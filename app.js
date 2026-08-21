// ---------------------------------------------------------------------
// app.js
// Screen navigation + UI wiring. All persistence goes through
// storage.js. Camera/voice/speech logic lives in media.js. PDF export
// lives in pdf.js.
// ---------------------------------------------------------------------

let currentLang = "ar";
let activeReport = null;         // full report object currently open
let editingIndex = null;         // index into activeReport.observations, or null = new
let stagedPhotos = [];           // array of {blob, takenAt} for the observation being edited
let stagedAudioBlob = null;
let pendingTranscript = "";
let isRecording = false;
let editingAIFields = {}; // preserves previously-approved AI fields when re-saving without re-running AI
const recorder = new VoiceRecorder();

// ---------- Translations ----------
const translations = {
  ar: {
    appTitle: "ملاحظاتي",
    btnNewReportHome: "+ إنشاء تقرير جديد",
    previousReportsHeading: "التقارير السابقة",
    noReports: "لا توجد تقارير حتى الآن",
    newReportHeading: "تقرير جديد",
    labelTitle: "عنوان التقرير",
    labelLocation: "اسم المدرسة / الموقع",
    labelDate: "التاريخ",
    placeholderTitle: "مثال: تفتيش الفصل الدراسي الأول",
    placeholderLocation: "مثال: مدرسة النور",
    btnStartReport: "بدء التقرير",
    btnCancel: "إلغاء",
    observationsHeading: "الملاحظات",
    noObservations: "لم تتم إضافة أي ملاحظات بعد.",
    btnAddObservation: "+ إضافة ملاحظة",
    btnPreview: "👁 معاينة التقرير",
    btnGeneratePdf: "📄 إنشاء PDF",
    btnBackHome: "رجوع للرئيسية",
    openBtn: "فتح",
    deleteBtn: "حذف",
    editBtn: "تعديل",
    confirmDeleteReport: "هل أنت متأكد من حذف هذا التقرير؟",
    confirmDeleteObservation: "هل أنت متأكد من حذف هذه الملاحظة؟",
    reportDeleted: "تم حذف التقرير.",
    observationDeleted: "تم حذف الملاحظة.",
    observationHeading: "الملاحظة",
    photoHeading: "الصور",
    btnTakePhoto: "📷 تصوير الملاحظة",
    btnPickPhoto: "اختيار من الصور",
    removePhoto: "حذف",
    moreActions: "المزيد",
    btnPhotoSettings: "⚙ إعدادات التوثيق",
    photoSettingsHeading: "إعدادات التوثيق",
    settingEnabled: "إضافة بيانات على الصور",
    settingSchool: "اسم المدرسة",
    settingDate: "التاريخ",
    settingObsNumber: "رقم الملاحظة",
    settingTime: "وقت التصوير",
    settingInspector: "اسم المشرفة",
    inspectorNamePlaceholder: "اسم المشرفة / المشرف",
    pdfImageTypeHeading: "نوع الصورة في التقرير",
    pdfImageDocumented: "الصورة الموثقة",
    pdfImageOriginal: "الصورة الأصلية",
    btnSaveSettings: "حفظ الإعدادات",
    btnViewOriginal: "الصورة الأصلية",
    btnViewDocumented: "الصورة الموثقة",
    btnReplacePhoto: "📷 تصوير / استبدال",
    btnSaveOriginalPhoto: "💾 حفظ الصورة الأصلية",
    btnSaveDocumentedPhoto: "📝 حفظ الصورة الموثقة",
    btnDeletePhotoAction: "🗑 حذف الصورة",
    btnCloseModal: "إغلاق",
    shareFallbackMsg: "افتحنا الصورة في تبويب جديد — اضغطي مطولاً عليها ثم احفظيها.",
    voiceHeading: "الملاحظة الصوتية",
    recording: "جاري التسجيل",
    btnRecord: "🎙️ تسجيل",
    btnStopRecord: "⏹ إيقاف التسجيل",
    btnDeleteAudio: "🗑 حذف التسجيل",
    btnReRecord: "🎙 تسجيل مرة أخرى",
    btnTranscribe: "تحويل إلى نص",
    textHeading: "نص الملاحظة",
    observationTextPlaceholder: "اكتب أو سجّل الملاحظة هنا",
    btnSaveObservation: "حفظ الملاحظة",
    observationSaved: "تم حفظ الملاحظة.",
    needText: "الرجاء كتابة نص الملاحظة قبل الحفظ.",
    micDenied: "تعذر الوصول إلى الميكروفون. يرجى السماح بالوصول من إعدادات المتصفح.",
    micNeedsHttps: "تسجيل الصوت يحتاج فتح التطبيق عبر رابط آمن (https)، وليس كملف محلي.",
    noTranscript: "تحويل الصوت إلى نص غير متاح في هذا المتصفح، يمكنك كتابة النص يدويًا.",
    previewHeading: "معاينة التقرير",
    btnBack: "رجوع",
    pdfSuccess: "تم إنشاء ملف PDF.",
    pdfFailed: "تعذر إنشاء التقرير. حاول مرة أخرى.",
    noObservationsForPdf: "أضف ملاحظة واحدة على الأقل قبل إنشاء PDF.",
    obsCount: (n) => `${n} ملاحظة`,
    langToggle: "English",
    searchPlaceholder: "بحث بالمدرسة أو التاريخ",
    noSearchResults: "لا توجد نتائج مطابقة.",
    btnExportBackup: "💾 نسخة احتياطية",
    btnImportBackup: "📂 استيراد نسخة",
    backupExported: "تم تصدير النسخة الاحتياطية.",
    backupFailed: "تعذر إنشاء النسخة الاحتياطية.",
    backupImported: (n) => `تم استيراد ${n} تقرير.`,
    backupImportFailed: "تعذر استيراد الملف. تأكدي أنه نسخة احتياطية صحيحة.",
    editReportHeading: "تعديل بيانات التقرير",
    btnSaveChanges: "حفظ التعديلات",
    btnEditReport: "✏️ تعديل بيانات التقرير",
    reportUpdated: "تم تحديث بيانات التقرير.",
    btnSharePdf: "📤 مشاركة PDF",
    previousVisitFound: (n, date) => `تمت زيارة هذا الموقع من قبل (${n} ${n === 1 ? "زيارة" : "زيارات"} سابقة، آخرها ${date}).`,
    previousVisitFoundRepeats: (n, date, r) => `تمت زيارة هذا الموقع من قبل (آخرها ${date})، و${r} ${r === 1 ? "ملاحظة تكررت" : "ملاحظات تكررت"} من زيارة سابقة.`,
    repeatedFrom: (date) => `🔁 لوحظ سابقًا بتاريخ ${date}`,
    btnOpenMonthly: "📅 الصور الشهرية للمدارس",
    monthlyHeading: "الصور الشهرية للمدارس",
    monthlyPickMonth: "الشهر",
    monthlySchoolPlaceholder: "اسم مدرسة جديدة",
    monthlyNoSchools: "لم تتم إضافة أي مدرسة بعد.",
    btnMonthlyTemplateSettings: "⚙ إدارة قائمة الصور المطلوبة",
    monthlyTemplateHeading: "قائمة الصور المطلوبة",
    monthlyTemplateHint: "هذي القائمة نفسها تُطبّق على كل المدارس.",
    btnAddSlot: "+ إضافة صورة مطلوبة",
    monthlyProgress: (n, total) => `${n} من ${total} مكتمل`,
    monthlyOpenBtn: "فتح",
    monthlyDeleteSchoolConfirm: "هل أنت متأكد من حذف هذه المدرسة؟ (صور الأشهر السابقة تبقى محفوظة لكن ما راح تظهر)",
    monthlySchoolDeleted: "تم حذف المدرسة.",
    monthlySlotsSaved: "تم حفظ التعديلات.",
    monthlyPhotoSaved: "تم حفظ الصورة.",
    monthlyPhotoDeleted: "تم حذف الصورة.",
    monthlySlotLabelPlaceholder: "مثال: واجهة المدرسة",
    btnMonthlyCamera: "📷",
    btnMonthlyGallery: "🖼",
    needSchoolName: "الرجاء كتابة اسم المدرسة.",
    monthlyVisitDateLabel: "تاريخ الزيارة",
    schoolsHeading: "مدارسي",
    searchSchoolPlaceholder: "بحث بالمدرسة",
    noSchoolsHome: "لم تتم إضافة أي مدرسة بعد. أضيفي مدرسة للبدء.",
    btnQuickReport: "+ زيارة سريعة بدون مدرسة محددة",
    visitsCount: (n) => `${n} ${n === 1 ? "زيارة" : "زيارات"}`,
    lastVisitLabel: "آخر زيارة",
    btnStartVisit: "🚀 بدء زيارة",
    visitHistoryHeading: "سجل الزيارات",
    noSchoolVisits: "لا توجد زيارات بعد لهذي المدرسة.",
    unlinkedVisitsHeading: "زيارات غير مرتبطة بمدرسة",
    unlinkedVisitsHint: "هذي الزيارات لها اسم موقع لا يطابق أي مدرسة محفوظة حاليًا.",
    unlinkedVisitsBtn: (n) => `📁 زيارات غير مرتبطة بمدرسة (${n})`,
    visitDefaultTitlePrefix: "زيارة",
    btnAnalyzeAI: "✨ تحليل الملاحظة (AI)",
    aiAnalyzing: "⏳ جاري التحليل...",
    aiNeedInput: "أضيفي نص أو صورة قبل التحليل.",
    aiAnalyzeFailed: "تعذر تحليل الملاحظة. تأكدي من الاتصال بالإنترنت وحاولي مرة أخرى.",
    aiReviewHeading: "مراجعة الملاحظة (AI)",
    aiCategoryLabel: "التصنيف",
    aiDescriptionLabel: "الوصف",
    aiRiskLabel: "الخطورة المقترحة",
    aiActionLabel: "الإجراء المقترح",
    aiPriorityLabel: "الأولوية",
    aiConfidenceLabel: (pct) => `مستوى ثقة AI: ${pct}%`,
    btnApproveAI: "✅ اعتماد وحفظ"
  },
  en: {
    appTitle: "My Observations",
    btnNewReportHome: "+ New Report",
    previousReportsHeading: "Previous Reports",
    noReports: "No reports yet",
    newReportHeading: "New Report",
    labelTitle: "Report Title",
    labelLocation: "Location / School Name",
    labelDate: "Date",
    placeholderTitle: "e.g. Term 1 Site Inspection",
    placeholderLocation: "e.g. Al Noor School",
    btnStartReport: "Start Report",
    btnCancel: "Cancel",
    observationsHeading: "Observations",
    noObservations: "No observations added yet.",
    btnAddObservation: "+ Add Observation",
    btnPreview: "👁 Preview Report",
    btnGeneratePdf: "📄 Generate PDF",
    btnBackHome: "Back to Home",
    openBtn: "Open",
    deleteBtn: "Delete",
    editBtn: "Edit",
    confirmDeleteReport: "Are you sure you want to delete this report?",
    confirmDeleteObservation: "Are you sure you want to delete this observation?",
    reportDeleted: "Report deleted.",
    observationDeleted: "Observation deleted.",
    observationHeading: "Observation",
    photoHeading: "Photos",
    btnTakePhoto: "📷 Take Photo",
    btnPickPhoto: "Choose from Photos",
    removePhoto: "Remove",
    moreActions: "More",
    btnPhotoSettings: "⚙ Documentation Settings",
    photoSettingsHeading: "Documentation Settings",
    settingEnabled: "Add info overlay on photos",
    settingSchool: "School name",
    settingDate: "Date",
    settingObsNumber: "Observation number",
    settingTime: "Time taken",
    settingInspector: "Inspector name",
    inspectorNamePlaceholder: "Inspector's name",
    pdfImageTypeHeading: "Image type in report",
    pdfImageDocumented: "Documented photo",
    pdfImageOriginal: "Original photo",
    btnSaveSettings: "Save Settings",
    btnViewOriginal: "Original",
    btnViewDocumented: "Documented",
    btnReplacePhoto: "📷 Retake / Replace",
    btnSaveOriginalPhoto: "💾 Save Original Photo",
    btnSaveDocumentedPhoto: "📝 Save Documented Photo",
    btnDeletePhotoAction: "🗑 Delete Photo",
    btnCloseModal: "Close",
    shareFallbackMsg: "Opened the photo in a new tab — press and hold it to save.",
    voiceHeading: "Voice Note",
    recording: "Recording",
    btnRecord: "🎙️ Record",
    btnStopRecord: "⏹ Stop Recording",
    btnDeleteAudio: "🗑 Delete Recording",
    btnReRecord: "🎙 Record Again",
    btnTranscribe: "Convert to Text",
    textHeading: "Observation Text",
    observationTextPlaceholder: "Type or record the observation here",
    btnSaveObservation: "Save Observation",
    observationSaved: "Observation saved.",
    needText: "Please write the observation text before saving.",
    micDenied: "Couldn't access the microphone. Please allow access in your browser settings.",
    micNeedsHttps: "Voice recording needs the app opened over a secure (https) link, not a local file.",
    noTranscript: "Speech-to-text isn't available in this browser — you can type the text manually.",
    previewHeading: "Preview Report",
    btnBack: "Back",
    pdfSuccess: "PDF created.",
    pdfFailed: "Couldn't create the report. Please try again.",
    noObservationsForPdf: "Add at least one observation before generating a PDF.",
    obsCount: (n) => `${n} observation${n === 1 ? "" : "s"}`,
    langToggle: "العربية",
    searchPlaceholder: "Search by school or date",
    noSearchResults: "No matching reports.",
    btnExportBackup: "💾 Backup",
    btnImportBackup: "📂 Restore Backup",
    backupExported: "Backup exported.",
    backupFailed: "Couldn't create the backup.",
    backupImported: (n) => `${n} report${n === 1 ? "" : "s"} imported.`,
    backupImportFailed: "Couldn't import the file. Make sure it's a valid backup.",
    editReportHeading: "Edit Report Details",
    btnSaveChanges: "Save Changes",
    btnEditReport: "✏️ Edit Report Details",
    reportUpdated: "Report details updated.",
    btnSharePdf: "📤 Share PDF",
    previousVisitFound: (n, date) => `This location was visited before (${n} previous visit${n === 1 ? "" : "s"}, last on ${date}).`,
    previousVisitFoundRepeats: (n, date, r) => `This location was visited before (last on ${date}), and ${r} observation${r === 1 ? "" : "s"} repeat from a previous visit.`,
    repeatedFrom: (date) => `🔁 Previously observed on ${date}`,
    btnOpenMonthly: "📅 Monthly School Photos",
    monthlyHeading: "Monthly School Photos",
    monthlyPickMonth: "Month",
    monthlySchoolPlaceholder: "New school name",
    monthlyNoSchools: "No schools added yet.",
    btnMonthlyTemplateSettings: "⚙ Manage Required Photos List",
    monthlyTemplateHeading: "Required Photos List",
    monthlyTemplateHint: "This same list applies to every school.",
    btnAddSlot: "+ Add Required Photo",
    monthlyProgress: (n, total) => `${n} of ${total} complete`,
    monthlyOpenBtn: "Open",
    monthlyDeleteSchoolConfirm: "Are you sure you want to delete this school? (Past months' photos are kept but won't be shown)",
    monthlySchoolDeleted: "School deleted.",
    monthlySlotsSaved: "Changes saved.",
    monthlyPhotoSaved: "Photo saved.",
    monthlyPhotoDeleted: "Photo deleted.",
    monthlySlotLabelPlaceholder: "e.g. School entrance",
    btnMonthlyCamera: "📷",
    btnMonthlyGallery: "🖼",
    needSchoolName: "Please enter the school name.",
    monthlyVisitDateLabel: "Visit Date",
    schoolsHeading: "My Schools",
    searchSchoolPlaceholder: "Search by school",
    noSchoolsHome: "No schools added yet. Add one to get started.",
    btnQuickReport: "+ Quick visit without a specific school",
    visitsCount: (n) => `${n} visit${n === 1 ? "" : "s"}`,
    lastVisitLabel: "Last visit",
    btnStartVisit: "🚀 Start Visit",
    visitHistoryHeading: "Visit History",
    noSchoolVisits: "No visits yet for this school.",
    unlinkedVisitsHeading: "Visits Not Linked to a School",
    unlinkedVisitsHint: "These visits have a location name that doesn't match any currently saved school.",
    unlinkedVisitsBtn: (n) => `📁 Unlinked visits (${n})`,
    visitDefaultTitlePrefix: "Visit",
    btnAnalyzeAI: "✨ Analyze Note (AI)",
    aiAnalyzing: "⏳ Analyzing...",
    aiNeedInput: "Add text or a photo before analyzing.",
    aiAnalyzeFailed: "Couldn't analyze the note. Check your internet connection and try again.",
    aiReviewHeading: "Review Note (AI)",
    aiCategoryLabel: "Category",
    aiDescriptionLabel: "Description",
    aiRiskLabel: "Suggested Risk Level",
    aiActionLabel: "Recommended Action",
    aiPriorityLabel: "Priority",
    aiConfidenceLabel: (pct) => `AI confidence: ${pct}%`,
    btnApproveAI: "✅ Approve & Save"
  }
};

function t(key) {
  return translations[currentLang][key];
}

async function applyLanguage(lang) {
  currentLang = lang;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (translations[lang][key]) el.textContent = translations[lang][key];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (translations[lang][key]) el.setAttribute("placeholder", translations[lang][key]);
  });
  document.getElementById("langToggle").textContent = t("langToggle");
  document.getElementById("topBackBtn").textContent = lang === "ar" ? "→" : "←";

  await renderHome();
  if (activeReport) await renderReportScreen();
}

document.getElementById("langToggle").addEventListener("click", () => {
  applyLanguage(currentLang === "ar" ? "en" : "ar");
});

// ---------- Toast ----------
let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ---------- Screen navigation ----------
// Maps each non-home screen to the id of its existing "back/cancel"
// button, so the top-of-page back button can just trigger the same
// logic instead of duplicating it.
const screenBackButtonMap = {
  "screen-new-report": "cancelNewReportBtn",
  "screen-edit-report": "cancelEditReportBtn",
  "screen-report": "backHomeBtn",
  "screen-observation": "cancelObservationBtn",
  "screen-preview": "previewBackBtn",
  "screen-photo-settings": "cancelPhotoSettingsBtn",
  "screen-monthly-home": "monthlyBackHomeBtn",
  "screen-monthly-template": "cancelSlotsBtn",
  "screen-monthly-school": "monthlySchoolBackBtn",
  "screen-school-detail": "schoolDetailBackBtn",
  "screen-unlinked-visits": "unlinkedVisitsBackBtn",
  "screen-ai-review": "aiCancelBtn"
};

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");

  const topBackBtn = document.getElementById("topBackBtn");
  const targetBtnId = screenBackButtonMap[id];
  if (targetBtnId) {
    topBackBtn.style.display = "flex";
    topBackBtn.onclick = () => document.getElementById(targetBtnId).click();
  } else {
    topBackBtn.style.display = "none";
    topBackBtn.onclick = null;
  }
}

// ---------- Home screen (Schools) ----------
let cachedSchools = [];
let cachedAllReports = [];

function normalizeName(str) {
  return (str || "").trim().toLowerCase();
}

async function renderHome() {
  cachedSchools = await getAllMonthlySchools();
  cachedAllReports = await getAllReports();
  renderSchoolsHomeList();
}

function schoolStats(school) {
  const visits = cachedAllReports.filter((r) => normalizeName(r.location) === normalizeName(school.name));
  const obsCount = visits.reduce((sum, v) => sum + v.observations.length, 0);
  const lastVisit = visits.reduce((max, v) => (!max || v.date > max ? v.date : max), null);
  return { visits, visitCount: visits.length, obsCount, lastVisit };
}

function renderSchoolsHomeList() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const schools = query
    ? cachedSchools.filter((s) => (s.name || "").toLowerCase().includes(query))
    : cachedSchools;

  const listEl = document.getElementById("schoolsHomeList");
  const emptyEl = document.getElementById("noSchoolsMsg");
  listEl.innerHTML = "";

  if (schools.length === 0) {
    emptyEl.style.display = "block";
    emptyEl.textContent = query ? t("noSearchResults") : t("noSchoolsHome");
  } else {
    emptyEl.style.display = "none";
    const knownNames = new Set(cachedSchools.map((s) => normalizeName(s.name)));

    schools.forEach((school) => {
      const stats = schoolStats(school);
      const card = document.createElement("div");
      card.className = "report-card";
      card.innerHTML = `
        <h4>${escapeHtml(school.name)}</h4>
        <p class="muted">${t("visitsCount")(stats.visitCount)} · ${t("obsCount")(stats.obsCount)}${stats.lastVisit ? " · " + t("lastVisitLabel") + " " + escapeHtml(stats.lastVisit) : ""}</p>
        <div class="card-actions">
          <button class="card-open school-open" data-id="${school.id}">${t("openBtn")}</button>
          <button class="card-delete school-delete" data-id="${school.id}">${t("deleteBtn")}</button>
        </div>
      `;
      listEl.appendChild(card);
    });

    listEl.querySelectorAll(".school-open").forEach((btn) => {
      btn.addEventListener("click", () => openSchoolDetail(btn.dataset.id));
    });
    listEl.querySelectorAll(".school-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (confirm(t("monthlyDeleteSchoolConfirm"))) {
          await deleteMonthlySchool(btn.dataset.id);
          showToast(t("monthlySchoolDeleted"));
          renderHome();
        }
      });
    });

    // Unlinked visits button: reports whose location doesn't match any saved school
    const unlinkedCount = cachedAllReports.filter((r) => !knownNames.has(normalizeName(r.location))).length;
    const unlinkedBtn = document.getElementById("viewUnlinkedBtn");
    if (unlinkedCount > 0) {
      unlinkedBtn.style.display = "block";
      unlinkedBtn.textContent = t("unlinkedVisitsBtn")(unlinkedCount);
    } else {
      unlinkedBtn.style.display = "none";
    }
  }
}

document.getElementById("addSchoolBtnHome").addEventListener("click", async () => {
  const input = document.getElementById("newSchoolNameInputHome");
  const name = input.value.trim();
  if (!name) {
    showToast(t("needSchoolName"));
    return;
  }
  await addMonthlySchool(name);
  input.value = "";
  await renderHome();
});

document.getElementById("searchInput").addEventListener("input", renderSchoolsHomeList);

// ---------- School Detail ----------
async function openSchoolDetail(schoolId) {
  const school = cachedSchools.find((s) => s.id === schoolId);
  if (!school) return;
  activeSchoolForVisits = school;

  const stats = schoolStats(school);
  document.getElementById("schoolDetailName").textContent = school.name;
  document.getElementById("schoolDetailStats").textContent =
    `${t("visitsCount")(stats.visitCount)} · ${t("obsCount")(stats.obsCount)}` +
    (stats.lastVisit ? ` · ${t("lastVisitLabel")} ${stats.lastVisit}` : "");

  const listEl = document.getElementById("schoolVisitsList");
  const emptyEl = document.getElementById("noSchoolVisitsMsg");
  listEl.innerHTML = "";

  if (stats.visits.length === 0) {
    emptyEl.style.display = "block";
  } else {
    emptyEl.style.display = "none";
    stats.visits
      .slice()
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .forEach((visit) => {
        const card = document.createElement("div");
        card.className = "report-card";
        card.innerHTML = `
          <h4>${escapeHtml(visit.title)}</h4>
          <p class="muted">${escapeHtml(visit.date)} · ${t("obsCount")(visit.observations.length)}</p>
          <div class="card-actions">
            <button class="card-open visit-open" data-id="${visit.id}">${t("openBtn")}</button>
            <button class="card-delete visit-delete" data-id="${visit.id}">${t("deleteBtn")}</button>
          </div>
        `;
        listEl.appendChild(card);
      });
    listEl.querySelectorAll(".visit-open").forEach((btn) => {
      btn.addEventListener("click", () => openReport(btn.dataset.id));
    });
    listEl.querySelectorAll(".visit-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (confirm(t("confirmDeleteReport"))) {
          await deleteReportById(btn.dataset.id);
          showToast(t("reportDeleted"));
          openSchoolDetail(schoolId);
        }
      });
    });
  }

  showScreen("screen-school-detail");
}

let activeSchoolForVisits = null;

document.getElementById("startVisitBtn").addEventListener("click", async () => {
  if (!activeSchoolForVisits) return;
  const today = new Date().toISOString().split("T")[0];
  const report = {
    id: generateId(),
    title: `${t("visitDefaultTitlePrefix")} ${today}`,
    location: activeSchoolForVisits.name,
    date: today,
    observations: [],
    photoSettings: defaultPhotoSettings(),
    createdAt: Date.now()
  };
  await saveReport(report);
  await openReport(report.id);
});

// ---------- Unlinked visits ----------
document.getElementById("viewUnlinkedBtn").addEventListener("click", () => {
  const knownNames = new Set(cachedSchools.map((s) => normalizeName(s.name)));
  const unlinked = cachedAllReports.filter((r) => !knownNames.has(normalizeName(r.location)));

  const listEl = document.getElementById("unlinkedVisitsList");
  listEl.innerHTML = "";
  unlinked
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .forEach((report) => {
      const card = document.createElement("div");
      card.className = "report-card";
      card.innerHTML = `
        <h4>${escapeHtml(report.title)}</h4>
        <p class="muted">${escapeHtml(report.location)} — ${escapeHtml(report.date)} · ${t("obsCount")(report.observations.length)}</p>
        <div class="card-actions">
          <button class="card-open unlinked-open" data-id="${report.id}">${t("openBtn")}</button>
          <button class="card-delete unlinked-delete" data-id="${report.id}">${t("deleteBtn")}</button>
        </div>
      `;
      listEl.appendChild(card);
    });
  listEl.querySelectorAll(".unlinked-open").forEach((btn) => {
    btn.addEventListener("click", () => openReport(btn.dataset.id));
  });
  listEl.querySelectorAll(".unlinked-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (confirm(t("confirmDeleteReport"))) {
        await deleteReportById(btn.dataset.id);
        showToast(t("reportDeleted"));
        await renderHome();
        document.getElementById("viewUnlinkedBtn").click();
      }
    });
  });

  showScreen("screen-unlinked-visits");
});

document.getElementById("schoolDetailBackBtn").addEventListener("click", async () => {
  await renderHome();
  showScreen("screen-home");
});

document.getElementById("unlinkedVisitsBackBtn").addEventListener("click", async () => {
  await renderHome();
  showScreen("screen-home");
});

document.getElementById("exportBackupBtn").addEventListener("click", async () => {
  try {
    const blob = await exportBackupBlob();
    const today = new Date().toISOString().split("T")[0];
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `safety_reports_backup_${today}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast(t("backupExported"));
  } catch (err) {
    console.error(err);
    showToast(t("backupFailed"));
  }
});

document.getElementById("importBackupBtn").addEventListener("click", () => {
  document.getElementById("importBackupInput").click();
});

document.getElementById("importBackupInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const count = await importBackupFile(file);
    showToast(t("backupImported")(count));
    renderHome();
  } catch (err) {
    console.error(err);
    showToast(t("backupImportFailed"));
  }
});

document.getElementById("newReportBtn").addEventListener("click", () => {
  document.getElementById("newReportForm").reset();
  document.getElementById("reportDate").value = new Date().toISOString().split("T")[0];
  showScreen("screen-new-report");
});

document.getElementById("cancelNewReportBtn").addEventListener("click", () => {
  showScreen("screen-home");
});

document.getElementById("newReportForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const report = {
    id: generateId(),
    title: document.getElementById("reportTitle").value.trim(),
    location: document.getElementById("reportLocation").value.trim(),
    date: document.getElementById("reportDate").value,
    observations: [],
    photoSettings: defaultPhotoSettings(),
    createdAt: Date.now()
  };
  await saveReport(report);
  await openReport(report.id);
});

// ---------- Report screen ----------
async function openReport(id) {
  activeReport = await getReportById(id);
  if (!activeReport) return;
  if (!activeReport.photoSettings) activeReport.photoSettings = defaultPhotoSettings();
  await renderReportScreen();
  showScreen("screen-report");
}

function thumbUrl(blob) {
  return blob ? URL.createObjectURL(blob) : null;
}

function riskLevelClass(riskLevel) {
  const map = {
    "منخفضة": "ai-risk-low",
    "متوسطة": "ai-risk-medium",
    "عالية": "ai-risk-high",
    "حرجة": "ai-risk-critical"
  };
  return map[riskLevel] || "ai-risk-medium";
}

async function renderReportScreen() {
  document.getElementById("reportSummaryTitle").textContent = activeReport.title;
  document.getElementById("reportSummaryMeta").textContent = `${activeReport.location} — ${activeReport.date}`;

  await renderPreviousVisitNote();

  const listEl = document.getElementById("observationsList");
  const emptyEl = document.getElementById("noObservationsMsg");
  listEl.innerHTML = "";

  if (activeReport.observations.length === 0) {
    emptyEl.style.display = "block";
  } else {
    emptyEl.style.display = "none";
    activeReport.observations.forEach((obs, i) => {
      const card = document.createElement("div");
      card.className = "obs-card";
      const photos = obsPhotos(obs);
      const thumbsHtml = photos.length
        ? `<div class="obs-thumb-grid">${photos.map(p => `<img src="${URL.createObjectURL(p.blob)}" class="obs-thumb" alt="">`).join("")}</div>`
        : "";
      const repeatInfo = repeatedObservationInfo[i];
      const repeatBadge = repeatInfo
        ? `<span class="repeat-badge">${t("repeatedFrom")(repeatInfo)}</span>`
        : "";
      const riskClass = obs.riskLevel ? riskLevelClass(obs.riskLevel) : "";
      const aiBadges = obs.category
        ? `<div class="ai-badges">
             <span class="ai-badge ai-badge-category">${escapeHtml(obs.category)}</span>
             ${obs.riskLevel ? `<span class="ai-badge ${riskClass}">${escapeHtml(obs.riskLevel)}</span>` : ""}
             ${obs.priority ? `<span class="ai-badge ai-badge-priority">${escapeHtml(obs.priority)}</span>` : ""}
           </div>`
        : "";
      card.innerHTML = `
        <div class="obs-card-header">${i + 1}</div>
        ${repeatBadge}
        ${aiBadges}
        ${thumbsHtml}
        <p class="obs-text">${escapeHtml(obs.text)}</p>
        ${obs.recommendedAction ? `<p class="obs-action"><strong>${t("aiActionLabel")}:</strong> ${escapeHtml(obs.recommendedAction)}</p>` : ""}
        <div class="card-actions">
          <button class="card-open obs-edit" data-i="${i}">${t("editBtn")}</button>
          <button class="card-delete obs-delete" data-i="${i}">${t("deleteBtn")}</button>
        </div>
      `;
      listEl.appendChild(card);
    });

    listEl.querySelectorAll(".obs-edit").forEach((btn) => {
      btn.addEventListener("click", () => openObservationEditor(parseInt(btn.dataset.i, 10)));
    });
    listEl.querySelectorAll(".obs-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (confirm(t("confirmDeleteObservation"))) {
          activeReport.observations.splice(parseInt(btn.dataset.i, 10), 1);
          await saveReport(activeReport);
          showToast(t("observationDeleted"));
          await renderReportScreen();
        }
      });
    });
  }
}

// ---------- Compare with a previous visit to the same school ----------
let repeatedObservationInfo = {}; // { observationIndex: previousReportDate }

async function renderPreviousVisitNote() {
  const noteEl = document.getElementById("previousVisitNote");
  repeatedObservationInfo = {};

  const previousReports = await getReportsByLocation(activeReport.location, activeReport.id);
  if (previousReports.length === 0) {
    noteEl.style.display = "none";
    return;
  }

  const previousTexts = []; // { text, date }
  previousReports.forEach((r) => {
    r.observations.forEach((obs) => {
      if (obs.text) previousTexts.push({ text: obs.text.trim().toLowerCase(), date: r.date });
    });
  });

  let repeatCount = 0;
  activeReport.observations.forEach((obs, i) => {
    const match = previousTexts.find((p) => p.text === (obs.text || "").trim().toLowerCase());
    if (match) {
      repeatedObservationInfo[i] = match.date;
      repeatCount++;
    }
  });

  const lastVisit = previousReports[0].date;
  noteEl.style.display = "block";
  noteEl.textContent = repeatCount > 0
    ? t("previousVisitFoundRepeats")(previousReports.length, lastVisit, repeatCount)
    : t("previousVisitFound")(previousReports.length, lastVisit);
}

document.getElementById("backHomeBtn").addEventListener("click", () => {
  activeReport = null;
  renderHome();
  showScreen("screen-home");
});

// ---------- Edit report metadata ----------
document.getElementById("editReportBtn").addEventListener("click", () => {
  document.getElementById("editReportTitle").value = activeReport.title;
  document.getElementById("editReportLocation").value = activeReport.location;
  document.getElementById("editReportDate").value = activeReport.date;
  showScreen("screen-edit-report");
});

document.getElementById("cancelEditReportBtn").addEventListener("click", () => showScreen("screen-report"));

document.getElementById("editReportForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  activeReport.title = document.getElementById("editReportTitle").value.trim();
  activeReport.location = document.getElementById("editReportLocation").value.trim();
  activeReport.date = document.getElementById("editReportDate").value;
  await saveReport(activeReport);
  showToast(t("reportUpdated"));
  await renderReportScreen();
  showScreen("screen-report");
});

// ---------- Add / Edit Observation ----------
function resetObservationForm() {
  stagedPhotos = [];
  stagedAudioBlob = null;
  pendingTranscript = "";
  renderPhotosGrid();
  document.getElementById("audioPlaybackBox").style.display = "none";
  document.getElementById("recordingStatus").style.display = "none";
  document.getElementById("observationText").value = "";
  document.getElementById("recordBtn").textContent = t("btnRecord");
  document.getElementById("cameraInput").value = "";
  document.getElementById("galleryInput").value = "";
}

function openObservationEditor(index) {
  editingIndex = index;
  resetObservationForm();
  editingAIFields = {};

  const number = index !== null ? index + 1 : activeReport.observations.length + 1;
  document.getElementById("observationHeading").textContent =
    (currentLang === "ar" ? "الملاحظة رقم " : "Observation #") + number;

  if (index !== null) {
    const obs = activeReport.observations[index];
    document.getElementById("observationText").value = obs.text || "";
    stagedPhotos = [...obsPhotos(obs)];
    renderPhotosGrid();
    if (obs.audioBlob) {
      stagedAudioBlob = obs.audioBlob;
      showAudioPreview(obs.audioBlob);
    }
    if (obs.category) {
      editingAIFields = {
        category: obs.category,
        riskLevel: obs.riskLevel,
        recommendedAction: obs.recommendedAction,
        priority: obs.priority
      };
    }
  }

  showScreen("screen-observation");
}

document.getElementById("addObservationBtn").addEventListener("click", () => openObservationEditor(null));
document.getElementById("cancelObservationBtn").addEventListener("click", async () => {
  if (isRecording) {
    await recorder.stop();
    isRecording = false;
  }
  showScreen("screen-report");
});

// ---- Photos ----
function renderPhotosGrid() {
  const grid = document.getElementById("photosGrid");
  grid.innerHTML = "";
  stagedPhotos.forEach((photo, i) => {
    const item = document.createElement("div");
    item.className = "photo-thumb";
    item.innerHTML = `
      <img src="${URL.createObjectURL(photo.blob)}" alt="">
      <button type="button" class="photo-thumb-more" data-i="${i}" aria-label="${t("moreActions")}">⋯</button>
      <button type="button" class="photo-thumb-remove" data-i="${i}" aria-label="${t("removePhoto")}">✕</button>
    `;
    grid.appendChild(item);
  });
  grid.querySelectorAll(".photo-thumb-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      stagedPhotos.splice(parseInt(btn.dataset.i, 10), 1);
      renderPhotosGrid();
    });
  });
  grid.querySelectorAll(".photo-thumb-more").forEach((btn) => {
    btn.addEventListener("click", () => openPhotoActionModal(parseInt(btn.dataset.i, 10)));
  });
}

document.getElementById("takePhotoBtn").addEventListener("click", () => document.getElementById("cameraInput").click());
document.getElementById("pickPhotoBtn").addEventListener("click", () => document.getElementById("galleryInput").click());

let replacingPhotoIndex = null;

async function handlePhotoInput(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  try {
    if (replacingPhotoIndex !== null) {
      const blob = await compressImage(files[0]);
      stagedPhotos[replacingPhotoIndex] = { blob, takenAt: Date.now() };
      replacingPhotoIndex = null;
    } else {
      for (const file of files) {
        const blob = await compressImage(file);
        stagedPhotos.push({ blob, takenAt: Date.now() });
      }
    }
    renderPhotosGrid();
  } catch (err) {
    console.error(err);
    showToast(currentLang === "ar" ? "تعذر إضافة الصورة." : "Couldn't add the photo.");
  }
  e.target.value = "";
}
document.getElementById("cameraInput").addEventListener("change", handlePhotoInput);
document.getElementById("galleryInput").addEventListener("change", handlePhotoInput);

// ---- Photo action modal ----
let modalPhotoIndex = null;
let modalShowingOriginal = false;

function currentObsNumber() {
  return editingIndex !== null ? editingIndex + 1 : activeReport.observations.length + 1;
}

function sanitizeFileNamePart(str) {
  return (str || "").replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_").trim() || "photo";
}

async function updateModalPreview() {
  const photo = stagedPhotos[modalPhotoIndex];
  const img = document.getElementById("photoActionPreview");
  const settings = activeReport.photoSettings || defaultPhotoSettings();

  if (modalShowingOriginal || !settings.enabled) {
    img.src = URL.createObjectURL(photo.blob);
    return;
  }
  const lines = buildOverlayLines(activeReport, currentObsNumber(), settings, photo.takenAt, currentLang);
  const docBlob = await createDocumentedPhoto(photo.blob, lines, currentLang === "ar");
  img.src = URL.createObjectURL(docBlob);
}

function openPhotoActionModal(index) {
  modalPhotoIndex = index;
  modalShowingOriginal = false;
  updateModalPreview();
  document.getElementById("photoActionModal").classList.add("show");
}

function closePhotoActionModal() {
  document.getElementById("photoActionModal").classList.remove("show");
  modalPhotoIndex = null;
}

document.getElementById("actionCloseModal").addEventListener("click", closePhotoActionModal);
document.getElementById("viewOriginalBtn").addEventListener("click", () => { modalShowingOriginal = true; updateModalPreview(); });
document.getElementById("viewDocumentedBtn").addEventListener("click", () => { modalShowingOriginal = false; updateModalPreview(); });

document.getElementById("actionReplacePhoto").addEventListener("click", () => {
  replacingPhotoIndex = modalPhotoIndex;
  closePhotoActionModal();
  document.getElementById("cameraInput").click();
});

document.getElementById("actionDeletePhoto").addEventListener("click", () => {
  stagedPhotos.splice(modalPhotoIndex, 1);
  closePhotoActionModal();
  renderPhotosGrid();
});

document.getElementById("actionSaveOriginal").addEventListener("click", async () => {
  const photo = stagedPhotos[modalPhotoIndex];
  const filename = `${sanitizeFileNamePart(activeReport.location)}_${activeReport.date}_obs${String(currentObsNumber()).padStart(2, "0")}_original.jpg`;
  const result = await sharePhotoBlob(photo.blob, filename);
  if (result === "fallback") showToast(t("shareFallbackMsg"));
});

document.getElementById("actionSaveDocumented").addEventListener("click", async () => {
  const photo = stagedPhotos[modalPhotoIndex];
  const settings = activeReport.photoSettings || defaultPhotoSettings();
  const lines = settings.enabled ? buildOverlayLines(activeReport, currentObsNumber(), settings, photo.takenAt, currentLang) : [];
  const docBlob = lines.length ? await createDocumentedPhoto(photo.blob, lines, currentLang === "ar") : photo.blob;
  const filename = `${sanitizeFileNamePart(activeReport.location)}_${activeReport.date}_obs${String(currentObsNumber()).padStart(2, "0")}_documented.jpg`;
  const result = await sharePhotoBlob(docBlob, filename);
  if (result === "fallback") showToast(t("shareFallbackMsg"));
});

// ---- Voice ----
function showAudioPreview(blob) {
  document.getElementById("audioPlayback").src = URL.createObjectURL(blob);
  document.getElementById("audioPlaybackBox").style.display = "block";
}

function formatTimer(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

document.getElementById("recordBtn").addEventListener("click", async () => {
  if (!isRecording) {
    if (!window.isSecureContext) {
      showToast(t("micNeedsHttps"));
      return;
    }
    try {
      recorder.onTick = (s) => (document.getElementById("recordTimer").textContent = formatTimer(s));
      await recorder.start(currentLang);
      isRecording = true;
      document.getElementById("recordingStatus").style.display = "flex";
      document.getElementById("recordTimer").textContent = "00:00";
      document.getElementById("recordBtn").textContent = t("btnStopRecord");
      document.getElementById("audioPlaybackBox").style.display = "none";
    } catch (err) {
      console.error(err);
      showToast(t("micDenied"));
    }
  } else {
    const { blob, transcript } = await recorder.stop();
    isRecording = false;
    document.getElementById("recordingStatus").style.display = "none";
    document.getElementById("recordBtn").textContent = t("btnRecord");
    if (blob) {
      stagedAudioBlob = blob;
      pendingTranscript = transcript;
      showAudioPreview(blob);
      // Auto-fill the text box with the transcript right away, so saving
      // never silently fails just because the user didn't tap "Convert to text".
      const textarea = document.getElementById("observationText");
      if (transcript && !textarea.value.trim()) {
        textarea.value = transcript;
      } else if (!transcript && !recorder.speechSupported) {
        showToast(t("noTranscript"));
      }
    }
  }
});

document.getElementById("deleteAudioBtn").addEventListener("click", () => {
  stagedAudioBlob = null;
  pendingTranscript = "";
  document.getElementById("audioPlaybackBox").style.display = "none";
});

document.getElementById("reRecordBtn").addEventListener("click", () => {
  stagedAudioBlob = null;
  document.getElementById("audioPlaybackBox").style.display = "none";
  document.getElementById("recordBtn").click();
});

document.getElementById("transcribeBtn").addEventListener("click", () => {
  if (!pendingTranscript) {
    showToast(t("noTranscript"));
    return;
  }
  const textarea = document.getElementById("observationText");
  if (textarea.value.trim() && !confirm(currentLang === "ar" ? "سيتم استبدال النص الحالي، متابعة؟" : "This will replace the current text. Continue?")) {
    return;
  }
  textarea.value = pendingTranscript;
});

// ---- Save observation ----
async function saveCurrentObservation(extraFields) {
  const text = document.getElementById("observationText").value.trim();
  if (!text) {
    showToast(t("needText"));
    return false;
  }
  const obs = { text, photos: stagedPhotos, audioBlob: stagedAudioBlob || null, ...editingAIFields, ...(extraFields || {}) };

  try {
    if (editingIndex !== null) {
      activeReport.observations[editingIndex] = obs;
    } else {
      activeReport.observations.push(obs);
    }
    await saveReport(activeReport);
    showToast(t("observationSaved"));
    await renderReportScreen();
    showScreen("screen-report");
    return true;
  } catch (err) {
    console.error("Failed to save observation:", err);
    showToast(currentLang === "ar"
      ? "تعذر حفظ الملاحظة. حاول مرة أخرى."
      : "Couldn't save the observation. Please try again.");
    return false;
  }
}

document.getElementById("saveObservationBtn").addEventListener("click", () => saveCurrentObservation());

// ---------- AI analysis (optional — requires the /analyze backend + API key) ----------
async function blobToBase64Raw(blob) {
  const dataUrl = await blobToDataUrl(blob);
  return dataUrl.split(",")[1];
}

function aiErrorMessage(errData) {
  const ar = currentLang === "ar";
  switch (errData.error) {
    case "missing_key":
      return ar
        ? "لم يتم إعداد مفتاح OpenAI بشكل صحيح في Cloudflare. تأكدي إن اسم الـ Secret بالضبط OPENAI_API_KEY."
        : "The OpenAI key isn't set up correctly in Cloudflare. Check the secret is named exactly OPENAI_API_KEY.";
    case "ai_failed": {
      const status = errData.status ? ` (${errData.status})` : "";
      const detail = errData.detail ? `: ${errData.detail}` : "";
      return ar
        ? `فشل الاتصال بـ OpenAI${status}${detail}. تأكدي من صلاحية المفتاح ووجود رصيد في حسابك.`
        : `OpenAI request failed${status}${detail}. Check your API key and account balance.`;
    }
    case "invalid_json":
    case "invalid_schema":
      return ar
        ? "استجابة غير متوقعة من الذكاء الاصطناعي. حاولي مرة أخرى."
        : "Unexpected response from the AI. Please try again.";
    case "no_input":
    case "bad_request":
      return t("aiNeedInput");
    default:
      return t("aiAnalyzeFailed");
  }
}

document.getElementById("analyzeAIBtn").addEventListener("click", async () => {
  const text = document.getElementById("observationText").value.trim();
  if (!text && stagedPhotos.length === 0) {
    showToast(t("aiNeedInput"));
    return;
  }
  const analyzingMsg = document.getElementById("aiAnalyzingMsg");
  const btn = document.getElementById("analyzeAIBtn");
  analyzingMsg.style.display = "block";
  btn.disabled = true;

  try {
    const imageBase64 = stagedPhotos.length ? await blobToBase64Raw(stagedPhotos[0].blob) : null;
    const resp = await fetch("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, imageBase64 })
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      console.error("AI analyze error:", errData);
      showToast(aiErrorMessage(errData));
      return;
    }

    const result = await resp.json();
    openAIReviewScreen(result);
  } catch (err) {
    console.error(err);
    showToast(t("aiAnalyzeFailed"));
  } finally {
    analyzingMsg.style.display = "none";
    btn.disabled = false;
  }
});

function openAIReviewScreen(result) {
  document.getElementById("aiCategorySelect").value = result.category || "أخرى";
  document.getElementById("aiDescriptionInput").value = result.description || "";
  document.getElementById("aiRiskSelect").value = result.riskLevel || "متوسطة";
  document.getElementById("aiActionInput").value = result.recommendedAction || "";
  document.getElementById("aiPrioritySelect").value = result.priority || "عادية";

  const visualNote = document.getElementById("aiVisualNote");
  if (result.visualObservation) {
    visualNote.style.display = "block";
    visualNote.textContent = "👁 " + result.visualObservation;
  } else {
    visualNote.style.display = "none";
  }

  const confidenceNote = document.getElementById("aiConfidenceNote");
  confidenceNote.textContent = typeof result.confidence === "number"
    ? t("aiConfidenceLabel")(Math.round(result.confidence * 100))
    : "";

  showScreen("screen-ai-review");
}

document.getElementById("aiCancelBtn").addEventListener("click", () => {
  showScreen("screen-observation");
});

document.getElementById("aiApproveBtn").addEventListener("click", async () => {
  const description = document.getElementById("aiDescriptionInput").value.trim();
  if (description) {
    document.getElementById("observationText").value = description;
  }
  const extraFields = {
    category: document.getElementById("aiCategorySelect").value,
    riskLevel: document.getElementById("aiRiskSelect").value,
    recommendedAction: document.getElementById("aiActionInput").value.trim(),
    priority: document.getElementById("aiPrioritySelect").value
  };
  await saveCurrentObservation(extraFields);
});

// ---------- Preview ----------
function renderPreview() {
  const el = document.getElementById("previewContent");
  let html = `
    <div class="preview-header">
      <h3>${escapeHtml(activeReport.title)}</h3>
      <p class="muted">${escapeHtml(activeReport.location)} — ${escapeHtml(activeReport.date)}</p>
    </div>
  `;
  activeReport.observations.forEach((obs, i) => {
    const photos = obsPhotos(obs);
    const thumbsHtml = photos.length
      ? `<div class="obs-thumb-grid">${photos.map(p => `<img src="${thumbUrl(p.blob)}" class="preview-photo" alt="">`).join("")}</div>`
      : "";
    html += `
      <div class="preview-obs">
        <h4>${currentLang === "ar" ? "الملاحظة رقم" : "Observation #"} ${i + 1}</h4>
        ${thumbsHtml}
        <p>${escapeHtml(obs.text)}</p>
      </div>
    `;
  });
  el.innerHTML = html;
}

document.getElementById("previewBtn").addEventListener("click", () => {
  renderPreview();
  showScreen("screen-preview");
});
document.getElementById("previewBackBtn").addEventListener("click", () => showScreen("screen-report"));

// ---------- PDF ----------
async function handleGeneratePdf() {
  if (!activeReport.observations.length) {
    showToast(t("noObservationsForPdf"));
    return;
  }
  try {
    const { blob, fileName } = await generatePdf(activeReport);
    const url = URL.createObjectURL(blob);

    // Try to trigger an automatic download...
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // ...and always leave a visible, tappable link too, in case the
    // automatic download was silently blocked (common on iPhone Safari).
    showPdfFallbackLink(url, fileName);
    showToast(t("pdfSuccess"));
  } catch (err) {
    console.error(err);
    showToast(t("pdfFailed"));
  }
}

async function handleSharePdf() {
  if (!activeReport.observations.length) {
    showToast(t("noObservationsForPdf"));
    return;
  }
  try {
    const { blob, fileName } = await generatePdf(activeReport);
    const result = await sharePhotoBlob(blob, fileName);
    if (result === "fallback") {
      const url = URL.createObjectURL(blob);
      showPdfFallbackLink(url, fileName);
      showToast(t("shareFallbackMsg"));
    }
  } catch (err) {
    console.error(err);
    showToast(t("pdfFailed"));
  }
}
document.getElementById("sharePdfBtn").addEventListener("click", handleSharePdf);

function showPdfFallbackLink(url, fileName) {
  let box = document.getElementById("pdfFallbackBox");
  if (!box) {
    box = document.createElement("div");
    box.id = "pdfFallbackBox";
    document.getElementById("screen-report").appendChild(box);
  }
  const label = currentLang === "ar" ? "📄 تحميل ملف PDF" : "📄 Download PDF";
  box.innerHTML = `<a href="${url}" download="${fileName}" class="btn btn-primary pdf-link">${label}</a>`;
}
document.getElementById("generatePdfBtn").addEventListener("click", handleGeneratePdf);
document.getElementById("previewGeneratePdfBtn").addEventListener("click", handleGeneratePdf);

// ---------- Photo documentation settings ----------
document.getElementById("photoSettingsBtn").addEventListener("click", () => {
  const s = activeReport.photoSettings || defaultPhotoSettings();
  document.getElementById("settingEnabled").checked = s.enabled;
  document.getElementById("settingSchool").checked = s.showSchool;
  document.getElementById("settingDate").checked = s.showDate;
  document.getElementById("settingObsNumber").checked = s.showObsNumber;
  document.getElementById("settingTime").checked = s.showTime;
  document.getElementById("settingInspector").checked = s.showInspector;
  document.getElementById("inspectorNameInput").value = s.inspectorName || "";
  document.getElementById("pdfImageDocumented").checked = s.pdfImageType !== "original";
  document.getElementById("pdfImageOriginal").checked = s.pdfImageType === "original";
  showScreen("screen-photo-settings");
});

document.getElementById("cancelPhotoSettingsBtn").addEventListener("click", () => showScreen("screen-report"));

document.getElementById("savePhotoSettingsBtn").addEventListener("click", async () => {
  activeReport.photoSettings = {
    enabled: document.getElementById("settingEnabled").checked,
    showSchool: document.getElementById("settingSchool").checked,
    showDate: document.getElementById("settingDate").checked,
    showObsNumber: document.getElementById("settingObsNumber").checked,
    showTime: document.getElementById("settingTime").checked,
    showInspector: document.getElementById("settingInspector").checked,
    inspectorName: document.getElementById("inspectorNameInput").value.trim(),
    pdfImageType: document.getElementById("pdfImageOriginal").checked ? "original" : "documented"
  };
  await saveReport(activeReport);
  showToast(currentLang === "ar" ? "تم حفظ الإعدادات." : "Settings saved.");
  showScreen("screen-report");
});

// ---------- Init ----------
applyLanguage("ar");
