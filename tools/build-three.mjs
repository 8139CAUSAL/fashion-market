// Bundles Three.js (three@0.170.0, pinned in package.json) into
// vendor/three.js for the Market and Store tabs' 3D views
// (js/fashion/three-loader.js loads it only when a 3D view is opened). It
// is committed, so Fashion Market stays a set of static files: no install,
// no build and no CDN at runtime, and it loads under cross-origin isolation
// (COOP/COEP) as a same-origin file.
//
//   npm install && npm run build:three

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(resolve(root, "node_modules/three/package.json"), "utf8")).version;

const result = await build({
  entryPoints: [resolve(root, "tools/three-entry.js")],
  outfile: resolve(root, "vendor/three.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "none",
  banner: { js: `// Three.js ${version} (MIT, https://threejs.org). Bundled by tools/build-three.mjs — do not edit.` },
  metafile: true,
});

const [output] = Object.values(result.metafile.outputs);
console.log(`vendor/three.js (three ${version}) — ${(output.bytes / 1024).toFixed(0)} kB`);
