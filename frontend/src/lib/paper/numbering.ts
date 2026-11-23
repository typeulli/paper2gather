import type { Node as PMNode } from "@tiptap/pm/model";
import { applyRefLabel, formatNumber, type HeadingNumbering, type PaperFormat } from "./format";
import { LABEL_PREFIX } from "./labels";
import { parseRefIds } from "./references";
import type { ObjectKind } from "./types";

export interface NumberedObject {
  id: string;
  label: string;
  kind: ObjectKind;
  /** null for unnumbered equations / headings; what references show ("2.1", "II-A") */
  number: string | null;
  /** Headings: what is shown in front of the title ("2.1", "A.", "Appendix A"), null for none */
  shown?: string | null;
  pos: number;
  /** heading text, caption or LaTeX source */
  text: string;
  level?: number;
  /** After the appendix break: numbers start with the appendix letter (A, A.1, Figure A.1 …) */
  appendix?: boolean;
}

export interface NumberingSnapshot {
  objects: NumberedObject[];
  byId: Map<string, NumberedObject>;
  /** Reference ids in order of their first citation in the document */
  citationOrder: string[];
  /** Reference id -> number of times it is cited */
  citationCounts: Map<string, number>;
}

export const EMPTY_NUMBERING: NumberingSnapshot = {
  objects: [],
  byId: new Map(),
  citationOrder: [],
  citationCounts: new Map(),
};

/** Node type name -> kind of numbered object */
export const NUMBERED_NODE_KINDS: Record<string, ObjectKind> = {
  heading: "section",
  equation: "equation",
  figure: "figure",
  tableFigure: "table",
};

export function defaultLabel(kind: ObjectKind, id: string): string {
  return `${LABEL_PREFIX[kind]}:${id}`;
}

/** Parts of the format that numbers or heading numbers depend on; a change requires recomputing them. */
export function numberingSignature(format: PaperFormat): string {
  return [
    format.equation.numbering,
    format.figure.numberStyle,
    format.table.numberStyle,
    format.appendix.label,
    format.section.numberFormat,
  ].join("|");
}

/**
 * The number of a heading for references and the one shown in front of it, from the counts of its level and the
 * levels above. Appendix headings are A, A.1, A.1.1 whatever the style, except that "none" numbers only the
 * appendices themselves.
 */
export function headingNumbers(
  counts: number[],
  level: number,
  appendix: boolean,
  style: HeadingNumbering
): { number: string | null; shown: string | null } {
  const own = counts.slice(0, level);
  if (appendix) {
    if (style === "none" && level > 1) return { number: null, shown: null };
    const number = [formatNumber(own[0], "upper-alpha"), ...own.slice(1)].join(".");
    return { number, shown: number };
  }
  switch (style) {
    case "none":
      return { number: null, shown: null };
    case "ieee": {
      // IEEEtran: I, II-A, II-A1; shown as "II.", "A.", "1)"
      const [section, subsection, subsubsection] = own;
      const parts = [formatNumber(section, "upper-roman")];
      if (level >= 2) parts.push(`-${formatNumber(subsection, "upper-alpha")}`);
      if (level >= 3) parts.push(String(subsubsection));
      const shown = level === 1 ? `${parts[0]}.` : level === 2 ? `${formatNumber(subsection, "upper-alpha")}.` : `${subsubsection})`;
      return { number: parts.join(""), shown };
    }
    default: {
      const number = own.join(".");
      return { number, shown: style === "decimal-period" && level === 1 ? `${number}.` : number };
    }
  }
}

export function computeNumbering(doc: PMNode, format: PaperFormat): NumberingSnapshot {
  const objects: NumberedObject[] = [];
  const sections = [0, 0, 0];
  let equation = 0;
  let equationInSection = 0;
  let figure = 0;
  let table = 0;
  let appendix = false;
  /** Appendix whose equations, figures and tables are being counted */
  let appendixLetter = "";
  const citationOrder: string[] = [];
  const citationCounts = new Map<string, number>();
  /** "2" -> "A.2" in the appendix */
  const prefixAppendix = (n: string) => (appendix ? `${appendixLetter}.${n}` : n);

  const push = (
    node: PMNode,
    pos: number,
    kind: ObjectKind,
    number: string | null,
    text: string,
    shown?: string | null
  ) => {
    const id = node.attrs.id as string | null;
    if (!id) return;
    objects.push({
      id,
      label: (node.attrs.label as string | null) || defaultLabel(kind, id),
      kind,
      number,
      ...(kind === "section" ? { shown } : {}),
      pos,
      text,
      level: kind === "section" ? (node.attrs.level as number) : undefined,
      appendix,
    });
  };

  doc.descendants((node, pos) => {
    switch (node.type.name) {
      case "appendixBreak":
        // Like \appendix: the following level-1 headings are appendices A, B … Only the first break counts.
        if (!appendix) {
          appendix = true;
          sections.fill(0);
          // Objects before the first appendix heading belong to appendix A.
          appendixLetter = "A";
          equationInSection = 0;
          figure = 0;
          table = 0;
        }
        return false;
      case "heading": {
        const level = node.attrs.level as number;
        let number: string | null = null;
        let shown: string | null = null;
        if (node.attrs.numbered !== false && level <= 3) {
          sections[level - 1]++;
          for (let l = level; l < sections.length; l++) sections[l] = 0;
          const top = appendix ? formatNumber(sections[0], "upper-alpha") : String(sections[0]);
          ({ number, shown } = headingNumbers(sections, level, appendix, format.section.numberFormat));
          // "Appendix A  Title"; its subsections are numbered "A.1" as usual.
          if (appendix && level === 1 && shown) shown = applyRefLabel(format.appendix.label, shown);
          if (level === 1 && !(appendix && top === appendixLetter)) {
            equationInSection = 0;
            // Each appendix numbers its equations, figures and tables anew: (A.1), Figure A.1 …
            if (appendix) {
              appendixLetter = top;
              figure = 0;
              table = 0;
            }
          }
        }
        push(node, pos, "section", number, node.textContent, shown);
        return false;
      }
      case "equation": {
        let number: string | null = null;
        if (node.attrs.numbered !== false) {
          equation++;
          equationInSection++;
          // In the appendix always per appendix, regardless of the numbering mode
          number = appendix
            ? prefixAppendix(String(equationInSection))
            : format.equation.numbering === "section"
              ? `${sections[0]}.${equationInSection}`
              : String(equation);
        }
        push(node, pos, "equation", number, node.attrs.latex as string);
        return false;
      }
      case "figure":
        push(
          node,
          pos,
          "figure",
          prefixAppendix(formatNumber(++figure, format.figure.numberStyle)),
          node.attrs.caption as string
        );
        return false;
      case "tableFigure":
        push(
          node,
          pos,
          "table",
          prefixAppendix(formatNumber(++table, format.table.numberStyle)),
          node.attrs.caption as string
        );
        return true;
      case "citation":
        for (const id of parseRefIds(node.attrs.refs)) {
          if (!citationCounts.has(id)) citationOrder.push(id);
          citationCounts.set(id, (citationCounts.get(id) ?? 0) + 1);
        }
        return false;
      default:
        return true;
    }
  });

  return {
    objects,
    byId: new Map(objects.map((o) => [o.id, o])),
    citationOrder,
    citationCounts,
  };
}

/** Minimal observable used by node views and side panels. */
export class NumberingStore {
  private snapshot: NumberingSnapshot = EMPTY_NUMBERING;
  private listeners = new Set<() => void>();
  private scheduled = false;

  get = (): NumberingSnapshot => this.snapshot;

  set(snapshot: NumberingSnapshot): void {
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    // Defer notifications: ProseMirror may update while React is rendering.
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.listeners.forEach((l) => l());
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
