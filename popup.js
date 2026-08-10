const globalToggle = document.getElementById("globalToggle");
const siteToggle = document.getElementById("siteToggle");
const imagesToggle = document.getElementById("imagesToggle");
const siteHost = document.getElementById("siteHost");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const statusDetail = document.getElementById("statusDetail");
const originalBtn = document.getElementById("originalBtn");
const retranslateBtn = document.getElementById("retranslateBtn");

let currentHost = null;
let currentTabId = null;
let urlAllowed = false;
let injectionTried = false;
let pollTimer = null;

const langNames = new Intl.DisplayNames(["en"], { type: "language" });

function languageName(code) {
  if (!code || code === "und") return "Unknown language";
  try {
    return langNames.of(code);
  } catch {
    return code;
  }
}

function setStatus(dotClass, text, detail) {
  statusDot.className = "status-dot " + dotClass;
  statusText.textContent = text;
  statusDetail.textContent = detail || "";
}

function queryContentScript(message) {
  return new Promise((resolve) => {
    if (currentTabId === null) {
      resolve(null);
      return;
    }
    chrome.tabs.sendMessage(currentTabId, message, { frameId: 0 }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

// Content scripts die when the extension is reloaded/updated, and pages
// opened before install never got one. Inject on demand so the popup
// works without requiring the user to refresh the tab.
async function ensureContentScript() {
  if (injectionTried || currentTabId === null || !urlAllowed) return false;
  injectionTried = true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTabId, allFrames: true },
      files: ["content.js"],
    });
    return true;
  } catch {
    return false; // page is restricted (Web Store, file access disabled, etc.)
  }
}

function renderStatus(s) {
  if (!s) {
    if (!urlAllowed) {
      setStatus(
        "off",
        "Chrome doesn't allow extensions here",
        "Chrome pages, the Web Store, and PDFs can't be translated."
      );
    } else {
      setStatus("off", "Couldn't reach this page", "Refresh the tab and try again.");
    }
    originalBtn.disabled = true;
    retranslateBtn.disabled = true;
    return;
  }

  currentHost = s.host;
  siteHost.textContent = s.host;
  siteToggle.checked = !s.siteDisabled;
  siteToggle.disabled = !globalToggle.checked;

  const lang = languageName(s.detectedLang);
  const count = s.translatedCount;
  const images = s.imagesTranslated || 0;
  const doneDetail =
    [
      count > 0 ? `${count} text segments replaced` : "",
      images > 0 ? `${images} image${images === 1 ? "" : "s"} repainted` : "",
    ]
      .filter(Boolean)
      .join(", ") || "";

  switch (s.status) {
    case "detecting":
      setStatus("busy", "Detecting language\u2026");
      break;
    case "translating":
      setStatus("busy", "Translating\u2026", count > 0 ? `${count} segments so far` : "");
      break;
    case "done":
      setStatus(
        "ok",
        count > 0 || images > 0 ? `Translated from ${lang}` : "Nothing needed translating",
        doneDetail
      );
      break;
    case "english":
      setStatus("ok", "Already in English", "No translation needed.");
      break;
    case "disabled":
      setStatus("off", "Translation is off", "Turn it on with the switches below.");
      break;
    case "error":
      setStatus("error", "Translation failed", "Check your connection and try again.");
      break;
    default:
      setStatus("off", "Waiting\u2026");
  }

  originalBtn.disabled = count === 0 && images === 0;
  originalBtn.textContent = s.showingOriginal ? "Show translation" : "Show original";
  retranslateBtn.disabled = !s.enabled || s.siteDisabled;
}

async function refreshStatus() {
  let s = await queryContentScript({ type: "getStatus" });
  if (!s && (await ensureContentScript())) {
    // Give the fresh script a moment to boot, then ask again.
    await new Promise((r) => setTimeout(r, 250));
    s = await queryContentScript({ type: "getStatus" });
  }
  renderStatus(s);
  // Keep polling while the page is actively being translated.
  if (s && (s.status === "detecting" || s.status === "translating")) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(refreshStatus, 600);
  }
}

async function init() {
  const cfg = await chrome.storage.sync.get({
    enabled: true,
    disabledSites: [],
    translateImages: true,
  });
  globalToggle.checked = cfg.enabled;
  imagesToggle.checked = cfg.translateImages;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id !== undefined) {
    currentTabId = tab.id;
    urlAllowed = /^(https?|file):/.test(tab.url || "");
  }
  await refreshStatus();
}

globalToggle.addEventListener("change", async () => {
  await chrome.storage.sync.set({ enabled: globalToggle.checked });
  siteToggle.disabled = !globalToggle.checked;
  setTimeout(refreshStatus, 300);
});

imagesToggle.addEventListener("change", async () => {
  await chrome.storage.sync.set({ translateImages: imagesToggle.checked });
  setTimeout(refreshStatus, 300);
});

siteToggle.addEventListener("change", async () => {
  if (!currentHost) return;
  const { disabledSites } = await chrome.storage.sync.get({ disabledSites: [] });
  const set = new Set(disabledSites);
  if (siteToggle.checked) set.delete(currentHost);
  else set.add(currentHost);
  await chrome.storage.sync.set({ disabledSites: [...set] });
  setTimeout(refreshStatus, 300);
});

originalBtn.addEventListener("click", async () => {
  await queryContentScript({ type: "toggleOriginal" });
  refreshStatus();
});

retranslateBtn.addEventListener("click", async () => {
  retranslateBtn.disabled = true;
  queryContentScript({ type: "retranslate" });
  setTimeout(refreshStatus, 400);
});

init();
