"use client";

import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useFormat, useNumbering } from "../paper-context";
import { ObjectCaption } from "./object-caption";
import { stopEventInNodeUi, stringAttribute } from "./shared";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableFigure: {
      insertTableFigure: (opts: { rows: number; cols: number; withHeaderRow: boolean; caption?: string }) => ReturnType;
      /** Deletes the table (and its caption wrapper) around the selection */
      deleteTableFigure: () => ReturnType;
    };
  }
}

function TableFigureView({ node, updateAttributes, editor }: NodeViewProps) {
  const { id, caption } = node.attrs as { id: string | null; caption: string };
  const numbering = useNumbering();
  const captionPosition = useFormat().table.position;
  const number = (id && numbering.byId.get(id)?.number) || "?";

  const captionEl = (
    <ObjectCaption
      kind="table"
      number={number}
      caption={caption}
      editable={editor.isEditable}
      onChange={(value) => updateAttributes({ caption: value })}
    />
  );

  return (
    <NodeViewWrapper className="table-figure my-5" data-object-id={id ?? undefined}>
      {captionPosition === "above" && captionEl}
      <NodeViewContent className="table-figure-content overflow-x-auto" />
      {captionPosition === "below" && captionEl}
    </NodeViewWrapper>
  );
}

export const TableFigure = Node.create({
  name: "tableFigure",
  group: "block",
  content: "table",
  isolating: true,
  selectable: false,

  addAttributes() {
    return {
      id: stringAttribute("id"),
      label: stringAttribute("label"),
      caption: stringAttribute("caption", ""),
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-type="table-figure"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes({ "data-type": "table-figure" }, HTMLAttributes), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TableFigureView, { stopEvent: stopEventInNodeUi });
  },

  addCommands() {
    return {
      insertTableFigure:
        ({ rows, cols, withHeaderRow, caption = "" }) =>
        ({ commands }) => {
          const cell = (header: boolean) => ({
            type: header ? "tableHeader" : "tableCell",
            content: [{ type: "paragraph" }],
          });
          const row = (header: boolean) => ({
            type: "tableRow",
            content: Array.from({ length: cols }, () => cell(header)),
          });
          return commands.insertContent({
            type: this.name,
            attrs: { caption },
            content: [
              {
                type: "table",
                content: Array.from({ length: rows }, (_, i) => row(withHeaderRow && i === 0)),
              },
            ],
          });
        },
      deleteTableFigure:
        () =>
        ({ state, dispatch, commands }) => {
          const { $from } = state.selection;
          for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type.name === this.name) {
              if (dispatch) dispatch(state.tr.delete($from.before(depth), $from.after(depth)));
              return true;
            }
          }
          return commands.deleteTable();
        },
    };
  },
});
