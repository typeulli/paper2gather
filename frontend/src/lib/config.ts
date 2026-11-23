/** The root server (server.mjs) that serves the app and routes the backend's paths to it */
const SERVER_PORT = 6005;

/**
 * Without NEXT_PUBLIC_API_URL, the backend is expected at the address the page was opened from, so
 * the app also works through a LAN or VPN address or from another computer.
 */
export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window === "undefined" ? `http://localhost:${SERVER_PORT}` : window.location.origin)
).replace(/\/$/, "");

export const COLLAB_URL = (
  process.env.NEXT_PUBLIC_COLLAB_URL ?? `${API_URL.replace(/^http/, "ws")}/collab`
).replace(/\/$/, "");

/** Uploaded files are stored as backend-relative paths so the backend host can change. */
export function resolveAssetUrl(src: string): string {
  return src.startsWith("/uploads/") ? `${API_URL}${src}` : src;
}
