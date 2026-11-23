"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  BoldIcon,
  CheckIcon,
  ItalicIcon,
  Loader2Icon,
  RotateCcwIcon,
  TextAlignCenterIcon,
  TextAlignEndIcon,
  TextAlignJustifyIcon,
  TextAlignStartIcon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, type FormatPrefab } from "@/lib/api";
import {
  citationText,
  entryLabel,
  formatReferenceAs,
  isAuthorDate,
  layoutCitations,
  sortsByAuthor,
} from "@/lib/paper/citations";
import {
  CAPTION_SEPARATORS,
  CITATION_STYLES,
  captionLabelText,
  defaultFormat,
  equationNumberText,
  FONT_SIZE_RANGE,
  formatNumber,
  HEADING_NUMBERINGS,
  KOREAN_FONT_KEYS,
  KOREAN_FONTS,
  LABEL_PRESETS,
  LATEX_CLASSES,
  LATIN_FONT_KEYS,
  LATIN_FONTS,
  MARGIN_RANGE,
  NUMBER_STYLES,
  PAPER_SIZES,
  readFormat,
  referenceText,
  STYLE_KEYS,
  STYLE_META,
  styleLabelCss,
  TEXT_CASES,
  textStyleCss,
  type CaptionSeparator,
  type CitationStyle,
  type EquationBrackets,
  type EquationNumbering,
  type FloatFormat,
  type FontDef,
  type HeadingNumbering,
  type KoreanFontKey,
  type LabelPreset,
  type LatexClass,
  type LatinFontKey,
  type NumberStyle,
  type PageFormat,
  type PaperFormat,
  type PaperSize,
  type StyleKey,
  type TextAlign,
  type TextCase,
  type TextStyleDef,
} from "@/lib/paper/format";
import { emptyReference } from "@/lib/paper/references";
import type { Reference } from "@/lib/paper/types";
import { cn } from "@/lib/utils";
import { ColorPalette } from "../color-palette";
import { NumberStepper } from "../number-stepper";
import { useFormat, usePaper, type FormatDialogTab } from "../paper-context";

const LINE_HEIGHTS = [1, 1.15, 1.25, 1.35, 1.5, 1.6, 1.75, 2, 2.5, 3];
const SPACING_MAX = 96;

const ALIGN_OPTIONS: { value: TextAlign; label: string; icon: ReactNode }[] = [
  { value: "left", label: "왼쪽 정렬", icon: <TextAlignStartIcon /> },
  { value: "center", label: "가운데 정렬", icon: <TextAlignCenterIcon /> },
  { value: "right", label: "오른쪽 정렬", icon: <TextAlignEndIcon /> },
  { value: "justify", label: "양쪽 정렬", icon: <TextAlignJustifyIcon /> },
];

const fontOption = <K extends string>(key: K, font: FontDef) => ({
  value: key,
  label: (
    <>
      <span style={{ fontFamily: font.css }}>{font.label}</span>
      {font.local && <span className="ml-1.5 text-xs text-muted-foreground">설치된 PC만</span>}
    </>
  ),
});

const LATIN_FONT_OPTIONS = LATIN_FONT_KEYS.map((key) => fontOption(key, LATIN_FONTS[key]));
const KOREAN_FONT_OPTIONS = KOREAN_FONT_KEYS.map((key) => fontOption(key, KOREAN_FONTS[key]));

const NUMBER_STYLE_OPTIONS =(Object.keys(NUMBER_STYLES) as NumberStyle[]).map((value) => ({
  value,
  label: NUMBER_STYLES[value],
}));

const SEPARATOR_OPTIONS = (Object.keys(CAPTION_SEPARATORS) as CaptionSeparator[]).map((value) => {
  const { label, text } = CAPTION_SEPARATORS[value];
  return { value, label: text ? `${label} (${text.trim()})` : label };
});

const EQUATION_NUMBERING_OPTIONS: { value: EquationNumbering; label: string }[] = [
  { value: "global", label: "문서 전체 연번 — 1, 2, 3" },
  { value: "section", label: "절 단위 — 2.1, 2.2, 3.1" },
];

const BRACKET_OPTIONS: { value: EquationBrackets; label: string }[] = [
  { value: "round", label: "소괄호 (1)" },
  { value: "square", label: "대괄호 [1]" },
  { value: "none", label: "없음 1" },
];

const TEXT_CASE_OPTIONS = (Object.keys(TEXT_CASES) as TextCase[]).map((value) => ({ value, label: TEXT_CASES[value] }));

const HEADING_NUMBERING_OPTIONS = (Object.keys(HEADING_NUMBERINGS) as HeadingNumbering[]).map((value) => ({
  value,
  label: HEADING_NUMBERINGS[value].label,
}));

const PAPER_OPTIONS = (Object.keys(PAPER_SIZES) as PaperSize[]).map((value) => ({ value, label: PAPER_SIZES[value].label }));

const LATEX_CLASS_OPTIONS = (Object.keys(LATEX_CLASSES) as LatexClass[]).map((value) => ({
  value,
  label: LATEX_CLASSES[value].label,
}));

const MARGIN_FIELDS: { field: keyof Omit<PageFormat, "paper">; label: string }[] = [
  { field: "marginTop", label: "위" },
  { field: "marginBottom", label: "아래" },
  { field: "marginLeft", label: "왼쪽" },
  { field: "marginRight", label: "오른쪽" },
];

// ------------------------------------------------------------------ small controls

function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Writes on every keystroke but shows a local draft while focused, so remote edits don't move the caret. */
function TextField({
  id,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      id={id}
      value={draft ?? value}
      maxLength={40}
      placeholder={placeholder}
      onFocus={() => setDraft(value)}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}

function SelectField<T extends string>({
  id,
  value,
  options,
  onChange,
}: {
  id?: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ColorField({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-start font-normal">
          <span
            className="size-4 shrink-0 rounded-full border border-black/10 dark:border-white/15"
            style={{ background: value || "var(--foreground)" }}
          />
          {value ? value.toUpperCase() : "기본 색"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3">
        <ColorPalette value={value} onChange={(color) => onChange(color ?? "")} onPick={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function Card({ title, onReset, children }: { title: string; onReset: () => void; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{title}</h3>
        <Button variant="ghost" size="xs" onClick={onReset}>
          <RotateCcwIcon /> 기본값
        </Button>
      </div>
      {children}
    </section>
  );
}

function Preview({ children }: { children: ReactNode }) {
  return <div className="rounded-md border bg-background px-3 py-2 text-foreground">{children}</div>;
}

// ------------------------------------------------------------------ paragraph styles

function blockStyle(s: TextStyleDef) {
  return { ...textStyleCss(s), marginTop: `${s.spaceBefore}pt`, marginBottom: `${s.spaceAfter}pt` };
}

const HEADING_LEVELS: Partial<Record<StyleKey, number>> = { heading1: 1, heading2: 2, heading3: 3 };

function StylePreview({ styleKey, format }: { styleKey: StyleKey; format: PaperFormat }) {
  const s = format.styles[styleKey];
  const { sample } = STYLE_META[styleKey];
  const body = format.styles.body;
  const level = HEADING_LEVELS[styleKey];
  const number = level ? HEADING_NUMBERINGS[format.section.numberFormat].samples[level - 1] : "";
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">미리보기</span>
      <div className="max-h-64 overflow-hidden rounded-md border bg-background px-5 py-3 break-words text-foreground">
        {/* Headings and body paragraphs are shown with a neighbour so the spacing is visible. */}
        <p style={blockStyle(s)}>
          {number && <span className="heading-number">{number}</span>}
          {sample}
        </p>
        {styleKey === "body" && <p style={blockStyle(s)}>{sample}</p>}
        {styleKey.startsWith("heading") && <p style={blockStyle(body)}>{STYLE_META.body.sample}</p>}
      </div>
    </div>
  );
}

function StyleEditor({ styleKey }: { styleKey: StyleKey }) {
  const { store } = usePaper();
  const format = useFormat();
  const s = format.styles[styleKey];
  const { label, fields } = STYLE_META[styleKey];
  const has = (field: keyof TextStyleDef) => fields.includes(field);
  const set = (field: keyof TextStyleDef, value: unknown) => store.setFormatValue(`styles.${styleKey}.${field}`, value);
  const lineHeights = [...new Set([...LINE_HEIGHTS, s.lineHeight])].sort((a, b) => a - b);
  const id = (field: string) => `style-${styleKey}-${field}`;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{label}</h3>
        <Button variant="ghost" size="sm" onClick={() => store.resetFormat(`styles.${styleKey}`)}>
          <RotateCcwIcon /> 기본값으로
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-3">
        {has("latinFont") && (
          <Field label="영문 글꼴" htmlFor={id("latinFont")}>
            <SelectField<LatinFontKey>
              id={id("latinFont")}
              value={s.latinFont}
              options={LATIN_FONT_OPTIONS}
              onChange={(v) => set("latinFont", v)}
            />
          </Field>
        )}
        {has("koreanFont") && (
          <Field label="한글 글꼴" htmlFor={id("koreanFont")}>
            <SelectField<KoreanFontKey>
              id={id("koreanFont")}
              value={s.koreanFont}
              options={KOREAN_FONT_OPTIONS}
              onChange={(v) => set("koreanFont", v)}
            />
          </Field>
        )}
        {has("size") && (
          <Field label="크기">
            <NumberStepper
              value={s.size}
              min={FONT_SIZE_RANGE.min}
              max={FONT_SIZE_RANGE.max}
              label="글자 크기"
              unit="pt"
              onChange={(v) => set("size", v)}
            />
          </Field>
        )}
        {(has("bold") || has("italic")) && (
          <Field label="글자 모양">
            <div className="flex gap-1">
              {has("bold") && (
                <Toggle variant="outline" size="sm" aria-label="굵게" pressed={s.bold} onPressedChange={(v) => set("bold", v)}>
                  <BoldIcon />
                </Toggle>
              )}
              {has("italic") && (
                <Toggle
                  variant="outline"
                  size="sm"
                  aria-label="기울임"
                  pressed={s.italic}
                  onPressedChange={(v) => set("italic", v)}
                >
                  <ItalicIcon />
                </Toggle>
              )}
            </div>
          </Field>
        )}
        {has("color") && (
          <Field label="글자 색">
            <ColorField value={s.color} onChange={(color) => set("color", color)} />
          </Field>
        )}
        {has("align") && (
          <Field label="정렬">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={s.align}
              onValueChange={(v) => v && set("align", v)}
            >
              {ALIGN_OPTIONS.map((o) => (
                <ToggleGroupItem key={o.value} value={o.value} aria-label={o.label} title={o.label}>
                  {o.icon}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        )}
        {has("lineHeight") && (
          <Field label="줄 간격" htmlFor={id("lineHeight")}>
            <SelectField
              id={id("lineHeight")}
              value={String(s.lineHeight)}
              options={lineHeights.map((n) => ({ value: String(n), label: `${n}배` }))}
              onChange={(v) => set("lineHeight", Number(v))}
            />
          </Field>
        )}
        {has("spaceBefore") && (
          <Field label="단락 앞 간격">
            <NumberStepper
              value={s.spaceBefore}
              min={0}
              max={SPACING_MAX}
              label="단락 앞 간격"
              unit="pt"
              onChange={(v) => set("spaceBefore", v)}
            />
          </Field>
        )}
        {has("spaceAfter") && (
          <Field label="단락 뒤 간격">
            <NumberStepper
              value={s.spaceAfter}
              min={0}
              max={SPACING_MAX}
              label="단락 뒤 간격"
              unit="pt"
              onChange={(v) => set("spaceAfter", v)}
            />
          </Field>
        )}
        {has("indent") && (
          <Field label="첫 줄 들여쓰기">
            <NumberStepper
              value={s.indent}
              min={0}
              max={SPACING_MAX}
              label="첫 줄 들여쓰기"
              unit="pt"
              onChange={(v) => set("indent", v)}
            />
          </Field>
        )}
        {has("textCase") && (
          <Field label="영문 대소문자" htmlFor={id("textCase")}>
            <SelectField
              id={id("textCase")}
              value={s.textCase}
              options={TEXT_CASE_OPTIONS}
              onChange={(v) => set("textCase", v)}
            />
          </Field>
        )}
      </div>

      <StylePreview styleKey={styleKey} format={format} />
    </div>
  );
}

function StylesTab({ selected, onSelect }: { selected: StyleKey; onSelect: (key: StyleKey) => void }) {
  const format = useFormat();
  return (
    <div className="grid gap-4 md:grid-cols-[13rem_1fr]">
      <div className="grid grid-cols-2 gap-1 md:flex md:flex-col md:border-r md:pr-3">
        {STYLE_KEYS.map((key) => {
          const s = format.styles[key];
          return (
            <button
              key={key}
              type="button"
              aria-pressed={key === selected}
              onClick={() => onSelect(key)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-muted",
                key === selected && "bg-muted"
              )}
            >
              <span className="max-w-full truncate" style={styleLabelCss(s)}>
                {STYLE_META[key].label}
              </span>
              <span className="max-w-full truncate text-[11px] text-muted-foreground">
                {LATIN_FONTS[s.latinFont].label} · {KOREAN_FONTS[s.koreanFont].label} · {s.size}pt
              </span>
            </button>
          );
        })}
      </div>
      <StyleEditor key={selected} styleKey={selected} />
    </div>
  );
}

// ------------------------------------------------------------------ captions & numbering

function FloatCard({ kind }: { kind: "figure" | "table" }) {
  const { store } = usePaper();
  const format = useFormat();
  const f = format[kind];
  const set = (field: keyof FloatFormat, value: unknown) => store.setFormatValue(`${kind}.${field}`, value);
  const id = (field: string) => `${kind}-${field}`;
  const sample = formatNumber(2, f.numberStyle);

  return (
    <Card title={kind === "figure" ? "그림" : "표"} onReset={() => store.resetFormat(kind)}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="캡션 라벨" htmlFor={id("captionLabel")}>
          <TextField
            id={id("captionLabel")}
            value={f.captionLabel}
            placeholder="없음"
            onChange={(v) => set("captionLabel", v)}
          />
        </Field>
        <Field label="본문 참조 표기" htmlFor={id("refLabel")}>
          <TextField id={id("refLabel")} value={f.refLabel} placeholder="없음" onChange={(v) => set("refLabel", v)} />
        </Field>
        <Field label="번호 형식" htmlFor={id("numberStyle")}>
          <SelectField
            id={id("numberStyle")}
            value={f.numberStyle}
            options={NUMBER_STYLE_OPTIONS}
            onChange={(v) => set("numberStyle", v)}
          />
        </Field>
        <Field label="구분자" htmlFor={id("separator")}>
          <SelectField
            id={id("separator")}
            value={f.separator}
            options={SEPARATOR_OPTIONS}
            onChange={(v) => set("separator", v)}
          />
        </Field>
        <Field label="캡션 위치">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={f.position}
            onValueChange={(v) => v && set("position", v)}
          >
            <ToggleGroupItem value="above">위</ToggleGroupItem>
            <ToggleGroupItem value="below">아래</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field label="라벨 굵게" htmlFor={id("labelBold")}>
          <Switch id={id("labelBold")} checked={f.labelBold} onCheckedChange={(v) => set("labelBold", v)} />
        </Field>
      </div>
      <Preview>
        <p>
          <span className={cn(f.labelBold && "font-bold")}>{captionLabelText(f, sample)}</span> 캡션 예시
        </p>
        <p className="text-xs text-muted-foreground">본문 참조: {referenceText(kind, sample, format)}</p>
      </Preview>
    </Card>
  );
}

function EquationCard() {
  const { store } = usePaper();
  const format = useFormat();
  const eq = format.equation;
  const sample = eq.numbering === "section" ? "2.1" : "3";

  return (
    <Card title="수식" onReset={() => store.resetFormat("equation")}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="번호 방식" htmlFor="equation-numbering" className="col-span-2">
          <SelectField
            id="equation-numbering"
            value={eq.numbering}
            options={EQUATION_NUMBERING_OPTIONS}
            onChange={(v) => store.setFormatValue("equation.numbering", v)}
          />
        </Field>
        <Field label="괄호" htmlFor="equation-brackets">
          <SelectField
            id="equation-brackets"
            value={eq.brackets}
            options={BRACKET_OPTIONS}
            onChange={(v) => store.setFormatValue("equation.brackets", v)}
          />
        </Field>
        <Field label="본문 참조 표기" htmlFor="equation-refLabel">
          <TextField
            id="equation-refLabel"
            value={eq.refLabel}
            placeholder="없음"
            onChange={(v) => store.setFormatValue("equation.refLabel", v)}
          />
        </Field>
      </div>
      <Preview>
        <p className="flex justify-between gap-4">
          <span className="text-muted-foreground italic">E = mc²</span>
          <span>{equationNumberText(sample, eq.brackets)}</span>
        </p>
        <p className="text-xs text-muted-foreground">본문 참조: {referenceText("equation", sample, format)}</p>
      </Preview>
    </Card>
  );
}

function SectionCard() {
  const { store } = usePaper();
  const format = useFormat();

  return (
    <Card
      title="절·부록·참고문헌"
      onReset={() => {
        store.resetFormat("section");
        store.resetFormat("appendix");
        store.resetFormat("references");
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="제목 번호"
          htmlFor="section-numberFormat"
          className="col-span-2"
          hint="부록은 A, A.1, A.1.1로 매깁니다(번호 없음이면 부록 제목만)."
        >
          <SelectField
            id="section-numberFormat"
            value={format.section.numberFormat}
            options={HEADING_NUMBERING_OPTIONS}
            onChange={(v) => store.setFormatValue("section.numberFormat", v)}
          />
        </Field>
        <Field
          label="절 참조 표기"
          htmlFor="section-refLabel"
          hint={
            <>
              <code>{"{n}"}</code>을 넣으면 그 자리에 번호가 들어갑니다. 예: <code>{"{n}절"}</code> → 2절
            </>
          }
        >
          <TextField
            id="section-refLabel"
            value={format.section.refLabel}
            placeholder="없음"
            onChange={(v) => store.setFormatValue("section.refLabel", v)}
          />
        </Field>
        <Field label="부록 표기" htmlFor="appendix-label" hint="부록 제목 번호와 부록 참조 앞에 붙습니다.">
          <TextField
            id="appendix-label"
            value={format.appendix.label}
            placeholder="없음"
            onChange={(v) => store.setFormatValue("appendix.label", v)}
          />
        </Field>
        <Field label="참고문헌 제목" htmlFor="references-title">
          <TextField
            id="references-title"
            value={format.references.title}
            onChange={(v) => store.setFormatValue("references.title", v)}
          />
        </Field>
      </div>
      <Preview>
        <p className="text-xs text-muted-foreground">
          본문 참조:{" "}
          {format.section.numberFormat === "none"
            ? "절 번호 없음"
            : referenceText("section", format.section.numberFormat === "ieee" ? "II-A" : "2.1", format)}{" "}
          · {referenceText("section", "A", format, true)}
        </p>
      </Preview>
    </Card>
  );
}

/** Made-up references for the preview */
const SAMPLE_REFERENCES: Reference[] = [
  {
    ...emptyReference(),
    id: "sample-1",
    title: "Writing papers together in real time",
    authors: ["Minji Kim", "Jiho Lee"],
    year: "2020",
    venue: "Journal of Collaborative Writing",
    volume: "12",
    issue: "3",
    pages: "45–67",
  },
  {
    ...emptyReference(),
    id: "sample-2",
    type: "inproceedings",
    title: "Citation styles for shared editors",
    authors: ["Alex Park", "Sam Choi", "Dana Han"],
    year: "2021",
    venue: "Proceedings of the Workshop on Writing Tools",
    pages: "1–10",
  },
];
const SAMPLE_IDS = SAMPLE_REFERENCES.map((r) => r.id);

const CITATION_STYLE_OPTIONS = (Object.keys(CITATION_STYLES) as CitationStyle[]).map((value) => ({
  value,
  label: CITATION_STYLES[value].label,
}));

function CitationCard() {
  const { store } = usePaper();
  const format = useFormat();
  const citation = format.citation;
  const layout = layoutCitations(SAMPLE_REFERENCES, SAMPLE_IDS, citation);
  const authorDate = isAuthorDate(citation.style);
  const samples = [
    citationText(SAMPLE_IDS, layout),
    citationText(SAMPLE_IDS.slice(0, 1), layout, { locator: "p. 5" }),
    ...(authorDate ? [citationText(SAMPLE_IDS.slice(0, 1), layout, { mode: "narrative" })] : []),
  ];

  return (
    <Card title="인용·참고문헌 목록" onReset={() => store.resetFormat("citation")}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="인용 양식" htmlFor="citation-style" className="col-span-2" hint={CITATION_STYLES[citation.style].hint}>
          <SelectField
            id="citation-style"
            value={citation.style}
            options={CITATION_STYLE_OPTIONS}
            onChange={(v) => store.setFormatValue("citation.style", v)}
          />
        </Field>
        <Field
          label="목록 순서"
          htmlFor="citation-order"
          className="col-span-2"
          hint={citation.order === "manual" ? "참고문헌 패널에서 끌어서 정합니다." : undefined}
        >
          <SelectField
            id="citation-order"
            value={citation.order}
            options={[
              {
                value: "style",
                label: `양식대로 (${sortsByAuthor(citation.style) ? "저자·연도 순" : "처음 인용한 순"})`,
              },
              { value: "manual", label: "직접 정렬" },
            ]}
            onChange={(v) => store.setFormatValue("citation.order", v)}
          />
        </Field>
        <Field
          label="인용하지 않은 문헌도 목록에 넣기"
          htmlFor="citation-listUncited"
          className="col-span-2"
          hint="끄면 인용하지 않은 문헌은 인쇄와 내보내기에서 빠지고, 화면에는 흐리게 남습니다."
        >
          <Switch
            id="citation-listUncited"
            checked={citation.listUncited}
            onCheckedChange={(v) => store.setFormatValue("citation.listUncited", v)}
          />
        </Field>
      </div>
      <Preview>
        <p className="text-xs text-muted-foreground">본문 인용: {samples.join(" · ")}</p>
        <ol className="mt-1.5 flex flex-col gap-1 text-xs">
          {layout.entries.map((entry) => (
            <li key={entry.ref.id} className={cn("flex gap-2", authorDate && "pl-4 -indent-4")}>
              {!authorDate && <span className="shrink-0 tabular-nums">{entryLabel(entry, citation.style)}</span>}
              <span className="min-w-0">
                {formatReferenceAs(entry.ref, citation.style, layout).map((s, i) =>
                  s.italic ? <i key={i}>{s.text}</i> : <span key={i}>{s.text}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </Preview>
    </Card>
  );
}

function valueAt(format: PaperFormat, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], format);
}

function ObjectsTab() {
  const { store } = usePaper();
  const format = useFormat();
  const presets = Object.keys(LABEL_PRESETS) as LabelPreset[];

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">표기 언어</span>
          <span className="text-xs text-muted-foreground">
            그림·표·수식·절·부록 라벨과 참고문헌 제목을 한 번에 바꿉니다. 번호 형식과 위치는 그대로 둡니다.
          </span>
        </div>
        <div className="flex gap-1.5">
          {presets.map((preset) => {
            const { label, values } = LABEL_PRESETS[preset];
            const active = Object.entries(values).every(([path, value]) => valueAt(format, path) === value);
            return (
              <Button
                key={preset}
                size="sm"
                variant={active ? "secondary" : "outline"}
                aria-pressed={active}
                onClick={() => store.setFormatValues(values)}
              >
                {label}
              </Button>
            );
          })}
        </div>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <FloatCard kind="figure" />
        <FloatCard kind="table" />
        <EquationCard />
        <SectionCard />
        <CitationCard />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ page & export

function PageTab() {
  const { store } = usePaper();
  const format = useFormat();
  const { page } = format;
  const paper = PAPER_SIZES[page.paper];
  const textWidth = paper.width - page.marginLeft - page.marginRight;
  const textHeight = paper.height - page.marginTop - page.marginBottom;
  const mm = (n: number) => Math.round(n * 10) / 10;
  const documentClass = format.latex.documentClass;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="용지" onReset={() => store.resetFormat("page")}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="크기" htmlFor="page-paper" className="col-span-2">
            <SelectField
              id="page-paper"
              value={page.paper}
              options={PAPER_OPTIONS}
              onChange={(v) => store.setFormatValue("page.paper", v)}
            />
          </Field>
          {MARGIN_FIELDS.map(({ field, label }) => (
            <Field key={field} label={`${label} 여백`}>
              <NumberStepper
                value={page[field]}
                min={MARGIN_RANGE.min}
                max={MARGIN_RANGE.max}
                label={`${label} 여백`}
                unit="mm"
                onChange={(v) => store.setFormatValue(`page.${field}`, v)}
              />
            </Field>
          ))}
        </div>
        <Preview>
          <p className="text-xs text-muted-foreground">
            본문 영역 {mm(textWidth)} × {mm(textHeight)} mm. 편집 화면·인쇄(PDF)·Word·HWPX에 적용되고, 2단은 지원하지
            않습니다.
          </p>
        </Preview>
      </Card>
      <Card title="LaTeX 내보내기" onReset={() => store.resetFormat("latex")}>
        <Field label="문서 클래스" htmlFor="latex-documentClass" hint={LATEX_CLASSES[documentClass].hint}>
          <SelectField
            id="latex-documentClass"
            value={documentClass}
            options={LATEX_CLASS_OPTIONS}
            onChange={(v) => store.setFormatValue("latex.documentClass", v)}
          />
        </Field>
        <Preview>
          <p className="text-xs text-muted-foreground">
            클래스 파일은 내보내지 않습니다. TeX 배포판(TeX Live 등)이나 학회 저자 키트의 것을 씁니다.
          </p>
        </Preview>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ prefabs

/** The editor's own format, offered next to the server's prefabs */
const DEFAULT_PREFAB: FormatPrefab = {
  id: "default",
  label: "기본 양식",
  description: "A4, 여백 25 mm, Times New Roman · Noto Serif KR, 제목 1 / 1.1 / 1.1.1. 처음 문서를 만들 때의 양식입니다.",
  format: {},
};

function PrefabsTab() {
  const { store } = usePaper();
  const format = useFormat();
  const [prefabs, setPrefabs] = useState<FormatPrefab[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<FormatPrefab | null>(null);

  useEffect(() => {
    api.listPrefabs().then(setPrefabs, () => setFailed(true));
  }, []);

  const current = JSON.stringify(format);
  const isActive = (prefab: FormatPrefab) =>
    JSON.stringify(readFormat(defaultFormat(), Object.entries(prefab.format))) === current;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        학회·학술지 저자 안내의 쪽 크기, 글꼴, 간격, 캡션, 제목 번호를 한 번에 적용합니다. 공식 템플릿이 아니라 그
        규칙을 따른 근사이며, 2단과 저자-연도 인용은 지원하지 않습니다. 본문 내용은 바뀌지 않습니다.
      </p>
      {failed && <p className="text-sm text-destructive">서버에서 양식 목록을 불러오지 못했습니다.</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {[DEFAULT_PREFAB, ...(prefabs ?? [])].map((prefab) => {
          const active = isActive(prefab);
          return (
            <section key={prefab.id} className={cn("flex flex-col gap-2 rounded-lg border p-3", active && "border-primary")}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-medium">{prefab.label}</h3>
                {active ? (
                  <Badge variant="secondary">
                    <CheckIcon /> 사용 중
                  </Badge>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setPending(prefab)}>
                    적용
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{prefab.description}</p>
            </section>
          );
        })}
        {!prefabs && !failed && (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> 양식 목록을 불러오는 중…
          </div>
        )}
      </div>
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>&lsquo;{pending?.label}&rsquo; 양식을 적용할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              문서 양식 전체(단락 스타일, 캡션·번호, 쪽)가 이 양식의 값으로 바뀌고, 직접 바꿔 둔 값은 사라집니다. 모든
              공동 작업자에게 바로 적용됩니다. 본문 내용은 그대로입니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) store.replaceFormat(pending.format);
                setPending(null);
              }}
            >
              적용
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ------------------------------------------------------------------ dialog

interface FormatDialogProps {
  open: boolean;
  initialTab?: FormatDialogTab;
  initialStyle?: StyleKey;
  onOpenChange: (open: boolean) => void;
}

/** "문서 양식": paragraph styles plus caption and numbering formats, shared by all collaborators. */
export function FormatDialog({ open, initialTab, initialStyle, onOpenChange }: FormatDialogProps) {
  const [tab, setTab] = useState<FormatDialogTab>(initialTab ?? "styles");
  const [styleKey, setStyleKey] = useState<StyleKey>(initialStyle ?? "body");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>문서 양식</DialogTitle>
          <DialogDescription>
            모든 공동 작업자에게 똑같이 적용됩니다. LaTeX 내보내기에는 문서 클래스와 캡션·번호 형식만 반영됩니다.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as FormatDialogTab)} className="min-h-0 flex-1">
          <TabsList>
            <TabsTrigger value="styles">단락 스타일</TabsTrigger>
            <TabsTrigger value="objects">캡션·번호</TabsTrigger>
            <TabsTrigger value="page">쪽·내보내기</TabsTrigger>
            <TabsTrigger value="prefabs">논문 양식</TabsTrigger>
          </TabsList>
          <TabsContent value="styles" className="min-h-0 overflow-y-auto pr-1">
            <StylesTab selected={styleKey} onSelect={setStyleKey} />
          </TabsContent>
          <TabsContent value="objects" className="min-h-0 overflow-y-auto pr-1">
            <ObjectsTab />
          </TabsContent>
          <TabsContent value="page" className="min-h-0 overflow-y-auto pr-1">
            <PageTab />
          </TabsContent>
          <TabsContent value="prefabs" className="min-h-0 overflow-y-auto pr-1">
            <PrefabsTab />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
