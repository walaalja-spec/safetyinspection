// ---------------------------------------------------------------------
// pptx.js
// Generates a "التقرير المصور" PowerPoint by editing the REAL template
// (monthly-template.pptx) directly at the ZIP/media level — we never
// touch the slide's shape/position XML, only:
//   1) swap the bytes of specific ppt/media/imageN.jpeg files (same
//      filenames, same positions/sizes in the deck — nothing about the
//      layout, fonts, colors, or design changes), and
//   2) string-replace two known text runs (school name, date range).
// This is deliberately the safest possible approach for "don't touch
// the template's design" — the design literally never gets re-parsed
// or reconstructed, just two categories of raw bytes get replaced.
//
// Mapping was derived from directly inspecting the template's XML
// (positions, aspect ratios) — see the analysis report. Multiple slots
// can share the same category label (e.g. two "صورة الموقع العام"
// slots); they're assigned to the template's matching image files in
// the order they appear in the monthly slots list, which keeps this
// forward-compatible with a future multi-school export (each school's
// slot list is resolved independently, nothing here is global state).
// ---------------------------------------------------------------------

const PPTX_TEMPLATE_PATH = "/monthly-template.pptx";

// { category -> [ { media: "imageN.jpeg", ratio: width/height } ] } in the
// exact order slots of that category should be assigned. Keyed by the
// slot's stable `category` (see storage.js's DEFAULT_MONTHLY_SLOTS and
// getMonthlySlots()) — NOT by the user-editable display label, so
// renaming a slot's label in "إدارة قائمة الصور المطلوبة" never breaks
// which documented photo lands in which template frame.
//
// "لافتة المبنى" first, matching the checklist order.
const PPTX_IMAGE_MAP = {
  "لافتة المبنى": [
    { media: "image5.jpeg", ratio: 4752000 / 4278591 }
  ],
  "صورة الموقع العام": [
    { media: "image11.jpeg", ratio: 1650545 / 1183603 },
    { media: "image17.jpeg", ratio: 1742922 / 1241288 }
  ],
  "صورة المدرسة / المبنى": [
    { media: "image14.jpeg", ratio: 1691894 / 1138475 },
    { media: "image10.jpeg", ratio: 1657114 / 1166262 }
  ],
  "السطح": [
    { media: "image16.jpeg", ratio: 1579375 / 1282500 }
  ],
  "صور الممرات": [
    { media: "image13.jpeg", ratio: 1629664 / 1285731 }
  ],
  "صور الحمام / المطبخ": [
    { media: "image15.jpeg", ratio: 1629664 / 1291911 }
  ],
  "صور للفصول / المكاتب": [
    { media: "image18.jpeg", ratio: 1617859 / 1142742 },
    { media: "image9.jpeg", ratio: 1644851 / 1302632 },
    { media: "image12.jpeg", ratio: 1672033 / 1284619 }
  ],
  "الأمن والسلامة": [
    { media: "image8.jpeg", ratio: 1753843 / 1227993 },
    { media: "image7.jpeg", ratio: 1657114 / 1214850 },
    { media: "image6.jpeg", ratio: 1657114 / 1227993 },
    { media: "image1.jpeg", ratio: 1648105 / 1227993 }
  ]
};

// Exact original XML text this deck's school-name field is split
// across (3 runs — see analysis). We rewrite the first run to hold the
// entire new name and empty the other two, keeping every formatting
// tag byte-for-byte untouched.
const SCHOOL_NAME_SEARCH =
  '<a:t>( تحفيظ القرآن الكريم الابتدائية و المتوسطة </a:t></a:r>' +
  '<a:r><a:rPr lang="ar-SA" sz="1100" b="1" err="1"><a:solidFill><a:srgbClr val="177B91"/></a:solidFill>' +
  '<a:latin typeface="Tajawal"/><a:ea typeface="Tajawal"/><a:cs typeface="Tajawal"/><a:sym typeface="Tajawal"/></a:rPr>' +
  '<a:t>ببطحان</a:t></a:r>' +
  '<a:r><a:rPr lang="ar-SA" sz="1100" b="1"><a:solidFill><a:srgbClr val="177B91"/></a:solidFill>' +
  '<a:latin typeface="Tajawal"/><a:ea typeface="Tajawal"/><a:cs typeface="Tajawal"/><a:sym typeface="Tajawal"/></a:rPr>' +
  '<a:t>)</a:t>';

const DATE_SEARCH = " 2026/3/16 الى 2026/4/15";

// Exact original XML text for the report title's month name — single
// run, so this is a plain, safe string replacement (same font/size/
// color/position, only the word inside the parentheses changes).
const TITLE_SEARCH = "<a:t>تقرير مشهد الإنجاز الشهري (مارس)</a:t>";

const ARABIC_MONTH_NAMES = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"
];

function monthKeyToArabicName(monthKey) {
  const month = Number(monthKey.split("-")[1]); // 1-12
  return ARABIC_MONTH_NAMES[month - 1] || monthKey;
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The school-name shape is a fixed-width box (wrap="square" + spAutoFit
// — it wraps and grows TALLER for long text, it doesn't shrink to fit).
// Its neighbors sit at fixed Y positions with no reactive layout, so
// any wrap to a 2nd line visually collides with the shape above it.
//
// A pixel-precise fit check would need the real Tajawal font loaded,
// which isn't guaranteed (offline use, slow connections) — so instead
// we use a fixed, conservative character budget calibrated against the
// template's own original example text (~51 characters incl. parens,
// which fits on one line without collision) and truncate with an
// ellipsis beyond that. This never touches the box's size, position,
// or font — only the text length.
const SCHOOL_NAME_MAX_CHARS = 40;

function truncateSchoolNameToFit(name) {
  const trimmed = (name || "").trim();
  if (trimmed.length <= SCHOOL_NAME_MAX_CHARS) return `(${trimmed})`;
  return `(${trimmed.slice(0, SCHOOL_NAME_MAX_CHARS).trim()}…)`;
}

// For monthKey "YYYY-MM": the reporting period is the 16th of that
// month through the 15th of the following month (matches how this
// template's own example report was dated).
function monthKeyToReportRange(monthKey) {
  const [year, month] = monthKey.split("-").map(Number); // month: 1-12
  const start = new Date(year, month - 1, 16);
  const end = new Date(year, month, 15); // JS month index (month) = next month, 0-based
  return { start, end };
}

function sanitizeFileNamePart(str) {
  return (str || "").replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_").trim() || "report";
}

// Crops (never stretches) a source blob to exactly match targetRatio,
// returns a JPEG Blob at a fixed comfortable resolution — same
// cover-crop principle used elsewhere in this app for PDF photos.
//
// When `lines` is given (non-empty), also burns the same semi-transparent
// info bar photodoc.js's createDocumentedPhoto() already draws for the
// in-app "documented photo" preview — same style, just sized for this
// frame's own aspect ratio instead of always forcing a square, since the
// template's photo frames aren't square. This is what puts each photo's
// already-associated school name + date onto the photo itself in the
// exported PowerPoint; the original blob is never touched, only this
// generated copy.
function cropImageToRatio(sourceBlob, targetRatio, targetWidth = 1000, lines = [], isRtl = true) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = reject;
    img.onload = () => {
      const targetHeight = Math.round(targetWidth / targetRatio);
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");

      const srcRatio = img.width / img.height;
      let sx, sy, sw, sh;
      if (srcRatio > targetRatio) {
        sh = img.height;
        sw = sh * targetRatio;
        sx = (img.width - sw) / 2;
        sy = 0;
      } else {
        sw = img.width;
        sh = sw / targetRatio;
        sx = 0;
        sy = (img.height - sh) / 2;
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

      if (lines && lines.length) {
        const fontSize = Math.max(18, Math.round(targetWidth * 0.032));
        const lineGap = Math.round(fontSize * 0.5);
        const paddingY = Math.round(fontSize * 0.6);
        const barHeight = lines.length * (fontSize + lineGap) + paddingY * 2 - lineGap;
        const barY = targetHeight - barHeight;

        // No background fill at all — same fully-transparent, stroked-text
        // approach used for the in-app documented photos (photodoc.js),
        // for a consistent look across PDF/app/PPTX exports.
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.14));
        ctx.fillStyle = "#ffffff";
        ctx.direction = isRtl ? "rtl" : "ltr";
        ctx.textAlign = isRtl ? "right" : "left";
        ctx.font = `600 ${fontSize}px Geeza Pro, Cairo, Arial, sans-serif`;
        const paddingX = Math.round(targetWidth * 0.025);
        let ty = barY + paddingY + fontSize * 0.8;
        lines.forEach((line) => {
          const tx = isRtl ? targetWidth - paddingX : paddingX;
          ctx.strokeText(line, tx, ty);
          ctx.fillText(line, tx, ty);
          ty += fontSize + lineGap;
        });
      }

      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/jpeg", 0.88);
    };
    img.src = URL.createObjectURL(sourceBlob);
  });
}

// Builds { category -> [{slotId, entry}] } from the current slots list
// and submission, preserving slot order, only for slots that actually
// have a saved photo. Grouped by the slot's stable `category` (falling
// back to its label only if `category` is somehow missing) so a slot
// that's been renamed for display still resolves to the right template
// frame — see PPTX_IMAGE_MAP's comment for why this matters.
function groupFilledSlotsByLabel(slots, submission) {
  const byLabel = {};
  slots.forEach((slot) => {
    const entry = submission.photos && submission.photos[slot.id];
    if (!entry) return;
    const key = slot.category || slot.label;
    (byLabel[key] = byLabel[key] || []).push({ slotId: slot.id, entry });
  });
  return byLabel;
}

// Returns { total, done, missingLabels: [...] } for the pre-generation
// summary screen (Phase 6 of the spec) — counts every physical image
// slot the template actually has, not just distinct labels.
function computePptxCompleteness(slots, submission) {
  const byLabel = groupFilledSlotsByLabel(slots, submission);
  let total = 0;
  let done = 0;
  const missingLabels = [];
  for (const label of Object.keys(PPTX_IMAGE_MAP)) {
    const need = PPTX_IMAGE_MAP[label].length;
    const have = (byLabel[label] || []).length;
    total += need;
    done += Math.min(have, need);
    if (have < need) missingLabels.push(`${label} (${have}/${need})`);
  }
  return { total, done, missingLabels };
}

// Shared by both the single-school and multi-school paths — applies the
// same 3 text replacements (school name, date range, month in title) to
// a slide's XML string. Used verbatim by generateMonthlyPptx() so its
// single-school output is unaffected by this refactor.
function applySlideTextReplacements(slideXml, school, monthKey) {
  if (slideXml.includes(SCHOOL_NAME_SEARCH)) {
    const safeName = truncateSchoolNameToFit(school.name);
    const replacement = SCHOOL_NAME_SEARCH.replace(
      '<a:t>( تحفيظ القرآن الكريم الابتدائية و المتوسطة </a:t>',
      `<a:t>${xmlEscape(safeName)}</a:t>`
    )
      .replace("<a:t>ببطحان</a:t>", "<a:t></a:t>")
      .replace(/<a:t>\)<\/a:t>$/, "<a:t></a:t>");
    slideXml = slideXml.replace(SCHOOL_NAME_SEARCH, replacement);
  } else {
    console.warn("PPTX: school-name marker text not found — name not updated. Template may have changed.");
  }

  const { start, end } = monthKeyToReportRange(monthKey);
  const fmt = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  if (slideXml.includes(DATE_SEARCH)) {
    slideXml = slideXml.replace(DATE_SEARCH, ` ${fmt(start)} الى ${fmt(end)}`);
  } else {
    console.warn("PPTX: date marker text not found — date not updated. Template may have changed.");
  }

  if (slideXml.includes(TITLE_SEARCH)) {
    const monthName = monthKeyToArabicName(monthKey);
    slideXml = slideXml.replace(TITLE_SEARCH, `<a:t>تقرير مشهد الإنجاز الشهري (${xmlEscape(monthName)})</a:t>`);
  } else {
    console.warn("PPTX: title month marker text not found — title not updated. Template may have changed.");
  }

  return slideXml;
}

async function generateMonthlyPptx(school, monthKey) {
  const [slots, submission, templateResp] = await Promise.all([
    getMonthlySlots(),
    getMonthlySubmission(school.id, monthKey),
    fetch(PPTX_TEMPLATE_PATH)
  ]);
  if (!templateResp.ok) throw new Error("template_fetch_failed");
  const templateBuffer = await templateResp.arrayBuffer();

  const zip = await JSZip.loadAsync(templateBuffer);
  const byLabel = groupFilledSlotsByLabel(slots, submission);

  // Same school name + documentation date already shown on each photo's
  // "documented" preview in-app (see monthly.js's monthlyOverlayLines()),
  // reused as-is so the exported photos carry the same associated
  // metadata as the app already displays for them.
  // A school with documentation turned off (see monthly.js's per-school
  // toggle) gets no burned-in name/date overlay at all -- an empty
  // array here is exactly what cropImageToRatio() already treats as
  // "no overlay", so this needs no other change anywhere downstream.
  const overlayLines = school.documentPhotos === false ? [] : monthlyOverlayLines(school.name, submission.visitDate);
  const overlayIsRtl = currentLang === "ar";

  // 1) Swap photo bytes — only for slots that actually have a photo.
  //    Missing ones keep the template's original example photo, by design.
  for (const [label, targets] of Object.entries(PPTX_IMAGE_MAP)) {
    const filled = byLabel[label] || [];
    for (let i = 0; i < targets.length; i++) {
      const filledEntry = filled[i];
      if (!filledEntry) continue; // leave this specific frame's original photo untouched
      const target = targets[i];
      const cropped = await cropImageToRatio(filledEntry.entry.blob, target.ratio, 1000, overlayLines, overlayIsRtl);
      const arrayBuf = await cropped.arrayBuffer();
      zip.file(`ppt/media/${target.media}`, arrayBuf);
    }
  }

  // 2) Replace the two text fields, in the slide XML.
  const slidePath = "ppt/slides/slide1.xml";
  let slideXml = await zip.file(slidePath).async("string");
  slideXml = await applySlideTextReplacements(slideXml, school, monthKey);
  zip.file(slidePath, slideXml);

  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });

  const monthLabel = monthKey; // "YYYY-MM" — kept simple/unambiguous in the filename
  const fileName = `التقرير المصور - ${sanitizeFileNamePart(school.name)} - ${monthLabel}.pptx`;
  return { blob, fileName };
}

// ---------------------------------------------------------------------
// Multi-school export — combines several schools' single-slide reports
// into one .pptx, one slide per school, same template/design for each.
//
// This does NOT touch generateMonthlyPptx() above or call it internally
// for the multi-school path (except the explicit 1-school passthrough
// below) — it duplicates the template's slide part at the ZIP/XML level
// (new slideN.xml + slideN.xml.rels + registrations in
// [Content_Types].xml, presentation.xml, and presentation.xml.rels),
// reusing the same per-school helpers (applySlideTextReplacements,
// cropImageToRatio, PPTX_IMAGE_MAP) as the single-school path so both
// stay visually identical per-school.
// ---------------------------------------------------------------------

// Replaces one specific media Target (by filename) inside a slide rels
// XML string. Each image filename appears as exactly one Target value
// in the template's rels file, so this is a safe, unique match.
function repointRelsTarget(relsXml, mediaFileName, newTarget) {
  const search = `Target="../media/${mediaFileName}"`;
  const replacement = `Target="${newTarget}"`;
  if (!relsXml.includes(search)) {
    console.warn(`PPTX: relationship target for ${mediaFileName} not found — leaving unchanged.`);
    return relsXml;
  }
  return relsXml.replace(search, replacement);
}

// Every duplicated slide needs its OWN notes-slide part — the template's
// notesSlide1.xml.rels contains a back-reference to its parent slide
// (Target="../slides/slide1.xml"), so sharing one notes part across
// multiple slides leaves that back-reference ambiguous. Cheap to just
// duplicate (notes content itself isn't school-specific).
async function duplicateNotesSlideForSlide(zip, originalNotesXml, originalNotesRelsXml, slideNum) {
  const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
  const notesRelsPath = `ppt/notesSlides/_rels/notesSlide${slideNum}.xml.rels`;
  const newNotesRels = originalNotesRelsXml.replace(
    'Target="../slides/slide1.xml"',
    `Target="../slides/slide${slideNum}.xml"`
  );
  zip.file(notesPath, originalNotesXml);
  zip.file(notesRelsPath, newNotesRels);
  return `../notesSlides/notesSlide${slideNum}.xml`;
}

async function generateMultiSchoolPptx(schools, monthKey) {
  if (!Array.isArray(schools) || schools.length === 0) throw new Error("no_schools_selected");
  if (schools.length === 1) return generateMonthlyPptx(schools[0], monthKey); // identical single-school path

  const [slots, templateResp] = await Promise.all([getMonthlySlots(), fetch(PPTX_TEMPLATE_PATH)]);
  if (!templateResp.ok) throw new Error("template_fetch_failed");
  const templateBuffer = await templateResp.arrayBuffer();
  const zip = await JSZip.loadAsync(templateBuffer);

  const originalSlideXml = await zip.file("ppt/slides/slide1.xml").async("string");
  const originalSlideRelsXml = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
  const originalNotesXml = await zip.file("ppt/notesSlides/notesSlide1.xml").async("string");
  const originalNotesRelsXml = await zip.file("ppt/notesSlides/_rels/notesSlide1.xml.rels").async("string");

  let contentTypesXml = await zip.file("[Content_Types].xml").async("string");
  let presRelsXml = await zip.file("ppt/_rels/presentation.xml.rels").async("string");
  let presXml = await zip.file("ppt/presentation.xml").async("string");

  // Next free relationship id in presentation.xml.rels (rIdN, N numeric).
  let nextRidNum = Math.max(...Array.from(presRelsXml.matchAll(/Id="rId(\d+)"/g), (m) => Number(m[1]))) + 1;
  // Next free <p:sldId id="..."> value in the slide list.
  let nextSldId = Math.max(...Array.from(presXml.matchAll(/<p:sldId id="(\d+)"/g), (m) => Number(m[1]))) + 1;

  const sldIdAdditions = [];
  const finalSlideRels = []; // collected to compute which original media ends up truly unreferenced

  for (let i = 0; i < schools.length; i++) {
    const school = schools[i];
    const submission = await getMonthlySubmission(school.id, monthKey);
    const byLabel = groupFilledSlotsByLabel(slots, submission);
    const overlayLines = school.documentPhotos === false ? [] : monthlyOverlayLines(school.name, submission.visitDate);
    const overlayIsRtl = currentLang === "ar";

    let slideXml = await applySlideTextReplacements(originalSlideXml, school, monthKey);
    let slideRelsXml = originalSlideRelsXml;

    // Photos: only slots THIS school actually filled get a new,
    // school-specific media file; everything else keeps pointing at
    // the one shared original template image — never another school's.
    for (const [label, targets] of Object.entries(PPTX_IMAGE_MAP)) {
      const filled = byLabel[label] || [];
      for (let t = 0; t < targets.length; t++) {
        const filledEntry = filled[t];
        if (!filledEntry) continue;
        const target = targets[t];
        const cropped = await cropImageToRatio(filledEntry.entry.blob, target.ratio, 1000, overlayLines, overlayIsRtl);
        const arrayBuf = await cropped.arrayBuffer();
        const newMediaPath = `ppt/media/s${i}_${target.media}`;
        zip.file(newMediaPath, arrayBuf);
        slideRelsXml = repointRelsTarget(slideRelsXml, target.media, `../media/s${i}_${target.media}`);
      }
    }

    if (i === 0) {
      // First school reuses slide1.xml in place — exactly the same
      // part the single-school path writes to. Its notes slide (and
      // notes-slide back-reference) already correctly point to slide1.
      zip.file("ppt/slides/slide1.xml", slideXml);
      zip.file("ppt/slides/_rels/slide1.xml.rels", slideRelsXml);
    } else {
      const slideNum = i + 1;

      // Give this slide its own notes-slide part (see function doc)
      // and repoint its own notes-slide relationship to it.
      const newNotesTarget = await duplicateNotesSlideForSlide(zip, originalNotesXml, originalNotesRelsXml, slideNum);
      slideRelsXml = slideRelsXml.replace('Target="../notesSlides/notesSlide1.xml"', `Target="${newNotesTarget}"`);
      contentTypesXml = contentTypesXml.replace(
        "</Types>",
        `<Override PartName="/ppt/notesSlides/notesSlide${slideNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>`
      );

      zip.file(`ppt/slides/slide${slideNum}.xml`, slideXml);
      zip.file(`ppt/slides/_rels/slide${slideNum}.xml.rels`, slideRelsXml);

      contentTypesXml = contentTypesXml.replace(
        "</Types>",
        `<Override PartName="/ppt/slides/slide${slideNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`
      );

      const rid = `rId${nextRidNum++}`;
      presRelsXml = presRelsXml.replace(
        "</Relationships>",
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${slideNum}.xml"/></Relationships>`
      );

      sldIdAdditions.push(`<p:sldId id="${nextSldId++}" r:id="${rid}"/>`);
    }

    finalSlideRels.push(slideRelsXml);
  }

  presXml = presXml.replace("</p:sldIdLst>", sldIdAdditions.join("") + "</p:sldIdLst>");

  zip.file("[Content_Types].xml", contentTypesXml);
  zip.file("ppt/_rels/presentation.xml.rels", presRelsXml);
  zip.file("ppt/presentation.xml", presXml);

  // Clean up: any of the 15 original template photos that ended up
  // replaced on EVERY slide that could reference it is now genuinely
  // unreferenced dead weight in the package — remove it (this is what
  // the validator flags as "Unreferenced file").
  const allMediaFiles = Object.values(PPTX_IMAGE_MAP).flat().map((t) => t.media);
  for (const mediaFile of allMediaFiles) {
    const stillReferenced = finalSlideRels.some((rels) => rels.includes(`Target="../media/${mediaFile}"`));
    if (!stillReferenced) {
      zip.remove(`ppt/media/${mediaFile}`);
    }
  }

  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });

  const monthName = monthKeyToArabicName(monthKey);
  const fileName = `التقرير المصور للصيانة - ${monthName} ${monthKey.split("-")[0]} - جميع المدارس.pptx`;
  return { blob, fileName };
}

// ---------------------------------------------------------------------
// Master (all-schools, pre-built) template export.
//
// Unlike generateMultiSchoolPptx() above (which duplicates ONE slide N
// times), this uses a real 38-slide deck where every slide already
// belongs to a specific school (master-template.pptx). Generation here
// never duplicates or renumbers slides — it only:
//   1) reads which school each of the 38 slides already shows (by its
//      existing name text), matched against the app's own school list,
//   2) for a matched school's filled slots, overwrites that SLIDE'S OWN
//      media file bytes (never another slide's — see MASTER_SLOT_MAP),
//   3) rewrites the shared month/date text run (identical across all
//      38 slides), and
//   4) leaves everything else — position, size, rotation, crop, the 3
//      shared logos, unmatched slides, unfilled slots — byte-for-byte
//      untouched.
// generateMonthlyPptx()/generateMultiSchoolPptx() above are unchanged
// and still used for the single-school export.
// ---------------------------------------------------------------------

const MASTER_TEMPLATE_PATH = "/master-template.pptx";
const MASTER_TEMPLATE_SLIDE_COUNT = 38;

// Per-slide photo-slot map, derived directly from inspecting
// master-template.pptx (see the structural analysis report). Keyed by
// slide number — for THIS file, raw ppt/slides/slideN.xml numbering
// already matches the deck's true display order (verified against
// presentation.xml's <p:sldIdLst>), so "slide N" below is safe to use
// directly as the zip path "ppt/slides/slideN.xml". If this asset is
// ever replaced with a differently-exported file, that assumption must
// be re-verified before reusing this map.
//
// Each slot: c = category (matches storage.js's slot `category`, so a
// user-renamed slot label still resolves correctly — see
// PPTX_IMAGE_MAP's comment above for why), m = this SLIDE'S OWN media
// filename (never shared with another slide's content photos — only
// the 3 header logos are intentionally shared, and they never appear
// in this map), r = target crop ratio (width/height of the slot's own
// box, so cropImageToRatio() fills it correctly even where rot=90),
// rot = the slot's existing rotation (informational only — rotation
// lives in the slide XML itself, which this code never touches, so a
// slot's rotation is always preserved automatically by construction).
//
// Slides 26 and 29 each contain one extra, genuinely unlabeled photo in
// the original template (confirmed by direct inspection — not a
// matching artifact) — recorded here as `extra` and deliberately
// EXCLUDED from `slots`, so it is never treated as an available slot.
// Slides 11/23/34/35/36/37 legitimately have only 13 slots (3 "الأمن
// والسلامة" instead of 4) — also a real template variation, not an
// omission.
const MASTER_SLOT_MAP = {
  1: {slots:[{c:"صورة الموقع العام",m:"image9.jpeg",r:1.2627,rot:0.0},{c:"صورة الموقع العام",m:"image12.jpeg",r:1.3016,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image14.jpeg",r:1.4861,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image15.jpeg",r:1.2614,rot:0.0},{c:"السطح",m:"image16.jpeg",r:1.2315,rot:0.0},{c:"صور الممرات",m:"image13.jpeg",r:1.2737,rot:0.0},{c:"صور الحمام / المطبخ",m:"image10.jpeg",r:1.4661,rot:0.0},{c:"صور للفصول / المكاتب",m:"image18.jpeg",r:1.4258,rot:0.0},{c:"صور للفصول / المكاتب",m:"image11.jpeg",r:1.425,rot:0.0},{c:"صور للفصول / المكاتب",m:"image17.jpeg",r:1.4249,rot:0.0},{c:"الأمن والسلامة",m:"image8.jpeg",r:1.4315,rot:0.0},{c:"الأمن والسلامة",m:"image7.jpeg",r:1.3575,rot:0.0},{c:"الأمن والسلامة",m:"image6.jpeg",r:1.3369,rot:0.0},{c:"الأمن والسلامة",m:"image1.jpeg",r:1.3438,rot:0.0}]},
  2: {slots:[{c:"صورة الموقع العام",m:"image21.jpeg",r:1.3233,rot:0.0},{c:"صورة الموقع العام",m:"image24.jpeg",r:1.3669,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image27.jpeg",r:1.4516,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image26.jpeg",r:1.3268,rot:0.0},{c:"السطح",m:"image20.jpeg",r:1.3054,rot:0.0},{c:"صور الممرات",m:"image29.jpeg",r:1.3621,rot:0.0},{c:"صور الحمام / المطبخ",m:"image23.jpeg",r:1.3281,rot:0.0},{c:"صور للفصول / المكاتب",m:"image28.jpeg",r:1.3072,rot:0.0},{c:"صور للفصول / المكاتب",m:"image25.jpeg",r:1.3905,rot:0.0},{c:"صور للفصول / المكاتب",m:"image22.jpeg",r:1.3077,rot:0.0},{c:"الأمن والسلامة",m:"image32.jpeg",r:1.3312,rot:0.0},{c:"الأمن والسلامة",m:"image30.jpeg",r:1.3312,rot:0.0},{c:"الأمن والسلامة",m:"image33.jpeg",r:1.3333,rot:0.0},{c:"الأمن والسلامة",m:"image31.jpeg",r:1.3393,rot:0.0}]},
  3: {slots:[{c:"صورة الموقع العام",m:"image45.jpeg",r:1.2691,rot:0.0},{c:"صورة الموقع العام",m:"image40.jpeg",r:1.3421,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image41.jpeg",r:1.2649,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image43.jpeg",r:1.4547,rot:0.0},{c:"السطح",m:"image46.jpeg",r:1.3126,rot:0.0},{c:"صور الممرات",m:"image44.jpeg",r:1.5219,rot:0.0},{c:"صور الحمام / المطبخ",m:"image42.jpeg",r:1.3012,rot:0.0},{c:"صور للفصول / المكاتب",m:"image47.jpeg",r:1.409,rot:0.0},{c:"صور للفصول / المكاتب",m:"image48.jpeg",r:1.3944,rot:0.0},{c:"صور للفصول / المكاتب",m:"image39.jpeg",r:1.3211,rot:0.0},{c:"الأمن والسلامة",m:"image36.jpeg",r:1.3261,rot:0.0},{c:"الأمن والسلامة",m:"image34.jpeg",r:1.3065,rot:0.0},{c:"الأمن والسلامة",m:"image38.jpeg",r:1.3333,rot:0.0},{c:"الأمن والسلامة",m:"image35.jpeg",r:1.2985,rot:0.0}]},
  4: {slots:[{c:"صورة الموقع العام",m:"image55.jpeg",r:1.3164,rot:0.0},{c:"صورة الموقع العام",m:"image58.jpeg",r:1.3483,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image61.jpeg",r:1.3022,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image62.jpeg",r:1.3765,rot:0.0},{c:"السطح",m:"image57.jpeg",r:1.2197,rot:0.0},{c:"صور الممرات",m:"image54.jpeg",r:1.4478,rot:0.0},{c:"صور الحمام / المطبخ",m:"image60.jpeg",r:1.402,rot:0.0},{c:"صور للفصول / المكاتب",m:"image59.jpeg",r:1.3964,rot:0.0},{c:"صور للفصول / المكاتب",m:"image63.jpeg",r:1.4218,rot:0.0},{c:"صور للفصول / المكاتب",m:"image56.jpeg",r:1.4218,rot:0.0},{c:"الأمن والسلامة",m:"image53.jpeg",r:1.3333,rot:0.0},{c:"الأمن والسلامة",m:"image51.jpeg",r:1.3115,rot:0.0},{c:"الأمن والسلامة",m:"image50.jpeg",r:1.3193,rot:0.0},{c:"الأمن والسلامة",m:"image49.jpeg",r:1.3276,rot:0.0}]},
  5: {slots:[{c:"صورة الموقع العام",m:"image72.jpeg",r:1.3467,rot:0.0},{c:"صورة الموقع العام",m:"image76.jpeg",r:1.3962,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image74.jpeg",r:1.4076,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image78.jpeg",r:1.3216,rot:0.0},{c:"السطح",m:"image75.jpeg",r:1.3976,rot:0.0},{c:"صور الممرات",m:"image69.jpeg",r:1.3284,rot:0.0},{c:"صور الحمام / المطبخ",m:"image73.jpeg",r:1.3823,rot:0.0},{c:"صور للفصول / المكاتب",m:"image70.jpeg",r:1.2639,rot:0.0},{c:"صور للفصول / المكاتب",m:"image77.jpeg",r:1.3408,rot:0.0},{c:"صور للفصول / المكاتب",m:"image71.jpeg",r:1.3677,rot:0.0},{c:"الأمن والسلامة",m:"image66.jpeg",r:1.2327,rot:0.0},{c:"الأمن والسلامة",m:"image68.jpeg",r:1.2739,rot:0.0},{c:"الأمن والسلامة",m:"image67.jpeg",r:1.3014,rot:0.0},{c:"الأمن والسلامة",m:"image65.jpeg",r:1.2606,rot:0.0}]},
  6: {slots:[{c:"صورة الموقع العام",m:"image84.jpeg",r:1.4144,rot:0.0},{c:"صورة الموقع العام",m:"image94.jpeg",r:1.3425,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image92.jpeg",r:1.3563,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image86.jpeg",r:1.4299,rot:0.0},{c:"السطح",m:"image87.jpeg",r:1.4328,rot:0.0},{c:"صور الممرات",m:"image91.jpeg",r:1.4259,rot:0.0},{c:"صور الحمام / المطبخ",m:"image85.jpeg",r:1.3565,rot:0.0},{c:"صور للفصول / المكاتب",m:"image93.jpeg",r:1.3111,rot:0.0},{c:"صور للفصول / المكاتب",m:"image90.jpeg",r:1.354,rot:0.0},{c:"صور للفصول / المكاتب",m:"image88.jpeg",r:1.3988,rot:0.0},{c:"الأمن والسلامة",m:"image83.jpeg",r:1.3985,rot:0.0},{c:"الأمن والسلامة",m:"image82.jpeg",r:1.2906,rot:0.0},{c:"الأمن والسلامة",m:"image80.jpeg",r:1.2415,rot:0.0},{c:"الأمن والسلامة",m:"image79.jpeg",r:1.3163,rot:0.0}]},
  7: {slots:[{c:"صورة الموقع العام",m:"image110.jpeg",r:1.232,rot:0.0},{c:"صورة الموقع العام",m:"image109.jpeg",r:1.2548,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image104.jpeg",r:1.2609,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image105.jpeg",r:1.215,rot:0.0},{c:"السطح",m:"image108.jpeg",r:1.2358,rot:0.0},{c:"صور الممرات",m:"image102.jpeg",r:1.3761,rot:0.0},{c:"صور الحمام / المطبخ",m:"image100.jpeg",r:1.3749,rot:0.0},{c:"صور للفصول / المكاتب",m:"image111.jpeg",r:1.3312,rot:0.0},{c:"صور للفصول / المكاتب",m:"image112.jpeg",r:1.3533,rot:0.0},{c:"صور للفصول / المكاتب",m:"image106.jpeg",r:1.3871,rot:0.0},{c:"الأمن والسلامة",m:"image99.jpeg",r:1.2954,rot:0.0},{c:"الأمن والسلامة",m:"image98.jpeg",r:1.2481,rot:0.0},{c:"الأمن والسلامة",m:"image97.jpeg",r:1.3151,rot:0.0},{c:"الأمن والسلامة",m:"image96.jpeg",r:1.3024,rot:0.0}]},
  8: {slots:[{c:"صورة الموقع العام",m:"image119.jpeg",r:1.4195,rot:0.0},{c:"صورة الموقع العام",m:"image122.jpeg",r:1.3904,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image126.jpeg",r:1.3349,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image114.jpeg",r:1.5106,rot:0.0},{c:"السطح",m:"image125.jpeg",r:1.3174,rot:0.0},{c:"صور الممرات",m:"image127.jpeg",r:1.4532,rot:0.0},{c:"صور الحمام / المطبخ",m:"image121.jpeg",r:1.4123,rot:0.0},{c:"صور للفصول / المكاتب",m:"image124.jpeg",r:1.4161,rot:0.0},{c:"صور للفصول / المكاتب",m:"image115.jpeg",r:1.4895,rot:0.0},{c:"صور للفصول / المكاتب",m:"image118.jpeg",r:1.3389,rot:0.0},{c:"الأمن والسلامة",m:"image117.jpeg",r:1.3476,rot:0.0},{c:"الأمن والسلامة",m:"image116.jpeg",r:1.3709,rot:0.0},{c:"الأمن والسلامة",m:"image123.jpeg",r:1.3621,rot:0.0},{c:"الأمن والسلامة",m:"image120.jpeg",r:1.3595,rot:0.0}]},
  9: {slots:[{c:"صورة الموقع العام",m:"image134.jpeg",r:1.3455,rot:0.0},{c:"صورة الموقع العام",m:"image141.jpeg",r:1.2193,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image140.jpeg",r:1.2057,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image136.jpeg",r:1.3614,rot:0.0},{c:"السطح",m:"image135.jpeg",r:1.3569,rot:0.0},{c:"صور الممرات",m:"image138.jpeg",r:1.3442,rot:0.0},{c:"صور الحمام / المطبخ",m:"image133.jpeg",r:1.2257,rot:0.0},{c:"صور للفصول / المكاتب",m:"image142.jpeg",r:1.2145,rot:0.0},{c:"صور للفصول / المكاتب",m:"image139.jpeg",r:1.252,rot:0.0},{c:"صور للفصول / المكاتب",m:"image137.jpeg",r:1.3055,rot:0.0},{c:"الأمن والسلامة",m:"image132.jpeg",r:1.312,rot:0.0},{c:"الأمن والسلامة",m:"image128.jpeg",r:1.2618,rot:0.0},{c:"الأمن والسلامة",m:"image129.jpeg",r:1.2694,rot:0.0},{c:"الأمن والسلامة",m:"image130.jpeg",r:1.2725,rot:0.0}]},
  10: {slots:[{c:"صورة الموقع العام",m:"image149.jpeg",r:1.2835,rot:0.0},{c:"صورة الموقع العام",m:"image156.jpeg",r:1.1979,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image155.jpeg",r:1.1772,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image157.jpeg",r:1.2407,rot:0.0},{c:"السطح",m:"image148.jpeg",r:1.163,rot:0.0},{c:"صور الممرات",m:"image153.jpeg",r:1.2759,rot:0.0},{c:"صور الحمام / المطبخ",m:"image151.jpeg",r:1.2885,rot:0.0},{c:"صور للفصول / المكاتب",m:"image150.jpeg",r:1.274,rot:0.0},{c:"صور للفصول / المكاتب",m:"image154.jpeg",r:1.2914,rot:0.0},{c:"صور للفصول / المكاتب",m:"image152.jpeg",r:1.2654,rot:0.0},{c:"الأمن والسلامة",m:"image146.jpeg",r:1.2817,rot:0.0},{c:"الأمن والسلامة",m:"image143.jpeg",r:1.2813,rot:0.0},{c:"الأمن والسلامة",m:"image144.jpeg",r:1.3061,rot:0.0},{c:"الأمن والسلامة",m:"image145.jpeg",r:1.2967,rot:0.0}]},
  11: {slots:[{c:"صورة الموقع العام",m:"image162.jpeg",r:1.3826,rot:0.0},{c:"صورة الموقع العام",m:"image169.jpeg",r:1.4002,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image167.jpeg",r:1.4124,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image168.jpeg",r:1.3356,rot:0.0},{c:"السطح",m:"image171.jpeg",r:1.4004,rot:0.0},{c:"صور الممرات",m:"image163.jpeg",r:1.3387,rot:0.0},{c:"صور الحمام / المطبخ",m:"image166.jpeg",r:1.3199,rot:0.0},{c:"صور للفصول / المكاتب",m:"image164.jpeg",r:1.408,rot:0.0},{c:"صور للفصول / المكاتب",m:"image170.jpeg",r:1.3371,rot:0.0},{c:"صور للفصول / المكاتب",m:"image165.jpeg",r:1.3812,rot:0.0},{c:"الأمن والسلامة",m:"image161.jpeg",r:1.4316,rot:0.0},{c:"الأمن والسلامة",m:"image160.jpeg",r:1.4296,rot:0.0},{c:"الأمن والسلامة",m:"image158.jpeg",r:1.5536,rot:0.0}]},
  12: {slots:[{c:"صورة الموقع العام",m:"image179.jpeg",r:1.3422,rot:0.0},{c:"صورة الموقع العام",m:"image184.jpeg",r:1.4196,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image186.jpeg",r:1.2256,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image181.jpeg",r:1.4105,rot:0.0},{c:"السطح",m:"image177.jpeg",r:1.2273,rot:0.0},{c:"صور الممرات",m:"image182.jpeg",r:1.396,rot:0.0},{c:"صور الحمام / المطبخ",m:"image185.jpeg",r:1.3514,rot:0.0},{c:"صور للفصول / المكاتب",m:"image178.jpeg",r:1.3907,rot:0.0},{c:"صور للفصول / المكاتب",m:"image183.jpeg",r:1.3252,rot:0.0},{c:"صور للفصول / المكاتب",m:"image180.jpeg",r:1.2648,rot:0.0},{c:"الأمن والسلامة",m:"image174.jpeg",r:1.2464,rot:0.0},{c:"الأمن والسلامة",m:"image173.jpeg",r:1.1849,rot:0.0},{c:"الأمن والسلامة",m:"image175.jpeg",r:1.2581,rot:0.0},{c:"الأمن والسلامة",m:"image172.jpeg",r:1.3201,rot:0.0}]},
  13: {slots:[{c:"صورة الموقع العام",m:"image200.jpeg",r:1.2748,rot:0.0},{c:"صورة الموقع العام",m:"image197.jpeg",r:1.3098,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image193.jpeg",r:1.2788,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image194.jpeg",r:1.3113,rot:0.0},{c:"السطح",m:"image195.jpeg",r:1.3324,rot:0.0},{c:"صور الممرات",m:"image192.jpeg",r:1.3722,rot:0.0},{c:"صور الحمام / المطبخ",m:"image198.jpeg",r:1.3009,rot:0.0},{c:"صور للفصول / المكاتب",m:"image199.jpeg",r:1.2058,rot:0.0},{c:"صور للفصول / المكاتب",m:"image201.jpeg",r:1.2961,rot:0.0},{c:"صور للفصول / المكاتب",m:"image196.jpeg",r:1.2396,rot:0.0},{c:"الأمن والسلامة",m:"image190.jpeg",r:1.3026,rot:0.0},{c:"الأمن والسلامة",m:"image187.jpeg",r:1.2261,rot:0.0},{c:"الأمن والسلامة",m:"image188.jpeg",r:1.2288,rot:0.0},{c:"الأمن والسلامة",m:"image189.jpeg",r:1.3085,rot:0.0}]},
  14: {slots:[{c:"صورة الموقع العام",m:"image207.jpeg",r:1.2421,rot:0.0},{c:"صورة الموقع العام",m:"image210.jpeg",r:1.2737,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image212.jpeg",r:1.2329,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image211.jpeg",r:1.2881,rot:0.0},{c:"السطح",m:"image209.jpeg",r:1.251,rot:0.0},{c:"صور الممرات",m:"image214.jpeg",r:1.293,rot:0.0},{c:"صور الحمام / المطبخ",m:"image208.jpeg",r:1.2664,rot:0.0},{c:"صور للفصول / المكاتب",m:"image216.jpeg",r:1.1557,rot:0.0},{c:"صور للفصول / المكاتب",m:"image213.jpeg",r:1.2727,rot:0.0},{c:"صور للفصول / المكاتب",m:"image215.jpeg",r:1.2506,rot:0.0},{c:"الأمن والسلامة",m:"image206.jpeg",r:1.2934,rot:0.0},{c:"الأمن والسلامة",m:"image205.jpeg",r:1.2833,rot:0.0},{c:"الأمن والسلامة",m:"image203.jpeg",r:1.2833,rot:0.0},{c:"الأمن والسلامة",m:"image204.jpeg",r:1.2581,rot:0.0}]},
  15: {slots:[{c:"صورة الموقع العام",m:"image222.jpeg",r:1.3534,rot:0.0},{c:"صورة الموقع العام",m:"image226.jpeg",r:1.3357,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image230.jpeg",r:1.3512,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image227.jpeg",r:1.3366,rot:0.0},{c:"السطح",m:"image229.jpeg",r:1.3298,rot:0.0},{c:"صور الممرات",m:"image231.jpeg",r:1.3551,rot:0.0},{c:"صور الحمام / المطبخ",m:"image224.jpeg",r:1.3499,rot:0.0},{c:"صور للفصول / المكاتب",m:"image225.jpeg",r:1.3443,rot:0.0},{c:"صور للفصول / المكاتب",m:"image228.jpeg",r:1.3414,rot:0.0},{c:"صور للفصول / المكاتب",m:"image223.jpeg",r:1.2892,rot:0.0},{c:"الأمن والسلامة",m:"image218.jpeg",r:1.2931,rot:0.0},{c:"الأمن والسلامة",m:"image219.jpeg",r:1.261,rot:0.0},{c:"الأمن والسلامة",m:"image220.jpeg",r:1.2328,rot:0.0},{c:"الأمن والسلامة",m:"image217.jpeg",r:1.221,rot:0.0}]},
  16: {slots:[{c:"صورة الموقع العام",m:"image240.jpeg",r:0.7373,rot:90.0},{c:"صورة الموقع العام",m:"image237.jpeg",r:0.7673,rot:90.0},{c:"صورة المدرسة / المبنى",m:"image239.jpeg",r:0.737,rot:90.0},{c:"صورة المدرسة / المبنى",m:"image242.jpeg",r:0.7692,rot:90.0},{c:"السطح",m:"image246.jpeg",r:0.7511,rot:90.0},{c:"صور الممرات",m:"image243.jpeg",r:0.7322,rot:90.0},{c:"صور الحمام / المطبخ",m:"image238.jpeg",r:0.7603,rot:90.0},{c:"صور للفصول / المكاتب",m:"image244.jpeg",r:1.3526,rot:0.0},{c:"صور للفصول / المكاتب",m:"image245.jpeg",r:0.7571,rot:90.0},{c:"صور للفصول / المكاتب",m:"image241.jpeg",r:0.7481,rot:90.0},{c:"الأمن والسلامة",m:"image236.jpeg",r:1.3932,rot:0.0},{c:"الأمن والسلامة",m:"image235.jpeg",r:1.3966,rot:0.0},{c:"الأمن والسلامة",m:"image234.jpeg",r:1.4186,rot:0.0},{c:"الأمن والسلامة",m:"image233.jpeg",r:1.3503,rot:0.0}]},
  17: {slots:[{c:"صورة الموقع العام",m:"image255.jpeg",r:1.346,rot:0.0},{c:"صورة الموقع العام",m:"image252.jpeg",r:1.3892,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image257.jpeg",r:1.4605,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image259.jpeg",r:1.4318,rot:0.0},{c:"السطح",m:"image258.jpeg",r:1.35,rot:0.0},{c:"صور الممرات",m:"image261.jpeg",r:1.2863,rot:0.0},{c:"صور الحمام / المطبخ",m:"image253.jpeg",r:1.3622,rot:0.0},{c:"صور للفصول / المكاتب",m:"image254.jpeg",r:1.4367,rot:0.0},{c:"صور للفصول / المكاتب",m:"image260.jpeg",r:1.4183,rot:0.0},{c:"صور للفصول / المكاتب",m:"image256.jpeg",r:1.2728,rot:0.0},{c:"الأمن والسلامة",m:"image250.jpeg",r:1.3296,rot:0.0},{c:"الأمن والسلامة",m:"image249.jpeg",r:1.3173,rot:0.0},{c:"الأمن والسلامة",m:"image248.jpeg",r:1.3638,rot:0.0},{c:"الأمن والسلامة",m:"image247.jpeg",r:1.3428,rot:0.0}]},
  18: {slots:[{c:"صورة الموقع العام",m:"image268.jpeg",r:1.3086,rot:0.0},{c:"صورة الموقع العام",m:"image272.jpeg",r:1.2543,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image270.jpeg",r:1.2873,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image271.jpeg",r:1.3086,rot:0.0},{c:"السطح",m:"image267.jpeg",r:1.2585,rot:0.0},{c:"صور الممرات",m:"image275.jpeg",r:1.308,rot:0.0},{c:"صور الحمام / المطبخ",m:"image273.jpeg",r:1.317,rot:0.0},{c:"صور للفصول / المكاتب",m:"image276.jpeg",r:1.2693,rot:0.0},{c:"صور للفصول / المكاتب",m:"image274.jpeg",r:1.4008,rot:0.0},{c:"صور للفصول / المكاتب",m:"image269.jpeg",r:1.3017,rot:0.0},{c:"الأمن والسلامة",m:"image266.jpeg",r:1.3147,rot:0.0},{c:"الأمن والسلامة",m:"image265.jpeg",r:1.3359,rot:0.0},{c:"الأمن والسلامة",m:"image264.jpeg",r:1.3484,rot:0.0},{c:"الأمن والسلامة",m:"image263.jpeg",r:1.3431,rot:0.0}]},
  19: {slots:[{c:"صورة الموقع العام",m:"image283.jpeg",r:1.2399,rot:0.0},{c:"صورة الموقع العام",m:"image282.jpeg",r:1.2064,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image287.jpeg",r:1.2152,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image286.jpeg",r:1.2271,rot:0.0},{c:"السطح",m:"image288.jpeg",r:1.2727,rot:0.0},{c:"صور الممرات",m:"image284.jpeg",r:1.3059,rot:0.0},{c:"صور الحمام / المطبخ",m:"image285.jpeg",r:1.2369,rot:0.0},{c:"صور للفصول / المكاتب",m:"image291.jpeg",r:1.2331,rot:0.0},{c:"صور للفصول / المكاتب",m:"image290.jpeg",r:1.2185,rot:0.0},{c:"صور للفصول / المكاتب",m:"image289.jpeg",r:1.2564,rot:0.0},{c:"الأمن والسلامة",m:"image281.jpeg",r:1.3677,rot:0.0},{c:"الأمن والسلامة",m:"image280.jpeg",r:1.2878,rot:0.0},{c:"الأمن والسلامة",m:"image279.jpeg",r:1.3062,rot:0.0},{c:"الأمن والسلامة",m:"image278.jpeg",r:1.2847,rot:0.0}]},
  20: {slots:[{c:"صورة الموقع العام",m:"image302.jpeg",r:1.3515,rot:0.0},{c:"صورة الموقع العام",m:"image300.jpeg",r:1.3142,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image304.jpeg",r:1.2643,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image301.jpeg",r:1.3581,rot:0.0},{c:"السطح",m:"image296.jpeg",r:1.2019,rot:0.0},{c:"صور الممرات",m:"image303.jpeg",r:1.3769,rot:0.0},{c:"صور الحمام / المطبخ",m:"image298.jpeg",r:1.2857,rot:0.0},{c:"صور للفصول / المكاتب",m:"image299.jpeg",r:1.3105,rot:0.0},{c:"صور للفصول / المكاتب",m:"image305.jpeg",r:1.2632,rot:0.0},{c:"صور للفصول / المكاتب",m:"image297.jpeg",r:1.3693,rot:0.0},{c:"الأمن والسلامة",m:"image306.jpeg",r:1.2465,rot:0.0},{c:"الأمن والسلامة",m:"image294.jpeg",r:1.251,rot:0.0},{c:"الأمن والسلامة",m:"image293.jpeg",r:1.2357,rot:0.0},{c:"الأمن والسلامة",m:"image292.jpeg",r:1.308,rot:0.0}]},
  21: {slots:[{c:"صورة الموقع العام",m:"image313.jpeg",r:1.2946,rot:0.0},{c:"صورة الموقع العام",m:"image320.jpeg",r:1.2507,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image317.jpeg",r:1.3038,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image319.jpeg",r:1.3321,rot:0.0},{c:"السطح",m:"image318.jpeg",r:1.2945,rot:0.0},{c:"صور الممرات",m:"image316.jpeg",r:1.3109,rot:0.0},{c:"صور الحمام / المطبخ",m:"image312.jpeg",r:1.2969,rot:0.0},{c:"صور للفصول / المكاتب",m:"image321.jpeg",r:1.2779,rot:0.0},{c:"صور للفصول / المكاتب",m:"image314.jpeg",r:1.3516,rot:0.0},{c:"صور للفصول / المكاتب",m:"image315.jpeg",r:1.3239,rot:0.0},{c:"الأمن والسلامة",m:"image311.jpeg",r:1.3054,rot:0.0},{c:"الأمن والسلامة",m:"image310.jpeg",r:1.2723,rot:0.0},{c:"الأمن والسلامة",m:"image308.jpeg",r:1.2623,rot:0.0},{c:"الأمن والسلامة",m:"image307.jpeg",r:1.3011,rot:0.0}]},
  22: {slots:[{c:"صورة الموقع العام",m:"image329.jpeg",r:1.2992,rot:0.0},{c:"صورة الموقع العام",m:"image333.jpeg",r:1.3443,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image327.jpeg",r:1.3384,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image332.jpeg",r:1.3169,rot:0.0},{c:"السطح",m:"image328.jpeg",r:1.3365,rot:0.0},{c:"صور الممرات",m:"image335.jpeg",r:1.3106,rot:0.0},{c:"صور الحمام / المطبخ",m:"image330.jpeg",r:1.2901,rot:0.0},{c:"صور للفصول / المكاتب",m:"image336.jpeg",r:1.3171,rot:0.0},{c:"صور للفصول / المكاتب",m:"image331.jpeg",r:1.3127,rot:0.0},{c:"صور للفصول / المكاتب",m:"image334.jpeg",r:1.283,rot:0.0},{c:"الأمن والسلامة",m:"image326.jpeg",r:1.3722,rot:0.0},{c:"الأمن والسلامة",m:"image325.jpeg",r:1.3081,rot:0.0},{c:"الأمن والسلامة",m:"image323.jpeg",r:1.3296,rot:0.0},{c:"الأمن والسلامة",m:"image324.jpeg",r:1.2119,rot:0.0}]},
  23: {slots:[{c:"صورة الموقع العام",m:"image343.jpeg",r:1.228,rot:0.0},{c:"صورة الموقع العام",m:"image342.jpeg",r:1.2191,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image345.jpeg",r:1.2626,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image344.jpeg",r:1.3378,rot:0.0},{c:"السطح",m:"image348.jpeg",r:1.2955,rot:0.0},{c:"صور الممرات",m:"image347.jpeg",r:1.2369,rot:0.0},{c:"صور الحمام / المطبخ",m:"image341.jpeg",r:1.3307,rot:0.0},{c:"صور للفصول / المكاتب",m:"image346.jpeg",r:1.1668,rot:0.0},{c:"صور للفصول / المكاتب",m:"image350.jpeg",r:1.2619,rot:0.0},{c:"صور للفصول / المكاتب",m:"image349.jpeg",r:1.2324,rot:0.0},{c:"الأمن والسلامة",m:"image339.jpeg",r:1.6286,rot:0.0},{c:"الأمن والسلامة",m:"image340.jpeg",r:1.6791,rot:0.0},{c:"الأمن والسلامة",m:"image338.jpeg",r:1.505,rot:0.0}]},
  24: {slots:[{c:"صورة الموقع العام",m:"image357.jpeg",r:1.1936,rot:0.0},{c:"صورة الموقع العام",m:"image363.jpeg",r:1.2434,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image365.jpeg",r:1.2412,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image359.jpeg",r:1.3013,rot:0.0},{c:"السطح",m:"image356.jpeg",r:1.1676,rot:0.0},{c:"صور الممرات",m:"image362.jpeg",r:1.1893,rot:0.0},{c:"صور الحمام / المطبخ",m:"image358.jpeg",r:1.2179,rot:0.0},{c:"صور للفصول / المكاتب",m:"image360.jpeg",r:1.2403,rot:0.0},{c:"صور للفصول / المكاتب",m:"image364.jpeg",r:1.3082,rot:0.0},{c:"صور للفصول / المكاتب",m:"image361.jpeg",r:1.2421,rot:0.0},{c:"الأمن والسلامة",m:"image355.jpeg",r:1.2201,rot:0.0},{c:"الأمن والسلامة",m:"image354.jpeg",r:1.26,rot:0.0},{c:"الأمن والسلامة",m:"image352.jpeg",r:1.2555,rot:0.0},{c:"الأمن والسلامة",m:"image353.jpeg",r:1.2797,rot:0.0}]},
  25: {slots:[{c:"صورة الموقع العام",m:"image374.jpeg",r:1.3756,rot:0.0},{c:"صورة الموقع العام",m:"image379.jpeg",r:1.3658,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image371.jpeg",r:1.5214,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image377.jpeg",r:1.3351,rot:0.0},{c:"السطح",m:"image378.jpeg",r:1.3886,rot:0.0},{c:"صور الممرات",m:"image372.jpeg",r:1.3663,rot:0.0},{c:"صور الحمام / المطبخ",m:"image373.jpeg",r:1.526,rot:0.0},{c:"صور للفصول / المكاتب",m:"image375.jpeg",r:1.526,rot:0.0},{c:"صور للفصول / المكاتب",m:"image376.jpeg",r:1.3808,rot:0.0},{c:"صور للفصول / المكاتب",m:"image380.jpeg",r:1.3895,rot:0.0},{c:"الأمن والسلامة",m:"image370.jpeg",r:1.3579,rot:0.0},{c:"الأمن والسلامة",m:"image369.jpeg",r:1.3426,rot:0.0},{c:"الأمن والسلامة",m:"image368.jpeg",r:1.3622,rot:0.0},{c:"الأمن والسلامة",m:"image367.jpeg",r:1.3455,rot:0.0}]},
  26: {slots:[{c:"صورة الموقع العام",m:"image391.jpeg",r:1.3181,rot:0.0},{c:"صورة الموقع العام",m:"image387.jpeg",r:1.3148,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image392.jpeg",r:1.3164,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image388.jpeg",r:1.3576,rot:0.0},{c:"السطح",m:"image386.jpeg",r:1.2864,rot:0.0},{c:"صور الممرات",m:"image390.jpeg",r:1.373,rot:0.0},{c:"صور الحمام / المطبخ",m:"image389.jpeg",r:1.3426,rot:0.0},{c:"صور للفصول / المكاتب",m:"image394.jpeg",r:1.2779,rot:0.0},{c:"صور للفصول / المكاتب",m:"image393.jpeg",r:1.3222,rot:0.0},{c:"الأمن والسلامة",m:"image385.jpeg",r:1.3466,rot:0.0},{c:"الأمن والسلامة",m:"image384.jpeg",r:1.3337,rot:0.0},{c:"الأمن والسلامة",m:"image383.jpeg",r:1.3475,rot:0.0},{c:"الأمن والسلامة",m:"image382.jpeg",r:1.2988,rot:0.0}],extra:["image395.jpeg"]},
  27: {slots:[{c:"صورة الموقع العام",m:"image405.jpeg",r:0.7399,rot:90.0},{c:"صورة الموقع العام",m:"image409.jpeg",r:1.2931,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image407.jpeg",r:1.3117,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image406.jpeg",r:1.3253,rot:0.0},{c:"السطح",m:"image401.jpeg",r:1.2312,rot:0.0},{c:"صور الممرات",m:"image404.jpeg",r:1.3916,rot:0.0},{c:"صور الحمام / المطبخ",m:"image403.jpeg",r:0.7399,rot:90.0},{c:"صور للفصول / المكاتب",m:"image408.jpeg",r:1.3916,rot:0.0},{c:"صور للفصول / المكاتب",m:"image410.jpeg",r:1.2526,rot:0.0},{c:"صور للفصول / المكاتب",m:"image402.jpeg",r:0.7481,rot:90.0},{c:"الأمن والسلامة",m:"image397.jpeg",r:1.2628,rot:0.0},{c:"الأمن والسلامة",m:"image399.jpeg",r:1.2478,rot:0.0},{c:"الأمن والسلامة",m:"image400.jpeg",r:1.2485,rot:0.0},{c:"الأمن والسلامة",m:"image398.jpeg",r:1.248,rot:0.0}]},
  28: {slots:[{c:"صورة الموقع العام",m:"image420.jpeg",r:1.2719,rot:0.0},{c:"صورة الموقع العام",m:"image423.jpeg",r:1.3799,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image417.jpeg",r:1.451,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image416.jpeg",r:1.3779,rot:0.0},{c:"السطح",m:"image419.jpeg",r:1.3672,rot:0.0},{c:"صور الممرات",m:"image424.jpeg",r:1.2583,rot:0.0},{c:"صور الحمام / المطبخ",m:"image422.jpeg",r:1.2227,rot:0.0},{c:"صور للفصول / المكاتب",m:"image425.jpeg",r:1.1793,rot:0.0},{c:"صور للفصول / المكاتب",m:"image421.jpeg",r:1.4026,rot:0.0},{c:"صور للفصول / المكاتب",m:"image418.jpeg",r:1.2562,rot:0.0},{c:"الأمن والسلامة",m:"image415.jpeg",r:1.2801,rot:0.0},{c:"الأمن والسلامة",m:"image412.jpeg",r:1.256,rot:0.0},{c:"الأمن والسلامة",m:"image414.jpeg",r:1.3107,rot:0.0},{c:"الأمن والسلامة",m:"image413.jpeg",r:1.3201,rot:0.0}]},
  29: {slots:[{c:"صورة الموقع العام",m:"image431.jpeg",r:1.3498,rot:0.0},{c:"صورة الموقع العام",m:"image436.jpeg",r:1.3609,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image440.jpeg",r:1.3442,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image439.jpeg",r:1.3573,rot:0.0},{c:"السطح",m:"image432.jpeg",r:1.3458,rot:0.0},{c:"صور الممرات",m:"image434.jpeg",r:1.3124,rot:0.0},{c:"صور الحمام / المطبخ",m:"image437.jpeg",r:1.3811,rot:0.0},{c:"صور للفصول / المكاتب",m:"image435.jpeg",r:1.3486,rot:0.0},{c:"صور للفصول / المكاتب",m:"image438.jpeg",r:1.3391,rot:0.0},{c:"صور للفصول / المكاتب",m:"image433.jpeg",r:1.327,rot:0.0},{c:"الأمن والسلامة",m:"image430.jpeg",r:1.3948,rot:0.0},{c:"الأمن والسلامة",m:"image429.jpeg",r:1.407,rot:0.0},{c:"الأمن والسلامة",m:"image428.jpeg",r:1.3815,rot:0.0},{c:"الأمن والسلامة",m:"image426.jpeg",r:1.3612,rot:0.0}],extra:["image441.jpeg"]},
  30: {slots:[{c:"صورة الموقع العام",m:"image453.jpeg",r:1.3758,rot:0.0},{c:"صورة الموقع العام",m:"image455.jpeg",r:1.2676,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image449.jpeg",r:1.3563,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image454.jpeg",r:1.3468,rot:0.0},{c:"السطح",m:"image448.jpeg",r:1.2998,rot:0.0},{c:"صور الممرات",m:"image447.jpeg",r:1.2606,rot:0.0},{c:"صور الحمام / المطبخ",m:"image450.jpeg",r:1.2676,rot:0.0},{c:"صور للفصول / المكاتب",m:"image451.jpeg",r:1.3432,rot:0.0},{c:"صور للفصول / المكاتب",m:"image456.jpeg",r:1.2775,rot:0.0},{c:"صور للفصول / المكاتب",m:"image452.jpeg",r:1.344,rot:0.0},{c:"الأمن والسلامة",m:"image445.jpeg",r:1.3342,rot:0.0},{c:"الأمن والسلامة",m:"image446.jpeg",r:1.3279,rot:0.0},{c:"الأمن والسلامة",m:"image444.jpeg",r:1.3476,rot:0.0},{c:"الأمن والسلامة",m:"image443.jpeg",r:1.3395,rot:0.0}]},
  31: {slots:[{c:"صورة الموقع العام",m:"image464.jpeg",r:1.4434,rot:0.0},{c:"صورة الموقع العام",m:"image465.jpeg",r:1.354,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image468.jpeg",r:1.2794,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image466.jpeg",r:1.3758,rot:0.0},{c:"السطح",m:"image467.jpeg",r:1.3202,rot:0.0},{c:"صور الممرات",m:"image469.jpeg",r:1.3509,rot:0.0},{c:"صور الحمام / المطبخ",m:"image462.jpeg",r:1.277,rot:0.0},{c:"صور للفصول / المكاتب",m:"image471.jpeg",r:1.2696,rot:0.0},{c:"صور للفصول / المكاتب",m:"image470.jpeg",r:1.2844,rot:0.0},{c:"صور للفصول / المكاتب",m:"image463.jpeg",r:1.2718,rot:0.0},{c:"الأمن والسلامة",m:"image461.jpeg",r:1.3164,rot:0.0},{c:"الأمن والسلامة",m:"image460.jpeg",r:1.3561,rot:0.0},{c:"الأمن والسلامة",m:"image459.jpeg",r:1.3084,rot:0.0},{c:"الأمن والسلامة",m:"image458.jpeg",r:1.3299,rot:0.0}]},
  32: {slots:[{c:"صورة الموقع العام",m:"image480.jpeg",r:1.4083,rot:0.0},{c:"صورة الموقع العام",m:"image479.jpeg",r:1.3995,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image476.jpeg",r:1.365,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image481.jpeg",r:1.3449,rot:0.0},{c:"السطح",m:"image477.jpeg",r:1.3666,rot:0.0},{c:"صور الممرات",m:"image485.jpeg",r:1.3535,rot:0.0},{c:"صور الحمام / المطبخ",m:"image478.jpeg",r:1.3538,rot:0.0},{c:"صور للفصول / المكاتب",m:"image484.jpeg",r:1.379,rot:0.0},{c:"صور للفصول / المكاتب",m:"image482.jpeg",r:1.3531,rot:0.0},{c:"صور للفصول / المكاتب",m:"image483.jpeg",r:1.3634,rot:0.0},{c:"الأمن والسلامة",m:"image472.jpeg",r:1.3313,rot:0.0},{c:"الأمن والسلامة",m:"image473.jpeg",r:1.3224,rot:0.0},{c:"الأمن والسلامة",m:"image474.jpeg",r:1.3449,rot:0.0},{c:"الأمن والسلامة",m:"image475.jpeg",r:1.3615,rot:0.0}]},
  33: {slots:[{c:"صورة الموقع العام",m:"image494.jpeg",r:1.3949,rot:0.0},{c:"صورة الموقع العام",m:"image496.jpeg",r:1.2614,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image492.jpeg",r:1.3422,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image498.jpeg",r:1.3205,rot:0.0},{c:"السطح",m:"image493.jpeg",r:1.3328,rot:0.0},{c:"صور الممرات",m:"image499.jpeg",r:1.4113,rot:0.0},{c:"صور الحمام / المطبخ",m:"image491.jpeg",r:1.3438,rot:0.0},{c:"صور للفصول / المكاتب",m:"image497.jpeg",r:1.2684,rot:0.0},{c:"صور للفصول / المكاتب",m:"image500.jpeg",r:1.2851,rot:0.0},{c:"صور للفصول / المكاتب",m:"image495.jpeg",r:1.3524,rot:0.0},{c:"الأمن والسلامة",m:"image490.jpeg",r:1.256,rot:0.0},{c:"الأمن والسلامة",m:"image486.jpeg",r:1.2815,rot:0.0},{c:"الأمن والسلامة",m:"image487.jpeg",r:1.2979,rot:0.0},{c:"الأمن والسلامة",m:"image488.jpeg",r:1.2781,rot:0.0}]},
  34: {slots:[{c:"صورة الموقع العام",m:"image506.jpeg",r:1.2024,rot:0.0},{c:"صورة الموقع العام",m:"image511.jpeg",r:1.3538,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image513.jpeg",r:1.2345,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image510.jpeg",r:1.2853,rot:0.0},{c:"السطح",m:"image508.jpeg",r:1.1701,rot:0.0},{c:"صور الممرات",m:"image509.jpeg",r:1.3673,rot:0.0},{c:"صور الحمام / المطبخ",m:"image507.jpeg",r:1.3991,rot:0.0},{c:"صور للفصول / المكاتب",m:"image514.jpeg",r:1.3255,rot:0.0},{c:"صور للفصول / المكاتب",m:"image512.jpeg",r:1.3741,rot:0.0},{c:"صور للفصول / المكاتب",m:"image505.jpeg",r:1.1934,rot:0.0},{c:"الأمن والسلامة",m:"image501.jpeg",r:1.2108,rot:0.0},{c:"الأمن والسلامة",m:"image504.jpeg",r:1.2817,rot:0.0},{c:"الأمن والسلامة",m:"image503.jpeg",r:1.2563,rot:0.0}]},
  35: {slots:[{c:"صورة الموقع العام",m:"image520.jpeg",r:1.306,rot:0.0},{c:"صورة الموقع العام",m:"image527.jpeg",r:1.2992,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image521.jpeg",r:1.3266,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image524.jpeg",r:1.2703,rot:0.0},{c:"السطح",m:"image523.jpeg",r:1.2641,rot:0.0},{c:"صور الممرات",m:"image519.jpeg",r:1.2746,rot:0.0},{c:"صور الحمام / المطبخ",m:"image522.jpeg",r:1.341,rot:0.0},{c:"صور للفصول / المكاتب",m:"image528.jpeg",r:1.3198,rot:0.0},{c:"صور للفصول / المكاتب",m:"image526.jpeg",r:1.2578,rot:0.0},{c:"صور للفصول / المكاتب",m:"image525.jpeg",r:1.3344,rot:0.0},{c:"الأمن والسلامة",m:"image517.jpeg",r:1.2994,rot:0.0},{c:"الأمن والسلامة",m:"image518.jpeg",r:1.2718,rot:0.0},{c:"الأمن والسلامة",m:"image515.jpeg",r:1.347,rot:0.0}]},
  36: {slots:[{c:"صورة الموقع العام",m:"image538.jpeg",r:1.3135,rot:0.0},{c:"صورة الموقع العام",m:"image537.jpeg",r:1.3542,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image542.jpeg",r:1.2506,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image540.jpeg",r:1.2954,rot:0.0},{c:"السطح",m:"image533.jpeg",r:1.3256,rot:0.0},{c:"صور الممرات",m:"image535.jpeg",r:1.3523,rot:0.0},{c:"صور الحمام / المطبخ",m:"image536.jpeg",r:1.3531,rot:0.0},{c:"صور للفصول / المكاتب",m:"image541.jpeg",r:1.2202,rot:0.0},{c:"صور للفصول / المكاتب",m:"image539.jpeg",r:1.2649,rot:0.0},{c:"صور للفصول / المكاتب",m:"image534.jpeg",r:1.2795,rot:0.0},{c:"الأمن والسلامة",m:"image532.jpeg",r:1.3501,rot:0.0},{c:"الأمن والسلامة",m:"image531.jpeg",r:1.3369,rot:0.0},{c:"الأمن والسلامة",m:"image530.jpeg",r:1.3774,rot:0.0}]},
  37: {slots:[{c:"صورة الموقع العام",m:"image555.jpeg",r:1.3313,rot:0.0},{c:"صورة الموقع العام",m:"image554.jpeg",r:1.2693,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image552.jpeg",r:1.2888,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image553.jpeg",r:1.2809,rot:0.0},{c:"السطح",m:"image551.jpeg",r:1.1558,rot:0.0},{c:"صور الممرات",m:"image550.jpeg",r:1.264,rot:0.0},{c:"صور الحمام / المطبخ",m:"image549.jpeg",r:1.2831,rot:0.0},{c:"صور للفصول / المكاتب",m:"image556.jpeg",r:1.3348,rot:0.0},{c:"صور للفصول / المكاتب",m:"image544.jpeg",r:1.549,rot:0.0},{c:"صور للفصول / المكاتب",m:"image547.jpeg",r:1.2042,rot:0.0},{c:"الأمن والسلامة",m:"image546.jpeg",r:1.457,rot:0.0},{c:"الأمن والسلامة",m:"image545.jpeg",r:1.4174,rot:0.0},{c:"الأمن والسلامة",m:"image548.jpeg",r:1.1871,rot:0.0}]},
  38: {slots:[{c:"صورة الموقع العام",m:"image566.jpeg",r:1.2335,rot:0.0},{c:"صورة الموقع العام",m:"image563.jpeg",r:1.2216,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image571.jpeg",r:1.1677,rot:0.0},{c:"صورة المدرسة / المبنى",m:"image569.jpeg",r:1.2562,rot:0.0},{c:"السطح",m:"image565.jpeg",r:1.1767,rot:0.0},{c:"صور الممرات",m:"image568.jpeg",r:1.294,rot:0.0},{c:"صور الحمام / المطبخ",m:"image564.jpeg",r:1.2491,rot:0.0},{c:"صور للفصول / المكاتب",m:"image570.jpeg",r:1.257,rot:0.0},{c:"صور للفصول / المكاتب",m:"image567.jpeg",r:1.2683,rot:0.0},{c:"صور للفصول / المكاتب",m:"image562.jpeg",r:1.2401,rot:0.0},{c:"الأمن والسلامة",m:"image561.jpeg",r:1.3258,rot:0.0},{c:"الأمن والسلامة",m:"image559.jpeg",r:1.319,rot:0.0},{c:"الأمن والسلامة",m:"image558.jpeg",r:1.3194,rot:0.0},{c:"الأمن والسلامة",m:"image560.jpeg",r:1.3416,rot:0.0}]},
};

// Same shared literal text found identically in all 38 slides (see the
// structural analysis) — same substitution technique as TITLE_SEARCH/
// DATE_SEARCH above, just this deck's own exact original wording.
const MASTER_MONTH_TITLE_SEARCH = "<a:t>تقرير مشهد الإنجاز الشهري (يونيو)</a:t>";
const MASTER_DATE_SEARCH = "2026/6/16 الى 2026/7/15";

// Strips the parentheses/whitespace noise the template's own school-name
// text is inconsistently formatted with (some names have a leading/
// trailing space before the parenthesis, doubled internal spaces, etc.)
// so matching against the app's own school records isn't broken by
// harmless formatting differences. Deliberately NOT fuzzy beyond this —
// no edit-distance/substring matching — so two different schools can
// never be confused for each other (see section 3 of the spec: "never
// guess").
function normalizeSchoolNameForMatch(text) {
  return (text || "")
    .trim()
    .replace(/^\(+\s*/, "")
    .replace(/\s*\)+$/, "")
    .replace(/[،,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Reads the school-name text directly out of a slide's own XML (DOMParser,
// not a hardcoded per-slide name list) — same shape-matching rule used to
// build MASTER_SLOT_MAP: the one parenthesized paragraph that isn't the
// month title or the date line. Returns the raw (un-normalized) text, or
// null if this slide doesn't have a text shape matching that pattern
// (surfaced by the caller as an explicit validation failure, never
// silently skipped).
function extractSchoolNameFromMasterSlideXml(slideXml) {
  const doc = new DOMParser().parseFromString(slideXml, "application/xml");
  const paragraphs = doc.getElementsByTagName("a:p");
  for (let i = 0; i < paragraphs.length; i++) {
    const runs = paragraphs[i].getElementsByTagName("a:t");
    let text = "";
    for (let j = 0; j < runs.length; j++) text += runs[j].textContent || "";
    text = text.trim();
    if (!text) continue;
    if (/^\(.*\)$/.test(text) && !text.includes("تقرير") && !text.includes("التاريخ")) {
      return text;
    }
  }
  return null;
}

// Loads master-template.pptx, reads every slide's own school name, and
// matches it against the app's current school list (getAllMonthlySchools())
// — see section 2/3 of the spec: exactly one match required per slide,
// zero matches and multiple matches are BOTH reported (never guessed at),
// and one app school can never end up claimed by two slides. Also counts
// how many slots/slides would actually change for `monthKey`, without
// writing anything — this is the pre-generation validation step AND the
// summary shown to the user before they confirm generation.
//
// Returns { ok, errorMessage, zip, slideMatches, ... } — `zip` (the loaded
// JSZip, with every slide's XML already read once) and `slideMatches` are
// reused as-is by generateMasterSchoolsPptx() so the file is only fetched
// and parsed once per generation.
async function validateMasterSchoolsPptx(monthKey) {
  const result = {
    ok: false,
    errorMessage: null,
    templateSlideCount: 0,
    schoolsInTemplate: 0,
    matchedCount: 0,
    unmatchedSlides: [], // [{slide, rawName}]
    ambiguousSlides: [], // [{slide, rawName, candidateNames}]
    specialSlidesMissingSecurity: [], // slide numbers with only 3 "الأمن والسلامة" slots
    specialSlidesExtraUnlabeled: [], // slide numbers (26, 29) with a genuinely unlabeled extra photo
    slideMatches: {}, // slideNum -> { rawName, matchedSchool, slideXml }
    newPhotosCount: 0,
    slidesWillUpdate: 0,
    slotsUnchangedCount: 0,
    monthlySlots: null,
    zip: null
  };

  let zip;
  try {
    const templateResp = await fetch(MASTER_TEMPLATE_PATH);
    if (!templateResp.ok) throw new Error("fetch_failed");
    const templateBuffer = await templateResp.arrayBuffer();
    zip = await JSZip.loadAsync(templateBuffer);
  } catch (e) {
    result.errorMessage = "تعذّر تحميل ملف القالب الرئيسي (master-template.pptx).";
    return result;
  }

  const slideNumbers = Object.keys(MASTER_SLOT_MAP).map(Number).sort((a, b) => a - b);
  result.templateSlideCount = slideNumbers.length;
  result.schoolsInTemplate = slideNumbers.length;
  if (result.templateSlideCount !== MASTER_TEMPLATE_SLIDE_COUNT) {
    result.errorMessage = `عدد شرائح القالب غير متوقع: ${result.templateSlideCount} (المتوقع ${MASTER_TEMPLATE_SLIDE_COUNT}).`;
    return result;
  }

  const schools = await getAllMonthlySchools();
  const monthlySlots = await getMonthlySlots();
  result.monthlySlots = monthlySlots;

  const normalizedSchools = schools.map((s) => ({ school: s, norm: normalizeSchoolNameForMatch(s.name) }));
  const usedSchoolIds = new Set();

  for (const sn of slideNumbers) {
    const path = `ppt/slides/slide${sn}.xml`;
    const file = zip.file(path);
    if (!file) {
      result.errorMessage = `الشريحة رقم ${sn} غير موجودة داخل ملف القالب.`;
      return result;
    }
    const slideXml = await file.async("string");
    const rawName = extractSchoolNameFromMasterSlideXml(slideXml);

    if (!rawName) {
      result.errorMessage = `تعذّر العثور على اسم مدرسة داخل الشريحة رقم ${sn}.`;
      return result;
    }

    const normName = normalizeSchoolNameForMatch(rawName);
    const candidates = normalizedSchools.filter((x) => x.norm === normName);

    if (candidates.length === 0) {
      result.unmatchedSlides.push({ slide: sn, rawName });
      result.slideMatches[sn] = { rawName, matchedSchool: null, slideXml };
    } else if (candidates.length > 1 || usedSchoolIds.has(candidates[0].school.id)) {
      result.ambiguousSlides.push({ slide: sn, rawName, candidateNames: candidates.map((c) => c.school.name) });
      result.slideMatches[sn] = { rawName, matchedSchool: null, slideXml, ambiguous: true };
    } else {
      const school = candidates[0].school;
      usedSchoolIds.add(school.id);
      result.matchedCount++;
      result.slideMatches[sn] = { rawName, matchedSchool: school, slideXml };
    }
  }

  result.specialSlidesMissingSecurity = slideNumbers.filter(
    (sn) => MASTER_SLOT_MAP[sn].slots.filter((s) => s.c === "الأمن والسلامة").length < 4
  );
  result.specialSlidesExtraUnlabeled = slideNumbers.filter((sn) => !!MASTER_SLOT_MAP[sn].extra);

  for (const sn of slideNumbers) {
    const m = result.slideMatches[sn];
    const slots = MASTER_SLOT_MAP[sn].slots;
    if (!m.matchedSchool) {
      result.slotsUnchangedCount += slots.length;
      continue;
    }
    const submission = await getMonthlySubmission(m.matchedSchool.id, monthKey);
    const byLabel = groupFilledSlotsByLabel(monthlySlots, submission);
    const consumedByCategory = {};
    let slideNewPhotos = 0;
    for (const slot of slots) {
      const filledForCat = byLabel[slot.c] || [];
      const i = consumedByCategory[slot.c] || 0;
      consumedByCategory[slot.c] = i + 1;
      if (filledForCat[i]) {
        slideNewPhotos++;
      } else {
        result.slotsUnchangedCount++;
      }
    }
    result.newPhotosCount += slideNewPhotos;
    if (slideNewPhotos > 0) result.slidesWillUpdate++;
  }

  if (result.ambiguousSlides.length > 0) {
    const names = result.ambiguousSlides.map((a) => `"${a.rawName}"`).join("، ");
    result.errorMessage = `تطابق غامض لاسم مدرسة — تم إيقاف التوليد. الشرائح المتأثرة: ${names}`;
    return result;
  }

  result.ok = true;
  result.zip = zip;
  return result;
}

// Generates the single combined all-schools PowerPoint from
// master-template.pptx for `monthKey`. Always re-validates first (never
// trusts a stale/external validation result) and refuses to write
// anything if validation fails — see validateMasterSchoolsPptx() above.
async function generateMasterSchoolsPptx(monthKey) {
  const validation = await validateMasterSchoolsPptx(monthKey);
  if (!validation.ok) {
    const err = new Error(validation.errorMessage || "master_validation_failed");
    err.validation = validation;
    throw err;
  }

  const zip = validation.zip;
  const { start, end } = monthKeyToReportRange(monthKey);
  const fmt = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  const monthName = monthKeyToArabicName(monthKey);
  const newDateText = xmlEscape(`${fmt(start)} الى ${fmt(end)}`);
  const overlayIsRtl = currentLang === "ar";

  for (const [snStr, slideInfo] of Object.entries(validation.slideMatches)) {
    const sn = Number(snStr);
    let slideXml = slideInfo.slideXml;

    // Section 2 of the spec: an unmatched slide is left fully
    // unchanged, including its month/date text — its school couldn't
    // be confirmed, so nothing about that slide is touched.
    if (!slideInfo.matchedSchool) continue;

    if (slideXml.includes(MASTER_MONTH_TITLE_SEARCH)) {
      slideXml = slideXml.replace(MASTER_MONTH_TITLE_SEARCH, `<a:t>تقرير مشهد الإنجاز الشهري (${xmlEscape(monthName)})</a:t>`);
    }
    if (slideXml.includes(MASTER_DATE_SEARCH)) {
      slideXml = slideXml.replace(MASTER_DATE_SEARCH, newDateText);
    }

    const school = slideInfo.matchedSchool;
    const slots = MASTER_SLOT_MAP[sn].slots;
    const submission = await getMonthlySubmission(school.id, monthKey);
    const byLabel = groupFilledSlotsByLabel(validation.monthlySlots, submission);
    const overlayLines = school.documentPhotos === false ? [] : monthlyOverlayLines(school.name, submission.visitDate);

    // Consumption index per category so multiple slots sharing the same
    // category (e.g. 4 "الأمن والسلامة" slots) each get a distinct
    // filled photo, in slot order — identical rule to
    // groupFilledSlotsByLabel()'s existing single-school usage above.
    const consumedByCategory = {};
    for (const slot of slots) {
      const filledForCat = byLabel[slot.c] || [];
      const i = consumedByCategory[slot.c] || 0;
      consumedByCategory[slot.c] = i + 1;
      const filledEntry = filledForCat[i];
      if (!filledEntry) continue; // section 6: keep this slide's original master photo untouched

      const cropped = await cropImageToRatio(filledEntry.entry.blob, slot.r, 1000, overlayLines, overlayIsRtl);
      const arrayBuf = await cropped.arrayBuffer();
      // This slide's OWN media file only (see MASTER_SLOT_MAP's comment)
      // — never a filename shared with any other slide, and never one
      // of the 3 header-logo files (which never appear in this map).
      zip.file(`ppt/media/${slot.m}`, arrayBuf);
    }

    zip.file(`ppt/slides/slide${sn}.xml`, slideXml);
  }

  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });

  const monthLabel = monthKeyToArabicName(monthKey);
  const year = monthKey.split("-")[0];
  const fileName = `تقرير_الصور_الشهرية_${monthLabel}_${year}.pptx`;
  return { blob, fileName, validation };
}
