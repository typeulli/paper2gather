"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { imageSourceAt, renderImage } from "@/lib/copy-image";
import { useFormat, usePaper, type PaperUi } from "./paper-context";

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Browsers write images to the clipboard only for https and localhost pages. */
function canWriteImages(): boolean {
  return window.isSecureContext && typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;
}

/**
 * Puts the PNG on the clipboard. Where the browser doesn't allow that (a page over http from another PC), the image
 * opens in a window to copy it from with the browser's own menu.
 */
async function copyImage(image: Promise<Blob | null>, ui: PaperUi): Promise<void> {
  const progress = toast.loading("이미지를 만드는 중…");
  if (canWriteImages()) {
    try {
      // The promise itself goes to the clipboard, so that browsers asking for a click right before still allow it.
      const png = image.then((blob) => blob ?? Promise.reject(new Error("not drawn")));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      toast.success("이미지로 복사했습니다.", { id: progress });
      return;
    } catch {
      // Not drawn, or the browser refused: told apart below.
    }
  }
  const blob = await image;
  if (!blob) {
    toast.error("이미지를 만들지 못했습니다.", { id: progress });
    return;
  }
  toast.dismiss(progress);
  ui.openCopyImageDialog(await blobToDataUrl(blob));
}

/** Copies the equation, figure or table at a position as an image (without caption or number). */
export function useCopyAsImage(): (pos: number) => void {
  const { editor, ui } = usePaper();
  const format = useFormat();
  return useCallback(
    (pos: number) => {
      if (!editor) return;
      const source = imageSourceAt(editor, pos, format);
      if (!source) {
        toast.error("이미지로 복사할 내용이 없습니다.");
        return;
      }
      void copyImage(renderImage(source), ui);
    },
    [editor, format, ui]
  );
}
