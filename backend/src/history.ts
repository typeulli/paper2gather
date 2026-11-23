/**
 * Revision history of each paper: who changed the title, authors, references and body, and how.
 * The Yjs documents are garbage collected and can't show earlier states, so the server records the
 * states as the edits arrive. Comments (threads and their highlights in the text) and the format
 * settings are not part of it.
 *
 * A revision is one author's edits until someone else edits or the author pauses for IDLE_MS. It
 * refers to the state before and after it. States are stored per block, so a revision only adds the
 * blocks it changed:
 * - history/<id>.jsonl: states (block hashes, mostly as a change of the previous state), revisions
 * - history/<id>.blobs.jsonl: blocks and the author and reference lists, by hash
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as Y from "yjs";
import { config } from "./config.js";
import {
  LABEL_PREFIX,
  NUMBERED_KINDS,
  readElement,
  toYElement,
  walk,
  type PNode,
} from "./mcp/content.js";
import type { Reference } from "./mcp/paper.js";
import { renderBlock, type RenderContext } from "./mcp/render.js";
import { writeAtomic } from "./storage.js";
import { FIELDS } from "./template.js";

/** A pause after which the same author's edits start a new revision */
const IDLE_MS = 5 * 60_000;
/** How often the open revision is saved while it grows (closed ones are saved with the document) */
const LIVE_SAVE_MS = 30_000;
/** Longest chain of states stored as changes of the previous one */
const MAX_DELTA_DEPTH = 200;
/** Block alignment for restores compares at most this many pairs of blocks */
const MAX_ALIGN_CELLS = 1_000_000;

const HISTORY_DIR = path.join(config.dataDir, "history");
const mainPath = (id: string) => path.join(HISTORY_DIR, `${id}.jsonl`);
const blobsPath = (id: string) => path.join(HISTORY_DIR, `${id}.blobs.jsonl`);

export type RevisionAuthor = { kind: "user"; name: string; color: string } | { kind: "mcp" };

/** Transaction origin of restores; the restore becomes a revision of `author`. */
export class RestoreOrigin {
  constructor(
    readonly author: { name: string; color: string },
    readonly revision: number
  ) {}
}

interface Revision {
  id: number;
  author: RevisionAuthor;
  startedAt: number;
  endedAt: number;
  /** State ids */
  before: number;
  after: number;
  /** The revision whose result this one restored */
  restoredFrom?: number;
}

export interface RevisionInfo {
  id: number;
  author: RevisionAuthor;
  startedAt: number;
  endedAt: number;
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

/** The paper as the editor keeps it, per part (for showing it like the editor does) */
export interface RevisionContent {
  title: string;
  authors: Author[];
  /** In citation order */
  references: Reference[];
  blocks: PNode[];
}

interface StateBase {
  id: number;
  title: string | null;
  /** Blob hashes */
  authors: string;
  refOrder: string;
  refs: string;
}

/** As stored: the block hashes in full, or the change of state `base` keeping its first and last `keep` */
interface StateRecord extends StateBase {
  blocks: string[];
  base?: number;
  keep?: [number, number];
}

/** Taken but not stored yet */
interface PendingState extends StateBase {
  blocks: string[];
  /** JSON of every blob it refers to */
  blobs: Map<string, string>;
}

interface Blob {
  hash: string;
  json: string;
}

/** The state last written, which the next one is stored as a change of */
interface WrittenState {
  id: number;
  blocks: string[];
  /** Length of its chain of changes */
  depth: number;
}

function encodeState(
  state: StateBase & { blocks: string[] },
  last: WrittenState | null
): { record: StateRecord; depth: number } {
  const { blocks } = state;
  if (last && last.depth < MAX_DELTA_DEPTH) {
    const a = last.blocks;
    let prefix = 0;
    while (prefix < a.length && prefix < blocks.length && a[prefix] === blocks[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < a.length - prefix &&
      suffix < blocks.length - prefix &&
      a[a.length - 1 - suffix] === blocks[blocks.length - 1 - suffix]
    )
      suffix++;
    if (prefix + suffix > 0) {
      return {
        record: {
          ...state,
          base: last.id,
          keep: [prefix, suffix],
          blocks: blocks.slice(prefix, blocks.length - suffix),
        },
        depth: last.depth + 1,
      };
    }
  }
  return { record: { ...state }, depth: 0 };
}

interface Author {
  name?: string;
  affiliation?: string;
  email?: string;
}

/** What a restore writes */
export interface RestoreTarget {
  title: string | null;
  authors: Author[];
  refOrder: string[];
  refs: Record<string, Reference>;
  blocks: { hash: string; node: PNode }[];
}

/** JSON with sorted keys, so equal values have equal hashes */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toBlob(value: unknown): Blob {
  const json = canonical(value);
  return { hash: createHash("sha256").update(json).digest("base64url").slice(0, 22), json };
}

/** A block without comment highlights (comments aren't part of the history) */
function withoutComments(node: PNode): PNode {
  const content: PNode[] = [];
  for (const child of node.content) {
    if (child.type !== "text") {
      content.push(withoutComments(child));
      continue;
    }
    const { comment: _, ...marks } = child.marks ?? {};
    const last = content[content.length - 1];
    if (last?.type === "text" && canonical(last.marks) === canonical(marks))
      last.text += child.text ?? "";
    else content.push({ ...child, marks });
  }
  return { ...node, content };
}

const sameAuthor = (a: RevisionAuthor, b: RevisionAuthor) =>
  a.kind === "mcp" || b.kind === "mcp"
    ? a.kind === b.kind
    : a.name === b.name && a.color === b.color;

/** Pairs of equal blocks (indices into `a` and `b`) of a longest common subsequence */
function alignBlocks(a: string[], b: string[]): [number, number][] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= MAX_ALIGN_CELLS) {
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          a[start + i] === b[start + j]
            ? lcs[(i + 1) * w + j + 1] + 1
            : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
      else j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

/** In citation order; same rules as the frontend PaperStore */
function orderReferences(refOrder: string[], refs: Record<string, Reference>): Reference[] {
  const seen = new Set<string>();
  const list: Reference[] = [];
  for (const id of refOrder) {
    if (!refs[id] || seen.has(id)) continue;
    seen.add(id);
    list.push(refs[id]);
  }
  for (const [id, ref] of Object.entries(refs)) if (!seen.has(id)) list.push(ref);
  return list;
}

function renderReference(r: Reference): string {
  const volume = r.volume && `vol. ${r.volume}${r.issue ? `(${r.issue})` : ""}`;
  return `[${r.key || r.id}] ${[
    r.type,
    (r.authors ?? []).join(", "),
    r.title && `"${r.title}"`,
    r.venue,
    volume,
    r.pages && `pp. ${r.pages}`,
    r.publisher,
    r.year,
    r.doi && `doi:${r.doi}`,
    r.url,
    r.note,
  ]
    .filter(Boolean)
    .join(" · ")}`;
}

function renderText(target: RestoreTarget): RevisionText {
  const references = orderReferences(target.refOrder, target.refs);
  const keys = new Map(references.map((r) => [r.id, r.key]));
  const blocks = target.blocks.map((b) => b.node);
  // Labels of the numbered objects (frontend lib/paper/numbering.ts)
  const labels = new Map<string, string>();
  walk(blocks, (node) => {
    const kind = NUMBERED_KINDS[node.type];
    const id = node.attrs.id;
    if (!kind || typeof id !== "string" || !id) return;
    const label = node.attrs.label;
    labels.set(id, typeof label === "string" && label ? label : `${LABEL_PREFIX[kind]}:${id}`);
  });
  const ctx: RenderContext = {
    key: (id) => keys.get(id) || id,
    label: (id) => labels.get(id) ?? null,
  };
  return {
    title: target.title ?? "",
    authors: target.authors
      .map((a) => [a.name, a.affiliation, a.email].filter(Boolean).join(" · "))
      .join("\n"),
    body: blocks.map((b) => renderBlock(b, ctx)).join("\n\n"),
    references: references.map(renderReference).join("\n"),
  };
}

function contentOf(target: RestoreTarget): RevisionContent {
  return {
    title: target.title ?? "",
    authors: target.authors,
    references: orderReferences(target.refOrder, target.refs),
    blocks: target.blocks.map((b) => b.node),
  };
}

const isNotFound = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

/** Size of `file` without a line left unfinished by a crash, which is cut off */
async function completeSize(file: string): Promise<number> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r+");
  } catch (err) {
    if (isNotFound(err)) return 0;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const chunk = Buffer.alloc(64 * 1024);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const { bytesRead } = await handle.read(chunk, 0, end - start, start);
      const nl = chunk.subarray(0, bytesRead).lastIndexOf(10);
      if (nl >= 0) {
        end = start + nl + 1;
        break;
      }
      end = start;
    }
    if (end < size) await handle.truncate(end);
    return end;
  } finally {
    await handle.close();
  }
}

/** Lines of a blob file: {"h":"<22 characters>","v":…} */
const BLOB_HASH_START = '{"h":"'.length;
const BLOB_HASH_END = BLOB_HASH_START + 22;

export class History {
  /** Stored states */
  private states = new Map<number, StateRecord>();
  private readonly pending = new Map<number, PendingState>();
  private revisions = new Map<number, Revision>();
  private nextState = 1;
  private nextRevision = 1;
  /** Revision whose `after` follows the document, while its author keeps editing */
  private live: Revision | null = null;
  /** Revision considered live when the history was loaded */
  private storedLive: number | null = null;

  // Writing
  private queue: Promise<unknown> = Promise.resolve();
  private discarded = false;
  /** Blob hashes in the blob file */
  private savedHashes = new Set<string>();
  /** JSON of each revision as last written */
  private savedRevisions = new Map<number, string>();
  /** Revisions changed since they were written */
  private readonly dirty = new Set<number>();
  /** Written revisions that turned out empty */
  private dropped: number[] = [];
  private liveSavedAt = 0;
  private lastWritten: WrittenState | null = null;
  private readonly depths = new Map<number, number>();
  private blobsSize = 0;
  /** Where each blob is in the blob file, read on first use */
  private blobIndex: Map<string, [number, number]> | null = null;
  private readonly decoded = new Map<number, string[]>();

  // Recording, while attached to the live document
  private doc: Y.Doc | null = null;
  private attribute: (origin: unknown) => RevisionAuthor | null = () => null;
  private fragment!: Y.XmlFragment;
  private meta!: Y.Map<unknown>;
  private authors!: Y.Array<Author>;
  private refOrder!: Y.Array<string>;
  private refs!: Y.Map<Reference>;
  private readonly blockCache = new WeakMap<Y.XmlElement, Blob>();
  private parts: { authors?: Blob; refOrder?: Blob; refs?: Blob } = {};
  /** State of the document; valid until an edit of the recorded parts */
  private head: number | null = null;
  private headValid = false;
  /** Set by beforeTransaction for the transaction in progress */
  private txAuthor: RevisionAuthor | null = null;
  private txBefore: number | null = null;

  private constructor(readonly id: string) {}

  static async load(id: string): Promise<History> {
    const history = new History(id);
    await history.read();
    return history;
  }

  private async read(): Promise<void> {
    let text = "";
    try {
      const size = await completeSize(mainPath(this.id));
      this.blobsSize = await completeSize(blobsPath(this.id));
      if (size > 0) text = await fs.readFile(mainPath(this.id), "utf8");
    } catch (err) {
      // The paper opens without its history rather than not at all.
      console.error(`[history] ${this.id}: could not read the history`, err);
    }
    let lastRecord: number | null = null;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let record: {
        state?: StateRecord;
        rev?: Revision;
        delete?: number[];
        live?: number | null;
        next?: number;
      };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.state) {
        this.addRecord(record.state);
        lastRecord = record.state.id;
      } else if (record.rev) {
        const rev = record.rev;
        this.revisions.set(rev.id, rev);
        this.savedRevisions.set(rev.id, canonical(rev));
        // The newest revision is live unless it is a restore.
        if (rev.id + 1 >= this.nextRevision) {
          this.nextRevision = rev.id + 1;
          this.storedLive = rev.restoredFrom === undefined ? rev.id : null;
        }
      } else if (record.delete) {
        for (const id of record.delete) {
          this.revisions.delete(id);
          this.savedRevisions.delete(id);
          if (this.storedLive === id) this.storedLive = null;
        }
      } else if (record.live !== undefined) {
        this.storedLive = record.live;
        this.nextRevision = Math.max(this.nextRevision, record.next ?? 0);
      }
    }

    // A crash may have cut off lines: keep the revisions whose states are complete.
    const complete = new Map<number, boolean>();
    const isComplete = (id: number): boolean => {
      let ok = complete.get(id);
      if (ok === undefined) {
        const record = this.states.get(id);
        ok = !!record && (record.base === undefined || isComplete(record.base));
        complete.set(id, ok);
      }
      return ok;
    };
    for (const rev of [...this.revisions.values()]) {
      if (isComplete(rev.before) && isComplete(rev.after)) continue;
      this.revisions.delete(rev.id);
      this.savedRevisions.delete(rev.id);
      if (this.storedLive === rev.id) this.storedLive = null;
    }
    if (lastRecord !== null && isComplete(lastRecord)) {
      this.lastWritten = {
        id: lastRecord,
        blocks: this.blocksOf(lastRecord),
        depth: this.depths.get(lastRecord) ?? 0,
      };
    }
  }

  private addRecord(record: StateRecord): void {
    this.states.set(record.id, record);
    this.nextState = Math.max(this.nextState, record.id + 1);
    for (const hash of record.blocks) this.savedHashes.add(hash);
    this.savedHashes.add(record.authors).add(record.refOrder).add(record.refs);
    this.depths.set(
      record.id,
      record.base === undefined ? 0 : (this.depths.get(record.base) ?? 0) + 1
    );
  }

  /** Resolves when the writes so far are done. */
  settled(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch((err) => console.error(`[history] ${this.id}`, err));
    return run;
  }

  // ---------------------------------------------------------------- states

  private blocksOf(id: number): string[] {
    const pending = this.pending.get(id);
    if (pending) return pending.blocks;
    if (this.lastWritten?.id === id) return this.lastWritten.blocks;
    const cached = this.decoded.get(id);
    if (cached) return cached;
    const record = this.states.get(id);
    if (!record) throw new Error(`state ${id} is missing`);
    let blocks = record.blocks;
    if (record.base !== undefined) {
      const base = this.blocksOf(record.base);
      const [prefix, suffix] = record.keep ?? [0, 0];
      blocks = [...base.slice(0, prefix), ...record.blocks, ...base.slice(base.length - suffix)];
    }
    this.decoded.set(id, blocks);
    if (this.decoded.size > 16) this.decoded.delete(this.decoded.keys().next().value!);
    return blocks;
  }

  private stateBase(id: number): StateBase {
    const state = this.pending.get(id) ?? this.states.get(id);
    if (!state) throw new Error(`state ${id} is missing`);
    return state;
  }

  private sameState(a: number, b: number): boolean {
    if (a === b) return true;
    const x = this.stateBase(a);
    const y = this.stateBase(b);
    if (
      x.title !== y.title ||
      x.authors !== y.authors ||
      x.refOrder !== y.refOrder ||
      x.refs !== y.refs
    )
      return false;
    const p = this.blocksOf(a);
    const q = this.blocksOf(b);
    return p.length === q.length && p.every((hash, i) => hash === q[i]);
  }

  /** Reads the blobs of a state (in its order: authors, refOrder, refs, blocks). */
  private async readState(id: number): Promise<RestoreTarget> {
    const state = this.stateBase(id);
    const blocks = this.blocksOf(id);
    const blobs = await this.readBlobs(
      [state.authors, state.refOrder, state.refs, ...blocks],
      this.pending.get(id)?.blobs
    );
    return {
      title: state.title,
      authors: blobs.get(state.authors) as Author[],
      refOrder: blobs.get(state.refOrder) as string[],
      refs: blobs.get(state.refs) as Record<string, Reference>,
      blocks: blocks.map((hash) => ({ hash, node: blobs.get(hash) as PNode })),
    };
  }

  private async readBlobs(
    hashes: string[],
    known?: Map<string, string>
  ): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    const missing: string[] = [];
    for (const hash of new Set(hashes)) {
      const json = known?.get(hash);
      if (json !== undefined) out.set(hash, JSON.parse(json));
      else missing.push(hash);
    }
    if (missing.length === 0) return out;
    const index = await this.index();
    const handle = await fs.open(blobsPath(this.id), "r");
    try {
      for (const hash of missing) {
        const at = index.get(hash);
        if (!at) throw new Error(`blob ${hash} is missing`);
        const buffer = Buffer.alloc(at[1]);
        await handle.read(buffer, 0, at[1], at[0]);
        out.set(hash, (JSON.parse(buffer.toString("utf8")) as { v: unknown }).v);
      }
    } finally {
      await handle.close();
    }
    return out;
  }

  private async index(): Promise<Map<string, [number, number]>> {
    if (this.blobIndex) return this.blobIndex;
    const index = new Map<string, [number, number]>();
    let data: Buffer;
    try {
      data = await fs.readFile(blobsPath(this.id));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      data = Buffer.alloc(0);
    }
    for (let start = 0; start < data.length; ) {
      const nl = data.indexOf(10, start);
      if (nl < 0) break;
      if (nl - start > BLOB_HASH_END) {
        index.set(data.toString("latin1", start + BLOB_HASH_START, start + BLOB_HASH_END), [
          start,
          nl - start,
        ]);
      }
      start = nl + 1;
    }
    this.blobIndex = index;
    return index;
  }

  // ---------------------------------------------------------------- recording

  /** Starts recording the edits of `doc`, whose state was just loaded. */
  attach(doc: Y.Doc, attribute: (origin: unknown) => RevisionAuthor | null): void {
    this.doc = doc;
    this.attribute = attribute;
    this.fragment = doc.getXmlFragment(FIELDS.content);
    this.meta = doc.getMap(FIELDS.meta);
    this.authors = doc.getArray<Author>(FIELDS.authors);
    this.refOrder = doc.getArray<string>(FIELDS.refOrder);
    this.refs = doc.getMap<Reference>(FIELDS.refs);
    this.parts = {};
    this.live = null;
    this.head = null;
    this.headValid = false;
    doc.on("beforeTransaction", this.onBefore);
    doc.on("afterTransaction", this.onAfter);

    try {
      const live = this.storedLive === null ? undefined : this.revisions.get(this.storedLive);
      const head = this.currentState();
      // Edits saved shortly before the server stopped belong to the revision that was open.
      if (live && !this.sameState(live.after, head)) {
        live.after = head;
        this.dirty.add(live.id);
      }
      this.live = live ?? null;
    } catch (err) {
      this.recordingFailed(err);
    }
  }

  /** The history must never get in the way of editing: forget what was being recorded, go on. */
  private recordingFailed(err: unknown): void {
    console.error(`[history] ${this.id}: recording failed`, err);
    this.live = null;
    this.head = null;
    this.headValid = false;
    this.txAuthor = null;
    this.txBefore = null;
  }

  /** Stops recording; call before destroying the document, then persist(true). */
  detach(): void {
    if (!this.doc) return;
    this.currentState();
    this.closeLiveIfEmpty();
    this.storedLive = this.live?.id ?? null;
    this.live = null;
    this.doc.off("beforeTransaction", this.onBefore);
    this.doc.off("afterTransaction", this.onAfter);
    this.doc = null;
  }

  /** Revision that continues with its author's next edits */
  private liveId(): number | null {
    return this.doc ? (this.live?.id ?? null) : this.storedLive;
  }

  private readonly onBefore = (tr: Y.Transaction) => {
    try {
      this.beforeTransaction(tr);
    } catch (err) {
      this.recordingFailed(err);
    }
  };

  private readonly onAfter = (tr: Y.Transaction) => {
    try {
      this.afterTransaction(tr);
    } catch (err) {
      this.recordingFailed(err);
    }
  };

  private beforeTransaction(tr: Y.Transaction): void {
    this.txBefore = null;
    const author = this.attribute(tr.origin);
    this.txAuthor = author;
    if (!author) return;
    const live = this.live;
    const extend =
      live !== null &&
      !(tr.origin instanceof RestoreOrigin) &&
      sameAuthor(live.author, author) &&
      Date.now() - live.endedAt < IDLE_MS;
    // The state before a new revision, which also ends the live one
    if (!extend) this.txBefore = this.currentState();
  }

  private afterTransaction(tr: Y.Transaction): void {
    const before = this.txBefore;
    const author = this.txAuthor;
    this.txBefore = null;
    this.txAuthor = null;

    let recorded =
      (tr.changed as Map<unknown, Set<string | null>>).get(this.meta)?.has("title") ?? false;
    for (const type of tr.changedParentTypes.keys() as Iterable<unknown>) {
      if (type instanceof Y.XmlElement && type.parent === this.fragment)
        this.blockCache.delete(type);
      else if (type === this.authors) delete this.parts.authors;
      else if (type === this.refOrder) delete this.parts.refOrder;
      else if (type === this.refs) delete this.parts.refs;
      else if (type !== this.fragment) continue;
      recorded = true;
    }
    if (!recorded) return;
    this.headValid = false;

    const now = Date.now();
    if (before !== null && author) {
      // Its `after` is `before` (see onBefore).
      const closing = this.live;
      this.live = null;
      const after = this.currentState();
      // Changes outside the history (comment highlights) don't start a revision.
      if (this.sameState(before, after)) {
        this.live = closing;
        return;
      }
      if (closing && this.sameState(closing.before, closing.after)) this.drop(closing);
      const rev: Revision = {
        id: this.nextRevision++,
        author,
        startedAt: now,
        endedAt: now,
        before,
        after,
      };
      if (tr.origin instanceof RestoreOrigin) rev.restoredFrom = tr.origin.revision;
      this.revisions.set(rev.id, rev);
      this.dirty.add(rev.id);
      // A restore is a revision of its own.
      if (rev.restoredFrom === undefined) this.live = rev;
    } else if (this.live && author) {
      this.live.endedAt = now;
      this.dirty.add(this.live.id);
    }
  }

  private drop(rev: Revision): void {
    this.revisions.delete(rev.id);
    this.dirty.delete(rev.id);
    if (this.savedRevisions.has(rev.id)) this.dropped.push(rev.id);
  }

  private closeLiveIfEmpty(): void {
    if (this.live && this.sameState(this.live.before, this.live.after)) {
      this.drop(this.live);
      this.live = null;
    }
  }

  /** Id of the current state, taken if the document changed since */
  private currentState(): number {
    if (!this.headValid || this.head === null) {
      const id = this.takeState();
      if (this.head !== null && this.sameState(this.head, id)) this.pending.delete(id);
      else this.head = id;
      this.headValid = true;
    }
    if (this.live && this.live.after !== this.head) {
      this.live.after = this.head!;
      this.dirty.add(this.live.id);
    }
    return this.head!;
  }

  private blockBlob(el: Y.XmlElement): Blob {
    let blob = this.blockCache.get(el);
    if (!blob) {
      blob = toBlob(withoutComments(readElement(el)));
      this.blockCache.set(el, blob);
    }
    return blob;
  }

  private takeState(): number {
    const blobs = new Map<string, string>();
    const blocks: string[] = [];
    for (const child of this.fragment.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const blob = this.blockBlob(child);
      blocks.push(blob.hash);
      blobs.set(blob.hash, blob.json);
    }
    const part = (blob: Blob) => {
      blobs.set(blob.hash, blob.json);
      return blob.hash;
    };
    const title = this.meta.get("title");
    const state: PendingState = {
      id: this.nextState++,
      title: typeof title === "string" ? title : null,
      authors: part((this.parts.authors ??= toBlob(this.authors.toJSON()))),
      refOrder: part((this.parts.refOrder ??= toBlob(this.refOrder.toJSON()))),
      refs: part((this.parts.refs ??= toBlob(this.refs.toJSON()))),
      blocks,
      blobs,
    };
    this.pending.set(state.id, state);
    return state.id;
  }

  // ---------------------------------------------------------------- writing

  /** Saves the revisions changed since the last call; the live one at most every LIVE_SAVE_MS unless `final`. */
  persist(final: boolean): Promise<void> {
    return this.enqueue(() => this.write(final));
  }

  private async write(final: boolean): Promise<void> {
    if (this.discarded) return;
    const now = Date.now();
    const live = this.live;
    const liveDue =
      final || !live || !this.savedRevisions.has(live.id) || now - this.liveSavedAt >= LIVE_SAVE_MS;
    if (live && liveDue && this.doc) this.currentState();

    const blobLines: string[] = [];
    const lines: string[] = [];
    const blobIndexAdds: [string, number][] = [];
    const writeState = (id: number) => {
      const state = this.pending.get(id);
      if (!state) return;
      for (const [hash, json] of state.blobs) {
        if (this.savedHashes.has(hash)) continue;
        this.savedHashes.add(hash);
        const line = `{"h":"${hash}","v":${json}}\n`;
        blobLines.push(line);
        blobIndexAdds.push([hash, Buffer.byteLength(line)]);
      }
      const { blobs: _, ...base } = state;
      const { record, depth } = encodeState(base, this.lastWritten);
      lines.push(JSON.stringify({ state: record }));
      this.pending.delete(id);
      this.states.set(id, record);
      this.depths.set(id, depth);
      this.lastWritten = { id, blocks: state.blocks, depth };
    };

    if (this.dropped.length) {
      lines.push(JSON.stringify({ delete: this.dropped }));
      this.dropped = [];
    }
    const due = [...this.dirty].sort((a, b) => a - b);
    for (const id of due) {
      const rev = this.revisions.get(id);
      if (!rev) {
        this.dirty.delete(id);
        continue;
      }
      if (rev === live && !liveDue) continue;
      this.dirty.delete(id);
      // An empty live revision is written once it changes something.
      if (this.sameState(rev.before, rev.after)) continue;
      writeState(rev.before);
      writeState(rev.after);
      const json = canonical(rev);
      if (this.savedRevisions.get(id) === json) continue;
      lines.push(JSON.stringify({ rev }));
      this.savedRevisions.set(id, json);
      if (rev === live) this.liveSavedAt = now;
    }
    this.forgetUnused();
    if (lines.length === 0) return;

    await fs.mkdir(HISTORY_DIR, { recursive: true });
    if (blobLines.length) {
      await fs.appendFile(blobsPath(this.id), blobLines.join(""));
      let offset = this.blobsSize;
      for (const [hash, length] of blobIndexAdds) {
        this.blobIndex?.set(hash, [offset, length - 1]);
        offset += length;
      }
      this.blobsSize = offset;
    }
    await fs.appendFile(mainPath(this.id), `${lines.join("\n")}\n`);
  }

  /** Drops taken states no revision needs. */
  private forgetUnused(): void {
    const used = new Set<number>();
    if (this.head !== null) used.add(this.head);
    for (const id of this.dirty) {
      const rev = this.revisions.get(id);
      if (rev) used.add(rev.before).add(rev.after);
    }
    if (this.live) used.add(this.live.before).add(this.live.after);
    for (const id of this.pending.keys()) if (!used.has(id)) this.pending.delete(id);
  }

  /** Stops all writes (the document is being deleted). */
  discard(): void {
    this.discarded = true;
  }

  // ---------------------------------------------------------------- reading and changing the history

  /** Newest first */
  list(): RevisionInfo[] {
    if (this.live && this.doc) this.currentState();
    const list: RevisionInfo[] = [];
    for (const rev of this.revisions.values()) {
      const live = rev === this.live;
      if (live && this.sameState(rev.before, rev.after)) continue;
      list.push({
        id: rev.id,
        author: rev.author,
        startedAt: rev.startedAt,
        endedAt: rev.endedAt,
        ...(rev.restoredFrom !== undefined && { restoredFrom: rev.restoredFrom }),
        live,
      });
    }
    return list.sort((a, b) => b.id - a.id);
  }

  /** Revision `id` with the states up to date; in a queued task, so that they stay while being read */
  private revision(id: number): Revision | null {
    if (this.live?.id === id && this.doc) this.currentState();
    return this.revisions.get(id) ?? null;
  }

  /** The paper before and after revision `id`; null if there is no such revision */
  texts(id: number): Promise<{ before: RevisionText; after: RevisionText } | null> {
    return this.enqueue(async () => {
      const rev = this.revision(id);
      if (!rev) return null;
      const { before, after } = rev;
      return {
        before: renderText(await this.readState(before)),
        after: renderText(await this.readState(after)),
      };
    });
  }

  /** The paper before and after revision `id` as content; null if there is no such revision */
  contents(id: number): Promise<{ before: RevisionContent; after: RevisionContent } | null> {
    return this.enqueue(async () => {
      const rev = this.revision(id);
      if (!rev) return null;
      const { before, after } = rev;
      return {
        before: contentOf(await this.readState(before)),
        after: contentOf(await this.readState(after)),
      };
    });
  }

  /** The state after revision `id`; null if there is no such revision */
  restoreTarget(id: number): Promise<RestoreTarget | null> {
    return this.enqueue(async () => {
      const rev = this.revision(id);
      return rev && this.readState(rev.after);
    });
  }

  /**
   * Makes the recorded parts of the attached document equal to `target`, as a transaction of
   * `origin`. Blocks equal to the target's are kept (with their comment highlights). Returns
   * whether anything changed.
   */
  restore(target: RestoreTarget, origin: RestoreOrigin): boolean {
    const doc = this.doc;
    if (!doc) throw new Error("the history is not attached to its document");
    const elements = this.fragment
      .toArray()
      .filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
    const current = elements.map((el) => this.blockBlob(el).hash);
    const wanted = target.blocks.map((b) => b.hash);
    const pairs = alignBlocks(current, wanted);
    pairs.push([current.length, wanted.length]);
    let changed = false;
    doc.transact(() => {
      const title = this.meta.get("title");
      if ((typeof title === "string" ? title : null) !== target.title) {
        if (target.title === null) this.meta.delete("title");
        else this.meta.set("title", target.title);
        changed = true;
      }
      const replaceArray = <T>(array: Y.Array<T>, items: T[]) => {
        if (canonical(array.toJSON()) === canonical(items)) return;
        array.delete(0, array.length);
        array.insert(0, items);
        changed = true;
      };
      replaceArray(this.authors, target.authors);
      replaceArray(this.refOrder, target.refOrder);
      for (const key of [...this.refs.keys()]) {
        if (!(key in target.refs)) {
          this.refs.delete(key);
          changed = true;
        }
      }
      for (const [key, ref] of Object.entries(target.refs)) {
        if (canonical(this.refs.get(key)) === canonical(ref)) continue;
        this.refs.set(key, ref);
        changed = true;
      }
      // Replace the blocks between equal ones, from the end so earlier positions stay valid.
      for (let k = pairs.length - 1; k >= 0; k--) {
        const [a1, b1] = pairs[k];
        const [a0, b0] = k > 0 ? [pairs[k - 1][0] + 1, pairs[k - 1][1] + 1] : [0, 0];
        if (a0 === a1 && b0 === b1) continue;
        for (let i = a1 - 1; i >= a0; i--)
          this.fragment.delete(this.fragment.toArray().indexOf(elements[i]), 1);
        const at =
          a1 < elements.length
            ? this.fragment.toArray().indexOf(elements[a1])
            : this.fragment.length;
        this.fragment.insert(
          at,
          target.blocks.slice(b0, b1).map((b) => toYElement(b.node))
        );
        changed = true;
      }
    }, origin);
    return changed;
  }

  /** Deletes revisions and rewrites the files without what only they needed. */
  deleteRevisions(ids: number[]): Promise<void> {
    for (const id of ids) {
      const rev = this.revisions.get(id);
      if (!rev) continue;
      this.revisions.delete(id);
      this.dirty.delete(id);
      if (rev === this.live) this.live = null;
      if (id === this.storedLive) this.storedLive = null;
    }
    if (this.live && this.doc) this.currentState();
    return this.enqueue(() => this.compact());
  }

  private async compact(): Promise<void> {
    if (this.discarded) return;
    // Dropped revisions are left out; ones dropped while this runs are deleted by the next write.
    this.dropped = [];
    const revisions = [...this.revisions.values()].sort((a, b) => a.id - b.id);
    const keep = new Set<number>();
    for (const rev of revisions) keep.add(rev.before).add(rev.after);
    if (this.head !== null) keep.add(this.head);
    const stored = [...keep].filter((id) => !this.pending.has(id)).sort((a, b) => a - b);

    // Every blob the kept states refer to
    const index = await this.index();
    const hashes = new Set<string>();
    for (const id of stored) {
      const state = this.stateBase(id);
      hashes.add(state.authors).add(state.refOrder).add(state.refs);
      for (const hash of this.blocksOf(id)) hashes.add(hash);
    }
    const blobData: Buffer[] = [];
    const newIndex = new Map<string, [number, number]>();
    let offset = 0;
    if (hashes.size) {
      const handle = await fs.open(blobsPath(this.id), "r");
      try {
        for (const hash of hashes) {
          const at = index.get(hash);
          if (!at) throw new Error(`blob ${hash} is missing`);
          const buffer = Buffer.alloc(at[1] + 1);
          await handle.read(buffer, 0, at[1], at[0]);
          buffer[at[1]] = 10;
          blobData.push(buffer);
          newIndex.set(hash, [offset, at[1]]);
          offset += buffer.length;
        }
      } finally {
        await handle.close();
      }
    }

    const records = new Map<number, StateRecord>();
    const depths = new Map<number, number>();
    const lines: string[] = [];
    let last: WrittenState | null = null;
    for (const id of stored) {
      const { title, authors, refOrder, refs } = this.stateBase(id);
      const blocks = this.blocksOf(id);
      const { record, depth } = encodeState({ id, title, authors, refOrder, refs, blocks }, last);
      records.set(id, record);
      depths.set(id, depth);
      lines.push(JSON.stringify({ state: record }));
      last = { id, blocks, depth };
    }
    // Revisions whose states are written, the others are written later like new ones.
    const written = new Map<number, string>();
    for (const rev of revisions) {
      if (!records.has(rev.before) || !records.has(rev.after)) {
        this.dirty.add(rev.id);
        continue;
      }
      lines.push(JSON.stringify({ rev }));
      written.set(rev.id, canonical(rev));
    }
    // Ids aren't reused, also for revisions deleted from the end.
    lines.push(JSON.stringify({ live: this.liveId(), next: this.nextRevision }));

    await fs.mkdir(HISTORY_DIR, { recursive: true });
    await writeAtomic(blobsPath(this.id), Buffer.concat(blobData));
    await writeAtomic(mainPath(this.id), `${lines.join("\n")}\n`);

    this.states = records;
    this.depths.clear();
    for (const [id, depth] of depths) this.depths.set(id, depth);
    this.decoded.clear();
    this.savedHashes = new Set(hashes);
    this.savedRevisions = written;
    this.blobIndex = newIndex;
    this.blobsSize = offset;
    this.lastWritten = last;
  }
}

// ------------------------------------------------------------------ one instance per paper

const open = new Map<string, { history: Promise<History>; refs: number }>();
/** Writes of instances no longer open, which a new instance waits for */
const closing = new Map<string, Promise<void>>();

export async function openHistory(id: string): Promise<History> {
  let entry = open.get(id);
  if (!entry) {
    const previous = closing.get(id) ?? Promise.resolve();
    entry = { history: previous.then(() => History.load(id)), refs: 0 };
    open.set(id, entry);
  }
  entry.refs++;
  try {
    return await entry.history;
  } catch (err) {
    if (--entry.refs === 0 && open.get(id) === entry) open.delete(id);
    throw err;
  }
}

export function closeHistory(history: History): void {
  const entry = open.get(history.id);
  if (!entry || --entry.refs > 0) return;
  open.delete(history.id);
  const settled = history.settled();
  closing.set(history.id, settled);
  void settled.then(() => {
    if (closing.get(history.id) === settled) closing.delete(history.id);
  });
}

export async function withHistory<T>(
  id: string,
  fn: (history: History) => T | Promise<T>
): Promise<T> {
  const history = await openHistory(id);
  try {
    return await fn(history);
  } finally {
    closeHistory(history);
  }
}

/** Deletes the history of a deleted paper. */
export async function deleteHistory(id: string): Promise<void> {
  const entry = open.get(id);
  const history = entry && (await entry.history.catch(() => null));
  history?.discard();
  await history?.settled();
  await closing.get(id);
  await Promise.all([fs.rm(mainPath(id), { force: true }), fs.rm(blobsPath(id), { force: true })]);
}
