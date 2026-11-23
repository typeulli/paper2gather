"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CopyIcon,
  EllipsisVerticalIcon,
  FileTextIcon,
  FileUpIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  ServerCrashIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { UserDialog } from "@/components/user-dialog";
import { api, type DocumentMeta, type FormatPrefab } from "@/lib/api";
import { API_URL } from "@/lib/config";

const dateFormat = new Intl.DateTimeFormat("ko", { dateStyle: "medium", timeStyle: "short" });

/** Select value for the editor's own format */
const DEFAULT_PREFAB = "default";

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState<"paper" | "blank">("paper");
  const [prefab, setPrefab] = useState(DEFAULT_PREFAB);
  const [prefabs, setPrefabs] = useState<FormatPrefab[]>([]);
  const [busy, setBusy] = useState(false);

  // Without the list (server unreachable) only the default format is offered.
  useEffect(() => {
    if (!open || prefabs.length > 0) return;
    api.listPrefabs().then(setPrefabs, () => {});
  }, [open, prefabs.length]);

  const create = async () => {
    setBusy(true);
    try {
      const doc = await api.createDocument(
        title.trim() || "Untitled Paper",
        template,
        prefab === DEFAULT_PREFAB ? undefined : prefab
      );
      router.push(`/doc/${doc.id}`);
    } catch (err) {
      toast.error(`문서를 만들지 못했습니다: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>새 논문</DialogTitle>
          <DialogDescription>링크를 공유하면 바로 함께 편집할 수 있습니다.</DialogDescription>
        </DialogHeader>
        <form
          id="create-form"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-title">제목</Label>
            <Input
              id="new-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled Paper"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>템플릿</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={template}
              onValueChange={(v) => v && setTemplate(v as "paper" | "blank")}
              className="w-full"
            >
              <ToggleGroupItem value="paper" className="flex-1">
                논문 구성 (Abstract~Conclusion)
              </ToggleGroupItem>
              <ToggleGroupItem value="blank" className="flex-1">
                빈 문서
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-prefab">양식</Label>
            <Select value={prefab} onValueChange={setPrefab}>
              <SelectTrigger id="new-prefab" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_PREFAB}>기본 양식</SelectItem>
                {prefabs.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {prefab === DEFAULT_PREFAB
                ? "A4, 여백 25 mm, Times New Roman · Noto Serif KR. 나중에 문서 양식에서 바꿀 수 있습니다."
                : `${prefabs.find((p) => p.id === prefab)?.description ?? ""} 공식 템플릿은 아닙니다.`}
            </p>
          </div>
        </form>
        <DialogFooter>
          <Button type="submit" form="create-form" disabled={busy}>
            {busy && <Loader2Icon className="animate-spin" />} 만들기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DocumentList() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocumentMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentMeta | null>(null);
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDocs(await api.listDocuments());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch from an external API
    void load();
  }, [load]);

  const duplicate = async (doc: DocumentMeta) => {
    try {
      const copy = await api.duplicateDocument(doc.id);
      toast.success("문서를 복제했습니다.");
      router.push(`/doc/${copy.id}`);
    } catch (err) {
      toast.error(`복제 실패: ${(err as Error).message}`);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    const toastId = toast.loading(`"${file.name}" 변환 중…`);
    try {
      // The converter pulls in the editor schema, so it is loaded only when needed.
      const { importHwpx } = await import("@/lib/hwpx/import");
      const { doc, notices } = await importHwpx(file);
      toast.success("HWPX 문서를 가져왔습니다.", { id: toastId, description: notices.join(" ") || undefined });
      router.push(`/doc/${doc.id}`);
    } catch (err) {
      toast.error(`가져오기 실패: ${(err as Error).message}`, { id: toastId });
      setImporting(false);
    }
  };

  const remove = async (doc: DocumentMeta) => {
    try {
      await api.deleteDocument(doc.id);
      setDocs((list) => list?.filter((d) => d.id !== doc.id) ?? null);
      toast.success("문서를 삭제했습니다.");
    } catch (err) {
      toast.error(`삭제 실패: ${(err as Error).message}`);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-muted/30">
      <header className="flex h-14 items-center gap-3 border-b bg-background px-4 sm:px-8">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary font-serif text-lg font-bold text-primary-foreground">
          P
        </span>
        <span className="font-semibold">Paper2Gather</span>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <UserDialog />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-10 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">내 논문</h1>
            <p className="text-sm text-muted-foreground">
              LaTeX 수식·자동 번호·참고문헌 관리를 지원하는 실시간 공동 작성 문서
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={importing} onClick={() => importRef.current?.click()}>
              {importing ? <Loader2Icon className="animate-spin" /> : <FileUpIcon />} HWPX 가져오기
            </Button>
            <input
              ref={importRef}
              type="file"
              accept=".hwpx"
              className="hidden"
              aria-label="HWPX 파일 선택"
              onChange={(e) => {
                void importFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon /> 새 논문
            </Button>
          </div>
        </div>

        {error ? (
          <Card className="items-center gap-3 py-12 text-center">
            <ServerCrashIcon className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">백엔드 서버에 연결할 수 없습니다</p>
              <p className="text-sm text-muted-foreground">
                {API_URL} 에서 backend가 실행 중인지 확인하세요 ({error})
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCwIcon /> 다시 시도
            </Button>
          </Card>
        ) : docs === null ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <Card className="items-center gap-3 py-16 text-center">
            <FileTextIcon className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">아직 문서가 없습니다. 첫 논문을 만들어 보세요.</p>
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon /> 새 논문
            </Button>
          </Card>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {docs.map((doc) => (
              <li key={doc.id}>
                <Card className="relative h-full gap-0 py-0 transition-shadow hover:shadow-md">
                  <Link href={`/doc/${doc.id}`} className="flex h-full flex-col rounded-xl">
                    <CardHeader className="gap-1 py-5 pr-12">
                      <CardTitle className="line-clamp-2 font-serif text-base leading-snug">{doc.title}</CardTitle>
                      <CardDescription className="text-xs">
                        수정 {dateFormat.format(new Date(doc.updatedAt))}
                      </CardDescription>
                    </CardHeader>
                  </Link>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" title="더 보기">
                        <EllipsisVerticalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void duplicate(doc)}>
                        <CopyIcon /> 복제
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => setPendingDelete(doc)}>
                        <Trash2Icon /> 삭제
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </main>

      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>&ldquo;{pendingDelete?.title}&rdquo;을(를) 삭제할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              문서와 모든 참고문헌·댓글이 영구 삭제되며, 편집 중인 공동 작업자의 연결도 끊어집니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) void remove(pendingDelete);
                setPendingDelete(null);
              }}
            >
              삭제
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
