import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { DEFAULT_SECTIONS, type Prefab, type SkeletonBlock } from "./prefabs.js";

/**
 * Shared type names inside every paper Y.Doc.
 * Must stay in sync with frontend/src/lib/paper/store.ts
 */
export const FIELDS = {
  content: "content", // Y.XmlFragment bound to the TipTap editor
  meta: "meta", // Y.Map: title, settings...
  // Used by the MCP server:
  authors: "authors", // Y.Array<Author>
  refOrder: "refOrder", // Y.Array<string>: reference ids, order = citation number
  refs: "refs", // Y.Map<Reference>
  comments: "comments", // Y.Map<Y.Map>: thread fields + messages Y.Array<CommentMessage>
  format: "format", // Y.Map: flat dotted keys overriding the default format
} as const;

export type TemplateName = "paper" | "blank";

const shortId = () => randomUUID().replace(/-/g, "").slice(0, 8);

function paragraph(text = ""): Y.XmlElement {
  const p = new Y.XmlElement("paragraph");
  if (text) p.insert(0, [new Y.XmlText(text)]);
  return p;
}

type HeadingAttrs = { level: number; id: string; label: string; numbered: boolean };

function heading(text: string, level: number, numbered = true): Y.XmlElement {
  const id = shortId();
  const h = new Y.XmlElement<HeadingAttrs>("heading");
  h.setAttribute("level", level);
  h.setAttribute("id", id);
  h.setAttribute("label", `sec:${id}`);
  h.setAttribute("numbered", numbered);
  h.insert(0, [new Y.XmlText(text)]);
  // Fragment children are typed with string attributes only; Yjs stores any JSON value.
  return h as unknown as Y.XmlElement;
}

function skeletonBlock(block: SkeletonBlock, title: string): Y.XmlElement {
  switch (block.type) {
    case "heading":
      return heading(block.text, block.level ?? 1, block.numbered ?? true);
    case "title":
      return heading(title, 1, false);
    case "paragraph":
      return paragraph(block.text);
  }
}

/**
 * Builds the initial content directly as Y.XmlElements using the node names of
 * the TipTap schema, so the server does not need to know the ProseMirror schema.
 * A prefab sets the document format and, with the "paper" template, the sections.
 */
export function applyTemplate(doc: Y.Doc, title: string, template: TemplateName, prefab?: Prefab): void {
  doc.transact(() => {
    doc.getMap(FIELDS.meta).set("title", title);
    if (prefab) {
      const format = doc.getMap(FIELDS.format);
      for (const [path, value] of Object.entries(prefab.format)) format.set(path, value);
    }
    const fragment = doc.getXmlFragment(FIELDS.content);
    if (template === "blank") {
      fragment.insert(0, [paragraph()]);
      return;
    }
    fragment.insert(0, (prefab?.sections ?? DEFAULT_SECTIONS).map((block) => skeletonBlock(block, title)));
  });
}
