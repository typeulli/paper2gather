"use client";

import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { CheckIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { refocusEditor } from "@/lib/editor-utils";
import {
  citationText,
  entryLabel,
  isAuthorDate,
  type CitationMode,
  type CitationOptions,
} from "@/lib/paper/citations";
import { CITATION_STYLES } from "@/lib/paper/format";
import { formatAuthorsIEEE, matchesReference, serializeRefIds } from "@/lib/paper/references";
import { cn } from "@/lib/utils";
import { citationAttrs } from "../nodes/citation";
import { useCitations, usePaper, useReferences, type NodeTarget } from "../paper-context";

interface CiteDialogProps {
  editor: Editor;
  open: boolean;
  initial: string[];
  initialOptions?: CitationOptions;
  target?: NodeTarget;
  onOpenChange: (open: boolean) => void;
}

export function CiteDialog({ editor, open, initial, initialOptions, target, onOpenChange }: CiteDialogProps) {
  const { ui } = usePaper();
  const refs = useReferences();
  const layout = useCitations();
  // Remounted on every open (see Workspace), so props seed the state.
  const [selected, setSelected] = useState<string[]>(initial);
  const [mode, setMode] = useState<CitationMode>(initialOptions?.mode ?? "paren");
  const [locator, setLocator] = useState(initialOptions?.locator ?? "");
  const [query, setQuery] = useState("");
  const authorDate = isAuthorDate(layout.style);

  // In the order of the reference list
  const filtered = layout.entries.map((e) => e.ref).filter((r) => matchesReference(r, query));

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const confirm = () => {
    // `open` is already false while the dialog animates out; ignore repeat activations (double click).
    if (!open || selected.length === 0) return;
    const options = { mode, locator };
    if (target) {
      const node = editor.state.doc.nodeAt(target.pos);
      if (node?.type.name === "citation") {
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(target.pos, undefined, {
            ...node.attrs,
            refs: serializeRefIds(selected),
            ...citationAttrs(options),
          })
        );
      }
      editor.commands.focus();
    } else {
      editor.chain().focus().insertCitation(selected, options).run();
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" onCloseAutoFocus={refocusEditor(editor)}>
        <DialogHeader>
          <DialogTitle>{target ? "인용 편집" : "인용 삽입"}</DialogTitle>
          <DialogDescription>
            인용 양식은 {CITATION_STYLES[layout.style].label}입니다. 여러 문헌을 선택하면{" "}
            {CITATION_STYLES[layout.style].sample}처럼 묶여서 표시됩니다.
          </DialogDescription>
        </DialogHeader>
        <Command
          shouldFilter={false}
          className="rounded-lg border"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              confirm();
            }
          }}
        >
          <CommandInput value={query} onValueChange={setQuery} placeholder="제목, 저자, 연도, 인용 키로 검색" />
          <CommandList className="max-h-[45vh]">
            <CommandEmpty>
              {refs.list.length === 0 ? "아직 등록된 참고문헌이 없습니다." : "검색 결과가 없습니다."}
            </CommandEmpty>
            {filtered.map((ref) => {
              const checked = selected.includes(ref.id);
              const entry = layout.byId.get(ref.id);
              const label = entry ? entryLabel(entry, layout.style) : "";
              return (
                <CommandItem
                  key={ref.id}
                  value={ref.id}
                  onSelect={() => toggle(ref.id)}
                  className="items-start gap-3 py-2"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border",
                      checked && "border-primary bg-primary text-primary-foreground"
                    )}
                  >
                    {checked && <CheckIcon className="size-3" />}
                  </span>
                  {!authorDate && (
                    <span className="w-8 shrink-0 font-medium tabular-nums text-muted-foreground">{label}</span>
                  )}
                  <span className="flex min-w-0 flex-col">
                    <span className="line-clamp-2 font-medium">{ref.title || "(제목 없음)"}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {[formatAuthorsIEEE(ref.authors), ref.venue, ref.year].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
        <div className="flex flex-wrap items-end gap-4">
          {authorDate && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">인용 형태</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                value={mode}
                onValueChange={(v) => v && setMode(v as CitationMode)}
              >
                <ToggleGroupItem value="paren">괄호 (Kim, 2020)</ToggleGroupItem>
                <ToggleGroupItem value="narrative">서술 Kim (2020)</ToggleGroupItem>
              </ToggleGroup>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cite-locator" className="text-xs text-muted-foreground">
              쪽·위치 (선택)
            </Label>
            <Input
              id="cite-locator"
              value={locator}
              onChange={(e) => setLocator(e.target.value)}
              placeholder="p. 5"
              className="h-8 w-40"
            />
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              ui.openReferenceDialog();
            }}
          >
            <PlusIcon /> 새 참고문헌 추가
          </Button>
          <div className="flex items-center gap-2">
            {selected.length > 0 && (
              <span className="text-sm text-muted-foreground">
                미리보기{" "}
                <span className="font-medium text-foreground">
                  {citationText(selected, layout, { mode, locator })}
                </span>
              </span>
            )}
            <Button onClick={confirm} disabled={selected.length === 0}>
              {target ? "적용" : "삽입"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
