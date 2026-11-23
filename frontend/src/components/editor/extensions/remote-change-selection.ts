import { Extension } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { messageSync, type WebsocketProvider } from "y-websocket";

export interface RemoteChangeSelectionOptions {
  provider: WebsocketProvider | null;
}

/** ProseMirror's reader of DOM changes (not part of its typed API) */
type ViewWithObserver = EditorView & { domObserver: { flush: () => void } };

/** Keys whose caret move the browser makes itself */
const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/**
 * The browser moves the caret itself (End, arrow keys, …) and ProseMirror reads the new position on
 * the next "selectionchange" event. An update of the editor before that event (a collaborator's
 * change, e.g. the AI's, or the page breaks and decorations that follow it) puts ProseMirror's older
 * selection back into the page, and the next keys land where the caret was, e.g. inside a word.
 * In that window the caret is read first: before each sync message, and before transactions that
 * only update decorations or metadata.
 */
export const RemoteChangeSelection = Extension.create<RemoteChangeSelectionOptions>({
  name: "remoteChangeSelection",

  addOptions() {
    return { provider: null };
  },

  addProseMirrorPlugins() {
    const { provider } = this.options;
    if (!provider) return [];
    // A caret key was pressed and ProseMirror hasn't read the move yet.
    let caretMoved = false;
    return [
      new Plugin({
        props: {
          handleKeyDown(_view, event) {
            if (CARET_KEYS.has(event.key)) caretMoved = true;
            return false;
          },
        },

        view(view) {
          const readCaret = () => {
            if (!caretMoved) return;
            caretMoved = false;
            if (!view.isDestroyed && view.hasFocus()) (view as ViewWithObserver).domObserver.flush();
          };
          const caretRead = () => {
            caretMoved = false;
          };
          view.dom.ownerDocument.addEventListener("selectionchange", caretRead);

          const handle = provider.messageHandlers[messageSync];
          const readCaretFirst: typeof handle = (...args) => {
            readCaret();
            handle(...args);
          };
          provider.messageHandlers[messageSync] = readCaretFirst;

          const dispatch = view.dispatch;
          view.dispatch = (tr: Transaction) => {
            if (caretMoved && !tr.docChanged && !tr.selectionSet) {
              const { doc, selection } = view.state;
              readCaret();
              // (not expected: the DOM had unread edits, so the transaction no longer applies)
              if (view.state.doc !== doc) return;
              if (!view.state.selection.eq(selection)) tr.setSelection(view.state.selection);
            }
            dispatch(tr);
          };

          return {
            destroy() {
              view.dom.ownerDocument.removeEventListener("selectionchange", caretRead);
              if (provider.messageHandlers[messageSync] === readCaretFirst) provider.messageHandlers[messageSync] = handle;
              view.dispatch = dispatch;
            },
          };
        },
      }),
    ];
  },
});
