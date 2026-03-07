export interface NormalizedNamePathSearchTarget {
  normalizedName: string;
  normalizedPath: string;
}

export interface RankedSearchMatch<T> {
  item: T;
  score: number;
}

export function normalizeNamePathSearchQuery(input: string): string {
  return input
    .trim()
    .replace(/^[@./]+/, "")
    .toLowerCase();
}

export function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

export function scoreNormalizedNamePathSearchTarget(
  target: NormalizedNamePathSearchTarget,
  normalizedQuery: string,
): number | null {
  if (!normalizedQuery) return 0;

  const { normalizedName, normalizedPath } = target;

  if (normalizedName === normalizedQuery) return 0;
  if (normalizedPath === normalizedQuery) return 1;
  if (normalizedName.startsWith(normalizedQuery)) return 2;
  if (normalizedPath.startsWith(normalizedQuery)) return 3;
  if (normalizedPath.includes(`/${normalizedQuery}`)) return 4;
  if (normalizedName.includes(normalizedQuery)) return 5;
  if (normalizedPath.includes(normalizedQuery)) return 6;

  const nameFuzzyScore = scoreSubsequenceMatch(normalizedName, normalizedQuery);
  if (nameFuzzyScore !== null) {
    return 100 + nameFuzzyScore;
  }

  const pathFuzzyScore = scoreSubsequenceMatch(normalizedPath, normalizedQuery);
  if (pathFuzzyScore !== null) {
    return 200 + pathFuzzyScore;
  }

  return null;
}

export function compareRankedSearchMatches<T>(
  left: RankedSearchMatch<T>,
  right: RankedSearchMatch<T>,
  compareItems: (left: T, right: T) => number,
): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  return compareItems(left.item, right.item);
}

function findInsertionIndex<T>(
  rankedMatches: RankedSearchMatch<T>[],
  candidate: RankedSearchMatch<T>,
  compareItems: (left: T, right: T) => number,
): number {
  let low = 0;
  let high = rankedMatches.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedMatches[middle];
    if (!current) {
      break;
    }

    if (compareRankedSearchMatches(candidate, current, compareItems) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

export function insertRankedSearchMatch<T>(
  rankedMatches: RankedSearchMatch<T>[],
  candidate: RankedSearchMatch<T>,
  limit: number,
  compareItems: (left: T, right: T) => number,
): void {
  if (limit <= 0) {
    return;
  }

  const insertionIndex = findInsertionIndex(rankedMatches, candidate, compareItems);
  if (rankedMatches.length < limit) {
    rankedMatches.splice(insertionIndex, 0, candidate);
    return;
  }

  if (insertionIndex >= limit) {
    return;
  }

  rankedMatches.splice(insertionIndex, 0, candidate);
  rankedMatches.pop();
}
