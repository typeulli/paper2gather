"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/react";
import type * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";
import type { CitationStore } from "@/lib/paper/citation-store";
import type { CitationLayout, CitationOptions } from "@/lib/paper/citations";
import type { StyleKey } from "@/lib/paper/format";
import type { NumberingSnapshot, NumberingStore } from "@/lib/paper/numbering";
import type { PaperStore, Slice } from "@/lib/paper/store";
import type { Reference } from "@/lib/paper/types";
import type { LocalUser } from "@/lib/user";

export type SidebarTab = "outline" | "citations" | "comments";

/** What the citations tab lists */
export type CitationView = "references" | "equation" | "figure" | "table";

/** Position of an existing inline node that a dialog should update instead of inserting. */
export interface NodeTarget {
  pos: number;
}

export type FormatDialogTab = "styles" | "objects" | "page" | "prefabs";

export interface PaperUi {
  openFormatDialog: (opts?: { tab?: FormatDialogTab; style?: StyleKey }) => void;
  openCiteDialog: (opts?: { initial?: string[]; options?: CitationOptions; target?: NodeTarget }) => void;
  openCrossRefDialog: (opts?: { target?: NodeTarget }) => void;
  openReferenceDialog: (opts?: { reference?: Reference; tab?: "manual" | "bibtex" | "doi" }) => void;
  openFigureDialog: () => void;
  /** New TikZ figure, or the figure with this id */
  openTikzDialog: (opts?: { figureId?: string }) => void;
  openTableDialog: () => void;
  openCommentDialog: () => void;
  /** An image (data URL) to copy with the browser's menu, where the clipboard can't take it */
  openCopyImageDialog: (image: string) => void;
  focusThread: (threadId: string) => void;
  setSidebarTab: (tab: SidebarTab, citationView?: CitationView) => void;
}

export interface PaperContextValue {
  docId: string;
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  store: PaperStore;
  numbering: NumberingStore;
  citations: CitationStore;
  user: LocalUser;
  editor: Editor | null;
  ui: PaperUi;
}

export const PaperContext = createContext<PaperContextValue | null>(null);

export function usePaper(): PaperContextValue {
  const ctx = useContext(PaperContext);
  if (!ctx) throw new Error("usePaper must be used inside <PaperContext>");
  return ctx;
}

function useSlice<T>(slice: Slice<T>): T {
  return useSyncExternalStore(slice.subscribe, slice.get, slice.get);
}

export function useReferences() {
  return useSlice(usePaper().store.referencesSlice);
}

export function useMeta() {
  return useSlice(usePaper().store.metaSlice);
}

export function useFormat() {
  return useSlice(usePaper().store.formatSlice);
}

export function useAuthors() {
  return useSlice(usePaper().store.authorsSlice);
}

export function useComments() {
  return useSlice(usePaper().store.commentsSlice);
}

export function useNumbering(): NumberingSnapshot {
  const { numbering } = usePaper();
  return useSyncExternalStore(numbering.subscribe, numbering.get, numbering.get);
}

/** Order, numbers and author-year labels of the reference list */
export function useCitations(): CitationLayout {
  const { citations } = usePaper();
  return useSyncExternalStore(citations.subscribe, citations.get, citations.get);
}
