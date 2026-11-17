export type ClaimStatus = "supported" | "refuted" | "partially_supported" | "unverified";
export type ExtractedClaim = { id: string; text: string; importance: number };
export type ClaimEvidence = {
  claim: string;
  status: ClaimStatus;
  score: number | null;
  rating: string | null;
  publisher: string | null;
  url: string | null;
  relevance: number;
  explanation: string;
};

const STOP = new Set(["about","after","again","also","among","because","been","before","being","between","could","does","during","each","from","have","into","more","most","other","over","said","same","such","than","that","their","there","these","they","this","those","through","under","very","were","what","when","where","which","while","with","would","year","years"]);

function tokens(value: string) {
  return new Set((value.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter((x) => x.length > 2 && !STOP.has(x)));
}

export function lexicalRelevance(a: string, b: string) {
  const aa = tokens(a), bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common++;
  return common / Math.max(aa.size, bb.size);
}

export function extractClaims(input: string, limit = 8): ExtractedClaim[] {
  const sentences = input.replace(/\s+/g, " ").match(/[^.!?]+[.!?]?/g) ?? [];
  const candidates = sentences.map((raw, index) => {
    const text = raw.trim();
    const words = text.split(/\s+/).length;
    const hasEntity = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b/.test(text);
    const hasNumber = /\b\d{3,4}\b|\b\d+(?:\.\d+)?%|\b\d+x\b/i.test(text);
    const hasDate = /\b(18|19|20)\d{2}\b/.test(text);
    const hasAttribution = /\b(according to|researchers|study|report|patent|university|institute|government|officials|records)\b/i.test(text);
    const score = (words >= 9 ? 1 : 0) + (hasEntity ? 2 : 0) + (hasNumber ? 2 : 0) + (hasDate ? 2 : 0) + (hasAttribution ? 1 : 0);
    return { text: text.slice(0, 500), index, score };
  }).filter((x) => x.text.length >= 45 && x.score >= 1);
  const selected = candidates.sort((a,b) => b.score-a.score || a.index-b.index).slice(0, limit).sort((a,b)=>a.index-b.index);
  return selected.map((x,i)=>({id:"claim-"+(i+1),text:x.text,importance:Math.min(3,1+(x.score>=4?1:0)+(x.score>=6?1:0))}));
}

export function classifyRating(rating: string): {status: ClaimStatus; score: number | null} {
  const value = rating.toLowerCase();
  if (/not true|not proven|unproven|no evidence|insufficient|mostly false|mostly true|half true|mixture|mixed|partly false|partially true|partly true|half-true/.test(value)) return {status:"partially_supported",score:50};
  if (/false|incorrect|fake|pants on fire|lie|fabricated|misleading/.test(value)) return {status:"refuted",score:0};
  if (/true|correct|accurate|verified/.test(value)) return {status:"supported",score:100};
  return {status:"unverified",score:null};
}

export function matchFactCheck(claim: string, reviewedClaim: string, rating: string) {
  const relevance = lexicalRelevance(claim, reviewedClaim);
  const classified = classifyRating(rating);
  // Conservative lexical gate: do not score a loosely related search result.
  if (relevance < 0.28 || classified.score === null) {
    return {status:"unverified" as const, score:null, relevance, explanation:"No sufficiently relevant, clearly rated fact-check was found."};
  }
  return {
    ...classified,
    relevance,
    explanation: classified.status === "supported" ? "A relevant published fact-check rates this claim as accurate." :
      classified.status === "refuted" ? "A relevant published fact-check rates this claim as false or misleading." :
      "A relevant published fact-check gives this claim a mixed or partial rating."
  };
}

export function calculateEvidenceScore(claims: Array<{importance:number;score:number|null}>) {
  const assessed = claims.filter((x): x is {importance:number;score:number} => x.score !== null);
  const totalWeight = assessed.reduce((sum,x)=>sum+x.importance,0);
  if (!totalWeight) return {score:null, assessed:0, total:claims.length, coverage:0};
  const score = assessed.reduce((sum,x)=>sum+x.score*x.importance,0)/totalWeight;
  return {score:Math.round(score*10)/10,assessed:assessed.length,total:claims.length,coverage:Math.round(assessed.length/Math.max(1,claims.length)*100)};
}
