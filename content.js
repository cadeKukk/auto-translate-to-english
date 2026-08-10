// Content script: finds text on the page, sends it for translation,
// and seamlessly replaces it with English in place.

(() => {
  // If a previous copy of this script is present, only defer to it when its
  // extension context is still valid. After the extension is reloaded, old
  // copies are orphaned (their chrome.runtime is dead) and must be replaced.
  const prev = window.__autoTranslateInstance;
  if (prev) {
    let alive = false;
    try {
      alive = prev.isAlive();
    } catch {
      alive = false;
    }
    if (alive) return;
    try {
      prev.teardown();
    } catch {
      // Orphaned instance with nothing to clean up.
    }
  }
  const myRuntime = chrome.runtime;
  window.__autoTranslateInstance = {
    isAlive: () => {
      try {
        return !!myRuntime.id;
      } catch {
        return false;
      }
    },
    teardown: () => teardownInstance(),
  };

  // ---------- State ----------

  const state = {
    enabled: true,
    siteDisabled: false,
    translateImages: true,
    showingOriginal: false,
    running: false,
    detectedLang: null, // page-level detected language code (advisory)
    pageLikelyEnglish: false,
    translatedCount: 0,
    imagesTranslated: 0,
    status: "idle", // idle | detecting | translating | done | english | disabled | error
  };

  const HOST = location.hostname;

  // Every replacement we make, so we can restore originals.
  // { node, original, translated, attr } — attr is null for text nodes.
  const records = [];
  const textRecords = new WeakMap(); // text node -> its record (so re-translations update in place)
  const processedTextNodes = new WeakSet();
  const processedAttrs = new WeakSet(); // elements whose attrs were handled

  // Values we wrote ourselves, so the MutationObserver can tell our own
  // writes apart from the page's framework updating text.
  const selfWrites = new WeakMap();

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "CODE", "PRE", "KBD", "SAMP",
    "TEXTAREA", "INPUT", "SELECT", "OPTION", "IFRAME", "OBJECT", "EMBED",
    "CANVAS", "SVG", "MATH", "TIME", "VAR",
  ]);

  const ATTR_TARGETS = [
    { selector: "[placeholder]", attr: "placeholder" },
    { selector: "img[alt]", attr: "alt" },
    { selector: "[title]", attr: "title" },
  ];

  // ---------- Helpers ----------

  const LETTER_RE = /\p{L}/u;
  const NON_LATIN_LETTER_RE = /(?![\p{Script=Latin}])\p{L}/u;
  const URL_LIKE_RE = /^(https?:\/\/|www\.)\S+$/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function isTranslatableText(text) {
    const t = text.trim();
    if (t.length < 2) return false;
    if (!LETTER_RE.test(t)) return false; // no letters at all (numbers, symbols)
    if (URL_LIKE_RE.test(t) || EMAIL_RE.test(t)) return false;
    // On pages that are reliably English overall, only bother with segments
    // containing non-Latin-script letters (CJK, Cyrillic, Arabic, ...).
    if (state.pageLikelyEnglish && !NON_LATIN_LETTER_RE.test(t)) return false;
    return true;
  }

  function isSkippableElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute && el.getAttribute("translate") === "no") return true;
    if (el.classList && el.classList.contains("notranslate")) return true;
    return false;
  }

  function hasSkippableAncestor(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el) {
      if (isSkippableElement(el)) return true;
      // Step out of shadow roots into their hosts.
      el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    }
    return false;
  }

  // Collects candidate text nodes, descending into open shadow roots.
  function collectTextNodes(root) {
    const nodes = [];
    const visit = (r) => {
      const walker = document.createTreeWalker(
        r,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (isSkippableElement(node)) return NodeFilter.FILTER_REJECT;
              if (node.shadowRoot) {
                visit(node.shadowRoot);
                observeRoot(node.shadowRoot);
              }
              return NodeFilter.FILTER_SKIP;
            }
            if (processedTextNodes.has(node)) return NodeFilter.FILTER_REJECT;
            if (!isTranslatableText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );
      let n;
      while ((n = walker.nextNode())) nodes.push(n);
    };
    if (root.nodeType === Node.TEXT_NODE) {
      if (
        !processedTextNodes.has(root) &&
        isTranslatableText(root.nodeValue) &&
        !hasSkippableAncestor(root)
      ) {
        nodes.push(root);
      }
      return nodes;
    }
    if (hasSkippableAncestor(root)) return nodes;
    visit(root);
    return nodes;
  }

  function collectAttrTargets(root) {
    const targets = [];
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
      return targets;
    }
    for (const { selector, attr } of ATTR_TARGETS) {
      const els = root.querySelectorAll ? root.querySelectorAll(selector) : [];
      for (const el of els) {
        if (processedAttrs.has(el)) continue;
        if (hasSkippableAncestor(el)) continue;
        const value = el.getAttribute(attr);
        if (value && isTranslatableText(value)) {
          targets.push({ el, attr, value });
        }
      }
      if (root.matches && root.matches(selector) && !processedAttrs.has(root)) {
        const value = root.getAttribute(attr);
        if (value && isTranslatableText(value)) {
          targets.push({ el: root, attr, value });
        }
      }
    }
    return targets;
  }

  function sendTranslate(texts) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "translate", texts }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.ok) {
          resolve(response.results);
        } else {
          reject(new Error((response && response.error) || "Translation failed"));
        }
      });
    });
  }

  // Preserve leading/trailing whitespace of the original node text.
  function withOriginalWhitespace(originalFull, translatedTrimmed) {
    const lead = originalFull.match(/^\s*/)[0];
    const trail = originalFull.match(/\s*$/)[0];
    return lead + translatedTrimmed + trail;
  }

  function detectPageLanguage() {
    return new Promise((resolve) => {
      let sample = "";
      try {
        sample = (document.body && document.body.innerText) || "";
      } catch {
        sample = "";
      }
      sample = sample.replace(/\s+/g, " ").slice(0, 2000);
      if (!sample || !chrome.i18n || !chrome.i18n.detectLanguage) {
        const htmlLang = (document.documentElement.lang || "").toLowerCase();
        resolve({ lang: htmlLang.split("-")[0] || "und", reliable: false });
        return;
      }
      chrome.i18n.detectLanguage(sample, (result) => {
        if (chrome.runtime.lastError || !result || !result.languages.length) {
          resolve({ lang: "und", reliable: false });
          return;
        }
        const top = result.languages[0];
        resolve({
          lang: top.language,
          reliable: result.isReliable && top.percentage >= 90,
        });
      });
    });
  }

  function setTextNodeValue(node, value) {
    selfWrites.set(node, value);
    node.nodeValue = value;
  }

  // ---------- Core translation pass ----------

  async function translateBatchOfItems(items) {
    // items: [{ kind: "text", node } | { kind: "attr", el, attr, value }]
    if (items.length === 0) return;

    // Deduplicate identical strings to save bandwidth.
    const uniqueTexts = [];
    const textToSlot = new Map();
    const itemSlots = items.map((item) => {
      const raw = item.kind === "text" ? item.node.nodeValue : item.value;
      const trimmed = raw.trim();
      if (!textToSlot.has(trimmed)) {
        textToSlot.set(trimmed, uniqueTexts.length);
        uniqueTexts.push(trimmed);
      }
      return textToSlot.get(trimmed);
    });

    const results = await sendTranslate(uniqueTexts);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const result = results[itemSlots[i]];
      if (!result || result.error) {
        // Request failed (rate limit, network blip) — retry later instead of
        // leaving this text untranslated forever.
        requeueItem(item);
        continue;
      }

      // If the source is already English (or translation is identical), leave it.
      const detected = (result.lang || "und").toLowerCase();
      if (detected === "en") continue;
      const translated = result.text;
      if (!translated) continue;

      if (item.kind === "text") {
        const node = item.node;
        if (!node.isConnected) continue;
        const original = node.nodeValue;
        if (translated === original.trim()) continue;
        const finalText = withOriginalWhitespace(original, translated);
        setTextNodeValue(node, finalText);

        const existing = textRecords.get(node);
        if (existing) {
          existing.original = original;
          existing.translated = finalText;
        } else {
          const record = { node, original, translated: finalText, attr: null };
          records.push(record);
          textRecords.set(node, record);
          state.translatedCount++;
        }
      } else {
        const { el, attr } = item;
        if (!el.isConnected) continue;
        const original = el.getAttribute(attr);
        if (original === null || translated === original.trim()) continue;
        el.setAttribute(attr, translated);
        records.push({ node: el, original, translated, attr });
        state.translatedCount++;
      }
    }
  }

  async function translateItems(items) {
    // Process in slices so huge pages render progressively.
    const SLICE = 300;
    for (let i = 0; i < items.length; i += SLICE) {
      if (!state.enabled || state.siteDisabled) return;
      const slice = items.slice(i, i + SLICE);
      try {
        await translateBatchOfItems(slice);
      } catch (err) {
        // Whole batch failed — put every item back in the queue for retry.
        for (const item of slice) requeueItem(item);
        console.warn("[Auto Translate] batch failed, will retry:", err);
      }
    }
  }

  function gatherItems(root) {
    const items = [];
    for (const node of collectTextNodes(root)) {
      processedTextNodes.add(node);
      items.push({ kind: "text", node });
    }
    for (const t of collectAttrTargets(root)) {
      processedAttrs.add(t.el);
      items.push({ kind: "attr", ...t });
    }
    return items;
  }

  async function runFullTranslation() {
    if (state.running || !state.enabled || state.siteDisabled) return;
    state.running = true;
    state.status = "detecting";

    // Watch for dynamic content no matter how the initial pass goes —
    // many pages render their real content well after load.
    startObserver();

    try {
      const detection = await detectPageLanguage();
      state.detectedLang = detection.lang;
      // Advisory only: used to filter obviously-English segments, never to
      // skip the page outright (mixed-language pages would be missed).
      state.pageLikelyEnglish = detection.lang === "en" && detection.reliable;

      state.status = "translating";
      // Images register after detection so OCR knows which language to expect.
      registerImages(document.body);
      await translateItems(gatherItems(document.body));
      state.status = state.translatedCount === 0 && state.pageLikelyEnglish ? "english" : "done";
    } catch (err) {
      state.status = "error";
      console.warn("[Auto Translate] failed:", err);
    } finally {
      state.running = false;
    }
  }

  // ---------- Dynamic content ----------

  let observer = null;
  const observedRoots = new WeakSet();
  let pendingRoots = new Set();
  let flushTimer = null;
  let scrollTimer = null;
  let rescanning = false;

  const retryCounts = new WeakMap();
  const MAX_RETRIES = 3;

  const OBSERVER_CONFIG = { childList: true, subtree: true, characterData: true };

  function scheduleFlush(delay = 350) {
    if (flushTimer) return;
    flushTimer = setTimeout(flushPending, delay);
  }

  // Put a failed item back in the queue with backoff, up to MAX_RETRIES.
  function requeueItem(item) {
    const key = item.kind === "text" ? item.node : item.el;
    if (!key.isConnected) return;
    const tries = (retryCounts.get(key) || 0) + 1;
    if (tries > MAX_RETRIES) return;
    retryCounts.set(key, tries);
    if (item.kind === "text") processedTextNodes.delete(item.node);
    else processedAttrs.delete(item.el);
    pendingRoots.add(key);
    scheduleFlush(1200 * tries);
  }

  function ensureObserver() {
    if (observer) return observer;
    observer = new MutationObserver(onMutations);
    return observer;
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    ensureObserver().observe(root, OBSERVER_CONFIG);
  }

  function startObserver() {
    if (document.body) observeRoot(document.body);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  }

  // Called by a newer copy of this script replacing an orphaned one.
  function teardownInstance() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }
    if (imageObserver) {
      imageObserver.disconnect();
      imageObserver = null;
    }
    window.removeEventListener("scroll", onScroll, true);
  }

  function onMutations(mutations) {
    if (!state.enabled || state.siteDisabled || state.showingOriginal) return;
    for (const m of mutations) {
      if (m.type === "characterData") {
        const node = m.target;
        if (node.nodeType !== Node.TEXT_NODE) continue;
        // Ignore mutations caused by our own writes.
        if (selfWrites.get(node) === node.nodeValue) continue;
        // The page changed this text after we processed it — do it again.
        processedTextNodes.delete(node);
        pendingRoots.add(node);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          pendingRoots.add(node);
        }
      }
    }
    if (pendingRoots.size > 0) scheduleFlush();
  }

  // Safety net for content the observer can miss (late-attached shadow
  // roots, virtualized lists): rescan the page after scrolling settles.
  // Capture phase so scrolls inside nested containers are seen too.
  function onScroll() {
    if (!state.enabled || state.siteDisabled || state.showingOriginal) return;
    if (scrollTimer) return;
    scrollTimer = setTimeout(async () => {
      scrollTimer = null;
      if (rescanning || !document.body) return;
      rescanning = true;
      try {
        registerImages(document.body);
        const items = gatherItems(document.body);
        if (items.length > 0) {
          await translateItems(items);
          if (state.status === "english" && state.translatedCount > 0) state.status = "done";
        }
      } finally {
        rescanning = false;
      }
    }, 500);
  }

  async function flushPending() {
    flushTimer = null;
    const roots = [...pendingRoots];
    pendingRoots = new Set();

    const items = [];
    for (const root of roots) {
      if (!root.isConnected) continue;
      items.push(...gatherItems(root));
      registerImages(root);
    }

    if (items.length === 0) return;
    try {
      await translateItems(items);
      if (state.status === "english" && state.translatedCount > 0) state.status = "done";
    } catch (err) {
      console.warn("[Auto Translate] dynamic content failed:", err);
    }
  }

  // ---------- Images (OCR) ----------

  const processedImages = new WeakSet();
  let imageObserver = null;
  const imageQueue = [];
  let imageQueueRunning = false;
  let imagesStarted = 0;
  const MAX_IMAGES_PER_PAGE = 40;

  function imageTranslationActive() {
    return state.translateImages && state.enabled && !state.siteDisabled;
  }

  function imageEligible(img) {
    const src = img.currentSrc || img.src || "";
    if (!/^(https?:|data:image\/)/.test(src)) return false;
    if (src.startsWith("data:image/svg")) return false;
    if (hasSkippableAncestor(img)) return false;
    const rect = img.getBoundingClientRect();
    // Skip icons and thumbnails — too small to hold readable text.
    return rect.width >= 100 && rect.height >= 50;
  }

  function ensureImageObserver() {
    if (imageObserver) return imageObserver;
    // OCR is expensive, so only process images that come near the viewport.
    imageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target;
          imageObserver.unobserve(img);
          if (!imageTranslationActive() || processedImages.has(img)) continue;
          if (!imageEligible(img)) continue;
          if (imagesStarted >= MAX_IMAGES_PER_PAGE) continue;
          processedImages.add(img);
          imagesStarted++;
          imageQueue.push(img);
          pumpImageQueue();
        }
      },
      { rootMargin: "300px" }
    );
    return imageObserver;
  }

  function registerImages(root) {
    if (!imageTranslationActive() || !root) return;
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    const obs = ensureImageObserver();
    if (root.tagName === "IMG") {
      if (!processedImages.has(root)) obs.observe(root);
      return;
    }
    const imgs = root.querySelectorAll ? root.querySelectorAll("img") : [];
    for (const img of imgs) {
      if (!processedImages.has(img)) obs.observe(img);
    }
  }

  async function pumpImageQueue() {
    if (imageQueueRunning) return;
    imageQueueRunning = true;
    try {
      while (imageQueue.length > 0) {
        if (!imageTranslationActive()) {
          imageQueue.length = 0;
          break;
        }
        const img = imageQueue.shift();
        try {
          await translateImage(img);
        } catch (err) {
          console.debug("[Auto Translate] image skipped:", err.message);
        }
      }
    } finally {
      imageQueueRunning = false;
    }
  }

  function sendTranslateImage(src) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "translateImage", src, pageLang: state.detectedLang },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.ok) {
            resolve(response);
          } else {
            reject(new Error((response && response.error) || "Image translation failed"));
          }
        }
      );
    });
  }

  // Repaints one recognized text line: covers the original text with the
  // surrounding background color, then draws the English on top.
  function paintLine(ctx, canvas, line) {
    const x0 = Math.max(0, Math.floor(line.bbox.x0 * canvas.width) - 2);
    const y0 = Math.max(0, Math.floor(line.bbox.y0 * canvas.height) - 2);
    const x1 = Math.min(canvas.width, Math.ceil(line.bbox.x1 * canvas.width) + 2);
    const y1 = Math.min(canvas.height, Math.ceil(line.bbox.y1 * canvas.height) + 2);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 8 || h < 8) return;

    // Average the pixels in a ring just outside the box to estimate the
    // background color behind the text.
    const pad = Math.max(2, Math.round(h * 0.2));
    const sx = Math.max(0, x0 - pad);
    const sy = Math.max(0, y0 - pad);
    const sw = Math.min(canvas.width - sx, w + pad * 2);
    const sh = Math.min(canvas.height - sy, h + pad * 2);
    let r = 240, g = 240, b = 240;
    try {
      const data = ctx.getImageData(sx, sy, sw, sh).data;
      let rs = 0, gs = 0, bs = 0, n = 0;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const isRing = x < pad || y < pad || x >= sw - pad || y >= sh - pad;
          if (!isRing) continue;
          const o = (y * sw + x) * 4;
          rs += data[o];
          gs += data[o + 1];
          bs += data[o + 2];
          n++;
        }
      }
      if (n > 0) {
        r = Math.round(rs / n);
        g = Math.round(gs / n);
        b = Math.round(bs / n);
      }
    } catch {
      // Keep the light-gray fallback if pixel access fails.
    }

    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(x0, y0, w, h);

    // Black or white text, whichever contrasts with the fill.
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    ctx.fillStyle = luminance > 140 ? "#111" : "#fff";

    let fontSize = Math.floor(h * 0.72);
    while (fontSize > 9) {
      ctx.font = `600 ${fontSize}px -apple-system, "Segoe UI", Arial, sans-serif`;
      if (ctx.measureText(line.translated).width <= w - 6) break;
      fontSize--;
    }
    ctx.textBaseline = "middle";
    ctx.fillText(line.translated, x0 + 3, y0 + h / 2 + 1, w - 6);
  }

  function applyImgTranslated(record) {
    for (const s of record.sources) s.el.removeAttribute("srcset");
    record.node.removeAttribute("srcset");
    record.node.src = record.translated;
  }

  function applyImgOriginal(record) {
    for (const s of record.sources) {
      if (s.srcset != null) s.el.setAttribute("srcset", s.srcset);
    }
    if (record.originalSrcset != null) {
      record.node.setAttribute("srcset", record.originalSrcset);
    }
    if (record.originalSrcAttr != null) {
      record.node.setAttribute("src", record.originalSrcAttr);
    } else {
      record.node.removeAttribute("src");
    }
  }

  async function translateImage(img) {
    const src = img.currentSrc || img.src;
    if (!src) return;
    const payload = await sendTranslateImage(src);
    if (!payload.lines || payload.lines.length === 0 || !payload.dataUrl) return;
    if (!img.isConnected || state.showingOriginal) return;

    const base = new Image();
    base.src = payload.dataUrl;
    await base.decode();

    const canvas = document.createElement("canvas");
    canvas.width = base.naturalWidth;
    canvas.height = base.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(base, 0, 0);
    for (const line of payload.lines) paintLine(ctx, canvas, line);

    const record = {
      node: img,
      img: true,
      sources: [],
      originalSrcAttr: img.getAttribute("src"),
      originalSrcset: img.getAttribute("srcset"),
      original: src,
      translated: canvas.toDataURL("image/png"),
      attr: null,
    };
    // <source> elements inside <picture> override the img src.
    const picture = img.parentElement;
    if (picture && picture.tagName === "PICTURE") {
      for (const s of picture.querySelectorAll("source")) {
        record.sources.push({ el: s, srcset: s.getAttribute("srcset") });
      }
    }

    applyImgTranslated(record);
    records.push(record);
    state.imagesTranslated++;
    if (state.status === "english") state.status = "done";
  }

  function restoreImages() {
    for (const r of records) {
      if (r.img && r.node.isConnected) applyImgOriginal(r);
    }
  }

  // ---------- Restore / re-apply ----------

  function showOriginal() {
    for (const r of records) {
      if (!r.node.isConnected) continue;
      if (r.img) {
        applyImgOriginal(r);
      } else if (r.attr) {
        r.node.setAttribute(r.attr, r.original);
      } else {
        setTextNodeValue(r.node, r.original);
      }
    }
    state.showingOriginal = true;
  }

  function showTranslated() {
    for (const r of records) {
      if (!r.node.isConnected) continue;
      if (r.img) {
        applyImgTranslated(r);
      } else if (r.attr) {
        r.node.setAttribute(r.attr, r.translated);
      } else {
        setTextNodeValue(r.node, r.translated);
      }
    }
    state.showingOriginal = false;
  }

  // ---------- Settings & messaging ----------

  function loadSettingsAndStart() {
    chrome.storage.sync.get(
      { enabled: true, disabledSites: [], translateImages: true },
      (cfg) => {
        state.enabled = cfg.enabled;
        state.siteDisabled = cfg.disabledSites.includes(HOST);
        state.translateImages = cfg.translateImages;
        if (state.enabled && !state.siteDisabled) {
          runFullTranslation();
        } else {
          state.status = "disabled";
        }
      }
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let shouldStart = false;
    let shouldRestore = false;

    if (changes.enabled) {
      state.enabled = changes.enabled.newValue;
      if (state.enabled && !state.siteDisabled) shouldStart = true;
      if (!state.enabled) shouldRestore = true;
    }
    if (changes.disabledSites) {
      const nowDisabled = (changes.disabledSites.newValue || []).includes(HOST);
      if (nowDisabled !== state.siteDisabled) {
        state.siteDisabled = nowDisabled;
        if (nowDisabled) shouldRestore = true;
        else if (state.enabled) shouldStart = true;
      }
    }
    if (changes.translateImages) {
      state.translateImages = changes.translateImages.newValue;
      if (state.translateImages) {
        if (state.enabled && !state.siteDisabled) registerImages(document.body);
      } else {
        restoreImages();
      }
    }

    if (shouldRestore) {
      showOriginal();
      state.status = "disabled";
    } else if (shouldStart) {
      if (records.length > 0) showTranslated();
      state.status = "done";
      runFullTranslation();
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;
    switch (message.type) {
      case "getStatus":
        sendResponse({
          host: HOST,
          enabled: state.enabled,
          siteDisabled: state.siteDisabled,
          showingOriginal: state.showingOriginal,
          detectedLang: state.detectedLang,
          translatedCount: state.translatedCount,
          imagesTranslated: state.imagesTranslated,
          status: state.status,
        });
        break;
      case "toggleOriginal":
        if (state.showingOriginal) showTranslated();
        else showOriginal();
        sendResponse({ showingOriginal: state.showingOriginal });
        break;
      case "retranslate":
        runFullTranslation().then(() => sendResponse({ ok: true }));
        return true;
    }
  });

  // ---------- Boot ----------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadSettingsAndStart, { once: true });
  } else {
    loadSettingsAndStart();
  }
})();
