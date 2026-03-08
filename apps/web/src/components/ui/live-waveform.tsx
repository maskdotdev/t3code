import { useMemo } from "react";

import { cn } from "~/lib/utils";

interface LiveWaveformProps {
  readonly data: ReadonlyArray<number>;
  readonly active?: boolean;
  readonly className?: string;
}

const BAR_COUNT = 32;

function normalizeWaveformData(data: ReadonlyArray<number>): number[] {
  if (data.length >= BAR_COUNT) {
    return data.slice(-BAR_COUNT);
  }
  const padding = Array.from({ length: BAR_COUNT - data.length }, () => 0.02);
  return [...padding, ...data];
}

export function LiveWaveform(props: LiveWaveformProps) {
  const bars = useMemo(() => {
    const waveform = normalizeWaveformData(props.data);
    const seen = new Map<string, number>();
    return waveform.map((value) => {
      const bucket = value.toFixed(3);
      const occurrence = seen.get(bucket) ?? 0;
      seen.set(bucket, occurrence + 1);
      return {
        key: `${bucket}:${occurrence}`,
        value,
      };
    });
  }, [props.data]);

  return (
    <div
      className={cn(
        "relative flex h-10 items-end gap-px overflow-hidden rounded-xl px-1.5 py-1.5",
        props.className,
      )}
      aria-hidden="true"
    >
      {bars.map((bar) => {
        const value = bar.value;
        const normalized = Math.max(props.active ? 0.04 : 0.02, Math.min(1, value));
        const shaped = Math.pow(normalized, 0.6);
        const heightPercent = 12 + shaped * 88;
        const barOpacity = props.active ? 0.35 + shaped * 0.65 : 0.15 + shaped * 0.2;
        return (
          <span
            key={bar.key}
            className="relative z-10 block w-[3px] shrink-0 grow rounded-full bg-white transition-[height,opacity] duration-100 ease-out"
            style={{
              height: `${heightPercent}%`,
              opacity: barOpacity,
            }}
          />
        );
      })}
    </div>
  );
}
