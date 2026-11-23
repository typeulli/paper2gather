import { editionText, monthNumber } from "./citations";
import { normalizeReference } from "./references";
import type { Reference, RefType } from "./types";

interface BibEntry {
  type: string;
  key: string;
  fields: Record<string, string>;
}

const MONTHS: Record<string, string> = {
  jan: "January",
  feb: "February",
  mar: "March",
  apr: "April",
  may: "May",
  jun: "June",
  jul: "July",
  aug: "August",
  sep: "September",
  oct: "October",
  nov: "November",
  dec: "December",
};

const ACCENTS: Record<string, Record<string, string>> = {
  '"': { a: "ä", o: "ö", u: "ü", e: "ë", i: "ï", A: "Ä", O: "Ö", U: "Ü" },
  "'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", c: "ć", n: "ń", s: "ś", z: "ź", E: "É" },
  "`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù" },
  "^": { a: "â", e: "ê", i: "î", o: "ô", u: "û" },
  "~": { a: "ã", n: "ñ", o: "õ", N: "Ñ" },
  c: { c: "ç", C: "Ç", s: "ş" },
  v: { c: "č", s: "š", z: "ž", r: "ř", e: "ě", C: "Č", S: "Š", Z: "Ž" },
};

function cleanValue(raw: string): string {
  return raw
    .replace(/\\([\"'`^~cv])\s*\{?\\?([a-zA-Z])\}?/g, (m, accent: string, ch: string) => ACCENTS[accent]?.[ch] ?? m)
    .replace(/\\ss\b/g, "ß")
    .replace(/\\([&%$#_{}])/g, "$1")
    .replace(/(?<!\\)[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

class Parser {
  i = 0;
  constructor(private s: string) {}

  skipWs() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  /** Reads a {...} group starting at the opening brace and returns its inner text. */
  braced(): string {
    let depth = 0;
    const start = this.i + 1;
    for (; this.i < this.s.length; this.i++) {
      const c = this.s[this.i];
      if (c === "\\") {
        this.i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          this.i++;
          return this.s.slice(start, this.i - 1);
        }
      }
    }
    return this.s.slice(start);
  }

  quoted(): string {
    let depth = 0;
    const start = ++this.i;
    for (; this.i < this.s.length; this.i++) {
      const c = this.s[this.i];
      if (c === "\\") {
        this.i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === '"' && depth === 0) {
        this.i++;
        return this.s.slice(start, this.i - 1);
      }
    }
    return this.s.slice(start);
  }

  value(strings: Record<string, string>): string {
    const parts: string[] = [];
    for (;;) {
      this.skipWs();
      const c = this.s[this.i];
      if (c === "{") parts.push(this.braced());
      else if (c === '"') parts.push(this.quoted());
      else {
        const m = /^[^\s,#}\)]+/.exec(this.s.slice(this.i));
        if (!m) break;
        this.i += m[0].length;
        const word = m[0].toLowerCase();
        parts.push(strings[word] ?? MONTHS[word] ?? m[0]);
      }
      this.skipWs();
      if (this.s[this.i] === "#") this.i++;
      else break;
    }
    return parts.join("");
  }

  entries(): BibEntry[] {
    const out: BibEntry[] = [];
    const strings: Record<string, string> = {};
    for (;;) {
      const at = this.s.indexOf("@", this.i);
      if (at < 0) break;
      this.i = at + 1;
      const typeMatch = /^[a-zA-Z]+/.exec(this.s.slice(this.i));
      if (!typeMatch) continue;
      const type = typeMatch[0].toLowerCase();
      this.i += typeMatch[0].length;
      this.skipWs();
      const open = this.s[this.i];
      if (open !== "{" && open !== "(") continue;
      const close = open === "{" ? "}" : ")";

      if (type === "comment" || type === "preamble") {
        this.braced();
        continue;
      }
      this.i++;
      if (type === "string") {
        this.skipWs();
        const name = /^[^\s=]+/.exec(this.s.slice(this.i))?.[0] ?? "";
        this.i += name.length;
        this.skipWs();
        if (this.s[this.i] === "=") this.i++;
        strings[name.toLowerCase()] = this.value(strings);
        this.skipWs();
        if (this.s[this.i] === close) this.i++;
        continue;
      }

      const comma = this.s.indexOf(",", this.i);
      if (comma < 0) break;
      const key = this.s.slice(this.i, comma).trim();
      this.i = comma + 1;
      const fields: Record<string, string> = {};
      for (;;) {
        this.skipWs();
        while (this.s[this.i] === ",") {
          this.i++;
          this.skipWs();
        }
        if (this.i >= this.s.length) break;
        if (this.s[this.i] === close) {
          this.i++;
          break;
        }
        const nameMatch = /^[a-zA-Z0-9_\-:.]+/.exec(this.s.slice(this.i));
        if (!nameMatch) {
          this.i++;
          continue;
        }
        this.i += nameMatch[0].length;
        this.skipWs();
        if (this.s[this.i] !== "=") continue;
        this.i++;
        fields[nameMatch[0].toLowerCase()] = this.value(strings);
      }
      out.push({ type, key, fields });
    }
    return out;
  }
}

/** Splits "A and B and {C and D}" on top-level " and ". */
function splitAuthors(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  const tokens = raw.split(/(\s+and\s+|[{}])/i);
  for (const t of tokens) {
    if (t === "{") depth++;
    if (t === "}") depth--;
    if (depth === 0 && /^\s+and\s+$/i.test(t)) {
      out.push(current);
      current = "";
    } else current += t;
  }
  out.push(current);
  return out.map(cleanValue).filter((a) => a && a.toLowerCase() !== "others");
}

const TYPE_MAP: Record<string, RefType> = {
  article: "article",
  inproceedings: "inproceedings",
  conference: "inproceedings",
  proceedings: "inproceedings",
  book: "book",
  incollection: "incollection",
  inbook: "incollection",
  phdthesis: "phdthesis",
  mastersthesis: "mastersthesis",
  techreport: "techreport",
  report: "techreport",
};

function entryToReference(entry: BibEntry): Reference {
  const f = (name: string) => cleanValue(entry.fields[name] ?? "");
  const type = TYPE_MAP[entry.type] ?? "misc";
  const month = monthNumber(f("month")) || Number(f("date").slice(5, 7)) || 0;
  return normalizeReference({
    // Without authors the editors stand in for them (below).
    editors: entry.fields.author ? splitAuthors(entry.fields.editor ?? "") : [],
    month: month >= 1 && month <= 12 ? String(month) : "",
    address: f("address") || f("location"),
    edition: f("edition"),
    series: f("series"),
    accessed: f("urldate"),
    key: entry.key,
    type,
    title: f("title"),
    authors: splitAuthors(entry.fields.author ?? entry.fields.editor ?? ""),
    year: f("year") || f("date").slice(0, 4),
    venue:
      f("journal") ||
      f("journaltitle") ||
      f("booktitle") ||
      f("school") ||
      f("institution") ||
      f("organization") ||
      f("howpublished") ||
      f("series"),
    volume: f("volume"),
    issue: f("number") || f("issue"),
    pages: f("pages"),
    publisher: f("publisher"),
    doi: f("doi").replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""),
    url: f("url"),
    note: f("note"),
  });
}

export function parseBibtex(input: string): Reference[] {
  return new Parser(input).entries().map(entryToReference);
}

const BIB_TYPE: Record<RefType, string> = {
  article: "article",
  inproceedings: "inproceedings",
  book: "book",
  incollection: "incollection",
  phdthesis: "phdthesis",
  mastersthesis: "mastersthesis",
  techreport: "techreport",
  misc: "misc",
};

const VENUE_FIELD: Record<RefType, string> = {
  article: "journal",
  inproceedings: "booktitle",
  book: "series",
  incollection: "booktitle",
  phdthesis: "school",
  mastersthesis: "school",
  techreport: "institution",
  misc: "howpublished",
};

function escapeBib(value: string): string {
  return value.replace(/([&%$#_])/g, "\\$1");
}

const MONTH_MACROS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export interface BibtexOptions {
  /** Citation key to write instead of the reference's own */
  key?: string;
  /** "2nd" instead of "2" (styles such as splncs04 print the edition as written) */
  ordinalEdition?: boolean;
  /** A `key` field with the title for works without authors, which sorting styles sort by */
  sortByTitle?: boolean;
}

export function referenceToBibtex(ref: Reference, options: BibtexOptions = {}): string {
  const month = monthNumber(ref.month);
  const edition = (ref.edition ?? "").trim();
  const fields: [string, string][] = [
    ["title", ref.title ? `{${escapeBib(ref.title)}}` : ""],
    ["author", ref.authors.map(escapeBib).join(" and ")],
    ["editor", (ref.editors ?? []).map(escapeBib).join(" and ")],
    ["key", options.sortByTitle && ref.authors.length === 0 ? escapeBib(ref.title.replace(/^(a|an|the)\s+/i, "")) : ""],
    // Braced like the title, so styles keep the case as entered (biblatex-apa lowercases book titles).
    [VENUE_FIELD[ref.type], ref.venue ? `{${escapeBib(ref.venue)}}` : ""],
    // A book's venue is its series already.
    ["series", ref.type === "book" ? "" : escapeBib(ref.series ?? "")],
    ["edition", options.ordinalEdition && edition ? editionText(edition) : edition],
    ["year", ref.year],
    ["volume", ref.volume],
    ["number", ref.issue],
    ["pages", ref.pages.replace(/[–-]+/g, "--")],
    ["publisher", escapeBib(ref.publisher)],
    ["address", escapeBib(ref.address ?? "")],
    ["doi", ref.doi],
    ["url", ref.url],
    ["urldate", ref.accessed ?? ""],
    ["note", escapeBib(ref.note)],
  ];
  const body = [
    ...fields.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${v}}`),
    // Month macros (no braces) are what every style understands.
    ...(month ? [`  month = ${MONTH_MACROS[month - 1]}`] : []),
  ].join(",\n");
  return `@${BIB_TYPE[ref.type]}{${options.key ?? (ref.key || ref.id)},\n${body}\n}`;
}

export function referencesToBibtex(refs: Reference[]): string {
  return refs.map((ref) => referenceToBibtex(ref)).join("\n\n") + "\n";
}
