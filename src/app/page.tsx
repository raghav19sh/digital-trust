"use client";

import { useState, type CSSProperties, type KeyboardEvent, type ChangeEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Info,
  Link2,
  Search,
  ShieldCheck,
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
    <div className="score" style={{ "--pct": score } as CSSProperties}>
      <div className="scoretext">
        <b>{Math.round(score)}</b>
        <span>TRUST SCORE</span>
      </div>
    </div>
  );
}

export default function Home() {
  const [mode, setMode] = useState<"url" | "text">("url");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  async function analyze() {
    setError("");
    setResult(null);
    const value = input.trim();

    if (!value) {
      setError("Enter a URL or paste text first.");
      return;
    }
    if (mode === "text" && value.length < 40) {
      setError("Paste at least 40 characters so the analyzer has enough context.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "url" ? { url: value } : { text: value }),
      });
      const data = (await response.json()) as Result & { error?: string };
      if (!response.ok) throw new Error(data.error || "Analysis failed.");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") void analyze();
  }

  return (
    <>
      <main className="container">
        <nav className="nav">
          <a className="brand" href="/">
            <span className="mark">
              <ShieldCheck size={18} />
            </span>
            <span>DigiTrust</span>
          </a>
          <div className="navlinks">
            <a href="/how-it-works">How it works</a>
            <a href="/privacy">Privacy</a>
            <a
              href="https://sharma-raghav.com"
              target="_blank"
              rel="noreferrer"
            >
              Raghav Sharma ↗
            </a>
          </div>
        </nav>

        <section className="hero">
          <span className="eyebrow">
            <ShieldCheck size={13} /> Digital Trust Intelligence
          </span>
          <h1>Before you share it, test the signal.</h1>
          <p>
            Analyze an article or claim for credibility signals across source
            reputation, published fact-checks, independent coverage, and
            manipulative language.
          </p>
        </section>

        <section className="analyzer">
          <div className="tabs">
            <button
              className={`tab ${mode === "url" ? "active" : ""}`}
              onClick={() => {
                setMode("url");
                setError("");
              }}
            >
              <Link2 size={13} /> Article URL
            </button>
            <button
              className={`tab ${mode === "text" ? "active" : ""}`}
              onClick={() => {
                setMode("text");
                setError("");
              }}
            >
              <FileText size={13} /> Paste text
            </button>
          </div>

          {mode === "url" ? (
            <div className="inputrow">
              <input
                className="input"
                value={input}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setInput(event.target.value)
                }
                onKeyDown={handleKeyDown}
                placeholder="https://example.com/news/article"
                inputMode="url"
                autoComplete="url"
              />
              <button
                className="btn"
                onClick={() => void analyze()}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <span className="spinner" /> Analyzing
                  </>
                ) : (
                  <>
                    <Search size={16} /> Analyze
                  </>
                )}
              </button>
            </div>
          ) : (
            <>
              <textarea
                className="textarea"
                value={input}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                  setInput(event.target.value)
                }
                placeholder="Paste the article, claim, or post you want to examine..."
              />
              <div className="inputrow compact">
                <span className="hint">
                  The public interface is stateless. Pasted content is sent only
                  to the analysis request.
                </span>
                <button
                  className="btn"
                  onClick={() => void analyze()}
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <span className="spinner" /> Analyzing
                    </>
                  ) : (
                    "Analyze text"
                  )}
                </button>
              </div>
            </>
          )}

          <div className="notice">
            <Info size={13} /> A trust score is a <strong>signal, not a verdict</strong>.
            Missing external data is shown as unavailable instead of being
            disguised as positive evidence.
          </div>

          {error && (
            <div className="error">
              <AlertTriangle size={14} /> {error}
            </div>
          )}
        </section>

        {!result && (
          <div className="grid">
            <div className="stat">
              <strong>01 · Source</strong>
              <span>Inspect hostname and basic source signals.</span>
            </div>
            <div className="stat">
              <strong>02 · Evidence</strong>
              <span>Match claims against published fact-checks when available.</span>
            </div>
            <div className="stat">
              <strong>03 · Coverage</strong>
              <span>Look for independent reporting around the claim.</span>
            </div>
            <div className="stat">
              <strong>04 · Language</strong>
              <span>Flag clickbait, absolutes, emotional framing, and attribution gaps.</span>
            </div>
          </div>
        )}

        {result && (
          <section className="result" aria-live="polite">
            <div className="card scorecard">
              <Score score={result.trust_score} />
              <div>
                <div className="muted small">
                  {result.domain || "Text analysis"}
                  {result.title ? ` · ${result.title}` : ""}
                </div>
                <div className="verdict">{result.verdict}</div>
                <Pill level={result.level} />
                <p className="small muted">{result.summary}</p>
                {result.source_url && (
                  <a
                    className="source-link"
                    href={result.source_url}
                    target="_blank"
                    rel="noreferrer"
                  >
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
                        <div className="bar">
                          <i style={{ width: `${score}%` }} />
                        </div>
                        <div className="hint">
                          {component?.available
                            ? "Signal available"
                            : "Unavailable — neutral contribution"}
                        </div>
                      </div>
                      <strong>
                        {component?.available ? Math.round(score) : "—"}
                      </strong>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="two">
              <div className="card">
                <h2>Linguistic red flags</h2>
                {result.red_flags?.length ? (
                  result.red_flags.map((flag, index) => (
                    <div className="flag" key={`${flag.category}-${index}`}>
                      <strong>{flag.category}</strong>
                      <div className="small muted">“{flag.excerpt}”</div>
                      <div className="small flag-copy">{flag.explanation}</div>
                    </div>
                  ))
                ) : (
                  <div className="small muted">
                    <CheckCircle2 size={15} /> No obvious linguistic red flags detected.
                  </div>
                )}
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
                          {fact.url && (
                            <a
                              href={fact.url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label="Open fact-check"
                            >
                              <ExternalLink size={12} />
                            </a>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="small muted">
                    No matching published fact-checks were returned.
                  </div>
                )}
              </div>
            </div>

            {result.sources?.length ? (
              <div className="card">
                <h2>Independent coverage</h2>
                {result.sources.map((source, index) => (
                  <div className="source" key={`${source.url}-${index}`}>
                    <strong>{source.source}</strong>
                    <div className="small muted">{source.title}</div>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open source <ExternalLink size={12} />
                    </a>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        )}
      </main>

      <footer className="footer">
        <div className="container">
          DigiTrust is a media-literacy aid. It does not determine objective
          truth and should not replace primary-source verification.
        </div>
      </footer>
    </>
  );
}