import type { JSONContent } from "@tiptap/core";
import { TABLE_CELL_MIN_WIDTH } from "@/components/editor/extensions/table-layout";
import { shortId } from "@/lib/ids";
import { defaultLabel } from "@/lib/paper/numbering";
import { PAGE_TEXT_WIDTH } from "@/lib/paper/page";
import { hwpEquationToLatex } from "./equation";
import {
  descendants,
  element,
  elements,
  intAttr,
  type CharShape,
  type HwpxPackage,
  type ParaShape,
  type StyleDef,
} from "./package";

/** HWPUNIT (1/7200 inch) per CSS px */
const HWPUNIT_PER_PX = 75;

export type HwpxWarning = "image" | "object";

export interface HwpxImage {
  /** Figure node whose src is filled in once the image is uploaded */
  node: JSONContent;
  data: Uint8Array;
  mediaType: string;
  name: string;
}

export interface HwpxConversion {
  /** Paper title, if the document marks one (title style or a large centered first line) */
  title: string | null;
  doc: JSONContent;
  images: HwpxImage[];
  /** Equation and inline math nodes, to check that their LaTeX renders */
  equations: JSONContent[];
  /** Footnotes and endnotes moved to the closing "각주" section */
  notes: number;
  warnings: Map<HwpxWarning, number>;
}

interface Context {
  /** Inside a table cell, note or caption: no headings, display equations or numbered tables */
  nested: boolean;
}

interface BlockMeta {
  text: string;
  /** Largest character height (1/100 pt) */
  size: number;
  list?: "bulletList" | "orderedList";
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

const UNNUMBERED_HEADING =
  /^(?:abstract|요\s*약|초\s*록|(?:국문|영문)\s*(?:요약|초록)|참\s*고\s*문\s*헌|references?|bibliography|acknowledge?ments?|감사의\s*글|사\s*사|부\s*록|appendix|각\s*주)$/i;

const CAPTION_LABELS = { table: "표|table|tab\\.?", figure: "그림|figure|fig\\.?" };

/**
 * Removes a leading "표 1." / "Figure 2:" label from caption text. Returns null when the text does
 * not start with such a label (a label needs a number or a separator after it).
 */
export function stripCaptionLabel(text: string, kind: "table" | "figure"): string | null {
  const re = new RegExp(
    `^\\s*[<\\[]?(?:${CAPTION_LABELS[kind]})\\s*(?:(?:\\d+(?:[.\\-]\\d+)*|[ivxlc]+(?=[\\s.:：)\\]>]|$))\\s*[>\\])]?\\s*[.:：\\-–—]?|[.:：])\\s*`,
    "i"
  );
  const m = re.exec(text);
  return m ? text.slice(m[0].length).trim() : null;
}

function sameMarks(a: JSONContent["marks"], b: JSONContent["marks"]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function plainText(inline: JSONContent[]): string {
  return inline
    .map((n) => (n.type === "text" ? n.text : n.type === "mathInline" ? n.attrs?.latex : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drops whitespace and line breaks at both ends. */
function trimInline(inline: JSONContent[]): JSONContent[] {
  const result = [...inline];
  for (const [index, re] of [
    [0, /^\s+/],
    [-1, /\s+$/],
  ] as const) {
    while (result.length) {
      const node = result.at(index)!;
      if (node.type === "hardBreak") {
        result.splice(index, 1);
        continue;
      }
      if (node.type !== "text") break;
      const text = node.text!.replace(re, "");
      if (text) {
        result.splice(index < 0 ? result.length - 1 : 0, 1, { ...node, text });
        break;
      }
      result.splice(index, 1);
    }
  }
  return result;
}

/** Target of a HYPERLINK field: the Command parameter up to the first unescaped ";". */
function hyperlinkTarget(field: Element): string | null {
  const command = descendants(field, "stringParam").find((el) => el.getAttribute("name") === "Command");
  const raw = command?.textContent ?? "";
  let url = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\" && i + 1 < raw.length) url += raw[++i];
    else if (raw[i] === ";") break;
    else url += raw[i];
  }
  url = url.trim();
  if (/^www\./i.test(url)) url = `https://${url}`;
  return /^(?:https?:|mailto:)/i.test(url) ? url : null;
}

class Converter {
  private readonly meta = new WeakMap<JSONContent, BlockMeta>();
  private readonly lists = new WeakSet<JSONContent>();
  private readonly notes: JSONContent[][] = [];
  /** Character counts per character height, to find the body text size */
  private readonly sizes = new Map<number, number>();
  private link: { href: string; field: string } | null = null;
  /** Width of the text area of one column (HWPUNIT) */
  private pageTextWidth = PAGE_TEXT_WIDTH * HWPUNIT_PER_PX;
  private columns = 1;
  private columnGap = 0;

  private title: string | null = null;
  private readonly images: HwpxImage[] = [];
  private readonly equations: JSONContent[] = [];
  private readonly warnings = new Map<HwpxWarning, number>();

  constructor(private readonly pkg: HwpxPackage) {}

  run(): HwpxConversion {
    const content: JSONContent[] = [];
    for (const section of this.pkg.sections) {
      content.push(...this.blocks(elements(section.documentElement, "p"), { nested: false }));
    }
    this.findTitle(content);
    if (this.notes.length) {
      const id = shortId();
      content.push(
        {
          type: "heading",
          attrs: { level: 1, id, label: defaultLabel("section", id), numbered: false },
          content: [{ type: "text", text: "각주" }],
        },
        ...this.notes.map((note, i) => ({
          type: "paragraph",
          content: [{ type: "text", text: `${i + 1}) ` }, ...note],
        }))
      );
    }
    if (content.length === 0) content.push({ type: "paragraph" });
    return {
      title: this.title,
      doc: { type: "doc", content },
      images: this.images,
      equations: this.equations,
      notes: this.notes.length,
      warnings: this.warnings,
    };
  }

  private warn(kind: HwpxWarning) {
    this.warnings.set(kind, (this.warnings.get(kind) ?? 0) + 1);
  }

  private columnWidth(): number {
    return Math.max(1, (this.pageTextWidth - this.columnGap * (this.columns - 1)) / this.columns);
  }

  private blocks(paragraphs: Element[], ctx: Context): JSONContent[] {
    const blocks = paragraphs.flatMap((p) => this.paragraph(p, ctx));
    if (!ctx.nested) this.attachManualCaptions(blocks);
    return this.groupLists(blocks);
  }

  private paragraph(p: Element, ctx: Context): JSONContent[] {
    const { charShapes, paraShapes, styles } = this.pkg.header;
    const para = paraShapes.get(p.getAttribute("paraPrIDRef") ?? "");
    const style = styles.get(p.getAttribute("styleIDRef") ?? "");
    const out: JSONContent[] = [];
    // Nested paragraphs (cells, notes, captions) must not end a link of the paragraph around them.
    const outerLink = this.link;
    let inline: JSONContent[] = [];
    let size = 0;
    const flush = () => {
      const block = this.textBlock(inline, para, style, size, ctx);
      if (block) out.push(block);
      inline = [];
      size = 0;
    };

    for (const run of elements(p, "run")) {
      const shape = charShapes.get(run.getAttribute("charPrIDRef") ?? "");
      const marks = this.marks(shape);
      for (const child of elements(run)) {
        switch (child.localName) {
          case "t": {
            const length = this.text(child, marks, inline);
            if (length && shape) {
              size = Math.max(size, shape.height);
              this.sizes.set(shape.height, (this.sizes.get(shape.height) ?? 0) + length);
            }
            break;
          }
          case "ctrl":
            this.control(child, marks, inline);
            break;
          case "secPr":
            this.pageDefinition(child);
            break;
          case "equation": {
            const node = this.inlineEquation(child);
            if (node) inline.push(node);
            break;
          }
          case "tbl": {
            flush();
            const table = this.table(child, ctx);
            if (table) out.push(table);
            break;
          }
          case "pic":
            flush();
            out.push(this.picture(child));
            break;
          case "container":
            flush();
            out.push(...this.container(child, ctx));
            break;
          case "ole":
          case "chart":
          case "video":
            this.warn("object");
            break;
          default:
            // Text boxes: shapes (rect, ellipse, ...) with a drawText
            if (element(child, "drawText")) {
              flush();
              out.push(...this.drawText(child, ctx));
            }
        }
      }
    }
    flush();
    this.link = outerLink;
    return out;
  }

  private marks(shape: CharShape | undefined): NonNullable<JSONContent["marks"]> {
    if (!shape) return [];
    const marks: NonNullable<JSONContent["marks"]> = [];
    if (shape.bold) marks.push({ type: "bold" });
    if (shape.italic) marks.push({ type: "italic" });
    if (shape.underline) marks.push({ type: "underline" });
    if (shape.strike) marks.push({ type: "strike" });
    if (shape.superscript) marks.push({ type: "superscript" });
    else if (shape.subscript) marks.push({ type: "subscript" });
    if (shape.color) marks.push({ type: "textStyle", attrs: { color: shape.color } });
    return marks;
  }

  private pushText(inline: JSONContent[], raw: string, marks: NonNullable<JSONContent["marks"]>): number {
    // HWP text may carry control characters
    const text = raw.replace(/[\t\n\r]/g, " ").replace(/[\u0000-\u001f]/g, "");
    if (!text) return 0;
    const all = this.link ? [...marks, { type: "link", attrs: { href: this.link.href } }] : marks;
    const last = inline.at(-1);
    if (last?.type === "text" && sameMarks(last.marks, all)) last.text += text;
    else inline.push(all.length ? { type: "text", text, marks: all } : { type: "text", text });
    return text.length;
  }

  /** Appends the content of an hp:t element; returns the number of characters added. */
  private text(t: Element, marks: NonNullable<JSONContent["marks"]>, inline: JSONContent[]): number {
    let length = 0;
    for (let node = t.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3 || node.nodeType === 4) {
        length += this.pushText(inline, node.nodeValue ?? "", marks);
        continue;
      }
      if (node.nodeType !== 1) continue;
      switch ((node as Element).localName) {
        case "lineBreak":
          inline.push({ type: "hardBreak" });
          break;
        case "tab":
        case "fwSpace":
          length += this.pushText(inline, " ", marks);
          break;
        case "nbSpace":
          length += this.pushText(inline, " ", marks);
          break;
        case "hyphen":
          length += this.pushText(inline, "-", marks);
          break;
      }
    }
    return length;
  }

  private control(ctrl: Element, marks: NonNullable<JSONContent["marks"]>, inline: JSONContent[]) {
    for (const el of elements(ctrl)) {
      switch (el.localName) {
        case "colPr":
          this.columns = Math.max(1, intAttr(el, "colCount", 1));
          this.columnGap = intAttr(el, "sameGap");
          break;
        case "fieldBegin": {
          const href = el.getAttribute("type") === "HYPERLINK" ? hyperlinkTarget(el) : null;
          if (href) this.link = { href, field: el.getAttribute("id") ?? "" };
          break;
        }
        case "fieldEnd":
          if (this.link && el.getAttribute("beginIDRef") === this.link.field) this.link = null;
          break;
        case "footNote":
        case "endNote":
          this.note(el, marks, inline);
          break;
        case "autoNum":
          // Numbers of notes are written by the notes section; others (e.g. in captions) are kept.
          if (!/NOTE$/.test(el.getAttribute("numType") ?? "")) this.pushText(inline, el.getAttribute("num") ?? "", marks);
          break;
      }
    }
  }

  private note(el: Element, marks: NonNullable<JSONContent["marks"]>, inline: JSONContent[]) {
    const content: JSONContent[] = [];
    for (const p of elements(element(el, "subList") ?? el, "p")) {
      for (const block of this.paragraph(p, { nested: true })) {
        if (!block.content?.length) continue;
        if (content.length) content.push({ type: "text", text: " " });
        content.push(...block.content);
      }
    }
    const number = this.notes.push(trimInline(content));
    const noteMarks = [...marks.filter((m) => m.type !== "subscript" && m.type !== "superscript"), { type: "superscript" }];
    this.pushText(inline, String(number), noteMarks);
  }

  private pageDefinition(secPr: Element) {
    const page = element(secPr, "pagePr");
    const margin = page && element(page, "margin");
    if (!page || !margin) return;
    const width = page.getAttribute("landscape") === "NARROWLY" ? intAttr(page, "height") : intAttr(page, "width");
    const text = width - intAttr(margin, "left") - intAttr(margin, "right") - intAttr(margin, "gutter");
    if (text > 0) this.pageTextWidth = text;
  }

  private inlineEquation(eq: Element): JSONContent | null {
    const latex = hwpEquationToLatex(element(eq, "script")?.textContent ?? "");
    if (!latex) return null;
    const node = { type: "mathInline", attrs: { latex } };
    this.equations.push(node);
    return node;
  }

  /** A paragraph holding only one equation (and maybe its "(1)" number) becomes a display equation. */
  private displayEquation(inline: JSONContent[]): JSONContent | null {
    const math = inline.filter((n) => n.type === "mathInline");
    if (math.length !== 1) return null;
    const rest = inline
      .filter((n) => n !== math[0])
      .map((n) => (n.type === "text" ? n.text : n.type === "hardBreak" ? " " : "\u0001"))
      .join("");
    const m = /^\s*(?:\(\s*(\d+(?:[.-]\d+)*[a-z]?)\s*\))?\s*$/.exec(rest);
    if (!m) return null;
    const id = shortId();
    const node = {
      type: "equation",
      attrs: { id, label: defaultLabel("equation", id), latex: math[0].attrs!.latex, numbered: m[1] !== undefined },
    };
    this.equations.splice(this.equations.indexOf(math[0]), 1, node);
    return node;
  }

  private headingLevel(para: ParaShape | undefined, style: StyleDef | undefined, text: string): number | null {
    if (text.length > 100) return null;
    if (para?.headingType === "OUTLINE") return para.headingLevel < 3 ? para.headingLevel + 1 : null;
    for (const name of [style?.name ?? "", style?.engName ?? ""].map((n) => n.trim())) {
      const m = /^(?:개요|outline|제목|heading)\s*([1-9])$/i.exec(name);
      if (m) return Number(m[1]) <= 3 ? Number(m[1]) : null;
      if (/^장\s*제목$/.test(name)) return 1;
      if (/^절\s*제목$/.test(name)) return 2;
      if (/^항\s*제목$/.test(name)) return 3;
    }
    return null;
  }

  private textBlock(
    raw: JSONContent[],
    para: ParaShape | undefined,
    style: StyleDef | undefined,
    size: number,
    ctx: Context
  ): JSONContent | null {
    const inline = trimInline(raw);
    if (inline.length === 0) return null;
    const text = plainText(inline);
    const align = para?.align === "center" || para?.align === "right" ? para.align : null;
    if (!ctx.nested) {
      const equation = this.displayEquation(inline);
      if (equation) return equation;
      const styleNames = [style?.name ?? "", style?.engName ?? ""].map((n) => n.trim());
      if (this.title === null && styleNames.some((n) => /^(?:논문\s*)?제목$|^title$/i.test(n))) {
        this.title = text;
        return null;
      }
      const level = this.headingLevel(para, style, text);
      if (level) {
        const id = shortId();
        return {
          type: "heading",
          attrs: {
            level,
            id,
            label: defaultLabel("section", id),
            numbered: !UNNUMBERED_HEADING.test(text.replace(/[.:]\s*$/, "")),
            ...(align && { textAlign: align }),
          },
          content: inline,
        };
      }
    }
    const block: JSONContent = { type: "paragraph", content: inline };
    if (align) block.attrs = { textAlign: align };
    const list =
      para?.headingType === "BULLET" ? "bulletList" : para?.headingType === "NUMBER" ? "orderedList" : undefined;
    this.meta.set(block, { text, size, list });
    return block;
  }

  private table(tbl: Element, ctx: Context): JSONContent | null {
    const cells = elements(tbl, "tr").map((tr) =>
      elements(tr, "tc").map((tc) => {
        const span = element(tc, "cellSpan");
        return {
          tc,
          col: intAttr(element(tc, "cellAddr"), "colAddr"),
          colSpan: Math.max(1, intAttr(span, "colSpan", 1)),
          rowSpan: Math.max(1, intAttr(span, "rowSpan", 1)),
          width: intAttr(element(tc, "cellSz"), "width"),
          header: tc.getAttribute("header") === "1",
        };
      })
    );
    const all = cells.flat();
    if (all.length === 0) return null;
    const colCount = Math.max(intAttr(tbl, "colCnt"), ...all.map((c) => c.col + c.colSpan));

    // Column widths from single-column cells; columns only covered by spanning cells share the rest.
    const widths: (number | null)[] = Array.from({ length: colCount }, () => null);
    for (const c of all) if (c.colSpan === 1 && c.width > 0 && widths[c.col] === null) widths[c.col] = c.width;
    for (const c of all) {
      const range = widths.slice(c.col, c.col + c.colSpan);
      const unknown = range.filter((w) => w === null).length;
      if (unknown === 0) continue;
      const each = (c.width - range.reduce<number>((sum, w) => sum + (w ?? 0), 0)) / unknown;
      if (each <= 0) continue;
      for (let i = c.col; i < c.col + c.colSpan; i++) widths[i] ??= each;
    }
    const scale = PAGE_TEXT_WIDTH / this.columnWidth();
    const px = widths.map((w) => (w ? Math.max(TABLE_CELL_MIN_WIDTH, Math.round(w * scale)) : null));

    // Without marked header cells, a table of several rows gets its first row as the header.
    const markedHeader = all.some((c) => c.header);
    const rows = cells
      .map((row, r) => ({
        type: "tableRow",
        content: row.map((c) => {
          const header = markedHeader ? c.header : r === 0 && cells.length > 1;
          const colwidth = px.slice(c.col, c.col + c.colSpan);
          const content = this.blocks(elements(element(c.tc, "subList") ?? c.tc, "p"), { nested: true });
          return {
            type: header ? "tableHeader" : "tableCell",
            attrs: {
              colspan: c.colSpan,
              rowspan: c.rowSpan,
              colwidth: colwidth.length === c.colSpan && colwidth.every(Boolean) ? colwidth : null,
            },
            content: content.length ? content : [{ type: "paragraph" }],
          };
        }),
      }))
      .filter((row) => row.content.length > 0);

    const table = { type: "table", content: rows };
    if (ctx.nested) return table;
    const id = shortId();
    return {
      type: "tableFigure",
      attrs: { id, label: defaultLabel("table", id), caption: this.caption(tbl, "table") },
      content: [table],
    };
  }

  private picture(pic: Element): JSONContent {
    const id = shortId();
    const width = intAttr(element(pic, "sz"), "width") || intAttr(element(pic, "curSz"), "width");
    const percent = width ? Math.min(100, Math.max(10, Math.round(((width / this.columnWidth()) * 100) / 5) * 5)) : 75;
    const node: JSONContent = {
      type: "figure",
      attrs: { id, label: defaultLabel("figure", id), src: "", caption: this.caption(pic, "figure"), width: percent },
    };
    const ref = descendants(pic, "img")[0]?.getAttribute("binaryItemIDRef") ?? "";
    const item = this.pkg.binaries.get(ref);
    const data = item && this.pkg.files[item.path];
    const ext = item?.path.split(".").pop()?.toLowerCase() ?? "";
    if (item && data) {
      this.images.push({
        node,
        data,
        mediaType: IMAGE_TYPES[ext] ?? item.mediaType,
        name: item.path.split("/").pop() ?? item.path,
      });
    } else {
      this.warn("image");
    }
    return node;
  }

  private container(el: Element, ctx: Context): JSONContent[] {
    return elements(el).flatMap((child) => {
      if (child.localName === "pic") return [this.picture(child)];
      if (child.localName === "container") return this.container(child, ctx);
      return element(child, "drawText") ? this.drawText(child, ctx) : [];
    });
  }

  private drawText(shape: Element, ctx: Context): JSONContent[] {
    const drawText = element(shape, "drawText")!;
    return this.blocks(elements(element(drawText, "subList") ?? drawText, "p"), ctx);
  }

  private caption(el: Element, kind: "table" | "figure"): string {
    const caption = element(el, "caption");
    if (!caption) return "";
    const text = elements(element(caption, "subList") ?? caption, "p")
      .flatMap((p) => this.paragraph(p, { nested: true }))
      .map((block) => plainText(block.content ?? []))
      .join(" ");
    return stripCaptionLabel(text, kind) ?? text;
  }

  /** Captions typed as ordinary paragraphs ("표 1. ..." above a table, "그림 1. ..." below a figure). */
  private attachManualCaptions(blocks: JSONContent[]) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const kind = block.type === "tableFigure" ? "table" : block.type === "figure" ? "figure" : null;
      if (!kind || block.attrs?.caption) continue;
      const candidates = kind === "table" ? [i - 1, i + 1] : [i + 1, i - 1];
      for (const j of candidates) {
        const meta = blocks[j] && this.meta.get(blocks[j]);
        const caption = meta && meta.text.length <= 300 ? stripCaptionLabel(meta.text, kind) : null;
        if (caption === null) continue;
        block.attrs = { ...block.attrs, caption };
        blocks.splice(j, 1);
        if (j < i) i--;
        break;
      }
    }
  }

  private groupLists(blocks: JSONContent[]): JSONContent[] {
    const result: JSONContent[] = [];
    for (const block of blocks) {
      const list = this.meta.get(block)?.list;
      if (!list) {
        result.push(block);
        continue;
      }
      const last = result.at(-1);
      const item = { type: "listItem", content: [block] };
      if (last?.type === list && this.lists.has(last)) {
        last.content!.push(item);
      } else {
        const node = { type: list, content: [item] };
        this.lists.add(node);
        result.push(node);
      }
    }
    return result;
  }

  /** Without a title style, a large centered paragraph before the first heading is the title. */
  private findTitle(content: JSONContent[]) {
    if (this.title !== null) return;
    const bodySize = [...this.sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1000;
    let best = -1;
    for (let i = 0; i < Math.min(content.length, 5); i++) {
      const block = content[i];
      if (block.type === "heading") break;
      const meta = this.meta.get(block);
      if (
        block.type === "paragraph" &&
        block.attrs?.textAlign === "center" &&
        meta &&
        meta.text.length <= 200 &&
        meta.size >= bodySize * 1.3 &&
        (best < 0 || meta.size > this.meta.get(content[best])!.size)
      ) {
        best = i;
      }
    }
    if (best < 0) return;
    this.title = this.meta.get(content[best])!.text;
    content.splice(best, 1);
  }
}

export function convertHwpx(pkg: HwpxPackage): HwpxConversion {
  return new Converter(pkg).run();
}
