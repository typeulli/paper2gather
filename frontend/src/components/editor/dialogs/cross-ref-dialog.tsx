"use client";

import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Katex } from "@/components/math/katex";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { refocusEditor } from "@/lib/editor-utils";
import { KIND_LABELS } from "@/lib/paper/labels";
import type { ObjectKind } from "@/lib/paper/types";
import { crossRefText } from "../nodes/cross-ref";
import { useFormat, useNumbering, type NodeTarget } from "../paper-context";

interface CrossRefDialogProps {
  editor: Editor;
  open: boolean;
  target?: NodeTarget;
  onOpenChange: (open: boolean) => void;
}

const KIND_ORDER: ObjectKind[] = ["equation", "figure", "table", "section"];

export function CrossRefDialog({ editor, open, target, onOpenChange }: CrossRefDialogProps) {
  const numbering = useNumbering();
  const format = useFormat();
  const [query, setQuery] = useState("");

  const choose = (id: string) => {
    // `open` is already false while the dialog animates out; ignore repeat activations (double click).
    if (!open) return;
    if (target) {
      const node = editor.state.doc.nodeAt(target.pos);
      if (node?.type.name === "crossRef") {
        editor.view.dispatch(editor.state.tr.setNodeMarkup(target.pos, undefined, { ...node.attrs, target: id }));
      }
      editor.commands.focus();
    } else {
      editor.chain().focus().insertCrossRef(id).run();
    }
    onOpenChange(false);
  };

  const q = query.trim().toLowerCase();
  const objects = numbering.objects.filter(
    (o) => o.number && (!q || `${o.text} ${o.label} ${o.number}`.toLowerCase().includes(q))
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" onCloseAutoFocus={refocusEditor(editor)}>
        <DialogHeader>
          <DialogTitle>{target ? "참조 대상 변경" : "상호 참조 삽입"}</DialogTitle>
          <DialogDescription>번호가 바뀌면 본문의 참조도 자동으로 갱신됩니다.</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} className="rounded-lg border">
          <CommandInput value={query} onValueChange={setQuery} placeholder="내용, 라벨, 번호로 검색" />
          <CommandList className="max-h-[50vh]">
            <CommandEmpty>참조할 수 있는 번호 붙은 개체가 없습니다.</CommandEmpty>
            {KIND_ORDER.map((kind) => {
              const items = objects.filter((o) => o.kind === kind);
              if (items.length === 0) return null;
              return (
                <CommandGroup key={kind} heading={KIND_LABELS[kind]}>
                  {items.map((o) => (
                    <CommandItem key={o.id} value={o.id} onSelect={() => choose(o.id)} className="gap-3">
                      <span className="w-20 shrink-0 font-medium">{crossRefText(o, format)}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {kind === "equation" ? (
                          <Katex latex={o.text} className="[&_.katex]:text-[0.9em]" />
                        ) : (
                          o.text || <span className="text-muted-foreground">(캡션 없음)</span>
                        )}
                      </span>
                      <code className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">{o.label}</code>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
