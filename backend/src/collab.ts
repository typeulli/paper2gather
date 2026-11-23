/**
 * Yjs collaboration server compatible with the `y-websocket` client protocol.
 * Documents are loaded lazily from storage, persisted with a debounce and
 * unloaded once the last client disconnects.
 */
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { WebSocket } from "ws";
import { config } from "./config.js";
import {
  closeHistory,
  openHistory,
  RestoreOrigin,
  type History,
  type RevisionAuthor,
} from "./history.js";
import { ORIGIN as MCP_ORIGIN } from "./mcp/paper.js";
import { getMeta, loadState, saveMeta, saveState } from "./storage.js";
import { FIELDS } from "./template.js";

const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;

const PING_INTERVAL_MS = 30_000;

/**
 * Maps where @tiptap/y-tiptap (>= 3.0.10) records how positions moved on structural edits and
 * undos. It never removes the records, and every undo copies the earlier ones into a new record,
 * so a ~50 KB paper grew to 27 MB. They only place cursors and undo selections of live editing
 * sessions, so the server drops old ones.
 */
const MIGRATIONS_PREFIX = "__tiptap_position_migrations:";
/** Records first seen less than this long ago are kept while the document is open. */
const MIGRATIONS_MAX_AGE_MS = 10 * 60_000;

/** Close codes in the 4400-4499 range make the y-websocket client stop reconnecting. */
export const CLOSE_NOT_FOUND = 4404;

class SharedDoc extends Y.Doc {
  readonly name: string;
  readonly conns = new Map<WebSocket, Set<number>>();
  readonly awareness: awarenessProtocol.Awareness;
  destroyed = false;
  /** Server-side operations in progress (withDoc); the document stays loaded while there are any. */
  holds = 0;
  /** Set when the document was deleted; pending saves must not recreate it. */
  private discarded = false;
  history!: History;

  private saveTimer: NodeJS.Timeout | null = null;
  private firstDirtyAt: number | null = null;
  private saving: Promise<void> = Promise.resolve();
  /** When each position migration record (map name + key) was first seen */
  private readonly migrationsSeen = new Map<string, number>();

  constructor(name: string) {
    super({ gc: true });
    this.name = name;
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    this.awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown
      ) => {
        const changed = added.concat(updated, removed);
        const controlled = origin instanceof WebSocket ? this.conns.get(origin) : undefined;
        if (controlled) {
          added.forEach((id) => controlled.add(id));
          removed.forEach((id) => controlled.delete(id));
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
        );
        this.broadcast(encoding.toUint8Array(encoder));
      }
    );
  }

  /** Must be registered after the persisted state has been applied. */
  startTracking(): void {
    this.on("update", (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
      this.scheduleSave();
    });
  }

  /** Changed since the last save started */
  get dirty(): boolean {
    return this.firstDirtyAt !== null;
  }

  /** Resolves when the current save (if any) has finished. */
  settled(): Promise<void> {
    return this.saving;
  }

  broadcast(message: Uint8Array): void {
    this.conns.forEach((_, conn) => send(this, conn, message));
  }

  /** Who made the changes of a transaction, for the history; null for the server's own changes */
  readonly authorOf = (origin: unknown): RevisionAuthor | null => {
    if (origin === MCP_ORIGIN) return { kind: "mcp" };
    if (origin instanceof RestoreOrigin) return { kind: "user", ...origin.author };
    if (!(origin instanceof WebSocket)) return null;
    // The name and color the editor shows in its awareness state (CollaborationCaret)
    for (const id of this.conns.get(origin) ?? []) {
      const user = (
        this.awareness.getStates().get(id) as { user?: { name?: unknown; color?: unknown } }
      )?.user;
      if (typeof user?.name === "string" && user.name) {
        return {
          kind: "user",
          name: user.name,
          color: typeof user.color === "string" ? user.color : "",
        };
      }
    }
    return { kind: "user", name: "", color: "" };
  };

  /** Deletes the position migration records first seen at least `maxAgeMs` ago. */
  pruneMigrations(maxAgeMs: number): void {
    const now = Date.now();
    const stale: { map: Y.Map<unknown>; key: string; id: string }[] = [];
    for (const name of [...this.share.keys()]) {
      if (!name.startsWith(MIGRATIONS_PREFIX)) continue;
      const map = this.getMap(name);
      for (const key of map.keys()) {
        const id = `${name}\n${key}`;
        let seen = this.migrationsSeen.get(id);
        if (seen === undefined) this.migrationsSeen.set(id, (seen = now));
        if (now - seen >= maxAgeMs) stale.push({ map, key, id });
      }
    }
    if (stale.length === 0) return;
    this.transact(() => stale.forEach(({ map, key }) => map.delete(key)));
    stale.forEach(({ id }) => this.migrationsSeen.delete(id));
  }

  /**
   * Removes empty text runs next to other inline content, which MCP text edits used to leave
   * (see removeIfEmpty in mcp/paper.ts): the editor refuses most edits while there is one.
   */
  removeEmptyTextRuns(): void {
    const empty: Y.XmlText[] = [];
    const visit = (children: (Y.XmlElement | Y.XmlText | Y.XmlHook)[]) => {
      for (const child of children) {
        if (child instanceof Y.XmlElement) visit(child.toArray());
        else if (child instanceof Y.XmlText && child.length === 0 && children.length > 1)
          empty.push(child);
      }
    };
    visit(this.getXmlFragment(FIELDS.content).toArray());
    if (empty.length === 0) return;
    this.transact(() =>
      empty.forEach((text) => {
        const parent = text.parent as Y.XmlElement;
        parent.delete(parent.toArray().indexOf(text), 1);
      })
    );
  }

  private scheduleSave(): void {
    const now = Date.now();
    this.firstDirtyAt ??= now;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const wait = Math.min(
      config.saveDebounceMs,
      Math.max(0, this.firstDirtyAt + config.saveMaxWaitMs - now)
    );
    this.saveTimer = setTimeout(() => {
      // Its update schedules another save, which the flush right after cancels.
      this.pruneMigrations(MIGRATIONS_MAX_AGE_MS);
      void this.flush();
    }, wait);
  }

  /** Persist the current state. Saves are serialized per document. `final` also saves the open revision. */
  flush(final = false): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.firstDirtyAt = null;
    this.saving = this.saving
      .then(async () => {
        if (this.discarded) return;
        await saveState(this.name, Y.encodeStateAsUpdate(this));
        const meta = await getMeta(this.name);
        if (meta) {
          const title = this.getMap(FIELDS.meta).get("title");
          await saveMeta({
            ...meta,
            title: typeof title === "string" && title.trim() ? title : meta.title,
            updatedAt: new Date().toISOString(),
          });
        }
        // The history logs its own failures; they don't fail the save.
        await this.history.persist(final).catch(() => undefined);
      })
      .catch((err) => console.error(`[collab] failed to save ${this.name}`, err));
    return this.saving;
  }

  /** Drop pending saves and wait for an in-flight one to settle. */
  discard(): Promise<void> {
    this.discarded = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return this.saving;
  }
}

const docs = new Map<string, Promise<SharedDoc>>();

async function loadDoc(name: string): Promise<SharedDoc> {
  const doc = new SharedDoc(name);
  const history = await openHistory(name);
  try {
    const state = await loadState(name);
    if (state) Y.applyUpdate(doc, state);
  } catch (err) {
    closeHistory(history);
    throw err;
  }
  doc.history = history;
  history.attach(doc, doc.authorOf);
  doc.startTracking();
  // Records of earlier sessions; deleting them schedules a save of the smaller state.
  doc.pruneMigrations(0);
  doc.removeEmptyTextRuns();
  return doc;
}

function getDoc(name: string): Promise<SharedDoc> {
  let doc = docs.get(name);
  if (!doc) {
    doc = loadDoc(name);
    docs.set(name, doc);
    doc.catch(() => docs.delete(name));
  }
  return doc;
}

function send(doc: SharedDoc, conn: WebSocket, message: Uint8Array): void {
  if (conn.readyState !== WebSocket.OPEN && conn.readyState !== WebSocket.CONNECTING) {
    closeConn(doc, conn);
    return;
  }
  conn.send(message, (err) => {
    if (err) closeConn(doc, conn);
  });
}

function closeConn(doc: SharedDoc, conn: WebSocket): void {
  const controlled = doc.conns.get(conn);
  if (controlled) {
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlled), null);
    if (doc.conns.size === 0) void unloadDoc(doc);
  }
  if (conn.readyState === WebSocket.OPEN || conn.readyState === WebSocket.CONNECTING) {
    conn.close();
  }
}

async function unloadDoc(doc: SharedDoc, save = true): Promise<void> {
  await (save ? doc.flush(true) : doc.settled());
  // Someone may have reconnected while we were saving.
  if (doc.conns.size > 0 || doc.holds > 0 || doc.destroyed) return;
  doc.destroyed = true;
  docs.delete(doc.name);
  doc.history.detach();
  void doc.history.persist(true);
  closeHistory(doc.history);
  doc.destroy();
}

function handleMessage(doc: SharedDoc, conn: WebSocket, message: Uint8Array): void {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case messageSync: {
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        // Only reply when there is content besides the message type.
        if (encoding.length(encoder) > 1) send(doc, conn, encoding.toUint8Array(encoder));
        break;
      }
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        );
        break;
      }
      case messageQueryAwareness: {
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            doc.awareness,
            Array.from(doc.awareness.getStates().keys())
          )
        );
        send(doc, conn, encoding.toUint8Array(encoder));
        break;
      }
      default:
        console.warn(`[collab] unknown message type ${messageType}`);
    }
  } catch (err) {
    console.error("[collab] failed to handle message", err);
  }
}

export async function setupConnection(conn: WebSocket, docName: string): Promise<void> {
  conn.binaryType = "arraybuffer";

  // Buffer messages that arrive while the document is being loaded.
  const pending: Uint8Array[] = [];
  let doc: SharedDoc | null = null;
  conn.on("message", (data: ArrayBuffer) => {
    const message = new Uint8Array(data);
    if (doc) handleMessage(doc, conn, message);
    else pending.push(message);
  });

  if (!(await getMeta(docName))) {
    conn.close(CLOSE_NOT_FOUND, "document not found");
    return;
  }

  let loaded = await getDoc(docName);
  // The doc might have been unloaded between resolving and attaching.
  while (loaded.destroyed) loaded = await getDoc(docName);
  if (conn.readyState !== WebSocket.OPEN) return;

  doc = loaded;
  doc.conns.set(conn, new Set());

  let pongReceived = true;
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      closeConn(loaded, conn);
      clearInterval(pingInterval);
      return;
    }
    pongReceived = false;
    try {
      conn.ping();
    } catch {
      closeConn(loaded, conn);
      clearInterval(pingInterval);
    }
  }, PING_INTERVAL_MS);
  conn.on("pong", () => {
    pongReceived = true;
  });
  conn.on("close", () => {
    closeConn(loaded, conn);
    clearInterval(pingInterval);
  });

  // Sync step 1 + current awareness states.
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(doc, conn, encoding.toUint8Array(encoder));
    const states = doc.awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, messageAwareness);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(states.keys()))
      );
      send(doc, conn, encoding.toUint8Array(awarenessEncoder));
    }
  }

  for (const message of pending.splice(0)) handleMessage(doc, conn, message);
}

/**
 * Runs `fn` on the live document, loading it if needed (the caller checks that it exists). Changes
 * made by `fn` reach connected clients like theirs and are saved before this resolves.
 */
export async function withDoc<T>(name: string, fn: (doc: Y.Doc) => T): Promise<T> {
  let doc = await getDoc(name);
  while (doc.destroyed) doc = await getDoc(name);
  doc.holds++;
  let changed = false;
  const onUpdate = () => {
    changed = true;
  };
  doc.on("update", onUpdate);
  try {
    const result = fn(doc);
    doc.off("update", onUpdate);
    if (changed) await doc.flush();
    return result;
  } finally {
    doc.off("update", onUpdate);
    doc.holds--;
    // Loaded only for this operation: unload without touching the saved state if nothing changed.
    if (doc.conns.size === 0 && doc.holds === 0) void unloadDoc(doc, doc.dirty);
  }
}

/** Returns the latest state, preferring the in-memory version when the document is open. */
export async function readDocState(name: string): Promise<Uint8Array | null> {
  const open = docs.get(name);
  if (open) {
    const doc = await open;
    if (!doc.destroyed) return Y.encodeStateAsUpdate(doc);
  }
  return loadState(name);
}

/** Disconnects every client of a document and drops it from memory without saving. */
export async function evictDoc(name: string): Promise<void> {
  const open = docs.get(name);
  if (!open) return;
  docs.delete(name);
  const doc = await open;
  doc.destroyed = true;
  await doc.discard();
  for (const conn of Array.from(doc.conns.keys())) {
    doc.conns.delete(conn);
    conn.close(CLOSE_NOT_FOUND, "document deleted");
  }
  doc.history.detach();
  closeHistory(doc.history);
  doc.destroy();
}

export async function flushAll(): Promise<void> {
  const all = await Promise.allSettled(Array.from(docs.values()));
  await Promise.all(
    all.flatMap((r) =>
      r.status === "fulfilled" && !r.value.destroyed ? [r.value.flush(true)] : []
    )
  );
}

/**
 * Makes the paper what it was after revision `revision` of its history, as a new revision of
 * `author`. Returns whether anything changed; null when there is no such revision.
 */
export async function restoreRevision(
  name: string,
  revision: number,
  author: { name: string; color: string }
): Promise<boolean | null> {
  const history = await openHistory(name);
  try {
    const target = await history.restoreTarget(revision);
    if (!target) return null;
    // The document shares this history instance.
    return await withDoc(name, () => history.restore(target, new RestoreOrigin(author, revision)));
  } finally {
    closeHistory(history);
  }
}

export function openDocumentStats() {
  return { openDocuments: docs.size };
}
