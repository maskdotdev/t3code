import type {
  SpeechToTextAppendAudioInput,
  SpeechToTextCancelInput,
  SpeechToTextConfigSnapshot,
  SpeechToTextConfigUpdatedPayload,
  SpeechToTextEvent,
  SpeechToTextStartInput,
  SpeechToTextStartResult,
  SpeechToTextStopInput,
  SpeechToTextStopResult,
  SpeechToTextUpdateConfigInput,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { SpeechToTextConfigError, SpeechToTextRuntimeError } from "../Errors";

export interface SpeechToTextServiceShape {
  readonly getConfig: () => Effect.Effect<SpeechToTextConfigSnapshot, SpeechToTextConfigError>;
  readonly updateConfig: (
    input: SpeechToTextUpdateConfigInput,
  ) => Effect.Effect<SpeechToTextConfigSnapshot, SpeechToTextConfigError>;
  readonly resetConfig: () => Effect.Effect<SpeechToTextConfigSnapshot, SpeechToTextConfigError>;
  readonly streamConfigChanges: Stream.Stream<SpeechToTextConfigUpdatedPayload>;
  readonly streamClientEvents: (clientId: string) => Stream.Stream<SpeechToTextEvent>;
  readonly startTranscription: (
    clientId: string,
    input: SpeechToTextStartInput,
  ) => Effect.Effect<SpeechToTextStartResult, SpeechToTextRuntimeError>;
  readonly appendAudio: (
    clientId: string,
    input: SpeechToTextAppendAudioInput,
  ) => Effect.Effect<void, SpeechToTextRuntimeError>;
  readonly stopTranscription: (
    clientId: string,
    input: SpeechToTextStopInput,
  ) => Effect.Effect<SpeechToTextStopResult, SpeechToTextRuntimeError>;
  readonly cancelTranscription: (
    clientId: string,
    input: SpeechToTextCancelInput,
  ) => Effect.Effect<void, SpeechToTextRuntimeError>;
  readonly disconnectClient: (clientId: string) => Effect.Effect<void>;
}

export class SpeechToTextService extends ServiceMap.Service<
  SpeechToTextService,
  SpeechToTextServiceShape
>()("t3/speech/Services/SpeechToTextService") {}
