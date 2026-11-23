/**
 * Converts the script of a Hancom (HWP/HWPX) equation, e.g. `{a+b} over 2 sqrt {x^2}`, to LaTeX.
 * Covers the common syntax (fractions, roots, scripts, big operators with from/to, matrices,
 * cases, LEFT/RIGHT delimiters, decorations, Greek letters and symbols); anything unknown is
 * passed through, so the result may still need a touch-up in the equation editor.
 */

type Token =
  | { kind: "word" | "number" | "text" | "symbol"; value: string }
  | { kind: "space"; value: "~" | "`" };

const MULTI_SYMBOLS = ["<=>", "<->", "...", "<=", ">=", "!=", "==", "->", "<-", "=>", "+-", "-+", "<<", ">>"];

const SYMBOLS: Record<string, string> = {
  "<=>": "\\Leftrightarrow",
  "<->": "\\leftrightarrow",
  "...": "\\cdots",
  "<=": "\\le",
  ">=": "\\ge",
  "!=": "\\ne",
  "==": "\\equiv",
  "->": "\\rightarrow",
  "<-": "\\leftarrow",
  "=>": "\\Rightarrow",
  "+-": "\\pm",
  "-+": "\\mp",
  "<<": "\\ll",
  ">>": "\\gg",
  "%": "\\%",
  $: "\\$",
  "\\": "\\backslash",
  "×": "\\times",
  "÷": "\\div",
  "±": "\\pm",
  "·": "\\cdot",
  "≤": "\\le",
  "≥": "\\ge",
  "≠": "\\ne",
  "∞": "\\infty",
  "→": "\\rightarrow",
  "←": "\\leftarrow",
};

/** Keywords matched case-insensitively (keys in lower case). */
const WORDS: Record<string, string> = {
  times: "\\times",
  div: "\\div",
  pm: "\\pm",
  mp: "\\mp",
  cdot: "\\cdot",
  circ: "\\circ",
  bullet: "\\bullet",
  ast: "\\ast",
  star: "\\star",
  oplus: "\\oplus",
  ominus: "\\ominus",
  otimes: "\\otimes",
  odiv: "\\oslash",
  odot: "\\odot",
  le: "\\le",
  leq: "\\le",
  ge: "\\ge",
  geq: "\\ge",
  ne: "\\ne",
  neq: "\\ne",
  equiv: "\\equiv",
  approx: "\\approx",
  sim: "\\sim",
  simeq: "\\simeq",
  cong: "\\cong",
  propto: "\\propto",
  doteq: "\\doteq",
  in: "\\in",
  ni: "\\ni",
  owns: "\\ni",
  notin: "\\notin",
  subset: "\\subset",
  supset: "\\supset",
  subseteq: "\\subseteq",
  supseteq: "\\supseteq",
  cup: "\\cup",
  cap: "\\cap",
  sqcup: "\\sqcup",
  sqcap: "\\sqcap",
  vee: "\\vee",
  wedge: "\\wedge",
  lor: "\\lor",
  land: "\\land",
  neg: "\\neg",
  lnot: "\\neg",
  inf: "\\infty",
  infty: "\\infty",
  infinity: "\\infty",
  partial: "\\partial",
  nabla: "\\nabla",
  forall: "\\forall",
  exist: "\\exists",
  exists: "\\exists",
  therefore: "\\therefore",
  because: "\\because",
  emptyset: "\\emptyset",
  prime: "'",
  angle: "\\angle",
  perp: "\\perp",
  bot: "\\bot",
  top: "\\top",
  parallel: "\\parallel",
  triangle: "\\triangle",
  deg: "^{\\circ}",
  hbar: "\\hbar",
  ell: "\\ell",
  wp: "\\wp",
  re: "\\Re",
  im: "\\Im",
  aleph: "\\aleph",
  dagger: "\\dagger",
  ddagger: "\\ddagger",
  cdots: "\\cdots",
  ldots: "\\ldots",
  vdots: "\\vdots",
  ddots: "\\ddots",
  larrow: "\\leftarrow",
  rarrow: "\\rightarrow",
  lrarrow: "\\leftrightarrow",
  uparrow: "\\uparrow",
  downarrow: "\\downarrow",
  udarrow: "\\updownarrow",
  nearrow: "\\nearrow",
  searrow: "\\searrow",
  nwarrow: "\\nwarrow",
  swarrow: "\\swarrow",
  mapsto: "\\mapsto",
  lbrace: "\\{",
  rbrace: "\\}",
  langle: "\\langle",
  rangle: "\\rangle",
  lceil: "\\lceil",
  rceil: "\\rceil",
  lfloor: "\\lfloor",
  rfloor: "\\rfloor",
  vert: "|",
  sum: "\\sum",
  prod: "\\prod",
  coprod: "\\coprod",
  int: "\\int",
  oint: "\\oint",
  dint: "\\iint",
  tint: "\\iiint",
  odint: "\\oiint",
  otint: "\\oiiint",
  bigcup: "\\bigcup",
  union: "\\bigcup",
  bigcap: "\\bigcap",
  inter: "\\bigcap",
  bigsqcup: "\\bigsqcup",
  bigvee: "\\bigvee",
  bigwedge: "\\bigwedge",
  bigoplus: "\\bigoplus",
  bigotimes: "\\bigotimes",
  bigodot: "\\bigodot",
  lim: "\\lim",
  mod: "\\bmod",
  pr: "\\Pr",
};

for (const fn of [
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth",
  "log", "ln", "lg", "exp", "det", "dim", "ker", "hom", "arg", "gcd", "max", "min",
]) {
  WORDS[fn] = `\\${fn}`;
}

/** Keywords whose upper-case spelling means something else (double arrows). */
const CASE_SENSITIVE: Record<string, string> = {
  LARROW: "\\Leftarrow",
  RARROW: "\\Rightarrow",
  LRARROW: "\\Leftrightarrow",
  UPARROW: "\\Uparrow",
  DOWNARROW: "\\Downarrow",
  UDARROW: "\\Updownarrow",
};

const GREEK = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu",
  "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
  "varepsilon", "vartheta", "varpi", "varrho", "varsigma", "varphi",
]);
/** Capital Greek letters that look like Latin ones have no LaTeX command. */
const LATIN_CAPITALS: Record<string, string> = {
  alpha: "A", beta: "B", epsilon: "E", zeta: "Z", eta: "H", iota: "I", kappa: "K", mu: "M", nu: "N",
  omicron: "O", rho: "P", tau: "T", chi: "X",
};

/** Decorations: [command for a single symbol, command for a longer argument] */
const ACCENTS: Record<string, [string, string]> = {
  bar: ["\\overline", "\\overline"],
  hat: ["\\hat", "\\widehat"],
  vec: ["\\vec", "\\overrightarrow"],
  tilde: ["\\tilde", "\\widetilde"],
  dot: ["\\dot", "\\dot"],
  ddot: ["\\ddot", "\\ddot"],
  check: ["\\check", "\\check"],
  acute: ["\\acute", "\\acute"],
  grave: ["\\grave", "\\grave"],
  under: ["\\underline", "\\underline"],
  dyad: ["\\overleftrightarrow", "\\overleftrightarrow"],
  arch: ["\\overgroup", "\\overgroup"],
};

const FONTS: Record<string, string> = { rm: "\\mathrm", it: "\\mathit", bold: "\\boldsymbol" };

/** Environments: name -> [begin, end] */
const ENVIRONMENTS: Record<string, [string, string]> = {
  matrix: ["\\begin{matrix}", "\\end{matrix}"],
  pmatrix: ["\\begin{pmatrix}", "\\end{pmatrix}"],
  bmatrix: ["\\begin{bmatrix}", "\\end{bmatrix}"],
  dmatrix: ["\\begin{vmatrix}", "\\end{vmatrix}"],
  cases: ["\\begin{cases}", "\\end{cases}"],
  pile: ["\\begin{matrix}", "\\end{matrix}"],
  lpile: ["\\begin{array}{l}", "\\end{array}"],
  rpile: ["\\begin{array}{r}", "\\end{array}"],
  eqalign: ["\\begin{aligned}", "\\end{aligned}"],
};

const DELIMITERS: Record<string, string> = {
  "(": "(",
  ")": ")",
  "[": "[",
  "]": "]",
  "|": "|",
  "||": "\\|",
  ".": ".",
  "<": "\\langle",
  ">": "\\rangle",
};
const DELIMITER_WORDS = new Set(["lbrace", "rbrace", "langle", "rangle", "lceil", "rceil", "lfloor", "rfloor", "vert"]);

function isHangul(ch: string): boolean {
  return /[ᄀ-ᇿ㄰-㆏가-힯一-鿿]/.test(ch);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      const stop = end === -1 ? src.length : end;
      tokens.push({ kind: "text", value: src.slice(i + 1, stop) });
      i = stop + 1;
    } else if (/[A-Za-z]/.test(ch)) {
      const m = /^[A-Za-z]+/.exec(src.slice(i))!;
      tokens.push({ kind: "word", value: m[0] });
      i += m[0].length;
    } else if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(?:\.[0-9]+)?/.exec(src.slice(i))!;
      tokens.push({ kind: "number", value: m[0] });
      i += m[0].length;
    } else if (ch === "~" || ch === "`") {
      tokens.push({ kind: "space", value: ch });
      i++;
    } else if (isHangul(ch)) {
      let j = i;
      while (j < src.length && (isHangul(src[j]) || src[j] === " ")) j++;
      tokens.push({ kind: "text", value: src.slice(i, j).trimEnd() });
      i = j;
    } else {
      const multi = MULTI_SYMBOLS.find((s) => src.startsWith(s, i));
      const value = multi ?? ch;
      tokens.push({ kind: "symbol", value });
      i += value.length;
    }
  }
  return tokens;
}

function escapeText(text: string): string {
  return text.replace(/[\\{}$&#^_%~]/g, (c) => (c === "\\" ? "\\textbackslash{}" : `\\${c}`));
}

/** Removes one pair of braces that wraps the whole string. */
function unwrap(s: string): string {
  if (!s.startsWith("{") || !s.endsWith("}")) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0 && i < s.length - 1) return s;
  }
  return s.slice(1, -1);
}

const SEPARATORS = new Set(["&", "#"]);

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isWord(token: Token | undefined, ...names: string[]): boolean {
    return token?.kind === "word" && names.includes(token.value.toLowerCase());
  }

  private isSymbol(token: Token | undefined, ...values: string[]): boolean {
    return token?.kind === "symbol" && values.includes(token.value);
  }

  document(): string {
    const rows = this.rows();
    while (this.pos < this.tokens.length) {
      // Unbalanced "}" at the top level: skip it and keep going.
      this.pos++;
      const more = this.rows();
      rows[rows.length - 1].push(...more[0]);
      rows.push(...more.slice(1));
    }
    if (rows.length === 1 && rows[0].length === 1) return rows[0][0];
    return `\\begin{aligned}${rows.map((r) => r.join(" & ")).join(" \\\\ ")}\\end{aligned}`;
  }

  /** Rows separated by "#", cells by "&", up to a closing "}" or the end. */
  private rows(): string[][] {
    const rows: string[][] = [[]];
    for (;;) {
      rows[rows.length - 1].push(this.expression());
      const token = this.peek();
      if (this.isSymbol(token, "&")) {
        this.pos++;
      } else if (this.isSymbol(token, "#")) {
        this.pos++;
        rows.push([]);
      } else {
        return rows;
      }
    }
  }

  private expression(): string {
    const items: string[] = [];
    for (;;) {
      const token = this.peek();
      if (!token || (token.kind === "symbol" && (token.value === "}" || SEPARATORS.has(token.value)))) break;
      if (this.isWord(token, "over", "atop")) {
        this.pos++;
        const left = unwrap(items.pop() ?? "{}");
        const right = unwrap(this.scripted());
        items.push(token.value.toLowerCase() === "over" ? `\\frac{${left}}{${right}}` : `{${left} \\atop ${right}}`);
        continue;
      }
      items.push(this.scripted());
    }
    return items.filter(Boolean).join(" ");
  }

  /** An atom followed by any sub/superscripts. */
  private scripted(): string {
    let base = this.atom();
    let hasSup = false;
    let hasSub = false;
    for (;;) {
      const token = this.peek();
      const sup = this.isSymbol(token, "^") || this.isWord(token, "sup", "to");
      const sub = this.isSymbol(token, "_") || this.isWord(token, "sub", "from");
      if (!sup && !sub) return base;
      this.pos++;
      const script = unwrap(this.atom());
      if ((sup && hasSup) || (sub && hasSub)) {
        base = `{${base}}`;
        hasSup = hasSub = false;
      }
      base = `${base || "{}"}${sup ? "^" : "_"}{${script}}`;
      if (sup) hasSup = true;
      else hasSub = true;
    }
  }

  private atom(): string {
    const token = this.peek();
    if (!token) return "";
    if (this.isSymbol(token, "^", "_", "}", "&", "#")) return "";
    this.pos++;
    switch (token.kind) {
      case "number":
        return token.value;
      case "text":
        return token.value ? `\\text{${escapeText(token.value)}}` : "";
      case "space":
        return token.value === "~" ? "\\ " : "\\,";
      case "symbol":
        if (token.value === "{") {
          const inner = this.rows();
          if (this.isSymbol(this.peek(), "}")) this.pos++;
          return `{${inner.map((r) => r.join(" ")).join(" ")}}`;
        }
        return SYMBOLS[token.value] ?? token.value;
      case "word":
        return this.word(token.value);
    }
  }

  private word(value: string): string {
    const lower = value.toLowerCase();
    if (CASE_SENSITIVE[value]) return CASE_SENSITIVE[value];
    if (GREEK.has(lower)) {
      if (value === lower) return lower === "omicron" ? "o" : `\\${lower}`;
      const name = lower.replace(/^var/, "");
      return LATIN_CAPITALS[name] ? `\\mathrm{${LATIN_CAPITALS[name]}}` : `\\${name[0].toUpperCase()}${name.slice(1)}`;
    }
    if (lower === "sqrt") return `\\sqrt{${unwrap(this.atom())}}`;
    if (lower === "root") {
      const index = unwrap(this.atom());
      if (this.isWord(this.peek(), "of")) this.pos++;
      return `\\sqrt[${index}]{${unwrap(this.atom())}}`;
    }
    if (ACCENTS[lower]) {
      const arg = unwrap(this.atom());
      const [single, wide] = ACCENTS[lower];
      const short = arg.length === 1 || /^\\[A-Za-z]+$/.test(arg);
      return `${short ? single : wide}{${arg}}`;
    }
    if (FONTS[lower]) return `${FONTS[lower]}{${unwrap(this.atom())}}`;
    if (lower === "left" || lower === "right") return `\\${lower}${this.delimiter()}`;
    if (ENVIRONMENTS[lower]) {
      const [begin, end] = ENVIRONMENTS[lower];
      if (!this.isSymbol(this.peek(), "{")) return begin + end;
      this.pos++;
      const rows = this.rows();
      if (this.isSymbol(this.peek(), "}")) this.pos++;
      return `${begin}${rows.map((r) => r.join(" & ")).join(" \\\\ ")}${end}`;
    }
    if (lower === "not") {
      const next = this.atom();
      return next.startsWith("\\") ? `\\not${next}` : `\\not ${next}`;
    }
    return WORDS[lower] ?? value;
  }

  private delimiter(): string {
    const token = this.peek();
    if (!token) return ".";
    if (token.kind === "symbol" && (DELIMITERS[token.value] || token.value === "{" || token.value === "}")) {
      this.pos++;
      if (token.value === "{" || token.value === "}") return `\\${token.value}`;
      return DELIMITERS[token.value];
    }
    if (token.kind === "word" && DELIMITER_WORDS.has(token.value.toLowerCase())) {
      this.pos++;
      return WORDS[token.value.toLowerCase()];
    }
    return ".";
  }
}

export function hwpEquationToLatex(script: string): string {
  return new Parser(tokenize(script.trim())).document().replace(/\s+/g, " ").trim();
}
