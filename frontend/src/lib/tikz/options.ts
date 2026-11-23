/** TikZ figures: the code is the body of a standalone LaTeX document, compiled in the browser (engine.ts). */

export interface TikzSource {
  code: string;
  /** Comma-separated TikZ libraries (\usetikzlibrary) */
  libraries: string;
  /** Comma-separated LaTeX packages (\usepackage) */
  packages: string;
}

export const DEFAULT_TIKZ_CODE = String.raw`\begin{tikzpicture}
  \draw[->] (0,0) -- (3,0) node[right] {$x$};
  \draw[->] (0,0) -- (0,2) node[above] {$y$};
  \draw[thick, blue] (0,0) .. controls (1,2) and (2,0) .. (3,1.5);
\end{tikzpicture}`;

/** Packages the browser TeX engine has the files for (isomorphic-tikzjax) */
export const TIKZ_PACKAGES: { name: string; description: string }[] = [
  { name: "pgfplots", description: "함수·데이터 그래프 (axis 환경)" },
  { name: "tikz-cd", description: "가환 다이어그램 (tikzcd 환경)" },
  { name: "circuitikz", description: "전기 회로도 (circuitikz 환경)" },
  { name: "chemfig", description: "화학 구조식 (\\chemfig)" },
  { name: "tikz-3dplot", description: "3차원 좌표계 회전" },
  { name: "tikz-feynhand", description: "파인만 다이어그램" },
  { name: "amsmath", description: "수식 환경·명령" },
  { name: "amssymb", description: "수학 기호 (\\mathbb 등)" },
  { name: "array", description: "표 열 형식 확장" },
];

/** Libraries shown first; the rest are under "all libraries". */
export const COMMON_TIKZ_LIBRARIES = [
  "arrows.meta",
  "positioning",
  "calc",
  "shapes.geometric",
  "shapes.misc",
  "decorations.pathreplacing",
  "decorations.pathmorphing",
  "decorations.markings",
  "patterns",
  "fit",
  "backgrounds",
  "matrix",
  "automata",
  "intersections",
  "angles",
  "quotes",
  "3d",
  "shadows",
  "trees",
  "chains",
];

/** Every TikZ library in the browser TeX engine */
export const ALL_TIKZ_LIBRARIES = [
  "3d", "angles", "animations", "arrows", "arrows.meta", "automata", "babel", "backgrounds", "bending", "calc",
  "calendar", "cd", "chains", "circuits", "circuits.ee", "circuits.ee.IEC", "circuits.logic", "circuits.logic.CDH",
  "circuits.logic.IEC", "circuits.logic.US", "datavisualization", "datavisualization.3d",
  "datavisualization.barcharts", "datavisualization.formats.functions", "datavisualization.polar",
  "datavisualization.sparklines", "decorations", "decorations.footprints", "decorations.fractals",
  "decorations.markings", "decorations.pathmorphing", "decorations.pathreplacing", "decorations.shapes",
  "decorations.text", "er", "fadings", "feynhand", "fit", "fixedpointarithmetic", "folding", "fpu", "graphs",
  "graphs.standard", "intersections", "lindenmayersystems", "math", "matrix", "mindmap", "patterns",
  "patterns.meta", "perspective", "petri", "plothandlers", "plotmarks", "positioning", "quotes", "rdf", "scopes",
  "shadings", "shadows", "shapes", "shapes.arrows", "shapes.callouts", "shapes.gates.logic.IEC",
  "shapes.gates.logic.US", "shapes.geometric", "shapes.misc", "shapes.multipart", "shapes.symbols", "snakes", "spy",
  "svg.path", "through", "trees", "turtle", "views",
];

/** "a, b,,c" -> ["a", "b", "c"] */
export function splitList(list: string | null | undefined): string[] {
  return (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Adds or removes `name` in a comma-separated list. */
export function toggleInList(list: string, name: string, on: boolean): string {
  const items = splitList(list).filter((n) => n !== name);
  if (on) items.push(name);
  return items.join(",");
}
