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

// Two-step monthly-photos flow: step 1 is every slot except the 4
// "الأمن والسلامة" ones, step 2 is just those 4 (now labeled "تكييف
// N" — see storage.js's relabelUntouchedAcSlots()). Grouping by
// `category` here (never by the user-editable `label`) is what keeps
// this correct even if the AC slots get renamed again later, and keeps
// it a pure display split -- the report's own completion count
// (doneCount/monthlySlots.length, used everywhere else in the app)
// still spans every slot from both steps, completely unchanged.
const MONTHLY_STEP2_CATEGORY = "الأمن والسلامة";
let monthlyStepOverride = null; // 1 | 2 | null (null = auto-derive)

function splitMonthlySlotsIntoSteps(slots) {
  const step1 = slots.filter((s) => s.category !== MONTHLY_STEP2_CATEGORY);
  const step2 = slots.filter((s) => s.category === MONTHLY_STEP2_CATEGORY);
  return { step1, step2 };
}

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
    card.dataset.id = school.id;
    card.innerHTML = `
      <h4 class="monthly-school-name">${escapeHtml(school.name)}</h4>
      <div class="monthly-progress-bar"><div class="monthly-progress-fill" style="width:${pct}%"></div></div>
      <p class="muted">${t("monthlyProgress")(doneCount, monthlySlots.length)}</p>
      <div class="card-actions">
        <button class="card-open monthly-open" data-id="${school.id}">${t("monthlyOpenBtn")}</button>
        <button class="card-edit monthly-edit-school" data-id="${school.id}">${t("monthlyEditBtn")}</button>
        <button class="card-delete monthly-delete-school" data-id="${school.id}">${t("deleteBtn")}</button>
      </div>
    `;
    listEl.appendChild(card);
  }

  listEl.querySelectorAll(".monthly-open").forEach((btn) => {
    btn.addEventListener("click", () => openSchoolPhotos(btn.dataset.id));
  });
  listEl.querySelectorAll(".monthly-edit-school").forEach((btn) => {
    btn.addEventListener("click", () => startEditingMonthlySchoolName(btn.dataset.id));
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

// Swaps one school card's name (only) into an inline text input + save/
// cancel — e.g. to fix a mismatch against master-template.pptx's own
// spelling of that school's name (see pptx.js's school-matching, which
// requires an exact match after only light normalization). Only the
// clicked card is touched; the rest of the list is left as-is.
function startEditingMonthlySchoolName(schoolId) {
  const school = monthlySchools.find((s) => s.id === schoolId);
  if (!school) return;
  const card = document.querySelector(`.monthly-school-card[data-id="${schoolId}"]`);
  if (!card) return;
  const nameEl = card.querySelector(".monthly-school-name");

  nameEl.innerHTML = `
    <input type="text" class="monthly-school-rename-input" value="${escapeHtml(school.name)}">
    <button type="button" class="monthly-school-rename-save" aria-label="${t("monthlySaveBtn")}">✓</button>
    <button type="button" class="monthly-school-rename-cancel" aria-label="${t("btnCancel")}">✕</button>
  `;
  const input = nameEl.querySelector(".monthly-school-rename-input");
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    if (!newName) {
      showToast(t("needSchoolName"), "warning");
      return;
    }
    await updateMonthlySchoolName(schoolId, newName);
    monthlySchools = await getAllMonthlySchools();
    showToast(t("monthlySchoolRenamed"), "success");
    renderMonthlySchoolsList();
  };
  nameEl.querySelector(".monthly-school-rename-save").addEventListener("click", save);
  nameEl.querySelector(".monthly-school-rename-cancel").addEventListener("click", () => renderMonthlySchoolsList());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") renderMonthlySchoolsList();
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
  document.getElementById("monthlyDocumentPhotosToggle").checked = activeSchool.documentPhotos !== false;
  // Always re-derive which of the two sections to land on (see
  // splitMonthlySlotsIntoSteps() below) rather than remembering a
  // manual override across schools/visits.
  monthlyStepOverride = null;
  await renderMonthlySlotsGrid();
  showScreen("screen-monthly-school");
}

document.getElementById("monthlyVisitDateInput").addEventListener("change", async (e) => {
  activeSubmission.visitDate = e.target.value;
  await saveMonthlySubmission(activeSubmission);
  await renderMonthlySlotsGrid();
});

document.getElementById("monthlyDocumentPhotosToggle").addEventListener("change", async (e) => {
  await updateMonthlySchoolDocumentation(activeSchool.id, e.target.checked);
  activeSchool.documentPhotos = e.target.checked;
  monthlySchools = await getAllMonthlySchools();
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

// Renders the small header above the grid showing which of the two
// sections is active, its own "X / Y صور" count, and (only when
// relevant) a manual link to the other section -- forward once step 1
// is done, back at any time while on step 2. Does nothing (clears
// itself) when the school's slot list has no "تكييف"/security
// category at all, so a custom slot list without that category is
// completely unaffected.
function renderMonthlyStepIndicator(activeStep, step1, step2) {
  const el = document.getElementById("monthlyStepIndicator");
  if (step2.length === 0) {
    el.innerHTML = "";
    return;
  }
  const slots = activeStep === 2 ? step2 : step1;
  const done = slots.filter((s) => activeSubmission.photos[s.id]).length;
  const title = activeStep === 2 ? t("monthlyAcSectionTitle") : t("monthlyBasicSectionTitle");

  el.innerHTML = `
    <div class="monthly-step-header">
      <h3>${escapeHtml(title)}</h3>
      <span class="monthly-step-badge">${escapeHtml(t("monthlyStepOf")(activeStep, 2))}</span>
    </div>
    <p class="muted">${done} / ${slots.length} ${currentLang === "ar" ? "صور" : "photos"}</p>
    <div class="monthly-step-nav"></div>
  `;

  const nav = el.querySelector(".monthly-step-nav");
  const step1Done = step1.length > 0 && step1.every((s) => activeSubmission.photos[s.id]);
  if (activeStep === 2) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "btn btn-text";
    back.textContent = t("monthlyBackToBasicSection");
    back.addEventListener("click", () => {
      monthlyStepOverride = 1;
      renderMonthlySlotsGrid();
    });
    nav.appendChild(back);
  } else if (step1Done) {
    const fwd = document.createElement("button");
    fwd.type = "button";
    fwd.className = "btn btn-text";
    fwd.textContent = t("monthlyGoToAcSection");
    fwd.addEventListener("click", () => {
      monthlyStepOverride = 2;
      renderMonthlySlotsGrid();
    });
    nav.appendChild(fwd);
  }
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

  const { step1, step2 } = splitMonthlySlotsIntoSteps(monthlySlots);
  const step1Done = step1.length > 0 && step1.every((s) => activeSubmission.photos[s.id]);
  let activeStep = 1;
  if (step2.length > 0) {
    if (monthlyStepOverride === 1) activeStep = 1;
    else if (monthlyStepOverride === 2 && step1Done) activeStep = 2;
    else activeStep = step1Done ? 2 : 1;
  }
  const activeSlots = activeStep === 2 ? step2 : step1;
  renderMonthlyStepIndicator(activeStep, step1, step2);

  for (const slot of activeSlots) {
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
      if (activeSchool.documentPhotos === false) {
        const img = document.createElement("img");
        img.src = URL.createObjectURL(entry.blob);
        img.alt = "";
        card.querySelector(".monthly-slot-photo-box").prepend(img);
      } else {
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
      let shareBlob = entry.blob;
      if (activeSchool.documentPhotos !== false) {
        const lines = monthlyOverlayLines(activeSchool.name, activeSubmission.visitDate);
        shareBlob = await createDocumentedPhoto(entry.blob, lines, currentLang === "ar");
      }
      const result = await sharePhotoBlob(shareBlob, monthlyFileName(activeSchool, slot, "jpg"));
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

// ---------- Multi-school PowerPoint (master-template based) ----------
// Master-template.pptx already has one slide PER school (all 38, fixed) —
// there's nothing for the user to "select", so this flow skips straight
// from the button to a validation summary (screen-multi-school-summary,
// reused as-is) and then generation. screen-multi-school-select and its
// checkboxes are no longer used by this button, but are left in place
// (dead HTML) rather than removed.
let lastMasterValidation = null;

document.getElementById("openMultiSchoolBtn").addEventListener("click", async () => {
  await runMasterValidationAndShowSummary();
});

async function runMasterValidationAndShowSummary() {
  document.getElementById("multiSummaryMonth").textContent = currentMonthKey;

  const perSchoolList = document.getElementById("multiSummaryPerSchoolList");
  const missingNote = document.getElementById("multiMissingNote");
  const generateBtn = document.getElementById("generateMultiPptxBtn");

  perSchoolList.innerHTML = `<p class="muted">${currentLang === "ar" ? "⏳ جارٍ فحص القالب ومطابقة المدارس..." : "⏳ Checking template and matching schools..."}</p>`;
  missingNote.style.display = "none";
  generateBtn.disabled = true;
  document.getElementById("fixUnmatchedNamesBtn").style.display = "none";
  document.getElementById("multiSummarySchoolCount").textContent = "…";

  showScreen("screen-multi-school-summary");

  const validation = await validateMasterSchoolsPptx(currentMonthKey);
  lastMasterValidation = validation;

  document.getElementById("multiSummarySchoolCount").textContent = validation.matchedCount;

  const statLines = [
    `عدد المدارس في القالب: ${validation.templateSlideCount || "-"}`,
    `المدارس المطابقة: ${validation.matchedCount}`,
    `المدارس غير المطابقة: ${validation.unmatchedSlides.length}`,
    `الصور الجديدة: ${validation.newPhotosCount}`,
    `الشرائح التي ستتحدث: ${validation.slidesWillUpdate}`,
    `الخانات التي ستبقى كما هي: ${validation.slotsUnchangedCount}`
  ];
  let html = `<div class="pptx-summary-card">${statLines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}</div>`;

  if (validation.unmatchedSlides.length > 0) {
    const names = validation.unmatchedSlides.map((u) => `الشريحة ${u.slide}: ${u.rawName}`).join("، ");
    html += `<p class="previous-visit-note">مدارس في القالب لم يُعثر لها على مطابقة في قائمة مدارسك (ستبقى شرائحها كما هي بدون تحديث): ${escapeHtml(names)}</p>`;
  }

  perSchoolList.innerHTML = html;

  document.getElementById("fixUnmatchedNamesBtn").style.display = validation.unmatchedSlides.length > 0 ? "block" : "none";

  if (!validation.ok) {
    missingNote.style.display = "block";
    missingNote.textContent = validation.errorMessage || "تعذّر التحقق من القالب.";
    generateBtn.disabled = true;
  } else {
    generateBtn.disabled = false;
  }
}

document.getElementById("multiSummaryBackBtn").addEventListener("click", () => {
  showScreen("screen-monthly-home");
});

document.getElementById("fixUnmatchedNamesBtn").addEventListener("click", () => {
  renderNameMatchingScreen();
  showScreen("screen-name-matching");
});

// One row per template school that couldn't be matched to any of your
// schools -- each is fixed structurally (rename an existing school to
// the template's own text, or add it as new), never by loosening the
// matching rule itself, so two different schools can never end up
// sharing one slide.
function renderNameMatchingScreen() {
  const listEl = document.getElementById("nameMatchingList");
  const doneMsg = document.getElementById("nameMatchingDoneMsg");
  listEl.innerHTML = "";

  const unmatched = (lastMasterValidation && lastMasterValidation.unmatchedSlides) || [];
  if (unmatched.length === 0) {
    doneMsg.style.display = "block";
    return;
  }
  doneMsg.style.display = "none";

  // Schools already claimed by a matched slide are left out of the
  // picker -- renaming one here would both break its existing correct
  // match and risk two slides claiming the same school.
  const matchedSchoolIds = new Set();
  Object.values(lastMasterValidation.slideMatches || {}).forEach((m) => {
    if (m.matchedSchool) matchedSchoolIds.add(m.matchedSchool.id);
  });
  const freeSchools = monthlySchools.filter((s) => !matchedSchoolIds.has(s.id));

  unmatched.forEach((u, idx) => {
    const row = document.createElement("div");
    row.className = "name-match-row";
    row.innerHTML = `
      <p class="name-match-template-name">${escapeHtml(u.rawName)}</p>
      <div class="name-match-controls">
        <select class="name-match-select" data-idx="${idx}">
          <option value="__new__">${t("nameMatchingAddNewOption")}</option>
          <option value="" disabled selected>${t("nameMatchingSelectPlaceholder")}</option>
          ${freeSchools.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}
        </select>
        <button type="button" class="name-match-apply" data-idx="${idx}">${t("nameMatchingApplyBtn")}</button>
      </div>
    `;
    listEl.appendChild(row);
  });

  listEl.querySelectorAll(".name-match-apply").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.idx);
      const select = listEl.querySelector(`.name-match-select[data-idx="${idx}"]`);
      const value = select.value;
      if (!value) {
        showToast(t("nameMatchingNeedSelection"), "warning");
        return;
      }
      btn.disabled = true;
      const cleanName = normalizeSchoolNameForMatch(unmatched[idx].rawName);
      if (value === "__new__") {
        const school = await addMonthlySchool(cleanName);
        if (typeof enqueueEntitySync === "function") {
          enqueueEntitySync("school", "create", school.id, { id: school.id, name: school.name });
        }
      } else {
        await updateMonthlySchoolName(value, cleanName);
      }
      monthlySchools = await getAllMonthlySchools();
      showToast(t("nameMatchingApplied"), "success");
      // Re-run validation so the remaining rows' pickers (and which
      // rows still show up at all) reflect this change immediately.
      lastMasterValidation = await validateMasterSchoolsPptx(currentMonthKey);
      renderNameMatchingScreen();
    });
  });
}

document.getElementById("nameMatchingRecheckBtn").addEventListener("click", async () => {
  await runMasterValidationAndShowSummary();
});
document.getElementById("nameMatchingBackBtn").addEventListener("click", async () => {
  await runMasterValidationAndShowSummary();
});

document.getElementById("generateMultiPptxBtn").addEventListener("click", async () => {
  const btn = document.getElementById("generateMultiPptxBtn");
  const msg = document.getElementById("multiPptxGeneratingMsg");
  btn.disabled = true;
  msg.style.display = "block";
  try {
    const { blob, fileName } = await generateMasterSchoolsPptx(currentMonthKey);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast(t("pptxGenerated"), "success");
  } catch (err) {
    console.error("Master-template PPTX generation failed:", err);
    showToast((err && err.validation && err.validation.errorMessage) || t("pptxGenerateFailed"), "error");
  } finally {
    btn.disabled = false;
    msg.style.display = "none";
  }
});
