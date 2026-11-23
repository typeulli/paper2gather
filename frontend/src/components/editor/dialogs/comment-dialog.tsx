"use client";

import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { refocusEditor } from "@/lib/editor-utils";
import { shortId } from "@/lib/ids";
import { usePaper } from "../paper-context";

interface CommentDialogProps {
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (threadId: string) => void;
}

export function CommentDialog({ editor, open, onOpenChange, onCreated }: CommentDialogProps) {
  const { store, user } = usePaper();
  const [text, setText] = useState("");
  // Remounted on every open (see Workspace), so the current selection is captured here.
  const [quote] = useState(() => {
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, " ").slice(0, 300);
  });

  const submit = () => {
    // `open` is already false while the dialog animates out; ignore repeat activations (double click).
    if (!open || !text.trim() || editor.state.selection.empty) return;
    const threadId = shortId(10);
    store.addThread(threadId, quote, {
      id: shortId(10),
      author: user.name,
      color: user.color,
      text: text.trim(),
      createdAt: Date.now(),
    });
    editor.chain().focus().setComment(threadId).run();
    onOpenChange(false);
    onCreated(threadId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={refocusEditor(editor)}>
        <DialogHeader>
          <DialogTitle>댓글 달기</DialogTitle>
          <DialogDescription>선택한 텍스트에 댓글 스레드를 만듭니다.</DialogDescription>
        </DialogHeader>
        {quote ? (
          <blockquote className="line-clamp-3 border-l-2 pl-3 text-sm text-muted-foreground">{quote}</blockquote>
        ) : (
          <p className="text-sm text-destructive">먼저 본문에서 댓글을 달 텍스트를 선택하세요.</p>
        )}
        <Textarea
          value={text}
          autoFocus
          rows={4}
          placeholder="의견을 남겨주세요 (Ctrl+Enter로 등록)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <DialogFooter>
          <Button onClick={submit} disabled={!text.trim() || !quote}>
            등록
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
