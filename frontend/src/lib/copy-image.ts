/**
 * "Copy as image" for equations, figures and tables: each drawn by itself (without caption or number) to a PNG with a
 * white background, in the colors of the light theme whatever the page shows. Not transparent: Chrome puts a bitmap
 * beside the PNG for apps such as Paint, and there transparent pixels turn black.
 */
import type { Editor } from "@tiptap/core";
import { resolveAssetUrl } from "@/lib/config";
import {
  canvasPng,
  drawSvg,
  equationImages,
  fontDataUrl,
  fontsSettled,
  offscreenHost,
  tikzImage,
} from "@/lib/hwpx/export-images";
import { escapeXml } from "@/lib/hwpx/owpml";
import type { PaperFormat } from "@/lib/paper/format";
import type { TikzSource } from "@/lib/tikz/options";

/** Pixels per CSS px for what's drawn here, as in the exports */
const SCALE = 3;
const MAX_CANVAS_SIDE = 8192;
/** Room around a table, in px: its outer rules reach half their width beyond its box. */
const EDGE = 2;

export type ImageSource =
  | { kind: "equation"; latex: string; size: number; color: string }
  | { kind: "tikz"; source: TikzSource }
  | { kind: "image"; src: string }
  | { kind: "table"; table: HTMLTableElement };

/** What to draw for the equation, figure or table at `pos`: null for anything else, an empty equation or a figure without an image. */
export function imageSourceAt(editor: Editor, pos: number, format: PaperFormat): ImageSource | null {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return null;
  const attrs = node.attrs;
  switch (node.type.name) {
    case "equation":
      if (!String(attrs.latex ?? "").trim()) return null;
      // As in the editor: the size and color of the body text
      return { kind: "equation", latex: attrs.latex, size: format.styles.body.size, color: format.styles.body.color || "#000000" };
    case "figure":
      if (attrs.tikz !== null) {
        return { kind: "tikz", source: { code: attrs.tikz, libraries: attrs.tikzLibraries, packages: attrs.tikzPackages } };
      }
      return attrs.src ? { kind: "image", src: attrs.src } : null;
    case "tableFigure":
    case "table": {
      const dom = editor.view.nodeDOM(pos);
      const table = dom instanceof HTMLTableElement ? dom : dom instanceof HTMLElement ? dom.querySelector("table") : null;
      return table ? { kind: "table", table } : null;
    }
    default:
      return null;
  }
}

/** The PNG of what `source` shows, or null when it can't be drawn (an invalid formula, a TikZ error, a missing file). */
export async function renderImage(source: ImageSource): Promise<Blob | null> {
  try {
    const data = await render(source);
    return data ? new Blob([data.slice()], { type: "image/png" }) : null;
  } catch {
    return null;
  }
}

async function render(source: ImageSource): Promise<Uint8Array | null> {
  switch (source.kind) {
    case "equation": {
      const request = { latex: source.latex, display: true, size: source.size, color: source.color };
      const [image] = await equationImages([request], async () => {});
      return image?.data ?? null;
    }
    case "tikz":
      return (await tikzImage(source.source))?.data ?? null;
    case "image":
      return fileImage(source.src);
    case "table":
      return tableImage(source.table);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image failed to load"));
    image.src = url;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** An uploaded image at its own size (an SVG larger, like the drawings here), on white. */
async function fileImage(src: string): Promise<Uint8Array | null> {
  const response = await fetch(resolveAssetUrl(src));
  if (!response.ok) return null;
  const blob = await response.blob();
  const vector = blob.type === "image/svg+xml";
  // A data URL for an SVG: from a blob URL, one with HTML inside would leave the canvas unreadable.
  const url = vector ? await blobToDataUrl(blob) : URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width === 0 || height === 0) return null;
    const scale = vector ? Math.min(SCALE, MAX_CANVAS_SIDE / Math.max(width, height)) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvasPng(canvas);
  } finally {
    if (!vector) URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------------------ tables

/**
 * Parts of the editor inside a table that aren't part of the table: column handles, other users' carets,
 * page break spacers, and the MathML copy of each formula (hidden anyway).
 */
const EDITOR_PARTS = ".column-resize-handle, .collaboration-carets__caret, .collaboration-carets__label, .page-break, .katex-mathml";
/**
 * Classes the editor adds for the moment: selected cells, the space before a row on a new page, the row being resized,
 * placeholders, comment highlights, selected inline nodes (math, citations, cross references) and a highlight after a jump.
 */
const EDITOR_CLASSES = [
  "selectedCell",
  "page-break-row",
  "row-resize-target",
  "is-empty",
  "comment-mark",
  "ProseMirror-selectednode",
  "flash-highlight",
  "bg-primary/10",
  "ring-1",
  "ring-primary/30",
];
/** How the editor lays out its text, which a table inherits: ProseMirror sets these on the editor. */
const EDITOR_TEXT_PROPERTIES = [
  "white-space",
  "overflow-wrap",
  "word-break",
  "font-variant-ligatures",
  "font-feature-settings",
];

function cleanTable(table: HTMLTableElement): HTMLTableElement {
  const clone = table.cloneNode(true) as HTMLTableElement;
  for (const part of Array.from(clone.querySelectorAll(EDITOR_PARTS))) part.remove();
  for (const element of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
    element.classList.remove(...EDITOR_CLASSES);
    if (element.classList.length === 0) element.removeAttribute("class");
    element.removeAttribute("contenteditable");
  }
  // Other users' selections: highlighted with an inline background
  for (const selection of Array.from(clone.querySelectorAll<HTMLElement>(".ProseMirror-yjs-selection"))) {
    selection.style.removeProperty("background-color");
  }
  return clone;
}

interface PageStyles {
  /** Every rule of the page except its fonts */
  css: string;
  /** By family */
  fonts: Map<string, CSSFontFaceRule[]>;
  /** The custom properties the page's own fonts are named by (next/font sets them on the root element) */
  fontVariables: Set<string>;
}

function readPageStyles(): PageStyles {
  const styles: PageStyles = { css: "", fonts: new Map(), fontVariables: new Set() };
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule) {
        const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
        styles.fonts.set(family, [...(styles.fonts.get(family) ?? []), rule]);
        continue;
      }
      if (rule instanceof CSSStyleRule) {
        for (const name of Array.from(rule.style)) {
          if (name.startsWith("--font-")) styles.fontVariables.add(name);
        }
      }
      if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
      parts.push(Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n"));
    } catch {
      // A stylesheet from elsewhere can't be read; the editor's are all the app's own.
    }
  }
  // The fonts go in separately, as data. A face inside a layer or a media rule is part of that rule's text.
  styles.css = parts.join("\n").replace(/@font-face\s*\{[^}]*\}/g, "");
  return styles;
}

function parseUnicodeRange(value: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const part of value.split(",")) {
    const match = part.trim().match(/^u\+([0-9a-f?]+)(?:-([0-9a-f]+))?$/i);
    if (!match) continue;
    const start = parseInt(match[1].replace(/\?/g, "0"), 16);
    const end = parseInt(match[2] ?? match[1].replace(/\?/g, "f"), 16);
    ranges.push([start, end]);
  }
  return ranges;
}

/** Whether the face is used for any of these characters */
function coversAny(rule: CSSFontFaceRule, codePoints: number[]): boolean {
  const value = rule.style.getPropertyValue("unicode-range");
  if (!value) return true;
  const ranges = parseUnicodeRange(value);
  return ranges.length === 0 || codePoints.some((c) => ranges.some(([start, end]) => c >= start && c <= end));
}

const loadedFonts = new Map<string, Promise<void>>();

/**
 * An SVG image is drawn before the fonts in it have loaded (its first copy shows some letters in another face), unless
 * the browser already holds them: loading the same data here first leaves them in its cache.
 */
function loadFontData(url: string, data: string): Promise<void> {
  let loaded = loadedFonts.get(url);
  if (!loaded) {
    loaded = new FontFace("copy-image-font", `url(${data})`).load().then(
      () => {},
      () => {}
    );
    loadedFonts.set(url, loaded);
  }
  return loaded;
}

/** The face with its file as data, or as it is when it only names installed fonts */
async function embeddedFace(rule: CSSFontFaceRule): Promise<string> {
  const source = rule.style.getPropertyValue("src");
  const url = source.match(/url\(\s*["']?([^"')]+)["']?\s*\)/)?.[1];
  if (!url) return rule.cssText;
  const base = rule.parentStyleSheet?.href ?? location.href;
  const href = new URL(url, base).href;
  const data = await fontDataUrl(href);
  await loadFontData(href, data);
  const declarations = Array.from(rule.style, (name) =>
    name === "src" ? `src:url(${data})` : `${name}:${rule.style.getPropertyValue(name)}`
  );
  return `@font-face{${declarations.join(";")}}`;
}

/** Every web font face that something below `root` may use for its text */
async function fontFaces(root: Element, fonts: PageStyles["fonts"]): Promise<string> {
  const families = new Set<string>();
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const family of getComputedStyle(element).fontFamily.split(",")) {
      families.add(family.replace(/["']/g, "").trim());
    }
  }
  const codePoints = [...new Set(Array.from(root.textContent ?? "", (c) => c.codePointAt(0) ?? 0))];
  const faces: string[] = [];
  for (const family of families) {
    for (const rule of fonts.get(family) ?? []) {
      if (coversAny(rule, codePoints)) faces.push(await embeddedFace(rule));
    }
  }
  return faces.join("");
}

/**
 * The table as the editor lays it out, drawn from an SVG that holds a copy of it with the page's stylesheets. There
 * `:root` is the SVG, so the theme colors are those of the light theme, and `.dark` matches nothing.
 */
async function tableImage(table: HTMLTableElement): Promise<Uint8Array | null> {
  const container = table.parentElement;
  const editorBody = table.closest(".paper-body");
  if (!container || !editorBody) return null;
  const styles = readPageStyles();

  // `.paper-page .paper-body` around the table, as in the editor, so that the same rules apply to it
  const page = document.createElement("div");
  page.className = "paper-page";
  page.style.width = `${container.clientWidth}px`;
  page.style.setProperty("color", "var(--foreground)");
  const rootStyle = getComputedStyle(document.documentElement);
  for (const name of styles.fontVariables) {
    const value = rootStyle.getPropertyValue(name);
    if (value) page.style.setProperty(name, value);
  }
  const body = document.createElement("div");
  body.className = "paper-body";
  const editorStyle = getComputedStyle(editorBody);
  for (const name of EDITOR_TEXT_PROPERTIES) body.style.setProperty(name, editorStyle.getPropertyValue(name));
  const clone = cleanTable(table);
  body.appendChild(clone);
  page.appendChild(body);

  const host = offscreenHost();
  try {
    host.appendChild(page);
    await fontsSettled(host);
    const pageBox = page.getBoundingClientRect();
    const box = clone.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    const width = Math.ceil(box.width + 2 * EDGE);
    const height = Math.ceil(box.height + 2 * EDGE);
    const faces = await fontFaces(body, styles.fonts);

    page.style.position = "relative";
    page.style.left = `${pageBox.left - box.left + EDGE}px`;
    page.style.top = `${pageBox.top - box.top + EDGE}px`;
    const markup = new XMLSerializer().serializeToString(page);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<style>${escapeXml(faces + styles.css)}</style>` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">${markup}</foreignObject></svg>`;
    return await canvasPng(await drawSvg(svg, width, height));
  } finally {
    host.remove();
  }
}
