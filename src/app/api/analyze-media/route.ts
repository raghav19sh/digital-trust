import { NextResponse } from "next/server";
import sharp from "sharp";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 4_000_000;
const MAX_REMOTE_BYTES = 4_000_000;
const HIVE_CHAT_ENDPOINT = "https://api.thehive.ai/api/v3/chat/completions";
const HIVE_VLM_MODEL = "hive/vision-language-model";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "video/x-msvideo", "video/x-matroska", "video/x-ms-wmv"]);

type ForensicSignals = {
  metadata: {
    available: boolean;
    score: number;
    anomaly: number;
    fields: string[];
    software: string | null;
    camera: string | null;
    c2pa: boolean;
  };
  frequency: {
    available: boolean;
    score: number;
    low_energy: number;
    mid_energy: number;
    high_energy: number;
    high_frequency_ratio: number;
    note: string;
  };
  face: {
    available: boolean;
    score: number;
    source: string;
  };
};

type MediaAnalysis = {
  verdict: "AI_GENERATED" | "AI_MANIPULATED" | "NO_STRONG_AI_SIGNAL" | "INCONCLUSIVE";
  explanation: string;
  confidence: number;
  signals: { ai_generated: number; not_ai_generated: number; deepfake: number; frames_analyzed: number };
  forensic: ForensicSignals;
  likely_source: { name: string; confidence: number } | null;
  provenance: { detected: boolean; generator: string | null; software_agent: string | null; action: string | null; digital_source_type: string | null };
  detector: string;
};

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function pct(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(clamp(n, 0, 1) * 1000) / 10 : 0;
}

function getStatusMessage(data: any) {
  return data?.message || data?.error?.message || data?.error || data?.status?.message || data?.status?.[0]?.status?.message || data?.detail;
}

function parseJsonContent(content: unknown) {
  if (typeof content !== "string") throw new Error("Hive VLM returned an unexpected response.");
  const cleaned = content.replace(/^\s*\`\`\`json\s*/i, "").replace(/^\s*\`\`\`\s*/i, "").replace(/\s*\`\`\`\s*$/i, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object") throw new Error("Hive VLM returned invalid JSON.");
  return parsed as any;
}

function ascii(buffer: Buffer, start: number, length: number) {
  return buffer.subarray(start, start + length).toString("latin1");
}

function extractMetadata(buffer: Buffer, mime: string): ForensicSignals["metadata"] {
  const fields: string[] = [];
  let software: string | null = null;
  let camera: string | null = null;
  let c2pa = false;

  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
      const marker = buffer[offset + 1];
      if (marker === 0xda) break;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const len = buffer.readUInt16BE(offset + 2);
      if (len < 2 || offset + 2 + len > buffer.length) break;
      const payload = buffer.subarray(offset + 4, offset + 2 + len);
      const text = payload.toString("latin1");
      if (marker === 0xe1) {
        if (text.includes("http://ns.adobe.com/xap/1.0/") || text.includes("http://ns.adobe.com/xmp/")) fields.push("XMP");
        if (text.includes("c2pa") || text.includes("C2PA")) c2pa = true;
        if (text.includes("CreatorTool")) fields.push("CreatorTool");
        const creator = text.match(/CreatorTool[^>]*>([^<]+)/i)?.[1];
        if (creator) software = creator.trim().slice(0, 160);
      } else if (marker === 0xed) {
        fields.push("APP13/IPTC");
        if (text.toLowerCase().includes("photoshop")) software ||= "Adobe Photoshop";
      } else if (marker === 0xe0) {
        const sig = ascii(payload, 0, 5);
        if (sig === "JFIF\0") fields.push("JFIF");
      } else if (marker === 0xe2) {
        if (text.includes("ICC_PROFILE")) fields.push("ICC");
        if (text.includes("c2pa") || text.includes("C2PA")) c2pa = true;
      }
      if (marker === 0xe1 && text.includes("Exif\0\0")) {
        fields.push("EXIF");
        const make = text.match(/(?:Make|Model)[^\x20\x00]{0,2}[\x00 ]+([^\x00]{2,60})/i)?.[1];
        if (make) camera = make.trim().slice(0, 120);
      }
      offset += 2 + len;
    }
  } else if (mime === "image/png") {
    let offset = 8;
    while (offset + 12 <= buffer.length) {
      const len = buffer.readUInt32BE(offset);
      if (offset + 12 + len > buffer.length) break;
      const type = ascii(buffer, offset + 4, 4);
      const payload = buffer.subarray(offset + 8, offset + 8 + len);
      if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
        fields.push(type);
        const text = payload.toString("latin1");
        if (/c2pa|content credentials/i.test(text)) c2pa = true;
        const match = text.match(/(?:software|creator|creatortool)[^\x00:=]*[:=]\s*([^\x00]+)/i);
        if (match) software = match[1].trim().slice(0, 160);
      }
      offset += 12 + len;
      if (type === "IEND") break;
    }
  }

  const suspiciousSoftware = /photoshop|lightroom|midjourney|stable diffusion|comfyui|dall[- ]?e|firefly|flux|gemini|imagen/i.test(software || "");
  const anomaly = clamp((c2pa ? 0 : 8) + (suspiciousSoftware ? 25 : 0) + (fields.length === 0 ? 8 : 0));
  return {
    available: fields.length > 0 || Boolean(software) || c2pa,
    score: anomaly,
    anomaly,
    fields: [...new Set(fields)],
    software,
    camera,
    c2pa,
  };
}

function dct1d(input: number[]) {
  const n = input.length;
  const out = new Array<number>(n).fill(0);
  const factor = Math.PI / n;
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += input[i] * Math.cos((i + 0.5) * k * factor);
    out[k] = sum * (k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n));
  }
  return out;
}

async function analyzeFrequency(buffer: Buffer, mime: string): Promise<ForensicSignals["frequency"]> {
  if (!mime.startsWith("image/")) {
    return { available: false, score: 0, low_energy: 0, mid_energy: 0, high_energy: 0, high_frequency_ratio: 0, note: "Frequency analysis currently applies to decoded images." };
  }

  try {
    const { data, info } = await sharp(buffer)
      .resize({ width: 32, height: 32, fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rows: number[][] = [];
    for (let y = 0; y < info.height; y++) {
      const row: number[] = [];
      for (let x = 0; x < info.width; x++) row.push((data[y * info.width + x] - 128) / 128);
      rows.push(dct1d(row));
    }

    const coeff = Array.from({ length: info.height }, (_, y) => dct1d(rows.map(row => row[y])));
    let low = 0, mid = 0, high = 0, total = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const e = coeff[y][x] ** 2;
        total += e;
        const radius = Math.sqrt(x * x + y * y);
        if (radius <= 5) low += e;
        else if (radius <= 13) mid += e;
        else high += e;
      }
    }

    const highRatio = total ? high / total : 0;
    const midRatio = total ? mid / total : 0;
    const score = clamp(
      Math.abs(highRatio - 0.24) * 170 +
      Math.abs(midRatio - 0.46) * 90
    );

    return {
      available: true,
      score: Math.round(score * 10) / 10,
      low_energy: Math.round((low / Math.max(total, 1)) * 1000) / 10,
      mid_energy: Math.round(midRatio * 1000) / 10,
      high_energy: Math.round(highRatio * 1000) / 10,
      high_frequency_ratio: Math.round(highRatio * 1000) / 10,
      note: "Heuristic DCT fingerprint; useful as supporting evidence, not a standalone AI classifier.",
    };
  } catch {
    return { available: false, score: 0, low_energy: 0, mid_energy: 0, high_energy: 0, high_frequency_ratio: 0, note: "Image could not be decoded for frequency analysis." };
  }
}

function combineForensics(metadata: ForensicSignals["metadata"], frequency: ForensicSignals["frequency"], deepfake: number): ForensicSignals {
  return {
    metadata,
    frequency,
    face: {
      available: deepfake > 0,
      score: deepfake,
      source: "Hive V3 deepfake signal; not a separate face model",
    },
  };
}

async function runForensics(buffer: Buffer, mime: string, deepfake = 0) {
  const metadata = extractMetadata(buffer, mime);
  const frequency = await analyzeFrequency(buffer, mime);
  return combineForensics(metadata, frequency, deepfake);
}

function fuseVerdict(ai: number, notAi: number, deepfake: number, forensic: ForensicSignals): Pick<MediaAnalysis, "verdict" | "confidence" | "explanation"> {
  const forensicAnomaly = Math.max(forensic.metadata.anomaly, forensic.frequency.score);
  let verdict: MediaAnalysis["verdict"] = "INCONCLUSIVE";
  if (deepfake >= 90) verdict = "AI_MANIPULATED";
  else if (ai >= 90) verdict = "AI_GENERATED";
  else if (ai >= 70 && forensicAnomaly >= 45) verdict = "AI_GENERATED";
  else if (notAi >= 90 && ai < 70 && forensicAnomaly < 45) verdict = "NO_STRONG_AI_SIGNAL";

  const confidence = clamp(Math.round(Math.max(ai, notAi, deepfake, forensicAnomaly * 0.85)));
  const explanation =
    verdict === "AI_GENERATED"
      ? ai >= 90 ? "Hive found a strong synthetic-generation signal, supported by forensic media evidence where available." : "Hive found a substantial synthetic-generation signal and the metadata/frequency evidence also shows anomalies."
      : verdict === "AI_MANIPULATED"
        ? "A strong face-manipulation/deepfake signal was detected."
        : verdict === "NO_STRONG_AI_SIGNAL"
          ? "No strong AI signal was detected, and the available forensic layers did not show a high-confidence anomaly."
          : "Evidence is mixed. Model output and forensic signals are not strong enough for a responsible binary classification.";

  return { verdict, confidence, explanation };
}

async function runVlmAnalysis(key: string, mediaType: "image" | "video", mediaInput: string) {
  const media = mediaType === "video"
    ? { type: "media_url", media_url: { url: mediaInput, sampling: { strategy: "fps", fps: 1 }, prompt_scope: "per_frame" } }
    : { type: "image_url", image_url: { url: mediaInput } };

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
      required: ["verdict","explanation","confidence","ai_generated","not_ai_generated","deepfake","likely_source_name","likely_source_confidence"],
      additionalProperties: false,
    },
    strict: true,
  };

  const upstream = await fetch(HIVE_CHAT_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key.trim()}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      model: HIVE_VLM_MODEL,
      max_tokens: 500,
      temperature: 0,
      top_p: 0.1,
      top_k: 1,
      response_format: { type: "json_schema", json_schema: schema },
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: `Perform a forensic media authenticity assessment of this ${mediaType}. Use visual evidence only. Do not call something AI-generated merely because it looks polished, cinematic, smooth, unusual or synthetic-looking. Look for generation artifacts, inconsistent textures, local detail failures, face/identity inconsistencies, lighting/shadow contradictions and temporal inconsistencies. Return conservative probabilities and do not invent provenance or a generator.`,
        }, media],
      }],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  const text = await upstream.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}
  if (!upstream.ok) throw new Error(`Hive VLM HTTP ${upstream.status}: ${String(getStatusMessage(data) || text || "Unknown error").slice(0, 500)}`);

  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const raws = choices.map((choice: any) => parseJsonContent(choice?.message?.content)).filter((value: any) => value && typeof value === "object");
  if (!raws.length) throw new Error("Hive VLM returned no structured media analysis.");

  const ai = Math.max(...raws.map((r: any) => clamp(Number(r.ai_generated) || 0)));
  const notAi = Math.max(...raws.map((r: any) => clamp(Number(r.not_ai_generated) || 0)));
  const deepfake = Math.max(...raws.map((r: any) => clamp(Number(r.deepfake) || 0)));
  const confidence = Math.max(...raws.map((r: any) => clamp(Number(r.confidence) || 0)));
  const bestSource = raws.map((r: any) => ({ name: String(r.likely_source_name || "").trim(), confidence: clamp(Number(r.likely_source_confidence) || 0) })).filter((s: any) => s.name && s.confidence > 0).sort((a: any,b: any)=>b.confidence-a.confidence)[0] || null;

  return {
    ai, notAi, deepfake, confidence, bestSource,
    frames: mediaType === "video" ? raws.length : 1,
    explanation: String(raws[0]?.explanation || ""),
  };
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
    let forensic: ForensicSignals = {
      metadata: { available:false, score:0, anomaly:0, fields:[], software:null, camera:null, c2pa:false },
      frequency: { available:false, score:0, low_energy:0, mid_energy:0, high_energy:0, high_frequency_ratio:0, note:"Unavailable." },
      face: { available:false, score:0, source:"Not available." },
    };

    if (file instanceof File) {
      if (file.size > MAX_UPLOAD_BYTES) return response({ error: "Direct uploads are limited to 4 MB on DigiTrust." }, 413);
      if (!IMAGE_TYPES.has(file.type) && !VIDEO_TYPES.has(file.type)) return response({ error: "Unsupported media type. Use JPG, PNG, WEBP, GIF, MP4, WEBM, M4V, MOV, AVI, MKV or WMV." }, 415);
      mediaType = IMAGE_TYPES.has(file.type) ? "image" : "video";
      const bytes = Buffer.from(await file.arrayBuffer());
      mediaInput = `data:${file.type};base64,${bytes.toString("base64")}`;
      forensic = await runForensics(bytes, file.type);
    } else if (mediaUrl) {
      let url: URL;
      try { url = new URL(mediaUrl); } catch { return response({ error: "Invalid media URL." }, 400); }
      if (!/^https?:$/.test(url.protocol)) return response({ error: "Only HTTP/HTTPS media URLs are supported." }, 400);
      mediaType = /\.(mp4|webm|m4v|mov|avi|mkv|wmv)(?:\?|$)/i.test(url.pathname) ? "video" : "image";
      mediaInput = mediaUrl;
    } else {
      return response({ error: "Upload an image/video or provide a public media URL." }, 400);
    }

    const analysis = await runVlmAnalysis(key, mediaType, mediaInput);
    if (file instanceof File) forensic.face = { available: analysis.deepfake > 0, score: analysis.deepfake, source: "Hive V3 deepfake signal; not a separate face model" };

    const fused = fuseVerdict(analysis.ai, analysis.notAi, analysis.deepfake, forensic);
    return response({
      verdict: fused.verdict,
      explanation: fused.explanation + (analysis.explanation ? ` Visual model note: ${analysis.explanation}` : ""),
      confidence: fused.confidence,
      signals: {
        ai_generated: Math.round(analysis.ai * 10) / 10,
        not_ai_generated: Math.round(analysis.notAi * 10) / 10,
        deepfake: Math.round(analysis.deepfake * 10) / 10,
        frames_analyzed: analysis.frames,
      },
      forensic,
      likely_source: analysis.bestSource,
      provenance: {
        detected: forensic.metadata.c2pa,
        generator: null,
        software_agent: forensic.metadata.software,
        action: null,
        digital_source_type: null,
      },
      detector: "Hive V3 VLM + metadata + DCT frequency forensics",
    } satisfies MediaAnalysis);
  } catch (error) {
    console.error("Media analysis route failed.", error);
    return response({ error: "Media analysis failed.", detail: error instanceof Error ? error.message : "Unknown error" }, 502);
  }
}
