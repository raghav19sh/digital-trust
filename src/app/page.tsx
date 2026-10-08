"use client";

import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, FileText, Info, Link2, Search, ShieldCheck } from "lucide-react";

type Level="good"|"warn"|"bad";
type Flag={category:string;excerpt:string;explanation:string;penalty:number};
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
 async function analyze(){
  setError("");setResult(null);const value=input.trim();
  if(!value)return setError("Enter a URL or paste text first.");
  if(mode==="text"&&value.length<40)return setError("Paste at least 40 characters.");
  setLoading(true);
  try{const r=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(mode==="url"?{url:value}:{text:value})});const d=await r.json();if(!r.ok)throw new Error(d.error||"Analysis failed.");setResult(d as Result)}
  catch(e){setError(e instanceof Error?e.message:"Analysis failed.")}finally{setLoading(false)}
 }
 function key(e:KeyboardEvent<HTMLInputElement>){if(e.key==="Enter")void analyze()}
 return <>
 <main className="container">
  <nav className="nav"><a className="brand" href="/"><span className="mark"><ShieldCheck size={18}/></span>DigiTrust</a><div className="navlinks"><a href="/how-it-works">Methodology</a><a href="/evaluation">Evaluation</a><a href="/security">Security</a><a href="/privacy">Privacy</a></div></nav>
  <section className="hero"><span className="eyebrow"><ShieldCheck size={13}/> Digital Trust Intelligence · Explainable Analysis</span><h1>Before you share it, test the signal.</h1><p>Trace claims, evidence, source signals, independent coverage and linguistic risk into a transparent, auditable trust score.</p></section>
  <section className="analyzer">
   <div className="tabs"><button className={"tab "+(mode==="url"?"active":"")} onClick={()=>setMode("url")}><Link2 size={13}/> Article URL</button><button className={"tab "+(mode==="text"?"active":"")} onClick={()=>setMode("text")}><FileText size={13}/> Paste text</button></div>
   {mode==="url"?<div className="inputrow"><input className="input" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={key} placeholder="https://example.com/news/article"/><button className="btn" onClick={()=>void analyze()} disabled={loading}>{loading?"Analyzing":"Analyze"}</button></div>:<><textarea className="textarea" value={input} onChange={e=>setInput(e.target.value)} placeholder="Paste the article, claim, or post..."/><button className="btn" onClick={()=>void analyze()} disabled={loading}>{loading?"Analyzing":"Analyze text"}</button></>}
   <div className="notice"><Info size={13}/> A trust score is a <strong>signal, not a verdict</strong>. Every available input, deduction and unavailable dependency is exposed below.</div>
   {error&&<div className="error"><AlertTriangle size={14}/>{error}</div>}
  </section>
  {!result&&<div className="grid">{[["01 · Extract","Identify readable content and candidate claims."],["02 · Verify","Search published fact-check evidence."],["03 · Corroborate","Search independent reporting."],["04 · Explain","Expose every weighted contribution."]].map(x=><div className="stat" key={x[0]}><strong>{x[0]}</strong><span>{x[1]}</span></div>)}</div>}
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