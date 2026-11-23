import { diffArrays } from "diff";

/**
 * Two versions of a formula as one: the LaTeX of the version after, with the parts only in the version
 * before or only in the version after wrapped in \htmlClass{DIFF_DEL}{…} / \htmlClass{DIFF_INS}{…}
 * (rendered with KaTeX's `trust` allowing these two classes).
 *
 * The LaTeX is split into units that can be wrapped on their own: a character, a command with its
 * brace arguments, a group, a sub/superscript with its argument, \left…\right and environments. Units
 * are compared level by level; a changed unit is compared inside when both versions have the same
 * structure (same command, same delimiters …). Some results don't parse, e.g. when a change crosses
 * \left…\right; the caller then shows both versions whole.
 */

export const DIFF_DEL = "diff-del";
export const DIFF_INS = "diff-ins";

type Unit =
  | { kind: "space"; src: string }
  | { kind: "atom"; src: string }
  /** {…}, or […] (an optional argument) */
  | { kind: "group"; open: string; close: string; body: Unit[] }
  | { kind: "command"; name: string; args: Unit[] }
  | { kind: "script"; op: string; arg: Unit }
  /** \left( … \right) and \begin{…} … \end{…} */
  | { kind: "wrap"; head: string; body: Unit[]; tail: string };

/** Alignment separators: they can't be wrapped, so they stay outside the wrappers. */
const SEPARATORS = new Set(["&", "\\\\", "\\cr", "\\hline", "\\hdashline"]);

/** Commands whose arguments aren't math (colors, links, sizes …): compared whole, never inside. */
const RAW_COMMANDS = new Set([
  "\\color",
  "\\textcolor",
  "\\colorbox",
  "\\fcolorbox",
  "\\href",
  "\\url",
  "\\htmlClass",
  "\\htmlId",
  "\\htmlStyle",
  "\\htmlData",
  "\\label",
  "\\tag",
  "\\ref",
  "\\eqref",
  "\\includegraphics",
  "\\rule",
  "\\kern",
  "\\mkern",
  "\\hspace",
  "\\hskip",
  "\\mskip",
  "\\raisebox",
]);

/** Environments with an argument after \begin{…} (the column specification) */
const ENVS_WITH_ARG = new Set(["array", "subarray", "alignat", "alignat*", "alignedat", "darray"]);

const isLetter = (c: string | undefined) => c !== undefined && /[a-zA-Z@]/.test(c);
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** The units of `latex`; null when the braces or environments don't match. */
function parse(latex: string): Unit[] | null {
  const s = latex;
  let i = 0;

  class Unbalanced extends Error {}

  const controlSequence = (): string => {
    let j = i + 1;
    if (isLetter(s[j])) {
      while (isLetter(s[j])) j++;
      if (s[j] === "*") j++;
    } else if (j < s.length) {
      j++;
    }
    const cs = s.slice(i, j);
    i = j;
    return cs;
  };

  const spaces = (): string => {
    const start = i;
    while (isSpace(s[i])) i++;
    return s.slice(start, i);
  };

  /** Whether `cs` (a control word) starts at i */
  const at = (cs: string) => s.startsWith(cs, i) && !isLetter(s[i + cs.length]);

  /** The raw text of the brace group at i, braces included */
  const rawGroup = (): string => {
    const start = i;
    let depth = 0;
    do {
      if (s[i] === "\\") i++;
      else if (s[i] === "{") depth++;
      else if (s[i] === "}") depth--;
      i++;
    } while (depth > 0 && i < s.length);
    if (depth !== 0) throw new Unbalanced();
    return s.slice(start, i);
  };

  const sequence = (stop: () => boolean): Unit[] => {
    const out: Unit[] = [];
    while (i < s.length && !stop()) {
      if (isSpace(s[i])) {
        out.push({ kind: "space", src: spaces() });
      } else if (s[i] === "%") {
        const end = s.indexOf("\n", i);
        const next = end < 0 ? s.length : end + 1;
        out.push({ kind: "space", src: s.slice(i, next) });
        i = next;
      } else if (s[i] === "}") {
        throw new Unbalanced();
      } else {
        out.push(unit());
      }
    }
    return out;
  };

  const group = (open: string, close: string): Unit => {
    i++;
    const body = sequence(() => s[i] === close);
    if (s[i] !== close) throw new Unbalanced();
    i++;
    return { kind: "group", open, close, body };
  };

  /** A delimiter after \left, \right: a character or a control sequence */
  const delimiter = (): string => spaces() + (s[i] === "\\" ? controlSequence() : (s[i++] ?? ""));

  const unit = (): Unit => {
    const c = s[i];
    if (c === "{") return group("{", "}");
    if (c === "^" || c === "_") {
      i++;
      spaces();
      if (i >= s.length || s[i] === "}") throw new Unbalanced();
      return { kind: "script", op: c, arg: unit() };
    }
    if (c !== "\\") {
      i++;
      return { kind: "atom", src: c };
    }
    if (at("\\left")) {
      i += 5;
      const head = "\\left" + delimiter();
      const body = sequence(() => at("\\right"));
      if (!at("\\right")) throw new Unbalanced();
      i += 6;
      return { kind: "wrap", head, body, tail: "\\right" + delimiter() };
    }
    if (at("\\begin")) {
      i += 6;
      spaces();
      if (s[i] !== "{") throw new Unbalanced();
      const name = rawGroup();
      let head = "\\begin" + name;
      const env = name.slice(1, -1);
      const before = i;
      spaces();
      if (ENVS_WITH_ARG.has(env) && s[i] === "{") head += rawGroup();
      else i = before;
      const body = sequence(() => at("\\end"));
      if (!at("\\end")) throw new Unbalanced();
      i += 4;
      spaces();
      if (s[i] !== "{") throw new Unbalanced();
      return { kind: "wrap", head, body, tail: "\\end" + rawGroup() };
    }
    const name = controlSequence();
    if (!isLetter(name[1])) return { kind: "atom", src: name };
    // Its brace arguments (and an optional argument right after the name)
    const args: Unit[] = [];
    for (;;) {
      const before = i;
      spaces();
      if (s[i] === "{") args.push(group("{", "}"));
      else if (s[i] === "[" && args.length === 0) args.push(group("[", "]"));
      else {
        i = before;
        break;
      }
    }
    return args.length === 0 ? { kind: "atom", src: name } : { kind: "command", name, args };
  };

  try {
    const units = sequence(() => false);
    return i === s.length ? units : null;
  } catch (err) {
    if (err instanceof Unbalanced) return null;
    throw err;
  }
}

function src(u: Unit): string {
  switch (u.kind) {
    case "space":
    case "atom":
      return u.src;
    case "group":
      return u.open + u.body.map(src).join("") + u.close;
    case "command":
      return u.name + u.args.map(src).join("");
    case "script":
      return u.op + src(u.arg);
    case "wrap":
      return u.head + u.body.map(src).join("") + u.tail;
  }
}

const solid = (units: Unit[]) => units.filter((u) => u.kind !== "space");

const keys = new WeakMap<Unit, string>();

/** What units are compared by: their LaTeX without spaces (spaces don't matter in math) */
function key(u: Unit): string {
  let k = keys.get(u);
  if (k !== undefined) return k;
  const seq = (units: Unit[]) => solid(units).map(key).join("\u0000");
  switch (u.kind) {
    case "space":
      k = " ";
      break;
    case "atom":
      k = u.src;
      break;
    case "group":
      k = u.open + seq(u.body) + u.close;
      break;
    case "command":
      k = u.name + u.args.map(key).join("");
      break;
    case "script":
      k = u.op + key(u.arg);
      break;
    case "wrap":
      k = u.head.replace(/\s+/g, "") + seq(u.body) + u.tail.replace(/\s+/g, "");
      break;
  }
  keys.set(u, k);
  return k;
}

/** Units wrapped in \htmlClass; separators are kept outside (or left out of what was removed). */
function wrapped(units: Unit[], cls: string): string {
  let out = "";
  let chunk: Unit[] = [];
  const flush = () => {
    if (solid(chunk).length > 0) out += `\\htmlClass{${cls}}{${chunk.map(src).join("")}}`;
    chunk = [];
  };
  for (const u of units) {
    if (u.kind === "atom" && SEPARATORS.has(u.src)) {
      flush();
      // A removed separator would change the layout of what is still there.
      if (cls === DIFF_INS) out += u.src;
    } else {
      chunk.push(u);
    }
  }
  flush();
  return out;
}

/** Whether two different units have the same structure, so that they're compared inside */
function comparable(a: Unit, b: Unit): boolean {
  if (a.kind === "group" && b.kind === "group") return a.open === b.open;
  if (a.kind === "command" && b.kind === "command") {
    return (
      a.name === b.name &&
      !RAW_COMMANDS.has(a.name) &&
      a.args.length === b.args.length &&
      a.args.every((arg, i) => arg.kind === "group" && b.args[i].kind === "group" && arg.open === (b.args[i] as { open: string }).open)
    );
  }
  if (a.kind === "script" && b.kind === "script") return a.op === b.op;
  if (a.kind === "wrap" && b.kind === "wrap") return key({ ...a, body: [] }) === key({ ...b, body: [] });
  return false;
}

/** The contents of a script argument: a group's units, or the unit itself */
const scriptBody = (u: Unit): Unit[] => (u.kind === "group" && u.open === "{" ? u.body : [u]);

function mergeUnit(a: Unit, b: Unit): string {
  if (key(a) === key(b)) return src(b);
  switch (b.kind) {
    case "group":
      return b.open + mergeSequence((a as typeof b).body, b.body) + b.close;
    case "command":
      return b.name + b.args.map((arg, i) => mergeUnit((a as typeof b).args[i], arg)).join("");
    case "script":
      return `${b.op}{${mergeSequence(scriptBody((a as typeof b).arg), scriptBody(b.arg))}}`;
    case "wrap":
      return b.head + mergeSequence((a as typeof b).body, b.body) + b.tail;
    default:
      return src(b);
  }
}

/** What was removed and what was added in place of it */
function mergeHunk(removed: Unit[], added: Unit[]): string {
  const r = solid(removed);
  const a = solid(added);
  if (r.length > 0 && r.length === a.length && r.every((u, i) => comparable(u, a[i]))) {
    let k = 0;
    return added.map((u) => (u.kind === "space" ? u.src : mergeUnit(r[k++], u))).join("");
  }
  return wrapped(removed, DIFF_DEL) + wrapped(added, DIFF_INS);
}

function mergeSequence(before: Unit[], after: Unit[]): string {
  // Spaces are left out of the comparison; those of the version after are kept.
  const nb = before.flatMap((u, i) => (u.kind === "space" ? [] : [i]));
  const na = after.flatMap((u, i) => (u.kind === "space" ? [] : [i]));
  const parts = diffArrays(
    nb.map((i) => key(before[i])),
    na.map((i) => key(after[i]))
  );
  let out = "";
  let pb = 0;
  let pa = 0;
  /** Units of `after` up to here are in `out` */
  let done = 0;
  const upTo = (end: number) => {
    for (; done < end; done++) out += src(after[done]);
  };
  for (let k = 0; k < parts.length; k++) {
    if (!parts[k].added && !parts[k].removed) {
      const n = parts[k].count;
      upTo(na[pa + n - 1] + 1);
      pa += n;
      pb += n;
      continue;
    }
    let removed = 0;
    let added = 0;
    for (; k < parts.length && (parts[k].added || parts[k].removed); k++) {
      if (parts[k].removed) removed += parts[k].count;
      else added += parts[k].count;
    }
    k--;
    const del = removed > 0 ? before.slice(nb[pb], nb[pb + removed - 1] + 1) : [];
    let ins: Unit[] = [];
    if (added > 0) {
      upTo(na[pa]);
      ins = after.slice(na[pa], na[pa + added - 1] + 1);
      done = na[pa + added - 1] + 1;
    }
    out += mergeHunk(del, ins);
    pb += removed;
    pa += added;
  }
  upTo(after.length);
  return out;
}

/** The merged LaTeX (see above); null when either version can't be split into units. */
export function mergeLatex(before: string, after: string): string | null {
  const b = parse(before);
  const a = parse(after);
  return b && a ? mergeSequence(b, a) : null;
}
