import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export interface DocumentMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const DOCS_DIR = path.join(config.dataDir, "docs");
export const UPLOADS_DIR = path.join(config.dataDir, "uploads");

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

const statePath = (id: string) => path.join(DOCS_DIR, `${id}.bin`);
const metaPath = (id: string) => path.join(DOCS_DIR, `${id}.json`);

export async function initStorage(): Promise<void> {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

/** Write to a temp file first and rename, so a crash never leaves a half-written file. */
export async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function listDocuments(): Promise<DocumentMeta[]> {
  const files = await fs.readdir(DOCS_DIR);
  const metas = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map((f) => getMeta(f.slice(0, -".json".length)))
  );
  return metas
    .filter((m): m is DocumentMeta => m !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getMeta(id: string): Promise<DocumentMeta | null> {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(metaPath(id), "utf8")) as DocumentMeta;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function saveMeta(meta: DocumentMeta): Promise<void> {
  await writeAtomic(metaPath(meta.id), JSON.stringify(meta, null, 2));
}

export async function loadState(id: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fs.readFile(statePath(id)));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function saveState(id: string, state: Uint8Array): Promise<void> {
  await writeAtomic(statePath(id), state);
}

export async function deleteDocumentFiles(id: string): Promise<void> {
  await Promise.all([
    fs.rm(statePath(id), { force: true }),
    fs.rm(metaPath(id), { force: true }),
  ]);
}
