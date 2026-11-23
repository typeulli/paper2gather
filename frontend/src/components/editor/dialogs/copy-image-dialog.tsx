"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface CopyImageDialogProps {
  /** Data URL of the PNG; null while closed */
  image: string | null;
  onClose: () => void;
}

/** Where the clipboard can't take an image: the image, to copy with the browser's own menu. */
export function CopyImageDialog({ image, onClose }: CopyImageDialogProps) {
  return (
    <Dialog open={image !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>이미지로 복사</DialogTitle>
          <DialogDescription>
            브라우저가 이미지를 바로 복사하지 못했습니다(https나 localhost가 아닌 주소에서는 막혀 있습니다). 아래
            이미지를 마우스 오른쪽 버튼으로 누르고 &lsquo;이미지 복사&rsquo;를 고르세요.
          </DialogDescription>
        </DialogHeader>
        {/* White like the image, also in the dark theme */}
        <div className="flex max-h-[60vh] justify-center overflow-auto rounded-md border bg-white p-4">
          {image && (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL made in the browser
            <img src={image} alt="복사할 이미지" className="h-auto max-w-full self-start" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
