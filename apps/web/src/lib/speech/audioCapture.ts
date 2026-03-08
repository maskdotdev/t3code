const TARGET_SAMPLE_RATE = 16_000;
const FRAME_DURATION_MS = 200;
const FRAME_SIZE = (TARGET_SAMPLE_RATE * FRAME_DURATION_MS) / 1_000;

export interface SpeechAudioCaptureSupport {
  readonly supported: boolean;
  readonly reason: string | null;
}

export interface StartSpeechAudioCaptureOptions {
  readonly onFrame: (frame: Int16Array) => void;
}

export interface SpeechAudioCaptureController {
  readonly stop: () => Promise<void>;
}

const WORKLET_PROCESSOR_NAME = "t3-speech-capture-processor";
let workletModuleUrl: string | null = null;

function ensureWorkletModuleUrl(): string {
  if (workletModuleUrl) {
    return workletModuleUrl;
  }
  const source = `
class T3SpeechCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.frameSize = 3200;
    this.downsampledBuffer = [];
    this.remainder = [];
    this.sourceSampleRate = sampleRate;
  }

  downsample(channelData) {
    const input = this.remainder.concat(Array.from(channelData));
    const ratio = this.sourceSampleRate / this.targetSampleRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Int16Array(outputLength);
    let offset = 0;
    for (let index = 0; index < outputLength; index += 1) {
      const nextOffset = Math.floor((index + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let sampleIndex = offset; sampleIndex < nextOffset && sampleIndex < input.length; sampleIndex += 1) {
        sum += input[sampleIndex];
        count += 1;
      }
      const sample = count > 0 ? sum / count : 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      output[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      offset = nextOffset;
    }
    this.remainder = input.slice(offset);
    return output;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) {
      return true;
    }

    const downsampled = this.downsample(channel);
    for (const sample of downsampled) {
      this.downsampledBuffer.push(sample);
    }

    while (this.downsampledBuffer.length >= this.frameSize) {
      const frame = this.downsampledBuffer.slice(0, this.frameSize);
      this.downsampledBuffer = this.downsampledBuffer.slice(this.frameSize);
      this.port.postMessage(Int16Array.from(frame));
    }
    return true;
  }
}

registerProcessor("${WORKLET_PROCESSOR_NAME}", T3SpeechCaptureProcessor);
`;
  workletModuleUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  return workletModuleUrl;
}

export function getSpeechAudioCaptureSupport(): SpeechAudioCaptureSupport {
  if (typeof window === "undefined") {
    return { supported: false, reason: "Audio capture is unavailable in this environment." };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { supported: false, reason: "Microphone capture is not supported in this browser." };
  }
  const AudioContextCtor = window.AudioContext ?? (window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;
  if (!AudioContextCtor) {
    return { supported: false, reason: "Web Audio is not supported in this browser." };
  }
  if (!("audioWorklet" in AudioContextCtor.prototype)) {
    return { supported: false, reason: "AudioWorklet is not supported in this browser." };
  }
  return { supported: true, reason: null };
}

export async function startSpeechAudioCapture(
  options: StartSpeechAudioCaptureOptions,
): Promise<SpeechAudioCaptureController> {
  const support = getSpeechAudioCaptureSupport();
  if (!support.supported) {
    throw new Error(support.reason ?? "Audio capture is unavailable.");
  }

  const AudioContextCtor = window.AudioContext ?? (window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("AudioContext is unavailable.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    },
  });
  const audioContext = new AudioContextCtor();
  await audioContext.audioWorklet.addModule(ensureWorkletModuleUrl());

  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
  });
  const sink = audioContext.createGain();
  sink.gain.value = 0;

  const handleMessage = (event: MessageEvent<Int16Array>) => {
    const frame = event.data;
    if (!(frame instanceof Int16Array)) {
      return;
    }
    options.onFrame(frame);
  };
  worklet.port.addEventListener("message", handleMessage as EventListener);
  worklet.port.start();

  source.connect(worklet);
  worklet.connect(sink);
  sink.connect(audioContext.destination);

  return {
    stop: async () => {
      worklet.port.removeEventListener("message", handleMessage as EventListener);
      worklet.disconnect();
      source.disconnect();
      sink.disconnect();
      for (const track of stream.getTracks()) {
        track.stop();
      }
      await audioContext.close();
    },
  };
}

export const SPEECH_FRAME_DURATION_MS = FRAME_DURATION_MS;
export const SPEECH_FRAME_SIZE = FRAME_SIZE;
