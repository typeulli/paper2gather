"use client";

import { useEffect, useState } from "react";
import { CheckIcon, MessageSquareIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { findCommentRange } from "@/lib/editor-utils";
import { shortId } from "@/lib/ids";
import type { CommentThread } from "@/lib/paper/types";
import { cn } from "@/lib/utils";
import { useComments, usePaper } from "../paper-context";

const relative = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });

function timeAgo(ts: number): string {
  const seconds = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86400), "day");
}

interface ThreadCardProps {
  thread: CommentThread;
  active: boolean;
  onActivate: () => void;
}

function ThreadCard({ thread, active, onActivate }: ThreadCardProps) {
  const { store, editor, user } = usePaper();
  const [reply, setReply] = useState("");

  const jump = () => {
    onActivate();
    if (!editor) return;
    const range = findCommentRange(editor, thread.id);
    if (range) editor.chain().focus().setTextSelection(range).scrollIntoView().run();
  };

  const send = () => {
    if (!reply.trim()) return;
    store.replyToThread(thread.id, {
      id: shortId(10),
      author: user.name,
      color: user.color,
      text: reply.trim(),
      createdAt: Date.now(),
    });
    setReply("");
  };

  return (
    <li
      id={`thread-${thread.id}`}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm transition-shadow",
        active && "ring-2 ring-amber-400/60",
        thread.resolved && "opacity-70"
      )}
    >
      <button
        type="button"
        onClick={jump}
        className="line-clamp-2 border-l-2 border-amber-400 pl-2 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {thread.quote || "(삭제된 텍스트)"}
      </button>
      <ul className="flex flex-col gap-2">
        {thread.messages.map((m) => (
          <li key={m.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="size-2 rounded-full" style={{ backgroundColor: m.color }} />
              <span className="font-medium">{m.author}</span>
              <span className="text-muted-foreground">{timeAgo(m.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap break-words">{m.text}</p>
          </li>
        ))}
      </ul>
      {!thread.resolved && (
        <Textarea
          value={reply}
          rows={1}
          onFocus={onActivate}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="답글 (Enter 전송)"
          className="min-h-8 text-xs"
        />
      )}
      <div className="flex justify-end gap-1">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            editor?.commands.removeCommentThread(thread.id);
            store.deleteThread(thread.id);
          }}
        >
          <Trash2Icon /> 삭제
        </Button>
        <Button size="xs" variant="outline" onClick={() => store.setThreadResolved(thread.id, !thread.resolved)}>
          {thread.resolved ? (
            <>
              <RotateCcwIcon /> 다시 열기
            </>
          ) : (
            <>
              <CheckIcon /> 해결
            </>
          )}
        </Button>
      </div>
    </li>
  );
}

interface CommentsPanelProps {
  activeThread: string | null;
  onActiveThreadChange: (id: string | null) => void;
}

export function CommentsPanel({ activeThread, onActiveThreadChange }: CommentsPanelProps) {
  const threads = useComments();
  const [showResolved, setShowResolved] = useState(false);
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);

  useEffect(() => {
    if (activeThread) {
      document.getElementById(`thread-${activeThread}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeThread]);

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-2">
        {threads.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-sm text-muted-foreground">
            <MessageSquareIcon className="size-8 opacity-50" />
            본문 텍스트를 선택한 뒤 툴바의 댓글 버튼을 눌러 의견을 남기세요.
          </div>
        )}
        <ul className="flex flex-col gap-2">
          {open.map((t) => (
            <ThreadCard
              key={t.id}
              thread={t}
              active={t.id === activeThread}
              onActivate={() => onActiveThreadChange(t.id)}
            />
          ))}
        </ul>
        {resolved.length > 0 && (
          <>
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowResolved((v) => !v)}>
              해결된 댓글 {resolved.length}개 {showResolved ? "숨기기" : "보기"}
            </Button>
            {showResolved && (
              <ul className="flex flex-col gap-2">
                {resolved.map((t) => (
                  <ThreadCard
                    key={t.id}
                    thread={t}
                    active={t.id === activeThread}
                    onActivate={() => onActiveThreadChange(t.id)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}
