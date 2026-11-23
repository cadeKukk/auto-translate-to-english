// Offscreen document: runs Tesseract OCR on images. Service workers can't
// host the OCR engine (it needs Web Workers + wasm), so this page does.

const OCR_MAX_DIM = 1600; // downscale for recognition speed
const RETURN_MAX_DIM = 2000; // cap on the image we hand back for repainting
const MIN_LINE_CONFIDENCE = 55;

// One Tesseract worker per language combination, reused across requests.
const workers = new Map();
let idleTimer = null;

function scheduleWorkerCleanup() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    for (const [key, workerPromise] of workers) {
      workers.delete(key);
      try {
        (await workerPromise).terminate();
      } catch {
        // already gone
      }
    }
  }, 90_000);
}

function getWorker(langs) {
  if (!workers.has(langs)) {
    workers.set(
      langs,
      Tesseract.createWorker(langs, 1, {
        workerPath: chrome.runtime.getURL("vendor/worker.min.js"),
        // Load the worker file directly. Tesseract's default wraps it in a
        // blob: worker, and importScripts() of an extension URL fails there.
        workerBlobURL: false,
        corePath: chrome.runtime.getURL("vendor/tesseract-core-simd-lstm.wasm.js"),
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
        gzip: true,
      })
    );
  }
  return workers.get(langs);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image failed to decode"));
    img.src = url;
  });
}

function drawScaled(img, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function ocrImage(src, langs) {
  const res = await fetch(src);
  if (!res.ok) throw new Error("Image fetch failed: HTTP " + res.status);
  const blob = await res.blob();
  if (blob.size > 15_000_000) throw new Error("Image too large");
  if (blob.type === "image/svg+xml") throw new Error("SVG images not supported");

  const objectUrl = URL.createObjectURL(blob);
  let img;
  try {
    img = await loadImage(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const ocrCanvas = drawScaled(img, OCR_MAX_DIM);
  const worker = await getWorker(langs);
  const { data } = await worker.recognize(ocrCanvas.toDataURL("image/png"));
  scheduleWorkerCleanup();

  const lines = [];
  for (const line of data.lines || []) {
    const text = (line.text || "").trim();
    if (text.length < 2 || line.confidence < MIN_LINE_CONFIDENCE) continue;
    if (!/\p{L}/u.test(text)) continue;
    // Normalize bbox to 0..1 so it applies at any resolution.
    lines.push({
      text,
      confidence: line.confidence,
      bbox: {
        x0: line.bbox.x0 / ocrCanvas.width,
        y0: line.bbox.y0 / ocrCanvas.height,
        x1: line.bbox.x1 / ocrCanvas.width,
        y1: line.bbox.y1 / ocrCanvas.height,
      },
    });
  }

  if (lines.length === 0) return { lines: [] };

  // Hand back a repaint-ready copy of the image. Keep PNG for formats that
  // may carry transparency; JPEG otherwise to keep the payload small.
  const outCanvas = drawScaled(img, RETURN_MAX_DIM);
  const usePng = /png|webp|gif/.test(blob.type);
  const dataUrl = usePng
    ? outCanvas.toDataURL("image/png")
    : outCanvas.toDataURL("image/jpeg", 0.92);

  return { lines, dataUrl };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen" || message.type !== "ocr") return;
  ocrImage(message.src, message.langs)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // async response
});
