"use client";

import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, FileText, Film, Info, Link2, Search, ShieldCheck, UploadCloud } from "lucide-react";

type Level="good"|"warn"|"bad";
type Flag={category:string;excerpt:string;explanation:string;penalty:number};
type MediaVerdict="AI_GENERATED"|"AI_MANIPULATED"|"NO_STRONG_AI_SIGNAL"|"INCONCLUSIVE";
type MediaResult={
 verdict:MediaVerdict; explanation:string; confidence:number;
 signals:{ai_generated:number;not_ai_generated:number;deepfake:number;frames_analyzed:number};
 likely_source:{name:string;confidence:number}|null;
 provenance:{detected:boolean;generator:string|null;software_agent:string|null;action:string|null;digital_source_type:string|null};
 detector:string;
};
type Result={
 domain:string|null; title:string|null; trust_score:number; level:Level; verdict:string; summary:string;
 source_url?:string|null;
 components?:Record<string,{score:number;weight:number;available:boolean;details?:Record<string,unknown>}>;
 claims?:Array<{id:string;text:string;confidence:number}>;
 evidence?:Array<{id:string;claim:string;status:string;source:string;url:string|null;contribution?:number}>;
 red_flags?:Flag[];
 verified_facts?:Array<{claim:string;publisher:string;rating:string;url:string|null}>;
 sources?:Array<{source:string;title:string;url:string}>;
 audit?:Array<{step:number;name:string;status:string;detail:string;value?:string}>;
 score_formula?:{numerator:number;denominator:number;formula:string};
 security?:{checks:Array<{name:string;status:string;detail:string}>};
};

const labels=[["fact_check","Fact-check evidence",35],["domain_reputation","Domain reputation",25],["news_coverage","Independent coverage",20],["language_signals","Language signals",20]] as const;

function Score({score}:{score:number}){return <div className="score" style={{"--pct":score} as CSSProperties}><div className="scoretext"><b>{Math.round(score)}</b><span>TRUST SCORE</span></div></div>}
function Pill({level}:{level:Level}){return <span className={"pill "+level}>{level==="good"?"Strong signal":level==="warn"?"Mixed signals":"Weak signal"}</span>}

export default function Home(){
 const[mode,setMode]=useState<"url"|"text">("url"),[input,setInput]=useState(""),[loading,setLoading]=useState(false),[error,setError]=useState(""),[result,setResult]=useState<Result|null>(null);
 const[mediaFile,setMediaFile]=useState<File|null>(null),[mediaUrl,setMediaUrl]=useState(""),[mediaLoading,setMediaLoading]=useState(false),[mediaError,setMediaError]=useState(""),[mediaResult,setMediaResult]=useState<MediaResult|null>(null);
 async function analyze(){
  setError("");setResult(null);const value=input.trim();
  if(!value)return setError("Enter a URL or paste text first.");
  if(mode==="text"&&value.length<40)return setError("Paste at least 40 characters.");
  setLoading(true);
  try{const r=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(mode==="url"?{url:value}:{text:value})});const d=await r.json();if(!r.ok)throw new Error(d.error||"Analysis failed.");setResult(d as Result)}
  catch(e){setError(e instanceof Error?e.message:"Analysis failed.")}finally{setLoading(false)}
 }
 async function analyzeMedia(){
  if(!mediaFile&&!mediaUrl.trim())return setMediaError("Choose an image/video or enter a public media URL.");
  setMediaError("");setMediaResult(null);setMediaLoading(true);
  try{const form=new FormData();if(mediaFile)form.append("file",mediaFile);else form.append("url",mediaUrl.trim());const r=await fetch("/api/analyze-media",{method:"POST",body:form});const d=await r.json();if(!r.ok)throw new Error(d.error||"Media analysis failed.");setMediaResult(d as MediaResult)}
  catch(e){setMediaError(e instanceof Error?e.message:"Media analysis failed.")}finally{setMediaLoading(false)}
 }
 function key(e:KeyboardEvent<HTMLInputElement>){if(e.key==="Enter")void analyze()}
 const mediaTitle=mediaResult?.verdict==="AI_GENERATED"?"Likely AI-generated":mediaResult?.verdict==="AI_MANIPULATED"?"Likely AI-manipulated":mediaResult?.verdict==="NO_STRONG_AI_SIGNAL"?"No strong AI signal":"Inconclusive";
 return <>
 <main className="container">
  <nav className="nav"><a className="brand" href="/"><span className="mark"><ShieldCheck size={18}/></span>DigiTrust</a><div className="navlinks"><a href="/how-it-works">Methodology</a><a href="/media">Media AI Check</a><a href="/evaluation">Evaluation</a><a href="/security">Security</a><a href="/privacy">Privacy</a></div></nav>
  <section className="hero"><span className="eyebrow"><ShieldCheck size={13}/> Digital Trust Intelligence · Explainable Analysis</span><h1>Before you share it, test the signal.</h1><p>Trace claims, evidence, source signals, independent coverage and linguistic risk into a transparent, auditable trust score.</p></section>
  <section className="analyzer">
   <div className="tabs"><button className={"tab "+(mode==="url"?"active":"")} onClick={()=>setMode("url")}><Link2 size={13}/> Article URL</button><button className={"tab "+(mode==="text"?"active":"")} onClick={()=>setMode("text")}><FileText size={13}/> Paste text</button></div>
   {mode==="url"?<div className="inputrow"><input className="input" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={key} placeholder="https://example.com/news/article"/><button className="btn" onClick={()=>void analyze()} disabled={loading}>{loading?"Analyzing":"Analyze"}</button></div>:<><textarea className="textarea" value={input} onChange={e=>setInput(e.target.value)} placeholder="Paste the article, claim, or post..."/><button className="btn" onClick={()=>void analyze()} disabled={loading}>{loading?"Analyzing":"Analyze text"}</button></>}
   <div className="notice"><Info size={13}/> A trust score is a <strong>signal, not a verdict</strong>. Every available input, deduction and unavailable dependency is exposed below.</div>
   {error&&<div className="error"><AlertTriangle size={14}/>{error}</div>}
  </section>
  <section className="media-home">
   <div className="media-home-head">
    <div><span className="eyebrow"><Film size={13}/> Media Authenticity Intelligence</span><h2>Check photos and videos for AI signals.</h2><p>Upload media or paste a public URL. DigiTrust checks synthetic-generation, manipulation/deepfake signals and available provenance without pretending that detection is absolute.</p></div>
    <a className="text-link" href="/media">Open full media lab <ArrowRight size={14}/></a>
   </div>
   <div className="media-home-grid">
    <label className="media-drop">
     <UploadCloud size={22}/>
     <strong>{mediaFile?mediaFile.name:"Choose image or video"}</strong>
     <span>JPG · PNG · WEBP · GIF · MP4 · WEBM · M4V · MOV · AVI · MKV · WMV</span>
     <small>Direct upload up to 4 MB. Larger videos can be checked by public URL.</small>
     <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,video/x-m4v,video/x-msvideo,video/x-matroska,video/x-ms-wmv" onChange={e=>{setMediaFile(e.target.files?.[0]??null);setMediaResult(null);setMediaError("")}}/>
    </label>
    <div className="media-urlbox">
     <span className="section-kicker">PUBLIC MEDIA URL</span>
     <input className="input" value={mediaUrl} onChange={e=>setMediaUrl(e.target.value)} placeholder="https://example.com/image.jpg"/>
     <button className="btn" onClick={()=>void analyzeMedia()} disabled={mediaLoading}>{mediaLoading?"Checking…":"Check media"}</button>
     <span className="small muted">Your media is analyzed separately from the article trust score.</span>
    </div>
   </div>
   {mediaError&&<div className="error"><AlertTriangle size={14}/>{mediaError}</div>}
   {mediaResult&&<div className={"media-home-result "+(mediaResult.verdict==="AI_GENERATED"?"bad":mediaResult.verdict==="NO_STRONG_AI_SIGNAL"?"good":"warn")}>
    <div><span className="section-kicker">MEDIA RESULT</span><h3>{mediaTitle}</h3><p>{mediaResult.explanation}</p></div>
    <div className="media-home-metrics"><div><span>AI generation</span><b>{mediaResult.signals.ai_generated}%</b></div><div><span>Manipulation</span><b>{mediaResult.signals.deepfake}%</b></div><div><span>Non-AI signal</span><b>{mediaResult.signals.not_ai_generated}%</b></div><div><span>Frames</span><b>{mediaResult.signals.frames_analyzed}</b></div></div>
    <div className="media-home-foot">{mediaResult.provenance.detected?"C2PA provenance detected":"No C2PA provenance signal returned"} · {mediaResult.likely_source?("Likely source: "+mediaResult.likely_source.name):"No specific generator identified"} · {mediaResult.confidence}% signal</div>
   </div>}
  </section>
  {!result&&<div className="grid">{[["01 · Extract","Identify readable content and candidate claims."],["02 · Verify","Search published fact-check evidence."],["03 · Corroborate","Search independent reporting."],["04 · Explain","Expose every weighted contribution."]].map(x=><div className="stat" key={x[0]}><strong>{x[0]}</strong><span>{x[1]}</span></div>)}</div>}
  {!result&&<section className="home-info">
   <div className="home-info-card"><span className="section-kicker">TEXT & CLAIMS</span><h2>What DigiTrust examines</h2><p>Source reputation, published fact-checks, independent coverage and linguistic risk are kept separate so missing evidence is visible instead of being treated as proof.</p><a className="text-link" href="/how-it-works">Read the methodology <ArrowRight size={14}/></a></div>
   <div className="home-info-card"><span className="section-kicker">MEDIA</span><h2>Generation ≠ authenticity</h2><p>Media results distinguish AI generation, AI manipulation, deepfake signals and provenance. A missing credential never becomes a “human-made” claim.</p><a className="text-link" href="/media">Explore media analysis <ArrowRight size={14}/></a></div>
   <div className="home-info-card"><span className="section-kicker">SECURITY</span><h2>Built as a security project</h2><p>Network input validation, redirect revalidation, private-network protection, response limits and an explicit audit trail are part of the analyzer.</p><a className="text-link" href="/security">View threat model <ArrowRight size={14}/></a></div>
  </section>}
  {result&&<section className="result">
   <div className="card scorecard"><Score score={result.trust_score}/><div><div className="muted small">{result.domain||"Text analysis"}{result.title?" · "+result.title:""}</div><div className="verdict">{result.verdict}</div><Pill level={result.level}/><p className="small muted">{result.summary}</p>{result.source_url&&<a href={result.source_url} target="_blank" rel="noreferrer">View analyzed page <ExternalLink size={12}/></a>}</div></div>
   <div className="card"><div className="section-head"><div><span className="section-kicker">CALCULATION</span><h2>Explainable score model</h2></div><code>{result.score_formula?.formula}</code></div><div className="bars">{labels.map(x=>{const c=result.components?.[x[0]];const s=c?.score??50;return <div className="barrow" key={x[0]}><span>{x[1]}<small>{x[2]}%</small></span><div><div className="bar"><i style={{width:s+"%"}}/></div><div className="hint">{c?.available?String(c.details?.method||"Signal available"):"Unavailable — neutral baseline"}</div></div><strong>{c?.available?Math.round(s):"—"}</strong></div>})}</div><div className="calculation">Numerator {result.score_formula?.numerator.toFixed(2)} ÷ denominator {result.score_formula?.denominator.toFixed(2)} = <strong>{result.trust_score}</strong></div></div>
   <div className="card"><div className="section-head"><div><span className="section-kicker">CLAIMS</span><h2>Claim extraction</h2></div><span className="muted small">{result.claims?.length||0} candidates</span></div>{result.claims?.map(c=><div className="claim" key={c.id}><div><span className="claim-id">{c.id}</span><strong>{c.text}</strong></div><span className="confidence">{c.confidence}% confidence</span></div>)}</div>
   <div className="card"><div className="section-head"><div><span className="section-kicker">EVIDENCE GRAPH</span><h2>Claim → evidence trail</h2></div></div>{result.evidence?.length?result.evidence.map(e=><div className="evidence" key={e.id}><span className="node">{e.id}</span><span className="connector"/><div><strong>{e.status}</strong><p>{e.claim}</p><small>{e.source}{e.contribution!==undefined?" · "+e.contribution.toFixed(2)+" pts":""}</small>{e.url&&<a href={e.url} target="_blank" rel="noreferrer">Open evidence ↗</a>}</div></div>):<p className="muted small">No external evidence returned; absence is recorded as unavailable.</p>}</div>
   <div className="two">
    <div className="card"><div className="section-head"><div><span className="section-kicker">LINGUISTICS</span><h2>Risk signals</h2></div></div>{result.red_flags?.length?result.red_flags.map((f,i)=><div className="flag" key={f.category+i}><strong>{f.category}</strong><span className="penalty">−{f.penalty}</span><div className="small muted">“{f.excerpt}”</div><div className="small">{f.explanation}</div></div>):<div className="small muted"><CheckCircle2 size={15}/> No obvious linguistic red flags.</div>}</div>
    <div className="card"><div className="section-head"><div><span className="section-kicker">FACT CHECKS</span><h2>Published evidence</h2></div></div>{result.verified_facts?.length?<ul className="list">{result.verified_facts.map((f,i)=><li key={f.claim+i}><strong>{f.claim}</strong><div className="small muted">{f.publisher} · {f.rating} {f.url&&<a href={f.url} target="_blank" rel="noreferrer"><ExternalLink size={12}/></a>}</div></li>)}</ul>:<div className="small muted">No matching published fact-checks.</div>}</div>
   </div>
   {result.sources?.length?<div className="card"><div className="section-head"><div><span className="section-kicker">CORROBORATION</span><h2>Independent coverage</h2></div></div>{result.sources.map((s,i)=><div className="source" key={s.url+i}><strong>{s.source}</strong><div className="small muted">{s.title}</div><a href={s.url} target="_blank" rel="noreferrer">Open source <ExternalLink size={12}/></a></div>)}</div>:null}
   <div className="card"><div className="section-head"><div><span className="section-kicker">SECURITY</span><h2>Input security audit</h2></div><a href="/security">Threat model ↗</a></div><div className="security-grid">{result.security?.checks.map(c=><div className="security-check" key={c.name}><strong>✓ {c.name}</strong><span>{c.detail}</span></div>)}</div></div>
   <div className="card"><div className="section-head"><div><span className="section-kicker">AUDIT TRAIL</span><h2>Analysis pipeline</h2></div><span className="muted small">Every stage recorded</span></div><div className="audit">{result.audit?.map(a=><div className="audit-row" key={a.step}><b>{String(a.step).padStart(2,"0")}</b><strong>{a.name}</strong><span>{a.detail}</span><em>{a.value||a.status}</em></div>)}</div></div>
  </section>}
 </main><footer className="footer"><div className="container">DigiTrust is a research and media-literacy aid. It does not determine objective truth.</div></footer></>
}