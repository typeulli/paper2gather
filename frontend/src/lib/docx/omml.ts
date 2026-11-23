/**
 * Converts LaTeX to Office Math (OMML), the equations Word edits. It reads the MathML that KaTeX makes of the
 * formula, so it accepts what the editor shows, with its characters already resolved. Anything without an OMML
 * form makes the result null rather than an equation that looks different.
 */
import katex from "katex";
import { escapeXml } from "@/lib/hwpx/owpml";

export interface OmmlStyle {
  /** pt */
  size: number;
  /** #rrggbb, or empty for automatic */
  color: string;
  /** Font of text in the formula (\text, the equation number); math itself is in Cambria Math */
  latinFont: string;
  /** Font of Hangul and other CJK characters */
  koreanFont: string;
}

interface MathElement {
  name: string;
  attrs: Record<string, string>;
  children: MathNode[];
}

type MathNode = MathElement | string;

class NoForm extends Error {}

interface Context {
  style: OmmlStyle;
  /** #rrggbb or empty */
  color: string;
}

const MATH_FONT = "Cambria Math";

// ---------------------------------------------------------------- reading KaTeX's markup

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

/** KaTeX writes plain markup: elements, double-quoted attributes (sometimes with a space before "=") and text. */
function parseMarkup(markup: string): MathElement {
  const root: MathElement = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  for (let match = tag.exec(markup); match; match = tag.exec(markup)) {
    const [, closing, name, attrText, selfClosing, text] = match;
    const parent = stack[stack.length - 1];
    if (text !== undefined) {
      parent.children.push(decode(text));
    } else if (closing) {
      if (stack.length > 1) stack.pop();
    } else {
      const attrs: Record<string, string> = {};
      for (const attr of attrText.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[attr[1]] = decode(attr[2]);
      const element: MathElement = { name, attrs, children: [] };
      parent.children.push(element);
      if (!selfClosing) stack.push(element);
    }
  }
  return root;
}

function find(node: MathElement, name: string): MathElement | null {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.name === name) return child;
    const inner = find(child, name);
    if (inner) return inner;
  }
  return null;
}

function elementsOf(node: MathElement): MathElement[] {
  return node.children.filter((child): child is MathElement => typeof child !== "string");
}

/** Invisible operators (function application, invisible times …) say nothing Word shows. */
const INVISIBLE = /[\u200b\u2061-\u2064]/g;

function textOf(node: MathElement): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("")
    .replace(INVISIBLE, "");
}

const TOKENS = new Set(["mi", "mn", "mo", "mtext", "ms"]);

function isApply(node: MathElement | undefined): boolean {
  return !!node && node.name === "mo" && elementsOf(node).length === 0 && /^\u2061+$/.test(String(node.children.join("")));
}

// ---------------------------------------------------------------- runs

const COLOR_NAMES: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  yellow: "#ffff00",
  gray: "#808080",
  grey: "#808080",
  orange: "#ffa500",
  purple: "#800080",
  brown: "#a52a2a",
};

/** #rrggbb for a CSS color, or "" for one that can't be read */
function cssColor(value: string): string {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  if (COLOR_NAMES[v]) return COLOR_NAMES[v];
  if (typeof document !== "undefined") {
    const context = document.createElement("canvas").getContext("2d");
    if (context) {
      context.fillStyle = "#000001";
      context.fillStyle = v;
      const read = String(context.fillStyle);
      if (read !== "#000001" && /^#[0-9a-f]{6}$/.test(read)) return read;
    }
  }
  return "";
}

interface RunProps {
  sty?: "p" | "b" | "i" | "bi";
  scr?: string;
  /** Normal text: the document's fonts, upright, no math spacing */
  normal?: boolean;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
}

/** Character properties of the runs and of the structures (their delimiters, bars and operators). */
function wordRunProps(ctx: Context, props: RunProps = {}): string {
  const { style } = ctx;
  const latin = props.mono ? "Courier New" : props.normal ? style.latinFont : MATH_FONT;
  const half = Math.round(style.size * 2);
  return (
    `<w:rPr><w:rFonts w:ascii="${escapeXml(latin)}" w:hAnsi="${escapeXml(latin)}" ` +
    `w:eastAsia="${escapeXml(style.koreanFont)}" w:cs="${escapeXml(latin)}"/>` +
    (props.bold ? "<w:b/>" : "") +
    (props.italic ? "<w:i/>" : "") +
    (ctx.color ? `<w:color w:val="${ctx.color.slice(1).toUpperCase()}"/>` : "") +
    `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/></w:rPr>`
  );
}

function ctrl(ctx: Context): string {
  return `<m:ctrlPr>${wordRunProps(ctx)}</m:ctrlPr>`;
}

function run(text: string, ctx: Context, props: RunProps = {}): string {
  if (!text) return "";
  const math = props.normal ? "<m:nor/>" : (props.scr ? `<m:scr m:val="${props.scr}"/>` : "") + (props.sty ? `<m:sty m:val="${props.sty}"/>` : "");
  return (
    `<m:r>${math ? `<m:rPr>${math}</m:rPr>` : ""}${wordRunProps(ctx, props)}` +
    `<m:t xml:space="preserve">${escapeXml(text)}</m:t></m:r>`
  );
}

/** MathML's mathvariant as OMML's script and style */
const VARIANTS: Record<string, RunProps> = {
  normal: { sty: "p" },
  bold: { sty: "b" },
  italic: { sty: "i" },
  "bold-italic": { sty: "bi" },
  "double-struck": { scr: "double-struck", sty: "p" },
  script: { scr: "script", sty: "p" },
  "bold-script": { scr: "script", sty: "b" },
  fraktur: { scr: "fraktur", sty: "p" },
  "bold-fraktur": { scr: "fraktur", sty: "b" },
  "sans-serif": { scr: "sans-serif", sty: "p" },
  "bold-sans-serif": { scr: "sans-serif", sty: "b" },
  "sans-serif-italic": { scr: "sans-serif", sty: "i" },
  "sans-serif-bold-italic": { scr: "sans-serif", sty: "bi" },
  monospace: { scr: "monospace", sty: "p" },
};

function variant(node: MathElement): RunProps | null {
  const name = node.attrs.mathvariant;
  if (!name) return null;
  const props = VARIANTS[name];
  if (!props) throw new NoForm(name);
  return props;
}

/** Spacing in em as the spaces of Unicode, which Word sets in formulas as wide as they are meant to be. */
function spaces(em: number): string {
  // Em, en, three-per-em, four-per-em, medium mathematical, thin and hair space
  if (em >= 0.9) return "\u2003".repeat(Math.max(1, Math.round(em)));
  if (em >= 0.4) return "\u2002";
  if (em >= 0.3) return "\u2004";
  if (em >= 0.24) return "\u2005";
  if (em >= 0.2) return "\u205f";
  if (em >= 0.12) return "\u2009";
  return em > 0 ? "\u200a" : "";
}

function emOf(length: string | undefined): number {
  const match = /^(-?[\d.]+)(em|ex|mu|pt|px)?$/.exec((length ?? "").trim());
  if (!match) return 0;
  const value = parseFloat(match[1]);
  switch (match[2]) {
    case "ex":
      return value * 0.43;
    case "mu":
      return value / 18;
    case "pt":
      return value / 10;
    case "px":
      return value / 13.33;
    default:
      return value;
  }
}

function token(node: MathElement, ctx: Context): string {
  // KaTeX puts structure inside a token now and then, as \overset and \bmod do.
  if (elementsOf(node).length > 0) return sequence(elementsOf(node), ctx);
  const text = textOf(node);
  if (!text) return "";
  switch (node.name) {
    case "mi": {
      const props = variant(node) ?? ([...text].length > 1 ? { sty: "p" as const } : {});
      return run(text, ctx, props);
    }
    case "mn":
      return run(text, ctx, variant(node) ?? {});
    case "mo":
      return run(text, ctx, [...text].length > 1 && /^[A-Za-z]+$/.test(text) ? { sty: "p" } : {});
    default: {
      // Spacing commands come as text of nothing but spaces; "\ " and "~" as no-break spaces, which Word would drop.
      if (!text.trim()) return run(text.replace(/\u00a0/g, "\u2004"), ctx);
      const style = node.attrs.mathvariant ?? "";
      return run(text, ctx, {
        normal: true,
        bold: style.includes("bold"),
        italic: style.includes("italic"),
        mono: style === "monospace",
      });
    }
  }
}

// ---------------------------------------------------------------- structures

const NARY = new Set([..."∑∏∐∫∬∭⨌∮∯∰∱∲∳⋀⋁⋂⋃⨀⨁⨂⨄⨆"]);

/** The operator of a big operator node, if it is one */
function naryChar(node: MathElement | undefined): string | null {
  if (!node || node.name !== "mo" || elementsOf(node).length > 0) return null;
  const text = textOf(node);
  return NARY.has(text) ? text : null;
}

interface Nary {
  chr: string;
  under: boolean;
  sub: MathElement | null;
  sup: MathElement | null;
}

function naryOf(node: MathElement): Nary | null {
  const [base, first, second] = elementsOf(node);
  const bare = naryChar(node);
  if (bare) return { chr: bare, under: false, sub: null, sup: null };
  const chr = naryChar(base);
  if (!chr) return null;
  switch (node.name) {
    case "msub":
      return { chr, under: false, sub: first, sup: null };
    case "msup":
      return { chr, under: false, sub: null, sup: first };
    case "msubsup":
      return { chr, under: false, sub: first, sup: second };
    case "munder":
      return { chr, under: true, sub: first, sup: null };
    case "mover":
      return { chr, under: true, sub: null, sup: first };
    case "munderover":
      return { chr, under: true, sub: first, sup: second };
    default:
      return null;
  }
}

function nary(op: Nary, body: string, ctx: Context): string {
  return (
    `<m:nary><m:naryPr><m:chr m:val="${escapeXml(op.chr)}"/><m:limLoc m:val="${op.under ? "undOvr" : "subSup"}"/>` +
    (op.sub ? "" : '<m:subHide m:val="1"/>') +
    (op.sup ? "" : '<m:supHide m:val="1"/>') +
    `${ctrl(ctx)}</m:naryPr><m:sub>${op.sub ? convert(op.sub, ctx) : ""}</m:sub>` +
    `<m:sup>${op.sup ? convert(op.sup, ctx) : ""}</m:sup><m:e>${body}</m:e></m:nary>`
  );
}

/** What ends the operand of a big operator, unless it's inside brackets */
const OPERAND_END = new Set([
  ..."=≠≡≢≈≅≃∼≤≥<>≪≫≺≻⪯⪰≼≽∝⊂⊃⊆⊇⊊⊋∈∉∋→←↔⇒⇐⇔⟶⟵⟷⟹⟸⟺↦⟼+−-±∓,;:∣|&⊢⊨≜≔≐",
]);
const OPENING = new Set([..."([{⟨⌊⌈"]);
const CLOSING = new Set([...")]}⟩⌋⌉"]);

function bracket(node: MathElement | undefined): number {
  if (!node || node.name !== "mo" || elementsOf(node).length > 0) return 0;
  const text = textOf(node);
  return OPENING.has(text) ? 1 : CLOSING.has(text) ? -1 : 0;
}

/** Where the operand that starts at `from` ends */
function operandEnd(items: MathElement[], from: number): number {
  let depth = 0;
  for (let i = from; i < items.length; i++) {
    const item = items[i];
    const step = bracket(item);
    if (step < 0 && depth === 0) return i;
    depth += step;
    if (depth > 0) continue;
    if (item.name === "mo" && elementsOf(item).length === 0 && OPERAND_END.has(textOf(item))) return i;
    if (item.name === "mspace" && emOf(item.attrs.width) >= 0.9) return i;
  }
  return items.length;
}

/** The argument of a function name: a bracketed group or one item */
function argumentEnd(items: MathElement[], from: number): number {
  if (bracket(items[from]) <= 0) return from + 1;
  let depth = 0;
  for (let i = from; i < items.length; i++) {
    depth += bracket(items[i]);
    if (depth === 0) return i + 1;
  }
  return items.length;
}

/** A name such as sin or lim, possibly with limits: what KaTeX follows with a function application */
function endsWithApply(node: MathElement): boolean {
  const children = elementsOf(node);
  if (node.name === "mrow") return isApply(children[children.length - 1]);
  if (["msub", "msup", "msubsup", "munder", "mover", "munderover"].includes(node.name)) {
    return !!children[0] && endsWithApply(children[0]);
  }
  return false;
}

function func(name: string, argument: string, ctx: Context): string {
  return `<m:func><m:funcPr>${ctrl(ctx)}</m:funcPr><m:fName>${name}</m:fName><m:e>${argument}</m:e></m:func>`;
}

function sequence(items: MathElement[], ctx: Context): string {
  let out = "";
  for (let i = 0; i < items.length; i++) {
    const node = items[i];
    if (isApply(node)) continue;
    const op = naryOf(node);
    if (op) {
      const end = operandEnd(items, i + 1);
      out += nary(op, sequence(items.slice(i + 1, end), ctx), ctx);
      i = end - 1;
      continue;
    }
    const xml = convert(node, ctx);
    let next = i + 1;
    const head = endsWithApply(node) || isApply(items[next]);
    if (isApply(items[next])) next++;
    if (head && next < items.length && operandEnd(items, next) > next) {
      const end = argumentEnd(items, next);
      out += func(xml, sequence(items.slice(next, end), ctx), ctx);
      i = end - 1;
      continue;
    }
    out += xml;
    i = next - 1;
  }
  return out;
}

const DELIMITER_CHARS: Record<string, string> = { "∣": "|", "∥": "‖" };

function delimiterChar(node: MathElement | undefined): string {
  const text = node ? textOf(node) : "";
  return DELIMITER_CHARS[text] ?? text;
}

function isFence(node: MathElement | undefined): boolean {
  return !!node && node.name === "mo" && node.attrs.fence === "true";
}

/** \left … \middle … \right, whose delimiters KaTeX leaves out when they're "." */
function fenced(items: MathElement[], ctx: Context): string {
  const begin = isFence(items[0]) ? delimiterChar(items[0]) : "";
  const last = items[items.length - 1];
  const end = items.length > (begin ? 1 : 0) && isFence(last) ? delimiterChar(last) : "";
  const inner = items.slice(begin ? 1 : 0, end ? -1 : undefined);
  const parts: MathElement[][] = [[]];
  let separator = "";
  for (const item of inner) {
    if (isFence(item)) {
      separator ||= delimiterChar(item);
      parts.push([]);
    } else {
      parts[parts.length - 1].push(item);
    }
  }
  return (
    `<m:d><m:dPr><m:begChr m:val="${escapeXml(begin)}"/>` +
    (separator ? `<m:sepChr m:val="${escapeXml(separator)}"/>` : "") +
    `<m:endChr m:val="${escapeXml(end)}"/>${ctrl(ctx)}</m:dPr>` +
    parts.map((part) => `<m:e>${sequence(part, ctx)}</m:e>`).join("") +
    "</m:d>"
  );
}

function mrow(node: MathElement, ctx: Context): string {
  const items = elementsOf(node);
  return items.some(isFence) ? fenced(items, ctx) : sequence(items, ctx);
}

function scripts(node: MathElement, ctx: Context): string {
  const [base, first, second] = elementsOf(node);
  const e = `<m:e>${base ? convert(base, ctx) : ""}</m:e>`;
  switch (node.name) {
    case "msub":
      return `<m:sSub><m:sSubPr>${ctrl(ctx)}</m:sSubPr>${e}<m:sub>${part(first, ctx)}</m:sub></m:sSub>`;
    case "msup":
      return `<m:sSup><m:sSupPr>${ctrl(ctx)}</m:sSupPr>${e}<m:sup>${part(first, ctx)}</m:sup></m:sSup>`;
    default:
      return (
        `<m:sSubSup><m:sSubSupPr>${ctrl(ctx)}</m:sSubSupPr>${e}<m:sub>${part(first, ctx)}</m:sub>` +
        `<m:sup>${part(second, ctx)}</m:sup></m:sSubSup>`
      );
  }
}

function part(node: MathElement | undefined, ctx: Context): string {
  return node ? convert(node, ctx) : "";
}

/** MathML's accents as the combining characters OMML puts above its base */
const ACCENTS: Record<string, string> = {
  "^": "\u0302",
  "\u02c6": "\u0302",
  "~": "\u0303",
  "\u02dc": "\u0303",
  "\u02c9": "\u0305",
  "\u00af": "\u0305",
  "\u02d9": "\u0307",
  "\u00a8": "\u0308",
  "\u02c7": "\u030c",
  "\u02ca": "\u0301",
  "\u00b4": "\u0301",
  "\u02cb": "\u0300",
  "`": "\u0300",
  "\u02d8": "\u0306",
  "\u02da": "\u030a",
  "\u20d7": "\u20d7",
  "\u2192": "\u20d7",
  "\u2190": "\u20d6",
  "\u2194": "\u20e1",
};

const OVERLINE = "\u203e";

function limit(kind: "limLow" | "limUpp", base: string, lim: string, ctx: Context): string {
  return `<m:${kind}><m:${kind}Pr>${ctrl(ctx)}</m:${kind}Pr><m:e>${base}</m:e><m:lim>${lim}</m:lim></m:${kind}>`;
}

function groupChar(chr: string, top: boolean, base: string, ctx: Context): string {
  return (
    `<m:groupChr><m:groupChrPr><m:chr m:val="${chr}"/>` +
    (top ? '<m:pos m:val="top"/><m:vertJc m:val="bot"/>' : "") +
    `${ctrl(ctx)}</m:groupChrPr><m:e>${base}</m:e></m:groupChr>`
  );
}

function bar(top: boolean, base: string, ctx: Context): string {
  return `<m:bar><m:barPr><m:pos m:val="${top ? "top" : "bot"}"/>${ctrl(ctx)}</m:barPr><m:e>${base}</m:e></m:bar>`;
}

function underOver(node: MathElement, ctx: Context): string {
  const [base, first, second] = elementsOf(node);
  if (!base || !first) throw new NoForm(node.name);
  const baseXml = convert(base, ctx);
  const mark = first.name === "mo" && elementsOf(first).length === 0 ? textOf(first) : "";
  if (node.name === "mover") {
    if (mark === OVERLINE) return bar(true, baseXml, ctx);
    if (mark === "⏞" || mark === "⏜") return groupChar(mark, true, baseXml, ctx);
    if (node.attrs.accent === "true" && ACCENTS[mark]) {
      return `<m:acc><m:accPr><m:chr m:val="${ACCENTS[mark]}"/>${ctrl(ctx)}</m:accPr><m:e>${baseXml}</m:e></m:acc>`;
    }
    return limit("limUpp", baseXml, convert(first, ctx), ctx);
  }
  if (node.name === "munder") {
    if (mark === OVERLINE || mark === "_") return bar(false, baseXml, ctx);
    if (mark === "⏟" || mark === "⏝") return groupChar(mark, false, baseXml, ctx);
    return limit("limLow", baseXml, convert(first, ctx), ctx);
  }
  if (!second) throw new NoForm(node.name);
  return limit("limUpp", limit("limLow", baseXml, convert(first, ctx), ctx), convert(second, ctx), ctx);
}

function fraction(node: MathElement, ctx: Context): string {
  const [num, den] = elementsOf(node);
  const thickness = node.attrs.linethickness;
  const noBar = thickness !== undefined && parseFloat(thickness) === 0;
  return (
    `<m:f><m:fPr>${noBar ? '<m:type m:val="noBar"/>' : ""}${ctrl(ctx)}</m:fPr>` +
    `<m:num>${part(num, ctx)}</m:num><m:den>${part(den, ctx)}</m:den></m:f>`
  );
}

function radical(node: MathElement, ctx: Context): string {
  const children = elementsOf(node);
  if (node.name === "msqrt") {
    return (
      `<m:rad><m:radPr><m:degHide m:val="1"/>${ctrl(ctx)}</m:radPr><m:deg/>` +
      `<m:e>${sequence(children, ctx)}</m:e></m:rad>`
    );
  }
  const [base, index] = children;
  return `<m:rad><m:radPr>${ctrl(ctx)}</m:radPr><m:deg>${part(index, ctx)}</m:deg><m:e>${part(base, ctx)}</m:e></m:rad>`;
}

/** The rows of a table, each a list of its cells, leaving out the cells KaTeX adds for spacing and tags */
function tableRows(node: MathElement): MathElement[][] {
  return elementsOf(node)
    .filter((row) => row.name === "mtr" || row.name === "mlabeledtr")
    .map((row) =>
      elementsOf(row).filter(
        (cell, i) =>
          cell.name === "mtd" &&
          !/\b(mtr-glue|mml-eqn-num)\b/.test(cell.attrs.class ?? "") &&
          !(row.name === "mlabeledtr" && i === 0)
      )
    );
}

const AMPERSAND = "&";

/**
 * align, aligned, gather and their kind, which KaTeX sets without space between the columns, become an equation
 * array: in a row of one, "&" marks the points that line up with the other rows.
 */
function equationArray(rows: MathElement[][], ctx: Context): string {
  const cells = rows.map((row) => row.map((cell) => sequence(elementsOf(cell), ctx)).join(run(AMPERSAND, ctx)));
  return `<m:eqArr><m:eqArrPr>${ctrl(ctx)}</m:eqArrPr>${cells.map((row) => `<m:e>${row}</m:e>`).join("")}</m:eqArr>`;
}

function matrix(node: MathElement, rows: MathElement[][], ctx: Context): string {
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const aligns = (node.attrs.columnalign ?? "center").split(/\s+/);
  const jc = (i: number) => {
    const align = aligns[Math.min(i, aligns.length - 1)];
    return align === "left" || align === "right" ? align : "center";
  };
  const mcs = Array.from(
    { length: columns },
    (_, i) => `<m:mc><m:mcPr><m:count m:val="1"/><m:mcJc m:val="${jc(i)}"/></m:mcPr></m:mc>`
  ).join("");
  const body = rows
    .map((row) => {
      const cells = Array.from({ length: columns }, (_, i) => `<m:e>${row[i] ? sequence(elementsOf(row[i]), ctx) : ""}</m:e>`);
      return `<m:mr>${cells.join("")}</m:mr>`;
    })
    .join("");
  return `<m:m><m:mPr><m:plcHide m:val="1"/><m:mcs>${mcs}</m:mcs>${ctrl(ctx)}</m:mPr>${body}</m:m>`;
}

function table(node: MathElement, ctx: Context): string {
  const rows = tableRows(node);
  if (rows.length === 0) return "";
  const spacing = (node.attrs.columnspacing ?? "").split(/\s+/).filter(Boolean);
  const aligned = spacing.length > 0 && spacing.every((s) => emOf(s) === 0);
  return aligned ? equationArray(rows, ctx) : matrix(node, rows, ctx);
}

function enclosed(node: MathElement, ctx: Context): string {
  const notation = (node.attrs.notation ?? "box").split(/\s+/);
  const body = sequence(elementsOf(node), ctx);
  const strikes: Record<string, string> = {
    updiagonalstrike: "strikeBLTR",
    downdiagonalstrike: "strikeTLBR",
    horizontalstrike: "strikeH",
    verticalstrike: "strikeV",
  };
  const boxed = notation.some((n) => n === "box" || n === "roundedbox");
  const props = boxed
    ? ""
    : '<m:hideTop m:val="1"/><m:hideBot m:val="1"/><m:hideLeft m:val="1"/><m:hideRight m:val="1"/>';
  const order = ["strikeH", "strikeV", "strikeBLTR", "strikeTLBR"];
  const lines = order.filter((name) => notation.some((n) => strikes[n] === name)).map((name) => `<m:${name} m:val="1"/>`);
  if (!boxed && lines.length === 0) throw new NoForm(node.attrs.notation ?? "menclose");
  return `<m:borderBox><m:borderBoxPr>${props}${lines.join("")}${ctrl(ctx)}</m:borderBoxPr><m:e>${body}</m:e></m:borderBox>`;
}

function phantom(node: MathElement, ctx: Context, zero: { width?: boolean; height?: boolean } = {}): string {
  return (
    '<m:phant><m:phantPr><m:show m:val="0"/>' +
    (zero.width ? '<m:zeroWid m:val="1"/>' : "") +
    (zero.height ? '<m:zeroAsc m:val="1"/><m:zeroDesc m:val="1"/>' : "") +
    `${ctrl(ctx)}</m:phantPr><m:e>${sequence(elementsOf(node), ctx)}</m:e></m:phant>`
  );
}

function padded(node: MathElement, ctx: Context): string {
  const children = elementsOf(node);
  if (children.length === 1 && children[0].name === "mphantom") {
    const zero = (value: string | undefined) => value !== undefined && parseFloat(value) === 0;
    return phantom(children[0], ctx, {
      width: zero(node.attrs.width),
      height: zero(node.attrs.height) && zero(node.attrs.depth),
    });
  }
  return sequence(children, ctx);
}

function styled(node: MathElement, ctx: Context): string {
  const color = node.attrs.mathcolor ? cssColor(node.attrs.mathcolor) : "";
  return sequence(elementsOf(node), color ? { ...ctx, color } : ctx);
}

function convert(node: MathElement, ctx: Context): string {
  if (TOKENS.has(node.name)) return token(node, ctx);
  switch (node.name) {
    case "mrow":
    case "semantics":
      return node.name === "semantics" ? part(elementsOf(node)[0], ctx) : mrow(node, ctx);
    case "mstyle":
      return styled(node, ctx);
    case "mspace":
      return run(spaces(emOf(node.attrs.width)), ctx);
    case "msub":
    case "msup":
    case "msubsup": {
      const op = naryOf(node);
      return op ? nary(op, "", ctx) : scripts(node, ctx);
    }
    case "munder":
    case "mover":
    case "munderover": {
      const op = naryOf(node);
      return op ? nary(op, "", ctx) : underOver(node, ctx);
    }
    case "mfrac":
      return fraction(node, ctx);
    case "msqrt":
    case "mroot":
      return radical(node, ctx);
    case "mtable":
      return table(node, ctx);
    case "menclose":
      return enclosed(node, ctx);
    case "mphantom":
      return phantom(node, ctx);
    case "mpadded":
      return padded(node, ctx);
    case "annotation":
    case "annotation-xml":
      return "";
    default:
      throw new NoForm(node.name);
  }
}

/** The formula of a parsed KaTeX output, as the content of an oMath */
function mathContent(markup: string, ctx: Context): string {
  const math = find(parseMarkup(markup), "math");
  if (!math) throw new NoForm("math");
  const semantics = find(math, "semantics");
  const top = semantics ? elementsOf(semantics).filter((child) => !child.name.startsWith("annotation")) : elementsOf(math);
  return sequence(top, ctx);
}

/**
 * The OMML of a LaTeX formula: an oMath to put among the runs of a paragraph, or for `display` an oMathPara that is
 * the paragraph's content. A display formula with a `number` gets it at the right margin, as Word numbers its
 * equations. Null if the formula has no OMML form (or isn't valid).
 */
export function latexToOmml(latex: string, display: boolean, style: OmmlStyle, number?: string): string | null {
  try {
    const markup = katex.renderToString(latex, {
      displayMode: display,
      output: "mathml",
      throwOnError: true,
      strict: "ignore",
      trust: false,
    });
    const ctx: Context = { style, color: style.color };
    let content = mathContent(markup, ctx);
    if (!content) return null;
    if (!display) return `<m:oMath>${content}</m:oMath>`;
    if (number) {
      // An equation array whose row holds the formula, "#" and the number: Word's own numbered equation
      content =
        `<m:eqArr><m:eqArrPr><m:maxDist m:val="1"/>${ctrl(ctx)}</m:eqArrPr><m:e>${content}` +
        `${run("#", ctx)}${run(number, ctx, { normal: true })}</m:e></m:eqArr>`;
    }
    return `<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr><m:oMath>${content}</m:oMath></m:oMathPara>`;
  } catch {
    return null;
  }
}
