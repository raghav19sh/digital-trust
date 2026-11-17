import { NextResponse } from "next/server";
import dns from "node:dns/promises";
import net from "node:net";
import { calculateEvidenceScore, extractClaims, matchFactCheck } from "../../../lib/verification";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_TEXT = 20000;
const MAX_BYTES = 900000;
const MAX_REQUEST_BYTES = 100000;
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

type Flag = { category: string; excerpt: string; explanation: string };
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
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (!net.isIPv6(ip)) return false;
  const x = ip.toLowerCase();
  return /^[23]/.test(x) && !x.startsWith("2001:db8:");
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

async function readRequestJson(request: Request) {
  if (!request.body) throw new Error("Request body is empty.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as { url?: unknown; text?: unknown; title?: unknown; mode?: unknown };
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
      clearTimeout(timer);
      throw new Error("Could not fetch that page.");
    }

    try {
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) throw new Error("Invalid redirect.");
        current = new URL(location, url).toString();
        continue;
      }

      if (!res.ok) throw new Error("The page returned HTTP " + res.status + ".");
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "text/html" && type !== "application/xhtml+xml" && type !== "text/plain") {
        await res.body?.cancel();
        throw new Error("Only HTML and plain-text pages are supported.");
      }

      const declaredLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
        await res.body?.cancel();
        throw new Error("The page is too large to analyze.");
      }
      if (!res.body) throw new Error("The page returned an empty response.");

      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) {
            await reader.cancel();
            throw new Error("The page is too large to analyze.");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const parsed = type === "text/plain" ? { title: null, text: clean(bytes.toString("utf8")) } : stripHtml(bytes.toString("utf8"));
      if (parsed.text.length < 100) throw new Error("Not enough readable text was found on that page.");

      return { url: current, domain: url.hostname.toLowerCase(), title: parsed.title, text: parsed.text };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("Too many redirects.");
}

function language(text: string) {
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
    if (hits[0]) flags.push({ category, excerpt: hits[0], explanation });
  }

  const caps = text.match(/\b[A-Z]{6,}\b/g) ?? [];
  if (caps[0]) {
    score -= Math.min(10, caps.length * 2);
    flags.push({ category: "all-caps", excerpt: caps[0], explanation: "Repeated all-caps wording can increase emotional intensity." });
  }

  const marks = text.match(/!{2,}|\?{3,}/g) ?? [];
  if (marks[0]) {
    score -= Math.min(10, marks.length * 3);
    flags.push({ category: "punctuation intensity", excerpt: marks[0], explanation: "Repeated punctuation can signal sensational presentation." });
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

async function factChecks(text: string) {
  const extracted = extractClaims(text);
  const key = process.env.GOOGLE_FACT_CHECK_API_KEY;
  const claimResults: Array<{ id: string; text: string; importance: number; status: string; score: number | null; evidence: Array<{ rating: string; publisher: string; url: string | null; relevance: number; status: string; explanation: string }> }> = [];
  const facts: Array<{ claim: string; rating: string; publisher: string; url: string | null }> = [];
  if (!key) {
    return { component: { score: 50, weight: weights.fact_check, available: false, details: { reason: 'Google Fact Check API not configured.' } } as Component, facts, claimResults: extracted.map((c) => ({ ...c, status: 'unverified', score: null, evidence: [] })), score: calculateEvidenceScore([]) };
  }
  for (const claim of extracted) {
    const evidence: Array<{ rating: string; publisher: string; url: string | null; relevance: number; status: string; explanation: string }> = [];
    try {
      const url = new URL('https://factchecktools.googleapis.com/v1alpha1/claims:search');
      url.searchParams.set('query', claim.text); url.searchParams.set('pageSize', '10'); url.searchParams.set('key', key);
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        for (const result of data.claims ?? []) for (const review of result.claimReview ?? []) {
          const reviewedClaim = String(result.text ?? ''); const rating = String(review.textualRating ?? '');
          const matched = matchFactCheck(claim.text, reviewedClaim, rating);
          if (matched.score === null) continue;
          const item = { rating, publisher: String(review.publisher?.name ?? 'Fact-check publisher'), url: review.url ? String(review.url) : null, relevance: Math.round(matched.relevance * 100), status: matched.status, explanation: matched.explanation };
          evidence.push(item); facts.push({ claim: reviewedClaim || claim.text, rating, publisher: item.publisher, url: item.url });
        }
      }
    } catch {}
    evidence.sort((x,y) => y.relevance - x.relevance); const best = evidence[0];
    const statuses = new Set(evidence.map((item) => item.status));
    const status = statuses.size > 1 ? 'partially_supported' : (best?.status ?? 'unverified');
    claimResults.push({ ...claim, status, score: status === 'supported' ? 100 : status === 'refuted' ? 0 : status === 'partially_supported' ? 50 : null, evidence: evidence.slice(0,3) });
  }
  const score = calculateEvidenceScore(claimResults);
  return { component: { score: score.score ?? 50, weight: weights.fact_check, available: score.assessed > 0, details: { claims_extracted: extracted.length, claims_assessed: score.assessed, claim_coverage: score.coverage, reason: score.assessed ? undefined : 'No relevant fact-checks found; claims remain unverified.' } } as Component, facts: facts.slice(0,12), claimResults, score };
}
function claims(text: string) { return extractClaims(text).map((claim) => claim.text); }

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
      component: {
        score: sources.length ? Math.min(100, 40 + sources.length * 10) : 50,
        weight: weights.news_coverage,
        // No matching coverage is insufficient evidence, not a negative credibility score.
        available: sources.length > 0,
        details: {
          independent_sources: sources.length,
          ...(sources.length ? {} : { reason: "No matching independent coverage was found; absence of coverage alone does not establish falsity." }),
        },
      } as Component,
      sources: sources.slice(0, 6),
    };
  } catch {
    return {
      component: { score: 50, weight: weights.news_coverage, available: false, details: { reason: "NewsAPI request failed." } } as Component,
      sources: [],
    };
  }
}

function overall(_components: Record<string, Component>, claimScore: number | null) {
  // Only claim-level fact-check evidence can produce a factual credibility score.
  // Domain, coverage and language remain visible diagnostics, not substitutes for verification.
  if (claimScore === null) return null;
  return Math.round(clamp(claimScore)*10)/10;
}
function evidenceCoverage(components: Record<string, Component>) {
  const factualSignals = [components.fact_check, components.domain_reputation, components.news_coverage];
  const configuredWeight = factualSignals.reduce((sum, item) => sum + item.weight, 0);
  const availableWeight = factualSignals
    .filter((item) => item.available)
    .reduce((sum, item) => sum + item.weight, 0);
  return configuredWeight ? Math.round((availableWeight / configuredWeight) * 100) : 0;
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
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      return response({ error: "Request body is too large." }, 413);
    }
    const body = await readRequestJson(request);
    const inputUrl = typeof body.url === "string" ? body.url.trim() : "";
    const requestedScope = body.mode === "selection" ? "selection" : "page";
    let text = typeof body.text === "string" ? clean(body.text) : "";
    let sourceUrl: string | null = null;
    let domain: string | null = null;
    let title: string | null = null;

    if (inputUrl) {
      // Browser clients may provide extracted text for client-rendered pages and social posts.
      // Preserve URL/domain metadata without server-fetching the page in that case.
      if (text.length >= 40) {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(inputUrl);
        } catch {
          throw new Error("Malformed URL.");
        }
        if (!/^https?:$/.test(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
          throw new Error("Only public HTTP/HTTPS URLs are allowed.");
        }
        sourceUrl = parsedUrl.toString();
        domain = parsedUrl.hostname.toLowerCase();
        title = typeof body.title === "string" ? clean(body.title).slice(0, 300) : null;
      } else {
        const article = await fetchArticle(inputUrl);
        sourceUrl = article.url;
        domain = article.domain;
        title = article.title;
        text = article.text;
      }
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

    const trustScore = overall(components, fact.score.score);

    return response({
      source_url: sourceUrl,
      domain,
      title,
      analysis_scope: requestedScope,
      evidence_coverage: evidenceCoverage(components),
      claim_coverage: fact.score.coverage,
      claims_extracted: fact.score.total,
      claims_assessed: fact.score.assessed,
      claim_results: fact.claimResults,
      trust_score: trustScore,
      level: trustScore === null ? "unknown" : trustScore >= 70 ? "good" : trustScore >= 40 ? "warn" : "bad",
      verdict: trustScore === null ? "Insufficient claim-level evidence — no credibility score" : trustScore >= 70 ? "Evidence supports the assessed claims" : trustScore >= 40 ? "Mixed claim-level evidence" : "Evidence contradicts important claims",
      summary: trustScore === null ? "No sufficiently relevant published fact-checks were found. Claims remain unverified; language and source signals cannot establish factual accuracy." : "Score is based on claim-level fact-check matches and supporting source signals. Language warnings are separate.",
      components,
      red_flags: languageResult.flags,
      verified_facts: fact.facts,
      language_diagnostics: { score: languageResult.score, red_flags: languageResult.flags },
      sources: news.sources,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed.";
    return response({ error: message }, message === "Request body is too large." ? 413 : 400);
  }
}
