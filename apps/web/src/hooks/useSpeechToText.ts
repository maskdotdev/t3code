import type { SpeechToTextConfigSnapshot, SpeechToTextProviderKind } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { speechConfigQueryOptions, speechQueryKeys } from "../lib/speechReactQuery";
import {
  getSpeechAudioCaptureSupport,
  SPEECH_FRAME_DURATION_MS,
  startSpeechAudioCapture,
  type SpeechAudioCaptureController,
} from "../lib/speech/audioCapture";
import { ensureNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";

const MAX_BUFFERED_MS = 3_000;
const MAX_BUFFERED_FRAMES = Math.floor(MAX_BUFFERED_MS / SPEECH_FRAME_DURATION_MS);
const WAVEFORM_HISTORY_SIZE = 40;

export type SpeechState =
  | { phase: "idle" }
  | {
      phase: "recording" | "stopping";
      sessionId: string;
      provider: SpeechToTextProviderKind;
      previewText: string;
      startedAt: number;
    }
  | {
      phase: "error";
      provider: SpeechToTextProviderKind | null;
      message: string;
      recoverable: boolean;
    };

export interface UseSpeechToTextOptions {
  readonly disabled?: boolean;
  readonly onInsertTranscript: (text: string) => void;
}

export interface UseSpeechToTextResult {
  readonly support: ReturnType<typeof getSpeechAudioCaptureSupport>;
  readonly defaultProvider: SpeechToTextProviderKind | null;
  readonly activeProvider: SpeechToTextProviderKind | null;
  readonly state: SpeechState;
  readonly elapsedMs: number;
  readonly waveformLevels: number[];
  readonly disabledReason: string | null;
  readonly startRecording: () => Promise<void>;
  readonly stopRecording: () => Promise<void>;
  readonly cancelRecording: () => Promise<void>;
  readonly discard: () => Promise<void>;
  readonly retry: () => Promise<void>;
}

export function speechToTextProviderLabel(provider: SpeechToTextProviderKind): string {
  switch (provider) {
    case "local-http":
      return "Local HTTP";
    case "elevenlabs":
      return "ElevenLabs";
    case "gemini":
      return "Gemini";
  }
}

function pcm16ToBase64(frame: Int16Array): string {
  const bytes = new Uint8Array(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function transcriptInsertion(text: string): string {
  return text.trim();
}

function resolveReadyDefaultProvider(
  config: SpeechToTextConfigSnapshot | null,
): SpeechToTextProviderKind | null {
  if (!config) return null;
  const configuredDefault = config.providers.find(
    (provider) =>
      provider.provider === config.settings.defaultProvider &&
      config.settings.providers[provider.provider].enabled &&
      provider.status !== "error",
  );
  return configuredDefault?.provider ?? null;
}

export function useSpeechToText(options: UseSpeechToTextOptions): UseSpeechToTextResult {
  const api = ensureNativeApi();
  const queryClient = useQueryClient();
  const support = useMemo(() => getSpeechAudioCaptureSupport(), []);
  const configQuery = useQuery(speechConfigQueryOptions());
  const snapshot = configQuery.data ?? null;
  const [state, setState] = useState<SpeechState>({ phase: "idle" });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [waveformLevels, setWaveformLevels] = useState<number[]>([]);

  const captureRef = useRef<SpeechAudioCaptureController | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const providerRef = useRef<SpeechToTextProviderKind | null>(null);
  const generationRef = useRef(0);
  const queueRef = useRef<Int16Array[]>([]);
  const sendingRef = useRef(false);
  const drainingWaitersRef = useRef<Array<() => void>>([]);
  const sequenceRef = useRef(0);

  const resetRuntime = useCallback(() => {
    generationRef.current += 1;
    sessionIdRef.current = null;
    providerRef.current = null;
    queueRef.current = [];
    sendingRef.current = false;
    sequenceRef.current = 0;
    drainingWaitersRef.current = [];
    setElapsedMs(0);
    setWaveformLevels([]);
  }, []);

  const pushWaveformLevel = useCallback((frame: Int16Array) => {
    let sum = 0;
    for (let index = 0; index < frame.length; index += 1) {
      const sample = frame[index] ?? 0;
      const normalized = sample / 32768;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    const level = Math.max(0.04, Math.min(1, rms * 6));
    setWaveformLevels((current) => {
      const next = [...current, level];
      return next.length > WAVEFORM_HISTORY_SIZE ? next.slice(-WAVEFORM_HISTORY_SIZE) : next;
    });
  }, []);

  const defaultProvider = useMemo(() => resolveReadyDefaultProvider(snapshot), [snapshot]);

  useEffect(() => {
    const unsubscribeConfigUpdated = api.speech.onConfigUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: speechQueryKeys.config() });
    });
    const unsubscribeEvents = api.speech.onEvent((event) => {
      const expectedGeneration = generationRef.current;
      if (sessionIdRef.current !== event.sessionId) {
        return;
      }
      if (expectedGeneration !== generationRef.current) {
        return;
      }

      setState((current) => {
        if (current.phase !== "recording" && current.phase !== "stopping") {
          return current;
        }
        if ("provider" in current && current.provider !== event.provider) {
          return current;
        }
        switch (event.type) {
          case "transcript.preview.updated":
            return { ...current, previewText: event.text };
          case "session.error":
            return {
              phase: "error",
              provider: event.provider,
              message: event.message,
              recoverable: event.recoverable,
            };
          default:
            return current;
        }
      });
    });

    return () => {
      unsubscribeConfigUpdated();
      unsubscribeEvents();
    };
  }, [api.speech, queryClient]);

  useEffect(() => {
    if (state.phase !== "recording" && state.phase !== "stopping") {
      return;
    }
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - state.startedAt);
    }, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  const flushQueue = useCallback(async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      while (queueRef.current.length > 0 && sessionIdRef.current) {
        const frame = queueRef.current.shift();
        if (!frame) break;
        await api.speech.appendAudio({
          sessionId: sessionIdRef.current,
          sequenceNumber: sequenceRef.current,
          sampleRateHz: 16_000,
          channels: 1,
          encoding: "pcm_s16le",
          audioBase64: pcm16ToBase64(frame),
        });
        sequenceRef.current += 1;
      }
    } finally {
      sendingRef.current = false;
      if (queueRef.current.length === 0) {
        for (const resolve of drainingWaitersRef.current.splice(0)) {
          resolve();
        }
      } else {
        void flushQueue();
      }
    }
  }, [api.speech]);

  const waitForQueueDrain = useCallback(async () => {
    if (!sendingRef.current && queueRef.current.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      drainingWaitersRef.current.push(resolve);
    });
  }, []);

  const clearCapture = useCallback(async () => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (!capture) return;
    await capture.stop().catch(() => undefined);
  }, []);

  const handleFailure = useCallback(
    async (message: string, provider: SpeechToTextProviderKind | null, recoverable = true) => {
      await clearCapture();
      const activeSessionId = sessionIdRef.current;
      resetRuntime();
      if (activeSessionId) {
        await api.speech.cancelTranscription({ sessionId: activeSessionId }).catch(() => undefined);
      }
      setState({ phase: "error", provider, message, recoverable });
    },
    [api.speech, clearCapture, resetRuntime],
  );

  const startRecording = useCallback(async () => {
    if (options.disabled) return;
    if (!support.supported) {
      setState({
        phase: "error",
        provider: null,
        message: support.reason ?? "Audio capture is unavailable.",
        recoverable: false,
      });
      return;
    }
    if (!defaultProvider) {
      const configuredDefault = snapshot?.settings.defaultProvider ?? null;
      const providerStatus = configuredDefault
        ? snapshot?.providers.find((provider) => provider.provider === configuredDefault) ?? null
        : null;
      setState({
        phase: "error",
        provider: providerStatus?.provider ?? configuredDefault,
        message:
          providerStatus?.message ??
          "Set a ready default speech provider in Settings before recording.",
        recoverable: true,
      });
      return;
    }

    const startResult = await api.speech
      .startTranscription({
        provider: defaultProvider,
        sampleRateHz: 16_000,
        channels: 1,
        encoding: "pcm_s16le",
      })
      .catch(async (error) => {
        await handleFailure(
          error instanceof Error ? error.message : "Could not start speech-to-text.",
          defaultProvider,
        );
        return null;
      });
    if (!startResult) {
      return;
    }

    const startedAt = Date.now();
    sessionIdRef.current = startResult.sessionId;
    providerRef.current = defaultProvider;
    queueRef.current = [];
    sequenceRef.current = 0;
      setState({
        phase: "recording",
        sessionId: startResult.sessionId,
        provider: defaultProvider,
        previewText: "",
      startedAt,
    });

    try {
      captureRef.current = await startSpeechAudioCapture({
        onFrame: (frame) => {
          pushWaveformLevel(frame);
          queueRef.current.push(frame);
          if (queueRef.current.length > MAX_BUFFERED_FRAMES) {
            void handleFailure(
              "Audio capture could not keep up. Recording was stopped before the transcript could drift.",
              providerRef.current,
            );
            return;
          }
          void flushQueue();
        },
      });
    } catch (error) {
      await api.speech
        .cancelTranscription({ sessionId: startResult.sessionId })
        .catch(() => undefined);
      resetRuntime();
      setState({
        phase: "error",
        provider: defaultProvider,
        message:
          error instanceof Error ? error.message : "Microphone permission was denied or unavailable.",
        recoverable: true,
      });
    }
  }, [
    api.speech,
    flushQueue,
    handleFailure,
    options.disabled,
    resetRuntime,
    defaultProvider,
    snapshot,
    support.reason,
    support.supported,
    pushWaveformLevel,
  ]);

  const stopRecording = useCallback(async () => {
    if (state.phase !== "recording" || !sessionIdRef.current || !providerRef.current) {
      return;
    }
    const sessionId = sessionIdRef.current;
    const provider = providerRef.current;
    setState((current) =>
      current.phase === "recording" ? { ...current, phase: "stopping" } : current,
    );
    await clearCapture();
    await waitForQueueDrain();
    const result = await api.speech.stopTranscription({ sessionId }).catch(async (error) => {
      await handleFailure(
        error instanceof Error ? error.message : "Could not finalize speech transcription.",
        provider,
      );
      return null;
    });
    if (!result) {
      return;
    }
    resetRuntime();
    const finalText = transcriptInsertion(result.text);
    if (finalText.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Transcript was empty",
        description: "Nothing was inserted into the composer.",
      });
      setState({ phase: "idle" });
      return;
    }
    options.onInsertTranscript(finalText);
    setState({ phase: "idle" });
  }, [api.speech, clearCapture, handleFailure, options, resetRuntime, state.phase, waitForQueueDrain]);

  const discard = useCallback(async () => {
    await clearCapture();
    resetRuntime();
    setState({ phase: "idle" });
  }, [clearCapture, resetRuntime]);

  const cancelRecording = useCallback(async () => {
    if (!sessionIdRef.current) {
      await discard();
      return;
    }
    const sessionId = sessionIdRef.current;
    await clearCapture();
    await api.speech.cancelTranscription({ sessionId }).catch(() => undefined);
    resetRuntime();
    setState({ phase: "idle" });
  }, [api.speech, clearCapture, discard, resetRuntime]);

  const retry = useCallback(async () => {
    await discard();
    await startRecording();
  }, [discard, startRecording]);

  const activeProvider =
    state.phase === "recording" || state.phase === "stopping"
      ? state.provider
      : state.phase === "error"
        ? state.provider
        : defaultProvider;

  const disabledReason = useMemo(() => {
    if (state.phase === "recording" || state.phase === "stopping") {
      return null;
    }
    if (!support.supported) {
      return support.reason ?? "Audio capture is unavailable.";
    }
    if (options.disabled) {
      return "Speech-to-text is unavailable while the composer is busy.";
    }
    if (!snapshot) {
      return "Loading speech settings...";
    }
    const configuredDefault = snapshot.settings.defaultProvider;
    const defaultStatus =
      snapshot.providers.find((provider) => provider.provider === configuredDefault) ?? null;
    if (!defaultStatus) {
      return "Configure a default speech provider in Settings.";
    }
    if (!snapshot.settings.providers[configuredDefault].enabled) {
      return `${speechToTextProviderLabel(configuredDefault)} is disabled in Settings.`;
    }
    if (defaultStatus.status === "error") {
      return (
        defaultStatus.message ?? `${speechToTextProviderLabel(configuredDefault)} is unavailable.`
      );
    }
    return null;
  }, [options.disabled, snapshot, state.phase, support.reason, support.supported]);

  return {
    support,
    defaultProvider,
    activeProvider,
    state,
    elapsedMs,
    waveformLevels,
    disabledReason,
    startRecording,
    stopRecording,
    cancelRecording,
    discard,
    retry,
  };
}
