import { diffArrays } from "diff";
import type { RevisionContent, RevisionNode } from "@/lib/api";
import { splitInlineMath } from "@/lib/editor-utils";
import { formatReferenceAs, type CitationLayout } from "./citations";
import type { Author, Reference } from "./types";

/**
 * The paper before and after a revision merged into one, to show the revision the way the editor shows
 * the paper: words only in the version before are "del", words only in the version after "ins". A
 * formula changed in place keeps both versions, to be compared inside the formula. A figure or table
 * that looks different is there twice: as it was ("del") and as it is ("ins").
 */

export type DiffSide = "del" | "ins";

export interface DiffNode {
  type: string;
  attrs: Record<string, unknown>;
  content: DiffNode[];
  text?: string;
  marks?: Record<string, Record<string, unknown>>;
  /** Only in the version before ("del") or after ("ins"); unset: in both */
  side?: DiffSide;
  /** The change it belongs to; changes are numbered in the order of the paper */
  change?: number;
  /** A formula changed in place: its LaTeX before (attrs.latex is the one after) */
  latexBefore?: string;
  /** Caption of a figure or table, as inline nodes */
  caption?: DiffNode[];
}

export interface AuthorDiff {
  id: string;
  side?: DiffSide;
  change?: number;
  name: DiffNode[];
  affiliation: DiffNode[];
  email: DiffNode[];
}

export interface ReferenceDiff {
  id: string;
  side?: DiffSide;
  text: DiffNode[];
}

export interface PaperDiff {
  title: DiffNode[];
  authors: AuthorDiff[];
  blocks: DiffNode[];
  references: ReferenceDiff[];
  /** Number of changes */
  changes: number;
}

interface Context {
  changes: number;
}

/** Inline content beyond this many edits is shown as removed and added whole */
const MAX_EDIT_LENGTH = 2000;
/** Blocks of a changed stretch are compared word by word when at least this similar */
const MIN_SIMILARITY = 0.5;

const TEXTBLOCKS = new Set(["paragraph", "heading", "codeBlock"]);
const CONTAINERS = new Set(["bulletList", "orderedList", "listItem", "blockquote"]);
const OBJECTS = new Set(["equation", "figure", "tableFigure"]);
/** Attributes that make up the look of a figure (unlike its caption or label) */
const FIGURE_LOOK = ["src", "width", "tikz", "tikzLibraries", "tikzPackages"];

/** JSON with sorted keys, so equal values are equal strings */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const text = (value: string, marks: Record<string, Record<string, unknown>> = {}): RevisionNode => ({
  type: "text",
  attrs: {},
  content: [],
  text: value,
  marks,
});

const plainText = (value: string | undefined): RevisionNode[] => (value ? [text(value)] : []);

/** A caption with its `$…$` formulas */
function captionNodes(node: RevisionNode): RevisionNode[] {
  return splitInlineMath(String(node.attrs.caption ?? "")).map((part) =>
    part.math ? { type: "mathInline", attrs: { latex: part.text }, content: [] } : text(part.text)
  );
}

function toDiff(node: RevisionNode, side?: DiffSide, change?: number): DiffNode {
  const out: DiffNode = {
    type: node.type,
    attrs: node.attrs,
    content: node.content.map((child) => toDiff(child, side, change)),
  };
  if (node.text !== undefined) out.text = node.text;
  if (node.marks) out.marks = node.marks;
  if (side) {
    out.side = side;
    out.change = change;
  }
  if (node.type === "figure" || node.type === "tableFigure") {
    out.caption = captionNodes(node).map((child) => toDiff(child, side, change));
  }
  return out;
}

// ------------------------------------------------------------------ words

// Korean words are compared whole, not syllable by syllable.
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("ko", { granularity: "word" }) : undefined;

const words = (value: string): string[] =>
  segmenter ? Array.from(segmenter.segment(value), (s) => s.segment) : value.split(/(\s+)/).filter(Boolean);

interface Token {
  key: string;
  /** A word or space of a text node, or an inline node */
  node: RevisionNode;
}

function tokens(content: RevisionNode[]): Token[] {
  const out: Token[] = [];
  for (const node of content) {
    if (node.type !== "text") {
      out.push({ key: `n${canonical(node)}`, node });
      continue;
    }
    const marks = canonical(node.marks ?? {});
    for (const word of words(node.text ?? "")) out.push({ key: `t${marks}\u0000${word}`, node: { ...node, text: word } });
  }
  return out;
}

const isSpace = (t: Token) => t.node.type === "text" && !t.node.text?.trim();
const isMath = (t: Token) => t.node.type === "mathInline";

/** Inline nodes in order, with adjacent text of the same marks and change joined */
class InlineBuilder {
  readonly nodes: DiffNode[] = [];

  add(node: RevisionNode, side?: DiffSide, change?: number) {
    const last = this.nodes[this.nodes.length - 1];
    if (
      node.type === "text" &&
      last?.type === "text" &&
      last.side === side &&
      last.change === change &&
      canonical(last.marks ?? {}) === canonical(node.marks ?? {})
    ) {
      last.text += node.text ?? "";
      return;
    }
    this.nodes.push(toDiff(node, side, change));
  }

  addAll(list: Token[], side?: DiffSide, change?: number) {
    for (const t of list) this.add(t.node, side, change);
  }
}

type Run = { equal: true; before: Token[]; after: Token[] } | { equal: false; del: Token[]; ins: Token[] };

/** Text (and inline nodes) compared word by word */
function mergeInline(before: RevisionNode[], after: RevisionNode[], ctx: Context): DiffNode[] {
  const a = tokens(before);
  const b = tokens(after);
  const out = new InlineBuilder();
  const parts = diffArrays(
    a.map((t) => t.key),
    b.map((t) => t.key),
    { maxEditLength: MAX_EDIT_LENGTH }
  );
  if (!parts) {
    const change = ctx.changes++;
    out.addAll(a, "del", change);
    out.addAll(b, "ins", change);
    return out.nodes;
  }

  const runs: Run[] = [];
  let ia = 0;
  let ib = 0;
  for (const part of parts) {
    const n = part.count;
    if (!part.added && !part.removed) {
      runs.push({ equal: true, before: a.slice(ia, ia + n), after: b.slice(ib, ib + n) });
      ia += n;
      ib += n;
      continue;
    }
    let last = runs[runs.length - 1];
    if (!last || last.equal) runs.push((last = { equal: false, del: [], ins: [] }));
    if (part.removed) {
      last.del.push(...a.slice(ia, ia + n));
      ia += n;
    } else {
      last.ins.push(...b.slice(ib, ib + n));
      ib += n;
    }
  }
  // A space between two changes belongs to them: "두 번째" → "세 번째" is one change, not two.
  for (let i = 1; i + 1 < runs.length; i++) {
    const [prev, run, next] = [runs[i - 1], runs[i], runs[i + 1]];
    if (!run.equal || prev.equal || next.equal || !run.after.every(isSpace)) continue;
    runs.splice(i - 1, 3, {
      equal: false,
      del: [...prev.del, ...run.before, ...next.del],
      ins: [...prev.ins, ...run.after, ...next.ins],
    });
    i--;
  }

  for (const run of runs) {
    if (run.equal) {
      out.addAll(run.after);
      continue;
    }
    const change = ctx.changes++;
    const mathDel = run.del.filter(isMath);
    const mathIns = run.ins.filter(isMath);
    if (mathDel.length === 0 || mathDel.length !== mathIns.length) {
      out.addAll(run.del, "del", change);
      out.addAll(run.ins, "ins", change);
      continue;
    }
    // Formulas in the same place are compared inside; the text around them word by word.
    let pd = 0;
    let pi = 0;
    for (let k = 0; k <= mathDel.length; k++) {
      const endDel = k < mathDel.length ? run.del.indexOf(mathDel[k], pd) : run.del.length;
      const endIns = k < mathIns.length ? run.ins.indexOf(mathIns[k], pi) : run.ins.length;
      out.addAll(run.del.slice(pd, endDel), "del", change);
      out.addAll(run.ins.slice(pi, endIns), "ins", change);
      if (k === mathDel.length) break;
      const before = String(mathDel[k].node.attrs.latex ?? "");
      const node = toDiff(mathIns[k].node);
      if (before !== node.attrs.latex) {
        node.change = change;
        node.latexBefore = before;
      }
      out.nodes.push(node);
      pd = endDel + 1;
      pi = endIns + 1;
    }
  }
  return out.nodes;
}

// ------------------------------------------------------------------ blocks

function textOf(node: RevisionNode): string {
  const own = [node.text, node.attrs.latex, node.attrs.caption].filter((v) => typeof v === "string").join(" ");
  return own + node.content.map(textOf).join(" ");
}

/** Dice coefficient of the character pairs, 0…1 */
function similarity(a: RevisionNode, b: RevisionNode): number {
  const pairs = (node: RevisionNode) => {
    const s = textOf(node).replace(/\s+/g, "");
    const counts = new Map<string, number>();
    for (let i = 0; i + 1 < s.length; i++) counts.set(s.slice(i, i + 2), (counts.get(s.slice(i, i + 2)) ?? 0) + 1);
    return { counts, total: Math.max(0, s.length - 1) };
  };
  const pa = pairs(a);
  const pb = pairs(b);
  if (pa.total + pb.total === 0) return 1;
  let common = 0;
  for (const [pair, n] of pa.counts) common += Math.min(n, pb.counts.get(pair) ?? 0);
  return (2 * common) / (pa.total + pb.total);
}

/** Whether a removed and an added block are compared with each other (else shown whole) */
function pairable(r: RevisionNode, a: RevisionNode, only: boolean): boolean {
  if (r.type !== a.type) return false;
  if (!TEXTBLOCKS.has(r.type) && !CONTAINERS.has(r.type) && !OBJECTS.has(r.type)) return false;
  // Headings, formulas, figures and tables keep their id when edited.
  if (typeof r.attrs.id === "string" && r.attrs.id && r.attrs.id === a.attrs.id) return true;
  return only || similarity(r, a) >= MIN_SIMILARITY;
}

function mergePair(r: RevisionNode, a: RevisionNode, ctx: Context): DiffNode[] {
  if (TEXTBLOCKS.has(a.type)) return [{ type: a.type, attrs: a.attrs, content: mergeInline(r.content, a.content, ctx) }];
  if (CONTAINERS.has(a.type)) return [{ type: a.type, attrs: a.attrs, content: mergeBlocks(r.content, a.content, ctx) }];
  if (a.type === "equation") {
    const node = toDiff(a);
    const before = String(r.attrs.latex ?? "");
    if (before !== a.attrs.latex) {
      node.change = ctx.changes++;
      node.latexBefore = before;
    }
    return [node];
  }
  const sameLook =
    a.type === "figure"
      ? FIGURE_LOOK.every((k) => canonical(r.attrs[k]) === canonical(a.attrs[k]))
      : canonical(r.content) === canonical(a.content);
  if (sameLook) return [{ ...toDiff(a), caption: mergeInline(captionNodes(r), captionNodes(a), ctx) }];
  const change = ctx.changes++;
  return [toDiff(r, "del", change), toDiff(a, "ins", change)];
}

/** A changed stretch: blocks that were removed and blocks that were added in their place */
function mergeStretch(removed: RevisionNode[], added: RevisionNode[], ctx: Context): DiffNode[] {
  const out: DiffNode[] = [];
  const only = removed.length === 1 && added.length === 1;
  /** Change of the blocks shown whole in a row */
  let run: number | undefined;
  const whole = (node: RevisionNode, side: DiffSide) => {
    run ??= ctx.changes++;
    out.push(toDiff(node, side, run));
  };
  let j = 0;
  for (const r of removed) {
    let match = -1;
    for (let m = j; m < added.length && match < 0; m++) if (pairable(r, added[m], only)) match = m;
    if (match < 0) {
      whole(r, "del");
      continue;
    }
    for (; j < match; j++) whole(added[j], "ins");
    run = undefined;
    out.push(...mergePair(r, added[j], ctx));
    j++;
  }
  for (; j < added.length; j++) whole(added[j], "ins");
  return out;
}

function mergeBlocks(before: RevisionNode[], after: RevisionNode[], ctx: Context): DiffNode[] {
  const parts = diffArrays(before.map(canonical), after.map(canonical));
  const out: DiffNode[] = [];
  let ia = 0;
  let ib = 0;
  for (let k = 0; k < parts.length; k++) {
    if (!parts[k].added && !parts[k].removed) {
      const n = parts[k].count;
      for (let j = 0; j < n; j++) out.push(toDiff(after[ib + j]));
      ia += n;
      ib += n;
      continue;
    }
    let removed = 0;
    let added = 0;
    for (; k < parts.length && (parts[k].added || parts[k].removed); k++) {
      if (parts[k].removed) removed += parts[k].count;
      else added += parts[k].count;
    }
    k--;
    out.push(...mergeStretch(before.slice(ia, ia + removed), after.slice(ib, ib + added), ctx));
    ia += removed;
    ib += added;
  }
  return out;
}

// ------------------------------------------------------------------ authors and references

function authorDiff(author: Author, side?: DiffSide, change?: number): AuthorDiff {
  const field = (value: string | undefined) => plainText(value).map((node) => toDiff(node, side, change));
  return {
    id: author.id,
    side,
    change,
    name: field(author.name),
    affiliation: field(author.affiliation),
    email: field(author.email),
  };
}

/** In the order of the version after; moved authors are shown removed where they were */
function mergeAuthors(before: Author[], after: Author[], ctx: Context): AuthorDiff[] {
  const parts = diffArrays(
    before.map((a) => a.id),
    after.map((a) => a.id)
  );
  const out: AuthorDiff[] = [];
  let ia = 0;
  let ib = 0;
  let run: number | undefined;
  for (const part of parts) {
    const n = part.count;
    if (part.removed) {
      run ??= ctx.changes++;
      for (const author of before.slice(ia, ia + n)) out.push(authorDiff(author, "del", run));
      ia += n;
    } else if (part.added) {
      run ??= ctx.changes++;
      for (const author of after.slice(ib, ib + n)) out.push(authorDiff(author, "ins", run));
      ib += n;
    } else {
      run = undefined;
      for (let j = 0; j < n; j++) {
        const [old, now] = [before[ia + j], after[ib + j]];
        out.push({
          id: now.id,
          name: mergeInline(plainText(old.name), plainText(now.name), ctx),
          affiliation: mergeInline(plainText(old.affiliation), plainText(now.affiliation), ctx),
          email: mergeInline(plainText(old.email), plainText(now.email), ctx),
        });
      }
      ia += n;
      ib += n;
    }
  }
  return out;
}

const referenceNodes = (ref: Reference, layout: CitationLayout): RevisionNode[] =>
  formatReferenceAs(ref, layout.style, layout).map((s) => text(s.text, s.italic ? { italic: {} } : {}));

/**
 * In the list order of the version after. The order follows the citations or the citation style, so a
 * reference that only moved isn't a change; it's shown where it is now.
 */
function mergeReferences(beforeList: CitationLayout, afterList: CitationLayout, ctx: Context): ReferenceDiff[] {
  const before = beforeList.entries.map((e) => e.ref);
  const after = afterList.entries.map((e) => e.ref);
  const old = new Map(before.map((r) => [r.id, r]));
  const kept = new Set(after.map((r) => r.id));
  const parts = diffArrays(
    before.map((r) => r.id),
    after.map((r) => r.id)
  );
  const out: ReferenceDiff[] = [];
  let ia = 0;
  let ib = 0;
  let run: number | undefined;
  const whole = (ref: Reference, side: DiffSide) => {
    run ??= ctx.changes++;
    const nodes = referenceNodes(ref, side === "del" ? beforeList : afterList);
    out.push({ id: ref.id, side, text: nodes.map((node) => toDiff(node, side, run)) });
  };
  for (const part of parts) {
    const n = part.count;
    if (part.removed) {
      for (const ref of before.slice(ia, ia + n)) if (!kept.has(ref.id)) whole(ref, "del");
      ia += n;
      continue;
    }
    for (const ref of after.slice(ib, ib + n)) {
      const was = old.get(ref.id);
      if (!was) {
        whole(ref, "ins");
        continue;
      }
      run = undefined;
      // The text can change without the reference changing (APA's 2020a when another 2020 work comes).
      const [then, now] = [referenceNodes(was, beforeList), referenceNodes(ref, afterList)];
      out.push({
        id: ref.id,
        text: canonical(then) === canonical(now) ? now.map((node) => toDiff(node)) : mergeInline(then, now, ctx),
      });
    }
    ib += n;
    if (!part.added) ia += n;
  }
  return out;
}

/** `citations`: the reference list of each version, in the current citation style */
export function diffPaper(
  before: RevisionContent,
  after: RevisionContent,
  citations: { before: CitationLayout; after: CitationLayout }
): PaperDiff {
  const ctx: Context = { changes: 0 };
  // In the order of the paper, so that the changes are numbered from top to bottom
  const title = mergeInline(plainText(before.title), plainText(after.title), ctx);
  const authors = mergeAuthors(before.authors, after.authors, ctx);
  const blocks = mergeBlocks(before.blocks, after.blocks, ctx);
  const references = mergeReferences(citations.before, citations.after, ctx);
  return { title, authors, blocks, references, changes: ctx.changes };
}
