"use client";

import { useEditorState, type Editor } from "@tiptap/react";
import type { ConnectionStatus } from "./editor-page";
import { useNumbering, useReferences } from "./paper-context";

export function StatusBar({ editor, status }: { editor: Editor; status: ConnectionStatus }) {
  const counts = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      words: e.storage.characterCount.words(),
      characters: e.storage.characterCount.characters(),
    }),
  });
  const numbering = useNumbering();
  const refs = useReferences();
  const count = (kind: string) => numbering.objects.filter((o) => o.kind === kind && o.number).length;
  const uncited = refs.list.filter((r) => !numbering.citationCounts.has(r.id)).length;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t bg-background px-3 text-xs whitespace-nowrap text-muted-foreground print:hidden">
      <span>단어 {counts.words.toLocaleString()}</span>
      <span className="hidden sm:inline">문자 {counts.characters.toLocaleString()}</span>
      <span className="hidden sm:inline">
        수식 {count("equation")} · 그림 {count("figure")} · 표 {count("table")}
      </span>
      <span>
        참고문헌 {refs.list.length}
        {uncited > 0 && <span className="text-amber-600 dark:text-amber-500"> (미인용 {uncited})</span>}
      </span>
      <span className="ml-auto min-w-0 truncate">
        {status === "connected" ? "서버와 실시간 동기화 중" : status === "connecting" ? "연결 중…" : "오프라인"}
      </span>
    </footer>
  );
}
