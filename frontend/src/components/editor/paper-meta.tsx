"use client";

import { useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { shortId } from "@/lib/ids";
import type { Author } from "@/lib/paper/types";
import { useAuthors, useMeta, usePaper } from "./paper-context";

function TitleField() {
  const { store } = usePaper();
  const { title } = useMeta();
  // Local draft only while focused, so remote edits don't move the caret.
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <textarea
      value={draft ?? title}
      rows={1}
      placeholder="논문 제목"
      onFocus={() => setDraft(title)}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        const value = e.target.value.replace(/\n/g, " ");
        setDraft(value);
        store.setTitle(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
      }}
      className="paper-title field-sizing-content w-full resize-none bg-transparent outline-none placeholder:text-muted-foreground/50"
    />
  );
}

function AuthorEditor({
  author,
  index,
  total,
  onClose,
}: {
  author: Author;
  index: number;
  total: number;
  onClose: () => void;
}) {
  const { store } = usePaper();
  const [draft, setDraft] = useState(author);
  const save = (next: Author) => {
    setDraft(next);
    store.updateAuthor(index, next);
  };
  return (
    <div className="flex flex-col gap-3">
      {(["name", "affiliation", "email"] as const).map((field) => (
        <div key={field} className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">
            {{ name: "이름", affiliation: "소속", email: "이메일" }[field]}
          </Label>
          <Input
            value={draft[field]}
            autoFocus={field === "name"}
            onChange={(e) => save({ ...draft, [field]: e.target.value })}
          />
        </div>
      ))}
      <div className="flex items-center justify-between border-t pt-2">
        <div className="flex gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            title="앞으로"
            disabled={index === 0}
            onClick={() => {
              store.moveAuthor(index, index - 1);
              onClose();
            }}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="뒤로"
            disabled={index === total - 1}
            onClick={() => {
              store.moveAuthor(index, index + 1);
              onClose();
            }}
          >
            <ChevronRightIcon />
          </Button>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={() => {
            store.removeAuthor(index);
            onClose();
          }}
        >
          <Trash2Icon /> 삭제
        </Button>
      </div>
    </div>
  );
}

function AuthorChip({ author, index, total }: { author: Author; index: number; total: number }) {
  const [open, setOpen] = useState(!author.name);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="flex flex-col items-center rounded-md px-2 py-1 text-center hover:bg-muted/60">
          <span className="font-medium">{author.name || "이름 없음"}</span>
          {author.affiliation && <span className="text-xs text-muted-foreground">{author.affiliation}</span>}
          {author.email && <span className="font-mono text-[11px] text-muted-foreground">{author.email}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <AuthorEditor author={author} index={index} total={total} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

export function PaperMeta() {
  const { store } = usePaper();
  const authors = useAuthors();
  return (
    <header className="mb-8 flex flex-col items-center gap-3 border-b pb-6">
      <TitleField />
      <div className="flex flex-wrap items-start justify-center gap-x-4 gap-y-1 text-sm">
        {authors.map((a, i) => (
          <AuthorChip key={a.id} author={a} index={i} total={authors.length} />
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground print:invisible"
          onClick={() => store.addAuthor({ id: shortId(), name: "", affiliation: "", email: "" })}
        >
          <PlusIcon /> 저자 추가
        </Button>
      </div>
    </header>
  );
}
