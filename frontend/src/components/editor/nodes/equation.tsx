"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { InputRule, mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Katex } from "@/components/math/katex";
import { LatexEditor } from "@/components/math/latex-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { shortId } from "@/lib/ids";
import { equationNumberText } from "@/lib/paper/format";
import { cn } from "@/lib/utils";
import { useCopyAsImage } from "../copy-as-image";
import { useFormat, useNumbering } from "../paper-context";
import { booleanAttribute, LABEL_PATTERN, stopEventInNodeUi, stringAttribute } from "./shared";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    equation: {
      insertEquation: (attrs?: { latex?: string; numbered?: boolean }) => ReturnType;
    };
  }
  interface Storage {
    equation: {
      /** Ids of empty equations this client just inserted; only these open their editor on mount. */
      autoEdit: Set<string>;
    };
  }
}

function EquationView({ node, updateAttributes, deleteNode, editor, getPos, selected }: NodeViewProps) {
  const { id, latex, numbered, label } = node.attrs as {
    id: string | null;
    latex: string;
    numbered: boolean;
    label: string | null;
  };
  const numbering = useNumbering();
  const format = useFormat();
  const number = id ? numbering.byId.get(id)?.number : null;
  // Non-null while the editing panel is open. An empty equation this client just inserted opens
  // it; collaborators receiving that equation must not (closing an empty draft deletes the node).
  const [draft, setDraft] = useState<string | null>(() =>
    editor.isEditable && !latex && !!id && editor.storage.equation.autoEdit.has(id) ? "" : null
  );
  // Non-null while the label input is focused.
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const anchorRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const numberRef = useRef<HTMLSpanElement>(null);
  // Too wide to share the line with its number: the number moves below (like amsmath).
  const [wide, setWide] = useState(false);
  const copyAsImage = useCopyAsImage();

  useLayoutEffect(() => {
    const row = anchorRef.current;
    const box = boxRef.current;
    const num = numberRef.current;
    if (!row || !box || !num) return;
    // Layout sizes, unaffected by the scaling of shrunk pages. The box is as wide as the equation in
    // both layouts, so the result doesn't depend on the current one.
    const measure = () => {
      const style = getComputedStyle(row);
      const width = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const gap = parseFloat(style.columnGap) || 0;
      setWide(box.offsetWidth > width - num.offsetWidth - 2 * gap);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of [row, box, num]) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Hides the panel; an equation left empty is removed. Returns whether the equation remains. */
  const finish = () => {
    const empty = !draft?.trim();
    setDraft(null);
    if (id) editor.storage.equation.autoEdit.delete(id);
    if (empty) deleteNode();
    return !empty;
  };

  const close = () => {
    if (!finish()) return;
    // Leave the caret after the equation (not a node selection) so typing continues the text
    // instead of replacing the equation.
    const pos = getPos();
    if (typeof pos !== "number") return;
    const after = pos + node.nodeSize;
    const next = editor.state.doc.nodeAt(after);
    const chain = editor.chain().focus();
    if (next?.type.name !== "paragraph") chain.insertContentAt(after, { type: "paragraph" });
    chain.setTextSelection(after + 1).run();
  };

  return (
    <NodeViewWrapper
      className={cn(
        "equation-node group/eq relative my-3 rounded-md transition-colors",
        selected && "bg-primary/5 ring-1 ring-primary/30",
        !editing && editor.isEditable && "hover:bg-muted/40"
      )}
      data-object-id={id ?? undefined}
    >
      {/* The editing panel floats over the document (in a portal, at actual size) so opening it doesn't
          move the layout. Clicking or focusing elsewhere dismisses it without taking focus back. */}
      <Popover open={editing} onOpenChange={(next) => !next && finish()}>
        <PopoverAnchor asChild>
          {/* Equal side columns center the equation on the line, with the number in the right one; a
              wide equation takes the space of the left column first (like LaTeX). Wider still, the
              equation gets a line of its own, centered, or overflowing into the right margin when
              wider than the line (no scrollbar), and the number goes below it. */}
          <div
            ref={anchorRef}
            className={cn(
              "min-h-10 cursor-pointer gap-x-2 px-2 py-1",
              wide ? "flex flex-col" : "grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center"
            )}
            // While editing, a click on the rendered equation keeps focus in the panel (ProseMirror
            // would otherwise take focus and close it).
            data-node-ui={editing ? "" : undefined}
            onMouseDown={(e) => editing && e.preventDefault()}
            onClick={() => editor.isEditable && !editing && setDraft(latex)}
          >
            {/* As wide as the equation (KaTeX doesn't wrap); a LaTeX error message still wraps. */}
            <div ref={boxRef} className={cn("w-fit py-1 text-center", wide ? "mx-auto" : "col-start-2")}>
              <Katex latex={latex} displayMode placeholder="수식을 입력하세요" />
            </div>
            <span
              ref={numberRef}
              className={cn("equation-number tabular-nums", wide ? "self-end" : "justify-self-end")}
            >
              {numbered && number ? equationNumberText(number, format.equation.brackets) : ""}
            </span>
          </div>
        </PopoverAnchor>
        <PopoverContent
          className="w-[38rem] max-w-[calc(100vw-2rem)] gap-3 p-3"
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // A click on the equation itself keeps the panel open (see the anchor's onMouseDown).
          onInteractOutside={(e) => {
            if (e.target instanceof Element && anchorRef.current?.contains(e.target)) e.preventDefault();
          }}
          // Esc (from the textarea or a palette tab) returns to the text after the equation.
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <LatexEditor
            value={draft ?? ""}
            displayMode
            autoFocus
            preview="errors"
            onChange={(value) => {
              setDraft(value);
              updateAttributes({ latex: value });
            }}
            onSubmit={close}
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <Switch
                id={`eq-numbered-${id}`}
                checked={numbered}
                onCheckedChange={(value) => updateAttributes({ numbered: value })}
              />
              <Label htmlFor={`eq-numbered-${id}`}>번호 매기기</Label>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor={`eq-label-${id}`} className="text-muted-foreground">
                라벨
              </Label>
              <Input
                id={`eq-label-${id}`}
                value={labelDraft ?? label ?? ""}
                className="h-7 w-44 font-mono text-xs"
                onFocus={() => setLabelDraft(label ?? "")}
                onBlur={() => setLabelDraft(null)}
                onChange={(e) => {
                  const value = e.target.value;
                  if (!LABEL_PATTERN.test(value)) return;
                  setLabelDraft(value);
                  if (value) updateAttributes({ label: value });
                }}
              />
            </div>
            <span className="text-xs text-muted-foreground">Ctrl+Enter 완료 · Esc 닫기</span>
            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!draft?.trim()}
                onClick={() => {
                  const pos = getPos();
                  if (typeof pos === "number") copyAsImage(pos);
                }}
              >
                이미지로 복사
              </Button>
              <Button size="sm" variant="ghost" onClick={() => deleteNode()}>
                삭제
              </Button>
              <Button size="sm" onClick={close}>
                완료
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}

export const Equation = Node.create({
  name: "equation",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      id: stringAttribute("id"),
      label: stringAttribute("label"),
      latex: stringAttribute("latex", ""),
      numbered: booleanAttribute("numbered", true),
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="equation"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ["div", mergeAttributes({ "data-type": "equation" }, HTMLAttributes), `$$${node.attrs.latex}$$`];
  },

  renderText({ node }) {
    return `$$${node.attrs.latex}$$`;
  },

  addStorage() {
    return { autoEdit: new Set<string>() };
  },

  addNodeView() {
    return ReactNodeViewRenderer(EquationView, { stopEvent: stopEventInNodeUi });
  },

  addCommands() {
    return {
      insertEquation:
        (attrs) =>
        ({ commands }) => {
          const latex = attrs?.latex ?? "";
          // The id is set up front (the unique-id pass keeps it) so the new node can be recognized.
          const id = shortId();
          if (!latex) this.storage.autoEdit.add(id);
          return commands.insertContent({
            type: this.name,
            attrs: { id, latex, numbered: attrs?.numbered ?? true },
          });
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Alt-e": () => this.editor.commands.insertEquation(),
    };
  },

  addInputRules() {
    return [
      // "$$ " at the start of an empty paragraph turns it into a display equation
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          // Depending on the input mode the typed space may already be in the document.
          if ($from.parent.textContent.trim() !== "$$") return null;
          const id = shortId();
          this.storage.autoEdit.add(id);
          state.tr.replaceRangeWith(range.from, range.to, this.type.create({ id, latex: "", numbered: true }));
        },
      }),
    ];
  },
});
