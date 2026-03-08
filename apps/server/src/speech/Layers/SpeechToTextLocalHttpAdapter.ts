import {
  EventId,
  type LocalHttpSpeechToTextSettings,
  type SpeechToTextAppendAudioInput,
  type SpeechToTextEvent,
  type SpeechToTextProviderStatus,
  type SpeechToTextSessionId,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, ServiceMap, Stream } from "effect";

import { SpeechToTextRuntimeError } from "../Errors";
import {
  type SpeechToTextAdapterSession,
  type SpeechToTextAdapterShape,
  type SpeechToTextAdapterStartSessionInput,
} from "../Services/SpeechToTextAdapter";

const LOCAL_HTTP_PROVIDER = "local-http" as const;
const HEALTH_TIMEOUT_MS = 2_000;
type SpeechEventType =
  | "session.started"
  | "transcript.preview.updated"
  | "transcript.finalized"
  | "session.stopped"
  | "session.cancelled"
  | "session.error";

function buildHeaders(settings: LocalHttpSpeechToTextSettings): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (settings.apiKey.trim().length > 0) {
    headers.authorization = `Bearer ${settings.apiKey}`;
    headers["x-api-key"] = settings.apiKey;
  }
  return headers;
}

function makeEvent(
  sessionId: SpeechToTextSessionId,
  type: SpeechEventType,
  fields: Record<string, unknown>,
): SpeechToTextEvent {
  return {
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    sessionId,
    provider: LOCAL_HTTP_PROVIDER,
    createdAt: new Date().toISOString(),
    type,
    ...fields,
  } as SpeechToTextEvent;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
}

function resolvePreviewText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["previewText", "preview", "text"] as const) {
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  return "";
}

function resolveFinalText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["text", "transcript", "finalText"] as const) {
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  return "";
}

function resolveRemoteSessionId(payload: unknown, fallback: SpeechToTextSessionId): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  for (const key of ["sessionId", "id"] as const) {
    if (typeof record[key] === "string" && record[key].trim().length > 0) {
      return record[key].trim();
    }
  }
  return fallback;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

const makeLocalHttpSpeechToTextAdapter = Effect.succeed({
  provider: LOCAL_HTTP_PROVIDER,
  validateSettings: (settings) => {
    const typedSettings = settings as LocalHttpSpeechToTextSettings;
    const issues: string[] = [];
    if (!typedSettings.enabled) {
      return issues;
    }
    try {
      const _validatedUrl = new URL(typedSettings.baseUrl);
      void _validatedUrl;
    } catch {
      issues.push("Base URL must be a valid URL.");
    }
    if (typedSettings.baseUrl.trim().length === 0) {
      issues.push("Base URL is required.");
    }
    return issues;
  },
  getStatus: (settings) =>
    Effect.tryPromise(async () => {
      const typedSettings = settings as LocalHttpSpeechToTextSettings;
      const checkedAt = new Date().toISOString();
      if (!typedSettings.enabled) {
        return {
          provider: LOCAL_HTTP_PROVIDER,
          status: "warning",
          available: false,
          configured: true,
          checkedAt,
          message: "Disabled.",
        } satisfies SpeechToTextProviderStatus;
      }

      try {
        await fetchJson(`${normalizeBaseUrl(typedSettings.baseUrl)}/v1/stt/health`, {
          method: "GET",
          headers: buildHeaders(typedSettings),
        });
        return {
          provider: LOCAL_HTTP_PROVIDER,
          status: "ready",
          available: true,
          configured: true,
          checkedAt,
          message: "Ready.",
        } satisfies SpeechToTextProviderStatus;
      } catch (error) {
        return {
          provider: LOCAL_HTTP_PROVIDER,
          status: "error",
          available: false,
          configured: true,
          checkedAt,
          message:
            error instanceof Error
              ? `Health check failed: ${error.message}`
              : "Health check failed.",
        } satisfies SpeechToTextProviderStatus;
      }
    }),
  startSession: (input: SpeechToTextAdapterStartSessionInput) =>
    Effect.gen(function* () {
      const settings = input.settings as LocalHttpSpeechToTextSettings;
      const events = yield* PubSub.unbounded<SpeechToTextEvent>();
      const baseUrl = normalizeBaseUrl(settings.baseUrl);
      const startPayload = yield* Effect.tryPromise(() =>
        fetchJson(`${baseUrl}/v1/stt/sessions`, {
          method: "POST",
          headers: buildHeaders(settings),
          body: JSON.stringify({
            encoding: input.input.encoding,
            sampleRateHz: input.input.sampleRateHz,
            channels: input.input.channels,
            ...(settings.model.trim().length > 0 ? { model: settings.model.trim() } : {}),
          }),
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SpeechToTextRuntimeError({
              message: "Failed to start local speech-to-text session.",
              cause,
            }),
        ),
      );

      const remoteSessionId = resolveRemoteSessionId(startPayload, input.sessionId);
      let revision = 0;

      const publish = (event: SpeechToTextEvent) =>
        PubSub.publish(events, event).pipe(Effect.asVoid);

      yield* publish(
        makeEvent(input.sessionId, "session.started", {
          model: settings.model.trim().length > 0 ? settings.model.trim() : undefined,
        }),
      );

      const session: SpeechToTextAdapterSession = {
        appendAudio: (frame: SpeechToTextAppendAudioInput) =>
          Effect.gen(function* () {
            const payload = yield* Effect.tryPromise(() =>
              fetchJson(`${baseUrl}/v1/stt/sessions/${encodeURIComponent(remoteSessionId)}/audio`, {
                method: "POST",
                headers: buildHeaders(settings),
                body: JSON.stringify({
                  encoding: "pcm_s16le",
                  sampleRateHz: 16_000,
                  channels: 1,
                  sequenceNumber: frame.sequenceNumber,
                  audioBase64: frame.audioBase64,
                }),
              }),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new SpeechToTextRuntimeError({
                    message: "Failed to append audio to local speech-to-text session.",
                    cause,
                  }),
              ),
            );
            revision += 1;
            yield* publish(
              makeEvent(input.sessionId, "transcript.preview.updated", {
                text: resolvePreviewText(payload),
                revision,
              }),
            );
          }),
        stop: () =>
          Effect.gen(function* () {
            const payload = yield* Effect.tryPromise(() =>
              fetchJson(`${baseUrl}/v1/stt/sessions/${encodeURIComponent(remoteSessionId)}/stop`, {
                method: "POST",
                headers: buildHeaders(settings),
              }),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new SpeechToTextRuntimeError({
                    message: "Failed to stop local speech-to-text session.",
                    cause,
                  }),
              ),
            );
            revision += 1;
            const text = resolveFinalText(payload);
            yield* publish(
              makeEvent(input.sessionId, "transcript.finalized", {
                text,
                revision,
              }),
            );
            yield* publish(makeEvent(input.sessionId, "session.stopped", {}));
            return text;
          }),
        cancel: () =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() =>
              fetchJson(`${baseUrl}/v1/stt/sessions/${encodeURIComponent(remoteSessionId)}/cancel`, {
                method: "POST",
                headers: buildHeaders(settings),
              }),
            ).pipe(Effect.ignore);
            yield* publish(makeEvent(input.sessionId, "session.cancelled", {}));
          }),
        streamEvents: Stream.fromPubSub(events),
      };

      return session;
    }),
} satisfies SpeechToTextAdapterShape);

export class LocalHttpSpeechToTextAdapter extends ServiceMap.Service<
  LocalHttpSpeechToTextAdapter,
  SpeechToTextAdapterShape
>()("t3/speech/Layers/SpeechToTextLocalHttpAdapter/LocalHttpSpeechToTextAdapter") {}

export const LocalHttpSpeechToTextAdapterLive = Layer.effect(
  LocalHttpSpeechToTextAdapter,
  makeLocalHttpSpeechToTextAdapter,
);
