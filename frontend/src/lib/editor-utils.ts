import type { Editor } from "@tiptap/react";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";

/** Scrolls to the node at `pos`, selects it and briefly highlights it. */
export function revealPos(editor: Editor, pos: number): void {
  const { state, view } = editor;
  const node = state.doc.nodeAt(pos);
  if (!node) return;
  const tr = state.tr;
  if (node.isAtom) tr.setSelection(NodeSelection.create(state.doc, pos));
  else tr.setSelection(TextSelection.create(state.doc, pos + node.nodeSize - 1));
  view.dispatch(tr);
  view.focus();
  const dom = view.nodeDOM(pos);
  if (dom instanceof HTMLElement) {
    dom.scrollIntoView({ behavior: "smooth", block: "center" });
    dom.classList.remove("flash-highlight");
    void dom.offsetWidth;
    dom.classList.add("flash-highlight");
    setTimeout(() => dom.classList.remove("flash-highlight"), 1600);
  }
}

/**
 * `onCloseAutoFocus` handler for dialogs that edit the document: returns focus to the editor
 * rather than to whatever opened the dialog (e.g. a toolbar button), so typing continues the text.
 */
export function refocusEditor(editor: Editor): (event: Event) => void {
  return (event) => {
    event.preventDefault();
    editor.commands.focus();
  };
}

/** Finds the first range covered by a comment mark with the given thread id. */
export function findCommentRange(editor: Editor, threadId: string): { from: number; to: number } | null {
  let range: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find((m) => m.type.name === "comment" && m.attrs.threadId === threadId);
    if (!mark) return true;
    if (range && range.to === pos) range.to = pos + node.nodeSize;
    else if (!range) range = { from: pos, to: pos + node.nodeSize };
    else return false;
    return true;
  });
  return range;
}

/** Splits text into plain and $math$ parts. */
export function splitInlineMath(text: string): { text: string; math: boolean }[] {
  const parts: { text: string; math: boolean }[] = [];
  const re = /\$([^$]+)\$/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), math: false });
    parts.push({ text: m[1], math: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), math: false });
  return parts;
}
