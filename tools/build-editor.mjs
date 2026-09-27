// Bundles CodeMirror into vendor/codemirror.js, which is committed so the
// Workbench stays a set of static files: no install, no build, no CDN at
// runtime (and so it keeps working offline and under cross-origin isolation).
//
//   npm install && npm run build:editor

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
  entryPoints: [resolve(root, "tools/editor-entry.js")],
  outfile: resolve(root, "vendor/codemirror.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "none",
  banner: { js: "// CodeMirror 6 (MIT). Bundled by tools/build-editor.mjs — do not edit." },
  metafile: true,
});

const [output] = Object.values(result.metafile.outputs);
console.log(`vendor/codemirror.js — ${(output.bytes / 1024).toFixed(0)} kB`);
