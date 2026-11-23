import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import { unzipSync } from "fflate";
import katex from "katex";
import * as Y from "yjs";
import { buildPaperSchema } from "@/components/editor/extensions";
import { api, type DocumentMeta } from "@/lib/api";
import { FIELDS } from "@/lib/paper/store";
import { convertHwpx, type HwpxImage } from "./convert";
import { readPackage } from "./package";

export interface HwpxImportResult {
  doc: DocumentMeta;
  /** What could not be carried over exactly, for the user */
  notices: string[];
}

const UPLOADABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

/** The image as an uploadable file; BMP and other formats the browser decodes become PNG. */
async function toUploadable(image: HwpxImage): Promise<File | null> {
  const bytes = new Uint8Array(image.data);
  if (UPLOADABLE.has(image.mediaType)) return new File([bytes], image.name, { type: image.mediaType });
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mediaType }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new File([blob], image.name.replace(/\.\w+$/, ".png"), { type: "image/png" }) : null;
  } catch {
    // WMF/EMF and other vector formats cannot be decoded by browsers.
    return null;
  }
}

/** Uploads the images (a few at a time) and fills in their figures' src; returns the failure count. */
async function uploadImages(images: HwpxImage[]): Promise<number> {
  let failed = 0;
  const queue = [...images];
  const worker = async () => {
    for (let image = queue.shift(); image; image = queue.shift()) {
      const file = await toUploadable(image);
      if (!file) {
        failed++;
        continue;
      }
      try {
        image.node.attrs = { ...image.node.attrs, src: (await api.uploadImage(file)).url };
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, images.length) }, worker));
  return failed;
}

/** Converts an HWPX file into a new paper document. Errors carry user-facing (Korean) messages. */
export async function importHwpx(file: File): Promise<HwpxImportResult> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error("HWPX 파일을 열 수 없습니다. HWP 파일은 한글에서 HWPX로 저장한 뒤 가져와 주세요.");
  }
  const parser = new DOMParser();
  const pkg = readPackage(files, (xml) => parser.parseFromString(xml, "application/xml"));
  const result = convertHwpx(pkg);

  const failedImages = (result.warnings.get("image") ?? 0) + (await uploadImages(result.images));
  const badEquations = result.equations.filter((node) => {
    try {
      katex.renderToString(node.attrs!.latex, { throwOnError: true, displayMode: node.type === "equation" });
      return false;
    } catch {
      return true;
    }
  }).length;

  const schema = buildPaperSchema();
  const content = schema.nodeFromJSON(result.doc);
  content.check();
  const ydoc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(schema, content.toJSON(), ydoc.getXmlFragment(FIELDS.content));
  const title = result.title || file.name.replace(/\.hwpx$/i, "").trim() || "Untitled Paper";
  const doc = await api.importDocument(title, Y.encodeStateAsUpdate(ydoc));
  ydoc.destroy();

  const notices: string[] = [];
  if (failedImages) notices.push(`그림 ${failedImages}개는 변환하지 못해 빈 그림으로 남겼습니다(WMF·EMF 등).`);
  const objects = result.warnings.get("object") ?? 0;
  if (objects) notices.push(`OLE 개체·차트 ${objects}개는 가져오지 않았습니다.`);
  if (badEquations) notices.push(`수식 ${badEquations}개는 변환 결과를 확인해 주세요.`);
  if (result.notes) notices.push(`각주 ${result.notes}개는 문서 끝 '각주' 절로 옮겼습니다.`);
  return { doc, notices };
}
