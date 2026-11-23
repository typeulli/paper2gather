"use client";

import { createElement, Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import katex from "katex";
import { Mark, type DOMOutputSpec, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { ImageIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { Katex } from "@/components/math/katex";
import type { RevisionContent, RevisionNode } from "@/lib/api";
import { resolveAssetUrl } from "@/lib/config";
import { captionLabelText, equationNumberText, type PaperFormat } from "@/lib/paper/format";
import { DIFF_DEL, DIFF_INS, mergeLatex } from "@/lib/paper/latex-diff";
import { computeNumbering, EMPTY_NUMBERING, type NumberingSnapshot } from "@/lib/paper/numbering";
import { pageGeometry } from "@/lib/paper/page";
import { citationText, entryLabel, isAuthorDate, layoutCitations, type CitationLayout } from "@/lib/paper/citations";
import { parseRefIds, withLaterFields } from "@/lib/paper/references";
import type { DiffNode, DiffSide, PaperDiff } from "@/lib/paper/revision-diff";
import type { TikzSource } from "@/lib/tikz/options";
import { cn } from "@/lib/utils";
import { buildPaperSchema } from "../extensions";
import { crossRefText } from "../nodes/cross-ref";
import { tikzErrorText, TikzSvg, useTikz } from "../nodes/tikz-svg";
import { useFormat } from "../paper-context";

export const ADDED = "rounded-sm bg-emerald-500/20 text-emerald-700 no-underline dark:text-emerald-300";
export const REMOVED = "rounded-sm bg-red-500/20 text-red-700 no-underline dark:text-red-300";
/** Formulas, figures and tables shown as they were and as they are */
const FRAME: Record<DiffSide, string> = { del: "ring-2 ring-red-500/70", ins: "ring-2 ring-emerald-500/70" };
/** ADDED and REMOVED for the parts of a formula (KaTeX \htmlClass, see latex-diff.ts) */
const FORMULA_PARTS =
  "[&_.diff-del]:rounded-sm [&_.diff-del]:bg-red-500/20 [&_.diff-del]:text-red-700 dark:[&_.diff-del]:text-red-300 " +
  "[&_.diff-ins]:rounded-sm [&_.diff-ins]:bg-emerald-500/20 [&_.diff-ins]:text-emerald-700 dark:[&_.diff-ins]:text-emerald-300";
const MIN_PAGE_SCALE = 0.25;

let schema: Schema | undefined;
const paperSchema = () => (schema ??= buildPaperSchema());

// ------------------------------------------------------------------ numbers

/** What the numbers of one version come from */
export interface Version {
  numbering: NumberingSnapshot;
  /** The reference list and citation marks, in the current citation style */
  citations: CitationLayout;
}

interface RenderContext {
  format: PaperFormat;
  before: Version;
  after: Version;
}

/** Removed things are numbered as in the version before, the rest as in the version after. */
const versionOf = (ctx: RenderContext, node: { side?: DiffSide }) => (node.side === "del" ? ctx.before : ctx.after);

function pmJSON(node: RevisionNode): Record<string, unknown> {
  if (node.type !== "text") return { type: node.type, attrs: node.attrs, content: node.content.map(pmJSON) };
  const marks = Object.entries(node.marks ?? {})
    .filter(([name]) => paperSchema().marks[name])
    .map(([type, attrs]) => ({ type, attrs }));
  return { type: "text", text: node.text, marks };
}

export function revisionVersion(content: RevisionContent, format: PaperFormat): Version {
  let numbering = EMPTY_NUMBERING;
  try {
    numbering = computeNumbering(
      paperSchema().nodeFromJSON({ type: "doc", content: content.blocks.map(pmJSON) }),
      format
    );
  } catch {
    // Content this editor version can't read: shown without numbers
  }
  // Versions saved before a reference field existed lack it.
  const references = content.references.map(withLaterFields);
  return { numbering, citations: layoutCitations(references, numbering.citationOrder, format.citation) };
}

// ------------------------------------------------------------------ the editor's HTML

const VOID_ELEMENTS = new Set(["br", "hr", "col", "img", "wbr"]);

function parseStyle(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    const name = declaration.slice(0, colon).trim();
    if (colon < 0 || !name) continue;
    const key = name.startsWith("--") ? name : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = declaration.slice(colon + 1).trim();
  }
  return out;
}

function reactProps(attrs: Record<string, unknown> | undefined): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false || name === "contenteditable") continue;
    if (name === "class") props.className = value;
    else if (name === "style") props.style = parseStyle(String(value));
    else if (name === "colspan") props.colSpan = value;
    else if (name === "rowspan") props.rowSpan = value;
    else props[name] = String(value);
  }
  return props;
}

const hasHole = (spec: unknown): boolean => spec === 0 || (Array.isArray(spec) && spec.some(hasHole));

/** The HTML that ProseMirror makes from `spec` (a node's or mark's toDOM), with `hole` as its content */
function fromSpec(spec: DOMOutputSpec, hole: ReactNode, top = true): ReactNode {
  if (typeof spec === "string") return spec;
  if (!Array.isArray(spec)) return hole;
  const [tag, ...rest] = spec as readonly unknown[];
  const name = String(tag).split(" ").pop() ?? "div";
  const first = rest[0];
  const attrs =
    first && typeof first === "object" && !Array.isArray(first) ? (first as Record<string, unknown>) : undefined;
  if (VOID_ELEMENTS.has(name)) return createElement(name, reactProps(attrs));
  const children = (attrs ? rest.slice(1) : rest).map((child) =>
    child === 0 ? hole : fromSpec(child as DOMOutputSpec, hole, false)
  );
  // Without a hole, the content goes into the outermost element.
  if (top && !hasHole(spec)) children.push(hole);
  return createElement(name, reactProps(attrs), ...children);
}

function specOf(node: DiffNode): DOMOutputSpec {
  const type = paperSchema().nodes[node.type];
  try {
    // A table gets its column widths from its cells.
    const pm: PMNode =
      node.type === "table"
        ? paperSchema().nodeFromJSON(pmJSON(node as RevisionNode))
        : type.create(node.attrs);
    return type.spec.toDOM?.(pm) ?? ["div", 0];
  } catch {
    return ["div", 0];
  }
}

function marksOf(node: DiffNode): readonly Mark[] {
  const marks: Mark[] = [];
  for (const [name, attrs] of Object.entries(node.marks ?? {})) {
    try {
      const type = paperSchema().marks[name];
      if (type) marks.push(type.create(attrs));
    } catch {
      // Attributes this editor version doesn't accept: the text without that mark
    }
  }
  return Mark.setFrom(marks);
}

// ------------------------------------------------------------------ inline content

/** Removed or added: marked like in the text comparison */
function changed(node: { side?: DiffSide; change?: number }, content: ReactNode): ReactNode {
  if (!node.side) return content;
  const Tag = node.side;
  return (
    <Tag data-change={node.change} className={node.side === "del" ? REMOVED : ADDED}>
      {content}
    </Tag>
  );
}

const trustDiffClasses = (context: { command: string; class?: string }) =>
  context.command === "\\htmlClass" && (context.class === DIFF_DEL || context.class === DIFF_INS);

/** Both versions of a formula in one, the changed parts marked; null if they can't be shown so */
function mergedFormula(before: string, after: string, displayMode: boolean): string | null {
  const latex = mergeLatex(before, after);
  if (latex === null) return null;
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: true,
      strict: "ignore",
      trust: trustDiffClasses,
      output: "htmlAndMathml",
    });
  } catch {
    return null;
  }
}

function ChangedInlineFormula({ before, after, change }: { before: string; after: string; change?: number }) {
  const html = useMemo(() => mergedFormula(before, after, false), [before, after]);
  if (html !== null) return <span data-change={change} dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <>
      <del data-change={change} className={REMOVED}>
        <Katex latex={before} />
      </del>
      <ins data-change={change} className={ADDED}>
        <Katex latex={after} />
      </ins>
    </>
  );
}

function inline(node: DiffNode, ctx: RenderContext, inCaption: boolean): ReactNode {
  switch (node.type) {
    case "text": {
      let content: ReactNode = node.text;
      const marks = marksOf(node);
      for (let i = marks.length - 1; i >= 0; i--) {
        const toDOM = marks[i].type.spec.toDOM;
        if (toDOM) content = fromSpec(toDOM(marks[i], true), content);
      }
      return changed(node, content);
    }
    case "hardBreak":
      return <br />;
    case "mathInline": {
      const latex = String(node.attrs.latex ?? "");
      const formula =
        node.latexBefore !== undefined ? (
          <ChangedInlineFormula before={node.latexBefore} after={latex} change={node.change} />
        ) : (
          <Katex latex={latex} placeholder="수식" />
        );
      // Captions show their formulas plainly (see CaptionField).
      return changed(
        node,
        inCaption ? (
          formula
        ) : (
          <span className="math-inline">
            <span className="rounded-sm px-0.5">{formula}</span>
          </span>
        )
      );
    }
    case "citation": {
      const ids = parseRefIds(node.attrs.refs);
      const layout = versionOf(ctx, node).citations;
      const options = {
        mode: node.attrs.mode === "narrative" ? ("narrative" as const) : ("paren" as const),
        locator: String(node.attrs.locator ?? ""),
      };
      return changed(
        node,
        <span className="citation">
          <span className={cn("rounded-sm px-px text-primary", ids.some((id) => !layout.byId.has(id)) && "text-destructive")}>
            {citationText(ids, layout, options)}
          </span>
        </span>
      );
    }
    case "crossRef": {
      const text = crossRefText(versionOf(ctx, node).numbering.byId.get(String(node.attrs.target ?? "")), ctx.format);
      return changed(
        node,
        <span className="cross-ref">
          <span className={cn("rounded-sm px-px text-primary", text === "??" && "text-destructive")}>{text}</span>
        </span>
      );
    }
    default:
      return inlines(node.content, ctx, inCaption);
  }
}

function inlines(nodes: DiffNode[], ctx: RenderContext, inCaption = false): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{inline(node, ctx, inCaption)}</Fragment>);
}

// ------------------------------------------------------------------ blocks

function EquationView({ node, ctx, formula }: { node: DiffNode; ctx: RenderContext; formula: string | undefined }) {
  const latex = String(node.attrs.latex ?? "");
  const id = typeof node.attrs.id === "string" ? node.attrs.id : null;
  const number = id ? versionOf(ctx, node).numbering.byId.get(id)?.number : null;
  const rowRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const numberRef = useRef<HTMLSpanElement>(null);
  // Too wide to share the line with its number: the number moves below (as in the editor).
  const [wide, setWide] = useState(false);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const box = boxRef.current;
    const num = numberRef.current;
    if (!row || !box || !num) return;
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(row);
      const width = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const gap = parseFloat(style.columnGap) || 0;
      setWide(box.offsetWidth > width - num.offsetWidth - 2 * gap);
    });
    for (const el of [row, box, num]) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div data-change={node.change} className={cn("equation-node relative my-3 rounded-md", node.side && FRAME[node.side])}>
      <div
        ref={rowRef}
        className={cn("min-h-10 gap-x-2 px-2 py-1", wide ? "flex flex-col" : "grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center")}
      >
        <div ref={boxRef} className={cn("w-fit py-1 text-center", wide ? "mx-auto" : "col-start-2")}>
          {formula !== undefined ? (
            <span dangerouslySetInnerHTML={{ __html: formula }} />
          ) : (
            <Katex latex={latex} displayMode placeholder="수식" />
          )}
        </div>
        <span ref={numberRef} className={cn("equation-number tabular-nums", wide ? "self-end" : "justify-self-end")}>
          {node.attrs.numbered !== false && number ? equationNumberText(number, ctx.format.equation.brackets) : ""}
        </span>
      </div>
    </div>
  );
}

function EquationBlock({ node, ctx }: { node: DiffNode; ctx: RenderContext }) {
  const latex = String(node.attrs.latex ?? "");
  const before = node.latexBefore;
  const formula = useMemo(() => (before === undefined ? undefined : mergedFormula(before, latex, true)), [before, latex]);
  if (before !== undefined && formula === null) {
    // Can't be compared inside: as it was and as it is
    return (
      <>
        <EquationView node={{ ...node, attrs: { ...node.attrs, latex: before }, side: "del" }} ctx={ctx} formula={undefined} />
        <EquationView node={{ ...node, side: "ins" }} ctx={ctx} formula={undefined} />
      </>
    );
  }
  return <EquationView node={node} ctx={ctx} formula={formula ?? undefined} />;
}

/** "Figure 1. <caption>" in the document's caption format (see ObjectCaption) */
function Caption({ kind, number, node, ctx }: { kind: "figure" | "table"; number: string; node: DiffNode; ctx: RenderContext }) {
  const format = ctx.format[kind];
  return (
    <div className="paper-caption">
      <span className={cn(format.labelBold && "font-bold")}>{captionLabelText(format, number)}</span>{" "}
      <span className="rounded-sm px-0.5">{inlines(node.caption ?? [], ctx, true)}</span>
    </div>
  );
}

function objectNumber(node: DiffNode, ctx: RenderContext): string {
  const id = node.attrs.id;
  return (typeof id === "string" && versionOf(ctx, node).numbering.byId.get(id)?.number) || "?";
}

function TikzFigure({ source, width }: { source: TikzSource; width: number }) {
  const { result, compiling } = useTikz(source);
  return (
    <div className="flex w-full justify-center">
      {result?.ok ? (
        <TikzSvg svg={result.svg} width={width} className={cn(compiling && "opacity-60")} />
      ) : result ? (
        <div className="flex w-3/4 flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 font-sans text-xs text-destructive">
          <span className="flex items-center gap-1.5 font-medium">
            <TriangleAlertIcon className="size-3.5" /> TikZ 오류
          </span>
          {result.errors.slice(0, 3).map((error, i) => (
            <span key={i}>{tikzErrorText(error)}</span>
          ))}
        </div>
      ) : (
        <div className="flex h-32 w-3/4 items-center justify-center gap-2 rounded-lg border-2 border-dashed font-sans text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" /> TikZ 그림을 그리는 중…
        </div>
      )}
    </div>
  );
}

function FigureBlock({ node, ctx }: { node: DiffNode; ctx: RenderContext }) {
  const { src, width, tikz, tikzLibraries, tikzPackages, caption } = node.attrs;
  const captionEl = (
    <figcaption className="w-full max-w-[90%]">
      <Caption kind="figure" number={objectNumber(node, ctx)} node={node} ctx={ctx} />
    </figcaption>
  );
  const position = ctx.format.figure.position;
  return (
    <div
      data-change={node.side ? node.change : undefined}
      className={cn("figure-node relative my-5 rounded-md py-2", node.side && FRAME[node.side])}
    >
      <figure className="flex flex-col items-center">
        {position === "above" && captionEl}
        {typeof tikz === "string" ? (
          <TikzFigure
            source={{ code: tikz, libraries: String(tikzLibraries ?? ""), packages: String(tikzPackages ?? "") }}
            width={Number(width) || 0}
          />
        ) : src ? (
          // eslint-disable-next-line @next/next/no-img-element -- user content from the collab backend
          <img
            src={resolveAssetUrl(String(src))}
            alt={String(caption ?? "")}
            style={{ width: `${Number(width) || 75}%` }}
            className="rounded-sm"
          />
        ) : (
          <div className="flex h-40 w-3/4 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-sm text-muted-foreground">
            <ImageIcon className="size-6" /> 이미지 없음
          </div>
        )}
        {position === "below" && captionEl}
      </figure>
    </div>
  );
}

function TableFigureBlock({ node, ctx }: { node: DiffNode; ctx: RenderContext }) {
  const captionEl = <Caption kind="table" number={objectNumber(node, ctx)} node={node} ctx={ctx} />;
  const position = ctx.format.table.position;
  return (
    <div
      data-change={node.side ? node.change : undefined}
      className={cn("table-figure my-5 rounded-md", node.side && FRAME[node.side])}
    >
      {position === "above" && captionEl}
      <div className="table-figure-content overflow-x-auto">{blocks(node.content, ctx)}</div>
      {position === "below" && captionEl}
    </div>
  );
}

function block(node: DiffNode, ctx: RenderContext): ReactNode {
  switch (node.type) {
    case "equation":
      return <EquationBlock node={node} ctx={ctx} />;
    case "figure":
      return <FigureBlock node={node} ctx={ctx} />;
    case "tableFigure":
      return <TableFigureBlock node={node} ctx={ctx} />;
    case "appendixBreak":
      return (
        <div data-change={node.change} className={cn("appendix-break rounded-sm", node.side && FRAME[node.side])}>
          부록 시작
        </div>
      );
    case "heading": {
      const id = node.attrs.id;
      const obj = typeof id === "string" ? versionOf(ctx, node).numbering.byId.get(id) : undefined;
      const number = obj?.shown;
      return fromSpec(
        specOf(node),
        <>
          {number && <span className="heading-number">{number}</span>}
          {inlines(node.content, ctx)}
        </>
      );
    }
    case "table":
      return <div className="tableWrapper">{fromSpec(specOf(node), blocks(node.content, ctx))}</div>;
  }
  const type = paperSchema().nodes[node.type];
  if (!type) return blocks(node.content, ctx);
  return fromSpec(specOf(node), type.isTextblock ? inlines(node.content, ctx) : blocks(node.content, ctx));
}

function blocks(nodes: DiffNode[], ctx: RenderContext): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{block(node, ctx)}</Fragment>);
}

// ------------------------------------------------------------------ the page

interface RevisionPaperProps {
  /** See revisionVersion */
  before: Version;
  after: Version;
  diff: PaperDiff;
}

/**
 * The paper with the changes of a revision, laid out like the editor's pages (as one long page) in the
 * document's current format. Elements of change i have data-change="i".
 */
export function RevisionPaper({ before, after, diff }: RevisionPaperProps) {
  const format = useFormat();
  const ctx = useMemo<RenderContext>(() => ({ format, before, after }), [before, after, format]);
  const authorDate = isAuthorDate(format.citation.style);

  const content = useMemo(
    () => (
      <>
        <header className="mb-8 flex flex-col items-center gap-3 border-b pb-6">
          <div className="paper-title w-full">
            {diff.title.length > 0 ? inlines(diff.title, ctx) : <span className="text-muted-foreground/50">논문 제목</span>}
          </div>
          {diff.authors.length > 0 && (
            <div className="flex flex-wrap items-start justify-center gap-x-4 gap-y-1 text-sm">
              {diff.authors.map((author, i) => (
                <span
                  key={i}
                  data-change={author.change}
                  className={cn("flex flex-col items-center rounded-md px-2 py-1 text-center", author.side && FRAME[author.side])}
                >
                  <span className="font-medium">{author.name.length > 0 ? inlines(author.name, ctx) : "이름 없음"}</span>
                  {author.affiliation.length > 0 && (
                    <span className="text-xs text-muted-foreground">{inlines(author.affiliation, ctx)}</span>
                  )}
                  {author.email.length > 0 && (
                    <span className="font-mono text-[11px] text-muted-foreground">{inlines(author.email, ctx)}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </header>
        <div className="paper-body">{blocks(diff.blocks, ctx)}</div>
        {diff.references.length > 0 && (
          <section className="mt-12 border-t pt-6">
            <h2 className="paper-references-title">{ctx.format.references.title}</h2>
            <ol className="paper-references">
              {diff.references.map((ref, i) => {
                const layout = versionOf(ctx, ref).citations;
                const entry = layout.byId.get(ref.id);
                const label = entry ? entryLabel(entry, layout.style) : "?";
                return (
                  <li key={i} className={cn("flex gap-3", !entry?.cited && "opacity-60")}>
                    {/* Author-date lists have no labels and a hanging indent of 0.5 in (APA). */}
                    {!authorDate && <span className="w-8 shrink-0 text-right tabular-nums">{label}</span>}
                    <span
                      className={cn("ref-text min-w-0 flex-1 break-words", authorDate && "pl-[0.5in] -indent-[0.5in]")}
                    >
                      {inlines(ref.text, ctx)}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </>
    ),
    [diff, ctx, authorDate]
  );

  // The page shrinks to fit the width, like in the editor.
  const geometry = useMemo(() => pageGeometry(format.page), [format.page]);
  const outerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ scale: 1, height: 0 });
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const page = pageRef.current;
    if (!outer || !page) return;
    const observer = new ResizeObserver(() =>
      setSize({
        scale: Math.max(MIN_PAGE_SCALE, Math.min(1, outer.clientWidth / geometry.width)),
        height: page.offsetHeight,
      })
    );
    observer.observe(outer);
    observer.observe(page);
    return () => observer.disconnect();
  }, [geometry.width]);

  const { margin } = geometry;
  return (
    <div ref={outerRef}>
      <div className="mx-auto" style={{ width: geometry.width * size.scale, height: size.height * size.scale }}>
        <article
          ref={pageRef}
          className={cn("paper-page origin-top-left rounded-sm border bg-background shadow-sm", FORMULA_PARTS)}
          style={{
            width: geometry.width,
            padding: `${margin.top}px ${margin.right}px ${margin.bottom}px ${margin.left}px`,
            transform: size.scale < 1 ? `scale(${size.scale})` : undefined,
          }}
        >
          {content}
        </article>
      </div>
    </div>
  );
}
