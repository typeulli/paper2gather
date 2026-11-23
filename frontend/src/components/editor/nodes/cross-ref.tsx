"use client";

import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { LocateFixedIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Katex } from "@/components/math/katex";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { revealPos } from "@/lib/editor-utils";
import { defaultFormat, referenceText, type PaperFormat } from "@/lib/paper/format";
import { KIND_LABELS } from "@/lib/paper/labels";
import type { NumberedObject, NumberingStore } from "@/lib/paper/numbering";
import type { PaperStore } from "@/lib/paper/store";
import { cn } from "@/lib/utils";
import { useFormat, useNumbering, usePaper } from "../paper-context";
import { stringAttribute } from "./shared";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    crossRef: {
      insertCrossRef: (targetId: string) => ReturnType;
    };
  }
}

export interface CrossRefOptions {
  store: PaperStore | null;
  numbering: NumberingStore | null;
}

export function crossRefText(target: NumberedObject | undefined, format: PaperFormat): string {
  if (!target || !target.number) return "??";
  return referenceText(target.kind, target.number, format, target.appendix);
}

function CrossRefView({ node, deleteNode, editor, getPos, selected }: NodeViewProps) {
  const { ui } = usePaper();
  const numbering = useNumbering();
  const format = useFormat();
  const target = numbering.byId.get(node.attrs.target as string);
  const text = crossRefText(target, format);

  return (
    <NodeViewWrapper as="span" className="cross-ref">
      <Popover>
        <PopoverTrigger asChild>
          <span
            role="button"
            className={cn(
              "cursor-pointer rounded-sm px-px text-primary transition-colors hover:bg-primary/10",
              text === "??" && "text-destructive",
              selected && "bg-primary/10 ring-1 ring-primary/30"
            )}
          >
            {text}
          </span>
        </PopoverTrigger>
        <PopoverContent className="w-80 gap-2" align="start">
          {target ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{KIND_LABELS[target.kind]}</Badge>
                <code className="truncate text-xs text-muted-foreground">{target.label}</code>
              </div>
              <div className="max-h-24 overflow-hidden text-sm">
                {target.kind === "equation" ? (
                  <Katex latex={target.text} displayMode />
                ) : (
                  <span>{target.text || "(내용 없음)"}</span>
                )}
              </div>
              {!target.number && (
                <p className="text-xs text-destructive">대상에 번호가 없어 참조할 수 없습니다.</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-destructive">참조 대상이 삭제되었습니다.</p>
          )}
          <div className="flex justify-end gap-1 border-t pt-2">
            {target && (
              <Button variant="ghost" size="sm" onClick={() => revealPos(editor, target.pos)}>
                <LocateFixedIcon /> 이동
              </Button>
            )}
            {editor.isEditable && (
              <>
                <Button variant="ghost" size="sm" onClick={() => deleteNode()}>
                  <Trash2Icon /> 삭제
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const pos = getPos();
                    if (typeof pos === "number") ui.openCrossRefDialog({ target: { pos } });
                  }}
                >
                  <PencilIcon /> 변경
                </Button>
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}

export const CrossRef = Node.create<CrossRefOptions>({
  name: "crossRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { store: null, numbering: null };
  },

  addAttributes() {
    return { target: stringAttribute("target", "") };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="cross-ref"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const text = crossRefText(
      this.options.numbering?.get().byId.get(node.attrs.target),
      this.options.store?.formatSlice.get() ?? defaultFormat()
    );
    return ["span", mergeAttributes({ "data-type": "cross-ref" }, HTMLAttributes), text];
  },

  renderText({ node }) {
    return crossRefText(
      this.options.numbering?.get().byId.get(node.attrs.target),
      this.options.store?.formatSlice.get() ?? defaultFormat()
    );
  },

  addNodeView() {
    return ReactNodeViewRenderer(CrossRefView);
  },

  addCommands() {
    return {
      insertCrossRef:
        (targetId) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { target: targetId } }),
    };
  },
});
