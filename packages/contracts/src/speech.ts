import { Schema } from "effect";
import { EventId, IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const SpeechToTextProviderKind = Schema.Literals(["local-http", "elevenlabs", "gemini"]);
export type SpeechToTextProviderKind = typeof SpeechToTextProviderKind.Type;

export const SpeechToTextEncoding = Schema.Literal("pcm_s16le");
export type SpeechToTextEncoding = typeof SpeechToTextEncoding.Type;

export const SpeechToTextProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type SpeechToTextProviderStatusState = typeof SpeechToTextProviderStatusState.Type;

export const SpeechToTextSessionId = TrimmedNonEmptyString;
export type SpeechToTextSessionId = typeof SpeechToTextSessionId.Type;

const SpeechToTextSecret = Schema.String.check(Schema.isMaxLength(4096));
const SpeechToTextModel = Schema.String.check(Schema.isMaxLength(256));
const SpeechToTextLanguageCode = Schema.String.check(Schema.isMaxLength(64));
const SpeechToTextUrl = Schema.String.check(Schema.isMaxLength(4096));

export const LocalHttpSpeechToTextSettings = Schema.Struct({
  enabled: Schema.Boolean,
  baseUrl: SpeechToTextUrl,
  apiKey: SpeechToTextSecret,
  model: SpeechToTextModel,
});
export type LocalHttpSpeechToTextSettings = typeof LocalHttpSpeechToTextSettings.Type;

export const ElevenLabsSpeechToTextSettings = Schema.Struct({
  enabled: Schema.Boolean,
  apiKey: SpeechToTextSecret,
  modelId: SpeechToTextModel,
  languageCode: SpeechToTextLanguageCode,
});
export type ElevenLabsSpeechToTextSettings = typeof ElevenLabsSpeechToTextSettings.Type;

export const GeminiSpeechToTextSettings = Schema.Struct({
  enabled: Schema.Boolean,
  apiKey: SpeechToTextSecret,
  model: SpeechToTextModel,
});
export type GeminiSpeechToTextSettings = typeof GeminiSpeechToTextSettings.Type;

export const SpeechToTextSettings = Schema.Struct({
  version: Schema.Literal(1),
  defaultProvider: SpeechToTextProviderKind,
  providers: Schema.Struct({
    "local-http": LocalHttpSpeechToTextSettings,
    elevenlabs: ElevenLabsSpeechToTextSettings,
    gemini: GeminiSpeechToTextSettings,
  }),
});
export type SpeechToTextSettings = typeof SpeechToTextSettings.Type;

const SpeechToTextMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("speech-to-text.malformed-config"),
  message: TrimmedNonEmptyString,
});

const SpeechToTextInvalidProviderConfigIssue = Schema.Struct({
  kind: Schema.Literal("speech-to-text.invalid-provider-config"),
  provider: SpeechToTextProviderKind,
  message: TrimmedNonEmptyString,
});

export const SpeechToTextIssue = Schema.Union([
  SpeechToTextMalformedConfigIssue,
  SpeechToTextInvalidProviderConfigIssue,
]);
export type SpeechToTextIssue = typeof SpeechToTextIssue.Type;

export const SpeechToTextProviderStatus = Schema.Struct({
  provider: SpeechToTextProviderKind,
  status: SpeechToTextProviderStatusState,
  available: Schema.Boolean,
  configured: Schema.Boolean,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type SpeechToTextProviderStatus = typeof SpeechToTextProviderStatus.Type;

export const SpeechToTextConfigSnapshot = Schema.Struct({
  configPath: TrimmedNonEmptyString,
  settings: SpeechToTextSettings,
  issues: Schema.Array(SpeechToTextIssue),
  providers: Schema.Array(SpeechToTextProviderStatus),
});
export type SpeechToTextConfigSnapshot = typeof SpeechToTextConfigSnapshot.Type;

export const SpeechToTextConfigUpdatedPayload = Schema.Struct({
  issues: Schema.Array(SpeechToTextIssue),
  providers: Schema.Array(SpeechToTextProviderStatus),
});
export type SpeechToTextConfigUpdatedPayload = typeof SpeechToTextConfigUpdatedPayload.Type;

export const SpeechToTextUpdateConfigInput = SpeechToTextSettings;
export type SpeechToTextUpdateConfigInput = typeof SpeechToTextUpdateConfigInput.Type;

export const SpeechToTextStartInput = Schema.Struct({
  provider: SpeechToTextProviderKind,
  sampleRateHz: NonNegativeInt,
  channels: Schema.Literal(1),
  encoding: SpeechToTextEncoding,
});
export type SpeechToTextStartInput = typeof SpeechToTextStartInput.Type;

export const SpeechToTextStartResult = Schema.Struct({
  sessionId: SpeechToTextSessionId,
  provider: SpeechToTextProviderKind,
  model: Schema.optional(TrimmedNonEmptyString),
});
export type SpeechToTextStartResult = typeof SpeechToTextStartResult.Type;

export const SpeechToTextAppendAudioInput = Schema.Struct({
  sessionId: SpeechToTextSessionId,
  sequenceNumber: NonNegativeInt,
  sampleRateHz: NonNegativeInt,
  channels: Schema.Literal(1),
  encoding: SpeechToTextEncoding,
  audioBase64: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400_000)),
});
export type SpeechToTextAppendAudioInput = typeof SpeechToTextAppendAudioInput.Type;

export const SpeechToTextStopInput = Schema.Struct({
  sessionId: SpeechToTextSessionId,
});
export type SpeechToTextStopInput = typeof SpeechToTextStopInput.Type;

export const SpeechToTextStopResult = Schema.Struct({
  sessionId: SpeechToTextSessionId,
  text: Schema.String,
});
export type SpeechToTextStopResult = typeof SpeechToTextStopResult.Type;

export const SpeechToTextCancelInput = Schema.Struct({
  sessionId: SpeechToTextSessionId,
});
export type SpeechToTextCancelInput = typeof SpeechToTextCancelInput.Type;

const SpeechToTextEventBase = Schema.Struct({
  eventId: EventId,
  sessionId: SpeechToTextSessionId,
  provider: SpeechToTextProviderKind,
  createdAt: IsoDateTime,
});

const SpeechToTextSessionStartedEvent = Schema.Struct({
  ...SpeechToTextEventBase.fields,
  type: Schema.Literal("session.started"),
  model: Schema.optional(TrimmedNonEmptyString),
});

const SpeechToTextTranscriptPreviewUpdatedEvent = Schema.Struct({
  ...SpeechToTextEventBase.fields,
  type: Schema.Literal("transcript.preview.updated"),
  text: Schema.String,
  revision: NonNegativeInt,
});

const SpeechToTextTranscriptFinalizedEvent = Schema.Struct({
  ...SpeechToTextEventBase.fields,
  type: Schema.Literal("transcript.finalized"),
  text: Schema.String,
  revision: NonNegativeInt,
});

const SpeechToTextSessionStoppedEvent = Schema.Struct({
  ...SpeechToTextEventBase.fields,
  type: Schema.Literal("session.stopped"),
});

const SpeechToTextSessionCancelledEvent = Schema.Struct({
  ...SpeechToTextEventBase.fields,
  type: Schema.Literal("session.cancelled"),
});

const SpeechToTextSessionErrorEvent = Schema.Struct({
  ...SpeechToTextEventBase.fields,
  type: Schema.Literal("session.error"),
  message: TrimmedNonEmptyString,
  recoverable: Schema.Boolean,
});

export const SpeechToTextEvent = Schema.Union([
  SpeechToTextSessionStartedEvent,
  SpeechToTextTranscriptPreviewUpdatedEvent,
  SpeechToTextTranscriptFinalizedEvent,
  SpeechToTextSessionStoppedEvent,
  SpeechToTextSessionCancelledEvent,
  SpeechToTextSessionErrorEvent,
]);
export type SpeechToTextEvent = typeof SpeechToTextEvent.Type;
