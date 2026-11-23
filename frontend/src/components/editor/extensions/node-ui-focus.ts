import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";

/**
 * While focus is inside a node view's own UI (equation editor, caption field), ProseMirror is
 * unfocused and forgets the DOM selection. When a click brings focus back it re-applies its stale
 * selection shortly after, which can win over the click: the caret stays put, or typing replaces
 * an equation that was node-selected when its editor opened. Moving the selection to the click
 * point first makes the click win.
 */
export const NodeUiFocus = Extension.create({
  name: "nodeUiFocus",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown(view, event) {
              const active = view.root.activeElement;
              const focusInNodeUi = active instanceof Element && active !== view.dom && view.dom.contains(active);
              if (!focusInNodeUi || event.button !== 0 || event.shiftKey) return false;
              const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (hit && view.state.doc.resolve(hit.pos).parent.inlineContent) {
                view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, hit.pos)));
              }
              // ProseMirror still handles the click itself.
              return false;
            },
          },
        },
      }),
    ];
  },
});
