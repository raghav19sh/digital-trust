# DigiTrust Chrome Extension

A Manifest V3 companion for the existing DigiTrust Next.js application. This first release is deliberately **manual-only**: it does not inspect pages in the background and does not request persistent access to all websites.

## Features

- Toolbar popup with an explicit **Analyze current page** action.
- Extracts readable page text to check that the page has enough content.
- Sends the page URL to the existing `POST /api/analyze` endpoint, preserving the existing backend and scoring pipeline.
- Right-click selected text and choose **Verify selection with DigiTrust**.
- Extracts ranked factual claims and checks them against published Google Fact Check reviews when configured.\n- Displays each claim as supported, refuted, partially supported or unverified, with matched review details.\n- Produces a numeric factual score only when at least one sufficiently relevant claim-level fact-check is found. Unknown claims are excluded; if none are verified, the result is 'insufficient evidence' rather than an invented neutral score.\n- Keeps domain, independent coverage and language patterns as separate diagnostics; language style cannot increase factual credibility.
- Stores the latest result locally in `chrome.storage.local`.

## Load unpacked in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `extension` directory.
5. Open a normal HTTP/HTTPS webpage and click the DigiTrust toolbar icon.
6. Press **Analyze current page**. To analyse a selected claim, select text and use the right-click menu.

## API configuration

The default API is `https://digitrust.sharma-raghav.com/api/analyze`. Change `API_URL` in `popup/popup.js` and `background.js` if deploying elsewhere. The API must allow requests from the Chrome extension origin (CORS) for the popup request to succeed.

## Permissions

- `activeTab`: temporary access to the current tab after the user invokes the extension.
- `scripting`: extract page text only after the user clicks Analyze.
- `contextMenus`: provide a selected-text action.
- `storage`: retain the most recent result locally.
- Host permission is limited to the DigiTrust API origin.

No content script is registered, no automatic page monitoring runs, and no webpage content is collected until the user invokes an action.

## Current limitations

- The existing API fetches article URLs itself. Pages that block server-side fetching, require login, or render content only in the browser may not be analyzable through URL mode.
- Selected-text analysis sends the selected passage together with its source URL. The backend analyzes the supplied passage without replacing it with a server-fetched full page, while retaining the page domain as a source-reputation signal.
- The API now uses an evidence-first claim score. Domain reputation, article coverage and language heuristics are diagnostics only; they cannot substitute for claim verification. A fact-check search result is accepted only when lexical claim relevance passes a conservative threshold.
- Image/video and OCR analysis are not included in this MVP.
- The UI displays the existing API's trust score as a triage signal, not a truth verdict.

## Icons

Place Chrome-compatible PNG icons at `icons/icon16.png`, `icons/icon48.png` and `icons/icon128.png` before publishing. For local unpacked testing, remove the `icons` block from `manifest.json` if you do not yet have icon assets.