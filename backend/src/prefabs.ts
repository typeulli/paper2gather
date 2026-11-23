/**
 * Format prefabs ("논문 양식"): document formats modelled on the author guidelines of common venues, plus the
 * sections a new paper of that kind starts with. Only layout rules are taken from the guidelines, nothing of their
 * templates, and the names describe what a format follows: none of them is an official template.
 *
 * The format is given as the flat dotted keys of the document format (frontend lib/paper/format.ts), which checks
 * every value when it reads them. Applying a prefab replaces all of a document's format keys.
 */

export const PREFAB_IDS = ["ieee", "lncs", "apa", "kr-journal"] as const;
export type PrefabId = (typeof PREFAB_IDS)[number];

/** A block of a new paper: a heading (followed by nothing) or a paragraph */
export type SkeletonBlock =
  | { type: "heading"; text: string; level?: number; numbered?: boolean }
  /** The paper's title as an unnumbered level-1 heading (APA repeats it above the introduction) */
  | { type: "title" }
  | { type: "paragraph"; text?: string };

export type FormatValues = Record<string, string | number | boolean>;

export interface Prefab {
  id: PrefabId;
  label: string;
  /** One line on what it follows and what it can't */
  description: string;
  format: FormatValues;
  sections: SkeletonBlock[];
}

type StyleKey = "title" | "body" | "heading1" | "heading2" | "heading3" | "caption" | "references";

/** Flat keys of one paragraph style */
function style(key: StyleKey, values: Record<string, string | number | boolean>): FormatValues {
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [`styles.${key}.${field}`, value]));
}

const flat = (prefix: string, values: FormatValues): FormatValues =>
  Object.fromEntries(Object.entries(values).map(([field, value]) => [`${prefix}.${field}`, value]));

const IN = 25.4;

/** Label texts of the frontend's language presets */
const EN_LABELS: FormatValues = {
  "figure.captionLabel": "Figure",
  "figure.refLabel": "Fig.",
  "table.captionLabel": "Table",
  "table.refLabel": "Table",
  "equation.refLabel": "Eq.",
  "section.refLabel": "Section",
  "appendix.label": "Appendix",
  "references.title": "References",
};

const KO_LABELS: FormatValues = {
  "figure.captionLabel": "그림",
  "figure.refLabel": "그림",
  "table.captionLabel": "표",
  "table.refLabel": "표",
  "equation.refLabel": "식",
  "section.refLabel": "{n}절",
  "appendix.label": "부록",
  "references.title": "참고문헌",
};

const heading = (text: string, level = 1, numbered = true): SkeletonBlock => ({ type: "heading", text, level, numbered });
const paragraph = (text = ""): SkeletonBlock => ({ type: "paragraph", text });

/** A heading followed by an empty paragraph for each title */
const sections = (...titles: string[]): SkeletonBlock[] => titles.flatMap((t) => [heading(t), paragraph()]);

/** The sections of a new paper without a prefab */
export const DEFAULT_SECTIONS: SkeletonBlock[] = [
  heading("Abstract", 1, false),
  paragraph(),
  ...sections("Introduction", "Related Work", "Method", "Experiments", "Conclusion"),
];

export const PREFABS: Prefab[] = [
  {
    id: "ieee",
    label: "IEEE 스타일 (학회 논문)",
    description:
      "US Letter, 여백 0.75 / 1 / 0.625 in, Times 10pt, 제목 I. / A. / 1), 그림 Fig. 1. · 표 TABLE I, 수식 참조 (1). " +
      "IEEE 학회 논문 템플릿(IEEEtran)을 따른 1단 근사입니다(2단 미지원).",
    format: {
      ...EN_LABELS,
      "equation.refLabel": "",
      ...flat("page", { paper: "letter", marginTop: 0.75 * IN, marginBottom: 1 * IN, marginLeft: 0.625 * IN, marginRight: 0.625 * IN }),
      ...style("title", { size: 24, bold: false, align: "center", lineHeight: 1.2 }),
      ...style("body", { size: 10, lineHeight: 1.2, align: "justify", indent: 10, spaceAfter: 0 }),
      // IEEEtran: 1.5ex before and 0.7ex after a section heading
      ...style("heading1", { size: 10, bold: false, textCase: "small-caps", align: "center", lineHeight: 1.2, spaceBefore: 7, spaceAfter: 3 }),
      ...style("heading2", { size: 10, bold: false, italic: true, lineHeight: 1.2, spaceBefore: 7, spaceAfter: 3 }),
      ...style("heading3", { size: 10, bold: false, italic: true, lineHeight: 1.2, spaceBefore: 4, spaceAfter: 2 }),
      // 8 pt on 9 pt leading
      ...style("caption", { size: 8, align: "center", lineHeight: 1.13, spaceBefore: 4, spaceAfter: 4 }),
      ...style("references", { size: 8, lineHeight: 1.13, align: "justify", spaceAfter: 1 }),
      "figure.captionLabel": "Fig.",
      "figure.separator": "period",
      "figure.position": "below",
      "figure.labelBold": false,
      "table.captionLabel": "TABLE",
      "table.numberStyle": "upper-roman",
      "table.separator": "none",
      "table.position": "above",
      "table.labelBold": false,
      "section.numberFormat": "ieee",
      "latex.documentClass": "IEEEtran",
      ...flat("citation", { style: "ieee", order: "style", listUncited: false }),
    },
    sections: [
      heading("Abstract", 1, false),
      paragraph(),
      paragraph("Index Terms—"),
      ...sections("Introduction", "Related Work", "Method", "Experiments", "Conclusion"),
      heading("Acknowledgment", 1, false),
      paragraph(),
    ],
  },
  {
    id: "lncs",
    label: "Springer LNCS 스타일",
    description:
      "A4, 본문 영역 12.2 × 19.3 cm, Times 10pt, 제목 1 / 1.1, 캡션 9pt Fig. 1. · Table 1., 절 참조 Sect. 1. " +
      "Springer LNCS 저자 안내와 Word 템플릿을 따른 근사입니다.",
    format: {
      ...EN_LABELS,
      "section.refLabel": "Sect.",
      ...flat("page", { paper: "a4", marginTop: 52, marginBottom: 52, marginLeft: 44, marginRight: 44 }),
      ...style("title", { size: 14, bold: true, align: "center", lineHeight: 1.25 }),
      ...style("body", { size: 10, lineHeight: 1.2, align: "justify", indent: 15, spaceAfter: 0 }),
      ...style("heading1", { size: 12, bold: true, lineHeight: 1.25, spaceBefore: 18, spaceAfter: 12 }),
      ...style("heading2", { size: 10, bold: true, lineHeight: 1.2, spaceBefore: 18, spaceAfter: 8 }),
      ...style("heading3", { size: 10, bold: true, italic: false, lineHeight: 1.2, spaceBefore: 12, spaceAfter: 4 }),
      ...style("caption", { size: 9, align: "center", lineHeight: 1.2, spaceBefore: 6, spaceAfter: 6 }),
      // 9 pt on 11 pt leading
      ...style("references", { size: 9, lineHeight: 1.22, align: "justify", spaceAfter: 2 }),
      "figure.captionLabel": "Fig.",
      "figure.separator": "period",
      "figure.position": "below",
      "figure.labelBold": true,
      "table.separator": "period",
      "table.position": "above",
      "table.labelBold": true,
      "section.numberFormat": "decimal",
      "latex.documentClass": "llncs",
      ...flat("citation", { style: "springer", order: "style", listUncited: false }),
    },
    sections: [
      heading("Abstract", 1, false),
      paragraph(),
      paragraph("Keywords: "),
      ...sections("Introduction", "Related Work", "Method", "Experiments", "Conclusion"),
      paragraph("Acknowledgments. "),
      paragraph("Disclosure of Interests. "),
    ],
  },
  {
    id: "apa",
    label: "APA 7판 스타일",
    description:
      "US Letter, 여백 1 in, Times 12pt, 줄 간격 2배, 첫 줄 들여쓰기 0.5 in, 제목 번호 없음, 그림·표 라벨은 위. " +
      "APA 7판 서식을 따른 근사입니다(저자-연도 인용, 참고문헌 내어쓰기).",
    format: {
      ...EN_LABELS,
      "figure.refLabel": "Figure",
      "equation.refLabel": "Equation",
      ...flat("page", { paper: "letter", marginTop: IN, marginBottom: IN, marginLeft: IN, marginRight: IN }),
      ...style("title", { size: 12, bold: true, align: "center", lineHeight: 2 }),
      ...style("body", { size: 12, lineHeight: 2, align: "left", indent: 36, spaceAfter: 0 }),
      ...style("heading1", { size: 12, bold: true, align: "center", lineHeight: 2, spaceBefore: 0, spaceAfter: 0 }),
      ...style("heading2", { size: 12, bold: true, lineHeight: 2, spaceBefore: 0, spaceAfter: 0 }),
      ...style("heading3", { size: 12, bold: true, italic: true, lineHeight: 2, spaceBefore: 0, spaceAfter: 0 }),
      ...style("caption", { size: 12, align: "left", lineHeight: 2, spaceBefore: 0, spaceAfter: 0 }),
      ...style("references", { size: 12, lineHeight: 2, align: "left", spaceAfter: 0 }),
      "figure.separator": "none",
      "figure.position": "above",
      "figure.labelBold": true,
      "table.separator": "none",
      "table.position": "above",
      "table.labelBold": true,
      "section.numberFormat": "none",
      "latex.documentClass": "apa7",
      ...flat("citation", { style: "apa", order: "style", listUncited: false }),
    },
    sections: [
      heading("Abstract", 1, false),
      paragraph(),
      paragraph("Keywords: "),
      { type: "title" },
      paragraph(),
      ...sections("Method", "Results", "Discussion"),
    ],
  },
  {
    id: "kr-journal",
    label: "국문 학술지 (일반형)",
    description:
      "A4, 여백 25 mm, 명조(함초롬바탕) 10pt, 줄 간격 160%, 제목 1. / 1.1 (1단계는 고딕), 그림 1. · 표 1. " +
      "국내 공학 학술지 4곳(정보과학회·통신학회·전자공학회·정보처리학회) 규정의 공통점을 모은 1단 양식으로, 학술지마다 세부 규정이 다릅니다.",
    format: {
      ...KO_LABELS,
      ...flat("page", { paper: "a4", marginTop: 25, marginBottom: 25, marginLeft: 25, marginRight: 25 }),
      ...style("title", { koreanFont: "hcr-batang", size: 18, bold: true, align: "center", lineHeight: 1.4 }),
      ...style("body", { koreanFont: "hcr-batang", size: 10, lineHeight: 1.6, align: "justify", indent: 10, spaceAfter: 0 }),
      ...style("heading1", { latinFont: "arial", koreanFont: "noto-sans-kr", size: 11, bold: true, lineHeight: 1.6, spaceBefore: 14, spaceAfter: 6 }),
      ...style("heading2", { koreanFont: "hcr-batang", size: 10, bold: true, lineHeight: 1.6, spaceBefore: 10, spaceAfter: 4 }),
      ...style("heading3", { koreanFont: "hcr-batang", size: 10, bold: true, italic: false, lineHeight: 1.6, spaceBefore: 8, spaceAfter: 2 }),
      ...style("caption", { koreanFont: "hcr-batang", size: 9, align: "center", lineHeight: 1.5, spaceBefore: 4, spaceAfter: 4 }),
      ...style("references", { koreanFont: "hcr-batang", size: 9, lineHeight: 1.5, align: "justify", spaceAfter: 2 }),
      "figure.separator": "period",
      "figure.position": "below",
      "figure.labelBold": true,
      "table.separator": "period",
      "table.position": "above",
      "table.labelBold": true,
      "section.numberFormat": "decimal-period",
      "latex.documentClass": "article",
      ...flat("citation", { style: "ieee", order: "style", listUncited: false }),
    },
    sections: [
      heading("요약", 1, false),
      paragraph(),
      paragraph("주제어: "),
      heading("Abstract", 1, false),
      paragraph(),
      paragraph("Keywords: "),
      ...sections("서론", "관련 연구", "제안 방법", "실험 및 결과", "결론"),
    ],
  },
];

export function findPrefab(id: unknown): Prefab | undefined {
  return PREFABS.find((p) => p.id === id);
}
