import { RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";

import {
  speechToTextProviderLabel,
  type UseSpeechToTextResult,
} from "../hooks/useSpeechToText";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { LiveWaveform } from "./ui/live-waveform";

interface ComposerSpeechToTextStatusProps {
  readonly speech: Pick<
    UseSpeechToTextResult,
    | "activeProvider"
    | "discard"
    | "elapsedMs"
    | "retry"
    | "state"
    | "stopRecording"
    | "waveformLevels"
  >;
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function ComposerSpeechToTextStatus(props: ComposerSpeechToTextStatusProps) {
  if (props.speech.state.phase === "idle") {
    return null;
  }

  if (props.speech.state.phase === "error") {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-destructive/25 bg-[linear-gradient(180deg,rgba(127,29,29,0.12),rgba(127,29,29,0.04))] px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-destructive/25 bg-destructive/8 px-2 py-1">
          <span aria-hidden="true" className="size-2 rounded-full bg-destructive" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-destructive/90">
            Error
          </span>
        </div>
        <span className="truncate text-xs text-destructive/90">{props.speech.state.message}</span>
        {props.speech.state.recoverable ? (
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 rounded-full text-destructive/90 hover:text-destructive"
            onClick={() => void props.speech.retry()}
          >
            <RotateCcwIcon className="size-3.5" />
            Retry
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0 rounded-full text-destructive/90 hover:text-destructive"
          aria-label="Dismiss dictation error"
          onClick={() => void props.speech.discard()}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
    );
  }

  const isRecording = props.speech.state.phase === "recording";
  const isStopping = props.speech.state.phase === "stopping";
  const providerLabel = props.speech.activeProvider
    ? speechToTextProviderLabel(props.speech.activeProvider)
    : "Dictation";

  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5">

      {/* Status badge */}
      <div className="relative z-10 inline-flex shrink-0 items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5">
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex size-1.5 rounded-full",
            isRecording
              ? "animate-pulse bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]"
              : "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]",
          )}
        />
        <div className="min-w-0">
          <div className="text-[9px] font-semibold uppercase leading-tight tracking-[0.16em] text-muted-foreground/70">
            {isRecording ? "Recording" : "Finalizing"}
          </div>
          <div className="max-w-28 truncate text-[11px] font-medium leading-tight text-foreground/90">
            {providerLabel}
          </div>
        </div>
      </div>

      {/* Waveform */}
      <LiveWaveform
        active={isRecording}
        className="relative z-10 min-w-0 flex-1"
        data={props.speech.waveformLevels}
      />

      {/* Timer + Stop grouped together */}
      <div className="relative z-10 flex shrink-0 items-center gap-1.5">
        <div className="inline-flex items-center rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1">
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground/80">
            {isRecording ? formatElapsed(props.speech.elapsedMs) : "…"}
          </span>
        </div>

        {/* Stop button */}
        <button
          type="button"
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-lg border transition-colors",
            isStopping
              ? "cursor-not-allowed border-white/[0.06] bg-white/[0.03] text-muted-foreground/50"
              : "border-rose-500/30 bg-rose-500/10 text-rose-400 hover:border-rose-500/50 hover:bg-rose-500/20 hover:text-rose-300",
          )}
          disabled={isStopping}
          aria-label="Stop dictation"
          onClick={() => void props.speech.stopRecording()}
        >
          <SquareIcon className="size-3 fill-current" />
        </button>
      </div>
    </div>
  );
}
