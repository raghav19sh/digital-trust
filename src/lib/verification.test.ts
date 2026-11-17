import { describe, expect, it } from "vitest";
import { calculateEvidenceScore, classifyRating, extractClaims, matchFactCheck } from "./verification";

describe("evidence-first claim verification", () => {
  it("extracts dated, named and numeric factual statements", () => {
    const claims = extractClaims("In 1881, Ives patented a new printing process. The sky was beautiful that morning. By 1885, he had developed a simplified process that reduced printing costs by 15x.");
    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(claims.some((x) => /1881/.test(x.text))).toBe(true);
    expect(claims.some((x) => /15x/.test(x.text))).toBe(true);
  });

  it("does not turn unknown fact-check ratings into truth", () => {
    expect(classifyRating("Unproven").score).toBeNull();
    expect(classifyRating("False").status).toBe("refuted");
    expect(classifyRating("Mostly True").status).toBe("partially_supported");
    expect(classifyRating("True").score).toBe(100);
  });

  it("rejects loosely related fact-check search results", () => {
    expect(matchFactCheck("Ives patented a printing process in 1881", "A politician made a false statement in 1881", "False").score).toBeNull();
  });

  it("returns no score when all claims are unverified", () => {
    expect(calculateEvidenceScore([{ importance: 2, score: null }, { importance: 1, score: null }]).score).toBeNull();
  });

  it("weights assessed claims and excludes unverified claims", () => {
    const result = calculateEvidenceScore([{ importance: 2, score: 100 }, { importance: 1, score: 0 }, { importance: 3, score: null }]);
    expect(result.score).toBe(66.7);
    expect(result.assessed).toBe(2);
    expect(result.coverage).toBe(67);
  });
});
