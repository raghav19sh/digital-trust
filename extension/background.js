const API_URL = "https://digitrust.sharma-raghav.com/api/analyze";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "digitrust-analyze-selection",
    title: "Verify selection with DigiTrust",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "digitrust-analyze-selection" || !info.selectionText) return;
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: info.selectionText.slice(0, 20000) })
    });
    const data = await response.json();
    await chrome.storage.local.set({
      latestAnalysis: { ...data, analyzedAt: Date.now(), sourceUrl: tab?.url || null }
    });
    if (tab?.id) chrome.action.openPopup().catch(() => {});
  } catch (error) {
    await chrome.storage.local.set({
      latestAnalysis: { error: "Could not reach DigiTrust. Check your connection and try again.", analyzedAt: Date.now() }
    });
  }
});