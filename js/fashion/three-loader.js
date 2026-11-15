// Three.js, only when a 3D view is opened: vendor/three.js (three 0.170.0,
// pinned in package.json and bundled by tools/build-three.mjs) is a
// same-origin static file, so it loads on GitHub Pages and under the
// cross-origin isolation webR needs. Nothing here runs until the 2D/3D
// switch on the Market or Store tab asks for 3D.

let three = null;

// Whether this browser can draw WebGL at all. Without it the 3D switch is
// off and the 2D views carry on as they are.
let support = null;
export function webglSupported() {
  if (support !== null) return support;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    support = !!gl;
    gl?.getExtension?.("WEBGL_lose_context")?.loseContext();
  } catch { support = false; }
  return support;
}

export function loadThree() {
  three ??= import("../../vendor/three.js").catch((err) => { three = null; throw err; });
  return three;
}

// The 3D views' modules, loaded with Three.js.
export async function loadMarket3D() {
  const [THREE, mod] = await Promise.all([loadThree(), import("./market-3d.js")]);
  return { THREE, Market3DView: mod.Market3DView };
}
export async function loadStore3D() {
  const [THREE, mod] = await Promise.all([loadThree(), import("./store-3d.js")]);
  return { THREE, Store3DView: mod.Store3DView };
}
