import type { ProviderKind, ServerConfig } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
};

export function updateServerConfigProviderRateLimits(
  current: ServerConfig | undefined,
  provider: ProviderKind,
  rateLimits: unknown,
): ServerConfig | undefined {
  if (!current) {
    return current;
  }

  let changed = false;
  const providers = current.providers.map((status) => {
    if (status.provider !== provider) {
      return status;
    }
    if (status.rateLimits === rateLimits) {
      return status;
    }

    changed = true;
    return {
      ...status,
      rateLimits,
    };
  });

  if (!changed) {
    return current;
  }

  return {
    ...current,
    providers,
  };
}

export function serverConfigQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig();
    },
    staleTime: Infinity,
  });
}
