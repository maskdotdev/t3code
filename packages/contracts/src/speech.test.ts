import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  SpeechToTextConfigSnapshot,
  SpeechToTextEvent,
  SpeechToTextSettings,
  SpeechToTextStartInput,
} from "./speech";

const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

it.effect("parses speech-to-text settings", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(SpeechToTextSettings, {
      version: 1,
      defaultProvider: "local-http",
      providers: {
        "local-http": {
          enabled: true,
          baseUrl: "http://127.0.0.1:8177",
          apiKey: "",
          model: "",
        },
        elevenlabs: {
          enabled: false,
          apiKey: "",
          modelId: "scribe_v2_realtime",
          languageCode: "",
        },
        gemini: {
          enabled: false,
          apiKey: "",
          model: "gemini-3-flash-preview",
        },
      },
    });
    assert.strictEqual(parsed.providers["local-http"].enabled, true);
    assert.strictEqual(parsed.providers.elevenlabs.modelId, "scribe_v2_realtime");
    assert.strictEqual(parsed.providers.gemini.model, "gemini-3-flash-preview");
  }),
);

it.effect("parses speech start input", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(SpeechToTextStartInput, {
      provider: "elevenlabs",
      sampleRateHz: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
    });
    assert.strictEqual(parsed.provider, "elevenlabs");
    assert.strictEqual(parsed.encoding, "pcm_s16le");
  }),
);

it.effect("parses finalized speech events", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(SpeechToTextEvent, {
      eventId: "event-1",
      sessionId: "speech-session-1",
      provider: "local-http",
      createdAt: "2026-03-07T12:00:00.000Z",
      type: "transcript.finalized",
      text: "hello world",
      revision: 2,
    });
    assert.strictEqual(parsed.type, "transcript.finalized");
    if (parsed.type === "transcript.finalized") {
      assert.strictEqual(parsed.text, "hello world");
      assert.strictEqual(parsed.revision, 2);
    }
  }),
);

it.effect("parses speech config snapshots", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(SpeechToTextConfigSnapshot, {
      configPath: "/tmp/speech-to-text.json",
      settings: {
        version: 1,
        defaultProvider: "local-http",
        providers: {
          "local-http": {
            enabled: true,
            baseUrl: "http://127.0.0.1:8177",
            apiKey: "",
            model: "",
          },
          elevenlabs: {
            enabled: false,
            apiKey: "",
            modelId: "scribe_v2_realtime",
            languageCode: "",
          },
          gemini: {
            enabled: false,
            apiKey: "",
            model: "gemini-3-flash-preview",
          },
        },
      },
      issues: [],
      providers: [
        {
          provider: "local-http",
          status: "ready",
          available: true,
          configured: true,
          checkedAt: "2026-03-07T12:00:00.000Z",
          message: "Ready.",
        },
      ],
    });
    assert.strictEqual(parsed.configPath, "/tmp/speech-to-text.json");
    assert.lengthOf(parsed.providers, 1);
  }),
);
