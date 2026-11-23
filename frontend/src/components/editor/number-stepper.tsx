"use client";

import { useState, type MouseEvent } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NumberStepperProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Accessible name of the field, e.g. "글자 크기" */
  label: string;
  /** Shown after the field, e.g. "pt" */
  unit?: string;
  onChange: (value: number) => void;
  /** Called after Enter commits the typed value (e.g. to return focus to the editor). */
  onSubmit?: () => void;
  /** Keep focus where it is when the −/+ buttons are clicked (toolbar use). */
  keepFocus?: boolean;
  className?: string;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** −/+ buttons around a numeric field that commits on Enter or blur. */
export function NumberStepper({
  value,
  min,
  max,
  step = 1,
  label,
  unit,
  onChange,
  onSubmit,
  keepFocus,
  className,
}: NumberStepperProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, round(n)));

  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (draft.trim() !== "" && Number.isFinite(n) && clamp(n) !== value) onChange(clamp(n));
  };

  const preventFocus = keepFocus ? (e: MouseEvent) => e.preventDefault() : undefined;

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`${label} 줄이기`}
        disabled={value <= min}
        onMouseDown={preventFocus}
        onClick={() => onChange(clamp(value - step))}
      >
        <MinusIcon />
      </Button>
      <input
        aria-label={label}
        title={label}
        inputMode="decimal"
        value={draft ?? String(value)}
        onFocus={(e) => {
          setDraft(String(value));
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          commit();
          onSubmit?.();
        }}
        className="h-6 w-11 rounded-md border border-input bg-transparent text-center text-xs tabular-nums outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"
      />
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`${label} 늘리기`}
        disabled={value >= max}
        onMouseDown={preventFocus}
        onClick={() => onChange(clamp(value + step))}
      >
        <PlusIcon />
      </Button>
      {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
    </div>
  );
}
