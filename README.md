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
- SEO metadata, sitemap, robots.txt, privacy and methodology pages\n- AI media authenticity checker using Hive's dedicated AI-generated media and deepfake classifiers, plus local metadata and frequency checks

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


## Media authenticity detection

The media endpoint uses Hive Moderation's dedicated `ai_generated_media` and `deepfake` models. Configure `HIVE_DETECTION_API_KEY` with a Hive Moderation API key whose project has both models enabled. The previous VLM chat endpoint is not used as the primary image classifier.

DigiTrust starts with Hive's published 90% confidence threshold for high-confidence AI-generated / non-AI classifications. Intermediate model scores are considered alongside explicit generator metadata and deepfake output. Missing EXIF/C2PA metadata is treated as unknown, not as evidence of AI generation. DCT frequency analysis is a supporting heuristic only and does not independently determine the verdict.

Remote images are downloaded with a 4 MB limit, public-address checks and redirect limits so the same local metadata/frequency checks can run on uploads and image URLs. Remote video URLs are submitted to Hive directly.

A classifier score is not a calibrated guarantee. Cropping, screenshots, compression, image editing and newly released generators can affect detection. Validate thresholds against a labelled test set before using results for high-stakes decisions.
