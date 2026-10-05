export default function Privacy() {
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
        <h1>Privacy</h1>
        <p>
          DigiTrust is designed to be stateless at the public interface. The
          current application does not require an account or database for
          public analysis.
        </p>

        <h2>Submitted content</h2>
        <p>
          Submitted text and URLs are processed by the analysis request. The
          application does not intentionally persist them in its own database.
          Hosting, network, or third-party provider logs may still exist under
          the policies of those services.
        </p>

        <h2>URL analysis</h2>
        <p>
          A submitted URL is fetched server-side to extract readable text.
          Private, loopback, link-local, and other non-public destinations are
          blocked; redirects are revalidated; response sizes and request times
          are capped.
        </p>

        <h2>Third-party providers</h2>
        <p>
          Optional integrations may send limited query or article text to
          Google Fact Check Tools, NewsAPI, Anthropic, or Gemini depending on
          which providers are enabled in the deployment. Do not submit
          passwords, API keys, private keys, or sensitive personal information.
        </p>

        <h2>Limitations</h2>
        <p>
          A trust score can be incomplete, wrong, or biased by missing sources
          and imperfect heuristics. Verify important claims against primary
          sources.
        </p>
      </article>
    </main>
  );
}