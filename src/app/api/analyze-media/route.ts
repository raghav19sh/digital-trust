import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 4_000_000;
const HIVE_ENDPOINT = "https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-matroska", "video/x-ms-wmv"]);

type HiveClass = { class?: string; score?: number };
type HiveOutput = { classes?: HiveClass[]; algorithmic_tags?: Record<string, any>; time?: number };

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function pct(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 10;
}

function collectOutputs(data: any): HiveOutput[] {
  const candidates = [
    ...(Array.isArray(data?.output) ? data.output : []),
    ...(Array.isArray(data?.response?.output) ? data.response.output : []),
    ...(Array.isArray(data?.status) ? data.status.flatMap((item: any) => item?.response?.output ?? []) : []),
  ];
  return candidates.filter((output: any) => output && typeof output === "object");
}

function topClass(outputs: HiveOutput[], name: string) {
  let best = 0;
  for (const output of outputs) {
    for (const item of output.classes ?? []) {
      if (item.class === name) best = Math.max(best, Number(item.score) || 0);
    }
  }
  return best;
}

function allClassScores(outputs: HiveOutput[], name: string) {
  return outputs.flatMap((output) =>
    (output.classes ?? [])
      .filter((item) => item.class === name)
      .map((item) => Number(item.score) || 0),
  );
}

function provenance(outputs: HiveOutput[]) {
  for (const output of outputs) {
    const c2pa = output.algorithmic_tags?.c2pa;
    if (c2pa && typeof c2pa === "object") {
      return {
        detected: true,
        generator: c2pa.claim_generator || null,
        software_agent: c2pa.actions_software_agent || null,
        action: c2pa.actions_action || null,
        digital_source_type: c2pa.actions_digital_source_type || null,
      };
    }
  }
  return { detected: false, generator: null, software_agent: null, action: null, digital_source_type: null };
}

function analyzeResult(data: any, mediaType: "image" | "video") {
  const outputs = collectOutputs(data);
  if (!outputs.length) throw new Error("The detector returned no analyzable frames.");

  const generated = topClass(outputs, "ai_generated");
  const notGenerated = topClass(outputs, "not_ai_generated");
  const deepfakeScores = allClassScores(outputs, "deepfake");
  const deepfake = Math.max(0, ...deepfakeScores);
  const provenanceData = provenance(outputs);

  const sourceScores = new Map<string, number>();
  const excluded = new Set(["ai_generated", "not_ai_generated", "deepfake", "none", "inconclusive", "inconclusive_video"]);
  for (const output of outputs) {
    for (const item of output.classes ?? []) {
      if (!item.class || excluded.has(item.class)) continue;
      const score = Number(item.score) || 0;
      if (score > (sourceScores.get(item.class) ?? 0)) sourceScores.set(item.class, score);
    }
  }
  const source = [...sourceScores.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  const aiEditSources = new Set(["stablediffusioninpaint", "sdxlinpaint"]);
  const aiEditSource = [...sourceScores.entries()].find(([name, score]) => aiEditSources.has(name) && score >= 0.5);
  const c2paSaysAiEdit =
    provenanceData.detected &&
    /edited|filtered|placed/i.test(String(provenanceData.action ?? "")) &&
    (/trainedalgorithmicmedia|generative|algorithmic/i.test(String(provenanceData.digital_source_type ?? "")) ||
      /gpt|dall|midjourney|firefly|stable|runway|sora|gemini|veo|kling|adobe|openai/i.test(String(provenanceData.software_agent ?? "")));

  let verdict: "AI_GENERATED" | "AI_MANIPULATED" | "NO_STRONG_AI_SIGNAL" | "INCONCLUSIVE";
  let explanation: string;

  const videoDeepfake =
    mediaType === "video"
      ? deepfakeScores.filter((score) => score >= 0.5).length >= 2 ||
        deepfakeScores.filter((score) => score >= 0.5).length / Math.max(1, outputs.length) >= 0.05
      : deepfake >= 0.9;

  if (generated >= 0.9 || (provenanceData.detected && /trainedAlgorithmicMedia/i.test(String(provenanceData.digital_source_type ?? "")) && generated >= 0.5)) {
    verdict = "AI_GENERATED";
    explanation = "The media has a strong synthetic-generation signal.";
  } else if (videoDeepfake || deepfake >= 0.9 || aiEditSource || c2paSaysAiEdit) {
    verdict = "AI_MANIPULATED";
    explanation = "The media has a strong signal of AI-based manipulation, face synthesis, or AI-assisted editing.";
  } else if (Math.max(generated, deepfake) < 0.35 && notGenerated >= 0.65 && !provenanceData.detected) {
    verdict = "NO_STRONG_AI_SIGNAL";
    explanation = "No strong AI-generation or deepfake signal was detected by the configured detector.";
  } else {
    verdict = "INCONCLUSIVE";
    explanation = "The available signals are not strong enough for a reliable classification.";
  }

  return {
    verdict,
    explanation,
    confidence: pct(verdict === "AI_GENERATED" ? generated : verdict === "AI_MANIPULATED" ? Math.max(deepfake, aiEditSource?.[1] ?? 0) : Math.max(notGenerated, 1 - generated)),
    signals: {
      ai_generated: pct(generated),
      not_ai_generated: pct(notGenerated),
      deepfake: pct(deepfake),
      frames_analyzed: outputs.length,
    },
    likely_source: source ? { name: source[0], confidence: pct(source[1]) } : null,
    provenance: provenanceData,
    detector: "Hive AI-Generated & Deepfake Image/Video Detection (V3)",
  };
}

export async function POST(request: Request) {
  const key = process.env.HIVE_API_KEY;
  if (!key) return response({ error: "Media detector is not configured. Add HIVE_API_KEY to the deployment environment." }, 503);

  try {
    const form = await request.formData();
    const file = form.get("file");
    const mediaUrl = typeof form.get("url") === "string" ? String(form.get("url")).trim() : "";

    let type: "image" | "video";
    let input: { url: string };

    if (file instanceof File) {
      if (file.size > MAX_UPLOAD_BYTES) {
        return response({ error: "Direct uploads are limited to 4 MB on DigiTrust. For larger videos, use a public media URL." }, 413);
      }
      if (!IMAGE_TYPES.has(file.type) && !VIDEO_TYPES.has(file.type)) {
        return response({ error: "Unsupported media type. Use JPG, PNG, WEBP, GIF, MP4, WEBM, MOV, AVI, MKV or WMV." }, 415);
      }
      type = IMAGE_TYPES.has(file.type) ? "image" : "video";
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
      }
      input = { url: `data:${file.type};base64,${Buffer.from(binary, "binary").toString("base64")}` };
    } else if (mediaUrl) {
      let url: URL;
      try {
        url = new URL(mediaUrl);
      } catch {
        return response({ error: "Invalid media URL." }, 400);
      }
      if (!/^https?:$/.test(url.protocol)) return response({ error: "Only HTTP/HTTPS media URLs are supported." }, 400);
      type = /\.(mp4|webm|mov|avi|mkv|wmv)(?:\?|$)/i.test(url.pathname) ? "video" : "image";
      input = { url: mediaUrl };
    } else {
      return response({ error: "Upload an image/video or provide a public media URL." }, 400);
    }

    const upstream = await fetch(HIVE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(55_000),
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const message = data?.message || data?.error || `Media detector returned HTTP ${upstream.status}.`;
      return response({ error: String(message) }, upstream.status >= 500 ? 502 : 400);
    }

    return response(analyzeResult(data, type));
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Media analysis failed." }, 500);
  }
}
