/**
 * The browser's part of the HWPX export: equations and TikZ figures drawn to PNG, figures read from their files.
 * Drawing works by loading an SVG as an image, which can't use anything from outside itself, so the styles and
 * fonts go inside it.
 */
import katex from "katex";
import { resolveAssetUrl } from "@/lib/config";
import { compileTikz, instantiateSvg } from "@/lib/tikz/engine";
import type { TikzSource } from "@/lib/tikz/options";
import type { EquationRequest, ExportImage, HwpxAssets, ProgressReport } from "./export";
import { escapeXml } from "./owpml";

/** Pixels per CSS px: enough for print */
const SCALE = 3;
const MAX_CANVAS_SIDE = 8192;
/** Size of the editor's equations relative to the text */
const EQUATION_EM = { inline: 1.05, display: 1.21 };
/** Room around what's measured, in px: glyphs reach a little beyond their boxes. */
const EDGE = 2;
const TIKZ_FONTS_CSS = "/tikzjax/fonts.css";
/** What the page's reset does to the elements KaTeX measures against */
const RESET = "*,::before,::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}";

const KEPT_FILE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const fontData = new Map<string, Promise<string>>();

export function fontDataUrl(url: string): Promise<string> {
  let data = fontData.get(url);
  if (!data) {
    data = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return blobToDataUrl(await response.blob());
    });
    fontData.set(url, data);
  }
  return data;
}

interface KatexStyles {
  rules: string;
  /** By family: what a @font-face needs, with the first (best) source of the rule */
  fonts: Map<string, { descriptors: string; url: string; format: string }[]>;
}

let katexStyles: KatexStyles | null = null;

function readKatexStyles(): KatexStyles {
  if (katexStyles) return katexStyles;
  const styles: KatexStyles = { rules: "", fonts: new Map() };
  const walk = (rules: CSSRuleList, base: string) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule) {
        const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
        const source = rule.style.getPropertyValue("src").match(/url\(["']?([^"')]+)["']?\)\s*format\(["']?([^"')]+)["']?\)/);
        if (!family.startsWith("KaTeX_") || !source) continue;
        const descriptors =
          `font-weight:${rule.style.getPropertyValue("font-weight") || "normal"};` +
          `font-style:${rule.style.getPropertyValue("font-style") || "normal"};`;
        const faces = styles.fonts.get(family) ?? [];
        faces.push({ descriptors, url: new URL(source[1], base).href, format: source[2] });
        styles.fonts.set(family, faces);
      } else if (rule instanceof CSSStyleRule) {
        if (rule.selectorText.includes(".katex")) styles.rules += rule.cssText;
      } else if ("cssRules" in rule) {
        walk((rule as CSSGroupingRule).cssRules, base);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules, sheet.href ?? location.href);
    } catch {
      // A stylesheet from elsewhere can't be read; KaTeX's is part of the app's own.
    }
  }
  katexStyles = styles;
  return styles;
}

/** The font families in use below `root` */
function familiesIn(root: Element, selector: string): Set<string> {
  const families = new Set<string>();
  for (const element of Array.from(root.querySelectorAll(selector))) {
    const first = getComputedStyle(element).fontFamily.split(",")[0];
    if (first) families.add(first.replace(/["']/g, "").trim());
  }
  return families;
}

/** A box outside the view in which markup can be laid out and measured */
export function offscreenHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-20000px;top:0;visibility:hidden;width:max-content;white-space:nowrap";
  document.body.appendChild(host);
  return host;
}

export async function fontsSettled(host: Element): Promise<void> {
  // Forces the layout that makes the browser ask for the fonts.
  host.getBoundingClientRect();
  await document.fonts.ready;
}

function drawScale(width: number, height: number): number {
  return Math.min(SCALE, MAX_CANVAS_SIDE / Math.max(width, height));
}

/** The SVG on a white canvas */
export async function drawSvg(svg: string, width: number, height: number): Promise<HTMLCanvasElement> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("SVG image failed to load"));
    // A data URL: a blob URL would leave the canvas unreadable.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const scale = drawScale(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("no PNG");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The same PNG as canvasPng gives, right away. toBlob waits for the browser to be idle, which takes far longer than
 * encoding a formula, and the wait adds up over hundreds of them. For something large, not holding up the page matters more.
 */
function smallCanvasPng(canvas: HTMLCanvasElement): Uint8Array {
  const data = atob(canvas.toDataURL("image/png").split(",")[1]);
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
  return bytes;
}

/** A formula laid out on the page */
interface LaidOutEquation {
  /** Its place among the requests */
  index: number;
  cell: HTMLElement;
  root: HTMLElement;
  parts: Element[];
  /** Its box in px, with room around what's measured */
  width: number;
  height: number;
  /** Where the cell goes for the formula to fill that box */
  left: number;
  top: number;
  /** How far the box reaches below the baseline */
  descent: number;
  /** Where the box is in its batch */
  y: number;
}

/** Formulas drawn from one SVG */
interface EquationBatch {
  items: LaidOutEquation[];
  width: number;
  height: number;
}

function layOutEquation(request: EquationRequest, index: number, host: HTMLElement): LaidOutEquation | null {
  const cell = document.createElement("div");
  // All in the same place, so that each is measured just as if it were alone.
  cell.style.cssText = "position:absolute;left:0;top:0;width:max-content;white-space:nowrap";
  cell.style.fontSize = `${request.size}pt`;
  cell.style.color = request.color;
  try {
    cell.innerHTML = katex.renderToString(request.latex, {
      displayMode: request.display,
      throwOnError: true,
      strict: "ignore",
      trust: false,
      output: "html",
    });
  } catch {
    return null;
  }
  const root = cell.querySelector<HTMLElement>(".katex");
  const parts = root ? Array.from(root.querySelectorAll(".katex-base")) : [];
  if (!root || parts.length === 0) return null;
  root.style.fontSize = `${request.display ? EQUATION_EM.display : EQUATION_EM.inline}em`;
  cell.querySelector<HTMLElement>(".katex-display")?.style.setProperty("margin", "0");
  host.appendChild(cell);
  return { index, cell, root, parts, width: 0, height: 0, left: 0, top: 0, descent: 0, y: 0 };
}

/** Reads every formula before changing anything, so that the browser lays out the page only once or twice. */
function measureEquations(items: LaidOutEquation[]): void {
  const bottoms = items.map((item) => {
    // Each part of a formula has a strut from its height to its depth. What's inside can't tell: hidden tails of
    // roots and braces are hundreds of em wide, and the spacers of stacked parts stick out far above and below.
    const cellBox = item.cell.getBoundingClientRect();
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const part of item.parts) {
      const box = part.getBoundingClientRect();
      const strut = part.querySelector(":scope > .katex-strut")?.getBoundingClientRect() ?? box;
      left = Math.min(left, box.left);
      right = Math.max(right, box.right);
      top = Math.min(top, strut.top);
      bottom = Math.max(bottom, strut.bottom);
    }
    item.width = Math.ceil(right - left + 2 * EDGE);
    item.height = Math.ceil(bottom - top + 2 * EDGE);
    item.left = cellBox.left - left + EDGE;
    item.top = cellBox.top - top + EDGE;
    return bottom;
  });
  // A box without height stands on the baseline.
  const probes = items.map((item) => {
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    item.parts[0].appendChild(probe);
    return probe;
  });
  items.forEach((item, i) => {
    item.descent = bottoms[i] - probes[i].getBoundingClientRect().bottom + EDGE;
  });
  for (const probe of probes) probe.remove();
}

/** Below each other, as many as a canvas holds. One too large for that is alone and gets drawn smaller. */
function batchEquations(items: LaidOutEquation[]): EquationBatch[] {
  const batches: EquationBatch[] = [];
  let batch: EquationBatch | null = null;
  for (const item of items) {
    if (!batch || Math.max(batch.width, item.width, batch.height + item.height) * SCALE > MAX_CANVAS_SIDE) {
      batch = { items: [], width: 0, height: 0 };
      batches.push(batch);
    }
    item.y = batch.height;
    batch.items.push(item);
    batch.width = Math.max(batch.width, item.width);
    batch.height += item.height;
  }
  return batches;
}

async function batchSvg(batch: EquationBatch): Promise<string> {
  const styles = readKatexStyles();
  const families = new Set(batch.items.flatMap((item) => [...familiesIn(item.root, "*")]));
  const faces: string[] = [];
  for (const family of families) {
    for (const face of styles.fonts.get(family) ?? []) {
      const data = await fontDataUrl(face.url);
      faces.push(`@font-face{font-family:${family};${face.descriptors}src:url(${data}) format("${face.format}");}`);
    }
  }
  const objects = batch.items.map((item) => {
    const content = item.cell.cloneNode(true) as HTMLElement;
    content.style.position = "relative";
    content.style.left = `${item.left}px`;
    content.style.top = `${item.top}px`;
    content.style.visibility = "visible";
    const markup = new XMLSerializer().serializeToString(content);
    return `<foreignObject x="0" y="${item.y}" width="${item.width}" height="${item.height}">${markup}</foreignObject>`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${batch.width}" height="${batch.height}" viewBox="0 0 ${batch.width} ${batch.height}">` +
    `<style>${faces.join("")}${RESET}${escapeXml(styles.rules)}</style>${objects.join("")}</svg>`
  );
}

/**
 * An SVG costs far more to load than what's in it takes to draw, so formulas share one and get cut out of its canvas.
 * That gives the same pixels as an SVG for each.
 */
export async function equationImages(requests: EquationRequest[], report: ProgressReport): Promise<(ExportImage | null)[]> {
  const images: (ExportImage | null)[] = requests.map(() => null);
  const host = offscreenHost();
  try {
    const items = requests.flatMap((request, index) => layOutEquation(request, index, host) ?? []);
    await fontsSettled(host);
    measureEquations(items);
    let done = 0;
    const draw = async (batch: EquationBatch) => {
      const sheet = await drawSvg(await batchSvg(batch), batch.width, batch.height);
      const scale = drawScale(batch.width, batch.height);
      for (const item of batch.items) {
        const cut = document.createElement("canvas");
        cut.width = Math.ceil(item.width * scale);
        cut.height = Math.ceil(item.height * scale);
        cut.getContext("2d")?.drawImage(sheet, 0, item.y * scale, cut.width, cut.height, 0, 0, cut.width, cut.height);
        images[item.index] = {
          data: smallCanvasPng(cut),
          extension: "png",
          mediaType: "image/png",
          width: item.width,
          height: item.height,
          descent: item.descent,
        };
        done++;
        await report(done / requests.length);
      }
    };
    for (const batch of batchEquations(items)) {
      try {
        await draw(batch);
      } catch {
        // Whatever went wrong with the SVG of them all, each may still work by itself.
        for (const item of batch.items.filter((item) => !images[item.index])) {
          item.y = 0;
          await draw({ items: [item], width: item.width, height: item.height }).catch(() => {});
        }
      }
    }
  } catch {
    // What isn't drawn by now stays null.
  } finally {
    host.remove();
  }
  return images;
}

let tikzFonts: Promise<Map<string, string>> | null = null;

/** The URL of each TikZ font by family */
function readTikzFonts(): Promise<Map<string, string>> {
  tikzFonts ??= fetch(TIKZ_FONTS_CSS)
    .then((response) => (response.ok ? response.text() : ""))
    .then((css) => {
      const fonts = new Map<string, string>();
      for (const match of css.matchAll(/font-family:\s*([\w-]+);\s*src:\s*url\('([^']+)'\)/g)) {
        fonts.set(match[1], new URL(match[2], new URL(TIKZ_FONTS_CSS, location.href)).href);
      }
      return fonts;
    });
  return tikzFonts;
}

let tikzInstances = 0;

export async function tikzImage(source: TikzSource): Promise<ExportImage | null> {
  const host = offscreenHost();
  try {
    const result = await compileTikz(source, { persist: true });
    if (!result.ok) return null;
    // The colors the page gives it on a light background
    host.innerHTML = instantiateSvg(result.svg, `hwpx${++tikzInstances}`)
      .replaceAll("currentColor", "#000000")
      .replaceAll("var(--background)", "#ffffff");
    const svg = host.querySelector("svg");
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;

    const fonts = await readTikzFonts();
    let faces = "";
    for (const family of familiesIn(svg, "text, tspan")) {
      const url = fonts.get(family);
      if (url) faces += `@font-face{font-family:${family};src:url(${await fontDataUrl(url)});}`;
    }
    const width = Math.ceil(box.width);
    const height = Math.ceil(box.height);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = faces;
    svg.insertBefore(style, svg.firstChild);
    return {
      data: await canvasPng(await drawSvg(new XMLSerializer().serializeToString(svg), width, height)),
      extension: "png",
      mediaType: "image/png",
      width,
      height,
    };
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

async function figureImage(src: string): Promise<ExportImage | null> {
  let url: string | null = null;
  try {
    const response = await fetch(resolveAssetUrl(src));
    if (!response.ok) return null;
    const blob = await response.blob();
    url = URL.createObjectURL(blob);
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image failed to load"));
      image.src = url!;
    });
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width === 0 || height === 0) return null;
    const extension = KEPT_FILE_TYPES[blob.type];
    if (extension) {
      return { data: new Uint8Array(await blob.arrayBuffer()), extension, mediaType: blob.type, width, height };
    }
    // WebP and the like, which Hancom can't read
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    return { data: await canvasPng(canvas), extension: "png", mediaType: "image/png", width, height };
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

export const browserHwpxAssets: HwpxAssets = { equationImages, figureImage, tikzImage };
