import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 4_000_000;
const HIVE_DETECTOR_ENDPOINTS = [
  "https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection",
  "https://api-cdn.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection",
];
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
  let lastError = "Hive detector request failed.";

  for (const endpoint of HIVE_DETECTOR_ENDPOINTS) {
    try {
      const upstream = await fetch(endpoint, {
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
        lastError = `Hive detector HTTP ${upstream.status}: ${String(getStatusMessage(data) || text || "Unknown error").slice(0, 500)}`;
        continue;
      }

      return normalizeDetector(data);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Hive detector request failed.";
    }
  }

  throw new Error(lastError);
}

async function runVlmAnalysis(key: string, mediaType: "image" | "video", mediaInput: string) {
  const media =
    mediaType === "video"
      ? {
          type: "media_url",
          media_url: {
            url: mediaInput,
            sampling: { strategy: "fps", fps: 1 },
            prompt_scope: "per_frame",
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
        confidence: { type: "number", minimum: 0, maximum: 100 },
        ai_generated: { type: "number", minimum: 0, maximum: 100 },
        not_ai_generated: { type: "number", minimum: 0, maximum: 100 },
        deepfake: { type: "number", minimum: 0, maximum: 100 },
        likely_source_name: { type: "string" },
        likely_source_confidence: { type: "number", minimum: 0, maximum: 100 },
      },
      required: [
        "verdict",
        "explanation",
        "confidence",
        "ai_generated",
        "not_ai_generated",
        "deepfake",
        "likely_source_name",
        "likely_source_confidence",
      ],
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
      top_p: 0.1,
      top_k: 1,
      response_format: { type: "json_schema", json_schema: schema },
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: `Perform a forensic media authenticity assessment of this ${mediaType}.

Use visual evidence only. Do NOT infer that something is AI-generated merely because it looks polished, cinematic, smooth, unusual, animated, or synthetic-looking. Do not invent provenance or a generator.

Return:
- ai_generated: probability 0-100 that the media itself was generated by AI.
- deepfake: probability 0-100 that a face was AI-manipulated/swapped.
- not_ai_generated: probability 0-100 that it is human-created.
- confidence: confidence in the assessment.
For a normal human photograph with no convincing manipulation evidence, favor not_ai_generated.
For an obviously synthetic image/video, favor ai_generated.
For uncertain evidence, use INCONCLUSIVE.

Verdict rules:
- AI_GENERATED only when ai_generated >= 90.
- AI_MANIPULATED only when deepfake >= 90 for an image, or when deepfake >= 50 in at least 5% of sampled video frames.
- NO_STRONG_AI_SIGNAL only when not_ai_generated >= 90 and neither AI threshold is met.
- Otherwise INCONCLUSIVE.

If a specific generator cannot be established from visual evidence, leave likely_source_name empty and likely_source_confidence at 0.`,
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
    throw new Error(`Hive VLM HTTP ${upstream.status}: ${String(getStatusMessage(data) || text || "Unknown error").slice(0, 500)}`);
  }

  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const raws = choices
    .map((choice: any) => parseJsonContent(choice?.message?.content))
    .filter((value: any) => value && typeof value === "object");

  if (!raws.length) throw new Error("Hive VLM returned no structured media analysis.");

  const aiValues = raws.map((r: any) => Math.max(0, Math.min(100, Number(r.ai_generated) || 0)));
  const notAiValues = raws.map((r: any) => Math.max(0, Math.min(100, Number(r.not_ai_generated) || 0)));
  const deepfakeValues = raws.map((r: any) => Math.max(0, Math.min(100, Number(r.deepfake) || 0)));
  const ai = Math.max(...aiValues);
  const notAi = Math.max(...notAiValues);
  const deepfake = Math.max(...deepfakeValues);
  const confidence = Math.max(...raws.map((r: any) => Math.max(0, Math.min(100, Number(r.confidence) || 0))));
  const frames = mediaType === "video" ? raws.length : 1;

  let verdict: MediaAnalysis["verdict"] = "INCONCLUSIVE";
  if (mediaType === "video" && deepfakeValues.filter((value: number) => value >= 50).length >= Math.max(1, Math.ceil(frames * 0.05))) {
    verdict = "AI_MANIPULATED";
  } else if (deepfake >= 90) {
    verdict = "AI_MANIPULATED";
  } else if (ai >= 90) {
    verdict = "AI_GENERATED";
  } else if (notAi >= 90) {
    verdict = "NO_STRONG_AI_SIGNAL";
  }

  const bestSource = raws
    .map((r: any) => ({
      name: String(r.likely_source_name || "").trim(),
      confidence: Math.max(0, Math.min(100, Number(r.likely_source_confidence) || 0)),
    }))
    .filter((source: { name: string; confidence: number }) => source.name && source.confidence > 0)
    .sort((a: { name: string; confidence: number }, b: { name: string; confidence: number }) => b.confidence - a.confidence)[0] || null;

  return {
    verdict,
    explanation: String(raws[0]?.explanation || `Hive VLM media authenticity assessment of this ${mediaType}.`),
    confidence,
    signals: {
      ai_generated: ai,
      not_ai_generated: notAi,
      deepfake,
      frames_analyzed: frames,
    },
    likely_source: bestSource,
    provenance: {
      detected: false,
      generator: null,
      software_agent: null,
      action: null,
      digital_source_type: null,
    },
    detector: "Hive Vision Language Model (V3)",
  } satisfies MediaAnalysis;
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

      mediaType = /\.(mp4|webm|mov|avi|mkv|wmv)(?:\?|$)/i.test(url.pathname) ? "video" : "image";
      mediaInput = mediaUrl;
    } else {
      return response({ error: "Upload an image/video or provide a public media URL." }, 400);
    }

    try {
      return response(await runVlmAnalysis(key, mediaType, mediaInput));
    } catch (analysisError) {
      console.error("Hive VLM media analysis failed.", analysisError);
      return response({
        error: "Hive media analysis failed.",
        detail: analysisError instanceof Error ? analysisError.message : "Hive VLM analysis failed.",
      }, 502);
    }
  } catch (error) {
    console.error("Media analysis route failed.", error);
    return response({ error: error instanceof Error ? error.message : "Media analysis failed." }, 500);
  }
}
