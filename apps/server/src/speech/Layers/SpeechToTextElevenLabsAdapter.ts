import {
  EventId,
  type ElevenLabsSpeechToTextSettings,
  type SpeechToTextAppendAudioInput,
  type SpeechToTextEvent,
  type SpeechToTextProviderStatus,
  type SpeechToTextSessionId,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Ref, ServiceMap, Stream } from "effect";
import WebSocket from "ws";

import { SpeechToTextRuntimeError } from "../Errors";
import type {
  SpeechToTextAdapterSession,
  SpeechToTextAdapterShape,
  SpeechToTextAdapterStartSessionInput,
} from "../Services/SpeechToTextAdapter";

const ELEVENLABS_PROVIDER = "elevenlabs" as const;
const DEFAULT_MODEL_ID = "scribe_v2_realtime";
const HEALTH_TIMEOUT_MS = 2_500;
const FINALIZE_TIMEOUT_MS = 5_000;
type SpeechEventType =
  | "session.started"
  | "transcript.preview.updated"
  | "transcript.finalized"
  | "session.stopped"
  | "session.cancelled"
  | "session.error";

function buildHeaders(settings: ElevenLabsSpeechToTextSettings): Record<string, string> {
  return {
    "xi-api-key": settings.apiKey,
    "content-type": "application/json",
  };
}

function makeEvent(
  sessionId: SpeechToTextSessionId,
  type: SpeechEventType,
  fields: Record<string, unknown>,
): SpeechToTextEvent {
  return {
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    sessionId,
    provider: ELEVENLABS_PROVIDER,
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

function resolveTextField(record: Record<string, unknown>, keys: ReadonlyArray<string>): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function createRealtimeUrl(settings: ElevenLabsSpeechToTextSettings): string {
  const url = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
  url.searchParams.set("model_id", settings.modelId.trim() || DEFAULT_MODEL_ID);
  url.searchParams.set("sample_rate", "16000");
  url.searchParams.set("enable_logging", "false");
  if (settings.languageCode.trim().length > 0) {
    url.searchParams.set("language_code", settings.languageCode.trim());
  }
  return url.toString();
}

const makeElevenLabsSpeechToTextAdapter = Effect.succeed({
  provider: ELEVENLABS_PROVIDER,
  validateSettings: (settings) => {
    const typedSettings = settings as ElevenLabsSpeechToTextSettings;
    if (!typedSettings.enabled) {
      return [];
    }
    const issues: string[] = [];
    if (typedSettings.apiKey.trim().length === 0) {
      issues.push("API key is required.");
    }
    return issues;
  },
  getStatus: (settings) =>
    Effect.tryPromise(async () => {
      const typedSettings = settings as ElevenLabsSpeechToTextSettings;
      const checkedAt = new Date().toISOString();
      if (!typedSettings.enabled) {
        return {
          provider: ELEVENLABS_PROVIDER,
          status: "warning",
          available: false,
          configured: true,
          checkedAt,
          message: "Disabled.",
        } satisfies SpeechToTextProviderStatus;
      }
      if (typedSettings.apiKey.trim().length === 0) {
        return {
          provider: ELEVENLABS_PROVIDER,
          status: "error",
          available: false,
          configured: false,
          checkedAt,
          message: "API key is required.",
        } satisfies SpeechToTextProviderStatus;
      }

      try {
        const payload = (await fetchJson("https://api.elevenlabs.io/v1/models", {
          method: "GET",
          headers: buildHeaders(typedSettings),
        })) as { models?: Array<{ model_id?: string }> } | Array<{ model_id?: string }>;
        const models = Array.isArray(payload) ? payload : (payload.models ?? []);
        const modelId = typedSettings.modelId.trim() || DEFAULT_MODEL_ID;
        const found = models.some((entry) => entry.model_id === modelId);
        if (!found) {
          return {
            provider: ELEVENLABS_PROVIDER,
            status: "error",
            available: false,
            configured: true,
            checkedAt,
            message: `Model '${modelId}' is not available for this account.`,
          } satisfies SpeechToTextProviderStatus;
        }
        return {
          provider: ELEVENLABS_PROVIDER,
          status: "ready",
          available: true,
          configured: true,
          checkedAt,
          message: "Ready.",
        } satisfies SpeechToTextProviderStatus;
      } catch (error) {
        return {
          provider: ELEVENLABS_PROVIDER,
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
      const settings = input.settings as ElevenLabsSpeechToTextSettings;
      const events = yield* PubSub.unbounded<SpeechToTextEvent>();
      const lastPreviewRef = yield* Ref.make("");
      const finalTextRef = yield* Ref.make("");
      const revisionRef = yield* Ref.make(0);
      const stoppedRef = yield* Ref.make(false);

      const publish = (event: SpeechToTextEvent) =>
        PubSub.publish(events, event).pipe(Effect.asVoid);

      const socket = yield* Effect.tryPromise({
        try: () =>
          new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(createRealtimeUrl(settings), {
              headers: buildHeaders(settings),
            });

            ws.once("open", () => resolve(ws));
            ws.once("error", (error) => reject(error));
          }),
        catch: (cause) =>
          new SpeechToTextRuntimeError({
            message: "Failed to connect to ElevenLabs realtime speech-to-text.",
            cause,
          }),
      });

      const finalizeWaiters = new Set<() => void>();
      const resolveFinalizeWaiters = () => {
        for (const resolve of finalizeWaiters) {
          resolve();
        }
        finalizeWaiters.clear();
      };

      const sendSocketMessage = (payload: Record<string, unknown>) =>
        Effect.tryPromise({
          try: async () => {
            await new Promise<void>((resolve, reject) => {
              socket.send(JSON.stringify(payload), (error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            });
          },
          catch: (cause) =>
            new SpeechToTextRuntimeError({
              message: "Failed to send realtime speech audio to ElevenLabs.",
              cause,
            }),
        });

      socket.on("message", (raw) => {
        const parsed = (() => {
          try {
            return JSON.parse(String(raw)) as Record<string, unknown>;
          } catch {
            return null;
          }
        })();
        if (!parsed) {
          return;
        }

        const rawType = resolveTextField(parsed, ["type", "message_type"]);
        if (rawType.length === 0) {
          return;
        }

        if (
          rawType.includes("error") ||
          typeof parsed.error === "string" ||
          typeof parsed.message === "string"
        ) {
          void Effect.runPromise(
            publish(
              makeEvent(input.sessionId, "session.error", {
                message:
                  resolveTextField(parsed, ["error", "message"]).trim() ||
                  "Speech provider error.",
                recoverable: true,
              }),
            ),
          );
          return;
        }

        const partialText = resolveTextField(parsed, [
          "transcript",
          "text",
          "partial",
          "normalized_text",
        ]);
        const isFinal =
          rawType.includes("final") ||
          rawType.includes("commit") ||
          rawType.includes("transcript") ||
          parsed.is_final === true;
        if (partialText.length === 0) {
          return;
        }

        void Effect.runPromise(
          Effect.gen(function* () {
            const revision = yield* Ref.updateAndGet(revisionRef, (value) => value + 1);
            if (isFinal) {
              yield* Ref.set(finalTextRef, partialText);
              yield* publish(
                makeEvent(input.sessionId, "transcript.finalized", {
                  text: partialText,
                  revision,
                }),
              );
              resolveFinalizeWaiters();
              return;
            }
            yield* Ref.set(lastPreviewRef, partialText);
            yield* publish(
              makeEvent(input.sessionId, "transcript.preview.updated", {
                text: partialText,
                revision,
              }),
            );
          }),
        );
      });

      socket.on("close", () => {
        void Effect.runPromise(
          Effect.gen(function* () {
            const alreadyStopped = yield* Ref.get(stoppedRef);
            if (alreadyStopped) {
              return;
            }
            yield* Ref.set(stoppedRef, true);
            yield* publish(makeEvent(input.sessionId, "session.stopped", {}));
          }),
        );
      });

      yield* publish(
        makeEvent(input.sessionId, "session.started", {
          model: settings.modelId.trim() || DEFAULT_MODEL_ID,
        }),
      );

      const session: SpeechToTextAdapterSession = {
        appendAudio: (frame: SpeechToTextAppendAudioInput) =>
          sendSocketMessage({
            message_type: "input_audio_chunk",
            audio_base_64: frame.audioBase64,
            sample_rate: 16_000,
          }),
        stop: () =>
          Effect.gen(function* () {
            yield* sendSocketMessage({
              message_type: "input_audio_chunk",
              audio_base_64: "",
              sample_rate: 16_000,
              commit: true,
            });
            yield* Effect.tryPromise({
              try: () =>
                new Promise<void>((resolve, reject) => {
                  const timeout = setTimeout(() => {
                    finalizeWaiters.delete(resolve);
                    reject(new Error("finalize-timeout"));
                  }, FINALIZE_TIMEOUT_MS);
                  finalizeWaiters.add(() => {
                    clearTimeout(timeout);
                    resolve();
                  });
                }),
              catch: (cause) =>
                new SpeechToTextRuntimeError({
                  message: "Timed out waiting for ElevenLabs to finalize the transcript.",
                  cause,
                }),
            }).pipe(Effect.catch(() => Effect.void));
            const finalText = yield* Ref.get(finalTextRef);
            yield* Ref.set(stoppedRef, true);
            socket.close();
            yield* publish(makeEvent(input.sessionId, "session.stopped", {}));
            return finalText || (yield* Ref.get(lastPreviewRef));
          }),
        cancel: () =>
          Effect.gen(function* () {
            yield* Ref.set(stoppedRef, true);
            socket.close();
            yield* publish(makeEvent(input.sessionId, "session.cancelled", {}));
          }),
        streamEvents: Stream.fromPubSub(events),
      };

      return session;
    }),
} satisfies SpeechToTextAdapterShape);

export class ElevenLabsSpeechToTextAdapter extends ServiceMap.Service<
  ElevenLabsSpeechToTextAdapter,
  SpeechToTextAdapterShape
>()("t3/speech/Layers/SpeechToTextElevenLabsAdapter/ElevenLabsSpeechToTextAdapter") {}

export const ElevenLabsSpeechToTextAdapterLive = Layer.effect(
  ElevenLabsSpeechToTextAdapter,
  makeElevenLabsSpeechToTextAdapter,
);
