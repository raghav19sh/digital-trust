import { NextResponse } from "next/server";
import dns from "node:dns/promises";
import net from "node:net";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_TEXT = 20000;
const MAX_BYTES = 900000;
const MAX_REDIRECTS = 3;
const RATE_LIMIT = 12;
const WINDOW = 60000;
const requests = new Map<string, { count: number; reset: number }>();

const weights = {
  fact_check: 0.35,
  domain_reputation: 0.25,
  news_coverage: 0.2,
  language_signals: 0.2,
} as const;

type Flag = { category: string; excerpt: string; explanation: string; penalty: number };
type Component = {
  score: number;
  weight: number;
  available: boolean;
  details: Record<string, unknown>;
};

const response = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

function clamp(n: number) {
  return Math.max(0, Math.min(100, n));
}

function publicIp(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false;
    return true;
  }
  if (!net.isIPv6(ip)) return false;
  const x = ip.toLowerCase();
  return x !== "::" && x !== "::1" && !x.startsWith("fc") && !x.startsWith("fd") && !x.startsWith("fe80:");
}

async function validateHost(host: string, port: number) {
  if (port !== 80 && port !== 443) throw new Error("Only ports 80 and 443 are allowed.");
  if (net.isIP(host)) {
    if (!publicIp(host)) throw new Error("Private or local hosts are not allowed.");
    return;
  }
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  if (!answers.length || answers.some((x) => !publicIp(x.address))) {
    throw new Error("That hostname resolves to a non-public address.");
  }
}

function clean(text: string) {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

function stripHtml(html: string) {
  const title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/<[^>]+>/g, " ")) || "";
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const blocks = [...body.matchAll(/<(?:article|main|p|h1|h2|h3|li)[^>]*>([\s\S]*?)<\/(?:article|main|p|h1|h2|h3|li)>/gi)]
    .map((m) => clean(m[1].replace(/<[^>]+>/g, " ")))
    .filter((x) => x.length > 30);
  return { title: title.slice(0, 300) || null, text: clean(blocks.length ? blocks.join(" ") : body.replace(/<[^>]+>/g, " ")) };
}

async function fetchArticle(input: string) {
  let current = input;

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new Error("Malformed URL.");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw new Error("Only public HTTP/HTTPS URLs are allowed.");
    }

    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    await validateHost(url.hostname, port);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "DigiTrust/1.0 (+https://digitrust.sharma-raghav.com)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        },
      });
    } catch {
      throw new Error("Could not fetch that page.");
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Invalid redirect.");
      current = new URL(location, url).toString();
      continue;
    }

    if (!res.ok) throw new Error("The page returned HTTP " + res.status + ".");
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "text/html" && type !== "application/xhtml+xml" && type !== "text/plain") {
      throw new Error("Only HTML and plain-text pages are supported.");
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error("The page is too large to analyze.");

    const parsed = type === "text/plain" ? { title: null, text: clean(bytes.toString("utf8")) } : stripHtml(bytes.toString("utf8"));
    if (parsed.text.length < 100) throw new Error("Not enough readable text was found on that page.");

    return { url: current, domain: url.hostname.toLowerCase(), title: parsed.title, text: parsed.text };
  }

  throw new Error("Too many redirects.");
}

function extractClaims(text: string) {\n  const sentences = text.split(/(?<=[.!?])\\s+/).map((x) => x.trim()).filter((x) => x.length > 55);\n  return sentences.slice(0, 5).map((x, i) => ({ id: `C${String(i + 1).padStart(2, "0")}`, text: x.slice(0, 280), confidence: Math.min(98, Math.round(65 + x.length / 10 + (/[0-9%]|\\b(is|are|was|were|will|has|have)\\b/i.test(x) ? 15 : 0))) }));\n}\n\nfunction language(text: string) {
  const tests: Array<[string, RegExp, number, string]> = [
    ["clickbait", /\b(shocking|you won't believe|must see|exposed|bombshell|going viral|urgent)\b/gi, 6, "Sensational phrasing can pressure readers to react before checking evidence."],
    ["emotional manipulation", /\b(outrage|disgusting|evil|traitor|corrupt|terrifying|horrific|insane|idiot|propaganda)\b/gi, 3, "Loaded wording can frame a claim emotionally."],
    ["absolute claims", /\b(always|never|everyone|no one|definitely|undeniable|proves that)\b/gi, 3, "Absolute wording raises the evidentiary bar."],
    ["vague attribution", /\b(experts say|people are saying|sources say|they say|it is known)\b/gi, 4, "Vague attribution makes evidence difficult to identify."],
  ];

  let score = 92;
  const flags: Flag[] = [];

  for (const [category, regex, penalty, explanation] of tests) {
    const hits = text.match(regex) ?? [];
    score -= Math.min(20, hits.length * penalty);
    if (hits[0]) flags.push({ category, excerpt: hits[0], explanation, penalty: p });
  }

  const caps = text.match(/\b[A-Z]{6,}\b/g) ?? [];
  if (caps[0]) {
    score -= Math.min(10, caps.length * 2);
    flags.push({ category: "all-caps", excerpt: caps[0], explanation: "Repeated all-caps wording can increase emotional intensity.", penalty: Math.min(10, caps.length * 2) });
  }

  const marks = text.match(/!{2,}|\?{3,}/g) ?? [];
  if (marks[0]) {
    score -= Math.min(10, marks.length * 3);
    flags.push({ category: "punctuation intensity", excerpt: marks[0], explanation: "Repeated punctuation can signal sensational presentation.", penalty: Math.min(10, marks.length * 3) });
  }

  return { score: clamp(score), flags: flags.slice(0, 8) };
}

function domainSignal(domain: string | null): Component {
  if (!domain) {
    return { score: 50, weight: weights.domain_reputation, available: false, details: { reason: "Pasted text has no source domain." } };
  }

  const host = domain.replace(/^www\./, "");
  const established = ["reuters.com", "apnews.com", "bbc.com", "npr.org", "pbs.org", "who.int", "un.org", "nih.gov", "cdc.gov", "europa.eu"];

  let score = 50;
  let method = "generic baseline";

  if (established.some((x) => host === x || host.endsWith("." + x))) {
    score = 82;
    method = "established publisher/institution heuristic";
  } else if (/\.(gov|gov\.in|edu|ac\.uk)$/i.test(host)) {
    score = 78;
    method = "government/education namespace heuristic";
  }

  return { score, weight: weights.domain_reputation, available: true, details: { hostname: host, method } };
}

function claims(text: string) {
  return text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 55).slice(0, 3).map((x) => x.slice(0, 250));
}

async function factChecks(text: string) {
  const key = process.env.GOOGLE_FACT_CHECK_API_KEY;
  if (!key) {
    return {
      component: { score: 50, weight: weights.fact_check, available: false, details: { reason: "Google Fact Check API not configured." } } as Component,
      facts: [] as Array<{ claim: string; rating: string; publisher: string; url: string | null }>,
    };
  }

  const facts: Array<{ claim: string; rating: string; publisher: string; url: string | null; score: number }> = [];

  for (const query of claims(text)) {
    try {
      const url = new URL("https://factchecktools.googleapis.com/v1alpha1/claims:search");
      url.searchParams.set("query", query);
      url.searchParams.set("pageSize", "5");
      url.searchParams.set("key", key);

      const res = await fetch(url);
      if (!res.ok) continue;

      const data = await res.json();
      for (const claim of data.claims ?? []) {
        for (const review of claim.claimReview ?? []) {
          const rating = String(review.textualRating ?? "Reviewed");
          const score = /false|incorrect|misleading|fake/i.test(rating) ? 18 : /true|correct|accurate/i.test(rating) ? 72 : 50;
          facts.push({
            claim: String(claim.text ?? query),
            rating,
            publisher: String(review.publisher?.name ?? "Fact-check publisher"),
            url: review.url ? String(review.url) : null,
            score,
          });
        }
      }
    } catch {}
  }

  const unique = facts.filter((f, i, a) => i === a.findIndex((x) => x.claim === f.claim && x.url === f.url));
  return {
    component: {
      score: unique.length ? unique.reduce((s, x) => s + x.score, 0) / unique.length : 50,
      weight: weights.fact_check,
      available: true,
      details: { claims_checked: claims(text).length, matches: unique.length },
    } as Component,
    facts: unique.slice(0, 8).map(({ score: _score, ...fact }) => fact),
  };
}

async function coverage(text: string, domain: string | null) {
  const key = process.env.NEWS_API_KEY;
  if (!key) {
    return {
      component: { score: 50, weight: weights.news_coverage, available: false, details: { reason: "NewsAPI not configured." } } as Component,
      sources: [] as Array<{ source: string; title: string; url: string }>,
    };
  }

  try {
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", (claims(text)[0] ?? text.split(/\s+/).slice(0, 12).join(" ")).slice(0, 500));
    url.searchParams.set("language", "en");
    url.searchParams.set("sortBy", "relevancy");
    url.searchParams.set("pageSize", "20");
    if (domain) url.searchParams.set("excludeDomains", domain.replace(/^www\./, ""));

    const res = await fetch(url, { headers: { "X-Api-Key": key } });
    if (!res.ok) throw new Error("NewsAPI failed.");

    const data = await res.json();
    const sources: Array<{ source: string; title: string; url: string }> = [];

    for (const article of data.articles ?? []) {
      const name = article.source?.name ? String(article.source.name) : "";
      const urlValue = typeof article.url === "string" ? article.url : "";
      if (!name || !urlValue || sources.some((x) => x.source === name)) continue;
      sources.push({ source: name, title: String(article.title ?? "Untitled"), url: urlValue });
    }

    return {
      component: { score: sources.length ? Math.min(100, 40 + sources.length * 10) : 50, weight: weights.news_coverage, available: true, details: { independent_sources: sources.length } } as Component,
      sources: sources.slice(0, 6),
    };
  } catch {
    return {
      component: { score: 50, weight: weights.news_coverage, available: false, details: { reason: "NewsAPI request failed." } } as Component,
      sources: [],
    };
  }
}

function overall(components: Record<string, Component>) {
  let total = 0;
  let weight = 0;
  for (const item of Object.values(components)) {
    total += item.score * item.weight;
    weight += item.weight;
  }
  return Math.round((total / weight) * 10) / 10;
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const entry = requests.get(ip);
  if (!entry || entry.reset <= now) requests.set(ip, { count: 1, reset: now + WINDOW });
  else {
    if (entry.count >= RATE_LIMIT) return response({ error: "Rate limit reached. Try again in a minute." }, 429);
    entry.count += 1;
  }

  try {
    const body = (await request.json()) as { url?: unknown; text?: unknown };
    const inputUrl = typeof body.url === "string" ? body.url.trim() : "";
    let text = typeof body.text === "string" ? clean(body.text) : "";
    let sourceUrl: string | null = null;
    let domain: string | null = null;
    let title: string | null = null;

    if (inputUrl) {
      const article = await fetchArticle(inputUrl);
      sourceUrl = article.url;
      domain = article.domain;
      title = article.title;
      text = article.text;
    }

    if (text.length < 40) throw new Error("Provide a full URL or at least 40 characters of text.");

    const languageResult = language(text);
    const [fact, news] = await Promise.all([factChecks(text), coverage(text, domain)]);

    const components = {
      fact_check: fact.component,
      domain_reputation: domainSignal(domain),
      news_coverage: news.component,
      language_signals: {
        score: languageResult.score,
        weight: weights.language_signals,
        available: true,
        details: { method: "built-in heuristic analyzer", red_flag_count: languageResult.flags.length },
      } as Component,
    };

    const trustScore = overall(components);
    const numerator = Object.values(components).reduce((sum, item) => sum + item.score * item.weight, 0);
    const denominator = Object.values(components).reduce((sum, item) => sum + item.weight, 0);
    const extractedClaims = extractClaims(text);
    const evidence = fact.facts.map((item, index) => ({
      id: `E${String(index + 1).padStart(2, "0")}`,
      claim: item.claim,
      status: /false|incorrect|misleading|fake/i.test(item.rating) ? "CONFLICTING" : /true|correct|accurate/i.test(item.rating) ? "SUPPORTED" : "REVIEWED",
      source: item.publisher,
      url: item.url,
      contribution: (item.score * weights.fact_check) / Math.max(1, fact.facts.length),
    }));
    const securityChecks = [
      { name: "Protocol allowlist", status: "PASS", detail: "Only HTTP/HTTPS URLs are accepted." },
      { name: "Credential blocking", status: "PASS", detail: "Embedded URL credentials are rejected." },
      { name: "Private-network protection", status: "PASS", detail: "Private, loopback, link-local and multicast destinations are blocked." },
      { name: "Redirect revalidation", status: "PASS", detail: `Redirects are capped at ${MAX_REDIRECTS} and every destination is revalidated.` },
      { name: "Port restriction", status: "PASS", detail: "Only ports 80 and 443 are accepted." },
      { name: "Response-size limit", status: "PASS", detail: `${MAX_BYTES.toLocaleString()} byte maximum before parsing.` },
      { name: "Request timeout", status: "PASS", detail: "15 second fetch timeout." },
      { name: "Rate limiting", status: "PASS", detail: `${RATE_LIMIT} requests per minute per observed client key.` },
    ];
    const audit = [
      { step: 1, name: "Content acquisition", status: "PASS", detail: inputUrl ? "Fetched and sanitized public article content." : "Accepted pasted text after validation.", value: inputUrl ? sourceUrl ?? "URL" : "TEXT" },
      { step: 2, name: "Claim extraction", status: "PASS", detail: `${extractedClaims.length} candidate factual sentences retained.`, value: `${extractedClaims.length} claims` },
      { step: 3, name: "Language analysis", status: "PASS", detail: `${languageResult.flags.length} linguistic risk categories detected.`, value: `score ${languageResult.score}/100` },
      { step: 4, name: "Fact-check lookup", status: fact.component.available ? "PASS" : "UNAVAILABLE", detail: fact.component.available ? `${fact.facts.length} ClaimReview matches returned.` : String(fact.component.details.reason), value: `${Math.round(fact.component.score)}/100` },
      { step: 5, name: "Domain analysis", status: domain ? "PASS" : "NEUTRAL", detail: String(components.domain_reputation.details.method), value: `${Math.round(components.domain_reputation.score)}/100` },
      { step: 6, name: "Independent coverage", status: news.component.available ? "PASS" : "UNAVAILABLE", detail: news.component.available ? `${news.sources.length} independent sources returned.` : String(news.component.details.reason), value: `${Math.round(news.component.score)}/100` },
      { step: 7, name: "Weighted calculation", status: "PASS", detail: "Σ(component score × component weight) ÷ Σ(weight).", value: String(trustScore) },
      { step: 8, name: "Evidence packaging", status: "PASS", detail: "Claims, evidence, deductions and security controls serialized for review.", value: `${evidence.length} evidence links` },
    ];

    return response({
      source_url: sourceUrl,
      domain,
      title,
      trust_score: trustScore,
      level: trustScore >= 70 ? "good" : trustScore >= 40 ? "warn" : "bad",
      verdict: trustScore >= 70 ? "Stronger credibility signals" : trustScore >= 40 ? "Mixed signals — verify independently" : "Weak credibility signals — verify carefully",
      summary: languageResult.flags.length
        ? "Several language patterns deserve scrutiny before the content is treated as established fact."
        : "No major manipulative-language pattern was detected by the heuristic analyzer.",
      components,
      red_flags: languageResult.flags,
      verified_facts: fact.facts,
      sources: news.sources,\n      claims: extractedClaims,\n      evidence,\n      audit,\n      score_formula: { numerator, denominator, formula: "Σ(score × weight) ÷ Σ(weight)" },\n      security: { checks: securityChecks },\n      meta: { analyzer_version: "1.1.0", text_characters: text.length },
    });
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Analysis failed." }, 400);
  }
}