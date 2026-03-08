import type { SpeechToTextProviderKind } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { SpeechToTextAdapterShape } from "./SpeechToTextAdapter";

export interface SpeechToTextAdapterRegistryShape {
  readonly getByProvider: (
    provider: SpeechToTextProviderKind,
  ) => Effect.Effect<SpeechToTextAdapterShape>;
  readonly listProviders: () => Effect.Effect<ReadonlyArray<SpeechToTextProviderKind>>;
}

export class SpeechToTextAdapterRegistry extends ServiceMap.Service<
  SpeechToTextAdapterRegistry,
  SpeechToTextAdapterRegistryShape
>()("t3/speech/Services/SpeechToTextAdapterRegistry") {}
