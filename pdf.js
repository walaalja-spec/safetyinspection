// ---------------------------------------------------------------------
// pdf.js
// Renders each page by drawing directly onto an HTML5 canvas with
// ctx.fillText() — canvas text goes through the browser's own
// text-shaping engine, so Arabic renders correctly (connected
// letterforms, right-to-left order), unlike html2canvas.
//
// Layout: no separate cover page — page 1 starts with a compact report
// header followed immediately by observations. Each observation's
// height is based on its actual content (how many photos, how much
// text) rather than a fixed slot, so short notes stay compact and a
// page can fit more than two when there isn't much text.
// ---------------------------------------------------------------------

const PDF_COLORS = {
  primary: "#1f5e3d",
  primaryLight: "#dcebe3",
  text: "#1c231f",
  muted: "#6b736c",
  border: "#dde2dc",
  bgLight: "#f3f6f4"
};

const PAGE_W = 1240;
const PAGE_H = 1754;
const MARGIN = 70;
const FOOTER_RESERVE = 70;
const GRID_COLS = 2;
const COL_GAP = 20;
const ROW_GAP = 20;
const MAX_PHOTO_CELL = 480;
const TEXT_LINE_HEIGHT = 26;
const TEXT_PADDING = 14;
const BADGE_ROW_H = 46;
// Hard cap on a single observation card's height, sized so that even
// the tightest page (page 1, with its taller header) fits 2 rows ×
// 2 columns = 4 observations minimum.
const MAX_ROW_HEIGHT = 680;

// Documented photos are generated as a fixed 1080×1080 square (see
// photodoc.js) so the info bar always stays inside the frame. If we
// then "cover crop" that square into a wide rectangular cell, the crop
// can cut the bottom info bar right off. So photo cells in the PDF are
// square too — the image is scaled to fit, never cropped a second time.
function photoCellSize(photoCount, availableWidth) {
  const gap = 10;
  const cols = photoCount === 1 ? 1 : 2;
  const idealSize = (availableWidth - gap * (cols - 1)) / cols;
  return Math.min(idealSize, MAX_PHOTO_CELL);
}

function sanitizeFileName(str) {
  return (str || "").replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_").trim() || "Report";
}

async function ensureFontsLoaded() {
  try {
    await Promise.all([
      document.fonts.load('400 30px Cairo'),
      document.fonts.load('600 30px Cairo'),
      document.fonts.load('700 30px Cairo'),
      document.fonts.load('800 30px Cairo')
    ]);
    await document.fonts.ready;
  } catch (e) {
    console.warn("Font preload failed, PDF will fall back to system fonts:", e);
  }
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawImageCover(ctx, img, x, y, w, h, radius) {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.clip();
  const imgRatio = img.width / img.height;
  const boxRatio = w / h;
  let drawW, drawH, dx, dy;
  if (imgRatio > boxRatio) {
    drawH = h;
    drawW = h * imgRatio;
    dx = x - (drawW - w) / 2;
    dy = y;
  } else {
    drawW = w;
    drawH = w / imgRatio;
    dx = x;
    dy = y - (drawH - h) / 2;
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, dx, dy, drawW, drawH);
  ctx.restore();
  ctx.strokeStyle = PDF_COLORS.border;
  ctx.lineWidth = 1;
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.stroke();
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  (text || "").split("\n").forEach((paragraph) => {
    if (paragraph === "") { lines.push(""); return; }
    const words = paragraph.split(" ");
    let current = "";
    words.forEach((word) => {
      const test = current ? current + " " + word : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    });
    if (current) lines.push(current);
  });
  return lines;
}

function truncateLines(lines, maxLines) {
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = kept[maxLines - 1].replace(/\s+$/, "") + " …";
  return kept;
}

// Renders at 2x pixel density (~300dpi for A4) for crisp print/zoom
// quality. All drawing code below still uses the same logical
// PAGE_W/PAGE_H coordinate system — ctx.scale() makes the browser
// rasterize everything at higher resolution automatically.
const RENDER_SCALE = 2;

function newPageCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = PAGE_W * RENDER_SCALE;
  canvas.height = PAGE_H * RENDER_SCALE;
  const ctx = canvas.getContext("2d");
  ctx.scale(RENDER_SCALE, RENDER_SCALE);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  return { canvas, ctx };
}

function drawFooter(ctx, pageNum, isRtl, reportTitle) {
  ctx.strokeStyle = PDF_COLORS.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, PAGE_H - 55);
  ctx.lineTo(PAGE_W - MARGIN, PAGE_H - 55);
  ctx.stroke();

  ctx.fillStyle = PDF_COLORS.muted;
  ctx.font = "20px Geeza Pro, Cairo, Arial, sans-serif";
  ctx.direction = isRtl ? "rtl" : "ltr";
  ctx.textAlign = isRtl ? "right" : "left";
  ctx.fillText(reportTitle, isRtl ? PAGE_W - MARGIN : MARGIN, PAGE_H - 22);

  ctx.textAlign = "center";
  ctx.fillText(String(pageNum), PAGE_W / 2, PAGE_H - 22);
}

function drawFirstPageHeader(ctx, report, isRtl, lang) {
  const bandHeight = 250;

  ctx.fillStyle = PDF_COLORS.primary;
  ctx.fillRect(0, 0, PAGE_W, bandHeight);

  const rightX = isRtl ? PAGE_W - MARGIN : MARGIN;
  const eyebrow = lang === "ar" ? "تقرير زيارة مدرسة" : "SCHOOL VISIT REPORT";

  ctx.font = "700 22px Geeza Pro, Cairo, Arial, sans-serif";
  ctx.direction = isRtl ? "rtl" : "ltr";
  ctx.textAlign = isRtl ? "right" : "left";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(eyebrow, rightX, MARGIN + 28);

  ctx.fillStyle = "#ffffff";
  ctx.font = "800 40px Geeza Pro, Cairo, Arial, sans-serif";
  ctx.fillText(report.title, rightX, MARGIN + 78);

  const metaParts = [
    report.location,
    report.date,
    (lang === "ar" ? `${report.observations.length} ملاحظة` : `${report.observations.length} observations`)
  ];
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font = "24px Geeza Pro, Cairo, Arial, sans-serif";
  ctx.fillText(metaParts.join("   •   "), rightX, MARGIN + 114);

  return bandHeight + 40;
}

function drawRunningHeader(ctx, report, isRtl) {
  const rightX = isRtl ? PAGE_W - MARGIN : MARGIN;
  ctx.fillStyle = PDF_COLORS.muted;
  ctx.font = "600 22px Geeza Pro, Cairo, Arial, sans-serif";
  ctx.direction = isRtl ? "rtl" : "ltr";
  ctx.textAlign = isRtl ? "right" : "left";
  ctx.fillText(`${report.title} — ${report.location}`, rightX, MARGIN + 20);
  return MARGIN + 55;
}

// Computes how tall this observation's card needs to be, based on its
// actual photos and text — capped at MAX_ROW_HEIGHT so 2 rows (4 cards)
// always fit on a page (long text gets truncated with "…" when drawn,
// same as any other overflow case).
function measureObservationHeight(ctx, obs, width) {
  const photos = obsPhotos(obs);
  let photoBlockH = 6;
  if (photos.length) {
    const cols = photos.length === 1 ? 1 : 2;
    const cellSize = photoCellSize(photos.length, width);
    const rows = Math.ceil(photos.length / cols);
    photoBlockH = rows * (cellSize + 10);
  }

  ctx.font = `${TEXT_LINE_HEIGHT - 8}px Geeza Pro, Cairo, Arial, sans-serif`;
  const lines = wrapText(ctx, obs.text || "", width - TEXT_PADDING * 2 - 14);
  const naturalTextH = lines.length * TEXT_LINE_HEIGHT + TEXT_PADDING * 2;

  const naturalTotal = BADGE_ROW_H + photoBlockH + naturalTextH;
  return { height: Math.min(naturalTotal, MAX_ROW_HEIGHT), lineCount: lines.length };
}

async function drawObservationSlot(ctx, report, obs, obsNumber, x, y, w, h, isRtl, lang) {
  const badgeSize = 36;
  const badgeX = isRtl ? x + w - badgeSize : x;
  const badgeCx = badgeX + badgeSize / 2;
  const badgeCy = y + badgeSize / 2;

  ctx.fillStyle = PDF_COLORS.primary;
  ctx.beginPath();
  ctx.arc(badgeCx, badgeCy, badgeSize / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 17px Geeza Pro, Cairo, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(String(obsNumber), badgeCx, badgeCy + 6);

  ctx.fillStyle = PDF_COLORS.text;
  ctx.font = "700 22px Geeza Pro, Cairo, Arial, sans-serif";
  ctx.direction = isRtl ? "rtl" : "ltr";
  ctx.textAlign = isRtl ? "right" : "left";
  const headingX = isRtl ? badgeX - 15 : badgeX + badgeSize + 15;
  ctx.fillText((lang === "ar" ? "ملاحظة رقم " : "Observation #") + obsNumber, headingX, badgeCy + 7);

  let cursorY = y + BADGE_ROW_H;

  const photos = obsPhotos(obs);
  const settings = report.photoSettings || defaultPhotoSettings();
  if (photos.length) {
    const gap = 10;
    const cols = photos.length === 1 ? 1 : 2;
    const cellSize = photoCellSize(photos.length, w);
    const rowWidth = cols * cellSize + gap * (cols - 1);
    const startX = x + (w - rowWidth) / 2; // center the (possibly capped) square row
    for (let i = 0; i < photos.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cellX = startX + col * (cellSize + gap);
      const cellY = cursorY + row * (cellSize + gap);
      try {
        let blobToDraw = photos[i].blob;
        if (settings.enabled && settings.pdfImageType !== "original") {
          const lines = buildOverlayLines(report, obsNumber, settings, photos[i].takenAt, lang);
          if (lines.length) blobToDraw = await createDocumentedPhoto(photos[i].blob, lines, isRtl);
        }
        const img = await loadImageFromBlob(blobToDraw);
        drawImageCover(ctx, img, cellX, cellY, cellSize, cellSize, 6);
      } catch (e) {
        console.warn("Could not draw photo in PDF:", e);
      }
    }
    const rows = Math.ceil(photos.length / cols);
    cursorY += rows * (cellSize + gap);
  } else {
    cursorY += 6;
  }

  const textCardH = Math.max(44, y + h - cursorY);
  const cardRadius = 8;

  ctx.fillStyle = PDF_COLORS.bgLight;
  roundRectPath(ctx, x, cursorY, w, textCardH, cardRadius);
  ctx.fill();
  ctx.strokeStyle = PDF_COLORS.border;
  ctx.lineWidth = 1;
  roundRectPath(ctx, x, cursorY, w, textCardH, cardRadius);
  ctx.stroke();

  // Flat accent bar on the reading-start edge
  ctx.save();
  roundRectPath(ctx, x, cursorY, w, textCardH, cardRadius);
  ctx.clip();
  ctx.fillStyle = PDF_COLORS.primary;
  const barW = 4;
  ctx.fillRect(isRtl ? x + w - barW : x, cursorY, barW, textCardH);
  ctx.restore();

  const textStartPad = TEXT_PADDING + barW + 6;
  ctx.font = `${TEXT_LINE_HEIGHT - 8}px Geeza Pro, Cairo, Arial, sans-serif`;
  const maxLines = Math.max(1, Math.floor((textCardH - TEXT_PADDING * 2) / TEXT_LINE_HEIGHT));
  let lines = wrapText(ctx, obs.text || "", w - TEXT_PADDING - textStartPad);
  lines = truncateLines(lines, maxLines);

  ctx.fillStyle = PDF_COLORS.text;
  ctx.direction = isRtl ? "rtl" : "ltr";
  ctx.textAlign = isRtl ? "right" : "left";
  let textY = cursorY + TEXT_PADDING + 16;
  lines.forEach((line) => {
    ctx.fillText(line, isRtl ? x + w - textStartPad : x + textStartPad, textY);
    textY += TEXT_LINE_HEIGHT;
  });
}

async function generatePdf(report) {
  await ensureFontsLoaded();

  const lang = document.documentElement.lang === "en" ? "en" : "ar";
  const isRtl = document.documentElement.dir === "rtl";
  const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

  const contentWidth = PAGE_W - MARGIN * 2;
  const cardWidth = (contentWidth - COL_GAP * (GRID_COLS - 1)) / GRID_COLS;
  const observations = report.observations;
  const pageBottom = PAGE_H - FOOTER_RESERVE;

  // colIndex 0 is the "first" reading position — right-hand column in
  // RTL, left-hand column in LTR.
  const colX = (colIndex) =>
    isRtl
      ? MARGIN + contentWidth - cardWidth - colIndex * (cardWidth + COL_GAP)
      : MARGIN + colIndex * (cardWidth + COL_GAP);

  let pageIndex = 0;
  let { canvas, ctx } = newPageCanvas();
  let y = drawFirstPageHeader(ctx, report, isRtl, lang);
  let isFirstRowOnPage = true;

  const finishPage = () => {
    drawFooter(ctx, pageIndex + 1, isRtl, report.title);
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.97), "JPEG", 0, 0, 210, 297);
  };

  for (let i = 0; i < observations.length; i += GRID_COLS) {
    const rowObs = observations.slice(i, i + GRID_COLS);
    const heights = rowObs.map((obs) => measureObservationHeight(ctx, obs, cardWidth).height);
    const rowHeight = Math.max(...heights);
    let rowY = isFirstRowOnPage ? y : y + ROW_GAP;

    if (rowY + rowHeight > pageBottom && !isFirstRowOnPage) {
      finishPage();
      pdf.addPage();
      pageIndex++;
      ({ canvas, ctx } = newPageCanvas());
      y = drawRunningHeader(ctx, report, isRtl);
      isFirstRowOnPage = true;
      rowY = y;
    } else if (!isFirstRowOnPage) {
      // Continuing on the same page — draw a divider before this row.
      ctx.strokeStyle = PDF_COLORS.border;
      ctx.lineWidth = 1;
      const lineY = y + ROW_GAP / 2;
      ctx.beginPath();
      ctx.moveTo(MARGIN, lineY);
      ctx.lineTo(PAGE_W - MARGIN, lineY);
      ctx.stroke();
    }

    for (let c = 0; c < rowObs.length; c++) {
      await drawObservationSlot(ctx, report, rowObs[c], i + c + 1, colX(c), rowY, cardWidth, rowHeight, isRtl, lang);
    }

    y = rowY + rowHeight;
    isFirstRowOnPage = false;
  }

  finishPage();

  const fileName = `Safety_Report_${sanitizeFileName(report.location)}_${report.date}.pdf`;
  const blob = pdf.output("blob");
  return { blob, fileName };
}
