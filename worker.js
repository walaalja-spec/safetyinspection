// ---------------------------------------------------------------------
// src/worker.js
// Cloudflare Workers entry point. Since this project is a "Workers with
// static assets" project (not classic Pages), everything routes through
// this one script: static files (index.html, app.js, etc.) are served
// via the ASSETS binding, and POST /analyze is handled here directly.
//
// Required setup (once, in the Cloudflare dashboard):
//   Your project → Settings → Variables and Secrets → Add
//     Name:  OPENAI_API_KEY
//     Value: <your OpenAI key>
//     Type:  Secret
// ---------------------------------------------------------------------

// Mirrors OBSERVATION_CATEGORIES in app.js — keep these two lists in
// sync manually if categories ever change (they intentionally live in
// two different runtimes: Worker vs. browser).
const ALLOWED_CATEGORIES = [
  "كهرباء", "كهرباء وإنارة", "سباكة", "دورات مياه", "تكييف وتبريد",
  "حريق", "السلامة", "مخارج طوارئ", "سلامة المبنى", "الأرضيات",
  "الأبواب والنوافذ", "أسقف وجدران", "النظافة", "المواد الكيميائية",
  "معدات السلامة", "الإسعافات الأولية", "التمديدات", "المخاطر العامة", "أخرى"
];

const SYSTEM_PROMPT = `أنت مساعد يحلل ملاحظات تفتيش الصحة والسلامة المهنية في المدارس.

مهمتك: تحويل نص مسموع (وصورة اختيارية) إلى ملاحظة منظمة، دون تغيير المعنى الأصلي الذي ذكره المستخدم.

التصنيفات المتاحة (اختر الأنسب، ولا تخترع تصنيفًا غير موجود بهذي القائمة):
كهرباء، كهرباء وإنارة، سباكة، دورات مياه، تكييف وتبريد، حريق، السلامة، مخارج طوارئ، سلامة المبنى، الأرضيات، الأبواب والنوافذ، أسقف وجدران، النظافة، المواد الكيميائية، معدات السلامة، الإسعافات الأولية، التمديدات، المخاطر العامة، أخرى

قواعد صارمة:
1. لا تخترع تفاصيل غير مذكورة في النص أو غير ظاهرة بوضوح في الصورة.
2. إذا وُجد تعارض بين كلام المستخدم والصورة، أو كانت الصورة لا تؤكد ما قاله المستخدم بوضوح، استخدم صياغة حذرة مثل "ذكر المستخدم ... بينما لا يمكن التحقق من ذلك بوضوح من الصورة" بدل الجزم.
3. أعد الإجابة بصيغة JSON فقط، بدون أي نص إضافي قبله أو بعده، وبالضبط بهذا الشكل:
{
  "category": "",
  "description": "",
  "recommendedAction": "",
  "visualObservation": "",
  "confidence": 0
}

"visualObservation" يصف فقط ما تراه في الصورة (فراغ "" إذا لا توجد صورة).
"confidence" رقم من 0 إلى 1 يعكس مدى وضوح الملاحظة ودعم الأدلة لها.`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Security headers are applied to EVERY response, not just static
    // assets — API responses (including raw photo bytes from R2) need
    // nosniff just as much as HTML does.
    if (url.pathname === "/analyze" && request.method === "POST") {
      return withSecurityHeaders(await handleAnalyze(request, env, url));
    }

    // Phase 2 cloud data layer (D1 + R2). Every route below /api/ except
    // /api/auth/* requires an authenticated session — see handleApi().
    if (url.pathname.startsWith("/api/")) {
      return withSecurityHeaders(await handleApi(request, env, url));
    }

    // Everything else (index.html, app.js, style.css, ...) is served
    // straight from the static assets bound to this Worker.
    const assetResponse = await env.ASSETS.fetch(request);
    return withSecurityHeaders(assetResponse);
  }
};

// index.html also carries this same policy via a <meta> tag (so it still
// applies if these files are ever served a different way, e.g. a plain
// static host) — but `frame-ancestors` only takes effect from a real HTTP
// header, never from <meta>, so it's set here rather than duplicated
// uselessly there. Applied to every response (HTML, JS, CSS, images).
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' blob: data:; " +
      "connect-src 'self'; object-src 'none'; base-uri 'self'; " +
      "form-action 'self'; manifest-src 'self'; frame-ancestors 'none';"
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// This app has no login/session layer by design (single-device, local
// storage), so /analyze can't be gated by a real auth check. This is a
// best-effort layer against the two cheapest abuse paths — a browser
// page on another origin driving traffic here, or a request that never
// came from this app's own UI at all — NOT a substitute for real auth;
// a determined caller can still spoof these headers directly. Absent
// Origin/Referer (some legitimate same-origin fetches omit them) is
// allowed through rather than blocked, to avoid breaking real usage.
function isAllowedOrigin(request, selfOrigin) {
  const origin = request.headers.get("Origin");
  if (origin) return origin === selfOrigin;
  const referer = request.headers.get("Referer");
  if (referer) return referer === selfOrigin || referer.startsWith(selfOrigin + "/");
  return true;
}

// Generous upper bounds — well above what this app itself ever sends
// (observation photos are compressed client-side to ~1600px/0.85 quality
// before reaching here), just to cap the cost/CPU blast radius of a
// direct, non-UI call to this endpoint.
const MAX_TEXT_CHARS = 8000;
const MAX_IMAGE_BASE64_CHARS = 8_000_000; // ~6MB decoded

async function handleAnalyze(request, env, url) {
  // CSRF defense-in-depth only — see handleApi().
  if (!isAllowedOrigin(request, url.origin)) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  // This endpoint spends real money on every call (OpenAI, billed to the
  // project's key) and previously accepted a ~6MB image from anyone who
  // set one header. It now requires the same verified session as the
  // rest of the API.
  const denied = await requireAuth(request, env);
  if (denied) return jsonResponse({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "bad_request" }, 400);
  }

  const text = (body.text || "").trim();
  const imageBase64 = body.imageBase64 || null;

  if (!text && !imageBase64) {
    return jsonResponse({ error: "no_input" }, 400);
  }
  if (text.length > MAX_TEXT_CHARS || (imageBase64 && imageBase64.length > MAX_IMAGE_BASE64_CHARS)) {
    return jsonResponse({ error: "payload_too_large" }, 413);
  }

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "missing_key" }, 500);
  }

  const userContent = [];
  userContent.push({
    type: "text",
    text: text
      ? `نص الملاحظة كما ذكره المستخدم صوتيًا:\n"${text}"`
      : "لا يوجد نص صوتي، اعتمد فقط على الصورة المرفقة."
  });
  if (imageBase64) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
    });
  }

  let aiResponse;
  try {
    aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 700
      })
    });
  } catch (e) {
    return jsonResponse({ error: "network_error" }, 502);
  }

  if (!aiResponse.ok) {
    const errText = await aiResponse.text().catch(() => "");
    console.error("OpenAI API error:", aiResponse.status, errText);
    let detail = "";
    try {
      const errJson = JSON.parse(errText);
      detail = (errJson.error && errJson.error.message) || "";
    } catch (e) {
      detail = errText.slice(0, 200);
    }
    return jsonResponse({ error: "ai_failed", status: aiResponse.status, detail }, 502);
  }

  let data;
  try {
    data = await aiResponse.json();
  } catch (e) {
    return jsonResponse({ error: "ai_failed" }, 502);
  }

  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) {
    return jsonResponse({ error: "ai_failed" }, 502);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return jsonResponse({ error: "invalid_json" }, 502);
  }

  const requiredFields = ["category", "description", "recommendedAction"];
  for (const field of requiredFields) {
    if (typeof parsed[field] !== "string" || !parsed[field]) {
      return jsonResponse({ error: "invalid_schema" }, 502);
    }
  }

  // Never let the AI introduce a category outside the fixed list —
  // fall back to "أخرى" (Other) if it ever returns something unexpected.
  const safeCategory = ALLOWED_CATEGORIES.includes(parsed.category) ? parsed.category : "أخرى";

  return jsonResponse({
    category: safeCategory,
    description: parsed.description,
    recommendedAction: parsed.recommendedAction,
    visualObservation: parsed.visualObservation || "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null
  });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// ---------------------------------------------------------------------
// Phase 2 — Cloud data layer (D1 + R2).
//
// Infrastructure only: nothing in the existing frontend (app.js,
// storage.js, ...) calls any of this yet, and IndexedDB remains the
// app's only real storage. See PHASE2_MIGRATION_PLAN.md for how a
// future migration would eventually use these endpoints.
//
// Every response uses one envelope: {success:true, data} on success,
// {success:false, error} on failure — callers can always branch on
// `success` alone rather than guessing from the HTTP status.
// ---------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" };

function apiOk(data, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), { status, headers: JSON_HEADERS });
}

function apiErr(error, status = 400) {
  return new Response(JSON.stringify({ success: false, error }), { status, headers: JSON_HEADERS });
}

function genId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Used for every id that ends up embedded in an R2 object key (school id,
// observation id, month key, slot id, ...) so a crafted id can never be
// used for path traversal or to reach another object's key namespace.
const SAFE_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
function isSafeId(v) {
  return typeof v === "string" && SAFE_ID_RE.test(v);
}

const PHOTO_TYPES = new Set(["original", "before", "after", "monthly", "audio"]);
const OWNER_TYPES = new Set(["observation", "monthly_submission"]);
const MAX_PHOTO_BYTES = 15_000_000;

// A machine-to-machine credential ONLY (migration tooling, ops scripts).
// It is deliberately never sent by the frontend: a secret shipped to a
// browser is visible to anyone with DevTools, so it would stop being a
// secret the moment the app used it. Browsers authenticate with the
// session cookie below instead. Set via
// `wrangler secret put API_INTERNAL_KEY` — never hardcode it here or in
// wrangler.toml.
function isAuthorizedApiRequest(request, env) {
  const expected = env.API_INTERNAL_KEY;
  if (!expected) return false;
  const provided = request.headers.get("X-Api-Key");
  return timingSafeEqual(provided, expected);
}

// ---------------------------------------------------------------------
// Authentication — single-operator session, HMAC-signed, HttpOnly cookie.
//
// Design notes:
//  * `Origin`/`Referer` are NEVER treated as authentication. They are
//    client-controlled and trivially spoofed by any non-browser client;
//    they remain only as CSRF defense-in-depth alongside SameSite=Strict.
//  * The session token is stateless (HMAC over {exp, iat, sub}), so no
//    D1 read is needed per request. Global revocation = rotate
//    SESSION_SECRET, which invalidates every existing session at once.
//  * Nothing secret ever reaches the browser: the cookie is HttpOnly, so
//    page JavaScript cannot read it, and the password itself is never
//    stored client-side.
//
// Required secrets (set per environment, including preview):
//   wrangler secret put AUTH_PASSWORD_HASH   # PBKDF2-SHA256, hex
//   wrangler secret put AUTH_PASSWORD_SALT   # random, hex
//   wrangler secret put SESSION_SECRET       # random 32+ bytes
//
// IMPORTANT DEGRADATION RULE: if these secrets are absent, /api/* and
// /analyze refuse access (fail closed) — but the app itself keeps
// working entirely on IndexedDB, exactly as it did before any cloud
// layer existed, with sync queueing harmlessly. Missing configuration
// can therefore never lock the user out of their own data.
// ---------------------------------------------------------------------

// Secrets are read through this rather than off `env` directly.
// Pasting a value into the Cloudflare dashboard very easily carries a
// trailing newline or space, and a single invisible character silently
// breaks everything: an extra byte on the SALT derives a completely
// different hash, and an extra byte on the HASH fails the length check
// in timingSafeEqual. Both surface only as "wrong password", which is
// impossible to diagnose from the outside -- so trim on read instead of
// making the operator hunt for whitespace they cannot see.
function readSecret(env, name) {
  const value = env[name];
  return typeof value === "string" ? value.trim() : value;
}

const SESSION_COOKIE = "wj_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d — field use spans days offline
const PBKDF2_ITERATIONS = 210000; // OWASP-recommended floor for PBKDF2-SHA256

// Length-independent comparison: returns false for null/length mismatch
// without leaking where the difference is via timing.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

async function pbkdf2Hex(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(bits);
}

async function hmacHex(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

async function issueSessionToken(env) {
  const payload = JSON.stringify({ sub: "owner", iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
  const body = base64UrlEncode(payload);
  return `${body}.${await hmacHex(body, readSecret(env, "SESSION_SECRET"))}`;
}

// Returns the payload when the signature verifies AND the token is
// unexpired; null otherwise. Signature is checked before expiry so a
// forged token is rejected on its merits, not its clock.
async function verifySessionToken(token, env) {
  if (!token || !readSecret(env, "SESSION_SECRET")) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!timingSafeEqual(signature, await hmacHex(body, readSecret(env, "SESSION_SECRET")))) return null;
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch (e) {
    return null;
  }
  if (typeof payload.exp !== "number" || Date.now() >= payload.exp) return null;
  return payload;
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sessionCookieHeader(token, maxAgeSeconds) {
  // HttpOnly  -> unreadable by page JS, so XSS cannot exfiltrate it.
  // Secure    -> never sent over plaintext.
  // SameSite=Strict -> the browser won't attach it to cross-site
  //              requests at all, which is the CSRF defense.
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

// The single gate every protected route goes through. Accepts either a
// valid browser session cookie or the machine credential — both are
// verified server-side against a real secret. Returns null when
// authenticated, or the 401 Response to return when not.
async function requireAuth(request, env) {
  const session = await verifySessionToken(readCookie(request, SESSION_COOKIE), env);
  if (session) return null;
  if (isAuthorizedApiRequest(request, env)) return null;
  return apiErr("unauthorized", 401);
}

// Brute-force protection for the one password that exists. Backed by D1
// so it survives isolate recycling (an in-memory counter would reset
// constantly and provide no real protection).
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

async function loginRateLimited(env, ip) {
  try {
    const since = Date.now() - LOGIN_WINDOW_MS;
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM auth_login_attempts WHERE ip = ? AND attempted_at > ?"
    ).bind(ip, since).first();
    return !!row && row.n >= LOGIN_MAX_ATTEMPTS;
  } catch (e) {
    // Table missing (migration 0002 not applied yet) must not make login
    // impossible — log and allow, rather than bricking access.
    console.error("Login rate-limit check unavailable:", e);
    return false;
  }
}

async function recordLoginAttempt(env, ip) {
  try {
    await env.DB.prepare("INSERT INTO auth_login_attempts (ip, attempted_at) VALUES (?, ?)").bind(ip, Date.now()).run();
    await env.DB.prepare("DELETE FROM auth_login_attempts WHERE attempted_at < ?").bind(Date.now() - LOGIN_WINDOW_MS).run();
  } catch (e) {
    console.error("Could not record login attempt:", e);
  }
}

async function handleAuth(request, env, action) {
  if (action === "session" && request.method === "GET") {
    const session = await verifySessionToken(readCookie(request, SESSION_COOKIE), env);
    const hash = readSecret(env, "AUTH_PASSWORD_HASH");
    const salt = readSecret(env, "AUTH_PASSWORD_SALT");
    const sessionSecret = readSecret(env, "SESSION_SECRET");

    // `setup` reports only the SHAPE of each secret, never its value or
    // any part of one. A wrong password is otherwise indistinguishable
    // from a truncated or mis-pasted secret -- both just say "wrong
    // password" -- and secrets cannot be read back from the Cloudflare
    // dashboard once saved, so without this there is no way to tell the
    // two apart. Knowing that the hash is 64 hex characters reveals
    // nothing exploitable: that is simply the published output size of
    // PBKDF2-SHA256, which the algorithm choice already implies.
    const setup = {
      saltPresent: !!salt,
      hashPresent: !!hash,
      sessionSecretPresent: !!sessionSecret,
      // A correct hash is exactly 64 lowercase hex chars. Anything else
      // means it was truncated, uppercased, or partially pasted.
      hashLooksValid: typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash),
      hashLength: typeof hash === "string" ? hash.length : 0,
      saltLength: typeof salt === "string" ? salt.length : 0
    };

    // Also reports whether auth is even configured, so the frontend can
    // stay in local-only mode instead of showing an unusable login form.
    return apiOk({
      authenticated: !!session,
      configured: !!(hash && salt && sessionSecret),
      expiresAt: session ? session.exp : null,
      setup
    });
  }

  if (action === "logout" && request.method === "POST") {
    return new Response(JSON.stringify({ success: true, data: { loggedOut: true } }), {
      status: 200,
      headers: { ...JSON_HEADERS, "Set-Cookie": sessionCookieHeader("", 0) }
    });
  }

  if (action === "login" && request.method === "POST") {
    if (!readSecret(env, "AUTH_PASSWORD_HASH") || !readSecret(env, "AUTH_PASSWORD_SALT") || !readSecret(env, "SESSION_SECRET")) {
      return apiErr("auth_not_configured", 503);
    }
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (await loginRateLimited(env, ip)) return apiErr("too_many_attempts", 429);

    let body;
    try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }
    if (!isNonEmptyString(body.password)) {
      await recordLoginAttempt(env, ip);
      return apiErr("invalid_credentials", 401);
    }

    const candidate = await pbkdf2Hex(body.password, readSecret(env, "AUTH_PASSWORD_SALT"));
    if (!timingSafeEqual(candidate, readSecret(env, "AUTH_PASSWORD_HASH"))) {
      await recordLoginAttempt(env, ip);
      // Deliberately identical to the empty-password error: never reveal
      // whether a password was close, or that the account exists.
      return apiErr("invalid_credentials", 401);
    }

    const token = await issueSessionToken(env);
    return new Response(JSON.stringify({ success: true, data: { authenticated: true } }), {
      status: 200,
      headers: { ...JSON_HEADERS, "Set-Cookie": sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)) }
    });
  }

  return apiErr("not_found", 404);
}

function extFromContentType(ct) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "audio/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/ogg": "ogg"
  };
  return map[ct] || "bin";
}

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// R2 key layout:
//   observations/{observationId}/{original|before|after|audio}/{photoId}.{ext}
//   monthly/{schoolId}/{monthKey}/{slotId}/{photoId}.{ext}
// Every path segment below has already passed isSafeId()/monthKey regex
// checks in the caller before reaching here.
function buildPhotoKey({ ownerType, ownerId, photoType, photoId, ext, schoolId, monthKey, slotId }) {
  if (ownerType === "observation") {
    return `observations/${ownerId}/${photoType}/${photoId}.${ext}`;
  }
  return `monthly/${schoolId}/${monthKey}/${slotId}/${photoId}.${ext}`;
}

// photo_refs is keyed by (owner_type, owner_id) rather than a real SQL
// foreign key, because its owner can be either an observations row or a
// monthly_submissions row -- SQLite has no polymorphic FK. That means SQL
// ON DELETE CASCADE on schools/visits never reaches photo_refs on its own
// (confirmed locally: deleting a school cascades away its
// monthly_submissions row, but a photo_refs row pointing at that deleted
// submission is left behind, pointing at nothing). So every delete path
// that can make an owner disappear -- directly or via a parent cascade --
// must call this first, to remove both the R2 object and the D1 row and
// avoid leaving a database reference to a file nothing points at anymore.
async function deletePhotoRefsForOwner(env, ownerType, ownerId) {
  const { results } = await env.DB.prepare("SELECT r2_key FROM photo_refs WHERE owner_type = ? AND owner_id = ?")
    .bind(ownerType, ownerId).all();
  for (const row of results) {
    await env.BUCKET.delete(row.r2_key);
  }
  await env.DB.prepare("DELETE FROM photo_refs WHERE owner_type = ? AND owner_id = ?").bind(ownerType, ownerId).run();
}

async function handleApi(request, env, url) {
  // Kept as CSRF defense-in-depth ONLY. This is not authentication: a
  // non-browser client sets Origin to anything it likes, which is
  // exactly how the previous version of this gate was bypassable. Real
  // identity is established by requireAuth() below.
  if (!isAllowedOrigin(request, url.origin)) {
    return apiErr("forbidden", 403);
  }

  const parts = url.pathname.split("/").filter(Boolean); // ["api", "schools", ":id", ...]
  const resource = parts[1];
  const id = parts[2];

  // The auth endpoints themselves must stay reachable without a session
  // — otherwise logging in would require already being logged in. They
  // do their own credential checking and rate limiting.
  if (resource === "auth") {
    try {
      return await handleAuth(request, env, id);
    } catch (e) {
      console.error("Auth error:", e);
      return apiErr("internal_error", 500);
    }
  }

  // Every other /api/* route requires a verified session cookie or the
  // machine credential. Nothing below this line runs unauthenticated.
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (!env.DB || !env.BUCKET) {
    return apiErr("cloud_storage_not_configured", 500);
  }

  try {
    switch (resource) {
      case "schools":
        return await handleSchools(request, env, request.method, id);
      case "visits":
        return await handleVisits(request, env, request.method, id);
      case "observations":
        return await handleObservations(request, env, request.method, id);
      case "monthly-slots":
        return await handleMonthlySlots(request, env, request.method, id);
      case "monthly-submissions":
        return await handleMonthlySubmissions(request, env, request.method, id);
      case "photos":
        return await handlePhotos(request, env, request.method, id, parts[3], url);
      default:
        return apiErr("not_found", 404);
    }
  } catch (e) {
    console.error("API error:", e);
    return apiErr("internal_error", 500);
  }
}

async function handleSchools(request, env, method, id) {
  if (method === "GET" && !id) {
    const { results } = await env.DB.prepare("SELECT * FROM schools ORDER BY name").all();
    return apiOk(results);
  }
  if (method === "GET" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const row = await env.DB.prepare("SELECT * FROM schools WHERE id = ?").bind(id).first();
    if (!row) return apiErr("not_found", 404);
    return apiOk(row);
  }
  if (method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }
    if (!isNonEmptyString(body.name)) return apiErr("invalid_name", 400);
    // Client-supplied id makes creation idempotent: a sync engine can
    // generate the id up front and safely retry the exact same request
    // after a timeout/dropped response without risking a duplicate row.
    // Omitting id keeps the old server-generated-id behavior.
    if (body.id !== undefined) {
      if (!isSafeId(body.id)) return apiErr("invalid_id", 400);
      const existing = await env.DB.prepare("SELECT * FROM schools WHERE id = ?").bind(body.id).first();
      if (existing) return apiOk(existing, 200);
    }
    const now = Date.now();
    const school = { id: body.id || genId("school"), name: body.name.trim(), created_at: now, updated_at: now };
    await env.DB.prepare(
      "INSERT INTO schools (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind(school.id, school.name, school.created_at, school.updated_at).run();
    return apiOk(school, 201);
  }
  if (method === "PUT" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    let body;
    try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }
    if (!isNonEmptyString(body.name)) return apiErr("invalid_name", 400);
    const existing = await env.DB.prepare("SELECT id FROM schools WHERE id = ?").bind(id).first();
    if (!existing) return apiErr("not_found", 404);
    const now = Date.now();
    await env.DB.prepare("UPDATE schools SET name = ?, updated_at = ? WHERE id = ?")
      .bind(body.name.trim(), now, id).run();
    const row = await env.DB.prepare("SELECT * FROM schools WHERE id = ?").bind(id).first();
    return apiOk(row);
  }
  if (method === "DELETE" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const existing = await env.DB.prepare("SELECT id FROM schools WHERE id = ?").bind(id).first();
    if (!existing) return apiErr("not_found", 404);
    // Visits keep a "quick visit" school_id set to NULL rather than being
    // deleted (see migrations/0001_init.sql), so their observations and
    // photos are untouched here. monthly_submissions DO cascade-delete
    // with the school, but (like observations above) their photo_refs
    // don't follow automatically -- clean those up first.
    const { results: subRows } = await env.DB.prepare("SELECT id FROM monthly_submissions WHERE school_id = ?").bind(id).all();
    for (const sub of subRows) {
      await deletePhotoRefsForOwner(env, "monthly_submission", sub.id);
    }
    await env.DB.prepare("DELETE FROM schools WHERE id = ?").bind(id).run();
    return apiOk({ id });
  }
  return apiErr("method_not_allowed", 405);
}

async function handleVisits(request, env, method, id) {
  if (method === "GET" && !id) {
    const { results } = await env.DB.prepare("SELECT * FROM visits ORDER BY date DESC").all();
    return apiOk(results);
  }
  if (method === "GET" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const row = await env.DB.prepare("SELECT * FROM visits WHERE id = ?").bind(id).first();
    if (!row) return apiErr("not_found", 404);
    return apiOk(row);
  }
  if (method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }
    if (!isNonEmptyString(body.title) || !isNonEmptyString(body.location) || !isNonEmptyString(body.date)) {
      return apiErr("missing_fields", 400);
    }
    let schoolId = null;
    if (body.schoolId != null) {
      if (!isSafeId(body.schoolId)) return apiErr("invalid_school_id", 400);
      const school = await env.DB.prepare("SELECT id FROM schools WHERE id = ?").bind(body.schoolId).first();
      if (!school) return apiErr("school_not_found", 404);
      schoolId = body.schoolId;
    }
    // See handleSchools' POST for why: a client-supplied id makes a
    // retried creation request idempotent instead of duplicating the visit.
    if (body.id !== undefined) {
      if (!isSafeId(body.id)) return apiErr("invalid_id", 400);
      const existing = await env.DB.prepare("SELECT * FROM visits WHERE id = ?").bind(body.id).first();
      if (existing) return apiOk(existing, 200);
    }
    const now = Date.now();
    const visit = {
      id: body.id || genId("visit"),
      school_id: schoolId,
      title: body.title.trim(),
      location: body.location.trim(),
      date: body.date,
      footer_text: body.footerText || null,
      photo_settings_json: body.photoSettingsJson || null,
      created_at: now,
      updated_at: now
    };
    await env.DB.prepare(
      `INSERT INTO visits (id, school_id, title, location, date, footer_text, photo_settings_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(visit.id, visit.school_id, visit.title, visit.location, visit.date, visit.footer_text, visit.photo_settings_json, visit.created_at, visit.updated_at).run();
    return apiOk(visit, 201);
  }
  if (method === "PUT" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const existing = await env.DB.prepare("SELECT * FROM visits WHERE id = ?").bind(id).first();
    if (!existing) return apiErr("not_found", 404);
    let body;
    try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }
    let schoolId = existing.school_id;
    if (body.schoolId !== undefined) {
      if (body.schoolId === null) {
        schoolId = null;
      } else {
        if (!isSafeId(body.schoolId)) return apiErr("invalid_school_id", 400);
        const school = await env.DB.prepare("SELECT id FROM schools WHERE id = ?").bind(body.schoolId).first();
        if (!school) return apiErr("school_not_found", 404);
        schoolId = body.schoolId;
      }
    }
    const now = Date.now();
    const title = isNonEmptyString(body.title) ? body.title.trim() : existing.title;
    const location = isNonEmptyString(body.location) ? body.location.trim() : existing.location;
    const date = isNonEmptyString(body.date) ? body.date : existing.date;
    const footerText = body.footerText !== undefined ? body.footerText : existing.footer_text;
    const photoSettingsJson = body.photoSettingsJson !== undefined ? body.photoSettingsJson : existing.photo_settings_json;
    await env.DB.prepare(
      `UPDATE visits SET school_id = ?, title = ?, location = ?, date = ?, footer_text = ?, photo_settings_json = ?, updated_at = ? WHERE id = ?`
    ).bind(schoolId, title, location, date, footerText, photoSettingsJson, now, id).run();
    const row = await env.DB.prepare("SELECT * FROM visits WHERE id = ?").bind(id).first();
    return apiOk(row);
  }
  if (method === "DELETE" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const existing = await env.DB.prepare("SELECT id FROM visits WHERE id = ?").bind(id).first();
    if (!existing) return apiErr("not_found", 404);
    // Observations cascade-delete at the SQL level when the visit goes,
    // but their photo_refs don't (see deletePhotoRefsForOwner) -- clean
    // those up first so no reference is left pointing at nothing.
    const { results: obsRows } = await env.DB.prepare("SELECT id FROM observations WHERE visit_id = ?").bind(id).all();
    for (const obs of obsRows) {
      await deletePhotoRefsForOwner(env, "observation", obs.id);
    }
    await env.DB.prepare("DELETE FROM visits WHERE id = ?").bind(id).run();
    return apiOk({ id });
  }
  return apiErr("method_not_allowed", 405);
}

async function handleObservations(request, env, method, id) {
  if (method === "GET" && !id) {
    const { results } = await env.DB.prepare("SELECT * FROM observations ORDER BY created_at DESC").all();
    return apiOk(results);
  }
  if (method === "GET" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const row = await env.DB.prepare("SELECT * FROM observations WHERE id = ?").bind(id).first();
    if (!row) return apiErr("not_found", 404);
    return apiOk(row);
  }
  if (method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }
    if (!isSafeId(body.visitId)) return apiErr("invalid_visit_id", 400);
    if (!isNonEmptyString(body.text)) return apiErr("missing_text", 400);
    const visit = await env.DB.prepare("SELECT id FROM visits WHERE id = ?").bind(body.visitId).first();
    if (!visit) return apiErr("visit_not_found", 404);
    // See handleSchools' POST for why: a client-supplied id makes a
    // retried creation request idempotent instead of duplicating the note.
    if (body.id !== undefined) {
      if (!isSafeId(body.id)) return apiErr("invalid_id", 400);
      const existing = await env.DB.prepare("SELECT * FROM observations WHERE id = ?").bind(body.id).first();
      if (existing) return apiOk(existing, 200);
    }
    const now = Date.now();
    const obs = {
      id: body.id || genId("obs"),
      visit_id: body.visitId,
      text: body.text.trim(),
      spot_location: body.spotLocation || null,
      category: body.category || null,
      recommended_action: body.recommendedAction || null,
      pending_ai: body.pendingAi ? 1 : 0,
      followup_enabled: 0,
      followup_status: null,
      followup_verification_date: null,
      followup_verification_note: null,
      created_at: now,
      updated_at: now
    };
    await env.DB.prepare(
      `INSERT INTO observations (id, visit_id, text, spot_location, category, recommended_action, pending_ai, followup_enabled, followup_status, followup_verification_date, followup_verification_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(obs.id, obs.visit_id, obs.text, obs.spot_location, obs.category, obs.recommended_action, obs.pending_ai, obs.followup_enabled, obs.followup_status, obs.followup_verification_date, obs.followup_verification_note, obs.created_at, obs.updated_at).run();
    return apiOk(obs, 201);
  }
  if (method === "PUT" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const existing = await env.DB.prepare("SELECT * FROM observations WHERE id = ?").bind(id).first();
    if (!existing) return apiErr("not_found", 404);
    let body;
    try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }
    const text = isNonEmptyString(body.text) ? body.text.trim() : existing.text;
    const spotLocation = body.spotLocation !== undefined ? body.spotLocation : existing.spot_location;
    const category = body.category !== undefined ? body.category : existing.category;
    const recommendedAction = body.recommendedAction !== undefined ? body.recommendedAction : existing.recommended_action;
    const pendingAi = body.pendingAi !== undefined ? (body.pendingAi ? 1 : 0) : existing.pending_ai;
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE observations SET text = ?, spot_location = ?, category = ?, recommended_action = ?, pending_ai = ?, updated_at = ? WHERE id = ?`
    ).bind(text, spotLocation, category, recommendedAction, pendingAi, now, id).run();
    const row = await env.DB.prepare("SELECT * FROM observations WHERE id = ?").bind(id).first();
    return apiOk(row);
  }
  if (method === "DELETE" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const existing = await env.DB.prepare("SELECT id FROM observations WHERE id = ?").bind(id).first();
    if (!existing) return apiErr("not_found", 404);
    await deletePhotoRefsForOwner(env, "observation", id);
    await env.DB.prepare("DELETE FROM observations WHERE id = ?").bind(id).run();
    return apiOk({ id });
  }
  return apiErr("method_not_allowed", 405);
}

async function handleMonthlySlots(request, env, method, id) {
  if (method === "GET" && !id) {
    const { results } = await env.DB.prepare("SELECT * FROM monthly_slots ORDER BY sort_order").all();
    return apiOk(results);
  }
  if (method === "GET" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const row = await env.DB.prepare("SELECT * FROM monthly_slots WHERE id = ?").bind(id).first();
    if (!row) return apiErr("not_found", 404);
    return apiOk(row);
  }
  if (method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }
    if (!isNonEmptyString(body.label) || !isNonEmptyString(body.category)) return apiErr("missing_fields", 400);
    const now = Date.now();
    const slot = {
      id: genId("slot"),
      label: body.label.trim(),
      category: body.category.trim(),
      sort_order: Number.isInteger(body.sortOrder) ? body.sortOrder : 0,
      updated_at: now
    };
    await env.DB.prepare(
      "INSERT INTO monthly_slots (id, label, category, sort_order, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(slot.id, slot.label, slot.category, slot.sort_order, slot.updated_at).run();
    return apiOk(slot, 201);
  }
  if (method === "PUT" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const existing = await env.DB.prepare("SELECT * FROM monthly_slots WHERE id = ?").bind(id).first();
    if (!existing) return apiErr("not_found", 404);
    let body;
    try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }
    const label = isNonEmptyString(body.label) ? body.label.trim() : existing.label;
    const category = isNonEmptyString(body.category) ? body.category.trim() : existing.category;
    const sortOrder = Number.isInteger(body.sortOrder) ? body.sortOrder : existing.sort_order;
    const now = Date.now();
    await env.DB.prepare("UPDATE monthly_slots SET label = ?, category = ?, sort_order = ?, updated_at = ? WHERE id = ?")
      .bind(label, category, sortOrder, now, id).run();
    const row = await env.DB.prepare("SELECT * FROM monthly_slots WHERE id = ?").bind(id).first();
    return apiOk(row);
  }
  if (method === "DELETE" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const existing = await env.DB.prepare("SELECT id FROM monthly_slots WHERE id = ?").bind(id).first();
    if (!existing) return apiErr("not_found", 404);
    await env.DB.prepare("DELETE FROM monthly_slots WHERE id = ?").bind(id).run();
    return apiOk({ id });
  }
  return apiErr("method_not_allowed", 405);
}

async function handleMonthlySubmissions(request, env, method, id) {
  if (method === "GET" && !id) {
    const { results } = await env.DB.prepare("SELECT * FROM monthly_submissions ORDER BY month_key DESC").all();
    return apiOk(results);
  }
  if (method === "GET" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const row = await env.DB.prepare("SELECT * FROM monthly_submissions WHERE id = ?").bind(id).first();
    if (!row) return apiErr("not_found", 404);
    return apiOk(row);
  }
  if (method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }
    if (!isSafeId(body.schoolId)) return apiErr("invalid_school_id", 400);
    if (!isNonEmptyString(body.monthKey) || !/^\d{4}-\d{2}$/.test(body.monthKey)) return apiErr("invalid_month_key", 400);
    const school = await env.DB.prepare("SELECT id FROM schools WHERE id = ?").bind(body.schoolId).first();
    if (!school) return apiErr("school_not_found", 404);
    const existing = await env.DB.prepare("SELECT id FROM monthly_submissions WHERE school_id = ? AND month_key = ?")
      .bind(body.schoolId, body.monthKey).first();
    if (existing) return apiErr("already_exists", 409);
    const now = Date.now();
    const sub = {
      id: genId("monthsub"),
      school_id: body.schoolId,
      month_key: body.monthKey,
      visit_date: body.visitDate || null,
      created_at: now,
      updated_at: now
    };
    await env.DB.prepare(
      "INSERT INTO monthly_submissions (id, school_id, month_key, visit_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(sub.id, sub.school_id, sub.month_key, sub.visit_date, sub.created_at, sub.updated_at).run();
    return apiOk(sub, 201);
  }
  if (method === "PUT" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const existing = await env.DB.prepare("SELECT * FROM monthly_submissions WHERE id = ?").bind(id).first();
    if (!existing) return apiErr("not_found", 404);
    let body;
    try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }
    const visitDate = body.visitDate !== undefined ? body.visitDate : existing.visit_date;
    const now = Date.now();
    await env.DB.prepare("UPDATE monthly_submissions SET visit_date = ?, updated_at = ? WHERE id = ?")
      .bind(visitDate, now, id).run();
    const row = await env.DB.prepare("SELECT * FROM monthly_submissions WHERE id = ?").bind(id).first();
    return apiOk(row);
  }
  if (method === "DELETE" && id) {
    if (!isSafeId(id)) return apiErr("invalid_id", 400);
    const existing = await env.DB.prepare("SELECT id FROM monthly_submissions WHERE id = ?").bind(id).first();
    if (!existing) return apiErr("not_found", 404);
    await deletePhotoRefsForOwner(env, "monthly_submission", id);
    await env.DB.prepare("DELETE FROM monthly_submissions WHERE id = ?").bind(id).run();
    return apiOk({ id });
  }
  return apiErr("method_not_allowed", 405);
}

// /api/photos/upload            POST raw bytes  -> R2 only (no D1 write)
// /api/photos/confirm           POST JSON       -> creates the photo_refs row
// /api/photos/:id                GET             -> photo_refs metadata
// /api/photos/:id/download       GET             -> raw bytes from R2
// /api/photos/:id                DELETE          -> removes R2 object + row
async function handlePhotos(request, env, method, idOrAction, subaction, url) {
  if (method === "POST" && idOrAction === "upload") {
    return handlePhotoUpload(request, env, url);
  }
  if (method === "POST" && idOrAction === "confirm") {
    return handlePhotoConfirm(request, env);
  }
  if (method === "GET" && idOrAction && subaction === "download") {
    return handlePhotoDownload(env, idOrAction);
  }
  if (method === "GET" && idOrAction) {
    return handlePhotoGet(env, idOrAction);
  }
  if (method === "DELETE" && idOrAction) {
    return handlePhotoDelete(env, idOrAction);
  }
  return apiErr("not_found", 404);
}

// Step 1 of 2. Uploads bytes to R2 and independently verifies (via
// BUCKET.head) that the object is actually readable before returning —
// but never writes to D1. The caller must follow up with /confirm using
// the returned metadata to create the photo_refs row.
async function handlePhotoUpload(request, env, url) {
  const ownerType = url.searchParams.get("ownerType");
  const ownerId = url.searchParams.get("ownerId");
  const photoType = url.searchParams.get("photoType");
  const schoolId = url.searchParams.get("schoolId");
  const monthKey = url.searchParams.get("monthKey");
  const slotId = url.searchParams.get("slotId");
  const clientPhotoId = url.searchParams.get("photoId");

  if (!OWNER_TYPES.has(ownerType)) return apiErr("invalid_owner_type", 400);
  if (!isSafeId(ownerId)) return apiErr("invalid_owner_id", 400);
  if (!PHOTO_TYPES.has(photoType)) return apiErr("invalid_photo_type", 400);
  if (clientPhotoId !== null && !isSafeId(clientPhotoId)) return apiErr("invalid_photo_id", 400);

  if (ownerType === "monthly_submission") {
    if (!isSafeId(schoolId) || !isNonEmptyString(monthKey) || !/^\d{4}-\d{2}$/.test(monthKey) || !isSafeId(slotId)) {
      return apiErr("missing_monthly_photo_fields", 400);
    }
  }

  const contentType = request.headers.get("Content-Type") || "application/octet-stream";
  const knownExt = extFromContentType(contentType);
  if (knownExt === "bin") return apiErr("unsupported_content_type", 415);

  // Verify the owning record actually exists BEFORE writing anything to
  // R2. Previously this check lived only in /confirm, so an unauthorized
  // (or simply buggy) caller could fill the bucket with objects that no
  // record ever referenced and nothing would ever clean up.
  const ownerTable = ownerType === "observation" ? "observations" : "monthly_submissions";
  const ownerRow = await env.DB.prepare(`SELECT id FROM ${ownerTable} WHERE id = ?`).bind(ownerId).first();
  if (!ownerRow) return apiErr("owner_not_found", 404);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return apiErr("empty_body", 400);
  if (bytes.byteLength > MAX_PHOTO_BYTES) return apiErr("payload_too_large", 413);

  // A client-supplied id (e.g. sync.js retrying after a dropped response)
  // makes the upload land at the exact same r2Key every time -- R2's put()
  // for an unchanged key/content is naturally idempotent, and it lets
  // handlePhotoConfirm's own r2_key dedup (see below) actually kick in
  // instead of creating a second orphaned object under a fresh random id.
  const photoId = clientPhotoId || genId("photo");
  const r2Key = buildPhotoKey({ ownerType, ownerId, photoType, photoId, ext: knownExt, schoolId, monthKey, slotId });

  const checksum = await sha256Hex(bytes);

  // Every path segment of r2Key is caller-supplied, so a caller reusing
  // ids would otherwise silently overwrite an already-stored object.
  // Inspection photos are evidence: once an upload is recorded in
  // photo_refs, that object is immutable.
  //
  // The checksum comparison is what makes this both safe AND
  // retry-friendly. A genuine retry (identical bytes, same id) matches
  // the recorded checksum and proceeds as an idempotent no-op. Anything
  // that would CHANGE the stored bytes is rejected -- including the
  // same-id case, which is not merely a security concern: /confirm
  // returns the pre-existing row, so a changed object would leave D1
  // reporting the old size and checksum while R2 served different
  // content. Verified in testing: without this, D1 said size=20 while
  // R2 returned 26 different bytes.
  const alreadyRecorded = await env.DB.prepare(
    "SELECT id, checksum FROM photo_refs WHERE r2_key = ?"
  ).bind(r2Key).first();
  if (alreadyRecorded && (alreadyRecorded.id !== photoId || alreadyRecorded.checksum !== checksum)) {
    return apiErr("photo_key_conflict", 409);
  }

  let putResult;
  try {
    putResult = await env.BUCKET.put(r2Key, bytes, {
      httpMetadata: { contentType },
      customMetadata: { checksum }
    });
  } catch (e) {
    console.error("R2 put failed:", e);
    return apiErr("r2_upload_failed", 502);
  }
  if (!putResult) return apiErr("r2_upload_failed", 502);

  // Independently re-check the object is really there before telling the
  // caller the upload succeeded — a photo is never "successful" on the
  // strength of put() alone.
  const head = await env.BUCKET.head(r2Key);
  if (!head) return apiErr("r2_verify_failed", 502);

  return apiOk({
    photoId,
    r2Key,
    ownerType,
    ownerId,
    photoType,
    slotId: ownerType === "monthly_submission" ? slotId : null,
    contentType,
    size: bytes.byteLength,
    checksum,
    uploadedAt: Date.now()
  }, 201);
}

// Step 2 of 2. Re-verifies the R2 object exists (never trusts the
// caller's claim), verifies the owner row exists in D1, then inserts the
// photo_refs row. If the D1 write itself fails, the R2 object is left
// untouched so this exact request can be retried later without
// re-uploading bytes — this is what keeps D1/R2 from drifting out of
// sync silently.
async function handlePhotoConfirm(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return apiErr("malformed_json", 400); }

  const { photoId, r2Key, ownerType, ownerId, photoType, slotId, contentType, size, checksum, uploadedAt } = body;

  if (!isSafeId(photoId)) return apiErr("invalid_photo_id", 400);
  if (!isNonEmptyString(r2Key)) return apiErr("invalid_r2_key", 400);
  if (!OWNER_TYPES.has(ownerType)) return apiErr("invalid_owner_type", 400);
  if (!isSafeId(ownerId)) return apiErr("invalid_owner_id", 400);
  if (!PHOTO_TYPES.has(photoType)) return apiErr("invalid_photo_type", 400);
  if (!isNonEmptyString(contentType)) return apiErr("invalid_content_type", 400);
  if (!Number.isFinite(size) || size <= 0) return apiErr("invalid_size", 400);

  const head = await env.BUCKET.head(r2Key);
  if (!head) return apiErr("r2_object_not_found", 409);

  const ownerTable = ownerType === "observation" ? "observations" : "monthly_submissions";
  const owner = await env.DB.prepare(`SELECT id FROM ${ownerTable} WHERE id = ?`).bind(ownerId).first();
  if (!owner) return apiErr("owner_not_found", 404);

  const existing = await env.DB.prepare("SELECT * FROM photo_refs WHERE r2_key = ?").bind(r2Key).first();
  if (existing) {
    // A retried confirm call for an already-confirmed upload — return the
    // existing row instead of failing the r2_key UNIQUE constraint.
    return apiOk(existing, 200);
  }

  const now = Date.now();
  const ref = {
    id: photoId,
    r2_key: r2Key,
    owner_type: ownerType,
    owner_id: ownerId,
    photo_type: photoType,
    slot_id: ownerType === "monthly_submission" ? (slotId || null) : null,
    content_type: contentType,
    size,
    checksum: checksum || null,
    taken_at: Number.isFinite(uploadedAt) ? uploadedAt : null,
    uploaded_at: now
  };

  try {
    await env.DB.prepare(
      `INSERT INTO photo_refs (id, r2_key, owner_type, owner_id, photo_type, slot_id, content_type, size, checksum, taken_at, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(ref.id, ref.r2_key, ref.owner_type, ref.owner_id, ref.photo_type, ref.slot_id, ref.content_type, ref.size, ref.checksum, ref.taken_at, ref.uploaded_at).run();
  } catch (e) {
    console.error("D1 insert failed during photo confirm:", e);
    return apiErr("d1_write_failed", 502);
  }

  return apiOk(ref, 201);
}

async function handlePhotoGet(env, id) {
  if (!isSafeId(id)) return apiErr("invalid_id", 400);
  const row = await env.DB.prepare("SELECT * FROM photo_refs WHERE id = ?").bind(id).first();
  if (!row) return apiErr("not_found", 404);
  return apiOk(row);
}

async function handlePhotoDownload(env, id) {
  if (!isSafeId(id)) return apiErr("invalid_id", 400);
  const row = await env.DB.prepare("SELECT * FROM photo_refs WHERE id = ?").bind(id).first();
  if (!row) return apiErr("not_found", 404);
  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) return apiErr("r2_object_missing", 404);
  return new Response(obj.body, {
    status: 200,
    headers: { "Content-Type": row.content_type, "Content-Length": String(row.size) }
  });
}

async function handlePhotoDelete(env, id) {
  if (!isSafeId(id)) return apiErr("invalid_id", 400);
  const row = await env.DB.prepare("SELECT * FROM photo_refs WHERE id = ?").bind(id).first();
  if (!row) return apiErr("not_found", 404);
  await env.BUCKET.delete(row.r2_key);
  await env.DB.prepare("DELETE FROM photo_refs WHERE id = ?").bind(id).run();
  return apiOk({ id });
}
