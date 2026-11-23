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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { refocusEditor } from "@/lib/editor-utils";

interface TableDialogProps {
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

export function TableDialog({ editor, open, onOpenChange }: TableDialogProps) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [header, setHeader] = useState(true);
  const [caption, setCaption] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" onCloseAutoFocus={refocusEditor(editor)}>
        <DialogHeader>
          <DialogTitle>표 삽입</DialogTitle>
          <DialogDescription>표 번호와 캡션은 자동으로 관리됩니다.</DialogDescription>
        </DialogHeader>
        <form
          id="table-form"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            // `open` is already false while the dialog animates out; ignore repeat submits (double click).
            if (!open) return;
            editor
              .chain()
              .focus()
              .insertTableFigure({ rows: clamp(rows, 1, 50), cols: clamp(cols, 1, 20), withHeaderRow: header, caption })
              .run();
            onOpenChange(false);
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="table-rows">행</Label>
              <Input
                id="table-rows"
                type="number"
                min={1}
                max={50}
                value={rows}
                onChange={(e) => setRows(Number(e.target.value))}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="table-cols">열</Label>
              <Input
                id="table-cols"
                type="number"
                min={1}
                max={20}
                value={cols}
                onChange={(e) => setCols(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="table-header" checked={header} onCheckedChange={setHeader} />
            <Label htmlFor="table-header">첫 행을 머리글로</Label>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="table-caption">캡션</Label>
            <Input
              id="table-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="표 설명"
            />
          </div>
        </form>
        <DialogFooter>
          <Button type="submit" form="table-form">
            삽입
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
