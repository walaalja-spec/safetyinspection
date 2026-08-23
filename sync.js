// ---------------------------------------------------------------------
// sync.js
// Cloud-sync engine. IndexedDB (storage.js) is and remains the only
// place a save can be considered successful — this file only pushes
// already-safely-saved local records to Cloudflare D1/R2 as a secondary
// copy, in the background, best-effort, retryable. Nothing here is ever
// on the critical path of "did the user's save succeed" — see
// saveCurrentObservation() in app.js, which calls enqueueEntitySync()
// only *after* saveReport() has already resolved.
//
// Never embeds any secret: /api/* now accepts a same-origin request
// (real Origin/Referer header, which every fetch() from this page sends
// automatically) without needing the API_INTERNAL_KEY fallback that
// exists only to lock out headerless direct access (see worker.js).
// ---------------------------------------------------------------------

const SYNC_MAX_BACKOFF_MS = 60000;
// Status codes where retrying the exact same request can't help --
// the payload itself is the problem, not a transient condition.
const SYNC_PERMANENT_STATUS = new Set([400, 404, 409, 413, 415, 422]);

let syncInFlight = false;

function syncBackoffMs(retryCount) {
  return Math.min(1000 * Math.pow(2, retryCount), SYNC_MAX_BACKOFF_MS);
}

// Queues an already-saved local record for background cloud sync. Called
// *after* the local IndexedDB write already succeeded -- this never
// blocks or gates the local save itself.
async function enqueueEntitySync(entityType, op, localRefId, payload) {
  try {
    await enqueueSyncItem({ entityType, op, localRefId, payload });
    updateSyncIndicator();
    scheduleSyncSoon();
  } catch (err) {
    // The sync queue itself is IndexedDB too -- if even this fails, the
    // real record (already saved) is still completely safe; sync is just
    // best-effort and can be resumed by rescanning stores later. Never
    // let a queueing failure surface as a user-facing save error.
    console.warn("Failed to enqueue sync item (local save is unaffected):", err);
  }
}

// True once a school/visit this item depends on has actually synced --
// local id === cloud id (client-supplied, see worker.js), so no separate
// id-translation table is needed; this just checks that a "synced" queue
// entry exists for that id.
async function dependencySynced(entityType, localRefId) {
  if (!localRefId) return true; // no dependency (e.g. a "quick visit" with no school)
  const all = await getAllSyncItems();
  return all.some((it) => it.entityType === entityType && it.localRefId === localRefId && it.status === "synced");
}

async function apiFetch(path, options) {
  const res = await fetch(path, options);
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON response */ }
  return { status: res.status, ok: res.ok, json };
}

// Returns { done: true } on success/permanent-give-up (item is now
// "synced" or "failed"), or { done: false } if it's not this item's turn
// yet (dependency not synced, or still within its backoff window) --
// in the { done: false } case the item's status is left exactly as
// found (still "pending"/"failed"), never "syncing", so a later pass
// still sees it via getPendingSyncItems().
async function processSyncItem(item) {
  if (item.op !== "create") {
    // update/delete sync isn't wired up yet -- see PHASE2_MIGRATION_PLAN.md
    // for scope. Leave it in the queue rather than silently dropping it.
    return { done: false };
  }

  if (item.status === "failed" && item.retryCount > 0) {
    const readyAt = item.updatedAt + syncBackoffMs(item.retryCount - 1);
    if (Date.now() < readyAt) return { done: false };
  }

  let depType = null, depId = null;
  if (item.entityType === "visit" && item.payload.schoolId) {
    depType = "school"; depId = item.payload.schoolId;
  } else if (item.entityType === "observation") {
    depType = "visit"; depId = item.payload.visitId;
  }
  if (depType && !(await dependencySynced(depType, depId))) {
    return { done: false }; // parent hasn't synced yet -- try again next pass
  }

  const endpoint = { school: "/api/schools", visit: "/api/visits", observation: "/api/observations" }[item.entityType];
  if (!endpoint) return { done: false };

  // Only now -- past every reason to skip this pass -- is a network
  // attempt actually about to happen, so only now does "syncing" become
  // true. Setting this any earlier (e.g. in flushSyncQueue before the
  // dependency check above) would leave a dependency-blocked item stuck
  // at "syncing" forever, since getPendingSyncItems() only looks for
  // "pending"/"failed".
  await updateSyncItem(item.id, { status: "syncing" });

  let result;
  try {
    result = await apiFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item.payload)
    });
  } catch (networkErr) {
    // Offline / DNS / connection reset -- always transient.
    await updateSyncItem(item.id, {
      status: "failed",
      retryCount: item.retryCount + 1,
      lastError: "network_error: " + networkErr.message
    });
    return { done: false };
  }

  if (result.ok && result.json && result.json.success) {
    await updateSyncItem(item.id, {
      status: "synced",
      cloudId: result.json.data.id,
      syncedAt: Date.now(),
      lastError: null
    });
    return { done: true };
  }

  const errCode = (result.json && result.json.error) || `http_${result.status}`;
  if (SYNC_PERMANENT_STATUS.has(result.status)) {
    // Won't self-heal by retrying the same payload -- stop auto-retrying,
    // but keep the entry (and the already-safe local record) for
    // visibility/manual follow-up rather than discarding anything.
    await updateSyncItem(item.id, { status: "failed", lastError: errCode, retryCount: item.retryCount });
    return { done: true };
  }
  // 401/403 (unexpected here on same-origin) / 5xx -- transient.
  await updateSyncItem(item.id, {
    status: "failed",
    retryCount: item.retryCount + 1,
    lastError: errCode
  });
  return { done: false };
}

async function flushSyncQueue() {
  // A flush already running when this fires (e.g. an enqueue's
  // scheduleSyncSoon landing mid-pass) must not just return and drop the
  // new work silently -- the "still pending after this pass" check below
  // re-schedules once the in-flight pass finishes, so nothing is missed.
  if (syncInFlight) { scheduleSyncSoon(); return; }
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  syncInFlight = true;
  try {
    const pending = await getPendingSyncItems();
    for (const item of pending) {
      await processSyncItem(item); // records its own status transition either way
    }
  } finally {
    syncInFlight = false;
    updateSyncIndicator();
  }
  // A dependency that just became synced in this very pass (e.g. a visit
  // right before the observation that needed it), or an item skipped
  // above because a flush was already running, is ready for another
  // attempt right away rather than waiting for the 20s periodic tick.
  // Items only backed off after a transient failure are deliberately
  // excluded here -- re-checking those every 500ms would defeat the
  // point of backoff; the periodic 20s tick covers them instead.
  const stillPending = await getPendingSyncItems();
  const readyNow = stillPending.some((it) =>
    it.status === "pending" || it.retryCount === 0 || Date.now() >= it.updatedAt + syncBackoffMs(it.retryCount - 1)
  );
  if (readyNow) scheduleSyncSoon();
}

let syncSoonTimer = null;
function scheduleSyncSoon() {
  clearTimeout(syncSoonTimer);
  syncSoonTimer = setTimeout(flushSyncQueue, 500);
}

function updateSyncIndicator() {
  const el = document.getElementById("cloudSyncIndicator");
  if (!el) return;
  getPendingSyncItems().then((pending) => {
    if (pending.length === 0) {
      el.style.display = "none";
      return;
    }
    const stuck = pending.some((it) => it.retryCount >= 5);
    el.textContent = stuck
      ? (typeof t === "function" ? t("cloudSyncNeedsAttention") : "تعذّرت مزامنة بعض البيانات — سيُعاد المحاولة")
      : (typeof t === "function" ? t("cloudSyncPending")(pending.length) : `جاري مزامنة ${pending.length} عنصر مع السحابة`);
    el.style.display = "flex";
  }).catch(() => {});
}

if (typeof window !== "undefined") {
  window.addEventListener("online", flushSyncQueue);
  setInterval(flushSyncQueue, 20000);
  window.addEventListener("DOMContentLoaded", () => {
    updateSyncIndicator();
    flushSyncQueue();
  });
}
