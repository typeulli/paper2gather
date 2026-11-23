import * as Y from "yjs";
import { defaultFormat, readFormat, type PaperFormat } from "./format";
import { withLaterFields } from "./references";
import type { Author, CommentMessage, CommentThread, Reference } from "./types";

/**
 * Shared type names inside every paper Y.Doc.
 * Must stay in sync with backend/src/template.ts (the MCP server reads and writes all of them).
 */
export const FIELDS = {
  content: "content", // Y.XmlFragment bound to TipTap
  meta: "meta", // Y.Map { title, settings (legacy: seeds the default format) }
  authors: "authors", // Y.Array<Author>
  refOrder: "refOrder", // Y.Array<string>: reference ids, order = citation number
  refs: "refs", // Y.Map<Reference>
  comments: "comments", // Y.Map<Y.Map>: thread fields + messages Y.Array<CommentMessage>
  format: "format", // Y.Map: flat dotted keys ("styles.body.size") overriding the default format
} as const;

/** A lazily computed, cached view of some Yjs state that React can subscribe to. */
export class Slice<T> {
  private value: { v: T } | null = null;
  private listeners = new Set<() => void>();

  constructor(private compute: () => T) {}

  get = (): T => {
    if (!this.value) this.value = { v: this.compute() };
    return this.value.v;
  };

  invalidate(): void {
    this.value = null;
    this.listeners.forEach((l) => l());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export interface ReferencesSnapshot {
  list: Reference[];
  /** reference id -> 1-based citation number */
  numbers: Map<string, number>;
  byId: Map<string, Reference>;
}

export interface MetaSnapshot {
  title: string;
}

export class PaperStore {
  readonly meta: Y.Map<unknown>;
  readonly authorsArray: Y.Array<Author>;
  readonly refOrder: Y.Array<string>;
  readonly refsMap: Y.Map<Reference>;
  readonly commentsMap: Y.Map<Y.Map<unknown>>;
  readonly formatMap: Y.Map<unknown>;

  readonly metaSlice: Slice<MetaSnapshot>;
  readonly authorsSlice: Slice<Author[]>;
  readonly referencesSlice: Slice<ReferencesSnapshot>;
  readonly commentsSlice: Slice<CommentThread[]>;
  readonly formatSlice: Slice<PaperFormat>;

  private cleanups: (() => void)[] = [];

  constructor(readonly doc: Y.Doc) {
    this.meta = doc.getMap(FIELDS.meta);
    this.authorsArray = doc.getArray<Author>(FIELDS.authors);
    this.refOrder = doc.getArray<string>(FIELDS.refOrder);
    this.refsMap = doc.getMap<Reference>(FIELDS.refs);
    this.commentsMap = doc.getMap<Y.Map<unknown>>(FIELDS.comments);
    this.formatMap = doc.getMap(FIELDS.format);

    this.metaSlice = new Slice(() => ({ title: (this.meta.get("title") as string | undefined) ?? "" }));
    this.authorsSlice = new Slice(() => this.authorsArray.toArray());
    this.referencesSlice = new Slice(() => this.computeReferences());
    this.commentsSlice = new Slice(() => this.computeComments());
    this.formatSlice = new Slice(() => this.computeFormat());

    this.watch(this.meta, this.metaSlice);
    this.watch(this.authorsArray, this.authorsSlice);
    this.watch(this.refOrder, this.referencesSlice);
    this.watch(this.refsMap, this.referencesSlice);
    this.watch(this.commentsMap, this.commentsSlice);
    this.watch(this.formatMap, this.formatSlice);
    // Only the legacy settings key affects the format; title edits must not invalidate it.
    const onLegacySettings = (event: Y.YMapEvent<unknown>) => {
      if (event.keysChanged.has("settings")) this.formatSlice.invalidate();
    };
    this.meta.observe(onLegacySettings);
    this.cleanups.push(() => this.meta.unobserve(onLegacySettings));
  }

  private watch(
    type: { observeDeep(f: () => void): void; unobserveDeep(f: () => void): void },
    slice: Slice<unknown>
  ) {
    const handler = () => slice.invalidate();
    type.observeDeep(handler);
    this.cleanups.push(() => type.unobserveDeep(handler));
  }

  destroy(): void {
    this.cleanups.forEach((c) => c());
    this.cleanups = [];
  }

  // ---------------------------------------------------------------- meta

  setTitle(title: string): void {
    this.meta.set("title", title);
  }

  // -------------------------------------------------------------- format

  private computeFormat(): PaperFormat {
    const legacy = (this.meta.get("settings") as { labelLanguage?: unknown; equationNumbering?: unknown }) ?? {};
    const base = defaultFormat(
      legacy.labelLanguage === "ko" ? "ko" : "en",
      legacy.equationNumbering === "section" ? "section" : "global"
    );
    return readFormat(base, this.formatMap.entries());
  }

  /** `path` is a dotted path into PaperFormat, e.g. "styles.body.size" or "figure.position". */
  setFormatValue(path: string, value: unknown): void {
    this.formatMap.set(path, value);
  }

  setFormatValues(values: Record<string, unknown>): void {
    this.doc.transact(() => {
      for (const [path, value] of Object.entries(values)) this.formatMap.set(path, value);
    });
  }

  /** Replaces the whole document format by the default with `values` over it (a format prefab). */
  replaceFormat(values: Record<string, unknown>): void {
    this.doc.transact(() => {
      for (const key of [...this.formatMap.keys()]) {
        if (!Object.hasOwn(values, key)) this.formatMap.delete(key);
      }
      for (const [path, value] of Object.entries(values)) {
        if (this.formatMap.get(path) !== value) this.formatMap.set(path, value);
      }
    });
  }

  /** Drops overrides under `prefix` (e.g. "styles.body"), restoring the defaults. */
  resetFormat(prefix: string): void {
    this.doc.transact(() => {
      for (const key of [...this.formatMap.keys()]) {
        if (key === prefix || key.startsWith(`${prefix}.`)) this.formatMap.delete(key);
      }
    });
  }

  // ------------------------------------------------------------- authors

  addAuthor(author: Author): void {
    this.authorsArray.push([author]);
  }

  updateAuthor(index: number, author: Author): void {
    this.doc.transact(() => {
      this.authorsArray.delete(index, 1);
      this.authorsArray.insert(index, [author]);
    });
  }

  removeAuthor(index: number): void {
    this.authorsArray.delete(index, 1);
  }

  moveAuthor(from: number, to: number): void {
    if (from === to) return;
    const author = this.authorsArray.get(from);
    this.doc.transact(() => {
      this.authorsArray.delete(from, 1);
      this.authorsArray.insert(to, [author]);
    });
  }

  // ---------------------------------------------------------- references

  private computeReferences(): ReferencesSnapshot {
    const seen = new Set<string>();
    const list: Reference[] = [];
    // Concurrent moves can leave duplicate ids in the order; first occurrence wins.
    for (const id of this.refOrder.toArray()) {
      const ref = this.refsMap.get(id);
      if (!ref || seen.has(id)) continue;
      seen.add(id);
      list.push(withLaterFields(ref));
    }
    // References whose order entry was lost go to the end.
    this.refsMap.forEach((ref, id) => {
      if (!seen.has(id)) list.push(withLaterFields(ref));
    });
    const numbers = new Map(list.map((r, i) => [r.id, i + 1]));
    const byId = new Map(list.map((r) => [r.id, r]));
    return { list, numbers, byId };
  }

  addReferences(refs: Reference[]): void {
    if (refs.length === 0) return;
    this.doc.transact(() => {
      for (const ref of refs) this.refsMap.set(ref.id, ref);
      this.refOrder.push(refs.map((r) => r.id));
    });
  }

  updateReference(ref: Reference): void {
    this.refsMap.set(ref.id, ref);
  }

  removeReference(id: string): void {
    this.doc.transact(() => {
      this.refsMap.delete(id);
      this.deleteFromOrder(id);
    });
  }

  private deleteFromOrder(id: string): void {
    const raw = this.refOrder.toArray();
    for (let i = raw.length - 1; i >= 0; i--) {
      if (raw[i] === id) this.refOrder.delete(i, 1);
    }
  }

  /**
   * Moves a reference within the visible order using minimal Yjs operations,
   * so concurrent moves by different users merge reasonably.
   */
  moveReference(id: string, toIndex: number): void {
    const order = this.referencesSlice.get().list.map((r) => r.id);
    const from = order.indexOf(id);
    if (from < 0 || from === toIndex) return;
    order.splice(from, 1);
    order.splice(toIndex, 0, id);
    const next = order[toIndex + 1];
    this.doc.transact(() => {
      this.deleteFromOrder(id);
      const raw = this.refOrder.toArray();
      const at = next ? raw.indexOf(next) : -1;
      if (at >= 0) this.refOrder.insert(at, [id]);
      else this.refOrder.push([id]);
    });
  }

  setReferenceOrder(ids: string[]): void {
    this.doc.transact(() => {
      this.refOrder.delete(0, this.refOrder.length);
      this.refOrder.insert(0, ids);
    });
  }

  // ------------------------------------------------------------ comments

  private computeComments(): CommentThread[] {
    const threads: CommentThread[] = [];
    this.commentsMap.forEach((thread, id) => {
      const messages = thread.get("messages") as Y.Array<CommentMessage> | undefined;
      threads.push({
        id,
        quote: (thread.get("quote") as string) ?? "",
        resolved: Boolean(thread.get("resolved")),
        createdAt: (thread.get("createdAt") as number) ?? 0,
        messages: messages?.toArray() ?? [],
      });
    });
    return threads.sort((a, b) => a.createdAt - b.createdAt);
  }

  addThread(id: string, quote: string, first: CommentMessage): void {
    const thread = new Y.Map<unknown>();
    thread.set("quote", quote);
    thread.set("resolved", false);
    thread.set("createdAt", first.createdAt);
    const messages = new Y.Array<CommentMessage>();
    messages.push([first]);
    thread.set("messages", messages);
    this.commentsMap.set(id, thread);
  }

  replyToThread(id: string, message: CommentMessage): void {
    const messages = this.commentsMap.get(id)?.get("messages") as Y.Array<CommentMessage> | undefined;
    messages?.push([message]);
  }

  setThreadResolved(id: string, resolved: boolean): void {
    this.commentsMap.get(id)?.set("resolved", resolved);
  }

  deleteThread(id: string): void {
    this.commentsMap.delete(id);
  }
}
