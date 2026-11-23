/**
 * Converts a paper to an HWPX file. Numbers (sections, equations, figures, tables, references to them) are
 * fixed text, the same as in the editor; comments are left out, as in the LaTeX and PDF exports.
 */
import type { JSONContent } from "@tiptap/core";
import { splitInlineMath } from "@/lib/editor-utils";
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
import type { Author } from "@/lib/paper/types";
import type { TikzSource } from "@/lib/tikz/options";
import { latexToHwpEquation } from "./equation-script";
import {
  buildPackage,
  escapeXml,
  HeaderBuilder,
  HWPUNIT_PER_PT,
  HWPUNIT_PER_PX,
  outlineHeading,
  pageBox,
  sectionStart,
  TAB_EQUATION,
  TAB_HANGING,
  type BorderLine,
  type CharShape,
  type PackageImage,
  type PageBox,
  type ParaAlign,
  type ParaShape,
} from "./owpml";

export type HwpxEquationMode = "native" | "image";

export interface HwpxExportInput {
  content: JSONContent;
  title: string;
  authors: Author[];
  /** The reference list and what citations show */
  citations: CitationLayout;
  format: PaperFormat;
  objectsById: Map<string, NumberedObject>;
  /** How equations are written: as Hancom equations (editable) or as images (looking as in the editor) */
  equations: HwpxEquationMode;
}

export interface ExportImage {
  data: Uint8Array;
  /** png, jpg, gif or bmp */
  extension: string;
  mediaType: string;
  /** Natural size, in CSS px */
  width: number;
  height: number;
  /** How far an equation reaches below its baseline, in the same px */
  descent?: number;
}

/** A formula to draw */
export interface EquationRequest {
  latex: string;
  display: boolean;
  /** In pt */
  size: number;
  color: string;
}

/** Says how far something got, from 0 to 1, and gives the browser a moment to show that. */
export type ProgressReport = (fraction: number) => Promise<void>;

/** Everything that needs a browser: rendering and downloading. Each gives null for what fails. */
export interface HwpxAssets {
  /** All formulas of a document at once, as drawing them one by one takes many times longer */
  equationImages(requests: EquationRequest[], report: ProgressReport): Promise<(ExportImage | null)[]>;
  figureImage(src: string): Promise<ExportImage | null>;
  tikzImage(source: TikzSource): Promise<ExportImage | null>;
}

/** Where a writer takes its images from: the formulas are ready by then. */
type WriterAssets = Pick<HwpxAssets, "figureImage" | "tikzImage"> & {
  equationImage(request: EquationRequest): ExportImage | null;
};

export interface HwpxExportResult {
  data: Uint8Array;
  /** Equations that couldn't take the chosen form and were written in the other one */
  otherForm: number;
  /** Equations written as their LaTeX source (invalid, or rendering failed) */
  asSource: number;
  /** Figures replaced by a note */
  missingFigures: number;
}

const STYLE_NAMES: Record<StyleKey, [string, string]> = {
  body: ["바탕글", "Normal"],
  title: ["논문 제목", "Paper Title"],
  heading1: ["개요 1", "Outline 1"],
  heading2: ["개요 2", "Outline 2"],
  heading3: ["개요 3", "Outline 3"],
  caption: ["캡션", "Caption"],
  references: ["참고문헌", "References"],
};
const STYLE_ORDER: StyleKey[] = ["body", "title", "heading1", "heading2", "heading3", "caption", "references"];

const MONO_FONT = "Courier New";
const MUTED_TEXT = "#737373";
const MUTED_FILL = "#F5F5F5";
const RULE_LINE: BorderLine = { type: "SOLID", width: "0.12 mm", color: "#E5E5E5" };
const QUOTE_LINE: BorderLine = { type: "SOLID", width: "0.5 mm", color: "#E5E5E5" };
const TABLE_EDGE: BorderLine = { type: "SOLID", width: "0.4 mm", color: "#000000" };
const TABLE_HEADER_LINE: BorderLine = { type: "SOLID", width: "0.25 mm", color: "#000000" };
const TABLE_ROW_LINE: BorderLine = { type: "DASH", width: "0.12 mm", color: "#E5E5E5" };
/** Cell padding of the editor's tables, in pt */
const CELL_PADDING: Padding = { left: 9, right: 9, top: 4.5, bottom: 4.5 };
const NO_PADDING: Padding = { left: 0, right: 0, top: 0, bottom: 0 };
const TABLE_MIN_COLUMN_PX = 64;
/** Blocks other than paragraphs have this top margin in the editor, in em */
const BLOCK_GAP = 0.75;
/** Size of the editor's equations relative to the text: inline 1.05 em, display 1.21 em */
const DISPLAY_EQUATION_SCALE = 1.21 / 1.05;
const LIST_INDENT = 18;
const BULLETS = ["●", "○", "■"];
const PROGRESS_INTERVAL_MS = 100;
/** Drawing a formula takes about as long as writing this many nodes of a document. */
const EQUATION_WORK = 10;
/** Stands in for a formula's image in the run that only finds out which ones it takes */
const NO_IMAGE: ExportImage = { data: new Uint8Array(0), extension: "png", mediaType: "image/png", width: 1, height: 1 };
const REFERENCE_INDENT = 33;
/** APA's hanging indent of 0.5 in, in pt */
const APA_HANGING_INDENT = 36;
const AUTHORS_PER_ROW = 3;
/** Part of an inline picture's height that Hancom sets below the baseline, whatever is in the picture */
const PICTURE_BASELINE = 0.14;

function pt(px: number): number {
  return (px * 3) / 4;
}

/** In pt */
interface Padding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface BlockEnv {
  /** Left margin in pt */
  left: number;
  /** Width available in HWPUNIT */
  width: number;
  /** Top level of the page: tab stops and the paragraph style's spacing apply */
  top: boolean;
  /** Text color override (quotes) */
  color?: string;
  /** The paragraphs' base character shape and size, when not the body style's (table cells) */
  char?: CharShape;
}

class HwpxWriter {
  private header = new HeaderBuilder();
  private images: PackageImage[] = [];
  private imageIds = new Map<string, { id: string; image: ExportImage }>();
  private styleIds = {} as Record<StyleKey, number>;
  private nextId = 1;
  private sectionStarted = false;
  /** The space below what was written last, which the editor's margins would collapse with the next one's. */
  private lastAfter = 0;
  /** The table that nothing has followed yet */
  private lastTable: number | null = null;
  /** The room below each table in pt, which the paragraph after it can add to */
  private roomBelow = new Map<number, number>();
  private otherForm = 0;
  private asSource = 0;
  private missingFigures = 0;
  /** The document's page */
  private readonly page: PageBox;

  constructor(
    private readonly input: HwpxExportInput,
    private readonly assets: WriterAssets,
    private readonly report: ProgressReport
  ) {
    this.page = pageBox(input.format.page);
    for (const key of STYLE_ORDER) {
      const name = STYLE_NAMES[key];
      this.styleIds[key] = this.header.style(
        name[0],
        name[1],
        this.header.paraPr(this.styleShape(key)),
        this.header.charPr(this.charShape(this.def(key)))
      );
    }
  }

  private get format(): PaperFormat {
    return this.input.format;
  }

  private def(key: StyleKey): TextStyleDef {
    return this.format.styles[key];
  }

  private charShape(def: TextStyleDef): CharShape {
    return {
      latinFont: LATIN_FONTS[def.latinFont].label,
      koreanFont: KOREAN_FONTS[def.koreanFont].label,
      size: def.size,
      bold: def.bold,
      italic: def.italic,
      color: def.color,
      caps: def.textCase !== "normal" || undefined,
    };
  }

  /**
   * Spacing as in the editor, where a paragraph's top and bottom margins collapse into the larger one. Hancom
   * adds them, so a style's space before only holds what exceeds the body's space after.
   */
  private spaceBefore(pts: number): number {
    return Math.max(0, pts - this.def("body").spaceAfter);
  }

  /** The same for a block in its place: what its top margin adds to the space that's already there. */
  private collapsed(pts: number): number {
    return Math.max(0, pts - this.lastAfter);
  }

  private styleShape(key: StyleKey): ParaShape {
    const def = this.def(key);
    const level = key === "heading1" ? 0 : key === "heading2" ? 1 : key === "heading3" ? 2 : null;
    return {
      align: def.align,
      lineHeight: def.lineHeight,
      before: this.spaceBefore(def.spaceBefore),
      after: def.spaceAfter,
      indent: def.indent,
      ...(level === null ? {} : { heading: outlineHeading(level), keepWithNext: true, keepLines: true }),
    };
  }

  private id(): number {
    return this.nextId++;
  }

  // ---------------------------------------------------------------- paragraphs and runs

  private paragraph(key: StyleKey, shape: ParaShape, runs: string): string {
    const start = this.sectionStarted ? "" : `<hp:run charPrIDRef="0">${sectionStart(this.page)}</hp:run>`;
    this.sectionStarted = true;
    this.lastAfter = shape.after ?? 0;
    // A table pushes the next paragraph down from where it begins, which uses up the space above it. The table leaves that room instead.
    let own = shape;
    if (this.lastTable !== null && shape.before) {
      this.roomBelow.set(this.lastTable, this.roomBelow.get(this.lastTable)! + shape.before);
      own = { ...shape, before: 0 };
    }
    this.lastTable = null;
    return (
      `<hp:p id="${this.id()}" paraPrIDRef="${this.header.paraPr(own)}" styleIDRef="${this.styleIds[key]}" ` +
      `pageBreak="0" columnBreak="0" merged="0">${start}${runs}</hp:p>`
    );
  }

  private run(char: CharShape, inner: string): string {
    return `<hp:run charPrIDRef="${this.header.charPr(char)}">${inner}</hp:run>`;
  }

  /** The run holding a text: line feeds and tabs are elements of their own. */
  private textRun(char: CharShape, text: string): string {
    const inner = text
      .split(/(\n|\t)/)
      .map((part) =>
        part === "\n"
          ? "<hp:lineBreak/>"
          : part === "\t"
            ? '<hp:tab width="1000" leader="0" type="1"/>'
            : escapeXml(char.caps ? part.toUpperCase() : part)
      )
      .join("");
    return this.run(char, `<hp:t>${inner}</hp:t>`);
  }

  private withMarks(base: CharShape, marks: JSONContent["marks"]): CharShape {
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

  private async inline(nodes: JSONContent[] | undefined, base: CharShape): Promise<string> {
    let out = "";
    /** The open hyperlink field */
    let link: { id: number; href: string } | null = null;
    const closeLink = (char: CharShape) => {
      if (!link) return;
      out += this.run(char, `<hp:ctrl><hp:fieldEnd beginIDRef="${link.id}" fieldid="${link.id}"/></hp:ctrl>`);
      link = null;
    };
    for (const node of nodes ?? []) {
      const char = this.withMarks(base, node.marks);
      const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href as string | undefined;
      if (link && link.href !== href) closeLink(base);
      if (href && !link) {
        link = { id: this.id(), href };
        out += this.run(char, hyperlinkBegin(link.id, href));
      }
      switch (node.type) {
        case "text":
          out += this.textRun(char, node.text ?? "");
          break;
        case "hardBreak":
          out += this.textRun(char, "\n");
          break;
        case "mathInline":
          out += await this.math(String(node.attrs?.latex ?? ""), false, char);
          break;
        case "citation":
          out += this.textRun(
            char,
            citationText(parseRefIds(node.attrs?.refs), this.input.citations, {
              mode: node.attrs?.mode === "narrative" ? "narrative" : "paren",
              locator: String(node.attrs?.locator ?? ""),
            })
          );
          break;
        case "crossRef":
          out += this.textRun(char, this.crossRefText(String(node.attrs?.target ?? "")));
          break;
      }
    }
    closeLink(base);
    return out;
  }

  private crossRefText(targetId: string): string {
    const target = this.input.objectsById.get(targetId);
    return target?.number ? referenceText(target.kind, target.number, this.format, target.appendix) : "??";
  }

  /** A caption or other plain text in which `$…$` is math. */
  private async textWithMath(text: string, char: CharShape): Promise<string> {
    let out = "";
    for (const part of splitInlineMath(text)) {
      out += part.math ? await this.math(part.text, false, char) : this.textRun(char, part.text);
    }
    return out;
  }

  // ---------------------------------------------------------------- equations

  private equationObject(script: string, char: CharShape, display: boolean): string {
    const size = Math.round(char.size * HWPUNIT_PER_PT * (display ? DISPLAY_EQUATION_SCALE : 1));
    // baseLine 0 makes Hancom measure the equation when it opens the file; it keeps any other size as stored.
    return (
      `<hp:equation id="${this.id()}" zOrder="${this.id()}" numberingType="EQUATION" textWrap="TOP_AND_BOTTOM" ` +
      'textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" version="Equation Version 60" baseLine="0" ' +
      `textColor="${char.color || "#000000"}" baseUnit="${size}" lineMode="CHAR" font="HancomEQN">` +
      `<hp:sz width="${Math.min(this.page.textWidth, script.length * Math.round(size / 3))}" widthRelTo="ABSOLUTE" ` +
      `height="${Math.round(size * 1.5)}" heightRelTo="ABSOLUTE" protect="0"/>${INLINE_POSITION}` +
      '<hp:outMargin left="56" right="56" top="0" bottom="0"/><hp:shapeComment>수식입니다.</hp:shapeComment>' +
      `<hp:script>${escapeXml(script)}</hp:script></hp:equation>`
    );
  }

  /** The formula in the chosen form, else the other one, else its LaTeX source. */
  private async math(latex: string, display: boolean, char: CharShape, maxWidth = this.page.textWidth): Promise<string> {
    if (!latex.trim()) return "";
    const wantImage = this.input.equations === "image";
    const asImage = async () => {
      const image = await this.equationImage(latex, display, char);
      return image && this.run(char, this.pictureObject(image, maxWidth));
    };
    const asNative = () => {
      const script = latexToHwpEquation(latex, display);
      return script && this.run(char, this.equationObject(script, char, display));
    };
    const first = wantImage ? await asImage() : asNative();
    if (first) return first;
    const second = wantImage ? asNative() : await asImage();
    if (second) {
      this.otherForm++;
      return second;
    }
    this.asSource++;
    return this.textRun({ ...char, latinFont: MONO_FONT }, latex);
  }

  private async equationImage(latex: string, display: boolean, char: CharShape) {
    const key = `equation|${display}|${char.size}|${char.color ?? ""}|${latex}`;
    return this.registered(key, () =>
      this.assets.equationImage({ latex, display, size: char.size, color: char.color || "#000000" })
    );
  }

  // ---------------------------------------------------------------- pictures

  /** The image once in the package, however often it is used */
  private async registered(key: string, load: () => ExportImage | null | Promise<ExportImage | null>) {
    const known = this.imageIds.get(key);
    if (known) return known;
    const image = await load();
    if (!image) return null;
    const n = this.images.length + 1;
    const entry = { id: `image${n}`, image };
    this.images.push({
      id: entry.id,
      path: `BinData/image${n}.${image.extension}`,
      mediaType: image.mediaType,
      data: image.data,
    });
    this.imageIds.set(key, entry);
    return entry;
  }

  /** At its natural size unless `width` is given, shrunk to fit `maxWidth` and the page height */
  private pictureObject(
    entry: { id: string; image: ExportImage },
    maxWidth: number,
    width = entry.image.width * HWPUNIT_PER_PX
  ): string {
    const { image, id } = entry;
    const scale = Math.min(1, maxWidth / width, this.page.textHeight / ((width * image.height) / image.width));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round((w * image.height) / image.width));
    const natural = {
      w: Math.round(image.width * HWPUNIT_PER_PX),
      h: Math.round(image.height * HWPUNIT_PER_PX),
    };
    const identity = 'e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"';
    // The line is laid out by the picture's box; this moves the drawing inside it onto the baseline.
    const shift = image.descent === undefined ? 0 : Math.round(((image.descent * h) / image.height) - PICTURE_BASELINE * h);
    return (
      `<hp:pic id="${this.id()}" zOrder="${this.id()}" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" ` +
      `lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${this.id()}" reverse="0">` +
      `<hp:offset x="0" y="0"/><hp:orgSz width="${natural.w}" height="${natural.h}"/><hp:curSz width="${w}" height="${h}"/>` +
      `<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/>` +
      `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="${shift}"/><hc:scaMatrix ${identity}/><hc:rotMatrix ${identity}/></hp:renderingInfo>` +
      `<hc:img binaryItemIDRef="${id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${natural.w}" y="0"/><hc:pt2 x="${natural.w}" y="${natural.h}"/><hc:pt3 x="0" y="${natural.h}"/></hp:imgRect>` +
      `<hp:imgClip left="0" right="${natural.w}" top="0" bottom="${natural.h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
      `<hp:imgDim dimwidth="${natural.w}" dimheight="${natural.h}"/><hp:effects/>` +
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>${INLINE_POSITION}` +
      '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment/></hp:pic>'
    );
  }

  // ---------------------------------------------------------------- blocks

  private async blocks(nodes: JSONContent[] | undefined, env: BlockEnv): Promise<string> {
    let out = "";
    for (const node of nodes ?? []) out += await this.block(node, env);
    return out;
  }

  private bodyChar(env: BlockEnv): CharShape {
    const char = env.char ?? this.charShape(this.def("body"));
    return env.color ? { ...char, color: env.color } : char;
  }

  private alignOf(node: JSONContent, fallback: ParaAlign): ParaAlign {
    return isTextAlign(node.attrs?.textAlign) ? node.attrs!.textAlign : fallback;
  }

  /** The top margin of blocks that aren't paragraphs. Only those directly on the page have one. */
  private gapBefore(env: BlockEnv): number {
    return env.top ? this.collapsed(BLOCK_GAP * this.def("body").size) : 0;
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
        return this.rule(this.collapsed(18), 18, env);
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
    const char = this.bodyChar(env);
    const shape: ParaShape = env.top
      ? { ...this.styleShape("body"), align: this.alignOf(node, def.align) }
      : { align: this.alignOf(node, env.char ? "left" : def.align), lineHeight: def.lineHeight, left: env.left };
    return this.paragraph("body", shape, (await this.inline(node.content, char)) || this.run(char, ""));
  }

  private async heading(node: JSONContent): Promise<string> {
    const level = Math.min(3, Number(node.attrs?.level ?? 1));
    const key = `heading${level}` as StyleKey;
    const char = this.charShape(this.def(key));
    const number = this.input.objectsById.get(String(node.attrs?.id ?? ""))?.shown;
    const shape = {
      ...this.styleShape(key),
      align: this.alignOf(node, this.def(key).align),
      before: this.collapsed(this.def(key).spaceBefore),
    };
    return this.paragraph(
      key,
      shape,
      (number ? this.textRun(char, `${number}  `) : "") + (await this.inline(node.content, char))
    );
  }

  private async list(node: JSONContent, env: BlockEnv, level: number, first = true): Promise<string> {
    const def = this.def("body");
    const ordered = node.type === "orderedList";
    const start = Number(node.attrs?.start ?? 1) || 1;
    const digits = String(start + (node.content?.length ?? 1) - 1).length;
    const id = ordered
      ? this.header.numbering(start, Math.max(0, digits - 2) * def.size * 0.55)
      : this.header.bullet(BULLETS[Math.min(level, BULLETS.length - 1)]);
    const left = env.left + LIST_INDENT;
    const itemEnv: BlockEnv = { ...env, top: false, left, width: env.width - LIST_INDENT * HWPUNIT_PER_PT };
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
          const char = this.bodyChar(env);
          const shape: ParaShape = {
            align: this.alignOf(child, def.align),
            lineHeight: def.lineHeight,
            // The marker starts here, and Hancom indents the text past it by about as much as the editor does.
            left: env.left,
            before: isFirst ? this.gapBefore(env) : 0,
            after: itemSpace,
            heading: { type: ordered ? "NUMBER" : "BULLET", id, level: ordered ? level : 0 },
          };
          isFirst = false;
          out += this.paragraph("body", shape, (await this.inline(child.content, char)) || this.run(char, ""));
        } else {
          out += await this.block(child, itemEnv);
        }
      }
    }
    return out;
  }

  private codeBlock(node: JSONContent, env: BlockEnv): string {
    const text = (node.content ?? []).map((child) => child.text ?? "").join("");
    const char: CharShape = { ...this.charShape(this.def("body")), latinFont: MONO_FONT, size: pt(14), bold: false, italic: false };
    const body = this.def("body");
    const top = this.gapBefore(env);
    return this.box(env, {
      content: this.paragraph("body", { align: "left", lineHeight: 1.5 }, this.textRun(char, text)),
      fill: this.header.borderFill({ fill: MUTED_FILL }),
      padding: { left: pt(12), right: pt(12), top: pt(12), bottom: pt(12) },
      top,
      // The next line starts right below, without the half of its leading that the editor has above the text.
      bottom: (body.size * (body.lineHeight - 1)) / 2,
      split: true,
    });
  }

  private async quote(node: JSONContent, env: BlockEnv): Promise<string> {
    const top = this.gapBefore(env);
    const padding = pt(16);
    // What's inside isn't pushed down by a table before it.
    this.lastTable = null;
    const content = await this.blocks(node.content, {
      ...env,
      top: false,
      left: 0,
      width: env.width - padding * HWPUNIT_PER_PT,
      color: MUTED_TEXT,
    });
    return this.box(env, {
      content,
      fill: this.header.borderFill({ left: QUOTE_LINE, fill: "none" }),
      padding: { ...NO_PADDING, left: padding },
      top,
      bottom: 0,
      split: true,
    });
  }

  /** A horizontal line */
  private rule(
    top: number,
    bottom: number,
    env: Pick<BlockEnv, "left" | "width"> = { left: 0, width: this.page.textWidth }
  ): string {
    return this.box(env, {
      content: "",
      fill: this.header.borderFill({ top: RULE_LINE, fill: "none" }),
      padding: NO_PADDING,
      top,
      bottom,
      split: false,
    });
  }

  /**
   * A table of one cell. A paragraph can't do this: its border and fill take in its spacing, ignore its left margin
   * and leave no distance to what's around them.
   */
  private box(
    env: Pick<BlockEnv, "left" | "width">,
    box: { content: string; fill: number; padding: Padding; top: number; bottom: number; split: boolean }
  ): string {
    const tiny: CharShape = { ...this.charShape(this.def("body")), size: 1 };
    const cell = tableCell({
      content: box.content || this.paragraph("body", { align: "left", lineHeight: 1 }, this.run(tiny, "")),
      fill: box.fill,
      header: false,
      col: 0,
      row: 0,
      colSpan: 1,
      rowSpan: 1,
      width: env.width,
      height: 0,
      padding: box.padding,
    });
    return this.tableParagraph(
      {
        rows: 1,
        cols: 1,
        width: env.width,
        fill: this.header.plainFill,
        repeatHeader: false,
        padding: box.padding,
        left: env.left,
        top: box.top,
        bottom: box.bottom,
        split: box.split,
      },
      `<hp:tr>${cell}</hp:tr>`
    );
  }

  /** The paragraph a table belongs to. It takes no room of its own, as tables go around their text. */
  private tableParagraph(table: TableObject, rows: string, keepWithNext = false): string {
    const id = this.id();
    const paragraph = this.paragraph(
      "body",
      { align: "left", lineHeight: 1, keepWithNext },
      this.run({ ...this.charShape(this.def("body")), size: 1 }, tableObject(id, this.id(), table, rows))
    );
    this.lastAfter = table.bottom;
    this.lastTable = id;
    this.roomBelow.set(id, table.bottom);
    return paragraph;
  }

  private async displayEquation(node: JSONContent, env: BlockEnv): Promise<string> {
    const def = this.def("body");
    const char = this.bodyChar(env);
    const object = this.input.objectsById.get(String(node.attrs?.id ?? ""));
    const number = object?.number ? equationNumberText(object.number, this.format.equation.brackets) : "";
    const spacing = { lineHeight: def.lineHeight, before: this.gapBefore(env) + def.size / 4, after: def.size / 4, keepLines: true };
    const latex = String(node.attrs?.latex ?? "");
    // With a number: centred on a tab stop, the number on a tab at the right edge
    if (number && env.top) {
      const room = this.page.textWidth - (number.length + 2) * char.size * HWPUNIT_PER_PT;
      const equation = await this.math(latex, true, char, room);
      return this.paragraph(
        "body",
        { ...spacing, align: "left", tab: TAB_EQUATION },
        this.textRun(char, "\t") + equation + this.textRun(char, `\t${number}`)
      );
    }
    const equation = await this.math(latex, true, char, env.width);
    return this.paragraph(
      "body",
      { ...spacing, align: "center", left: env.left },
      equation + (number ? this.textRun(char, `  ${number}`) : "")
    );
  }

  /** "Figure 1. caption" in the caption style */
  private async caption(
    format: FloatFormat,
    object: NumberedObject | undefined,
    text: string,
    spacing: Pick<ParaShape, "before" | "after" | "keepWithNext">
  ): Promise<string> {
    const def = this.def("caption");
    const char = this.charShape(def);
    const label = object?.number ? captionLabelText(format, object.number) : "";
    const runs =
      (label ? this.textRun(format.labelBold ? { ...char, bold: true } : char, label) : "") +
      (label && text ? this.textRun(char, " ") : "") +
      (await this.textWithMath(text, char));
    return this.paragraph("caption", { ...this.styleShape("caption"), ...spacing }, runs || this.run(char, ""));
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
    const char = this.charShape(this.def("body"));
    const pictureParagraph = async () => {
      const before = above ? 0 : this.collapsed(margin);
      const picture = await this.figurePicture(attrs);
      return this.paragraph(
        "body",
        { align: "center", lineHeight: 1, before, after: above ? margin : 0, keepWithNext: !above },
        picture ? this.run(char, picture) : this.textRun({ ...char, color: "#DC2626" }, "[그림을 넣지 못했습니다]")
      );
    };
    if (above) {
      const captionEl = await this.caption(format, object, captionText, {
        before: this.collapsed(margin + caption.spaceBefore),
        after: caption.spaceAfter,
        keepWithNext: true,
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

  private async figurePicture(attrs: Record<string, unknown>): Promise<string | null> {
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
    return this.pictureObject(entry, textWidth, width > 0 ? (textWidth * width) / 100 : undefined);
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
        before: this.collapsed(margin + caption.spaceBefore),
        after: caption.spaceAfter,
        keepWithNext: true,
      });
      return captionEl + (await this.table(table, env, { top: 0, bottom: margin }));
    }
    const tableEl = await this.table(table, env, { top: this.collapsed(margin), bottom: 0, keepWithNext: true });
    return (
      tableEl +
      (await this.caption(format, object, captionText, {
        before: caption.spaceBefore,
        after: caption.spaceAfter + margin,
      }))
    );
  }

  // ---------------------------------------------------------------- tables

  private async table(
    node: JSONContent,
    env: BlockEnv,
    spacing: { top: number; bottom: number; keepWithNext?: boolean }
  ): Promise<string> {
    // What's inside isn't pushed down by a table before it.
    this.lastTable = null;
    const layout = layoutTable(node);
    const def = this.def("body");
    const size = Math.round(def.size * 95) / 100;
    const widths = columnWidths(layout, size, env.width);
    const char: CharShape = { ...this.charShape(def), size };
    let tr = "";
    for (const row of layout.rows) {
      let cells = "";
      const rowHeight = Number(row.node.attrs?.height ?? 0) * HWPUNIT_PER_PX;
      for (const cell of row.cells) {
        const header = cell.node.type === "tableHeader";
        const lastRow = cell.row + cell.rowSpan >= layout.rows.length;
        const fill = this.header.borderFill({
          top: cell.row === 0 ? TABLE_EDGE : undefined,
          bottom: lastRow ? TABLE_EDGE : header ? TABLE_HEADER_LINE : TABLE_ROW_LINE,
          fill: "none",
        });
        const width = widths.slice(cell.col, cell.col + cell.colSpan).reduce((sum, w) => sum + w, 0);
        const cellEnv: BlockEnv = {
          left: 0,
          top: false,
          width: width - (CELL_PADDING.left + CELL_PADDING.right) * HWPUNIT_PER_PT,
          char: header ? { ...char, bold: true } : char,
        };
        const content = (await this.blocks(cell.node.content, cellEnv)) || this.paragraph("body", { align: "left", lineHeight: def.lineHeight }, this.run(char, ""));
        cells += tableCell({
          content,
          fill,
          header: row.header,
          col: cell.col,
          row: cell.row,
          colSpan: cell.colSpan,
          rowSpan: cell.rowSpan,
          width,
          height: rowHeight,
          padding: CELL_PADDING,
        });
      }
      tr += `<hp:tr>${cells}</hp:tr>`;
    }
    return this.tableParagraph(
      {
        rows: layout.rows.length,
        cols: layout.columns,
        width: widths.reduce((sum, w) => sum + w, 0),
        fill: this.header.plainFill,
        repeatHeader: layout.rows[0]?.header ?? false,
        padding: CELL_PADDING,
        top: spacing.top,
        bottom: spacing.bottom,
        split: true,
      },
      tr,
      spacing.keepWithNext
    );
  }

  /** Authors side by side in a borderless table, as in the editor: name, affiliation and e-mail in a column */
  private authors(): string {
    const authors = this.input.authors.filter((a) => a.name || a.affiliation || a.email);
    if (authors.length === 0) return "";
    const body = this.charShape(this.def("body"));
    const line = (text: string, char: CharShape) =>
      text ? this.paragraph("body", { align: "center", lineHeight: 1.4 }, this.textRun(char, text)) : "";
    const columns = Math.min(AUTHORS_PER_ROW, authors.length);
    const width = Math.floor(this.page.textWidth / columns);
    let tr = "";
    const rowCount = Math.ceil(authors.length / columns);
    for (let row = 0; row < rowCount; row++) {
      let cells = "";
      for (let col = 0; col < columns; col++) {
        const author = authors[row * columns + col];
        const content = author
          ? line(author.name, { ...body, size: pt(14), italic: false, bold: true }) +
            line(author.affiliation, { ...body, size: pt(12), italic: false, bold: false, color: MUTED_TEXT }) +
            line(author.email, { ...body, latinFont: MONO_FONT, size: pt(11), italic: false, bold: false, color: MUTED_TEXT })
          : "";
        cells += tableCell({
          content: content || this.paragraph("body", { align: "center", lineHeight: 1 }, this.run(body, "")),
          fill: this.header.plainFill,
          header: false,
          col,
          row,
          colSpan: 1,
          rowSpan: 1,
          width,
          height: 0,
          padding: CELL_PADDING,
        });
      }
      tr += `<hp:tr>${cells}</hp:tr>`;
    }
    return this.tableParagraph(
      {
        rows: rowCount,
        cols: columns,
        width: width * columns,
        fill: this.header.plainFill,
        repeatHeader: false,
        padding: CELL_PADDING,
        top: 0,
        bottom: 0,
        split: true,
      },
      tr
    );
  }

  private references(): string {
    const { citations } = this.input;
    const entries = citations.entries.filter((e) => e.listed);
    if (entries.length === 0) return "";
    const key = "heading1";
    const titleChar = this.charShape(this.def(key));
    const def = this.def("references");
    const char = this.charShape(def);
    // Author-date lists have no labels and a hanging indent of 0.5 in (APA).
    const hanging = isAuthorDate(citations.style);
    const items = entries.map((entry) => {
      const runs = formatReferenceAs(entry.ref, citations.style, citations)
        .map((segment) => this.textRun(segment.italic ? { ...char, italic: true } : char, segment.text))
        .join("");
      return this.paragraph(
        "references",
        {
          ...this.styleShape("references"),
          before: 0,
          indent: -(hanging ? APA_HANGING_INDENT : REFERENCE_INDENT),
          ...(hanging ? {} : { tab: TAB_HANGING }),
          keepLines: true,
        },
        (hanging ? "" : this.textRun(char, `${entryLabel(entry, citations.style)}\t`)) + runs
      );
    });
    return (
      this.rule(pt(48), pt(24)) +
      this.paragraph(key, { ...this.styleShape(key), before: 0 }, this.textRun(titleChar, this.format.references.title)) +
      items.join("")
    );
  }

  /** The text of the document, which is also what asks for all its images */
  async section(): Promise<string> {
    const { title, content } = this.input;
    const titleDef = this.def("title");
    const titleChar = this.charShape(titleDef);
    const titleParagraph = this.paragraph(
      "title",
      { ...this.styleShape("title"), after: pt(12) },
      this.textRun(titleChar, title)
    );
    const authorTable = this.authors();
    const rule = this.rule(pt(24), pt(32));
    const nodes = content.content ?? [];
    const work = nodes.reduce((sum, node) => sum + workOf(node), 0);
    let done = 0;
    let body = "";
    for (const node of nodes) {
      body += await this.block(node, { left: 0, top: true, width: this.page.textWidth });
      done += workOf(node);
      await this.report(done / work);
    }
    return (titleParagraph + authorTable + rule + body + this.references()).replace(
      / bottom="@(\d+)"/g,
      (_, id) => ` bottom="${hwpUnits(this.roomBelow.get(Number(id))!)}"`
    );
  }

  async write(): Promise<HwpxExportResult> {
    const { title, authors } = this.input;
    const body = await this.section();
    return {
      data: buildPackage({
        header: this.header.toXml(this.page.textWidth),
        body,
        title,
        creator: authors.map((a) => a.name).filter(Boolean).join(", "),
        images: this.images,
      }),
      otherForm: this.otherForm,
      asSource: this.asSource,
      missingFigures: this.missingFigures,
    };
  }
}

const INLINE_POSITION =
  '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" ' +
  'horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>';

/** The start of a hyperlink field; ":" is escaped in its command, and the numbers are its display options. */
function hyperlinkBegin(id: number, href: string): string {
  const command = `${href.replace(/\\/g, "\\\\").replace(/:/g, "\\:")};1;0;0;`;
  return (
    `<hp:ctrl><hp:fieldBegin id="${id}" type="HYPERLINK" name="" editable="0" dirty="1" zorder="-1" fieldid="${id}">` +
    '<hp:parameters cnt="2" name=""><hp:integerParam name="Prop">0</hp:integerParam>' +
    `<hp:stringParam name="Command">${escapeXml(command)}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>`
  );
}

function tableCell(cell: {
  content: string;
  fill: number;
  header: boolean;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  width: number;
  height: number;
  padding: Padding;
}): string {
  return (
    `<hp:tc name="" header="${cell.header ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${cell.fill}">` +
    '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" ' +
    `textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${cell.content}</hp:subList>` +
    `<hp:cellAddr colAddr="${cell.col}" rowAddr="${cell.row}"/><hp:cellSpan colSpan="${cell.colSpan}" rowSpan="${cell.rowSpan}"/>` +
    `<hp:cellSz width="${cell.width}" height="${Math.round(cell.height)}"/>` +
    `<hp:cellMargin ${margins(cell.padding)}/></hp:tc>`
  );
}

function hwpUnits(pts: number): number {
  return Math.round(pts * HWPUNIT_PER_PT);
}

function margins(padding: Padding): string {
  return (
    `left="${hwpUnits(padding.left)}" right="${hwpUnits(padding.right)}" ` +
    `top="${hwpUnits(padding.top)}" bottom="${hwpUnits(padding.bottom)}"`
  );
}

interface TableObject {
  rows: number;
  cols: number;
  width: number;
  fill: number;
  repeatHeader: boolean;
  padding: Padding;
  left?: number;
  top: number;
  bottom: number;
  split: boolean;
}

/**
 * A table that goes around its text rather than inside a line, as only that one can continue on the next page.
 * `left` in pt places it from the left edge, or else it's centred. `split` also lets a row continue there, as
 * nothing could show the rest of a row taller than a page. The room below it is filled in at the end, as the
 * paragraph after it adds to it.
 */
function tableObject(id: number, order: number, table: TableObject, rows: string): string {
  const position =
    '<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" ' +
    `horzRelTo="COLUMN" vertAlign="TOP" horzAlign="${table.left === undefined ? "CENTER" : "LEFT"}" vertOffset="0" ` +
    `horzOffset="${Math.round((table.left ?? 0) * HWPUNIT_PER_PT)}"/>`;
  return (
    `<hp:tbl id="${id}" zOrder="${order}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" ` +
    `lock="0" dropcapstyle="None" pageBreak="${table.split ? "CELL" : "NONE"}" repeatHeader="${table.repeatHeader ? 1 : 0}" rowCnt="${table.rows}" ` +
    `colCnt="${table.cols}" cellSpacing="0" borderFillIDRef="${table.fill}" noAdjust="0">` +
    `<hp:sz width="${table.width}" widthRelTo="ABSOLUTE" height="0" heightRelTo="ABSOLUTE" protect="0"/>${position}` +
    `<hp:outMargin left="0" right="0" top="${hwpUnits(table.top)}" bottom="@${id}"/><hp:inMargin ${margins(table.padding)}/>` +
    `${rows}</hp:tbl>`
  );
}

export interface TableLayout {
  columns: number;
  rows: {
    node: JSONContent;
    header: boolean;
    cells: { node: JSONContent; col: number; row: number; colSpan: number; rowSpan: number }[];
  }[];
}

/** Puts the cells on the grid that merged cells make. */
export function layoutTable(table: JSONContent): TableLayout {
  const taken = new Set<string>();
  let columns = 0;
  const rows = (table.content ?? []).map((row, r) => {
    let col = 0;
    const cells = (row.content ?? []).map((cell) => {
      while (taken.has(`${r}:${col}`)) col++;
      const colSpan = Math.max(1, Number(cell.attrs?.colspan ?? 1));
      const rowSpan = Math.max(1, Number(cell.attrs?.rowspan ?? 1));
      for (let y = r; y < r + rowSpan; y++) {
        for (let x = col; x < col + colSpan; x++) taken.add(`${y}:${x}`);
      }
      const placed = { node: cell, col, row: r, colSpan, rowSpan };
      col += colSpan;
      columns = Math.max(columns, col);
      return placed;
    });
    return { node: row, header: cells.length > 0 && cells.every((c) => c.node.type === "tableHeader"), cells };
  });
  return { columns, rows };
}

function textOf(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "mathInline") return "x".repeat(Math.ceil(String(node.attrs?.latex ?? "").length / 2));
  return (node.content ?? []).map(textOf).join(node.type === "paragraph" ? "\n" : "");
}

/** Width of a text on one line in em: full-width characters are one em, others about half. */
function textEm(text: string): number {
  let em = 0;
  for (const char of text) em += char.charCodeAt(0) > 0x2e7f ? 1 : 0.5;
  return em;
}

/**
 * Column widths in HWPUNIT. Columns the user sized keep their width; as the editor's tables are as wide as
 * their content, the others are estimated from it. The table is scaled down if it's wider than the page.
 */
export function columnWidths(layout: TableLayout, size: number, available: number): number[] {
  const px = new Array<number>(layout.columns).fill(TABLE_MIN_COLUMN_PX);
  const fixed = new Array<boolean>(layout.columns).fill(false);
  for (const row of layout.rows) {
    for (const cell of row.cells) {
      const set = cell.node.attrs?.colwidth as (number | null)[] | null | undefined;
      for (let i = 0; i < cell.colSpan; i++) {
        const width = set?.[i];
        if (width) {
          px[cell.col + i] = width;
          fixed[cell.col + i] = true;
        }
      }
      if (cell.colSpan === 1 && !fixed[cell.col]) {
        const lines = textOf(cell.node).split("\n");
        const em = Math.max(...lines.map(textEm));
        px[cell.col] = Math.max(px[cell.col], ((em * size * 4) / 3) * 1.05 + ((CELL_PADDING.left + CELL_PADDING.right) * 4) / 3);
      }
    }
  }
  const units = px.map((w) => w * HWPUNIT_PER_PX);
  const scale = Math.min(1, available / units.reduce((sum, w) => sum + w, 0));
  return units.map((w) => Math.round(w * scale));
}

/** Roughly how much a block has to write: how many nodes it's made of. */
export function workOf(node: JSONContent): number {
  return (node.content ?? []).reduce((sum, child) => sum + workOf(child), 1);
}

/** Not after every step, as giving the browser time takes time. */
export function progressReport(onProgress?: (fraction: number) => void): ProgressReport {
  let last = 0;
  return async (fraction) => {
    const now = Date.now();
    if (!onProgress || (fraction < 1 && now - last < PROGRESS_INTERVAL_MS)) return;
    last = now;
    onProgress(fraction);
    await new Promise((resolve) => setTimeout(resolve));
  };
}

export function equationKey(request: EquationRequest): string {
  return JSON.stringify([request.latex, request.display, request.size, request.color]);
}

/** `onProgress` gets how much is done, from 0 to 1. */
export async function exportHwpx(
  input: HwpxExportInput,
  assets: HwpxAssets,
  onProgress?: (fraction: number) => void
): Promise<HwpxExportResult> {
  const report = progressReport(onProgress);
  // Formulas get drawn together, so a first run through the document finds out which ones it takes.
  const requests = new Map<string, EquationRequest>();
  await new HwpxWriter(
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
  ).section();
  const list = [...requests.values()];
  const drawing = list.length * EQUATION_WORK;
  const work = (input.content.content ?? []).reduce((sum, node) => sum + workOf(node), 0);
  const share = drawing > 0 ? drawing / (drawing + work) : 0;
  const images = drawing > 0 ? await assets.equationImages(list, (fraction) => report(fraction * share)) : [];
  const drawn = new Map(list.map((request, i) => [equationKey(request), images[i]]));
  return new HwpxWriter(
    input,
    { ...assets, equationImage: (request) => drawn.get(equationKey(request)) ?? null },
    (fraction) => report(share + fraction * (1 - share))
  ).write();
}
