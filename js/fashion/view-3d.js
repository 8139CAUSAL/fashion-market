// What the two 3D views share (market-3d.js, store-3d.js): a Three.js
// renderer in a canvas-wrap, an angled camera that orbits, pans and zooms
// (OrbitControls) and goes back to where it started, names written over the
// scene, picking under the pointer, and the scene's lifecycle.
//
// It draws only when something changed (a new frame, the camera moved, a
// resize), never while its wrap is hidden (another tab, or the 2D view),
// and never on the simulation's schedule: a frame from R is copied into
// the scene and the page acknowledges it straight away (app.js), so
// rendering can't hold the worker up. Static scenery is built only when
// the installed world changes (a successful Setup); dispose() lets go of
// every geometry, material, texture, listener and the WebGL context.
//
// THREE is passed in (three-loader.js loads it on demand); so is the
// renderer, for the tests, which run the views under node without WebGL.

import { el, cssVar } from "./ui.js";
import { tooltip } from "./charts.js";

const CLICK_PX = 5;          // a press that moves less than this is a click, not a drag

export class View3D {
  constructor(wrap, THREE, { createRenderer, label = "3D view", background = "--surface-2" } = {}) {
    this.wrap = wrap; this.THREE = THREE; this.background = background;
    this.renderer = createRenderer ? createRenderer() : new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio?.(Math.min(2, window.devicePixelRatio || 1));
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute?.("aria-label", label);
    this.canvas.setAttribute?.("tabindex", "0");
    this.labelLayer = el("div", { class: "view3d-labels", "aria-hidden": "true" });
    this.caption = el("div", { class: "view-caption" });
    wrap.append(this.canvas, this.labelLayer, this.caption);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 4 / 3, 1, 1e5);
    this.statics = new THREE.Group(); this.statics.name = "static";
    this.dynamics = new THREE.Group(); this.dynamics.name = "dynamic";
    this.scene.add(this.statics, this.dynamics);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8778, 2.2);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.controls = new THREE.OrbitControls(this.camera, this.canvas);
    Object.assign(this.controls, { enableDamping: false, screenSpacePanning: false, zoomToCursor: true, maxPolarAngle: 1.38, minPolarAngle: 0.05 });
    this.controls.listenToKeyEvents?.(this.canvas);
    this.controls.addEventListener("change", () => { this.cameraChanged(); this.invalidate(); });

    this.raycaster = new THREE.Raycaster();
    this.home = null;                 // where reset() puts the camera
    this.labels = [];                 // { node, X, Y, Z, priority, show(dist) }
    this.active = false; this.visible = false; this.disposed = false;
    this.raf = 0; this.renders = 0; this.staticBuilds = 0;
    this.onLost = null;

    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(wrap);
    this.media = matchMedia("(prefers-color-scheme: dark)");
    this.onThemeChange = () => { this.themeChanged(); this.invalidate(); };
    this.media.addEventListener?.("change", this.onThemeChange);

    // Pointer: a click picks (a drag is the camera's), a hover shows a tooltip.
    this.down = null;
    this.handlers = {
      pointerdown: (ev) => { this.down = { x: ev.clientX, y: ev.clientY, button: ev.button }; },
      pointerup: (ev) => {
        const d = this.down; this.down = null;
        if (!d || d.button !== 0 || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > CLICK_PX) return;
        this.click(ev);
      },
      pointermove: (ev) => { if (!ev.buttons) this.hover(ev); else tooltip.hide(); },
      pointerleave: () => { tooltip.hide(); this.canvas.style.cursor = ""; },
      webglcontextlost: (ev) => { ev.preventDefault?.(); this.onLost?.(); },
    };
    for (const [type, fn] of Object.entries(this.handlers)) this.canvas.addEventListener(type, fn);
  }

  // ---- What subclasses fill in -------------------------------------------------------

  buildStatic() {}            // the scenery, when the installed world (or the theme) changed
  updateDynamic() {}          // the agents, after a frame
  cameraChanged() { this.#clipPlanes(); }
  themeChanged() { this.staticDirty = true; }
  click() {}
  hover() {}

  // ---- Lifecycle -----------------------------------------------------------------------

  // Shown (the 3D view picked, its tab open) or not: hidden, it draws nothing.
  setActive(on) {
    this.active = on;
    if (on) { this.#resize(); this.invalidate(); } else tooltip.hide();
  }

  setCaption(text) { this.caption.textContent = text; this.caption.hidden = !text; }

  // A render on the next animation frame, if it'll be seen.
  invalidate() {
    if (this.raf || !this.active || !this.visible || this.disposed) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  render() {
    if (this.disposed) return;
    if (this.staticDirty) {
      this.staticDirty = false;
      this.scene.background = this.colour(this.background);
      View3D.disposeTree(this.statics);
      this.statics.clear();
      this.labels.forEach((l) => l.node.remove()); this.labels = [];
      this.buildStatic();
      this.staticBuilds++;
      this.dynamicDirty = true;
    }
    if (this.dynamicDirty) { this.dynamicDirty = false; this.updateDynamic(); }
    this.renderer.render(this.scene, this.camera);
    this.renders++;
    this.#placeLabels();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.media.removeEventListener?.("change", this.onThemeChange);
    for (const [type, fn] of Object.entries(this.handlers)) this.canvas.removeEventListener?.(type, fn);
    this.controls.dispose();
    View3D.disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove(); this.labelLayer.remove(); this.caption.remove();
    tooltip.hide();
  }

  // Every geometry, material and texture under `root`.
  static disposeTree(root) {
    root.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [o.material].flat()) { if (!m) continue; m.map?.dispose(); m.dispose(); }
      o.dispose?.();               // an InstancedMesh's own buffers
    });
  }

  #resize() {
    const w = this.wrap.clientWidth; const h = this.wrap.clientHeight;
    this.visible = w > 0 && h > 0;
    if (!this.visible) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  // ---- The camera ------------------------------------------------------------------------

  // Looks at a box of the ground (scene X0..X1, Z0..Z1) from an angle:
  // `azimuth` round from the south (radians, toward the east), `elevation`
  // above the ground. This is the view reset() goes back to.
  frame({ X0, X1, Z0, Z1 }, { azimuth = 0.45, elevation = 0.95, fill = 1.05 } = {}) {
    const THREE = this.THREE;
    const target = new THREE.Vector3((X0 + X1) / 2, 0, (Z0 + Z1) / 2);
    const span = Math.max(X1 - X0, Z1 - Z0);
    const half = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const dist = (fill * span / 2) / Math.tan(half) * Math.max(1, 1 / Math.max(0.5, this.camera.aspect));
    const pos = new THREE.Vector3(
      target.x + dist * Math.cos(elevation) * Math.sin(azimuth),
      dist * Math.sin(elevation),
      target.z + dist * Math.cos(elevation) * Math.cos(azimuth));
    this.home = { target, pos, span };
    this.controls.minDistance = Math.max(0.5, span / 400);
    this.controls.maxDistance = dist * 3;
    this.reset();
  }

  reset() {
    if (!this.home) return;
    this.controls.target.copy(this.home.target);
    this.camera.position.copy(this.home.pos);
    this.camera.lookAt(this.home.target);
    this.controls.update();
    this.cameraChanged();
    this.invalidate();
  }

  get distance() { return this.camera.position.distanceTo(this.controls.target); }

  #clipPlanes() {
    const d = this.distance; const span = this.home?.span ?? d;
    this.camera.near = Math.max(0.05, d / 400);
    this.camera.far = d * 6 + span * 3;
    this.camera.updateProjectionMatrix();
    // The sun follows the view, so shadows of light fall the same way at any scale.
    const t = this.controls.target;
    this.sun.position.set(t.x + d * 0.4, d * 1.2, t.z + d * 0.7);
    this.sun.target.position.copy(t);
  }

  // ---- Under the pointer ---------------------------------------------------------------------

  // The ray through the pointer.
  ray(ev) {
    this.camera.updateMatrixWorld();
    const r = this.canvas.getBoundingClientRect();
    const ndc = new this.THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  // Where the pointer's ray meets the level y (the ground: 0), or null.
  groundAt(ev, y = 0) {
    const ray = this.ray(ev).ray;
    const plane = new this.THREE.Plane(new this.THREE.Vector3(0, 1, 0), -y);
    const hit = new this.THREE.Vector3();
    return ray.intersectPlane(plane, hit) ? hit : null;
  }

  // A scene point on screen: CSS pixels from the canvas's top left, and
  // whether it's in front of the camera and on the canvas.
  toScreen(X, Y, Z) {
    this.camera.updateMatrixWorld();
    const v = new this.THREE.Vector3(X, Y, Z).project(this.camera);
    const w = this.wrap.clientWidth; const h = this.wrap.clientHeight;
    return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, on: v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05 };
  }

  // ---- Names over the scene ------------------------------------------------------------------

  // A name at a scene point. `priority`: higher wins where names overlap;
  // `show(distance)`: whether it's shown with the camera that far away.
  addLabel(text, X, Y, Z, { cls = "", priority = 0, show = null } = {}) {
    const node = el("span", { class: `view3d-label ${cls}`, text });
    this.labelLayer.append(node);
    const label = { node, text, X, Y, Z, priority, show };
    this.labels.push(label);
    return label;
  }

  #placeLabels() {
    const d = this.distance; const placed = [];
    const order = [...this.labels].sort((a, b) => b.priority - a.priority);
    for (const l of order) {
      const s = this.toScreen(l.X, l.Y, l.Z);
      let on = s.on && (!l.show || l.show(d));
      // Names don't overlap: a box per name, as wide as its text.
      const w = 7 * l.text.length + 10; const h = 16;
      if (on && placed.some((b) => Math.abs(b.x - s.x) * 2 < b.w + w && Math.abs(b.y - s.y) * 2 < b.h + h)) on = false;
      l.node.hidden = !on;
      if (!on) continue;
      placed.push({ x: s.x, y: s.y, w, h });
      l.node.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  // ---- Colours -----------------------------------------------------------------------------

  // A CSS colour (a custom property's value, or a colour) as a THREE.Color.
  colour(nameOrValue) {
    const v = nameOrValue.startsWith("--") ? cssVar(nameOrValue, this.wrap) : nameOrValue;
    const [r, g, b] = rgb(v);
    return new this.THREE.Color().setRGB(r / 255, g / 255, b / 255, this.THREE.SRGBColorSpace);
  }
  // Two CSS colours mixed: t of the way from a to b.
  mixColour(a, b, t) { return this.colour(a).lerp(this.colour(b), t); }

  // An instanced mesh of `count` copies (space for `capacity`), each placed by `place(i, matrix)`.
  instanced(geometry, material, count, place, capacity = count) {
    const mesh = new this.THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
    const m = new this.THREE.Matrix4();
    for (let i = 0; i < count; i++) { place(i, m); mesh.setMatrixAt(i, m); }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }
}

// A colour's red, green and blue (0 to 255): #rgb, #rrggbb, rgb() or rgba().
export function rgb(c) {
  c = String(c ?? "").trim();
  if (c.startsWith("rgb")) { const v = c.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [128, 128, 128]; return v; }
  const h = c.replace("#", "");
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(h)) return [128, 128, 128];
  const v = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
}

// A matrix placing an instance: at (X, Y, Z), turned `yaw` about the
// vertical, scaled (sx, sy, sz).
export function placeMatrix(THREE, m, X, Y, Z, yaw = 0, sx = 1, sy = 1, sz = 1) {
  const c = Math.cos(yaw); const s = Math.sin(yaw);
  // Rotation about Y then scale, set directly (no temporaries per instance).
  m.set(c * sx, 0, s * sz, X,
    0, sy, 0, Y,
    -s * sx, 0, c * sz, Z,
    0, 0, 0, 1);
  return m;
}

// ---- Low-poly shapes, shared by the views ----------------------------------------------------
// Each is one geometry (parts merged), so each kind of thing is one draw
// call however many there are, as an InstancedMesh. Sizes are 1 (scaled
// per instance); each stands on y = 0.

// Colours a geometry's vertices (for shapes whose parts differ in colour).
export function paint(THREE, geometry, colour) {
  const c = colour instanceof THREE.Color ? colour : new THREE.Color(colour);
  const n = geometry.attributes.position.count; const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[3 * i] = c.r; a[3 * i + 1] = c.g; a[3 * i + 2] = c.b; }
  geometry.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return geometry;
}

// A car, 1 long along X: a body and a cabin.
export function carGeometry(THREE) {
  const body = new THREE.BoxGeometry(1, 0.3, 0.44).translate(0, 0.23, 0);
  const cabin = new THREE.BoxGeometry(0.52, 0.22, 0.38).translate(-0.06, 0.49, 0);
  return THREE.mergeGeometries([body, cabin]);
}

// A person, 1 tall: a body and a head.
export function personGeometry(THREE) {
  const body = new THREE.CylinderGeometry(0.15, 0.2, 0.64, 8).translate(0, 0.32, 0);
  const head = new THREE.SphereGeometry(0.13, 10, 6).translate(0, 0.8, 0);
  return THREE.mergeGeometries([body, head]);
}

// A member of staff, 1 tall: squarer, so they stand apart from shoppers.
export function staffGeometry(THREE) {
  const body = new THREE.BoxGeometry(0.4, 0.66, 0.3).translate(0, 0.33, 0);
  const head = new THREE.SphereGeometry(0.14, 10, 6).translate(0, 0.82, 0);
  return THREE.mergeGeometries([body, head]);
}

// A house, 1 across and 1 high: walls (white: the instance colour shows)
// under a darker hipped roof.
export function houseGeometry(THREE) {
  const walls = paint(THREE, new THREE.BoxGeometry(1, 0.62, 1).translate(0, 0.31, 0), 0xffffff);
  const roof = paint(THREE, new THREE.ConeGeometry(0.76, 0.38, 4).rotateY(Math.PI / 4).translate(0, 0.62 + 0.19, 0), 0x9a9a9a);
  return THREE.mergeGeometries([walls, roof]);
}

// A tree, about 1.15 high: a trunk and a crown.
export function treeGeometry(THREE, crown, trunk) {
  const t = paint(THREE, new THREE.CylinderGeometry(0.05, 0.07, 0.35, 6).translate(0, 0.175, 0), trunk);
  const c = paint(THREE, new THREE.ConeGeometry(0.3, 0.8, 7).translate(0, 0.75, 0), crown);
  return THREE.mergeGeometries([t, c]);
}

// Flat ribbons on the ground along segments ([X0, Z0, X1, Z1, ...]), `width`
// across, and a square `width` across at each dot ([X, Z, ...]) to join
// them: one geometry for a whole road network.
export function ribbonGeometry(THREE, segs, dots, width) {
  const pos = []; const idx = []; const h = width / 2;
  const quad = (ax, az, bx, bz, cx, cz, dx, dz) => {
    const k = pos.length / 3;
    pos.push(ax, 0, az, bx, 0, bz, cx, 0, cz, dx, 0, dz);
    idx.push(k, k + 2, k + 1, k, k + 3, k + 2);
  };
  for (let i = 0; i < segs.length; i += 4) {
    const [x0, z0, x1, z1] = [segs[i], segs[i + 1], segs[i + 2], segs[i + 3]];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (!len) { quad(x0 - h, z0 - h, x0 + h, z0 - h, x0 + h, z0 + h, x0 - h, z0 + h); continue; }
    const nx = -(z1 - z0) / len * h; const nz = (x1 - x0) / len * h;
    quad(x0 + nx, z0 + nz, x1 + nx, z1 + nz, x1 - nx, z1 - nz, x0 - nx, z0 - nz);
  }
  for (let i = 0; i < dots.length; i += 2) { const x = dots[i]; const z = dots[i + 1]; quad(x - h, z - h, x + h, z - h, x + h, z + h, x - h, z + h); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  // Facing up, whichever way each quad was wound.
  const ix = g.index.array; const p = g.attributes.position.array;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t], ix[t + 1], ix[t + 2]];
    const cross = (p[3 * b] - p[3 * a]) * (p[3 * c + 2] - p[3 * a + 2]) - (p[3 * b + 2] - p[3 * a + 2]) * (p[3 * c] - p[3 * a]);
    if (cross > 0) { ix[t + 1] = c; ix[t + 2] = b; }
  }
  return g;
}

// The ground: a plane `width` by `depth` from the scene's origin (the
// south-west corner) east and north, one texel per tile in the colour
// `colourAt(r, c)` gives (a CSS colour) for the tile in row r (from the
// north edge), column c. Texture row 0 is the plane's south edge, so the
// tile in row r is texture row ny − 1 − r: its texel's middle falls on the
// tile's middle (spatial.js).
export function groundPlane(THREE, nx, ny, width, depth, colourAt) {
  const data = new Uint8Array(nx * ny * 4);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    const [R, G, B] = rgb(colourAt(r, c));
    data.set([R, G, B, 255], ((ny - 1 - r) * nx + c) * 4);
  }
  const tex = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const geom = new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2).translate(width / 2, 0, -depth / 2);
  const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ map: tex }));
  mesh.name = "ground";
  return mesh;
}

// A material for things lying flat on the ground (roads, markings), drawn
// over it without flicker: `level` orders the layers (higher on top).
export function overlayMaterial(THREE, colour, level, lit = true, opacity = 1) {
  const Mat = lit ? THREE.MeshLambertMaterial : THREE.MeshBasicMaterial;
  return new Mat({ color: colour, polygonOffset: true, polygonOffsetFactor: -level, polygonOffsetUnits: -4 * level,
    transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
}
