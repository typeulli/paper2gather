"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { diffLines, diffWords, type Change } from "diff";
import { BotIcon, ChevronDownIcon, ChevronUpIcon, HistoryIcon, Loader2Icon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, type RevisionAuthor, type RevisionContent, type RevisionInfo, type RevisionText } from "@/lib/api";
import { diffPaper } from "@/lib/paper/revision-diff";
import { cn } from "@/lib/utils";
import { useFormat, usePaper } from "../paper-context";
import { ADDED, REMOVED, RevisionPaper, revisionVersion } from "./revision-paper";

/** The list is reloaded this long after the last change of the paper */
const REFRESH_MS = 1500;

/** The changes shown as the paper, or as text (LaTeX source) */
type View = "paper" | "source";

const SECTIONS: { key: keyof RevisionText; label: string }[] = [
  { key: "title", label: "제목" },
  { key: "authors", label: "저자" },
  { key: "body", label: "본문" },
  { key: "references", label: "참고문헌" },
];

// Korean words are compared whole, not syllable by syllable.
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("ko", { granularity: "word" }) : undefined;

/** Paragraphs (lines) first, then the words of the changed ones */
function diffText(before: string, after: string): Change[] {
  const lines = diffLines(before, after);
  const out: Change[] = [];
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i];
    const next = lines[i + 1];
    if (part.removed && next?.added) {
      const words = diffWords(part.value, next.value, { intlSegmenter: segmenter, maxEditLength: 5000 });
      if (words) {
        out.push(...words);
        i++;
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

const dayTime = new Intl.DateTimeFormat("ko", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const timeOnly = new Intl.DateTimeFormat("ko", { hour: "numeric", minute: "2-digit" });

function timeRange(rev: RevisionInfo): string {
  const start = dayTime.format(rev.startedAt);
  if (Math.floor(rev.startedAt / 60_000) === Math.floor(rev.endedAt / 60_000)) return start;
  const sameDay = new Date(rev.startedAt).toDateString() === new Date(rev.endedAt).toDateString();
  return `${start} – ${(sameDay ? timeOnly : dayTime).format(rev.endedAt)}`;
}

function AuthorLabel({ author }: { author: RevisionAuthor }) {
  if (author.kind === "mcp") {
    return (
      <Badge variant="secondary" className="bg-violet-500/15 text-violet-700 dark:text-violet-300">
        <BotIcon /> MCP
      </Badge>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: author.color || "#64748b" }} />
      <span className="truncate font-medium">{author.name || "이름 없음"}</span>
    </span>
  );
}

/** Moves between the changes of a view (its elements with data-change) */
function useChangeNavigation(containerRef: RefObject<HTMLDivElement | null>, changes: number) {
  const [current, setCurrent] = useState(0);
  const go = (index: number) => {
    setCurrent(index);
    containerRef.current
      ?.querySelector(`[data-change="${index}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  // Shown from the first change (the view is remounted for each revision), once laid out
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      containerRef.current?.querySelector('[data-change="0"]')?.scrollIntoView({ block: "center" })
    );
    return () => cancelAnimationFrame(frame);
  }, [containerRef]);
  // A live revision can lose changes when it's reloaded.
  return { current: Math.min(current, Math.max(0, changes - 1)), go };
}

function ChangeBar({
  changes,
  current,
  onGo,
  empty,
}: {
  changes: number;
  current: number;
  onGo: (index: number) => void;
  empty: string;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-popover/95 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur">
      {changes > 0 ? (
        <>
          <span>
            변경 {changes}곳 · <span className={cn(ADDED, "px-1")}>추가</span>{" "}
            <span className={cn(REMOVED, "px-1")}>삭제</span>
          </span>
          <span className="ml-auto tabular-nums">
            {current + 1} / {changes}
          </span>
          <Button variant="ghost" size="icon-xs" title="이전 변경" onClick={() => onGo((current - 1 + changes) % changes)}>
            <ChevronUpIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" title="다음 변경" onClick={() => onGo((current + 1) % changes)}>
            <ChevronDownIcon />
          </Button>
        </>
      ) : (
        <span>{empty}</span>
      )}
    </div>
  );
}

function PaperDiffView({ before, after }: { before: RevisionContent; after: RevisionContent }) {
  const format = useFormat();
  // Numbered and cited in the current format
  const versions = useMemo(
    () => ({ before: revisionVersion(before, format), after: revisionVersion(after, format) }),
    [before, after, format]
  );
  const diff = useMemo(
    () => diffPaper(before, after, { before: versions.before.citations, after: versions.after.citations }),
    [before, after, versions]
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const { current, go } = useChangeNavigation(containerRef, diff.changes);

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto bg-muted/40">
      <ChangeBar
        changes={diff.changes}
        current={current}
        onGo={go}
        empty="보이는 변경이 없습니다. 정렬·라벨 같은 속성만 바뀌었을 수 있습니다."
      />
      {/* The current change is outlined without rendering the paper again. */}
      <style>{`[data-revision-paper] [data-change="${current}"]{outline:2px solid color-mix(in oklab,var(--primary) 45%,transparent);outline-offset:2px}`}</style>
      <div data-revision-paper className="px-4 py-6">
        <RevisionPaper before={versions.before} after={versions.after} diff={diff} />
      </div>
    </div>
  );
}

function DiffView({ before, after }: { before: RevisionText; after: RevisionText }) {
  const { sections, changes } = useMemo(() => {
    let changes = 0;
    const sections = SECTIONS.flatMap(({ key, label }) => {
      if (!before[key] && !after[key]) return [];
      // Adjacent removed and added parts are one change.
      let inChange = false;
      const parts = diffText(before[key], after[key]).map((part) => {
        const changed = part.added || part.removed;
        const index = !changed ? -1 : inChange ? changes - 1 : changes++;
        inChange = changed;
        return { ...part, index };
      });
      return [{ key, label, parts }];
    });
    return { sections, changes };
  }, [before, after]);

  const containerRef = useRef<HTMLDivElement>(null);
  const { current, go } = useChangeNavigation(containerRef, changes);

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto">
      <ChangeBar
        changes={changes}
        current={current}
        onGo={go}
        empty="글자로 보이는 변경이 없습니다. 글꼴·색·정렬 같은 서식만 바뀌었을 수 있습니다."
      />
      <div className="flex flex-col gap-5 px-4 py-3">
        {sections.map(({ key, label, parts }) => (
          <section key={key}>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">{label}</h3>
            <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">
              {parts.map((part, i) => {
                const highlight = part.index === current && "ring-2 ring-primary/40";
                if (part.added) {
                  return (
                    <ins key={i} data-change={part.index} className={cn(ADDED, highlight)}>
                      {part.value}
                    </ins>
                  );
                }
                if (part.removed) {
                  return (
                    <del key={i} data-change={part.index} className={cn(REMOVED, highlight)}>
                      {part.value}
                    </del>
                  );
                }
                return <span key={i}>{part.value}</span>;
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

type LoadedRevision = {
  /** endedAt when loaded: a live revision is loaded again when it grows */
  endedAt: number;
} & (
  | { view: "paper"; before: RevisionContent; after: RevisionContent }
  | { view: "source"; before: RevisionText; after: RevisionText }
);

interface HistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HistoryDialog({ open, onOpenChange }: HistoryDialogProps) {
  const { docId, ydoc, user } = usePaper();
  const [revisions, setRevisions] = useState<RevisionInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** null: the newest */
  const [activeId, setActiveId] = useState<number | null>(null);
  const [view, setView] = useState<View>("paper");
  /** By view and revision id */
  const [loaded, setLoaded] = useState<Map<string, LoadedRevision>>(() => new Map());
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  // The kind stays while the confirmation closes.
  const [confirm, setConfirm] = useState<{ kind: "restore" | "delete"; open: boolean }>({
    kind: "restore",
    open: false,
  });
  const [busy, setBusy] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listRevisions(docId);
      setRevisions(list);
      setLoadError(null);
      const ids = new Set(list.map((r) => r.id));
      setChecked((prev) => new Set([...prev].filter((id) => ids.has(id))));
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [docId]);

  // Up to date while open: reloaded after the paper changes
  useEffect(() => {
    if (!open) return;
    // The state is set when the request answers, not in the effect itself.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_MS);
    };
    ydoc.on("update", onUpdate);
    return () => {
      ydoc.off("update", onUpdate);
      clearTimeout(timer);
    };
  }, [open, ydoc, refresh]);

  const active = revisions?.find((r) => r.id === activeId) ?? revisions?.[0] ?? null;
  const activeRevId = active?.id;
  const activeEndedAt = active?.endedAt;
  const shown = active ? loaded.get(`${view}:${active.id}`) : undefined;

  useEffect(() => {
    if (!open || activeRevId === undefined || activeEndedAt === undefined) return;
    const key = `${view}:${activeRevId}`;
    if (loaded.get(key)?.endedAt === activeEndedAt) return;
    let cancelled = false;
    const request: Promise<LoadedRevision> =
      view === "paper"
        ? api
            .getRevisionContent(docId, activeRevId)
            .then((content) => ({ view: "paper", endedAt: activeEndedAt, ...content }))
        : api
            .getRevision(docId, activeRevId)
            .then((texts) => ({ view: "source", endedAt: activeEndedAt, ...texts }));
    request
      .then((entry) => {
        if (!cancelled) setLoaded((prev) => new Map(prev).set(key, entry));
      })
      .catch((err) => {
        if (!cancelled) toast.error(`수정 내용을 불러오지 못했습니다: ${(err as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [open, docId, view, activeRevId, activeEndedAt, loaded]);

  const list = revisions ?? [];
  const allChecked = list.length > 0 && checked.size === list.length;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = checked.size > 0 && !allChecked;
  }, [checked, allChecked]);

  /** Shift+click checks or unchecks the range from the last clicked row. */
  const toggle = (index: number, range: boolean) => {
    const value = !checked.has(list[index].id);
    const next = new Set(checked);
    const [from, to] = range && anchor !== null ? [Math.min(anchor, index), Math.max(anchor, index)] : [index, index];
    for (let i = from; i <= to; i++) {
      if (value) next.add(list[i].id);
      else next.delete(list[i].id);
    }
    setChecked(next);
    setAnchor(index);
  };

  const restore = async () => {
    if (!active) return;
    setBusy(true);
    try {
      const { changed } = await api.restoreRevision(docId, active.id, { name: user.name, color: user.color });
      if (changed) toast.success(`#${active.id} 수정 이후 상태로 되돌렸습니다.`);
      else toast.info("이미 그 상태입니다.");
      setActiveId(null);
      await refresh();
    } catch (err) {
      toast.error(`되돌리지 못했습니다: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ids = [...checked];
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await api.deleteRevisions(docId, ids);
      toast.success(`기록 ${ids.length}개를 삭제했습니다.`);
      setChecked(new Set());
      setAnchor(null);
      if (activeId !== null && ids.includes(activeId)) setActiveId(null);
      await refresh();
    } catch (err) {
      toast.error(`삭제하지 못했습니다: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const isNewest = active !== null && active.id === list[0]?.id;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex h-[85vh] flex-col gap-3 sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>수정 기록</DialogTitle>
            <DialogDescription>
              각 수정을 바로 전 상태와 비교합니다. 추가된 글은 초록색, 지운 글은 빨간색입니다. 모양이 바뀐 그림·표는
              이전(빨간 테두리)과 이후(초록 테두리)를 함께 보여줍니다. 댓글은 기록하지 않습니다.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border md:flex-row">
            <aside className="flex max-h-56 shrink-0 flex-col border-b md:max-h-none md:w-72 md:border-r md:border-b-0">
              <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-xs">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={allChecked}
                  disabled={list.length === 0}
                  onChange={() => setChecked(allChecked ? new Set() : new Set(list.map((r) => r.id)))}
                  aria-label="모두 선택"
                />
                <span className="text-muted-foreground">
                  {checked.size > 0 ? `${checked.size}개 선택` : `${list.length}개`}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto text-destructive hover:text-destructive"
                  disabled={checked.size === 0 || busy}
                  onClick={() => setConfirm({ kind: "delete", open: true })}
                >
                  <Trash2Icon /> 삭제
                </Button>
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto select-none">
                {revisions === null && !loadError && (
                  <li className="flex justify-center p-6 text-muted-foreground">
                    <Loader2Icon className="size-5 animate-spin" />
                  </li>
                )}
                {loadError && <li className="p-4 text-sm text-destructive">기록을 불러오지 못했습니다: {loadError}</li>}
                {revisions?.length === 0 && (
                  <li className="p-4 text-sm text-muted-foreground">
                    아직 기록이 없습니다. 이 기능이 생긴 뒤의 수정부터 기록됩니다.
                  </li>
                )}
                {list.map((rev, i) => (
                  <li
                    key={rev.id}
                    className={cn(
                      "flex items-start gap-2 border-b px-3 py-2 text-sm hover:bg-muted/60",
                      rev.id === active?.id && "bg-muted"
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                      checked={checked.has(rev.id)}
                      onChange={(e) => toggle(i, "shiftKey" in e.nativeEvent && (e.nativeEvent as MouseEvent).shiftKey)}
                      aria-label={`#${rev.id} 선택`}
                    />
                    <button type="button" className="flex min-w-0 flex-1 flex-col gap-0.5 text-left" onClick={() => setActiveId(rev.id)}>
                      <span className="flex items-center gap-2">
                        <AuthorLabel author={rev.author} />
                        {rev.live && (
                          <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                            편집 중
                          </Badge>
                        )}
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">#{rev.id}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{timeRange(rev)}</span>
                      {rev.restoredFrom !== undefined && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <RotateCcwIcon className="size-3" /> #{rev.restoredFrom} 이후 상태로 되돌림
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </aside>

            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              {active ? (
                <>
                  <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4 text-sm">
                    <AuthorLabel author={active.author} />
                    <span className="truncate text-xs text-muted-foreground">
                      {timeRange(active)}
                      {active.restoredFrom !== undefined && ` · #${active.restoredFrom} 이후 상태로 되돌림`}
                    </span>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      size="sm"
                      spacing={0}
                      className="ml-auto shrink-0"
                      value={view}
                      onValueChange={(value) => value && setView(value as View)}
                    >
                      <ToggleGroupItem value="paper" title="논문으로 보기">
                        논문
                      </ToggleGroupItem>
                      <ToggleGroupItem value="source" title="글자(LaTeX 소스)로 보기">
                        소스
                      </ToggleGroupItem>
                    </ToggleGroup>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={busy || isNewest}
                      title={isNewest ? "지금 문서가 이 상태입니다" : undefined}
                      onClick={() => setConfirm({ kind: "restore", open: true })}
                    >
                      <RotateCcwIcon /> 이 수정 이후로 되돌리기
                    </Button>
                  </div>
                  {shown?.view === "paper" ? (
                    <PaperDiffView key={active.id} before={shown.before} after={shown.after} />
                  ) : shown?.view === "source" ? (
                    <DiffView key={active.id} before={shown.before} after={shown.after} />
                  ) : (
                    <div className="flex flex-1 items-center justify-center text-muted-foreground">
                      <Loader2Icon className="size-5 animate-spin" />
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                  <HistoryIcon className="size-8" />
                  수정을 고르면 바뀐 내용이 여기에 보입니다.
                </div>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirm.open} onOpenChange={(o) => setConfirm((c) => ({ ...c, open: o }))}>
        <AlertDialogContent>
          {confirm.kind === "restore" ? (
            <AlertDialogHeader>
              <AlertDialogTitle>#{active?.id} 수정 이후 상태로 되돌릴까요?</AlertDialogTitle>
              <AlertDialogDescription>
                제목·저자·참고문헌·본문이 이 수정이 끝난 시점으로 바뀝니다. 그 뒤의 수정은 기록에 남아 있고, 되돌린 것도
                새 기록으로 남아 다시 되돌릴 수 있습니다. 댓글은 그대로 둡니다.
              </AlertDialogDescription>
            </AlertDialogHeader>
          ) : (
            <AlertDialogHeader>
              <AlertDialogTitle>선택한 기록 {checked.size}개를 삭제할까요?</AlertDialogTitle>
              <AlertDialogDescription>
                문서 내용은 바뀌지 않고 기록만 지워집니다. 지운 기록은 되살릴 수 없습니다.
              </AlertDialogDescription>
            </AlertDialogHeader>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm.kind === "delete" ? "destructive" : "default"}
              onClick={() => void (confirm.kind === "restore" ? restore() : remove())}
            >
              {confirm.kind === "restore" ? "되돌리기" : "삭제"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
