import { mergeAttributes, Node, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { toast } from "sonner";
import { revealPos } from "@/lib/editor-utils";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    appendixBreak: {
      /** Starts the appendix after the top-level block at the selection; fails if the document has one. */
      insertAppendixBreak: () => ReturnType;
    };
  }
}

const NAME = "appendixBreak";

/** Position of the appendix break (the first one, should a paste or merge add another), or -1. */
export function appendixBreakPos(doc: PMNode): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === NAME) found = pos;
    return found < 0;
  });
  return found;
}

/** Inserts the appendix break, or shows the existing one: a document has a single appendix. */
export function startAppendix(editor: Editor): void {
  const pos = appendixBreakPos(editor.state.doc);
  if (pos < 0) {
    editor.chain().focus().insertAppendixBreak().run();
    return;
  }
  revealPos(editor, pos);
  toast.info("부록은 이미 시작되었습니다. 이 구분선 뒤의 제목 1이 부록 A, B…가 됩니다.");
}

/**
 * Where the appendix starts (like LaTeX's \appendix): the following level-1 headings become
 * appendices A, B … that number their equations, figures and tables anew. Shown on screen only.
 */
export const AppendixBreak = Node.create({
  name: NAME,
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  parseHTML() {
    return [{ tag: 'div[data-type="appendix-break"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "appendix-break" }, HTMLAttributes)];
  },

  addNodeView() {
    return () => {
      const dom = document.createElement("div");
      dom.className = "appendix-break";
      dom.dataset.type = "appendix-break";
      dom.textContent = "부록 시작";
      return { dom };
    };
  },

  addCommands() {
    return {
      insertAppendixBreak:
        () =>
        ({ state, tr, dispatch }) => {
          if (appendixBreakPos(state.doc) >= 0) return false;
          if (!dispatch) return true;
          const { $from } = tr.selection;
          const start = $from.depth > 0 ? $from.before(1) : $from.pos;
          const block = tr.doc.nodeAt(start);
          const node = this.type.create();
          if (block?.type.name === "paragraph" && block.content.size === 0) {
            // An empty paragraph (e.g. where the slash command was typed) becomes the appendix's first line.
            tr.insert(start, node);
          } else {
            const end = block ? start + block.nodeSize : start;
            tr.insert(end, [node, state.schema.nodes.paragraph.create()]);
            tr.setSelection(TextSelection.create(tr.doc, end + node.nodeSize + 1));
          }
          tr.scrollIntoView();
          return true;
        },
    };
  },
});
