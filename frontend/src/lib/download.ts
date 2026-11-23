export function downloadText(fileName: string, text: string, mime = "text/plain"): void {
  downloadBlob(fileName, new Blob([text], { type: `${mime};charset=utf-8` }));
}

export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileName(name: string, fallback = "paper"): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 80);
}
