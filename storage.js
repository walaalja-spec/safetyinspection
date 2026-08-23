// ---------------------------------------------------------------------
// storage.js
// IndexedDB is used (not localStorage) because observations contain
// photo and audio Blobs, which can be large and are stored natively
// by IndexedDB without the size bloat of base64-encoding into JSON.
// All functions here are async — every caller must use await.
// ---------------------------------------------------------------------

const DB_NAME = "safety_inspection_db";
const DB_VERSION = 3;
const STORE_NAME = "reports";
const MONTHLY_TEMPLATE_STORE = "monthly_templates";
const MONTHLY_SCHOOLS_STORE = "monthly_schools";
const MONTHLY_SUBMISSIONS_STORE = "monthly_submissions";
// New, independent from the monthly-photos system by explicit request —
// a separate configurable list of "scenes" with their own status
// workflow, scoped by school + month exactly like monthly photos are,
// but otherwise unrelated data.
const SCENE_TEMPLATE_STORE = "scene_templates";
const SCENE_TRACKING_STORE = "scene_tracking";

// Single shared connection, opened once and reused — avoids the
// overhead/edge-cases of re-opening a fresh IndexedDB connection on
// every single read/write, which was the main suspect behind
// intermittent save failures.
let dbConnectionPromise = null;

function openDB() {
  if (dbConnectionPromise) return dbConnectionPromise;

  dbConnectionPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MONTHLY_TEMPLATE_STORE)) {
        db.createObjectStore(MONTHLY_TEMPLATE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MONTHLY_SCHOOLS_STORE)) {
        db.createObjectStore(MONTHLY_SCHOOLS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MONTHLY_SUBMISSIONS_STORE)) {
        db.createObjectStore(MONTHLY_SUBMISSIONS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SCENE_TEMPLATE_STORE)) {
        db.createObjectStore(SCENE_TEMPLATE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SCENE_TRACKING_STORE)) {
        db.createObjectStore(SCENE_TRACKING_STORE, { keyPath: "id" });
      }
    };

    req.onblocked = () => {
      // Another tab/old connection is holding the DB open during an
      // upgrade. Don't hang forever — surface it so the retry logic
      // in saveReportWithRetry can react instead of silently stalling.
      console.warn("IndexedDB open blocked by another connection/tab.");
    };

    req.onsuccess = () => {
      const db = req.result;
      // If the connection drops unexpectedly (browser reclaiming
      // resources, etc.), drop the cached promise so the next call
      // opens a fresh connection instead of reusing a dead one.
      db.onclose = () => { dbConnectionPromise = null; };
      db.onversionchange = () => { db.close(); dbConnectionPromise = null; };
      resolve(db);
    };

    req.onerror = () => {
      dbConnectionPromise = null;
      reject(req.error);
    };
  });

  return dbConnectionPromise;
}

// Retries a DB operation a few times with a short backoff — covers
// transient failures (a brief lock, a just-dropped connection) instead
// of failing the user's save on the first hiccup.
async function withRetry(fn, retries = 3, delayMs = 250) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`DB operation failed (attempt ${attempt}/${retries}):`, err);
      dbConnectionPromise = null; // force a fresh connection on retry
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  throw lastErr;
}

function generateId() {
  return "r_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
}

// ---------------------------------------------------------------------
// WebKit (Safari, and every iOS browser under it) has a long-documented
// bug where Blob values stored directly inside IndexedDB can come back
// corrupted/unreadable after the browser is closed and reopened — the
// record itself is fine (text fields load correctly), but the photo/
// audio data doesn't decode, which is exactly the "notes are there, but
// photos show a broken-image icon" symptom. ArrayBuffers don't hit this
// bug, so every Blob anywhere in a record (photos, audio — nested any
// number of levels deep) is converted to a small marker holding its raw
// bytes right before every write, and rehydrated back into a real Blob
// right after every read. This is invisible to every other caller in the
// app: they only ever see real Blob objects, exactly as before.
async function blobsToBuffersForWrite(value) {
  if (value instanceof Blob) {
    return { __buf: true, type: value.type, buffer: await value.arrayBuffer() };
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await blobsToBuffersForWrite(item));
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = await blobsToBuffersForWrite(value[key]);
    return out;
  }
  return value;
}

function buffersToBlobsAfterRead(value) {
  // A record saved *before* this fix shipped still has real Blob objects
  // in it (the old storage format) -- must be returned as-is here. Without
  // this check they fall into the generic object-walk below, and since
  // Object.keys(aBlob) is empty (size/type are prototype getters, not own
  // enumerable properties), that walk would silently replace the photo
  // with `{}`, destroying it. This must be checked first, before the
  // generic object branch.
  if (value instanceof Blob) return value;
  if (value && typeof value === "object" && value.__buf === true && value.buffer) {
    return new Blob([value.buffer], { type: value.type });
  }
  if (Array.isArray(value)) return value.map(buffersToBlobsAfterRead);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = buffersToBlobsAfterRead(value[key]);
    return out;
  }
  return value;
}

// Normalizes an observation's photos to a consistent array of
// { blob, takenAt }, regardless of which older/newer shape the data
// was saved in (plain Blob array, single photoBlob, etc.).
function obsPhotos(obs) {
  const raw = obs.photos || (obs.photoBlob ? [obs.photoBlob] : []);
  return raw.map((p) => (p instanceof Blob ? { blob: p, takenAt: null } : p));
}

async function getAllReports() {
  const db = await openDB();
  const reports = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  reports.sort((a, b) => b.createdAt - a.createdAt);
  return reports.map(buffersToBlobsAfterRead);
}

async function saveReport(report) {
  const safeReport = await blobsToBuffersForWrite(report);
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(safeReport);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    });
  });
}

async function getReportById(id) {
  const db = await openDB();
  const report = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  return report ? buffersToBlobsAfterRead(report) : null;
}

async function deleteReportById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// Returns other saved reports at the same location (case/space-insensitive
// match), newest first — used for the "compared to a previous visit" feature.
async function getReportsByLocation(location, excludeId) {
  const all = await getAllReports();
  const norm = (location || "").trim().toLowerCase();
  return all.filter((r) => r.id !== excludeId && (r.location || "").trim().toLowerCase() === norm);
}

// ---------------------------------------------------------------------
// Backup / restore
// Blobs can't go directly into JSON, so photos/audio are converted to
// base64 data URLs for the backup file, and converted back to Blobs on
// import. This inflates file size a bit but keeps the backup a single
// portable file with no server involved.
// ---------------------------------------------------------------------

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Deliberately does NOT use fetch(dataUrl) — that depends on the network
// stack (and, in this app, gets intercepted by the service worker's own
// fetch handler), which turned out to fail unpredictably ("Failed to
// fetch") purely for data: URLs, silently breaking every restore of a
// report that had a photo. Decoding the base64 payload directly has no
// such dependency.
function dataUrlToBlob(dataUrl) {
  const commaIndex = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, commaIndex);
  const base64 = dataUrl.slice(commaIndex + 1);
  const mimeMatch = header.match(/^data:([^;]+);base64$/);
  const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Generic deep (de)serializers — walk any value (report, school, monthly
// template/submission, whatever shape it currently has) and convert
// Blobs to/from a portable marker. This deliberately does NOT hardcode
// field names, so every field that actually exists on a record today —
// or gets added later — is carried through the backup automatically.
async function serializeForBackup(value) {
  if (value instanceof Blob) {
    return { __blob: true, dataUrl: await blobToDataUrl(value) };
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await serializeForBackup(item));
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = await serializeForBackup(value[key]);
    return out;
  }
  return value;
}

async function deserializeFromBackup(value) {
  if (value && typeof value === "object" && value.__blob === true && typeof value.dataUrl === "string") {
    return dataUrlToBlob(value.dataUrl);
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await deserializeFromBackup(item));
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = await deserializeFromBackup(value[key]);
    return out;
  }
  return value;
}

const BACKUP_VERSION = 2;
// Informational only (shown for diagnostics/support) — not tied to any
// version-gated migration logic.
const APP_VERSION = "2.0.0";

// All stores currently in the database, and the exact key each one
// occupies in a backup file's `stores` object. Single source of truth
// for exportBackupBlob(), importBackupFile(), the snapshot/rollback
// helpers, and __storageHealthCheck() — adding a new store only means
// adding one entry here.
const BACKUP_STORE_MAP = {
  reports: STORE_NAME,
  monthly_schools: MONTHLY_SCHOOLS_STORE,
  monthly_templates: MONTHLY_TEMPLATE_STORE,
  monthly_submissions: MONTHLY_SUBMISSIONS_STORE,
  scene_templates: SCENE_TEMPLATE_STORE,
  scene_tracking: SCENE_TRACKING_STORE
};

async function exportBackupBlob() {
  const [reports, schools, templates, submissions, sceneTemplates, sceneTracking] = await Promise.all([
    getAllReports(),
    storeGetAll(MONTHLY_SCHOOLS_STORE),
    storeGetAll(MONTHLY_TEMPLATE_STORE),
    storeGetAll(MONTHLY_SUBMISSIONS_STORE),
    storeGetAll(SCENE_TEMPLATE_STORE),
    storeGetAll(SCENE_TRACKING_STORE)
  ]);

  const payload = {
    backupVersion: BACKUP_VERSION,
    appVersion: APP_VERSION,
    exportedAt: Date.now(),
    stores: {
      reports: await serializeForBackup(reports),
      monthly_schools: await serializeForBackup(schools),
      monthly_templates: await serializeForBackup(templates),
      monthly_submissions: await serializeForBackup(submissions),
      scene_templates: await serializeForBackup(sceneTemplates),
      scene_tracking: await serializeForBackup(sceneTracking)
    }
  };

  const json = JSON.stringify(payload);
  return new Blob([json], { type: "application/json" });
}

// Takes a full, in-memory snapshot of every store — used right before a
// restore so a failure partway through can be rolled back exactly to
// this state (see importBackupFile()).
async function snapshotAllStores() {
  const snapshot = {};
  for (const key of Object.keys(BACKUP_STORE_MAP)) {
    snapshot[key] = key === "reports" ? await getAllReports() : await storeGetAll(BACKUP_STORE_MAP[key]);
  }
  return snapshot;
}

// Restores every store to exactly the given snapshot: re-writes every
// record that was there before (undoing any overwrite the failed import
// made), and deletes any record the partial import newly added that
// wasn't present in the snapshot. Used only when a restore fails
// partway through, so the database never ends up half-restored.
async function restoreFromSnapshot(snapshot) {
  for (const key of Object.keys(BACKUP_STORE_MAP)) {
    const storeName = BACKUP_STORE_MAP[key];
    const originalRecords = snapshot[key] || [];
    const originalIds = new Set(originalRecords.map((r) => r.id));

    for (const rec of originalRecords) {
      if (key === "reports") await saveReport(rec);
      else await storePut(storeName, rec);
    }

    const currentRecords = key === "reports" ? await getAllReports() : await storeGetAll(storeName);
    for (const rec of currentRecords) {
      if (!originalIds.has(rec.id)) {
        if (key === "reports") await deleteReportById(rec.id);
        else await storeDelete(storeName, rec.id);
      }
    }
  }
}

// Structural validation for an imported backup file, run before a single
// byte is written to IndexedDB. Deliberately tolerant of unknown/extra
// fields (forward-compatible with future stores/fields) but rejects
// anything that isn't recognizably a backup at all.
function validateBackupPayload(data) {
  if (!data || typeof data !== "object") {
    throw new Error("invalid_backup");
  }
  if (data.stores && typeof data.stores === "object" && !Array.isArray(data.stores)) {
    if (data.backupVersion !== undefined) {
      if (typeof data.backupVersion !== "number" || !Number.isInteger(data.backupVersion) || data.backupVersion < 1) {
        throw new Error("invalid_backup_version");
      }
    }
    return; // versioned format — fine, even if some/all store arrays are empty
  }
  if (Array.isArray(data.reports)) {
    return; // original pre-versioned format: reports only
  }
  throw new Error("invalid_backup");
}

// Restores a backup file. Never touches IndexedDB until every record in
// the file has been successfully validated + decoded (Base64 → Blob) —
// an invalid or corrupted file fails before anything is written, so
// existing data is never at risk. A single unreadable record is skipped
// (and counted) rather than failing the whole import. Successful writes
// use `put` (upsert by id) exactly like the rest of the app already
// does, so a successful import is always additive/merging — it never
// clears existing data.
//
// Safety net for the write phase itself: the current database is
// snapshotted right before any write, and if anything throws partway
// through writing (e.g. a quota error on the 500th record), every store
// is rolled back to that exact snapshot — the database is never left
// half-restored.
//
// Handles both the current { backupVersion, stores } format and the
// original pre-versioned format that only ever held `reports`.
async function importBackupFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("invalid_json");
  }

  validateBackupPayload(data); // throws invalid_backup / invalid_backup_version — nothing written yet

  let stores;
  if (data.stores && typeof data.stores === "object") {
    stores = data.stores;
  } else {
    // Original backup format (pre-backupVersion): reports only.
    stores = {
      reports: data.reports,
      monthly_schools: [],
      monthly_templates: [],
      monthly_submissions: [],
      scene_templates: [],
      scene_tracking: []
    };
  }

  const reportsIn = Array.isArray(stores.reports) ? stores.reports : [];
  const schoolsIn = Array.isArray(stores.monthly_schools) ? stores.monthly_schools : [];
  const templatesIn = Array.isArray(stores.monthly_templates) ? stores.monthly_templates : [];
  const submissionsIn = Array.isArray(stores.monthly_submissions) ? stores.monthly_submissions : [];
  const sceneTemplatesIn = Array.isArray(stores.scene_templates) ? stores.scene_templates : [];
  const sceneTrackingIn = Array.isArray(stores.scene_tracking) ? stores.scene_tracking : [];

  const summary = {
    reports: 0,
    monthly_schools: 0,
    monthly_templates: 0,
    monthly_submissions: 0,
    scene_templates: 0,
    scene_tracking: 0,
    skipped: 0
  };

  // Phase 1: decode everything first. Nothing is written to IndexedDB yet.
  const decode = async (list, label) => {
    const ready = [];
    for (const item of list) {
      try {
        ready.push(await deserializeFromBackup(item));
      } catch (e) {
        console.warn(`Skipping unreadable ${label} record in backup:`, e);
        summary.skipped++;
      }
    }
    return ready;
  };

  const readyReports = await decode(reportsIn, "report");
  const readySchools = await decode(schoolsIn, "monthly_schools");
  const readyTemplates = await decode(templatesIn, "monthly_templates");
  const readySubmissions = await decode(submissionsIn, "monthly_submissions");
  const readySceneTemplates = await decode(sceneTemplatesIn, "scene_templates");
  const readySceneTracking = await decode(sceneTrackingIn, "scene_tracking");

  // Phase 2: only now, after validation + decoding succeeded, write to
  // IndexedDB — guarded by the snapshot/rollback safety net.
  const preRestoreSnapshot = await snapshotAllStores();
  try {
    for (const r of readyReports) {
      if (!r || !r.id) { summary.skipped++; continue; }
      r.observations = Array.isArray(r.observations) ? r.observations : [];
      await saveReport(r);
      summary.reports++;
    }
    for (const s of readySchools) {
      if (!s || !s.id) { summary.skipped++; continue; }
      await storePut(MONTHLY_SCHOOLS_STORE, s);
      summary.monthly_schools++;
    }
    for (const tpl of readyTemplates) {
      if (!tpl || !tpl.id) { summary.skipped++; continue; }
      await storePut(MONTHLY_TEMPLATE_STORE, tpl);
      summary.monthly_templates++;
    }
    for (const sub of readySubmissions) {
      if (!sub || !sub.id) { summary.skipped++; continue; }
      await storePut(MONTHLY_SUBMISSIONS_STORE, sub);
      summary.monthly_submissions++;
    }
    for (const tpl of readySceneTemplates) {
      if (!tpl || !tpl.id) { summary.skipped++; continue; }
      await storePut(SCENE_TEMPLATE_STORE, tpl);
      summary.scene_templates++;
    }
    for (const tr of readySceneTracking) {
      if (!tr || !tr.id) { summary.skipped++; continue; }
      await storePut(SCENE_TRACKING_STORE, tr);
      summary.scene_tracking++;
    }
  } catch (err) {
    console.error("Restore failed partway through — rolling back to the pre-restore snapshot:", err);
    try {
      await restoreFromSnapshot(preRestoreSnapshot);
    } catch (rollbackErr) {
      console.error("CRITICAL: rollback itself failed after a partial restore failure:", rollbackErr);
      throw new Error("restore_failed_rollback_failed");
    }
    throw new Error("restore_failed_rolled_back");
  }

  return summary;
}

// ---------------------------------------------------------------------
// Internal verification helper — NOT exposed in the UI. Exports the
// current data, re-imports it (safe: re-importing identical records by
// id is just an idempotent overwrite), then compares record counts and
// ids to confirm nothing was lost. Run manually from the browser
// console if you ever need to double check:
//   await __testBackupRoundtrip()
// ---------------------------------------------------------------------
async function __testBackupRoundtrip() {
  const snapshot = async () => ({
    reports: await getAllReports(),
    monthly_schools: await storeGetAll(MONTHLY_SCHOOLS_STORE),
    monthly_templates: await storeGetAll(MONTHLY_TEMPLATE_STORE),
    monthly_submissions: await storeGetAll(MONTHLY_SUBMISSIONS_STORE),
    scene_templates: await storeGetAll(SCENE_TEMPLATE_STORE),
    scene_tracking: await storeGetAll(SCENE_TRACKING_STORE)
  });

  const before = await snapshot();
  const blob = await exportBackupBlob();
  const parsed = JSON.parse(await blob.text());
  const file = new File([blob], "roundtrip_test.json", { type: "application/json" });
  const importSummary = await importBackupFile(file);
  const after = await snapshot();

  const idSet = (arr) => arr.map((r) => r.id).sort().join(",");
  const counts = {};
  for (const key of ["reports", "monthly_schools", "monthly_templates", "monthly_submissions", "scene_templates", "scene_tracking"]) {
    counts[key] = { before: before[key].length, after: after[key].length, exported: parsed.stores[key].length };
  }
  const idsMatch = {
    reports: idSet(before.reports) === idSet(after.reports),
    monthly_schools: idSet(before.monthly_schools) === idSet(after.monthly_schools),
    scene_templates: idSet(before.scene_templates) === idSet(after.scene_templates),
    scene_tracking: idSet(before.scene_tracking) === idSet(after.scene_tracking)
  };
  const passed = Object.values(counts).every((c) => c.before === c.after) &&
    idsMatch.reports && idsMatch.monthly_schools && idsMatch.scene_templates && idsMatch.scene_tracking;

  const result = { backupVersion: parsed.backupVersion, counts, idsMatch, importSummary, passed };
  console.log("Backup roundtrip test:", result);
  return result;
}

// ---------------------------------------------------------------------
// Storage health check — NOT exposed in the UI (the "🔍 فحص البيانات
// المخزّنة" screen is a separate, simpler, read-only display for
// end users). This is an internal diagnostic for structural problems —
// missing ids, missing/empty photo Blobs, dangling references, etc. —
// without changing anything. Run manually from the browser console:
//   await __storageHealthCheck()
// ---------------------------------------------------------------------
async function __storageHealthCheck() {
  const issues = [];
  const add = (level, message) => issues.push({ level, message });

  let dbAvailable = true;
  try {
    await openDB();
  } catch (e) {
    dbAvailable = false;
    add("critical", "IndexedDB unavailable: " + e.message);
  }

  const result = { dbAvailable, storeCounts: {}, issues };
  if (!dbAvailable) {
    result.healthy = false;
    return result;
  }

  const reports = await getAllReports();
  result.storeCounts.reports = reports.length;
  reports.forEach((r, i) => {
    if (!r.id) { add("critical", `Report at index ${i} has no id`); return; }
    if (!Array.isArray(r.observations)) {
      add("warning", `Report ${r.id} has no observations array`);
      return;
    }
    r.observations.forEach((obs, oi) => {
      if (typeof obs.text !== "string") add("warning", `Report ${r.id} observation #${oi} is missing text`);
      obsPhotos(obs).forEach((p, pi) => {
        if (!p || !(p.blob instanceof Blob) || p.blob.size === 0) {
          add("critical", `Report ${r.id} observation #${oi} photo #${pi} has a missing/empty Blob`);
        }
      });
      if (obs.audioBlob && !(obs.audioBlob instanceof Blob)) {
        add("critical", `Report ${r.id} observation #${oi} has a non-Blob audioBlob`);
      }
      if (obs.followUp && obs.followUp.afterPhoto && !(obs.followUp.afterPhoto.blob instanceof Blob)) {
        add("critical", `Report ${r.id} observation #${oi} has a non-Blob follow-up after-photo`);
      }
    });
  });

  const schools = await storeGetAll(MONTHLY_SCHOOLS_STORE);
  result.storeCounts.monthly_schools = schools.length;
  const schoolIds = new Set(schools.map((s) => s.id));
  schools.forEach((s) => { if (!s.id) add("critical", "A monthly school has no id"); });

  const submissions = await storeGetAll(MONTHLY_SUBMISSIONS_STORE);
  result.storeCounts.monthly_submissions = submissions.length;
  submissions.forEach((sub) => {
    if (!sub.id) { add("critical", "A monthly submission has no id"); return; }
    if (sub.schoolId && !schoolIds.has(sub.schoolId)) {
      add("warning", `Monthly submission ${sub.id} references a school that no longer exists (${sub.schoolId})`);
    }
    Object.entries(sub.photos || {}).forEach(([slotId, entry]) => {
      if (!entry || !(entry.blob instanceof Blob) || entry.blob.size === 0) {
        add("critical", `Monthly submission ${sub.id} slot ${slotId} has a missing/empty Blob`);
      }
    });
  });

  result.storeCounts.monthly_templates = (await storeGetAll(MONTHLY_TEMPLATE_STORE)).length;
  result.storeCounts.scene_templates = (await storeGetAll(SCENE_TEMPLATE_STORE)).length;

  const sceneTracking = await storeGetAll(SCENE_TRACKING_STORE);
  result.storeCounts.scene_tracking = sceneTracking.length;
  sceneTracking.forEach((tr) => {
    if (!tr.id) { add("critical", "A scene-tracking record has no id"); return; }
    if (tr.schoolId && !schoolIds.has(tr.schoolId)) {
      add("warning", `Scene tracking ${tr.id} references a school that no longer exists (${tr.schoolId})`);
    }
  });

  try {
    await exportBackupBlob();
    result.backupSerializationOk = true;
  } catch (e) {
    result.backupSerializationOk = false;
    add("critical", "exportBackupBlob() failed: " + e.message);
  }

  result.healthy = issues.filter((i) => i.level === "critical").length === 0;
  console.log("Storage health check:", result);
  return result;
}

// ---------------------------------------------------------------------
// Generic single-store helpers, reused by all three monthly-photos stores.
// ---------------------------------------------------------------------

async function storeGetAll(storeName) {
  const db = await openDB();
  const records = await new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return records.map(buffersToBlobsAfterRead);
}

async function storeGet(storeName, id) {
  const db = await openDB();
  const record = await new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  return record ? buffersToBlobsAfterRead(record) : null;
}

// Same internal retry (withRetry) that saveReport() already relies on —
// covers the same transient failures (a brief lock, a just-dropped
// connection) for every other store (monthly schools/template/
// submissions, scene tracking/templates) instead of failing on the
// first hiccup. Also runs every record through the same WebKit-safe
// Blob→ArrayBuffer conversion saveReport() uses (monthly-photo
// submissions store Blobs too).
async function storePut(storeName, record) {
  const safeRecord = await blobsToBuffersForWrite(record);
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(safeRecord);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    });
  });
}

async function storeDelete(storeName, id) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    });
  });
}

// ---------------------------------------------------------------------
// Monthly required-photos feature
// ---------------------------------------------------------------------

// Matches the real PowerPoint template's 15 photo placeholders exactly
// (see pptx.js's PPTX_IMAGE_MAP) — duplicate categories are intentional,
// since the template has multiple frames for some of them (e.g. two
// "صورة الموقع العام" photos, four "الأمن والسلامة" photos).
//
// "لافتة المبنى" (building sign) is listed first so it's also the first
// photo the checklist/photo grid asks for.
//
// Each entry's `category` is the STABLE key pptx.js matches against to
// pick which documented photo goes in which template frame — separate
// from `label`, which is only the display text and is free for the user
// to rename via "إدارة قائمة الصور المطلوبة" without breaking that match
// (see getMonthlySlots()'s back-compat fallback below, and pptx.js's
// groupFilledSlotsByLabel()).
const DEFAULT_MONTHLY_SLOTS = [
  { category: "لافتة المبنى", label: "لافتة المبنى" },
  { category: "صورة الموقع العام", label: "صورة الموقع العام" },
  { category: "صورة الموقع العام", label: "صورة الموقع العام" },
  { category: "صورة المدرسة / المبنى", label: "صورة المدرسة / المبنى" },
  { category: "صورة المدرسة / المبنى", label: "صورة المدرسة / المبنى" },
  { category: "السطح", label: "السطح" },
  { category: "صور الممرات", label: "صور الممرات" },
  { category: "صور الحمام / المطبخ", label: "صور الحمام / المطبخ" },
  { category: "صور للفصول / المكاتب", label: "صور للفصول / المكاتب" },
  { category: "صور للفصول / المكاتب", label: "صور للفصول / المكاتب" },
  { category: "صور للفصول / المكاتب", label: "صور للفصول / المكاتب" },
  { category: "الأمن والسلامة", label: "الأمن والسلامة" },
  { category: "الأمن والسلامة", label: "الأمن والسلامة" },
  { category: "الأمن والسلامة", label: "الأمن والسلامة" },
  { category: "الأمن والسلامة", label: "الأمن والسلامة" }
];

// Returns the shared checklist of required photo types (same for every school).
async function getMonthlySlots() {
  const record = await storeGet(MONTHLY_TEMPLATE_STORE, "template");
  if (record && record.slots && record.slots.length) {
    // Back-compat: a template saved before `category` existed (or a slot
    // added/edited without one) falls back to its own label — exactly
    // today's matching behavior, unchanged for anyone who hasn't renamed
    // that slot since.
    return record.slots.map((s) => (s.category ? s : { ...s, category: s.label }));
  }
  return DEFAULT_MONTHLY_SLOTS.map((def, i) => ({ id: "slot_" + i, label: def.label, category: def.category }));
}

async function saveMonthlySlots(slots) {
  await storePut(MONTHLY_TEMPLATE_STORE, { id: "template", slots, updatedAt: Date.now() });
}

async function getAllMonthlySchools() {
  const schools = await storeGetAll(MONTHLY_SCHOOLS_STORE);
  return schools.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ar"));
}

async function addMonthlySchool(name) {
  const school = { id: generateId(), name, createdAt: Date.now(), updatedAt: Date.now() };
  await storePut(MONTHLY_SCHOOLS_STORE, school);
  return school;
}

async function deleteMonthlySchool(id) {
  await storeDelete(MONTHLY_SCHOOLS_STORE, id);
}

function submissionId(schoolId, monthKey) {
  return `${schoolId}__${monthKey}`;
}

// Returns { id, schoolId, monthKey, visitDate, photos: { [slotId]: {blob, takenAt} } }
async function getMonthlySubmission(schoolId, monthKey) {
  const record = await storeGet(MONTHLY_SUBMISSIONS_STORE, submissionId(schoolId, monthKey));
  return record || { id: submissionId(schoolId, monthKey), schoolId, monthKey, visitDate: `${monthKey}-01`, photos: {} };
}

async function saveMonthlySubmission(submission) {
  submission.updatedAt = Date.now();
  await storePut(MONTHLY_SUBMISSIONS_STORE, submission);
}

// ---------------------------------------------------------------------
// Scene tracking ("📋 متابعة المشاهد") — independent list from the
// monthly-photos slots, but the same school+month scoping pattern.
// ---------------------------------------------------------------------

// Scene definitions: one global, user-managed list — { id, label } — like
// the monthly-photo slots editor, but its own separate store.
async function getSceneTemplate() {
  const record = await storeGet(SCENE_TEMPLATE_STORE, "template");
  return record && Array.isArray(record.scenes) ? record.scenes : [];
}

async function saveSceneTemplate(scenes) {
  await storePut(SCENE_TEMPLATE_STORE, { id: "template", scenes, updatedAt: Date.now() });
}

function sceneTrackingId(schoolId, monthKey) {
  return `${schoolId}__${monthKey}`;
}

// Returns { id, schoolId, monthKey, createdAt, updatedAt,
//           scenes: { [sceneId]: { status, updatedAt, history: [{status, at}] } } }
// A brand-new school+month combination is returned as a blank record —
// deterministic id (schoolId__monthKey) means calling this repeatedly
// for the same month never creates duplicates.
async function getSceneTracking(schoolId, monthKey) {
  const record = await storeGet(SCENE_TRACKING_STORE, sceneTrackingId(schoolId, monthKey));
  return record || {
    id: sceneTrackingId(schoolId, monthKey),
    schoolId,
    monthKey,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    scenes: {}
  };
}

async function saveSceneTracking(tracking) {
  tracking.updatedAt = Date.now();
  await storePut(SCENE_TRACKING_STORE, tracking);
}

async function getAllSceneTrackingForSchool(schoolId) {
  const all = await storeGetAll(SCENE_TRACKING_STORE);
  return all.filter((t) => t.schoolId === schoolId);
}

function sceneCompletionStats(scenes, trackingRecord) {
  const statuses = trackingRecord && trackingRecord.scenes ? trackingRecord.scenes : {};
  let received = 0, sent = 0, notDone = 0;
  scenes.forEach((scene) => {
    const s = statuses[scene.id] ? statuses[scene.id].status : "not_done";
    if (s === "received") received++;
    else if (s === "sent_to_supervisor") sent++;
    else notDone++;
  });
  const total = scenes.length;
  const completed = received + sent;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { total, received, sent, notDone, completed, percent };
}
