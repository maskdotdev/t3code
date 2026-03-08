import { describe, expect, it } from "vitest";

import { normalizeProviderRateLimits } from "./providerRateLimits";

describe("normalizeProviderRateLimits", () => {
  it("normalizes primary and secondary windows from Codex payloads", () => {
    const summary = normalizeProviderRateLimits("codex", {
      primary: {
        usedPercent: 28.4,
        windowDurationMins: 300,
        resetAt: 1_772_000_000,
      },
      secondary: {
        usedPercent: 61,
        windowDurationMins: 10_080,
        resetAt: 1_772_500_000,
      },
    });

    expect(summary).not.toBeNull();
    expect(summary?.groups).toEqual([
      {
        key: "default",
        label: "Codex",
        windows: [
          {
            key: "primary",
            label: "5h",
            usedPercent: 28,
            remainingPercent: 72,
            resetAtUnixSeconds: 1_772_000_000,
            windowDurationMins: 300,
          },
          {
            key: "secondary",
            label: "7d",
            usedPercent: 61,
            remainingPercent: 39,
            resetAtUnixSeconds: 1_772_500_000,
            windowDurationMins: 10_080,
          },
        ],
      },
    ]);
  });

  it("derives used percentage from remaining percent when needed", () => {
    const summary = normalizeProviderRateLimits("codex", {
      primary: {
        remainingPercent: 84,
        windowDurationMins: 300,
      },
    });

    expect(summary?.groups[0]?.windows[0]).toEqual({
      key: "primary",
      label: "5h",
      usedPercent: 16,
      remainingPercent: 84,
      resetAtUnixSeconds: null,
      windowDurationMins: 300,
    });
  });

  it("keeps all Codex rate-limit buckets under the provider", () => {
    const summary = normalizeProviderRateLimits("codex", {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: 1_772_873_565,
        },
        secondary: {
          usedPercent: 43,
          windowDurationMins: 10_080,
          resetsAt: 1_773_269_415,
        },
      },
      rateLimitsByLimitId: {
        codex_bengalfox: {
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          primary: {
            usedPercent: 0,
            windowDurationMins: 300,
            resetsAt: 1_772_900_000,
          },
          secondary: {
            usedPercent: 12,
            windowDurationMins: 10_080,
            resetsAt: 1_773_300_000,
          },
        },
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 0,
            windowDurationMins: 300,
            resetsAt: 1_772_873_565,
          },
          secondary: {
            usedPercent: 43,
            windowDurationMins: 10_080,
            resetsAt: 1_773_269_415,
          },
        },
      },
    });

    expect(summary?.groups).toEqual([
      {
        key: "codex",
        label: "Codex",
        windows: [
          {
            key: "primary",
            label: "5h",
            usedPercent: 0,
            remainingPercent: 100,
            resetAtUnixSeconds: 1_772_873_565,
            windowDurationMins: 300,
          },
          {
            key: "secondary",
            label: "7d",
            usedPercent: 43,
            remainingPercent: 57,
            resetAtUnixSeconds: 1_773_269_415,
            windowDurationMins: 10_080,
          },
        ],
      },
      {
        key: "codex_bengalfox",
        label: "GPT-5.3-Codex-Spark",
        windows: [
          {
            key: "primary",
            label: "5h",
            usedPercent: 0,
            remainingPercent: 100,
            resetAtUnixSeconds: 1_772_900_000,
            windowDurationMins: 300,
          },
          {
            key: "secondary",
            label: "7d",
            usedPercent: 12,
            remainingPercent: 88,
            resetAtUnixSeconds: 1_773_300_000,
            windowDurationMins: 10_080,
          },
        ],
      },
    ]);
  });

  it("returns null when the payload has no usable windows", () => {
    expect(normalizeProviderRateLimits("codex", { primary: { resetAt: 1_772_000_000 } })).toBeNull();
    expect(normalizeProviderRateLimits("codex", null)).toBeNull();
  });
});
