import type {
  ElevenLabsSpeechToTextSettings,
  GeminiSpeechToTextSettings,
  LocalHttpSpeechToTextSettings,
  SpeechToTextAppendAudioInput,
  SpeechToTextEvent,
  SpeechToTextProviderKind,
  SpeechToTextProviderStatus,
  SpeechToTextSessionId,
  SpeechToTextStartInput,
} from "@t3tools/contracts";
import type { Effect, Stream } from "effect";

import type { SpeechToTextRuntimeError } from "../Errors";

export interface SpeechToTextAdapterSession {
  readonly appendAudio: (
    frame: SpeechToTextAppendAudioInput,
  ) => Effect.Effect<void, SpeechToTextRuntimeError>;
  readonly stop: () => Effect.Effect<string, SpeechToTextRuntimeError>;
  readonly cancel: () => Effect.Effect<void, SpeechToTextRuntimeError>;
  readonly streamEvents: Stream.Stream<SpeechToTextEvent>;
}

export interface SpeechToTextAdapterStartSessionInput {
  readonly sessionId: SpeechToTextSessionId;
  readonly input: SpeechToTextStartInput;
  readonly settings:
    | LocalHttpSpeechToTextSettings
    | ElevenLabsSpeechToTextSettings
    | GeminiSpeechToTextSettings;
}

export interface SpeechToTextAdapterShape {
  readonly provider: SpeechToTextProviderKind;
  readonly validateSettings: (
    settings:
      | LocalHttpSpeechToTextSettings
      | ElevenLabsSpeechToTextSettings
      | GeminiSpeechToTextSettings,
  ) => ReadonlyArray<string>;
  readonly getStatus: (
    settings:
      | LocalHttpSpeechToTextSettings
      | ElevenLabsSpeechToTextSettings
      | GeminiSpeechToTextSettings,
  ) => Effect.Effect<SpeechToTextProviderStatus>;
  readonly startSession: (
    input: SpeechToTextAdapterStartSessionInput,
  ) => Effect.Effect<SpeechToTextAdapterSession, SpeechToTextRuntimeError>;
}
