// Content script: finds text on the page, sends it for translation,
// and seamlessly replaces it with English in place.

(() => {
  if (window.__autoTranslateInjected) return;
  window.__autoTranslateInjected = true;

  // ---------- State ----------

  const state = {
    enabled: true,
    siteDisabled: false,
    showingOriginal: false,
    running: false,
    detectedLang: null, // page-level detected language code
    translatedCount: 0,
    status: "idle", // idle | detecting | translating | done | english | disabled | error
  };

  const HOST = location.hostname;

  // Every replacement we make, so we can restore originals.
  // { node, original, translated, attr } — attr is null for text nodes.
  const records = [];
  const processedTextNodes = new WeakSet();
  const processedAttrs = new WeakSet(); // elements whose attrs were handled

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
  const URL_LIKE_RE = /^(https?:\/\/|www\.)\S+$/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function isTranslatableText(text) {
    const t = text.trim();
    if (t.length < 2) return false;
    if (!LETTER_RE.test(t)) return false; // no letters at all (numbers, symbols)
    if (URL_LIKE_RE.test(t) || EMAIL_RE.test(t)) return false;
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
      el = el.parentElement;
    }
    return false;
  }

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (processedTextNodes.has(node)) return NodeFilter.FILTER_REJECT;
        if (!isTranslatableText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (hasSkippableAncestor(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
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
        resolve({ lang: htmlLang.split("-")[0] || "und", reliable: !!htmlLang });
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
          reliable: result.isReliable && top.percentage >= 80,
        });
      });
    });
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
      if (!result || result.error) continue;

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
        node.nodeValue = finalText;
        records.push({ node, original, translated: finalText, attr: null });
        state.translatedCount++;
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

  async function translateRoot(root) {
    const textNodes = collectTextNodes(root);
    const attrTargets = collectAttrTargets(root);

    // Mark as processed up front so overlapping passes don't double-handle.
    const items = [];
    for (const node of textNodes) {
      processedTextNodes.add(node);
      items.push({ kind: "text", node });
    }
    for (const t of attrTargets) {
      processedAttrs.add(t.el);
      items.push({ kind: "attr", ...t });
    }

    // Process in slices so huge pages render progressively.
    const SLICE = 300;
    for (let i = 0; i < items.length; i += SLICE) {
      if (!state.enabled || state.siteDisabled) return;
      await translateBatchOfItems(items.slice(i, i + SLICE));
    }
  }

  async function runFullTranslation() {
    if (state.running || !state.enabled || state.siteDisabled) return;
    state.running = true;
    state.status = "detecting";

    try {
      const detection = await detectPageLanguage();
      state.detectedLang = detection.lang;

      // Skip pages that are reliably already in English.
      if (detection.lang === "en" && detection.reliable) {
        state.status = "english";
        state.running = false;
        return;
      }

      state.status = "translating";
      await translateRoot(document.body);
      state.status = "done";
      startObserver();
    } catch (err) {
      state.status = "error";
      console.warn("[Auto Translate] failed:", err);
    } finally {
      state.running = false;
    }
  }

  // ---------- Dynamic content ----------

  let observer = null;
  let pendingRoots = new Set();
  let flushTimer = null;

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      if (!state.enabled || state.siteDisabled || state.showingOriginal) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
            pendingRoots.add(node);
          }
        }
      }
      if (pendingRoots.size > 0 && !flushTimer) {
        flushTimer = setTimeout(flushPending, 350);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function flushPending() {
    flushTimer = null;
    const roots = [...pendingRoots];
    pendingRoots = new Set();

    const items = [];
    for (const root of roots) {
      if (!root.isConnected) continue;
      if (root.nodeType === Node.TEXT_NODE) {
        if (
          !processedTextNodes.has(root) &&
          isTranslatableText(root.nodeValue) &&
          !hasSkippableAncestor(root)
        ) {
          processedTextNodes.add(root);
          items.push({ kind: "text", node: root });
        }
        continue;
      }
      if (hasSkippableAncestor(root)) continue;
      for (const node of collectTextNodes(root)) {
        processedTextNodes.add(node);
        items.push({ kind: "text", node });
      }
      for (const t of collectAttrTargets(root)) {
        processedAttrs.add(t.el);
        items.push({ kind: "attr", ...t });
      }
    }

    if (items.length === 0) return;
    try {
      const SLICE = 300;
      for (let i = 0; i < items.length; i += SLICE) {
        await translateBatchOfItems(items.slice(i, i + SLICE));
      }
      if (state.status === "english") state.status = "done";
    } catch (err) {
      console.warn("[Auto Translate] dynamic content failed:", err);
    }
  }

  // ---------- Restore / re-apply ----------

  function showOriginal() {
    for (const r of records) {
      if (!r.node.isConnected) continue;
      if (r.attr) {
        r.node.setAttribute(r.attr, r.original);
      } else {
        r.node.nodeValue = r.original;
      }
    }
    state.showingOriginal = true;
  }

  function showTranslated() {
    for (const r of records) {
      if (!r.node.isConnected) continue;
      if (r.attr) {
        r.node.setAttribute(r.attr, r.translated);
      } else {
        r.node.nodeValue = r.translated;
      }
    }
    state.showingOriginal = false;
  }

  // ---------- Settings & messaging ----------

  function loadSettingsAndStart() {
    chrome.storage.sync.get({ enabled: true, disabledSites: [] }, (cfg) => {
      state.enabled = cfg.enabled;
      state.siteDisabled = cfg.disabledSites.includes(HOST);
      if (state.enabled && !state.siteDisabled) {
        runFullTranslation();
      } else {
        state.status = "disabled";
      }
    });
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
