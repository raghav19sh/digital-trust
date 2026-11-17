"use client";

import { useState, type CSSProperties, type KeyboardEvent, type ChangeEvent } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Info,
  Link2,
} from "lucide-react";

type Level = "good" | "warn" | "bad";
type Flag = { category: string; excerpt: string; explanation: string };
type ComponentResult = {
  score: number;
  available: boolean;
  details?: Record<string, unknown>;
};
type Result = {
  domain: string | null;
  title: string | null;
  trust_score: number;
  level: Level;
  verdict: string;
  summary: string;
  components?: Record<string, ComponentResult>;
  red_flags?: Flag[];
  verified_facts?: Array<{
    claim: string;
    publisher: string;
    rating: string;
    url: string | null;
  }>;
  sources?: Array<{ source: string; title: string; url: string }>;
  source_url?: string | null;
};

const labels = [
  { key: "fact_check", title: "Fact checks" },
  { key: "domain_reputation", title: "Domain reputation" },
  { key: "news_coverage", title: "News coverage" },
  { key: "language_signals", title: "Language signals" },
] as const;

function Pill({ level }: { level: Level }) {
  const label =
    level === "good" ? "Strong signal" : level === "warn" ? "Mixed signals" : "Weak signal";
  return <span className={`pill ${level}`}>{label}</span>;
}

function Score({ score }: { score: number }) {
  return (
    <>
      <main id="main-content" className="container">
        <nav className="nav">
          <Link className="brand" href="/">
            <span className="mark" aria-hidden="true" />
            <span>DigiTrust</span>
          </Link>
          <div className="navlinks">
            <a href="/how-it-works">Methodology</a>
            <a href="#analysis">Media Check</a>
            <a href="#signals">Evaluation</a>
            <a href="#analysis">Security</a>
            <a href="/privacy">Privacy</a>
          </div>
        </nav>

        <section className="hero">
          <span className="eyebrow">Multimedia trust analysis</span>
          <h1>Truth deserves more than a glance.</h1>
          <p>
            Examine the signals behind online content — source reputation,
            published fact-checks, independent coverage and the language used
            to shape a claim.
          </p>
        </section>

        <section className="analyzer" id="analysis" aria-label="Article analysis">
          <div className="tabs" role="tablist" aria-label="Analysis input type">
            <button
              className={`tab ${mode === "url" ? "active" : ""}`}
              role="tab"
              aria-selected={mode === "url"}
              onClick={() => { setMode("url"); setError(""); }}
            >
              <Link2 size={15} /> Article URL
            </button>
            <button
              className={`tab ${mode === "text" ? "active" : ""}`}
              role="tab"
              aria-selected={mode === "text"}
              onClick={() => { setMode("text"); setError(""); }}
            >
              <FileText size={15} /> Paste text
            </button>
          </div>

          {mode === "url" ? (
            <div className="inputrow">
              <input
                className="input"
                value={input}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="https://example.com/news/article"
                inputMode="url"
                autoComplete="url"
                aria-label="Article URL"
              />
              <button className="btn" onClick={() => void analyze()} disabled={loading}>
                {loading ? <><span className="spinner" /> Analyzing</> : <>Analyze <span aria-hidden="true">→</span></>}
              </button>
            </div>
          ) : (
            <>
              <textarea
                className="textarea"
                value={input}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setInput(event.target.value)}
                placeholder="Paste the article, claim, or post you want to examine..."
                aria-label="Text to analyze"
              />
              <div className="inputrow compact">
                <span className="hint">Pasted content is sent only with this analysis request.</span>
                <button className="btn" onClick={() => void analyze()} disabled={loading}>
                  {loading ? <><span className="spinner" /> Analyzing</> : "Analyze text"}
                </button>
              </div>
            </>
          )}

          <div className="notice">
            <Info size={14} />
            <span>A trust score is a <strong>signal, not a verdict</strong>. Missing external data is shown as unavailable rather than treated as positive evidence.</span>
          </div>

          {error && <div className="error"><AlertTriangle size={14} /> {error}</div>}
        </section>

        {!result && (
          <section className="grid" id="signals" aria-label="Analysis methodology">
            <div className="stat">
              <strong>01&nbsp; / &nbsp;Source reputation</strong>
              <span>Inspect the publisher and the reliability signals associated with its domain.</span>
            </div>
            <div className="stat">
              <strong>02&nbsp; / &nbsp;Fact-checks</strong>
              <span>Compare claims with published fact-checks when a relevant match is available.</span>
            </div>
            <div className="stat">
              <strong>03&nbsp; / &nbsp;Independent coverage</strong>
              <span>Look for corroboration from reporting beyond the original source.</span>
            </div>
            <div className="stat">
              <strong>04&nbsp; / &nbsp;Language signals</strong>
              <span>Identify emotional framing, absolute claims and attribution gaps.</span>
            </div>
          </section>
        )}

        {result && (
          <section className="result" aria-live="polite">
            <div className="card scorecard">
              <Score score={result.trust_score} />
              <div>
                <div className="muted small">{result.domain || "Text analysis"}{result.title ? ` · ${result.title}` : ""}</div>
                <div className="verdict">{result.verdict}</div>
                <Pill level={result.level} />
                <p className="small muted">{result.summary}</p>
                {result.source_url && (
                  <a className="source-link" href={result.source_url} target="_blank" rel="noreferrer">
                    View analyzed page <ExternalLink size={12} />
                  </a>
                )}
              </div>
            </div>

            <div className="card">
              <h2>Score breakdown</h2>
              <div className="bars">
                {labels.map((item) => {
                  const component = result.components?.[item.key];
                  const score = Math.max(0, Math.min(100, component?.score ?? 0));
                  return (
                    <div key={item.key} className="barrow">
                      <span>{item.title}</span>
                      <div>
                        <div className="bar"><i style={{ width: `${score}%` }} /></div>
                        <div className="hint">{component?.available ? "Signal available" : "Unavailable — neutral contribution"}</div>
                      </div>
                      <strong>{component?.available ? Math.round(score) : "—"}</strong>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="two">
              <div className="card">
                <h2>Linguistic red flags</h2>
                {result.red_flags?.length ? result.red_flags.map((flag, index) => (
                  <div className="flag" key={`${flag.category}-${index}`}>
                    <strong>{flag.category}</strong>
                    <div className="small muted">“{flag.excerpt}”</div>
                    <div className="small flag-copy">{flag.explanation}</div>
                  </div>
                )) : <div className="small muted"><CheckCircle2 size={15} /> No obvious linguistic red flags detected.</div>}
              </div>

              <div className="card">
                <h2>Published fact-checks</h2>
                {result.verified_facts?.length ? (
                  <ul className="list">
                    {result.verified_facts.map((fact, index) => (
                      <li key={`${fact.claim}-${index}`}>
                        <strong>{fact.claim}</strong>
                        <div className="small muted">
                          {fact.publisher} · {fact.rating}{" "}
                          {fact.url && <a href={fact.url} target="_blank" rel="noreferrer" aria-label="Open fact-check"><ExternalLink size={12} /></a>}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : <div className="small muted">No matching published fact-checks were returned.</div>}
              </div>
            </div>

            {result.sources?.length ? (
              <div className="card">
                <h2>Independent coverage</h2>
                {result.sources.map((source, index) => (
                  <div className="source" key={`${source.url}-${index}`}>
                    <strong>{source.source}</strong>
                    <div className="small muted">{source.title}</div>
                    <a href={source.url} target="_blank" rel="noreferrer">Open source <ExternalLink size={12} /></a>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        )}
      </main>

      <footer className="footer">
        <div className="container">
          <strong style={{ color: "var(--accent)", fontFamily: "var(--serif)", fontSize: 18 }}>DigiTrust</strong>
          <span style={{ marginLeft: 18 }}>Multimedia forensics · Explainable analysis · Responsible AI</span>
          <p>Digital content should be examined with evidence, context and care. A trust score is an analytical signal, not a final determination of truth.</p>
        </div>
      </footer>
    </>
  );
}

