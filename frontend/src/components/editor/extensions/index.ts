import { getSchema } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TableKit } from "@tiptap/extension-table";
import { TextStyle } from "@tiptap/extension-text-style";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import type * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";
import type { CitationStore } from "@/lib/paper/citation-store";
import type { PaperFormat } from "@/lib/paper/format";
import type { NumberingStore } from "@/lib/paper/numbering";
import { pageGeometry } from "@/lib/paper/page";
import { FIELDS, type PaperStore } from "@/lib/paper/store";
import type { LocalUser } from "@/lib/user";
import { AppendixBreak } from "../nodes/appendix-break";
import { Citation } from "../nodes/citation";
import { CrossRef } from "../nodes/cross-ref";
import { Equation } from "../nodes/equation";
import { Figure } from "../nodes/figure";
import { MathInline } from "../nodes/math-inline";
import { TableFigure } from "../nodes/table-figure";
import { CommentMark } from "./comment-mark";
import { NodeUiFocus } from "./node-ui-focus";
import { Numbering } from "./numbering";
import { Pagination } from "./pagination";
import { PaperHeading } from "./paper-heading";
import { ReactSelection } from "./react-selection";
import { RemoteChangeSelection } from "./remote-change-selection";
import { SlashCommand, type SlashItem } from "./slash-command";
import { PaperTableRow, TABLE_CELL_MIN_WIDTH, TableLayout } from "./table-layout";
import { TextFormat } from "./text-format";

export interface BuildExtensionsOptions {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  user: LocalUser;
  store: PaperStore;
  numbering: NumberingStore;
  citations: CitationStore;
  getFormat: () => PaperFormat;
  getSlashItems: () => SlashItem[];
  onCommentActivate: (threadId: string) => void;
  onPageCount: (count: number) => void;
}

const STARTER_KIT = StarterKit.configure({
  // Yjs has its own undo manager (provided by the Collaboration extension)
  undoRedo: false,
  heading: false,
  link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
});

const TABLE_KIT = TableKit.configure({
  table: { resizable: true, cellMinWidth: TABLE_CELL_MIN_WIDTH },
  tableRow: false,
});

export function buildExtensions(opts: BuildExtensionsOptions) {
  return [
    STARTER_KIT,
    PaperHeading,
    Subscript,
    Superscript,
    TextStyle,
    TextFormat,
    Placeholder.configure({
      placeholder: ({ node }) =>
        node.type.name === "heading" ? "제목" : "내용을 입력하거나 '/'로 수식·인용·그림을 삽입하세요",
    }),
    CharacterCount,
    TABLE_KIT,
    PaperTableRow,
    TableLayout,
    TableFigure,
    Equation,
    MathInline,
    AppendixBreak,
    Citation.configure({ citations: opts.citations }),
    CrossRef.configure({ store: opts.store, numbering: opts.numbering }),
    Figure,
    NodeUiFocus,
    ReactSelection,
    CommentMark.configure({ onActivate: opts.onCommentActivate }),
    Numbering.configure({ store: opts.numbering, getFormat: opts.getFormat }),
    SlashCommand.configure({ getItems: opts.getSlashItems }),
    Pagination.configure({
      onPageCount: opts.onPageCount,
      getPage: () => pageGeometry(opts.getFormat().page),
      subscribePage: opts.store.formatSlice.subscribe,
    }),
    Collaboration.configure({ document: opts.ydoc, field: FIELDS.content }),
    CollaborationCaret.configure({ provider: opts.provider, user: opts.user }),
    RemoteChangeSelection.configure({ provider: opts.provider }),
  ];
}

/**
 * The document schema without an editor, e.g. to build imported documents.
 * Must include every extension of buildExtensions that defines nodes, marks or attributes.
 */
export function buildPaperSchema() {
  return getSchema([
    STARTER_KIT,
    PaperHeading,
    Subscript,
    Superscript,
    TextStyle,
    TextFormat,
    TABLE_KIT,
    PaperTableRow,
    TableFigure,
    Equation,
    MathInline,
    AppendixBreak,
    Citation,
    CrossRef,
    Figure,
    CommentMark,
  ]);
}
