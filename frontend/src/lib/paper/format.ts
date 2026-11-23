import type { ObjectKind } from "./types";

/**
 * Document format ("문서 양식"): paragraph styles plus caption / numbering formats.
 * Stored per document as flat dotted keys (e.g. "styles.body.size") overriding a default,
 * so concurrent edits of different fields merge. Every value is validated on read because
 * it comes from collaborators and ends up in generated CSS.
 */

// ------------------------------------------------------------------ fonts

/*
 * Text uses a Latin font and a Korean font. The CSS stack lists the Latin font first; it has no
 * Hangul glyphs, so Korean text falls through to the Korean font. Latin stacks therefore must not
 * contain a generic family (it would match Hangul first).
 */

export type LatinFontKey = "times" | "georgia" | "arial" | "geist" | "courier";
export type KoreanFontKey =
  | "noto-serif-kr"
  | "nanum-myeongjo"
  | "hcr-batang"
  | "human-myeongjo"
  | "noto-sans-kr"
  | "malgun-gothic";

export interface FontDef {
  label: string;
  css: string;
  /** Not served by the app: shown only where installed, otherwise the stack's fallback. */
  local?: boolean;
}

export const LATIN_FONTS: Record<LatinFontKey, FontDef> = {
  times: { label: "Times New Roman", css: '"Times New Roman", Times, "Liberation Serif"' },
  georgia: { label: "Georgia", css: "Georgia" },
  arial: { label: "Arial", css: 'Arial, Helvetica, "Liberation Sans"' },
  geist: { label: "Geist", css: "var(--font-sans)" },
  courier: { label: "Courier New", css: '"Courier New", Courier, "Liberation Mono"' },
};

// Installed-only fonts fall back to the matching web font, so every collaborator sees a similar face.
const SERIF_KR = "var(--font-noto-serif-kr), serif";
const SANS_KR = "var(--font-noto-sans-kr), sans-serif";

export const KOREAN_FONTS: Record<KoreanFontKey, FontDef> = {
  "noto-serif-kr": { label: "Noto Serif KR", css: SERIF_KR },
  "nanum-myeongjo": { label: "나눔명조", css: "var(--font-nanum-myeongjo), serif" },
  "hcr-batang": { label: "함초롬바탕", css: `"함초롬바탕", "HCR Batang", ${SERIF_KR}`, local: true },
  "human-myeongjo": { label: "휴먼명조", css: `"휴먼명조", ${SERIF_KR}`, local: true },
  "noto-sans-kr": { label: "Noto Sans KR", css: SANS_KR },
  "malgun-gothic": { label: "맑은 고딕", css: `"Malgun Gothic", "맑은 고딕", ${SANS_KR}`, local: true },
};

export const LATIN_FONT_KEYS = Object.keys(LATIN_FONTS) as LatinFontKey[];
export const KOREAN_FONT_KEYS = Object.keys(KOREAN_FONTS) as KoreanFontKey[];

export function isLatinFontKey(value: unknown): value is LatinFontKey {
  return typeof value === "string" && Object.hasOwn(LATIN_FONTS, value);
}

export function isKoreanFontKey(value: unknown): value is KoreanFontKey {
  return typeof value === "string" && Object.hasOwn(KOREAN_FONTS, value);
}

export function fontStack(latin: LatinFontKey, korean: KoreanFontKey): string {
  return `${LATIN_FONTS[latin].css}, ${KOREAN_FONTS[korean].css}`;
}

/**
 * The paper sets the two fonts as custom properties, so direct formatting can override one of them
 * (a span re-declares its property plus this family) while inheriting the other.
 */
export const FONT_FAMILY_FROM_VARS = "var(--latin-font), var(--korean-font)";

export const TEXT_COLORS: { label: string; value: string }[] = [
  { label: "회색", value: "#6b7280" },
  { label: "빨강", value: "#dc2626" },
  { label: "주황", value: "#ea580c" },
  { label: "노랑", value: "#ca8a04" },
  { label: "초록", value: "#16a34a" },
  { label: "청록", value: "#0d9488" },
  { label: "파랑", value: "#2563eb" },
  { label: "남색", value: "#4f46e5" },
  { label: "보라", value: "#9333ea" },
  { label: "분홍", value: "#db2777" },
];

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export function isColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_PATTERN.test(value);
}

export type TextAlign = "left" | "center" | "right" | "justify";
export const TEXT_ALIGNS: TextAlign[] = ["left", "center", "right", "justify"];

export function isTextAlign(value: unknown): value is TextAlign {
  return TEXT_ALIGNS.includes(value as TextAlign);
}

export const FONT_SIZE_RANGE = { min: 6, max: 72 };

export type TextCase = "normal" | "uppercase" | "small-caps";

export const TEXT_CASES: Record<TextCase, string> = {
  normal: "그대로",
  uppercase: "대문자 (ABC)",
  "small-caps": "작은 대문자 (Aʙᴄ)",
};

// ------------------------------------------------------------------ paragraph styles

export interface TextStyleDef {
  latinFont: LatinFontKey;
  koreanFont: KoreanFontKey;
  /** pt */
  size: number;
  bold: boolean;
  italic: boolean;
  /** "" = theme text color, otherwise #rrggbb */
  color: string;
  align: TextAlign;
  /** multiple of the font size */
  lineHeight: number;
  /** pt */
  spaceBefore: number;
  /** pt */
  spaceAfter: number;
  /** first-line indent, pt */
  indent: number;
  /** Latin letters in capitals or small capitals (title and headings) */
  textCase: TextCase;
}

export type StyleKey = "title" | "body" | "heading1" | "heading2" | "heading3" | "caption" | "references";

export const STYLE_KEYS: StyleKey[] = ["title", "body", "heading1", "heading2", "heading3", "caption", "references"];

const ALL_FIELDS: (keyof TextStyleDef)[] = [
  "latinFont",
  "koreanFont",
  "size",
  "bold",
  "italic",
  "color",
  "align",
  "lineHeight",
  "spaceBefore",
  "spaceAfter",
  "indent",
];

const HEADING_FIELDS: (keyof TextStyleDef)[] = [...ALL_FIELDS, "textCase"];

export const STYLE_META: Record<StyleKey, { label: string; sample: string; fields: (keyof TextStyleDef)[] }> = {
  title: {
    label: "논문 제목",
    sample: "Attention Is All You Need",
    fields: ["latinFont", "koreanFont", "size", "bold", "italic", "color", "align", "lineHeight", "textCase"],
  },
  body: {
    label: "본문",
    sample:
      "본문 단락 예시입니다. The quick brown fox jumps over the lazy dog. 여러 줄에 걸친 문장의 줄 간격과 들여쓰기를 확인할 수 있습니다.",
    fields: ALL_FIELDS,
  },
  heading1: { label: "제목 1", sample: "Introduction", fields: HEADING_FIELDS },
  heading2: { label: "제목 2", sample: "Background", fields: HEADING_FIELDS },
  heading3: { label: "제목 3", sample: "Details", fields: HEADING_FIELDS },
  caption: {
    label: "캡션",
    sample: "Figure 1. Overview of the proposed method.",
    fields: [
      "latinFont",
      "koreanFont",
      "size",
      "bold",
      "italic",
      "color",
      "align",
      "lineHeight",
      "spaceBefore",
      "spaceAfter",
    ],
  },
  references: {
    label: "참고문헌",
    sample: "[1] A. Vaswani et al., “Attention is all you need,” in Proc. NeurIPS, 2017.",
    fields: ["latinFont", "koreanFont", "size", "color", "align", "lineHeight", "spaceAfter"],
  },
};

/** Paragraph style that applies to a block node (used for toolbar defaults). */
export function blockStyleKey(headingLevel: number | undefined): StyleKey {
  if (headingLevel === 1) return "heading1";
  if (headingLevel === 2) return "heading2";
  if (headingLevel === 3) return "heading3";
  return "body";
}

// ------------------------------------------------------------------ captions & numbering

export type NumberStyle = "arabic" | "upper-roman" | "lower-roman" | "upper-alpha" | "lower-alpha";
export type CaptionSeparator = "period" | "colon" | "emdash" | "none";
export type CaptionPosition = "above" | "below";
export type EquationNumbering = "global" | "section";
export type EquationBrackets = "round" | "square" | "none";
/** How headings are numbered; appendix headings keep A, A.1, A.1.1 except with "none". */
export type HeadingNumbering = "decimal" | "decimal-period" | "ieee" | "none";

export const HEADING_NUMBERINGS: Record<HeadingNumbering, { label: string; samples: [string, string, string] }> = {
  decimal: { label: "1 / 1.1 / 1.1.1", samples: ["1", "1.1", "1.1.1"] },
  "decimal-period": { label: "1. / 1.1 / 1.1.1", samples: ["1.", "1.1", "1.1.1"] },
  ieee: { label: "I. / A. / 1) — 참조는 II-A", samples: ["I.", "A.", "1)"] },
  none: { label: "번호 없음", samples: ["", "", ""] },
};

export const NUMBER_STYLES: Record<NumberStyle, string> = {
  arabic: "1, 2, 3",
  "upper-roman": "I, II, III",
  "lower-roman": "i, ii, iii",
  "upper-alpha": "A, B, C",
  "lower-alpha": "a, b, c",
};

export const CAPTION_SEPARATORS: Record<CaptionSeparator, { label: string; text: string }> = {
  period: { label: "마침표", text: "." },
  colon: { label: "쌍점", text: ":" },
  emdash: { label: "줄표", text: " —" },
  none: { label: "없음", text: "" },
};

export interface FloatFormat {
  /** e.g. "Figure", "TABLE", "그림" */
  captionLabel: string;
  /** Label used by in-text references; may contain "{n}" */
  refLabel: string;
  numberStyle: NumberStyle;
  separator: CaptionSeparator;
  position: CaptionPosition;
  labelBold: boolean;
}

export interface EquationFormat {
  numbering: EquationNumbering;
  brackets: EquationBrackets;
  /** e.g. "Eq.", "식"; may contain "{n}" */
  refLabel: string;
}

// ------------------------------------------------------------------ page & export

export type PaperSize = "a4" | "letter";

/** Paper sizes in mm */
export const PAPER_SIZES: Record<PaperSize, { label: string; width: number; height: number }> = {
  a4: { label: "A4 (210 × 297 mm)", width: 210, height: 297 },
  letter: { label: "US Letter (8.5 × 11 in)", width: 215.9, height: 279.4 },
};

export const MARGIN_RANGE = { min: 5, max: 80 };

/** Margins in mm */
export interface PageFormat {
  paper: PaperSize;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

export type LatexClass = "article" | "IEEEtran" | "llncs" | "apa7";

export const LATEX_CLASSES: Record<LatexClass, { label: string; hint: string }> = {
  article: { label: "article", hint: "캡션 모양까지 문서 양식대로 내보냅니다." },
  IEEEtran: { label: "IEEEtran (conference)", hint: "캡션 모양은 클래스에 맡기고 라벨·번호 형식만 반영합니다." },
  llncs: { label: "llncs (Springer LNCS)", hint: "캡션 모양은 클래스에 맡기고 라벨·번호 형식만 반영합니다." },
  apa7: { label: "apa7 (man)", hint: "캡션 모양은 클래스에 맡기고 라벨·번호 형식만 반영합니다." },
};

/** How citations and the reference list look ("numeric" is the editor's own, IEEE-like style) */
export type CitationStyle = "numeric" | "ieee" | "springer" | "apa";

export const CITATION_STYLES: Record<CitationStyle, { label: string; sample: string; hint: string }> = {
  numeric: {
    label: "기본 (번호)",
    sample: "[1, 3–5]",
    hint: "LaTeX에는 목록을 이 형식의 글자로 넣습니다(thebibliography).",
  },
  ieee: {
    label: "IEEE",
    sample: "[1], [3], [4]",
    hint: "LaTeX에는 .bib와 IEEEtran.bst로 넣습니다(bibtex로 컴파일).",
  },
  springer: {
    label: "Springer LNCS",
    sample: "[1, 3–5]",
    hint: "LaTeX에는 .bib와 splncs04.bst로 넣습니다(bibtex로 컴파일).",
  },
  apa: {
    label: "APA 7판 (저자-연도)",
    sample: "(Kim, 2020; Lee & Park, 2021)",
    hint: "LaTeX에는 .bib와 biblatex-apa로 넣습니다(biber로 컴파일). biblatex-apa는 국문 규칙(외, 국문 먼저)을 모릅니다.",
  },
};

/** "manual": the order of the references panel; "style": the order the citation style prescribes */
export type ReferenceOrder = "manual" | "style";

export interface CitationFormat {
  style: CitationStyle;
  order: ReferenceOrder;
  /** References that aren't cited are listed too (they are always shown on screen, dimmed) */
  listUncited: boolean;
}

export interface PaperFormat {
  styles: Record<StyleKey, TextStyleDef>;
  figure: FloatFormat;
  table: FloatFormat;
  equation: EquationFormat;
  section: { refLabel: string; numberFormat: HeadingNumbering };
  /** Put before appendix numbers in headings and references ("Appendix A"); may contain "{n}" */
  appendix: { label: string };
  references: { title: string };
  citation: CitationFormat;
  page: PageFormat;
  latex: { documentClass: LatexClass };
}

export type LabelPreset = "en" | "ko";

/** Language presets only change label texts, not number formats or positions. */
export const LABEL_PRESETS: Record<LabelPreset, { label: string; values: Record<string, string> }> = {
  en: {
    label: "영문",
    values: {
      "figure.captionLabel": "Figure",
      "figure.refLabel": "Fig.",
      "table.captionLabel": "Table",
      "table.refLabel": "Table",
      "equation.refLabel": "Eq.",
      "section.refLabel": "Section",
      "appendix.label": "Appendix",
      "references.title": "References",
    },
  },
  ko: {
    label: "국문",
    values: {
      "figure.captionLabel": "그림",
      "figure.refLabel": "그림",
      "table.captionLabel": "표",
      "table.refLabel": "표",
      "equation.refLabel": "식",
      "section.refLabel": "{n}절",
      "appendix.label": "부록",
      "references.title": "참고문헌",
    },
  },
};

const style = (overrides: Partial<TextStyleDef>): TextStyleDef => ({
  latinFont: "times",
  koreanFont: "noto-serif-kr",
  size: 12,
  bold: false,
  italic: false,
  color: "",
  align: "left",
  lineHeight: 1.75,
  spaceBefore: 0,
  spaceAfter: 9,
  indent: 0,
  textCase: "normal",
  ...overrides,
});

const DEFAULT_FORMAT: PaperFormat = {
  styles: {
    title: style({ size: 22, bold: true, align: "center", lineHeight: 1.25, spaceAfter: 0 }),
    body: style({}),
    heading1: style({ size: 16, bold: true, lineHeight: 1.35, spaceBefore: 26, spaceAfter: 9 }),
    heading2: style({ size: 14, bold: true, lineHeight: 1.35, spaceBefore: 22, spaceAfter: 8 }),
    heading3: style({ size: 12, bold: true, italic: true, lineHeight: 1.35, spaceBefore: 18, spaceAfter: 6 }),
    caption: style({ size: 10.5, align: "center", lineHeight: 1.5, spaceBefore: 6, spaceAfter: 6 }),
    references: style({ size: 11, lineHeight: 1.6, spaceAfter: 4 }),
  },
  figure: {
    captionLabel: "Figure",
    refLabel: "Fig.",
    numberStyle: "arabic",
    separator: "period",
    position: "below",
    labelBold: true,
  },
  table: {
    captionLabel: "Table",
    refLabel: "Table",
    numberStyle: "arabic",
    separator: "period",
    position: "above",
    labelBold: true,
  },
  equation: { numbering: "global", brackets: "round", refLabel: "Eq." },
  section: { refLabel: "Section", numberFormat: "decimal" },
  appendix: { label: "Appendix" },
  references: { title: "References" },
  citation: { style: "numeric", order: "manual", listUncited: true },
  page: { paper: "a4", marginTop: 25, marginBottom: 25, marginLeft: 25, marginRight: 25 },
  latex: { documentClass: "article" },
};

// ------------------------------------------------------------------ reading stored values

const enumOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): T | undefined =>
    values.includes(v as T) ? (v as T) : undefined;

const numberIn =
  (min: number, max: number) =>
  (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v * 100) / 100)) : undefined;

const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const label = (v: unknown) => (typeof v === "string" ? v.slice(0, 40) : undefined);

/** Validators by leaf field name; a stored value is ignored unless its validator accepts it. */
const FIELD_RULES: Record<string, (v: unknown) => unknown> = {
  latinFont: (v) => (isLatinFontKey(v) ? v : undefined),
  koreanFont: (v) => (isKoreanFontKey(v) ? v : undefined),
  size: numberIn(FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max),
  bold: bool,
  italic: bool,
  color: (v) => (v === "" || isColor(v) ? v : undefined),
  align: (v) => (isTextAlign(v) ? v : undefined),
  lineHeight: numberIn(0.8, 3),
  spaceBefore: numberIn(0, 96),
  spaceAfter: numberIn(0, 96),
  indent: numberIn(0, 96),
  textCase: enumOf(Object.keys(TEXT_CASES) as TextCase[]),
  captionLabel: label,
  refLabel: label,
  title: label,
  label,
  numberStyle: enumOf(Object.keys(NUMBER_STYLES) as NumberStyle[]),
  separator: enumOf(Object.keys(CAPTION_SEPARATORS) as CaptionSeparator[]),
  position: enumOf(["above", "below"] as const),
  labelBold: bool,
  numbering: enumOf(["global", "section"] as const),
  brackets: enumOf(["round", "square", "none"] as const),
  numberFormat: enumOf(Object.keys(HEADING_NUMBERINGS) as HeadingNumbering[]),
  paper: enumOf(Object.keys(PAPER_SIZES) as PaperSize[]),
  marginTop: numberIn(MARGIN_RANGE.min, MARGIN_RANGE.max),
  marginBottom: numberIn(MARGIN_RANGE.min, MARGIN_RANGE.max),
  marginLeft: numberIn(MARGIN_RANGE.min, MARGIN_RANGE.max),
  marginRight: numberIn(MARGIN_RANGE.min, MARGIN_RANGE.max),
  documentClass: enumOf(Object.keys(LATEX_CLASSES) as LatexClass[]),
  style: enumOf(Object.keys(CITATION_STYLES) as CitationStyle[]),
  order: enumOf(["manual", "style"] as const),
  listUncited: bool,
};

/** Sets `path` in `target` only if every segment already exists as an own property. */
function setExistingPath(target: object, path: string, value: unknown): void {
  const parts = path.split(".");
  let node: Record<string, unknown> = target as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(node, part) || typeof node[part] !== "object" || node[part] === null) return;
    node = node[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (!Object.hasOwn(node, leaf)) return;
  const valid = FIELD_RULES[leaf]?.(value);
  if (valid !== undefined) node[leaf] = valid;
}

/**
 * Default format for a document. Older documents stored a label language and an equation
 * numbering mode in `meta.settings`; those seed the defaults.
 */
export function defaultFormat(preset: LabelPreset = "en", numbering: EquationNumbering = "global"): PaperFormat {
  const format = structuredClone(DEFAULT_FORMAT);
  for (const [path, value] of Object.entries(LABEL_PRESETS[preset].values)) setExistingPath(format, path, value);
  format.equation.numbering = numbering;
  return format;
}

/** Preset labels added after documents started storing their format, so older documents lack them. */
const LATER_PRESET_PATHS = ["appendix.label"];

function valueAt(format: PaperFormat, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], format);
}

export function readFormat(base: PaperFormat, entries: Iterable<[string, unknown]>): PaperFormat {
  const format = structuredClone(base);
  const stored = new Set<string>();
  for (const [path, value] of entries) {
    setExistingPath(format, path, value);
    stored.add(path);
  }
  // Such a label follows the language preset that the document's other labels match.
  for (const path of LATER_PRESET_PATHS) {
    if (stored.has(path)) continue;
    const preset = Object.values(LABEL_PRESETS).find(({ values }) =>
      Object.entries(values).every(([p, v]) => LATER_PRESET_PATHS.includes(p) || valueAt(format, p) === v)
    );
    if (preset) setExistingPath(format, path, preset.values[path]);
  }
  return format;
}

// ------------------------------------------------------------------ text helpers

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
  for (const [value, symbol] of table) {
    while (n >= value) {
      out += symbol;
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

export function formatNumber(n: number, numberStyle: NumberStyle): string {
  switch (numberStyle) {
    case "upper-roman":
      return toRoman(n);
    case "lower-roman":
      return toRoman(n).toLowerCase();
    case "upper-alpha":
      return toAlpha(n);
    case "lower-alpha":
      return toAlpha(n).toLowerCase();
    default:
      return String(n);
  }
}

/** "Figure 1." / "TABLE II:" — the label part of a caption. */
export function captionLabelText(format: FloatFormat, number: string): string {
  const head = format.captionLabel ? `${format.captionLabel} ${number}` : number;
  return head + CAPTION_SEPARATORS[format.separator].text;
}

export function equationNumberText(number: string, brackets: EquationBrackets): string {
  if (brackets === "square") return `[${number}]`;
  if (brackets === "none") return number;
  return `(${number})`;
}

/** Joins a reference label and a number: "Fig." + "2" -> "Fig. 2", "{n}절" + "2" -> "2절". */
export function applyRefLabel(refLabel: string, number: string): string {
  if (refLabel.includes("{n}")) return refLabel.replaceAll("{n}", number);
  return refLabel ? `${refLabel} ${number}` : number;
}

/** `appendix`: the object is in the appendix; its sections are referred to as "Appendix A.1". */
export function refLabelOf(kind: ObjectKind, format: PaperFormat, appendix = false): string {
  if (kind === "section" && appendix) return format.appendix.label;
  return kind === "section" ? format.section.refLabel : format[kind].refLabel;
}

/** In-text reference: "Eq. (3)", "Fig. II", "Section 2", "Appendix A". */
export function referenceText(kind: ObjectKind, number: string, format: PaperFormat, appendix = false): string {
  const shown = kind === "equation" ? equationNumberText(number, format.equation.brackets) : number;
  return applyRefLabel(refLabelOf(kind, format, appendix), shown);
}

// ------------------------------------------------------------------ CSS

function textCaseCss(textCase: TextCase): Record<string, string> {
  if (textCase === "uppercase") return { textTransform: "uppercase" };
  if (textCase === "small-caps") return { fontVariantCaps: "small-caps" };
  return {};
}

/** Inline style for previews of a paragraph style. */
export function textStyleCss(s: TextStyleDef): Record<string, string | number> {
  return {
    fontFamily: fontStack(s.latinFont, s.koreanFont),
    fontSize: `${s.size}pt`,
    fontWeight: s.bold ? 700 : 400,
    fontStyle: s.italic ? "italic" : "normal",
    lineHeight: s.lineHeight,
    textAlign: s.align,
    textIndent: `${s.indent}pt`,
    ...(s.color ? { color: s.color } : {}),
    ...textCaseCss(s.textCase),
  };
}

/** Style name shown in menus in its own face, with the size capped so the menu stays compact. */
export function styleLabelCss(s: TextStyleDef, maxSize = 16): Record<string, string | number> {
  return {
    fontFamily: fontStack(s.latinFont, s.koreanFont),
    fontSize: `${Math.min(s.size, maxSize)}pt`,
    fontWeight: s.bold ? 700 : 400,
    fontStyle: s.italic ? "italic" : "normal",
    lineHeight: 1.3,
    ...(s.color ? { color: s.color } : {}),
    ...textCaseCss(s.textCase),
  };
}

function fontRules(s: TextStyleDef): string {
  return (
    `--latin-font:${LATIN_FONTS[s.latinFont].css};--korean-font:${KOREAN_FONTS[s.koreanFont].css};` +
    `font-family:${FONT_FAMILY_FROM_VARS};font-size:${s.size}pt;font-weight:${s.bold ? 700 : 400};` +
    `font-style:${s.italic ? "italic" : "normal"};line-height:${s.lineHeight};` +
    (s.color ? `color:${s.color};` : "") +
    (s.textCase === "uppercase" ? "text-transform:uppercase;" : "") +
    (s.textCase === "small-caps" ? "font-variant-caps:small-caps;" : "")
  );
}

function blockRules(s: TextStyleDef): string {
  return (
    `text-align:${s.align};text-indent:${s.indent}pt;` +
    `margin-top:${s.spaceBefore}pt;margin-bottom:${s.spaceAfter}pt;`
  );
}

/** Stylesheet applying the paragraph styles to the paper (scoped to `.paper-page`). */
export function paperFormatCss(format: PaperFormat): string {
  const { styles: s } = format;
  const p = ".paper-page";
  return [
    `${p} .paper-title{${fontRules(s.title)}text-align:${s.title.align};}`,
    `${p} .paper-body{${fontRules(s.body)}}`,
    `${p} .paper-body>p{${blockRules(s.body)}}`,
    `${p} .paper-body h1,${p} .paper-references-title{${fontRules(s.heading1)}${blockRules(s.heading1)}}`,
    `${p} .paper-body h2{${fontRules(s.heading2)}${blockRules(s.heading2)}}`,
    `${p} .paper-body h3{${fontRules(s.heading3)}${blockRules(s.heading3)}}`,
    `${p} .paper-body>:first-child,${p} .paper-references-title{margin-top:0}`,
    `${p} .paper-caption{${fontRules(s.caption)}text-align:${s.caption.align};` +
      `margin-top:${s.caption.spaceBefore}pt;margin-bottom:${s.caption.spaceAfter}pt;}`,
    `${p} .paper-references{${fontRules(s.references)}}`,
    `${p} .paper-references>li{margin-bottom:${s.references.spaceAfter}pt;}`,
    `${p} .paper-references .ref-text{text-align:${s.references.align};}`,
  ].join("\n");
}
