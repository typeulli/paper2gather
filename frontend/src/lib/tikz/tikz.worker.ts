/**
 * Runs TeX (WebAssembly, isomorphic-tikzjax) off the main thread: TikZ source -> unsanitized SVG
 * markup. One job at a time; the engine keeps global state between the steps of a run.
 */
import { Machines } from "@prinsss/dvi2html";
import fontData from "@prinsss/dvi2html/lib/tfm/fonts.json";
import { dvi2svg, getResourceLoader, tex, type ResourceLoader } from "isomorphic-tikzjax";

export interface TikzJob {
  id: number;
  /** Full document body, \begin{document} … \end{document} */
  input: string;
  libraries: string;
  packages: string[];
  /** URL of the directory with core.dump.gz, tex.wasm.gz and tex_files.tar.gz */
  baseUrl: string;
}

export type TikzJobResult =
  | { id: number; ok: true; svg: string }
  | {
      id: number;
      ok: false;
      log: string[];
      message: string;
      /** The failure escaped the job, leaving the worker in an unknown state: start a new one. */
      restart?: boolean;
    };

// The package types describe its Node.js build; the browser build takes a URL.
const browserLoader = getResourceLoader as unknown as (options: { texResourcesUrl: string }) => ResourceLoader;
let loader: ResourceLoader | null = null;

// The project's TypeScript lib is the DOM one; this is a dedicated worker scope.
const scope = self as unknown as {
  onmessage: (event: MessageEvent<TikzJob>) => void;
  postMessage: (result: TikzJobResult) => void;
};

/**
 * TeX and the DVI to SVG step read font metrics from this table (and the page has the font files of
 * the same fonts), which only has some sizes of each font, while LaTeX uses others too, e.g. cmmib5
 * for \boldsymbol in small text: TeX would fail. The missing sizes get the metrics of the nearest
 * size of the same font (larger first) and are drawn with it.
 */
const fonts = fontData as Record<string, string>;
const fontAliases = new Map<string, string>();
const fontSizes = new Map<string, number[]>();
for (const name of Object.keys(fonts)) {
  const sized = /^(.*?)(\d+)$/.exec(name);
  if (sized) fontSizes.set(sized[1], [...(fontSizes.get(sized[1]) ?? []), Number(sized[2])]);
}
for (const [family, sizes] of fontSizes) {
  for (let size = 5; size <= 17; size++) {
    if (sizes.includes(size)) continue;
    const nearest = [...sizes].sort((a, b) => Math.abs(a - size) - Math.abs(b - size) || b - a)[0];
    fontAliases.set(`${family}${size}`, `${family}${nearest}`);
    fonts[`${family}${size}`] = fonts[`${family}${nearest}`];
  }
}

const htmlMachine = Machines.HTML.prototype;
const loadFont = htmlMachine.loadFont;
htmlMachine.loadFont = function (properties: { name: string }) {
  return loadFont.call(this, { ...properties, name: fontAliases.get(properties.name) ?? properties.name });
};

/** The job being run, until its result is posted */
let current: { id: number; log: string[] } | null = null;

function post(result: TikzJobResult) {
  if (current?.id !== result.id) return;
  current = null;
  scope.postMessage(result);
}

// TeX resumes in timer callbacks after loading files, so an error there (and in promises nobody
// awaits) never settles the job, which would hang until the page's timeout: fail it right away.
const failEscaped = (reason: unknown) => {
  if (!current) return;
  const message = reason instanceof Error ? reason.message : String(reason);
  post({ id: current.id, ok: false, log: current.log, message, restart: true });
};
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  failEscaped(event.reason);
});
self.addEventListener("error", (event) => {
  event.preventDefault();
  failEscaped(event.error ?? event.message);
});

scope.onmessage = async (event) => {
  const job = event.data;
  loader ??= browserLoader({ texResourcesUrl: job.baseUrl });
  // With showConsole the engine writes the TeX terminal output with console.log.
  const log: string[] = [];
  current = { id: job.id, log };
  const consoleLog = console.log;
  console.log = (...args: unknown[]) => log.push(args.map(String).join(" "));
  let result: TikzJobResult;
  try {
    const dvi = await tex(
      job.input,
      {
        showConsole: true,
        texPackages: Object.fromEntries(job.packages.map((name) => [name, ""])),
        tikzLibraries: job.libraries,
      },
      loader
    );
    // Sanitized on the main thread (no DOM here).
    const svg = await dvi2svg(dvi, { disableSanitize: true });
    result = { id: job.id, ok: true, svg };
  } catch (err) {
    result = { id: job.id, ok: false, log, message: err instanceof Error ? err.message : String(err) };
  } finally {
    console.log = consoleLog;
  }
  post(result);
};
