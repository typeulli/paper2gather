import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { config } from "./config.js";
import {
  UPLOADS_DIR,
  deleteDocumentFiles,
  getMeta,
  initStorage,
  isValidId,
  listDocuments,
  newId,
  saveMeta,
  saveState,
  type DocumentMeta,
} from "./storage.js";
import { applyTemplate, FIELDS, type TemplateName } from "./template.js";
import { findPrefab, PREFABS } from "./prefabs.js";
import {
  evictDoc,
  flushAll,
  openDocumentStats,
  readDocState,
  restoreRevision,
  setupConnection,
} from "./collab.js";
import { deleteHistory, withHistory } from "./history.js";
import { mcpRouter } from "./mcp/server.js";

const COLLAB_PATH = "/collab/";

const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const app = express();
app.disable("x-powered-by");

const allowedOrigins = config.corsOrigin.split(",").map((o) => o.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes("*")) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ...openDocumentStats() });
});

app.get(
  "/api/documents",
  asyncRoute(async (_req, res) => {
    res.json(await listDocuments());
  })
);

async function createDocument(title: string, buildState: (doc: Y.Doc) => void): Promise<DocumentMeta> {
  const now = new Date().toISOString();
  const meta: DocumentMeta = { id: newId(), title, createdAt: now, updatedAt: now };
  const doc = new Y.Doc();
  buildState(doc);
  await saveState(meta.id, Y.encodeStateAsUpdate(doc));
  await saveMeta(meta);
  doc.destroy();
  return meta;
}

app.post(
  "/api/documents",
  express.json(),
  asyncRoute(async (req, res) => {
    const title =
      typeof req.body?.title === "string" && req.body.title.trim()
        ? req.body.title.trim().slice(0, 300)
        : "Untitled Paper";
    const template: TemplateName = req.body?.template === "blank" ? "blank" : "paper";
    const prefab = findPrefab(req.body?.prefab);
    const meta = await createDocument(title, (doc) => applyTemplate(doc, title, template, prefab));
    res.status(201).json(meta);
  })
);

app.get("/api/prefabs", (_req, res) => {
  res.json(PREFABS.map(({ id, label, description, format }) => ({ id, label, description, format })));
});

app.post(
  "/api/documents/import",
  express.raw({ type: () => true, limit: config.maxUploadBytes }),
  asyncRoute(async (req, res) => {
    const title =
      typeof req.query.title === "string" && req.query.title.trim()
        ? req.query.title.trim().slice(0, 300)
        : "Untitled Paper";
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "empty body" });
      return;
    }
    // A Yjs update the frontend built from an imported file (HWPX) with the editor's schema.
    const source = new Y.Doc();
    try {
      Y.applyUpdate(source, new Uint8Array(req.body));
    } catch {
      source.destroy();
      res.status(400).json({ error: "invalid document update" });
      return;
    }
    if (source.getXmlFragment(FIELDS.content).length === 0) {
      source.destroy();
      res.status(400).json({ error: "empty document" });
      return;
    }
    const meta = await createDocument(title, (doc) => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
      doc.getMap(FIELDS.meta).set("title", title);
    });
    source.destroy();
    res.status(201).json(meta);
  })
);

app.get(
  "/api/documents/:id",
  asyncRoute(async (req, res) => {
    const meta = await getMeta(String(req.params.id));
    if (!meta) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(meta);
  })
);

app.post(
  "/api/documents/:id/duplicate",
  asyncRoute(async (req, res) => {
    const id = String(req.params.id);
    const source = await getMeta(id);
    const state = source && (await readDocState(id));
    if (!source || !state) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const title = `${source.title} (copy)`;
    const meta = await createDocument(title, (doc) => {
      Y.applyUpdate(doc, state);
      doc.getMap(FIELDS.meta).set("title", title);
    });
    res.status(201).json(meta);
  })
);

app.delete(
  "/api/documents/:id",
  asyncRoute(async (req, res) => {
    const id = String(req.params.id);
    if (!isValidId(id) || !(await getMeta(id))) {
      res.status(404).json({ error: "not found" });
      return;
    }
    await evictDoc(id);
    await deleteDocumentFiles(id);
    await deleteHistory(id);
    res.status(204).end();
  })
);

// ------------------------------------------------------------------ revision history

/** The document id of the request, or null after answering 404 */
async function documentId(req: Request, res: Response): Promise<string | null> {
  const id = String(req.params.id);
  if (await getMeta(id)) return id;
  res.status(404).json({ error: "not found" });
  return null;
}

const revisionId = (value: unknown) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

app.get(
  "/api/documents/:id/history",
  asyncRoute(async (req, res) => {
    const id = await documentId(req, res);
    if (id) res.json(await withHistory(id, (history) => history.list()));
  })
);

app.get(
  "/api/documents/:id/history/:rev",
  asyncRoute(async (req, res) => {
    const id = await documentId(req, res);
    if (!id) return;
    const rev = revisionId(req.params.rev);
    const texts = rev === null ? null : await withHistory(id, (history) => history.texts(rev));
    if (!texts) {
      res.status(404).json({ error: "revision not found" });
      return;
    }
    res.json(texts);
  })
);

app.get(
  "/api/documents/:id/history/:rev/content",
  asyncRoute(async (req, res) => {
    const id = await documentId(req, res);
    if (!id) return;
    const rev = revisionId(req.params.rev);
    const contents =
      rev === null ? null : await withHistory(id, (history) => history.contents(rev));
    if (!contents) {
      res.status(404).json({ error: "revision not found" });
      return;
    }
    res.json(contents);
  })
);

app.delete(
  "/api/documents/:id/history",
  express.json(),
  asyncRoute(async (req, res) => {
    const id = await documentId(req, res);
    if (!id) return;
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((v) => revisionId(v) === null)) {
      res.status(400).json({ error: "ids must be a list of revision ids" });
      return;
    }
    await withHistory(id, (history) => history.deleteRevisions(ids as number[]));
    res.status(204).end();
  })
);

app.post(
  "/api/documents/:id/history/:rev/restore",
  express.json(),
  asyncRoute(async (req, res) => {
    const id = await documentId(req, res);
    if (!id) return;
    const rev = revisionId(req.params.rev);
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "";
    const color = typeof req.body?.color === "string" ? req.body.color.slice(0, 32) : "";
    const changed = rev === null ? null : await restoreRevision(id, rev, { name, color });
    if (changed === null) {
      res.status(404).json({ error: "revision not found" });
      return;
    }
    res.json({ changed });
  })
);

app.post(
  "/api/uploads",
  express.raw({ type: () => true, limit: config.maxUploadBytes }),
  asyncRoute(async (req, res) => {
    const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim();
    const ext = IMAGE_TYPES[contentType];
    if (!ext) {
      res.status(415).json({ error: `unsupported type: ${contentType || "unknown"}` });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "empty body" });
      return;
    }
    const fileName = `${newId()}.${ext}`;
    await fs.writeFile(path.join(UPLOADS_DIR, fileName), req.body);
    res.status(201).json({ url: `/uploads/${fileName}` });
  })
);

app.use(
  "/uploads",
  (_req, res, next) => {
    // Uploaded SVGs must never run scripts in this origin.
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  },
  express.static(UPLOADS_DIR, { immutable: true, maxAge: "365d", index: false })
);

app.use("/mcp", mcpRouter({ createDocument }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number })?.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "internal error" : String((err as Error).message) });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const docName = pathname.startsWith(COLLAB_PATH)
    ? decodeURIComponent(pathname.slice(COLLAB_PATH.length))
    : "";
  if (!isValidId(docName)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    setupConnection(ws, docName).catch((err) => {
      console.error("[collab] connection setup failed", err);
      ws.close(1011, "internal error");
    });
  });
});

await initStorage();
server.listen(config.port, config.host, () => {
  console.log(`[paper2gather] http+ws listening on http://localhost:${config.port}`);
  console.log(`[paper2gather] data directory: ${config.dataDir}`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[paper2gather] ${signal} received, saving documents...`);
  await flushAll();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
