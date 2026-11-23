import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { shortId } from "@/lib/ids";
import { defaultFormat, type PaperFormat } from "@/lib/paper/format";
import {
  computeNumbering,
  defaultLabel,
  NUMBERED_NODE_KINDS,
  type NumberingSnapshot,
  type NumberingStore,
} from "@/lib/paper/numbering";

interface NumberingPluginState {
  snapshot: NumberingSnapshot;
  decorations: DecorationSet;
}

export const numberingKey = new PluginKey<NumberingPluginState>("numbering");
const uniqueIdsKey = new PluginKey("uniqueIds");

/** Dispatch after format settings that influence numbering change. */
export function refreshNumbering(tr: Transaction): Transaction {
  return tr.setMeta(numberingKey, "refresh");
}

function headingDecorations(doc: PMNode, snapshot: NumberingSnapshot): DecorationSet {
  const decorations: Decoration[] = [];
  for (const obj of snapshot.objects) {
    if (obj.kind !== "section" || !obj.shown) continue;
    const number = obj.shown;
    decorations.push(
      Decoration.widget(
        obj.pos + 1,
        () => {
          const span = document.createElement("span");
          span.className = "heading-number";
          span.contentEditable = "false";
          span.textContent = number;
          return span;
        },
        { side: -1, key: `heading-number-${number}`, ignoreSelection: true }
      )
    );
  }
  return DecorationSet.create(doc, decorations);
}

export interface NumberingOptions {
  store: NumberingStore | null;
  getFormat: () => PaperFormat;
}

/**
 * - Assigns unique ids/labels to headings, equations, figures and tables
 *   (also fixes duplicates created by copy & paste).
 * - Computes the numbering of all numbered objects and publishes it to a store.
 * - Renders section numbers in front of headings.
 */
export const Numbering = Extension.create<NumberingOptions>({
  name: "numbering",

  addOptions() {
    return { store: null, getFormat: () => defaultFormat() };
  },

  addProseMirrorPlugins() {
    const { store, getFormat } = this.options;

    const build = (doc: PMNode): NumberingPluginState => {
      const snapshot = computeNumbering(doc, getFormat());
      return { snapshot, decorations: headingDecorations(doc, snapshot) };
    };

    const uniqueIds = new Plugin({
      key: uniqueIdsKey,
      appendTransaction(transactions, _oldState, state) {
        if (!transactions.some((tr) => tr.docChanged)) return null;
        const seenIds = new Set<string>();
        const seenLabels = new Set<string>();
        const fixes: { pos: number; attrs: Record<string, unknown> }[] = [];
        state.doc.descendants((node, pos) => {
          const kind = NUMBERED_NODE_KINDS[node.type.name];
          if (!kind) return !node.isAtom;
          const id = node.attrs.id as string | null;
          const label = node.attrs.label as string | null;
          if (!id || seenIds.has(id) || !label || seenLabels.has(label)) {
            const newId = !id || seenIds.has(id) ? shortId() : id;
            const keepLabel = label && !seenLabels.has(label) && label !== defaultLabel(kind, id ?? "");
            const newLabel = keepLabel ? label : defaultLabel(kind, newId);
            fixes.push({ pos, attrs: { ...node.attrs, id: newId, label: newLabel } });
            seenIds.add(newId);
            seenLabels.add(newLabel);
          } else {
            seenIds.add(id);
            seenLabels.add(label);
          }
          // Numbered nodes never nest, except a table figure whose cells may hold anything.
          return kind === "table";
        });
        if (fixes.length === 0) return null;
        const tr = state.tr;
        // setNodeMarkup keeps node sizes, so the collected positions stay valid.
        for (const fix of fixes) tr.setNodeMarkup(fix.pos, undefined, fix.attrs);
        return tr.setMeta("addToHistory", false);
      },
    });

    const numbering = new Plugin<NumberingPluginState>({
      key: numberingKey,
      state: {
        init: (_config, state) => build(state.doc),
        apply: (tr, value, _oldState, newState) =>
          tr.docChanged || tr.getMeta(numberingKey) === "refresh" ? build(newState.doc) : value,
      },
      props: {
        decorations: (state) => numberingKey.getState(state)?.decorations,
      },
      view: (view) => {
        const publish = () => {
          const snapshot = numberingKey.getState(view.state)?.snapshot;
          if (snapshot) store?.set(snapshot);
        };
        publish();
        return { update: publish };
      },
    });

    return [uniqueIds, numbering];
  },
});
