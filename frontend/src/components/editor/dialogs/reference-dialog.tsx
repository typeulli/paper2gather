"use client";

import { useMemo, useState } from "react";
import { FileUpIcon, Loader2Icon, SearchIcon } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { parseBibtex } from "@/lib/paper/bibtex";
import { formatReferenceAs } from "@/lib/paper/citations";
import { fetchReferenceByDoi } from "@/lib/paper/doi";
import { CITATION_STYLES } from "@/lib/paper/format";
import { emptyReference, makeCitationKey, REF_TYPE_LABELS, VENUE_LABELS } from "@/lib/paper/references";
import type { Reference, RefType } from "@/lib/paper/types";
import { useFormat, usePaper, useReferences } from "../paper-context";

type Tab = "manual" | "bibtex" | "doi";

interface ReferenceDialogProps {
  open: boolean;
  /** Edit mode when set */
  reference?: Reference;
  initialTab?: Tab;
  onOpenChange: (open: boolean) => void;
}

const normTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const NO_MONTH = "none";
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1));

/** Which types show the fields that only some of them use */
const WITH_EDITORS: RefType[] = ["inproceedings", "incollection", "book"];
const WITH_EDITION: RefType[] = ["book", "incollection"];
const WITH_SERIES: RefType[] = ["inproceedings", "incollection"];

const lines = (text: string) =>
  text
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);

function findDuplicate(ref: Reference, others: Reference[]): Reference | undefined {
  return others.find(
    (o) =>
      o.id !== ref.id &&
      ((ref.doi && o.doi && ref.doi.toLowerCase() === o.doi.toLowerCase()) ||
        (ref.title && normTitle(o.title) === normTitle(ref.title)))
  );
}

export function ReferenceDialog({ open, reference, initialTab, onOpenChange }: ReferenceDialogProps) {
  const { store } = usePaper();
  const refs = useReferences();
  const { citation } = useFormat();
  // Remounted on every open (see Workspace), so props seed the state.
  const [tab, setTab] = useState<Tab>(reference ? "manual" : (initialTab ?? "manual"));
  const [form, setForm] = useState<Reference>(() => reference ?? emptyReference());
  const [authorsText, setAuthorsText] = useState(() => reference?.authors.join("\n") ?? "");
  const [editorsText, setEditorsText] = useState(() => reference?.editors.join("\n") ?? "");
  const [bibtex, setBibtex] = useState("");
  const [doi, setDoi] = useState("");
  const [loadingDoi, setLoadingDoi] = useState(false);
  const editing = !!reference;

  const parsed = useMemo(() => (bibtex.trim() ? parseBibtex(bibtex) : []), [bibtex]);

  const set = <K extends keyof Reference>(key: K, value: Reference[K]) => setForm((f) => ({ ...f, [key]: value }));

  const draft: Reference = { ...form, authors: lines(authorsText), editors: lines(editorsText) };

  const saveManual = () => {
    if (!draft.title.trim()) {
      toast.error("제목을 입력하세요.");
      return;
    }
    const others = refs.list.filter((r) => r.id !== draft.id);
    const dup = findDuplicate(draft, others);
    if (dup && !editing) {
      toast.error(`이미 등록된 문헌입니다: ${dup.title}`);
      return;
    }
    const keys = others.map((r) => r.key);
    const key = draft.key.trim() && !keys.includes(draft.key.trim()) ? draft.key.trim() : makeCitationKey(draft, keys);
    const ref = { ...draft, key };
    if (editing) store.updateReference(ref);
    else store.addReferences([ref]);
    toast.success(editing ? "참고문헌을 수정했습니다." : "참고문헌을 추가했습니다.");
    onOpenChange(false);
  };

  const importBibtex = () => {
    const accepted: Reference[] = [];
    let skipped = 0;
    const keys = refs.list.map((r) => r.key);
    for (const ref of parsed) {
      if (findDuplicate(ref, [...refs.list, ...accepted])) {
        skipped++;
        continue;
      }
      const key = ref.key && !keys.includes(ref.key) ? ref.key : makeCitationKey(ref, keys);
      keys.push(key);
      accepted.push({ ...ref, key });
    }
    store.addReferences(accepted);
    toast.success(`${accepted.length}개 가져옴${skipped ? ` · 중복 ${skipped}개 건너뜀` : ""}`);
    onOpenChange(false);
  };

  const lookupDoi = async () => {
    setLoadingDoi(true);
    try {
      const found = await fetchReferenceByDoi(doi);
      setForm({ ...found, id: form.id });
      setAuthorsText(found.authors.join("\n"));
      setEditorsText(found.editors.join("\n"));
      setTab("manual");
      toast.success("메타데이터를 불러왔습니다. 확인 후 저장하세요.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoadingDoi(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "참고문헌 편집" : "참고문헌 추가"}</DialogTitle>
          <DialogDescription>
            {citation.order === "style"
              ? `목록은 ${CITATION_STYLES[citation.style].label} 양식의 순서로 자동 정렬됩니다.`
              : "새 문헌은 목록 끝에 추가되며, 패널에서 끌어서 번호 순서를 바꿀 수 있습니다."}
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-h-0 flex-1">
          {!editing && (
            <TabsList>
              <TabsTrigger value="manual">직접 입력</TabsTrigger>
              <TabsTrigger value="doi">DOI로 찾기</TabsTrigger>
              <TabsTrigger value="bibtex">BibTeX 가져오기</TabsTrigger>
            </TabsList>
          )}

          <TabsContent value="manual" className="min-h-0 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3 py-1 sm:grid-cols-4">
              <Field label="유형" className="col-span-2">
                <Select value={form.type} onValueChange={(v) => set("type", v as RefType)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(REF_TYPE_LABELS) as RefType[]).map((t) => (
                      <SelectItem key={t} value={t}>
                        {REF_TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="인용 키 (LaTeX)" className="col-span-2">
                <Input
                  value={form.key}
                  onChange={(e) => set("key", e.target.value.replace(/[^\w:\-.]/g, ""))}
                  placeholder="비워두면 자동 생성"
                  className="font-mono"
                />
              </Field>
              <Field label="제목 *" className="col-span-full">
                <Input value={form.title} onChange={(e) => set("title", e.target.value)} />
              </Field>
              <Field label="저자 (한 줄에 한 명)" className="col-span-full">
                <Textarea
                  rows={3}
                  value={authorsText}
                  onChange={(e) => setAuthorsText(e.target.value)}
                  placeholder={"Ashish Vaswani\nShazeer, Noam"}
                />
              </Field>
              {WITH_EDITORS.includes(form.type) && (
                <Field label="편집자 (한 줄에 한 명)" className="col-span-full">
                  <Textarea
                    rows={2}
                    value={editorsText}
                    onChange={(e) => setEditorsText(e.target.value)}
                    placeholder={"Frank Editor"}
                  />
                </Field>
              )}
              <Field label={VENUE_LABELS[form.type]} className="col-span-full">
                <Input value={form.venue} onChange={(e) => set("venue", e.target.value)} />
              </Field>
              {WITH_SERIES.includes(form.type) && (
                <Field label="시리즈" className="col-span-2">
                  <Input value={form.series} onChange={(e) => set("series", e.target.value)} placeholder="LNCS" />
                </Field>
              )}
              {WITH_EDITION.includes(form.type) && (
                <Field label="판 (edition)" className="col-span-2">
                  <Input value={form.edition} onChange={(e) => set("edition", e.target.value)} placeholder="2" />
                </Field>
              )}
              <Field label="연도">
                <Input value={form.year} onChange={(e) => set("year", e.target.value)} />
              </Field>
              <Field label="월">
                <Select
                  value={form.month || NO_MONTH}
                  onValueChange={(v) => set("month", v === NO_MONTH ? "" : v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_MONTH}>없음</SelectItem>
                    {MONTHS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}월
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="권 (vol.)">
                <Input value={form.volume} onChange={(e) => set("volume", e.target.value)} />
              </Field>
              <Field label="호 (no.)">
                <Input value={form.issue} onChange={(e) => set("issue", e.target.value)} />
              </Field>
              <Field label="페이지">
                <Input value={form.pages} onChange={(e) => set("pages", e.target.value)} placeholder="1–10" />
              </Field>
              <Field label="출판사" className="col-span-2">
                <Input value={form.publisher} onChange={(e) => set("publisher", e.target.value)} />
              </Field>
              <Field label="출판 지역·개최지" className="col-span-2">
                <Input
                  value={form.address}
                  onChange={(e) => set("address", e.target.value)}
                  placeholder="Cham, Switzerland"
                />
              </Field>
              <Field label="DOI" className="col-span-full">
                <Input value={form.doi} onChange={(e) => set("doi", e.target.value)} className="font-mono" />
              </Field>
              <Field label="URL" className={form.type === "misc" ? "col-span-2" : "col-span-full"}>
                <Input value={form.url} onChange={(e) => set("url", e.target.value)} />
              </Field>
              {form.type === "misc" && (
                <Field label="접속일" className="col-span-2">
                  <Input type="date" value={form.accessed} onChange={(e) => set("accessed", e.target.value)} />
                </Field>
              )}
              <Field label="메모" className="col-span-full">
                <Input value={form.note} onChange={(e) => set("note", e.target.value)} />
              </Field>
            </div>
            <div className="mt-3 rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">
              <span className="mb-1 block font-medium text-muted-foreground">
                미리보기 ({CITATION_STYLES[citation.style].label})
              </span>
              {formatReferenceAs(draft, citation.style).map((s, i) =>
                s.italic ? <em key={i}>{s.text}</em> : <span key={i}>{s.text}</span>
              )}
            </div>
          </TabsContent>

          <TabsContent value="doi" className="flex flex-col gap-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void lookupDoi();
              }}
            >
              <Input
                value={doi}
                autoFocus
                onChange={(e) => setDoi(e.target.value)}
                placeholder="10.48550/arXiv.1706.03762 또는 https://doi.org/..."
                className="font-mono"
              />
              <Button type="submit" disabled={!doi.trim() || loadingDoi}>
                {loadingDoi ? <Loader2Icon className="animate-spin" /> : <SearchIcon />} 조회
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">Crossref에서 서지 정보를 가져와 직접 입력 탭에 채웁니다.</p>
          </TabsContent>

          <TabsContent value="bibtex" className="flex min-h-0 flex-col gap-3">
            <Textarea
              value={bibtex}
              onChange={(e) => setBibtex(e.target.value)}
              rows={10}
              spellCheck={false}
              placeholder={"@article{vaswani2017attention,\n  title={Attention is all you need},\n  author={Vaswani, Ashish and Shazeer, Noam},\n  year={2017}\n}"}
              className="min-h-40 font-mono text-xs"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                <FileUpIcon className="size-4" /> .bib 파일 열기
                <input
                  type="file"
                  accept=".bib,.txt,text/plain"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) setBibtex(await file.text());
                    e.target.value = "";
                  }}
                />
              </label>
              <span className="text-sm text-muted-foreground">{parsed.length}개 항목 인식됨</span>
            </div>
            {parsed.length > 0 && (
              <ul className="max-h-32 overflow-y-auto rounded-md border p-2 text-xs">
                {parsed.map((r) => (
                  <li key={r.id} className="truncate">
                    <code className="text-muted-foreground">{r.key}</code> {r.title}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
        <DialogFooter>
          {tab === "bibtex" ? (
            <Button onClick={importBibtex} disabled={parsed.length === 0}>
              {parsed.length}개 가져오기
            </Button>
          ) : (
            tab === "manual" && <Button onClick={saveManual}>{editing ? "저장" : "추가"}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
