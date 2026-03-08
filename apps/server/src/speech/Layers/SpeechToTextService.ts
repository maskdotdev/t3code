import type {
  ElevenLabsSpeechToTextSettings,
  GeminiSpeechToTextSettings,
  LocalHttpSpeechToTextSettings,
  SpeechToTextEvent,
  SpeechToTextProviderKind,
  SpeechToTextProviderStatus,
} from "@t3tools/contracts";
import {
  EventId,
  type SpeechToTextAppendAudioInput,
  type SpeechToTextCancelInput,
  SpeechToTextSessionId as SpeechToTextSessionIdSchema,
  type SpeechToTextStartInput,
  type SpeechToTextStartResult,
  type SpeechToTextStopInput,
  type SpeechToTextStopResult,
  type SpeechToTextUpdateConfigInput,
} from "@t3tools/contracts";
import { Effect, Fiber, Layer, PubSub, Ref, Stream } from "effect";

import { SpeechToTextRuntimeError } from "../Errors";
import { SpeechToTextAdapterRegistry } from "../Services/SpeechToTextAdapterRegistry";
import {
  type SpeechToTextAdapterSession,
  type SpeechToTextAdapterShape,
} from "../Services/SpeechToTextAdapter";
import { SpeechToTextConfig } from "../Services/SpeechToTextConfig";
import { SpeechToTextService, type SpeechToTextServiceShape } from "../Services/SpeechToTextService";

interface ClientSpeechEventEnvelope {
  readonly clientId: string;
  readonly event: SpeechToTextEvent;
}

interface ActiveSpeechSession {
  readonly clientId: string;
  readonly sessionId: typeof SpeechToTextSessionIdSchema.Type;
  readonly provider: SpeechToTextProviderKind;
  readonly handle: SpeechToTextAdapterSession;
  readonly eventFiber: unknown;
  readonly stopped: boolean;
}
type SpeechEventType =
  | "session.started"
  | "transcript.preview.updated"
  | "transcript.finalized"
  | "session.stopped"
  | "session.cancelled"
  | "session.error";

function makeInternalError(message: string, cause?: unknown): SpeechToTextRuntimeError {
  return new SpeechToTextRuntimeError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function makeServiceEvent(
  sessionId: typeof SpeechToTextSessionIdSchema.Type,
  provider: SpeechToTextProviderKind,
  type: SpeechEventType,
  fields: Record<string, unknown>,
): SpeechToTextEvent {
  return {
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    sessionId,
    provider,
    createdAt: new Date().toISOString(),
    type,
    ...fields,
  } as SpeechToTextEvent;
}

const makeSpeechToTextService = Effect.gen(function* () {
  const config = yield* SpeechToTextConfig;
  const registry = yield* SpeechToTextAdapterRegistry;
  const eventsPubSub = yield* PubSub.unbounded<ClientSpeechEventEnvelope>();
  const activeSessionsRef = yield* Ref.make(new Map<string, ActiveSpeechSession>());

  const publishEvent = (clientId: string, event: SpeechToTextEvent) =>
    PubSub.publish(eventsPubSub, { clientId, event }).pipe(Effect.asVoid);

  const updateSession = (
    clientId: string,
    updater: (current: ActiveSpeechSession | undefined) => ActiveSpeechSession | undefined,
  ) =>
    Ref.update(activeSessionsRef, (current) => {
      const next = new Map(current);
      const updated = updater(next.get(clientId));
      if (updated) {
        next.set(clientId, updated);
      } else {
        next.delete(clientId);
      }
      return next;
    });

  const getActiveSession = (clientId: string) =>
    Ref.get(activeSessionsRef).pipe(
      Effect.map((sessions) => sessions.get(clientId)),
      Effect.flatMap((session) =>
        session
          ? Effect.succeed(session)
          : Effect.fail(
              makeInternalError("No active speech-to-text session is associated with this connection."),
            ),
      ),
    );

  const resolveEligibleProvider = Effect.fn(function* (
    provider: SpeechToTextProviderKind,
  ): Effect.fn.Return<
    {
      readonly adapter: SpeechToTextAdapterShape;
      readonly providerStatus: SpeechToTextProviderStatus;
      readonly settings:
        | LocalHttpSpeechToTextSettings
        | ElevenLabsSpeechToTextSettings
        | GeminiSpeechToTextSettings;
    },
    SpeechToTextRuntimeError
  > {
    const snapshot = yield* config.loadSnapshot.pipe(
      Effect.mapError((error) => makeInternalError(error.message, error.cause)),
    );
    const providerStatus = snapshot.providers.find((entry) => entry.provider === provider);
    if (!providerStatus) {
      return yield* makeInternalError(`Unknown speech provider: ${provider}`);
    }
    if (!snapshot.settings.providers[provider].enabled) {
      return yield* makeInternalError(`${provider} speech provider is disabled.`);
    }
    if (providerStatus.status === "error" || !providerStatus.available) {
      return yield* makeInternalError(
        providerStatus.message ?? `${provider} speech provider is unavailable.`,
      );
    }
    const adapter = yield* registry.getByProvider(provider).pipe(
      Effect.mapError((cause) => makeInternalError(`Unknown speech provider: ${provider}`, cause)),
    );
    return {
      adapter,
      providerStatus,
      settings: snapshot.settings.providers[provider],
    };
  });

  const attachSessionEvents = (
    clientId: string,
    sessionId: typeof SpeechToTextSessionIdSchema.Type,
    handle: SpeechToTextAdapterSession,
  ) =>
    Effect.sync(() =>
      Effect.runFork(
        Stream.runForEach(handle.streamEvents, (event) =>
          Ref.get(activeSessionsRef).pipe(
            Effect.flatMap((activeSessions) => {
              const current = activeSessions.get(clientId);
              if (!current || current.sessionId !== sessionId) {
                return Effect.void;
              }
              return publishEvent(clientId, event).pipe(
                Effect.tap(() => {
                  if (
                    event.type === "session.cancelled" ||
                    event.type === "session.stopped" ||
                    event.type === "session.error"
                  ) {
                    return updateSession(clientId, () => undefined);
                  }
                  return Effect.void;
                }),
              );
            }),
          ),
        ),
      ),
    );

  const stopAndRemoveSession = (
    clientId: string,
    session: ActiveSpeechSession,
    operation: "stop" | "cancel",
  ) =>
    Effect.gen(function* () {
      if (session.stopped) {
        return;
      }
      yield* updateSession(clientId, (current) =>
        current ? { ...current, stopped: true } : current,
      );
      if (operation === "stop") {
        yield* session.handle.stop().pipe(
          Effect.tap((text) =>
            publishEvent(
              clientId,
              makeServiceEvent(session.sessionId, session.provider, "transcript.finalized", {
                text,
                revision: 0,
              }),
            ),
          ),
          Effect.tap(() =>
            publishEvent(
              clientId,
              makeServiceEvent(session.sessionId, session.provider, "session.stopped", {}),
            ),
          ),
          Effect.ignore,
        );
      } else {
        yield* session.handle.cancel().pipe(Effect.ignore);
      }
      yield* Effect.sync(() => {
        if (
          session.eventFiber &&
          typeof session.eventFiber === "object" &&
          "interruptAsFork" in (session.eventFiber as object)
        ) {
          Effect.runFork(Fiber.interrupt(session.eventFiber as never));
        }
      });
      yield* updateSession(clientId, () => undefined);
    });

  return {
    getConfig: () => config.loadSnapshot,
    updateConfig: (input: SpeechToTextUpdateConfigInput) => config.updateConfig(input),
    resetConfig: () => config.resetToDefaults,
    streamConfigChanges: config.changes,
    streamClientEvents: (clientId: string) =>
      Stream.fromPubSub(eventsPubSub).pipe(
        Stream.filter((entry) => entry.clientId === clientId),
        Stream.map((entry) => entry.event),
      ),
    startTranscription: (clientId: string, input: SpeechToTextStartInput) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(activeSessionsRef);
        if (current.has(clientId)) {
          return yield* makeInternalError(
            "Only one speech-to-text session may be active per connection.",
          );
        }
        const { adapter, settings } = yield* resolveEligibleProvider(input.provider);
        const sessionId = SpeechToTextSessionIdSchema.makeUnsafe(crypto.randomUUID());
        const handle = yield* adapter.startSession({
          sessionId,
          input,
          settings,
        }).pipe(
          Effect.mapError((cause) =>
            makeInternalError(`Failed to start ${input.provider} speech-to-text session.`, cause),
          ),
        );
        const eventFiber = yield* attachSessionEvents(clientId, sessionId, handle);
        yield* updateSession(clientId, () => ({
          clientId,
          sessionId,
          provider: input.provider,
          handle,
          eventFiber,
          stopped: false,
        }));
        const model =
          "model" in settings && typeof settings.model === "string" && settings.model.trim().length > 0
            ? settings.model.trim()
            : "modelId" in settings && typeof settings.modelId === "string"
              ? settings.modelId.trim()
              : undefined;
        return {
          sessionId,
          provider: input.provider,
          ...(model ? { model } : {}),
        } satisfies SpeechToTextStartResult;
      }),
    appendAudio: (clientId: string, input: SpeechToTextAppendAudioInput) =>
      Effect.gen(function* () {
        const session = yield* getActiveSession(clientId);
        if (session.sessionId !== input.sessionId) {
          return yield* makeInternalError("Speech session does not match this connection.");
        }
        if (session.stopped) {
          return yield* makeInternalError("Speech session has already been stopped.");
        }
        yield* session.handle.appendAudio(input).pipe(
          Effect.mapError((cause) =>
            makeInternalError("Failed to append speech audio frame.", cause),
          ),
        );
      }),
    stopTranscription: (clientId: string, input: SpeechToTextStopInput) =>
      Effect.gen(function* () {
        const session = yield* getActiveSession(clientId);
        if (session.sessionId !== input.sessionId) {
          return yield* makeInternalError("Speech session does not match this connection.");
        }
        yield* updateSession(clientId, (current) =>
          current ? { ...current, stopped: true } : current,
        );
        const text = yield* session.handle.stop().pipe(
          Effect.mapError((cause) =>
            makeInternalError("Failed to finalize speech transcription.", cause),
          ),
        );
        yield* Effect.sync(() => {
          if (
            session.eventFiber &&
            typeof session.eventFiber === "object" &&
            "interruptAsFork" in (session.eventFiber as object)
          ) {
            Effect.runFork(Fiber.interrupt(session.eventFiber as never));
          }
        });
        yield* publishEvent(
          clientId,
          makeServiceEvent(session.sessionId, session.provider, "transcript.finalized", {
            text,
            revision: 0,
          }),
        );
        yield* publishEvent(
          clientId,
          makeServiceEvent(session.sessionId, session.provider, "session.stopped", {}),
        );
        yield* updateSession(clientId, () => undefined);
        return {
          sessionId: session.sessionId,
          text,
        } satisfies SpeechToTextStopResult;
      }),
    cancelTranscription: (clientId: string, input: SpeechToTextCancelInput) =>
      Effect.gen(function* () {
        const session = yield* getActiveSession(clientId);
        if (session.sessionId !== input.sessionId) {
          return yield* makeInternalError("Speech session does not match this connection.");
        }
        yield* stopAndRemoveSession(clientId, session, "cancel");
      }),
    disconnectClient: (clientId: string) =>
      Effect.gen(function* () {
        const active = yield* Ref.get(activeSessionsRef);
        const session = active.get(clientId);
        if (!session) {
          return;
        }
        yield* stopAndRemoveSession(clientId, session, "cancel");
      }),
  } satisfies SpeechToTextServiceShape;
});

export const SpeechToTextServiceLive = Layer.effect(
  SpeechToTextService,
  makeSpeechToTextService,
);
