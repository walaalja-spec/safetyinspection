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

// { category label -> [ { media: "imageN.jpeg", ratio: width/height } ] }
// in the exact order slots of that label should be assigned.
const PPTX_IMAGE_MAP = {
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
  ],
  "لافتة المبنى": [
    { media: "image5.jpeg", ratio: 4752000 / 4278591 }
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

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
function cropImageToRatio(sourceBlob, targetRatio, targetWidth = 1000) {
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
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/jpeg", 0.88);
    };
    img.src = URL.createObjectURL(sourceBlob);
  });
}

// Builds { label -> [{slotId, entry}] } from the current slots list and
// submission, preserving slot order, only for slots that actually have
// a saved photo.
function groupFilledSlotsByLabel(slots, submission) {
  const byLabel = {};
  slots.forEach((slot) => {
    const entry = submission.photos && submission.photos[slot.id];
    if (!entry) return;
    (byLabel[slot.label] = byLabel[slot.label] || []).push({ slotId: slot.id, entry });
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

  // 1) Swap photo bytes — only for slots that actually have a photo.
  //    Missing ones keep the template's original example photo, by design.
  for (const [label, targets] of Object.entries(PPTX_IMAGE_MAP)) {
    const filled = byLabel[label] || [];
    for (let i = 0; i < targets.length; i++) {
      const filledEntry = filled[i];
      if (!filledEntry) continue; // leave this specific frame's original photo untouched
      const target = targets[i];
      const cropped = await cropImageToRatio(filledEntry.entry.blob, target.ratio);
      const arrayBuf = await cropped.arrayBuffer();
      zip.file(`ppt/media/${target.media}`, arrayBuf);
    }
  }

  // 2) Replace the two text fields, in the slide XML.
  const slidePath = "ppt/slides/slide1.xml";
  let slideXml = await zip.file(slidePath).async("string");

  if (slideXml.includes(SCHOOL_NAME_SEARCH)) {
    const replacement = SCHOOL_NAME_SEARCH.replace(
      '<a:t>( تحفيظ القرآن الكريم الابتدائية و المتوسطة </a:t>',
      `<a:t>(${xmlEscape(school.name)})</a:t>`
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

  zip.file(slidePath, slideXml);

  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });

  const monthLabel = monthKey; // "YYYY-MM" — kept simple/unambiguous in the filename
  const fileName = `التقرير المصور - ${sanitizeFileNamePart(school.name)} - ${monthLabel}.pptx`;
  return { blob, fileName };
}
