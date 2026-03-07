import { describe, expect, it } from "vitest";
import {
  compareRankedSearchMatches,
  insertRankedSearchMatch,
  normalizeNamePathSearchQuery,
  scoreNormalizedNamePathSearchTarget,
  scoreSubsequenceMatch,
} from "./search";

const compareStrings = (left: string, right: string) => left.localeCompare(right);

describe("normalizeNamePathSearchQuery", () => {
  it("trims and strips mention/path prefixes", () => {
    expect(normalizeNamePathSearchQuery("  @./Composer  ")).toBe("composer");
  });
});

describe("scoreSubsequenceMatch", () => {
  it("returns a lower score for tighter matches", () => {
    expect(scoreSubsequenceMatch("composer", "cmp")).toBeLessThan(
      scoreSubsequenceMatch("components", "cmp") ?? Number.POSITIVE_INFINITY,
    );
  });

  it("returns null when the query is not a subsequence", () => {
    expect(scoreSubsequenceMatch("composer", "xyz")).toBeNull();
  });
});

describe("scoreNormalizedNamePathSearchTarget", () => {
  const target = {
    normalizedName: "composer.tsx",
    normalizedPath: "src/components/composer.tsx",
  } as const;

  it("prioritizes exact and prefix name matches before fuzzy matches", () => {
    expect(scoreNormalizedNamePathSearchTarget(target, "composer.tsx")).toBe(0);
    expect(scoreNormalizedNamePathSearchTarget(target, "composer")).toBe(2);
    expect(scoreNormalizedNamePathSearchTarget(target, "cmp")).toBeGreaterThanOrEqual(100);
  });

  it("returns null when there is no match", () => {
    expect(scoreNormalizedNamePathSearchTarget(target, "zzz")).toBeNull();
  });
});

describe("insertRankedSearchMatch", () => {
  it("keeps the best matches sorted up to the provided limit", () => {
    const ranked: Array<{ item: string; score: number }> = [];

    insertRankedSearchMatch(ranked, { item: "gamma", score: 5 }, 2, compareStrings);
    insertRankedSearchMatch(ranked, { item: "alpha", score: 1 }, 2, compareStrings);
    insertRankedSearchMatch(ranked, { item: "beta", score: 3 }, 2, compareStrings);

    expect(ranked).toEqual([
      { item: "alpha", score: 1 },
      { item: "beta", score: 3 },
    ]);
  });

  it("uses the provided item comparator to break score ties", () => {
    expect(
      compareRankedSearchMatches(
        { item: "alpha", score: 2 },
        { item: "beta", score: 2 },
        compareStrings,
      ),
    ).toBeLessThan(0);
  });
});
