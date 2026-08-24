// ---------------------------------------------------------------------
// app.js
// Screen navigation + UI wiring. All persistence goes through
// storage.js. Camera/voice/speech logic lives in media.js. PDF export
// lives in pdf.js.
// ---------------------------------------------------------------------

// Single source of truth for observation categories — used to populate
// both the manual category field and the AI review screen's dropdown,
// and mirrored in worker.js's AI prompt so the AI only ever picks from
// this exact list.
const OBSERVATION_CATEGORIES = [
  "كهرباء", "كهرباء وإنارة", "سباكة", "دورات مياه", "تكييف وتبريد",
  "حريق", "السلامة", "مخارج طوارئ", "سلامة المبنى", "الأرضيات",
  "الأبواب والنوافذ", "أسقف وجدران", "النظافة", "المواد الكيميائية",
  "معدات السلامة", "الإسعافات الأولية", "التمديدات", "المخاطر العامة", "أخرى"
];

// Maps each observation category to an accent color used throughout the
// UI (observation card rail + badge) so the category taxonomy doubles as
// a visual wayfinding system — purely presentational, never read by any
// storage/export/AI code path.
const CATEGORY_COLORS = {
  "كهرباء": "#c9860f",
  "كهرباء وإنارة": "#c9860f",
  "سباكة": "#2f74b5",
  "دورات مياه": "#0c8a7e",
  "تكييف وتبريد": "#2f8fc7",
  "حريق": "#c23b30",
  "السلامة": "#14603f",
  "مخارج طوارئ": "#d1651c",
  "سلامة المبنى": "#5b6b73",
  "الأرضيات": "#97633c",
  "الأبواب والنوافذ": "#5c5fc4",
  "أسقف وجدران": "#55707e",
  "النظافة": "#3f9e63",
  "المواد الكيميائية": "#8a4bb0",
  "معدات السلامة": "#14603f",
  "الإسعافات الأولية": "#cf4570",
  "التمديدات": "#c9860f",
  "المخاطر العامة": "#9c2b2b",
  "أخرى": "#6b736c"
};
function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || "#6b736c";
}

function populateCategorySelects() {
  const aiSelect = document.getElementById("aiCategorySelect");
  const aiPrev = aiSelect.value;
  aiSelect.innerHTML = OBSERVATION_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("");
  if (aiPrev) aiSelect.value = aiPrev;

  const manualSelect = document.getElementById("observationCategorySelect");
  const manualPrev = manualSelect.value;
  const blankLabel = currentLang === "ar" ? "بدون تصنيف" : "No category";
  manualSelect.innerHTML =
    `<option value="">${blankLabel}</option>` +
    OBSERVATION_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("");
  manualSelect.value = manualPrev || "";
}

let currentLang = "ar";
let activeReport = null;         // full report object currently open
let editingIndex = null;         // index into activeReport.observations, or null = new
let stagedPhotos = [];           // array of {blob, takenAt} for the observation being edited
let stagedAudioBlob = null;
let pendingTranscript = "";
let isRecording = false;
let editingAIFields = {}; // preserves previously-approved AI fields when re-saving without re-running AI
let followUpCaptureIndex = null; // observation index currently capturing an after-fix photo
let followUpOpenIndices = new Set(); // which observations' follow-up panels are expanded (survives re-renders)
let isSavingObservation = false; // guards against double-submit (multi-click, or a retry while a save is already in flight)
let pendingNewObsIndex = null;   // for a NEW observation whose save failed: the array index it already occupies, so a retry overwrites it instead of pushing a duplicate
const recorder = new VoiceRecorder();

// ---------- Translations ----------
const translations = {
  ar: {
    appTitle: "WJ Safety",
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
    btnTakePhoto2: "📷 إضافة صورة",
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
    footerTextHeading: "نص التذييل (أسفل كل صفحة بالتقرير)",
    footerTextPlaceholder: "إعداد: م. ص.س.م / ولاء الجابري",
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
    btnRecord: "🎙️ اضغطي وتكلمي",
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
    backupImported: (s) => `تم استيراد ${s.reports} زيارة، ${s.monthly_schools} مدرسة، ${s.monthly_submissions} أرشيف صور شهرية.${s.skipped ? ` (تعذر قراءة ${s.skipped} سجل)` : ""}`,
    backupImportFailed: "تعذر استيراد الملف. تأكدي أنه نسخة احتياطية صحيحة. بياناتك الحالية سليمة ولم تتأثر.",
    backupRestoreRolledBack: "تعذرت الاستعادة أثناء التنفيذ، فتم التراجع تلقائيًا. بياناتك الأصلية سليمة كما كانت.",
    backupRestoreCritical: "حدث خطأ أثناء الاستعادة. افتحي «فحص البيانات المخزّنة» للتأكد من سلامة بياناتك.",
    btnDataDiagnostic: "🔍 فحص البيانات المخزّنة",
    diagnosticHeading: "فحص البيانات المخزّنة",
    diagnosticIntro: "هذه الشاشة للقراءة فقط — تعرض ما هو محفوظ فعليًا على هذا الجهاز الآن، ولا تُعدّل أو تحذف أي شيء.",
    diagnosticSearchPlaceholder: "ابحثي باسم المدرسة أو عنوان التقرير (اتركيه فارغًا لعرض الكل)",
    diagnosticSummary: (total, matched) => `إجمالي التقارير المخزّنة: ${total} — المطابقة للبحث: ${matched}`,
    diagnosticNoResults: "لا يوجد تقرير مطابق لهذا البحث.",
    diagnosticNoPhotos: "لا صور في هذه الملاحظة.",
    diagnosticNoText: "(بدون نص)",
    diagnosticNoObs: "لا توجد ملاحظات محفوظة في هذا التقرير.",
    diagnosticObsCount: (n) => `عدد الملاحظات المحفوظة فعليًا: ${n}`,
    diagnosticHasDraft: "يوجد تعديل غير محفوظ رسميًا بعد",
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
    monthlySaveFailedQueued: "تعذر حفظ الصورة الآن. الصورة محفوظة مؤقتًا وسيُعاد المحاولة تلقائيًا.",
    photoStatusSaving: "جاري الحفظ محليًا…",
    photoStatusSaved: "محفوظة محليًا",
    photoStatusRetry: "تعذر الحفظ، سيُعاد المحاولة تلقائيًا",
    pendingSaveIndicator: (n) => `🔄 ${n} ${n === 1 ? "عنصر بانتظار الحفظ" : "عناصر بانتظار الحفظ"}`,
    cloudSyncPending: (n) => `☁️ جاري مزامنة ${n} ${n === 1 ? "عنصر" : "عناصر"} مع السحابة`,
    cloudSyncNeedsAttention: "☁️ تعذّرت مزامنة بعض البيانات — البيانات محفوظة على جهازك وسيُعاد المحاولة",
    cloudSyncSignInNeeded: "☁️ سجّلي الدخول لمزامنة بياناتك — بياناتك محفوظة على جهازك بأمان",
    loginHeading: "تسجيل الدخول للمزامنة السحابية",
    loginHint: "التطبيق يعمل بالكامل بدون تسجيل دخول. تسجيل الدخول مطلوب فقط لمزامنة بياناتك مع النسخة الاحتياطية السحابية.",
    loginPasswordLabel: "كلمة المرور",
    btnLogin: "تسجيل الدخول",
    btnCloudSignIn: "☁️ تسجيل الدخول للمزامنة",
    btnCloudSignOut: "☁️ تسجيل الخروج من المزامنة",
    loginSigningIn: "جاري تسجيل الدخول...",
    loginBadPassword: "كلمة المرور غير صحيحة.",
    loginTooMany: "محاولات كثيرة. انتظري ١٥ دقيقة ثم حاولي مرة أخرى.",
    loginNetworkError: "تعذر الاتصال. بياناتك محفوظة على جهازك ولن تُفقد.",
    loginServerError: (status, code) => `خطأ من الخادم (${status}: ${code}) — ليست مشكلة في كلمة المرور.`,
    loginSuccess: "تم تسجيل الدخول. ستبدأ المزامنة تلقائيًا.",
    loggedOut: "تم تسجيل الخروج. بياناتك لا تزال محفوظة على جهازك.",
    draftRestored: "↩️ تمت استعادة تعديلاتك غير المحفوظة.",
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
    noVisitsYetShort: "لا توجد زيارات بعد",
    btnStartVisit2: "＋ زيارة جديدة",
    btnSchoolMonthly: "📷 الصور الشهرية",
    btnSchoolReports: "📄 التقارير",
    tabVisits: "سجل الزيارات",
    tabObservations: "الملاحظات",
    statusComplete: "مكتمل",
    statusIncomplete: "ناقص",
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
    aiActionLabel: "الإجراء المقترح",
    aiConfidenceLabel: (pct) => `مستوى ثقة AI: ${pct}%`,
    btnApproveAI: "✅ اعتماد وحفظ",
    spotLocationHeading: "موقع الملاحظة",
    manualCategoryHeading: "التصنيف (اختياري)",
    dashboardHeading: "ملخص عملك اليوم",
    statSchoolsLabel: "مدارس",
    statVisitsLabel: "زيارات",
    statObsLabel: "ملاحظات",
    statMonthLabel: "هذا الشهر",
    btnQuickStartVisit: "+ بدء زيارة",
    btnQuickSchools: "🏫 المدارس",
    btnOpenMonthlyShort: "📸 الصور الشهرية",
    btnQuickReports: "📄 التقارير",
    recentVisitsHeading: "آخر النشاطات",
    noRecentVisits: "لا توجد زيارات بعد.",
    allReportsHeading: "كل التقارير",
    noReportsAtAll: "لا توجد أي زيارات بعد.",
    schoolObsHistoryHeading: "الملاحظات السابقة",
    noSchoolObs: "لا توجد ملاحظات سابقة.",
    btnReuseNote: "♻️ استخدام كملاحظة جديدة",
    noteReused: "تم نسخ الملاحظة — عدّلي التفاصيل وأضيفي صورة جديدة قبل الحفظ.",
    searchObsResultsHeading: (n) => `نتائج البحث بالملاحظات (${n})`,
    btnGeneratePptx: "🖥️ توليد PowerPoint",
    pptxSummaryHeading: "ملخص قبل التوليد",
    pptxSummarySchool: "المدرسة:",
    pptxSummaryMonth: "الشهر:",
    pptxSummaryPhotos: "الصور:",
    pptxMissingList: (list) => `صور ناقصة (بيبقى مكان الصورة الأصلية بالقالب): ${list}`,
    btnGeneratePptxConfirm: "توليد PowerPoint",
    pptxGenerating: "⏳ جاري التوليد...",
    pptxGenerated: "تم توليد ملف PowerPoint.",
    pptxGenerateFailed: "تعذر توليد الملف. تأكدي من الاتصال بالإنترنت وحاولي مرة أخرى.",
    btnMultiSchool: "🖥️ تجميع تقارير المدارس",
    multiSchoolSelectHeading: "اختيار المدارس",
    btnSelectAll: "تحديد الكل",
    btnSelectNone: "إلغاء تحديد الكل",
    btnNext: "التالي",
    multiNeedSelection: "اختاري مدرسة واحدة على الأقل.",
    multiSummarySchoolsCount: "المدارس المحددة:",
    multiMissingWarning: "⚠️ بعض المدارس تحتوي على صور ناقصة (الخانة الناقصة تبقى بصورة القالب الأصلية):",
    btnSceneTracking: "📋 متابعة المشاهد",
    sceneStatReceived: "تم الاستلام",
    sceneStatSent: "أُرسل للمشرف",
    sceneStatNotDone: "لم يتم",
    sceneStatPercent: "نسبة الإنجاز",
    noScenesYet: "لم تتم إضافة أي مشاهد بعد. أضيفي مشاهد من ⚙ إدارة قائمة المشاهد.",
    btnManageScenes: "⚙ إدارة قائمة المشاهد",
    btnSceneHistory: "🗂️ سجل الأشهر السابقة",
    sceneHistoryHeading: "🗂️ سجل الأشهر السابقة",
    noSceneHistory: "لا يوجد سجل سابق بعد.",
    manageScenesHeading: "إدارة قائمة المشاهد",
    newScenePlaceholder: "اسم مشهد جديد",
    needSceneName: "الرجاء كتابة اسم المشهد.",
    sceneAdded: "تمت إضافة المشهد.",
    sceneDeleted: "تم حذف المشهد.",
    confirmDeleteScene: "هل تريدين حذف هذا المشهد؟",
    sceneSaveFailed: "تعذر حفظ الحالة. حاولي مرة أخرى.",
    greetingMorning: "صباح الخير 👋",
    greetingAfternoon: "مساء الخير 👋",
    greetingEvening: "مساء الخير 👋",
    btnQuickStartVisit2: "＋ زيارة جديدة",
    quickAccessHeading: "الوصول السريع",
    tileSchools: "المدارس",
    tileMonthly: "الصور الشهرية",
    tileReports: "التقارير",
    tileSearch: "البحث",
    noSchoolsHomeTitle: "لا توجد مدارس بعد",
    noSchoolsHomeSub: "أضيفي أول مدرسة من الأعلى للبدء",
    spotLocationPlaceholder: "مثال: فصل 3ب - بجانب السبورة، أو غرفة المعلمات - الدور الثاني",
    needSpotLocation: "الرجاء كتابة موقع الملاحظة.",
    obsSpotLabel: "الموقع",
    pendingAIBadge: "⏳ بانتظار التحليل",
    btnAnalyzePending: "🔄 تحليل كل الملاحظات المعلقة",
    offlineAnalyzeSaved: "📴 لا يوجد اتصال — تم حفظ الملاحظة وستُحلَّل لاحقًا.",
    analyzingPendingProgress: (i, n) => `⏳ جاري التحليل (${i}/${n})...`,
    analyzingPendingDone: (ok, total) => `تم تحليل ${ok} من ${total} ملاحظة معلّقة.`,
    followUpStart: "🔄 متابعة الإصلاح",
    followUpHeading: "متابعة الإصلاح",
    followUpStatusInProgress: "قيد المتابعة",
    followUpStatusFixed: "تم الإصلاح",
    followUpStatusNotFixed: "لم يتم الإصلاح",
    followUpBefore: "قبل",
    followUpAfter: "بعد",
    followUpAddAfterPhoto: "📷 إضافة صورة بعد الإصلاح",
    followUpMarkFixed: "✅ تم الإصلاح",
    followUpMarkNotFixed: "↩️ لم يتم الإصلاح",
    followUpVerificationDateLabel: "تاريخ التحقق",
    followUpNotePlaceholder: "ملاحظة التحقق (اختياري)",
    followUpPhotoSaved: "تم حفظ صورة ما بعد الإصلاح.",
    savingObservation: "⏳ جاري الحفظ...",
    btnRetrySaveObservation: "🔄 إعادة المحاولة",
    observationSaveFailed: "تعذر حفظ الملاحظة. البيانات محفوظة مؤقتًا، حاول مرة أخرى."
  },
  en: {
    appTitle: "WJ Safety",
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
    btnTakePhoto2: "📷 Add Photo",
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
    footerTextHeading: "Footer text (bottom of every report page)",
    footerTextPlaceholder: "إعداد: م. ص.س.م / ولاء الجابري",
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
    btnRecord: "🎙️ Tap and Speak",
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
    backupImported: (s) => `Imported ${s.reports} visit${s.reports === 1 ? "" : "s"}, ${s.monthly_schools} school${s.monthly_schools === 1 ? "" : "s"}, ${s.monthly_submissions} monthly photo record${s.monthly_submissions === 1 ? "" : "s"}.${s.skipped ? ` (${s.skipped} record${s.skipped === 1 ? "" : "s"} couldn't be read)` : ""}`,
    backupImportFailed: "Couldn't import the file. Make sure it's a valid backup. Your current data is safe and untouched.",
    backupRestoreRolledBack: "The restore failed partway through and was automatically rolled back. Your original data is intact.",
    backupRestoreCritical: "Something went wrong during restore. Open “Check Stored Data” to verify your data is intact.",
    btnDataDiagnostic: "🔍 Check Stored Data",
    diagnosticHeading: "Check Stored Data",
    diagnosticIntro: "Read-only -- shows exactly what's actually saved on this device right now. Never edits or deletes anything.",
    diagnosticSearchPlaceholder: "Search by school name or report title (leave empty to show all)",
    diagnosticSummary: (total, matched) => `Total stored reports: ${total} — matching search: ${matched}`,
    diagnosticNoResults: "No report matches this search.",
    diagnosticNoPhotos: "No photos on this observation.",
    diagnosticNoText: "(no text)",
    diagnosticNoObs: "No observations saved in this report.",
    diagnosticObsCount: (n) => `Observations actually saved: ${n}`,
    diagnosticHasDraft: "Has an unsaved draft edit",
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
    monthlySaveFailedQueued: "Couldn't save the photo right now. It's kept and will retry automatically.",
    photoStatusSaving: "Saving locally…",
    photoStatusSaved: "Saved locally",
    photoStatusRetry: "Couldn't save yet, retrying automatically",
    pendingSaveIndicator: (n) => `🔄 ${n} item${n === 1 ? "" : "s"} waiting to save`,
    cloudSyncPending: (n) => `☁️ Syncing ${n} item${n === 1 ? "" : "s"} to the cloud`,
    cloudSyncNeedsAttention: "☁️ Couldn't sync some data yet — it's saved on your device and will retry automatically",
    cloudSyncSignInNeeded: "☁️ Sign in to sync — your data is saved safely on this device",
    loginHeading: "Sign in for cloud sync",
    loginHint: "The app works fully without signing in. Signing in is only needed to sync your data to the cloud backup.",
    loginPasswordLabel: "Password",
    btnLogin: "Sign in",
    btnCloudSignIn: "☁️ Sign in for cloud sync",
    btnCloudSignOut: "☁️ Sign out of cloud sync",
    loginSigningIn: "Signing in...",
    loginBadPassword: "Incorrect password.",
    loginTooMany: "Too many attempts. Wait 15 minutes and try again.",
    loginNetworkError: "Couldn't connect. Your data is saved on this device and won't be lost.",
    loginServerError: (status, code) => `Server error (${status}: ${code}) — this is not a password problem.`,
    loginSuccess: "Signed in. Syncing will start automatically.",
    loggedOut: "Signed out. Your data is still saved on this device.",
    draftRestored: "↩️ Your unsaved changes were restored.",
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
    noVisitsYetShort: "No visits yet",
    btnStartVisit2: "＋ New Visit",
    btnSchoolMonthly: "📷 Monthly Photos",
    btnSchoolReports: "📄 Reports",
    tabVisits: "Visit History",
    tabObservations: "Observations",
    statusComplete: "Complete",
    statusIncomplete: "Incomplete",
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
    aiActionLabel: "Recommended Action",
    aiConfidenceLabel: (pct) => `AI confidence: ${pct}%`,
    btnApproveAI: "✅ Approve & Save",
    spotLocationHeading: "Observation Location",
    manualCategoryHeading: "Category (optional)",
    dashboardHeading: "Today's Summary",
    statSchoolsLabel: "Schools",
    statVisitsLabel: "Visits",
    statObsLabel: "Observations",
    statMonthLabel: "This Month",
    btnQuickStartVisit: "+ Start Visit",
    btnQuickSchools: "🏫 Schools",
    btnOpenMonthlyShort: "📸 Monthly Photos",
    btnQuickReports: "📄 Reports",
    recentVisitsHeading: "Recent Activity",
    noRecentVisits: "No visits yet.",
    allReportsHeading: "All Reports",
    noReportsAtAll: "No visits yet.",
    schoolObsHistoryHeading: "Previous Observations",
    noSchoolObs: "No previous observations.",
    btnReuseNote: "♻️ Use as New Note",
    noteReused: "Note copied — edit the details and add a new photo before saving.",
    searchObsResultsHeading: (n) => `Matching observations (${n})`,
    btnGeneratePptx: "🖥️ Generate PowerPoint",
    pptxSummaryHeading: "Summary Before Generating",
    pptxSummarySchool: "School:",
    pptxSummaryMonth: "Month:",
    pptxSummaryPhotos: "Photos:",
    pptxMissingList: (list) => `Missing photos (original template photo stays in that spot): ${list}`,
    btnGeneratePptxConfirm: "Generate PowerPoint",
    pptxGenerating: "⏳ Generating...",
    pptxGenerated: "PowerPoint file generated.",
    pptxGenerateFailed: "Couldn't generate the file. Check your connection and try again.",
    btnMultiSchool: "🖥️ Combine School Reports",
    multiSchoolSelectHeading: "Select Schools",
    btnSelectAll: "Select All",
    btnSelectNone: "Deselect All",
    btnNext: "Next",
    multiNeedSelection: "Select at least one school.",
    multiSummarySchoolsCount: "Selected schools:",
    multiMissingWarning: "⚠️ Some schools have missing photos (that spot keeps the template's original photo):",
    btnSceneTracking: "📋 Scene Tracking",
    sceneStatReceived: "Received",
    sceneStatSent: "Sent to Supervisor",
    sceneStatNotDone: "Not Done",
    sceneStatPercent: "Completion Rate",
    noScenesYet: "No scenes added yet. Add some from ⚙ Manage Scene List.",
    btnManageScenes: "⚙ Manage Scene List",
    btnSceneHistory: "🗂️ Previous Months",
    sceneHistoryHeading: "🗂️ Previous Months",
    noSceneHistory: "No history yet.",
    manageScenesHeading: "Manage Scene List",
    newScenePlaceholder: "New scene name",
    needSceneName: "Please enter a scene name.",
    sceneAdded: "Scene added.",
    sceneDeleted: "Scene deleted.",
    confirmDeleteScene: "Delete this scene?",
    sceneSaveFailed: "Couldn't save the status. Please try again.",
    greetingMorning: "Good morning 👋",
    greetingAfternoon: "Good afternoon 👋",
    greetingEvening: "Good evening 👋",
    btnQuickStartVisit2: "＋ New Visit",
    quickAccessHeading: "Quick Access",
    tileSchools: "Schools",
    tileMonthly: "Monthly Photos",
    tileReports: "Reports",
    tileSearch: "Search",
    noSchoolsHomeTitle: "No schools yet",
    noSchoolsHomeSub: "Add your first school above to get started",
    spotLocationPlaceholder: "e.g. Classroom 3B - next to the whiteboard, or Teachers' Room - 2nd floor",
    needSpotLocation: "Please enter the observation location.",
    obsSpotLabel: "Location",
    pendingAIBadge: "⏳ Pending analysis",
    btnAnalyzePending: "🔄 Analyze All Pending Notes",
    offlineAnalyzeSaved: "📴 No connection — the note was saved and will be analyzed later.",
    analyzingPendingProgress: (i, n) => `⏳ Analyzing (${i}/${n})...`,
    analyzingPendingDone: (ok, total) => `Analyzed ${ok} of ${total} pending notes.`,
    followUpStart: "🔄 Track Fix",
    followUpHeading: "Follow-up",
    followUpStatusInProgress: "In progress",
    followUpStatusFixed: "Fixed",
    followUpStatusNotFixed: "Not fixed",
    followUpBefore: "Before",
    followUpAfter: "After",
    followUpAddAfterPhoto: "📷 Add after-fix photo",
    followUpMarkFixed: "✅ Fixed",
    followUpMarkNotFixed: "↩️ Not fixed",
    followUpVerificationDateLabel: "Verification date",
    followUpNotePlaceholder: "Verification note (optional)",
    followUpPhotoSaved: "After-fix photo saved.",
    savingObservation: "⏳ Saving...",
    btnRetrySaveObservation: "🔄 Retry",
    observationSaveFailed: "Couldn't save the observation. Your data is kept -- try again."
  }
};

function t(key) {
  return translations[currentLang][key];
}

async function applyLanguage(lang) {
  currentLang = lang;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  populateCategorySelects();

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
function showToast(message, type = "") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "toast show" + (type ? ` toast-${type}` : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// Text-node round-tripping (textContent -> innerHTML) escapes & < > but
// NOT quote characters, since quotes aren't special inside a text node.
// This app also interpolates escapeHtml() output inside quoted HTML
// attributes (e.g. monthly.js's `value="${escapeHtml(slot.label)}"`), so
// a value containing `"` could otherwise break out of the attribute and
// inject new attributes/event handlers. Escaping quotes here makes the
// same function safe in both contexts; harmless where it's only ever
// used as text, since &quot;/&#39; render identically to " and '.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
  "screen-pptx-summary": "pptxSummaryBackBtn",
  "screen-multi-school-select": "multiSchoolBackBtn",
  "screen-multi-school-summary": "multiSummaryBackBtn",
  "screen-scene-tracking": "sceneTrackingBackBtn",
  "screen-scene-history": "sceneHistoryBackBtn",
  "screen-scene-template": "sceneTemplateBackBtn",
  "screen-school-detail": "schoolDetailBackBtn",
  "screen-unlinked-visits": "unlinkedVisitsBackBtn",
  "screen-ai-review": "aiCancelBtn",
  "screen-all-reports": "allReportsBackBtn",
  "screen-schools": "schoolsScreenBackBtn",
  "screen-data-diagnostic": "diagnosticBackBtn"
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
  renderDashboardStats();
  renderRecentVisits();
}

function resolveSchoolNameForReport(report) {
  if (report.schoolId) {
    const school = cachedSchools.find((s) => s.id === report.schoolId);
    if (school) return school.name;
  }
  return report.location || "";
}

function renderDashboardStats() {
  const totalObs = cachedAllReports.reduce((sum, r) => sum + r.observations.length, 0);
  const monthPrefix = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const thisMonthCount = cachedAllReports.filter((r) => (r.date || "").startsWith(monthPrefix)).length;

  document.getElementById("statSchools").textContent = cachedSchools.length;
  document.getElementById("statVisits").textContent = cachedAllReports.length;
  document.getElementById("statObservations").textContent = totalObs;
  document.getElementById("statThisMonth").textContent = thisMonthCount;

  const hour = new Date().getHours();
  const greetingKey = hour < 12 ? "greetingMorning" : hour < 17 ? "greetingAfternoon" : "greetingEvening";
  document.getElementById("homeGreetingTime").textContent = t(greetingKey);
}

function renderRecentVisits() {
  const listEl = document.getElementById("recentVisitsList");
  const emptyEl = document.getElementById("noRecentVisitsMsg");
  listEl.innerHTML = "";

  const recent = cachedAllReports
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 5);

  if (recent.length === 0) {
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";

  recent.forEach((report) => {
    const card = document.createElement("div");
    card.className = "recent-visit-card";
    card.innerHTML = `
      <div class="rv-info">
        <h4>${escapeHtml(resolveSchoolNameForReport(report))}</h4>
        <p>${escapeHtml(report.date)} · ${t("obsCount")(report.observations.length)}</p>
      </div>
      <button class="rv-open" data-id="${report.id}">${t("openBtn")}</button>
    `;
    listEl.appendChild(card);
  });
  listEl.querySelectorAll(".rv-open").forEach((btn) => {
    btn.addEventListener("click", () => openReport(btn.dataset.id));
  });
}

// A visit is considered to belong to a school if either its schoolId
// matches (new, reliable way — set automatically since this phase),
// or — for older visits saved before schoolId existed — its location
// text matches the school's name (the original matching rule, kept
// for backward compatibility so no old visit ever "disappears").
function visitBelongsToSchool(report, school) {
  if (report.schoolId) return report.schoolId === school.id;
  return normalizeName(report.location) === normalizeName(school.name);
}

function schoolStats(school) {
  const visits = cachedAllReports.filter((r) => visitBelongsToSchool(r, school));
  const obsCount = visits.reduce((sum, v) => sum + v.observations.length, 0);
  const lastVisit = visits.reduce((max, v) => (!max || v.date > max ? v.date : max), null);
  return { visits, visitCount: visits.length, obsCount, lastVisit };
}

async function renderSchoolsHomeList() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const schools = query
    ? cachedSchools.filter((s) => (s.name || "").toLowerCase().includes(query))
    : cachedSchools;

  const listEl = document.getElementById("schoolsHomeList");
  const emptyEl = document.getElementById("noSchoolsMsg");
  listEl.innerHTML = "";

  if (schools.length === 0) {
    emptyEl.style.display = "block";
    if (query) {
      emptyEl.innerHTML = `<div class="empty-state-icon">🔎</div><div class="empty-state-title">${escapeHtml(t("noSearchResults"))}</div>`;
    } else {
      emptyEl.innerHTML = `<div class="empty-state-icon">🏫</div><div class="empty-state-title">${escapeHtml(t("noSchoolsHomeTitle"))}</div><div class="empty-state-sub">${escapeHtml(t("noSchoolsHomeSub"))}</div>`;
    }
  } else {
    emptyEl.style.display = "none";
    const monthlySlotsForCards = await getMonthlySlots();
    const monthKeyForCards = new Date().toISOString().slice(0, 7);

    for (const school of schools) {
      const stats = schoolStats(school);
      let monthlyDone = 0;
      try {
        const submission = await getMonthlySubmission(school.id, monthKeyForCards);
        monthlyDone = Object.keys(submission.photos || {}).length;
      } catch (e) { /* monthly photos not started yet for this school */ }
      const monthlyTotal = monthlySlotsForCards.length;
      const monthlyPct = monthlyTotal > 0 ? Math.round((monthlyDone / monthlyTotal) * 100) : 0;

      const card = document.createElement("div");
      card.className = "report-card school-card";
      card.innerHTML = `
        <h4>${escapeHtml(school.name)}</h4>
        <p class="muted">${stats.lastVisit ? t("lastVisitLabel") + " " + escapeHtml(stats.lastVisit) : t("noVisitsYetShort")}</p>
        <div class="school-card-badges">
          <span class="status-badge status-progress">${t("visitsCount")(stats.visitCount)}</span>
          <span class="status-badge status-progress">● ${t("obsCount")(stats.obsCount)}</span>
        </div>
        ${monthlyTotal > 0 ? `
          <div class="school-card-monthly">
            <p class="muted">📷 ${t("tileMonthly")} ${monthlyDone}/${monthlyTotal}</p>
            <div class="progress-bar-track"><div class="progress-bar-fill ${monthlyPct < 100 ? "warning" : ""}" style="width:${monthlyPct}%"></div></div>
          </div>` : ""}
        <div class="card-actions">
          <button class="card-open school-open" data-id="${school.id}">${t("openBtn")}</button>
          <button class="card-delete school-delete" data-id="${school.id}">${t("deleteBtn")}</button>
        </div>
      `;
      listEl.appendChild(card);
    }

    listEl.querySelectorAll(".school-open").forEach((btn) => {
      btn.addEventListener("click", () => openSchoolDetail(btn.dataset.id));
    });
    listEl.querySelectorAll(".school-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (confirm(t("monthlyDeleteSchoolConfirm"))) {
          await deleteMonthlySchool(btn.dataset.id);
          showToast(t("monthlySchoolDeleted"), "success");
          await renderHome();
          await renderSchoolsHomeList();
        }
      });
    });

    // Unlinked visits button: reports that don't belong to any saved school
    const unlinkedCount = cachedAllReports.filter((r) => !cachedSchools.some((s) => visitBelongsToSchool(r, s))).length;
    const unlinkedBtn = document.getElementById("viewUnlinkedBtn");
    if (unlinkedCount > 0) {
      unlinkedBtn.style.display = "block";
      unlinkedBtn.textContent = t("unlinkedVisitsBtn")(unlinkedCount);
    } else {
      unlinkedBtn.style.display = "none";
    }
  }

  renderSearchObservationResults(query);
}

// Extends search beyond school names: also surfaces matching
// observations (text or location) across every visit, shown below the
// schools list only when there's something to show — keeps the default
// (empty search) dashboard exactly as before.
function renderSearchObservationResults(query) {
  let container = document.getElementById("searchObsResults");
  if (!container) {
    container = document.createElement("div");
    container.id = "searchObsResults";
    document.getElementById("schoolsHomeList").insertAdjacentElement("afterend", container);
  }
  container.innerHTML = "";
  if (!query) return;

  const matches = [];
  cachedAllReports.forEach((report) => {
    report.observations.forEach((obs) => {
      const haystack = `${obs.text || ""} ${obs.spotLocation || ""}`.toLowerCase();
      if (haystack.includes(query)) matches.push({ report, obs });
    });
  });
  if (matches.length === 0) return;

  const heading = document.createElement("h3");
  heading.className = "section-heading";
  heading.textContent = t("searchObsResultsHeading")(matches.length);
  container.appendChild(heading);

  matches.slice(0, 10).forEach(({ report, obs }) => {
    const card = document.createElement("div");
    card.className = "obs-card";
    card.innerHTML = `
      <p class="muted">${escapeHtml(resolveSchoolNameForReport(report))} · ${escapeHtml(report.date)}</p>
      ${obs.spotLocation ? `<p class="obs-spot">📍 ${escapeHtml(obs.spotLocation)}</p>` : ""}
      <p class="obs-text">${escapeHtml(obs.text)}</p>
      <div class="card-actions">
        <button class="card-open">${t("openBtn")}</button>
      </div>
    `;
    card.querySelector("button").addEventListener("click", () => openReport(report.id));
    container.appendChild(card);
  });
}

let isAddingSchoolHome = false;
document.getElementById("addSchoolBtnHome").addEventListener("click", async () => {
  if (isAddingSchoolHome) return; // guards against a duplicate school record from a rapid double-tap
  const input = document.getElementById("newSchoolNameInputHome");
  const name = input.value.trim();
  if (!name) {
    showToast(t("needSchoolName"), "warning");
    return;
  }
  isAddingSchoolHome = true;
  const btn = document.getElementById("addSchoolBtnHome");
  btn.disabled = true;
  try {
    const school = await addMonthlySchool(name);
    // Cloud sync only, after the local save above already succeeded --
    // see saveCurrentObservation()'s matching comment. Missing this is
    // exactly what left visits/observations/photos created under a
    // school stuck "pending" forever: they wait on this school (and the
    // visit) to sync first, and a dependency that was never enqueued at
    // all never syncs, silently, with no error to surface.
    if (typeof enqueueEntitySync === "function") {
      enqueueEntitySync("school", "create", school.id, { id: school.id, name: school.name });
    }
    input.value = "";
    await renderHome();
    await renderSchoolsHomeList();
  } finally {
    btn.disabled = false;
    isAddingSchoolHome = false;
  }
});

document.getElementById("searchInput").addEventListener("input", renderSchoolsHomeList);

// ---------- Dashboard quick actions ----------
// The full schools list no longer lives on the home dashboard (it was
// crowding it) — it now lives in its own dedicated screen, opened from
// the home page's "Schools" tile, the primary "new visit" CTA (visits
// start by picking a school), and the search tile.
async function openSchoolsScreen(focusSearch) {
  showScreen("screen-schools");
  await renderSchoolsHomeList();
  if (focusSearch) document.getElementById("searchInput").focus();
}
document.getElementById("quickStartVisitBtn").addEventListener("click", () => openSchoolsScreen(false));
document.getElementById("quickSchoolsBtn").addEventListener("click", () => openSchoolsScreen(false));
document.getElementById("quickSearchBtn").addEventListener("click", () => openSchoolsScreen(true));

document.getElementById("quickReportsBtn").addEventListener("click", () => {
  const listEl = document.getElementById("allReportsList");
  const emptyEl = document.getElementById("noAllReportsMsg");
  listEl.innerHTML = "";

  const sorted = cachedAllReports.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (sorted.length === 0) {
    emptyEl.style.display = "block";
  } else {
    emptyEl.style.display = "none";
    sorted.forEach((report) => {
      const card = document.createElement("div");
      card.className = "report-card report-list-card";
      card.innerHTML = `
        <div class="report-list-card-icon">📄</div>
        <div class="report-list-card-body">
          <h4>${escapeHtml(report.title)}</h4>
          <p class="muted">${escapeHtml(resolveSchoolNameForReport(report))}</p>
          <div class="school-card-badges">
            <span class="status-badge status-progress">${escapeHtml(report.date)}</span>
            <span class="status-badge status-progress">● ${t("obsCount")(report.observations.length)}</span>
          </div>
        </div>
        <button class="card-open ar-open" data-id="${report.id}">${t("openBtn")}</button>
      `;
      listEl.appendChild(card);
    });
    listEl.querySelectorAll(".ar-open").forEach((btn) => {
      btn.addEventListener("click", () => openReport(btn.dataset.id));
    });
  }
  showScreen("screen-all-reports");
});

document.getElementById("allReportsBackBtn").addEventListener("click", () => {
  showScreen("screen-home");
});

// ---------- School Detail ----------
async function openSchoolDetail(schoolId) {
  const school = cachedSchools.find((s) => s.id === schoolId);
  if (!school) return;
  activeSchoolForVisits = school;

  // Always reset to the "visits" tab when (re-)entering a school profile.
  document.querySelectorAll(".school-tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector('.school-tab-btn[data-tab="visits"]').classList.add("active");
  document.getElementById("schoolTabVisits").style.display = "block";
  document.getElementById("schoolTabObs").style.display = "none";

  const stats = schoolStats(school);
  document.getElementById("schoolDetailName").textContent = school.name;
  document.getElementById("schoolDetailStats").textContent =
    `${t("visitsCount")(stats.visitCount)} · ${t("obsCount")(stats.obsCount)}` +
    (stats.lastVisit ? ` · ${t("lastVisitLabel")} ${stats.lastVisit}` : "");

  // Monthly photo status for the current month
  try {
    const slots = await getMonthlySlots();
    const monthKey = new Date().toISOString().slice(0, 7);
    const submission = await getMonthlySubmission(school.id, monthKey);
    const done = Object.keys(submission.photos || {}).length;
    document.getElementById("schoolMonthlyStatus").textContent =
      "📅 " + t("monthlyProgress")(done, slots.length);
  } catch (e) {
    document.getElementById("schoolMonthlyStatus").textContent = "";
  }

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
          showToast(t("reportDeleted"), "success");
          openSchoolDetail(schoolId);
        }
      });
    });
  }

  // Flattened observation history across all this school's visits
  const obsHistoryList = document.getElementById("schoolObsHistoryList");
  const obsHistoryEmpty = document.getElementById("noSchoolObsMsg");
  obsHistoryList.innerHTML = "";

  const allObs = [];
  stats.visits.forEach((visit) => {
    visit.observations.forEach((obs) => allObs.push({ obs, date: visit.date }));
  });
  allObs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if (allObs.length === 0) {
    obsHistoryEmpty.style.display = "block";
  } else {
    obsHistoryEmpty.style.display = "none";
    allObs.forEach(({ obs, date }, i) => {
      const photos = obsPhotos(obs);
      const thumbHtml = photos.length ? `<img src="${URL.createObjectURL(photos[0].blob)}" class="obs-thumb" alt="">` : "";
      const card = document.createElement("div");
      card.className = "obs-card";
      card.innerHTML = `
        <p class="muted">${escapeHtml(date)}${obs.category ? " · " + escapeHtml(obs.category) : ""}</p>
        ${obs.spotLocation ? `<p class="obs-spot">📍 ${escapeHtml(obs.spotLocation)}</p>` : ""}
        ${thumbHtml}
        <p class="obs-text">${escapeHtml(obs.text)}</p>
        ${obs.recommendedAction ? `<p class="obs-action"><strong>${t("aiActionLabel")}:</strong> ${escapeHtml(obs.recommendedAction)}</p>` : ""}
        <div class="card-actions">
          <button class="card-open obs-reuse" data-i="${i}">${t("btnReuseNote")}</button>
        </div>
      `;
      obsHistoryList.appendChild(card);
    });
    obsHistoryList.querySelectorAll(".obs-reuse").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = allObs[parseInt(btn.dataset.i, 10)];
        reuseObservationForSchool(entry.obs);
      });
    });
  }

  showScreen("screen-school-detail");
}

// Cloud sync for a visit created under an existing school -- the other
// half of enqueueEntitySync("visit", ...) alongside the "quick visit"
// path in the newReportForm handler below. Missing this for years is
// exactly what left visits (and every observation/photo under them)
// started from a school's page stuck "pending" forever: sync.js makes
// an observation wait for its visit, and a photo wait for its
// observation, and a dependency that was never enqueued at all never
// syncs -- silently, with no error surfaced anywhere. See also
// backfillMissingParentSyncItems() in sync.js, which repairs any visit
// already stuck this way from before this fix.
function enqueueVisitSync(report) {
  if (typeof enqueueEntitySync !== "function") return;
  enqueueEntitySync("visit", "create", report.id, {
    id: report.id,
    schoolId: report.schoolId || undefined,
    title: report.title,
    location: report.location,
    date: report.date
  });
}

async function reuseObservationForSchool(obsData) {
  if (!activeSchoolForVisits) return;
  const today = new Date().toISOString().split("T")[0];
  const report = {
    id: generateId(),
    title: `${t("visitDefaultTitlePrefix")} ${today}`,
    schoolId: activeSchoolForVisits.id,
    location: activeSchoolForVisits.name,
    date: today,
    observations: [],
    photoSettings: defaultPhotoSettings(),
    createdAt: Date.now()
  };
  await saveReport(report);
  enqueueVisitSync(report);
  activeReport = report;
  openObservationEditor(null);
  document.getElementById("observationText").value = obsData.text || "";
  document.getElementById("observationSpotLocation").value = obsData.spotLocation || "";
  document.getElementById("observationCategorySelect").value = obsData.category || "";
  editingAIFields = obsData.recommendedAction ? { recommendedAction: obsData.recommendedAction } : {};
  showToast(t("noteReused"), "success");
}

let activeSchoolForVisits = null;

document.getElementById("startVisitBtn").addEventListener("click", async () => {
  if (!activeSchoolForVisits) return;
  const today = new Date().toISOString().split("T")[0];
  const report = {
    id: generateId(),
    title: `${t("visitDefaultTitlePrefix")} ${today}`,
    schoolId: activeSchoolForVisits.id,
    location: activeSchoolForVisits.name,
    date: today,
    observations: [],
    photoSettings: defaultPhotoSettings(),
    createdAt: Date.now()
  };
  await saveReport(report);
  enqueueVisitSync(report);
  await openReport(report.id);
});

// ---------- School profile: tabs + monthly-photos shortcut ----------
document.querySelectorAll(".school-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".school-tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("schoolTabVisits").style.display = btn.dataset.tab === "visits" ? "block" : "none";
    document.getElementById("schoolTabObs").style.display = btn.dataset.tab === "obs" ? "block" : "none";
  });
});

document.getElementById("scrollToVisitsTabBtn").addEventListener("click", () => {
  document.querySelector('.school-tab-btn[data-tab="visits"]').click();
});

document.getElementById("openSchoolMonthlyBtn").addEventListener("click", async () => {
  if (!activeSchoolForVisits) return;
  // These are monthly.js's own state — populate them here too, since this
  // shortcut can be used without ever visiting the main Monthly Photos
  // entry point first.
  monthlySlots = await getMonthlySlots();
  monthlySchools = await getAllMonthlySchools();
  if (!currentMonthKey) currentMonthKey = defaultMonthKey();
  await openSchoolPhotos(activeSchoolForVisits.id);
});

// ---------- Unlinked visits ----------
document.getElementById("viewUnlinkedBtn").addEventListener("click", () => {
  const unlinked = cachedAllReports.filter((r) => !cachedSchools.some((s) => visitBelongsToSchool(r, s)));

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
        showToast(t("reportDeleted"), "success");
        await renderHome();
        document.getElementById("viewUnlinkedBtn").click();
      }
    });
  });

  showScreen("screen-unlinked-visits");
});

document.getElementById("schoolDetailBackBtn").addEventListener("click", async () => {
  await renderHome();
  await openSchoolsScreen(false);
});

document.getElementById("unlinkedVisitsBackBtn").addEventListener("click", async () => {
  await renderHome();
  await openSchoolsScreen(false);
});

document.getElementById("schoolsScreenBackBtn").addEventListener("click", async () => {
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
    showToast(t("backupExported"), "success");
  } catch (err) {
    console.error(err);
    showToast(t("backupFailed"), "error");
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
    const summary = await importBackupFile(file);
    showToast(t("backupImported")(summary), "success");
    renderHome();
  } catch (err) {
    console.error(err);
    if (err.message === "restore_failed_rolled_back") {
      showToast(t("backupRestoreRolledBack"), "warning");
    } else if (err.message === "restore_failed_rollback_failed") {
      showToast(t("backupRestoreCritical"), "error");
    } else {
      showToast(t("backupImportFailed"), "error");
    }
    renderHome();
  }
});

// ---------- Data diagnostic (read-only) ----------
// Built so a report of "missing" notes/photos can be checked directly on
// the device that has them (no DevTools/Mac needed): reads straight from
// IndexedDB via the same getAllReports()/obsPhotos() the rest of the app
// uses, and only ever displays — never edits or deletes.
async function renderDataDiagnostic(keyword) {
  const kw = (keyword || "").trim();
  const allReports = await getAllReports();
  const matches = kw
    ? allReports.filter((r) => (r.location || "").includes(kw) || (r.title || "").includes(kw))
    : allReports;

  document.getElementById("diagnosticSummary").textContent = t("diagnosticSummary")(allReports.length, matches.length);

  const resultsEl = document.getElementById("diagnosticResults");
  const emptyEl = document.getElementById("noDiagnosticResults");
  resultsEl.innerHTML = "";

  if (matches.length === 0) {
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";

  matches.forEach((r) => {
    const card = document.createElement("div");
    card.className = "report-card field-section";

    const obsList = (r.observations || []).map((o, i) => {
      const photos = obsPhotos(o);
      const thumbs = photos.length
        ? `<div class="obs-thumb-grid">${photos.map((p) => `<img src="${URL.createObjectURL(p.blob)}" class="obs-thumb" alt="">`).join("")}</div>`
        : `<p class="muted">${t("diagnosticNoPhotos")}</p>`;
      return `
        <div class="diagnostic-obs-row">
          <p class="obs-text"><strong>${i + 1}.</strong> ${escapeHtml(o.text || t("diagnosticNoText"))}</p>
          ${thumbs}
        </div>
      `;
    }).join("");

    const draftNote = r.draft
      ? `<p class="diagnostic-draft-note">⚠️ ${t("diagnosticHasDraft")}: ${escapeHtml((r.draft.text || "").slice(0, 100))}</p>`
      : "";

    card.innerHTML = `
      <h4>${escapeHtml(r.title || "")}</h4>
      <p class="muted">${escapeHtml(r.location || "")} — ${escapeHtml(r.date || "")}</p>
      <p class="muted">${t("diagnosticObsCount")((r.observations || []).length)}</p>
      ${draftNote}
      ${obsList || `<p class="muted">${t("diagnosticNoObs")}</p>`}
    `;
    resultsEl.appendChild(card);
  });
}

// ---------- Cloud sign-in ----------
// Gates CLOUD SYNC only. The app itself never requires a login: every
// screen, every save, and all existing data stay fully usable offline
// whether signed in or not. If the Worker reports that auth isn't
// configured at all, the entry point stays hidden and nothing changes.
let cloudAuthState = { authenticated: false, configured: false };

async function refreshCloudAuthState() {
  try {
    const res = await fetch("/api/auth/session");
    const json = await res.json();
    if (json && json.success) cloudAuthState = json.data;
  } catch (e) {
    // Offline, or no cloud layer reachable -- leave the last known state
    // and stay silent. This must never interrupt normal offline use.
  }
  const btn = document.getElementById("cloudAuthBtn");
  if (!btn) return;
  if (!cloudAuthState.configured) {
    btn.style.display = "none";
    return;
  }
  btn.style.display = "";
  btn.textContent = cloudAuthState.authenticated ? t("btnCloudSignOut") : t("btnCloudSignIn");
}

document.getElementById("cloudAuthBtn").addEventListener("click", async () => {
  if (cloudAuthState.authenticated) {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      showToast(t("loggedOut"), "success");
    } catch (e) {
      showToast(t("loginNetworkError"), "error");
    }
    await refreshCloudAuthState();
    return;
  }
  document.getElementById("loginPassword").value = "";
  document.getElementById("loginError").style.display = "none";
  showScreen("screen-login");
});

document.getElementById("loginBackBtn").addEventListener("click", () => showScreen("screen-home"));

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("loginSubmitBtn");
  const errEl = document.getElementById("loginError");
  const password = document.getElementById("loginPassword").value;
  if (!password) return;

  btn.disabled = true;
  btn.textContent = t("loginSigningIn");
  errEl.style.display = "none";

  let message = null;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json && json.success) {
      // The session lives in an HttpOnly cookie set by the Worker --
      // deliberately nothing is stored in JS or localStorage here, so
      // there is no token for a future XSS to steal.
      document.getElementById("loginPassword").value = "";
      showToast(t("loginSuccess"), "success");
      await refreshCloudAuthState();
      showScreen("screen-home");
      // Anything queued while signed out syncs now, with no data moved
      // or lost in the meantime.
      if (typeof flushSyncQueue === "function") flushSyncQueue();
    } else if (res.status === 429) {
      message = t("loginTooMany");
    } else if (res.status === 401) {
      // Only a genuine credential rejection says "wrong password".
      message = t("loginBadPassword");
    } else {
      // Anything else is a SERVER-side problem, not a bad password:
      // 403 (origin rejected), 503 (secrets missing), 500, or a
      // Cloudflare-level failure such as the Worker exceeding its CPU
      // limit. Reporting all of these as "wrong password" sent the user
      // hunting for a typo that was never there, so surface the real
      // status and error code instead.
      const code = (json && json.error) || `HTTP ${res.status}`;
      message = t("loginServerError")(res.status, code);
    }
  } catch (netErr) {
    message = t("loginNetworkError");
  }

  if (message) {
    errEl.textContent = message;
    errEl.style.display = "block";
  }
  btn.disabled = false;
  btn.textContent = t("btnLogin");
});

document.getElementById("dataDiagnosticBtn").addEventListener("click", () => {
  document.getElementById("diagnosticSearchInput").value = "";
  renderDataDiagnostic("");
  showScreen("screen-data-diagnostic");
});
document.getElementById("diagnosticSearchInput").addEventListener("input", (e) => renderDataDiagnostic(e.target.value));
document.getElementById("diagnosticBackBtn").addEventListener("click", () => showScreen("screen-home"));

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
  // Cloud sync only, after the local save above already succeeded -- see
  // saveCurrentObservation()'s matching comment. A "quick visit" created
  // here never has a schoolId, so this is always a schoolless visit in
  // the D1 schema's own terms -- see enqueueVisitSync() for the other
  // creation path (starting a visit from an existing school).
  if (typeof enqueueEntitySync === "function") {
    enqueueEntitySync("visit", "create", report.id, {
      id: report.id,
      title: report.title,
      location: report.location,
      date: report.date
    });
  }
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

// ---------- Follow-up (متابعة الإصلاح) — fully optional per observation.
// Lives entirely on the report-card view (not the add/edit observation
// form), reading/writing activeReport.observations[i].followUp directly
// and persisting immediately — observations that never enable it keep
// `followUp` absent, which every reader below treats as "no follow-up".
function defaultFollowUp() {
  return { enabled: true, status: "in_progress", afterPhoto: null, verificationDate: null, verificationNote: "" };
}

function followUpStatusLabel(status) {
  if (status === "fixed") return t("followUpStatusFixed");
  if (status === "not_fixed") return t("followUpStatusNotFixed");
  return t("followUpStatusInProgress");
}

function followUpStatusClass(status) {
  if (status === "fixed") return "status-completed";
  if (status === "not_fixed") return "status-incomplete";
  return "status-progress";
}

function formatDateSlash(isoDateStr) {
  if (!isoDateStr) return "";
  const [y, m, d] = isoDateStr.split("-");
  return `${d}/${m}/${y}`;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function persistFollowUpChange() {
  await saveReport(activeReport);
  await renderReportScreen();
}

function renderFollowUpSection(obs, i) {
  const fu = obs.followUp;
  if (!fu || !fu.enabled) {
    return `<div class="followup-section">
      <button type="button" class="btn btn-text btn-inline followup-start" data-i="${i}">${t("followUpStart")}</button>
    </div>`;
  }

  const beforePhoto = obsPhotos(obs)[0];
  const beforeUrl = beforePhoto ? thumbUrl(beforePhoto.blob) : "";
  const afterUrl = fu.afterPhoto ? thumbUrl(fu.afterPhoto.blob) : "";
  const statusBadge = `<span class="status-badge ${followUpStatusClass(fu.status)}">${followUpStatusLabel(fu.status)}</span>`;

  const photosHtml = (beforeUrl || afterUrl)
    ? `<div class="followup-photos">
         ${beforeUrl ? `<div class="followup-photo-col"><span class="followup-photo-label">${t("followUpBefore")}</span><img src="${beforeUrl}" class="obs-thumb" alt=""></div>` : ""}
         ${afterUrl ? `<div class="followup-photo-col"><span class="followup-photo-label">${t("followUpAfter")}</span><img src="${afterUrl}" class="obs-thumb" alt=""></div>` : ""}
       </div>`
    : "";

  const addAfterBtn = !afterUrl
    ? `<button type="button" class="btn btn-secondary followup-add-after" data-i="${i}">${t("followUpAddAfterPhoto")}</button>`
    : "";

  const verifyButtons = afterUrl
    ? `<div class="card-actions followup-verify-actions">
         <button type="button" class="btn-primary followup-mark-fixed" data-i="${i}">${t("followUpMarkFixed")}</button>
         <button type="button" class="btn-secondary followup-mark-notfixed" data-i="${i}">${t("followUpMarkNotFixed")}</button>
       </div>`
    : "";

  const verificationDateHtml = fu.verificationDate
    ? `<p class="followup-verification-date">${t("followUpVerificationDateLabel")}: ${formatDateSlash(fu.verificationDate)}</p>`
    : "";

  return `
    <details class="followup-details" data-i="${i}" ${followUpOpenIndices.has(i) ? "open" : ""}>
      <summary class="followup-summary">🔄 ${t("followUpHeading")} ${statusBadge}</summary>
      <div class="followup-body">
        ${photosHtml}
        ${addAfterBtn}
        ${verifyButtons}
        ${verificationDateHtml}
        <textarea class="followup-note" data-i="${i}" placeholder="${t("followUpNotePlaceholder")}">${escapeHtml(fu.verificationNote || "")}</textarea>
      </div>
    </details>
  `;
}

function wireFollowUpEvents(listEl) {
  listEl.querySelectorAll(".followup-start").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const i = parseInt(btn.dataset.i, 10);
      activeReport.observations[i].followUp = defaultFollowUp();
      followUpOpenIndices.add(i);
      await persistFollowUpChange();
    });
  });
  // <details> open/closed state is re-derived from followUpOpenIndices on
  // every render (the card list is rebuilt via innerHTML), so keep that
  // set in sync with the user's own manual expand/collapse clicks.
  listEl.querySelectorAll(".followup-details").forEach((det) => {
    det.addEventListener("toggle", () => {
      const i = parseInt(det.dataset.i, 10);
      if (det.open) followUpOpenIndices.add(i);
      else followUpOpenIndices.delete(i);
    });
  });
  listEl.querySelectorAll(".followup-add-after").forEach((btn) => {
    btn.addEventListener("click", () => {
      followUpCaptureIndex = parseInt(btn.dataset.i, 10);
      document.getElementById("followUpPhotoInput").click();
    });
  });
  listEl.querySelectorAll(".followup-mark-fixed").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const i = parseInt(btn.dataset.i, 10);
      activeReport.observations[i].followUp.status = "fixed";
      activeReport.observations[i].followUp.verificationDate = todayIso();
      await persistFollowUpChange();
    });
  });
  listEl.querySelectorAll(".followup-mark-notfixed").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const i = parseInt(btn.dataset.i, 10);
      activeReport.observations[i].followUp.status = "not_fixed";
      activeReport.observations[i].followUp.verificationDate = todayIso();
      await persistFollowUpChange();
    });
  });
  // Saved on blur (not re-rendering the list) so typing a note doesn't
  // collapse the <details> panel or steal focus mid-sentence.
  listEl.querySelectorAll(".followup-note").forEach((textarea) => {
    textarea.addEventListener("change", async () => {
      const i = parseInt(textarea.dataset.i, 10);
      activeReport.observations[i].followUp.verificationNote = textarea.value;
      await saveReport(activeReport);
    });
  });
}

document.getElementById("followUpPhotoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || followUpCaptureIndex === null) return;
  try {
    const blob = await compressImage(file);
    activeReport.observations[followUpCaptureIndex].followUp.afterPhoto = { blob, takenAt: Date.now() };
    await saveReport(activeReport);
    showToast(t("followUpPhotoSaved"), "success");
    await renderReportScreen();
  } catch (err) {
    console.error(err);
    showToast(currentLang === "ar" ? "تعذر إضافة الصورة." : "Couldn't add the photo.", "error");
  }
  followUpCaptureIndex = null;
});

async function renderReportScreen() {
  document.getElementById("reportSummaryTitle").textContent = activeReport.title;
  document.getElementById("reportSummaryMeta").textContent = `${activeReport.location} — ${activeReport.date}`;

  await renderPreviousVisitNote();
  updatePendingAIButton();

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
      if (obs.category) card.style.setProperty("--cat", categoryColor(obs.category));
      const photos = obsPhotos(obs);
      const thumbsHtml = photos.length
        ? `<div class="obs-thumb-grid">${photos.map(p => `<img src="${URL.createObjectURL(p.blob)}" class="obs-thumb" alt="">`).join("")}</div>`
        : "";
      const repeatInfo = repeatedObservationInfo[i];
      const repeatBadge = repeatInfo
        ? `<span class="repeat-badge">${t("repeatedFrom")(repeatInfo)}</span>`
        : "";
      const aiBadges = obs.category || obs.pendingAI
        ? `<div class="ai-badges">
             ${obs.category ? `<span class="ai-badge ai-badge-category">${escapeHtml(obs.category)}</span>` : ""}
             ${obs.pendingAI ? `<span class="ai-badge ai-badge-pending">${t("pendingAIBadge")}</span>` : ""}
           </div>`
        : "";
      card.innerHTML = `
        <div class="obs-card-header">${i + 1}</div>
        ${repeatBadge}
        ${aiBadges}
        ${thumbsHtml}
        <p class="obs-spot">📍 ${escapeHtml(obs.spotLocation || "")}</p>
        <p class="obs-text">${escapeHtml(obs.text)}</p>
        ${obs.recommendedAction ? `<p class="obs-action"><strong>${t("aiActionLabel")}:</strong> ${escapeHtml(obs.recommendedAction)}</p>` : ""}
        <div class="card-actions">
          <button class="card-open obs-edit" data-i="${i}">${t("editBtn")}</button>
          <button class="card-delete obs-delete" data-i="${i}">${t("deleteBtn")}</button>
        </div>
        ${renderFollowUpSection(obs, i)}
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
          showToast(t("observationDeleted"), "success");
          await renderReportScreen();
        }
      });
    });
    wireFollowUpEvents(listEl);
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
  showToast(t("reportUpdated"), "success");
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
  document.getElementById("observationSpotLocation").value = "";
  document.getElementById("observationCategorySelect").value = "";
  document.getElementById("recordBtn").textContent = t("btnRecord");
  document.getElementById("cameraInput").value = "";
  document.getElementById("galleryInput").value = "";
}

// ---------- Draft auto-save ----------
// Protects in-progress text/photos/audio *before* "Save" is ever pressed
// (a refresh, closed tab, or crash mid-edit shouldn't lose it) by
// periodically snapshotting the open form into activeReport.draft and
// writing it through the same resilient path (persistReportResilient)
// already used for real observation saves — no new storage system, same
// report record, same retry/queue machinery.
let draftAutosaveTimer = null;

function applyObservationDataToForm({ text, spotLocation, category, photos, audioBlob }) {
  document.getElementById("observationText").value = text || "";
  document.getElementById("observationSpotLocation").value = spotLocation || "";
  document.getElementById("observationCategorySelect").value = category || "";
  stagedPhotos = [...(photos || [])];
  renderPhotosGrid();
  if (audioBlob) {
    stagedAudioBlob = audioBlob;
    showAudioPreview(audioBlob);
  }
}

function saveDraftNow() {
  if (!activeReport) return Promise.resolve(false);
  activeReport.draft = {
    editingIndex,
    text: document.getElementById("observationText").value,
    spotLocation: document.getElementById("observationSpotLocation").value,
    category: document.getElementById("observationCategorySelect").value,
    photos: stagedPhotos,
    audioBlob: stagedAudioBlob || null,
    updatedAt: Date.now()
  };
  // Returns the resilient write's promise (true/false) so callers that
  // need to know a specific save actually landed -- e.g. per-photo local
  // status -- can await it, while the debounced text-only autosave below
  // keeps firing it without waiting, exactly as before.
  return persistReportResilient(activeReport);
}

function scheduleDraftAutosave() {
  clearTimeout(draftAutosaveTimer);
  draftAutosaveTimer = setTimeout(saveDraftNow, 1200);
}

function clearDraft() {
  clearTimeout(draftAutosaveTimer);
  if (activeReport && activeReport.draft) {
    delete activeReport.draft;
    persistReportResilient(activeReport);
  }
}

["observationText", "observationSpotLocation"].forEach((id) => {
  document.getElementById(id).addEventListener("input", scheduleDraftAutosave);
});
document.getElementById("observationCategorySelect").addEventListener("change", scheduleDraftAutosave);

function openObservationEditor(index) {
  editingIndex = index;
  pendingNewObsIndex = null;
  isSavingObservation = false;
  setObservationSaveUI("idle");
  resetObservationForm();
  editingAIFields = {};

  const number = index !== null ? index + 1 : activeReport.observations.length + 1;
  document.getElementById("observationHeading").textContent =
    (currentLang === "ar" ? "الملاحظة رقم " : "Observation #") + number;

  const obs = index !== null ? activeReport.observations[index] : null;
  if (obs) {
    applyObservationDataToForm({
      text: obs.text,
      spotLocation: obs.spotLocation,
      category: obs.category,
      photos: obsPhotos(obs),
      audioBlob: obs.audioBlob
    });
    if (obs.category) {
      editingAIFields = {
        category: obs.category,
        recommendedAction: obs.recommendedAction
      };
    }
    if (obs.pendingAI) {
      editingAIFields.pendingAI = true;
    }
  }

  // A draft only ever exists for the single most-recently-open form, tagged
  // by which observation it belongs to (null = a new, not-yet-saved one) —
  // restoring it here means a refresh/crash mid-edit picks up right where
  // the user left off instead of losing the unsaved changes.
  const draft = activeReport.draft && activeReport.draft.editingIndex === index ? activeReport.draft : null;
  if (draft) {
    applyObservationDataToForm(draft);
    showToast(t("draftRestored"), "success");
  }

  showScreen("screen-observation");
}

document.getElementById("addObservationBtn").addEventListener("click", () => openObservationEditor(null));
document.getElementById("cancelObservationBtn").addEventListener("click", async () => {
  if (isRecording) {
    await recorder.stop();
    isRecording = false;
  }
  clearDraft(); // explicit discard -- the user chose to abandon this edit
  showScreen("screen-report");
});

// ---- Photos ----
// A photo with no localStatus at all (loaded from a saved observation, or
// restored from a draft already written to disk) is implicitly already
// saved -- only a photo just added in this session passes through
// "saving"/"retry" first (see handlePhotoInput/persistPhotosNow).
function photoStatusBadge(status) {
  if (status === "saving") return { cls: "saving", icon: "⏳", label: t("photoStatusSaving") };
  if (status === "retry") return { cls: "retry", icon: "⚠️", label: t("photoStatusRetry") };
  return { cls: "saved", icon: "✓", label: t("photoStatusSaved") };
}

function renderPhotosGrid() {
  const grid = document.getElementById("photosGrid");
  grid.innerHTML = "";
  stagedPhotos.forEach((photo, i) => {
    const item = document.createElement("div");
    item.className = "photo-thumb";
    const badge = photoStatusBadge(photo.localStatus);
    item.innerHTML = `
      <img src="${URL.createObjectURL(photo.blob)}" alt="">
      <span class="photo-thumb-status photo-thumb-status--${badge.cls}" title="${escapeHtml(badge.label)}">${badge.icon}</span>
      <button type="button" class="photo-thumb-more" data-i="${i}" aria-label="${t("moreActions")}">⋯</button>
      <button type="button" class="photo-thumb-remove" data-i="${i}" aria-label="${t("removePhoto")}">✕</button>
    `;
    grid.appendChild(item);
  });
  grid.querySelectorAll(".photo-thumb-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      stagedPhotos.splice(parseInt(btn.dataset.i, 10), 1);
      renderPhotosGrid();
      scheduleDraftAutosave();
    });
  });
  grid.querySelectorAll(".photo-thumb-more").forEach((btn) => {
    btn.addEventListener("click", () => openPhotoActionModal(parseInt(btn.dataset.i, 10)));
  });
}

document.getElementById("takePhotoBtn").addEventListener("click", () => document.getElementById("cameraInput").click());
document.getElementById("pickPhotoBtn").addEventListener("click", () => document.getElementById("galleryInput").click());

let replacingPhotoIndex = null;

// Retries a just-failed immediate photo save with exponential backoff
// (1s/2s/4s/8s/16s, 5 attempts) instead of silently leaving it at "retry"
// until the next unrelated save happens to sweep it up. The photo itself
// is never at risk either way -- it's still sitting in stagedPhotos in
// memory and gets included in the very next successful report save,
// whenever that happens -- this only makes the "محفوظ محليًا" status
// converge on its own instead of needing the user to notice and act.
function retryPhotoLocalSave(photoIds, attempt = 1) {
  const delay = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
  setTimeout(async () => {
    const stillStaged = photoIds.filter((id) => stagedPhotos.some((p) => p.id === id));
    if (!stillStaged.length) return; // removed or already superseded by a later save
    const ok = await saveDraftNow();
    stillStaged.forEach((id) => {
      const p = stagedPhotos.find((sp) => sp.id === id);
      if (p) p.localStatus = ok ? "saved" : "retry";
    });
    renderPhotosGrid();
    if (!ok && attempt < 5) retryPhotoLocalSave(stillStaged, attempt + 1);
  }, delay);
}

// Persists newly-added photos immediately (no debounce) -- unlike typed
// text, a photo can't be "retyped" if it's lost, so it gets the same
// resilient write (internal retries + queued fallback, see
// persistReportResilient) right away instead of waiting up to 1.2s for
// scheduleDraftAutosave(). This is only affordable because saveReport()
// now externalizes photo blobs into their own small records (storage.js)
// -- the write cost is proportional to the new photo(s), not to every
// photo already saved earlier in the visit.
async function persistPhotosNow(photoIds) {
  clearTimeout(draftAutosaveTimer); // this save supersedes any pending debounced one
  const ok = await saveDraftNow();
  photoIds.forEach((id) => {
    const p = stagedPhotos.find((sp) => sp.id === id);
    if (p) p.localStatus = ok ? "saved" : "retry";
  });
  renderPhotosGrid();
  if (!ok) retryPhotoLocalSave(photoIds);
}

async function handlePhotoInput(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const addedIds = [];
  try {
    if (replacingPhotoIndex !== null) {
      const blob = await compressImage(files[0]);
      // A fresh id, not the replaced photo's old one -- this is a
      // different image and needs its own cloud sync entry (see sync.js).
      const id = generateId();
      stagedPhotos[replacingPhotoIndex] = { id, blob, takenAt: Date.now(), localStatus: "saving" };
      addedIds.push(id);
      replacingPhotoIndex = null;
    } else {
      for (const file of files) {
        const blob = await compressImage(file);
        // Stable id, independent of array position -- same reasoning as
        // observation ids (see saveCurrentObservation), needed so sync.js
        // can track each photo's own cloud-upload status individually.
        const id = generateId();
        stagedPhotos.push({ id, blob, takenAt: Date.now(), localStatus: "saving" });
        addedIds.push(id);
      }
    }
    renderPhotosGrid(); // shows the photo immediately, "saving locally" badge
    persistPhotosNow(addedIds); // not awaited -- never blocks moving to the next photo
  } catch (err) {
    console.error(err);
    showToast(currentLang === "ar" ? "تعذر إضافة الصورة." : "Couldn't add the photo.", "error");
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
  scheduleDraftAutosave();
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
      showToast(t("micNeedsHttps"), "warning");
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
      showToast(t("micDenied"), "warning");
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
        showToast(t("noTranscript"), "warning");
      }
      scheduleDraftAutosave();
    }
  }
});

document.getElementById("deleteAudioBtn").addEventListener("click", () => {
  stagedAudioBlob = null;
  pendingTranscript = "";
  document.getElementById("audioPlaybackBox").style.display = "none";
  scheduleDraftAutosave();
});

document.getElementById("reRecordBtn").addEventListener("click", () => {
  stagedAudioBlob = null;
  document.getElementById("audioPlaybackBox").style.display = "none";
  document.getElementById("recordBtn").click();
});

document.getElementById("transcribeBtn").addEventListener("click", () => {
  if (!pendingTranscript) {
    showToast(t("noTranscript"), "warning");
    return;
  }
  const textarea = document.getElementById("observationText");
  if (textarea.value.trim() && !confirm(currentLang === "ar" ? "سيتم استبدال النص الحالي، متابعة؟" : "This will replace the current text. Continue?")) {
    return;
  }
  textarea.value = pendingTranscript;
});

// ---- Save observation ----
// ---------- Resilient observation saving ----------
// The UI only advances (toast + list re-render + navigate back to the
// report) *after* the IndexedDB write is confirmed. storage.js's
// saveReport() already retries a failed write 3x internally with backoff;
// this function awaits that real result instead of assuming it succeeded.
// If every internal retry is exhausted, the observation is NOT discarded:
// the form stays exactly as the user left it (no reset, no navigation),
// a clear error + a "retry" button are shown, and the report is queued so
// flushPendingSaves keeps retrying in the background even if the user
// navigates away without pressing retry.
const pendingSaveQueue = new Map(); // reportId -> report object awaiting a successful DB write

async function persistReportResilient(report) {
  try {
    await saveReport(report);
    pendingSaveQueue.delete(report.id);
    updatePendingSaveIndicator();
    return true;
  } catch (err) {
    console.error("Persist failed after internal retries, queued for background retry:", err);
    pendingSaveQueue.set(report.id, report);
    updatePendingSaveIndicator();
    return false;
  }
}

// Small, non-intrusive indicator: visible only while at least one write
// (report, monthly-photo submission, or scene status) is queued for a
// background retry. Every queue-mutating call site (success or failure)
// calls this so the badge appears/disappears immediately rather than
// waiting for the next 15s interval tick.
function updatePendingSaveIndicator() {
  const el = document.getElementById("pendingSaveIndicator");
  const count = pendingSaveQueue.size + pendingMonthlySaveQueue.size + pendingSceneSaveQueue.size;
  if (count > 0) {
    el.textContent = t("pendingSaveIndicator")(count);
    el.style.display = "flex";
  } else {
    el.style.display = "none";
  }
}

async function flushPendingSaves() {
  if (pendingSaveQueue.size > 0) {
    for (const [id, report] of Array.from(pendingSaveQueue.entries())) {
      await persistReportResilient(report);
    }
  }
  // monthly.js and scenes.js each define an analogous queue+flush pair
  // (monthly-photo submissions, scene-tracking status) and are both
  // loaded before this interval ever fires, so they're always defined by
  // the time this runs -- reuses this same interval/'online' trigger
  // instead of running extra background timers per feature.
  await flushPendingMonthlySaves();
  await flushPendingSceneSaves();
  updatePendingSaveIndicator();
}
setInterval(flushPendingSaves, 15000);
window.addEventListener("online", flushPendingSaves);

function setObservationSaveUI(state) {
  const saveBtn = document.getElementById("saveObservationBtn");
  const approveBtn = document.getElementById("aiApproveBtn");
  if (state === "saving") {
    saveBtn.disabled = true;
    if (approveBtn) approveBtn.disabled = true;
    saveBtn.textContent = t("savingObservation");
  } else if (state === "error") {
    saveBtn.disabled = false;
    if (approveBtn) approveBtn.disabled = false;
    saveBtn.textContent = t("btnRetrySaveObservation");
  } else {
    saveBtn.disabled = false;
    if (approveBtn) approveBtn.disabled = false;
    saveBtn.textContent = t("btnSaveObservation");
  }
}

async function saveCurrentObservation(extraFields) {
  if (isSavingObservation) return false; // a save is already in flight -- ignore extra clicks/retries

  const text = document.getElementById("observationText").value.trim();
  if (!text) {
    showToast(t("needText"), "warning");
    return false;
  }
  const spotLocation = document.getElementById("observationSpotLocation").value.trim();
  if (!spotLocation) {
    showToast(t("needSpotLocation"), "warning");
    return false;
  }

  const manualCategory = document.getElementById("observationCategorySelect").value;
  // A retry after a failed save reuses the same array slot instead of
  // pushing a new entry, so multiple clicks/retries never create
  // duplicate observations.
  const targetIndex = editingIndex !== null
    ? editingIndex
    : (pendingNewObsIndex !== null ? pendingNewObsIndex : activeReport.observations.length);
  const existingObs = activeReport.observations[targetIndex] || null;
  const isNewObservation = editingIndex === null;

  const obs = {
    // Stable id, independent of array position -- needed so cloud sync
    // (sync.js) can reference this exact observation reliably even if
    // other observations are added/removed/reordered later. Purely
    // additive: nothing existing reads or depends on this field.
    id: (existingObs && existingObs.id) || generateId(),
    text,
    spotLocation,
    photos: stagedPhotos,
    audioBlob: stagedAudioBlob || null,
    ...editingAIFields,
    category: manualCategory || editingAIFields.category || undefined,
    // Follow-up isn't edited from this form (it lives on the report
    // card) — carry it over untouched so re-saving an edited
    // observation never drops its follow-up data.
    ...(existingObs && existingObs.followUp ? { followUp: existingObs.followUp } : {}),
    ...(extraFields || {})
  };

  activeReport.observations[targetIndex] = obs;
  if (editingIndex === null) pendingNewObsIndex = targetIndex;

  isSavingObservation = true;
  setObservationSaveUI("saving");
  // The real observation now supersedes any in-progress draft for this
  // same slot -- clearing it here means the write below both saves the
  // observation and drops the now-redundant draft in one atomic call.
  if (activeReport.draft && activeReport.draft.editingIndex === editingIndex) {
    clearTimeout(draftAutosaveTimer);
    delete activeReport.draft;
  }

  try {
    // Awaits the real, confirmed write (storage.js already retries
    // transient failures internally) -- nothing below this line runs
    // until the save has actually succeeded.
    await saveReport(activeReport);
    pendingSaveQueue.delete(activeReport.id);
    pendingNewObsIndex = null;
    isSavingObservation = false;
    setObservationSaveUI("idle");

    // Cloud sync is queued only *after* the local write above already
    // succeeded. This never affects whether the save itself succeeds for
    // the user.
    if (isNewObservation && typeof enqueueEntitySync === "function") {
      // Only for a genuinely new observation -- an edit to an
      // already-synced one isn't wired up yet -- see sync.js.
      enqueueEntitySync("observation", "create", obs.id, {
        id: obs.id,
        visitId: activeReport.id,
        text: obs.text,
        spotLocation: obs.spotLocation,
        category: obs.category || undefined,
        recommendedAction: obs.recommendedAction || undefined,
        pendingAi: !!obs.pendingAI
      });
    }
    // Photos sync on every save, new or edited -- a photo added while
    // editing an already-synced observation still needs to reach R2.
    // enqueuePhotosForObservation itself skips any photo already tracked
    // (queued or synced), so this is safe to call on every save.
    if (typeof enqueuePhotosForObservation === "function") {
      enqueuePhotosForObservation(obs.id, obs.photos);
    }

    showToast(extraFields && extraFields.pendingAI ? t("offlineAnalyzeSaved") : t("observationSaved"), "success");
    await renderReportScreen();
    showScreen("screen-report");
    return true;
  } catch (err) {
    console.error("Failed to save observation after internal retries:", err);
    isSavingObservation = false;
    setObservationSaveUI("error");
    showToast(t("observationSaveFailed"), "error");
    // Keep retrying in the background too, in case the user navigates
    // away instead of pressing retry -- the typed text, photos, and
    // every other field are untouched either way (no reset, no navigate).
    pendingSaveQueue.set(activeReport.id, activeReport);
    updatePendingSaveIndicator();
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
    showToast(t("aiNeedInput"), "warning");
    return;
  }

  // Offline: don't attempt the network call at all — save immediately
  // with a pending flag so it can be analyzed later. AI never blocks saving.
  if (!navigator.onLine) {
    await saveCurrentObservation({ pendingAI: true });
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
      showToast(aiErrorMessage(errData), "error");
      return;
    }

    const result = await resp.json();
    openAIReviewScreen(result);
  } catch (err) {
    console.error(err);
    showToast(t("aiAnalyzeFailed"), "error");
  } finally {
    analyzingMsg.style.display = "none";
    btn.disabled = false;
  }
});

function openAIReviewScreen(result) {
  document.getElementById("aiCategorySelect").value = result.category || "أخرى";
  document.getElementById("aiDescriptionInput").value = result.description || "";
  document.getElementById("aiActionInput").value = result.recommendedAction || "";

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
    recommendedAction: document.getElementById("aiActionInput").value.trim(),
    pendingAI: false
  };
  await saveCurrentObservation(extraFields);
});

// ---------- Batch-analyze notes saved while offline ----------
function updatePendingAIButton() {
  const btn = document.getElementById("analyzePendingBtn");
  const hasPending = activeReport.observations.some((o) => o.pendingAI);
  btn.style.display = hasPending && navigator.onLine ? "block" : "none";
}

window.addEventListener("online", () => {
  if (activeReport) updatePendingAIButton();
});
window.addEventListener("offline", () => {
  if (activeReport) updatePendingAIButton();
});

document.getElementById("analyzePendingBtn").addEventListener("click", async () => {
  const btn = document.getElementById("analyzePendingBtn");
  btn.disabled = true;
  const originalLabel = btn.textContent;

  const pendingObs = activeReport.observations.filter((o) => o.pendingAI);
  let successCount = 0;

  for (let i = 0; i < pendingObs.length; i++) {
    const obs = pendingObs[i];
    btn.textContent = t("analyzingPendingProgress")(i + 1, pendingObs.length);
    try {
      const imageBase64 = obs.photos && obs.photos.length ? await blobToBase64Raw(obsPhotos(obs)[0].blob) : null;
      const resp = await fetch("/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: obs.text, imageBase64 })
      });
      if (resp.ok) {
        const result = await resp.json();
        obs.category = result.category;
        obs.recommendedAction = result.recommendedAction;
        obs.pendingAI = false;
        successCount++;
      }
    } catch (err) {
      console.error("Batch analyze failed for one observation, will retry later:", err);
    }
  }

  await saveReport(activeReport);
  btn.disabled = false;
  btn.textContent = originalLabel;
  showToast(t("analyzingPendingDone")(successCount, pendingObs.length), "success");
  await renderReportScreen();
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
        <h4>${currentLang === "ar" ? "الملاحظة رقم" : "Observation #"} ${i + 1}${obs.category ? ` · ${escapeHtml(obs.category)}` : ""}</h4>
        ${thumbsHtml}
        <p class="obs-spot">📍 ${escapeHtml(obs.spotLocation || "")}</p>
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
    showToast(t("noObservationsForPdf"), "warning");
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
    showToast(t("pdfSuccess"), "success");
  } catch (err) {
    console.error(err);
    showToast(t("pdfFailed"), "error");
  }
}

async function handleSharePdf() {
  if (!activeReport.observations.length) {
    showToast(t("noObservationsForPdf"), "warning");
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
    showToast(t("pdfFailed"), "error");
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
  document.getElementById("footerTextInput").value = s.footerText || defaultPhotoSettings().footerText;
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
    pdfImageType: document.getElementById("pdfImageOriginal").checked ? "original" : "documented",
    footerText: document.getElementById("footerTextInput").value.trim() || defaultPhotoSettings().footerText
  };
  await saveReport(activeReport);
  showToast(currentLang === "ar" ? "تم حفظ الإعدادات." : "Settings saved.", "success");
  showScreen("screen-report");
});

// ---------- Init ----------
applyLanguage("ar");

// Ask the Worker whether cloud auth is configured and whether this
// device already has a valid session. Fire-and-forget: if it fails
// (offline, no cloud layer), the app carries on exactly as before --
// this must never gate startup.
refreshCloudAuthState();

// ---------- PWA: register service worker for offline support ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
