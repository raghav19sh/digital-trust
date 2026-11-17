import { NextResponse } from "next/server";
import sharp from "sharp";
import dns from "node:dns/promises";
import net from "node:net";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 4_000_000;
const MAX_REMOTE_BYTES = 4_000_000;
const SIGHTENGINE_IMAGE_ENDPOINT = "https://api.sightengine.com/1.0/check.json";
const SIGHTENGINE_VIDEO_ENDPOINT = "https://api.sightengine.com/1.0/video/check-sync.json";
const MAX_REMOTE_VIDEO_BYTES = 20_000_000;

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

type MediaVerdict = "AI_GENERATED" | "AI_MANIPULATED" | "NO_STRONG_AI_SIGNAL" | "INCONCLUSIVE";

type MediaAnalysis = {
  verdict: MediaVerdict;
  explanation: string;
  confidence: number;
  signals: { ai_generated: number; not_ai_generated: number; deepfake: number; frames_analyzed: number; model_verdict: MediaVerdict; model_confidence: number; source_confidence: number; non_ai_source: number };
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

  // Missing EXIF/XMP is common after social-media recompression and is neutral.
  // Editing software alone is not proof of synthetic generation.
  const generatorSoftware = /midjourney|stable diffusion|comfyui|automatic1111|dall[- ]?e|adobe firefly|imagen|leonardo\.ai|ideogram|flux(?:\s|$)/i.test(software || "");
  const anomaly = generatorSoftware ? 85 : 0;
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
      source: "Sightengine dedicated deepfake classifier",
    },
  };
}

async function runForensics(buffer: Buffer, mime: string, deepfake = 0) {
  const metadata = extractMetadata(buffer, mime);
  const frequency = await analyzeFrequency(buffer, mime);
  return combineForensics(metadata, frequency, deepfake);
}

function isPublicAddress(address: string) {
  if (net.isIPv4(address)) {
    const [a,b] = address.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
    return true;
  }
  if (!net.isIPv6(address)) return false;
  const value = address.toLowerCase();
  return (/^[23]/.test(value) && !value.startsWith('2001:db8:'));
}

async function fetchRemoteMedia(input: string, allowedTypes: Set<string>, maxBytes: number) {
  let current = input;
  for (let hop = 0; hop <= 3; hop++) {
    const url = new URL(current);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only public HTTP/HTTPS media URLs are supported.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("Media URL resolves to a private or non-public address.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let upstream: Response;
    try {
      upstream = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { "user-agent": "DigiTrust/2.0", accept: [...allowedTypes].join(",") } });
    } finally {
      clearTimeout(timeout);
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      await upstream.body?.cancel();
      if (!location) throw new Error("Media URL returned an invalid redirect.");
      current = new URL(location, url).toString();
      continue;
    }
    if (!upstream.ok) throw new Error("Could not retrieve remote media (HTTP " + upstream.status + ").");
    const mime = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!allowedTypes.has(mime)) throw new Error("The URL did not return a supported media type.");
    const declared = Number(upstream.headers.get("content-length") || 0);
    if (declared > maxBytes) {
      await upstream.body?.cancel();
      throw new Error("Remote media exceeds the " + Math.round(maxBytes / 1_000_000) + " MB analysis limit.");
    }
    if (!upstream.body) throw new Error("Remote media response was empty.");
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error("Remote media exceeds the " + Math.round(maxBytes / 1_000_000) + " MB analysis limit.");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    return { buffer: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), mime, url: current };
  }
  throw new Error("Too many redirects while retrieving remote media.");
}
function fuseVerdict(ai: number, deepfake: number): Pick<MediaAnalysis, "verdict" | "confidence" | "explanation"> {
  let verdict: MediaVerdict = "INCONCLUSIVE";
  if (deepfake >= 70) verdict = "AI_MANIPULATED";
  else if (ai >= 70) verdict = "AI_GENERATED";
  else if (ai <= 30 && deepfake < 50) verdict = "NO_STRONG_AI_SIGNAL";
  const confidence = verdict === "AI_GENERATED" ? ai
    : verdict === "AI_MANIPULATED" ? deepfake
    : verdict === "NO_STRONG_AI_SIGNAL" ? 100 - ai
    : Math.max(ai, deepfake);
  const explanation = verdict === "AI_GENERATED"
    ? "Sightengine's pixel-based detector returned a strong AI-generation signal. Generator scores are supporting attribution, not proof of a specific tool."
    : verdict === "AI_MANIPULATED"
      ? "Sightengine returned a strong face-manipulation/deepfake signal. This is distinct from fully AI-generated imagery."
      : verdict === "NO_STRONG_AI_SIGNAL"
        ? "Sightengine returned a low AI-generation score and no strong deepfake signal. This is not proof that the media is authentic."
        : "Sightengine's scores fall in an uncertain range. The available evidence is not decisive enough for a responsible classification.";
  return { verdict, confidence: clamp(Math.round(confidence)), explanation };
}
type SightengineRecord = Record<string, unknown>;
type SightengineFrame = { ai: number; deepfake: number; generators: Record<string, number> };

function asRecord(value: unknown): SightengineRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as SightengineRecord : null;
}
function scorePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clamp(value * 100);
}
function parseSightengineFrame(value: unknown): SightengineFrame | null {
  const root = asRecord(value);
  const type = asRecord(root?.type);
  if (!type) return null;
  const ai = scorePercent(type.ai_generated);
  if (ai === null) return null;
  const deepfake = scorePercent(type.deepfake) ?? 0;
  const rawGenerators = asRecord(type.ai_generators);
  const generators: Record<string, number> = {};
  if (rawGenerators) {
    for (const [name, rawScore] of Object.entries(rawGenerators)) {
      const score = scorePercent(rawScore);
      if (score !== null) generators[name] = score;
    }
  }
  return { ai, deepfake, generators };
}
async function runSightengineDetection(apiUser: string, apiSecret: string, mediaType: "image" | "video", bytes: Buffer, mime: string) {
  const form = new FormData();
  form.set("media", new Blob([bytes], { type: mime }), mediaType === "video" ? "digitrust-video" : "digitrust-image");
  form.set("models", "genai,deepfake");
  form.set("api_user", apiUser);
  form.set("api_secret", apiSecret);
  if (mediaType === "video") form.set("interval", "2");
  const endpoint = mediaType === "video" ? SIGHTENGINE_VIDEO_ENDPOINT : SIGHTENGINE_IMAGE_ENDPOINT;
  const upstream = await fetch(endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(55_000) });
  const rawText = await upstream.text();
  let payload: unknown;
  try { payload = JSON.parse(rawText); }
  catch { throw new Error("Sightengine returned a non-JSON response (HTTP " + upstream.status + ")."); }
  const root = asRecord(payload);
  const apiError = asRecord(root?.error);
  if (!upstream.ok || root?.status !== "success") {
    const message = typeof apiError?.message === "string" ? apiError.message
      : typeof root?.message === "string" ? root.message : rawText.slice(0, 400);
    throw new Error("Sightengine API HTTP " + upstream.status + ": " + message);
  }
  let frames: SightengineFrame[];
  if (mediaType === "video") {
    const data = asRecord(root?.data);
    const rawFrames = Array.isArray(data?.frames) ? data.frames : [];
    frames = rawFrames.map(parseSightengineFrame).filter((frame): frame is SightengineFrame => frame !== null);
  } else {
    const frame = parseSightengineFrame(payload);
    frames = frame ? [frame] : [];
  }
  if (!frames.length) throw new Error("Sightengine returned no genai scores. Confirm AI-generated media detection is enabled for this API account.");
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const ai = average(frames.map(frame => frame.ai));
  const deepfake = Math.max(...frames.map(frame => frame.deepfake));
  const generatorTotals = new Map<string, number[]>();
  for (const frame of frames) {
    for (const [name, score] of Object.entries(frame.generators)) {
      const values = generatorTotals.get(name) ?? [];
      values.push(score);
      generatorTotals.set(name, values);
    }
  }
  const generatorScores = [...generatorTotals.entries()]
    .map(([name, values]) => ({ name, confidence: average(values) }))
    .sort((a, b) => b.confidence - a.confidence);
  const bestSource = generatorScores[0] && generatorScores[0].confidence >= 20 ? generatorScores[0] : null;
  const sourceConfidence = bestSource?.confidence ?? 0;
  const notAi = 100 - ai;
  const modelVerdict: MediaVerdict = deepfake >= 70 ? "AI_MANIPULATED"
    : ai >= 70 ? "AI_GENERATED"
    : ai <= 30 && deepfake < 50 ? "NO_STRONG_AI_SIGNAL" : "INCONCLUSIVE";
  const confidence = modelVerdict === "AI_GENERATED" ? ai
    : modelVerdict === "AI_MANIPULATED" ? deepfake
    : modelVerdict === "NO_STRONG_AI_SIGNAL" ? notAi : Math.max(ai, deepfake);
  return { ai, notAi, deepfake, sourceConfidence, nonAiSource: notAi, confidence, bestSource, modelVerdict, frames: frames.length, explanation: "", c2pa: null as SightengineRecord | null };
}
export async function POST(request: Request) {
  const apiUser = process.env.SIGHTENGINE_API_USER?.trim();
  const apiSecret = process.env.SIGHTENGINE_API_SECRET?.trim();
  if (!apiUser || !apiSecret) return response({ error: "Media detector is not configured. Add SIGHTENGINE_API_USER and SIGHTENGINE_API_SECRET to the deployment environment." }, 503);

  try {
    const form = await request.formData();
    const file = form.get("file");
    const mediaUrl = typeof form.get("url") === "string" ? String(form.get("url")).trim() : "";

    let mediaType: "image" | "video";
    let mediaBytes: Buffer;
    let mediaMime: string;
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
      mediaBytes = bytes;
      mediaMime = file.type;
      forensic = await runForensics(bytes, file.type);
    } else if (mediaUrl) {
      let url: URL;
      try { url = new URL(mediaUrl); } catch { return response({ error: "Invalid media URL." }, 400); }
      if (!/^https?:$/.test(url.protocol)) return response({ error: "Only HTTP/HTTPS media URLs are supported." }, 400);
      mediaType = /\.(mp4|webm|m4v|mov|avi|mkv|wmv)(?:\?|$)/i.test(url.pathname) ? "video" : "image";
      const allowedTypes = mediaType === "image" ? IMAGE_TYPES : VIDEO_TYPES;
      const maxBytes = mediaType === "image" ? MAX_REMOTE_BYTES : MAX_REMOTE_VIDEO_BYTES;
      const remote = await fetchRemoteMedia(mediaUrl, allowedTypes, maxBytes);
      mediaBytes = remote.buffer;
      mediaMime = remote.mime;
      if (mediaType === "image") forensic = await runForensics(remote.buffer, remote.mime);
    } else {
      return response({ error: "Upload an image/video or provide a public media URL." }, 400);
    }

    const analysis = await runSightengineDetection(apiUser, apiSecret, mediaType, mediaBytes, mediaMime);
    forensic.face = { available: true, score: analysis.deepfake, source: "Sightengine dedicated deepfake classifier" };

    const fused = fuseVerdict(analysis.ai, analysis.deepfake);
    return response({
      verdict: fused.verdict,
      explanation: fused.explanation + (analysis.explanation ? ` Visual model note: ${analysis.explanation}` : ""),
      confidence: fused.confidence,
      signals: {
        ai_generated: Math.round(analysis.ai * 10) / 10,
        not_ai_generated: Math.round(analysis.notAi * 10) / 10,
        deepfake: Math.round(analysis.deepfake * 10) / 10,
        frames_analyzed: analysis.frames,
        model_verdict: analysis.modelVerdict,
        model_confidence: Math.round(analysis.confidence * 10) / 10,
        source_confidence: Math.round(analysis.sourceConfidence * 10) / 10,
        non_ai_source: Math.round(analysis.nonAiSource * 10) / 10,
      },
      forensic,
      likely_source: analysis.bestSource,
      provenance: {
        detected: Boolean(analysis.c2pa) || forensic.metadata.c2pa,
        generator: typeof analysis.c2pa?.claim_generator === "string" ? analysis.c2pa.claim_generator : null,
        software_agent: typeof analysis.c2pa?.actions_software_agent === "string" ? analysis.c2pa.actions_software_agent : forensic.metadata.software,
        action: typeof analysis.c2pa?.actions_action === "string" ? analysis.c2pa.actions_action : null,
        digital_source_type: typeof analysis.c2pa?.actions_digital_source_type === "string" ? analysis.c2pa.actions_digital_source_type : null,
      },
      detector: "Sightengine genai + deepfake models, with metadata and DCT frequency forensics",
    } satisfies MediaAnalysis);
  } catch (error) {
    console.error("Media analysis route failed.", error);
    return response({ error: "Media analysis failed.", detail: error instanceof Error ? error.message : "Unknown error" }, 502);
  }
}
