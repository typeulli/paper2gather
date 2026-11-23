import { shortId } from "@/lib/ids";
import type { Reference, RefType } from "./types";

export const REF_TYPE_LABELS: Record<RefType, string> = {
  article: "저널 논문",
  inproceedings: "학회 논문",
  book: "단행본",
  incollection: "책 챕터",
  phdthesis: "박사 학위논문",
  mastersthesis: "석사 학위논문",
  techreport: "기술 보고서",
  misc: "기타 / 웹",
};

export const VENUE_LABELS: Record<RefType, string> = {
  article: "저널",
  inproceedings: "학회명 (booktitle)",
  book: "시리즈",
  incollection: "책 제목 (booktitle)",
  phdthesis: "학교",
  mastersthesis: "학교",
  techreport: "기관",
  misc: "출처",
};

/** Fields added after references were first stored; older references lack them. A new object each time. */
const laterFields = () => ({
  month: "",
  editors: [] as string[],
  address: "",
  edition: "",
  series: "",
  accessed: "",
});

export function emptyReference(): Reference {
  return {
    id: shortId(),
    key: "",
    type: "article",
    title: "",
    authors: [],
    year: "",
    venue: "",
    volume: "",
    issue: "",
    pages: "",
    publisher: "",
    doi: "",
    url: "",
    note: "",
    ...laterFields(),
  };
}

const LATER_KEYS = Object.keys(laterFields());

/** A stored reference with the fields it may lack */
export function withLaterFields(ref: Reference): Reference {
  return LATER_KEYS.every((k) => k in ref) ? ref : { ...laterFields(), ...ref };
}

export function normalizeReference(partial: Partial<Reference>): Reference {
  const base = emptyReference();
  const defined = Object.fromEntries(
    Object.entries(partial).filter(([, v]) => v !== undefined && v !== null)
  ) as Partial<Reference>;
  const names = (list: string[] | undefined) => (list ?? []).map((a) => a.trim()).filter(Boolean);
  return {
    ...base,
    ...defined,
    authors: names(partial.authors),
    editors: names(partial.editors),
  };
}

export function parseAuthorName(raw: string): { first: string; last: string } {
  const name = raw.trim();
  if (name.includes(",")) {
    const [last, first = ""] = name.split(",", 2);
    return { first: first.trim(), last: last.trim() };
  }
  const parts = name.split(/\s+/);
  const last = parts.pop() ?? "";
  return { first: parts.join(" "), last };
}

/** "Ashish Kumar" -> "A. K." */
export function initials(first: string): string {
  return first
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .split("-")
        .filter(Boolean)
        .map((p) => (p.endsWith(".") && p.length <= 3 ? p : `${p[0]}.`))
        .join("-")
    )
    .join(" ");
}

const HANGUL = /[ㄱ-ㆎ가-힣]/;

/** Korean names are written as they are: no initials, no reordering. */
export const isKoreanName = (name: string) => HANGUL.test(name);

export function formatAuthorsIEEE(authors: string[]): string {
  const names = authors.map((a) => {
    if (isKoreanName(a)) return a.trim();
    const { first, last } = parseAuthorName(a);
    const init = initials(first);
    return init ? `${init} ${last}` : last;
  });
  if (names.length === 0) return "";
  if (names.length > 6) return `${names[0]} et al.`;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function lastNameOf(author: string | undefined): string {
  return author ? parseAuthorName(author).last : "";
}

export interface Segment {
  text: string;
  italic?: boolean;
}

/** IEEE-like numeric style. */
export function formatReference(ref: Reference): Segment[] {
  const title = ref.title || "(제목 없음)";
  const details: string[] = [];
  if (ref.volume) details.push(`vol. ${ref.volume}`);
  if (ref.issue) details.push(`no. ${ref.issue}`);
  if (ref.pages) {
    const prefix = /[-–,]/.test(ref.pages) ? "pp." : "p.";
    details.push(`${prefix} ${ref.pages.replace(/--?/g, "–")}`);
  }
  const plain = (...parts: string[]): Segment[][] => parts.filter(Boolean).map((text) => [{ text }]);
  const italicVenue = (prefix = ""): Segment[][] =>
    ref.venue ? [[...(prefix ? [{ text: prefix }] : []), { text: ref.venue, italic: true }]] : [];

  // Pieces after the title, joined by ", " and terminated with "."
  let pieces: Segment[][];
  switch (ref.type) {
    case "book":
      pieces = plain(ref.publisher, ref.year);
      break;
    case "inproceedings":
    case "incollection":
      pieces = [...italicVenue("in "), ...plain(ref.publisher, ref.year, ...details)];
      break;
    case "phdthesis":
    case "mastersthesis":
      pieces = plain(
        ref.type === "phdthesis" ? "Ph.D. dissertation" : "M.S. thesis",
        ref.venue,
        ref.year
      );
      break;
    case "techreport":
      pieces = plain(ref.venue, "Tech. Rep.", ref.year);
      break;
    case "misc":
      pieces = plain(ref.venue, ref.year);
      break;
    default:
      pieces = [...italicVenue(), ...plain(...details, ref.year)];
  }

  const segs: Segment[] = [];
  const authors = formatAuthorsIEEE(ref.authors);
  if (authors) segs.push({ text: `${authors}, ` });
  if (ref.type === "book") {
    segs.push({ text: title, italic: true }, { text: pieces.length ? ". " : "." });
  } else {
    segs.push({ text: pieces.length ? `“${title},” ` : `“${title}.”` });
  }
  pieces.forEach((piece, i) => {
    if (i > 0) segs.push({ text: ", " });
    segs.push(...piece);
  });
  if (pieces.length) segs.push({ text: "." });
  if (ref.doi) segs.push({ text: ` doi: ${ref.doi}.` });
  else if (ref.url) segs.push({ text: ` [Online]. Available: ${ref.url}` });
  if (ref.note) segs.push({ text: ` ${ref.note}` });
  return segs;
}

export function referenceToPlainText(ref: Reference): string {
  return formatReference(ref)
    .map((s) => s.text)
    .join("");
}

/** [1, 2, 3, 5] -> "1–3, 5" */
export function compressNumbers(nums: number[], separator = ", "): string {
  const sorted = Array.from(new Set(nums)).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) parts.push(`${sorted[i]}–${sorted[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return parts.join(separator);
}

export function parseRefIds(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").filter(Boolean) : [];
}

export function serializeRefIds(ids: string[]): string {
  return Array.from(new Set(ids)).join(",");
}

const KEY_STOP_WORDS = new Set(["with", "from", "that", "this", "towards", "using", "over"]);

/** e.g. "vaswani2017attention" */
export function makeCitationKey(ref: Reference, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const ascii = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const last = ascii(lastNameOf(ref.authors[0])).replace(/[^a-z0-9]/g, "");
  const word =
    ascii(ref.title)
      .split(/[^a-z0-9]+/)
      .find((w) => w.length > 3 && !KEY_STOP_WORDS.has(w)) ?? "";
  const base = `${last || "ref"}${ref.year.replace(/\D/g, "")}${word}`;
  let key = base;
  for (let i = 0; taken.has(key); i++) {
    key = `${base}${String.fromCharCode(97 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}`;
  }
  return key;
}

export function matchesReference(ref: Reference, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [ref.title, ref.key, ref.year, ref.venue, ...ref.authors].some((f) =>
    f.toLowerCase().includes(q)
  );
}
