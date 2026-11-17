import { NextResponse } from "next/server";
import sharp from "sharp";
import dns from "node:dns/promises";
import net from "node:net";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 4_000_000;
const MAX_REMOTE_BYTES = 4_000_000;
const HIVE_DETECTION_ENDPOINT = "https://api.hivemoderation.com/api/v2/task/sync?legacy=1";

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
  signals: { ai_generated: number; not_ai_generated: number; deepfake: number; frames_analyzed: number; model_verdict: MediaVerdict; model_confidence: number };
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
      source: "Hive V3 deepfake signal; not a separate face model",
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

async function fetchRemoteImage(input: string) {
  let current = input;
  for (let hop = 0; hop <= 3; hop++) {
    const url = new URL(current);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP/HTTPS media URLs are supported.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Media URL resolves to a private or non-public address.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response: Response;
    try { response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'DigiTrust/2.0', accept: 'image/jpeg,image/png,image/webp,image/gif' } }); }
    finally { clearTimeout(timeout); }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Media URL returned an invalid redirect.');
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) throw new Error('Could not retrieve the remote image (HTTP ' + response.status + ').');
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg','image/png','image/webp','image/gif'].includes(mime)) throw new Error('The URL did not return a supported image.');
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_REMOTE_BYTES) { await response.body?.cancel(); throw new Error('Remote image exceeds the 4 MB analysis limit.'); }
    if (!response.body) throw new Error('Remote image response was empty.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_REMOTE_BYTES) { await reader.cancel(); throw new Error('Remote image exceeds the 4 MB analysis limit.'); } chunks.push(part.value); } }
    finally { reader.releaseLock(); }
    return { buffer: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), mime, url: current };
  }
  throw new Error('Too many redirects while retrieving remote media.');
}
function fuseVerdict(ai: number, notAi: number, deepfake: number, forensic: ForensicSignals, modelVerdict: MediaAnalysis["verdict"], modelConfidence: number): Pick<MediaAnalysis, "verdict" | "confidence" | "explanation"> {
  const generatorProvenance = forensic.metadata.anomaly >= 80;
  const margin = ai - notAi;
  let verdict: MediaAnalysis["verdict"] = "INCONCLUSIVE";
  // The dedicated classifier is the primary signal; local forensic heuristics are supporting evidence.
  // Do not require an unrelated frequency anomaly to agree with the classifier.
  if (deepfake >= 90 && modelConfidence >= 90) verdict = "AI_MANIPULATED";
  else if (generatorProvenance && ai >= 45) verdict = "AI_GENERATED";
  else if (ai >= 65 && margin >= 15 && modelConfidence >= 55) verdict = "AI_GENERATED";
  else if (modelVerdict === "AI_GENERATED" && ai >= 55 && modelConfidence >= 70) verdict = "AI_GENERATED";
  else if (notAi >= 65 && ai < 45 && deepfake < 40 && modelConfidence >= 50) verdict = "NO_STRONG_AI_SIGNAL";
  else if (modelVerdict === "NO_STRONG_AI_SIGNAL" && notAi >= 55 && ai < 50 && modelConfidence >= 65) verdict = "NO_STRONG_AI_SIGNAL";
  const confidence = clamp(Math.round(modelConfidence));
  const explanation = verdict === "AI_GENERATED"
    ? "The visual model returned a strong synthetic-generation signal. Metadata and frequency checks are supporting evidence only and are not treated as independent classifiers."
    : verdict === "AI_MANIPULATED"
      ? "The visual model returned a strong face-manipulation/deepfake signal."
      : verdict === "NO_STRONG_AI_SIGNAL"
        ? "The visual model found stronger non-AI than AI signals. This is not proof that the image is authentic."
        : "The model signals are not decisive enough for a responsible classification. More than one independent detector or provenance evidence is needed.";
  return { verdict, confidence, explanation };
}
async function runHiveDetection(key: string, mediaType: "image" | "video", mediaInput: string) {
  const form = new FormData();
  form.set("user_id", "digitrust-public");
  form.set("post_id", crypto.randomUUID());
  form.append("models", "ai_generated_media");
  form.append("models", "deepfake");
  if (mediaInput.startsWith("data:")) {
    const match = mediaInput.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) throw new Error("Invalid media payload.");
    const mime = match[1];
    const bytes = Buffer.from(match[2], "base64");
    form.set("media", new Blob([bytes], { type: mime }), mediaType === "video" ? "upload-video" : "upload-image");
  } else {
    form.set("url", mediaInput);
  }
  const upstream = await fetch(HIVE_DETECTION_ENDPOINT, {
    method: "POST",
    headers: { Authorization: "token " + key.trim(), Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(55_000),
  });
  const rawText = await upstream.text();
  let data: any;
  try { data = JSON.parse(rawText); } catch { throw new Error("Hive detection returned an invalid response."); }
  if (!upstream.ok || data?.error) throw new Error("Hive detection HTTP " + upstream.status + ": " + String(data?.message || data?.error || rawText).slice(0, 400));
  const classGroups: any[][] = [];
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.classes)) classGroups.push(value.classes);
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  visit(data);
  if (!classGroups.length) throw new Error("Hive did not return AI-generation classification scores. Check that the API key has the AI-generated media model enabled.");
  const scoreFor = (classes: any[], name: string) => {
    const found = classes.find((item: any) => String(item.class).toLowerCase() === name);
    return found ? clamp(Number(found.score) * 100) : 0;
  };
  const aiScores = classGroups.map(group => scoreFor(group, "ai_generated"));
  const notAiScores = classGroups.map(group => scoreFor(group, "not_ai_generated"));
  const deepfakeScores = classGroups.map(group => scoreFor(group, "deepfake"));
  const ai = mediaType === "video" ? Math.max(...aiScores) : aiScores.reduce((x,y)=>x+y,0)/aiScores.length;
  const notAi = notAiScores.reduce((x,y)=>x+y,0)/notAiScores.length;
  const deepfake = Math.max(...deepfakeScores);
  const bestSource = classGroups.flatMap(group => group)
    .filter((item: any) => !["ai_generated","not_ai_generated","deepfake","none","inconclusive","inconclusive_video"].includes(String(item.class).toLowerCase()) && Number(item.score) >= 0.1)
    .map((item: any) => ({ name: String(item.class), confidence: clamp(Number(item.score) * 100) }))
    .sort((x: any,y: any)=>y.confidence-x.confidence)[0] || null;
  const tags = data?.status?.flatMap((item: any) => item?.response?.output || [])?.map((item: any) => item?.algorithmic_tags?.c2pa).find(Boolean) || null;
  const modelVerdict = ai >= 90 ? "AI_GENERATED" : deepfake >= 90 ? "AI_MANIPULATED" : notAi >= 90 ? "NO_STRONG_AI_SIGNAL" : "INCONCLUSIVE";
  const confidence = Math.max(ai, notAi, deepfake);
  return { ai, notAi, deepfake, confidence, bestSource, modelVerdict, frames: classGroups.length, explanation: "", c2pa: tags };
}
export async function POST(request: Request) {
  const key = process.env.HIVE_DETECTION_API_KEY?.trim();
  if (!key) return response({ error: "Media detector is not configured. Add HIVE_DETECTION_API_KEY (Hive Moderation API key with the ai_generated_media and deepfake models enabled) to the deployment environment." }, 503);

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
      if (mediaType === "image") {
        const remote = await fetchRemoteImage(mediaUrl);
        forensic = await runForensics(remote.buffer, remote.mime);
        mediaInput = "data:" + remote.mime + ";base64," + remote.buffer.toString("base64");
      } else {
        mediaInput = mediaUrl;
      }
    } else {
      return response({ error: "Upload an image/video or provide a public media URL." }, 400);
    }

    const analysis = await runHiveDetection(key, mediaType, mediaInput);
    forensic.face = { available: true, score: analysis.deepfake, source: "Hive dedicated deepfake classifier" };

    const fused = fuseVerdict(analysis.ai, analysis.notAi, analysis.deepfake, forensic, analysis.modelVerdict, analysis.confidence);
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
      },
      forensic,
      likely_source: analysis.bestSource,
      provenance: {
        detected: Boolean(analysis.c2pa) || forensic.metadata.c2pa,
        generator: analysis.c2pa?.claim_generator || null,
        software_agent: analysis.c2pa?.actions_software_agent || forensic.metadata.software,
        action: analysis.c2pa?.actions_action || null,
        digital_source_type: analysis.c2pa?.actions_digital_source_type || null,
      },
      detector: "Hive AI-generated media classifier + deepfake model + metadata + DCT frequency forensics",
    } satisfies MediaAnalysis);
  } catch (error) {
    console.error("Media analysis route failed.", error);
    return response({ error: "Media analysis failed.", detail: error instanceof Error ? error.message : "Unknown error" }, 502);
  }
}
