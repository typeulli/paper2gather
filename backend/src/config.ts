import path from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 1234),
  /** Unset = Node default (dual-stack "::"), so both 127.0.0.1 and ::1 work for localhost */
  host: process.env.HOST || undefined,
  dataDir: path.resolve(process.env.DATA_DIR ?? "data"),
  /** Comma separated list of allowed origins, or "*" */
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  /** Debounce before persisting a changed document (ms) */
  saveDebounceMs: Number(process.env.SAVE_DEBOUNCE_MS ?? 1000),
  /** Upper bound for how long a dirty document may stay unsaved (ms) */
  saveMaxWaitMs: Number(process.env.SAVE_MAX_WAIT_MS ?? 5000),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 15 * 1024 * 1024),
};
