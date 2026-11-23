"use client";

import { ClipboardCopyIcon, CopyIcon, LinkIcon, LocateFixedIcon } from "lucide-react";
import { toast } from "sonner";
import { Katex } from "@/components/math/katex";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { revealPos, splitInlineMath } from "@/lib/editor-utils";
import type { NumberedObject } from "@/lib/paper/numbering";
import type { ObjectKind } from "@/lib/paper/types";
import { useCopyAsImage } from "../copy-as-image";
import { crossRefText } from "../nodes/cross-ref";
import { useFormat, useNumbering, usePaper } from "../paper-context";

export type ListedObjectKind = Exclude<ObjectKind, "section">;

const EMPTY: Record<ListedObjectKind, string> = {
  equation: "'$$ ' 입력 또는 Ctrl+Alt+E로 수식을 추가하세요.",
  figure: "그림이 없습니다.",
  table: "표가 없습니다.",
};

function Caption({ text }: { text: string }) {
  if (!text) return <span className="text-muted-foreground italic">캡션 없음</span>;
  return (
    <>
      {splitInlineMath(text).map((p, i) => (p.math ? <Katex key={i} latex={p.text} /> : <span key={i}>{p.text}</span>))}
    </>
  );
}

export function ObjectsPanel({ kind }: { kind: ListedObjectKind }) {
  const { editor } = usePaper();
  const numbering = useNumbering();
  const format = useFormat();
  const items = numbering.objects.filter((o) => o.kind === kind);
  const copyAsImage = useCopyAsImage();

  const actions = (o: NumberedObject) => (
    <div className="flex shrink-0 gap-0.5 opacity-60 group-hover/obj:opacity-100">
      <Button size="icon-xs" variant="ghost" title="위치로 이동" onClick={() => editor && revealPos(editor, o.pos)}>
        <LocateFixedIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        title="커서 위치에 참조 삽입"
        disabled={!o.number}
        onClick={() => editor?.chain().focus().insertCrossRef(o.id).run()}
      >
        <LinkIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        title="LaTeX 라벨 복사"
        onClick={async () => {
          await navigator.clipboard.writeText(o.label);
          toast.success(`${o.label} 복사됨`);
        }}
      >
        <CopyIcon />
      </Button>
      <Button size="icon-xs" variant="ghost" title="이미지로 복사" onClick={() => copyAsImage(o.pos)}>
        <ClipboardCopyIcon />
      </Button>
    </div>
  );

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-3">
        <p className="text-xs text-muted-foreground">
          번호는 문서 내 위치 순서로 자동 매겨집니다. 수식을 옮기거나 삭제하면 모든 참조가 함께 갱신됩니다.
        </p>
        <section className="flex flex-col gap-1.5">
          {items.length === 0 && <p className="text-xs text-muted-foreground">{EMPTY[kind]}</p>}
          <ul className="flex flex-col gap-1">
            {items.map((o) => (
              <li key={o.id} className="group/obj flex items-center gap-2 rounded-md border p-1.5 pl-2">
                <span className="w-14 shrink-0 text-xs font-semibold">
                  {o.number ? crossRefText(o, format) : "번호 없음"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="max-h-16 overflow-hidden text-sm">
                    {kind === "equation" ? (
                      <Katex latex={o.text} className="[&_.katex]:text-[0.85em]" placeholder="(빈 수식)" />
                    ) : (
                      <span className="line-clamp-2 text-xs">
                        <Caption text={o.text} />
                      </span>
                    )}
                  </div>
                  <code className="block truncate text-[10px] text-muted-foreground">{o.label}</code>
                </div>
                {actions(o)}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </ScrollArea>
  );
}
