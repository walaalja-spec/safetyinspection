// ---------------------------------------------------------------------
// scenes.js
// "📋 متابعة المشاهد" — an independent, user-managed list of "scenes"
// tracked per school per month with a 3-state status workflow. This is
// NOT the Monthly Photos feature — different store, different list, by
// explicit design (confirmed with the user before building this).
//
// Data isolation note: there is no server/auth layer in this app (it's
// intentionally single-device, local-only — see the project's own
// earlier architecture decision). Every read/write here is scoped by
// the school's real id (never by name), matching the pattern already
// used everywhere else in the app.
// ---------------------------------------------------------------------

let sceneList = [];                    // [{id, label}]
let activeSceneSchool = null;          // school object
let activeSceneMonthKey = "";          // "YYYY-MM" currently being viewed/edited
let sceneTrackingReturnScreen = "screen-school-detail";

function defaultSceneMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const SCENE_STATUS_LABELS = {
  ar: { not_done: "⏳ لم يتم", received: "📥 تم الاستلام", sent_to_supervisor: "📤 تم إرساله للمشرف" },
  en: { not_done: "⏳ Not done", received: "📥 Received", sent_to_supervisor: "📤 Sent to supervisor" }
};

function formatSceneTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString(currentLang === "ar" ? "ar-SA" : "en-US", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

document.getElementById("openSceneTrackingBtn").addEventListener("click", async () => {
  if (!activeSchoolForVisits) return;
  activeSceneSchool = activeSchoolForVisits;
  activeSceneMonthKey = defaultSceneMonthKey(); // auto-detected, never asks the user to "start a new cycle"
  sceneTrackingReturnScreen = "screen-school-detail";
  await renderSceneTrackingScreen();
});

// `preloadedTracking`, when passed, is rendered as-is instead of re-fetching
// from IndexedDB -- used right after a save attempt so a write that's still
// retrying in the background (queued, not yet confirmed) doesn't make the
// screen revert the status the user just picked back to its old value.
async function renderSceneTrackingScreen(preloadedTracking) {
  sceneList = await getSceneTemplate();
  const tracking = preloadedTracking || await getSceneTracking(activeSceneSchool.id, activeSceneMonthKey);

  document.getElementById("sceneTrackingSchoolName").textContent = activeSceneSchool.name;
  const isCurrent = activeSceneMonthKey === defaultSceneMonthKey();
  document.getElementById("sceneTrackingMonthLabel").textContent =
    activeSceneMonthKey + (isCurrent ? (currentLang === "ar" ? " (الشهر الحالي)" : " (current month)") : "");

  const stats = sceneCompletionStats(sceneList, tracking);
  document.getElementById("sceneStatReceived").textContent = stats.received;
  document.getElementById("sceneStatSent").textContent = stats.sent;
  document.getElementById("sceneStatNotDone").textContent = stats.notDone;
  document.getElementById("sceneStatPercent").textContent = stats.percent + "%";

  const listEl = document.getElementById("sceneTrackingList");
  const emptyEl = document.getElementById("noScenesMsg");
  listEl.innerHTML = "";

  if (sceneList.length === 0) {
    emptyEl.style.display = "block";
  } else {
    emptyEl.style.display = "none";
    sceneList.forEach((scene) => {
      const entry = tracking.scenes[scene.id];
      const status = entry ? entry.status : "not_done";
      const row = document.createElement("div");
      row.className = "scene-row";
      row.innerHTML = `
        <div class="scene-row-label">${escapeHtml(scene.label)}</div>
        <div class="scene-status-buttons">
          <button class="scene-status-btn ${status === "not_done" ? "active" : ""}" data-scene="${scene.id}" data-status="not_done">⏳</button>
          <button class="scene-status-btn ${status === "received" ? "active" : ""}" data-scene="${scene.id}" data-status="received">📥</button>
          <button class="scene-status-btn ${status === "sent_to_supervisor" ? "active" : ""}" data-scene="${scene.id}" data-status="sent_to_supervisor">📤</button>
        </div>
        ${entry && entry.updatedAt ? `<div class="scene-updated-at">${escapeHtml(SCENE_STATUS_LABELS[currentLang][status])} · ${formatSceneTimestamp(entry.updatedAt)}</div>` : ""}
      `;
      listEl.appendChild(row);
    });

    listEl.querySelectorAll(".scene-status-btn").forEach((btn) => {
      btn.addEventListener("click", () => setSceneStatus(btn.dataset.scene, btn.dataset.status));
    });
  }

  showScreen("screen-scene-tracking");
}

const sceneStatusSaveInFlight = new Set(); // guards a double-tap on the same scene from racing itself

// Same resilient-queue pattern as reports (app.js) and monthly photos
// (monthly.js): saveSceneTracking() already retries a failed write
// internally (storage.js's storePut), but if every retry is exhausted
// the status change is queued here instead of being silently discarded —
// app.js's flushPendingSaves() (already on a 15s interval / 'online'
// event) retries it in the background.
const pendingSceneSaveQueue = new Map(); // trackingId -> tracking object awaiting a successful write

async function persistSceneTrackingResilient(tracking) {
  try {
    await saveSceneTracking(tracking);
    pendingSceneSaveQueue.delete(tracking.id);
    return true;
  } catch (err) {
    console.error("Persist failed for scene tracking after internal retries, queued for background retry:", err);
    pendingSceneSaveQueue.set(tracking.id, tracking);
    return false;
  }
}

async function flushPendingSceneSaves() {
  if (pendingSceneSaveQueue.size === 0) return;
  for (const [id, tracking] of Array.from(pendingSceneSaveQueue.entries())) {
    await persistSceneTrackingResilient(tracking);
  }
}

async function setSceneStatus(sceneId, status) {
  if (sceneStatusSaveInFlight.has(sceneId)) return;
  sceneStatusSaveInFlight.add(sceneId);
  try {
    const tracking = await getSceneTracking(activeSceneSchool.id, activeSceneMonthKey);
    const now = Date.now();
    const prevEntry = tracking.scenes[sceneId];
    const history = prevEntry && prevEntry.history ? prevEntry.history.slice(-19) : []; // bounded audit trail
    history.push({ status, at: now });
    tracking.scenes[sceneId] = { status, updatedAt: now, history };

    const ok = await persistSceneTrackingResilient(tracking);
    await renderSceneTrackingScreen(tracking); // render the in-memory record, not a re-fetch -- stays correct even if the write is still retrying
    if (!ok) showToast(t("monthlySaveFailedQueued"), "warning");
    updatePendingSaveIndicator();
  } catch (err) {
    console.error("Failed to save scene status:", err);
    showToast(t("sceneSaveFailed"), "error");
  } finally {
    sceneStatusSaveInFlight.delete(sceneId);
  }
}

document.getElementById("sceneTrackingBackBtn").addEventListener("click", () => {
  showScreen(sceneTrackingReturnScreen);
});

// ---------- History ----------
document.getElementById("viewSceneHistoryBtn").addEventListener("click", async () => {
  const allTracking = await getAllSceneTrackingForSchool(activeSceneSchool.id);
  const currentKey = defaultSceneMonthKey();
  const pastMonths = allTracking
    .filter((t) => t.monthKey !== currentKey)
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey));

  const listEl = document.getElementById("sceneHistoryList");
  const emptyEl = document.getElementById("noSceneHistoryMsg");
  listEl.innerHTML = "";

  if (pastMonths.length === 0) {
    emptyEl.style.display = "block";
  } else {
    emptyEl.style.display = "none";
    pastMonths.forEach((tracking) => {
      const stats = sceneCompletionStats(sceneList, tracking);
      const card = document.createElement("div");
      card.className = "scene-month-history-card";
      card.innerHTML = `
        <div>
          <h4>${escapeHtml(tracking.monthKey)}</h4>
          <p class="muted">${stats.percent}% ${currentLang === "ar" ? "مكتمل" : "complete"}</p>
        </div>
        <button class="card-open" data-month="${tracking.monthKey}">${t("openBtn")}</button>
      `;
      listEl.appendChild(card);
    });
    listEl.querySelectorAll("button[data-month]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        activeSceneMonthKey = btn.dataset.month;
        sceneTrackingReturnScreen = "screen-scene-history";
        await renderSceneTrackingScreen();
      });
    });
  }

  showScreen("screen-scene-history");
});

document.getElementById("sceneHistoryBackBtn").addEventListener("click", () => {
  showScreen("screen-school-detail");
});

// ---------- Manage scene list ----------
document.getElementById("manageScenesBtn").addEventListener("click", async () => {
  await renderSceneTemplateList();
  showScreen("screen-scene-template");
});

async function renderSceneTemplateList() {
  sceneList = await getSceneTemplate();
  const listEl = document.getElementById("sceneTemplateList");
  listEl.innerHTML = "";
  sceneList.forEach((scene) => {
    const row = document.createElement("div");
    row.className = "report-card";
    row.innerHTML = `
      <h4>${escapeHtml(scene.label)}</h4>
      <div class="card-actions">
        <button class="card-delete scene-delete" data-id="${scene.id}">${t("deleteBtn")}</button>
      </div>
    `;
    listEl.appendChild(row);
  });
  listEl.querySelectorAll(".scene-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (confirm(t("confirmDeleteScene"))) {
        sceneList = sceneList.filter((s) => s.id !== btn.dataset.id);
        await saveSceneTemplate(sceneList);
        showToast(t("sceneDeleted"), "success");
        await renderSceneTemplateList();
      }
    });
  });
}

document.getElementById("addSceneBtn").addEventListener("click", async () => {
  const input = document.getElementById("newSceneNameInput");
  const label = input.value.trim();
  if (!label) {
    showToast(t("needSceneName"), "warning");
    return;
  }
  sceneList.push({ id: generateId(), label });
  await saveSceneTemplate(sceneList);
  input.value = "";
  showToast(t("sceneAdded"), "success");
  await renderSceneTemplateList();
});

document.getElementById("sceneTemplateBackBtn").addEventListener("click", () => {
  showScreen("screen-school-detail");
});
