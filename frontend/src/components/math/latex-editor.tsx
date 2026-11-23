"use client";

import { useEffect, useRef } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Katex, renderLatex } from "./katex";

/** `|` marks where the caret goes after insertion. */
const SYMBOLS: { group: string; items: { insert: string; preview: string }[] }[] = [
  {
    group: "그리스",
    items: [
      "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "lambda",
      "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "phi", "varphi", "chi", "psi", "omega",
      "Gamma", "Delta", "Theta", "Lambda", "Pi", "Sigma", "Phi", "Psi", "Omega",
    ].map((n) => ({ insert: `\\${n}`, preview: `\\${n}` })),
  },
  {
    group: "연산",
    items: [
      { insert: "\\frac{|}{}", preview: "\\frac{a}{b}" },
      { insert: "\\sqrt{|}", preview: "\\sqrt{x}" },
      { insert: "^{|}", preview: "x^{n}" },
      { insert: "_{|}", preview: "x_{i}" },
      { insert: "\\sum_{|}^{}", preview: "\\sum_{i}^{n}" },
      { insert: "\\prod_{|}^{}", preview: "\\prod_{i}^{n}" },
      { insert: "\\int_{|}^{}", preview: "\\int_{a}^{b}" },
      { insert: "\\oint", preview: "\\oint" },
      { insert: "\\lim_{| \\to }", preview: "\\lim_{x \\to 0}" },
      { insert: "\\partial", preview: "\\partial" },
      { insert: "\\nabla", preview: "\\nabla" },
      { insert: "\\times", preview: "\\times" },
      { insert: "\\cdot", preview: "\\cdot" },
      { insert: "\\pm", preview: "\\pm" },
      { insert: "\\otimes", preview: "\\otimes" },
      { insert: "\\circ", preview: "\\circ" },
      { insert: "\\infty", preview: "\\infty" },
      { insert: "\\log", preview: "\\log" },
      { insert: "\\exp", preview: "\\exp" },
      { insert: "\\max_{|}", preview: "\\max_{x}" },
      { insert: "\\arg\\min_{|}", preview: "\\arg\\min_{x}" },
      { insert: "\\mathbb{E}\\left[|\\right]", preview: "\\mathbb{E}[x]" },
    ],
  },
  {
    group: "관계",
    items: [
      "leq", "geq", "neq", "approx", "equiv", "sim", "propto", "ll", "gg", "in", "notin", "subset",
      "subseteq", "cup", "cap", "forall", "exists", "to", "rightarrow", "Rightarrow", "Leftrightarrow",
      "mapsto", "mid", "perp", "parallel",
    ].map((n) => ({ insert: `\\${n}`, preview: `\\${n}` })),
  },
  {
    group: "구조",
    items: [
      { insert: "\\left( | \\right)", preview: "\\left( x \\right)" },
      { insert: "\\left\\{ | \\right\\}", preview: "\\left\\{ x \\right\\}" },
      { insert: "\\left\\| | \\right\\|", preview: "\\left\\| x \\right\\|" },
      { insert: "\\begin{aligned}\n  | &= \\\\\n  &= \n\\end{aligned}", preview: "\\begin{aligned}a&=b\\\\&=c\\end{aligned}" },
      { insert: "\\begin{cases}\n  | & \\text{if } \\\\\n  & \\text{otherwise}\n\\end{cases}", preview: "\\begin{cases}a&x\\\\b&y\\end{cases}" },
      { insert: "\\begin{pmatrix}\n  | & \\\\\n  & \n\\end{pmatrix}", preview: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}" },
      { insert: "\\begin{bmatrix}\n  | & \\\\\n  & \n\\end{bmatrix}", preview: "\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}" },
      { insert: "\\underbrace{|}_{}", preview: "\\underbrace{x}_{n}" },
      { insert: "\\overset{|}{}", preview: "\\overset{a}{=}" },
      { insert: "\\text{|}", preview: "\\text{abc}" },
    ],
  },
  {
    group: "서식",
    items: [
      { insert: "\\mathbf{|}", preview: "\\mathbf{x}" },
      { insert: "\\boldsymbol{|}", preview: "\\boldsymbol{\\theta}" },
      { insert: "\\mathbb{|}", preview: "\\mathbb{R}" },
      { insert: "\\mathcal{|}", preview: "\\mathcal{L}" },
      { insert: "\\mathrm{|}", preview: "\\mathrm{d}" },
      { insert: "\\hat{|}", preview: "\\hat{x}" },
      { insert: "\\bar{|}", preview: "\\bar{x}" },
      { insert: "\\tilde{|}", preview: "\\tilde{x}" },
      { insert: "\\vec{|}", preview: "\\vec{v}" },
      { insert: "\\dot{|}", preview: "\\dot{x}" },
      { insert: "\\overline{|}", preview: "\\overline{AB}" },
      { insert: "^{\\top}", preview: "A^{\\top}" },
    ],
  },
];

interface LatexEditorProps {
  value: string;
  onChange: (value: string) => void;
  displayMode: boolean;
  autoFocus?: boolean;
  /** Called on Ctrl/Cmd+Enter (and plain Enter when `singleLine`) */
  onSubmit?: () => void;
  onCancel?: () => void;
  singleLine?: boolean;
  /** "errors" only shows parse errors (when the node itself already renders the preview) */
  preview?: "full" | "errors";
  className?: string;
}

export function LatexEditor({
  value,
  onChange,
  displayMode,
  autoFocus,
  onSubmit,
  onCancel,
  singleLine,
  preview = "full",
  className,
}: LatexEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  useEffect(() => {
    if (pendingCaret.current === null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  const insert = (snippet: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const caret = snippet.indexOf("|");
    const text = snippet.replace("|", "");
    const before = value.slice(0, start);
    const needsSpace = /\\[a-zA-Z]+$/.test(before) && /^[a-zA-Z]/.test(text);
    const prefix = needsSpace ? " " : "";
    pendingCaret.current = start + prefix.length + (caret >= 0 ? caret : text.length);
    onChange(before + prefix + text + value.slice(end));
  };

  const rendered = value.trim() ? renderLatex(value, displayMode) : null;
  const result = rendered && (preview === "full" || "error" in rendered) ? rendered : null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Tabs defaultValue={SYMBOLS[0].group} className="gap-1">
        <TabsList className="h-7">
          {SYMBOLS.map((g) => (
            <TabsTrigger key={g.group} value={g.group} className="px-2 text-xs">
              {g.group}
            </TabsTrigger>
          ))}
        </TabsList>
        {SYMBOLS.map((g) => (
          <TabsContent key={g.group} value={g.group} className="flex flex-wrap gap-0.5">
            {g.items.map((item) => (
              <button
                key={item.insert}
                type="button"
                title={item.insert.replace("|", "")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(item.insert)}
                className="flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-xs hover:bg-muted"
              >
                <Katex latex={item.preview} className="pointer-events-none [&_.katex]:text-[0.85em]" />
              </button>
            ))}
          </TabsContent>
        ))}
      </Tabs>
      <Textarea
        ref={ref}
        value={value}
        spellCheck={false}
        rows={singleLine ? 2 : 4}
        placeholder={displayMode ? "예: E = mc^2  또는 \\begin{aligned} ... \\end{aligned}" : "예: x^2 + y^2 = r^2"}
        className="min-h-0 font-mono text-sm"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel?.();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (singleLine && !e.shiftKey))) {
            e.preventDefault();
            onSubmit?.();
          }
        }}
      />
      {result && (
        <div className="min-h-10 overflow-x-auto overflow-y-hidden rounded-md border bg-muted/30 px-3 py-2">
          {"error" in result ? (
            <p className="font-mono text-xs text-destructive">{result.error}</p>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: result.html }} />
          )}
        </div>
      )}
    </div>
  );
}
