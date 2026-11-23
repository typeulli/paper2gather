"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
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
import { refocusEditor } from "@/lib/editor-utils";
import { compileTikz, peekTikz, tikzEngineLoaded, type TikzResult } from "@/lib/tikz/engine";
import {
  ALL_TIKZ_LIBRARIES,
  COMMON_TIKZ_LIBRARIES,
  DEFAULT_TIKZ_CODE,
  splitList,
  TIKZ_PACKAGES,
  toggleInList,
  type TikzSource,
} from "@/lib/tikz/options";
import { cn } from "@/lib/utils";
import { tikzErrorText, TikzSvg } from "../nodes/tikz-svg";

/** Pause in typing before the preview is compiled again */
const PREVIEW_DELAY_MS = 1000;
const LINE_HEIGHT_PX = 20;

interface TikzDialogProps {
  editor: Editor;
  open: boolean;
  /** The figure to edit; a new figure is inserted when unset */
  figureId?: string;
  onOpenChange: (open: boolean) => void;
}

function findFigure(editor: Editor, id: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "figure" && node.attrs.id === id) found = { pos, node };
    return !node.isAtom;
  });
  return found;
}

/** Edits the code of a TikZ figure next to a live preview (like a LaTeX editor). */
export function TikzDialog({ editor, open, figureId, onOpenChange }: TikzDialogProps) {
  const [initial] = useState(() => {
    const node = figureId ? findFigure(editor, figureId)?.node : null;
    return {
      code: (node?.attrs.tikz as string | null) ?? DEFAULT_TIKZ_CODE,
      libraries: (node?.attrs.tikzLibraries as string | undefined) ?? "",
      packages: (node?.attrs.tikzPackages as string | undefined) ?? "",
      caption: (node?.attrs.caption as string | undefined) ?? "",
    };
  });
  const [code, setCode] = useState(initial.code);
  const [libraries, setLibraries] = useState(initial.libraries);
  const [packages, setPackages] = useState(initial.packages);
  const [caption, setCaption] = useState(initial.caption);
  const dirty =
    code !== initial.code ||
    libraries !== initial.libraries ||
    packages !== initial.packages ||
    caption !== initial.caption;

  const preview = usePreview({ code, libraries, packages });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const apply = () => {
    if (!code.trim()) return;
    const attrs = { tikz: code, tikzLibraries: libraries, tikzPackages: packages, caption };
    if (figureId) {
      const found = findFigure(editor, figureId);
      if (!found) {
        toast.error("그림이 삭제되어 반영하지 못했습니다.");
        return;
      }
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, ...attrs });
          return true;
        })
        .setNodeSelection(found.pos)
        .run();
    } else {
      editor.chain().focus().insertTikzFigure({ code, libraries, packages, caption }).run();
    }
    onOpenChange(false);
  };

  const goToLine = (line: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const lines = code.split("\n");
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    textarea.focus();
    textarea.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    textarea.scrollTop = Math.max(0, (line - 1) * LINE_HEIGHT_PX - textarea.clientHeight / 3);
  };

  const errors = preview.result && !preview.result.ok ? preview.result.errors : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(52rem,calc(100dvh-2rem))] flex-col gap-3 sm:max-w-6xl"
        // A click beside the dialog shouldn't throw the code away; unsaved changes need 취소.
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => dirty && e.preventDefault()}
        onCloseAutoFocus={refocusEditor(editor)}
      >
        <DialogHeader>
          <DialogTitle>{figureId ? "TikZ 그림 편집" : "TikZ 그림 삽입"}</DialogTitle>
          <DialogDescription>
            왼쪽에 TikZ 코드를 쓰면 입력을 멈출 때마다 오른쪽 그림이 다시 그려집니다. 그림 번호와 캡션은 다른 그림과
            같이 매겨집니다.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-rows-2 gap-3 md:grid-cols-2 md:grid-rows-1">
          <div className="flex min-h-0 flex-col gap-2">
            <OptionChips
              title="패키지"
              names={TIKZ_PACKAGES.map((p) => p.name)}
              hints={Object.fromEntries(TIKZ_PACKAGES.map((p) => [p.name, p.description]))}
              selected={packages}
              onChange={setPackages}
            />
            <OptionChips
              title="TikZ 라이브러리"
              names={COMMON_TIKZ_LIBRARIES}
              allNames={ALL_TIKZ_LIBRARIES}
              selected={libraries}
              onChange={setLibraries}
            />
            <CodeEditor
              textareaRef={textareaRef}
              value={code}
              onChange={setCode}
              errorLines={new Set(errors.map((e) => e.line).filter((l): l is number => l !== null))}
              onSubmit={apply}
            />
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
            <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/40 px-3 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">미리보기</span>
              {preview.compiling && (
                <span className="flex items-center gap-1">
                  <Loader2Icon className="size-3 animate-spin" />
                  {tikzEngineLoaded() ? "그리는 중…" : "TeX 엔진을 불러오는 중… (처음 한 번, 약 8MB)"}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-background p-6">
              {preview.lastSvg ? (
                <TikzSvg
                  svg={preview.lastSvg}
                  width={0}
                  className={cn((preview.compiling || errors.length > 0) && "opacity-40")}
                />
              ) : (
                !preview.compiling &&
                errors.length === 0 && <p className="text-center text-sm text-muted-foreground">그림이 없습니다.</p>
              )}
            </div>
            {errors.length > 0 && (
              <ul className="max-h-40 shrink-0 overflow-auto border-t bg-destructive/5 p-2 text-xs text-destructive">
                {errors.map((error, i) => (
                  <li key={i} className="flex gap-1.5 py-0.5">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    <div className="min-w-0">
                      {error.line ? (
                        <button
                          type="button"
                          className="font-medium underline-offset-2 hover:underline"
                          onClick={() => goToLine(error.line!)}
                        >
                          {tikzErrorText(error)}
                        </button>
                      ) : (
                        <span className="font-medium">{tikzErrorText(error)}</span>
                      )}
                      {error.context && (
                        <code className="block truncate font-mono text-[11px] opacity-80">{error.context}</code>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <div className="flex w-full items-center gap-2 sm:max-w-md">
            <Label htmlFor="tikz-caption" className="shrink-0">
              캡션
            </Label>
            <Input
              id="tikz-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="그림 설명 ($...$로 수식 사용 가능)"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Ctrl+Enter 완료</span>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button onClick={apply} disabled={!code.trim()}>
              완료
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Compiles the source once typing pauses, one compile at a time (the newest source next).
 * `lastSvg` is the last successful drawing, kept while the code has errors.
 */
function usePreview(src: TikzSource) {
  const { code, libraries, packages } = src;
  const [state, setState] = useState<{ result: TikzResult | null; lastSvg: string | null; compiling: boolean }>(
    () => {
      const cached = peekTikz(src);
      return { result: cached ?? null, lastSvg: cached?.ok ? cached.svg : null, compiling: !cached };
    }
  );
  const latest = useRef<TikzSource | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const first = useRef(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const source = { code, libraries, packages };
    latest.current = source;
    const show = (result: TikzResult) =>
      setState((s) => ({ result, lastSvg: result.ok ? result.svg : s.lastSvg, compiling: false }));
    const cached = peekTikz(source);
    if (cached) {
      // a drawing compiled before shows at once
      show(cached);
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- dims the preview until the debounced compile is done
    setState((s) => ({ ...s, compiling: true }));
    const run = async () => {
      if (busy.current) {
        again.current = true;
        return;
      }
      busy.current = true;
      do {
        again.current = false;
        const current = latest.current!;
        const result = await compileTikz(current, { priority: true });
        if (!mounted.current) return;
        if (latest.current === current) show(result);
      } while (again.current);
      busy.current = false;
    };
    const timer = setTimeout(run, first.current ? 0 : PREVIEW_DELAY_MS);
    first.current = false;
    return () => clearTimeout(timer);
  }, [code, libraries, packages]);

  return state;
}

/** Toggle chips for packages or libraries (a comma-separated list). */
function OptionChips({
  title,
  names,
  allNames,
  hints,
  selected,
  onChange,
}: {
  title: string;
  names: string[];
  /** Further names behind "모두 보기" */
  allNames?: string[];
  hints?: Record<string, string>;
  selected: string;
  onChange: (value: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const on = new Set(splitList(selected));
  // Selected names outside the short list stay visible.
  const shown = showAll && allNames ? allNames : [...names, ...[...on].filter((n) => !names.includes(n))];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs font-medium">
        {title}
        {allNames && (
          <button
            type="button"
            className="flex items-center gap-0.5 font-normal text-muted-foreground hover:text-foreground"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "자주 쓰는 것만" : `모두 보기 (${allNames.length})`}
            {showAll ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
          </button>
        )}
      </div>
      <div className={cn("flex flex-wrap gap-1", showAll && "max-h-28 overflow-y-auto")}>
        {shown.map((name) => {
          const active = on.has(name);
          return (
            <button
              key={name}
              type="button"
              aria-pressed={active}
              title={hints?.[name]}
              onClick={() => onChange(toggleInList(selected, name, !active))}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors",
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {active && <CheckIcon className="size-3" />}
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A plain code textarea with line numbers; lines with errors are marked. */
function CodeEditor({
  textareaRef,
  value,
  onChange,
  errorLines,
  onSubmit,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  errorLines: Set<number>;
  onSubmit: () => void;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const lineCount = value.split("\n").length;
  return (
    <div
      className="flex min-h-0 flex-1 overflow-hidden rounded-lg border bg-background font-mono text-[13px]"
      style={{ lineHeight: `${LINE_HEIGHT_PX}px` }}
    >
      <div
        ref={gutterRef}
        aria-hidden
        className="w-10 shrink-0 overflow-hidden border-r bg-muted/40 py-2 text-right text-muted-foreground select-none"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className={cn("pr-2", errorLines.has(i + 1) && "bg-destructive/15 font-semibold text-destructive")}>
            {i + 1}
          </div>
        ))}
        {/* room for the textarea's horizontal scrollbar */}
        <div className="h-4" />
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        autoFocus
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        aria-label="TikZ 코드"
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            // Indent instead of leaving the editor (execCommand keeps the native undo history).
            e.preventDefault();
            if (!document.execCommand("insertText", false, "  ")) {
              const { selectionStart: start, selectionEnd: end } = e.currentTarget;
              onChange(value.slice(0, start) + "  " + value.slice(end));
            }
          }
        }}
        className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2 whitespace-pre outline-none"
      />
    </div>
  );
}
