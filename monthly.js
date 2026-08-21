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
        showToast(t("monthlySchoolDeleted"));
        renderMonthlySchoolsList();
      }
    });
  });
}

document.getElementById("addSchoolBtn").addEventListener("click", async () => {
  const input = document.getElementById("newSchoolNameInput");
  const name = input.value.trim();
  if (!name) {
    showToast(t("needSchoolName"));
    return;
  }
  await addMonthlySchool(name);
  input.value = "";
  monthlySchools = await getAllMonthlySchools();
  renderMonthlySchoolsList();
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
    if (label) newSlots.push({ id: row.dataset.slotId, label });
  });
  await saveMonthlySlots(newSlots);
  monthlySlots = newSlots;
  showToast(t("monthlySlotsSaved"));
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
  document.getElementById("monthlySchoolProgress").textContent = t("monthlyProgress")(doneCount, monthlySlots.length);

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
      delete activeSubmission.photos[btn.dataset.slot];
      await saveMonthlySubmission(activeSubmission);
      showToast(t("monthlyPhotoDeleted"));
      await renderMonthlySlotsGrid();
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

async function handleMonthlyPhotoInput(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !captureSlotId) return;
  try {
    // Higher resolution/quality than the default report photos, since
    // these are official documentation photos that may be reviewed closely.
    const blob = await compressImage(file, 2200, 0.92);
    activeSubmission.photos[captureSlotId] = { blob, takenAt: Date.now() };
    await saveMonthlySubmission(activeSubmission);
    showToast(t("monthlyPhotoSaved"));
    await renderMonthlySlotsGrid();
  } catch (err) {
    console.error(err);
    showToast(currentLang === "ar" ? "تعذر إضافة الصورة." : "Couldn't add the photo.");
  }
  captureSlotId = null;
}
document.getElementById("monthlyCameraInput").addEventListener("change", handleMonthlyPhotoInput);
document.getElementById("monthlyGalleryInput").addEventListener("change", handleMonthlyPhotoInput);

document.getElementById("monthlySchoolBackBtn").addEventListener("click", async () => {
  await renderMonthlySchoolsList();
  showScreen("screen-monthly-home");
});
