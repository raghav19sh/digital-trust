# DigiTrust

DigiTrust — Digital Trust Intelligence is a standalone Next.js application for analyzing articles and claims for credibility signals.

## What it does

- Article URL or pasted-text analysis
- Transparent 0–100 trust score
- Fact-check evidence when Google Fact Check Tools API is configured
- Independent-coverage search when NewsAPI is configured
- Conservative source/domain heuristics
- Built-in manipulative-language detection
- Optional Anthropic or Gemini language analysis
- SSRF-defensive URL fetching
- Stateless public UI with no database requirement
- SEO metadata, sitemap, robots.txt, privacy and methodology pages\n- AI media authenticity checker for images and videos (Hive detector + provenance signals)

## Score

35% fact checks · 25% domain signal · 20% independent coverage · 20% language signals.

The score is a triage signal, not an objective-truth classifier.

## Run locally

```bash
npm install
npm run dev
```

## Environment

Copy `.env.example` to `.env.local` and add any optional provider keys.

## Deploy

Import `raghav19sh/digital-trust` into Vercel as a Next.js project and attach:

`https://digitrust.sharma-raghav.com`

Important claims should always be verified against primary sources.
