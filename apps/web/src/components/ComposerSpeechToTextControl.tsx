import { MicIcon } from "lucide-react";

import type { UseSpeechToTextResult } from "../hooks/useSpeechToText";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface ComposerSpeechToTextControlProps {
  readonly speech: Pick<
    UseSpeechToTextResult,
    "disabledReason" | "startRecording" | "state" | "stopRecording"
  >;
}

export function ComposerSpeechToTextControl(props: ComposerSpeechToTextControlProps) {
  const phase = props.speech.state.phase;

  // Stop button is now integrated into ComposerSpeechToTextStatus,
  // so hide this control entirely when recording/stopping.
  if (phase === "recording" || phase === "stopping") {
    return null;
  }

  const disabled = props.speech.disabledReason !== null;
  const tooltipText = props.speech.disabledReason ?? "Start dictation";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="outline"
            className="rounded-full"
            disabled={disabled}
            aria-label="Start dictation"
            onClick={() => void props.speech.startRecording()}
          >
            <MicIcon className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="top">{tooltipText}</TooltipPopup>
    </Tooltip>
  );
}
