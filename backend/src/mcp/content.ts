/**
 * The paper content as the TipTap editor keeps it in Yjs (y-prosemirror encoding): one Y.XmlElement
 * per node (name = node type, attributes = node attributes) and a Y.XmlText per run of text, with the
 * marks as text formatting ({ bold: {}, link: { href, … } }).
 *
 * The server has no ProseMirror schema. It writes only the node types below, in shapes the editor
 * schema accepts: content the editor cannot read keeps it from showing the document at all.
 * Must stay in sync with buildPaperSchema in frontend/src/components/editor/extensions/index.ts.
 */
import { randomInt } from "node:crypto";
import * as Y from "yjs";

/** A mistake in the request (unknown block, bad markdown …); its message is meant for the caller. */
export class UserError extends Error {}

export type Marks = Record<string, Record<string, unknown>>;

/** A ProseMirror-like node, read from or written to Yjs. */
export interface PNode {
  type: string;
  attrs: Record<string, unknown>;
  content: PNode[];
  /** Text nodes only */
  text?: string;
  marks?: Marks;
}

export type ObjectKind = "section" | "equation" | "figure" | "table";

/** Node types the editor numbers (frontend lib/paper/numbering.ts) */
export const NUMBERED_KINDS: Record<string, ObjectKind> = {
  heading: "section",
  equation: "equation",
  figure: "figure",
  tableFigure: "table",
};

export const LABEL_PREFIX: Record<ObjectKind, string> = {
  section: "sec",
  equation: "eq",
  figure: "fig",
  table: "tab",
};

/** Labels the editor accepts (frontend nodes/shared.ts), non-empty */
export const LABEL_PATTERN = /^[a-zA-Z0-9:_\-.]+$/;

/** Attributes of each node type with the editor's defaults; null = unset (y-prosemirror doesn't store it). */
const NODE_ATTRS: Record<string, Record<string, unknown>> = {
  paragraph: { textAlign: null },
  heading: { textAlign: null, level: 1, id: null, label: null, numbered: true },
  blockquote: {},
  bulletList: {},
  orderedList: { start: 1, type: null },
  listItem: {},
  codeBlock: { language: null },
  horizontalRule: {},
  hardBreak: {},
  table: {},
  tableRow: { height: null },
  tableHeader: { colspan: 1, rowspan: 1, colwidth: null, align: null },
  tableCell: { colspan: 1, rowspan: 1, colwidth: null, align: null },
  tableFigure: { id: null, label: null, caption: "" },
  figure: {
    id: null,
    label: null,
    src: "",
    caption: "",
    width: 75,
    tikz: null,
    tikzLibraries: "",
    tikzPackages: "",
  },
  equation: { id: null, label: null, latex: "", numbered: true },
  mathInline: { latex: "" },
  citation: { refs: "", mode: "paren", locator: "" },
  crossRef: { target: "" },
  appendixBreak: {},
};

/** Link mark attributes besides href (TipTap Link defaults) */
export const LINK_DEFAULTS = {
  target: "_blank",
  rel: "noopener noreferrer nofollow",
  class: null,
  title: null,
};

export function createNode(
  type: string,
  attrs: Record<string, unknown> = {},
  content: PNode[] = []
): PNode {
  return { type, attrs: { ...NODE_ATTRS[type], ...attrs }, content };
}

export function createText(text: string, marks: Marks = {}): PNode {
  return { type: "text", attrs: {}, content: [], text, marks };
}

/** y-prosemirror stores overlapping marks as "name--hash" (this schema has none). */
const markName = (key: string) => key.replace(/--[a-zA-Z0-9+/=]{8}$/, "");

export function readElement(el: Y.XmlElement): PNode {
  const content: PNode[] = [];
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as { insert: unknown; attributes?: Marks }[]) {
        if (typeof op.insert !== "string" || !op.insert) continue;
        const marks: Marks = {};
        for (const [key, value] of Object.entries(op.attributes ?? {}))
          marks[markName(key)] = value ?? {};
        content.push(createText(op.insert, marks));
      }
    } else if (child instanceof Y.XmlElement) {
      content.push(readElement(child));
    }
  }
  return {
    type: el.nodeName,
    attrs: { ...NODE_ATTRS[el.nodeName], ...el.getAttributes() },
    content,
  };
}

/** The Yjs type the editor would create for `node` (y-prosemirror createTypeFromElementNode). */
export function toYElement(node: PNode): Y.XmlElement {
  // Fragment children are typed with string attributes only; Yjs stores any JSON value.
  const el = new Y.XmlElement<Record<string, any>>(node.type);
  for (const key of Object.keys(NODE_ATTRS[node.type] ?? {})) {
    const value = node.attrs[key];
    if (value !== null && value !== undefined) el.setAttribute(key, value);
  }
  const children: (Y.XmlElement | Y.XmlText)[] = [];
  let run: PNode[] = [];
  const endRun = () => {
    if (run.length === 0) return;
    children.push(textType(run.map((t) => ({ insert: t.text ?? "", attributes: t.marks ?? {} }))));
    run = [];
  };
  for (const child of node.content) {
    if (child.type !== "text") {
      endRun();
      children.push(toYElement(child));
    } else if (child.text) {
      run.push(child);
    }
  }
  endRun();
  if (children.length > 0) el.insert(0, children);
  return el as unknown as Y.XmlElement;
}

export interface TextOp {
  insert: string;
  attributes: Marks;
}

export function textType(delta: TextOp[]): Y.XmlText {
  const text = new Y.XmlText();
  text.applyDelta(delta, { sanitize: false });
  return text;
}

/** Stable handle of a block: the id of its Yjs item, kept while the block is edited in place. */
export function blockId(el: Y.XmlElement): string {
  const id = el._item?.id;
  return id ? `${id.client.toString(36)}-${id.clock.toString(36)}` : "";
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Same format as the editor's ids (frontend lib/ids.ts) */
export function shortId(length = 8): string {
  let id = "";
  for (let i = 0; i < length; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

/** Calls `fn` for every node below `nodes`, parents first. */
export function walk(nodes: PNode[], fn: (node: PNode) => void): void {
  for (const node of nodes) {
    fn(node);
    walk(node.content, fn);
  }
}

/** Plain text of a node, with inline math as $…$ */
export function plainText(node: PNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "mathInline") return `$${node.attrs.latex}$`;
  return node.content.map(plainText).join("");
}

export function isEmptyParagraph(node: PNode): boolean {
  return node.type === "paragraph" && node.content.length === 0;
}
