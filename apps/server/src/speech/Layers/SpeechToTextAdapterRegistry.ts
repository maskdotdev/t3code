import { Effect, Layer } from "effect";

import type { SpeechToTextAdapterShape } from "../Services/SpeechToTextAdapter";
import {
  SpeechToTextAdapterRegistry,
  type SpeechToTextAdapterRegistryShape,
} from "../Services/SpeechToTextAdapterRegistry";
import { ElevenLabsSpeechToTextAdapter } from "./SpeechToTextElevenLabsAdapter";
import { GeminiSpeechToTextAdapter } from "./SpeechToTextGeminiAdapter";
import { LocalHttpSpeechToTextAdapter } from "./SpeechToTextLocalHttpAdapter";

const makeSpeechToTextAdapterRegistry = Effect.gen(function* () {
  const adapters = [
    yield* LocalHttpSpeechToTextAdapter,
    yield* ElevenLabsSpeechToTextAdapter,
    yield* GeminiSpeechToTextAdapter,
  ] satisfies ReadonlyArray<SpeechToTextAdapterShape>;
  const byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));

  return {
    getByProvider: (provider) =>
      Effect.sync(() => {
        const adapter = byProvider.get(provider);
        if (!adapter) {
          throw new Error(`Unsupported speech provider: ${provider}`);
        }
        return adapter;
      }),
    listProviders: () => Effect.sync(() => Array.from(byProvider.keys())),
  } satisfies SpeechToTextAdapterRegistryShape;
});

export const SpeechToTextAdapterRegistryLive = Layer.effect(
  SpeechToTextAdapterRegistry,
  makeSpeechToTextAdapterRegistry,
);
