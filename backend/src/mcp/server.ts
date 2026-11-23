/**
 * MCP server (Streamable HTTP, stateless) at /mcp: lets AI agents read and edit papers. Edits go
 * into the live documents, so everyone editing a paper sees them right away.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import express, { type Router } from "express";
import type * as Y from "yjs";
import { z } from "zod";
import { withDoc } from "../collab.js";
import { config } from "../config.js";
import { getMeta, isValidId, listDocuments, type DocumentMeta } from "../storage.js";
import { applyTemplate } from "../template.js";
import { findPrefab, PREFAB_IDS, PREFABS } from "../prefabs.js";
import { UserError } from "./content.js";
import { Paper, REF_TYPES } from "./paper.js";

export interface McpDeps {
  createDocument: (title: string, buildState: (doc: Y.Doc) => void) => Promise<DocumentMeta>;
}

const INSTRUCTIONS = `Paper2Gather is a real-time collaborative editor for academic papers. Changes made with these tools appear at once for everyone editing the paper.

read_paper shows a paper as Markdown. Each top-level block is preceded by a comment like <!-- #k3x9a-1f · Eq. (2) -->: "#k3x9a-1f" is the block id the editing tools take, the rest is the number the editor shows. Block ids stay valid while a block is edited; read the paper again when one is not found.

Markdown dialect (for reading and writing):
- Headings: #, ##, ### (levels 1-3). "{#sec:intro}" after the title sets its label, "{-}" makes it unnumbered: "# Abstract {-}".
- **bold**, *italic*, ~~strike~~, \`code\`, <u>underline</u>, <sub>…</sub>, <sup>…</sup>, [text](https://…), <br> for a line break.
- Inline math $…$. Display equations: $$…$$ on one or more lines, optionally followed by {#eq:label} or {-} (unnumbered). \\begin{equation}/align/gather and \\label{…} work too.
- Citations: \\cite{key1,key2} or [@key1; @key2] with the citation keys of list_references; add missing references with add_references first. A locator goes in brackets: \\cite[p. 5]{key} or [@key, p. 5]. \\citet{key} is a narrative citation ("Kim (2020) shows") in author-date styles such as APA; numbered styles show it as a number. Citation marks and the reference list follow the paper's citation style.
- Cross references: \\ref{label} (or \\eqref). It shows the full text such as "Eq. (3)", "Fig. 2", "Section 1", so don't write "Eq." or "Figure" before it.
- Figures: ![caption](https://image-url){#fig:label width=60} (width in % of the text width).
- TikZ figures: a \`\`\`tikz code block holding the body of a LaTeX document (e.g. \\begin{tikzpicture}…\\end{tikzpicture}), with optional attributes after \`\`\`tikz such as {#fig:label width=60 libraries=arrows.meta,positioning packages=pgfplots} and an optional caption line "Figure: caption" right below the block. Without width the figure keeps its natural size. Browsers compile it with TikZJax: load TikZ libraries and packages with these attributes (not \\usetikzlibrary or \\usepackage in the code); the packages are pgfplots, tikz-cd, circuitikz, chemfig, tikz-3dplot, tikz-feynhand, amsmath, amssymb and array; text in the drawing must be ASCII or math (no Korean).
- Tables: a pipe table with a header row, with an optional caption line "Table: caption {#tab:label}" right above it.
- Lists (-, 1., nested by indentation), > quotes, \`\`\` code blocks (other than \`\`\`tikz), --- rules.
- \\appendix on its own line starts the appendix: the level-1 headings after it become Appendix A, B, … (only one per paper).
- Headings, equations, figures and tables get labels automatically. Keep the {#label} of a block you rewrite so references to it stay valid.
- Escape a literal * $ [ ] \\ ~ _ with a backslash.

Editing: use edit_text for changes inside a paragraph (it keeps formatting and comment highlights); replace_blocks rewrites whole blocks and drops what Markdown can't express (fonts, colors, alignment, comments); insert_blocks adds new blocks.`;

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/** Mistakes the caller can fix come back as tool errors with a message. */
async function run(fn: () => string | Promise<string>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof UserError) return { ...ok(err.message), isError: true };
    console.error("[mcp] tool failed", err);
    return { ...ok("Internal error."), isError: true };
  }
}

async function paperMeta(paperId: string): Promise<DocumentMeta> {
  const meta = isValidId(paperId) ? await getMeta(paperId) : null;
  if (!meta) throw new UserError(`Paper "${paperId}" not found. Use list_papers.`);
  return meta;
}

async function onPaper<T>(
  paperId: string,
  fn: (paper: Paper, meta: DocumentMeta) => T
): Promise<T> {
  const meta = await paperMeta(paperId);
  return withDoc(paperId, (doc) => fn(new Paper(doc), meta));
}

const paperId = z.string().describe("Paper id (from list_papers)");
const anchor = z
  .string()
  .describe("Block id from read_paper (e.g. #k3x9a-1f) or a label (e.g. sec:intro, eq:loss)");
const author = z
  .string()
  .max(100)
  .optional()
  .describe('Name shown on the comment (default "AI assistant")');
const markdown = z.string().describe("Content in the Markdown dialect of the server instructions");

const referenceFields = {
  key: z
    .string()
    .optional()
    .describe("Citation key used in \\cite{}; generated (e.g. vaswani2017attention) if omitted"),
  type: z.enum(REF_TYPES).optional().describe("Default article"),
  title: z.string().optional(),
  authors: z.array(z.string()).optional().describe('"First Last" or "Last, First"'),
  year: z.string().optional(),
  venue: z.string().optional().describe("Journal, conference (booktitle) or school/institution"),
  volume: z.string().optional(),
  issue: z.string().optional(),
  pages: z.string().optional(),
  publisher: z.string().optional(),
  month: z.string().optional().describe('Month of publication: 1–12 or a name such as "Apr"'),
  editors: z.array(z.string()).optional().describe("Editors of the book or proceedings"),
  address: z.string().optional().describe("Place of the publisher, or where the conference was held"),
  edition: z.string().optional().describe('Edition number such as "2"'),
  series: z.string().optional().describe("Series of a proceedings or chapter (e.g. LNCS) — a book's series goes in venue"),
  accessed: z.string().optional().describe("YYYY-MM-DD: when an online source (misc) was accessed"),
  doi: z.string().optional(),
  url: z.string().optional(),
  note: z.string().optional(),
};

function createServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "paper2gather", version: "0.1.0" },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool(
    "list_papers",
    {
      title: "List papers",
      description: "Lists all papers, most recently changed first.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const docs = await listDocuments();
        return docs.length
          ? docs.map((d) => `${d.id} · ${d.title} · updated ${d.updatedAt}`).join("\n")
          : "No papers yet.";
      })
  );

  server.registerTool(
    "create_paper",
    {
      title: "Create a paper",
      description:
        "Creates a paper. Without markdown it gets the standard sections (Abstract, Introduction, …, Conclusion) " +
        'with empty paragraphs, or a single empty paragraph with template "blank". ' +
        "A prefab sets the document format (page, fonts, captions, heading numbers) and the standard sections of " +
        `that kind of paper: ${PREFABS.map((p) => `${p.id} (${p.label})`).join(", ")}.`,
      inputSchema: {
        title: z.string().min(1).max(300),
        template: z.enum(["paper", "blank"]).optional(),
        prefab: z.enum(PREFAB_IDS).optional().describe("Format of a venue; default: the editor's own format"),
        markdown: markdown.optional().describe("Initial content (replaces the template)"),
      },
    },
    ({ title, template, prefab, markdown: content }) =>
      run(async () => {
        let notes = "";
        const meta = await deps.createDocument(title.trim(), (doc) => {
          applyTemplate(doc, title.trim(), content ? "blank" : (template ?? "paper"), findPrefab(prefab));
          if (content) notes = new Paper(doc).insert(content, "end");
        });
        return `Created paper ${meta.id} "${meta.title}".${notes ? `\n${notes}` : ""}`;
      })
  );

  server.registerTool(
    "read_paper",
    {
      title: "Read a paper",
      description:
        "Returns the paper (title, authors, content) as Markdown with block ids and numbers. " +
        "Use outline for a list of the sections, equations, figures and tables of a long paper, and section to read one section.",
      inputSchema: {
        paper_id: paperId,
        section: anchor.optional().describe("Only this section: a heading's block id or label"),
        outline: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ paper_id, section, outline }) =>
      run(() => onPaper(paper_id, (paper, meta) => paper.read(meta, { section, outline })))
  );

  server.registerTool(
    "insert_blocks",
    {
      title: "Insert blocks",
      description:
        "Inserts Markdown content as new blocks. position: start/end of the paper (end is inside the appendix if there " +
        "is one), before/after the anchor block, or end_of_section (the anchor heading's section, before its next " +
        "heading of the same or a higher level; empty paragraphs that are all the section holds are replaced).",
      inputSchema: {
        paper_id: paperId,
        markdown,
        position: z.enum(["end", "start", "before", "after", "end_of_section"]).default("end"),
        anchor: anchor.optional().describe("Required for before, after and end_of_section"),
      },
    },
    ({ paper_id, markdown: content, position, anchor: at }) =>
      run(() => onPaper(paper_id, (paper) => paper.insert(content, position, at)))
  );

  server.registerTool(
    "replace_blocks",
    {
      title: "Replace blocks",
      description:
        "Replaces the blocks from `from` to `to` (inclusive; default just `from`) with Markdown content. " +
        "Objects keep their identity (and the references to them) when the new content uses the same {#label}.",
      inputSchema: { paper_id: paperId, from: anchor, to: anchor.optional(), markdown },
      annotations: { destructiveHint: true },
    },
    ({ paper_id, from, to, markdown: content }) =>
      run(() => onPaper(paper_id, (paper) => paper.replace(from, to, content)))
  );

  server.registerTool(
    "delete_blocks",
    {
      title: "Delete blocks",
      description: "Deletes the blocks from `from` to `to` (inclusive; default just `from`).",
      inputSchema: { paper_id: paperId, from: anchor, to: anchor.optional() },
      annotations: { destructiveHint: true },
    },
    ({ paper_id, from, to }) => run(() => onPaper(paper_id, (paper) => paper.remove(from, to)))
  );

  server.registerTool(
    "edit_text",
    {
      title: "Edit text",
      description:
        "Finds plain text (as it reads in the paper, without Markdown) and replaces it, keeping the formatting " +
        "around it. The replacement may use inline Markdown: marks, $math$, \\cite{}, \\ref{}. The text must occur " +
        "once (in the block, if given) unless all is true.",
      inputSchema: {
        paper_id: paperId,
        find: z.string().min(1),
        replace: z.string(),
        block: anchor.optional().describe("Search only this block"),
        all: z.boolean().optional().describe("Replace every occurrence"),
      },
    },
    ({ paper_id, find, replace, block, all }) =>
      run(() => onPaper(paper_id, (paper) => paper.editText(find, replace, block, all)))
  );

  server.registerTool(
    "update_paper_info",
    {
      title: "Set title and authors",
      description: "Sets the paper title and/or replaces the author list.",
      inputSchema: {
        paper_id: paperId,
        title: z.string().max(300).optional(),
        authors: z
          .array(
            z.object({
              name: z.string().min(1),
              affiliation: z.string().optional(),
              email: z.string().optional(),
            })
          )
          .optional(),
      },
    },
    ({ paper_id, title, authors }) =>
      run(() => onPaper(paper_id, (paper) => paper.setInfo(title, authors)))
  );

  server.registerTool(
    "list_references",
    {
      title: "List references",
      description:
        "Lists the bibliography in citation-number order, with citation keys and how often each is cited.",
      inputSchema: { paper_id: paperId },
      annotations: { readOnlyHint: true },
    },
    ({ paper_id }) => run(() => onPaper(paper_id, (paper) => paper.listReferences()))
  );

  server.registerTool(
    "add_references",
    {
      title: "Add references",
      description: "Adds bibliography entries; returns their citation keys for \\cite{}.",
      inputSchema: {
        paper_id: paperId,
        references: z.array(z.object({ ...referenceFields, title: z.string().min(1) })).min(1),
      },
    },
    ({ paper_id, references }) =>
      run(() => onPaper(paper_id, (paper) => paper.addReferences(references)))
  );

  server.registerTool(
    "update_reference",
    {
      title: "Update a reference",
      description:
        "Changes fields of a bibliography entry (a new key renames it; citations follow).",
      inputSchema: {
        paper_id: paperId,
        key: z.string().describe("Current citation key"),
        changes: z.object(referenceFields),
      },
    },
    ({ paper_id, key, changes }) =>
      run(() => onPaper(paper_id, (paper) => paper.updateReference(key, changes)))
  );

  server.registerTool(
    "delete_reference",
    {
      title: "Delete a reference",
      description: 'Removes a bibliography entry. Citations of it remain and show "?".',
      inputSchema: { paper_id: paperId, key: z.string() },
      annotations: { destructiveHint: true },
    },
    ({ paper_id, key }) => run(() => onPaper(paper_id, (paper) => paper.deleteReference(key)))
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description:
        "Lists comment threads with the quoted text, the block they are on and their messages.",
      inputSchema: { paper_id: paperId, include_resolved: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ paper_id, include_resolved }) =>
      run(() => onPaper(paper_id, (paper) => paper.listComments(include_resolved ?? false)))
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add a comment",
      description:
        "Starts a comment thread on a piece of text (plain text as it reads in the paper; it must occur once, in the block if given).",
      inputSchema: {
        paper_id: paperId,
        quote: z.string().min(1),
        text: z.string().min(1),
        block: anchor.optional(),
        author,
      },
    },
    ({ paper_id, quote, text, block, author: name }) =>
      run(() =>
        onPaper(paper_id, (paper) =>
          paper.addComment(quote, text, name?.trim() || "AI assistant", block)
        )
      )
  );

  server.registerTool(
    "reply_comment",
    {
      title: "Reply to a comment",
      description: "Adds a reply to a comment thread.",
      inputSchema: { paper_id: paperId, thread_id: z.string(), text: z.string().min(1), author },
    },
    ({ paper_id, thread_id, text, author: name }) =>
      run(() =>
        onPaper(paper_id, (paper) => paper.reply(thread_id, text, name?.trim() || "AI assistant"))
      )
  );

  server.registerTool(
    "resolve_comment",
    {
      title: "Resolve a comment",
      description: "Marks a comment thread resolved (or open again with resolved: false).",
      inputSchema: { paper_id: paperId, thread_id: z.string(), resolved: z.boolean().optional() },
    },
    ({ paper_id, thread_id, resolved }) =>
      run(() => onPaper(paper_id, (paper) => paper.setResolved(thread_id, resolved ?? true)))
  );

  return server;
}

/** POST /mcp; every request gets its own server and transport (no sessions). */
export function mcpRouter(deps: McpDeps): Router {
  const router = express.Router();
  router.post("/", express.json({ limit: config.maxUploadBytes }), (req, res, next) => {
    const server = createServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res, req.body))
      .catch(next);
  });
  router.all("/", (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });
  return router;
}
