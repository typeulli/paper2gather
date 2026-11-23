/**
 * Converts LaTeX to the script of a Hancom equation, e.g. `{a+b} over 2`: the opposite of
 * `hwpEquationToLatex`. It walks KaTeX's parse tree, so it accepts what the editor shows. Anything without a
 * Hancom notation makes the result null rather than an equation that looks different.
 */
import katex from "katex";

interface TexNode {
  type: string;
  [field: string]: unknown;
}

interface Context {
  /** Display style: big operators take their limits above and below. */
  display: boolean;
  /** Inside `rm`, whose closing `it` would end the outer one as well. */
  upright?: boolean;
}

class NoNotation extends Error {}

const SAME_NAME = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu", "xi",
  "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega", "varepsilon", "vartheta", "varpi", "varrho",
  "varsigma", "varphi",
  "times", "div", "cdot", "circ", "bullet", "ast", "star", "oplus", "ominus", "otimes", "odot", "cup", "cap", "sqcup",
  "sqcap", "vee", "wedge", "approx", "sim", "simeq", "cong", "propto", "doteq", "in", "ni", "notin", "subset", "supset",
  "subseteq", "supseteq", "partial", "nabla", "exists", "therefore", "because", "emptyset", "prime", "angle",
  "bot", "top", "triangle", "hbar", "ell", "wp", "aleph", "dagger", "ddagger", "cdots", "ldots", "vdots", "ddots",
  "uparrow", "downarrow", "nearrow", "searrow", "nwarrow", "swarrow", "mapsto", "lbrace", "rbrace",
  "lceil", "rceil", "lfloor", "rfloor", "infty",
];

const SYMBOLS: Record<string, string> = {
  ...Object.fromEntries(SAME_NAME.map((name) => [`\\${name}`, name])),
  ...Object.fromEntries(
    ["Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega"].map((name) => [
      `\\${name}`,
      name.toUpperCase(),
    ])
  ),
  "\\pm": "+-",
  "\\mp": "-+",
  "\\cdotp": "cdot",
  "\\centerdot": "cdot",
  "\\oslash": "odiv",
  "\\lor": "vee",
  "\\land": "wedge",
  "\\le": "<=",
  "\\leq": "<=",
  "≤": "<=",
  "\\ge": ">=",
  "\\geq": ">=",
  "≥": ">=",
  "\\ne": "!=",
  "\\neq": "!=",
  "≠": "!=",
  "∉": "notin",
  "\\equiv": "==",
  "\\ll": "<<",
  "\\gg": ">>",
  "\\owns": "ni",
  "\\varnothing": "emptyset",
  "\\forall": "FORALL",
  "\\perp": "bot",
  "\\langle": "⟨",
  "\\rangle": "⟩",
  "\\Re": "ℜ",
  "\\Im": "ℑ",
  "\\neg": "¬",
  "\\lnot": "¬",
  "\\setminus": "∖",
  "\\smallsetminus": "∖",
  "\\backslash": "backslash",
  "\\lesssim": "≲",
  "\\gtrsim": "≳",
  "\\prec": "≺",
  "\\succ": "≻",
  "\\preccurlyeq": "≼",
  "\\succcurlyeq": "≽",
  "\\vdash": "⊢",
  "\\dashv": "⊣",
  "\\models": "⊨",
  "\\triangleq": "≜",
  "\\subsetneq": "⊊",
  "\\supsetneq": "⊋",
  "\\nsubseteq": "⊈",
  "\\nsupseteq": "⊉",
  "\\ncong": "≇",
  "\\nsim": "≁",
  "\\nleq": "≰",
  "\\ngeq": "≱",
  "\\nmid": "∤",
  "\\nparallel": "∦",
  "\\nexists": "∄",
  "\\asymp": "≍",
  "\\bowtie": "⋈",
  "\\Join": "⋈",
  "\\ltimes": "⋉",
  "\\rtimes": "⋊",
  "\\uplus": "⊎",
  "\\wr": "≀",
  "\\hookrightarrow": "↪",
  "\\hookleftarrow": "↩",
  "\\rightleftharpoons": "⇌",
  "\\rightsquigarrow": "⇝",
  "\\leadsto": "⇝",
  "\\twoheadrightarrow": "↠",
  "\\rightarrowtail": "↣",
  "\\square": "□",
  "\\Box": "□",
  "\\blacksquare": "■",
  "\\checkmark": "✓",
  "\\sharp": "♯",
  "\\flat": "♭",
  "\\natural": "♮",
  "\\complement": "∁",
  "\\measuredangle": "∡",
  "\\beth": "ℶ",
  "\\eth": "ð",
  "\\degree": "°",
  "\\@cdots": "cdots",
  "\\dotsb": "cdots",
  "\\dotsm": "cdots",
  "\\dotsi": "cdots",
  "\\dotso": "ldots",
  "\\dotsc": "ldots",
  "\\varvdots": "vdots",
  "\\to": "->",
  "\\rightarrow": "->",
  "\\longrightarrow": "->",
  "\\gets": "<-",
  "\\leftarrow": "<-",
  "\\longleftarrow": "<-",
  "\\leftrightarrow": "<->",
  "\\longleftrightarrow": "<->",
  "\\Rightarrow": "RARROW",
  "\\Longrightarrow": "RARROW",
  "\\Leftarrow": "LARROW",
  "\\Longleftarrow": "LARROW",
  "\\Leftrightarrow": "LRARROW",
  "\\Longleftrightarrow": "LRARROW",
  "\\updownarrow": "udarrow",
  "\\Uparrow": "UPARROW",
  "\\Downarrow": "DOWNARROW",
  "\\Updownarrow": "UDARROW",
  "\\longmapsto": "mapsto",
  "\\mid": "|",
  "\\vert": "|",
  "\\lvert": "|",
  "\\rvert": "|",
  "\\|": "||",
  "\\Vert": "||",
  "\\lVert": "||",
  "\\rVert": "||",
  "\\parallel": "||",
  "\\{": "lbrace",
  "\\}": "rbrace",
  "\\lbrack": "[",
  "\\rbrack": "]",
  "\\%": "%",
  "\\$": "$",
  "\\#": '"#"',
  "\\&": '"&"',
  "\\_": '"_"',
  "\\colon": ":",
  "\\ldotp": ".",
  "̸": "not",
};

const PUNCTUATION = /^[+\-=<>()[\],.;:!?/*|']$/;
/** Hangul and other CJK characters are text: a bare one would be read as a keyword or be spaced like a variable. */
const CJK = /^[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯豈-﫿]+$/;

const quoted = (text: string) => `"${text}"`;

/** Words in quotes. A space inside quotes is narrower than a word space and lost at the ends, so spaces stay out. */
function words(text: string): string {
  return text
    .split(" ")
    .map((word) => (word ? quoted(word) : ""))
    .join(" ~ ");
}

/** Upright content: quoted text and letters are italic without `rm`, which reaches past its braces until `it`. */
function upright(content: string, ctx: Context, bold = false): string {
  const weight = bold ? "bold " : "";
  return ctx.upright ? `${weight}{${content}}` : `rm ${weight}{${content}} it`;
}

function symbol(text: string, ctx: Context): string {
  if (/^[A-Za-z0-9]$/.test(text) || PUNCTUATION.test(text)) return text;
  const known = SYMBOLS[text];
  if (known) return known;
  if (CJK.test(text)) return upright(quoted(text), ctx);
  throw new NoNotation(text);
}

/** Big operators with the name of their Hancom keyword */
const OPERATORS: Record<string, string> = {
  "\\sum": "sum",
  "\\prod": "prod",
  "\\coprod": "coprod",
  "\\int": "int",
  "\\oint": "oint",
  "\\iint": "dint",
  "\\iiint": "tint",
  "\\oiint": "odint",
  "\\oiiint": "otint",
  "\\bigcup": "bigcup",
  "\\bigcap": "bigcap",
  "\\bigsqcup": "bigsqcup",
  "\\bigvee": "bigvee",
  "\\bigwedge": "bigwedge",
  "\\bigoplus": "bigoplus",
  "\\bigotimes": "bigotimes",
  "\\bigodot": "bigodot",
};

/**
 * Function names Hancom sets upright by itself. Others are quoted: `sup` and `over` are keywords there, for one. Only
 * the operators above and `lim` can take `from` and `to`: after anything else those drop the rest of the equation.
 */
const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth", "log", "ln",
  "lg", "exp", "det", "dim", "ker", "hom", "arg", "gcd", "max", "min", "lim", "Pr",
]);

const ACCENTS: Record<string, string> = {
  "\\hat": "hat",
  "\\widehat": "hat",
  "\\bar": "bar",
  "\\vec": "vec",
  "\\overrightarrow": "vec",
  "\\tilde": "tilde",
  "\\widetilde": "tilde",
  "\\dot": "dot",
  "\\ddot": "ddot",
  "\\check": "check",
  "\\acute": "acute",
  "\\grave": "grave",
  "\\overleftrightarrow": "dyad",
};

/** The letters of these alphabets that have a character of their own. The others look wrong in Hancom's fonts. */
const SCRIPT_LETTERS = { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ" };
const ALPHABETS: Record<string, Record<string, string>> = {
  mathbb: { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" },
  mathcal: SCRIPT_LETTERS,
  mathscr: SCRIPT_LETTERS,
};

const DELIMITERS: Record<string, string> = {
  "(": "(",
  ")": ")",
  "[": "[",
  "]": "]",
  "\\lbrack": "[",
  "\\rbrack": "]",
  "|": "|",
  "\\vert": "|",
  "\\lvert": "|",
  "\\rvert": "|",
  "\\|": "||",
  "\\Vert": "||",
  "\\lVert": "||",
  "\\rVert": "||",
  "\\{": "{",
  "\\}": "}",
  "\\lbrace": "{",
  "\\rbrace": "}",
  "\\langle": "<",
  "\\rangle": ">",
  "<": "<",
  ">": ">",
  "\\lceil": "lceil",
  "\\rceil": "rceil",
  "\\lfloor": "lfloor",
  "\\rfloor": "rfloor",
  ".": ".",
};

function delimiter(text: unknown): string {
  const known = DELIMITERS[text as string];
  if (!known) throw new NoNotation(String(text));
  return known;
}

/** Matrix environments by their delimiters */
const DELIMITED_ARRAYS: Record<string, string> = {
  "(|)": "pmatrix",
  "[|]": "bmatrix",
  "|||": "dmatrix",
  "\\{|.": "cases",
};

function nodes(value: unknown): TexNode[] {
  if (Array.isArray(value)) return value as TexNode[];
  return value ? [value as TexNode] : [];
}

/** The characters of nodes that hold only letters, digits and thin spaces, else null. */
function plainText(items: TexNode[]): string | null {
  let out = "";
  for (const node of items) {
    if (node.type === "ordgroup") {
      const inner = plainText(nodes(node.body));
      if (inner === null) return null;
      out += inner;
    } else if (node.type === "kern") {
      out += " ";
    } else if ((node.type === "mathord" || node.type === "textord") && /^[A-Za-z0-9-]$/.test(node.text as string)) {
      out += node.text as string;
    } else {
      return null;
    }
  }
  return out;
}

function list(items: TexNode[], ctx: Context): string {
  const out: string[] = [];
  for (const node of items) {
    const token = convert(node, ctx);
    if (!token) continue;
    const last = out[out.length - 1];
    // Numbers stay in one piece; a negated "=" or "in" has its own keyword.
    if (last && /^[0-9][0-9.]*$/.test(last) && /^[0-9.]+$/.test(token)) out[out.length - 1] = last + token;
    else if (last === "not" && (token === "=" || token === "in")) out[out.length - 1] = token === "=" ? "!=" : "notin";
    else if (last === "not") throw new NoNotation(token);
    else out.push(token);
  }
  if (out[out.length - 1] === "not") throw new NoNotation("not");
  return out.join(" ");
}

function group(value: unknown, ctx: Context): string {
  return `{${list(nodes(value), ctx)}}`;
}

/** A base or argument that a following keyword binds to: single tokens need no braces. */
function atom(node: TexNode | undefined, ctx: Context): string {
  if (!node) return "{}";
  const single = ["mathord", "textord", "atom", "op", "operatorname", "text", "delimsizing"].includes(node.type);
  return single ? convert(node, ctx) : `{${convert(node, ctx)}}`;
}

/** What \mathop{…} or \underset{…}{…} hold around a name such as argmax */
const OPERATOR_NAMES = ["op", "operatorname", "font", "text"];

function scripts(node: TexNode, ctx: Context): string {
  const base = node.base as TexNode | undefined;
  const limits =
    base?.type === "op"
      ? base.limits && (ctx.display || base.alwaysHandleSupSub)
      : base?.type === "operatorname" && base.alwaysHandleSupSub && (ctx.display || base.limits);
  const inner = { ...ctx, display: false };
  const parts = [atom(base, ctx)];
  if (limits) {
    // \overset and its kind stack arbitrary content, which Hancom can't do at script size. Names are fine at the side.
    if (base?.type === "op" && base.body && !nodes(base.body).every((item) => OPERATOR_NAMES.includes(item.type))) {
      throw new NoNotation("stacked");
    }
    if (base?.type === "op" && (OPERATORS[base.name as string] || base.name === "\\lim")) {
      if (node.sub) parts.push(`from ${group(node.sub, inner)}`);
      if (node.sup) parts.push(`to ${group(node.sup, inner)}`);
      return parts.join(" ");
    }
    // \max, \sup or an \operatorname* keep their limits at the side.
  }
  // Hancom stacks the scripts of its operators unless they're in a group.
  if (base?.type === "op") parts[0] = `{${parts[0]}}`;
  if (node.sub) parts.push(`_${group(node.sub, inner)}`);
  if (node.sup) parts.push(`^${group(node.sup, inner)}`);
  return parts.join(" ");
}

function fraction(node: TexNode, ctx: Context): string {
  const inner = { ...ctx, display: false };
  const parts = `${group(node.numer, inner)} ${node.hasBarLine ? "over" : "atop"} ${group(node.denom, inner)}`;
  if (!node.leftDelim && !node.rightDelim) return parts;
  return `LEFT ${delimiter(node.leftDelim ?? ".")} ${parts} RIGHT ${delimiter(node.rightDelim ?? ".")}`;
}

function arrayRows(node: TexNode, ctx: Context): string {
  const lines = node.hLinesBeforeRow as boolean[][] | undefined;
  const cols = (node.cols ?? []) as { type: string }[];
  if (node.isCD || lines?.some((row) => row.length > 0) || cols.some((col) => col.type === "separator")) {
    throw new NoNotation(node.type);
  }
  return (node.body as TexNode[][]).map((row) => row.map((cell) => convert(cell, ctx)).join(" & ")).join(" # ");
}

function array(node: TexNode, ctx: Context): string {
  const body = node.body as TexNode[][];
  if (body.length === 1 && body[0].length === 1) return convert(body[0][0], ctx);
  const rows = arrayRows(node, ctx);
  if (node.colSeparationType === "align" || node.colSeparationType === "alignat") {
    // One alignment point per line is all that eqalign has.
    if (body.some((row) => row.length > 2)) throw new NoNotation("align columns");
    return `eqalign{${rows}}`;
  }
  const cols = (node.cols ?? []) as { align?: string }[];
  if (body.every((row) => row.length === 1)) {
    return `${cols[0]?.align === "l" ? "lpile" : cols[0]?.align === "r" ? "rpile" : "pile"}{${rows}}`;
  }
  return `matrix{${rows}}`;
}

function leftRight(node: TexNode, ctx: Context): string {
  const body = nodes(node.body);
  if (body.length === 1 && body[0].type === "array") {
    const env = DELIMITED_ARRAYS[`${node.left}|${node.right}`];
    if (env) return `${env}{${arrayRows(body[0], ctx)}}`;
  }
  return `LEFT ${delimiter(node.left)} ${list(body, ctx)} RIGHT ${delimiter(node.right)}`;
}

function operator(node: TexNode, ctx: Context): string {
  if (node.body) return group(node.body, ctx);
  const name = node.name as string;
  if (OPERATORS[name]) return OPERATORS[name];
  if (node.symbol) throw new NoNotation(name);
  const word = name.replace(/^\\/, "");
  if (FUNCTIONS.has(word)) return word;
  return upright(words(word === "limsup" ? "lim sup" : word === "liminf" ? "lim inf" : word), ctx);
}

const TEXT_ESCAPES: Record<string, string> = {
  "\\%": "%",
  "\\$": "$",
  "\\#": "#",
  "\\&": "&",
  "\\_": "_",
  "\\{": "{",
  "\\}": "}",
};

function textContent(items: TexNode[]): string {
  let out = "";
  for (const node of items) {
    if (node.type === "text" || node.type === "ordgroup") {
      out += textContent(nodes(node.body));
    } else if (node.type === "spacing") {
      out += " ";
    } else if (node.type === "textord" || node.type === "mathord" || node.type === "atom") {
      const text = node.text as string;
      const char = TEXT_ESCAPES[text] ?? text;
      // Hancom reads the spacing characters as spacing even between quotes.
      if (char.startsWith("\\") || char === '"' || char === "~" || char === "`") throw new NoNotation(char);
      out += char;
    } else {
      throw new NoNotation(node.type);
    }
  }
  return out;
}

function text(node: TexNode, ctx: Context): string {
  const content = words(textContent(nodes(node.body)));
  if (!content || node.font === "\\textit") return content;
  return upright(content, ctx, node.font === "\\textbf");
}

function font(node: TexNode, ctx: Context): string {
  const body = nodes(node.body);
  switch (node.font) {
    case "mathrm":
    case "mathbf": {
      const plain = plainText(body);
      const content = plain === null ? list(body, { ...ctx, upright: true }) : words(plain);
      return upright(content, ctx, node.font === "mathbf");
    }
    case "mathit":
    case "mathnormal":
      return list(body, ctx);
    case "boldsymbol":
      return `bold ${group(body, ctx)}`;
    default: {
      const letter = ALPHABETS[node.font as string]?.[plainText(body) ?? ""];
      if (!letter) throw new NoNotation(String(node.font));
      return letter;
    }
  }
}

function kern(node: TexNode): string {
  const { number, unit } = node.dimension as { number: number; unit: string };
  const em = unit === "mu" ? number / 18 : unit === "em" ? number : unit === "ex" ? number * 0.43 : null;
  if (em === null) throw new NoNotation(unit);
  if (em <= 0) return "";
  // "`" is a quarter of "~", which is about a third of an em wide.
  return em < 0.25 ? "`" : "~".repeat(Math.max(1, Math.round(em * 3)));
}

function spacing(node: TexNode): string {
  return node.text === "\\nobreak" || node.text === "\\allowbreak" ? "" : "~";
}

function convert(node: TexNode, ctx: Context): string {
  switch (node.type) {
    case "mathord":
    case "textord":
    case "atom":
      return symbol(node.text as string, ctx);
    case "ordgroup":
    case "sizing":
      return list(nodes(node.body), ctx);
    case "mclass": {
      const inner = list(nodes(node.body), ctx);
      // Hancom spaces its own operators, not a word such as the "mod" of \bmod.
      return node.mclass === "mbin" && inner.startsWith("rm ") ? `~ ${inner} ~` : inner;
    }
    case "styling":
      return list(nodes(node.body), { ...ctx, display: node.style === "display" });
    case "supsub":
      return scripts(node, ctx);
    case "genfrac":
      return fraction(node, ctx);
    case "sqrt":
      return node.index
        ? `root ${group(node.index, { ...ctx, display: false })} of ${group(node.body, ctx)}`
        : `sqrt ${group(node.body, ctx)}`;
    case "op":
      return operator(node, ctx);
    case "operatorname": {
      const name = plainText(nodes(node.body));
      if (name === null) throw new NoNotation(node.type);
      return upright(words(name), ctx);
    }
    case "text":
      return text(node, ctx);
    case "font":
      return font(node, ctx);
    case "accent": {
      const accent = ACCENTS[node.label as string];
      if (!accent) throw new NoNotation(String(node.label));
      return `${accent} ${group(node.base, ctx)}`;
    }
    case "overline":
      return `bar ${group(node.body, ctx)}`;
    case "underline":
      return `under ${group(node.body, ctx)}`;
    case "leftright":
      return leftRight(node, ctx);
    case "middle":
    case "delimsizing":
      return node.delim === "." ? "" : symbol(node.delim as string, ctx);
    case "array":
      return array(node, ctx);
    case "kern":
      return kern(node);
    case "spacing":
      return spacing(node);
    case "mathchoice":
      return list(nodes(ctx.display ? node.display : node.text), ctx);
    case "htmlmathml":
      return list(nodes(node.mathml), ctx);
    case "internal":
      return "";
    case "rule":
      // dots brings a strut
      if ((node.width as { number: number }).number === 0) return "";
      throw new NoNotation(node.type);
    default:
      throw new NoNotation(node.type);
  }
}

/** The Hancom script of a LaTeX formula, or null if it has no equivalent there (or isn't valid). */
export function latexToHwpEquation(latex: string, display: boolean): string | null {
  try {
    const parse = (katex as unknown as { __parse(input: string, options: object): TexNode[] }).__parse;
    const tree = parse(latex, { displayMode: display, strict: "ignore", trust: false, throwOnError: true });
    return list(tree, { display }).replace(/\s+/g, " ").trim() || null;
  } catch {
    return null;
  }
}
