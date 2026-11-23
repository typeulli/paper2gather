/**
 * Writing the parts of a Word (.docx, WordprocessingML) package. Lengths are pt unless a name says otherwise;
 * Word stores twips (1/20 pt), half-points for font sizes, eighths of a point for borders and EMU for drawings.
 * Word reads elements in the order of the schema, so every builder here keeps that order.
 */
import { strToU8, zipSync } from "fflate";
import { escapeXml } from "@/lib/hwpx/owpml";
import type { PageFormat, PaperSize } from "@/lib/paper/format";

export const EMU_PER_PT = 12700;
/** A CSS px at 96 dpi */
export const EMU_PER_PX = 9525;

/** Word's own paper sizes, in pt */
const PAPER: Record<PaperSize, { width: number; height: number }> = {
  a4: { width: 595.3, height: 841.9 },
  letter: { width: 612, height: 792 },
};

const PT_PER_MM = 72 / 25.4;

/** The document's page, in pt */
export interface PageBox {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  textWidth: number;
  textHeight: number;
}

export function pageBox(page: PageFormat): PageBox {
  const { width, height } = PAPER[page.paper];
  const [top, right, bottom, left] = [page.marginTop, page.marginRight, page.marginBottom, page.marginLeft].map(
    (mm) => mm * PT_PER_MM
  );
  return { width, height, top, right, bottom, left, textWidth: width - left - right, textHeight: height - top - bottom };
}

export function twips(pt: number): number {
  return Math.round(pt * 20);
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  m: "http://schemas.openxmlformats.org/officeDocument/2006/math",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  w15: "http://schemas.microsoft.com/office/word/2012/wordml",
};

function namespaces(...prefixes: (keyof typeof NS)[]): string {
  return prefixes.map((prefix) => `xmlns:${prefix}="${NS[prefix]}"`).join(" ");
}

// ---------------------------------------------------------------- characters

export interface RunFormat {
  latinFont: string;
  koreanFont: string;
  /** pt */
  size: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  /** #rrggbb; automatic if empty */
  color?: string;
  /** #rrggbb background */
  shade?: string;
  /** Raised (or lowered, if negative) by this many pt */
  raise?: number;
  /** Shown in capitals or small capitals */
  caps?: "upper" | "small";
}

const halfPoints = (pt: number) => Math.max(2, Math.round(pt * 2));

const toggle = (name: string, on: boolean | undefined) => (on ? `<w:${name}/>` : `<w:${name} w:val="0"/>`);

/**
 * The properties of a run: all of them, or with `base` (the paragraph style's) only those that differ from it, so
 * that the text follows its style when that is changed in Word.
 */
export function runProps(format: RunFormat, base?: RunFormat): string {
  /** Whether a property is written: without a base only what is set, with one what differs from it */
  const flag = (key: "bold" | "italic" | "strike" | "underline") =>
    base ? !!format[key] !== !!base[key] : !!format[key];
  let out = "";
  const latin = !base || format.latinFont !== base.latinFont;
  const korean = !base || format.koreanFont !== base.koreanFont;
  if (latin || korean) {
    const l = escapeXml(format.latinFont);
    out +=
      "<w:rFonts" +
      (latin ? ` w:ascii="${l}" w:hAnsi="${l}" w:cs="${l}"` : "") +
      (korean ? ` w:eastAsia="${escapeXml(format.koreanFont)}"` : "") +
      "/>";
  }
  if (flag("bold")) out += toggle("b", format.bold) + toggle("bCs", format.bold);
  if (flag("italic")) out += toggle("i", format.italic) + toggle("iCs", format.italic);
  if (base ? format.caps !== base.caps : format.caps) {
    if (format.caps === "upper" || base?.caps === "upper") out += toggle("caps", format.caps === "upper");
    if (format.caps === "small" || base?.caps === "small") out += toggle("smallCaps", format.caps === "small");
  }
  if (flag("strike")) out += toggle("strike", format.strike);
  if ((format.color || "") !== (base?.color || "")) {
    out += `<w:color w:val="${format.color ? format.color.slice(1).toUpperCase() : "auto"}"/>`;
  }
  if (format.raise) out += `<w:position w:val="${Math.round(format.raise * 2)}"/>`;
  if (!base || halfPoints(format.size) !== halfPoints(base.size)) {
    out += `<w:sz w:val="${halfPoints(format.size)}"/><w:szCs w:val="${halfPoints(format.size)}"/>`;
  }
  if (flag("underline")) out += `<w:u w:val="${format.underline ? "single" : "none"}"/>`;
  if (format.shade) out += `<w:shd w:val="clear" w:color="auto" w:fill="${format.shade.slice(1).toUpperCase()}"/>`;
  const vertical = format.superscript ? "superscript" : format.subscript ? "subscript" : "baseline";
  const baseVertical = base?.superscript ? "superscript" : base?.subscript ? "subscript" : "baseline";
  if (vertical !== baseVertical) out += `<w:vertAlign w:val="${vertical}"/>`;
  return out ? `<w:rPr>${out}</w:rPr>` : "";
}

/** A run of text; line feeds and tabs are elements of their own. */
export function textRun(text: string, props: string): string {
  const inner = text
    .split(/(\n|\t)/)
    .map((part) =>
      part === "\n" ? "<w:br/>" : part === "\t" ? "<w:tab/>" : part ? `<w:t xml:space="preserve">${escapeXml(part)}</w:t>` : ""
    )
    .join("");
  return `<w:r>${props}${inner}</w:r>`;
}

// ---------------------------------------------------------------- paragraphs

export type ParaAlign = "left" | "center" | "right" | "justify";

export interface Border {
  /** single or dashed */
  style: "single" | "dashed";
  /** pt */
  width: number;
  color: string;
  /** Distance to the text, pt */
  space?: number;
}

export interface Borders {
  top?: Border;
  left?: Border;
  bottom?: Border;
  right?: Border;
}

export interface Tab {
  type: "left" | "center" | "right";
  /** From the left margin of the page (or the cell), pt */
  pos: number;
}

/** Properties of a paragraph; what's left out is the style's. */
export interface ParaFormat {
  /** Left out in the definition of a style */
  style?: string;
  keepNext?: boolean;
  keepLines?: boolean;
  numbering?: { id: number; level: number };
  borders?: Borders;
  shade?: string;
  tabs?: Tab[];
  /** pt */
  before?: number;
  /** pt, or a placeholder (see `spacingAfter`) that gets the value later */
  after?: number | string;
  /** Line height in pt */
  line?: number;
  /** The line is exactly `line` high rather than at least */
  exact?: boolean;
  left?: number;
  right?: number;
  /** First-line indent; negative for a hanging one */
  indent?: number;
  align?: ParaAlign;
  /** Properties of the paragraph mark, which give an empty paragraph its height */
  mark?: string;
}

const JC: Record<ParaAlign, string> = { left: "left", center: "center", right: "right", justify: "both" };

function border(side: string, line: Border): string {
  const size = Math.min(96, Math.max(2, Math.round(line.width * 8)));
  return (
    `<w:${side} w:val="${line.style}" w:sz="${size}" w:space="${Math.round(line.space ?? 0)}" ` +
    `w:color="${line.color.slice(1).toUpperCase()}"/>`
  );
}

/**
 * Delimits placeholders for what is filled in at the end. Text can't contain it: escapeXml drops control characters.
 */
export const MARK = String.fromCharCode(1);

/** The value of a spacing after that is filled in at the end: what's below the paragraph may add to it. */
export function spacingAfter(slot: number): string {
  return `${MARK}after${slot}${MARK}`;
}

/** What's inside w:pPr */
export function paraPropsContent(format: ParaFormat): string {
  let out = format.style ? `<w:pStyle w:val="${format.style}"/>` : "";
  if (format.keepNext !== undefined) out += toggle("keepNext", format.keepNext);
  if (format.keepLines !== undefined) out += toggle("keepLines", format.keepLines);
  if (format.numbering) {
    out += `<w:numPr><w:ilvl w:val="${format.numbering.level}"/><w:numId w:val="${format.numbering.id}"/></w:numPr>`;
  }
  const b = format.borders;
  if (b && (b.top || b.left || b.bottom || b.right)) {
    out +=
      "<w:pBdr>" +
      (b.top ? border("top", b.top) : "") +
      (b.left ? border("left", b.left) : "") +
      (b.bottom ? border("bottom", b.bottom) : "") +
      (b.right ? border("right", b.right) : "") +
      "</w:pBdr>";
  }
  if (format.shade) out += `<w:shd w:val="clear" w:color="auto" w:fill="${format.shade.slice(1).toUpperCase()}"/>`;
  if (format.tabs?.length) {
    out += `<w:tabs>${format.tabs.map((tab) => `<w:tab w:val="${tab.type}" w:pos="${twips(tab.pos)}"/>`).join("")}</w:tabs>`;
  }
  let spacing = "";
  if (format.before !== undefined) spacing += ` w:before="${twips(format.before)}"`;
  if (typeof format.after === "string") spacing += format.after;
  else if (format.after !== undefined) spacing += ` w:after="${twips(format.after)}"`;
  if (format.line !== undefined) {
    spacing += ` w:line="${Math.max(20, twips(format.line))}" w:lineRule="${format.exact ? "exact" : "atLeast"}"`;
  }
  if (spacing) out += `<w:spacing${spacing}/>`;
  let ind = "";
  if (format.left !== undefined) ind += ` w:left="${twips(format.left)}"`;
  if (format.right !== undefined) ind += ` w:right="${twips(format.right)}"`;
  if (format.indent !== undefined) {
    ind += format.indent < 0 ? ` w:hanging="${twips(-format.indent)}"` : ` w:firstLine="${twips(format.indent)}"`;
  }
  if (ind) out += `<w:ind${ind}/>`;
  if (format.align) out += `<w:jc w:val="${JC[format.align]}"/>`;
  if (format.mark) out += format.mark;
  return out;
}

export function paraProps(format: ParaFormat): string {
  const content = paraPropsContent(format);
  return content ? `<w:pPr>${content}</w:pPr>` : "";
}

// ---------------------------------------------------------------- styles

export interface StyleDef {
  id: string;
  name: string;
  type: "paragraph" | "character";
  /** The run properties in full (character styles: only what they set) */
  run: string;
  /** Paragraph properties without pStyle */
  paragraph?: string;
  basedOn?: string;
  next?: string;
  outlineLevel?: number;
  isDefault?: boolean;
  /** Shown in the style gallery */
  quick?: boolean;
  priority?: number;
}

export function stylesXml(defaults: { run: string; paragraph: string }, styles: StyleDef[]): string {
  const style = (s: StyleDef) =>
    `<w:style w:type="${s.type}"${s.isDefault ? ' w:default="1"' : ""} w:styleId="${s.id}">` +
    `<w:name w:val="${escapeXml(s.name)}"/>` +
    (s.basedOn ? `<w:basedOn w:val="${s.basedOn}"/>` : "") +
    (s.next ? `<w:next w:val="${s.next}"/>` : "") +
    (s.priority !== undefined ? `<w:uiPriority w:val="${s.priority}"/>` : "") +
    (s.quick ? "<w:qFormat/>" : "") +
    (s.paragraph !== undefined || s.outlineLevel !== undefined
      ? `<w:pPr>${s.paragraph ?? ""}${s.outlineLevel !== undefined ? `<w:outlineLvl w:val="${s.outlineLevel}"/>` : ""}</w:pPr>`
      : "") +
    (s.run ? `<w:rPr>${s.run.replace(/^<w:rPr>|<\/w:rPr>$/g, "")}</w:rPr>` : "") +
    "</w:style>";
  return (
    `${XML_DECLARATION}<w:styles ${namespaces("w")}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr>${defaults.run}</w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr>${defaults.paragraph}</w:pPr></w:pPrDefault></w:docDefaults>` +
    styles.map(style).join("") +
    "</w:styles>"
  );
}

// ---------------------------------------------------------------- lists

/** Word's own bullets: a disc in Symbol, a circle in Courier New and a square in Wingdings */
const BULLETS = [
  { char: "\uf0b7", font: "Symbol" },
  { char: "o", font: "Courier New" },
  { char: "\uf0a7", font: "Wingdings" },
];
const LIST_LEVELS = 9;

export class NumberingBuilder {
  private abstracts: string[] = [];
  private nums: string[] = [];
  private bulletNum: number | null = null;

  /** `indent`: where the text of level `i` starts, pt; the marker hangs `hanging` pt to its left */
  constructor(
    private readonly indent: (level: number) => number,
    private readonly hanging: number
  ) {}

  private add(levels: (level: number) => string): number {
    const abstractId = this.abstracts.length;
    this.abstracts.push(
      `<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="hybridMultilevel"/>` +
        Array.from({ length: LIST_LEVELS }, (_, i) => levels(i)).join("") +
        "</w:abstractNum>"
    );
    const numId = this.nums.length + 1;
    this.nums.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/></w:num>`);
    return numId;
  }

  private levelProps(level: number): string {
    return `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${twips(this.indent(level))}" w:hanging="${twips(this.hanging)}"/></w:pPr>`;
  }

  /** Bullets don't count, so all bulleted lists share one definition. */
  bullets(): number {
    this.bulletNum ??= this.add((i) => {
      const bullet = BULLETS[i % BULLETS.length];
      return (
        `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${bullet.char}"/>` +
        `${this.levelProps(i)}<w:rPr><w:rFonts w:ascii="${bullet.font}" w:hAnsi="${bullet.font}" w:hint="default"/></w:rPr></w:lvl>`
      );
    });
    return this.bulletNum;
  }

  /** Every numbered list gets a definition of its own: lists sharing one would count on from each other. */
  numbers(start: number): number {
    return this.add(
      (i) =>
        `<w:lvl w:ilvl="${i}"><w:start w:val="${start}"/><w:numFmt w:val="decimal"/>` +
        `<w:lvlText w:val="%${i + 1}."/>${this.levelProps(i)}</w:lvl>`
    );
  }

  get empty(): boolean {
    return this.nums.length === 0;
  }

  toXml(): string {
    return `${XML_DECLARATION}<w:numbering ${namespaces("w")}>${this.abstracts.join("")}${this.nums.join("")}</w:numbering>`;
  }
}

// ---------------------------------------------------------------- comments

export interface CommentEntry {
  id: number;
  author: string;
  initials: string;
  /** ms since 1970 */
  date: number;
  text: string;
  /** The comment this one answers */
  parent?: number;
  done: boolean;
}

/** Word reads the time of a comment as local time. */
function localTime(ms: number): string {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  );
}

/** comments.xml and commentsExtended.xml, which holds the threads (replies) and which are resolved */
export function commentParts(entries: CommentEntry[]): { comments: string; extended: string } {
  /** The id of the last paragraph of each comment, by which the threads refer to it */
  const lastPara = new Map<number, string>();
  let paraCount = 0;
  const paraId = () => (0x10000000 + ++paraCount).toString(16).toUpperCase();
  const comments = entries.map((entry) => {
    const lines = entry.text.split("\n");
    const paragraphs = lines.map((line, i) => {
      const id = paraId();
      if (i === lines.length - 1) lastPara.set(entry.id, id);
      const reference = i === 0 ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : "";
      return (
        `<w:p w14:paraId="${id}" w14:textId="77777777"><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${reference}` +
        `${line ? textRun(line, "") : ""}</w:p>`
      );
    });
    return (
      `<w:comment w:id="${entry.id}" w:author="${escapeXml(entry.author || "?")}" w:date="${localTime(entry.date)}" ` +
      `w:initials="${escapeXml(entry.initials)}">${paragraphs.join("")}</w:comment>`
    );
  });
  const extended = entries.map((entry) => {
    const parent = entry.parent !== undefined ? ` w15:paraIdParent="${lastPara.get(entry.parent)}"` : "";
    return `<w15:commentEx w15:paraId="${lastPara.get(entry.id)}"${parent} w15:done="${entry.done ? 1 : 0}"/>`;
  });
  return {
    comments:
      `${XML_DECLARATION}<w:comments ${namespaces("w", "w14", "mc")} mc:Ignorable="w14">${comments.join("")}</w:comments>`,
    extended:
      `${XML_DECLARATION}<w15:commentsEx ${namespaces("w15", "mc")} mc:Ignorable="w15">${extended.join("")}</w15:commentsEx>`,
  };
}

// ---------------------------------------------------------------- drawings

/** An inline picture `width` × `height` pt, of the image with relationship `rel`; `id` is unique in the document. */
export function inlinePicture(id: number, rel: string, width: number, height: number, description = ""): string {
  const cx = Math.max(1, Math.round(width * EMU_PER_PT));
  const cy = Math.max(1, Math.round(height * EMU_PER_PT));
  const descr = description ? ` descr="${escapeXml(description)}"` : "";
  return (
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture ${id}"${descr}/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/>` +
    `<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    "</pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>"
  );
}

// ---------------------------------------------------------------- package

const SETTINGS =
  `${XML_DECLARATION}<w:settings ${namespaces("w", "m")}><w:zoom w:percent="100"/><w:defaultTabStop w:val="800"/>` +
  '<w:characterSpacingControl w:val="doNotCompress"/>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
  '<m:mathPr><m:mathFont m:val="Cambria Math"/><m:brkBin m:val="before"/><m:brkBinSub m:val="--"/><m:smallFrac m:val="0"/>' +
  '<m:dispDef/><m:lMargin m:val="0"/><m:rMargin m:val="0"/><m:defJc m:val="centerGroup"/><m:wrapIndent m:val="1440"/>' +
  '<m:intLim m:val="subSup"/><m:naryLim m:val="undOvr"/></m:mathPr>' +
  '<w:themeFontLang w:val="en-US" w:eastAsia="ko-KR"/></w:settings>';

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAIN_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml";

export interface PackageMedia {
  rel: string;
  /** Inside word/, e.g. media/image1.png */
  path: string;
  data: Uint8Array;
}

export interface PackageLink {
  rel: string;
  url: string;
}

export function buildPackage(input: {
  /** The content of w:body, without the section properties */
  body: string;
  styles: string;
  numbering: string | null;
  comments: { comments: string; extended: string } | null;
  media: PackageMedia[];
  links: PackageLink[];
  title: string;
  creator: string;
  page: PageBox;
}): Uint8Array {
  const { body, styles, numbering, comments, media, links, title, creator, page } = input;
  const section =
    `<w:sectPr><w:pgSz w:w="${twips(page.width)}" w:h="${twips(page.height)}"/>` +
    `<w:pgMar w:top="${twips(page.top)}" w:right="${twips(page.right)}" w:bottom="${twips(page.bottom)}" ` +
    `w:left="${twips(page.left)}" w:header="709" w:footer="709" w:gutter="0"/><w:cols w:space="720"/>` +
    '<w:docGrid w:linePitch="360"/></w:sectPr>';
  const document =
    `${XML_DECLARATION}<w:document ${namespaces("w", "r", "m", "wp", "a", "pic", "w14", "mc")} mc:Ignorable="w14">` +
    `<w:body>${body}${section}</w:body></w:document>`;

  const rels = [
    `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdSettings" Type="${REL}/settings" Target="settings.xml"/>`,
    ...(numbering ? [`<Relationship Id="rIdNumbering" Type="${REL}/numbering" Target="numbering.xml"/>`] : []),
    ...(comments
      ? [
          `<Relationship Id="rIdComments" Type="${REL}/comments" Target="comments.xml"/>`,
          '<Relationship Id="rIdCommentsEx" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>',
        ]
      : []),
    ...media.map((m) => `<Relationship Id="${m.rel}" Type="${REL}/image" Target="${m.path}"/>`),
    ...links.map(
      (l) => `<Relationship Id="${l.rel}" Type="${REL}/hyperlink" Target="${escapeXml(l.url)}" TargetMode="External"/>`
    ),
  ];
  const override = (part: string, type: string) => `<Override PartName="${part}" ContentType="${type}"/>`;
  const contentTypes =
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/>' +
    '<Default Extension="gif" ContentType="image/gif"/><Default Extension="bmp" ContentType="image/bmp"/>' +
    override("/word/document.xml", `${MAIN_TYPE}.document.main+xml`) +
    override("/word/styles.xml", `${MAIN_TYPE}.styles+xml`) +
    override("/word/settings.xml", `${MAIN_TYPE}.settings+xml`) +
    (numbering ? override("/word/numbering.xml", `${MAIN_TYPE}.numbering+xml`) : "") +
    (comments
      ? override("/word/comments.xml", `${MAIN_TYPE}.comments+xml`) +
        override("/word/commentsExtended.xml", `${MAIN_TYPE}.commentsExtended+xml`)
      : "") +
    override("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml") +
    override("/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml") +
    "</Types>";
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(
      `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`
    ),
    "docProps/core.xml": strToU8(
      `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(creator)}</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
    ),
    "docProps/app.xml": strToU8(
      `${XML_DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
        "<Application>Paper2Gather</Application></Properties>"
    ),
    "word/document.xml": strToU8(document),
    "word/_rels/document.xml.rels": strToU8(
      `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`
    ),
    "word/styles.xml": strToU8(styles),
    "word/settings.xml": strToU8(SETTINGS),
  };
  if (numbering) files["word/numbering.xml"] = strToU8(numbering);
  if (comments) {
    files["word/comments.xml"] = strToU8(comments.comments);
    files["word/commentsExtended.xml"] = strToU8(comments.extended);
  }
  for (const m of media) files[`word/${m.path}`] = m.data;
  return zipSync(files);
}
