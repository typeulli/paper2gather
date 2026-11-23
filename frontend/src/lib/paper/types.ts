export type RefType =
  | "article"
  | "inproceedings"
  | "book"
  | "incollection"
  | "phdthesis"
  | "mastersthesis"
  | "techreport"
  | "misc";

export interface Reference {
  id: string;
  /** BibTeX citation key, used for LaTeX export */
  key: string;
  type: RefType;
  title: string;
  /** "First Last" or "Last, First" */
  authors: string[];
  year: string;
  /** Journal, conference (booktitle) or school/institution */
  venue: string;
  volume: string;
  issue: string;
  pages: string;
  publisher: string;
  doi: string;
  url: string;
  note: string;
  /** "1"–"12" or "" */
  month: string;
  /** Editors of the book or proceedings, written like authors */
  editors: string[];
  /** Where it was published or held: "Cham, Switzerland" */
  address: string;
  /** Edition number of a book: "2" */
  edition: string;
  /** Book series of a proceedings volume or chapter: "LNCS" */
  series: string;
  /** When a web source was accessed: "YYYY-MM-DD" or "" */
  accessed: string;
}

export interface Author {
  id: string;
  name: string;
  affiliation: string;
  email: string;
}

export interface CommentMessage {
  id: string;
  author: string;
  color: string;
  text: string;
  createdAt: number;
}

export interface CommentThread {
  id: string;
  quote: string;
  resolved: boolean;
  createdAt: number;
  messages: CommentMessage[];
}

export type ObjectKind = "equation" | "figure" | "table" | "section";
