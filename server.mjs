// One address for the whole app: starts the backend and the frontend dev servers and routes each
// request (and WebSocket) to the one that serves its path.
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createProxyServer } from "http-proxy-3";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 6005);
/** Unset = Node default (dual-stack "::"), as in the backend */
const HOST = process.env.HOST || undefined;

// Both only listen on this computer; other computers come in through PORT.
const BACKEND_PORT = 1234;
const FRONTEND_PORT = 3000;
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND = `http://127.0.0.1:${FRONTEND_PORT}`;

/** The paths backend/src/index.ts serves; everything else is the Next app */
const BACKEND_PATHS = ["/api", "/uploads", "/mcp", "/collab"];

function targetOf(url = "/") {
  const pathname = url.split("?")[0];
  return BACKEND_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ? BACKEND : FRONTEND;
}

// ------------------------------------------------------------------ child servers

const children = [];
let stopping = false;

/** Runs `npm run dev` in a package folder */
function startDev(name, args, env) {
  const options = { cwd: path.join(ROOT, name), env: { ...process.env, ...env }, stdio: "inherit" };
  // Through `npm run dev` npm gives its own CLI, which runs without a shell (no "Terminate batch job?").
  const npmCli = process.env.npm_execpath;
  const child = npmCli
    ? spawn(process.execPath, [npmCli, "run", "dev", ...args], options)
    : spawn("npm", ["run", "dev", ...args], { ...options, shell: process.platform === "win32" });
  child.on("exit", (code, signal) => {
    if (!stopping) console.error(`[root] ${name} exited (${signal ?? code})`);
    if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) process.exit(stopping ? 0 : 1);
  });
  children.push(child);
}

startDev("backend", [], { PORT: String(BACKEND_PORT), HOST: "127.0.0.1" });
startDev("frontend", ["--", "-p", String(FRONTEND_PORT), "-H", "127.0.0.1"], { PORT: String(FRONTEND_PORT) });

// Ctrl+C in the terminal reaches the child servers by itself, so this only waits for them to exit.
// A SIGTERM sent to this process alone is passed on.
process.on("SIGINT", () => {
  stopping = true;
  server.close();
});
process.on("SIGTERM", () => {
  stopping = true;
  server.close();
  for (const child of children) child.kill("SIGTERM");
});

// ------------------------------------------------------------------ routing

/** A browser that closed a tab or a connection: nothing to report */
const CLIENT_GONE = new Set(["ECONNRESET", "ECONNABORTED", "EPIPE"]);

const proxy = createProxyServer({});
// Without a listener of its own the proxy throws these, which would stop this server.
proxy.on("error", (err, req, res) => {
  if (!CLIENT_GONE.has(err.code)) console.error(`[root] ${req.method} ${req.url} → ${targetOf(req.url)}: ${err.message}`);
  if (!(res instanceof http.ServerResponse)) res.destroy(); // a WebSocket's socket
  else if (!res.headersSent) res.status(502).type("text/plain").send(`${targetOf(req.url)} is not reachable (starting?)`);
  else res.destroy();
});

const app = express();
app.disable("x-powered-by");
app.use((req, res) => proxy.web(req, res, { target: targetOf(req.url) }));

const server = http.createServer(app);
// Yjs collaboration (/collab/…) goes to the backend, Next's hot reload to the frontend.
server.on("upgrade", (req, socket, head) => proxy.ws(req, socket, head, { target: targetOf(req.url) }));

server.listen(PORT, HOST, () => {
  console.log(`[root] http://localhost:${PORT} → backend ${BACKEND} (${BACKEND_PATHS.join(", ")}), frontend ${FRONTEND}`);
});
