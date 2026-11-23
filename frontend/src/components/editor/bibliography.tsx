"use client";

import { entryLabel, formatReferenceAs, isAuthorDate } from "@/lib/paper/citations";
import { cn } from "@/lib/utils";
import { useCitations, useFormat, usePaper } from "./paper-context";

/**
 * Read-only reference list rendered after the document body, in the order of the citation style. Uncited
 * references are dimmed on screen; when the style lists only cited ones, they aren't printed.
 */
export function Bibliography() {
  const { ui } = usePaper();
  const layout = useCitations();
  const format = useFormat();
  const hanging = isAuthorDate(layout.style);

  return (
    <section className="mt-12 border-t pt-6">
      {/* Styled like "제목 1" (see paperFormatCss) */}
      <h2 className="paper-references-title">{format.references.title}</h2>
      {layout.entries.length === 0 ? (
        <button
          type="button"
          onClick={() => ui.setSidebarTab("citations", "references")}
          className="text-sm text-muted-foreground hover:underline print:invisible"
        >
          아직 참고문헌이 없습니다. 오른쪽 패널에서 추가하세요.
        </button>
      ) : (
        <ol className="paper-references">
          {layout.entries.map((entry) => (
            <li
              key={entry.ref.id}
              id={`ref-${entry.ref.id}`}
              className={cn(
                "flex gap-3",
                !entry.cited && "opacity-60 print:opacity-100",
                !entry.listed && "print:hidden"
              )}
            >
              {!hanging && (
                <span className="w-8 shrink-0 text-right tabular-nums">{entryLabel(entry, layout.style)}</span>
              )}
              {/* APA: hanging indent of 0.5 in */}
              <span className={cn("ref-text min-w-0 flex-1 break-words", hanging && "pl-[0.5in] -indent-[0.5in]")}>
                {formatReferenceAs(entry.ref, layout.style, layout).map((s, j) =>
                  s.italic ? <em key={j}>{s.text}</em> : <span key={j}>{s.text}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
