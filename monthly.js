// ---------------------------------------------------------------------
// monthly.js
// A separate feature from the safety reports: every month, a fixed
// checklist of required photos (same list for every school) needs to
// be captured per school. Uses the same storage.js (IndexedDB), and
// reuses app.js's t()/currentLang/showScreen/showToast/compressImage —
// this file is loaded after app.js so those are already defined.
// ---------------------------------------------------------------------

let monthlySlots = [];
let monthlySchools = [];
let currentMonthKey = "";
let activeSchool = null;
let activeSubmission = null;
let captureSlotId = null;

function defaultMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

document.getElementById("openMonthlyBtn").addEventListener("click", async () => {
  const picker = document.getElementById("monthlyMonthPicker");
  if (!picker.value) picker.value = defaultMonthKey();
  currentMonthKey = picker.value;
  monthlySlots = await getMonthlySlots();
  monthlySchools = await getAllMonthlySchools();
  await renderMonthlySchoolsList();
  showScreen("screen-monthly-home");
});

document.getElementById("monthlyBackHomeBtn").addEventListener("click", () => {
  showScreen("screen-home");
});

document.getElementById("monthlyMonthPicker").addEventListener("change", async (e) => {
  currentMonthKey = e.target.value || defaultMonthKey();
  await renderMonthlySchoolsList();
});

// ---------- Schools list ----------
async function renderMonthlySchoolsList() {
  const listEl = document.getElementById("monthlySchoolsList");
  const emptyEl = document.getElementById("noMonthlySchoolsMsg");
  listEl.innerHTML = "";

  if (monthlySchools.length === 0) {
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";

  for (const school of monthlySchools) {
    const submission = await getMonthlySubmission(school.id, currentMonthKey);
    const doneCount = Object.keys(submission.photos || {}).length;
    const total = monthlySlots.length || 1;
    const pct = Math.round((doneCount / total) * 100);

    const card = document.createElement("div");
    card.className = "monthly-school-card";
    card.innerHTML = `
      <h4>${escapeHtml(school.name)}</h4>
      <div class="monthly-progress-bar"><div class="monthly-progress-fill" style="width:${pct}%"></div></div>
      <p class="muted">${t("monthlyProgress")(doneCount, monthlySlots.length)}</p>
      <div class="card-actions">
        <button class="card-open monthly-open" data-id="${school.id}">${t("monthlyOpenBtn")}</button>
        <button class="card-delete monthly-delete-school" data-id="${school.id}">${t("deleteBtn")}</button>
      </div>
    `;
    listEl.appendChild(card);
  }

  listEl.querySelectorAll(".monthly-open").forEach((btn) => {
    btn.addEventListener("click", () => openSchoolPhotos(btn.dataset.id));
  });
  listEl.querySelectorAll(".monthly-delete-school").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (confirm(t("monthlyDeleteSchoolConfirm"))) {
        await deleteMonthlySchool(btn.dataset.id);
        monthlySchools = await getAllMonthlySchools();
        showToast(t("monthlySchoolDeleted"), "success");
        renderMonthlySchoolsList();
      }
    });
  });
}

let isAddingMonthlySchool = false;
document.getElementById("addSchoolBtn").addEventListener("click", async () => {
  if (isAddingMonthlySchool) return; // guards against a duplicate school record from a rapid double-tap
  const input = document.getElementById("newSchoolNameInput");
  const name = input.value.trim();
  if (!name) {
    showToast(t("needSchoolName"), "warning");
    return;
  }
  isAddingMonthlySchool = true;
  const btn = document.getElementById("addSchoolBtn");
  btn.disabled = true;
  try {
    const school = await addMonthlySchool(name);
    // See the matching addSchoolBtnHome handler in app.js for why this
    // matters -- without it, this school (and every visit/observation/
    // photo created under it) never reaches the cloud, silently.
    if (typeof enqueueEntitySync === "function") {
      enqueueEntitySync("school", "create", school.id, { id: school.id, name: school.name });
    }
    input.value = "";
    monthlySchools = await getAllMonthlySchools();
    renderMonthlySchoolsList();
  } finally {
    btn.disabled = false;
    isAddingMonthlySchool = false;
  }
});

// ---------- Template settings ----------
document.getElementById("monthlyTemplateSettingsBtn").addEventListener("click", async () => {
  monthlySlots = await getMonthlySlots();
  renderSlotsEditor();
  showScreen("screen-monthly-template");
});

document.getElementById("cancelSlotsBtn").addEventListener("click", () => showScreen("screen-monthly-home"));

function renderSlotsEditor() {
  const el = document.getElementById("monthlySlotsEditor");
  el.innerHTML = "";
  monthlySlots.forEach((slot) => {
    const row = document.createElement("div");
    row.className = "monthly-slot-row";
    row.innerHTML = `
      <input type="text" value="${escapeHtml(slot.label)}" data-i18n-placeholder="monthlySlotLabelPlaceholder" placeholder="${t("monthlySlotLabelPlaceholder")}">
      <button type="button" class="monthly-slot-remove" aria-label="${t("deleteBtn")}">✕</button>
    `;
    row.querySelector(".monthly-slot-remove").addEventListener("click", () => {
      row.remove();
    });
    row.dataset.slotId = slot.id;
    // Preserved (not shown/editable here) so renaming a slot's display
    // label doesn't break which PowerPoint frame its photos map to —
    // see pptx.js's groupFilledSlotsByLabel().
    if (slot.category) row.dataset.category = slot.category;
    el.appendChild(row);
  });
}

document.getElementById("addSlotBtn").addEventListener("click", () => {
  const el = document.getElementById("monthlySlotsEditor");
  const row = document.createElement("div");
  row.className = "monthly-slot-row";
  row.dataset.slotId = "slot_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
  row.innerHTML = `
    <input type="text" value="" placeholder="${t("monthlySlotLabelPlaceholder")}">
    <button type="button" class="monthly-slot-remove" aria-label="${t("deleteBtn")}">✕</button>
  `;
  row.querySelector(".monthly-slot-remove").addEventListener("click", () => row.remove());
  el.appendChild(row);
  row.querySelector("input").focus();
});

document.getElementById("saveSlotsBtn").addEventListener("click", async () => {
  const rows = document.querySelectorAll("#monthlySlotsEditor .monthly-slot-row");
  const newSlots = [];
  rows.forEach((row) => {
    const label = row.querySelector("input").value.trim();
    if (!label) return;
    const slot = { id: row.dataset.slotId, label };
    if (row.dataset.category) slot.category = row.dataset.category;
    newSlots.push(slot);
  });
  await saveMonthlySlots(newSlots);
  monthlySlots = newSlots;
  showToast(t("monthlySlotsSaved"), "success");
  await renderMonthlySchoolsList();
  showScreen("screen-monthly-home");
});

// ---------- Per-school photo grid ----------
async function openSchoolPhotos(schoolId) {
  activeSchool = monthlySchools.find((s) => s.id === schoolId);
  if (!activeSchool) return;
  activeSubmission = await getMonthlySubmission(schoolId, currentMonthKey);

  document.getElementById("monthlySchoolTitle").textContent = activeSchool.name;
  document.getElementById("monthlyVisitDateInput").value = activeSubmission.visitDate || `${currentMonthKey}-01`;
  await renderMonthlySlotsGrid();
  showScreen("screen-monthly-school");
}

document.getElementById("monthlyVisitDateInput").addEventListener("change", async (e) => {
  activeSubmission.visitDate = e.target.value;
  await saveMonthlySubmission(activeSubmission);
  await renderMonthlySlotsGrid();
});

function formatVisitDateDisplay(isoDateStr) {
  if (!isoDateStr) return "";
  const [y, m, d] = isoDateStr.split("-");
  return `${d}-${m}-${y}`;
}

function monthlyOverlayLines(schoolName, visitDateIso) {
  return [schoolName, formatVisitDateDisplay(visitDateIso)];
}

function monthlyFileName(school, slot, ext) {
  return `${sanitizeFileNamePart(school.name)}_${sanitizeFileNamePart(slot.label)}_${currentMonthKey}.${ext}`;
}

async function renderMonthlySlotsGrid() {
  const grid = document.getElementById("monthlySlotsGrid");
  grid.innerHTML = "";
  const doneCount = Object.keys(activeSubmission.photos || {}).length;
  const total = monthlySlots.length;
  const isComplete = total > 0 && doneCount === total;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  document.getElementById("monthlySchoolProgress").innerHTML = `
    <div class="monthly-progress-row">
      <span>${doneCount} / ${total}</span>
      <span class="status-badge ${isComplete ? "status-completed" : "status-incomplete"}">
        ${isComplete ? "🟢 " + t("statusComplete") : "🟠 " + t("statusIncomplete")}
      </span>
    </div>
    <div class="progress-bar-track"><div class="progress-bar-fill ${isComplete ? "" : "warning"}" style="width:${pct}%"></div></div>
  `;

  for (const slot of monthlySlots) {
    const entry = activeSubmission.photos[slot.id];
    const card = document.createElement("div");
    card.className = "monthly-slot-card";
    card.innerHTML = `
      <div class="slot-label">${escapeHtml(slot.label)}</div>
      <div class="monthly-slot-photo-box ${entry ? "filled" : ""}">
        ${entry ? "" : `<span class="monthly-slot-placeholder">＋</span>`}
        ${entry ? `<button type="button" class="monthly-slot-remove-photo" data-slot="${slot.id}" aria-label="${t("deleteBtn")}">✕</button>` : ""}
      </div>
      <div class="monthly-slot-actions">
        <button type="button" class="monthly-slot-camera" data-slot="${slot.id}">${t("btnMonthlyCamera")}</button>
        <button type="button" class="monthly-slot-gallery" data-slot="${slot.id}">${t("btnMonthlyGallery")}</button>
        ${entry ? `<button type="button" class="monthly-slot-save" data-slot="${slot.id}">💾</button>` : ""}
      </div>
    `;
    grid.appendChild(card);

    if (entry) {
      const lines = monthlyOverlayLines(activeSchool.name, activeSubmission.visitDate);
      createDocumentedPhoto(entry.blob, lines, currentLang === "ar")
        .then((docBlob) => {
          const img = document.createElement("img");
          img.src = URL.createObjectURL(docBlob);
          img.alt = "";
          card.querySelector(".monthly-slot-photo-box").prepend(img);
        })
        .catch((err) => {
          console.error("Failed to generate documented photo, showing original instead:", err);
          const img = document.createElement("img");
          img.src = URL.createObjectURL(entry.blob);
          img.alt = "";
          card.querySelector(".monthly-slot-photo-box").prepend(img);
        });
    }
  }

  grid.querySelectorAll(".monthly-slot-camera").forEach((btn) => {
    btn.addEventListener("click", () => {
      captureSlotId = btn.dataset.slot;
      document.getElementById("monthlyCameraInput").click();
    });
  });
  grid.querySelectorAll(".monthly-slot-gallery").forEach((btn) => {
    btn.addEventListener("click", () => {
      captureSlotId = btn.dataset.slot;
      document.getElementById("monthlyGalleryInput").click();
    });
  });
  grid.querySelectorAll(".monthly-slot-remove-photo").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const removed = activeSubmission.photos[btn.dataset.slot];
      delete activeSubmission.photos[btn.dataset.slot];
      const ok = await persistMonthlySubmissionResilient(activeSubmission);
      if (!ok) {
        // Keep it removed from the UI's perspective (matches user intent)
        // but the underlying write is queued and will retry in the
        // background -- surfacing this as a hard failure with the photo
        // restored would be more confusing than reassuring here.
        console.error("Failed to persist photo deletion after internal retries; queued for background retry.", removed);
      }
      showToast(t("monthlyPhotoDeleted"), "success");
      await renderMonthlySlotsGrid();
      updatePendingSaveIndicator();
    });
  });
  grid.querySelectorAll(".monthly-slot-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const slot = monthlySlots.find((s) => s.id === btn.dataset.slot);
      const entry = activeSubmission.photos[btn.dataset.slot];
      if (!slot || !entry) return;
      const lines = monthlyOverlayLines(activeSchool.name, activeSubmission.visitDate);
      const docBlob = await createDocumentedPhoto(entry.blob, lines, currentLang === "ar");
      const result = await sharePhotoBlob(docBlob, monthlyFileName(activeSchool, slot, "jpg"));
      if (result === "fallback") showToast(t("shareFallbackMsg"));
    });
  });
}

// ---------- Resilient monthly-submission saving ----------
// Mirrors app.js's pendingSaveQueue/persistReportResilient/
// flushPendingSaves pattern for reports: saveMonthlySubmission() already
// retries a failed write internally (storage.js's storePut, same
// withRetry() saveReport() uses), but if every retry is exhausted the
// photo must not be silently lost -- it's queued here, and app.js's
// flushPendingSaves() (already running on a 15s interval / 'online'
// event) keeps retrying it in the background without any new timer.
const pendingMonthlySaveQueue = new Map(); // submissionId -> submission object awaiting a successful write

async function persistMonthlySubmissionResilient(submission) {
  try {
    await saveMonthlySubmission(submission);
    pendingMonthlySaveQueue.delete(submission.id);
    return true;
  } catch (err) {
    console.error("Persist failed for monthly submission after internal retries, queued for background retry:", err);
    pendingMonthlySaveQueue.set(submission.id, submission);
    return false;
  }
}

async function flushPendingMonthlySaves() {
  if (pendingMonthlySaveQueue.size === 0) return;
  for (const [id, submission] of Array.from(pendingMonthlySaveQueue.entries())) {
    await persistMonthlySubmissionResilient(submission);
  }
}

async function handleMonthlyPhotoInput(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !captureSlotId) return;
  const slotId = captureSlotId;
  captureSlotId = null;

  let blob;
  try {
    // Higher resolution/quality than the default report photos, since
    // these are official documentation photos that may be reviewed closely.
    blob = await compressImage(file, 2200, 0.92);
  } catch (err) {
    console.error("Failed to compress monthly photo:", err);
    showToast(currentLang === "ar" ? "تعذر إضافة الصورة." : "Couldn't add the photo.", "error");
    return;
  }

  // The photo is captured in memory (activeSubmission) and the grid is
  // re-rendered from it *before* the write result is known -- the photo
  // is never invisible/appears-lost even if the save is still retrying
  // in the background, and a hard refresh only risks it if the write
  // truly never lands (rare: 3 internal retries + this background queue).
  activeSubmission.photos[slotId] = { blob, takenAt: Date.now() };
  const ok = await persistMonthlySubmissionResilient(activeSubmission);
  await renderMonthlySlotsGrid();
  showToast(ok ? t("monthlyPhotoSaved") : t("monthlySaveFailedQueued"), ok ? "success" : "warning");
  updatePendingSaveIndicator();
}
document.getElementById("monthlyCameraInput").addEventListener("change", handleMonthlyPhotoInput);
document.getElementById("monthlyGalleryInput").addEventListener("change", handleMonthlyPhotoInput);

document.getElementById("monthlySchoolBackBtn").addEventListener("click", async () => {
  await renderMonthlySchoolsList();
  showScreen("screen-monthly-home");
});

// ---------- PowerPoint generation (Phase: monthly photos → PPTX) ----------
document.getElementById("openPptxSummaryBtn").addEventListener("click", () => {
  const completeness = computePptxCompleteness(monthlySlots, activeSubmission);

  document.getElementById("pptxSummarySchoolName").textContent = activeSchool.name;
  document.getElementById("pptxSummaryMonth").textContent = currentMonthKey;
  document.getElementById("pptxSummaryPhotos").textContent =
    `${completeness.done} / ${completeness.total}` + (currentLang === "ar" ? " مكتملة" : " complete");

  const missingNote = document.getElementById("pptxMissingNote");
  if (completeness.missingLabels.length > 0) {
    missingNote.style.display = "block";
    missingNote.textContent = t("pptxMissingList")(completeness.missingLabels.join("، "));
  } else {
    missingNote.style.display = "none";
  }

  showScreen("screen-pptx-summary");
});

document.getElementById("pptxSummaryBackBtn").addEventListener("click", () => {
  showScreen("screen-monthly-school");
});

document.getElementById("generatePptxBtn").addEventListener("click", async () => {
  const btn = document.getElementById("generatePptxBtn");
  const msg = document.getElementById("pptxGeneratingMsg");
  btn.disabled = true;
  msg.style.display = "block";
  try {
    const { blob, fileName } = await generateMonthlyPptx(activeSchool, currentMonthKey);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast(t("pptxGenerated"), "success");
  } catch (err) {
    console.error("PPTX generation failed:", err);
    showToast(t("pptxGenerateFailed"), "error");
  } finally {
    btn.disabled = false;
    msg.style.display = "none";
  }
});

// ---------- Multi-school PowerPoint ----------
document.getElementById("openMultiSchoolBtn").addEventListener("click", async () => {
  document.getElementById("multiSchoolMonthLabel").textContent = currentMonthKey;

  const listEl = document.getElementById("multiSchoolCheckList");
  const emptyEl = document.getElementById("noMultiSchoolsMsg");
  listEl.innerHTML = "";

  if (monthlySchools.length === 0) {
    emptyEl.style.display = "block";
  } else {
    emptyEl.style.display = "none";
    for (const school of monthlySchools) {
      const submission = await getMonthlySubmission(school.id, currentMonthKey);
      const completeness = computePptxCompleteness(monthlySlots, submission);
      const row = document.createElement("label");
      row.className = "multi-school-check-row";
      row.innerHTML = `
        <input type="checkbox" class="msc-checkbox" data-id="${school.id}">
        <div class="msc-info">
          <h4>${escapeHtml(school.name)}</h4>
          <p>${completeness.done} / ${completeness.total} ${currentLang === "ar" ? "صورة" : "photos"}</p>
        </div>
      `;
      listEl.appendChild(row);
    }
  }

  showScreen("screen-multi-school-select");
});

document.getElementById("multiSelectAllBtn").addEventListener("click", () => {
  document.querySelectorAll(".msc-checkbox").forEach((cb) => (cb.checked = true));
});
document.getElementById("multiSelectNoneBtn").addEventListener("click", () => {
  document.querySelectorAll(".msc-checkbox").forEach((cb) => (cb.checked = false));
});

document.getElementById("multiSchoolBackBtn").addEventListener("click", () => {
  showScreen("screen-monthly-home");
});

let multiSelectedSchools = [];

document.getElementById("multiSchoolNextBtn").addEventListener("click", async () => {
  const checkedIds = Array.from(document.querySelectorAll(".msc-checkbox:checked")).map((cb) => cb.dataset.id);
  if (checkedIds.length === 0) {
    showToast(t("multiNeedSelection"), "warning");
    return;
  }
  // Order follows the current app/list order (monthlySchools), not
  // checkbox-click order — matches "استخدم ترتيب المدارس الحالي".
  multiSelectedSchools = monthlySchools.filter((s) => checkedIds.includes(s.id));

  document.getElementById("multiSummaryMonth").textContent = currentMonthKey;
  document.getElementById("multiSummarySchoolCount").textContent = multiSelectedSchools.length;

  const perSchoolList = document.getElementById("multiSummaryPerSchoolList");
  perSchoolList.innerHTML = "";
  const missingParts = [];

  for (const school of multiSelectedSchools) {
    const submission = await getMonthlySubmission(school.id, currentMonthKey);
    const completeness = computePptxCompleteness(monthlySlots, submission);
    const row = document.createElement("p");
    row.textContent = `${school.name} — ${completeness.done}/${completeness.total}`;
    perSchoolList.appendChild(row);
    if (completeness.missingLabels.length > 0) {
      missingParts.push(`${school.name}: ${completeness.missingLabels.join("، ")}`);
    }
  }

  const missingNote = document.getElementById("multiMissingNote");
  if (missingParts.length > 0) {
    missingNote.style.display = "block";
    missingNote.textContent = t("multiMissingWarning") + " " + missingParts.join(" | ");
  } else {
    missingNote.style.display = "none";
  }

  showScreen("screen-multi-school-summary");
});

document.getElementById("multiSummaryBackBtn").addEventListener("click", () => {
  showScreen("screen-multi-school-select");
});

document.getElementById("generateMultiPptxBtn").addEventListener("click", async () => {
  const btn = document.getElementById("generateMultiPptxBtn");
  const msg = document.getElementById("multiPptxGeneratingMsg");
  btn.disabled = true;
  msg.style.display = "block";
  try {
    const { blob, fileName } = await generateMultiSchoolPptx(multiSelectedSchools, currentMonthKey);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast(t("pptxGenerated"), "success");
  } catch (err) {
    console.error("Multi-school PPTX generation failed:", err);
    showToast(t("pptxGenerateFailed"), "error");
  } finally {
    btn.disabled = false;
    msg.style.display = "none";
  }
});
