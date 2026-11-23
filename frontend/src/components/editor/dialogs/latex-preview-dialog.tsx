"use client";

import { CopyIcon, DownloadIcon, ImageIcon } from "lucide-react";
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
import { downloadText } from "@/lib/download";
import type { LatexExportResult } from "@/lib/paper/latex";

interface LatexPreviewDialogProps {
  /** The dialog is open while a result is set */
  result: LatexExportResult | null;
  onClose: () => void;
  fileBase: string;
}

export function LatexPreviewDialog({ result, onClose, fileBase }: LatexPreviewDialogProps) {
  return (
    <Dialog open={result !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>LaTeX 소스</DialogTitle>
          <DialogDescription>
            참고문헌은 목록 순서를 그대로 유지하도록 thebibliography 환경으로 출력됩니다.
          </DialogDescription>
        </DialogHeader>
        <textarea
          readOnly
          value={result?.tex ?? ""}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none rounded-md border bg-muted/40 p-3 font-mono text-xs"
          style={{ height: "50vh" }}
        />
        {result && result.figures.length > 0 && (
          <div className="flex flex-col gap-1 text-xs">
            <span className="font-medium">그림 파일 ({result.figures.length}) — figures/ 폴더에 저장하세요</span>
            <div className="flex flex-wrap gap-1">
              {result.figures.map((f) => (
                <a
                  key={f.path}
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  download={f.path.split("/").pop()}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted"
                >
                  <ImageIcon className="size-3" /> {f.path}
                </a>
              ))}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              if (!result) return;
              await navigator.clipboard.writeText(result.tex);
              toast.success("LaTeX 소스를 복사했습니다.");
            }}
          >
            <CopyIcon /> 복사
          </Button>
          <Button onClick={() => result && downloadText(`${fileBase}.tex`, result.tex, "application/x-tex")}>
            <DownloadIcon /> .tex 다운로드
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
