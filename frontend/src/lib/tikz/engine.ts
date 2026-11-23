/**
 * Compiles TikZ figures in the browser: TeX runs in a worker (tikz.worker.ts), the SVG it produces is
 * sanitized here (the code is shared by every collaborator and TeX can emit raw SVG) and cached in
 * memory and IndexedDB, so a figure is compiled once per browser.
 */
import { splitList, type TikzSource } from "./options";
import type { TikzJob, TikzJobResult } from "./tikz.worker";

export interface TikzError {
  /** Line of the TikZ code, when TeX points into it */
  line: number | null;
  message: string;
  /** The code TeX read up to the error */
  context: string | null;
}

export type TikzResult = { ok: true; svg: string } | { ok: false; errors: TikzError[] };

/** Where scripts/copy-tikzjax.mjs puts the engine files and fonts */
const BASE_PATH = "/tikzjax";
/** Lines before the code in the TeX input: the preamble line and \begin{document} */
const LINES_BEFORE_CODE = 2;
/** A fresh worker first downloads the engine (about 8 MB). */
const FIRST_TIMEOUT_MS = 120_000;
const TIMEOUT_MS = 30_000;
/** Part of the cache keys: bump when the engine or the SVG post-processing changes. */
const CACHE_VERSION = 1;
const MEMORY_ENTRIES = 100;
/** Replaced with a per-instance prefix when an SVG is shown (see `instantiateSvg`) */
const ID_PLACEHOLDER = "tikzsvgid-";

function cacheKey(src: TikzSource): string {
  return JSON.stringify([CACHE_VERSION, src.packages, src.libraries, src.code]);
}

// ------------------------------------------------------------------ worker queue

interface Job {
  key: string;
  src: TikzSource;
  resolve: (result: TikzResult) => void;
}

let worker: Worker | null = null;
let workerUsed = false;
const queue: Job[] = [];
let running: { job: Job; id: number; timer: ReturnType<typeof setTimeout> } | null = null;
let nextId = 1;
let loaded = false;

/** Whether the engine has run in this page (the first run downloads it). */
export function tikzEngineLoaded(): boolean {
  return loaded;
}

function stopWorker() {
  worker?.terminate();
  worker = null;
}

function startWorker(): Worker {
  const w = new Worker(new URL("./tikz.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (event: MessageEvent<TikzJobResult>) => {
    if (running?.id !== event.data.id) return;
    const { job } = running;
    loaded = true;
    if (!event.data.ok && event.data.restart) stopWorker();
    finish(event.data.ok ? toResult(event.data.svg) : failure(event.data, job.src.code));
  };
  w.onerror = () => {
    stopWorker();
    finish(engineError("TeX 엔진을 실행하지 못했습니다."));
  };
  workerUsed = false;
  return w;
}

function pump() {
  if (running || queue.length === 0) return;
  const job = queue.shift()!;
  worker ??= startWorker();
  const id = nextId++;
  const timeout = workerUsed ? TIMEOUT_MS : FIRST_TIMEOUT_MS;
  workerUsed = true;
  const timer = setTimeout(() => {
    // TeX may loop forever; only a new worker gets out of it.
    stopWorker();
    finish(engineError(`${timeout / 1000}초 안에 끝나지 않았습니다. 끝없이 반복하는 코드가 있는지 확인하세요.`));
  }, timeout);
  running = { job, id, timer };
  const message: TikzJob = {
    id,
    input: `\\begin{document}\n${job.src.code}\n\\end{document}`,
    libraries: splitList(job.src.libraries).join(","),
    packages: splitList(job.src.packages),
    baseUrl: new URL(BASE_PATH, window.location.href).href,
  };
  worker.postMessage(message);
}

function finish(result: TikzResult & { engine?: boolean }) {
  if (!running) return;
  const { job, timer } = running;
  clearTimeout(timer);
  running = null;
  job.resolve(result);
  pump();
}

// ------------------------------------------------------------------ results

/** Failures of the engine itself (not of the code) aren't cached, so the next render retries. */
function engineError(message: string): TikzResult & { engine: true } {
  return { ok: false, errors: [{ line: null, message, context: null }], engine: true };
}

function failure(result: Extract<TikzJobResult, { ok: false }>, code: string): TikzResult {
  if (/Failed to fetch/i.test(result.message)) {
    return engineError(`TeX 엔진 파일을 불러오지 못했습니다 (${result.message}).`);
  }
  const font = /Could not find font (\S+)/.exec(result.message);
  if (font) {
    const message = `그림에 쓴 글꼴(${font[1]})은 그릴 수 없습니다. 글꼴이나 글자 크기를 바꿔 보세요.`;
    return { ok: false, errors: [{ line: null, message, context: null }] };
  }
  if (result.restart) return engineError(`그림을 SVG로 바꾸지 못했습니다 (${result.message}).`);
  const errors = parseTexErrors(result.log, code.split("\n").length);
  return {
    ok: false,
    errors: errors.length ? errors : [{ line: null, message: "그림을 만들지 못했습니다.", context: null }],
  };
}

/** "! message" lines of the TeX terminal output with the "l.N context" line that follows. */
export function parseTexErrors(log: string[], codeLines: number): TikzError[] {
  const errors: TikzError[] = [];
  for (let i = 0; i < log.length; i++) {
    if (!log[i].startsWith("! ") || log[i].startsWith("! Emergency stop")) continue;
    // TeX wraps its output at 79 characters.
    let message = log[i].slice(2);
    let j = i + 1;
    for (; j < log.length && log[j] && !/^(l\.\d+|\?|!|See the |Type )/.test(log[j]); j++) {
      message += (log[j - 1].length >= 79 ? "" : " ") + log[j];
    }
    let line: number | null = null;
    let context: string | null = null;
    for (let k = j; k < Math.min(log.length, j + 12); k++) {
      const at = /^l\.(\d+) ?(.*)$/.exec(log[k]);
      if (at) {
        const n = Number(at[1]) - LINES_BEFORE_CODE;
        line = n >= 1 && n <= codeLines ? n : null;
        context = at[2].trim() || null;
        break;
      }
      if (log[k].startsWith("! ")) break;
    }
    const unicode = /Unicode character (\S+) \(U\+([0-9A-F]+)\)/.exec(message);
    if (unicode) {
      const char = String.fromCodePoint(parseInt(unicode[2], 16));
      message = `TikZ 그림 안에는 한글 등 영문 외 문자를 쓸 수 없습니다: "${char}" (U+${unicode[2]}). 캡션에 쓰세요.`;
      context = context?.replace(/(\^\^[0-9a-f]{2})+/g, char) ?? null;
    }
    errors.push({ line, message, context });
    i = j - 1;
  }
  return errors;
}

// ------------------------------------------------------------------ SVG

const ALLOWED_ELEMENTS = new Set(
  [
    "svg", "g", "path", "text", "tspan", "defs", "clipPath", "mask", "linearGradient", "radialGradient", "stop",
    "pattern", "use", "rect", "circle", "ellipse", "line", "polyline", "polygon", "symbol", "marker", "title", "desc",
  ].map((n) => n.toLowerCase())
);
const COLOR_ATTRIBUTES = ["fill", "stroke", "color", "stop-color"];
const BLACK = /^(#000|#000000|black|rgb\(\s*0%?\s*,\s*0%?\s*,\s*0%?\s*\))$/i;
const WHITE = /^(#fff|#ffffff|white|rgb\(\s*(255|100%)\s*,\s*(255|100%)\s*,\s*(255|100%)\s*\))$/i;

/**
 * Keeps only drawing elements and attributes (no scripts, styles, event handlers or external links),
 * draws black in the text color and white in the page color (dark theme), and renames ids to
 * placeholders so several copies of a figure can be shown at once.
 */
function sanitizeSvg(markup: string): string | null {
  const doc = new DOMParser().parseFromString(markup, "text/html");
  const svg = doc.querySelector("svg");
  if (!svg) return null;
  const ids = new Map<string, string>();
  const clean = (el: Element) => {
    for (const child of [...el.children]) {
      if (ALLOWED_ELEMENTS.has(child.localName.toLowerCase())) clean(child);
      else child.remove();
    }
    for (const { name, value } of [...el.attributes]) {
      const lower = name.toLowerCase();
      if (
        lower.startsWith("on") ||
        ((lower === "href" || lower === "xlink:href") && !value.startsWith("#")) ||
        /javascript:|url\(\s*(?!["']?#)/i.test(value)
      ) {
        el.removeAttribute(name);
      }
    }
    for (const name of COLOR_ATTRIBUTES) {
      const value = el.getAttribute(name)?.trim();
      if (!value) continue;
      if (BLACK.test(value)) el.setAttribute(name, "currentColor");
      else if (WHITE.test(value)) {
        el.removeAttribute(name);
        (el as SVGElement).style.setProperty(name, "var(--background)");
      }
    }
    const id = el.getAttribute("id");
    if (id) {
      ids.set(id, `${ID_PLACEHOLDER}${ids.size}`);
      el.setAttribute("id", ids.get(id)!);
    }
  };
  clean(svg);
  if (ids.size) {
    for (const el of [svg, ...svg.querySelectorAll("*")]) {
      for (const { name, value } of [...el.attributes]) {
        if (!value.includes("#") || name === "id") continue;
        const renamed = value
          .replace(/url\(\s*#([^)\s]+)\s*\)/g, (m, id: string) => (ids.has(id) ? `url(#${ids.get(id)})` : m))
          .replace(/^#(.+)$/, (m, id: string) => (ids.has(id) ? `#${ids.get(id)}` : m));
        if (renamed !== value) el.setAttribute(name, renamed);
      }
    }
  }
  return svg.outerHTML;
}

function toResult(markup: string): TikzResult {
  const svg = sanitizeSvg(markup);
  return svg ? { ok: true, svg } : { ok: false, errors: [{ line: null, message: "그림이 비어 있습니다.", context: null }] };
}

/** The SVG with ids unique to one place where it is shown (`instance`: letters and digits). */
export function instantiateSvg(svg: string, instance: string): string {
  return svg.replaceAll(ID_PLACEHOLDER, `tikz-${instance}-`);
}

// ------------------------------------------------------------------ caches

const memory = new Map<string, TikzResult>();
const inflight = new Map<string, Promise<TikzResult>>();

function remember(key: string, result: TikzResult) {
  memory.delete(key);
  memory.set(key, result);
  if (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
}

const DB_NAME = "paper2gather-tikz";
const STORE = "svg";
const DB_MAX_ENTRIES = 400;
const DB_PRUNED_ENTRIES = 300;
let db: Promise<IDBDatabase | null> | null = null;

/** Persistent cache of compiled figures; null where IndexedDB isn't available (it is optional). */
function openDb(): Promise<IDBDatabase | null> {
  db ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE).createIndex("used", "used");
      request.onsuccess = () => {
        resolve(request.result);
        prune(request.result);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return db;
}

interface StoredSvg {
  svg: string;
  used: number;
}

/** Keeps the most recently used figures. */
function prune(database: IDBDatabase) {
  try {
    const store = database.transaction(STORE, "readwrite").objectStore(STORE);
    const count = store.count();
    count.onsuccess = () => {
      let excess = count.result - DB_PRUNED_ENTRIES;
      if (count.result <= DB_MAX_ENTRIES) return;
      store.index("used").openCursor().onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cursor || excess-- <= 0) return;
        cursor.delete();
        cursor.continue();
      };
    };
  } catch {
    // The cache is best effort.
  }
}

async function loadStored(key: string): Promise<string | null> {
  const database = await openDb();
  if (!database) return null;
  return new Promise((resolve) => {
    try {
      const store = database.transaction(STORE, "readwrite").objectStore(STORE);
      const request = store.get(key);
      request.onsuccess = () => {
        const value = request.result as StoredSvg | undefined;
        if (value) store.put({ svg: value.svg, used: Date.now() } satisfies StoredSvg, key);
        resolve(value?.svg ?? null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

const stored = new Set<string>();

async function store(key: string, svg: string) {
  if (stored.has(key)) return;
  stored.add(key);
  const database = await openDb();
  try {
    database?.transaction(STORE, "readwrite").objectStore(STORE).put({ svg, used: Date.now() } satisfies StoredSvg, key);
  } catch {
    // The cache is best effort.
  }
}

// ------------------------------------------------------------------ API

function ensureFonts() {
  if (document.getElementById("tikzjax-fonts")) return;
  const link = document.createElement("link");
  link.id = "tikzjax-fonts";
  link.rel = "stylesheet";
  link.href = `${BASE_PATH}/fonts.css`;
  document.head.appendChild(link);
}

/** A result this browser already has in memory. */
export function peekTikz(src: TikzSource): TikzResult | undefined {
  return memory.get(cacheKey(src));
}

/**
 * Compiles a figure (one at a time, in order; `priority` jumps the queue). `persist` keeps a
 * successful result across page loads: for figures in the document, not for drafts being edited.
 */
export function compileTikz(src: TikzSource, opts: { priority?: boolean; persist?: boolean } = {}): Promise<TikzResult> {
  ensureFonts();
  const key = cacheKey(src);
  let promise: Promise<TikzResult> | undefined = memory.get(key) && Promise.resolve(memory.get(key)!);
  if (!promise) {
    promise = inflight.get(key);
    if (promise && opts.priority) {
      const at = queue.findIndex((job) => job.key === key);
      if (at > 0) queue.unshift(...queue.splice(at, 1));
    }
  }
  if (!promise) {
    promise = loadStored(key)
      .then((svg) => {
        if (svg) {
          stored.add(key);
          return { ok: true, svg } satisfies TikzResult;
        }
        return new Promise<TikzResult & { engine?: boolean }>((resolve) => {
          const job: Job = { key, src, resolve };
          if (opts.priority) queue.unshift(job);
          else queue.push(job);
          pump();
        });
      })
      .then((result: TikzResult & { engine?: boolean }) => {
        inflight.delete(key);
        if (!result.ok && result.engine) return { ok: false, errors: result.errors };
        remember(key, result);
        return result;
      });
    inflight.set(key, promise);
  }
  if (opts.persist) {
    void promise.then((result) => {
      if (result.ok) void store(key, result.svg);
    });
  }
  return promise;
}
