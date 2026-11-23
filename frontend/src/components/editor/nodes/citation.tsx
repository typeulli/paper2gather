"use client";

import { mergeAttributes, Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CitationStore } from "@/lib/paper/citation-store";
import {
  citationText,
  entryLabel,
  formatReferenceAs,
  type CitationLayout,
  type CitationMode,
  type CitationOptions,
} from "@/lib/paper/citations";
import { parseRefIds, serializeRefIds } from "@/lib/paper/references";
import { cn } from "@/lib/utils";
import { useCitations, usePaper } from "../paper-context";
import { stringAttribute } from "./shared";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    citation: {
      insertCitation: (refIds: string[], options?: CitationOptions) => ReturnType;
    };
  }
}

export interface CitationExtensionOptions {
  citations: CitationStore | null;
}

/** The citation form and locator of a citation node */
export function citationOptionsOf(node: Pick<PMNode, "attrs">): Required<CitationOptions> {
  return {
    mode: node.attrs.mode === "narrative" ? "narrative" : "paren",
    locator: typeof node.attrs.locator === "string" ? node.attrs.locator : "",
  };
}

/** Node attributes for citation options */
export function citationAttrs(options: CitationOptions = {}): { mode: CitationMode; locator: string } {
  return { mode: options.mode === "narrative" ? "narrative" : "paren", locator: options.locator?.trim() ?? "" };
}

function CitationView({ node, updateAttributes, deleteNode, editor, getPos, selected }: NodeViewProps) {
  const { ui } = usePaper();
  const layout = useCitations();
  const ids = parseRefIds(node.attrs.refs);
  const options = citationOptionsOf(node);
  const text = citationText(ids, layout, options);
  const hasMissing = ids.some((id) => !layout.byId.has(id));

  return (
    <NodeViewWrapper as="span" className="citation">
      <Popover>
        <PopoverTrigger asChild>
          <span
            role="button"
            className={cn(
              "cursor-pointer rounded-sm px-px text-primary transition-colors hover:bg-primary/10",
              hasMissing && "text-destructive",
              selected && "bg-primary/10 ring-1 ring-primary/30"
            )}
          >
            {text}
          </span>
        </PopoverTrigger>
        <PopoverContent className="w-[28rem] gap-2" align="start">
          <ul className="flex flex-col gap-1.5">
            {ids.map((id) => {
              const entry = layout.byId.get(id);
              const label = entry ? entryLabel(entry, layout.style) : "[?]";
              return (
                <li key={id} className="group/cite flex items-start gap-2 text-xs leading-relaxed">
                  {label && (
                    <span className="w-7 shrink-0 font-medium tabular-nums text-muted-foreground">{label}</span>
                  )}
                  <span className="min-w-0 flex-1">
                    {entry ? (
                      formatReferenceAs(entry.ref, layout.style, layout).map((s, i) =>
                        s.italic ? <em key={i}>{s.text}</em> : <span key={i}>{s.text}</span>
                      )
                    ) : (
                      <span className="text-destructive">삭제되었거나 찾을 수 없는 참고문헌</span>
                    )}
                  </span>
                  {editor.isEditable && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="이 인용 제거"
                      onClick={() => {
                        const rest = ids.filter((x) => x !== id);
                        if (rest.length === 0) deleteNode();
                        else updateAttributes({ refs: serializeRefIds(rest) });
                      }}
                    >
                      <XIcon />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {editor.isEditable && (
            <div className="flex justify-end gap-1 border-t pt-2">
              <Button variant="ghost" size="sm" onClick={() => deleteNode()}>
                <Trash2Icon /> 삭제
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const pos = getPos();
                  if (typeof pos === "number") ui.openCiteDialog({ initial: ids, options, target: { pos } });
                }}
              >
                <PencilIcon /> 인용 편집
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}

const EMPTY_LAYOUT: CitationLayout = { style: "numeric", entries: [], byId: new Map(), authorDate: new Map() };

export const Citation = Node.create<CitationExtensionOptions>({
  name: "citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { citations: null };
  },

  addAttributes() {
    return {
      refs: stringAttribute("refs", ""),
      mode: stringAttribute("mode", "paren"),
      locator: stringAttribute("locator", ""),
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="citation"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const layout = this.options.citations?.get() ?? EMPTY_LAYOUT;
    return [
      "span",
      mergeAttributes({ "data-type": "citation" }, HTMLAttributes),
      citationText(parseRefIds(node.attrs.refs), layout, citationOptionsOf(node)),
    ];
  },

  renderText({ node }) {
    const layout = this.options.citations?.get() ?? EMPTY_LAYOUT;
    return citationText(parseRefIds(node.attrs.refs), layout, citationOptionsOf(node));
  },

  addNodeView() {
    return ReactNodeViewRenderer(CitationView);
  },

  addCommands() {
    return {
      insertCitation:
        (refIds, options) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { refs: serializeRefIds(refIds), ...citationAttrs(options) },
          }),
    };
  },
});
