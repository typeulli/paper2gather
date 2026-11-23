"use client";

import { useRef, useState } from "react";
import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import {
  ClipboardCopyIcon,
  CodeIcon,
  ImageIcon,
  ImageUpIcon,
  Loader2Icon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { resolveAssetUrl } from "@/lib/config";
import type { TikzSource } from "@/lib/tikz/options";
import { cn } from "@/lib/utils";
import { useCopyAsImage } from "../copy-as-image";
import { useFormat, useNumbering, usePaper } from "../paper-context";
import { ObjectCaption } from "./object-caption";
import { LABEL_PATTERN, numberAttribute, stopEventInNodeUi, stringAttribute } from "./shared";
import { tikzErrorText, TikzSvg, useTikz } from "./tikz-svg";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    figure: {
      insertFigure: (attrs: { src: string; caption?: string; width?: number }) => ReturnType;
      insertTikzFigure: (attrs: TikzSource & { caption?: string }) => ReturnType;
    };
  }
}

const WIDTHS = [25, 50, 75, 100];
/** TikZ figures can also keep their natural size (width 0), like in LaTeX. */
const TIKZ_WIDTHS = [0, ...WIDTHS];

/** The compiled TikZ figure in the document; double-click to edit. */
function TikzImage({ src, width, onEdit }: { src: TikzSource; width: number; onEdit?: () => void }) {
  const { result, compiling } = useTikz(src);
  return (
    <div className="flex w-full justify-center" onDoubleClick={onEdit}>
      {result?.ok ? (
        <TikzSvg svg={result.svg} width={width} className={cn(compiling && "opacity-60")} />
      ) : result ? (
        <div className="flex w-3/4 flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 font-sans text-xs text-destructive">
          <span className="flex items-center gap-1.5 font-medium">
            <TriangleAlertIcon className="size-3.5" /> TikZ 오류{onEdit && " · 더블클릭해서 고치세요"}
          </span>
          {result.errors.slice(0, 3).map((error, i) => (
            <span key={i}>{tikzErrorText(error)}</span>
          ))}
        </div>
      ) : (
        <div className="flex h-32 w-3/4 items-center justify-center gap-2 rounded-lg border-2 border-dashed font-sans text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" /> TikZ 그림을 그리는 중…
        </div>
      )}
    </div>
  );
}

function FigureView({ node, updateAttributes, deleteNode, editor, getPos, selected }: NodeViewProps) {
  const { id, src, caption, width, label, tikz, tikzLibraries, tikzPackages } = node.attrs as {
    id: string | null;
    src: string;
    caption: string;
    width: number;
    label: string | null;
    /** TikZ code of a TikZ figure; null for an image */
    tikz: string | null;
    tikzLibraries: string;
    tikzPackages: string;
  };
  const { ui } = usePaper();
  const numbering = useNumbering();
  const captionPosition = useFormat().figure.position;
  const number = (id && numbering.byId.get(id)?.number) || "?";
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const editable = editor.isEditable;
  const editTikz = editable && id ? () => ui.openTikzDialog({ figureId: id }) : undefined;
  const copyAsImage = useCopyAsImage();

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const { url } = await api.uploadImage(file);
      updateAttributes({ src: url });
    } catch (err) {
      toast.error(`이미지 업로드 실패: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const captionEl = (
    <figcaption className="w-full max-w-[90%]">
      <ObjectCaption
        kind="figure"
        number={number}
        caption={caption}
        editable={editable}
        onChange={(value) => updateAttributes({ caption: value })}
      />
    </figcaption>
  );

  return (
    <NodeViewWrapper
      className={cn("figure-node relative my-5 rounded-md py-2", selected && "bg-primary/5 ring-1 ring-primary/30")}
      data-object-id={id ?? undefined}
    >
      <figure className="flex flex-col items-center">
        {captionPosition === "above" && captionEl}
        {tikz !== null ? (
          <TikzImage
            src={{ code: tikz, libraries: tikzLibraries, packages: tikzPackages }}
            width={width}
            onEdit={editTikz}
          />
        ) : src ? (
          // eslint-disable-next-line @next/next/no-img-element -- user content from the collab backend
          <img
            src={resolveAssetUrl(src)}
            alt={caption}
            style={{ width: `${width}%` }}
            className="rounded-sm"
          />
        ) : (
          <button
            type="button"
            data-node-ui
            disabled={!editable}
            onClick={() => fileRef.current?.click()}
            className="flex h-40 w-3/4 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-sm text-muted-foreground hover:bg-muted/50"
          >
            {uploading ? <Loader2Icon className="size-6 animate-spin" /> : <ImageIcon className="size-6" />}
            이미지를 업로드하세요
          </button>
        )}
        {captionPosition === "below" && captionEl}
      </figure>

      {selected && editable && (
        <div
          data-node-ui
          className={cn(
            "absolute right-1 flex items-center gap-1 rounded-lg border bg-popover p-1 text-xs shadow-sm",
            // Below a TikZ figure: over a small drawing it would catch the second click of a double-click.
            tikz !== null ? "top-full z-10 mt-1" : "top-1"
          )}
        >
          {(tikz !== null ? TIKZ_WIDTHS : WIDTHS).map((w) => (
            <Button
              key={w}
              size="xs"
              variant={w === width ? "secondary" : "ghost"}
              title={w === 0 ? "TikZ 코드에 정한 크기 그대로" : undefined}
              onClick={() => updateAttributes({ width: w })}
            >
              {w === 0 ? "원래 크기" : `${w}%`}
            </Button>
          ))}
          <Input
            title="LaTeX 라벨"
            value={label ?? ""}
            className="h-6 w-28 font-mono text-[11px]"
            onChange={(e) => {
              if (LABEL_PATTERN.test(e.target.value) && e.target.value) updateAttributes({ label: e.target.value });
            }}
          />
          {tikz !== null ? (
            <Button size="icon-xs" variant="ghost" title="TikZ 편집 (더블클릭)" onClick={editTikz}>
              <CodeIcon />
            </Button>
          ) : (
            <Button size="icon-xs" variant="ghost" title="이미지 교체" onClick={() => fileRef.current?.click()}>
              {uploading ? <Loader2Icon className="animate-spin" /> : <ImageUpIcon />}
            </Button>
          )}
          {(tikz !== null || src) && (
            <Button
              size="icon-xs"
              variant="ghost"
              title="이미지로 복사"
              onClick={() => {
                const pos = getPos();
                if (typeof pos === "number") copyAsImage(pos);
              }}
            >
              <ClipboardCopyIcon />
            </Button>
          )}
          <Button size="icon-xs" variant="ghost" title="그림 삭제" onClick={() => deleteNode()}>
            <Trash2Icon />
          </Button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        hidden
        data-node-ui
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </NodeViewWrapper>
  );
}

export const Figure = Node.create({
  name: "figure",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      id: stringAttribute("id"),
      label: stringAttribute("label"),
      src: stringAttribute("src", ""),
      caption: stringAttribute("caption", ""),
      // % of the text width; 0 = the natural size of a TikZ figure
      width: numberAttribute("width", 75, true),
      tikz: stringAttribute("tikz"),
      tikzLibraries: stringAttribute("tikzLibraries", ""),
      tikzPackages: stringAttribute("tikzPackages", ""),
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-type="figure"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "figure",
      mergeAttributes({ "data-type": "figure" }, HTMLAttributes),
      node.attrs.tikz !== null
        ? ["pre", {}, node.attrs.tikz]
        : ["img", { src: resolveAssetUrl(node.attrs.src), alt: node.attrs.caption }],
      ["figcaption", {}, node.attrs.caption],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FigureView, { stopEvent: stopEventInNodeUi });
  },

  addCommands() {
    return {
      insertFigure:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { src: attrs.src, caption: attrs.caption ?? "", width: attrs.width ?? 75 },
          }),
      insertTikzFigure:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              tikz: attrs.code,
              tikzLibraries: attrs.libraries,
              tikzPackages: attrs.packages,
              caption: attrs.caption ?? "",
              width: 0,
            },
          }),
    };
  },
});
