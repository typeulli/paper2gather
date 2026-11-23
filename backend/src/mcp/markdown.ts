/**
 * Markdown with LaTeX → paper nodes. The dialect is described in the MCP server instructions
 * (server.ts); render.ts writes the same dialect.
 *
 * Numbered nodes come out with the label written in the markdown (or null) and no id; cross
 * references carry the label as `target`, citations the citation keys as `refs`. Paper.resolve
 * turns them into ids.
 */
import {
  createNode,
  createText,
  LABEL_PATTERN,
  LINK_DEFAULTS,
  UserError,
  type Marks,
  type PNode,
} from "./content.js";

const COMMENT = /^ {0,3}<!--/;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const DISPLAY_MATH = /^ {0,3}(\$\$|\\\[)/;
const MATH_ENV = /^ {0,3}\\begin\{(equation|align|gather|eqnarray)(\*?)\}/;
const APPENDIX = /^ {0,3}\\appendix[ \t]*$/;
const FIGURE =
  /^ {0,3}!\[(.*)\]\([ \t]*<?([^\s<>]+)>?(?:[ \t]+"[^"]*")?[ \t]*\)[ \t]*(?:\{([^{}]*)\})?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const CAPTION = /^ {0,3}Table:[ \t]*(.*)$/;
const FIGURE_CAPTION = /^ {0,3}Figure:[ \t]*(.*)$/;
const TABLE_ROW = /^ {0,3}\|/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;

/** Lines that start a block (and so end a paragraph) */
export function isBlockStart(line: string): boolean {
  return [
    COMMENT,
    FENCE,
    HEADING,
    DISPLAY_MATH,
    MATH_ENV,
    APPENDIX,
    FIGURE,
    RULE,
    CAPTION,
    FIGURE_CAPTION,
    TABLE_ROW,
    QUOTE,
    LIST_ITEM,
  ].some((re) => re.test(line));
}

/** Display math environments and what they become inside an equation */
const ENV_BODY: Record<string, (body: string) => string> = {
  equation: (body) => body,
  align: (body) => `\\begin{aligned}${body}\\end{aligned}`,
  eqnarray: (body) => `\\begin{aligned}${body}\\end{aligned}`,
  gather: (body) => `\\begin{gathered}${body}\\end{gathered}`,
};

const MIN_FIGURE_WIDTH = 10;

/** Packages the browser TeX engine of TikZ figures has (frontend lib/tikz/options.ts) */
const TIKZ_PACKAGES = [
  "pgfplots",
  "tikz-cd",
  "circuitikz",
  "chemfig",
  "tikz-3dplot",
  "tikz-feynhand",
  "amsmath",
  "amssymb",
  "array",
];

interface BlockAttrs {
  label?: string;
  numbered?: boolean;
  width?: number;
  /** TikZ figures */
  libraries?: string;
  packages?: string;
}

/** `{#label -}` style attributes; null when `inner` isn't an attribute list. */
function parseAttrs(inner: string): BlockAttrs | null {
  const attrs: BlockAttrs = {};
  for (const token of inner.trim().split(/\s+/).filter(Boolean)) {
    const width = /^width=(\d{1,3})%?$/.exec(token);
    const list = /^(libraries|packages)=([A-Za-z0-9.-]+(?:,[A-Za-z0-9.-]+)*)$/.exec(token);
    if (token.startsWith("#")) {
      const label = token.slice(1);
      if (!LABEL_PATTERN.test(label)) {
        throw new UserError(`Invalid label "${label}": use letters, digits and : _ - . only.`);
      }
      attrs.label = label;
    } else if (token === "-" || token === ".unnumbered") {
      attrs.numbered = false;
    } else if (width) {
      attrs.width = Math.min(100, Math.max(MIN_FIGURE_WIDTH, Number(width[1])));
    } else if (list) {
      attrs[list[1] as "libraries" | "packages"] = list[2];
    } else {
      return null;
    }
  }
  return attrs;
}

/** Splits trailing `{…}` attributes off a heading or caption. */
function splitAttrs(text: string): { text: string; attrs: BlockAttrs } {
  const m = /\{([^{}]*)\}[ \t]*$/.exec(text);
  const attrs = m ? parseAttrs(m[1]) : null;
  return m && attrs ? { text: text.slice(0, m.index).trimEnd(), attrs } : { text, attrs: {} };
}

/** ```tikz, also with the attributes right after it: ```tikz{#fig:x} */
const isTikzFence = (m: RegExpExecArray) => /^tikz(\{|$)/.test(m[2]);

const indentOf = (line: string) => line.length - line.trimStart().length;
const snippet = (s: string) =>
  JSON.stringify(s.trim().length > 60 ? `${s.trim().slice(0, 57)}...` : s.trim());

export interface ParseResult {
  nodes: PNode[];
  /** Things that were changed to fit the paper (heading levels …) */
  warnings: string[];
}

export function parseMarkdown(source: string): ParseResult {
  const parser = new BlockParser();
  const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return { nodes: parser.blocks(lines), warnings: parser.warnings };
}

/** Inline content only (text, marks, math, citations, references) */
export function parseInlineMarkdown(source: string): ParseResult {
  const warnings: string[] = [];
  return { nodes: new InlineParser(source.replace(/\r\n?/g, "\n"), warnings).parse(), warnings };
}

class BlockParser {
  readonly warnings: string[] = [];

  blocks(lines: string[]): PNode[] {
    const out: PNode[] = [];
    for (let i = 0; i < lines.length; ) {
      if (!lines[i].trim()) i++;
      else i = this.block(lines, i, out);
    }
    return out;
  }

  private inline(text: string): PNode[] {
    return new InlineParser(text, this.warnings).parse();
  }

  /** Parses the block starting at line `i` into `out` and returns the index of the next line. */
  private block(lines: string[], i: number, out: PNode[]): number {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (COMMENT.test(line)) {
      let j = i;
      while (j < lines.length && !lines[j].includes("-->")) j++;
      return j + 1;
    }
    if ((m = FENCE.exec(line))) {
      return isTikzFence(m) ? this.tikzFigure(lines, i, m, out) : this.codeBlock(lines, i, m, out);
    }
    if ((m = HEADING.exec(line))) {
      out.push(this.heading(m[1].length, m[2] ?? ""));
      return i + 1;
    }
    if (DISPLAY_MATH.test(line) || MATH_ENV.test(line)) return this.equation(lines, i, out);
    if (APPENDIX.test(line)) {
      out.push(createNode("appendixBreak"));
      return i + 1;
    }
    if ((m = FIGURE.exec(line))) {
      out.push(this.figure(m[1], m[2], m[3]));
      return i + 1;
    }
    if (RULE.test(line)) {
      out.push(createNode("horizontalRule"));
      return i + 1;
    }
    if ((m = CAPTION.exec(line))) {
      // The caption goes right above the table (one blank line allowed).
      const at = lines[i + 1]?.trim() ? i + 1 : i + 2;
      if (this.isTable(lines, at)) return this.table(lines, at, out, m[1]);
    }
    if ((m = FIGURE_CAPTION.exec(line))) {
      // or above a TikZ figure
      const at = lines[i + 1]?.trim() ? i + 1 : i + 2;
      const fence = at < lines.length ? FENCE.exec(lines[at]) : null;
      if (fence && isTikzFence(fence)) return this.tikzFigure(lines, at, fence, out, m[1]);
    }
    if (this.isTable(lines, i)) return this.table(lines, i, out);
    if (QUOTE.test(line)) return this.quote(lines, i, out);
    if (LIST_ITEM.test(line)) return this.list(lines, i, out);
    return this.paragraph(lines, i, out);
  }

  private heading(hashes: number, raw: string): PNode {
    const split = splitAttrs(raw);
    // Optional closing hashes: "## Title ##"
    const text = split.text.replace(/(^|[ \t]+)#+[ \t]*$/, "");
    const { attrs } = split;
    let level = hashes;
    if (level > 3) {
      this.warnings.push(
        `Headings go down to level 3; "${"#".repeat(hashes)} ${text}" became level 3.`
      );
      level = 3;
    }
    return createNode(
      "heading",
      { level, numbered: attrs.numbered ?? true, label: attrs.label ?? null },
      this.inline(text)
    );
  }

  private paragraph(lines: string[], i: number, out: PNode[]): number {
    const buffer = [lines[i]];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !isBlockStart(lines[j])) buffer.push(lines[j++]);
    const text = buffer
      .map((l) => l.trimStart())
      .join("\n")
      .trimEnd();
    out.push(createNode("paragraph", {}, this.inline(text)));
    return j;
  }

  private codeBlock(lines: string[], i: number, m: RegExpExecArray, out: PNode[]): number {
    const fence = m[1];
    const closing = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closing.test(lines[j])) body.push(lines[j++]);
    const code = body.join("\n");
    out.push(createNode("codeBlock", { language: m[2] || null }, code ? [createText(code)] : []));
    return j + 1;
  }

  /** ```tikz {attributes} … ``` with a "Figure:" caption line above or below (one blank line allowed) */
  private tikzFigure(
    lines: string[],
    i: number,
    m: RegExpExecArray,
    out: PNode[],
    captionAbove?: string
  ): number {
    // after "tikz" (the fence is made of ` or ~)
    const rest = lines[i].slice(lines[i].indexOf(m[2]) + "tikz".length).trim();
    const attrs = rest ? /^\{([^{}]*)\}$/.test(rest) && parseAttrs(rest.slice(1, -1)) : {};
    if (!attrs) throw new UserError(`Invalid TikZ figure attributes ${snippet(rest)}.`);
    const closing = new RegExp(`^ {0,3}${m[1][0] === "`" ? "`" : "~"}{${m[1].length},}[ \\t]*$`);
    const body: string[] = [];
    let next = i + 1;
    while (next < lines.length && !closing.test(lines[next])) body.push(lines[next++]);
    next++;
    let captionText = captionAbove;
    if (captionText === undefined) {
      const at = lines[next]?.trim() ? next : next + 1;
      const caption = at < lines.length ? FIGURE_CAPTION.exec(lines[at]) : null;
      if (caption) {
        captionText = caption[1];
        next = at + 1;
      }
    }
    const { text: caption, attrs: captionAttrs } = splitAttrs(captionText ?? "");
    const code = body
      .map((l) => l.trimEnd())
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
    if (!code.trim()) throw new UserError(`Empty TikZ figure at ${snippet(lines[i])}.`);
    const unknown = (attrs.packages ?? "")
      .split(",")
      .filter((p) => p && !TIKZ_PACKAGES.includes(p));
    if (unknown.length) {
      throw new UserError(
        `TikZ figures can't load ${unknown.join(", ")}; available packages: ${TIKZ_PACKAGES.join(", ")}.`
      );
    }
    out.push(
      createNode("figure", {
        tikz: code,
        tikzLibraries: attrs.libraries ?? "",
        tikzPackages: attrs.packages ?? "",
        caption: caption.trim(),
        // natural size unless a width is given
        width: attrs.width ?? 0,
        label: attrs.label ?? captionAttrs.label ?? null,
      })
    );
    return next;
  }

  /** Collects lines from `rest` (the rest of line `i`) until `close`; returns the text before and after it. */
  private until(
    lines: string[],
    i: number,
    rest: string,
    close: string
  ): { inner: string; tail: string; next: number } {
    const body: string[] = [];
    for (let j = i; ; ) {
      const at = rest.indexOf(close);
      if (at >= 0) {
        body.push(rest.slice(0, at));
        return { inner: body.join("\n"), tail: rest.slice(at + close.length), next: j + 1 };
      }
      body.push(rest);
      if (++j >= lines.length)
        throw new UserError(`Missing ${close} for the equation starting ${snippet(lines[i])}.`);
      rest = lines[j];
    }
  }

  private equation(lines: string[], i: number, out: PNode[]): number {
    const first = lines[i].trimStart();
    const env = MATH_ENV.exec(lines[i]);
    let numbered = true;
    let found: { inner: string; tail: string; next: number };
    let latex: string;
    if (env) {
      found = this.until(
        lines,
        i,
        first.slice(env[0].trimStart().length),
        `\\end{${env[1]}${env[2]}}`
      );
      numbered = env[2] !== "*";
      latex = ENV_BODY[env[1]](found.inner.trim());
    } else {
      found = this.until(lines, i, first.slice(2), first.startsWith("$$") ? "$$" : "\\]");
      latex = found.inner;
    }
    const tail = found.tail.trim();
    const attrs = tail ? /^\{([^{}]*)\}$/.exec(tail) && parseAttrs(tail.slice(1, -1)) : {};
    if (!attrs) throw new UserError(`Unexpected text after an equation: ${snippet(tail)}.`);
    // LaTeX habits: \label{} sets the label, \nonumber / \notag turn the number off.
    let label = attrs.label;
    latex = latex.replace(/\\label\{([^{}]*)\}/g, (_, name: string) => {
      label ??= name.trim();
      return "";
    });
    latex = latex.replace(/\\(nonumber|notag)\b/g, () => {
      numbered = false;
      return "";
    });
    latex = latex
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .replace(/^\s*\n|\n\s*$/g, "")
      .trim();
    if (!latex) throw new UserError(`Empty equation at ${snippet(lines[i])}.`);
    if (label !== undefined && !LABEL_PATTERN.test(label)) {
      throw new UserError(`Invalid label "${label}": use letters, digits and : _ - . only.`);
    }
    out.push(
      createNode("equation", { latex, numbered: attrs.numbered ?? numbered, label: label ?? null })
    );
    return found.next;
  }

  private figure(caption: string, src: string, attrText: string | undefined): PNode {
    if (!/^(https?:\/\/|\/uploads\/)/.test(src)) {
      throw new UserError(
        `Figure images must be http(s) URLs or /uploads/… paths, not ${snippet(src)}.`
      );
    }
    const attrs = attrText === undefined ? {} : parseAttrs(attrText);
    if (!attrs) throw new UserError(`Invalid figure attributes {${attrText}}.`);
    return createNode("figure", {
      src,
      caption: caption.trim(),
      width: attrs.width ?? 75,
      label: attrs.label ?? null,
    });
  }

  private isTable(lines: string[], i: number): boolean {
    return i + 1 < lines.length && TABLE_ROW.test(lines[i]) && TABLE_SEP.test(lines[i + 1]);
  }

  private table(lines: string[], i: number, out: PNode[], captionAbove?: string): number {
    const header = splitRow(lines[i]);
    const aligns = splitRow(lines[i + 1]).map((cell) =>
      cell.startsWith(":") && cell.endsWith(":")
        ? "center"
        : cell.endsWith(":")
          ? "right"
          : cell.startsWith(":")
            ? "left"
            : null
    );
    const body: string[][] = [];
    let j = i + 2;
    while (j < lines.length && TABLE_ROW.test(lines[j])) body.push(splitRow(lines[j++]));
    let captionText = captionAbove;
    if (captionText === undefined) {
      // or right below it
      const at = lines[j]?.trim() ? j : j + 1;
      const m = at < lines.length ? CAPTION.exec(lines[at]) : null;
      if (m) {
        captionText = m[1];
        j = at + 1;
      }
    }
    const { text: caption, attrs } = splitAttrs(captionText ?? "");
    const cols = header.length;
    if (body.some((r) => r.length > cols)) {
      this.warnings.push(`Cells beyond the ${cols} header columns of a table were dropped.`);
    }
    const row = (cells: string[], head: boolean) =>
      createNode(
        "tableRow",
        {},
        Array.from({ length: cols }, (_, c) =>
          createNode(head ? "tableHeader" : "tableCell", { align: aligns[c] ?? null }, [
            createNode("paragraph", {}, this.inline(cells[c] ?? "")),
          ])
        )
      );
    out.push(
      createNode("tableFigure", { caption: caption.trim(), label: attrs.label ?? null }, [
        createNode("table", {}, [row(header, true), ...body.map((r) => row(r, false))]),
      ])
    );
    return j;
  }

  private quote(lines: string[], i: number, out: PNode[]): number {
    const inner: string[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      const m = QUOTE.exec(lines[j]);
      if (m) inner.push(m[1]);
      // lazy continuation of a quoted paragraph
      else if (lines[j].trim() && !isBlockStart(lines[j]) && inner[inner.length - 1]?.trim())
        inner.push(lines[j]);
      else break;
    }
    const content = this.blocks(inner);
    out.push(createNode("blockquote", {}, content.length ? content : [createNode("paragraph")]));
    return j;
  }

  private list(lines: string[], i: number, out: PNode[]): number {
    const first = LIST_ITEM.exec(lines[i])!;
    const markerIndent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const kindOf = (m: RegExpExecArray) => (/\d/.test(m[2]) ? m[2].slice(-1) : m[2]);
    const kind = kindOf(first);
    const items: PNode[] = [];
    let j = i;
    for (;;) {
      const m = LIST_ITEM.exec(lines[j])!;
      const spaces = m[3]?.length ?? 0;
      const contentIndent = markerIndent + m[2].length + (m[4] && spaces <= 4 ? spaces : 1);
      // Indented lines, and nested list markers even when indented less than the content.
      const belongs = (line: string) =>
        indentOf(line) >= contentIndent ||
        (indentOf(line) > markerIndent && /^\s*([-*+]|\d{1,9}[.)])(\s|$)/.test(line));
      const body = [m[4] ?? ""];
      j++;
      while (j < lines.length) {
        const line = lines[j];
        if (!line.trim()) {
          let k = j;
          while (k < lines.length && !lines[k].trim()) k++;
          if (k < lines.length && belongs(lines[k])) {
            for (; j < k; j++) body.push("");
            continue;
          }
          break;
        }
        if (belongs(line)) body.push(line.slice(Math.min(indentOf(line), contentIndent)));
        // lazy continuation of the item's paragraph
        else if (!isBlockStart(line) && body[body.length - 1].trim()) body.push(line.trimStart());
        else break;
        j++;
      }
      const content = this.blocks(body);
      if (content[0]?.type !== "paragraph") content.unshift(createNode("paragraph"));
      items.push(createNode("listItem", {}, content));
      // The list goes on with the next item of the same kind, blank lines in between or not.
      let k = j;
      while (k < lines.length && !lines[k].trim()) k++;
      const next = k < lines.length ? LIST_ITEM.exec(lines[k]) : null;
      if (!next || next[1].length !== markerIndent || kindOf(next) !== kind) break;
      j = k;
    }
    out.push(
      ordered
        ? createNode("orderedList", { start: parseInt(first[2], 10) }, items)
        : createNode("bulletList", {}, items)
    );
    return j;
  }
}

/** Cells of a pipe table row; `|` inside math or code doesn't split. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let math = false;
  let code = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\" && k + 1 < s.length) {
      // Kept as is: "\|" is a literal bar in text and a norm in math.
      cell += c + s[++k];
      continue;
    }
    if (c === "`") code = !code;
    else if (c === "$" && !code) math = !math;
    if (c === "|" && !math && !code) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += c;
    }
  }
  cells.push(cell.trim());
  return cells;
}

interface Delim {
  open: string;
  close: string;
  mark: string;
  /** Must touch the text: no whitespace after the opener or before the closer */
  flanking?: boolean;
  /** Not inside words (snake_case stays text) */
  word?: boolean;
}

const tag = (name: string, mark: string): Delim => ({
  open: `<${name}>`,
  close: `</${name}>`,
  mark,
});

const DELIMS: Delim[] = [
  { open: "**", close: "**", mark: "bold", flanking: true },
  { open: "__", close: "__", mark: "bold", flanking: true, word: true },
  { open: "~~", close: "~~", mark: "strike", flanking: true },
  { open: "*", close: "*", mark: "italic", flanking: true },
  { open: "_", close: "_", mark: "italic", flanking: true, word: true },
  tag("b", "bold"),
  tag("strong", "bold"),
  tag("i", "italic"),
  tag("em", "italic"),
  tag("u", "underline"),
  tag("s", "strike"),
  tag("del", "strike"),
  tag("sub", "subscript"),
  tag("sup", "superscript"),
];

const PUNCT = /[!-/:-@[-`{-~]/;
const SPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;
const COMMAND = /\\(cite[a-zA-Z]*|textcite|Textcite|parencite|ref|eqref|autoref|cref|Cref)\*?((?:\[[^\]]*\])*)\{([^{}]*)\}/y;
/** Narrative citations: Kim (2020) */
const NARRATIVE_CITE = /^(citet|Citet|textcite|Textcite)$/;
const BREAK = /<br\s*\/?>/iy;
const PANDOC_CITE = /\[(@[^\]]*)\]/y;
/** "Eq.~" or "Fig. " before \ref: the reference shows its own label. */
const REF_WORD =
  /(^|[\s(])((?:eqs?|equations?|figs?|figures?|tabs?|tables?|secs?|sections?|appendix|appendices)\.?)(~|\s)$/i;
const SAFE_URL = /^(https?:|mailto:|#|\/|\.)/i;

const isCite = (command: string) => /^(cite|textcite|Textcite|parencite)/.test(command);

class InlineParser {
  private pos = 0;

  constructor(
    private readonly src: string,
    private readonly warnings: string[]
  ) {}

  parse(marks: Marks = {}): PNode[] {
    return this.run(null, marks).nodes;
  }

  private at(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  private opens(d: Delim): boolean {
    if (!this.src.startsWith(d.open, this.pos)) return false;
    const next = this.src[this.pos + d.open.length] ?? "";
    if (d.flanking && (!next || SPACE.test(next))) return false;
    return !(d.word && WORD.test(this.at(-1)));
  }

  private closes(d: Delim): boolean {
    if (!this.src.startsWith(d.close, this.pos)) return false;
    if (d.flanking && (!this.at(-1) || SPACE.test(this.at(-1)))) return false;
    return !(d.word && WORD.test(this.src[this.pos + d.close.length] ?? ""));
  }

  private sticky(re: RegExp): RegExpExecArray | null {
    re.lastIndex = this.pos;
    return re.exec(this.src);
  }

  /** Parses until the closer of `delim` (or the end). `closed` is false when no closer was found. */
  private run(delim: Delim | null, marks: Marks): { nodes: PNode[]; closed: boolean } {
    const nodes: PNode[] = [];
    const s = this.src;
    let text = "";
    const endText = () => {
      if (text) nodes.push(createText(text, { ...marks }));
      text = "";
    };
    const push = (...items: PNode[]) => {
      endText();
      nodes.push(...items);
    };

    while (this.pos < s.length) {
      if (delim && this.closes(delim)) {
        this.pos += delim.close.length;
        endText();
        return { nodes, closed: true };
      }
      const c = s[this.pos];
      let m: RegExpExecArray | null;

      if (c === "\\") {
        if ((m = this.sticky(COMMAND))) {
          this.pos += m[0].length;
          // "Fig.~\ref{…}": the tie becomes a space, a reference word is dropped.
          if (!isCite(m[1]) && !["autoref", "cref", "Cref"].includes(m[1])) {
            const word = REF_WORD.exec(text);
            if (word) {
              this.warnings.push(
                `Removed "${word[2]}" before \\${m[1]}{${m[3]}}: references show their own label.`
              );
              text = text.slice(0, word.index + word[1].length);
            }
          }
          if (text.endsWith("~")) text = `${text.slice(0, -1)} `;
          push(...this.command(m[1], m[3], marks, m[2]));
          continue;
        }
        if (s.startsWith("\\(", this.pos)) {
          const end = s.indexOf("\\)", this.pos + 2);
          if (end >= 0) {
            push(createNode("mathInline", { latex: s.slice(this.pos + 2, end).trim() }));
            this.pos = end + 2;
            continue;
          }
        }
        const next = this.at(1);
        if (next === "\n") {
          push(createNode("hardBreak"));
          this.pos += 2;
        } else if (next && PUNCT.test(next)) {
          text += next;
          this.pos += 2;
        } else {
          text += c;
          this.pos++;
        }
        continue;
      }

      if (c === "$") {
        const math = this.math();
        if (math) {
          push(math);
          continue;
        }
        text += c;
        this.pos++;
        continue;
      }

      if (c === "`") {
        const code = this.code();
        if (code) {
          push(code);
          continue;
        }
      }

      if (s.startsWith("<!--", this.pos)) {
        const end = s.indexOf("-->", this.pos);
        this.pos = end < 0 ? s.length : end + 3;
        continue;
      }

      if ((m = this.sticky(BREAK))) {
        push(createNode("hardBreak"));
        this.pos += m[0].length;
        continue;
      }

      if (c === "[") {
        if ((m = this.sticky(PANDOC_CITE))) {
          // [@key1; @key2, p. 3]: citation keys (or labels, see Paper.resolve) and the locator
          const parts = m[1].split(";").map((part) => /@([^\s,;\]]+)\s*(?:,\s*(.*))?$/.exec(part.trim()));
          const keys = parts.map((p) => p?.[1]).filter((key): key is string => !!key);
          if (keys.length) {
            this.pos += m[0].length;
            const locators = parts.map((p) => p?.[2]?.trim() ?? "");
            const locator = locators[locators.length - 1];
            if (locators.slice(0, -1).some(Boolean)) {
              this.warnings.push(`Kept only the last locator in [${m[1]}]: a citation has one, after its last key.`);
            }
            push(createNode("citation", { refs: keys.join(","), locator, pandoc: true }));
            continue;
          }
        }
        const link = this.link(marks);
        if (link) {
          push(...link);
          continue;
        }
      }

      if (c === "\n") {
        // Two spaces at the end of a line: line break; otherwise lines of a paragraph join with a space.
        if (text.endsWith("  ")) {
          text = text.trimEnd();
          push(createNode("hardBreak"));
        } else {
          text = `${text.trimEnd()} `;
        }
        this.pos++;
        continue;
      }

      const d = DELIMS.find((d) => this.opens(d));
      if (d) {
        const start = this.pos;
        this.pos += d.open.length;
        const inner = this.run(d, { ...marks, [d.mark]: {} });
        if (inner.closed) {
          push(...inner.nodes);
          continue;
        }
        // Unmatched: the opener is text.
        this.pos = start + d.open.length;
        text += d.open;
        continue;
      }

      text += c;
      this.pos++;
    }
    endText();
    return { nodes, closed: false };
  }

  private command(name: string, arg: string, marks: Marks, options = ""): PNode[] {
    const names = arg
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (names.length === 0) throw new UserError(`Empty \\${name}{}.`);
    if (isCite(name)) {
      // \cite[p. 5]{key}; natbib's \citep[see][p. 5]{key} keeps only the last option (the locator).
      const notes = [...options.matchAll(/\[([^\]]*)\]/g)].map((o) => o[1].trim());
      const locator = notes[notes.length - 1] ?? "";
      if (notes.slice(0, -1).some(Boolean)) {
        this.warnings.push(`Dropped the note before the locator in \\${name}${options}{${arg}}.`);
      }
      const mode = NARRATIVE_CITE.test(name) ? "narrative" : "paren";
      return [createNode("citation", { refs: names.join(","), mode, locator })];
    }
    return names.flatMap((label, i) => {
      const ref = createNode("crossRef", { target: label });
      return i ? [createText(", ", { ...marks }), ref] : [ref];
    });
  }

  /** $…$ (or $$…$$) with pandoc's rules: no space inside the dollars, no digit right after the closer. */
  private math(): PNode | null {
    const s = this.src;
    const delim = s.startsWith("$$", this.pos) ? "$$" : "$";
    const from = this.pos + delim.length;
    if (!s[from] || SPACE.test(s[from])) return null;
    for (let k = from; k < s.length; k++) {
      if (s[k] === "\\") {
        k++;
        continue;
      }
      if (!s.startsWith(delim, k)) continue;
      // Like LaTeX, the next dollar ends the math; if it can't close, "$5 and $10" is text.
      if (SPACE.test(s[k - 1]) || (delim === "$" && /\d/.test(s[k + 1] ?? ""))) return null;
      this.pos = k + delim.length;
      return createNode("mathInline", { latex: s.slice(from, k).replace(/\n/g, " ") });
    }
    return null;
  }

  private code(): PNode | null {
    const s = this.src;
    let n = 0;
    while (s[this.pos + n] === "`") n++;
    for (
      let k = s.indexOf("`".repeat(n), this.pos + n);
      k >= 0;
      k = s.indexOf("`".repeat(n), k + 1)
    ) {
      if (s[k + n] === "`" || s[k - 1] === "`") continue;
      let code = s.slice(this.pos + n, k).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim())
        code = code.slice(1, -1);
      this.pos = k + n;
      // The code mark excludes all other marks.
      return code ? createText(code, { code: {} }) : null;
    }
    return null;
  }

  /** [text](url) */
  private link(marks: Marks): PNode[] | null {
    const s = this.src;
    let depth = 0;
    let end = this.pos;
    for (; end < s.length; end++) {
      if (s[end] === "\\") end++;
      else if (s[end] === "[") depth++;
      else if (s[end] === "]" && --depth === 0) break;
    }
    if (s[end + 1] !== "(") return null;
    let close = end + 2;
    for (let parens = 0; close < s.length; close++) {
      if (s[close] === "(") parens++;
      else if (s[close] === ")" && parens-- === 0) break;
    }
    if (close >= s.length) return null;
    const href = s
      .slice(end + 2, close)
      .trim()
      .replace(/^<(.*)>$/, "$1")
      .split(/\s+/)[0];
    if (!href || (/^[a-z][a-z0-9+.-]*:/i.test(href) && !SAFE_URL.test(href))) return null;
    const label = new InlineParser(s.slice(this.pos + 1, end), this.warnings).parse({
      ...marks,
      link: { href, ...LINK_DEFAULTS },
    });
    this.pos = close + 1;
    return label;
  }
}
