// ---------------------------------------------------------------------
// storage.js
// IndexedDB is used (not localStorage) because observations contain
// photo and audio Blobs, which can be large and are stored natively
// by IndexedDB without the size bloat of base64-encoding into JSON.
// All functions here are async — every caller must use await.
// ---------------------------------------------------------------------

const DB_NAME = "safety_inspection_db";
const DB_VERSION = 2;
const STORE_NAME = "reports";
const MONTHLY_TEMPLATE_STORE = "monthly_templates";
const MONTHLY_SCHOOLS_STORE = "monthly_schools";
const MONTHLY_SUBMISSIONS_STORE = "monthly_submissions";

function openDB() {
  return new Promise((resolve, reject) => {
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function generateId() {
  return "r_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const reports = req.result || [];
      reports.sort((a, b) => b.createdAt - a.createdAt);
      resolve(reports);
    };
    req.onerror = () => reject(req.error);
  });
}

async function saveReport(report) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(report);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function getReportById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
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

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

async function exportBackupBlob() {
  const reports = await getAllReports();
  const out = [];
  for (const report of reports) {
    const obsOut = [];
    for (const obs of report.observations) {
      const photosOut = [];
      for (const p of obsPhotos(obs)) {
        photosOut.push({ dataUrl: await blobToDataUrl(p.blob), takenAt: p.takenAt || null });
      }
      const audioDataUrl = obs.audioBlob ? await blobToDataUrl(obs.audioBlob) : null;
      obsOut.push({ text: obs.text, photos: photosOut, audioDataUrl });
    }
    out.push({
      id: report.id,
      title: report.title,
      location: report.location,
      date: report.date,
      createdAt: report.createdAt,
      photoSettings: report.photoSettings || null,
      observations: obsOut
    });
  }
  const json = JSON.stringify({ exportedAt: Date.now(), reports: out });
  return new Blob([json], { type: "application/json" });
}

// Returns the number of reports imported.
async function importBackupFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  let count = 0;
  for (const r of data.reports || []) {
    const observations = [];
    for (const obs of r.observations || []) {
      const photos = [];
      for (const p of obs.photos || []) {
        photos.push({ blob: await dataUrlToBlob(p.dataUrl), takenAt: p.takenAt || null });
      }
      const audioBlob = obs.audioDataUrl ? await dataUrlToBlob(obs.audioDataUrl) : null;
      observations.push({ text: obs.text, photos, audioBlob });
    }
    const report = {
      id: r.id || generateId(),
      title: r.title || "",
      location: r.location || "",
      date: r.date || "",
      createdAt: r.createdAt || Date.now(),
      photoSettings: r.photoSettings || null,
      observations
    };
    await saveReport(report);
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------
// Generic single-store helpers, reused by all three monthly-photos stores.
// ---------------------------------------------------------------------

async function storeGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function storeGet(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function storePut(storeName, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function storeDelete(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------
// Monthly required-photos feature
// ---------------------------------------------------------------------

const DEFAULT_MONTHLY_SLOTS = ["واجهة المدرسة", "الملعب", "المطبخ", "دورات المياه", "غرفة الأمن"];

// Returns the shared checklist of required photo types (same for every school).
async function getMonthlySlots() {
  const record = await storeGet(MONTHLY_TEMPLATE_STORE, "template");
  if (record && record.slots && record.slots.length) return record.slots;
  return DEFAULT_MONTHLY_SLOTS.map((label, i) => ({ id: "slot_" + i, label }));
}

async function saveMonthlySlots(slots) {
  await storePut(MONTHLY_TEMPLATE_STORE, { id: "template", slots });
}

async function getAllMonthlySchools() {
  const schools = await storeGetAll(MONTHLY_SCHOOLS_STORE);
  return schools.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ar"));
}

async function addMonthlySchool(name) {
  const school = { id: generateId(), name, createdAt: Date.now() };
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
