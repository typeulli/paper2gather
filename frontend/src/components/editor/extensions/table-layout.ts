import { Extension } from "@tiptap/core";
import { TableRow } from "@tiptap/extension-table";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { columnResizingPluginKey } from "@tiptap/pm/tables";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/** Narrowest column (px) when resizing; columns without a set width keep the CSS min-width instead. */
export const TABLE_CELL_MIN_WIDTH = 32;
const ROW_MIN_HEIGHT = 24;
/** Distance from a horizontal cell border (px) at which the row resize handle appears. */
const ROW_HANDLE_SIZE = 5;

function validHeight(value: unknown): number | null {
  const n = typeof value === "string" ? parseInt(value, 10) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= ROW_MIN_HEIGHT && n <= 2000 ? Math.round(n) : null;
}

/** Table row with an optional minimum height (px), set by dragging its bottom border. */
export const PaperTableRow = TableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      height: {
        default: null,
        parseHTML: (el) => validHeight(el.style.height),
        renderHTML: (attrs) => {
          const height = validHeight(attrs.height);
          return height ? { style: `height: ${height}px` } : {};
        },
      },
    };
  },
});

interface RowResizeState {
  /** Position of the row whose bottom border is under the pointer, -1 if none */
  row: number;
  /** Live height while dragging */
  height: number | null;
}

const rowResizeKey = new PluginKey<RowResizeState>("tableRowResize");
const activeTableKey = new PluginKey("activeTable");

/** The row whose bottom border lies within the handle distance of the pointer, or -1. */
function rowBorderAt(view: EditorView, event: MouseEvent): number {
  const cell = event.target instanceof Element ? event.target.closest("td, th") : null;
  if (!(cell instanceof HTMLTableCellElement) || !view.dom.contains(cell)) return -1;
  const rect = cell.getBoundingClientRect();
  let rowEl: Element | null = null;
  if (rect.bottom - event.clientY <= ROW_HANDLE_SIZE) {
    // A cell spanning rows ends at the bottom of its last row.
    rowEl = cell.parentElement;
    for (let i = 1; i < cell.rowSpan && rowEl; i++) rowEl = rowEl.nextElementSibling;
  } else if (event.clientY - rect.top <= ROW_HANDLE_SIZE) {
    rowEl = cell.parentElement?.previousElementSibling ?? null;
  }
  if (!rowEl) return -1;
  const pos = view.posAtDOM(rowEl, 0) - 1;
  return view.state.doc.nodeAt(pos)?.type.name === "tableRow" ? pos : -1;
}

function setRowState(view: EditorView, value: Partial<RowResizeState>) {
  view.dispatch(view.state.tr.setMeta(rowResizeKey, value));
}

function columnHandleActive(state: EditorState): boolean {
  return (columnResizingPluginKey.getState(state)?.activeHandle ?? -1) > -1;
}

function startRowDrag(view: EditorView, event: MouseEvent, row: number) {
  const rowEl = view.nodeDOM(row);
  if (!(rowEl instanceof HTMLElement)) return;
  // The page may be shown shrunk: the pointer moves in screen px, heights are CSS px.
  const scale = view.dom.getBoundingClientRect().width / view.dom.offsetWidth || 1;
  const startY = event.clientY;
  const startHeight = rowEl.getBoundingClientRect().height / scale;
  const heightAt = (e: MouseEvent) => Math.max(ROW_MIN_HEIGHT, Math.round(startHeight + (e.clientY - startY) / scale));
  setRowState(view, { height: startHeight });

  const move = (e: MouseEvent) => {
    if (e.buttons === 0) return finish(e);
    setRowState(view, { height: heightAt(e) });
  };
  const finish = (e: MouseEvent) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", finish);
    const { row: current } = rowResizeKey.getState(view.state) ?? { row: -1 };
    const node = current >= 0 ? view.state.doc.nodeAt(current) : null;
    const tr = view.state.tr.setMeta(rowResizeKey, { height: null });
    if (node?.type.name === "tableRow") tr.setNodeMarkup(current, undefined, { ...node.attrs, height: heightAt(e) });
    view.dispatch(tr);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", finish);
}

/**
 * HWP-like table editing aids:
 * - the table holding the caret shows its invisible cell borders as dashed guides;
 * - dragging a column border changes column widths (prosemirror-tables' column resizing, enabled
 *   in the table config) and dragging a row border changes the row's height.
 */
export const TableLayout = Extension.create({
  name: "tableLayout",
  // Runs before the table plugins so a row drag does not also start a cell selection.
  priority: 110,

  addProseMirrorPlugins() {
    const activeTable = new Plugin({
      key: activeTableKey,
      props: {
        decorations: (state) => {
          const { $from } = state.selection;
          for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type.spec.tableRole === "table") {
              const pos = $from.before(depth);
              return DecorationSet.create(state.doc, [
                Decoration.node(pos, pos + $from.node(depth).nodeSize, { class: "table-active" }),
              ]);
            }
          }
          return null;
        },
      },
    });

    const rowResize = new Plugin<RowResizeState>({
      key: rowResizeKey,
      state: {
        init: () => ({ row: -1, height: null }),
        apply: (tr, value) => {
          const meta = tr.getMeta(rowResizeKey) as Partial<RowResizeState> | undefined;
          let next = value;
          if (tr.docChanged && next.row >= 0) next = { ...next, row: tr.mapping.map(next.row, -1) };
          if (meta) next = { ...next, ...meta };
          return next;
        },
      },
      props: {
        // A column border under the pointer (e.g. in a cell corner) takes precedence.
        attributes: (state): Record<string, string> =>
          (rowResizeKey.getState(state)?.row ?? -1) >= 0 && !columnHandleActive(state) ? { class: "row-resize-cursor" } : {},
        decorations: (state) => {
          const { row, height } = rowResizeKey.getState(state) ?? { row: -1, height: null };
          if (height === null && columnHandleActive(state)) return null;
          const node = row >= 0 ? state.doc.nodeAt(row) : null;
          if (node?.type.name !== "tableRow") return null;
          const attrs: Record<string, string> = { class: "row-resize-target" };
          if (height !== null) attrs.style = `height: ${height}px`;
          return DecorationSet.create(state.doc, [Decoration.node(row, row + node.nodeSize, attrs)]);
        },
        handleDOMEvents: {
          mousemove(view, event) {
            const state = rowResizeKey.getState(view.state);
            if (!state || state.height !== null || !view.editable) return false;
            const row = rowBorderAt(view, event);
            if (row !== state.row) setRowState(view, { row });
            return false;
          },
          mouseleave(view) {
            const state = rowResizeKey.getState(view.state);
            if (state && state.row >= 0 && state.height === null) setRowState(view, { row: -1 });
            return false;
          },
          mousedown(view, event) {
            const state = rowResizeKey.getState(view.state);
            if (!state || state.row < 0 || event.button !== 0 || columnHandleActive(view.state)) return false;
            event.preventDefault();
            startRowDrag(view, event, state.row);
            return true;
          },
        },
      },
    });

    return [activeTable, rowResize];
  },
});
