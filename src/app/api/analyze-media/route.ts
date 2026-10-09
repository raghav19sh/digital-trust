import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 4_000_000;
const HIVE_ENDPOINT = "https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection";
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
  return data?.message || data?.error?.message || data?.error || data?.status?.message || data?.status?.[0]?.status?.message;
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
  if (!frames.length) throw new Error("Hive returned no detector frames.");

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
      if (!["ai_generated", "not_ai_generated", "deepfake", "inconclusive", "inconclusive_video"].includes(name)) {
        sourceScores[name] = Math.max(sourceScores[name] || 0, score);
      }
    }

    const c2pa = frame?.algorithmic_tags?.c2pa;
    if (c2pa && Object.keys(c2pa).length) {
      c2paDetected = true;
      generator ||= c2pa.claim_generator || null;
      softwareAgent ||= c2pa.actions_software_agent || null;
      action ||= c2pa.actions_action || null;
      digitalSourceType ||= c2pa.actions_digital_source_type || null;
    }
  }

  const [sourceName, sourceScore] = Object.entries(sourceScores)
    .filter(([name]) => !["none"].includes(name))
    .sort((a, b) => b[1] - a[1])[0] || [];

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

  const explanation =
    verdict === "AI_GENERATED"
      ? "Hive detected a strong AI-generation signal."
      : verdict === "AI_MANIPULATED"
        ? "Hive detected a strong deepfake/manipulation signal."
        : verdict === "NO_STRONG_AI_SIGNAL"
          ? "Hive did not detect a strong AI-generation signal."
          : "Hive's confidence did not cross the configured decision threshold.";

  return {
    verdict,
    explanation,
    confidence: pct(confidence),
    signals: {
      ai_generated: pct(maxAi),
      not_ai_generated: pct(maxNotAi),
      deepfake: pct(maxDeepfake),
      frames_analyzed: Math.max(1, frames.length),
    },
    likely_source: sourceName && sourceName !== "none"
      ? { name: sourceName, confidence: pct(sourceScore) }
      : null,
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

export async function POST(request: Request) {
  const key = process.env.HIVE_API_KEY;
  if (!key) return response({ error: "Media detector is not configured. Add HIVE_API_KEY to the deployment environment." }, 503);

  try {
    const form = await request.formData();
    const file = form.get("file");
    const mediaUrl = typeof form.get("url") === "string" ? String(form.get("url")).trim() : "";

    let mediaType: "image" | "video";
    let mediaInput: string;

    if (file instanceof File) {
      if (file.size > MAX_UPLOAD_BYTES) return response({ error: "Direct uploads are limited to 4 MB on DigiTrust. For larger videos, use a public media URL." }, 413);
      if (!IMAGE_TYPES.has(file.type) && !VIDEO_TYPES.has(file.type)) return response({ error: "Unsupported media type. Use JPG, PNG, WEBP, GIF, MP4, WEBM, MOV, AVI, MKV or WMV." }, 415);
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

    const upstream = await fetch(HIVE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        input: { url: mediaInput },
      }),
      signal: AbortSignal.timeout(55_000),
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const message = getStatusMessage(data) || `Hive returned HTTP ${upstream.status}.`;
      return response({ error: String(message) }, upstream.status >= 500 ? 502 : 400);
    }

    return response(normalizeDetector(data));
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Media analysis failed." }, 500);
  }
}
