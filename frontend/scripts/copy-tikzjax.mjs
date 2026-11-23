// Copies the TeX engine files and fonts of isomorphic-tikzjax to public/tikzjax, where the TikZ
// worker (src/lib/tikz) and the TikZ figures load them from. Runs after npm install.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "node_modules", "isomorphic-tikzjax");
const out = join(root, "public", "tikzjax");

if (!existsSync(pkg)) {
  console.warn("[copy-tikzjax] isomorphic-tikzjax is not installed; TikZ figures won't render.");
  process.exit(0);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of ["core.dump.gz", "tex.wasm.gz", "tex_files.tar.gz"]) {
  cpSync(join(pkg, "tex", file), join(out, file));
}
// fonts.css refers to the fonts as bakoma/ttf/*.ttf
cpSync(join(pkg, "css", "fonts.css"), join(out, "fonts.css"));
cpSync(join(pkg, "css", "bakoma"), join(out, "bakoma"), { recursive: true });
