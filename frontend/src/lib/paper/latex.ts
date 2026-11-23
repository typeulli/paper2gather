import type { JSONContent } from "@tiptap/core";
import { resolveAssetUrl } from "@/lib/config";
import { splitInlineMath } from "@/lib/editor-utils";
import { splitList } from "@/lib/tikz/options";
import {
  refLabelOf,
  type CaptionSeparator,
  type FloatFormat,
  type LatexClass,
  type NumberStyle,
  type PaperFormat,
} from "./format";
import type { NumberedObject } from "./numbering";
import { referenceToBibtex } from "./bibtex";
import { formatReferenceAs, isAuthorDate, type CitationLayout } from "./citations";
import { makeCitationKey, parseRefIds } from "./references";
import type { Author } from "./types";

export interface LatexExportInput {
  content: JSONContent;
  title: string;
  authors: Author[];
  /** The reference list and what citations show */
  citations: CitationLayout;
  /** Only the document class and caption and numbering formats are exported; paragraph styles belong to the class. */
  format: PaperFormat;
  objectsById: Map<string, NumberedObject>;
}

const COUNTER_FORMAT: Record<NumberStyle, string> = {
  arabic: "\\arabic",
  "upper-roman": "\\Roman",
  "lower-roman": "\\roman",
  "upper-alpha": "\\Alph",
  "lower-alpha": "\\alph",
};

/** caption package `labelsep` values ("emdash" is declared in the preamble). */
const LABEL_SEPARATORS: Record<CaptionSeparator, string> = {
  period: "period",
  colon: "colon",
  emdash: "emdash",
  none: "space",
};

export interface LatexExportResult {
  tex: string;
  /** Images referenced by the document; they must be placed next to the .tex file. */
  figures: { url: string; path: string }[];
}

const ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  "^": "\\textasciicircum{}",
  _: "\\_",
  "%": "\\%",
  "~": "\\textasciitilde{}",
};

export function escapeLatex(text: string): string {
  return text.replace(/[\\{}$&#^_%~]/g, (ch) => ESCAPES[ch]);
}

/** Escapes text but keeps `$...$` segments as math. */
function escapeWithMath(text: string): string {
  return splitInlineMath(text)
    .map((p) => (p.math ? `$${p.text}$` : escapeLatex(p.text)))
    .join("");
}

const MARK_COMMANDS: Record<string, string> = {
  bold: "textbf",
  italic: "emph",
  underline: "underline",
  strike: "sout",
  code: "texttt",
  subscript: "textsubscript",
  superscript: "textsuperscript",
};

const ABSTRACT_TITLES = /^(abstract|초록|요약)$/i;

/** "Fig." + ref -> "Fig.~\ref{…}", "{n}절" + ref -> "\ref{…}절" */
function withRefLabel(refLabel: string, ref: string): string {
  if (refLabel.includes("{n}")) return refLabel.split("{n}").map(escapeLatex).join(ref);
  return refLabel ? `${escapeLatex(refLabel)}~${ref}` : ref;
}

class LatexWriter {
  private keys = new Map<string, string>();
  private appendixStarted = false;
  /** apa7 takes the abstract with \abstract{…} in the preamble instead of an environment. */
  abstract: string | null = null;
  readonly figures: { url: string; path: string }[] = [];
  /** What the TikZ figures need in the preamble, in order of first use */
  readonly tikz = { used: false, packages: new Set<string>(), libraries: new Set<string>(), scaled: false };

  constructor(private input: LatexExportInput) {
    const used = new Set<string>();
    for (const { ref } of input.citations.entries) {
      const key = ref.key && !used.has(ref.key) ? ref.key : makeCitationKey(ref, used);
      used.add(key);
      this.keys.set(ref.id, key);
    }
  }

  keyOf(refId: string): string {
    return this.keys.get(refId) ?? "?";
  }

  inline(nodes: JSONContent[] = []): string {
    return nodes.map((n) => this.inlineNode(n)).join("");
  }

  private inlineNode(n: JSONContent): string {
    switch (n.type) {
      case "text": {
        let out = escapeLatex(n.text ?? "");
        for (const mark of n.marks ?? []) {
          if (mark.type === "link") {
            const href = String(mark.attrs?.href ?? "").replace(/([%#\\])/g, "\\$1");
            out = `\\href{${href}}{${out}}`;
          } else if (MARK_COMMANDS[mark.type]) {
            out = `\\${MARK_COMMANDS[mark.type]}{${out}}`;
          }
        }
        return out;
      }
      case "hardBreak":
        return "\\\\\n";
      case "mathInline":
        return `$${n.attrs?.latex ?? ""}$`;
      case "citation":
        return this.cite(n);
      case "crossRef": {
        const target = this.input.objectsById.get(String(n.attrs?.target ?? ""));
        if (!target) return "??";
        // \eqref adds the equation brackets itself (see the \tagform@ setup in the preamble).
        const ref = `${target.kind === "equation" ? "\\eqref" : "\\ref"}{${target.label}}`;
        return withRefLabel(refLabelOf(target.kind, this.input.format, target.appendix), ref);
      }
      default:
        return this.inline(n.content);
    }
  }

  blocks(nodes: JSONContent[] = []): string {
    const out: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (
        node.type === "heading" &&
        node.attrs?.numbered === false &&
        ABSTRACT_TITLES.test(this.inline(node.content).trim())
      ) {
        const body: JSONContent[] = [];
        while (i + 1 < nodes.length && nodes[i + 1].type !== "heading" && nodes[i + 1].type !== "appendixBreak") {
          body.push(nodes[++i]);
        }
        if (this.input.format.latex.documentClass === "apa7") this.abstract = this.blocks(body).trim();
        else out.push(`\\begin{abstract}\n${this.blocks(body).trim()}\n\\end{abstract}`);
        continue;
      }
      const tex = this.block(node);
      if (tex.trim()) out.push(tex.trimEnd());
    }
    return out.join("\n\n");
  }

  private block(node: JSONContent): string {
    const attrs = node.attrs ?? {};
    switch (node.type) {
      case "paragraph":
        return this.inline(node.content);
      case "heading": {
        const cmd = ["section", "subsection", "subsubsection"][Math.min(Number(attrs.level ?? 1), 3) - 1];
        const star = attrs.numbered === false ? "*" : "";
        const label = attrs.numbered !== false && attrs.label ? `\\label{${attrs.label}}` : "";
        return `\\${cmd}${star}{${this.inline(node.content)}}${label}`;
      }
      case "bulletList":
      case "orderedList": {
        const env = node.type === "bulletList" ? "itemize" : "enumerate";
        const items = (node.content ?? []).map((li) => `  \\item ${this.blocks(li.content).trim()}`);
        return `\\begin{${env}}\n${items.join("\n")}\n\\end{${env}}`;
      }
      case "blockquote":
        return `\\begin{quote}\n${this.blocks(node.content)}\n\\end{quote}`;
      case "codeBlock":
        return `\\begin{verbatim}\n${(node.content ?? []).map((t) => t.text ?? "").join("")}\n\\end{verbatim}`;
      case "horizontalRule":
        return "\\noindent\\rule{\\linewidth}{0.4pt}";
      case "appendixBreak":
        return this.appendix();
      case "equation":
        return this.equation(attrs);
      case "figure":
        return this.figure(attrs);
      case "tableFigure": {
        const table = node.content?.[0];
        return this.float("table", this.input.format.table, attrs, table ? this.tabular(table) : "");
      }
      case "table":
        return `\\begin{center}\n${this.tabular(node)}\n\\end{center}`;
      default:
        return this.blocks(node.content);
    }
  }

  /** \appendix numbered like the editor: "Appendix A" headings, (A.1), Figure A.1 … per appendix. */
  private appendix(): string {
    // Only the first break counts, as in the editor.
    if (this.appendixStarted) return "";
    this.appendixStarted = true;
    const { format } = this.input;
    const objects = [
      "\\numberwithin{equation}{section}",
      "\\numberwithin{figure}{section}",
      "\\numberwithin{table}{section}",
      `\\renewcommand{\\thefigure}{\\thesection.${COUNTER_FORMAT[format.figure.numberStyle]}{figure}}`,
      `\\renewcommand{\\thetable}{\\thesection.${COUNTER_FORMAT[format.table.numberStyle]}{table}}`,
    ];
    if (format.latex.documentClass === "IEEEtran") {
      // IEEEtran's \appendix is a single appendix without its title; \appendices heads each "APPENDIX A" + title.
      const label = format.appendix.label;
      const name = label && !label.includes("{n}") ? [`\\renewcommand{\\appendixname}{${escapeLatex(label)}}`] : [];
      return ["\\appendices", ...name, ...objects].join("\n");
    }
    // Appendix subsections are A.1, A.1.1 in every heading numbering (headingCounters sets II-A for the others).
    const subsections =
      format.section.numberFormat === "ieee"
        ? [
            "\\renewcommand{\\thesubsection}{\\thesection.\\arabic{subsection}}",
            "\\renewcommand{\\thesubsubsection}{\\thesubsection.\\arabic{subsubsection}}",
          ]
        : [];
    return [
      "\\appendix",
      ...subsections,
      ...objects,
      // Section headings show the appendix label before the letter; subsections stay "A.1".
      "\\makeatletter",
      "\\renewcommand{\\@seccntformat}[1]{%",
      "  \\ifcsname appendix@#1\\endcsname\\csname appendix@#1\\endcsname\\else\\csname the#1\\endcsname\\fi\\quad}",
      `\\def\\appendix@section{${withRefLabel(format.appendix.label, "\\thesection")}}`,
      "\\makeatother",
    ].join("\n");
  }

  private equation(attrs: Record<string, unknown>): string {
    let latex = String(attrs.latex ?? "").trim();
    if (!latex) return "";
    // A bare multi-line equation needs an inner environment in LaTeX (KaTeX is more lenient).
    if (/\\\\/.test(latex) && !/\\begin\{/.test(latex)) {
      const env = latex.includes("&") ? "aligned" : "gathered";
      latex = `\\begin{${env}}\n${latex}\n\\end{${env}}`;
    }
    if (attrs.numbered === false) return `\\begin{equation*}\n${latex}\n\\end{equation*}`;
    const label = attrs.label ? `\\label{${attrs.label}}\n` : "";
    return `\\begin{equation}\n${label}${latex}\n\\end{equation}`;
  }

  private figure(attrs: Record<string, unknown>): string {
    if (typeof attrs.tikz === "string") return this.tikzFigure(attrs, attrs.tikz.trim());
    const src = String(attrs.src ?? "");
    const width = Math.min(100, Math.max(5, Number(attrs.width ?? 75))) / 100;
    let graphic = "% (이미지 없음)";
    if (src) {
      const name = src.split(/[?#]/)[0].split("/").pop() || "figure";
      const path = `figures/${name}`;
      this.figures.push({ url: resolveAssetUrl(src), path });
      graphic = `\\includegraphics[width=${width}\\linewidth]{${path}}`;
    }
    return this.float("figure", this.input.format.figure, attrs, graphic);
  }

  /** The TikZ code as written; a width in % scales it like the editor does (adjustbox). */
  private tikzFigure(attrs: Record<string, unknown>, code: string): string {
    const { tikz } = this;
    tikz.used = true;
    for (const name of splitList(attrs.tikzPackages as string)) tikz.packages.add(name);
    for (const name of splitList(attrs.tikzLibraries as string)) tikz.libraries.add(name);
    const width = Number(attrs.width ?? 0);
    let content = code || "% (TikZ 코드 없음)";
    if (code && width > 0) {
      tikz.scaled = true;
      content = `\\begin{adjustbox}{width=${Math.min(100, width) / 100}\\linewidth}\n${code}\n\\end{adjustbox}`;
    }
    return this.float("figure", this.input.format.figure, attrs, content);
  }

  /** A figure/table environment with the caption above or below the content. */
  private float(env: "figure" | "table", format: FloatFormat, attrs: Record<string, unknown>, content: string): string {
    const caption = [
      `\\caption{${escapeWithMath(String(attrs.caption ?? ""))}}`,
      attrs.label ? `\\label{${attrs.label}}` : "",
    ];
    const body = format.position === "above" ? [...caption, content] : [content, ...caption];
    return [`\\begin{${env}}[htbp]`, "\\centering", ...body, `\\end{${env}}`].filter(Boolean).join("\n");
  }

  private tabular(table: JSONContent): string {
    const rows = table.content ?? [];
    const colCount = Math.max(
      1,
      ...rows.map((r) => (r.content ?? []).reduce((n, c) => n + Number(c.attrs?.colspan ?? 1), 0))
    );
    const lines = ["\\begin{tabular}{" + "l".repeat(colCount) + "}", "\\toprule"];
    rows.forEach((row, i) => {
      const cells = (row.content ?? []).map((cell) => {
        const text = (cell.content ?? []).map((p) => this.inline(p.content)).join(" ");
        const span = Number(cell.attrs?.colspan ?? 1);
        return span > 1 ? `\\multicolumn{${span}}{l}{${text}}` : text;
      });
      lines.push(`${cells.join(" & ")} \\\\`);
      const isHeader = (row.content ?? []).every((c) => c.type === "tableHeader");
      if (isHeader && i < rows.length - 1) lines.push("\\midrule");
    });
    lines.push("\\bottomrule", "\\end{tabular}");
    return lines.join("\n");
  }

  /** \cite for numbered styles, \parencite or \textcite for biblatex-apa; the locator is the postnote. */
  private cite(n: JSONContent): string {
    const keys = parseRefIds(n.attrs?.refs).map((id) => this.keyOf(id));
    const locator = escapeLatex(String(n.attrs?.locator ?? "").trim()).replace(/\.\s+/g, ".~");
    const note = !locator ? "" : locator.includes("]") ? `[{${locator}}]` : `[${locator}]`;
    const command = !isAuthorDate(this.input.citations.style)
      ? "cite"
      : n.attrs?.mode === "narrative"
        ? "textcite"
        : "parencite";
    return `\\${command}${note}{${keys.join(",")}}`;
  }

  /**
   * The reference list. "numeric" writes it out as Paper2Gather shows it; the others hand a .bib to the
   * style's own BibTeX or biblatex style, which then decides the text.
   */
  bibliography(): Bibliography {
    const { style, entries } = this.input.citations;
    const listed = entries.filter((e) => e.listed);
    const none: Bibliography = { files: [], preamble: [], start: [], list: "" };
    if (listed.length === 0) return none;

    if (style === "numeric") {
      const items = listed.map(({ ref }) => {
        const text = formatReferenceAs(ref, style)
          .map((s) => (s.italic ? `\\emph{${escapeLatex(s.text)}}` : escapeLatex(s.text)))
          .join("");
        return `\\bibitem{${this.keyOf(ref.id)}}\n${text}`;
      });
      return {
        ...none,
        // Sorts and compresses numbers: [1, 3–5]
        preamble: ["\\usepackage{cite}"],
        list: [
          "% Order and numbers follow the reference list in Paper2Gather.",
          "\\begin{thebibliography}{99}",
          items.join("\n\n"),
          "\\end{thebibliography}",
        ].join("\n"),
      };
    }

    const bib = listed.map(({ ref }) =>
      referenceToBibtex(ref, {
        key: this.keyOf(ref.id),
        ordinalEdition: style === "springer",
        // splncs04 sorts works without authors by title, as Paper2Gather does, only when told so
        sortByTitle: style === "springer",
      })
    );
    // Listed entries in Paper2Gather's order: the order of unsorted styles (IEEEtran numbers by first citation)
    // and the uncited references the list keeps.
    const start = [`\\nocite{${listed.map(({ ref }) => this.keyOf(ref.id)).join(",")}}`];
    if (style === "ieee") {
      // IEEE: "et al." after the first author when there are more than six.
      bib.unshift(
        [
          "@IEEEtranBSTCTL{IEEEexample:BSTcontrol,",
          '  CTLuse_forced_etal = "yes",',
          '  CTLmax_names_forced_etal = "6",',
          '  CTLnames_show_etal = "1"',
          "}",
        ].join("\n")
      );
      // Before any other citation; \bstctlcite (IEEEtran.cls) cites it without a missing \bibitem warning.
      start.unshift("\\bstctlcite{IEEEexample:BSTcontrol}");
    }
    const files = [
      style === "apa"
        ? "% Compile with pdflatex, biber, pdflatex, pdflatex."
        : "% Compile with pdflatex, bibtex, pdflatex, pdflatex.",
      `% The references, written out as ${BIB_FILE} when the file is compiled.`,
      `\\begin{filecontents*}[overwrite]{${BIB_FILE}}`,
      bib.join("\n\n"),
      "\\end{filecontents*}",
    ];
    if (style === "apa") {
      return {
        files,
        preamble: [
          "\\usepackage[american]{babel}",
          "\\usepackage{csquotes}",
          "\\usepackage[style=apa,backend=biber]{biblatex}",
          `\\addbibresource{${BIB_FILE}}`,
        ],
        start,
        list: `\\printbibliography[title={${escapeLatex(this.input.format.references.title)}}]`,
      };
    }
    return {
      files,
      preamble:
        style === "ieee"
          ? [
              // [1], [2], [3] rather than [1, 2, 3]
              "\\usepackage[nocompress]{cite}",
              "\\renewcommand{\\citepunct}{], [}",
              // IEEEtran.cls's command, for other classes
              "\\makeatletter",
              "\\providecommand{\\bstctlcite}[1]{\\if@filesw\\immediate\\write\\@auxout{\\string\\citation{#1}}\\fi}",
              "\\makeatother",
            ]
          : ["\\usepackage{cite}"],
      start,
      list: [
        ...(style === "springer" ? ["% splncs04 sorts the list by author, year and title."] : []),
        `\\bibliographystyle{${style === "ieee" ? "IEEEtran" : "splncs04"}}`,
        `\\bibliography{${BIB_FILE.replace(/\.bib$/, "")}}`,
      ].join("\n"),
    };
  }
}

/** A fixed name: \jobname may hold spaces, which BibTeX doesn't take. */
const BIB_FILE = "paper2gather-refs.bib";

interface Bibliography {
  /** Before \documentclass */
  files: string[];
  preamble: string[];
  /** Right after \begin{document} */
  start: string[];
  /** Where the list goes */
  list: string;
}

function captionSetup(env: "figure" | "table", format: FloatFormat): string {
  const options = [`labelsep=${LABEL_SEPARATORS[format.separator]}`, `position=${format.position === "above" ? "top" : "bottom"}`];
  if (format.labelBold) options.push("labelfont=bf");
  return `\\captionsetup[${env}]{${options.join(",")}}`;
}

/**
 * The number a heading shows when it differs from the one references show (\the<counter>): "I." / "A." / "1)"
 * against "I-A1", or "1." against "1". The appendix replaces this with its own \@seccntformat.
 */
function headingDisplay(numbers: Record<string, string>): string[] {
  return [
    "\\makeatletter",
    "\\renewcommand{\\@seccntformat}[1]{%",
    "  \\ifcsname headnum@#1\\endcsname\\csname headnum@#1\\endcsname\\else\\csname the#1\\endcsname\\fi\\quad}",
    ...Object.entries(numbers).map(([counter, shown]) => `\\def\\headnum@${counter}{${shown}}`),
    "\\makeatother",
  ];
}

/** Heading numbers like the editor's, where the class doesn't number them that way itself */
function headingCounters(format: PaperFormat): string[] {
  const cls = format.latex.documentClass;
  switch (format.section.numberFormat) {
    case "none":
      return cls === "apa7" ? [] : ["\\setcounter{secnumdepth}{0}"];
    case "ieee":
      return cls === "IEEEtran"
        ? []
        : [
            "\\renewcommand{\\thesection}{\\Roman{section}}",
            "\\renewcommand{\\thesubsection}{\\thesection-\\Alph{subsection}}",
            "\\renewcommand{\\thesubsubsection}{\\thesubsection\\arabic{subsubsection}}",
            ...headingDisplay({
              section: "\\Roman{section}.",
              subsection: "\\Alph{subsection}.",
              subsubsection: "\\arabic{subsubsection})",
            }),
          ];
    case "decimal-period":
      // IEEEtran numbers its headings its own way and apa7 doesn't number them.
      return cls === "IEEEtran" || cls === "apa7" ? [] : headingDisplay({ section: "\\thesection." });
    default:
      return [];
  }
}

function formatPreamble(format: PaperFormat): string[] {
  const lines: string[] = [];
  // A journal class has its own caption layout; only label names and number formats follow the document.
  if (format.latex.documentClass === "article") {
    lines.push("\\usepackage{caption}");
    if (format.figure.separator === "emdash" || format.table.separator === "emdash") {
      lines.push("\\DeclareCaptionLabelSeparator{emdash}{~---~}");
    }
    lines.push(captionSetup("figure", format.figure), captionSetup("table", format.table));
  }
  lines.push(...headingCounters(format));
  if (format.equation.numbering === "section") lines.push("\\numberwithin{equation}{section}");
  if (format.equation.brackets !== "round") {
    const [open, close] = format.equation.brackets === "square" ? ["[", "]"] : ["", ""];
    lines.push(
      "\\makeatletter",
      `\\renewcommand{\\tagform@}[1]{\\maketag@@@{${open}\\ignorespaces#1\\unskip\\@@italiccorr${close}}}`,
      "\\makeatother"
    );
  }
  return lines;
}

/** Packages the preamble below loads anyway */
const BASE_PACKAGES = new Set(["amsmath", "amssymb", "amsfonts"]);

function tikzPreamble(tikz: LatexWriter["tikz"]): string[] {
  if (!tikz.used) return [];
  const lines = ["\\usepackage{tikz}"];
  for (const name of tikz.packages) if (!BASE_PACKAGES.has(name)) lines.push(`\\usepackage{${name}}`);
  if (tikz.libraries.size) lines.push(`\\usetikzlibrary{${[...tikz.libraries].join(",")}}`);
  if (tikz.scaled) lines.push("\\usepackage{adjustbox}");
  return lines;
}

/** Caption names and counter formats, set after \begin{document} so packages (e.g. kotex) can't override them. */
function formatNames(format: PaperFormat): string[] {
  return [
    `\\renewcommand{\\figurename}{${escapeLatex(format.figure.captionLabel)}}`,
    `\\renewcommand{\\tablename}{${escapeLatex(format.table.captionLabel)}}`,
    `\\renewcommand{\\thefigure}{${COUNTER_FORMAT[format.figure.numberStyle]}{figure}}`,
    `\\renewcommand{\\thetable}{${COUNTER_FORMAT[format.table.numberStyle]}{table}}`,
    `\\renewcommand{\\refname}{${escapeLatex(format.references.title)}}`,
  ];
}

const DOCUMENT_CLASSES: Record<LatexClass, string> = {
  article: "\\documentclass[11pt]{article}",
  IEEEtran: "\\documentclass[conference]{IEEEtran}",
  llncs: "\\documentclass{llncs}",
  apa7: "\\documentclass[man]{apa7}",
};

/** \author{…} and what else the class wants about the authors and the title */
function authorLines(input: LatexExportInput, title: string): string[] {
  if (input.format.latex.documentClass === "apa7") {
    // apa7 sets names and affiliations apart: \author and \affiliation. An empty one breaks \maketitle, so
    // they're left out then (apa7 warns and prints its placeholder).
    const names = input.authors.map((a) => escapeLatex(a.name)).filter(Boolean);
    const affiliations = [...new Set(input.authors.map((a) => a.affiliation.trim()).filter(Boolean))].map(escapeLatex);
    return [
      `\\shorttitle{${title}}`,
      ...(names.length ? [`\\author{${names.join(" and ")}}`] : []),
      ...(affiliations.length ? [`\\affiliation{${affiliations.join(" \\\\ ")}}`] : []),
    ];
  }
  const authors = input.authors
    .map((a) =>
      [escapeLatex(a.name), a.affiliation && escapeLatex(a.affiliation), a.email && `\\texttt{${escapeLatex(a.email)}}`]
        .filter(Boolean)
        .join(" \\\\ ")
    )
    .join(" \\and\n");
  return [`\\author{${authors}}`, "\\date{}"];
}

export function exportLatex(input: LatexExportInput): LatexExportResult {
  const writer = new LatexWriter(input);
  const body = writer.blocks(input.content.content);
  const bibliography = writer.bibliography();
  const title = escapeWithMath(input.title || "Untitled");
  const authors = authorLines(input, title);
  const everything = `${input.title}${body}${bibliography.files.join("")}${bibliography.list}${authors.join("")}${writer.abstract ?? ""}`;
  const needsKorean = /[\u3131-\u318e\uac00-\ud7a3]/.test(everything);

  const tex = [
    ...bibliography.files,
    DOCUMENT_CLASSES[input.format.latex.documentClass],
    needsKorean ? "\\usepackage{kotex}" : "",
    "\\usepackage{amsmath,amssymb,amsfonts}",
    "\\usepackage{graphicx}",
    ...tikzPreamble(writer.tikz),
    "\\usepackage{booktabs}",
    "\\usepackage[normalem]{ulem}",
    ...formatPreamble(input.format),
    ...bibliography.preamble,
    "\\usepackage{hyperref}",
    "",
    `\\title{${title}}`,
    ...authors,
    writer.abstract !== null ? `\\abstract{${writer.abstract}}` : "",
    "",
    "\\begin{document}",
    ...formatNames(input.format),
    ...bibliography.start,
    "\\maketitle",
    "",
    body,
    "",
    bibliography.list,
    "",
    "\\end{document}",
    "",
  ]
    .filter((line, i, arr) => line !== "" || arr[i - 1] !== "")
    .join("\n");

  return { tex, figures: writer.figures };
}
