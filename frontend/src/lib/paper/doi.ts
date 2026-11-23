import { normalizeReference } from "./references";
import type { Reference, RefType } from "./types";

interface CrossrefWork {
  type?: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  editor?: { given?: string; family?: string; name?: string }[];
  issued?: { "date-parts"?: number[][] };
  published?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  "publisher-location"?: string;
  "edition-number"?: string;
  DOI?: string;
  URL?: string;
}

const TYPE_MAP: Record<string, RefType> = {
  "journal-article": "article",
  "proceedings-article": "inproceedings",
  book: "book",
  monograph: "book",
  "edited-book": "book",
  "book-chapter": "incollection",
  "book-section": "incollection",
  dissertation: "phdthesis",
  report: "techreport",
  "posted-content": "misc",
};

export function extractDoi(input: string): string | null {
  const m = /10\.\d{4,9}\/[^\s"<>]+/i.exec(input.trim());
  return m ? m[0].replace(/[.,;]+$/, "") : null;
}

/** Looks up metadata on Crossref (CORS enabled, no API key). */
export async function fetchReferenceByDoi(input: string): Promise<Reference> {
  const doi = extractDoi(input);
  if (!doi) throw new Error("올바른 DOI 형식이 아닙니다 (예: 10.1145/3292500.3330701)");
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (res.status === 404) throw new Error("Crossref에서 DOI를 찾을 수 없습니다");
  if (!res.ok) throw new Error(`Crossref 요청 실패 (${res.status})`);
  const work = ((await res.json()) as { message: CrossrefWork }).message;
  const people = work.author ?? work.editor ?? [];
  const name = (p: { given?: string; family?: string; name?: string }) =>
    p.name ?? [p.given, p.family].filter(Boolean).join(" ");
  const [year, month] = (work.issued ?? work.published)?.["date-parts"]?.[0] ?? [];
  return normalizeReference({
    type: TYPE_MAP[work.type ?? ""] ?? "misc",
    title: work.title?.[0]?.replace(/\s+/g, " ") ?? "",
    authors: people.map(name),
    // Editors stand in for missing authors above.
    editors: work.author ? (work.editor ?? []).map(name) : [],
    year: year ? String(year) : "",
    month: month ? String(month) : "",
    address: work["publisher-location"] ?? "",
    edition: work["edition-number"] ?? "",
    venue: work["container-title"]?.[0] ?? "",
    volume: work.volume ?? "",
    issue: work.issue ?? "",
    pages: work.page ?? "",
    publisher: work.publisher ?? "",
    doi: work.DOI ?? doi,
    url: work.URL ?? "",
  });
}
