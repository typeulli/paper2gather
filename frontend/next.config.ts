import os from "node:os";
import type { NextConfig } from "next";

/**
 * Hosts the dev server may be opened from besides localhost: this computer's name and IPv4
 * addresses (LAN, VPN…) plus ALLOWED_DEV_ORIGINS (comma separated, e.g. "*.example.com").
 */
function devOrigins(): string[] {
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
  const extra = (process.env.ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return [os.hostname().toLowerCase(), ...addresses, ...extra];
}

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: devOrigins(),
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // isomorphic-tikzjax (TikZ worker) loads these only under Node.js; keep them out of the browser bundle.
    resolveAlias: {
      jsdom: { browser: "./src/lib/tikz/empty-module.ts" },
      svgo: { browser: "./src/lib/tikz/empty-module.ts" },
    },
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
