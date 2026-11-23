import type { PageGeometry } from "@/lib/paper/page";

/**
 * The sheets behind the paginated paper, with page numbers (screen only: printing paginates
 * natively, see globals.css). The text is placed on them by the Pagination extension.
 */
export function PageSheets({ count, page }: { count: number; page: PageGeometry }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 select-none print:hidden">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="absolute inset-x-0 rounded-sm border bg-background shadow-sm"
          style={{ top: i * (page.height + page.gap), height: page.height }}
        >
          <span
            className="absolute inset-x-0 translate-y-1/2 text-center text-xs text-muted-foreground tabular-nums"
            style={{ bottom: page.margin.bottom / 2 }}
          >
            {i + 1}
          </span>
        </div>
      ))}
    </div>
  );
}
