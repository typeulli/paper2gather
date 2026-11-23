import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

/**
 * Before every commit, while an element whose `contentEditable` is "true" has focus, React saves its
 * selection as text offsets by walking all of the element's DOM (getSelectionInformation). In a long
 * paper that takes tens of ms on every toolbar click and every state update while typing. ProseMirror
 * keeps the selection itself, so readers of the property get "inherit" instead ("false" stays "false");
 * the browser goes by the attribute, which is unchanged.
 */
export const ReactSelection = Extension.create({
  name: "reactSelection",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        view(view) {
          const property = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "contentEditable");
          Object.defineProperty(view.dom, "contentEditable", {
            configurable: true,
            get: () => (view.dom.getAttribute("contenteditable") === "false" ? "false" : "inherit"),
            set: (value: string) => property?.set?.call(view.dom, value),
          });
          return { destroy: () => Reflect.deleteProperty(view.dom, "contentEditable") };
        },
      }),
    ];
  },
});
