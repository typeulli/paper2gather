"use client";

import { useState } from "react";
import { InputRule, mergeAttributes, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Katex } from "@/components/math/katex";
import { LatexEditor } from "@/components/math/latex-editor";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { stringAttribute } from "./shared";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mathInline: {
      insertMathInline: (latex?: string) => ReturnType;
    };
  }
  interface Storage {
    mathInline: {
      /** Empty nodes this client just inserted; only these open their editor on mount. */
      autoEdit: WeakSet<ProseMirrorNode>;
    };
  }
}

function MathInlineView({ node, updateAttributes, deleteNode, editor, getPos, selected }: NodeViewProps) {
  const latex = node.attrs.latex as string;
  // Non-null while the popover editor is open. An empty node this client just inserted opens it;
  // collaborators receiving that node must not (closing an empty draft deletes the node).
  const [draft, setDraft] = useState<string | null>(() =>
    editor.isEditable && !latex && editor.storage.mathInline.autoEdit.has(node) ? "" : null
  );
  const open = draft !== null;

  /** Hides the popover; a formula left empty is removed. Returns whether the formula remains. */
  const finish = () => {
    const empty = !draft?.trim();
    setDraft(null);
    if (empty) deleteNode();
    return !empty;
  };

  const close = () => {
    if (!finish()) return;
    const pos = getPos();
    if (typeof pos === "number") {
      editor.chain().focus().setTextSelection(pos + node.nodeSize).run();
    }
  };

  return (
    <NodeViewWrapper as="span" className="math-inline">
      {/* Clicking or focusing elsewhere dismisses without taking focus back from where it went. */}
      <Popover open={open} onOpenChange={(next) => (next ? setDraft(latex) : finish())}>
        <PopoverAnchor asChild>
          <span
            className={cn(
              "cursor-pointer rounded-sm px-0.5 transition-colors hover:bg-muted",
              selected && "bg-primary/10 ring-1 ring-primary/30"
            )}
            onClick={() => editor.isEditable && !open && setDraft(latex)}
          >
            <Katex latex={latex} placeholder="수식" />
          </span>
        </PopoverAnchor>
        <PopoverContent
          className="w-[26rem]"
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Esc (from the textarea or a palette tab) returns to the text after the formula.
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <LatexEditor
            value={draft ?? ""}
            displayMode={false}
            autoFocus
            singleLine
            onChange={(value) => {
              setDraft(value);
              updateAttributes({ latex: value });
            }}
            onSubmit={close}
          />
          <p className="text-xs text-muted-foreground">Enter 완료 · Shift+Enter 줄바꿈 · Esc 닫기</p>
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}

export const MathInline = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { latex: stringAttribute("latex", "") };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="math-inline"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ["span", mergeAttributes({ "data-type": "math-inline" }, HTMLAttributes), `$${node.attrs.latex}$`];
  },

  renderText({ node }) {
    return `$${node.attrs.latex}$`;
  },

  addStorage() {
    return { autoEdit: new WeakSet<ProseMirrorNode>() };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView);
  },

  addCommands() {
    return {
      insertMathInline:
        (latex = "") =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.replaceSelectionWith(this.type.create({ latex }));
            // The selection ends right after the inserted node.
            const inserted = tr.doc.nodeAt(tr.selection.from - 1);
            if (!latex && inserted?.type === this.type) this.storage.autoEdit.add(inserted);
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-e": () => {
        const { from, to } = this.editor.state.selection;
        const selected = this.editor.state.doc.textBetween(from, to, " ");
        return this.editor.commands.insertMathInline(selected);
      },
    };
  },

  addInputRules() {
    return [
      // $x^2$ -> inline math (ignores "$$" and escaped "\$")
      new InputRule({
        find: /(?:^|[^$\\])\$([^$\n]+)\$$/,
        handler: ({ state, range, match }) => {
          const latex = match[1];
          if (!latex.trim()) return null;
          const lead = match[0].length - latex.length - 2;
          state.tr.replaceWith(range.from + lead, range.to, this.type.create({ latex }));
        },
      }),
    ];
  },
});
