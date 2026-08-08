// Background service worker: handles translation requests from content scripts.
// Uses Google's public web translation endpoint (no API key required).

const BATCH_URL = "https://translate.googleapis.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=en";
const SINGLE_URL = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=";

// Limits per network request to keep URLs/bodies within safe sizes.
const MAX_ITEMS_PER_REQUEST = 128;
const MAX_CHARS_PER_REQUEST = 12000;

// Simple in-memory cache (per service-worker lifetime).
const cache = new Map();
const CACHE_MAX = 8000;

function cacheGet(text) {
  return cache.get(text);
}

function cacheSet(text, result) {
  if (cache.size >= CACHE_MAX) {
    // Drop oldest ~10% of entries.
    const drop = Math.floor(CACHE_MAX / 10);
    let i = 0;
    for (const key of cache.keys()) {
      cache.delete(key);
      if (++i >= drop) break;
    }
  }
  cache.set(text, result);
}

// Batch endpoint: POST q=...&q=... -> [["translated","detectedLang"], ...]
async function translateBatch(texts) {
  const body = texts.map((t) => "q=" + encodeURIComponent(t)).join("&");
  const res = await fetch(BATCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
  });
  if (!res.ok) throw new Error("Batch translate failed: HTTP " + res.status);
  const data = await res.json();

  // Normalize the response. With sl=auto each entry is [translated, detectedLang];
  // occasionally the API returns a bare string per entry.
  const list = Array.isArray(data) ? data : [data];
  return texts.map((original, i) => {
    const entry = list[i];
    if (Array.isArray(entry)) {
      return { text: String(entry[0] ?? original), lang: String(entry[1] ?? "und") };
    }
    if (typeof entry === "string") {
      return { text: entry, lang: "und" };
    }
    return { text: original, lang: "und" };
  });
}

// Fallback single-text endpoint.
async function translateSingle(text) {
  const res = await fetch(SINGLE_URL + encodeURIComponent(text));
  if (!res.ok) throw new Error("Single translate failed: HTTP " + res.status);
  const data = await res.json();
  const segments = (data && data[0]) || [];
  let out = "";
  for (const seg of segments) {
    if (seg && typeof seg[0] === "string") out += seg[0];
  }
  return { text: out || text, lang: (data && data[2]) || "und" };
}

function chunkTexts(texts) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const t of texts) {
    if (
      current.length > 0 &&
      (current.length >= MAX_ITEMS_PER_REQUEST || chars + t.length > MAX_CHARS_PER_REQUEST)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(t);
    chars += t.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function handleTranslate(texts) {
  const results = new Array(texts.length).fill(null);

  // Serve cached entries; collect the rest.
  const pendingIdx = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = cacheGet(texts[i]);
    if (hit) {
      results[i] = hit;
    } else {
      pendingIdx.push(i);
    }
  }

  if (pendingIdx.length > 0) {
    const pendingTexts = pendingIdx.map((i) => texts[i]);
    const chunks = chunkTexts(pendingTexts);

    let offset = 0;
    for (const chunk of chunks) {
      let translated;
      try {
        translated = await translateBatch(chunk);
      } catch (err) {
        // Fall back to per-item requests with limited concurrency.
        translated = [];
        const CONCURRENCY = 6;
        for (let s = 0; s < chunk.length; s += CONCURRENCY) {
          const slice = chunk.slice(s, s + CONCURRENCY);
          const settled = await Promise.allSettled(slice.map((t) => translateSingle(t)));
          for (let k = 0; k < settled.length; k++) {
            translated.push(
              settled[k].status === "fulfilled"
                ? settled[k].value
                : { text: slice[k], lang: "und", error: true }
            );
          }
        }
      }
      for (let j = 0; j < chunk.length; j++) {
        const idx = pendingIdx[offset + j];
        const r = translated[j] || { text: texts[idx], lang: "und", error: true };
        results[idx] = r;
        if (!r.error) cacheSet(texts[idx], r);
      }
      offset += chunk.length;
    }
  }

  return results;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "translate" && Array.isArray(message.texts)) {
    handleTranslate(message.texts)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response
  }
});
