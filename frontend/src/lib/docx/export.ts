/**
 * Converts a paper to a Word file (.docx). Numbers (sections, equations, figures, tables, references to them) are
 * fixed text, the same as in the editor, and references to them link to what they refer to. Comments become Word
 * comments: resolved threads are marked as resolved, and threads whose text is gone are left out.
 */
import type { JSONContent } from "@tiptap/core";
import { splitInlineMath } from "@/lib/editor-utils";
import {
  columnWidths,
  equationKey,
  layoutTable,
  progressReport,
  workOf,
  type EquationRequest,
  type ExportImage,
  type HwpxAssets,
  type ProgressReport,
} from "@/lib/hwpx/export";
import { HWPUNIT_PER_PT } from "@/lib/hwpx/owpml";
import {
  captionLabelText,
  equationNumberText,
  isColor,
  isKoreanFontKey,
  isLatinFontKey,
  isTextAlign,
  KOREAN_FONTS,
  LATIN_FONTS,
  referenceText,
  type FloatFormat,
  type PaperFormat,
  type StyleKey,
  type TextStyleDef,
} from "@/lib/paper/format";
import type { NumberedObject } from "@/lib/paper/numbering";
import { citationText, entryLabel, formatReferenceAs, isAuthorDate, type CitationLayout } from "@/lib/paper/citations";
import { parseRefIds } from "@/lib/paper/references";
import type { Author, CommentThread } from "@/lib/paper/types";
import type { TikzSource } from "@/lib/tikz/options";
import { initialsOf } from "@/lib/user";
import { latexToOmml, type OmmlStyle } from "./omml";
import {
  buildPackage,
  commentParts,
  inlinePicture,
  MARK,
  NumberingBuilder,
  paraProps,
  pageBox,
  paraPropsContent,
  runProps,
  spacingAfter,
  stylesXml,
  textRun,
  twips,
  type Border,
  type Borders,
  type CommentEntry,
  type PackageLink,
  type PackageMedia,
  type PageBox,
  type ParaAlign,
  type RunFormat,
  type StyleDef,
  type Tab,
} from "./ooxml";

export type DocxEquationMode = "native" | "image";

export interface DocxExportInput {
  content: JSONContent;
  title: string;
  authors: Author[];
  /** The reference list and what citations show */
  citations: CitationLayout;
  format: PaperFormat;
  objectsById: Map<string, NumberedObject>;
  comments: CommentThread[];
  /** How equations are written: as Word equations (editable) or as images (looking as in the editor) */
  equations: DocxEquationMode;
}

/** Rendering and downloading, which need a browser: the same as for HWPX */
export type DocxAssets = HwpxAssets;

/** Where a writer takes its images from: the formulas are ready by then. */
type WriterAssets = Pick<DocxAssets, "figureImage" | "tikzImage"> & {
  equationImage(request: EquationRequest): ExportImage | null;
};

export interface DocxExportResult {
  data: Uint8Array;
  /** Equations that couldn't take the chosen form and were written in the other one */
  otherForm: number;
  /** Equations written as their LaTeX source (invalid, or rendering failed) */
  asSource: number;
  /** Figures replaced by a note */
  missingFigures: number;
}

/** Word's own styles, so that its navigation pane, table of contents and captions know them */
const STYLES: Record<StyleKey, { id: string; name: string; outline?: number }> = {
  body: { id: "Normal", name: "Normal" },
  title: { id: "Title", name: "Title" },
  heading1: { id: "Heading1", name: "heading 1", outline: 0 },
  heading2: { id: "Heading2", name: "heading 2", outline: 1 },
  heading3: { id: "Heading3", name: "heading 3", outline: 2 },
  caption: { id: "Caption", name: "caption" },
  references: { id: "Bibliography", name: "Bibliography" },
};
const STYLE_ORDER: StyleKey[] = ["body", "title", "heading1", "heading2", "heading3", "caption", "references"];

const MONO_FONT = "Courier New";
const MUTED_TEXT = "#737373";
const MUTED_FILL = "#F5F5F5";
const RULE_LINE: Border = { style: "single", width: 0.75, color: "#E5E5E5" };
const QUOTE_LINE: Border = { style: "single", width: 1.5, color: "#E5E5E5" };
const TABLE_EDGE: Border = { style: "single", width: 1.125, color: "#000000" };
const TABLE_HEADER_LINE: Border = { style: "single", width: 0.75, color: "#000000" };
const TABLE_ROW_LINE: Border = { style: "dashed", width: 0.25, color: "#E5E5E5" };
/** Cell padding of the editor's tables, in pt */
const CELL_PADDING = { left: 9, right: 9, top: 4.5, bottom: 4.5 };
/** Blocks other than paragraphs have this top margin in the editor, in em */
const BLOCK_GAP = 0.75;
/** Display equations are larger than inline ones in the editor: 1.21 em against 1.05 em */
const DISPLAY_EQUATION_SCALE = 1.21 / 1.05;
const LIST_INDENT = 18;
const QUOTE_PADDING = 12;
const CODE_PADDING = 9;
const REFERENCE_INDENT = 33;
/** APA's hanging indent of 0.5 in, in pt */
const APA_HANGING_INDENT = 36;
const AUTHORS_PER_ROW = 3;
/** Drawing a formula takes about as long as writing this many nodes of a document. */
const EQUATION_WORK = 10;
/** Stands in for a formula's image in the run that only finds out which ones it takes */
const NO_IMAGE: ExportImage = { data: new Uint8Array(0), extension: "png", mediaType: "image/png", width: 1, height: 1 };

function pt(px: number): number {
  return (px * 3) / 4;
}

interface BlockEnv {
  /** Left indent in pt, from the page's (or cell's) left margin */
  left: number;
  /** Width available in pt */
  width: number;
  /** Top level of the page: the paragraph style's spacing and indent apply */
  top: boolean;
  /** Text color override (quotes) */
  color?: string;
  /** The paragraphs' base character format, when not the body style's (table cells) */
  char?: RunFormat;
  /** Inside a quote: paragraphs get its line on the left */
  quote?: boolean;
  /** Paragraphs stay on the page of what follows (table rows that move as a whole) */
  keepNext?: boolean;
}

/** The character format of runs and the paragraph style's, which they are written as differences from */
interface RunEnv {
  char: RunFormat;
  style: RunFormat;
}

/** Paragraph properties in pt; what's undefined is the style's. */
interface ParaShape {
  align?: ParaAlign;
  before?: number;
  after?: number;
  /** Line height, pt */
  line?: number;
  exact?: boolean;
  left?: number;
  right?: number;
  /** First-line indent; negative for a hanging one */
  indent?: number;
  keepNext?: boolean;
  keepLines?: boolean;
  numbering?: { id: number; level: number };
  borders?: Borders;
  shade?: string;
  tabs?: Tab[];
  mark?: string;
}

/**
 * The run of blocks one after another on the page or in a cell. Word puts no space around tables, so the paragraph
 * before a table gets the table's top margin, and the one after it its bottom margin.
 */
interface Flow {
  /** The spacing slot of the paragraph written last, if nothing came after it */
  lastSlot: number | null;
  /** Something written last that ends in a table */
  lastTable: boolean;
  /** Space the next paragraph has at least above it, pt */
  pending: number;
}

interface ThreadState {
  thread: CommentThread;
  /** Comment ids of its messages, the first one the thread's */
  ids: number[];
  /** Number of end markers written */
  ends: number;
}

class DocxWriter {
  private numbering = new NumberingBuilder((level) => (level + 1) * LIST_INDENT, LIST_INDENT);
  private media: PackageMedia[] = [];
  private links: PackageLink[] = [];
  private linkRels = new Map<string, string>();
  private images = new Map<string, { rel: string; image: ExportImage }>();
  private nextRel = 1;
  private nextDrawing = 1;
  private slots: { value: number; style: number }[] = [];
  private flow: Flow = { lastSlot: null, lastTable: false, pending: 0 };
  /** The next paragraph is the first of the body, which has no space above it */
  private bodyStart = false;
  /** Bookmark names of the objects that references link to */
  private bookmarks = new Map<string, string>();
  private placed = new Set<string>();
  private nextBookmark = 0;
  private threads = new Map<string, CommentThread>();
  private started = new Map<string, ThreadState>();
  private nextComment = 0;
  private otherForm = 0;
  private asSource = 0;
  private missingFigures = 0;
  /** The document's page, in pt */
  private readonly page: PageBox;

  constructor(
    private readonly input: DocxExportInput,
    private readonly assets: WriterAssets,
    private readonly report: ProgressReport
  ) {
    this.page = pageBox(input.format.page);
    for (const thread of input.comments) {
      if (thread.messages.length > 0) this.threads.set(thread.id, thread);
    }
    const visit = (node: JSONContent) => {
      if (node.type === "crossRef") {
        const target = String(node.attrs?.target ?? "");
        if (this.input.objectsById.has(target) && !this.bookmarks.has(target)) {
          this.bookmarks.set(target, `_P2G${++this.nextBookmark}`);
        }
      }
      for (const child of node.content ?? []) visit(child);
    };
    visit(input.content);
  }

  private get format(): PaperFormat {
    return this.input.format;
  }

  private def(key: StyleKey): TextStyleDef {
    return this.format.styles[key];
  }

  private charOf(def: TextStyleDef): RunFormat {
    return {
      latinFont: LATIN_FONTS[def.latinFont].label,
      koreanFont: KOREAN_FONTS[def.koreanFont].label,
      size: def.size,
      bold: def.bold,
      italic: def.italic,
      color: def.color,
      caps: def.textCase === "uppercase" ? "upper" : def.textCase === "small-caps" ? "small" : undefined,
    };
  }

  private styleChar(key: StyleKey): RunFormat {
    return this.charOf(this.def(key));
  }

  /** The style's own paragraph values, which paragraphs only repeat where they differ */
  private styleValues(key: StyleKey) {
    const def = this.def(key);
    return { before: def.spaceBefore, after: def.spaceAfter, line: def.lineHeight * def.size, align: def.align, indent: def.indent };
  }

  private rel(): string {
    return `rId${this.nextRel++}`;
  }

  // ---------------------------------------------------------------- paragraphs and runs

  private paragraph(key: StyleKey, shape: ParaShape, content: string): string {
    const style = this.styleValues(key);
    let before = Math.max(shape.before ?? style.before, this.flow.pending);
    if (this.bodyStart) {
      before = 0;
      this.bodyStart = false;
    }
    const slot = this.slots.push({ value: shape.after ?? style.after, style: style.after }) - 1;
    const differs = (value: number | undefined, own: number) => (value === undefined || value === own ? undefined : value);
    const pPr = paraProps({
      style: STYLES[key].id,
      keepNext: shape.keepNext,
      keepLines: shape.keepLines,
      numbering: shape.numbering,
      borders: shape.borders,
      shade: shape.shade,
      tabs: shape.tabs,
      before: differs(before, style.before),
      after: spacingAfter(slot),
      line: shape.exact ? shape.line : differs(shape.line, style.line),
      exact: shape.exact,
      left: shape.left || undefined,
      right: shape.right || undefined,
      indent: differs(shape.indent, style.indent),
      align: shape.align === style.align ? undefined : shape.align,
      mark: shape.mark,
    });
    this.flow = { lastSlot: slot, lastTable: false, pending: 0 };
    return `<w:p>${pPr}${content}</w:p>`;
  }

  /** What a table needs before it: room above, and a paragraph between it and a table before it */
  private beforeTable(top: number): string {
    const room = Math.max(top, this.flow.pending);
    if (this.flow.lastSlot !== null && !this.flow.lastTable) {
      const slot = this.slots[this.flow.lastSlot];
      slot.value = Math.max(slot.value, room);
      return "";
    }
    if (room <= 0 && !this.flow.lastTable) return "";
    // A small empty paragraph, as Word would join two tables next to each other
    this.flow.pending = 0;
    return this.paragraph("body", { before: 0, after: room, line: 1, exact: true, indent: 0, mark: '<w:rPr><w:sz w:val="2"/></w:rPr>' }, "");
  }

  private afterTable(bottom: number): void {
    this.flow = { lastSlot: null, lastTable: true, pending: bottom };
  }

  private text(env: RunEnv, text: string, char = env.char): string {
    return textRun(text, runProps(char, env.style));
  }

  private withMarks(base: RunFormat, marks: JSONContent["marks"]): RunFormat {
    const char = { ...base };
    for (const mark of marks ?? []) {
      const attrs = mark.attrs ?? {};
      switch (mark.type) {
        case "bold":
          char.bold = true;
          break;
        case "italic":
          char.italic = true;
          break;
        case "underline":
        case "link":
          char.underline = true;
          break;
        case "strike":
          char.strike = true;
          break;
        case "superscript":
          char.superscript = true;
          break;
        case "subscript":
          char.subscript = true;
          break;
        case "code":
          char.latinFont = MONO_FONT;
          char.size = Math.round(base.size * 85) / 100;
          char.shade = MUTED_FILL;
          break;
        case "textStyle":
          if (isLatinFontKey(attrs.latinFont)) char.latinFont = LATIN_FONTS[attrs.latinFont].label;
          if (isKoreanFontKey(attrs.koreanFont)) char.koreanFont = KOREAN_FONTS[attrs.koreanFont].label;
          if (typeof attrs.fontSize === "number") char.size = attrs.fontSize;
          if (isColor(attrs.color)) char.color = attrs.color;
          break;
      }
    }
    return char;
  }

  private linkRel(url: string): string {
    let rel = this.linkRels.get(url);
    if (!rel) {
      rel = this.rel();
      this.linkRels.set(url, rel);
      this.links.push({ rel, url });
    }
    return rel;
  }

  private async inline(nodes: JSONContent[] | undefined, env: RunEnv): Promise<string> {
    let out = "";
    /** The URL of the open hyperlink */
    let link: string | null = null;
    const closeLink = () => {
      if (link === null) return;
      out += "</w:hyperlink>";
      link = null;
    };
    for (const node of nodes ?? []) {
      const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href as string | undefined;
      if (link !== null && link !== href) closeLink();
      out += this.commentStarts(node);
      if (href && link === null) {
        out += `<w:hyperlink r:id="${this.linkRel(href)}" w:history="1">`;
        link = href;
      }
      const char = this.withMarks(env.char, node.marks);
      const runEnv = { ...env, char };
      switch (node.type) {
        case "text":
          out += this.text(runEnv, node.text ?? "");
          break;
        case "hardBreak":
          out += this.text(runEnv, "\n");
          break;
        case "mathInline":
          out += await this.math(String(node.attrs?.latex ?? ""), runEnv);
          break;
        case "citation":
          out += this.text(
            runEnv,
            citationText(parseRefIds(node.attrs?.refs), this.input.citations, {
              mode: node.attrs?.mode === "narrative" ? "narrative" : "paren",
              locator: String(node.attrs?.locator ?? ""),
            })
          );
          break;
        case "crossRef": {
          const target = String(node.attrs?.target ?? "");
          const run = this.text(runEnv, this.crossRefText(target));
          const name = this.bookmarks.get(target);
          // A link can't be inside another one.
          out += name && link === null ? `${MARK}ref:${name}${MARK}${run}${MARK}/ref${MARK}` : run;
          break;
        }
      }
      out += this.commentEnd(node);
    }
    closeLink();
    return out;
  }

  private crossRefText(targetId: string): string {
    const target = this.input.objectsById.get(targetId);
    return target?.number ? referenceText(target.kind, target.number, this.format, target.appendix) : "??";
  }

  /** A caption or other plain text in which `$…$` is math. */
  private async textWithMath(text: string, env: RunEnv): Promise<string> {
    let out = "";
    for (const part of splitInlineMath(text)) {
      out += part.math ? await this.math(part.text, env) : this.text(env, part.text);
    }
    return out;
  }

  /** The content wrapped in the bookmark of an object that references link to */
  private bookmarked(objectId: unknown, content: string): string {
    const name = this.bookmarks.get(String(objectId ?? ""));
    if (!name || this.placed.has(name)) return content;
    this.placed.add(name);
    const id = name.slice(4);
    return `<w:bookmarkStart w:id="${id}" w:name="${name}"/>${content}<w:bookmarkEnd w:id="${id}"/>`;
  }

  // ---------------------------------------------------------------- comments

  private threadOf(node: JSONContent): ThreadState[] {
    const states: ThreadState[] = [];
    for (const mark of node.marks ?? []) {
      if (mark.type !== "comment") continue;
      const id = String(mark.attrs?.threadId ?? "");
      const state = this.started.get(id);
      if (state) states.push(state);
      else if (this.threads.has(id)) states.push({ thread: this.threads.get(id)!, ids: [], ends: 0 });
    }
    return states;
  }

  /** Where a comment's text begins: at the first text that has its mark */
  private commentStarts(node: JSONContent): string {
    let out = "";
    for (const state of this.threadOf(node)) {
      if (this.started.has(state.thread.id)) continue;
      state.ids = state.thread.messages.map(() => this.nextComment++);
      this.started.set(state.thread.id, state);
      out += state.ids.map((id) => `<w:commentRangeStart w:id="${id}"/>`).join("");
    }
    return out;
  }

  /** Each text with the mark may be the last one: the end goes after whichever is, in the end. */
  private commentEnd(node: JSONContent): string {
    return this.threadOf(node)
      .map((state) => `${MARK}end:${state.ids[0]}:${++state.ends}${MARK}`)
      .join("");
  }

  private commentEntries(): CommentEntry[] {
    const entries: CommentEntry[] = [];
    for (const { thread, ids } of this.started.values()) {
      thread.messages.forEach((message, i) => {
        entries.push({
          id: ids[i],
          author: message.author,
          initials: initialsOf(message.author),
          date: message.createdAt,
          text: message.text,
          parent: i > 0 ? ids[0] : undefined,
          done: thread.resolved,
        });
      });
    }
    return entries.sort((a, b) => a.id - b.id);
  }

  private resolveComments(body: string): string {
    const states = new Map([...this.started.values()].map((state) => [state.ids[0], state]));
    return body.replace(new RegExp(`${MARK}end:(\\d+):(\\d+)${MARK}`, "g"), (_, first: string, seq: string) => {
      const state = states.get(Number(first));
      if (!state || Number(seq) !== state.ends) return "";
      return (
        state.ids.map((id) => `<w:commentRangeEnd w:id="${id}"/>`).join("") +
        state.ids
          .map((id) => `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`)
          .join("")
      );
    });
  }

  // ---------------------------------------------------------------- equations

  private ommlStyle(char: RunFormat, scale: number): OmmlStyle {
    return {
      size: Math.round(char.size * scale * 2) / 2,
      color: char.color || "",
      latinFont: char.latinFont,
      koreanFont: char.koreanFont,
    };
  }

  /** An inline formula in the chosen form, else the other one, else its LaTeX source. */
  private async math(latex: string, env: RunEnv, maxWidth = this.page.textWidth): Promise<string> {
    if (!latex.trim()) return "";
    const wantImage = this.input.equations === "image";
    const asImage = async () => {
      const entry = await this.equationImage(latex, false, env.char);
      return entry && this.pictureRun(entry, env, maxWidth, undefined, latex);
    };
    const asNative = () => latexToOmml(latex, false, this.ommlStyle(env.char, 1));
    const first = wantImage ? await asImage() : asNative();
    if (first) return first;
    const second = wantImage ? asNative() : await asImage();
    if (second) {
      this.otherForm++;
      return second;
    }
    this.asSource++;
    return this.text(env, latex, { ...env.char, latinFont: MONO_FONT });
  }

  private async equationImage(latex: string, display: boolean, char: RunFormat) {
    const key = `equation|${display}|${char.size}|${char.color ?? ""}|${latex}`;
    return this.registered(key, () =>
      this.assets.equationImage({ latex, display, size: char.size, color: char.color || "#000000" })
    );
  }

  // ---------------------------------------------------------------- pictures

  /** The image once in the package, however often it is used */
  private async registered(key: string, load: () => ExportImage | null | Promise<ExportImage | null>) {
    const known = this.images.get(key);
    if (known) return known;
    const image = await load();
    if (!image) return null;
    const entry = { rel: this.rel(), image };
    this.media.push({ rel: entry.rel, path: `media/image${this.media.length + 1}.${image.extension}`, data: image.data });
    this.images.set(key, entry);
    return entry;
  }

  /** At its natural size unless `width` (pt) is given, shrunk to fit `maxWidth` and the page height */
  private pictureRun(
    entry: { rel: string; image: ExportImage },
    env: RunEnv,
    maxWidth: number,
    width = pt(entry.image.width),
    description = ""
  ): string {
    const { image, rel } = entry;
    const scale = Math.min(1, maxWidth / width, this.page.textHeight / ((width * image.height) / image.width));
    const w = width * scale;
    const h = (w * image.height) / image.width;
    // Word sets a picture on the baseline; a formula's reaches below it as far as its text does.
    const raise = image.descent === undefined ? undefined : -(image.descent * h) / image.height;
    return `<w:r>${runProps({ ...env.char, raise }, env.style)}${inlinePicture(this.nextDrawing++, rel, w, h, description)}</w:r>`;
  }

  // ---------------------------------------------------------------- blocks

  private async blocks(nodes: JSONContent[] | undefined, env: BlockEnv): Promise<string> {
    let out = "";
    for (const node of nodes ?? []) out += await this.block(node, env);
    return out;
  }

  private bodyChar(env: BlockEnv): RunFormat {
    const char = env.char ?? this.styleChar("body");
    return env.color ? { ...char, color: env.color } : char;
  }

  private bodyEnv(env: BlockEnv): RunEnv {
    return { char: this.bodyChar(env), style: this.styleChar("body") };
  }

  private alignOf(node: JSONContent, fallback: ParaAlign): ParaAlign {
    return isTextAlign(node.attrs?.textAlign) ? node.attrs!.textAlign : fallback;
  }

  /** The top margin of blocks that aren't paragraphs. Only those directly on the page have one. */
  private gapBefore(env: BlockEnv): number {
    return env.top ? BLOCK_GAP * this.def("body").size : 0;
  }

  /** The shape of a paragraph that isn't directly on the page: no spacing or first-line indent of its own */
  private nestedShape(env: BlockEnv, align: ParaAlign, char: RunFormat): ParaShape {
    return {
      align,
      before: 0,
      after: 0,
      indent: 0,
      left: env.left,
      line: this.def("body").lineHeight * char.size,
      keepNext: env.keepNext,
      ...(env.quote ? { borders: { left: { ...QUOTE_LINE, space: QUOTE_PADDING } } } : {}),
    };
  }

  private async block(node: JSONContent, env: BlockEnv): Promise<string> {
    switch (node.type) {
      case "paragraph":
        return this.bodyParagraph(node, env);
      case "heading":
        return this.heading(node);
      case "bulletList":
      case "orderedList":
        return this.list(node, env, 0);
      case "blockquote":
        return this.quote(node, env);
      case "codeBlock":
        return this.codeBlock(node, env);
      case "horizontalRule":
        return this.rule(18, 18, env);
      case "equation":
        return this.displayEquation(node, env);
      case "figure":
        return this.figure(node);
      case "tableFigure":
        return this.tableFigure(node, env);
      case "table":
        return this.table(node, env, { top: this.gapBefore(env), bottom: 0 });
      default:
        return "";
    }
  }

  private async bodyParagraph(node: JSONContent, env: BlockEnv): Promise<string> {
    const def = this.def("body");
    const runEnv = this.bodyEnv(env);
    const shape: ParaShape = env.top
      ? { align: this.alignOf(node, def.align) }
      : this.nestedShape(env, this.alignOf(node, env.char ? "left" : def.align), runEnv.char);
    return this.paragraph("body", shape, await this.inline(node.content, runEnv));
  }

  private async heading(node: JSONContent): Promise<string> {
    const level = Math.min(3, Number(node.attrs?.level ?? 1));
    const key = `heading${level}` as StyleKey;
    const env: RunEnv = { char: this.styleChar(key), style: this.styleChar(key) };
    const number = this.input.objectsById.get(String(node.attrs?.id ?? ""))?.shown;
    const content = (number ? this.text(env, `${number}  `) : "") + (await this.inline(node.content, env));
    return this.paragraph(key, { align: this.alignOf(node, this.def(key).align) }, this.bookmarked(node.attrs?.id, content));
  }

  private async list(node: JSONContent, env: BlockEnv, level: number, first = true): Promise<string> {
    const def = this.def("body");
    const ordered = node.type === "orderedList";
    const id = ordered ? this.numbering.numbers(Number(node.attrs?.start ?? 1) || 1) : this.numbering.bullets();
    const left = env.left + LIST_INDENT;
    const itemEnv: BlockEnv = { ...env, top: false, left, width: env.width - LIST_INDENT };
    const itemSpace = def.size * 0.15;
    let out = "";
    let isFirst = first;
    for (const item of node.content ?? []) {
      let marked = false;
      for (const child of item.content ?? []) {
        if (child.type === "bulletList" || child.type === "orderedList") {
          out += await this.list(child, itemEnv, level + 1, false);
        } else if (child.type === "paragraph" && !marked) {
          marked = true;
          const runEnv = this.bodyEnv(env);
          out += this.paragraph(
            "body",
            {
              ...this.nestedShape(itemEnv, this.alignOf(child, def.align), runEnv.char),
              before: isFirst ? this.gapBefore(env) : 0,
              after: itemSpace,
              indent: -LIST_INDENT,
              numbering: { id, level },
            },
            await this.inline(child.content, runEnv)
          );
          isFirst = false;
        } else {
          out += await this.block(child, itemEnv);
        }
      }
    }
    return out;
  }

  private codeBlock(node: JSONContent, env: BlockEnv): string {
    const text = (node.content ?? []).map((child) => child.text ?? "").join("");
    const runEnv: RunEnv = {
      char: { ...this.styleChar("body"), latinFont: MONO_FONT, size: pt(14), bold: false, italic: false },
      style: this.styleChar("body"),
    };
    // Borders in the color of the fill give it the editor's padding.
    const edge: Border = { style: "single", width: 0.25, color: MUTED_FILL, space: CODE_PADDING };
    return this.paragraph(
      "body",
      {
        align: "left",
        before: this.gapBefore(env),
        after: 0,
        line: runEnv.char.size * 1.5,
        indent: 0,
        left: env.left + CODE_PADDING,
        right: CODE_PADDING,
        shade: MUTED_FILL,
        borders: { top: edge, left: edge, bottom: edge, right: edge },
      },
      this.text(runEnv, text)
    );
  }

  private async quote(node: JSONContent, env: BlockEnv): Promise<string> {
    // The gap above goes to its first paragraph.
    this.flow.pending = Math.max(this.flow.pending, this.gapBefore(env));
    return this.blocks(node.content, {
      ...env,
      top: false,
      left: env.left + QUOTE_PADDING,
      width: env.width - QUOTE_PADDING,
      color: MUTED_TEXT,
      quote: true,
    });
  }

  /** A horizontal line */
  private rule(before: number, after: number, env: Pick<BlockEnv, "left"> = { left: 0 }): string {
    return this.paragraph(
      "body",
      {
        before,
        after,
        line: 1,
        exact: true,
        indent: 0,
        left: env.left,
        borders: { top: RULE_LINE },
        mark: '<w:rPr><w:sz w:val="2"/></w:rPr>',
      },
      ""
    );
  }

  private async displayEquation(node: JSONContent, env: BlockEnv): Promise<string> {
    const def = this.def("body");
    const runEnv = this.bodyEnv(env);
    const object = this.input.objectsById.get(String(node.attrs?.id ?? ""));
    const number = object?.number ? equationNumberText(object.number, this.format.equation.brackets) : "";
    const shape: ParaShape = {
      ...this.nestedShape(env, "center", runEnv.char),
      before: this.gapBefore(env) + def.size / 4,
      after: def.size / 4,
      keepLines: true,
    };
    const latex = String(node.attrs?.latex ?? "");
    const wantImage = this.input.equations === "image";
    const native = () => latexToOmml(latex, true, this.ommlStyle(runEnv.char, DISPLAY_EQUATION_SCALE), number || undefined);
    const image = async () => {
      const entry = await this.equationImage(latex, true, runEnv.char);
      if (!entry) return null;
      if (!number) return this.pictureRun(entry, runEnv, env.width, undefined, latex);
      // Centred on a tab stop, the number on one at the right edge
      const room = env.width - (number.length + 2) * runEnv.char.size;
      return this.text(runEnv, "\t") + this.pictureRun(entry, runEnv, room, undefined, latex) + this.text(runEnv, `\t${number}`);
    };
    const tabs: Tab[] = [
      { type: "center", pos: env.left + env.width / 2 },
      { type: "right", pos: env.left + env.width },
    ];
    const write = (content: string, asImage: boolean) =>
      this.paragraph(
        "body",
        asImage && number ? { ...shape, align: "left", tabs } : shape,
        this.bookmarked(node.attrs?.id, content)
      );
    if (!latex.trim()) return write(number ? this.text(runEnv, number) : "", false);
    const first = wantImage ? await image() : native();
    if (first) return write(first, wantImage);
    const second = wantImage ? native() : await image();
    if (second) {
      this.otherForm++;
      return write(second, !wantImage);
    }
    this.asSource++;
    const source = this.text(runEnv, latex, { ...runEnv.char, latinFont: MONO_FONT });
    return write(source + (number ? this.text(runEnv, `  ${number}`) : ""), false);
  }

  /** "Figure 1. caption" in the caption style */
  private async caption(
    format: FloatFormat,
    object: NumberedObject | undefined,
    text: string,
    spacing: Pick<ParaShape, "before" | "after" | "keepNext">
  ): Promise<string> {
    const env: RunEnv = { char: this.styleChar("caption"), style: this.styleChar("caption") };
    const label = object?.number ? captionLabelText(format, object.number) : "";
    const content =
      (label ? this.text(env, label, format.labelBold ? { ...env.char, bold: true } : env.char) : "") +
      (label && text ? this.text(env, " ") : "") +
      (await this.textWithMath(text, env));
    return this.paragraph("caption", spacing, this.bookmarked(object?.id, content));
  }

  private async figure(node: JSONContent): Promise<string> {
    const attrs = node.attrs ?? {};
    const format = this.format.figure;
    const above = format.position === "above";
    const caption = this.def("caption");
    /** Margin and padding around a figure in the editor, in pt */
    const margin = pt(20 + 8);
    const object = this.input.objectsById.get(String(attrs.id ?? ""));
    const captionText = String(attrs.caption ?? "");
    const pictureParagraph = async () => {
      const runEnv = this.bodyEnv({ left: 0, width: this.page.textWidth, top: true });
      const picture = await this.figurePicture(attrs, runEnv);
      return this.paragraph(
        "body",
        { align: "center", indent: 0, before: above ? 0 : margin, after: above ? margin : 0, keepNext: !above },
        picture ?? this.text(runEnv, "[그림을 넣지 못했습니다]", { ...runEnv.char, color: "#DC2626" })
      );
    };
    if (above) {
      const captionEl = await this.caption(format, object, captionText, {
        before: margin + caption.spaceBefore,
        after: caption.spaceAfter,
        keepNext: true,
      });
      return captionEl + (await pictureParagraph());
    }
    const paragraph = await pictureParagraph();
    return (
      paragraph +
      (await this.caption(format, object, captionText, {
        before: caption.spaceBefore,
        after: caption.spaceAfter + margin,
      }))
    );
  }

  private async figurePicture(attrs: Record<string, unknown>, env: RunEnv): Promise<string | null> {
    const width = Number(attrs.width ?? 0);
    const tikz = attrs.tikz as string | null | undefined;
    const source: TikzSource | null =
      typeof tikz === "string"
        ? { code: tikz, libraries: String(attrs.tikzLibraries ?? ""), packages: String(attrs.tikzPackages ?? "") }
        : null;
    const src = String(attrs.src ?? "");
    const entry = source
      ? await this.registered(`tikz|${JSON.stringify(source)}`, () => this.assets.tikzImage(source))
      : src
        ? await this.registered(`figure|${src}`, () => this.assets.figureImage(src))
        : null;
    if (!entry) {
      this.missingFigures++;
      return null;
    }
    const { textWidth } = this.page;
    return this.pictureRun(entry, env, textWidth, width > 0 ? (textWidth * width) / 100 : undefined, String(attrs.caption ?? ""));
  }

  private async tableFigure(node: JSONContent, env: BlockEnv): Promise<string> {
    const attrs = node.attrs ?? {};
    const format = this.format.table;
    const above = format.position === "above";
    const caption = this.def("caption");
    const margin = pt(20);
    const object = this.input.objectsById.get(String(attrs.id ?? ""));
    const captionText = String(attrs.caption ?? "");
    const table = node.content?.[0] ?? {};
    if (above) {
      const captionEl = await this.caption(format, object, captionText, {
        before: margin + caption.spaceBefore,
        after: caption.spaceAfter,
        keepNext: true,
      });
      return captionEl + (await this.table(table, env, { top: 0, bottom: margin }));
    }
    const tableEl = await this.table(table, env, { top: margin, bottom: 0, keepWithNext: true });
    return (
      tableEl +
      (await this.caption(format, object, captionText, {
        before: caption.spaceBefore,
        after: caption.spaceAfter + margin,
      }))
    );
  }

  // ---------------------------------------------------------------- tables

  /** Cell content, in a flow of its own; a cell has to end with a paragraph. */
  private async cellContent(write: () => Promise<string>, emptyLine: number): Promise<string> {
    const outer = this.flow;
    this.flow = { lastSlot: null, lastTable: false, pending: 0 };
    let content = await write();
    if (!content || this.flow.lastTable) {
      content += this.paragraph("body", { before: 0, after: 0, indent: 0, line: emptyLine }, "");
    }
    this.flow = outer;
    return content;
  }

  private async table(
    node: JSONContent,
    env: BlockEnv,
    spacing: { top: number; bottom: number; keepWithNext?: boolean }
  ): Promise<string> {
    const before = this.beforeTable(spacing.top);
    const layout = layoutTable(node);
    const def = this.def("body");
    const size = Math.round(def.size * 95) / 100;
    const widths = columnWidths(layout, size, env.width * HWPUNIT_PER_PT).map((w) => w / HWPUNIT_PER_PT);
    const char: RunFormat = { ...this.styleChar("body"), size };
    const lastRow = layout.rows.length - 1;
    // Cells that a merged cell above covers
    const covered = layout.rows.map(() => [] as { col: number; colSpan: number; bottom: boolean }[]);
    for (const row of layout.rows) {
      for (const cell of row.cells) {
        for (let r = cell.row + 1; r < cell.row + cell.rowSpan && r <= lastRow; r++) {
          covered[r].push({ col: cell.col, colSpan: cell.colSpan, bottom: r === cell.row + cell.rowSpan - 1 });
        }
      }
    }
    const span = (col: number, colSpan: number) => widths.slice(col, col + colSpan).reduce((sum, w) => sum + w, 0);
    let rows = "";
    for (const [r, row] of layout.rows.entries()) {
      const header = row.header;
      const bottomLine = (rowIndex: number) =>
        rowIndex >= lastRow ? TABLE_EDGE : layout.rows[rowIndex].header ? TABLE_HEADER_LINE : TABLE_ROW_LINE;
      const cells: { col: number; xml: string }[] = [];
      for (const cell of row.cells) {
        const width = span(cell.col, cell.colSpan);
        const last = Math.min(lastRow, cell.row + cell.rowSpan - 1);
        const cellEnv: BlockEnv = {
          left: 0,
          top: false,
          width: width - CELL_PADDING.left - CELL_PADDING.right,
          char: cell.node.type === "tableHeader" ? { ...char, bold: true } : char,
          // The table moves to the next page as a whole, unless it's longer than a page.
          keepNext: r < lastRow || spacing.keepWithNext,
        };
        const content = await this.cellContent(() => this.blocks(cell.node.content, cellEnv), def.lineHeight * size);
        cells.push({
          col: cell.col,
          xml: tableCell({
            width,
            colSpan: cell.colSpan,
            merge: cell.rowSpan > 1 ? "restart" : null,
            borders: { top: r === 0 ? TABLE_EDGE : undefined, bottom: bottomLine(cell.rowSpan > 1 ? last : r) },
            content,
          }),
        });
      }
      for (const cover of covered[r]) {
        cells.push({
          col: cover.col,
          xml: tableCell({
            width: span(cover.col, cover.colSpan),
            colSpan: cover.colSpan,
            merge: "continue",
            borders: { bottom: cover.bottom ? bottomLine(r) : undefined },
            // Without the spacing of the body style, which would make the row taller
            content: `<w:p>${paraProps({ before: 0, after: 0, left: 0, indent: 0 })}</w:p>`,
          }),
        });
      }
      cells.sort((a, b) => a.col - b.col);
      const height = Number(row.node.attrs?.height ?? 0);
      const trPr =
        "<w:cantSplit/>" +
        (height > 0 ? `<w:trHeight w:val="${twips(pt(height))}" w:hRule="atLeast"/>` : "") +
        (header ? "<w:tblHeader/>" : "");
      rows += `<w:tr><w:trPr>${trPr}</w:trPr>${cells.map((c) => c.xml).join("")}</w:tr>`;
    }
    const total = widths.reduce((sum, w) => sum + w, 0);
    const xml =
      `<w:tbl><w:tblPr><w:tblW w:w="${twips(total)}" w:type="dxa"/><w:jc w:val="center"/>` +
      `<w:tblLayout w:type="fixed"/>${cellMargins()}<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" ` +
      'w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>' +
      `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${twips(w)}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>`;
    this.afterTable(spacing.bottom);
    return before + xml;
  }

  /** Authors side by side in a borderless table, as in the editor: name, affiliation and e-mail in a column */
  private async authors(): Promise<string> {
    const authors = this.input.authors.filter((a) => a.name || a.affiliation || a.email);
    if (authors.length === 0) return "";
    const style = this.styleChar("body");
    const plain: RunFormat = { ...style, bold: false, italic: false };
    const lines = [
      (a: Author) => ({ text: a.name, char: { ...plain, size: pt(14), bold: true } }),
      (a: Author) => ({ text: a.affiliation, char: { ...plain, size: pt(12), color: MUTED_TEXT } }),
      (a: Author) => ({ text: a.email, char: { ...plain, latinFont: MONO_FONT, size: pt(11), color: MUTED_TEXT } }),
    ];
    const columns = Math.min(AUTHORS_PER_ROW, authors.length);
    const width = this.page.textWidth / columns;
    const before = this.beforeTable(0);
    let rows = "";
    for (let row = 0; row < Math.ceil(authors.length / columns); row++) {
      let cells = "";
      for (let col = 0; col < columns; col++) {
        const author = authors[row * columns + col];
        const content = await this.cellContent(async () => {
          if (!author) return "";
          return lines
            .map((line) => line(author))
            .filter((line) => line.text)
            .map((line) =>
              this.paragraph(
                "body",
                { align: "center", before: 0, after: 0, indent: 0, line: 1.4 * line.char.size },
                textRun(line.text, runProps(line.char, style))
              )
            )
            .join("");
        }, style.size);
        cells += tableCell({ width, colSpan: 1, merge: null, borders: {}, content });
      }
      rows += `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells}</w:tr>`;
    }
    this.afterTable(0);
    return (
      before +
      `<w:tbl><w:tblPr><w:tblW w:w="${twips(width * columns)}" w:type="dxa"/><w:jc w:val="center"/>` +
      `<w:tblLayout w:type="fixed"/>${cellMargins()}</w:tblPr>` +
      `<w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${twips(width)}"/>`).join("")}</w:tblGrid>` +
      `${rows}</w:tbl>`
    );
  }

  private references(): string {
    const { citations } = this.input;
    const entries = citations.entries.filter((e) => e.listed);
    if (entries.length === 0) return "";
    const titleEnv: RunEnv = { char: this.styleChar("heading1"), style: this.styleChar("heading1") };
    const env: RunEnv = { char: this.styleChar("references"), style: this.styleChar("references") };
    // In document order, since each paragraph takes the space left by the one before it
    const head =
      this.rule(pt(48), pt(24)) +
      this.paragraph("heading1", { before: 0 }, this.text(titleEnv, this.format.references.title));
    // Author-date lists have no labels and a hanging indent of 0.5 in (APA).
    const hanging = isAuthorDate(citations.style);
    const indent = hanging ? APA_HANGING_INDENT : REFERENCE_INDENT;
    const items = entries.map((entry) => {
      const runs = formatReferenceAs(entry.ref, citations.style, citations)
        .map((segment) => this.text(env, segment.text, segment.italic ? { ...env.char, italic: true } : env.char))
        .join("");
      return this.paragraph(
        "references",
        {
          before: 0,
          left: indent,
          indent: -indent,
          tabs: hanging ? [] : [{ type: "left", pos: REFERENCE_INDENT }],
          keepLines: true,
        },
        (hanging ? "" : this.text(env, `${entryLabel(entry, citations.style)}\t`)) + runs
      );
    });
    return head + items.join("");
  }

  /** The text of the document, which is also what asks for all its images */
  async body(): Promise<string> {
    const { title, content } = this.input;
    const titleEnv: RunEnv = { char: this.styleChar("title"), style: this.styleChar("title") };
    let out = this.paragraph("title", { after: pt(12) }, this.text(titleEnv, title));
    out += await this.authors();
    out += this.rule(pt(24), pt(32));
    const nodes = content.content ?? [];
    const work = nodes.reduce((sum, node) => sum + workOf(node), 0);
    let done = 0;
    this.bodyStart = true;
    for (const node of nodes) {
      out += await this.block(node, { left: 0, top: true, width: this.page.textWidth });
      done += workOf(node);
      await this.report(done / work);
    }
    out += this.references();
    if (this.flow.lastTable) out += this.paragraph("body", { before: 0, after: 0 }, "");
    return out;
  }

  private stylesXml(): string {
    const body = this.styleChar("body");
    const styles: StyleDef[] = STYLE_ORDER.map((key) => {
      const def = this.def(key);
      const values = this.styleValues(key);
      const heading = STYLES[key].outline !== undefined;
      return {
        id: STYLES[key].id,
        name: STYLES[key].name,
        type: "paragraph",
        isDefault: key === "body",
        basedOn: key === "body" ? undefined : "Normal",
        next: key === "body" ? undefined : "Normal",
        outlineLevel: STYLES[key].outline,
        quick: true,
        priority: key === "body" ? 0 : heading ? 9 : 10,
        paragraph: paraPropsContent({
          ...(heading ? { keepNext: true, keepLines: true } : {}),
          before: values.before,
          after: values.after,
          line: values.line,
          indent: values.indent,
          align: values.align,
        }),
        run: runProps(this.charOf(def)),
      };
    });
    styles.push(
      {
        id: "CommentText",
        name: "annotation text",
        type: "paragraph",
        basedOn: "Normal",
        priority: 99,
        paragraph: paraPropsContent({ before: 0, after: 0, line: 12, indent: 0, align: "left" }),
        run: runProps({ ...body, size: 10, bold: false, italic: false, color: "" }),
      },
      {
        id: "CommentReference",
        name: "annotation reference",
        type: "character",
        priority: 99,
        run: '<w:sz w:val="16"/><w:szCs w:val="16"/>',
      }
    );
    const defaults = runProps(body).replace(/^<w:rPr>|<\/w:rPr>$/g, "") + '<w:lang w:val="en-US" w:eastAsia="ko-KR"/>';
    return stylesXml(
      {
        run: defaults,
        paragraph: '<w:widowControl/><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>',
      },
      styles
    );
  }

  async write(): Promise<DocxExportResult> {
    const { title, authors } = this.input;
    let body = await this.body();
    body = body.replace(new RegExp(`${MARK}after(\\d+)${MARK}`, "g"), (_, n: string) => {
      const slot = this.slots[Number(n)];
      return Math.abs(slot.value - slot.style) < 0.01 ? "" : ` w:after="${twips(slot.value)}"`;
    });
    body = body.replace(new RegExp(`${MARK}ref:([^${MARK}]+)${MARK}([^${MARK}]*)${MARK}/ref${MARK}`, "g"), (_, name: string, run: string) =>
      this.placed.has(name) ? `<w:hyperlink w:anchor="${name}" w:history="1">${run}</w:hyperlink>` : run
    );
    body = this.resolveComments(body);
    const entries = this.commentEntries();
    return {
      data: buildPackage({
        body,
        styles: this.stylesXml(),
        numbering: this.numbering.empty ? null : this.numbering.toXml(),
        comments: entries.length > 0 ? commentParts(entries) : null,
        media: this.media,
        links: this.links,
        title,
        creator: authors.map((a) => a.name).filter(Boolean).join(", "),
        page: this.page,
      }),
      otherForm: this.otherForm,
      asSource: this.asSource,
      missingFigures: this.missingFigures,
    };
  }
}

function cellMargins(): string {
  const { top, left, bottom, right } = CELL_PADDING;
  return (
    `<w:tblCellMar><w:top w:w="${twips(top)}" w:type="dxa"/><w:left w:w="${twips(left)}" w:type="dxa"/>` +
    `<w:bottom w:w="${twips(bottom)}" w:type="dxa"/><w:right w:w="${twips(right)}" w:type="dxa"/></w:tblCellMar>`
  );
}

function cellBorder(side: string, line: Border | undefined): string {
  if (!line) return "";
  const size = Math.min(96, Math.max(2, Math.round(line.width * 8)));
  return `<w:${side} w:val="${line.style}" w:sz="${size}" w:space="0" w:color="${line.color.slice(1).toUpperCase()}"/>`;
}

function tableCell(cell: {
  /** pt */
  width: number;
  colSpan: number;
  /** A cell merged with those below it starts the merge; those continue it */
  merge: "restart" | "continue" | null;
  borders: { top?: Border; bottom?: Border };
  content: string;
}): string {
  const borders = cellBorder("top", cell.borders.top) + cellBorder("bottom", cell.borders.bottom);
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${twips(cell.width)}" w:type="dxa"/>` +
    (cell.colSpan > 1 ? `<w:gridSpan w:val="${cell.colSpan}"/>` : "") +
    (cell.merge === "restart" ? '<w:vMerge w:val="restart"/>' : cell.merge === "continue" ? "<w:vMerge/>" : "") +
    (borders ? `<w:tcBorders>${borders}</w:tcBorders>` : "") +
    `</w:tcPr>${cell.content}</w:tc>`
  );
}

/** `onProgress` gets how much is done, from 0 to 1. */
export async function exportDocx(
  input: DocxExportInput,
  assets: DocxAssets,
  onProgress?: (fraction: number) => void
): Promise<DocxExportResult> {
  const report = progressReport(onProgress);
  // Formulas get drawn together, so a first run through the document finds out which ones it takes.
  const requests = new Map<string, EquationRequest>();
  await new DocxWriter(
    input,
    {
      equationImage: (request) => {
        requests.set(equationKey(request), request);
        return NO_IMAGE;
      },
      figureImage: async () => null,
      tikzImage: async () => null,
    },
    async () => {}
  ).body();
  const list = [...requests.values()];
  const drawing = list.length * EQUATION_WORK;
  const work = (input.content.content ?? []).reduce((sum, node) => sum + workOf(node), 0);
  const share = drawing > 0 ? drawing / (drawing + work) : 0;
  const images = drawing > 0 ? await assets.equationImages(list, (fraction) => report(fraction * share)) : [];
  const drawn = new Map(list.map((request, i) => [equationKey(request), images[i]]));
  return new DocxWriter(
    input,
    { ...assets, equationImage: (request) => drawn.get(equationKey(request)) ?? null },
    (fraction) => report(share + fraction * (1 - share))
  ).write();
}

