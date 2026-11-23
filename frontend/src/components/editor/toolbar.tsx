"use client";

import { useState, type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import {
  BetweenHorizontalEndIcon,
  BetweenHorizontalStartIcon,
  BetweenVerticalEndIcon,
  BetweenVerticalStartIcon,
  BoldIcon,
  BookAIcon,
  BookMarkedIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardCopyIcon,
  CodeIcon,
  DraftingCompassIcon,
  HashIcon,
  ImageIcon,
  ItalicIcon,
  Link2Icon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  MessageSquarePlusIcon,
  MinusIcon,
  RadicalIcon,
  Redo2Icon,
  RemoveFormattingIcon,
  Settings2Icon,
  SigmaIcon,
  StrikethroughIcon,
  SubscriptIcon,
  SuperscriptIcon,
  TableIcon,
  TableRowsSplitIcon,
  TextAlignCenterIcon,
  TextAlignEndIcon,
  TextAlignJustifyIcon,
  TextAlignStartIcon,
  TextQuoteIcon,
  Trash2Icon,
  UnderlineIcon,
  Undo2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { refocusEditor } from "@/lib/editor-utils";
import {
  blockStyleKey,
  FONT_SIZE_RANGE,
  isColor,
  isKoreanFontKey,
  isLatinFontKey,
  isTextAlign,
  KOREAN_FONT_KEYS,
  KOREAN_FONTS,
  LATIN_FONT_KEYS,
  LATIN_FONTS,
  styleLabelCss,
  type FontDef,
  type TextAlign,
} from "@/lib/paper/format";
import { cn } from "@/lib/utils";
import { ColorPalette } from "./color-palette";
import { useCopyAsImage } from "./copy-as-image";
import { startAppendix } from "./nodes/appendix-break";
import { NumberStepper } from "./number-stepper";
import { useFormat, usePaper } from "./paper-context";

function ToolButton({
  label,
  shortcut,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          className={cn(active && "bg-muted text-foreground")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="ml-1.5 opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

const BLOCK_LABELS = { p: "본문", h1: "제목 1", h2: "제목 2", h3: "제목 3" } as const;

const ALIGNS: { value: TextAlign; label: string; icon: ReactNode }[] = [
  { value: "left", label: "왼쪽 정렬", icon: <TextAlignStartIcon /> },
  { value: "center", label: "가운데 정렬", icon: <TextAlignCenterIcon /> },
  { value: "right", label: "오른쪽 정렬", icon: <TextAlignEndIcon /> },
  { value: "justify", label: "양쪽 정렬", icon: <TextAlignJustifyIcon /> },
];

function FontMenuItem({ font, checked, onSelect }: { font: FontDef; checked: boolean; onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <span style={{ fontFamily: font.css }}>{font.label}</span>
      {font.local && <span className="text-xs text-muted-foreground">설치된 PC만</span>}
      <CheckIcon className={cn("ml-auto", !checked && "invisible")} />
    </DropdownMenuItem>
  );
}

function TextColorButton({ editor, color }: { editor: Editor; color: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="글자 색" onMouseDown={(e) => e.preventDefault()}>
              <span className="relative flex size-4 items-center justify-center text-[13px] leading-none font-semibold">
                A
                <span
                  className="absolute inset-x-0 -bottom-0.5 h-[3px] rounded-full"
                  style={{ background: color ?? "currentColor" }}
                />
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>글자 색</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-auto p-3" onCloseAutoFocus={refocusEditor(editor)}>
        {/* Applied to the editor's selection without focusing it, so the color picker stays open. */}
        <ColorPalette
          value={color}
          onChange={(c) => editor.chain().setTextColor(c).run()}
          onPick={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function LinkButton({ editor, active }: { editor: Editor; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setHref((editor.getAttributes("link").href as string | undefined) ?? "");
        setOpen(next);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="링크"
              onMouseDown={(e) => e.preventDefault()}
              className={cn(active && "bg-muted text-foreground")}
            >
              <Link2Icon />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>링크</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-80" onCloseAutoFocus={(e) => e.preventDefault()}>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const chain = editor.chain().focus().extendMarkRange("link");
            if (href.trim()) chain.setLink({ href: href.trim() }).run();
            else chain.unsetLink().run();
            setOpen(false);
          }}
        >
          <Input autoFocus value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://" />
          <Button type="submit" size="sm">
            {href.trim() ? "적용" : "해제"}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function EditorToolbar({ editor }: { editor: Editor }) {
  const { ui } = usePaper();
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      subscript: e.isActive("subscript"),
      superscript: e.isActive("superscript"),
      link: e.isActive("link"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      blockquote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      heading: ([1, 2, 3] as const).find((level) => e.isActive("heading", { level })),
      headingNumbered: e.getAttributes("heading").numbered !== false,
      inTable: e.isActive("table"),
      latinFont: e.getAttributes("textStyle").latinFont as unknown,
      koreanFont: e.getAttributes("textStyle").koreanFont as unknown,
      fontSize: e.getAttributes("textStyle").fontSize as unknown,
      color: e.getAttributes("textStyle").color as unknown,
      textAlign: (e.getAttributes("heading").textAlign ?? e.getAttributes("paragraph").textAlign) as unknown,
      hasSelection: !e.state.selection.empty,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const blockKey = s.heading ? (`h${s.heading}` as const) : "p";
  const chain = () => editor.chain().focus();
  const copyAsImage = useCopyAsImage();
  const copyTableAsImage = () => {
    const { $from } = editor.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type.name === "table") return copyAsImage($from.before(depth));
    }
  };

  // Direct formatting overrides the paragraph style of the block at the selection.
  const format = useFormat();
  const blockStyle = format.styles[blockStyleKey(s.heading)];
  const latinFont = isLatinFontKey(s.latinFont) ? s.latinFont : blockStyle.latinFont;
  const koreanFont = isKoreanFontKey(s.koreanFont) ? s.koreanFont : blockStyle.koreanFont;
  const fontSize = typeof s.fontSize === "number" ? s.fontSize : blockStyle.size;
  const align = ALIGNS.find((a) => a.value === (isTextAlign(s.textAlign) ? s.textAlign : blockStyle.align)) ?? ALIGNS[0];

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b bg-background px-2 py-1 print:hidden">
      <ToolButton label="실행 취소" shortcut="Ctrl+Z" disabled={!s.canUndo} onClick={() => chain().undo().run()}>
        <Undo2Icon />
      </ToolButton>
      <ToolButton label="다시 실행" shortcut="Ctrl+Shift+Z" disabled={!s.canRedo} onClick={() => chain().redo().run()}>
        <Redo2Icon />
      </ToolButton>
      <Separator orientation="vertical" className="mx-1 h-5!" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="w-24 justify-between" onMouseDown={(e) => e.preventDefault()}>
            {BLOCK_LABELS[blockKey]} <ChevronDownIcon className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuItem onSelect={() => chain().setParagraph().run()} style={styleLabelCss(format.styles.body)}>
            본문
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => chain().setHeading({ level: 1 }).run()}
            style={styleLabelCss(format.styles.heading1)}
          >
            제목 1
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => chain().setHeading({ level: 2 }).run()}
            style={styleLabelCss(format.styles.heading2)}
          >
            제목 2
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => chain().setHeading({ level: 3 }).run()}
            style={styleLabelCss(format.styles.heading3)}
          >
            제목 3
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => ui.openFormatDialog({ tab: "styles", style: blockStyleKey(s.heading) })}
          >
            <Settings2Icon /> 스타일 설정…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {s.heading && (
        <ToolButton
          label={s.headingNumbered ? "번호 없는 제목으로 (\\section*)" : "번호 매기기"}
          active={s.headingNumbered}
          onClick={() => chain().updateAttributes("heading", { numbered: !s.headingNumbered }).run()}
        >
          <HashIcon />
        </ToolButton>
      )}
      <Separator orientation="vertical" className="mx-1 h-5!" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            title="글꼴"
            className="w-60 justify-between"
            onMouseDown={(e) => e.preventDefault()}
          >
            <span className="truncate">
              <span style={{ fontFamily: LATIN_FONTS[latinFont].css }}>{LATIN_FONTS[latinFont].label}</span>
              <span className="text-muted-foreground"> / </span>
              <span style={{ fontFamily: KOREAN_FONTS[koreanFont].css }}>{KOREAN_FONTS[koreanFont].label}</span>
            </span>
            <ChevronDownIcon className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuLabel>영문 글꼴</DropdownMenuLabel>
          {LATIN_FONT_KEYS.map((key) => (
            <FontMenuItem
              key={key}
              font={LATIN_FONTS[key]}
              checked={key === latinFont}
              onSelect={() => chain().setLatinFont(key).run()}
            />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>한글 글꼴</DropdownMenuLabel>
          {KOREAN_FONT_KEYS.map((key) => (
            <FontMenuItem
              key={key}
              font={KOREAN_FONTS[key]}
              checked={key === koreanFont}
              onSelect={() => chain().setKoreanFont(key).run()}
            />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => chain().setLatinFont(null).setKoreanFont(null).run()}>
            스타일 글꼴 사용 ({LATIN_FONTS[blockStyle.latinFont].label} / {KOREAN_FONTS[blockStyle.koreanFont].label})
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NumberStepper
        value={fontSize}
        min={FONT_SIZE_RANGE.min}
        max={FONT_SIZE_RANGE.max}
        label="글자 크기"
        keepFocus
        onChange={(size) => editor.chain().setFontSizePt(size).run()}
        onSubmit={() => editor.commands.focus()}
      />
      <Separator orientation="vertical" className="mx-1 h-5!" />

      <ToolButton label="굵게" shortcut="Ctrl+B" active={s.bold} onClick={() => chain().toggleBold().run()}>
        <BoldIcon />
      </ToolButton>
      <ToolButton label="기울임" shortcut="Ctrl+I" active={s.italic} onClick={() => chain().toggleItalic().run()}>
        <ItalicIcon />
      </ToolButton>
      <ToolButton label="밑줄" shortcut="Ctrl+U" active={s.underline} onClick={() => chain().toggleUnderline().run()}>
        <UnderlineIcon />
      </ToolButton>
      <ToolButton label="취소선" active={s.strike} onClick={() => chain().toggleStrike().run()}>
        <StrikethroughIcon />
      </ToolButton>
      <ToolButton label="아래 첨자" active={s.subscript} onClick={() => chain().toggleSubscript().run()}>
        <SubscriptIcon />
      </ToolButton>
      <ToolButton label="위 첨자" active={s.superscript} onClick={() => chain().toggleSuperscript().run()}>
        <SuperscriptIcon />
      </ToolButton>
      <ToolButton label="인라인 코드" active={s.code} onClick={() => chain().toggleCode().run()}>
        <CodeIcon />
      </ToolButton>
      <LinkButton editor={editor} active={s.link} />
      <TextColorButton editor={editor} color={isColor(s.color) ? s.color : null} />
      <ToolButton label="서식 지우기" onClick={() => chain().clearTextFormatting().run()}>
        <RemoveFormattingIcon />
      </ToolButton>
      <Separator orientation="vertical" className="mx-1 h-5!" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="정렬" title="정렬" onMouseDown={(e) => e.preventDefault()}>
            {align.icon}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
          {ALIGNS.map((a) => (
            <DropdownMenuItem key={a.value} onSelect={() => chain().setBlockAlign(a.value).run()}>
              {a.icon} {a.label}
              {a.value === align.value && <CheckIcon className="ml-auto" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <ToolButton label="글머리 목록" active={s.bulletList} onClick={() => chain().toggleBulletList().run()}>
        <ListIcon />
      </ToolButton>
      <ToolButton label="번호 목록" active={s.orderedList} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrderedIcon />
      </ToolButton>
      <ToolButton label="인용구" active={s.blockquote} onClick={() => chain().toggleBlockquote().run()}>
        <TextQuoteIcon />
      </ToolButton>
      <ToolButton label="구분선" onClick={() => chain().setHorizontalRule().run()}>
        <MinusIcon />
      </ToolButton>
      <Separator orientation="vertical" className="mx-1 h-5!" />

      <ToolButton label="인라인 수식" shortcut="Ctrl+Shift+E" onClick={() => chain().insertMathInline().run()}>
        <RadicalIcon />
      </ToolButton>
      <ToolButton label="수식 블록 (번호)" shortcut="Ctrl+Alt+E" onClick={() => chain().insertEquation().run()}>
        <SigmaIcon />
      </ToolButton>
      <ToolButton label="인용 삽입" onClick={() => ui.openCiteDialog()}>
        <BookMarkedIcon />
      </ToolButton>
      <ToolButton label="상호 참조 (수식·그림·표·절)" onClick={() => ui.openCrossRefDialog()}>
        <LinkIcon />
      </ToolButton>
      <ToolButton label="그림" onClick={() => ui.openFigureDialog()}>
        <ImageIcon />
      </ToolButton>
      <ToolButton label="TikZ 그림" onClick={() => ui.openTikzDialog()}>
        <DraftingCompassIcon />
      </ToolButton>
      <ToolButton label="표" onClick={() => ui.openTableDialog()}>
        <TableIcon />
      </ToolButton>
      <ToolButton label="부록 시작 (이후 제목 1 → 부록 A, B…)" onClick={() => startAppendix(editor)}>
        <BookAIcon />
      </ToolButton>
      <ToolButton label="댓글 (텍스트 선택 후)" disabled={!s.hasSelection} onClick={() => ui.openCommentDialog()}>
        <MessageSquarePlusIcon />
      </ToolButton>

      {s.inTable && (
        <>
          <Separator orientation="vertical" className="mx-1 h-5!" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm" onMouseDown={(e) => e.preventDefault()}>
                <TableRowsSplitIcon /> 표 편집 <ChevronDownIcon className="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuItem onSelect={() => chain().addRowBefore().run()}>
                <BetweenHorizontalStartIcon /> 위에 행 추가
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chain().addRowAfter().run()}>
                <BetweenHorizontalEndIcon /> 아래에 행 추가
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chain().addColumnBefore().run()}>
                <BetweenVerticalStartIcon /> 왼쪽에 열 추가
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chain().addColumnAfter().run()}>
                <BetweenVerticalEndIcon /> 오른쪽에 열 추가
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => chain().mergeOrSplit().run()}>셀 병합 / 분할</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chain().toggleHeaderRow().run()}>머리글 행 전환</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={copyTableAsImage}>
                <ClipboardCopyIcon /> 이미지로 복사
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => chain().deleteRow().run()}>행 삭제</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chain().deleteColumn().run()}>열 삭제</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => chain().deleteTableFigure().run()}>
                <Trash2Icon /> 표 삭제
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
