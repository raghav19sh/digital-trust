export default function HowItWorks() {
  return (
    <main className="container page">
      <nav className="nav">
        <a className="brand" href="/">
          <span className="mark">DT</span>
          DigiTrust
        </a>
        <a className="muted" href="/">← Analyzer</a>
      </nav>
      <article className="prose">
        <h1>How DigiTrust works</h1>
        <p>
          DigiTrust combines several credibility-signal groups into a
          transparent score. The result is designed for triage and media
          literacy, not as proof that a claim is objectively true or false.
        </p>

        <h2>1. Fact-check evidence</h2>
        <p>
          When a Google Fact Check Tools API key is configured, DigiTrust
          extracts a small number of factual-looking sentences and searches
          published ClaimReview results. Matching reviews are displayed as
          evidence.
        </p>

        <h2>2. Domain signal</h2>
        <p>
          The source hostname is evaluated with conservative heuristics for
          established publishers, public institutions, education namespaces,
          and generic publishing platforms. This is not a licensed reputation
          database.
        </p>

        <h2>3. Independent coverage</h2>
        <p>
          When NewsAPI is configured, DigiTrust searches for related reporting
          and excludes the analyzed source domain. No coverage is treated as a
          neutral signal rather than proof of falsehood.
        </p>

        <h2>4. Language signals</h2>
        <p>
          The built-in analyzer looks for clickbait, emotionally loaded words,
          absolute claims, vague attribution, excessive capitalization, and
          punctuation intensity. An optional LLM can provide richer language
          analysis when configured.
        </p>

        <h2>Scoring</h2>
        <p>
          The reference weighting is 35% fact checks, 25% domain signal, 20%
          independent coverage, and 20% language signals. Missing external
          components are explicitly marked unavailable and contribute a neutral
          baseline.
        </p>
      </article>
    </main>
  );
}