import type {
  SpeechToTextConfigSnapshot,
  SpeechToTextConfigUpdatedPayload,
  SpeechToTextSettings,
  SpeechToTextUpdateConfigInput,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { SpeechToTextConfigError } from "../Errors";

export interface SpeechToTextConfigShape {
  readonly loadSnapshot: Effect.Effect<SpeechToTextConfigSnapshot, SpeechToTextConfigError>;
  readonly updateConfig: (
    input: SpeechToTextUpdateConfigInput,
  ) => Effect.Effect<SpeechToTextConfigSnapshot, SpeechToTextConfigError>;
  readonly resetToDefaults: Effect.Effect<SpeechToTextConfigSnapshot, SpeechToTextConfigError>;
  readonly defaultSettings: SpeechToTextSettings;
  readonly changes: Stream.Stream<SpeechToTextConfigUpdatedPayload>;
}

export class SpeechToTextConfig extends ServiceMap.Service<
  SpeechToTextConfig,
  SpeechToTextConfigShape
>()("t3/speech/Services/SpeechToTextConfig") {}
