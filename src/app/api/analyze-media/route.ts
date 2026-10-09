import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 4_000_000;
const HIVE_DETECTOR_ENDPOINT = "https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection";
const HIVE_CHAT_ENDPOINT = "https://api.thehive.ai/api/v3/chat/completions";
const HIVE_VLM_MODEL = "hive/vision-language-model";

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

function pct(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(1, n)) * 1000) / 10 : 0;
}

function getStatusMessage(data: any) {
  return (
    data?.message ||
    data?.error?.message ||
    data?.error ||
    data?.status?.message ||
    data?.status?.[0]?.status?.message ||
    data?.detail
  );
}

function extractResponse(data: any) {
  return data?.response || data?.status?.[0]?.response || data?.status?.response || data;
}

function extractFrames(data: any): any[] {
  const result = extractResponse(data);
  if (Array.isArray(result?.output)) return result.output;
  if (Array.isArray(result?.outputs)) return result.outputs;
  return [];
}

function classScores(frame: any): Record<string, number> {
  const classes = frame?.classes || frame?.output?.classes || [];
  const out: Record<string, number> = {};
  for (const item of Array.isArray(classes) ? classes : []) {
    if (item?.class) out[String(item.class)] = Number(item.score) || 0;
  }
  return out;
}

function normalizeDetector(data: any): MediaAnalysis {
  const frames = extractFrames(data);
  if (!frames.length) throw new Error("Hive detector returned no output frames.");

  let maxAi = 0;
  let maxNotAi = 0;
  let maxDeepfake = 0;
  const sourceScores: Record<string, number> = {};
  let generator: string | null = null;
  let softwareAgent: string | null = null;
  let action: string | null = null;
  let digitalSourceType: string | null = null;
  let c2paDetected = false;

  for (const frame of frames) {
    const scores = classScores(frame);
    maxAi = Math.max(maxAi, scores.ai_generated || 0);
    maxNotAi = Math.max(maxNotAi, scores.not_ai_generated || 0);
    maxDeepfake = Math.max(maxDeepfake, scores.deepfake || 0);

    for (const [name, score] of Object.entries(scores)) {
      if (!["ai_generated", "not_ai_generated", "deepfake", "inconclusive", "inconclusive_video", "none"].includes(name)) {
        sourceScores[name] = Math.max(sourceScores[name] || 0, score);
      }
    }

    const c2pa = frame?.algorithmic_tags?.c2pa;
    if (c2pa && typeof c2pa === "object" && Object.keys(c2pa).length) {
      c2paDetected = true;
      generator ||= c2pa.claim_generator || null;
      softwareAgent ||= c2pa.actions_software_agent || null;
      action ||= c2pa.actions_action || null;
      digitalSourceType ||= c2pa.actions_digital_source_type || null;
    }
  }

  const [sourceName, sourceScore] =
    Object.entries(sourceScores).sort((a, b) => b[1] - a[1])[0] || [];

  let verdict: MediaAnalysis["verdict"] = "INCONCLUSIVE";
  let confidence = Math.max(maxAi, maxNotAi, maxDeepfake);

  if (maxDeepfake >= 0.9) {
    verdict = "AI_MANIPULATED";
    confidence = maxDeepfake;
  } else if (maxAi >= 0.9) {
    verdict = "AI_GENERATED";
    confidence = maxAi;
  } else if (maxNotAi >= 0.9) {
    verdict = "NO_STRONG_AI_SIGNAL";
    confidence = maxNotAi;
  }

  return {
    verdict,
    explanation:
      verdict === "AI_GENERATED"
        ? "Hive detected a strong AI-generation signal."
        : verdict === "AI_MANIPULATED"
          ? "Hive detected a strong deepfake/manipulation signal."
          : verdict === "NO_STRONG_AI_SIGNAL"
            ? "Hive did not detect a strong AI-generation signal."
            : "Hive's detector confidence did not cross the configured decision threshold.",
    confidence: pct(confidence),
    signals: {
      ai_generated: pct(maxAi),
      not_ai_generated: pct(maxNotAi),
      deepfake: pct(maxDeepfake),
      frames_analyzed: Math.max(1, frames.length),
    },
    likely_source: sourceName ? { name: sourceName, confidence: pct(sourceScore) } : null,
    provenance: {
      detected: c2paDetected,
      generator,
      software_agent: softwareAgent,
      action,
      digital_source_type: digitalSourceType,
    },
    detector: "Hive AI-Generated & Deepfake Content Detection (V3)",
  };
}

function parseJsonContent(content: unknown) {
  if (typeof content !== "string") throw new Error("Hive VLM returned an unexpected response.");
  const cleaned = content
    .replace(/^\s*\`\`\`json\s*/i, "")
    .replace(/^\s*\`\`\`\s*/i, "")
    .replace(/\s*\`\`\`\s*$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object") throw new Error("Hive VLM returned invalid JSON.");
  return parsed as any;
}

function normalizeVlm(raw: any, mediaType: "image" | "video"): MediaAnalysis {
  const ai = Math.max(0, Math.min(100, Number(raw?.signals?.ai_generated) || 0));
  const notAi = Math.max(0, Math.min(100, Number(raw?.signals?.not_ai_generated) || 0));
  const deepfake = Math.max(0, Math.min(100, Number(raw?.signals?.deepfake) || 0));
  const confidence = Math.max(0, Math.min(100, Number(raw?.confidence) || Math.max(ai, notAi, deepfake)));

  let verdict: MediaAnalysis["verdict"] = "INCONCLUSIVE";
  if (deepfake >= 90) verdict = "AI_MANIPULATED";
  else if (ai >= 90) verdict = "AI_GENERATED";
  else if (notAi >= 90) verdict = "NO_STRONG_AI_SIGNAL";

  return {
    verdict,
    explanation: String(raw?.explanation || `Hive VLM fallback analysis of this ${mediaType}.`),
    confidence,
    signals: {
      ai_generated: ai,
      not_ai_generated: notAi,
      deepfake,
      frames_analyzed: Math.max(1, Math.round(Number(raw?.signals?.frames_analyzed) || 1)),
    },
    likely_source: raw?.likely_source?.name
      ? { name: String(raw.likely_source.name), confidence: Math.max(0, Math.min(100, Number(raw.likely_source.confidence) || 0)) }
      : null,
    provenance: {
      detected: Boolean(raw?.provenance?.detected),
      generator: raw?.provenance?.generator ? String(raw.provenance.generator) : null,
      software_agent: raw?.provenance?.software_agent ? String(raw.provenance.software_agent) : null,
      action: raw?.provenance?.action ? String(raw.provenance.action) : null,
      digital_source_type: raw?.provenance?.digital_source_type ? String(raw.provenance.digital_source_type) : null,
    },
    detector: "Hive Vision Language Model (V3 fallback)",
  };
}

async function runDetector(key: string, mediaInput: string) {
  const upstream = await fetch(HIVE_DETECTOR_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ input: { url: mediaInput } }),
    signal: AbortSignal.timeout(45_000),
  });

  const text = await upstream.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}

  if (!upstream.ok) {
    throw new Error(`Hive detector HTTP ${upstream.status}: ${String(getStatusMessage(data) || text || "Unknown error").slice(0, 500)}`);
  }

  return normalizeDetector(data);
}

async function runVlmFallback(key: string, mediaType: "image" | "video", mediaInput: string) {
  const media =
    mediaType === "video"
      ? {
          type: "media_url",
          media_url: {
            url: mediaInput,
            sampling: { strategy: "fps", fps: 1 },
            prompt_scope: "once",
          },
        }
      : {
          type: "image_url",
          image_url: { url: mediaInput },
        };

  const schema = {
    name: "media_authenticity",
    schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["AI_GENERATED", "AI_MANIPULATED", "NO_STRONG_AI_SIGNAL", "INCONCLUSIVE"] },
        explanation: { type: "string" },
        confidence: { type: "number" },
        signals: {
          type: "object",
          properties: {
            ai_generated: { type: "number" },
            not_ai_generated: { type: "number" },
            deepfake: { type: "number" },
            frames_analyzed: { type: "number" },
          },
          required: ["ai_generated", "not_ai_generated", "deepfake", "frames_analyzed"],
          additionalProperties: false,
        },
        likely_source: {
          anyOf: [
            {
              type: "object",
              properties: {
                name: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["name", "confidence"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
        provenance: {
          type: "object",
          properties: {
            detected: { type: "boolean" },
            generator: { anyOf: [{ type: "string" }, { type: "null" }] },
            software_agent: { anyOf: [{ type: "string" }, { type: "null" }] },
            action: { anyOf: [{ type: "string" }, { type: "null" }] },
            digital_source_type: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["detected", "generator", "software_agent", "action", "digital_source_type"],
          additionalProperties: false,
        },
      },
      required: ["verdict", "explanation", "confidence", "signals", "likely_source", "provenance"],
      additionalProperties: false,
    },
    strict: true,
  };

  const upstream = await fetch(HIVE_CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: HIVE_VLM_MODEL,
      max_tokens: 500,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: schema },
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: `Assess this ${mediaType} for synthetic generation and face manipulation. This is a fallback classifier, not the dedicated Hive detector. Return calibrated probabilities from 0 to 100. Do not claim provenance unless visible in supplied metadata.`,
          },
          media,
        ],
      }],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  const text = await upstream.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}

  if (!upstream.ok) {
    throw new Error(`Hive VLM fallback HTTP ${upstream.status}: ${String(getStatusMessage(data) || text || "Unknown error").slice(0, 500)}`);
  }

  return normalizeVlm(parseJsonContent(data?.choices?.[0]?.message?.content), mediaType);
}

export async function POST(request: Request) {
  const key = process.env.HIVE_API_KEY?.trim();
  if (!key) return response({ error: "Media detector is not configured. Add HIVE_API_KEY to the deployment environment." }, 503);

  try {
    const form = await request.formData();
    const file = form.get("file");
    const mediaUrl = typeof form.get("url") === "string" ? String(form.get("url")).trim() : "";

    let mediaType: "image" | "video";
    let mediaInput: string;

    if (file instanceof File) {
      if (file.size > MAX_UPLOAD_BYTES) {
        return response({ error: "Direct uploads are limited to 4 MB on DigiTrust. For larger media, use a public media URL." }, 413);
      }
      if (!IMAGE_TYPES.has(file.type) && !VIDEO_TYPES.has(file.type)) {
        return response({ error: "Unsupported media type. Use JPG, PNG, WEBP, GIF, MP4, WEBM, MOV, AVI, MKV or WMV." }, 415);
      }

      mediaType = IMAGE_TYPES.has(file.type) ? "image" : "video";
      const bytes = Buffer.from(await file.arrayBuffer());
      mediaInput = `data:${file.type};base64,${bytes.toString("base64")}`;
    } else if (mediaUrl) {
      let url: URL;
      try { url = new URL(mediaUrl); } catch { return response({ error: "Invalid media URL." }, 400); }
      if (!/^https?:$/.test(url.protocol)) return response({ error: "Only HTTP/HTTPS media URLs are supported." }, 400);

      mediaType = /.(mp4|webm|mov|avi|mkv|wmv)(?:?|$)/i.test(url.pathname) ? "video" : "image";
      mediaInput = mediaUrl;
    } else {
      return response({ error: "Upload an image/video or provide a public media URL." }, 400);
    }

    try {
      return response(await runDetector(key, mediaInput));
    } catch (detectorError) {
      console.error("Hive dedicated detector failed; attempting VLM fallback.", detectorError);

      try {
        return response(await runVlmFallback(key, mediaType, mediaInput));
      } catch (fallbackError) {
        console.error("Hive VLM fallback failed.", fallbackError);
        return response({
          error: "Hive media analysis failed.",
          detail: detectorError instanceof Error ? detectorError.message : "Dedicated detector failed.",
          fallback: fallbackError instanceof Error ? fallbackError.message : "VLM fallback failed.",
        }, 502);
      }
    }
  } catch (error) {
    console.error("Media analysis route failed.", error);
    return response({ error: error instanceof Error ? error.message : "Media analysis failed." }, 500);
  }
}
