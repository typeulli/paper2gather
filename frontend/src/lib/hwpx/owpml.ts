/**
 * Writing the parts of an HWPX (OWPML) package. Lengths are HWPUNIT (7200 per inch), or pt where a name says so.
 * Files carry no line layout (linesegarray): Hancom lays the text out when it opens them.
 */
import { strToU8, zipSync } from "fflate";
import type { PageFormat, PaperSize } from "@/lib/paper/format";

export const HWPUNIT_PER_PT = 100;
/** A CSS px at 96 dpi */
export const HWPUNIT_PER_PX = 75;

/** Hancom's own paper sizes */
const PAPER: Record<PaperSize, { width: number; height: number }> = {
  a4: { width: 59528, height: 84186 },
  letter: { width: 61200, height: 79200 },
};

const HWPUNIT_PER_MM = 7200 / 25.4;

/** The document's page */
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
  const [top, right, bottom, left] = [page.marginTop, page.marginRight, page.marginBottom, page.marginLeft].map((mm) =>
    Math.round(mm * HWPUNIT_PER_MM)
  );
  return { width, height, top, right, bottom, left, textWidth: width - left - right, textHeight: height - top - bottom };
}

const NAMESPACES = [
  ["ha", "http://www.hancom.co.kr/hwpml/2011/app"],
  ["hp", "http://www.hancom.co.kr/hwpml/2011/paragraph"],
  ["hp10", "http://www.hancom.co.kr/hwpml/2016/paragraph"],
  ["hs", "http://www.hancom.co.kr/hwpml/2011/section"],
  ["hc", "http://www.hancom.co.kr/hwpml/2011/core"],
  ["hh", "http://www.hancom.co.kr/hwpml/2011/head"],
  ["hhs", "http://www.hancom.co.kr/hwpml/2011/history"],
  ["hm", "http://www.hancom.co.kr/hwpml/2011/master-page"],
  ["hpf", "http://www.hancom.co.kr/schema/2011/hpf"],
  ["dc", "http://purl.org/dc/elements/1.1/"],
  ["opf", "http://www.idpf.org/2007/opf/"],
  ["ooxmlchart", "http://www.hancom.co.kr/hwpml/2016/ooxmlchart"],
  ["hwpunitchar", "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"],
  ["epub", "http://www.idpf.org/2007/ops"],
  ["config", "urn:oasis:names:tc:opendocument:xmlns:config:1.0"],
]
  .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
  .join(" ");
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
const UNIT_CASE = 'hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"';

export function escapeXml(text: string): string {
  return text
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10ffff}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PER_LANGUAGE = (value: string | number) =>
  ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"].map((lang) => `${lang}="${value}"`).join(" ");

export interface CharShape {
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
  /** #rrggbb; black if empty */
  color?: string;
  /** #rrggbb background */
  shade?: string;
  /** Text written in capitals: Hancom has no capitals or small capitals setting. Not part of the shape itself. */
  caps?: boolean;
}

export type ParaAlign = "left" | "center" | "right" | "justify";

export interface ParaShape {
  align: ParaAlign;
  /** Multiple of the font size */
  lineHeight: number;
  /** pt */
  before?: number;
  after?: number;
  indent?: number;
  left?: number;
  heading?: { type: "OUTLINE" | "BULLET" | "NUMBER"; id: number; level: number };
  /** A tab property id; TAB_* below */
  tab?: number;
  keepWithNext?: boolean;
  keepLines?: boolean;
}

export interface BorderLine {
  type: "SOLID" | "DASH";
  /** One of Hancom's fixed widths, e.g. "0.12 mm" */
  width: string;
  color: string;
}

export interface BorderFill {
  left?: BorderLine;
  right?: BorderLine;
  top?: BorderLine;
  bottom?: BorderLine;
  fill?: string;
}

/** Tab properties: none, a tab at the left margin of a hanging indent, centre and right of the text width */
const TAB_NONE = 0;
export const TAB_HANGING = 1;
export const TAB_EQUATION = 2;

/** The Hancom number of the outline shape, which shows no number: numbers are part of the heading text. */
const OUTLINE_NUMBERING = 1;
/** Outline heading level `level` (from 0) */
export const outlineHeading = (level: number): ParaShape["heading"] => ({
  type: "OUTLINE",
  id: 0,
  level,
});

const NO_BORDER = '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>';

function border(side: string, line?: BorderLine): string {
  return line
    ? `<hh:${side} type="${line.type}" width="${line.width}" color="${line.color}"/>`
    : `<hh:${side} type="NONE" width="0.1 mm" color="#000000"/>`;
}

/** Headings show no marker. */
const NO_MARKER = 'autoIndent="0" widthAdjust="0" textOffsetType="HWPUNIT" textOffset="0"';
/** Hancom makes the hanging indent as wide as a list's marker needs, with room for two digits and `wider` in pt. */
function listMarker(wider = 0): string {
  return `autoIndent="1" widthAdjust="${Math.round(wider * HWPUNIT_PER_PT)}" textOffsetType="PERCENT" textOffset="50"`;
}

function paraHead(attrs: string, marker: string, text = ""): string {
  const common = 'align="LEFT" useInstWidth="0" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0"';
  return `<hh:paraHead ${attrs} ${marker} ${common}>${text}</hh:paraHead>`;
}

const LIST_LEVELS = 7;

/** Collects shapes and hands out their ids (the same shape gets the same id). */
export class HeaderBuilder {
  private fonts: string[] = [];
  private borderFills = new Map<string, string>();
  private charPrs = new Map<string, string>();
  private paraPrs = new Map<string, string>();
  private bullets = new Map<string, string>();
  private numberings: string[] = [];
  private styles: string[] = [];
  /** Border fill of everything without a border */
  readonly plainFill: number;

  constructor() {
    this.borderFill({}, true);
    this.plainFill = this.borderFill({ fill: "none" });
    this.numberings.push(
      `<hh:numbering id="${OUTLINE_NUMBERING}" start="0">${Array.from({ length: LIST_LEVELS }, (_, i) =>
        paraHead(`start="1" level="${i + 1}"`, NO_MARKER)
      ).join("")}</hh:numbering>`
    );
  }

  private fontId(face: string): number {
    let id = this.fonts.indexOf(face);
    if (id < 0) id = this.fonts.push(face) - 1;
    return id;
  }

  /** `unfilled`: the page's own border fill, which has no fill element at all. */
  borderFill(def: BorderFill, unfilled = false): number {
    const key = JSON.stringify(def) + unfilled;
    const existing = this.borderFills.get(key);
    if (existing) return Number(existing.match(/id="(\d+)"/)![1]);
    const id = this.borderFills.size + 1;
    const fill =
      !unfilled && def.fill
        ? `<hc:fillBrush><hc:winBrush faceColor="${def.fill}" hatchColor="#999999" alpha="0"/></hc:fillBrush>`
        : "";
    this.borderFills.set(
      key,
      `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">${NO_BORDER}` +
        border("leftBorder", def.left) +
        border("rightBorder", def.right) +
        border("topBorder", def.top) +
        border("bottomBorder", def.bottom) +
        `<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>${fill}</hh:borderFill>`
    );
    return id;
  }

  charPr(shape: CharShape): number {
    const key = JSON.stringify({ ...shape, caps: undefined });
    const existing = this.charPrs.get(key);
    if (existing) return Number(existing.match(/id="(\d+)"/)![1]);
    const id = this.charPrs.size;
    const korean = this.fontId(shape.koreanFont);
    const latin = this.fontId(shape.latinFont);
    this.charPrs.set(
      key,
      `<hh:charPr id="${id}" height="${Math.round(shape.size * HWPUNIT_PER_PT)}" ` +
        `textColor="${shape.color || "#000000"}" shadeColor="${shape.shade || "none"}" useFontSpace="0" useKerning="0" ` +
        `symMark="NONE" borderFillIDRef="${this.plainFill}">` +
        `<hh:fontRef hangul="${korean}" latin="${latin}" hanja="${korean}" japanese="${korean}" other="${latin}" ` +
        `symbol="${latin}" user="${latin}"/>` +
        `<hh:ratio ${PER_LANGUAGE(100)}/><hh:spacing ${PER_LANGUAGE(0)}/><hh:relSz ${PER_LANGUAGE(100)}/>` +
        `<hh:offset ${PER_LANGUAGE(0)}/>` +
        (shape.italic ? "<hh:italic/>" : "") +
        (shape.bold ? "<hh:bold/>" : "") +
        `<hh:underline type="${shape.underline ? "BOTTOM" : "NONE"}" shape="SOLID" color="${shape.color || "#000000"}"/>` +
        `<hh:strikeout shape="${shape.strike ? "SOLID" : "NONE"}" color="${shape.color || "#000000"}"/>` +
        '<hh:outline type="NONE"/><hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/>' +
        (shape.superscript ? "<hh:supscript/>" : "") +
        (shape.subscript ? "<hh:subscript/>" : "") +
        "</hh:charPr>"
    );
    return id;
  }

  paraPr(shape: ParaShape): number {
    const key = JSON.stringify(shape);
    const existing = this.paraPrs.get(key);
    if (existing) return Number(existing.match(/id="(\d+)"/)![1]);
    const id = this.paraPrs.size;
    const heading = shape.heading ?? { type: "NONE", id: 0, level: 0 };
    const units = (pt: number | undefined) => Math.round((pt ?? 0) * HWPUNIT_PER_PT);
    // Hancom reads the case; older readers read the default, which holds these lengths doubled.
    const margin = (factor: number) =>
      "<hh:margin>" +
      `<hc:intent value="${units(shape.indent) * factor}" unit="HWPUNIT"/>` +
      `<hc:left value="${units(shape.left) * factor}" unit="HWPUNIT"/>` +
      '<hc:right value="0" unit="HWPUNIT"/>' +
      `<hc:prev value="${units(shape.before) * factor}" unit="HWPUNIT"/>` +
      `<hc:next value="${units(shape.after) * factor}" unit="HWPUNIT"/>` +
      "</hh:margin>" +
      `<hh:lineSpacing type="PERCENT" value="${Math.round(shape.lineHeight * 100)}" unit="HWPUNIT"/>`;
    this.paraPrs.set(
      key,
      `<hh:paraPr id="${id}" tabPrIDRef="${shape.tab ?? TAB_NONE}" condense="0" fontLineHeight="0" snapToGrid="1" ` +
        'suppressLineNumbers="0" checked="0" textDir="LTR">' +
        `<hh:align horizontal="${shape.align.toUpperCase()}" vertical="BASELINE"/>` +
        `<hh:heading type="${heading.type}" idRef="${heading.id}" level="${heading.level}"/>` +
        '<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="1" ' +
        `keepWithNext="${shape.keepWithNext ? 1 : 0}" keepLines="${shape.keepLines ? 1 : 0}" pageBreakBefore="0" lineWrap="BREAK"/>` +
        '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
        `<hp:switch><hp:case ${UNIT_CASE}>${margin(1)}</hp:case><hp:default>${margin(2)}</hp:default></hp:switch>` +
        `<hh:border borderFillIDRef="${this.plainFill}" offsetLeft="0" offsetRight="0" ` +
        'offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>'
    );
    return id;
  }

  /** A numbering definition: each one counts on its own, so every ordered list gets one and restarts. */
  numbering(start: number, wider: number): number {
    const id = this.numberings.length + 1;
    const heads = Array.from({ length: LIST_LEVELS }, (_, i) =>
      paraHead(`start="${start}" level="${i + 1}"`, listMarker(wider), `^${i + 1}.`)
    );
    this.numberings.push(`<hh:numbering id="${id}" start="0">${heads.join("")}</hh:numbering>`);
    return id;
  }

  bullet(char: string): number {
    const existing = this.bullets.get(char);
    if (existing) return Number(existing.match(/id="(\d+)"/)![1]);
    const id = this.bullets.size + 1;
    this.bullets.set(
      char,
      `<hh:bullet id="${id}" char="${char}" useImage="0">${paraHead('level="0"', listMarker()).replace("></hh:paraHead>", "/>")}</hh:bullet>`
    );
    return id;
  }

  /** The first style added is the document's default, and each is followed by it when typing in Hancom. */
  style(name: string, engName: string, paraPr: number, charPr: number): number {
    const id = this.styles.length;
    this.styles.push(
      `<hh:style id="${id}" type="PARA" name="${escapeXml(name)}" engName="${escapeXml(engName)}" ` +
        `paraPrIDRef="${paraPr}" charPrIDRef="${charPr}" nextStyleIDRef="0" langID="1042" lockForm="0"/>`
    );
    return id;
  }

  /** `textWidth`: of the page, for the equation tab stops */
  toXml(textWidth: number): string {
    const fontList = this.fonts
      .map((face, id) => `<hh:font id="${id}" face="${escapeXml(face)}" type="TTF" isEmbedded="0"/>`)
      .join("");
    const fontfaces = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"]
      .map((lang) => `<hh:fontface lang="${lang}" fontCnt="${this.fonts.length}">${fontList}</hh:fontface>`)
      .join("");
    const half = textWidth / 2;
    const tabItems = (center: number, right: number, unit: string) =>
      `<hh:tabItem pos="${center}" type="CENTER" leader="NONE"${unit}/><hh:tabItem pos="${right}" type="RIGHT" leader="NONE"${unit}/>`;
    const tabs =
      '<hh:tabProperties itemCnt="3">' +
      `<hh:tabPr id="${TAB_NONE}" autoTabLeft="0" autoTabRight="0"/>` +
      `<hh:tabPr id="${TAB_HANGING}" autoTabLeft="1" autoTabRight="0"/>` +
      `<hh:tabPr id="${TAB_EQUATION}" autoTabLeft="0" autoTabRight="0"><hp:switch><hp:case ${UNIT_CASE}>` +
      tabItems(Math.round(half), textWidth, ' unit="HWPUNIT"') +
      `</hp:case><hp:default>${tabItems(textWidth, textWidth * 2, "")}</hp:default></hp:switch></hh:tabPr></hh:tabProperties>`;
    const items = (tag: string, values: Iterable<string>) => {
      const all = [...values];
      return all.length ? `<hh:${tag} itemCnt="${all.length}">${all.join("")}</hh:${tag}>` : "";
    };
    return (
      `${XML_DECLARATION}<hh:head ${NAMESPACES} version="1.5" secCnt="1">` +
      '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>' +
      `<hh:fontfaces itemCnt="7">${fontfaces}</hh:fontfaces>` +
      items("borderFills", this.borderFills.values()) +
      items("charProperties", this.charPrs.values()) +
      tabs +
      items("numberings", this.numberings) +
      items("bullets", this.bullets.values()) +
      items("paraProperties", this.paraPrs.values()) +
      items("styles", this.styles) +
      '</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>' +
      '<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>' +
      '<hh:trackchageConfig flags="56"/></hh:head>'
    );
  }
}

const NOTE_LINE = '<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>';
const NOTE_FORMAT = '<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>';
const NOTE_SPACING = '<hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/>';
const NOTE_NUMBERING = '<hp:numbering type="CONTINUOUS" newNum="1"/>';

function pageBorder(type: string): string {
  return (
    `<hp:pageBorderFill type="${type}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">` +
    '<hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>'
  );
}

/** The section definition (page shape); it goes first in the first paragraph, with the column definition. */
export function sectionStart(page: PageBox): string {
  const { width, height, top, right, bottom, left } = page;
  return (
    '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" ' +
    `tabStopUnit="HWPUNIT" outlineShapeIDRef="${OUTLINE_NUMBERING}" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
    '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>' +
    '<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
    '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" ' +
    'hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
    '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
    `<hp:pagePr landscape="WIDELY" width="${width}" height="${height}" gutterType="LEFT_ONLY">` +
    `<hp:margin header="0" footer="0" gutter="0" left="${left}" right="${right}" top="${top}" bottom="${bottom}"/></hp:pagePr>` +
    `<hp:footNotePr>${NOTE_FORMAT}${NOTE_LINE}${NOTE_SPACING}${NOTE_NUMBERING}<hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>` +
    `<hp:endNotePr>${NOTE_FORMAT}${NOTE_LINE}${NOTE_SPACING}${NOTE_NUMBERING}<hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>` +
    pageBorder("BOTH") +
    pageBorder("EVEN") +
    pageBorder("ODD") +
    '</hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>'
  );
}

export interface PackageImage {
  id: string;
  path: string;
  mediaType: string;
  data: Uint8Array;
}

export function buildPackage(input: {
  header: string;
  /** The paragraphs of the only section */
  body: string;
  title: string;
  creator: string;
  images: PackageImage[];
}): Uint8Array {
  const { header, body, title, creator, images } = input;
  const imageItems = images
    .map((image) => `<opf:item id="${image.id}" href="${image.path}" media-type="${image.mediaType}" isEmbeded="1"/>`)
    .join("");
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    // Must come first and uncompressed, as the file's signature
    mimetype: [strToU8("application/hwp+zip"), { level: 0 }],
    "version.xml": strToU8(
      `${XML_DECLARATION}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" ` +
        'major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="Paper2Gather" appVersion="1, 0, 0, 0"/>'
    ),
    "META-INF/container.xml": strToU8(
      `${XML_DECLARATION}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" ` +
        'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles>' +
        '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>' +
        "</ocf:rootfiles></ocf:container>"
    ),
    "META-INF/manifest.xml": strToU8(
      `${XML_DECLARATION}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`
    ),
    "Contents/content.hpf": strToU8(
      `${XML_DECLARATION}<opf:package ${NAMESPACES} version="" unique-identifier="" id=""><opf:metadata>` +
        `<opf:title>${escapeXml(title)}</opf:title><opf:language>ko</opf:language>` +
        `<opf:meta name="creator" content="text">${escapeXml(creator)}</opf:meta></opf:metadata><opf:manifest>` +
        '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>' +
        '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>' +
        imageItems +
        '<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>' +
        '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>'
    ),
    "Contents/header.xml": strToU8(header),
    "Contents/section0.xml": strToU8(`${XML_DECLARATION}<hs:sec ${NAMESPACES}>${body}</hs:sec>`),
    "settings.xml": strToU8(
      `${XML_DECLARATION}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" ` +
        'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>'
    ),
  };
  for (const image of images) files[image.path] = image.data;
  return zipSync(files);
}
