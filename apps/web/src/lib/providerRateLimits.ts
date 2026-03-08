import type { ProviderKind } from "@t3tools/contracts";

export interface ProviderRateLimitWindow {
  key: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAtUnixSeconds: number | null;
  windowDurationMins: number | null;
}

export interface ProviderRateLimitGroup {
  key: string;
  label: string;
  windows: ReadonlyArray<ProviderRateLimitWindow>;
}

export interface ProviderRateLimitSummary {
  provider: ProviderKind;
  groups: ReadonlyArray<ProviderRateLimitGroup>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRateLimitGroupLabel(sourceKey: string, rawGroup: Record<string, unknown>): string {
  const limitName = asNonEmptyString(rawGroup.limitName);
  if (limitName) {
    return limitName;
  }

  const limitId = asNonEmptyString(rawGroup.limitId) ?? sourceKey;
  if (limitId === "codex" || limitId === "default") {
    return "Codex";
  }

  return limitId.replace(/[_-]+/g, " ");
}

function extractRateLimitGroups(
  value: unknown,
): ReadonlyArray<readonly [groupKey: string, groupValue: unknown]> {
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const rateLimitsByLimitId = asRecord(record.rateLimitsByLimitId);
  if (rateLimitsByLimitId) {
    const groups = Object.entries(rateLimitsByLimitId).filter(([, entry]) => asRecord(entry) !== null);
    if (groups.length > 0) {
      return groups;
    }
  }

  const nestedRateLimits = asRecord(record.rateLimits);
  if (nestedRateLimits) {
    return extractRateLimitGroups(nestedRateLimits);
  }

  return [[asNonEmptyString(record.limitId) ?? "default", value] as const];
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function labelForRateLimitWindow(sourceKey: string, windowDurationMins: number | null): string {
  if (windowDurationMins !== null && windowDurationMins > 0) {
    if (windowDurationMins % 1_440 === 0) {
      return `${windowDurationMins / 1_440}d`;
    }
    if (windowDurationMins % 60 === 0) {
      return `${windowDurationMins / 60}h`;
    }
    return `${windowDurationMins}m`;
  }

  if (sourceKey === "primary") {
    return "Primary";
  }
  if (sourceKey === "secondary") {
    return "Secondary";
  }
  return sourceKey;
}

function extractRateLimitEntries(
  rawRateLimits: unknown,
): ReadonlyArray<readonly [key: string, value: unknown]> {
  if (Array.isArray(rawRateLimits)) {
    return rawRateLimits.map((value, index) => [`window-${index + 1}`, value] as const);
  }

  const record = asRecord(rawRateLimits);
  if (!record) {
    return [];
  }

  const preferredEntries = ["primary", "secondary"]
    .filter((key) => key in record)
    .map((key) => [key, record[key]] as const);
  if (preferredEntries.length > 0) {
    return preferredEntries;
  }

  return Object.entries(record).filter(([, value]) => asRecord(value) !== null);
}

function normalizeRateLimitWindow(
  sourceKey: string,
  rawWindow: unknown,
): ProviderRateLimitWindow | null {
  const record = asRecord(rawWindow);
  if (!record) {
    return null;
  }

  const usedPercent = readNumber(record, ["usedPercent", "used_percentage", "percentUsed"]);
  const remainingPercent = readNumber(record, [
    "remainingPercent",
    "remaining_percentage",
    "leftPercent",
    "availablePercent",
  ]);
  const normalizedUsedPercent =
    usedPercent !== null
      ? clampPercent(usedPercent)
      : remainingPercent !== null
        ? clampPercent(100 - remainingPercent)
        : null;

  if (normalizedUsedPercent === null) {
    return null;
  }

  const windowDurationMins = readNumber(record, [
    "windowDurationMins",
    "windowDurationMinutes",
    "windowMinutes",
    "durationMinutes",
  ]);
  const resetAtUnixSeconds = readNumber(record, ["resetAt", "resetsAt", "resetAtUnixSeconds"]);

  return {
    key: sourceKey,
    label: labelForRateLimitWindow(sourceKey, windowDurationMins),
    usedPercent: normalizedUsedPercent,
    remainingPercent: clampPercent(100 - normalizedUsedPercent),
    resetAtUnixSeconds:
      resetAtUnixSeconds !== null && resetAtUnixSeconds > 0 ? resetAtUnixSeconds : null,
    windowDurationMins,
  };
}

function normalizeRateLimitGroup(sourceKey: string, rawGroup: unknown): ProviderRateLimitGroup | null {
  const record = asRecord(rawGroup);
  if (!record) {
    return null;
  }

  const windows = extractRateLimitEntries(record)
    .map(([key, value]) => normalizeRateLimitWindow(key, value))
    .filter((value): value is ProviderRateLimitWindow => value !== null)
    .toSorted((left, right) => {
      if (left.windowDurationMins === null && right.windowDurationMins === null) return 0;
      if (left.windowDurationMins === null) return 1;
      if (right.windowDurationMins === null) return -1;
      return left.windowDurationMins - right.windowDurationMins;
    });

  if (windows.length === 0) {
    return null;
  }

  return {
    key: asNonEmptyString(record.limitId) ?? sourceKey,
    label: normalizeRateLimitGroupLabel(sourceKey, record),
    windows,
  };
}

export function normalizeProviderRateLimits(
  provider: ProviderKind,
  rawRateLimits: unknown,
): ProviderRateLimitSummary | null {
  const groups = extractRateLimitGroups(rawRateLimits)
    .map(([key, value]) => normalizeRateLimitGroup(key, value))
    .filter((value): value is ProviderRateLimitGroup => value !== null)
    .toSorted((left, right) => {
      if (left.key === "codex" && right.key !== "codex") return -1;
      if (left.key !== "codex" && right.key === "codex") return 1;
      return left.label.localeCompare(right.label);
    });

  if (groups.length === 0) {
    return null;
  }

  return {
    provider,
    groups,
  };
}
