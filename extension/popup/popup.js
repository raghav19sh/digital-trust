const API_URL = "https://digitrust.sharma-raghav.com/api/analyze";
const $ = (id) => document.getElementById(id);

function extractPage() {
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const selected = clean(window.getSelection()?.toString());
  const candidates = [...document.querySelectorAll("article, main, [role='main']")];
  const root = candidates.sort((a, b) => b.innerText.length - a.innerText.length)[0] || document.body;
  const text = selected.length >= 40 ? selected : clean(root.innerText);
  return { text: text.slice(0, 20000), title: document.title, url: location.href, mode: selected.length >= 40 ? "selection" : "page" };
}

function render(data) {
  $("result").hidden = false;
  if (data.error) {
    $("status").textContent = data.error;
    $("score").textContent = "—";
    $("verdict").textContent = "Analysis unavailable";
    $("domain").textContent = "";
    $("summary").textContent = "";
    return;
  }
  $("status").textContent = `Analysis complete · ${data.analysis_scope === "selection" ? "Selected text" : "Full page"} · ${Number.isFinite(data.evidence_coverage) ? data.evidence_coverage + "% evidence coverage" : "Evidence coverage unavailable"}.`;
  $("score").textContent = Number.isFinite(data.trust_score) ? Math.round(data.trust_score) : "—";
  $("verdict").textContent = data.verdict || "Analysis complete";
  $("domain").textContent = data.domain || data.source_url || "Selected text";
  $("summary").textContent = data.summary || "";
  renderList("claim-results", "Claim-level verification", data.claim_results || [], (x) => `${x.status.replaceAll("_", " ")} · ${x.text}${x.evidence?.length ? " · " + x.evidence[0].publisher + ": " + x.evidence[0].rating : ""}`);
  const labels = { fact_check: "Fact checks", domain_reputation: "Source reputation", news_coverage: "Independent coverage", language_signals: "Language signals" };
  $("components").replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    const item = data.components?.[key];
    const row = document.createElement("div");
    row.className = "component";
    const name = document.createElement("span");
    name.textContent = label + (item?.available ? "" : " · unavailable");
    const value = document.createElement("b");
    value.textContent = item?.available ? Math.round(item.score) : "—";
    const track = document.createElement("div");
    track.className = "track";
    const fill = document.createElement("i");
    fill.style.width = (item?.available ? Math.max(0, Math.min(100, item.score)) : 0) + "%";
    track.append(fill); row.append(name, value, track); $("components").append(row);
  }
  renderList("flags", "Language signals to review", data.red_flags || [], (x) => x.category + ": “" + x.excerpt + "” — " + x.explanation);
  renderList("facts", "Published fact-checks", data.verified_facts || [], (x) => x.publisher + " · " + x.rating + (x.url ? " · " + x.url : ""));
  renderList("sources", "Independent coverage", data.sources || [], (x) => x.source + " · " + x.title + " · " + x.url);
}
function renderList(id, title, items, format) {
  const root = $(id); root.replaceChildren();
  if (!items.length) return;
  const heading = document.createElement("h2"); heading.textContent = title; root.append(heading);
  for (const item of items.slice(0, 5)) {
    const p = document.createElement("p"); p.textContent = format(item); root.append(p);
  }
}
$("analyze").addEventListener("click", async () => {
  const button = $("analyze"); button.disabled = true; button.textContent = "Analyzing…";
  $("status").textContent = "Extracting page content and checking evidence…";
  $("result").hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("This page cannot be analyzed. Open a normal HTTP or HTTPS webpage.");
    const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
    if (!page?.text || page.text.length < 40) throw new Error("Not enough readable text found. Select a longer claim or open an article.");
    const response = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: page.url, text: page.text, title: page.title, mode: page.mode }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Analysis request failed.");
    await chrome.storage.local.set({ latestAnalysis: { ...data, analyzedAt: Date.now() } });
    render(data);
  } catch (error) {
    render({ error: error.message || "Analysis failed." });
  } finally {
    button.disabled = false; button.textContent = "Analyze current page";
  }
});
chrome.storage.local.get("latestAnalysis").then(({ latestAnalysis }) => {
  if (latestAnalysis && Date.now() - latestAnalysis.analyzedAt < 30 * 60 * 1000) render(latestAnalysis);
});