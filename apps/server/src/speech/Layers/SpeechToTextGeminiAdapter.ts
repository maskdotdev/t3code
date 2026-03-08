import {
  EventId,
  type GeminiSpeechToTextSettings,
  type SpeechToTextAppendAudioInput,
  type SpeechToTextEvent,
  type SpeechToTextProviderStatus,
  type SpeechToTextSessionId,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, ServiceMap, Stream } from "effect";

import { SpeechToTextRuntimeError } from "../Errors";
import type {
  SpeechToTextAdapterSession,
  SpeechToTextAdapterShape,
  SpeechToTextAdapterStartSessionInput,
} from "../Services/SpeechToTextAdapter";

const GEMINI_PROVIDER = "gemini" as const;
const DEFAULT_MODEL = "gemini-3-flash-preview";
const HEALTH_TIMEOUT_MS = 2_500;
type SpeechEventType =
  | "session.started"
  | "transcript.preview.updated"
  | "transcript.finalized"
  | "session.stopped"
  | "session.cancelled"
  | "session.error";

function makeEvent(
  sessionId: SpeechToTextSessionId,
  type: SpeechEventType,
  fields: Record<string, unknown>,
): SpeechToTextEvent {
  return {
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    sessionId,
    provider: GEMINI_PROVIDER,
    createdAt: new Date().toISOString(),
    type,
    ...fields,
  } as SpeechToTextEvent;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = Buffer.from(base64, "base64");
  return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
}

function concatChunks(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function encodeWavBase64(pcm: Uint8Array, sampleRateHz: number): string {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const dataLength = pcm.byteLength;

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);

  const result = new Uint8Array(44 + dataLength);
  result.set(new Uint8Array(header), 0);
  result.set(pcm, 44);
  return Buffer.from(result).toString("base64");
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = HEALTH_TIMEOUT_MS): Promise<unknown> {
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

function resolveModel(settings: GeminiSpeechToTextSettings): string {
  return settings.model.trim().length > 0 ? settings.model.trim() : DEFAULT_MODEL;
}

function extractGeminiText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const content = (candidate as Record<string, unknown>).content;
    if (!content || typeof content !== "object") continue;
    const parts = Array.isArray((content as Record<string, unknown>).parts)
      ? ((content as Record<string, unknown>).parts as ReadonlyArray<unknown>)
      : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim().length > 0) {
        return text.trim();
      }
    }
  }
  return "";
}

const makeGeminiSpeechToTextAdapter = Effect.succeed({
  provider: GEMINI_PROVIDER,
  validateSettings: (settings) => {
    const typedSettings = settings as GeminiSpeechToTextSettings;
    if (!typedSettings.enabled) return [];
    const issues: string[] = [];
    if (typedSettings.apiKey.trim().length === 0) {
      issues.push("API key is required.");
    }
    return issues;
  },
  getStatus: (settings) =>
    Effect.tryPromise(async () => {
      const typedSettings = settings as GeminiSpeechToTextSettings;
      const checkedAt = new Date().toISOString();
      if (!typedSettings.enabled) {
        return {
          provider: GEMINI_PROVIDER,
          status: "warning",
          available: false,
          configured: true,
          checkedAt,
          message: "Disabled.",
        } satisfies SpeechToTextProviderStatus;
      }
      if (typedSettings.apiKey.trim().length === 0) {
        return {
          provider: GEMINI_PROVIDER,
          status: "error",
          available: false,
          configured: false,
          checkedAt,
          message: "API key is required.",
        } satisfies SpeechToTextProviderStatus;
      }

      try {
        await fetchJson(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(resolveModel(typedSettings))}?key=${encodeURIComponent(typedSettings.apiKey)}`,
          { method: "GET" },
        );
        return {
          provider: GEMINI_PROVIDER,
          status: "ready",
          available: true,
          configured: true,
          checkedAt,
          message: "Ready. Final transcript is produced after stop.",
        } satisfies SpeechToTextProviderStatus;
      } catch (error) {
        return {
          provider: GEMINI_PROVIDER,
          status: "error",
          available: false,
          configured: true,
          checkedAt,
          message:
            error instanceof Error ? `Health check failed: ${error.message}` : "Health check failed.",
        } satisfies SpeechToTextProviderStatus;
      }
    }),
  startSession: (input: SpeechToTextAdapterStartSessionInput) =>
    Effect.gen(function* () {
      const settings = input.settings as GeminiSpeechToTextSettings;
      const events = yield* PubSub.unbounded<SpeechToTextEvent>();
      const chunks: Uint8Array[] = [];

      const publish = (event: SpeechToTextEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
      const model = resolveModel(settings);

      yield* publish(
        makeEvent(input.sessionId, "session.started", {
          model,
        }),
      );
      yield* publish(
        makeEvent(input.sessionId, "transcript.preview.updated", {
          text: "Gemini 3.0 Flash will transcribe after you stop recording.",
          revision: 0,
        }),
      );

      const session: SpeechToTextAdapterSession = {
        appendAudio: (frame: SpeechToTextAppendAudioInput) =>
          Effect.sync(() => {
            chunks.push(decodeBase64(frame.audioBase64));
          }),
        stop: () =>
          Effect.gen(function* () {
            const pcm = concatChunks(chunks);
            const audioBase64 = encodeWavBase64(pcm, 16_000);
            const payload = yield* Effect.tryPromise({
              try: () =>
                fetchJson(
                  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
                  {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                    },
                    body: JSON.stringify({
                      contents: [
                        {
                          parts: [
                            {
                              text: "Transcribe this audio. Return only the transcript text with no commentary.",
                            },
                            {
                              inline_data: {
                                mime_type: "audio/wav",
                                data: audioBase64,
                              },
                            },
                          ],
                        },
                      ],
                      generationConfig: {
                        temperature: 0,
                      },
                    }),
                  },
                  20_000,
                ),
              catch: (cause) =>
                new SpeechToTextRuntimeError({
                  message: "Failed to transcribe audio with Gemini 3.0 Flash.",
                  cause,
                }),
            });
            const text = extractGeminiText(payload);
            yield* publish(
              makeEvent(input.sessionId, "transcript.finalized", {
                text,
                revision: 1,
              }),
            );
            yield* publish(makeEvent(input.sessionId, "session.stopped", {}));
            return text;
          }),
        cancel: () =>
          publish(makeEvent(input.sessionId, "session.cancelled", {})).pipe(
            Effect.mapError(
              (cause) =>
                new SpeechToTextRuntimeError({
                  message: "Failed to cancel Gemini speech-to-text session.",
                  cause,
                }),
            ),
          ),
        streamEvents: Stream.fromPubSub(events),
      };

      return session;
    }),
} satisfies SpeechToTextAdapterShape);

export class GeminiSpeechToTextAdapter extends ServiceMap.Service<
  GeminiSpeechToTextAdapter,
  SpeechToTextAdapterShape
>()("t3/speech/Layers/SpeechToTextGeminiAdapter/GeminiSpeechToTextAdapter") {}

export const GeminiSpeechToTextAdapterLive = Layer.effect(
  GeminiSpeechToTextAdapter,
  makeGeminiSpeechToTextAdapter,
);
