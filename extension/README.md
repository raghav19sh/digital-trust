# DigiTrust Chrome Extension

A Manifest V3 companion for the existing DigiTrust Next.js application. This first release is deliberately **manual-only**: it does not inspect pages in the background and does not request persistent access to all websites.

## Features

- Toolbar popup with an explicit **Analyze current page** action.
- Extracts readable page text to check that the page has enough content.
- Sends the page URL to the existing `POST /api/analyze` endpoint, preserving the existing backend and scoring pipeline.
- Right-click selected text and choose **Verify selection with DigiTrust**.
- Shows the returned score, signal breakdown, language flags, fact-checks and coverage.
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
- Selected-text analysis uses the existing text-only API input; the current backend therefore has no source-domain signal for that request.
- Image/video and OCR analysis are not included in this MVP.
- The UI displays the existing API's trust score as a triage signal, not a truth verdict.

## Icons

Place Chrome-compatible PNG icons at `icons/icon16.png`, `icons/icon48.png` and `icons/icon128.png` before publishing. For local unpacked testing, remove the `icons` block from `manifest.json` if you do not yet have icon assets.