"use client";

import { useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDownNarrowWideIcon,
  BookMarkedIcon,
  EllipsisVerticalIcon,
  FileDownIcon,
  FileUpIcon,
  GripVerticalIcon,
  PencilIcon,
  PlusIcon,
  QuoteIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { downloadText, safeFileName } from "@/lib/download";
import { referencesToBibtex } from "@/lib/paper/bibtex";
import { entryLabel } from "@/lib/paper/citations";
import { CITATION_STYLES } from "@/lib/paper/format";
import { formatAuthorsIEEE, matchesReference } from "@/lib/paper/references";
import type { Reference } from "@/lib/paper/types";
import { cn } from "@/lib/utils";
import { useCitations, useFormat, useMeta, useNumbering, usePaper, useReferences } from "../paper-context";

interface SortableReferenceProps {
  reference: Reference;
  /** "[3]", "3." or "" */
  label: string;
  citedCount: number;
  sortable: boolean;
  onCite: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function SortableReference({ reference, label, citedCount, sortable, onCite, onEdit, onDelete }: SortableReferenceProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: reference.id,
    disabled: !sortable,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/ref relative flex gap-1.5 rounded-lg border bg-card p-2 pl-1",
        isDragging && "z-10 shadow-lg ring-1 ring-primary/40"
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label={`${label || reference.title} 끌어서 순서 변경`}
        disabled={!sortable}
        className="flex w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-30"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      {label && <span className="w-7 shrink-0 pt-px text-sm font-semibold tabular-nums">{label}</span>}
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm leading-snug font-medium">{reference.title || "(제목 없음)"}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {[formatAuthorsIEEE(reference.authors), reference.venue, reference.year].filter(Boolean).join(" · ")}
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          {citedCount > 0 ? (
            <Badge variant="secondary">{citedCount}회 인용</Badge>
          ) : (
            <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-500">
              미인용
            </Badge>
          )}
          {reference.key && <code className="truncate text-[11px] text-muted-foreground">{reference.key}</code>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-0.5">
        <Button size="icon-xs" variant="ghost" title="커서 위치에 인용" onClick={onCite}>
          <QuoteIcon />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-xs" variant="ghost" title="더 보기">
              <EllipsisVerticalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              <PencilIcon /> 편집
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2Icon /> 삭제
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

export function ReferencesPanel() {
  const { store, editor, ui } = usePaper();
  const refs = useReferences();
  const numbering = useNumbering();
  const layout = useCitations();
  const { citation } = useFormat();
  const { title } = useMeta();
  // The style orders the list itself; dragging only applies to the manual order.
  const ordered = citation.order === "style";
  const list = ordered ? layout.entries.map((e) => e.ref) : refs.list;
  const labelOf = (id: string) => {
    const entry = layout.byId.get(id);
    return entry ? entryLabel(entry, layout.style) : "";
  };
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Reference[] | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const filtering = query.trim().length > 0;
  const visible = filtering ? list.filter((r) => matchesReference(r, query)) : list;
  const uncited = refs.list.filter((r) => !numbering.citationCounts.has(r.id));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const to = refs.list.findIndex((r) => r.id === over.id);
    if (to >= 0) store.moveReference(String(active.id), to);
  };

  const sortByCitation = () => {
    const cited = numbering.citationOrder.filter((id) => refs.byId.has(id));
    const rest = refs.list.map((r) => r.id).filter((id) => !numbering.citationCounts.has(id));
    store.setReferenceOrder([...cited, ...rest]);
    toast.success("본문 첫 인용 순서대로 번호를 다시 매겼습니다.");
  };

  const cite = (id: string) => {
    if (!editor) return;
    editor.chain().focus().insertCitation([id]).run();
  };

  const deleteCount = pendingDelete?.reduce((n, r) => n + (numbering.citationCounts.get(r.id) ?? 0), 0) ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b p-2">
        <InputGroup className="h-8">
          <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="참고문헌 검색" />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
        <Button size="sm" onClick={() => ui.openReferenceDialog()}>
          <PlusIcon /> 추가
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="outline" title="더 보기">
              <EllipsisVerticalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onSelect={sortByCitation} disabled={refs.list.length < 2 || ordered}>
              <ArrowDownNarrowWideIcon /> 본문 인용 순서로 번호 정렬
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => ui.openReferenceDialog({ tab: "bibtex" })}>
              <FileUpIcon /> BibTeX 가져오기
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={refs.list.length === 0}
              onSelect={() =>
                downloadText(`${safeFileName(title)}.bib`, referencesToBibtex(refs.list), "application/x-bibtex")
              }
            >
              <FileDownIcon /> BibTeX 내보내기
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={uncited.length === 0}
              onSelect={() => setPendingDelete(uncited)}
            >
              <Trash2Icon /> 미인용 문헌 삭제 ({uncited.length})
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="shrink-0 px-3 pt-2 pb-1 text-xs text-muted-foreground">
        {ordered
          ? `${CITATION_STYLES[citation.style].label} 양식의 순서로 자동 정렬됩니다. 직접 정렬은 문서 양식에서 고릅니다.`
          : filtering
            ? "검색 중에는 순서를 바꿀 수 없습니다."
            : "핸들을 끌어 번호 순서를 바꾸면 본문 인용 번호가 즉시 갱신됩니다."}
      </p>
      <ScrollArea className="min-h-0 flex-1">
        {refs.list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-sm text-muted-foreground">
            <BookMarkedIcon className="size-8 opacity-50" />
            직접 입력하거나 DOI · BibTeX로 참고문헌을 추가하세요.
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => ui.openReferenceDialog({ tab: "doi" })}>
                DOI로 추가
              </Button>
              <Button size="sm" variant="outline" onClick={() => ui.openReferenceDialog({ tab: "bibtex" })}>
                BibTeX 가져오기
              </Button>
            </div>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={visible.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col gap-1.5 p-2">
                {visible.map((ref) => (
                  <SortableReference
                    key={ref.id}
                    reference={ref}
                    label={labelOf(ref.id)}
                    citedCount={numbering.citationCounts.get(ref.id) ?? 0}
                    sortable={!filtering && !ordered}
                    onCite={() => cite(ref.id)}
                    onEdit={() => ui.openReferenceDialog({ reference: ref })}
                    onDelete={() => setPendingDelete([ref])}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </ScrollArea>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>참고문헌 {pendingDelete?.length ?? 0}개를 삭제할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteCount > 0
                ? `본문에서 ${deleteCount}회 인용되어 있습니다. 삭제하면 해당 인용은 [?]로 표시됩니다.`
                : "본문에서 인용되지 않은 문헌입니다."}{" "}
              뒤 번호는 자동으로 당겨집니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                pendingDelete?.forEach((r) => store.removeReference(r.id));
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
