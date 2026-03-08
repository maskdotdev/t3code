/**
 * ProviderHealth - Provider readiness snapshot service.
 *
 * Owns startup-time provider health checks (install/auth reachability) and
 * exposes the cached results to transport layers.
 *
 * @module ProviderHealth
 */
import type { ServerProviderStatus } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ProviderKind } from "@t3tools/contracts";

export interface ProviderHealthShape {
  /**
   * Read provider health statuses computed at server startup.
   */
  readonly getStatuses: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Load provider account-level rate limits without requiring an active thread session.
   */
  readonly getRateLimits: (provider: ProviderKind) => Effect.Effect<unknown | null>;
}

export class ProviderHealth extends ServiceMap.Service<ProviderHealth, ProviderHealthShape>()(
  "t3/provider/Services/ProviderHealth",
) {}
