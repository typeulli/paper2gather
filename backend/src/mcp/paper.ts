/**
 * Reading and editing a paper's Y.Doc for the MCP tools. Edits are Yjs transactions on the live
 * document, so connected editors receive them like a collaborator's changes.
 */
import * as Y from "yjs";
import { FIELDS } from "../template.js";
import {
  blockId,
  createNode,
  createText,
  isEmptyParagraph,
  LABEL_PATTERN,
  LABEL_PREFIX,
  NUMBERED_KINDS,
  plainText,
  readElement,
  shortId,
  textType,
  toYElement,
  UserError,
  walk,
  type Marks,
  type ObjectKind,
  type PNode,
  type TextOp,
} from "./content.js";
import { parseInlineMarkdown, parseMarkdown } from "./markdown.js";
import { renderBlock, type RenderContext } from "./render.js";

/** Transaction origin of MCP edits */
export const ORIGIN = "mcp";

// ------------------------------------------------------------------ shared types (frontend lib/paper/types.ts)

export const REF_TYPES = [
  "article",
  "inproceedings",
  "book",
  "incollection",
  "phdthesis",
  "mastersthesis",
  "techreport",
  "misc",
] as const;

export interface Reference {
  id: string;
  key: string;
  type: (typeof REF_TYPES)[number];
  title: string;
  authors: string[];
  year: string;
  venue: string;
  volume: string;
  issue: string;
  pages: string;
  publisher: string;
  doi: string;
  url: string;
  note: string;
  // Added later; older references lack them (frontend lib/paper/references.ts withLaterFields)
  /** "1"–"12" or "" */
  month?: string;
  editors?: string[];
  /** Place of the publisher or the conference */
  address?: string;
  edition?: string;
  series?: string;
  /** "YYYY-MM-DD": when an online source was accessed */
  accessed?: string;
}

export type ReferenceInput = Partial<Omit<Reference, "id">>;

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "4", "04", "Apr" or "April" -> "4" */
function monthOf(value: string): string {
  const v = value.trim().toLowerCase();
  if (!v) return "";
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return String(n);
  const i = v.length >= 3 ? MONTH_NAMES.indexOf(v.slice(0, 3)) : -1;
  if (i < 0) throw new UserError(`Invalid month "${value}": use 1–12 or a month name.`);
  return String(i + 1);
}

function accessedOf(value: string): string {
  const v = value.trim();
  if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UserError(`Invalid accessed date "${value}": use YYYY-MM-DD.`);
  return v;
}

interface Author {
  id: string;
  name: string;
  affiliation: string;
  email: string;
}

export type AuthorInput = Partial<Omit<Author, "id">> & { name: string };

interface CommentMessage {
  id: string;
  author: string;
  color: string;
  text: string;
  createdAt: number;
}

/** Comment author color of MCP clients */
const COMMENT_COLOR = "#7c3aed";

// ------------------------------------------------------------------ numbering (frontend lib/paper/numbering.ts)

const NUMBER_STYLES = [
  "arabic",
  "upper-roman",
  "lower-roman",
  "upper-alpha",
  "lower-alpha",
] as const;
type NumberStyle = (typeof NUMBER_STYLES)[number];

const HEADING_NUMBERINGS = ["decimal", "decimal-period", "ieee", "none"] as const;
type HeadingNumbering = (typeof HEADING_NUMBERINGS)[number];

interface NumberingFormat {
  equation: "global" | "section";
  figure: NumberStyle;
  table: NumberStyle;
  section: HeadingNumbering;
}

function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "";
  for (const [value, numeral] of table) {
    while (n >= value) {
      out += numeral;
      n -= value;
    }
  }
  return out;
}

function toAlpha(n: number): string {
  let out = "";
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function formatNumber(n: number, style: NumberStyle): string {
  if (style === "upper-roman") return toRoman(n);
  if (style === "lower-roman") return toRoman(n).toLowerCase();
  if (style === "upper-alpha") return toAlpha(n);
  if (style === "lower-alpha") return toAlpha(n).toLowerCase();
  return String(n);
}

/** The number references show for a heading (frontend headingNumbers); null if it has none. */
function headingNumber(counts: number[], level: number, appendix: boolean, style: HeadingNumbering): string | null {
  const own = counts.slice(0, level);
  if (appendix) {
    if (style === "none" && level > 1) return null;
    return [formatNumber(own[0], "upper-alpha"), ...own.slice(1)].join(".");
  }
  if (style === "none") return null;
  if (style === "ieee") {
    const [section, subsection, subsubsection] = own;
    return (
      formatNumber(section, "upper-roman") +
      (level >= 2 ? `-${formatNumber(subsection, "upper-alpha")}` : "") +
      (level >= 3 ? String(subsubsection) : "")
    );
  }
  return own.join(".");
}

interface PaperObject {
  id: string;
  label: string;
  kind: ObjectKind;
  /** null for unnumbered equations / headings */
  number: string | null;
  appendix: boolean;
  /** Index of the top-level block it is in */
  block: number;
  node: PNode;
}

/** Same numbers as the editor shows */
function computeObjects(blocks: PNode[], format: NumberingFormat) {
  const objects: PaperObject[] = [];
  const citationCounts = new Map<string, number>();
  const sections = [0, 0, 0];
  let equation = 0;
  let equationInSection = 0;
  let figure = 0;
  let table = 0;
  let appendix = false;
  let appendixLetter = "";
  const prefixAppendix = (n: string) => (appendix ? `${appendixLetter}.${n}` : n);
  const push = (node: PNode, block: number, kind: ObjectKind, number: string | null) => {
    const id = node.attrs.id;
    if (typeof id !== "string" || !id) return;
    const label =
      typeof node.attrs.label === "string" && node.attrs.label
        ? node.attrs.label
        : `${LABEL_PREFIX[kind]}:${id}`;
    objects.push({ id, label, kind, number, appendix, block, node });
  };
  const visit = (node: PNode, block: number): void => {
    switch (node.type) {
      case "appendixBreak":
        if (!appendix) {
          appendix = true;
          sections.fill(0);
          appendixLetter = "A";
          equationInSection = 0;
          figure = 0;
          table = 0;
        }
        return;
      case "heading": {
        const level = Number(node.attrs.level) || 1;
        let number: string | null = null;
        if (node.attrs.numbered !== false && level <= 3) {
          sections[level - 1]++;
          for (let l = level; l < sections.length; l++) sections[l] = 0;
          const top = appendix ? formatNumber(sections[0], "upper-alpha") : String(sections[0]);
          number = headingNumber(sections, level, appendix, format.section);
          if (level === 1 && !(appendix && top === appendixLetter)) {
            equationInSection = 0;
            if (appendix) {
              appendixLetter = top;
              figure = 0;
              table = 0;
            }
          }
        }
        push(node, block, "section", number);
        return;
      }
      case "equation": {
        let number: string | null = null;
        if (node.attrs.numbered !== false) {
          equation++;
          equationInSection++;
          number = appendix
            ? prefixAppendix(String(equationInSection))
            : format.equation === "section"
              ? `${sections[0]}.${equationInSection}`
              : String(equation);
        }
        push(node, block, "equation", number);
        return;
      }
      case "figure":
        push(node, block, "figure", prefixAppendix(formatNumber(++figure, format.figure)));
        return;
      case "tableFigure":
        push(node, block, "table", prefixAppendix(formatNumber(++table, format.table)));
        break;
      case "citation":
        for (const id of String(node.attrs.refs ?? "")
          .split(",")
          .filter(Boolean)) {
          citationCounts.set(id, (citationCounts.get(id) ?? 0) + 1);
        }
        return;
    }
    for (const child of node.content) visit(child, block);
  };
  blocks.forEach((b, i) => visit(b, i));
  return { objects, citationCounts };
}

function describe(o: PaperObject): string {
  switch (o.kind) {
    case "section":
      return o.number ? `${o.appendix ? "Appendix" : "Section"} ${o.number}` : "unnumbered section";
    case "equation":
      return o.number ? `Eq. (${o.number})` : "unnumbered equation";
    case "figure":
      return `Figure ${o.number}`;
    case "table":
      return `Table ${o.number}`;
  }
}

// ------------------------------------------------------------------ text search

interface TextMatch {
  text: Y.XmlText;
  index: number;
  /** Top-level block */
  block: number;
}

const deltaOf = (text: Y.XmlText) =>
  (text.toDelta() as { insert: unknown; attributes?: Marks }[]).filter(
    (op): op is { insert: string; attributes?: Marks } => typeof op.insert === "string"
  );

const stringOf = (text: Y.XmlText) =>
  deltaOf(text)
    .map((op) => op.insert)
    .join("");

/** Formatting at `index` */
function marksAt(text: Y.XmlText, index: number): Marks {
  let offset = 0;
  for (const op of deltaOf(text)) {
    if (index < offset + op.insert.length) return op.attributes ?? {};
    offset += op.insert.length;
  }
  return {};
}

/**
 * Removes a text run left empty next to other inline content. The editor never has one, and its
 * position tracking (y-tiptap) refuses Enter, marks and other edits while the document holds one.
 */
function removeIfEmpty(text: Y.XmlText): void {
  const parent = text.parent as Y.XmlElement;
  if (text.length > 0 || parent.length < 2) return;
  parent.delete(parent.toArray().indexOf(text), 1);
}

/** The text from `from` to the end, with its formatting */
function deltaFrom(text: Y.XmlText, from: number): TextOp[] {
  const out: TextOp[] = [];
  let offset = 0;
  for (const op of deltaOf(text)) {
    const end = offset + op.insert.length;
    if (end > from)
      out.push({
        insert: op.insert.slice(Math.max(0, from - offset)),
        attributes: op.attributes ?? {},
      });
    offset = end;
  }
  return out;
}

function collectTexts(el: Y.XmlElement, out: Y.XmlText[]): Y.XmlText[] {
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) out.push(child);
    else if (child instanceof Y.XmlElement) collectTexts(child, out);
  }
  return out;
}

const unescapeMarkdown = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");

const quote = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s);

// ------------------------------------------------------------------ paper

interface Snapshot {
  elements: Y.XmlElement[];
  blocks: PNode[];
  ids: string[];
  objects: PaperObject[];
  byLabel: Map<string, PaperObject>;
  byId: Map<string, PaperObject>;
  citationCounts: Map<string, number>;
  references: Reference[];
  refById: Map<string, Reference>;
  refByKey: Map<string, Reference>;
}

export type InsertPosition = "start" | "end" | "before" | "after" | "end_of_section";

export class Paper {
  private readonly fragment: Y.XmlFragment;
  private readonly meta: Y.Map<unknown>;
  private readonly authors: Y.Array<Author>;
  private readonly refOrder: Y.Array<string>;
  private readonly refs: Y.Map<Reference>;
  private readonly comments: Y.Map<Y.Map<unknown>>;
  /** Notes for the caller collected while handling a request */
  private warnings: string[] = [];

  constructor(private readonly doc: Y.Doc) {
    this.fragment = doc.getXmlFragment(FIELDS.content);
    this.meta = doc.getMap(FIELDS.meta);
    this.authors = doc.getArray<Author>(FIELDS.authors);
    this.refOrder = doc.getArray<string>(FIELDS.refOrder);
    this.refs = doc.getMap<Reference>(FIELDS.refs);
    this.comments = doc.getMap<Y.Map<unknown>>(FIELDS.comments);
  }

  private transact(fn: () => void): void {
    this.doc.transact(fn, ORIGIN);
  }

  private withWarnings(message: string): string {
    const warnings = this.warnings.splice(0);
    return warnings.length
      ? `${message}\n\nNotes:\n${warnings.map((w) => `- ${w}`).join("\n")}`
      : message;
  }

  // ---------------------------------------------------------------- reading

  private numberingFormat(): NumberingFormat {
    const format = this.doc.getMap<unknown>(FIELDS.format);
    // Papers without a stored format take the numbering mode of their legacy settings.
    const legacy = (this.meta.get("settings") ?? {}) as { equationNumbering?: unknown };
    const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
      allowed.includes(value as T) ? (value as T) : fallback;
    return {
      equation: pick(
        format.get("equation.numbering"),
        ["global", "section"],
        legacy.equationNumbering === "section" ? "section" : "global"
      ),
      figure: pick(format.get("figure.numberStyle"), NUMBER_STYLES, "arabic"),
      table: pick(format.get("table.numberStyle"), NUMBER_STYLES, "arabic"),
      section: pick(format.get("section.numberFormat"), HEADING_NUMBERINGS, "decimal"),
    };
  }

  /** In citation order; same rules as the frontend PaperStore */
  private references(): Reference[] {
    const seen = new Set<string>();
    const list: Reference[] = [];
    for (const id of this.refOrder.toArray()) {
      const ref = this.refs.get(id);
      if (!ref || seen.has(id)) continue;
      seen.add(id);
      list.push(ref);
    }
    this.refs.forEach((ref, id) => {
      if (!seen.has(id)) list.push(ref);
    });
    return list;
  }

  private snapshot(): Snapshot {
    const elements = this.fragment
      .toArray()
      .filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
    const blocks = elements.map(readElement);
    const { objects, citationCounts } = computeObjects(blocks, this.numberingFormat());
    const references = this.references();
    return {
      elements,
      blocks,
      ids: elements.map(blockId),
      objects,
      byLabel: new Map(objects.map((o) => [o.label, o])),
      byId: new Map(objects.map((o) => [o.id, o])),
      citationCounts,
      references,
      refById: new Map(references.map((r) => [r.id, r])),
      refByKey: new Map(references.map((r) => [r.key, r])),
    };
  }

  private renderContext(snap: Snapshot): RenderContext {
    return {
      key: (id) => snap.refById.get(id)?.key || id,
      label: (id) => snap.byId.get(id)?.label ?? null,
    };
  }

  /** "#k3x9a-1f · Eq. (2)" */
  private blockInfo(snap: Snapshot, index: number): string {
    const node = snap.blocks[index];
    const object = snap.objects.find((o) => o.block === index && o.node === node);
    const info = object ? describe(object) : isEmptyParagraph(node) ? "empty paragraph" : "";
    return `#${snap.ids[index]}${info ? ` · ${info}` : ""}`;
  }

  /** Index of the top-level block an anchor (block id or label) points to */
  private blockIndex(snap: Snapshot, anchor: string): number {
    const id = anchor.trim().replace(/^#/, "");
    const index = snap.ids.indexOf(id);
    if (index >= 0) return index;
    const object = snap.byLabel.get(id);
    if (object) return object.block;
    throw new UserError(
      `No block or label ${quote(anchor)}. Block ids (#…) and labels ({#…}) are shown by read_paper; ` +
        "ids change when a block is deleted or retyped, so read the paper again."
    );
  }

  private headingIndex(snap: Snapshot, anchor: string): number {
    const index = this.blockIndex(snap, anchor);
    if (snap.blocks[index].type !== "heading")
      throw new UserError(`${quote(anchor)} is not a heading.`);
    return index;
  }

  /** Index after the last block of the section starting at heading `index` */
  private sectionEnd(snap: Snapshot, index: number): number {
    const level = Number(snap.blocks[index].attrs.level) || 1;
    for (let i = index + 1; i < snap.blocks.length; i++) {
      const b = snap.blocks[i];
      if (
        b.type === "appendixBreak" ||
        (b.type === "heading" && (Number(b.attrs.level) || 1) <= level)
      )
        return i;
    }
    return snap.blocks.length;
  }

  read(
    info: { id: string; updatedAt: string },
    options: { section?: string; outline?: boolean }
  ): string {
    const snap = this.snapshot();
    const title = String(this.meta.get("title") ?? "");
    const authors = this.authors.toArray();
    const threads = this.threads();
    const open = threads.filter((t) => !t.resolved).length;
    const lines = [
      `Title: ${title || "(untitled)"}`,
      `Paper ID: ${info.id} · last saved ${info.updatedAt}`,
      `Authors: ${
        authors.length
          ? authors
              .map(
                (a) =>
                  `${a.name}${[a.affiliation, a.email].some(Boolean) ? ` (${[a.affiliation, a.email].filter(Boolean).join(", ")})` : ""}`
              )
              .join("; ")
          : "(none)"
      }`,
      `References: ${snap.references.length} (list_references) · Comments: ${open} open, ${threads.length - open} resolved (list_comments)`,
    ];

    let from = 0;
    let to = snap.blocks.length;
    if (options.section) {
      from = this.headingIndex(snap, options.section);
      to = this.sectionEnd(snap, from);
      lines.push(
        `Showing the section ${quote(plainText(snap.blocks[from]))}: blocks ${from + 1}–${to} of ${snap.blocks.length}.`
      );
    }

    if (options.outline) {
      lines.push(`Outline (${snap.blocks.length} blocks):`, "");
      for (const o of snap.objects) {
        if (o.block < from || o.block >= to) continue;
        const text =
          o.kind === "section"
            ? `${"#".repeat(Number(o.node.attrs.level) || 1)} ${plainText(o.node)}`
            : o.kind === "equation"
              ? `$$${o.node.attrs.latex}$$`
              : String(o.node.attrs.caption ?? "");
        lines.push(`#${snap.ids[o.block]} · ${describe(o)} {#${o.label}}: ${text}`);
      }
      return lines.join("\n");
    }

    const ctx = this.renderContext(snap);
    const body: string[] = [];
    for (let i = from; i < to; i++)
      body.push(
        `<!-- ${this.blockInfo(snap, i)} -->\n${renderBlock(snap.blocks[i], ctx)}`.trimEnd()
      );
    return `${lines.join("\n")}\n\n${body.join("\n\n")}`;
  }

  // ---------------------------------------------------------------- writing blocks

  private newObjectId(taken: Set<string>): string {
    let id = shortId();
    while (taken.has(id)) id = shortId();
    taken.add(id);
    return id;
  }

  /**
   * Parses markdown into nodes ready to insert: new ids for numbered objects (or the ids of the
   * replaced objects with the same labels, so references to them stay valid), cross references
   * and citations resolved to ids.
   */
  private parse(markdown: string, snap: Snapshot, range?: [number, number]): PNode[] {
    const { nodes, warnings } = parseMarkdown(markdown);
    this.warnings.push(...warnings);
    this.resolveRefs(nodes, snap, range);
    const breaks = (list: PNode[]) => {
      let n = 0;
      walk(list, (node) => node.type === "appendixBreak" && n++);
      return n;
    };
    const kept = snap.blocks.filter((_, i) => !range || i < range[0] || i > range[1]);
    if (breaks(nodes) + breaks(kept) > 1)
      throw new UserError("A paper can have only one \\appendix.");
    return nodes;
  }

  /** `range`: the top-level blocks being replaced */
  private resolveRefs(nodes: PNode[], snap: Snapshot, range?: [number, number]): void {
    const replaced = (o: PaperObject) => !!range && o.block >= range[0] && o.block <= range[1];
    const taken = new Set(snap.objects.map((o) => o.id));
    const reusable = new Map(snap.objects.filter(replaced).map((o) => [o.label, o.id]));
    const kept = new Map(snap.objects.filter((o) => !replaced(o)).map((o) => [o.label, o]));
    const created = new Map<string, string>();

    walk(nodes, (node) => {
      const kind = NUMBERED_KINDS[node.type];
      if (!kind) return;
      let label = node.attrs.label as string | null;
      let id: string;
      if (label) {
        if (created.has(label)) throw new UserError(`The label "${label}" is used twice.`);
        const other = kept.get(label);
        if (other) {
          throw new UserError(
            `The label "${label}" already belongs to ${describe(other)} (#${snap.ids[other.block]}). ` +
              "Use another label, or replace that block."
          );
        }
        id = reusable.get(label) ?? this.newObjectId(taken);
      } else {
        id = this.newObjectId(taken);
        label = `${LABEL_PREFIX[kind]}:${id}`;
      }
      node.attrs.id = id;
      node.attrs.label = label;
      created.set(label, id);
    });

    const objectId = (label: string) => created.get(label) ?? kept.get(label)?.id;
    const keys = () => {
      const all = snap.references.map((r) => r.key).filter(Boolean);
      return all.length
        ? `Known keys: ${all.slice(0, 30).join(", ")}${all.length > 30 ? ", …" : ""}.`
        : "The paper has no references yet.";
    };
    const visit = (list: PNode[]) => {
      for (let i = 0; i < list.length; i++) {
        const node = list[i];
        if (node.type === "crossRef") {
          const label = String(node.attrs.target);
          const id = LABEL_PATTERN.test(label) ? objectId(label) : undefined;
          if (!id) {
            throw new UserError(
              `Unknown label "${label}" in \\ref{${label}}. Labels are shown as {#…} by read_paper` +
                (range ? "; objects removed by this replacement can't be referred to." : ".")
            );
          }
          node.attrs.target = id;
        } else if (node.type === "citation") {
          const names = String(node.attrs.refs).split(",").filter(Boolean);
          const pandoc = node.attrs.pandoc === true;
          delete node.attrs.pandoc;
          // [@eq:energy]: pandoc-crossref style references
          if (pandoc && names.every((n) => !snap.refByKey.has(n) && objectId(n))) {
            const refs = names.flatMap((n, k) => {
              const ref = createNode("crossRef", { target: objectId(n) });
              return k ? [createText(", "), ref] : [ref];
            });
            list.splice(i, 1, ...refs);
            i += refs.length - 1;
            continue;
          }
          node.attrs.refs = names
            .map((name) => {
              const ref = snap.refByKey.get(name) ?? snap.refById.get(name);
              if (!ref) {
                throw new UserError(
                  `Unknown citation key "${name}". ${keys()} Add references with add_references first` +
                    (objectId(name) ? `; to refer to ${name} use \\ref{${name}}.` : ".")
                );
              }
              return ref.id;
            })
            .join(",");
        } else {
          visit(node.content);
        }
      }
    };
    visit(nodes);
  }

  /** Replaces `count` top-level blocks at `index` with `nodes`; returns the new elements. */
  private splice(snap: Snapshot, index: number, count: number, nodes: PNode[]): Y.XmlElement[] {
    const children = this.fragment.toArray();
    const at =
      index < snap.elements.length ? children.indexOf(snap.elements[index]) : children.length;
    const end =
      index + count < snap.elements.length
        ? children.indexOf(snap.elements[index + count])
        : children.length;
    const elements = nodes.map(toYElement);
    this.transact(() => {
      if (end > at) this.fragment.delete(at, end - at);
      if (elements.length) this.fragment.insert(at, elements);
      // The editor's document needs at least one block.
      if (this.fragment.length === 0)
        this.fragment.insert(0, [toYElement(createNode("paragraph"))]);
    });
    return elements;
  }

  private summary(elements: Y.XmlElement[]): string {
    const snap = this.snapshot();
    return elements
      .map((el) => {
        const i = snap.elements.indexOf(el);
        const node = snap.blocks[i];
        const object = snap.objects.find((o) => o.block === i && o.node === node);
        return `#${snap.ids[i]} ${node.type}${object ? ` · ${describe(object)} {#${object.label}}` : ""}`;
      })
      .join("\n");
  }

  /** Warns about cross references to objects that no longer exist */
  private checkDangling(removed: Set<string>): void {
    const snap = this.snapshot();
    const places = new Set<string>();
    snap.blocks.forEach((block, i) =>
      walk([block], (node) => {
        const target = String(node.attrs.target ?? "");
        if (node.type === "crossRef" && removed.has(target) && !snap.byId.has(target))
          places.add(`#${snap.ids[i]}`);
      })
    );
    if (places.size) {
      this.warnings.push(
        `Cross references to removed objects now show "??" in ${[...places].join(", ")}.`
      );
    }
  }

  private removedIds(snap: Snapshot, from: number, to: number): Set<string> {
    return new Set(snap.objects.filter((o) => o.block >= from && o.block <= to).map((o) => o.id));
  }

  insert(markdown: string, position: InsertPosition, anchor?: string): string {
    const snap = this.snapshot();
    const need = () => {
      if (!anchor)
        throw new UserError(`position "${position}" needs an anchor (block id or label).`);
      return anchor;
    };
    let index = snap.blocks.length;
    let clear = 0;
    switch (position) {
      case "start":
        index = 0;
        break;
      case "end":
        // A new blank paper's single empty paragraph is replaced.
        if (snap.blocks.length === 1 && isEmptyParagraph(snap.blocks[0])) [index, clear] = [0, 1];
        break;
      case "before":
        index = this.blockIndex(snap, need());
        break;
      case "after":
        index = this.blockIndex(snap, need()) + 1;
        break;
      case "end_of_section": {
        const heading = this.headingIndex(snap, need());
        index = this.sectionEnd(snap, heading);
        // A section holding only empty paragraphs (as in a new paper) gets the content in their place.
        if (index > heading + 1 && snap.blocks.slice(heading + 1, index).every(isEmptyParagraph)) {
          clear = index - heading - 1;
          index = heading + 1;
        }
        break;
      }
    }
    const nodes = this.parse(markdown, snap);
    if (nodes.length === 0) throw new UserError("The markdown has no content.");
    const elements = this.splice(snap, index, clear, nodes);
    return this.withWarnings(`Inserted ${elements.length} block(s):\n${this.summary(elements)}`);
  }

  replace(from: string, to: string | undefined, markdown: string): string {
    const snap = this.snapshot();
    const a = this.blockIndex(snap, from);
    const b = to ? this.blockIndex(snap, to) : a;
    if (b < a) throw new UserError(`${quote(to ?? "")} comes before ${quote(from)}.`);
    const nodes = this.parse(markdown, snap, [a, b]);
    const removed = this.removedIds(snap, a, b);
    const elements = this.splice(snap, a, b - a + 1, nodes);
    this.checkDangling(removed);
    return this.withWarnings(
      `Replaced ${b - a + 1} block(s) with ${elements.length}:${elements.length ? `\n${this.summary(elements)}` : ""}`
    );
  }

  remove(from: string, to?: string): string {
    const snap = this.snapshot();
    const a = this.blockIndex(snap, from);
    const b = to ? this.blockIndex(snap, to) : a;
    if (b < a) throw new UserError(`${quote(to ?? "")} comes before ${quote(from)}.`);
    const removed = this.removedIds(snap, a, b);
    this.splice(snap, a, b - a + 1, []);
    this.checkDangling(removed);
    return this.withWarnings(`Deleted ${b - a + 1} block(s).`);
  }

  // ---------------------------------------------------------------- writing text

  /**
   * Occurrences of `find` inside single runs of text (inline math, citations and references split
   * runs); `length` is the length of the matched text.
   */
  private findText(
    snap: Snapshot,
    find: string,
    block?: string,
    all = true
  ): { matches: TextMatch[]; length: number } {
    if (!find) throw new UserError("The text to find is empty.");
    const scope = block ? [this.blockIndex(snap, block)] : snap.elements.map((_, i) => i);
    const search = (needle: string) => {
      const matches: TextMatch[] = [];
      for (const i of scope) {
        for (const text of collectTexts(snap.elements[i], [])) {
          const s = stringOf(text);
          for (let at = s.indexOf(needle); at >= 0; at = s.indexOf(needle, at + needle.length)) {
            matches.push({ text, index: at, block: i });
          }
        }
      }
      return matches;
    };
    // Text copied from read_paper may still have markdown escapes (\$, \*).
    let needle = find;
    let matches = search(needle);
    if (matches.length === 0 && unescapeMarkdown(find) !== find)
      matches = search((needle = unescapeMarkdown(find)));
    if (matches.length === 0 || (!all && matches.length > 1)) {
      throw new UserError(
        matches.length
          ? `${quote(find)} occurs ${matches.length} times${block ? " in that block" : ""}; give more surrounding text, a block or all=true.`
          : `${quote(find)} was not found${block ? " in that block" : ""}. Search for plain text as it reads in the ` +
            "paper (no markdown); inline math, citations and references split the text, so it can't span them."
      );
    }
    return { matches, length: needle.length };
  }

  editText(find: string, replacement: string, block?: string, all = false): string {
    const snap = this.snapshot();
    const { matches, length } = this.findText(snap, find, block, all);
    const { nodes, warnings } = parseInlineMarkdown(replacement);
    this.warnings.push(...warnings);
    this.resolveRefs(nodes, snap);
    this.transact(() => {
      // Back to front so earlier matches keep their positions.
      for (const match of [...matches].reverse())
        this.replaceInText(match.text, match.index, length, nodes);
    });
    const blocks = [...new Set(matches.map((m) => `#${snap.ids[m.block]}`))];
    return this.withWarnings(`Replaced ${matches.length} occurrence(s) in ${blocks.join(", ")}.`);
  }

  /** Replaces text keeping the formatting it had (and its comment highlights) for the new text. */
  private replaceInText(
    text: Y.XmlText,
    index: number,
    length: number,
    replacement: PNode[]
  ): void {
    const parent = text.parent as Y.XmlElement;
    const base = marksAt(text, index);
    if (parent.nodeName === "codeBlock") {
      // Code blocks hold plain text only.
      text.delete(index, length);
      text.insert(index, replacement.map(plainText).join(""), {});
      return;
    }
    const marksFor = (node: PNode): Marks => {
      const marks = { ...base, ...node.marks };
      // The code mark excludes all others.
      return marks.code ? { code: {} } : marks;
    };
    if (replacement.every((n) => n.type === "text")) {
      text.delete(index, length);
      let at = index;
      for (const node of replacement) {
        text.insert(at, node.text ?? "", marksFor(node));
        at += (node.text ?? "").length;
      }
      removeIfEmpty(text);
      return;
    }
    // Inline nodes split the text: the start stays, the rest goes into new texts after them.
    const tail = deltaFrom(text, index + length);
    text.delete(index, text.length - index);
    const items: (Y.XmlElement | Y.XmlText)[] = [];
    let run: TextOp[] = [];
    let leading = true;
    let at = index;
    for (const node of replacement) {
      if (node.type === "text") {
        if (leading) {
          text.insert(at, node.text ?? "", marksFor(node));
          at += (node.text ?? "").length;
        } else if (node.text) {
          run.push({ insert: node.text, attributes: marksFor(node) });
        }
        continue;
      }
      leading = false;
      if (run.length) items.push(textType(run));
      run = [];
      items.push(toYElement(node));
    }
    run.push(...tail);
    if (run.length) items.push(textType(run));
    parent.insert(parent.toArray().indexOf(text) + 1, items);
    removeIfEmpty(text);
  }

  // ---------------------------------------------------------------- title & authors

  setInfo(title: string | undefined, authors: AuthorInput[] | undefined): string {
    if (title !== undefined && !title.trim()) throw new UserError("The title can't be empty.");
    this.transact(() => {
      if (title !== undefined) this.meta.set("title", title.trim());
      if (authors) {
        this.authors.delete(0, this.authors.length);
        this.authors.insert(
          0,
          authors.map((a) => ({
            id: shortId(),
            name: a.name.trim(),
            affiliation: a.affiliation ?? "",
            email: a.email ?? "",
          }))
        );
      }
    });
    return [title !== undefined && "Title updated.", authors && `Authors set (${authors.length}).`]
      .filter(Boolean)
      .join(" ");
  }

  // ---------------------------------------------------------------- references

  listReferences(): string {
    const snap = this.snapshot();
    if (snap.references.length === 0) return "The paper has no references.";
    return snap.references
      .map((r, i) => {
        const cited = snap.citationCounts.get(r.id) ?? 0;
        const where = [
          r.editors?.length && `eds. ${r.editors.join("; ")}`,
          r.venue,
          r.series,
          r.edition && `ed. ${r.edition}`,
          r.volume && `vol. ${r.volume}`,
          r.issue && `no. ${r.issue}`,
          r.pages && `pp. ${r.pages}`,
          r.publisher,
          r.address,
        ]
          .filter(Boolean)
          .join(", ");
        const date = `${r.year || "n.d."}${r.month ? `-${r.month.padStart(2, "0")}` : ""}`;
        return [
          `[${i + 1}] ${r.key || "(no key)"} — ${r.authors.join("; ") || "(no authors)"} (${date}). ${r.title}.`,
          where && ` ${where}.`,
          r.doi && ` doi:${r.doi}`,
          r.url && ` ${r.url}`,
          r.accessed && ` (accessed ${r.accessed})`,
          ` [${r.type}; ${cited ? `cited ${cited}×` : "not cited"}]`,
        ]
          .filter(Boolean)
          .join("");
      })
      .join("\n");
  }

  private makeKey(ref: ReferenceInput, taken: Set<string>): string {
    // frontend lib/paper/references.ts makeCitationKey, e.g. "vaswani2017attention"
    const ascii = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const first = ref.authors?.[0] ?? "";
    const last = first.includes(",")
      ? first.split(",")[0]
      : (first.trim().split(/\s+/).pop() ?? "");
    const stop = new Set(["with", "from", "that", "this", "towards", "using", "over"]);
    const word = ascii(ref.title ?? "")
      .split(/[^a-z0-9]+/)
      .find((w) => w.length > 3 && !stop.has(w));
    const base = `${ascii(last).replace(/[^a-z0-9]/g, "") || "ref"}${(ref.year ?? "").replace(/\D/g, "")}${word ?? ""}`;
    let key = base;
    for (let i = 0; taken.has(key); i++)
      key = `${base}${String.fromCharCode(97 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}`;
    return key;
  }

  private checkKey(key: string, taken: Set<string>): void {
    if (!/^[^\s,;{}[\]%#\\]+$/.test(key))
      throw new UserError(`Invalid citation key "${key}": no spaces, commas or braces.`);
    if (taken.has(key)) throw new UserError(`The citation key "${key}" is already used.`);
  }

  private toReference(input: ReferenceInput, base: Reference): Reference {
    const str = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim() : fallback);
    return {
      ...base,
      type: input.type ?? base.type,
      title: str(input.title, base.title),
      authors: input.authors ? input.authors.map((a) => a.trim()).filter(Boolean) : base.authors,
      year: str(input.year, base.year),
      venue: str(input.venue, base.venue),
      volume: str(input.volume, base.volume),
      issue: str(input.issue, base.issue),
      pages: str(input.pages, base.pages),
      publisher: str(input.publisher, base.publisher),
      doi: str(input.doi, base.doi),
      url: str(input.url, base.url),
      note: str(input.note, base.note),
      month: monthOf(str(input.month, base.month ?? "")),
      editors: input.editors ? input.editors.map((a) => a.trim()).filter(Boolean) : (base.editors ?? []),
      address: str(input.address, base.address ?? ""),
      edition: str(input.edition, base.edition ?? ""),
      series: str(input.series, base.series ?? ""),
      accessed: accessedOf(str(input.accessed, base.accessed ?? "")),
    };
  }

  addReferences(inputs: ReferenceInput[]): string {
    const snap = this.snapshot();
    const taken = new Set(snap.references.map((r) => r.key));
    const added: Reference[] = [];
    for (const input of inputs) {
      const key = input.key?.trim() || this.makeKey(input, taken);
      this.checkKey(key, taken);
      taken.add(key);
      const empty: Reference = {
        id: shortId(),
        key,
        type: "article",
        title: "",
        authors: [],
        year: "",
        venue: "",
        volume: "",
        issue: "",
        pages: "",
        publisher: "",
        doi: "",
        url: "",
        note: "",
        month: "",
        editors: [],
        address: "",
        edition: "",
        series: "",
        accessed: "",
      };
      added.push(this.toReference(input, empty));
    }
    this.transact(() => {
      for (const ref of added) this.refs.set(ref.id, ref);
      this.refOrder.push(added.map((r) => r.id));
    });
    return `Added ${added.length} reference(s). Cite them with \\cite{key}: ${added.map((r) => r.key).join(", ")}`;
  }

  private referenceByKey(snap: Snapshot, key: string): Reference {
    const ref = snap.refByKey.get(key);
    if (!ref) throw new UserError(`No reference with the key "${key}". Use list_references.`);
    return ref;
  }

  updateReference(key: string, changes: ReferenceInput): string {
    const snap = this.snapshot();
    const ref = this.referenceByKey(snap, key);
    const next = this.toReference(changes, ref);
    const newKey = changes.key?.trim();
    if (newKey && newKey !== key) {
      this.checkKey(newKey, new Set(snap.references.map((r) => r.key)));
      next.key = newKey;
    }
    this.transact(() => this.refs.set(ref.id, next));
    return `Updated ${next.key}.`;
  }

  deleteReference(key: string): string {
    const snap = this.snapshot();
    const ref = this.referenceByKey(snap, key);
    this.transact(() => {
      this.refs.delete(ref.id);
      const order = this.refOrder.toArray();
      for (let i = order.length - 1; i >= 0; i--)
        if (order[i] === ref.id) this.refOrder.delete(i, 1);
    });
    const cited = snap.citationCounts.get(ref.id) ?? 0;
    if (cited) this.warnings.push(`It was cited ${cited} time(s); those citations now show "?".`);
    return this.withWarnings(`Deleted ${key}.`);
  }

  // ---------------------------------------------------------------- comments

  private threads() {
    const threads: {
      id: string;
      quote: string;
      resolved: boolean;
      createdAt: number;
      messages: CommentMessage[];
    }[] = [];
    this.comments.forEach((thread, id) => {
      const messages = thread.get("messages") as Y.Array<CommentMessage> | undefined;
      threads.push({
        id,
        quote: String(thread.get("quote") ?? ""),
        resolved: Boolean(thread.get("resolved")),
        createdAt: Number(thread.get("createdAt") ?? 0),
        messages: messages?.toArray() ?? [],
      });
    });
    return threads.sort((a, b) => a.createdAt - b.createdAt);
  }

  listComments(includeResolved: boolean): string {
    const snap = this.snapshot();
    // Where each thread's highlight is
    const anchors = new Map<string, string>();
    snap.elements.forEach((el, i) => {
      for (const text of collectTexts(el, [])) {
        for (const op of deltaOf(text)) {
          const threadId = op.attributes?.comment?.threadId;
          if (typeof threadId === "string" && !anchors.has(threadId))
            anchors.set(threadId, `#${snap.ids[i]}`);
        }
      }
    });
    const threads = this.threads().filter((t) => includeResolved || !t.resolved);
    if (threads.length === 0) return includeResolved ? "No comments." : "No open comments.";
    const time = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
    return threads
      .map((t) =>
        [
          `Thread ${t.id} (${t.resolved ? "resolved" : "open"}) on ${anchors.get(t.id) ?? "removed text"}: ${quote(t.quote)}`,
          ...t.messages.map(
            (m) => `  - ${m.author || "Anonymous"} (${time(m.createdAt)}): ${m.text}`
          ),
        ].join("\n")
      )
      .join("\n\n");
  }

  addComment(quoteText: string, message: string, author: string, block?: string): string {
    if (!message.trim()) throw new UserError("The comment text is empty.");
    const snap = this.snapshot();
    const {
      matches: [match],
      length,
    } = this.findText(snap, quoteText, block, false);
    if ((match.text.parent as Y.XmlElement).nodeName === "codeBlock")
      throw new UserError("Code blocks can't have comments.");
    const threadId = shortId(10);
    const now = Date.now();
    this.transact(() => {
      const thread = new Y.Map<unknown>();
      thread.set("quote", stringOf(match.text).slice(match.index, match.index + length));
      thread.set("resolved", false);
      thread.set("createdAt", now);
      const messages = new Y.Array<CommentMessage>();
      messages.push([
        { id: shortId(10), author, color: COMMENT_COLOR, text: message.trim(), createdAt: now },
      ]);
      thread.set("messages", messages);
      this.comments.set(threadId, thread);
      match.text.format(match.index, length, { comment: { threadId } });
    });
    return `Added comment thread ${threadId} on #${snap.ids[match.block]}.`;
  }

  private thread(threadId: string): Y.Map<unknown> {
    const thread = this.comments.get(threadId);
    if (!thread) throw new UserError(`No comment thread "${threadId}". Use list_comments.`);
    return thread;
  }

  reply(threadId: string, message: string, author: string): string {
    if (!message.trim()) throw new UserError("The reply is empty.");
    const messages = this.thread(threadId).get("messages") as Y.Array<CommentMessage> | undefined;
    if (!messages) throw new UserError(`The thread "${threadId}" can't take replies.`);
    this.transact(() =>
      messages.push([
        {
          id: shortId(10),
          author,
          color: COMMENT_COLOR,
          text: message.trim(),
          createdAt: Date.now(),
        },
      ])
    );
    return `Replied to ${threadId}.`;
  }

  setResolved(threadId: string, resolved: boolean): string {
    const thread = this.thread(threadId);
    this.transact(() => thread.set("resolved", resolved));
    return `${threadId} is ${resolved ? "resolved" : "open again"}.`;
  }
}
