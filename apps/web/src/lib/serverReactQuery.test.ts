import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { updateServerConfigProviderRateLimits } from "./serverReactQuery";

function makeConfig(): ServerConfig {
  return {
    cwd: "/tmp/workspace",
    keybindingsConfigPath: "/tmp/workspace/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: "2026-03-08T00:00:00.000Z",
      },
    ],
    availableEditors: [],
  };
}

describe("updateServerConfigProviderRateLimits", () => {
  it("updates the matching provider in the cached server config", () => {
    const current = makeConfig();
    const rateLimits = {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1_772_992_558 },
        },
      },
    };

    const next = updateServerConfigProviderRateLimits(current, "codex", rateLimits);

    expect(next).toEqual({
      ...current,
      providers: [
        {
          ...current.providers[0],
          rateLimits,
        },
      ],
    });
  });

  it("returns the same config when the rate-limit payload is unchanged", () => {
    const current = makeConfig();
    const rateLimits = {
      primary: { usedPercent: 10 },
    };
    const withRateLimits = updateServerConfigProviderRateLimits(current, "codex", rateLimits);

    const next = updateServerConfigProviderRateLimits(withRateLimits, "codex", rateLimits);

    expect(next).toBe(withRateLimits);
  });
});
