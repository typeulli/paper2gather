/** Reading the parts of an HWPX (OWPML) package: package manifest, header styles and sections. */

export type XmlParser = (xml: string) => Document;

/** Element children, optionally only those with the given local name (namespaces vary by version). */
export function elements(parent: Element | Document, name?: string): Element[] {
  const result: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && (!name || (node as Element).localName === name)) result.push(node as Element);
  }
  return result;
}

export function element(parent: Element | Document, name: string): Element | null {
  return elements(parent, name)[0] ?? null;
}

export function descendants(parent: Element | Document, name: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS("*", name));
}

export function intAttr(el: Element | null, name: string, fallback = 0): number {
  const n = parseInt(el?.getAttribute(name) ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface CharShape {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  superscript: boolean;
  subscript: boolean;
  /** #rrggbb, null for black/automatic */
  color: string | null;
  /** 1/100 pt */
  height: number;
}

export interface ParaShape {
  align: "left" | "center" | "right" | "justify";
  /** NONE, OUTLINE (개요), NUMBER or BULLET */
  headingType: string;
  /** 0-based outline/list level */
  headingLevel: number;
}

export interface StyleDef {
  name: string;
  engName: string;
}

export interface HwpxHeader {
  charShapes: Map<string, CharShape>;
  paraShapes: Map<string, ParaShape>;
  styles: Map<string, StyleDef>;
}

export interface BinaryItem {
  path: string;
  mediaType: string;
}

export interface HwpxPackage {
  header: HwpxHeader;
  sections: Document[];
  /** Embedded binaries (images) by manifest id */
  binaries: Map<string, BinaryItem>;
  files: Record<string, Uint8Array>;
}

const LINE_SHAPES = new Set([
  "SOLID", "DASH", "DOT", "DASH_DOT", "DASH_DOT_DOT", "LONG_DASH", "CIRCLE", "DOUBLE_SLIM", "SLIM_THICK",
  "THICK_SLIM", "SLIM_THICK_SLIM", "WAVE", "DOUBLE_WAVE", "DOUBLEWAVE",
]);

const ALIGNS: Record<string, ParaShape["align"]> = {
  LEFT: "left",
  CENTER: "center",
  RIGHT: "right",
  JUSTIFY: "justify",
  DISTRIBUTE: "justify",
  DISTRIBUTE_SPACE: "justify",
};

function parseHeader(doc: Document): HwpxHeader {
  const charShapes = new Map<string, CharShape>();
  for (const el of descendants(doc, "charPr")) {
    const color = (el.getAttribute("textColor") ?? "").toLowerCase();
    charShapes.set(el.getAttribute("id") ?? "", {
      bold: element(el, "bold") !== null,
      italic: element(el, "italic") !== null,
      underline: element(el, "underline")?.getAttribute("type") === "BOTTOM",
      strike: LINE_SHAPES.has(element(el, "strikeout")?.getAttribute("shape") ?? "NONE"),
      superscript: element(el, "supscript") !== null,
      subscript: element(el, "subscript") !== null,
      color: /^#[0-9a-f]{6}$/.test(color) && color !== "#000000" ? color : null,
      height: intAttr(el, "height", 1000),
    });
  }
  const paraShapes = new Map<string, ParaShape>();
  for (const el of descendants(doc, "paraPr")) {
    const heading = element(el, "heading");
    paraShapes.set(el.getAttribute("id") ?? "", {
      align: ALIGNS[element(el, "align")?.getAttribute("horizontal") ?? ""] ?? "justify",
      headingType: heading?.getAttribute("type") ?? "NONE",
      headingLevel: intAttr(heading, "level"),
    });
  }
  const styles = new Map<string, StyleDef>();
  for (const el of descendants(doc, "style")) {
    styles.set(el.getAttribute("id") ?? "", {
      name: el.getAttribute("name") ?? "",
      engName: el.getAttribute("engName") ?? "",
    });
  }
  return { charShapes, paraShapes, styles };
}

function decode(data: Uint8Array | undefined): string {
  return data ? new TextDecoder("utf-8").decode(data) : "";
}

/** Throws a user-facing (Korean) message when the file is not an HWPX document. */
export function readPackage(files: Record<string, Uint8Array>, parseXml: XmlParser): HwpxPackage {
  const mimetype = decode(files["mimetype"]).trim();
  if (mimetype && mimetype !== "application/hwp+zip") throw new Error("HWPX 문서가 아닙니다.");
  const container = files["META-INF/container.xml"] ? parseXml(decode(files["META-INF/container.xml"])) : null;
  const rootfile =
    (container &&
      descendants(container, "rootfile")
        .find((el) => el.getAttribute("media-type") === "application/hwpml-package+xml")
        ?.getAttribute("full-path")) ||
    "Contents/content.hpf";
  if (!files[rootfile]) throw new Error("HWPX 문서가 아니거나 손상된 파일입니다.");
  const opf = parseXml(decode(files[rootfile]));
  const baseDir = rootfile.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/") + 1) : "";
  // Hancom writes hrefs relative to the package root; the OPF spec makes them relative to the OPF.
  const resolve = (href: string) => (files[href] ? href : files[baseDir + href] ? baseDir + href : null);

  const items = new Map<string, { path: string | null; mediaType: string }>();
  for (const el of descendants(opf, "item")) {
    items.set(el.getAttribute("id") ?? "", {
      path: resolve(el.getAttribute("href") ?? ""),
      mediaType: el.getAttribute("media-type") ?? "",
    });
  }
  const headerPath =
    items.get("header")?.path ?? Object.keys(files).find((name) => /(^|\/)header\.xml$/i.test(name)) ?? null;
  if (!headerPath) throw new Error("HWPX 문서의 스타일 정보(header.xml)를 찾을 수 없습니다.");

  const spine = descendants(opf, "itemref").map((el) => items.get(el.getAttribute("idref") ?? "")?.path);
  let sectionPaths = spine.filter((p): p is string => !!p && /section\d+\.xml$/i.test(p));
  if (sectionPaths.length === 0) {
    sectionPaths = Object.keys(files)
      .filter((name) => /(^|\/)section\d+\.xml$/i.test(name))
      .sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)![1]) - Number(/(\d+)\.xml$/i.exec(b)![1]));
  }
  if (sectionPaths.length === 0) throw new Error("HWPX 문서에 본문(section)이 없습니다.");

  const binaries = new Map<string, BinaryItem>();
  for (const [id, item] of items) {
    if (item.path && /^bindata\//i.test(item.path)) binaries.set(id, { path: item.path, mediaType: item.mediaType });
  }

  return {
    header: parseHeader(parseXml(decode(files[headerPath]))),
    sections: sectionPaths.map((p) => parseXml(decode(files[p]))),
    binaries,
    files,
  };
}
