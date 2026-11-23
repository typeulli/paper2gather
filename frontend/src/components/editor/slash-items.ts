import {
  BookAIcon,
  BookMarkedIcon,
  CodeIcon,
  DraftingCompassIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  PilcrowIcon,
  RadicalIcon,
  SigmaIcon,
  TableIcon,
  TextQuoteIcon,
} from "lucide-react";
import type { SlashItem } from "./extensions/slash-command";
import { startAppendix } from "./nodes/appendix-break";
import type { PaperUi } from "./paper-context";

export function createSlashItems(ui: PaperUi): SlashItem[] {
  return [
    {
      title: "수식 (블록)",
      description: "번호가 매겨지는 디스플레이 수식",
      icon: SigmaIcon,
      keywords: ["equation", "math", "eq"],
      run: (e, r) => e.chain().focus().deleteRange(r).insertEquation().run(),
    },
    {
      title: "인라인 수식",
      description: "문장 안의 수식 ($x$)",
      icon: RadicalIcon,
      keywords: ["inline", "math", "latex"],
      run: (e, r) => e.chain().focus().deleteRange(r).insertMathInline().run(),
    },
    {
      title: "인용",
      description: "참고문헌 인용 [1]",
      icon: BookMarkedIcon,
      keywords: ["cite", "citation", "reference", "bib"],
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        ui.openCiteDialog();
      },
    },
    {
      title: "상호 참조",
      description: "수식·그림·표·절 번호 참조",
      icon: LinkIcon,
      keywords: ["ref", "crossref", "label"],
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        ui.openCrossRefDialog();
      },
    },
    {
      title: "그림",
      description: "이미지와 번호 캡션",
      icon: ImageIcon,
      keywords: ["figure", "image", "img"],
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        ui.openFigureDialog();
      },
    },
    {
      title: "TikZ 그림",
      description: "TikZ 코드로 그린 번호 그림",
      icon: DraftingCompassIcon,
      keywords: ["tikz", "pgf", "pgfplots", "diagram", "drawing"],
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        ui.openTikzDialog();
      },
    },
    {
      title: "표",
      description: "번호 캡션이 있는 표",
      icon: TableIcon,
      keywords: ["table", "tabular"],
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        ui.openTableDialog();
      },
    },
    {
      title: "본문",
      description: "일반 문단",
      icon: PilcrowIcon,
      keywords: ["paragraph", "text"],
      run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
    },
    {
      title: "제목 1",
      description: "절 (section)",
      icon: Heading1Icon,
      keywords: ["h1", "heading", "section"],
      run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run(),
    },
    {
      title: "제목 2",
      description: "소절 (subsection)",
      icon: Heading2Icon,
      keywords: ["h2", "heading", "subsection"],
      run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run(),
    },
    {
      title: "제목 3",
      description: "소소절 (subsubsection)",
      icon: Heading3Icon,
      keywords: ["h3", "heading", "subsubsection"],
      run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run(),
    },
    {
      title: "부록",
      description: "이후 제목 1을 부록 A, B…로 (appendix)",
      icon: BookAIcon,
      keywords: ["appendix"],
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        startAppendix(e);
      },
    },
    {
      title: "글머리 목록",
      description: "itemize",
      icon: ListIcon,
      keywords: ["bullet", "list", "itemize", "ul"],
      run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
    },
    {
      title: "번호 목록",
      description: "enumerate",
      icon: ListOrderedIcon,
      keywords: ["ordered", "list", "enumerate", "ol"],
      run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
    },
    {
      title: "인용구",
      description: "quote",
      icon: TextQuoteIcon,
      keywords: ["quote", "blockquote"],
      run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
    },
    {
      title: "코드 블록",
      description: "verbatim",
      icon: CodeIcon,
      keywords: ["code", "verbatim"],
      run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
    },
    {
      title: "구분선",
      description: "horizontal rule",
      icon: MinusIcon,
      keywords: ["hr", "divider", "rule"],
      run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
    },
  ];
}
