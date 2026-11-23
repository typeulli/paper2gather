import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { PAGE, type PageGeometry } from "@/lib/paper/page";

/**
 * Splits the paper into pages on screen, like a word processor's page view. The article
 * (`.paper-page`) is laid out as stacked pages of the document's page size (`getPage`), page.gap apart,
 * with the page margins as its padding; content that would cross the bottom margin of a page is pushed
 * to the top of the next one by spacers:
 * - a widget before a block, or before the first line of a paragraph that does not fit;
 * - extra space at the top of a table row (only tables taller than a page are split between rows,
 *   marked `page-split` for printing);
 * - a widget at the end of the document (moving the reference list) and padding on references.
 * Only the view changes, the document stays the same. The page sheets are drawn by the workspace
 * from the reported page count. The workspace may shrink the article with a transform: positions are
 * measured on screen and converted to the article's own px.
 *
 * Printing doesn't use this: the browser paginates with the same page size and margins (see
 * globals.css), so the spacers are screen-only.
 */

export interface PaginationOptions {
  onPageCount: (count: number) => void;
  /** The document's page; read on every layout */
  getPage: () => PageGeometry;
  /** Calls the listener when the page may have changed (the document format) */
  subscribePage: (listener: () => void) => () => void;
}

type BreakKind = "block" | "line" | "row" | "end" | "reference";

/** Where content can be pushed down to the next page */
type Anchor =
  /** Spacer before the block */
  | { kind: "block"; pos: number; el: HTMLElement }
  /** Spacer before the line of a paragraph that starts at the probe point (or before the paragraph) */
  | { kind: "line"; probe: { left: number; top: number }; from: number; to: number; block: BlockAnchor; blockTop: number }
  /** Space at the top of the row's cells */
  | { kind: "row"; pos: number; el: HTMLElement }
  /** Spacer at the end of the document, moving the reference list */
  | { kind: "end"; el: HTMLElement }
  /** Top padding of a reference list item */
  | { kind: "reference"; el: HTMLElement };

type BlockAnchor = Extract<Anchor, { kind: "block" }>;

/** A piece of the paper that stays on one page (a block, a line, a table row, a reference) */
interface Unit {
  /** Position without spacers, relative to the top of the article */
  top: number;
  bottom: number;
  anchor: Anchor | null;
  /** Keep on the same page as the next unit (headings) */
  keepWithNext?: boolean;
}

interface Break {
  kind: BreakKind;
  /** Document position of the spacer (-1 outside the document) */
  pos: number;
  /** Element showing where the moved content starts (block, end, reference) */
  el: HTMLElement;
  /** Spacer size (px) */
  height: number;
  /** Top of the page content area the moved content should start at */
  target: number;
  /** How far the content after the break moves */
  moved: number;
  /** The widget, once rendered */
  spacer?: HTMLElement;
}

const paginationKey = new PluginKey<DecorationSet>("pagination");
const CONTAINERS = new Set(["bulletList", "orderedList", "listItem", "blockquote"]);
const SPACER = "page-break";
/** Class of the article while measuring: hides the spacers */
const MEASURING = "paginating";
const EPS = 0.5;
/** Printing moves whatever crosses the bottom margin by more than rounding (a layout unit is 1/64 px). */
const FIT_EPS = 1 / 32;

/** Where the pages of a layout are, in article px */
class PageLayout {
  readonly stride: number;
  readonly contentHeight: number;

  constructor(readonly page: PageGeometry) {
    this.stride = page.height + page.gap;
    this.contentHeight = page.height - page.margin.top - page.margin.bottom;
  }

  contentTopOf(index: number): number {
    return index * this.stride + this.page.margin.top;
  }

  contentBottomOf(index: number): number {
    return index * this.stride + this.page.height - this.page.margin.bottom;
  }
}

const pageKeyOf = (page: PageGeometry) =>
  [page.width, page.height, page.margin.top, page.margin.right, page.margin.bottom, page.margin.left].join();

function px(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

const isWidget = (b: { kind: string }) => b.kind === "block" || b.kind === "line" || b.kind === "end";

/** Compares spacers by position (and size for rows, which are only resized by new decorations). */
function signature(items: { kind: string; pos: number; height: number }[]): string {
  return items
    .map((i) => (i.kind === "row" ? `${i.kind}:${i.pos}:${Math.round(i.height)}` : `${i.kind}:${i.pos}`))
    .sort()
    .join();
}

/**
 * Line boxes of a textblock in client coordinates, estimated from its text (and formulas) plus the
 * half-leading. `scale`: on-screen size of a CSS px.
 */
function lineBoxes(el: HTMLElement, scale: number): { top: number; bottom: number; left: number }[] {
  const rects: DOMRect[] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (!(node instanceof Element)) return NodeFilter.FILTER_ACCEPT;
      // A formula is one box; its inner layout boxes would look like extra lines.
      if (node.classList.contains("katex")) {
        rects.push(...node.getClientRects());
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });
  while (walker.nextNode()) {
    range.selectNodeContents(walker.currentNode);
    rects.push(...range.getClientRects());
  }

  const lines: { top: number; bottom: number; left: number }[] = [];
  for (const r of rects.filter((r) => r.height > 1 && r.width > 0).sort((a, b) => a.top - b.top)) {
    const last = lines.at(-1);
    if (last && r.top < last.bottom - 2) {
      last.top = Math.min(last.top, r.top);
      last.bottom = Math.max(last.bottom, r.bottom);
      last.left = Math.min(last.left, r.left);
    } else {
      lines.push({ top: r.top, bottom: r.bottom, left: r.left });
    }
  }
  const lineHeight = px(getComputedStyle(el).lineHeight) * scale;
  for (const line of lines) {
    const leading = Math.max(0, (lineHeight - (line.bottom - line.top)) / 2);
    line.top -= leading;
    line.bottom += leading;
  }
  // Line boxes follow each other without gaps.
  for (let i = 1; i < lines.length; i++) {
    const edge = (lines[i - 1].bottom + lines[i].top) / 2;
    lines[i - 1].bottom = edge;
    lines[i].top = edge;
  }
  return lines;
}

/** The previous sibling taking part in layout (spacers are hidden while measuring). */
function previousVisible(el: Element): Element | null {
  let prev = el.previousElementSibling;
  while (prev && getComputedStyle(prev).display === "none") prev = prev.previousElementSibling;
  return prev;
}

class PaginationView {
  private frame = 0;
  /** Positions of the table figures split between rows, found by `measure` */
  private splitTables: number[] = [];
  private count = 0;
  /** On-screen size of a CSS px of the article */
  private scale = 1;
  /** References with top padding */
  private padded: HTMLElement[] = [];
  private readonly resizes = new ResizeObserver(() => this.schedule());
  /** Reordered or edited references don't always change the list's size. */
  private readonly mutations = new MutationObserver(() => this.schedule());
  private observedReferences: Element | null = null;
  /** The pages of the last layout */
  private layout = new PageLayout(PAGE);
  private pageKey = "";
  private readonly unsubscribePage: () => void;

  constructor(
    private readonly view: EditorView,
    private readonly options: PaginationOptions
  ) {
    this.resizes.observe(view.dom);
    document.fonts.addEventListener("loadingdone", this.schedule);
    // Changed margins don't always resize the editor.
    this.unsubscribePage = options.subscribePage(() => {
      if (pageKeyOf(options.getPage()) !== this.pageKey) this.schedule();
    });
    this.schedule();
  }

  update(view: EditorView, prevState: EditorView["state"]) {
    if (view.state.doc !== prevState.doc) this.schedule();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.resizes.disconnect();
    this.mutations.disconnect();
    this.unsubscribePage();
    document.fonts.removeEventListener("loadingdone", this.schedule);
    for (const el of this.padded) el.style.removeProperty("--page-break");
  }

  private schedule = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.run();
    });
  };

  private run() {
    const { view } = this;
    const article = view.dom.closest<HTMLElement>(".paper-page");
    if (!article || view.isDestroyed) return;

    const page = this.options.getPage();
    this.layout = new PageLayout(page);
    this.pageKey = pageKeyOf(page);
    this.scale = article.getBoundingClientRect().width / page.width || 1;

    // 1. Where the pages break in the layout without spacers
    article.classList.add(MEASURING);
    let origin = article.getBoundingClientRect().top;
    const units = this.measure(article, origin);
    const { breaks, end } = this.paginate(units);
    article.classList.remove(MEASURING);

    // 2. Spacers there
    const current = paginationKey.getState(view.state)?.find() ?? [];
    const rendered = current.map((d) => ({ kind: d.spec.pageBreak as string, pos: d.from, height: d.spec.height as number }));
    const splits = this.splitTables.map((pos) => ({ kind: "split", pos, height: 0 }));
    if (signature(rendered) !== signature([...breaks, ...splits])) {
      view.dispatch(view.state.tr.setMeta(paginationKey, this.decorations(breaks)));
    }
    const widgets = breaks.filter(isWidget);
    const spacers = view.dom.querySelectorAll<HTMLElement>(`.${SPACER}`);
    if (spacers.length === widgets.length) widgets.forEach((b, i) => (b.spacer = spacers[i]));
    for (const el of this.padded) el.style.removeProperty("--page-break");
    this.padded = breaks.filter((b) => b.kind === "reference").map((b) => b.el);
    for (const b of breaks) this.applyHeight(b);

    // 3. Margins that stop collapsing next to a spacer make the estimates slightly off: measure the
    // result once and correct it, in order (a correction moves everything after it).
    origin = article.getBoundingClientRect().top;
    const actual = breaks.map((b) => this.contentTop(b, origin));
    let shift = 0;
    breaks.forEach((b, i) => {
      const top = actual[i];
      if (top === null) return;
      const height = Math.max(0, b.height + b.target - (top + shift));
      if (Math.abs(height - b.height) <= EPS) return;
      shift += height - b.height;
      b.height = height;
      this.applyHeight(b);
    });

    const count = Math.max(1, Math.floor((end + shift) / this.layout.stride) + 1);
    if (count !== this.count) {
      this.count = count;
      this.options.onPageCount(count);
    }
  }

  private applyHeight(b: Break) {
    if (b.kind === "reference") b.el.style.setProperty("--page-break", `${b.height}px`);
    else if (b.spacer) b.spacer.style.height = `${b.height}px`;
  }

  /** Article px from the top of the article at client y `origin` */
  private offset(clientY: number, origin: number): number {
    return (clientY - origin) / this.scale;
  }

  /** Where the content moved by a break starts now; null if it can't be corrected. */
  private contentTop(b: Break, origin: number): number | null {
    switch (b.kind) {
      case "block": {
        const dom = b.spacer && this.view.nodeDOM(b.pos);
        return dom instanceof HTMLElement ? this.offset(dom.getBoundingClientRect().top, origin) : null;
      }
      case "line":
        return b.spacer ? this.offset(b.spacer.getBoundingClientRect().bottom, origin) : null;
      case "end":
        return b.spacer ? this.offset(b.el.getBoundingClientRect().top, origin) : null;
      case "reference":
        return this.offset(b.el.getBoundingClientRect().top, origin) + b.height;
      case "row":
        // Resized by new decorations only (row attributes belong to the editor's DOM).
        return null;
    }
  }

  private decorations(breaks: Break[]): DecorationSet {
    const { doc } = this.view.state;
    const decorations: Decoration[] = [];
    for (const pos of this.splitTables) {
      const node = doc.nodeAt(pos);
      if (node) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "page-split" }, { pageBreak: "split", height: 0 }));
    }
    for (const b of breaks) {
      const spec = { pageBreak: b.kind, height: b.height };
      if (b.kind === "row") {
        const row = doc.nodeAt(b.pos);
        if (!row) continue;
        decorations.push(
          Decoration.node(b.pos, b.pos + row.nodeSize, { class: "page-break-row", style: `--page-break: ${b.height}px` }, spec)
        );
      } else if (isWidget(b)) {
        const toDOM = () => {
          const el = document.createElement(b.kind === "line" ? "span" : "div");
          el.className = SPACER;
          el.contentEditable = "false";
          el.setAttribute("aria-hidden", "true");
          el.style.height = `${b.height}px`;
          return el;
        };
        decorations.push(
          Decoration.widget(b.pos, toDOM, {
            ...spec,
            side: b.kind === "end" ? 1 : -1,
            key: `${SPACER}:${b.kind}:${b.pos}`,
            ignoreSelection: true,
          })
        );
      }
    }
    return DecorationSet.create(doc, decorations);
  }

  private measure(article: HTMLElement, origin: number): Unit[] {
    const units: Unit[] = [];
    this.splitTables = [];
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { top: this.offset(r.top, origin), bottom: this.offset(r.bottom, origin) };
    };

    const header = article.querySelector(":scope > header");
    if (header) {
      this.resizes.observe(header);
      units.push({ ...box(header), anchor: null });
    }

    /** `outer`: anchor to use for the node's first unit (the list item around its first paragraph) */
    const visit = (node: PMNode, pos: number, outer: BlockAnchor | null) => {
      const dom = this.view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return;
      const self: BlockAnchor = outer ?? { kind: "block", pos, el: dom };
      if (CONTAINERS.has(node.type.name)) {
        // Breaking before a list item keeps its marker with its text.
        node.forEach((child, offset, index) =>
          visit(child, pos + 1 + offset, node.type.name === "listItem" && index === 0 ? self : null)
        );
        return;
      }
      const { top, bottom } = box(dom);

      const table = node.type.name === "tableFigure" ? node.firstChild : node.type.spec.tableRole === "table" ? node : null;
      if (table && bottom - top > this.layout.contentHeight) {
        // Too tall for a page: split between rows.
        const tablePos = table === node ? pos : pos + 1;
        const rows: Unit[] = [];
        table.forEach((row, offset) => {
          const rowPos = tablePos + 1 + offset;
          const tr = this.view.nodeDOM(rowPos);
          if (!(tr instanceof HTMLElement)) return;
          rows.push({ ...box(tr), anchor: rows.length ? { kind: "row", pos: rowPos, el: tr } : self });
        });
        if (rows.length) {
          if (table !== node) this.splitTables.push(pos);
          rows[0].top = top;
          rows[rows.length - 1].bottom = bottom;
          units.push(...rows);
          return;
        }
      }

      const lines = node.isTextblock && !node.type.spec.code && node.type.name !== "heading" ? lineBoxes(dom, this.scale) : [];
      if (lines.length <= 1) {
        units.push({ top, bottom, anchor: self, keepWithNext: node.type.name === "heading" });
        return;
      }
      lines.forEach((line, i) => {
        units.push({
          top: i === 0 ? top : this.offset(line.top, origin),
          bottom: i === lines.length - 1 ? bottom : this.offset(line.bottom, origin),
          anchor:
            i === 0
              ? self
              : {
                  kind: "line",
                  probe: { left: line.left + 1, top: (line.top + line.bottom) / 2 },
                  from: pos + 1,
                  to: pos + node.nodeSize - 1,
                  block: self,
                  blockTop: top,
                },
        });
      });
    };
    this.view.state.doc.forEach((node, offset) => visit(node, offset, null));

    const references = article.querySelector<HTMLElement>(":scope > section");
    if (references) {
      if (this.observedReferences !== references) {
        this.observedReferences = references;
        this.resizes.observe(references);
        this.mutations.disconnect();
        this.mutations.observe(references, { childList: true, subtree: true, characterData: true });
      }
      const items = Array.from(references.querySelectorAll<HTMLElement>("li"));
      // The section title stays with the first reference.
      const title = items.length ? (references.firstElementChild ?? references) : references;
      units.push({
        top: box(references).top,
        bottom: box(title).bottom,
        anchor: { kind: "end", el: references },
        keepWithNext: items.length > 0,
      });
      for (const li of items) units.push({ ...box(li), anchor: { kind: "reference", el: li } });
    }
    return units;
  }

  private paginate(units: Unit[]): { breaks: Break[]; end: number } {
    const breaks: Break[] = [];
    const { layout } = this;
    let shift = 0;
    let end = 0;

    units.forEach((unit, i) => {
      const top = unit.top + shift;
      let bottom = unit.bottom + shift;
      const page = Math.max(0, Math.floor(top / layout.stride));
      const next = units[i + 1];
      const fitBottom =
        unit.keepWithNext && next && next.bottom - next.top < layout.contentHeight
          ? Math.max(bottom, next.bottom + shift)
          : bottom;

      let target: number | null = null;
      // Starts in a top margin (after something taller than a page)
      if (top < layout.contentTopOf(page) - EPS) target = layout.contentTopOf(page);
      // Doesn't fit in the rest of the page
      else if (top > layout.contentTopOf(page) + EPS && fitBottom > layout.contentBottomOf(page) + FIT_EPS) {
        target = layout.contentTopOf(page + 1);
      }

      if (target !== null && unit.anchor) {
        const b = this.breakFor(unit.anchor, target, top, shift);
        if (b) {
          breaks.push(b);
          shift += b.moved;
          bottom += b.moved;
        }
      }
      end = Math.max(end, bottom);
    });
    return { breaks, end };
  }

  /** A break moving the content at `top` (`shift` = moves so far) to `target`. */
  private breakFor(anchor: Anchor, target: number, top: number, shift: number): Break {
    const moved = target - top;
    switch (anchor.kind) {
      case "block": {
        // With the spacer in between, this block's top margin no longer collapses with the previous
        // block's bottom margin.
        const prev = previousVisible(anchor.el);
        const marginTop = px(getComputedStyle(anchor.el).marginTop);
        const extra = prev ? Math.min(px(getComputedStyle(prev).marginBottom), marginTop) : marginTop;
        return { kind: "block", pos: anchor.pos, el: anchor.el, height: Math.max(0, moved - extra), target, moved };
      }
      case "line": {
        const hit = this.view.posAtCoords(anchor.probe);
        // A formula or citation starting the line is hit inside.
        const pos = hit && (hit.inside >= 0 && this.view.state.doc.nodeAt(hit.inside)?.isInline ? hit.inside : hit.pos);
        if (pos == null || pos <= anchor.from || pos > anchor.to) {
          return this.breakFor(anchor.block, target, anchor.blockTop + shift, shift);
        }
        return { kind: "line", pos, el: anchor.block.el, height: moved, target, moved };
      }
      case "row":
        return { kind: "row", pos: anchor.pos, el: anchor.el, height: moved, target, moved };
      case "end":
        return { kind: "end", pos: this.view.state.doc.content.size, el: anchor.el, height: moved, target, moved };
      case "reference":
        return { kind: "reference", pos: -1, el: anchor.el, height: moved, target, moved };
    }
  }
}

export const Pagination = Extension.create<PaginationOptions>({
  name: "pagination",

  addOptions() {
    return { onPageCount: () => {}, getPage: () => PAGE, subscribePage: () => () => {} };
  },

  addProseMirrorPlugins() {
    const { options } = this;
    return [
      new Plugin<DecorationSet>({
        key: paginationKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set) => (tr.getMeta(paginationKey) as DecorationSet | undefined) ?? set.map(tr.mapping, tr.doc),
        },
        props: {
          decorations: (state) => paginationKey.getState(state),
        },
        view: (view) => new PaginationView(view, options),
      }),
    ];
  },
});
