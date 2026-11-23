"use client";

import { CheckIcon } from "lucide-react";
import { TEXT_COLORS } from "@/lib/paper/format";
import { cn } from "@/lib/utils";

interface ColorPaletteProps {
  /** Current color (#rrggbb); null or "" means the default text color. */
  value: string | null;
  /** null restores the default color. */
  onChange: (color: string | null) => void;
  /** Called after a swatch is clicked (not while dragging the custom picker), e.g. to close a popover. */
  onPick?: () => void;
}

const swatch =
  "flex size-6 items-center justify-center rounded-full border border-black/10 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-white/15";

/** Text color choices: default, a fixed palette and a custom color. */
export function ColorPalette({ value, onChange, onPick }: ColorPaletteProps) {
  const current = value?.toLowerCase() || null;
  const pick = (color: string | null) => {
    onChange(color);
    onPick?.();
  };
  const isCustom = current !== null && !TEXT_COLORS.some((c) => c.value === current);

  return (
    <div className="grid w-max grid-cols-6 gap-1.5">
      <button
        type="button"
        title="기본 색"
        aria-label="기본 색"
        onClick={() => pick(null)}
        className={cn(swatch, "bg-foreground text-background")}
      >
        {current === null && <CheckIcon className="size-3.5" />}
      </button>
      {TEXT_COLORS.map((c) => (
        <button
          key={c.value}
          type="button"
          title={c.label}
          aria-label={c.label}
          onClick={() => pick(c.value)}
          className={cn(swatch, "text-white")}
          style={{ background: c.value }}
        >
          {current === c.value && <CheckIcon className="size-3.5" />}
        </button>
      ))}
      <label
        title="사용자 지정 색"
        className={cn(swatch, "relative cursor-pointer overflow-hidden", isCustom && "ring-2 ring-ring")}
        style={{ background: isCustom ? current : "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }}
      >
        <input
          type="color"
          aria-label="사용자 지정 색"
          value={current ?? "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}
