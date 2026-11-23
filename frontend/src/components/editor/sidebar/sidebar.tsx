"use client";

import type { RefObject } from "react";
import type { LucideIcon } from "lucide-react";
import { BookMarkedIcon, ImageIcon, SigmaIcon, TableIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useComments, useNumbering, useReferences, type CitationView, type SidebarTab } from "../paper-context";
import { CommentsPanel } from "./comments-panel";
import { ObjectsPanel } from "./objects-panel";
import { OutlinePanel } from "./outline-panel";
import { ReferencesPanel } from "./references-panel";

const CITATION_VIEWS: { view: CitationView; title: string; icon: LucideIcon }[] = [
  { view: "references", title: "참고문헌", icon: BookMarkedIcon },
  { view: "equation", title: "수식", icon: SigmaIcon },
  { view: "figure", title: "그림", icon: ImageIcon },
  { view: "table", title: "표", icon: TableIcon },
];

interface SidebarProps {
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  citationView: CitationView;
  onCitationViewChange: (view: CitationView) => void;
  /** The scrolled view of the pages, which the outline follows */
  scrollRef: RefObject<HTMLElement | null>;
  activeThread: string | null;
  onActiveThreadChange: (id: string | null) => void;
}

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="text-[11px] text-muted-foreground tabular-nums">{n}</span> : null;
}

export function Sidebar({
  tab,
  onTabChange,
  citationView,
  onCitationViewChange,
  scrollRef,
  activeThread,
  onActiveThreadChange,
}: SidebarProps) {
  const refs = useReferences();
  const numbering = useNumbering();
  const comments = useComments();
  const openComments = comments.filter((c) => !c.resolved).length;
  const countOf = (view: CitationView) =>
    view === "references" ? refs.list.length : numbering.objects.filter((o) => o.kind === view).length;

  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as SidebarTab)} className="flex h-full w-full min-w-0 gap-0">
      <div className="flex h-10 shrink-0 items-center border-b px-2">
        <TabsList className="w-full">
          <TabsTrigger value="outline">개요</TabsTrigger>
          <TabsTrigger value="citations">인용</TabsTrigger>
          <TabsTrigger value="comments">
            댓글 <Count n={openComments} />
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="outline" className="min-h-0">
        <OutlinePanel scrollRef={scrollRef} />
      </TabsContent>
      <TabsContent value="citations" className="min-h-0">
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 border-b p-2">
            <Select value={citationView} onValueChange={(v) => onCitationViewChange(v as CitationView)}>
              <SelectTrigger size="sm" className="w-full" aria-label="인용 대상">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CITATION_VIEWS.map(({ view, title, icon: Icon }) => (
                  <SelectItem key={view} value={view}>
                    <Icon className="text-muted-foreground" /> {title} <Count n={countOf(view)} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-h-0 flex-1">
            {citationView === "references" ? <ReferencesPanel /> : <ObjectsPanel kind={citationView} />}
          </div>
        </div>
      </TabsContent>
      <TabsContent value="comments" className="min-h-0">
        <CommentsPanel activeThread={activeThread} onActiveThreadChange={onActiveThreadChange} />
      </TabsContent>
    </Tabs>
  );
}
