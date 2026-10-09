"use client";

import { useState, type ChangeEvent } from "react";
import { AlertTriangle, CheckCircle2, FileImage, Film, ShieldCheck, UploadCloud } from "lucide-react";

type Verdict = "AI_GENERATED" | "AI_MANIPULATED" | "NO_STRONG_AI_SIGNAL" | "INCONCLUSIVE";
type Result = {
  verdict: Verdict;
  explanation: string;
  confidence: number;
  signals: { ai_generated: number; not_ai_generated: number; deepfake: number; frames_analyzed: number };
  forensic: { metadata: { available: boolean; score: number; anomaly: number; fields: string[]; software: string | null; camera: string | null; c2pa: boolean }; frequency: { available: boolean; score: number; low_energy: number; mid_energy: number; high_energy: number; high_frequency_ratio: number; note: string }; face: { available: boolean; score: number; source: string } };
  likely_source: { name: string; confidence: number } | null;
  provenance: { detected: boolean; generator: string | null; software_agent: string | null; action: string | null; digital_source_type: string | null };
  detector: string;
};

const verdictCopy: Record<Verdict, { title: string; className: string }> = {
  AI_GENERATED: { title: "Likely AI-generated", className: "bad" },
  AI_MANIPULATED: { title: "Likely AI-manipulated", className: "warn" },
  NO_STRONG_AI_SIGNAL: { title: "No strong AI signal", className: "good" },
  INCONCLUSIVE: { title: "Inconclusive", className: "warn" },
};

export default function MediaPage() {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    setResult(null);
    setError("");
  }

  async function analyze() {
    if (!file && !url.trim()) return setError("Choose a media file or provide a public media URL.");
    setLoading(true); setError(""); setResult(null);
    try {
      const form = new FormData();
      if (file) form.append("file", file);
      else form.append("url", url.trim());
      const response = await fetch("/api/analyze-media", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Media analysis failed.");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Media analysis failed.");
    } finally { setLoading(false); }
  }

  const verdict = result ? verdictCopy[result.verdict] : null;

  return <main className="container page">
    <nav className="nav">
      <a className="brand" href="/"><span className="mark"><ShieldCheck size={18}/></span>DigiTrust</a>
      <a className="muted" href="/">← Analyzer</a>
    </nav>

    <section className="hero" style={{paddingTop: 30}}>
      <span className="eyebrow"><ShieldCheck size={13}/> Media Authenticity Intelligence</span>
      <h1>Was this made or changed by AI?</h1>
      <p>Analyze images and videos for synthetic generation, AI manipulation, deepfake signals and available provenance.</p>
    </section>

    <section className="analyzer">
      <label className="uploadbox">
        <UploadCloud size={28}/>
        <strong>{file ? file.name : "Choose an image or video"}</strong>
        <span>JPG · PNG · WEBP · GIF · MP4 · WEBM · M4V · MOV · AVI · MKV · WMV</span>
        <small>Direct upload: 4 MB maximum. Larger videos can be checked by public URL.</small>
        <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/x-m4v,video/quicktime,video/x-msvideo,video/x-matroska,video/x-ms-wmv" onChange={pick}/>
      </label>
      <div className="or">OR</div>
      <div className="inputrow"><input className="input" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://example.com/video.mp4"/><button className="btn" onClick={()=>void analyze()} disabled={loading}>{loading ? "Checking…" : "Check media"}</button></div>
      <div className="notice"><strong>Important:</strong> AI detectors are probabilistic. “No strong AI signal” does not prove that media is human-made, especially after recompression, screenshots, cropping or metadata removal.</div>
      {error && <div className="error"><AlertTriangle size={14}/>{error}</div>}
    </section>

    {result && <section className="result">
      <div className="card media-verdict">
        <div className={"media-verdict-icon " + verdict!.className}>{result.verdict==="AI_GENERATED"?<Film size={30}/>:result.verdict==="NO_STRONG_AI_SIGNAL"?<CheckCircle2 size={30}/>:<AlertTriangle size={30}/>}</div>
        <div><span className="section-kicker">PRIMARY CLASSIFICATION</span><h2>{verdict!.title}</h2><p>{result.explanation}</p><strong>{result.confidence}% confidence signal</strong></div>
      </div>

      <div className="metric-grid">
        <div><span className="muted small">AI generation</span><b>{result.signals.ai_generated}%</b></div>
        <div><span className="muted small">AI manipulation / deepfake</span><b>{result.signals.deepfake}%</b></div>
        <div><span className="muted small">Non-AI signal</span><b>{result.signals.not_ai_generated}%</b></div>
        <div><span className="muted small">Frames analyzed</span><b>{result.signals.frames_analyzed}</b></div>
      </div>

      <div className="card"><div className="section-head"><div><span className="section-kicker">FORENSIC SIGNALS</span><h2>Metadata + frequency evidence</h2></div></div><div className="method-grid"><div><b>Metadata anomaly</b><p>{result.forensic.metadata.anomaly}% · {result.forensic.metadata.fields.length ? result.forensic.metadata.fields.join(", ") : "No readable metadata fields"}</p>{result.forensic.metadata.software&&<p className="muted small">Software: {result.forensic.metadata.software}</p>}</div><div><b>Frequency fingerprint</b><p>{result.forensic.frequency.score}% heuristic anomaly</p><p className="muted small">High-frequency energy: {result.forensic.frequency.high_frequency_ratio}%</p></div><div><b>Face / deepfake</b><p>{result.forensic.face.score}% model signal</p><p className="muted small">{result.forensic.face.source}</p></div><div><b>Interpretation</b><p>{result.forensic.frequency.note}</p></div></div></div>

      <div className="two">
        <div className="card"><div className="section-head"><div><span className="section-kicker">PROVENANCE</span><h2>Content credentials</h2></div></div>
          {result.provenance.detected ? <div className="media-details"><div><strong>Credentials detected</strong><span>A C2PA provenance signal was detected in the supplied media.</span></div>{result.provenance.generator&&<div><strong>Claim generator</strong><span>{result.provenance.generator}</span></div>}{result.provenance.software_agent&&<div><strong>Software / model</strong><span>{result.provenance.software_agent}</span></div>}{result.provenance.action&&<div><strong>Action</strong><span>{result.provenance.action}</span></div>}</div> : <p className="muted small">No C2PA provenance signal was returned. This is not evidence that the file is authentic; provenance can be absent or stripped.</p>}
        </div>
        <div className="card"><div className="section-head"><div><span className="section-kicker">SOURCE ATTRIBUTION</span><h2>Likely generator</h2></div></div>{result.likely_source ? <div className="source"><strong>{result.likely_source.name}</strong><div className="small muted">{result.likely_source.confidence}% source confidence</div></div> : <p className="muted small">No specific generator was identified.</p>}<p className="muted small" style={{marginTop:14}}>Detector: {result.detector}</p></div>
      </div>

      <div className="card"><div className="section-head"><div><span className="section-kicker">INTERPRETATION</span><h2>What DigiTrust can establish</h2></div></div><div className="method-grid"><div><b>AI-generated</b><p>Strong synthetic-generation signal or matching provenance.</p></div><div><b>AI-manipulated</b><p>Strong deepfake/face-synthesis signal or AI-edit/provenance evidence.</p></div><div><b>No strong signal</b><p>The detector found no strong AI signal; it is not a proof of authenticity.</p></div><div><b>Inconclusive</b><p>Evidence is mixed or too weak for a responsible classification.</p></div></div></div>
    </section>}

    <section className="card" style={{marginTop:14}}><span className="section-kicker">RESEARCH BOUNDARY</span><h2>Why this is not a simple “AI or real” button</h2><p className="prose">DigiTrust combines model-based detection with provenance. C2PA can record whether media was generated or modified and can preserve a history of actions, but credentials may disappear when media is edited, converted or re-shared. Model detection is also probabilistic. The result therefore separates generation, manipulation, provenance and uncertainty instead of pretending that one score proves authenticity.</p></section>
  </main>;
}
