import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 4_000_000;
const HIVE_ENDPOINT = "https://api.thehive.ai/api/v3/chat/completions";
const HIVE_MODEL = "hive/ai-generated-and-deepfake-content-detection";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-matroska", "video/x-ms-wmv"]);

type MediaAnalysis = {
  verdict: "AI_GENERATED" | "AI_MANIPULATED" | "NO_STRONG_AI_SIGNAL" | "INCONCLUSIVE";
  explanation: string;
  confidence: number;
  signals: { ai_generated: number; not_ai_generated: number; deepfake: number; frames_analyzed: number };
  likely_source: { name: string; confidence: number } | null;
  provenance: { detected: boolean; generator: string | null; software_agent: string | null; action: string | null; digital_source_type: string | null };
  detector: string;
};

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function clampPct(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(0, Math.min(100, number)) * 10) / 10;
}

function parseModelJson(content: unknown): Partial<MediaAnalysis> {
  if (typeof content !== "string") throw new Error("Hive returned an unexpected response format.");
  const cleaned = content.replace(/^\s*\`\`\`json\s*/i, "").replace(/^\s*\`\`\`\s*/i, "").replace(/\s*\`\`\`\s*$/i, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object") throw new Error("Hive returned an invalid analysis.");
  return parsed;
}

function normalizeResult(raw: Partial<MediaAnalysis>): MediaAnalysis {
  const verdicts = new Set(["AI_GENERATED", "AI_MANIPULATED", "NO_STRONG_AI_SIGNAL", "INCONCLUSIVE"]);
  const verdict = verdicts.has(String(raw.verdict)) ? raw.verdict! : "INCONCLUSIVE";
  return {
    verdict,
    explanation: String(raw.explanation || "Hive did not provide a detailed explanation."),
    confidence: clampPct(raw.confidence),
    signals: {
      ai_generated: clampPct(raw.signals?.ai_generated),
      not_ai_generated: clampPct(raw.signals?.not_ai_generated),
      deepfake: clampPct(raw.signals?.deepfake),
      frames_analyzed: Math.max(1, Math.round(Number(raw.signals?.frames_analyzed) || 1)),
    },
    likely_source: raw.likely_source?.name ? { name: String(raw.likely_source.name), confidence: clampPct(raw.likely_source.confidence) } : null,
    provenance: {
      detected: Boolean(raw.provenance?.detected),
      generator: raw.provenance?.generator ? String(raw.provenance.generator) : null,
      software_agent: raw.provenance?.software_agent ? String(raw.provenance.software_agent) : null,
      action: raw.provenance?.action ? String(raw.provenance.action) : null,
      digital_source_type: raw.provenance?.digital_source_type ? String(raw.provenance.digital_source_type) : null,
    },
    detector: "Hive AI-Generated & Deepfake Content Detection (V3)",
  };
}

export async function POST(request: Request) {
  const key = process.env.HIVE_API_KEY;
  if (!key) return response({ error: "Media detector is not configured. Add HIVE_API_KEY to the deployment environment." }, 503);

  try {
    const form = await request.formData();
    const file = form.get("file");
    const mediaUrl = typeof form.get("url") === "string" ? String(form.get("url")).trim() : "";

    let mediaType: "image" | "video";
    let mediaInput: { url: string };

    if (file instanceof File) {
      if (file.size > MAX_UPLOAD_BYTES) return response({ error: "Direct uploads are limited to 4 MB on DigiTrust. For larger videos, use a public media URL." }, 413);
      if (!IMAGE_TYPES.has(file.type) && !VIDEO_TYPES.has(file.type)) return response({ error: "Unsupported media type. Use JPG, PNG, WEBP, GIF, MP4, WEBM, MOV, AVI, MKV or WMV." }, 415);
      mediaType = IMAGE_TYPES.has(file.type) ? "image" : "video";
      const bytes = Buffer.from(await file.arrayBuffer());
      mediaInput = { url: `data:${file.type};base64,${bytes.toString("base64")}` };
    } else if (mediaUrl) {
      let url: URL;
      try { url = new URL(mediaUrl); } catch { return response({ error: "Invalid media URL." }, 400); }
      if (!/^https?:$/.test(url.protocol)) return response({ error: "Only HTTP/HTTPS media URLs are supported." }, 400);
      mediaType = /\.(mp4|webm|mov|avi|mkv|wmv)(?:\?|$)/i.test(url.pathname) ? "video" : "image";
      mediaInput = { url: mediaUrl };
    } else {
      return response({ error: "Upload an image/video or provide a public media URL." }, 400);
    }

    const mediaContent = mediaType === "video"
      ? { type: "media_url", media_url: { url: mediaInput.url, sampling: { strategy: "fps", fps: 1 }, prompt_scope: "once" } }
      : { type: "image_url", image_url: { url: mediaInput.url } };

    const upstream = await fetch(HIVE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: HIVE_MODEL,
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this ${mediaType} for AI generation and deepfake/manipulation signals. Return ONLY valid JSON with exactly these fields: verdict (AI_GENERATED, AI_MANIPULATED, NO_STRONG_AI_SIGNAL, or INCONCLUSIVE), explanation (string), confidence (0-100), signals (object containing ai_generated, not_ai_generated, deepfake, frames_analyzed as numbers), likely_source (object with name/confidence or null), and provenance (object containing detected, generator, software_agent, action, digital_source_type). Do not invent C2PA metadata. If unavailable, use null or 0.`,
            },
            mediaContent,
          ],
        }],
      }),
      signal: AbortSignal.timeout(55_000),
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const message = data?.error?.message || data?.message || data?.error || `Hive returned HTTP ${upstream.status}.`;
      return response({ error: String(message) }, upstream.status >= 500 ? 502 : 400);
    }

    const content = data?.choices?.[0]?.message?.content;
    return response(normalizeResult(parseModelJson(content)));
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Media analysis failed." }, 500);
  }
}
