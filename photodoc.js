// ---------------------------------------------------------------------
// photodoc.js
// Builds a "documented" copy of a photo (original + a text overlay with
// school/date/observation number/etc.) without ever touching the
// original Blob, and handles saving/sharing photos on iPhone Safari.
//
// iOS note: there is no web API that writes directly into the Photos
// library. The reliable, honest approach is the Web Share API
// (navigator.share with files), which opens the native iOS share
// sheet — the user picks "Save Image" themselves. If the browser
// doesn't support sharing files, we fall back to opening the image in
// a new tab so the user can long-press → Save Image manually.
// ---------------------------------------------------------------------

function defaultPhotoSettings() {
  return {
    enabled: true,
    showSchool: true,
    showDate: true,
    showObsNumber: true,
    showTime: false,
    showInspector: false,
    inspectorName: "",
    pdfImageType: "documented" // "documented" | "original"
  };
}

function buildOverlayLines(report, obsNumber, settings, takenAt, lang) {
  const lines = [];
  if (settings.showSchool && report.location) lines.push(report.location);
  if (settings.showDate && report.date) lines.push(report.date);
  if (settings.showObsNumber) {
    lines.push((lang === "ar" ? "الملاحظة رقم " : "Observation #") + String(obsNumber).padStart(2, "0"));
  }
  if (settings.showTime && takenAt) {
    const d = new Date(takenAt);
    lines.push(d.toLocaleTimeString(lang === "ar" ? "ar-SA" : "en-US", { hour: "2-digit", minute: "2-digit" }));
  }
  if (settings.showInspector && settings.inspectorName) lines.push(settings.inspectorName);
  return lines;
}

// Documented photos are output as a fixed 1080×1080 square (cropped to
// fill, never stretched) so the info bar is always clearly visible and
// every photo in the report looks consistent — regardless of whether
// the original photo was portrait, landscape, or an odd shape. The
// original Blob is never touched; this only affects the generated copy.
const DOCUMENTED_SIZE = 1440;

// Draws a semi-transparent bar with the given lines onto a square,
// cover-cropped copy of the image. Returns a new Blob — the source
// blob is never modified.
function createDocumentedPhoto(sourceBlob, lines, isRtl) {
  return new Promise((resolve, reject) => {
    if (!lines.length) { resolve(sourceBlob); return; }
    const img = new Image();
    img.onerror = reject;
    img.onload = () => {
      const size = DOCUMENTED_SIZE;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");

      // Cover-fit crop, centered, so nothing important is cut off any
      // more than a normal "fill the frame" crop would.
      const imgRatio = img.width / img.height;
      let sx, sy, sw, sh;
      if (imgRatio > 1) {
        sh = img.height;
        sw = img.height;
        sx = (img.width - sw) / 2;
        sy = 0;
      } else {
        sw = img.width;
        sh = img.width;
        sx = 0;
        sy = (img.height - sh) / 2;
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);

      const fontSize = Math.max(24, Math.round(size * 0.032));
      const lineGap = Math.round(fontSize * 0.5);
      const paddingY = Math.round(fontSize * 0.6);
      const barHeight = lines.length * (fontSize + lineGap) + paddingY * 2 - lineGap;
      const barY = size - barHeight;

      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, barY, size, barHeight);

      ctx.fillStyle = "#ffffff";
      ctx.direction = isRtl ? "rtl" : "ltr";
      ctx.textAlign = isRtl ? "right" : "left";
      ctx.font = `600 ${fontSize}px Geeza Pro, Cairo, Arial, sans-serif`;
      const paddingX = Math.round(size * 0.025);
      let ty = barY + paddingY + fontSize * 0.8;
      lines.forEach((line) => {
        ctx.fillText(line, isRtl ? size - paddingX : paddingX, ty);
        ty += fontSize + lineGap;
      });

      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/jpeg", 0.95);
    };
    img.src = URL.createObjectURL(sourceBlob);
  });
}

// Returns "shared" | "cancelled" | "fallback"
async function sharePhotoBlob(blob, filename) {
  try {
    const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return "shared";
    }
  } catch (e) {
    if (e.name === "AbortError") return "cancelled";
    console.warn("Share failed, falling back to opening the image:", e);
  }
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  return "fallback";
}
