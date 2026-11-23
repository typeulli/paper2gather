import { API_URL } from "./config";
import type { Author, Reference } from "./paper/types";

export interface DocumentMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Same as backend/src/history.ts */
export type RevisionAuthor = { kind: "user"; name: string; color: string } | { kind: "mcp" };

export interface RevisionInfo {
  id: number;
  author: RevisionAuthor;
  startedAt: number;
  endedAt: number;
  /** The revision whose result this one restored */
  restoredFrom?: number;
  /** Still growing with its author's edits */
  live: boolean;
}

/** The paper as text, per part */
export interface RevisionText {
  title: string;
  authors: string;
  body: string;
  references: string;
}

/** A node of the paper as the server reads it from Yjs (backend mcp/content.ts): marks by name */
export interface RevisionNode {
  type: string;
  attrs: Record<string, unknown>;
  content: RevisionNode[];
  /** Text nodes only */
  text?: string;
  marks?: Record<string, Record<string, unknown>>;
}

/** A format prefab of backend/src/prefabs.ts */
export interface FormatPrefab {
  id: string;
  label: string;
  description: string;
  /** Flat dotted keys of the document format */
  format: Record<string, unknown>;
}

/** The paper as the editor keeps it, per part */
export interface RevisionContent {
  title: string;
  authors: Author[];
  /** In citation order */
  references: Reference[];
  blocks: RevisionNode[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  listDocuments: () => request<DocumentMeta[]>("/api/documents"),
  getDocument: (id: string) => request<DocumentMeta>(`/api/documents/${encodeURIComponent(id)}`),
  /** `prefab`: id of a format prefab, or undefined for the default format */
  createDocument: (title: string, template: "paper" | "blank", prefab?: string) =>
    request<DocumentMeta>("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, template, prefab }),
    }),
  listPrefabs: () => request<FormatPrefab[]>("/api/prefabs"),
  /** Creates a document from a Yjs update built from an imported file (e.g. HWPX). */
  importDocument: (title: string, update: Uint8Array) =>
    request<DocumentMeta>(`/api/documents/import?title=${encodeURIComponent(title)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([new Uint8Array(update)]),
    }),
  duplicateDocument: (id: string) =>
    request<DocumentMeta>(`/api/documents/${encodeURIComponent(id)}/duplicate`, { method: "POST" }),
  deleteDocument: (id: string) =>
    request<void>(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Newest first */
  listRevisions: (id: string) => request<RevisionInfo[]>(`/api/documents/${encodeURIComponent(id)}/history`),
  getRevision: (id: string, rev: number) =>
    request<{ before: RevisionText; after: RevisionText }>(
      `/api/documents/${encodeURIComponent(id)}/history/${rev}`
    ),
  getRevisionContent: (id: string, rev: number) =>
    request<{ before: RevisionContent; after: RevisionContent }>(
      `/api/documents/${encodeURIComponent(id)}/history/${rev}/content`
    ),
  deleteRevisions: (id: string, ids: number[]) =>
    request<void>(`/api/documents/${encodeURIComponent(id)}/history`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
  /** Makes the paper what it was after `rev`, as a new revision of `user`. */
  restoreRevision: (id: string, rev: number, user: { name: string; color: string }) =>
    request<{ changed: boolean }>(`/api/documents/${encodeURIComponent(id)}/history/${rev}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(user),
    }),
  uploadImage: (file: File) =>
    request<{ url: string }>("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    }),
};
