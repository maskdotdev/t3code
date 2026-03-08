import {
  ElevenLabsSpeechToTextSettings,
  GeminiSpeechToTextSettings,
  LocalHttpSpeechToTextSettings,
  SpeechToTextConfigSnapshot,
  type SpeechToTextIssue,
  type SpeechToTextProviderKind,
  type SpeechToTextProviderStatus,
  type SpeechToTextSettings,
  SpeechToTextSettings as SpeechToTextSettingsSchema,
  type SpeechToTextUpdateConfigInput,
} from "@t3tools/contracts";
import {
  Cache,
  Cause,
  Effect,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Schema,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config";
import { SpeechToTextConfigError } from "../Errors";
import { SpeechToTextAdapterRegistry } from "../Services/SpeechToTextAdapterRegistry";
import { SpeechToTextConfig, type SpeechToTextConfigShape } from "../Services/SpeechToTextConfig";

const SpeechToTextUnknownJson = Schema.fromJsonString(Schema.Unknown);

const DEFAULT_SPEECH_TO_TEXT_SETTINGS: SpeechToTextSettings = {
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
};

function invalidProviderConfigIssue(
  provider: SpeechToTextProviderKind,
  detail: string,
): SpeechToTextIssue {
  return {
    kind: "speech-to-text.invalid-provider-config",
    provider,
    message: detail.trim() || "Invalid provider configuration.",
  };
}

function malformedConfigIssue(detail: string): SpeechToTextIssue {
  return {
    kind: "speech-to-text.malformed-config",
    message: detail.trim() || "Malformed speech-to-text configuration.",
  };
}

function normalizeSettings(
  raw: unknown,
): {
  readonly settings: SpeechToTextSettings;
  readonly issues: ReadonlyArray<SpeechToTextIssue>;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      settings: DEFAULT_SPEECH_TO_TEXT_SETTINGS,
      issues: [malformedConfigIssue("Expected JSON object.")],
    };
  }

  const record = raw as Record<string, unknown>;
  const issues: SpeechToTextIssue[] = [];

  const localHttpResult = Schema.decodeUnknownExit(LocalHttpSpeechToTextSettings)(
    record.providers && typeof record.providers === "object"
      ? (record.providers as Record<string, unknown>)["local-http"]
      : undefined,
  );
  const elevenLabsResult = Schema.decodeUnknownExit(ElevenLabsSpeechToTextSettings)(
    record.providers && typeof record.providers === "object"
      ? (record.providers as Record<string, unknown>).elevenlabs
      : undefined,
  );
  const geminiResult = Schema.decodeUnknownExit(GeminiSpeechToTextSettings)(
    record.providers && typeof record.providers === "object"
      ? (record.providers as Record<string, unknown>).gemini
      : undefined,
  );
  const defaultProviderResult = Schema.decodeUnknownExit(
    Schema.Literals(["local-http", "elevenlabs", "gemini"] as const),
  )(record.defaultProvider);

  if (localHttpResult._tag === "Failure") {
    issues.push(
      invalidProviderConfigIssue("local-http", Cause.pretty(localHttpResult.cause)),
    );
  }
  if (elevenLabsResult._tag === "Failure") {
    issues.push(
      invalidProviderConfigIssue("elevenlabs", Cause.pretty(elevenLabsResult.cause)),
    );
  }
  if (geminiResult._tag === "Failure") {
    issues.push(
      invalidProviderConfigIssue("gemini", Cause.pretty(geminiResult.cause)),
    );
  }
  if (defaultProviderResult._tag === "Failure") {
    issues.push(
      malformedConfigIssue(`Invalid defaultProvider (${Cause.pretty(defaultProviderResult.cause)})`),
    );
  }

  return {
    settings: {
      version: 1,
      defaultProvider:
        defaultProviderResult._tag === "Success"
          ? defaultProviderResult.value
          : DEFAULT_SPEECH_TO_TEXT_SETTINGS.defaultProvider,
      providers: {
        "local-http":
          localHttpResult._tag === "Success"
            ? localHttpResult.value
            : DEFAULT_SPEECH_TO_TEXT_SETTINGS.providers["local-http"],
        elevenlabs:
          elevenLabsResult._tag === "Success"
            ? elevenLabsResult.value
            : DEFAULT_SPEECH_TO_TEXT_SETTINGS.providers.elevenlabs,
        gemini:
          geminiResult._tag === "Success"
            ? geminiResult.value
            : DEFAULT_SPEECH_TO_TEXT_SETTINGS.providers.gemini,
      },
    },
    issues,
  };
}

const makeSpeechToTextConfig = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registry = yield* SpeechToTextAdapterRegistry;
  const configPath = path.join(stateDir, "speech-to-text.json");
  const changesPubSub = yield* PubSub.unbounded<{
    readonly snapshot: SpeechToTextConfigSnapshot;
  }>();
  const resolvedConfigCacheKey = "speech-config" as const;
  const writeSemaphore = yield* Semaphore.make(1);

  const readConfigExists = fs.exists(configPath).pipe(
    Effect.mapError(
      (cause) =>
        new SpeechToTextConfigError({
          configPath,
          detail: "failed to access speech-to-text config",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(configPath).pipe(
    Effect.mapError(
      (cause) =>
        new SpeechToTextConfigError({
          configPath,
          detail: "failed to read speech-to-text config",
          cause,
        }),
    ),
  );

  const computeStatuses = Effect.fn(function* (
    settings: SpeechToTextSettings,
    currentIssues: ReadonlyArray<SpeechToTextIssue>,
  ): Effect.fn.Return<ReadonlyArray<SpeechToTextProviderStatus>, never> {
    const providers = yield* registry.listProviders();
    return yield* Effect.forEach(providers, (provider) =>
      Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(provider);
        const providerSettings = settings.providers[provider];
        const validationIssues = adapter.validateSettings(providerSettings);
        if (validationIssues.length > 0) {
          return {
            provider,
            status: "error" as const,
            available: false,
            configured: false,
            checkedAt: new Date().toISOString(),
            message: validationIssues[0],
          };
        }
        const invalidProviderIssue = currentIssues.find(
          (issue) =>
            issue.kind === "speech-to-text.invalid-provider-config" && issue.provider === provider,
        );
        if (invalidProviderIssue) {
          return {
            provider,
            status: "error" as const,
            available: false,
            configured: false,
            checkedAt: new Date().toISOString(),
            message: invalidProviderIssue.message,
          };
        }
        return yield* adapter.getStatus(providerSettings);
      }),
    );
  });

  const buildSnapshot = Effect.fn(function* (
    settings: SpeechToTextSettings,
    issues: ReadonlyArray<SpeechToTextIssue>,
  ): Effect.fn.Return<SpeechToTextConfigSnapshot, never> {
    const providers = yield* computeStatuses(settings, issues);
    return {
      configPath,
      settings,
      issues,
      providers,
    };
  });

  const loadSnapshotFromDisk = Effect.gen(function* () {
    if (!(yield* readConfigExists)) {
      return yield* buildSnapshot(DEFAULT_SPEECH_TO_TEXT_SETTINGS, []);
    }
    const rawText = yield* readRawConfig;
    const rawValue = Schema.decodeUnknownExit(SpeechToTextUnknownJson)(rawText);
    if (rawValue._tag === "Failure") {
      return yield* buildSnapshot(DEFAULT_SPEECH_TO_TEXT_SETTINGS, [
        malformedConfigIssue(Cause.pretty(rawValue.cause)),
      ]);
    }
    const normalized = normalizeSettings(rawValue.value);
    return yield* buildSnapshot(normalized.settings, normalized.issues);
  });

  const snapshotCache = yield* Cache.make<
    typeof resolvedConfigCacheKey,
    SpeechToTextConfigSnapshot,
    SpeechToTextConfigError
  >({
    capacity: 1,
    lookup: () => loadSnapshotFromDisk,
  });
  const loadSnapshotFromCache = Cache.get(snapshotCache, resolvedConfigCacheKey);

  const emitSnapshot = (snapshot: SpeechToTextConfigSnapshot) =>
    PubSub.publish(changesPubSub, { snapshot }).pipe(Effect.asVoid);

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(snapshotCache, resolvedConfigCacheKey);
      const snapshot = yield* loadSnapshotFromCache;
      yield* emitSnapshot(snapshot);
    }),
  );

  const writeConfigAtomically = (settings: SpeechToTextUpdateConfigInput) => {
    const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    return Schema.decodeUnknownEffect(SpeechToTextSettingsSchema)(settings).pipe(
      Effect.map((validated) => `${JSON.stringify(validated, null, 2)}\n`),
      Effect.tap(() => fs.makeDirectory(path.dirname(configPath), { recursive: true })),
      Effect.tap((encoded) => fs.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fs.rename(tempPath, configPath)),
      Effect.mapError(
        (cause) =>
          new SpeechToTextConfigError({
            configPath,
            detail: "failed to write speech-to-text config",
            cause,
          }),
      ),
    );
  };

  const configDir = path.dirname(configPath);
  const configFile = path.basename(configPath);
  const configPathResolved = path.resolve(configPath);
  yield* fs.makeDirectory(configDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
  yield* Stream.runForEach(fs.watch(configDir), (event) => {
    const isTargetEvent =
      event.path === configFile ||
      event.path === configPath ||
      path.resolve(configDir, event.path) === configPathResolved;
    if (!isTargetEvent) {
      return Effect.void;
    }
    return revalidateAndEmit.pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to revalidate speech-to-text config after file update", {
          path: configPath,
          detail: error.detail,
          cause: error.cause,
        }),
      ),
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("speech-to-text config watcher stopped unexpectedly", {
        path: configPath,
        cause,
      }),
    ),
    Effect.forkScoped,
  );

  return {
    defaultSettings: DEFAULT_SPEECH_TO_TEXT_SETTINGS,
    loadSnapshot: loadSnapshotFromCache,
    changes: Stream.fromPubSub(changesPubSub).pipe(Stream.map((event) => ({
      issues: event.snapshot.issues,
      providers: event.snapshot.providers,
    }))),
    updateConfig: (input) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* writeConfigAtomically(input);
          yield* Cache.invalidate(snapshotCache, resolvedConfigCacheKey);
          const snapshot = yield* loadSnapshotFromCache;
          yield* emitSnapshot(snapshot);
          return snapshot;
        }),
      ),
    resetToDefaults: writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* writeConfigAtomically(DEFAULT_SPEECH_TO_TEXT_SETTINGS);
        yield* Cache.invalidate(snapshotCache, resolvedConfigCacheKey);
        const snapshot = yield* loadSnapshotFromCache;
        yield* emitSnapshot(snapshot);
        return snapshot;
      }),
    ),
  } satisfies SpeechToTextConfigShape;
});

export const SpeechToTextConfigLive = Layer.effect(
  SpeechToTextConfig,
  makeSpeechToTextConfig,
);
