"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { compileTikz, instantiateSvg, peekTikz, type TikzError, type TikzResult } from "@/lib/tikz/engine";
import type { TikzSource } from "@/lib/tikz/options";
import { cn } from "@/lib/utils";

/** The compiled figure; while a new version compiles, the previous result stays. */
export function useTikz(src: TikzSource): { result: TikzResult | null; compiling: boolean } {
  const { code, libraries, packages } = src;
  const [state, setState] = useState<{ result: TikzResult | null; compiling: boolean }>(() => {
    const cached = peekTikz(src);
    return { result: cached ?? null, compiling: !cached };
  });

  useEffect(() => {
    let alive = true;
    const source = { code, libraries, packages };
    const cached = peekTikz(source);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- shows the cached figure without a frame of the old one
    setState((s) => (cached ? { result: cached, compiling: false } : { ...s, compiling: true }));
    void compileTikz(source, { persist: true }).then((result) => alive && setState({ result, compiling: false }));
    return () => {
      alive = false;
    };
  }, [code, libraries, packages]);

  return state;
}

/** A sanitized SVG from the engine. `width`: % of the available width, 0 = natural size. */
export function TikzSvg({ svg, width, className }: { svg: string; width: number; className?: string }) {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, "");
  const html = useMemo(() => instantiateSvg(svg, instance), [svg, instance]);
  return (
    <div
      className={cn("tikz-svg", width > 0 && "tikz-svg-scaled", className)}
      style={width > 0 ? { width: `${width}%` } : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function tikzErrorText(error: TikzError): string {
  return error.line ? `${error.line}행: ${error.message}` : error.message;
}
