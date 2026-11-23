"use client";

import { useEffect, useRef, useState } from "react";
import { Katex } from "@/components/math/katex";
import { splitInlineMath } from "@/lib/editor-utils";
import { cn } from "@/lib/utils";

interface CaptionFieldProps {
  value: string;
  onChange: (value: string) => void;
  editable: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Caption stored as a node attribute. Shows rendered `$math$` while idle and the raw
 * text while editing.
 */
export function CaptionField({ value, onChange, editable, placeholder = "캡션을 입력하세요", className }: CaptionFieldProps) {
  // Non-null while editing; keeps remote updates from moving the caret.
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null;

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={draft}
        rows={1}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(e.target.value);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
          }
        }}
        className={cn(
          "field-sizing-content min-w-40 flex-1 resize-none rounded-sm bg-muted/50 px-1 outline-none ring-1 ring-ring/40",
          className
        )}
      />
    );
  }

  return (
    <span
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      onClick={() => editable && setDraft(value)}
      onKeyDown={(e) => {
        if (editable && e.key === "Enter") setDraft(value);
      }}
      className={cn(
        "rounded-sm px-0.5",
        editable && "cursor-text hover:bg-muted/60",
        !value && "text-muted-foreground italic",
        className
      )}
    >
      {value
        ? splitInlineMath(value).map((part, i) =>
            part.math ? <Katex key={i} latex={part.text} /> : <span key={i}>{part.text}</span>
          )
        : editable
          ? placeholder
          : ""}
    </span>
  );
}
