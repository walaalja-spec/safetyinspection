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

        // Same soft gradient fade used for the in-app documented photos
        // (photodoc.js) instead of a flat black bar, for a consistent
        // look across PDF/app/PPTX exports.
        const fadeHeight = Math.round(fontSize * 1.4);
        const gradientTop = Math.max(0, barY - fadeHeight);
        const gradient = ctx.createLinearGradient(0, gradientTop, 0, targetHeight);
        gradient.addColorStop(0, "rgba(0,0,0,0)");
        gradient.addColorStop(0.35, "rgba(0,0,0,0.3)");
        gradient.addColorStop(1, "rgba(0,0,0,0.72)");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, gradientTop, targetWidth, targetHeight - gradientTop);

        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = Math.round(fontSize * 0.3);
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 1;

        ctx.fillStyle = "#ffffff";
        ctx.direction = isRtl ? "rtl" : "ltr";
        ctx.textAlign = isRtl ? "right" : "left";
        ctx.font = `600 ${fontSize}px Geeza Pro, Cairo, Arial, sans-serif`;
        const paddingX = Math.round(targetWidth * 0.025);
        let ty = barY + paddingY + fontSize * 0.8;
        lines.forEach((line) => {
          ctx.fillText(line, isRtl ? targetWidth - paddingX : paddingX, ty);
          ty += fontSize + lineGap;
        });
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
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
  const overlayLines = monthlyOverlayLines(school.name, submission.visitDate);
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
    const overlayLines = monthlyOverlayLines(school.name, submission.visitDate);
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
