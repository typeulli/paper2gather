import { defaultFormat, PAPER_SIZES, type PageFormat } from "./format";

/** Page geometry of the paginated editor, in CSS px */
export interface PageGeometry {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  /** Space between pages on screen (none when printing) */
  gap: number;
}

const PX_PER_MM = 96 / 25.4;

/**
 * The document's page in the whole pixels Chrome lays it out with for printing (each edge rounded to the nearest
 * px: A4 with 25 mm margins is 794 × 1123 with margins 94, 95, 95, 94), so that the screen pages break where the
 * printed ones do. The @page rule of `pagePrintCss` has the same margins.
 */
export function pageGeometry(page: PageFormat): PageGeometry {
  const paper = PAPER_SIZES[page.paper];
  const exactWidth = paper.width * PX_PER_MM;
  const exactHeight = paper.height * PX_PER_MM;
  const width = Math.round(exactWidth);
  const height = Math.round(exactHeight);
  return {
    width,
    height,
    margin: {
      top: Math.round(page.marginTop * PX_PER_MM),
      right: width - Math.round(exactWidth - page.marginRight * PX_PER_MM),
      bottom: height - Math.round(exactHeight - page.marginBottom * PX_PER_MM),
      left: Math.round(page.marginLeft * PX_PER_MM),
    },
    gap: 24,
  };
}

/** Page geometry of the default format: A4 with 25 mm margins */
export const PAGE = pageGeometry(defaultFormat().page);

/** Width of the text area of the default page */
export const PAGE_TEXT_WIDTH = PAGE.width - PAGE.margin.left - PAGE.margin.right;

/**
 * Page size and margins for printing. The side margins are the article's padding: Chrome shrinks the whole paper to
 * fit anything wider than the page area, so that area has to reach the paper edge, where the article clips.
 */
export function pagePrintCss(page: PageFormat): string {
  const { margin } = pageGeometry(page);
  const size = page.paper === "letter" ? "letter" : "A4";
  return `@media print{@page{size:${size};margin:${margin.top}px 0 ${margin.bottom}px}}`;
}
