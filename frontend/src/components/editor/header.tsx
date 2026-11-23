"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { WebsocketProvider } from "y-websocket";
import {
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  FileCodeIcon,
  FileTextIcon,
  HistoryIcon,
  ImageIcon,
  PanelRightIcon,
  PrinterIcon,
  SettingsIcon,
  Share2Icon,
  SigmaIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserDialog } from "@/components/user-dialog";
import { downloadBlob, downloadText, safeFileName } from "@/lib/download";
import type { DocxEquationMode } from "@/lib/docx/export";
import type { HwpxEquationMode } from "@/lib/hwpx/export";
import { referencesToBibtex } from "@/lib/paper/bibtex";
import { exportLatex, type LatexExportResult } from "@/lib/paper/latex";
import { initialsOf } from "@/lib/user";
import { cn } from "@/lib/utils";
import { HistoryDialog } from "./dialogs/history-dialog";
import { LatexPreviewDialog } from "./dialogs/latex-preview-dialog";
import type { ConnectionStatus } from "./editor-page";
import { useMeta, usePaper } from "./paper-context";

interface PresenceUser {
  clientId: number;
  name: string;
  color: string;
  isSelf: boolean;
}

function usePresence(provider: WebsocketProvider): PresenceUser[] {
  const [users, setUsers] = useState<PresenceUser[]>([]);
  useEffect(() => {
    const { awareness } = provider;
    const update = () => {
      const list: PresenceUser[] = [];
      awareness.getStates().forEach((state, clientId) => {
        const user = state.user as { name?: string; color?: string } | undefined;
        if (!user?.name) return;
        list.push({
          clientId,
          name: user.name,
          color: user.color ?? "#64748b",
          isSelf: clientId === awareness.clientID,
        });
      });
      list.sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
      setUsers(list);
    };
    update();
    awareness.on("change", update);
    return () => awareness.off("change", update);
  }, [provider]);
  return users;
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connected: "실시간 동기화 중",
  connecting: "연결 중…",
  disconnected: "오프라인 — 재연결 시 변경사항이 병합됩니다",
};

interface EditorHeaderProps {
  status: ConnectionStatus;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function EditorHeader({ status, sidebarOpen, onToggleSidebar }: EditorHeaderProps) {
  const { provider, editor, store, numbering, citations, ui } = usePaper();
  const { title } = useMeta();
  const users = usePresence(provider);
  const [latexPreview, setLatexPreview] = useState<LatexExportResult | null>(null);
  // Remounted (fresh state) on every open
  const [history, setHistory] = useState({ open: false, key: 0 });
  const [hwpxBusy, setHwpxBusy] = useState(false);
  const [docxBusy, setDocxBusy] = useState(false);
  const fileBase = safeFileName(title);

  useEffect(() => {
    document.title = `${title || "제목 없는 논문"} · Paper2Gather`;
  }, [title]);

  const buildLatex = () => {
    if (!editor) return null;
    return exportLatex({
      content: editor.getJSON(),
      title,
      authors: store.authorsSlice.get(),
      citations: citations.get(),
      format: store.formatSlice.get(),
      objectsById: numbering.get().byId,
    });
  };

  const downloadTex = () => {
    const result = buildLatex();
    if (!result) return;
    downloadText(`${fileBase}.tex`, result.tex, "application/x-tex");
    if (result.figures.length > 0) {
      toast.info(`그림 ${result.figures.length}개는 'LaTeX 소스 보기'에서 내려받아 figures/ 폴더에 넣어주세요.`);
    }
  };

  const downloadBib = () => {
    const refs = store.referencesSlice.get().list;
    if (refs.length === 0) {
      toast.info("내보낼 참고문헌이 없습니다.");
      return;
    }
    downloadText(`${fileBase}.bib`, referencesToBibtex(refs), "application/x-bibtex");
  };

  const downloadHwpx = async (equations: HwpxEquationMode) => {
    if (!editor || hwpxBusy) return;
    setHwpxBusy(true);
    const message = "한글 파일을 만드는 중입니다…";
    const bar = (fraction: number) => ({
      description: <Progress value={fraction * 100} className="mt-1" aria-label={message} />,
      classNames: { content: "w-full" },
    });
    const progress = toast.loading(message, bar(0));
    try {
      const [{ exportHwpx }, { browserHwpxAssets }] = await Promise.all([
        import("@/lib/hwpx/export"),
        import("@/lib/hwpx/export-images"),
      ]);
      const result = await exportHwpx(
        {
          content: editor.getJSON(),
          title,
          authors: store.authorsSlice.get(),
          citations: citations.get(),
          format: store.formatSlice.get(),
          objectsById: numbering.get().byId,
          equations,
        },
        browserHwpxAssets,
        (fraction) => toast.loading(message, { id: progress, ...bar(fraction) })
      );
      downloadBlob(`${fileBase}.hwpx`, new Blob([result.data.slice()], { type: "application/hwp+zip" }));
      const notes = [
        result.otherForm > 0 &&
          (equations === "native"
            ? `한글 수식으로 바꿀 수 없는 수식 ${result.otherForm}개는 이미지로 넣었습니다.`
            : `이미지로 만들지 못한 수식 ${result.otherForm}개는 한글 수식으로 넣었습니다.`),
        result.asSource > 0 && `변환하지 못한 수식 ${result.asSource}개는 LaTeX 원문으로 넣었습니다.`,
        result.missingFigures > 0 && `그림 ${result.missingFigures}개를 넣지 못했습니다.`,
      ].filter(Boolean);
      if (notes.length > 0) toast.warning(notes.join(" "), { id: progress, description: null });
      else toast.success("한글 파일을 내보냈습니다.", { id: progress, description: null });
    } catch {
      toast.error("한글 파일을 만들지 못했습니다.", { id: progress, description: null });
    } finally {
      setHwpxBusy(false);
    }
  };

  const downloadDocx = async (equations: DocxEquationMode) => {
    if (!editor || docxBusy) return;
    setDocxBusy(true);
    const message = "Word 파일을 만드는 중입니다…";
    const bar = (fraction: number) => ({
      description: <Progress value={fraction * 100} className="mt-1" aria-label={message} />,
      classNames: { content: "w-full" },
    });
    const progress = toast.loading(message, bar(0));
    try {
      const [{ exportDocx }, { browserHwpxAssets }] = await Promise.all([
        import("@/lib/docx/export"),
        import("@/lib/hwpx/export-images"),
      ]);
      const result = await exportDocx(
        {
          content: editor.getJSON(),
          title,
          authors: store.authorsSlice.get(),
          citations: citations.get(),
          format: store.formatSlice.get(),
          objectsById: numbering.get().byId,
          comments: store.commentsSlice.get(),
          equations,
        },
        browserHwpxAssets,
        (fraction) => toast.loading(message, { id: progress, ...bar(fraction) })
      );
      downloadBlob(
        `${fileBase}.docx`,
        new Blob([result.data.slice()], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })
      );
      const notes = [
        result.otherForm > 0 &&
          (equations === "native"
            ? `Word 수식으로 바꿀 수 없는 수식 ${result.otherForm}개는 이미지로 넣었습니다.`
            : `이미지로 만들지 못한 수식 ${result.otherForm}개는 Word 수식으로 넣었습니다.`),
        result.asSource > 0 && `변환하지 못한 수식 ${result.asSource}개는 LaTeX 원문으로 넣었습니다.`,
        result.missingFigures > 0 && `그림 ${result.missingFigures}개를 넣지 못했습니다.`,
      ].filter(Boolean);
      if (notes.length > 0) toast.warning(notes.join(" "), { id: progress, description: null });
      else toast.success("Word 파일을 내보냈습니다.", { id: progress, description: null });
    } catch {
      toast.error("Word 파일을 만들지 못했습니다.", { id: progress, description: null });
    } finally {
      setDocxBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("문서 링크를 복사했습니다. 링크가 있는 사람은 누구나 편집할 수 있습니다.");
    } catch {
      toast.error("클립보드에 복사하지 못했습니다.");
    }
  };

  const visible = users.slice(0, 5);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-2 print:hidden">
      <Button variant="ghost" size="icon-sm" asChild title="문서 목록">
        <Link href="/">
          <ArrowLeftIcon />
        </Link>
      </Button>
      <div className="flex min-w-0 items-center gap-2">
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{title || "제목 없는 논문"}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                status === "connected" && "bg-emerald-500",
                status === "connecting" && "animate-pulse bg-amber-500",
                status === "disconnected" && "bg-destructive"
              )}
            />
          </TooltipTrigger>
          <TooltipContent>{STATUS_TEXT[status]}</TooltipContent>
        </Tooltip>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <AvatarGroup className="mr-2 hidden sm:flex">
          {visible.map((u) => (
            <Tooltip key={u.clientId}>
              <TooltipTrigger asChild>
                <Avatar size="sm">
                  <AvatarFallback style={{ backgroundColor: u.color }} className="text-[10px] text-white">
                    {initialsOf(u.name)}
                  </AvatarFallback>
                </Avatar>
              </TooltipTrigger>
              <TooltipContent>
                {u.name}
                {u.isSelf && " (나)"}
              </TooltipContent>
            </Tooltip>
          ))}
          {users.length > visible.length && <AvatarGroupCount>+{users.length - visible.length}</AvatarGroupCount>}
        </AvatarGroup>

        <Button variant="outline" size="sm" onClick={copyLink}>
          <Share2Icon /> 공유
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <DownloadIcon /> 내보내기
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>내보내기</DropdownMenuLabel>
            <DropdownMenuItem onSelect={downloadTex}>
              <FileCodeIcon /> LaTeX (.tex)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={downloadBib}>
              <FileTextIcon /> BibTeX (.bib)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setLatexPreview(buildLatex())}>
              <CopyIcon /> LaTeX 소스 보기 / 복사
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={hwpxBusy}>
                <FileTextIcon /> 한글 (.hwpx)
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                <DropdownMenuLabel>수식을 넣는 방식</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void downloadHwpx("native")}>
                  <SigmaIcon /> 한글 수식 (편집 가능)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void downloadHwpx("image")}>
                  <ImageIcon /> 이미지 (화면과 같은 모양)
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={docxBusy}>
                <FileTextIcon /> Word (.docx)
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                <DropdownMenuLabel>수식을 넣는 방식</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void downloadDocx("native")}>
                  <SigmaIcon /> Word 수식 (편집 가능)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void downloadDocx("image")}>
                  <ImageIcon /> 이미지 (화면과 같은 모양)
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setTimeout(() => window.print(), 100)}>
              <PrinterIcon /> 인쇄 / PDF로 저장
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon-sm"
          title="수정 기록"
          onClick={() => setHistory((h) => ({ open: true, key: h.key + 1 }))}
        >
          <HistoryIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" title="문서 양식" onClick={() => ui.openFormatDialog()}>
          <SettingsIcon />
        </Button>
        <ThemeToggle />
        <UserDialog />
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("hidden md:inline-flex", sidebarOpen && "bg-muted")}
          title="참고문헌·개체·댓글 패널"
          onClick={onToggleSidebar}
        >
          <PanelRightIcon />
        </Button>
      </div>

      <LatexPreviewDialog result={latexPreview} onClose={() => setLatexPreview(null)} fileBase={fileBase} />
      <HistoryDialog
        key={history.key}
        open={history.open}
        onOpenChange={(open) => setHistory((h) => ({ ...h, open }))}
      />
    </header>
  );
}
