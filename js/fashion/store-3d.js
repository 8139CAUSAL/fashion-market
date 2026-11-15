// A store's floor in 3D, roofless and its walls cut away low: the
// installed layout's walls, entrances, racks in their category's colour
// (racks of a category the store's brand doesn't sell stand grey), the
// stockroom and its door, the till counter and the cashiers' places, the
// fitting cubicles (lit when in use, grey when closed), the queues' lines
// and heads — read from plan_geometry() and, where it gives several
// fixtures one code, from the installed layout's own rows — and everyone in
// the store where frame_pack() puts them: shoppers coloured by what they're
// doing, cashiers and assistants (filled when busy), the followed shopper
// and the inspected worker ringed. The heat map lies on its floor.
//
// It takes what FloorView takes, from the same calls on the Store tab, and
// a click does what a click on the 2D floor does: onClick(x, y) at the
// clicked agent's own position (or the floor's point under the pointer),
// in the floor's patch units, for the model's inspect_at().
//
// Its camera presets: Overview (the floor as it opens), Top-down (the
// whole floor from overhead, north up), Shopper (low, round the shopper
// selected in the inspector, where the current live frame has them) and
// Checkout (the tills, their counters and the till queue, as far as
// plan_geometry() and the installed rows place them); Focus turns to the
// selected shopper or worker. A preset that needs a live frame, a
// selection or geometry the plan doesn't have says so instead.
//
// Follow camera: the camera stays with the inspector's shopper as each
// live frame moves them, found by their visit's id. frame_pack() sends who
// is on the floor, not who left: a live frame without the visit ends it,
// and says only that the shopper isn't visible. A frame that contradicts
// itself ends it as an error.

import { sceneToFloor } from "./spatial.js";
import { floorModel, floorAgentsOf, checkoutGeometry, locateOnFloor, floorFrameProblems, union } from "./scene-adapter.js";
import { View3D, CameraTargetError, placeMatrix, personGeometry, staffGeometry, groundPlane, overlayMaterial, rgb, unavailable, defect } from "./view-3d.js";
import { LOOK_NAMES } from "./floor-view.js";
import { cssVar } from "./ui.js";
import { tooltip } from "./charts.js";

const WALL_M = 1.4;          // walls cut away to this height: everyone shows over them
const RACK_M = 1.35;
const COUNTER_M = 1.0;
const STOCK_M = 1.9;
const CUBICLE_M = 2.0;
const SHOPPER_M = 1.7;
const STAFF_M = 1.75;
const AGENT_LOOK_Y = 0.85;   // a camera on someone looks at their middle
const SHOPPER_DISTANCE = 5.5;
const SHOPPER_POLAR = 1.15;  // 0.42 rad (24°) above the floor: low, inside the store
const CHECKOUT_ELEVATION = 0.85;
const COMBINE_SPAN = 0.7;    // tills in separate places framed together while they span no more than this share of the floor

export class Store3DView extends View3D {
  constructor(wrap, THREE, { onClick, createRenderer } = {}) {
    super(wrap, THREE, { createRenderer, label: "Store floor in 3D with shoppers and staff", background: "--surface" });
    this.onClick = onClick;
    this.plan = null; this.rows = null; this.keys = []; this.model = null; this.sells = null; this.checkout = null;
    this.agents = null; this.heat = null; this.mode = "floor"; this.follow = null; this.inspect = null;
    this.live = false;           // whether frames now carry this store's floor as it is (watch pace)
    this.shapes = { shopper: personGeometry(THREE), staff: staffGeometry(THREE) };
    this.meshes = {};
  }

  // ---- What the Store tab sends -----------------------------------------------------------

  // A plan from plan_geometry(), the installed layout's rows for it (or
  // null) and the world's categories' keys. A new plan rebuilds the floor;
  // the same plan again does nothing.
  setPlan(plan, rows = null, keys = []) {
    if (this.plan === plan && this.rows === rows) return;
    const followed = this.tracking;
    this.plan = plan; this.rows = rows; this.keys = keys;
    this.model = plan ? floorModel(plan, rows, keys) : null;
    this.checkout = this.model ? checkoutGeometry(plan, this.model) : null;
    if (this.checkout?.problem) console.error(`[fashion] the Checkout camera can't read this floor: ${this.checkout.problem}`);
    this.agents = null; this.heat = null;
    this.staticDirty = true;
    if (this.model) {
      const f = this.model.frame;
      this.frame({ X0: 0, X1: f.width, Z0: -f.depth, Z1: 0 }, { azimuth: 0.3, elevation: 0.92, fill: 0.95 });
    }
    // A new floor: whoever was followed isn't on it.
    if (this.tracking) this.stopTracking("Stopped following: the store's floor changed.");
    if (followed) this.setCameraState({ note: "Stopped following: the store's floor changed." });
    this.invalidate();
  }
  setMode(mode) { this.mode = mode; this.heatDirty = true; this.dynamicDirty = true; this.invalidate(); }
  // The categories the store's brand sells (1-based); racks of the rest stand empty.
  setSells(cats) {
    const next = cats ? new Set(cats) : null;
    if (JSON.stringify([...(next ?? [])]) === JSON.stringify([...(this.sells ?? [])])) return;
    this.sells = next; this.racksDirty = true; this.dynamicDirty = true; this.invalidate();
  }
  setAgents(a) {
    this.agents = a; this.dynamicDirty = true;
    if (this.tracking && a) this.#track(a);
    this.invalidate();
  }
  // Whether the frames now carry this store's floor live (the Store report's
  // `live`): without it, where anyone stands isn't known now, and following ends.
  setLive(on) {
    this.live = !!on;
    if (!this.live) this.stopTracking("Stopped following: the floor isn't drawn live at this speed.");
  }
  setHeat(h) { this.heat = h; this.heatDirty = true; if (this.mode === "heat") { this.dynamicDirty = true; this.invalidate(); } }
  setFollow(v) { this.follow = v; this.dynamicDirty = true; this.invalidate(); }
  setInspect(target) { this.inspect = target; this.dynamicDirty = true; this.invalidate(); }

  // ---- The floor ----------------------------------------------------------------------------

  buildStatic() {
    if (!this.model) return;
    const THREE = this.THREE; const M = this.model; const f = M.frame; const c = f.cell; const C = M.cells;
    const add = (o, order = 0) => { o.renderOrder = order; this.statics.add(o); return o; };
    const lambert = (opts = {}) => new THREE.MeshLambertMaterial(opts);
    const css = (v) => cssVar(v, this.wrap);
    const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const blocks = (cells, height, material, inset = 1, name = "") => {
      if (!cells.length) return null;
      const mesh = add(this.instanced(unit, material, cells.length, (i, m) => placeMatrix(THREE, m, cells[i].X, 0, cells[i].Z, 0, c * inset, height, c * inset)));
      mesh.name = name;
      return mesh;
    };
    const tint = (v, a) => mixRgb(css("--floor-bg"), css(v), a);

    // The floor: one texel per cell, tinted as the 2D floor tints it.
    const floorTint = {
      door: tint("--good", 0.5), cubicle: tint("--fitting", 0.22), behind: tint("--muted", 0.18), cashier: tint("--ink", 0.22),
      stock: tint("--muted", 0.3), stockDoor: tint("--muted", 0.55), queue: tint("--muted", 0.12),
      frLine: tint("--look-4", 0.22), frHead: tint("--look-4", 0.45), tillLine: tint("--look-3", 0.22), tillHead: tint("--look-3", 0.45),
    };
    add(groundPlane(THREE, f.W, f.H, f.width, f.depth, (r, col) => floorTint[M.kind[r * f.W + col]] ?? css("--floor-bg")));
    // A faint line every metre, as on the 2D floor.
    const lines = [];
    for (let x = 0; x <= f.W; x += 2) lines.push(x * c, 0.005, 0, x * c, 0.005, -f.depth);
    for (let y = 0; y <= f.H; y += 2) lines.push(0, 0.005, -y * c, f.width, 0.005, -y * c);
    const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: this.colour("--floor-line"), polygonOffset: true, polygonOffsetFactor: -1 })));

    // Walls, the till counter, the stockroom's shelving.
    blocks(C.wall, WALL_M, lambert({ color: this.colour("--floor-wall") }), 1, "walls");
    blocks(C.counter, COUNTER_M, lambert({ color: this.colour("--muted") }), 1, "counter");
    blocks(C.stock, STOCK_M, lambert({ color: this.mixColour("--floor-bg", "--muted", 0.55) }), 0.98, "stockroom");
    // Racks: a fixture per cell in its category's colour (grey where not stocked).
    this.rackMesh = blocks(C.rack, RACK_M, lambert({ color: 0xffffff }), 0.97, "racks");
    this.racksDirty = true;
    // The queues' heads: a post each, in the queue's colour.
    const heads = [...C.frHead.map((h) => [h, "--look-4"]), ...C.tillHead.map((h) => [h, "--look-3"])];
    if (heads.length) {
      const post = new THREE.CylinderGeometry(0.05, 0.07, 1, 8).translate(0, 0.5, 0);
      const mesh = add(this.instanced(post, lambert({ color: 0xffffff }), heads.length, (i, m) => placeMatrix(THREE, m, heads[i][0].X, 0, heads[i][0].Z, 0, 1, 1.05, 1)));
      heads.forEach(([, v], i) => mesh.setColorAt(i, this.colour(v)));
      mesh.instanceColor.needsUpdate = true;
    }
    // A cashier's place: a till on the counter beside it.
    if (C.cashier.length) {
      const till = new THREE.BoxGeometry(0.3, 0.28, 0.24).translate(0, 0.14, 0);
      add(this.instanced(till, lambert({ color: this.colour("--ink-2") }), C.cashier.length, (i, m) => placeMatrix(THREE, m, C.cashier[i].X, 0.85, C.cashier[i].Z, 0, 1, 1, 1)));
    }
    // Fitting cubicles: a booth each, see-through, coloured by its state each frame.
    if (M.cubicles.length) {
      this.cubicleMesh = add(this.instanced(unit, new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }), M.cubicles.length,
        (i, m) => { const b = M.cubicles[i]; placeMatrix(THREE, m, (b.X0 + b.X1) / 2, 0, (b.Z0 + b.Z1) / 2, 0, (b.X1 - b.X0) * 0.92, CUBICLE_M, (b.Z1 - b.Z0) * 0.92); }), 3);
      this.cubicleMesh.name = "cubicles";
    } else this.cubicleMesh = null;
    // The heat map, on the floor (shown in heat mode).
    this.heatPlane = add(new THREE.Mesh(new THREE.PlaneGeometry(f.width, f.depth).rotateX(-Math.PI / 2).translate(f.width / 2, 0, -f.depth / 2),
      overlayMaterial(THREE, 0xffffff, 3, false, 0.999)), 1);
    this.heatPlane.visible = false; this.heatDirty = true;

    // Names: each rack's category, the stockroom, tills, fitting rooms and the entrances.
    this.rackLabels = M.labels.map((l) => this.addLabel(l.text, l.X, RACK_M + 0.5, l.Z, { cls: "fixture", priority: 2 }));
    M.doors.forEach((d) => this.addLabel("Entrance · exit", d.X, 0.3, d.Z, { cls: "door", priority: 1 }));
    this.receiptLabel = M.tills.length ? this.addLabel("", M.tills[0].X, 2.6, M.tills[0].Z, { cls: "receipts", priority: 3 }) : null;

    // Selection rings.
    const ring = (colour) => { const r = add(new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: colour, depthTest: false })), 6); r.visible = false; return r; };
    this.followRing = ring(this.colour("--ink")); this.inspectRing = ring(this.colour("--focus"));
    this.lookColours = LOOK_NAMES.map((_, k) => this.colour(`--look-${k + 1}`));
    this.roleColours = [this.colour("--ink"), this.colour("--accent")];
    this.surface = this.colour("--surface");
    this.cubColours = { busy: this.mixColour("--surface", "--fitting", 0.85), closed: this.colour("--muted"), free: this.mixColour("--surface", "--fitting", 0.25) };
  }

  #agentMesh(kind, n) {
    const THREE = this.THREE; let mesh = this.meshes[kind];
    if (mesh && mesh.instanceMatrix.count >= n) return mesh;
    const cap = Math.max(32, 2 ** Math.ceil(Math.log2(Math.max(1, n))));
    if (mesh) { this.dynamics.remove(mesh); mesh.material.dispose(); mesh.dispose(); }
    mesh = new THREE.InstancedMesh(this.shapes[kind], new THREE.MeshLambertMaterial({ color: 0xffffff }), cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.count = 0; mesh.name = kind;
    mesh.setColorAt(0, this.surface ?? new THREE.Color(1, 1, 1));
    this.dynamics.add(mesh);
    this.meshes[kind] = mesh;
    return mesh;
  }

  // ---- The moving parts ---------------------------------------------------------------------

  updateDynamic() {
    if (!this.model) return;
    const THREE = this.THREE; const m = new THREE.Matrix4();
    if (this.racksDirty && this.rackMesh) {
      this.racksDirty = false;
      const muted = this.mixColour("--floor-bg", "--muted", 0.45);
      this.model.cells.rack.forEach((r, i) => {
        const sold = !this.sells || this.sells.has(r.category);
        this.rackMesh.setColorAt(i, sold ? this.colour(`--cat-${r.category}`) : muted);
      });
      this.rackMesh.instanceColor.needsUpdate = true;
      this.model.labels.forEach((l, i) => {
        const empty = l.category && this.sells && !this.sells.has(l.category);
        const label = this.rackLabels?.[i]; if (!label) return;
        label.text = empty ? `${l.text} (not stocked)` : l.text; label.node.textContent = label.text;
      });
    }
    if (this.heatDirty && this.heatPlane) {
      this.heatDirty = false;
      this.heatPlane.visible = this.mode === "heat" && !!this.heat;
      if (this.heatPlane.visible) this.#paintHeat();
    }
    const A = floorAgentsOf(this.agents, this.plan);
    this.lastAgents = A;
    const sh = this.#agentMesh("shopper", A.shoppers.n);
    for (let i = 0; i < A.shoppers.n; i++) {
      sh.setMatrixAt(i, placeMatrix(THREE, m, A.shoppers.X[i], 0, A.shoppers.Z[i], 0, SHOPPER_M, SHOPPER_M, SHOPPER_M));
      sh.setColorAt(i, this.lookColours[A.shoppers.look[i] - 1] ?? this.surface);
    }
    sh.count = A.shoppers.n; sh.instanceMatrix.needsUpdate = true; if (sh.instanceColor) sh.instanceColor.needsUpdate = true;
    const st = this.#agentMesh("staff", A.staff.n);
    for (let i = 0; i < A.staff.n; i++) {
      st.setMatrixAt(i, placeMatrix(THREE, m, A.staff.X[i], 0, A.staff.Z[i], 0, STAFF_M, STAFF_M, STAFF_M));
      const role = this.roleColours[A.staff.role[i] === 1 ? 0 : 1];
      // Busy: in their role's colour; free: paler (the 2D floor's hollow square).
      st.setColorAt(i, A.staff.busy[i] ? role : role.clone().lerp(this.surface, 0.6));
    }
    st.count = A.staff.n; st.instanceMatrix.needsUpdate = true; if (st.instanceColor) st.instanceColor.needsUpdate = true;
    // Fitting cubicles: in use, closed, or free.
    if (this.cubicleMesh) {
      this.model.cubicles.forEach((_, i) => {
        const open = A.cubicles.n ? A.cubicles.open[i] : true; const busy = A.cubicles.n ? A.cubicles.busy[i] : false;
        this.cubicleMesh.setColorAt(i, !open ? this.cubColours.closed : busy ? this.cubColours.busy : this.cubColours.free);
      });
      this.cubicleMesh.instanceColor.needsUpdate = true;
    }
    // The followed shopper; the worker in the inspector.
    const fi = this.follow ? A.shoppers.visit.indexOf(this.follow) : -1;
    this.followRing.visible = fi >= 0;
    if (fi >= 0) { this.followRing.position.set(A.shoppers.X[fi], 0.02, A.shoppers.Z[fi]); this.followRing.scale.set(0.55, 1, 0.55); }
    let wi = -1;
    const ins = this.inspect;
    if (ins && ins.kind !== "shopper") for (let i = 0; i < A.staff.n; i++) if (A.staff.role[i] === (ins.kind === "cashier" ? 1 : 2) && A.staff.id[i] === ins.server) wi = i;
    this.inspectRing.visible = wi >= 0;
    if (wi >= 0) { this.inspectRing.position.set(A.staff.X[wi], 0.02, A.staff.Z[wi]); this.inspectRing.scale.set(0.7, 1, 0.7); }
    if (this.receiptLabel) { const t = this.agents ? `${this.agents.receipts} receipts` : ""; this.receiptLabel.text = t; this.receiptLabel.node.textContent = t; }
  }

  // The heat map as the 2D floor shades it: each cell by the square root of
  // its share of the busiest cell's footfall.
  #paintHeat() {
    const THREE = this.THREE; const f = this.model.frame; const h = this.heat;
    let max = 0; for (let i = 0; i < h.length; i++) if (h[i] > max) max = h[i];
    const steps = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"].map(rgb);
    const data = new Uint8Array(f.W * f.H * 4);
    for (let r = 0; r < f.H; r++) for (let c = 0; c < f.W; c++) {
      const v = h[r * f.W + c]; if (!(v > 0) || !max) continue;
      const t = Math.sqrt(v / max);
      const [R, G, B] = steps[Math.min(steps.length - 1, Math.floor(t * steps.length))];
      data.set([R, G, B, Math.round(255 * (0.25 + 0.65 * t))], ((f.H - 1 - r) * f.W + c) * 4);
    }
    const old = this.heatPlane.material.map;
    const tex = new THREE.DataTexture(data, f.W, f.H, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    this.heatPlane.material.map = tex; this.heatPlane.material.transparent = true; this.heatPlane.material.needsUpdate = true;
    old?.dispose();
  }

  // ---- Camera targets ------------------------------------------------------------------------------

  // Where a selected shopper or worker stands now: in the current frame,
  // which must be live. See locateOnFloor().
  locate(sel) {
    if (!this.model) return unavailable("No floor is installed.");
    if (!sel) return unavailable("Select a shopper or a worker on the floor first.");
    if (!this.live) return unavailable("The floor isn't drawn live at this speed: pick a slower speed to see where everyone is.");
    if (!this.agents) return unavailable("No live frame of this store has arrived yet.");
    const r = locateOnFloor(this.agents, this.plan, sel);
    if (!r.ok) return r;
    return { ...r, point: { X: r.at.X, Y: AGENT_LOOK_Y, Z: r.at.Z } };
  }

  // The checkout's zones as the camera controls offer them: each zone's
  // tills, and whether they can all be framed at once.
  checkoutChoices() {
    const g = this.checkout;
    if (!g || g.problem || !g.zones.length) return { zones: [], together: false };
    const f = this.model.frame;
    const all = this.#checkoutBox(g.zones.map((_, i) => i), true);
    const together = g.zones.length === 1 || Math.max(all.X1 - all.X0, all.Z1 - all.Z0) <= COMBINE_SPAN * Math.max(f.width, f.depth);
    return { together, zones: g.zones.map((z, i) => ({ index: i + 1, label: z.tills.length === 1 ? `Till ${z.tills[0]}` : `Tills ${z.tills[0]}–${z.tills.at(-1)}`, tills: z.tills })) };
  }

  #checkoutBox(zones, withQueue) {
    const g = this.checkout; let box = null;
    for (const i of zones) box = box ? union(box, g.zones[i].box) : g.zones[i].box;
    if (withQueue) for (const q of [g.queue.head, ...(g.queue.line ?? [])]) if (q) box = union(box, q);
    return box;
  }

  // Overview; Top-down; Shopper { selection }; Checkout { zone } (a zone's
  // number, or none for every till together).
  presetTarget(name, { selection = null, zone = null } = {}) {
    if (!this.model) return unavailable("No floor is installed.");
    const f = this.model.frame;
    if (name === "topdown") return { ok: true, pose: this.poseOverhead({ X0: 0, X1: f.width, Z0: -f.depth, Z1: 0 }), label: "Top-down" };
    if (name === "shopper") {
      if (selection?.kind !== "shopper") return unavailable("Select a shopper on the floor: the Shopper view looks at the one in the inspector.");
      const r = this.locate(selection); if (!r.ok) return r;
      return { ok: true, pose: { target: r.point, distance: SHOPPER_DISTANCE, polar: SHOPPER_POLAR, azimuth: this.currentPose().azimuth }, label: `Shopper · visit #${selection.visit}` };
    }
    if (name === "checkout") {
      const g = this.checkout;
      if (g.problem) return defect(`The checkout can't be framed: ${g.problem}`, { format: this.plan.format });
      if (!g.zones.length) return unavailable("This floor plan has no till to frame.");
      const ch = this.checkoutChoices();
      let box; let label; const notes = [];
      if (zone === null || zone === undefined || zone === "") {
        if (!ch.together) return unavailable(`This floor's tills stand in ${g.zones.length} places too far apart to frame together: pick a till zone.`);
        box = this.#checkoutBox(g.zones.map((_, i) => i), true);
        label = g.zones.length === 1 ? "Checkout" : "Checkout · every till";
        if (!g.queue.head && !g.queue.line) notes.push("The floor's data has no place for the till queue, so only the tills are framed.");
        else if (!g.queue.line) notes.push("Only the till queue's head is placed in the floor's data here (the installed layout's picture isn't this plan's), so its line isn't framed.");
      } else {
        const z = g.zones[zone - 1];
        if (!Number.isInteger(zone) || !z) return defect(`There is no till zone ${zone} on this floor (it has ${g.zones.length})`, { zone });
        box = this.#checkoutBox([zone - 1], false);
        label = `Checkout · ${ch.zones[zone - 1].label}`;
        notes.push("The till queue serves every till, so it's framed with every till together, not with one zone.");
      }
      const pose = this.poseForBox(box, { azimuth: this.currentPose().azimuth, elevation: CHECKOUT_ELEVATION, fill: 1.3, minSpan: 4 });
      return { ok: true, pose, label, note: notes.join(" ") };
    }
    return super.presetTarget(name);
  }

  // ---- Follow camera ------------------------------------------------------------------------------

  // Whether the inspector's shopper can be followed now.
  followTarget(sel) {
    if (sel?.kind !== "shopper") return unavailable("Select a shopper on the floor to follow them.");
    return this.locate(sel);
  }

  // Follows the inspector's shopper: the camera moves round them, low, from
  // the side it's on, and stays with them frame by frame.
  followCamera(sel) {
    const r = this.followTarget(sel);
    if (!r.ok) { if (r.defect) throw new CameraTargetError(r.reason, { action: "follow", ...r.context }); return r; }
    this.startTracking({ id: sel.visit, label: `visit #${sel.visit}`, point: r.point,
      pose: { target: r.point, distance: SHOPPER_DISTANCE, polar: SHOPPER_POLAR, azimuth: this.currentPose().azimuth } });
    return { ok: true };
  }

  // A frame while following: the camera moves with the visit, or following
  // ends — normally if the visit isn't in it, as an error if the frame is wrong.
  #track(a) {
    const visit = this.tracking.id;
    const problems = floorFrameProblems(a, this.plan);
    const r = problems.length ? null : locateOnFloor(a, this.plan, { kind: "shopper", visit });
    if (problems.length || r.defect) {
      const detail = problems.length ? problems.slice(0, 4).join("; ") : r.reason;
      const err = new CameraTargetError(`Following visit #${visit} stopped: the frame is wrong (${detail})`, { visit, problems });
      console.error(`[fashion] ${err.message}`, err.context);
      this.stopTracking(`Stopped following: the store's frame was wrong (${detail}).`, err);
      this.onCameraError?.(err);
      return;
    }
    if (!r.ok) { this.stopTracking("Shopper no longer visible in this store."); return; }
    this.updateTracking({ X: r.at.X, Y: AGENT_LOOK_Y, Z: r.at.Z });
  }

  // Focus: the shopper or worker selected (the inspector's).
  focusTarget(sel) {
    if (!sel) return unavailable("Select a shopper or a worker on the floor to focus on.");
    const r = this.locate(sel); if (!r.ok) return r;
    const who = sel.kind === "shopper" ? `visit #${sel.visit}` : `${sel.kind} ${sel.server}`;
    return { ok: true, point: r.point, distance: SHOPPER_DISTANCE + 0.5, label: `Focus · ${who}` };
  }

  // ---- The pointer ------------------------------------------------------------------------------

  // The agent under the pointer: { kind: "shopper" | "staff", i }, by its
  // figure, else the nearest to the floor's point within the 2D view's
  // reach; and that point, in patch units.
  agentAt(ev) {
    const A = this.lastAgents;
    let hit = null;
    if (A) {
      const meshes = ["shopper", "staff"].map((k) => this.meshes[k]).filter((x) => x && x.count);
      for (const mesh of meshes) mesh.computeBoundingSphere();
      const h = this.ray(ev).intersectObjects(meshes, false)[0];
      if (h && h.instanceId !== undefined) hit = { kind: h.object.name, i: h.instanceId };
    }
    const g = this.groundAt(ev);
    const at = g ? sceneToFloor(this.model.frame, g.x, g.z) : null;
    if (!hit && A && at) {
      let bd = 2.2;
      for (let i = 0; i < A.shoppers.n; i++) { const d = (A.shoppers.x[i] - at.x) ** 2 + (A.shoppers.y[i] - at.y) ** 2; if (d < bd) { bd = d; hit = { kind: "shopper", i }; } }
      for (let i = 0; i < A.staff.n; i++) { const d = (A.staff.x[i] - at.x) ** 2 + (A.staff.y[i] - at.y) ** 2; if (d < bd) { bd = d; hit = { kind: "staff", i }; } }
    }
    return { hit, at };
  }

  click(ev) {
    if (!this.model) return;
    const { hit, at } = this.agentAt(ev);
    const A = this.lastAgents;
    // The same call the 2D floor makes: the model inspects whoever is nearest the point.
    if (hit?.kind === "shopper") return this.onClick?.(A.shoppers.x[hit.i], A.shoppers.y[hit.i]);
    if (hit?.kind === "staff") return this.onClick?.(A.staff.x[hit.i], A.staff.y[hit.i]);
    if (at) this.onClick?.(at.x, at.y);
  }

  hover(ev) {
    if (!this.model) return;
    const { hit } = this.agentAt(ev); const A = this.lastAgents;
    this.canvas.style.cursor = hit ? "pointer" : "";
    if (hit?.kind === "staff") {
      const role = A.staff.role[hit.i] === 1 ? "Cashier" : "Assistant";
      return tooltip.show(ev, `${role} ${A.staff.id[hit.i]}`, [{ value: A.staff.busy[hit.i] ? "busy" : "free" }, { value: "Click", name: "to see their work" }]);
    }
    if (!hit) return tooltip.hide();
    const look = A.shoppers.look[hit.i];
    tooltip.show(ev, `Shopper · visit #${A.shoppers.visit[hit.i]}`, [
      { colour: `var(--look-${look})`, value: LOOK_NAMES[look - 1] },
      { value: "Click", name: "to see inside their head" },
    ]);
  }
}

// Two CSS colours mixed, as a CSS colour: t of the way from a to b.
function mixRgb(a, b, t) {
  const A = rgb(a); const B = rgb(b);
  return `rgb(${A.map((v, i) => Math.round(v * (1 - t) + B[i] * t)).join(",")})`;
}
