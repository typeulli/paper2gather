/**
 * Citation styles: the order and numbers of the reference list, the marks citations show in the text and the
 * text of each list entry. Everything that shows citations or the list (editor, exports, revision view) goes
 * through a CitationLayout, so they all agree.
 */
import type { CitationFormat, CitationStyle } from "./format";
import { compressNumbers, formatReference, initials, isKoreanName, parseAuthorName, type Segment } from "./references";
import type { Reference } from "./types";

/** "paren": (Kim, 2020) or [1]; "narrative": Kim (2020). Numeric styles show both as numbers. */
export type CitationMode = "paren" | "narrative";

export interface CitationOptions {
  mode?: CitationMode;
  /** "p. 5", "pp. 3–7", "Chap. 2": put after the last citation inside the brackets */
  locator?: string;
}

export interface BibliographyEntry {
  ref: Reference;
  /** Number of a numeric style; null in author-date styles and for entries left out of the list */
  number: number | null;
  cited: boolean;
  /** In the printed and exported list (uncited entries are shown on screen only when not listed) */
  listed: boolean;
}

interface AuthorDate {
  /** "Kim & Lee", "Kim et al.", "홍길동 외" */
  paren: string;
  /** "Kim and Lee" */
  narrative: string;
  /** "2020a", "n.d." */
  year: string;
  korean: boolean;
}

export interface CitationLayout {
  style: CitationStyle;
  /** The list in its order */
  entries: BibliographyEntry[];
  byId: Map<string, BibliographyEntry>;
  authorDate: Map<string, AuthorDate>;
}

export const isAuthorDate = (style: CitationStyle) => style === "apa";

/**
 * Styles whose list is sorted by author (and year), not by first citation: APA, and LNCS, whose guidelines prefer
 * alphabetical order (splncs04.bst sorts by surname, year, title). Korean APA journals list Korean works first.
 */
const SORTED_BY_AUTHOR: Record<CitationStyle, { koreanFirst: boolean } | null> = {
  numeric: null,
  ieee: null,
  springer: { koreanFirst: false },
  apa: { koreanFirst: true },
};

/** Whether the style's own order is by author and year (otherwise by first citation) */
export const sortsByAuthor = (style: CitationStyle) => SORTED_BY_AUTHOR[style] !== null;

/** "[1]", "1." or nothing in front of a list entry */
export function entryLabel(entry: BibliographyEntry, style: CitationStyle): string {
  if (entry.number === null) return "";
  return style === "springer" ? `${entry.number}.` : `[${entry.number}]`;
}

// ------------------------------------------------------------------ names

interface PersonName {
  family: string;
  given: string;
  korean: boolean;
  /** As entered (trimmed) */
  written: string;
}

function personName(raw: string): PersonName {
  const written = raw.trim().replace(/\s+/g, " ");
  if (isKoreanName(written)) return { family: written, given: "", korean: true, written };
  const { first, last } = parseAuthorName(written);
  return { family: last, given: first, korean: false, written };
}

const collator = new Intl.Collator(["ko", "en"], { sensitivity: "base", numeric: true });

/** "A", "A and B", "A, B, and C" */
function listWithAnd(names: string[], and: string, serial = true): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} ${and} ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}${serial ? "," : ""} ${and} ${names[names.length - 1]}`;
}

// ------------------------------------------------------------------ order

const ARTICLES = /^(the|a|an)\s+/i;

/** By authors, year and title; Korean entries first or (as BibTeX sorts) last */
function compareByAuthor(a: Reference, b: Reference, koreanFirst: boolean): number {
  const lead = (r: Reference) => r.authors[0] ?? r.title;
  const ka = isKoreanName(lead(a)) === koreanFirst ? 0 : 1;
  const kb = isKoreanName(lead(b)) === koreanFirst ? 0 : 1;
  if (ka !== kb) return ka - kb;
  const names = (r: Reference) =>
    r.authors.length ? r.authors.map(personName) : [{ family: r.title.replace(ARTICLES, ""), given: "" }];
  const na = names(a);
  const nb = names(b);
  for (let i = 0; i < Math.min(na.length, nb.length); i++) {
    const c = collator.compare(na[i].family, nb[i].family) || collator.compare(na[i].given, nb[i].given);
    if (c) return c;
  }
  // One author before several, "nothing precedes something"
  if (na.length !== nb.length) return na.length - nb.length;
  const ya = a.year.trim();
  const yb = b.year.trim();
  // Undated works come first.
  if (!ya !== !yb) return ya ? 1 : -1;
  return collator.compare(ya, yb) || collator.compare(a.title.replace(ARTICLES, ""), b.title.replace(ARTICLES, ""));
}

/**
 * The reference list of a document: `list` is the order of the references panel, `citationOrder` the
 * references in order of their first citation.
 */
export function layoutCitations(list: Reference[], citationOrder: string[], format: CitationFormat): CitationLayout {
  const cited = new Set(citationOrder);
  const sorted = SORTED_BY_AUTHOR[format.style];
  let order: Reference[];
  if (format.order === "manual") order = list;
  else if (sorted) order = [...list].sort((a, b) => compareByAuthor(a, b, sorted.koreanFirst));
  else {
    const byId = new Map(list.map((r) => [r.id, r]));
    const first = citationOrder.map((id) => byId.get(id)).filter((r): r is Reference => !!r);
    order = [...first, ...list.filter((r) => !cited.has(r.id))];
  }
  const numbered = !isAuthorDate(format.style);
  let n = 0;
  const entries = order.map((ref): BibliographyEntry => {
    const isCited = cited.has(ref.id);
    const listed = isCited || format.listUncited;
    return { ref, cited: isCited, listed, number: listed && numbered ? ++n : null };
  });
  const authorDate = new Map<string, AuthorDate>();
  if (!numbered) {
    // Letters and longer author lists only tell apart what the printed list holds.
    for (const group of [entries.filter((e) => e.listed), entries.filter((e) => !e.listed)]) {
      for (const [id, label] of authorDateLabels(group.map((e) => e.ref))) authorDate.set(id, label);
    }
  }
  return { style: format.style, entries, byId: new Map(entries.map((e) => [e.ref.id, e])), authorDate };
}

// ------------------------------------------------------------------ author-date labels (APA 7)

const ET_AL = { en: "et al.", ko: "외" };

/** "과" after a final consonant, "와" after a vowel: 이복동과, 김철수와 */
function withAnd(name: string): string {
  const code = name.charCodeAt(name.length - 1) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 !== 0 ? "과" : "와";
}

/** APA 7 §8.17–8.20: "Kim", "Kim & Lee", "Kim et al.", more names or initials where needed, a/b for the rest */
function authorDateLabels(refs: Reference[]): Map<string, AuthorDate> {
  const people = refs.map((r) => r.authors.map(personName));
  // First authors who share a surname but not the initials are cited with their initials (§8.20).
  const initialsOf = new Map<string, Set<string>>();
  for (const names of people) {
    const first = names[0];
    if (!first || first.korean) continue;
    const set = initialsOf.get(first.family) ?? new Set();
    set.add(initials(first.given));
    initialsOf.set(first.family, set);
  }
  const shown = (name: PersonName, i: number) =>
    i === 0 && !name.korean && (initialsOf.get(name.family)?.size ?? 0) > 1
      ? `${initials(name.given)} ${name.family}`.trim()
      : name.family;

  const label = (names: PersonName[], count: number, title: string) => {
    if (names.length === 0) {
      const words = title.trim().split(/\s+/);
      const short = words.length > 4 ? `${words.slice(0, 4).join(" ")}…` : title.trim() || "?";
      return { paren: short, narrative: short, korean: isKoreanName(title) };
    }
    const korean = names.every((p) => p.korean);
    const parts = names.slice(0, count).map(shown);
    const etAl = count < names.length;
    if (korean) {
      // (이복동, 김명기, 2020) but 이복동과 김명기(2020); (이복동 외, 2020)
      if (etAl) return { paren: `${parts.join(", ")} ${ET_AL.ko}`, narrative: `${parts.join(", ")} ${ET_AL.ko}`, korean };
      const narrative =
        parts.length === 2 ? `${parts[0]}${withAnd(parts[0])} ${parts[1]}` : parts.join(", ");
      return { paren: parts.join(", "), narrative, korean };
    }
    if (etAl) {
      const text = `${parts.join(", ")}${parts.length > 1 ? "," : ""} ${ET_AL.en}`;
      return { paren: text, narrative: text, korean };
    }
    return { paren: listWithAnd(parts, "&"), narrative: listWithAnd(parts, "and"), korean };
  };

  // Two authors are always named; three or more start as "First et al.".
  const counts = people.map((names) => (names.length <= 2 ? names.length : 1));
  const years = refs.map((r) => r.year.trim() || "n.d.");
  const full = people.map((names) => names.map((p) => `${p.family}|${initials(p.given)}`).join(";"));
  // Different author lists that shorten alike get as many names as tell them apart (§8.18).
  for (let changed = true; changed; ) {
    changed = false;
    const groups = new Map<string, number[]>();
    refs.forEach((r, i) => {
      const key = `${label(people[i], counts[i], r.title).paren}|${years[i]}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    });
    for (const members of groups.values()) {
      if (new Set(members.map((i) => full[i])).size < 2) continue;
      for (const i of members) {
        if (counts[i] < people[i].length) {
          counts[i]++;
          changed = true;
        }
      }
    }
  }
  // The same authors in the same year: 2020a, 2020b … in list order (§8.19)
  const out = new Map<string, AuthorDate>();
  const byLabel = new Map<string, number[]>();
  refs.forEach((r, i) => {
    const key = `${full[i] || r.title}|${years[i]}`;
    byLabel.set(key, [...(byLabel.get(key) ?? []), i]);
  });
  for (const members of byLabel.values()) {
    members.forEach((i, k) => {
      const base = label(people[i], counts[i], refs[i].title);
      const letter = members.length > 1 ? String.fromCharCode(97 + (k % 26)) : "";
      const year = !letter ? years[i] : years[i] === "n.d." ? `n.d.-${letter}` : `${years[i]}${letter}`;
      out.set(refs[i].id, { ...base, year });
    });
  }
  return out;
}

// ------------------------------------------------------------------ in-text citations

/** IEEE: [1], [2], [3] (the Reference Guide of 2025 no longer joins ranges with an en dash) */
function ieeeNumbers(nums: number[]): string[] {
  return Array.from(new Set(nums))
    .sort((a, b) => a - b)
    .map((n) => `[${n}]`);
}

/** What a citation of `refIds` shows in the text */
export function citationText(refIds: string[], layout: CitationLayout, options: CitationOptions = {}): string {
  const locator = options.locator?.trim() ?? "";
  const entries = refIds.map((id) => layout.byId.get(id));
  const missing = entries.some((e) => !e);
  if (!isAuthorDate(layout.style)) {
    const nums = entries.map((e) => e?.number).filter((n): n is number => typeof n === "number");
    const unknown = missing || nums.length < entries.length;
    if (layout.style === "ieee") {
      const parts = [...ieeeNumbers(nums), ...(unknown ? ["[?]"] : [])];
      if (parts.length === 0) parts.push("[?]");
      const text = parts.join(", ");
      return locator ? `${text.slice(0, -1)}, ${locator}]` : text;
    }
    // Numeric and LNCS: [1, 3–5]
    const body = [compressNumbers(nums), ...(unknown ? ["?"] : [])].filter(Boolean).join(", ");
    return `[${body || "?"}${locator ? `, ${locator}` : ""}]`;
  }
  return authorDateText(entries, layout, options.mode ?? "paren", locator);
}

function authorDateText(
  entries: (BibliographyEntry | undefined)[],
  layout: CitationLayout,
  mode: CitationMode,
  locator: string
): string {
  // In the order of the list; the same authors are cited once with their years (Kim, 2018, 2020a).
  const position = new Map(layout.entries.map((e, i) => [e.ref.id, i]));
  const known = entries
    .filter((e): e is BibliographyEntry => !!e)
    .sort((a, b) => (position.get(a.ref.id) ?? 0) - (position.get(b.ref.id) ?? 0));
  const groups: { label: AuthorDate; years: string[] }[] = [];
  for (const e of known) {
    const label = layout.authorDate.get(e.ref.id);
    if (!label) continue;
    const last = groups[groups.length - 1];
    if (last && last.label.paren === label.paren) last.years.push(label.year);
    else groups.push({ label, years: [label.year] });
  }
  const unknown = entries.some((e) => !e || !layout.authorDate.has(e.ref.id));
  if (mode === "paren") {
    const parts = groups.map((g) => `${g.label.paren}, ${g.years.join(", ")}`);
    if (unknown) parts.push("?");
    return `(${parts.join("; ")}${locator ? `, ${locator}` : ""})`;
  }
  const parts = groups.map((g, i) => {
    const years = `${g.years.join(", ")}${i === groups.length - 1 && locator ? `, ${locator}` : ""}`;
    return g.label.korean ? `${g.label.narrative}(${years})` : `${g.label.narrative} (${years})`;
  });
  if (unknown) parts.push("(?)");
  return listWithAnd(parts, "and");
}

// ------------------------------------------------------------------ reference list entries

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const IEEE_MONTHS = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec."];

/** "4", "04", "apr", "April" -> 4; 0 if none */
export function monthNumber(value: string | undefined): number {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return 0;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
  const i = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(v.slice(0, 3)) && v.length >= 3);
  return i + 1;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "2" -> "2nd"; other text as entered */
export function editionText(edition: string): string {
  const n = Number(edition.trim());
  return Number.isInteger(n) && n > 0 ? ordinal(n) : edition.trim();
}

const enDash = (pages: string) => pages.trim().replace(/\s*-{1,2}\s*|\s*–\s*/g, "–");
const isRange = (pages: string) => /[–,-]/.test(pages);

/** Parts of an entry, some in italics */
class Out {
  readonly segments: Segment[] = [];
  text(text: string): this {
    if (!text) return this;
    const last = this.segments[this.segments.length - 1];
    if (last && !last.italic) last.text += text;
    else this.segments.push({ text });
    return this;
  }
  italic(text: string): this {
    if (text) this.segments.push({ text, italic: true });
    return this;
  }
  /** Ends a sentence with "." unless it already ends with punctuation */
  period(): this {
    const last = this.segments[this.segments.length - 1];
    if (last && !/[.?!]$/.test(last.text.trimEnd())) this.text(".");
    return this;
  }
}

const field = (value: string | undefined) => (value ?? "").trim();

/**
 * The text of a list entry in `style`. With the layout of its list, APA entries take the year their citations
 * show (2020a, 2020b).
 */
export function formatReferenceAs(ref: Reference, style: CitationStyle, layout?: CitationLayout): Segment[] {
  switch (style) {
    case "ieee":
      return ieeeEntry(ref);
    case "springer":
      return springerEntry(ref);
    case "apa":
      return apaEntry(ref, layout?.authorDate.get(ref.id)?.year);
    default:
      return formatReference(ref);
  }
}

// ---- IEEE (IEEE Reference Guide)

function ieeeName(raw: string): string {
  const p = personName(raw);
  if (p.korean) return p.written;
  const init = initials(p.given);
  return init ? `${init} ${p.family}` : p.family;
}

function ieeeNames(names: string[]): string {
  const shown = names.map(ieeeName);
  if (shown.length > 6) return `${shown[0]} et al.`;
  return listWithAnd(shown, "and");
}

function ieeeEntry(ref: Reference): Segment[] {
  const o = new Out();
  const title = field(ref.title) || "(제목 없음)";
  const authors = ieeeNames(ref.authors);
  const month = monthNumber(ref.month);
  const date = [month ? IEEE_MONTHS[month - 1] : "", field(ref.year)].filter(Boolean).join(" ");
  const pages = field(ref.pages) && `${isRange(ref.pages) ? "pp." : "p."} ${enDash(ref.pages)}`;
  const place = field(ref.address);
  const edition = field(ref.edition) && `${editionText(ref.edition)} ed.`;
  const editors = (ref.editors ?? []).filter(Boolean);
  const editorText = editors.length ? `${ieeeNames(editors)}, ${editors.length > 1 ? "Eds." : "Ed."}` : "";
  const publisherPlace = [place, field(ref.publisher)].filter(Boolean).join(": ");

  /** "A. Author, “Title,” rest" with the comma inside the quotes; "A. Author, “Title.”" if nothing follows */
  const quoted = (rest: boolean) => {
    if (authors) o.text(`${authors}, `);
    o.text(rest ? `“${title},” ` : `“${title}.”`);
  };
  /** The quoted title, then the pieces joined by ", " and ended with "." */
  const quotedWith = (...list: (string | (() => void))[]) => {
    const parts = list.filter((p) => p);
    quoted(parts.length > 0);
    parts.forEach((p, i) => {
      if (i > 0) o.text(", ");
      if (typeof p === "function") p();
      else o.text(p);
    });
    if (parts.length) o.period();
  };
  const venue = () => o.italic(field(ref.venue));
  const doi = field(ref.doi) && `doi: ${field(ref.doi)}`;

  switch (ref.type) {
    case "book": {
      if (authors) o.text(`${authors}, `);
      o.italic(title);
      o.text(edition ? `, ${edition} ` : ". ");
      o.text(publisherPlace ? `${publisherPlace}, ` : "");
      o.text(field(ref.year));
      o.period();
      if (doi) o.text(` ${doi}.`);
      break;
    }
    case "incollection":
      // “Title,” in Book, 2nd ed., J. S. Brake, Ed., New York, NY, USA: Wiley, 1994, pp. 55–70.
      quotedWith(
        () => {
          o.text("in ");
          venue();
        },
        edition,
        editorText,
        publisherPlace,
        field(ref.year),
        pages,
        doi
      );
      break;
    case "inproceedings":
      quotedWith(
        field(ref.venue) &&
          (() => {
            o.text("in ");
            venue();
          }),
        place,
        date,
        pages,
        doi
      );
      break;
    case "phdthesis":
    case "mastersthesis":
      quotedWith(ref.type === "phdthesis" ? "Ph.D. dissertation" : "M.S. thesis", field(ref.venue), place, date);
      break;
    case "techreport":
      quotedWith(field(ref.venue), place, field(ref.issue) ? `Tech. Rep. ${field(ref.issue)}` : "Tech. Rep.", date);
      break;
    case "misc": {
      if (authors) o.text(`${authors}. `);
      o.text(`“${title}.” `);
      if (field(ref.venue)) o.italic(field(ref.venue)).text(". ");
      if (date && !field(ref.url)) o.text(`${date}. `);
      if (field(ref.accessed)) o.text(`Accessed: ${ieeeDate(ref.accessed)}. `);
      if (field(ref.url)) o.text(`[Online]. Available: ${field(ref.url)}`);
      else if (doi) o.text(`${doi}.`);
      break;
    }
    default:
      quotedWith(
        field(ref.venue) && venue,
        field(ref.volume) && `vol. ${field(ref.volume)}`,
        field(ref.issue) && `no. ${field(ref.issue)}`,
        pages,
        date,
        doi
      );
  }
  if (ref.type !== "misc" && field(ref.url) && !field(ref.doi)) o.text(` [Online]. Available: ${field(ref.url)}`);
  if (field(ref.note)) o.text(` ${field(ref.note)}`);
  return o.segments;
}

/** "2024-03-05" -> "Mar. 5, 2024" */
function ieeeDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m) return iso;
  return d ? `${IEEE_MONTHS[m - 1]} ${d}, ${y}` : `${IEEE_MONTHS[m - 1]} ${y}`;
}

// ---- Springer LNCS (splncs04)

function springerName(raw: string): string {
  const p = personName(raw);
  if (p.korean) return p.written;
  const init = initials(p.given).replace(/\s+/g, "");
  return init ? `${p.family}, ${init}` : p.family;
}

const springerNames = (names: string[]) => names.map(springerName).join(", ");

function springerEntry(ref: Reference): Segment[] {
  const o = new Out();
  const title = field(ref.title) || "(제목 없음)";
  const authors = springerNames(ref.authors);
  const year = field(ref.year) && `(${field(ref.year)})`;
  const pages = field(ref.pages) && enDash(ref.pages);
  const publisher = [field(ref.publisher), field(ref.address)].filter(Boolean).join(", ");
  const editors = (ref.editors ?? []).filter(Boolean);
  const edition = field(ref.edition) && `${editionText(ref.edition)} edn.`;
  const doi = field(ref.doi) && `https://doi.org/${field(ref.doi)}`;
  /** "Publisher, Location (Year)" */
  const imprint = [publisher, year].filter(Boolean).join(" ");
  if (authors) o.text(`${authors}: `);

  switch (ref.type) {
    case "book":
      o.text(`${title}. `);
      if (edition) o.text(`${edition} `);
      if (field(ref.venue)) o.text(`${field(ref.venue)}${field(ref.volume) ? `, vol. ${field(ref.volume)}` : ""}. `);
      o.text(imprint);
      break;
    case "inproceedings":
    case "incollection": {
      o.text(`${title}. In: `);
      if (editors.length) o.text(`${springerNames(editors)} (${editors.length > 1 ? "eds." : "ed."}) `);
      const series = [
        field(ref.venue),
        field(ref.series),
        field(ref.volume) && `vol. ${field(ref.volume)}`,
        pages && `pp. ${pages}`,
      ].filter(Boolean);
      o.text(series.join(", "));
      if (imprint) o.period().text(` ${imprint}`);
      break;
    }
    case "phdthesis":
    case "mastersthesis":
      // Ph.D. thesis, MIT, Cambridge (2015)
      o.text(`${title}. ${ref.type === "phdthesis" ? "Ph.D. thesis" : "Master's thesis"}`);
      o.text([field(ref.venue), field(ref.address)].filter(Boolean).map((s) => `, ${s}`).join(""));
      o.text(year ? ` ${year}` : "");
      break;
    case "techreport":
      // Tech. Rep. TR-42, NIST, Gaithersburg (2013)
      o.text(`${title}. Tech. Rep.${field(ref.issue) ? ` ${field(ref.issue)}` : ""}`);
      o.text([field(ref.venue), field(ref.address)].filter(Boolean).map((s) => `, ${s}`).join(""));
      o.text(year ? ` ${year}` : "");
      break;
    case "misc": {
      // "LNCS Homepage, http://www.springer.com/lncs, last accessed 2016/11/21" (no final period)
      o.text([title, field(ref.venue), field(ref.url)].filter(Boolean).join(", "));
      if (field(ref.accessed)) o.text(`, last accessed ${field(ref.accessed).replace(/-/g, "/")}`);
      else if (year) o.text(` ${year}`);
      if (field(ref.note)) o.text(` ${field(ref.note)}`);
      return o.segments;
    }
    default: {
      // Journal 2(5), 99–110 (2016)
      o.text(`${title}. `);
      const volume = `${field(ref.volume)}${field(ref.issue) ? `(${field(ref.issue)})` : ""}`;
      const head = [field(ref.venue), volume].filter(Boolean).join(" ");
      o.text([head, pages].filter(Boolean).join(", "));
      o.text(year ? ` ${year}` : "");
    }
  }
  o.period();
  if (doi) o.text(` ${doi}`);
  else if (field(ref.url)) o.text(` ${field(ref.url)}`);
  if (field(ref.note)) o.text(` ${field(ref.note)}`);
  return o.segments;
}

// ---- APA 7

function apaName(raw: string): string {
  const p = personName(raw);
  if (p.korean) return p.written;
  const init = initials(p.given);
  return init ? `${p.family}, ${init}` : p.family;
}

/** Up to 20 authors; with 21 or more the first 19, "…" and the last (§9.8) */
function apaNames(names: string[]): string {
  const shown = names.map(apaName);
  if (shown.length === 0) return "";
  if (names.every(isKoreanName)) return shown.join(", ");
  if (shown.length === 1) return shown[0];
  if (shown.length > 20) return `${shown.slice(0, 19).join(", ")}, . . . ${shown[shown.length - 1]}`;
  return `${shown.slice(0, -1).join(", ")}, & ${shown[shown.length - 1]}`;
}

/** Editors in a chapter: "J. Smith & K. Lee (Eds.)" */
function apaEditors(names: string[]): string {
  const shown = names.map((raw) => {
    const p = personName(raw);
    if (p.korean) return p.written;
    const init = initials(p.given);
    return init ? `${init} ${p.family}` : p.family;
  });
  const list = names.every(isKoreanName) ? shown.join(", ") : listWithAnd(shown, "&", shown.length > 2);
  return `${list} (${names.length > 1 ? "Eds." : "Ed."})`;
}

/** `yearLabel`: the year with its letter ("2020a", "n.d.-b") when the list has more works of the authors that year */
function apaEntry(ref: Reference, yearLabel?: string): Segment[] {
  const o = new Out();
  const title = field(ref.title) || "(제목 없음)";
  const authors = apaNames(ref.authors);
  const korean = ref.authors.length ? ref.authors.every(isKoreanName) : isKoreanName(title);
  const month = monthNumber(ref.month);
  const year = yearLabel || field(ref.year) || "n.d.";
  const date = ref.type === "misc" && month && field(ref.year) ? `${year}, ${MONTH_NAMES[month - 1]}` : year;
  const pages = field(ref.pages) && enDash(ref.pages);
  const edition = field(ref.edition) && `${editionText(ref.edition)} ed.`;
  const link = field(ref.doi) ? `https://doi.org/${field(ref.doi)}` : field(ref.url);
  const editors = (ref.editors ?? []).filter(Boolean);
  const italicTitle = ["book", "phdthesis", "mastersthesis", "techreport", "misc"].includes(ref.type);

  // Author. (Year). — without authors the title takes their place (§9.12). Korean journals write
  // "심청, 심학규 (2023)." with no period after the names.
  if (authors && korean) o.text(`${authors} (${date}). `);
  else if (authors) {
    o.text(authors);
    o.period().text(` (${date}). `);
  }
  const titleText = (italic: boolean) => {
    if (italic) o.italic(title);
    else o.text(title);
  };
  if (authors) titleText(italicTitle);
  else {
    titleText(italicTitle);
    // What follows starts with its own space.
    o.period().text(` (${date}).`);
  }

  switch (ref.type) {
    case "book":
      if (edition) o.text(` (${edition})`);
      o.period();
      if (field(ref.publisher)) o.text(` ${field(ref.publisher)}`).period();
      break;
    case "inproceedings":
    case "incollection":
      o.period().text(" In ");
      if (editors.length) o.text(`${apaEditors(editors)}, `);
      o.italic(field(ref.venue) || "(제목 없음)");
      {
        const inside = [edition, pages && `${isRange(ref.pages) ? "pp." : "p."} ${pages}`].filter(Boolean);
        if (inside.length) o.text(` (${inside.join(", ")})`);
      }
      o.period();
      if (field(ref.publisher)) o.text(` ${field(ref.publisher)}`).period();
      break;
    case "phdthesis":
    case "mastersthesis": {
      const kind = ref.type === "phdthesis" ? "Doctoral dissertation" : "Master's thesis";
      o.text(` [${[kind, field(ref.venue)].filter(Boolean).join(", ")}]`).period();
      break;
    }
    case "techreport":
      if (field(ref.issue)) o.text(` (Report No. ${field(ref.issue)})`);
      o.period();
      if (field(ref.venue) || field(ref.publisher)) o.text(` ${field(ref.venue) || field(ref.publisher)}`).period();
      break;
    case "misc":
      o.period();
      if (field(ref.venue)) o.text(` ${field(ref.venue)}`).period();
      break;
    default: {
      // Journal, 12(3), 45–67.
      o.period().text(" ");
      if (field(ref.venue)) {
        o.italic(field(ref.venue));
        if (field(ref.volume)) o.text(", ").italic(field(ref.volume));
        if (field(ref.issue)) o.text(`(${field(ref.issue)})`);
        if (pages) o.text(`, ${pages}`);
        o.period();
      }
    }
  }
  if (link) o.text(` ${link}`);
  if (field(ref.note)) o.text(` ${field(ref.note)}`);
  // Korean entries and titles aren't set in italics (Korean journals use a gothic face instead).
  return o.segments.map((s, i) => ({
    text: i === 0 ? s.text.trimStart() : s.text,
    ...(s.italic && !korean && !isKoreanName(s.text) ? { italic: true } : {}),
  }));
}
