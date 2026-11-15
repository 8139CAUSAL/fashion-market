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
//
// Camera actions (presets, Focus, the compass, Reset) move the camera to a
// pose the view works out from what is installed or selected: Market and
// Store say where (presetTarget(), focusTarget()), this layer says how. A
// pose is OrbitControls' own: the point looked at (target), and the
// camera's distance, polar angle (from straight above) and azimuth (round
// from the south, toward the east) about it. A move eases the target and
// those three from where the camera is to the pose over ~700 ms, drawn on
// demand: a frame is asked for only while a move runs, none once it ends,
// the view is hidden or disposed. Grabbing the camera (pointer, wheel,
// keys) stops a move where it is; another action replaces it. A target
// that can't be computed is either unavailable ({ ok: false, reason }: the
// action says why and the camera stays) or a defect (CameraTargetError,
// thrown before the camera is touched, so it keeps its last valid pose).

import { el, cssVar } from "./ui.js";
import { tooltip } from "./charts.js";

const CLICK_PX = 5;          // a press that moves less than this is a click, not a drag
export const TRANSITION_MS = 700;
const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
// Following: a step this long (metres) between two frames gives a heading;
// a turn of more than TURN_EASE radians is eased over TURN_MS.
const MIN_STEP_M = 0.05;
const TURN_EASE = 0.35; const TURN_MS = 350;
// The follow perspectives. Orbit's distance and height are the pose
// following starts with (the view's own); Chase sits low and close behind,
// Front a little farther ahead.
export const FOLLOW_PERSPECTIVES = {
  orbit: { label: "Orbit" },
  chase: { label: "Chase", distance: 2.6, polar: 1.32 },
  front: { label: "Front", distance: 3.0, polar: 1.28 },
};

// Slow in, slow out.
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// A camera target that is wrong, not merely missing: bad numbers, data
// that contradicts itself. `context` carries what was being computed.
export class CameraTargetError extends Error {
  constructor(message, context = {}) { super(message); this.name = "CameraTargetError"; this.context = context; }
}
// What presetTarget() and focusTarget() give when there's nothing to aim at
// (a legitimate state: nothing selected yet), and when the data is wrong.
export const unavailable = (reason) => ({ ok: false, reason });
export const defect = (reason, context = {}) => ({ ok: false, defect: true, reason, context });

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
    // The compass: where north is on screen; a click turns the view to face it.
    this.needle = el("span", { class: "needle", "aria-hidden": "true" }, el("b", { text: "N" }));
    this.compass = el("button", { type: "button", class: "view3d-compass", hidden: true, title: "North (−Z on the map): click to turn the view to face north",
      "aria-label": "Turn the view to face north" }, this.needle);
    this.compass.addEventListener("click", () => this.runAction(() => this.faceNorth()));
    // While the camera follows someone: who, over the view.
    this.trackBadge = el("div", { class: "view3d-tracking", role: "status", hidden: true });
    wrap.append(this.canvas, this.labelLayer, this.caption, this.compass, this.trackBadge);

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
    // Keys: heard before the controls act on them, so a key that turns or
    // moves the camera stops a move and counts as moving it by hand.
    this.onKeyDown = (ev) => this.keyDown(ev);
    this.canvas.addEventListener("keydown", this.onKeyDown);
    this.controls.listenToKeyEvents?.(this.canvas);
    this.controls.addEventListener("change", () => {
      this.cameraChanged();
      if (!this.stepping) this.invalidate();
      if ((this.driving || this.keyDriving) && !this.applying) { this.#wantFromUser(); this.movedByHand(); }
    });
    // A drag, a pinch or the wheel: the user has the camera.
    this.controls.addEventListener("start", () => { this.driving = true; this.cancelTransition(); });
    this.controls.addEventListener("end", () => { this.driving = false; });

    this.raycaster = new THREE.Raycaster();
    this.home = null;                 // where reset() puts the camera
    this.labels = [];                 // { node, X, Y, Z, priority, show(dist) }
    this.active = false; this.visible = false; this.disposed = false;
    this.raf = 0; this.renders = 0; this.staticBuilds = 0;
    this.onLost = null;
    // The camera's moves: the one running, and what the camera shows now.
    this.clock = () => performance.now();
    this.transition = null;
    this.driving = false; this.keyDriving = false; this.stepping = false; this.applying = 0;
    this.cameraState = { mode: "overview", label: "Overview", note: "" };
    // Following someone: { id, label, point } (the scene point the camera
    // keeps its offset from), and whether panning was on before.
    this.tracking = null; this.panBefore = true; this.zoomToCursorBefore = true;
    this.onTrackingStop = null;       // ({ id, label, reason, error }) => …, when following ends
    this.onCameraState = null;        // (state) => …, when what the camera shows changes
    this.onCameraError = null;        // (error) => …, a camera action that went wrong

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
  cameraChanged() { this.#clipPlanes(); this.#pointCompass(); }
  themeChanged() { this.staticDirty = true; }
  click() {}
  hover() {}
  // Where a camera action aims: { ok: true, pose, label, note } or
  // unavailable(reason) / defect(reason). Subclasses add their presets.
  presetTarget(name) {
    if (name !== "overview") return defect(`There is no camera preset called "${name}" in this view`, { name });
    return this.home ? { ok: true, pose: this.home.pose, label: "Overview" } : unavailable("Nothing is installed to look at yet.");
  }
  // What Focus frames for a selection: { ok: true, point: {X, Y, Z}, distance | box, label }.
  focusTarget() { return unavailable("Nothing is selected to focus on."); }

  // ---- Lifecycle -----------------------------------------------------------------------

  // Shown (the 3D view picked, its tab open) or not: hidden, it draws
  // nothing, and a move under way ends where it was going.
  setActive(on) {
    this.active = on;
    if (on) { this.#resize(); this.invalidate(); } else {
      this.stopTracking("Stopped following: the 3D view was closed.");
      this.#finishTransition(); tooltip.hide();
    }
  }

  setCaption(text) { this.caption.textContent = text; this.caption.hidden = !text; }

  // A render on the next animation frame, if it'll be seen; while the
  // camera is moving, the move's next step first, and then another frame.
  invalidate() {
    if (this.raf || !this.active || !this.visible || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.active || !this.visible || this.disposed) return;     // hidden since it was asked for
      if (this.transition) this.#step();
      this.render();
      if (this.transition) this.invalidate();
    });
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
    this.raf = 0; this.transition = null;
    this.stopTracking("Stopped following: the 3D view was closed.");
    this.resizeObserver.disconnect();
    this.media.removeEventListener?.("change", this.onThemeChange);
    for (const [type, fn] of Object.entries(this.handlers)) this.canvas.removeEventListener?.(type, fn);
    this.canvas.removeEventListener?.("keydown", this.onKeyDown);
    this.controls.dispose();
    View3D.disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove(); this.labelLayer.remove(); this.caption.remove(); this.compass.remove(); this.trackBadge.remove();
    this.onCameraState = null; this.onCameraError = null; this.onTrackingStop = null;
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
  // above the ground. This is the view reset() goes back to: the Overview.
  frame(box, { azimuth = 0.45, elevation = 0.95, fill = 1.05 } = {}) {
    const THREE = this.THREE;
    // The distance as the 3D views have always opened (the box's span at the field of view).
    const pose = { target: { X: (box.X0 + box.X1) / 2, Y: 0, Z: (box.Z0 + box.Z1) / 2 },
      distance: this.fitDistance(Math.max(box.X1 - box.X0, box.Z1 - box.Z0), fill), polar: Math.PI / 2 - elevation, azimuth };
    this.checkPose(pose, "Overview");
    const t = pose.target;
    const target = new THREE.Vector3(t.X, t.Y, t.Z);
    const pos = target.clone().add(new THREE.Vector3().setFromSphericalCoords(pose.distance, pose.polar, pose.azimuth));
    const span = Math.max(box.X1 - box.X0, box.Z1 - box.Z0);
    this.home = { target, pos, span, pose };
    this.controls.minDistance = Math.max(0.5, span / 400);
    this.controls.maxDistance = pose.distance * 3;
    this.compass.hidden = false;
    this.reset();
  }

  // Straight back to the Overview, with no move (a new world or floor).
  reset() {
    if (!this.home) return;
    this.stopTracking("Stopped following: the scene changed.");
    this.transition = null;
    this.#apply(this.home.pose);
    this.setCameraState({ mode: "overview", label: "Overview", note: "" });
    this.invalidate();
  }

  get distance() { return this.camera.position.distanceTo(this.controls.target); }

  // ---- Camera poses and moves ------------------------------------------------------------------

  // Where the camera is, as a pose.
  currentPose() {
    const t = this.controls.target; const o = this.camera.position.clone().sub(t);
    // As THREE.Spherical reads an offset (that class isn't in the vendored bundle).
    const r = o.length();
    return { target: { X: t.x, Y: t.y, Z: t.z }, distance: r, polar: r ? Math.acos(Math.min(1, Math.max(-1, o.y / r))) : 0, azimuth: r ? Math.atan2(o.x, o.z) : 0 };
  }

  // How far away the camera must be to show a box of the ground `span`
  // across from an angle, filling the canvas by `fill` (as frame() always has).
  fitDistance(span, fill = 1.05) {
    const half = this.THREE.MathUtils.degToRad(this.camera.fov / 2);
    return (fill * span / 2) / Math.tan(half) * Math.max(1, 1 / Math.max(0.5, this.camera.aspect));
  }

  // A pose looking at a box of the ground from a direction (azimuth, and
  // elevation or polar): its middle, from the nearest distance that puts
  // all four corners on the canvas, `fill` the margin. At least `minSpan`
  // across (a box of a few cells isn't filled to the edges).
  poseForBox({ X0, X1, Z0, Z1 }, { azimuth = 0.45, elevation = 0.95, polar, fill = 1.05, Y = 0, minSpan = 0 } = {}) {
    const grow = Math.max(0, minSpan - (X1 - X0)) / 2; const growZ = Math.max(0, minSpan - (Z1 - Z0)) / 2;
    const box = { X0: X0 - grow, X1: X1 + grow, Z0: Z0 - growZ, Z1: Z1 + growZ };
    const target = { X: (box.X0 + box.X1) / 2, Y, Z: (box.Z0 + box.Z1) / 2 };
    const p = polar ?? Math.PI / 2 - elevation;
    const corners = [[box.X0, box.Z0], [box.X1, box.Z0], [box.X0, box.Z1], [box.X1, box.Z1]].map(([X, Z]) => ({ X, Y: 0, Z }));
    return { target, distance: this.distanceToShow(corners, target, p, azimuth, fill), polar: p, azimuth };
  }

  // A pose looking down on a box from as near overhead as the controls
  // allow, north at the top: the whole box on the canvas, whatever its shape.
  poseOverhead(box, { fill = 1.06 } = {}) {
    return this.poseForBox(box, { polar: this.controls.minPolarAngle, azimuth: 0, fill });
  }

  // The nearest distance from `target`, looking from (polar, azimuth), at
  // which every point is on the canvas with `fill` to spare: for each point,
  // its depth in front of the camera must cover its offset across and up
  // the screen at the camera's field of view (and so its aspect).
  distanceToShow(points, target, polar, azimuth, fill = 1.05) {
    const u = { x: Math.sin(polar) * Math.sin(azimuth), y: Math.cos(polar), z: Math.sin(polar) * Math.cos(azimuth) };    // target → camera
    const right = { x: Math.cos(azimuth), y: 0, z: -Math.sin(azimuth) };                                              // up × u, normalised
    const up = { x: -Math.cos(polar) * Math.sin(azimuth), y: Math.sin(polar), z: -Math.cos(polar) * Math.cos(azimuth) }; // u × right
    const tanV = Math.tan(this.THREE.MathUtils.degToRad(this.camera.fov / 2)) / fill;
    const tanH = tanV * Math.max(0.1, this.camera.aspect);
    let d = 0;
    for (const P of points) {
      const q = { x: P.X - target.X, y: P.Y - target.Y, z: P.Z - target.Z };
      const dot = (a) => a.x * q.x + a.y * q.y + a.z * q.z;
      d = Math.max(d, dot(u) + Math.abs(dot(right)) / tanH, dot(u) + Math.abs(dot(up)) / tanV);
    }
    return d;
  }

  // A pose must be numbers, and a real distance away. A defect if not.
  checkPose(pose, what = "camera action") {
    const bad = [];
    for (const k of ["X", "Y", "Z"]) if (!Number.isFinite(pose?.target?.[k])) bad.push(`target ${k} = ${pose?.target?.[k]}`);
    for (const k of ["distance", "polar", "azimuth"]) if (!Number.isFinite(pose?.[k])) bad.push(`${k} = ${pose?.[k]}`);
    if (Number.isFinite(pose?.distance) && pose.distance <= 0) bad.push(`distance = ${pose.distance} (not in front of the target)`);
    if (bad.length) throw new CameraTargetError(`${what}: the camera target isn't a valid pose (${bad.join(", ")})`, { what, pose });
  }

  // The pose within the controls' limits: no nearer or farther than they
  // allow, no lower or more overhead.
  constrain(pose) {
    const c = this.controls; const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    return { target: { ...pose.target }, distance: clamp(pose.distance, c.minDistance, c.maxDistance), polar: clamp(pose.polar, c.minPolarAngle, c.maxPolarAngle), azimuth: pose.azimuth };
  }

  // Moves the camera to `pose`, easing there over `duration` ms (at once
  // while the view isn't shown). Checked first: an invalid pose throws and
  // the camera stays as it was. Replaces a move under way, and ends
  // following someone unless `keepTracking` (the compass's turn).
  animateTo(pose, { mode = "manual", label = "", note = "", duration = TRANSITION_MS, keepTracking = false } = {}) {
    this.checkPose(pose, label || mode);
    const to = this.constrain(pose);
    if (!keepTracking) this.stopTracking("");
    this.transition = null;
    this.setCameraState({ mode, label, note });
    if (!this.active || !this.visible || this.disposed || duration <= 0) { this.#apply(to); this.invalidate(); return; }
    this.transition = { from: this.currentPose(), to, t0: this.clock(), duration };
    this.invalidate();
  }

  // Stops a move where it is.
  cancelTransition() { this.transition = null; }

  // A step between two poses: the target and the distance (by ratio, so a
  // long zoom is even), the polar angle and the azimuth (the short way round).
  static lerpPose(a, b, t) {
    const L = (x, y) => x + (y - x) * t;
    const dAz = Math.atan2(Math.sin(b.azimuth - a.azimuth), Math.cos(b.azimuth - a.azimuth));
    return { target: { X: L(a.target.X, b.target.X), Y: L(a.target.Y, b.target.Y), Z: L(a.target.Z, b.target.Z) },
      distance: a.distance * (b.distance / a.distance) ** t, polar: L(a.polar, b.polar), azimuth: a.azimuth + dAz * t };
  }

  #step() {
    const tr = this.transition;
    const t = Math.min(1, Math.max(0, (this.clock() - tr.t0) / tr.duration));
    this.stepping = true;
    try { this.#apply(t >= 1 ? tr.to : View3D.lerpPose(tr.from, tr.to, easeInOut(t))); } finally { this.stepping = false; }
    if (t >= 1) this.transition = null;
  }

  #finishTransition() {
    const tr = this.transition; if (!tr) return;
    this.transition = null;
    this.#apply(tr.to);
  }

  // Puts the camera at a pose now: the controls hold it to their limits.
  #apply(pose) {
    const t = pose.target;
    this.controls.target.set(t.X, t.Y, t.Z);
    const off = new this.THREE.Vector3().setFromSphericalCoords(pose.distance, pose.polar, pose.azimuth);
    this.camera.position.set(t.X + off.x, t.Y + off.y, t.Z + off.z);
    this.camera.lookAt(this.controls.target);
    this.applying++;
    try { this.controls.update(); } finally { this.applying--; }
    this.cameraChanged();
  }

  // ---- Following someone ---------------------------------------------------------------------------
  //
  // The camera moves round a point (`pose`, about `point`) and from then on
  // keeps its offset from that point as the view reports where the one
  // followed is now (updateTracking(), from each frame: their actual
  // position, nothing interpolated or guessed). The user can still turn and
  // zoom round them; panning is off, and so is zooming toward the pointer
  // (it would move the target off them): both back as they were when
  // following ends.
  //
  // Three perspectives on the one followed, switched without changing who:
  // Orbit (the start: the camera keeps its offset, turned as the user
  // likes), Chase (behind them, low and close, facing the way they go) and
  // Front (ahead of them, looking back). Which way they go is read from
  // their position in one frame and the next: a step of at least
  // MIN_STEP_M sets it, a smaller one (or none) keeps the last, and until
  // they have stepped there is none, so Chase and Front wait, the camera
  // following as in Orbit, and say so. In Chase and Front the user can tilt
  // and zoom (kept from frame to frame); the heading is theirs. clearPose()
  // keeps those two cameras out of solid fixtures; what stands between the
  // camera and the one followed is left in view.

  startTracking({ id, label, point, pose }) {
    this.checkPoint(point, `following ${label}`);
    this.checkPose(pose, `following ${label}`);
    if (!this.tracking) { this.panBefore = this.controls.enablePan; this.zoomToCursorBefore = this.controls.zoomToCursor; }
    else this.tracking = null;               // someone else: the camera turns to them
    this.animateTo(pose, { mode: "follow", label: `Following ${label}`, note: "" });
    this.tracking = { id, label, point: { ...point }, perspective: "orbit", heading: null,
      orbit: { distance: pose.distance, polar: pose.polar }, want: null, applied: null, cleared: null };
    this.controls.enablePan = false; this.controls.zoomToCursor = false;
    this.#trackingShown();
  }

  // Where the one followed is now: the camera keeps its offset from them
  // (and a move under way to them ends on where they are now); in Chase or
  // Front, once they have a heading, it takes its place behind or ahead.
  updateTracking(point) {
    const tr = this.tracking; if (!tr) return;
    this.checkPoint(point, `following ${tr.label}`);
    const dX = point.X - tr.point.X; const dY = point.Y - tr.point.Y; const dZ = point.Z - tr.point.Z;
    tr.point = { ...point };
    const step = Math.hypot(dX, dZ);
    const hadHeading = !!tr.heading;
    if (step >= MIN_STEP_M) tr.heading = { X: dX / step, Z: dZ / step };
    if (tr.perspective !== "orbit" && tr.heading) {
      if (!hadHeading) this.#trackingShown();
      this.#placePerspective();
      return;
    }
    if (!dX && !dY && !dZ) return;
    if (this.transition) {
      const t = this.transition.to.target;
      this.transition.to = { ...this.transition.to, target: { X: t.X + dX, Y: t.Y + dY, Z: t.Z + dZ } };
      return;
    }
    this.controls.target.set(this.controls.target.x + dX, this.controls.target.y + dY, this.controls.target.z + dZ);
    this.camera.position.set(this.camera.position.x + dX, this.camera.position.y + dY, this.camera.position.z + dZ);
    this.applying++;
    try { this.controls.update(); } finally { this.applying--; }
    this.cameraChanged();
    this.invalidate();
  }

  // Orbit, Chase or Front, for the one followed now (the same one).
  setFollowPerspective(name) {
    const tr = this.tracking;
    if (!tr) return unavailable("Follow a shopper first: the perspectives are on the one followed.");
    if (!FOLLOW_PERSPECTIVES[name]) throw new CameraTargetError(`There is no follow perspective called "${name}"`, { name });
    if (name === tr.perspective) return { ok: true };
    tr.perspective = name;
    if (name === "orbit") {
      // Back to Orbit as it starts: its own distance and height, from where the camera is now.
      this.#moveTo(this.constrain({ target: { ...tr.point }, distance: tr.orbit.distance, polar: tr.orbit.polar, azimuth: this.currentPose().azimuth }), TRANSITION_MS);
    } else {
      const P = FOLLOW_PERSPECTIVES[name];
      tr.want = { distance: P.distance, polar: P.polar };
      if (tr.heading) this.#placePerspective(true);
    }
    this.#trackingShown();
    return { ok: true };
  }

  // The Chase or Front pose for where they are and the way they go: the
  // camera behind them (Chase) or ahead of them looking back (Front), at the
  // distance and height wanted, then kept out of solid fixtures.
  perspectivePose() {
    const tr = this.tracking; const h = tr.heading;
    const azimuth = tr.perspective === "chase" ? Math.atan2(-h.X, -h.Z) : Math.atan2(h.X, h.Z);
    const pose = this.constrain({ target: { ...tr.point }, distance: tr.want.distance, polar: tr.want.polar, azimuth });
    const r = this.clearPose(pose);
    tr.cleared = r.cleared;
    return r.pose;
  }

  // Where a camera at `pose` would stand clear of solid fixtures: the view's
  // own geometry says (Store3DView); { pose, cleared: null | "pulled in" | "raised" }.
  clearPose(pose) { return { pose, cleared: null }; }

  #placePerspective(ease = false) {
    const pose = this.perspectivePose();
    this.tracking.applied = { distance: pose.distance, polar: pose.polar };
    if (this.transition) { this.transition.to = pose; return; }
    const cur = this.currentPose();
    const turn = Math.abs(Math.atan2(Math.sin(pose.azimuth - cur.azimuth), Math.cos(pose.azimuth - cur.azimuth)));
    if (ease || turn > TURN_EASE) { this.#moveTo(pose, ease ? TRANSITION_MS : TURN_MS); return; }
    this.#apply(pose);
    this.invalidate();
  }

  // A move that keeps following (it doesn't change what the camera shows).
  #moveTo(pose, duration) {
    this.checkPose(pose, "following");
    if (!this.active || !this.visible || this.disposed) { this.transition = null; this.#apply(pose); return; }
    this.transition = { from: this.currentPose(), to: pose, t0: this.clock(), duration };
    this.invalidate();
  }

  // The user tilted or zoomed in Chase or Front: kept for the frames to come.
  #wantFromUser() {
    const tr = this.tracking; if (!tr || tr.perspective === "orbit" || !tr.want) return;
    const cur = this.currentPose(); const a = tr.applied;
    if (a) {
      tr.want = { distance: tr.want.distance * (cur.distance / a.distance), polar: tr.want.polar + (cur.polar - a.polar) };
      tr.applied = { distance: cur.distance, polar: cur.polar };
    } else tr.want = { distance: cur.distance, polar: cur.polar };
  }

  // The badge over the view and what the camera shows: who, how, and
  // whether Chase or Front is waiting for a heading.
  #trackingShown() {
    const tr = this.tracking; if (!tr) return;
    const how = FOLLOW_PERSPECTIVES[tr.perspective].label;
    const waiting = tr.perspective !== "orbit" && !tr.heading;
    this.trackBadge.textContent = `Following ${tr.label} · ${how}`;
    this.trackBadge.hidden = false;
    this.setCameraState({ mode: "follow", perspective: tr.perspective, label: `Following ${tr.label} · ${how}`,
      note: waiting ? `No direction yet: ${tr.label} hasn't moved since following began, so ${how} waits and the camera follows as in Orbit.` : "" });
  }

  // Ends following: the camera stays where it is, panning as it was before.
  // `reason` says why (shown with the camera's state); `error`, if it ended
  // because the data was wrong. Returns whether anyone was being followed.
  stopTracking(reason = "", error = null) {
    const tr = this.tracking; if (!tr) return false;
    this.tracking = null;
    this.transition = null;                 // a move to them stops where it is
    this.controls.enablePan = this.panBefore; this.controls.zoomToCursor = this.zoomToCursorBefore;
    this.trackBadge.hidden = true; this.trackBadge.textContent = "";
    this.setCameraState({ mode: "manual", perspective: null, label: `Stopped following ${tr.label}`, note: reason });
    this.onTrackingStop?.({ id: tr.id, label: tr.label, reason, error });
    return true;
  }

  // A scene point must be numbers. A defect if not.
  checkPoint(point, what) {
    const bad = ["X", "Y", "Z"].filter((k) => !Number.isFinite(point?.[k]));
    if (bad.length) throw new CameraTargetError(`${what}: not a point (${bad.map((k) => `${k} = ${point?.[k]}`).join(", ")})`, { what, point });
  }

  // ---- Camera actions --------------------------------------------------------------------------

  // A camera preset: the view works out its pose (presetTarget()), then the
  // camera moves there. Unavailable: the camera stays, and the result says
  // why. A defect: thrown, the camera untouched.
  goPreset(name, args = {}) {
    const r = this.presetTarget(name, args);
    if (!r.ok) { if (r.defect) throw new CameraTargetError(r.reason, { action: name, ...r.context }); return r; }
    this.animateTo(r.pose, { mode: name, label: r.label, note: r.note ?? "" });
    return r;
  }

  // Focus: the camera turns to the selection and comes to the distance
  // that frames it, looking from the same direction and height as before
  // (as far as the controls' limits allow).
  focus(selection) {
    const r = this.focusTarget(selection);
    if (!r.ok) { if (r.defect) throw new CameraTargetError(r.reason, { action: "focus", ...r.context }); return r; }
    const cur = this.currentPose();
    const distance = r.box ? this.fitDistance(Math.max(r.minSpan ?? 0, r.box.X1 - r.box.X0, r.box.Z1 - r.box.Z0), 1.15) : r.distance;
    this.animateTo({ target: { ...r.point }, distance, polar: cur.polar, azimuth: cur.azimuth }, { mode: "focus", label: r.label, note: r.note ?? "" });
    return r;
  }

  // The compass: turns the camera round its target until it faces north
  // (−Z: the top of the 2D views), keeping its distance and height.
  faceNorth() {
    if (!this.home) return unavailable("Nothing is installed to look at yet.");
    const p = this.currentPose();
    if (Math.abs(Math.atan2(Math.sin(p.azimuth), Math.cos(p.azimuth))) < 1e-6) {
      this.setCameraState({ note: "Already facing north." });
      return { ok: true, already: true };
    }
    if (this.tracking) this.animateTo({ ...p, azimuth: 0 }, { mode: "follow", label: this.cameraState.label, keepTracking: true });
    else this.animateTo({ ...p, azimuth: 0 }, { mode: "north", label: "Facing north" });
    return { ok: true };
  }

  // Runs a camera action from a button: a defect is shown (onCameraError)
  // and logged, never swallowed; the camera keeps its last valid pose.
  runAction(fn) {
    try {
      const r = fn();
      if (r && r.ok === false && !r.defect) this.setCameraState({ note: r.reason });
      return r;
    } catch (err) {
      console.error("[fashion] camera action failed:", err, err?.context ?? "");
      this.setCameraState({ note: `That camera action failed: ${err?.message ?? err}` });
      if (this.onCameraError) this.onCameraError(err); else throw err;
      return { ok: false, defect: true, reason: err?.message ?? String(err) };
    }
  }

  // What the camera shows now (a preset, Focus, moved by hand), for the controls.
  setCameraState(partial) {
    this.cameraState = { ...this.cameraState, ...partial };
    this.onCameraState?.(this.cameraState);
  }

  // The user moved the camera: it shows no preset now.
  movedByHand() {
    if (this.tracking) return;       // turning or zooming while following: still following
    if (this.cameraState.mode !== "manual" || this.cameraState.note) this.setCameraState({ mode: "manual", label: "Moved by hand", note: "" });
  }

  keyDown(ev) {
    const key = ev.code ?? ev.key;
    if (!ARROWS.has(key)) return;
    this.cancelTransition();
    // Following, panning is off and the controls ignore keys altogether:
    // Shift (or Ctrl, ⌘) and an arrow still turn the camera, by the
    // controls' own step, round the one followed.
    if (this.tracking && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault?.();
      const step = 2 * Math.PI * this.controls.rotateSpeed / Math.max(1, this.canvas.clientHeight || this.wrap.clientHeight);
      const p = this.currentPose();
      if (key === "ArrowLeft") p.azimuth -= step; else if (key === "ArrowRight") p.azimuth += step;
      else if (key === "ArrowUp") p.polar -= step; else p.polar += step;
      this.#apply(this.constrain(p));
      this.#wantFromUser();
      this.invalidate();
      return;
    }
    this.keyDriving = true;
    queueMicrotask(() => { this.keyDriving = false; });
  }

  // The needle shows the camera's heading, as a map's compass does: north's
  // bearing, clockwise from straight up the screen. It's exactly where
  // north lies on screen from overhead and when facing north, east, south
  // or west; between those, the ground's slant toward the camera makes the
  // on-screen direction lean toward the nearest of them.
  #pointCompass() {
    const az = this.currentPose().azimuth;
    const deg = ((az * 180 / Math.PI) % 360 + 360) % 360;
    this.compassHeading = deg;
    this.needle.style.transform = `rotate(${deg >= 359.95 ? "0.0" : deg.toFixed(1)}deg)`;
  }

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

// Where a camera at `pose` stands: its target, then distance, polar angle
// and azimuth away (as OrbitControls places it).
export function cameraPoint(pose) {
  const t = pose.target; const sp = Math.sin(pose.polar);
  return { X: t.X + pose.distance * sp * Math.sin(pose.azimuth), Y: t.Y + pose.distance * Math.cos(pose.polar), Z: t.Z + pose.distance * sp * Math.cos(pose.azimuth) };
}

// Keeps a camera out of solid fixtures, and does nothing else. `heightAt(X,
// Z)` is how tall the solid fixture under a scene point is (0: none). If
// the camera would stand inside one (below its top, plus `margin`), it's
// pulled in along its line to the target, then, if no point on that line
// is clear, raised until it's above it. It doesn't look for a clear line of
// sight: a rack between the camera and the one followed stays there.
export function clearOfFixtures(pose, heightAt, { margin = 0.1, step = 0.1, minDistance = 0.6, minPolar = 0.05 } = {}) {
  const inside = (p) => { const c = cameraPoint(p); const h = heightAt(c.X, c.Z); return h > 0 && c.Y < h + margin; };
  if (!inside(pose)) return { pose, cleared: null };
  for (let d = pose.distance - step; d >= minDistance - 1e-9; d -= step) {
    const p = { ...pose, distance: d };
    if (!inside(p)) return { pose: p, cleared: "pulled in" };
  }
  for (let polar = pose.polar - 0.05; polar >= minPolar - 1e-9; polar -= 0.05) {
    const p = { ...pose, polar };
    if (!inside(p)) return { pose: p, cleared: "raised" };
  }
  return { pose: { ...pose, polar: minPolar }, cleared: "raised" };
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
