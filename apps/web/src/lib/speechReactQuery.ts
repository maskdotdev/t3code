import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";

export const speechQueryKeys = {
  all: ["speech"] as const,
  config: () => ["speech", "config"] as const,
};

export function speechConfigQueryOptions() {
  return queryOptions({
    queryKey: speechQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.speech.getConfig();
    },
    staleTime: Infinity,
  });
}
