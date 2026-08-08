# Auto Translate to English

A Chrome extension that automatically detects the language of any webpage and seamlessly replaces its text with English — no clicks needed.

## Features

- **Automatic language detection** — uses Chrome's built-in detector to identify the page language, plus per-segment detection so mixed-language pages are handled correctly.
- **Seamless in-place replacement** — text is swapped directly in the page's own elements, so layout, styling, and interactivity are untouched.
- **Dynamic content support** — new text added by infinite scroll, single-page apps, chat feeds, etc. is translated as it appears.
- **Smart skipping** — pages already in English are left alone, as are code blocks, inputs, URLs, numbers, and elements marked `translate="no"` / `.notranslate`.
- **Show original** — flip back to the untranslated page at any time from the popup.
- **Per-site control** — disable translation globally or for specific sites.
- **No API key required** — uses Google's public web translation endpoint, with caching to minimize requests.

## Installation

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select this folder (`auto translate`).
5. Visit any non-English webpage — it translates automatically.

## Usage

Just browse. Pages in other languages are translated to English automatically a moment after they load.

Click the extension icon to:

- See the detected language and how many text segments were translated.
- Toggle auto-translate globally or for the current site.
- Switch between the translation and the original text.
- Force a re-translation.

## Testing

Open `test.html` (in this folder) in Chrome after installing the extension — it contains French, German, Spanish, and Japanese text, plus a button that injects new foreign-language text dynamically, so you can watch it get translated live.

To test with a local `file://` page, enable **Allow access to file URLs** for this extension on `chrome://extensions`. Alternatively, serve the page over HTTP:

```bash
python3 -m http.server 8080
# then visit http://localhost:8080/test.html
```

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Service worker that performs translation requests and caching |
| `content.js` | Finds, translates, and replaces page text; watches for dynamic content |
| `popup.html/css/js` | Toolbar popup UI |
| `icons/` | Extension icons |
| `make_icons.py` | Script that generated the icons (not needed at runtime) |
| `test.html` | Multi-language demo page for testing |
