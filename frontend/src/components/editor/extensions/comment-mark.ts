import { Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    comment: {
      setComment: (threadId: string) => ReturnType;
      /** Removes every mark of the given thread from the whole document */
      removeCommentThread: (threadId: string) => ReturnType;
    };
  }
}

export interface CommentMarkOptions {
  onActivate: (threadId: string) => void;
}

export const CommentMark = Mark.create<CommentMarkOptions>({
  name: "comment",
  inclusive: false,

  addOptions() {
    return { onActivate: () => {} };
  },

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-thread-id"),
        renderHTML: (attrs) => ({ "data-thread-id": attrs.threadId }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-thread-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "comment-mark" }, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setComment:
        (threadId) =>
        ({ commands }) =>
          commands.setMark(this.name, { threadId }),
      removeCommentThread:
        (threadId) =>
        ({ state, dispatch }) => {
          const tr = state.tr;
          state.doc.descendants((node, pos) => {
            if (!node.isText) return true;
            const mark = node.marks.find((m) => m.type === this.type && m.attrs.threadId === threadId);
            if (mark) tr.removeMark(pos, pos + node.nodeSize, mark);
            return true;
          });
          if (!tr.docChanged) return false;
          dispatch?.(tr);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const { onActivate } = this.options;
    const type = this.type;
    return [
      new Plugin({
        key: new PluginKey("commentClick"),
        props: {
          handleClick(view, pos) {
            const $pos = view.state.doc.resolve(pos);
            const marks = [...$pos.marks(), ...($pos.nodeAfter?.marks ?? [])];
            const mark = marks.find((m) => m.type === type);
            if (mark?.attrs.threadId) onActivate(mark.attrs.threadId as string);
            return false;
          },
        },
      }),
    ];
  },
});
