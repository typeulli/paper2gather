"use client";

import { captionLabelText } from "@/lib/paper/format";
import { cn } from "@/lib/utils";
import { useFormat } from "../paper-context";
import { CaptionField } from "./caption-field";

interface ObjectCaptionProps {
  kind: "figure" | "table";
  number: string;
  caption: string;
  editable: boolean;
  onChange: (caption: string) => void;
  className?: string;
}

/** "Figure 1. <caption>" in the document's caption format and caption paragraph style. */
export function ObjectCaption({ kind, number, caption, editable, onChange, className }: ObjectCaptionProps) {
  const format = useFormat()[kind];
  return (
    <div data-node-ui contentEditable={false} className={cn("paper-caption", className)}>
      <span className={cn(format.labelBold && "font-bold")}>{captionLabelText(format, number)}</span>{" "}
      <CaptionField value={caption} editable={editable} onChange={onChange} />
    </div>
  );
}
