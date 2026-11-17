const API_URL = "https://digitrust.sharma-raghav.com/api/analyze";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "digitrust-analyze-selection",
    title: "Verify selection with DigiTrust",
    contexts: ["selection"]
  });
});

function extractSelectionContext() {
  const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
  const selected = clean(window.getSelection()?.toString());
  const node = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0).commonAncestorContainer : null;
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const block = element?.closest("p, li, blockquote, h1, h2, h3, h4, td, figcaption") || element;
  const context = clean(block?.innerText || block?.textContent || "");
  return { text: context.length >= 40 ? context : selected, selected_text: selected.slice(0, 2000), mode: "selection" };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "digitrust-analyze-selection" || !info.selectionText || !tab?.id) return;
  try {
    const [{ result: selection }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractSelectionContext });
    const text = selection?.text || info.selectionText;
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: tab.url, title: tab.title, ...selection, text: text.slice(0, 20000), mode: "selection" })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Selection verification failed.");
    await chrome.storage.local.set({ latestAnalysis: { ...data, analyzedAt: Date.now(), sourceUrl: tab.url || null } });
    chrome.action.openPopup().catch(() => {});
  } catch (error) {
    await chrome.storage.local.set({
      latestAnalysis: { error: error.message || "Could not analyze the selected claim.", analyzedAt: Date.now() }
    });
    chrome.action.openPopup().catch(() => {});
  }
});