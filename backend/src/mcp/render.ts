/**
 * Paper nodes → the markdown dialect of markdown.ts, so that what read_paper shows can be edited and
 * written back. Formatting markdown can't express (fonts, colors, alignment, comment highlights) is
 * left out.
 */
import { createText, type PNode } from "./content.js";
import { isBlockStart } from "./markdown.js";

export interface RenderContext {
  /** Citation key of a reference id */
  key(refId: string): string;
  /** Label of a numbered object id; null when there is no such object */
  label(objectId: string): string | null;
}

export function renderBlocks(blocks: PNode[], ctx: RenderContext): string {
  return blocks.map((b) => renderBlock(b, ctx)).join("\n\n");
}

const attrBlock = (parts: (string | false)[]) => {
  const list = parts.filter(Boolean);
  return list.length ? ` {${list.join(" ")}}` : "";
};

const labelPart = (node: PNode) =>
  typeof node.attrs.label === "string" && node.attrs.label && `#${node.attrs.label}`;

export function renderBlock(node: PNode, ctx: RenderContext): string {
  switch (node.type) {
    case "paragraph":
      return escapeLineStart(renderInline(node.content, ctx));
    case "heading":
      return `${"#".repeat(Number(node.attrs.level) || 1)} ${renderInline(node.content, ctx)}${attrBlock(
        [labelPart(node), node.attrs.numbered === false && "-"]
      )}`;
    case "equation": {
      const latex = String(node.attrs.latex ?? "");
      const attrs = attrBlock([labelPart(node), node.attrs.numbered === false && "-"]);
      return latex.includes("\n") ? `$$\n${latex}\n$$${attrs}` : `$$${latex}$$${attrs}`;
    }
    case "figure": {
      if (typeof node.attrs.tikz === "string") return renderTikzFigure(node);
      const src = String(node.attrs.src ?? "");
      const width = Number(node.attrs.width);
      return `![${node.attrs.caption ?? ""}](${/\s/.test(src) ? `<${src}>` : src})${attrBlock([
        labelPart(node),
        width !== 75 && `width=${width}`,
      ])}`;
    }
    case "tableFigure":
      return renderTable(node, ctx);
    case "bulletList":
    case "orderedList":
      return renderList(node, ctx);
    case "blockquote":
      return renderBlocks(node.content, ctx)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "codeBlock": {
      const code = node.content.map((t) => t.text ?? "").join("");
      const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((r) => r.length));
      const fence = "`".repeat(longest + 1);
      return `${fence}${node.attrs.language ?? ""}\n${code}\n${fence}`;
    }
    case "horizontalRule":
      return "---";
    case "appendixBreak":
      return "\\appendix";
    default:
      return `<!-- ${node.type} (not shown) -->`;
  }
}

const listAttr = (name: string, value: unknown) => {
  const list = String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 && `${name}=${list.join(",")}`;
};

/** ```tikz {attributes} with the code, and the caption below */
function renderTikzFigure(node: PNode): string {
  const code = String(node.attrs.tikz);
  const width = Number(node.attrs.width);
  const caption = String(node.attrs.caption ?? "");
  const attrs = attrBlock([
    labelPart(node),
    width > 0 && `width=${width}`,
    listAttr("libraries", node.attrs.tikzLibraries),
    listAttr("packages", node.attrs.tikzPackages),
  ]);
  // longer than any run of backticks in the code
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}tikz${attrs}\n${code}\n${fence}${caption ? `\nFigure: ${caption}` : ""}`;
}

const indent = (text: string, pad: string, firstLine: boolean) =>
  text
    .split("\n")
    .map((line, i) => (line && (i > 0 || firstLine) ? pad + line : line))
    .join("\n");

const isList = (node: PNode | undefined) =>
  node?.type === "bulletList" || node?.type === "orderedList";

function renderList(node: PNode, ctx: RenderContext): string {
  const start = Number(node.attrs.start) || 1;
  // Items with several paragraphs (or other blocks) are separated by blank lines.
  const loose = node.content.some((item) => item.content.slice(1).some((child) => !isList(child)));
  return node.content
    .map((item, i) => {
      const marker = node.type === "orderedList" ? `${start + i}. ` : "- ";
      const pad = " ".repeat(marker.length);
      const first = item.content[0] ? renderBlock(item.content[0], ctx) : "";
      let out = (marker + indent(first, pad, false)).trimEnd();
      for (const child of item.content.slice(1)) {
        out += (isList(child) ? "\n" : "\n\n") + indent(renderBlock(child, ctx), pad, true);
      }
      return out;
    })
    .join(loose ? "\n\n" : "\n");
}

function renderTable(figure: PNode, ctx: RenderContext): string {
  const rows = figure.content[0]?.content ?? [];
  // Merged cells are spread over the grid; the first one gets the content.
  const grid: string[][] = [];
  const aligns: (string | null)[] = [];
  let merged = false;
  rows.forEach((row, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of row.content) {
      while (grid[r][c] !== undefined) c++;
      const colspan = Number(cell.attrs.colspan) || 1;
      const rowspan = Number(cell.attrs.rowspan) || 1;
      if (colspan > 1 || rowspan > 1) merged = true;
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++)
          (grid[r + dr] ??= [])[c + dc] = dr || dc ? "" : cellText(cell, ctx);
      }
      aligns[c] ??= (cell.attrs.align as string | null) ?? null;
      c += colspan;
    }
  });
  const cols = Math.max(1, ...grid.map((r) => r.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: cols }, (_, c) => cells[c] ?? "").join(" | ")} |`;
  const separator = Array.from({ length: cols }, (_, c) =>
    aligns[c] === "center"
      ? ":---:"
      : aligns[c] === "right"
        ? "---:"
        : aligns[c] === "left"
          ? ":---"
          : "---"
  );
  const caption = String(figure.attrs.caption ?? "");
  return [
    `Table:${caption ? ` ${caption}` : ""}${attrBlock([labelPart(figure)])}`,
    "",
    line(grid[0] ?? []),
    `| ${separator.join(" | ")} |`,
    ...grid.slice(1).map(line),
    ...(merged
      ? [
          "<!-- merged cells are shown split; rewriting this table with replace_blocks unmerges them -->",
        ]
      : []),
  ].join("\n");
}

function cellText(cell: PNode, ctx: RenderContext): string {
  return cell.content
    .map((block) =>
      block.type === "paragraph"
        ? renderInline(block.content, ctx, true)
        : renderBlock(block, ctx).replace(/\n/g, " ")
    )
    .filter(Boolean)
    .join("<br>");
}

/** Escapes a paragraph that would otherwise read as another kind of block. */
function escapeLineStart(line: string): string {
  if (!isBlockStart(line)) return line;
  const ordered = /^(\d+)([.)])/.exec(line);
  if (ordered) return `${ordered[1]}\\${ordered[2]}${line.slice(ordered[0].length)}`;
  if (line.startsWith("Table:")) return `Table\\:${line.slice(6)}`;
  if (line.startsWith("Figure:")) return `Figure\\:${line.slice(7)}`;
  return /^[!-/:-@[-`{-~]/.test(line) ? `\\${line}` : line;
}

const WORD = /[\p{L}\p{N}]/u;

function escapeText(s: string, table: boolean): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ("\\*`$[]~".includes(c) || (table && c === "|")) out += `\\${c}`;
    else if (c === "_" && !(WORD.test(s[i - 1] ?? "") && WORD.test(s[i + 1] ?? ""))) out += "\\_";
    else if (c === "<" && /[a-zA-Z/!]/.test(s[i + 1] ?? "")) out += "\\<";
    else if (c === "\n") out += " ";
    else out += c;
  }
  return out;
}

/** Marks written as delimiters, outermost first */
const MARK_ORDER = ["link", "bold", "italic", "strike", "underline", "subscript", "superscript"];
const OPEN: Record<string, string> = {
  link: "[",
  bold: "**",
  italic: "*",
  strike: "~~",
  underline: "<u>",
  subscript: "<sub>",
  superscript: "<sup>",
};
const CLOSE: Record<string, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  underline: "</u>",
  subscript: "</sub>",
  superscript: "</sup>",
};
/** Delimiters that must touch the text (see markdown.ts) */
const FLANKING = new Set(["bold", "italic", "strike"]);

const hrefOf = (node: PNode) => String(node.marks?.link?.href ?? "");

function renderAtom(node: PNode, ctx: RenderContext, table: boolean): string {
  switch (node.type) {
    case "text": {
      const text = node.text ?? "";
      if (!node.marks?.code) return escapeText(text, table);
      const ticks = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length)) + 1);
      const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
      return `${ticks}${pad}${text}${pad}${ticks}`;
    }
    case "mathInline":
      return `$${node.attrs.latex ?? ""}$`;
    case "citation": {
      const keys = String(node.attrs.refs ?? "")
        .split(",")
        .filter(Boolean)
        .map((id) => ctx.key(id))
        .join(",");
      const locator = String(node.attrs.locator ?? "");
      const command = node.attrs.mode === "narrative" ? "citet" : "cite";
      return `\\${command}${locator ? `[${locator}]` : ""}{${keys}}`;
    }
    case "crossRef":
      return `\\ref{${ctx.label(String(node.attrs.target ?? "")) ?? "??"}}`;
    case "hardBreak":
      return "<br>";
    default:
      return "";
  }
}

export function renderInline(nodes: PNode[], ctx: RenderContext, table = false): string {
  // Whitespace at the edges of emphasized text goes outside the delimiters.
  const pieces: PNode[] = [];
  for (const node of nodes) {
    const marks = node.marks ?? {};
    if (node.type !== "text" || marks.code || !Object.keys(marks).some((m) => FLANKING.has(m))) {
      pieces.push(node);
      continue;
    }
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.text ?? "")!;
    const plain = Object.fromEntries(Object.entries(marks).filter(([m]) => !FLANKING.has(m)));
    if (lead) pieces.push(createText(lead, plain));
    if (core) pieces.push(createText(core, marks));
    if (trail) pieces.push(createText(trail, plain));
  }

  let out = "";
  const open: { mark: string; href: string }[] = [];
  const closeTo = (depth: number) => {
    while (open.length > depth) {
      const top = open.pop()!;
      out +=
        top.mark === "link"
          ? `](${top.href.replace(/[\s()]/g, encodeURIComponent)})`
          : CLOSE[top.mark];
    }
  };
  for (const piece of pieces) {
    const marks =
      piece.type === "text" && !piece.marks?.code ? MARK_ORDER.filter((m) => piece.marks?.[m]) : [];
    let common = 0;
    while (
      common < open.length &&
      common < marks.length &&
      open[common].mark === marks[common] &&
      (marks[common] !== "link" || open[common].href === hrefOf(piece))
    ) {
      common++;
    }
    closeTo(common);
    for (const mark of marks.slice(common)) {
      out += OPEN[mark];
      open.push({ mark, href: mark === "link" ? hrefOf(piece) : "" });
    }
    out += renderAtom(piece, ctx, table);
  }
  closeTo(0);
  return out;
}
