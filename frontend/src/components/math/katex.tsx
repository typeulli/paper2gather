"use client";

import { memo, useMemo } from "react";
import katex from "katex";
import { cn } from "@/lib/utils";

export function renderLatex(latex: string, displayMode: boolean): { html: string } | { error: string } {
  try {
    return {
      html: katex.renderToString(latex, {
        displayMode,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml",
      }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^KaTeX parse error: /, "") : String(err) };
  }
}

interface KatexProps {
  latex: string;
  displayMode?: boolean;
  className?: string;
  placeholder?: string;
}

export const Katex = memo(function Katex({ latex, displayMode = false, className, placeholder }: KatexProps) {
  const result = useMemo(() => (latex.trim() ? renderLatex(latex, displayMode) : null), [latex, displayMode]);
  if (!result) {
    return <span className={cn("text-muted-foreground italic", className)}>{placeholder ?? "수식 입력"}</span>;
  }
  if ("error" in result) {
    return (
      <span className={cn("font-mono text-xs text-destructive", className)} title={result.error}>
        {latex}
      </span>
    );
  }
  return <span className={className} dangerouslySetInnerHTML={{ __html: result.html }} />;
});
