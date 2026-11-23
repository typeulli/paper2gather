"use client";

import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { ImageIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { refocusEditor } from "@/lib/editor-utils";
import { cn } from "@/lib/utils";

interface FigureDialogProps {
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FigureDialog({ editor, open, onOpenChange }: FigureDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [mode, setMode] = useState<"upload" | "url">("upload");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const reset = () => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview(null);
    setUrl("");
    setCaption("");
    setBusy(false);
  };

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast.error("이미지 파일만 업로드할 수 있습니다.");
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const insert = async () => {
    setBusy(true);
    try {
      let src = url.trim();
      if (mode === "upload") {
        if (!file) return;
        src = (await api.uploadImage(file)).url;
      }
      if (!src) return;
      editor.chain().focus().insertFigure({ src, caption }).run();
      onOpenChange(false);
      reset();
    } catch (err) {
      toast.error(`이미지 업로드 실패: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const canInsert = mode === "upload" ? !!file : /^https?:\/\//.test(url.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={refocusEditor(editor)}>
        <DialogHeader>
          <DialogTitle>그림 삽입</DialogTitle>
          <DialogDescription>그림 번호는 문서 내 순서에 따라 자동으로 매겨집니다.</DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(v) => setMode(v as "upload" | "url")}>
          <TabsList>
            <TabsTrigger value="upload">파일 업로드</TabsTrigger>
            <TabsTrigger value="url">이미지 URL</TabsTrigger>
          </TabsList>
          <TabsContent value="upload">
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                pick(e.dataTransfer.files[0]);
              }}
              className={cn(
                "flex h-48 cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border-2 border-dashed text-sm text-muted-foreground transition-colors hover:bg-muted/50",
                dragOver && "border-primary bg-primary/5"
              )}
            >
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                <img src={preview} alt="" className="max-h-full max-w-full object-contain" />
              ) : (
                <>
                  <ImageIcon className="size-6" />
                  클릭하거나 이미지를 끌어다 놓으세요 (PNG, JPG, GIF, WebP, SVG)
                </>
              )}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => pick(e.target.files?.[0])}
              />
            </label>
          </TabsContent>
          <TabsContent value="url" className="flex flex-col gap-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/figure.png" />
          </TabsContent>
        </Tabs>
        <div className="flex flex-col gap-2">
          <Label htmlFor="figure-caption">캡션</Label>
          <Input
            id="figure-caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="그림 설명 ($...$로 수식 사용 가능)"
          />
        </div>
        <DialogFooter>
          <Button onClick={insert} disabled={!canInsert || busy}>
            {busy && <Loader2Icon className="animate-spin" />} 삽입
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
