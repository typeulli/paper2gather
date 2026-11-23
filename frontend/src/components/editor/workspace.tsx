"use client";

import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { pageGeometry, pagePrintCss } from "@/lib/paper/page";
import { useLocalUser } from "@/lib/user";
import type { CitationOptions } from "@/lib/paper/citations";
import { paperFormatCss, type StyleKey } from "@/lib/paper/format";
import { numberingSignature } from "@/lib/paper/numbering";
import type { Reference } from "@/lib/paper/types";
import { Bibliography } from "./bibliography";
import { CiteDialog } from "./dialogs/cite-dialog";
import { CommentDialog } from "./dialogs/comment-dialog";
import { CopyImageDialog } from "./dialogs/copy-image-dialog";
import { CrossRefDialog } from "./dialogs/cross-ref-dialog";
import { FigureDialog } from "./dialogs/figure-dialog";
import { FormatDialog } from "./dialogs/format-dialog";
import { ReferenceDialog } from "./dialogs/reference-dialog";
import { TableDialog } from "./dialogs/table-dialog";
import { TikzDialog } from "./dialogs/tikz-dialog";
import type { ConnectionStatus, Session } from "./editor-page";
import { buildExtensions } from "./extensions";
import { refreshNumbering } from "./extensions/numbering";
import { EditorHeader } from "./header";
import { PageSheets } from "./page-sheets";
import {
  PaperContext,
  type CitationView,
  type FormatDialogTab,
  type NodeTarget,
  type PaperContextValue,
  type PaperUi,
  type SidebarTab,
} from "./paper-context";
import { PaperMeta } from "./paper-meta";
import { Sidebar } from "./sidebar/sidebar";
import { loadSidebarWidth, saveSidebarWidth, SidebarResizer } from "./sidebar/sidebar-resizer";
import { createSlashItems } from "./slash-items";
import { StatusBar } from "./status-bar";
import { EditorToolbar } from "./toolbar";

/** Space beside the pages (px) when they are shrunk to fit */
const PAGE_GUTTER = 24;
const MIN_PAGE_SCALE = 0.25;

interface WorkspaceProps {
  docId: string;
  session: Session;
  status: ConnectionStatus;
}

export function Workspace({ docId, session, status }: WorkspaceProps) {
  const { ydoc, provider, store, numbering, citations } = session;
  const user = useLocalUser();
  const format = useSyncExternalStore(store.formatSlice.subscribe, store.formatSlice.get, store.formatSlice.get);
  const comments = useSyncExternalStore(
    store.commentsSlice.subscribe,
    store.commentsSlice.get,
    store.commentsSlice.get
  );

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("citations");
  const [citationView, setCitationView] = useState<CitationView>("references");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const sidebarRef = useRef<HTMLElement>(null);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const page = useMemo(() => pageGeometry(format.page), [format.page]);
  const pagesHeight = pageCount * page.height + (pageCount - 1) * page.gap;

  // The pages shrink to fit the width left beside the panel.
  const mainRef = useRef<HTMLElement>(null);
  const [pageScale, setPageScale] = useState(1);
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const observer = new ResizeObserver(() =>
      setPageScale(Math.max(MIN_PAGE_SCALE, Math.min(1, (main.clientWidth - 2 * PAGE_GUTTER) / page.width)))
    );
    observer.observe(main);
    return () => observer.disconnect();
  }, [page.width]);

  const [cite, setCite] = useState<{
    open: boolean;
    initial: string[];
    options?: CitationOptions;
    target?: NodeTarget;
  }>({
    open: false,
    initial: [],
  });
  const [crossRef, setCrossRef] = useState<{ open: boolean; target?: NodeTarget }>({ open: false });
  const [refDialog, setRefDialog] = useState<{
    open: boolean;
    reference?: Reference;
    tab?: "manual" | "bibtex" | "doi";
  }>({ open: false });
  const [figureOpen, setFigureOpen] = useState(false);
  const [tikz, setTikz] = useState<{ open: boolean; figureId?: string }>({ open: false });
  const [tableOpen, setTableOpen] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [copyImage, setCopyImage] = useState<string | null>(null);
  const [formatDialog, setFormatDialog] = useState<{ open: boolean; tab?: FormatDialogTab; style?: StyleKey }>({
    open: false,
  });
  // Dialogs are opened programmatically, so they get remounted (fresh state) on every open.
  const [dialogKey, setDialogKey] = useState(0);

  // Stable for the lifetime of the workspace; captured by editor extensions.
  const [ui] = useState<PaperUi>(() => {
    const opening =
      <A extends unknown[]>(open: (...args: A) => void) =>
      (...args: A) => {
        setDialogKey((k) => k + 1);
        open(...args);
      };
    return {
      openFormatDialog: opening((opts) => setFormatDialog({ open: true, ...opts })),
      openCiteDialog: opening((opts) =>
        setCite({ open: true, initial: opts?.initial ?? [], options: opts?.options, target: opts?.target })
      ),
      openCrossRefDialog: opening((opts) => setCrossRef({ open: true, target: opts?.target })),
      openReferenceDialog: opening((opts) => setRefDialog({ open: true, ...opts })),
      openFigureDialog: opening(() => setFigureOpen(true)),
      openTikzDialog: opening((opts) => setTikz({ open: true, figureId: opts?.figureId })),
      openTableDialog: opening(() => setTableOpen(true)),
      openCommentDialog: opening(() => setCommentOpen(true)),
      openCopyImageDialog: (image) => setCopyImage(image),
      focusThread: (threadId) => {
        setActiveThread(threadId);
        setSidebarTab("comments");
        setSidebarOpen(true);
      },
      setSidebarTab: (tab, view) => {
        setSidebarTab(tab);
        if (view) setCitationView(view);
        setSidebarOpen(true);
      },
    };
  });

  const editor = useEditor(
    {
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      extensions: buildExtensions({
        ydoc,
        provider,
        user,
        store,
        numbering,
        citations,
        getFormat: () => store.formatSlice.get(),
        getSlashItems: () => createSlashItems(ui),
        onCommentActivate: ui.focusThread,
        onPageCount: setPageCount,
      }),
      editorProps: { attributes: { class: "paper-body" } },
    },
    [ydoc, provider]
  );

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.updateUser(user);
  }, [editor, user]);

  // Numbers depend on format options stored outside ProseMirror (equation mode, number styles).
  const numberingMode = numberingSignature(format);
  const lastNumberingMode = useRef(numberingMode);
  useEffect(() => {
    if (!editor || editor.isDestroyed || lastNumberingMode.current === numberingMode) return;
    lastNumberingMode.current = numberingMode;
    editor.view.dispatch(refreshNumbering(editor.state.tr));
  }, [editor, numberingMode]);

  const formatCss = useMemo(() => `${paperFormatCss(format)}\n${pagePrintCss(format.page)}`, [format]);

  const commentCss = useMemo(() => {
    const rules = comments
      .filter((t) => t.resolved)
      .map((t) => `.comment-mark[data-thread-id="${t.id}"]{background:none;border-bottom:none}`);
    if (activeThread) rules.push(`.comment-mark[data-thread-id="${activeThread}"]{background:var(--comment-active)}`);
    return rules.join("\n");
  }, [comments, activeThread]);

  const ctx = useMemo<PaperContextValue>(
    () => ({ docId, ydoc, provider, store, numbering, citations, user, editor, ui }),
    [docId, ydoc, provider, store, numbering, citations, user, editor, ui]
  );

  return (
    <PaperContext.Provider value={ctx}>
      <div className="flex h-dvh flex-col bg-muted/40 print:block print:h-auto print:bg-background">
        <EditorHeader
          status={status}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
        />
        {editor && <EditorToolbar editor={editor} />}
        <div className="flex min-h-0 flex-1 print:block">
          <main
            ref={mainRef}
            className="paper-scroll min-w-0 flex-1 overflow-auto [scrollbar-gutter:stable] print:overflow-visible"
          >
            {/* Pages of the document's size (see the Pagination extension). A transform keeps the text
                layout of the actual size; the box around them takes the shrunk size. */}
            <div
              className="mx-auto my-8 print:m-0 print:h-auto! print:w-auto!"
              style={{ width: page.width * pageScale, height: pagesHeight * pageScale }}
            >
              {/* Content overflowing into the right margin (a too wide equation) is cut at the page
                  edge, without a horizontal scrollbar on screen and without shrinking the paper in print. */}
              <article
                className="paper-page relative isolate origin-top-left overflow-x-clip"
                style={{
                  width: page.width,
                  padding: `${page.margin.top}px ${page.margin.right}px ${page.margin.bottom}px ${page.margin.left}px`,
                  minHeight: pagesHeight,
                  transform: pageScale < 1 ? `scale(${pageScale})` : undefined,
                }}
              >
                <PageSheets count={pageCount} page={page} />
                <PaperMeta />
                <EditorContent editor={editor} />
                <Bibliography />
              </article>
            </div>
          </main>
          {sidebarOpen && (
            <aside
              ref={sidebarRef}
              style={{ width: sidebarWidth, maxWidth: "60vw" }}
              className="relative hidden shrink-0 border-l bg-background md:flex print:hidden"
            >
              <SidebarResizer
                panelRef={sidebarRef}
                width={sidebarWidth}
                onResize={(width) => {
                  setSidebarWidth(width);
                  saveSidebarWidth(width);
                }}
              />
              <Sidebar
                tab={sidebarTab}
                onTabChange={setSidebarTab}
                citationView={citationView}
                onCitationViewChange={setCitationView}
                scrollRef={mainRef}
                activeThread={activeThread}
                onActiveThreadChange={setActiveThread}
              />
            </aside>
          )}
        </div>
        {editor && <StatusBar editor={editor} status={status} />}
      </div>

      {/* Keys stay distinct among these siblings while still remounting the dialogs on each open. */}
      {editor && (
        <Fragment key={`editor-dialogs-${dialogKey}`}>
          <CiteDialog
            editor={editor}
            open={cite.open}
            initial={cite.initial}
            initialOptions={cite.options}
            target={cite.target}
            onOpenChange={(open) => setCite((s) => ({ ...s, open }))}
          />
          <CrossRefDialog
            editor={editor}
            open={crossRef.open}
            target={crossRef.target}
            onOpenChange={(open) => setCrossRef((s) => ({ ...s, open }))}
          />
          <FigureDialog editor={editor} open={figureOpen} onOpenChange={setFigureOpen} />
          <TikzDialog
            editor={editor}
            open={tikz.open}
            figureId={tikz.figureId}
            onOpenChange={(open) => setTikz((s) => ({ ...s, open }))}
          />
          <TableDialog editor={editor} open={tableOpen} onOpenChange={setTableOpen} />
          <CommentDialog
            editor={editor}
            open={commentOpen}
            onOpenChange={setCommentOpen}
            onCreated={ui.focusThread}
          />
        </Fragment>
      )}
      <ReferenceDialog
        key={`reference-${dialogKey}`}
        open={refDialog.open}
        reference={refDialog.reference}
        initialTab={refDialog.tab}
        onOpenChange={(open) => setRefDialog((s) => ({ ...s, open }))}
      />
      <FormatDialog
        key={`format-${dialogKey}`}
        open={formatDialog.open}
        initialTab={formatDialog.tab}
        initialStyle={formatDialog.style}
        onOpenChange={(open) => setFormatDialog((s) => ({ ...s, open }))}
      />
      <CopyImageDialog image={copyImage} onClose={() => setCopyImage(null)} />
      <style>{formatCss}</style>
      <style>{commentCss}</style>
    </PaperContext.Provider>
  );
}
