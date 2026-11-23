"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { ListTreeIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { revealPos } from "@/lib/editor-utils";
import type { NumberedObject } from "@/lib/paper/numbering";
import { cn } from "@/lib/utils";
import { useNumbering, usePaper } from "../paper-context";

/** Height in the view (fraction from the top) at which the section being read is taken */
const READING_LINE = 0.3;

const INDENT = ["pl-2", "pl-6", "pl-10"];

/**
 * The section the cursor is in. After the user scrolls (wheel, touch, scrollbar), the section at the
 * reading line of the view instead, until the cursor moves again.
 */
function useCurrentSection(
  editor: Editor | null,
  sections: NumberedObject[],
  scrollRef: RefObject<HTMLElement | null>
): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  const follow = useRef<"cursor" | "scroll">("cursor");

  useEffect(() => {
    const el = scrollRef.current;
    if (!editor || !el) return;
    const update = () => {
      let id: string | null = null;
      if (follow.current === "cursor") {
        const { from } = editor.state.selection;
        for (const s of sections) {
          if (s.pos > from) break;
          id = s.id;
        }
      } else {
        const line = el.getBoundingClientRect().top + el.clientHeight * READING_LINE;
        for (const s of sections) {
          const dom = editor.view.nodeDOM(s.pos);
          if (!(dom instanceof HTMLElement)) continue;
          if (dom.getBoundingClientRect().top > line) break;
          id = s.id;
        }
      }
      setCurrent(id);
    };
    let frame = requestAnimationFrame(() => {
      frame = 0;
      update();
    });
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    const onSelection = ({ transaction }: { transaction: Transaction }) => {
      // A collaborator's change maps the cursor along; it doesn't move it.
      if (transaction.getMeta(ySyncPluginKey)?.isChangeOrigin) return;
      follow.current = "cursor";
      scheduleUpdate();
    };
    const onScroll = () => {
      if (follow.current === "scroll") scheduleUpdate();
    };
    const onUserScroll = (event: Event) => {
      // A press on the container itself is one on its scrollbar (or beside the pages).
      if (event.type === "pointerdown" && event.target !== el) return;
      follow.current = "scroll";
    };
    editor.on("selectionUpdate", onSelection);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onUserScroll, { passive: true });
    el.addEventListener("touchmove", onUserScroll, { passive: true });
    el.addEventListener("pointerdown", onUserScroll);
    return () => {
      cancelAnimationFrame(frame);
      editor.off("selectionUpdate", onSelection);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onUserScroll);
      el.removeEventListener("touchmove", onUserScroll);
      el.removeEventListener("pointerdown", onUserScroll);
    };
  }, [editor, sections, scrollRef]);

  return current;
}

export function OutlinePanel({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const { editor } = usePaper();
  const numbering = useNumbering();
  const sections = useMemo(() => numbering.objects.filter((o) => o.kind === "section"), [numbering.objects]);
  const current = useCurrentSection(editor, sections, scrollRef);
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the highlighted section in sight in a long outline.
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: "nearest" });
  }, [current]);

  if (sections.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-sm text-muted-foreground">
        <ListTreeIcon className="size-8 opacity-50" />
        &apos;# &apos; 입력 또는 &apos;/&apos; 메뉴의 제목 1~3으로 절을 추가하세요.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <ul ref={listRef} className="flex flex-col gap-0.5 p-2">
        {sections.map((s) => {
          // As in front of the heading: "Appendix A" for a top-level appendix section
          const number = s.shown;
          const active = s.id === current;
          return (
            <li key={s.id}>
              <button
                type="button"
                aria-current={active ? "location" : undefined}
                onClick={() => editor && revealPos(editor, s.pos)}
                className={cn(
                  "flex w-full items-baseline gap-2 rounded-md border-l-2 border-transparent py-1 pr-2 text-left text-sm hover:bg-muted",
                  INDENT[(s.level ?? 1) - 1],
                  s.level === 1 ? "font-medium" : "text-muted-foreground",
                  active && "border-primary bg-muted text-foreground"
                )}
              >
                {number && <span className="shrink-0 tabular-nums">{number}</span>}
                <span className="min-w-0 truncate">
                  {s.text || <span className="text-muted-foreground italic">(제목 없음)</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}
