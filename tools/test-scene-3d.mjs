// Tests for the 3D views' page side: the coordinate transformation between
// the simulation and the Three.js scenes (js/fashion/spatial.js), the
// adapter that reads R's geometry and frames for them
// (js/fashion/scene-adapter.js), and the views themselves
// (js/fashion/market-3d.js, store-3d.js) built with the real Three.js
// bundle (vendor/three.js) against a stand-in for the browser
// (tools/fake-dom.mjs) and a renderer that only counts what it's asked.
// tools/test-browser-3d.mjs runs them in Chromium, with WebGL and the real
// model in webR.
//
//   node --test tools/test-scene-3d.mjs
//
//   - a tile, a floor cell and an agent land in the scene where the
//     spatial contract (tools/fixtures/spatial-contract.json) and the 2D
//     views put them: X = x, Z = −y, no mirroring, turn or offset
//   - the ground's texture puts each tile's colour on that tile
//   - the default world's map read as scenery: every tile drawn as what it
//     is, the mall's plan on its block, the storefronts in their stores'
//     colours, the households where homes_xy() puts them
//   - a floor read from the installed layout's rows only when they are the
//     picture plan_geometry() read; then a cashier's place, a stockroom
//     door and each queue's head and line are told apart
//   - frames move the agents and nothing else: no scenery rebuilt, one
//     render however many frames arrive, none while hidden or in 2D
//   - a new installed world rebuilds the scenery and lets the old go;
//     dispose() lets everything go
//   - a click picks the store, household, shopper or worker the 2D views
//     would, with the same call
//   - the 2D/3D switch sends nothing to the simulation, and without WebGL
//     stays in 2D

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDom } from "./fake-dom.mjs";

const dom = installDom();
globalThis.document.getElementById = () => null;               // no tooltip element: tooltips do nothing
// Each CSS custom property its own colour, so the views' colours can be told apart.
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => {
  let h = 7; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `#${(h & 0xffffff).toString(16).padStart(6, "0")}`;
} });
const THREE = await import("../vendor/three.js");
const spatial = await import("../js/fashion/spatial.js");
const adapter = await import("../js/fashion/scene-adapter.js");
const { Market3DView } = await import("../js/fashion/market-3d.js");
const { Store3DView } = await import("../js/fashion/store-3d.js");
const { ViewSwitch } = await import("../js/fashion/view-switch.js");
const { tileCentre, tileAt } = await import("../js/fashion/world-store.js");
const { pointer } = await import("./fake-dom.mjs");

const json = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const contract = json("tools/fixtures/spatial-contract.json");
const world = json("worlds/default.world.json");
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- Fixtures: what R sends, made from the world files ---------------------------------------

// model/city.R's MAP_CHARS.
const MAP_CHARS = { ".": 0, "~": 1, p: 2, s: 4, "=": 5, "+": 6, w: 7, "#": 8, "-": 9, f: 10, H: 11, x: 12, d: 13, P: 14, G: 15, m: 16 };
for (let k = 1; k <= 9; k++) MAP_CHARS[String(k)] = 3;

// A city_geometry() for a world file, as model/city.R sends it: tiles row
// by row from the top left, facilities' and venues' tiles 0-based and
// column-major, stores with their points in metres.
function geometryOf(W) {
  const M = W.macro; const ny = M.tiles.length; const nx = M.tiles[0].length; const p = M.patch_m;
  const land = []; const density = []; const area = [];
  const keys = M.areas.map((a) => a.key);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    const ch = M.tiles[r][c];
    land.push(MAP_CHARS[ch]); density.push(/[1-9]/.test(ch) ? Number(ch) : 0);
    area.push(keys.indexOf(M.area_tiles[r][c]) + 1);
  }
  const colMajor = (ts) => ts.map(([r, c]) => c * ny + r);
  const storeIds = W.stores.map((s) => s.id);
  return {
    width: nx * p, height: ny * p, patch: p, nx, ny, land, density, area,
    areas: M.areas.map((a) => ({ id: a.id, name: a.name, colour: a.colour, x: NaN, y: NaN })),
    stores: W.stores.map((s, i) => ({ id: i + 1, key: s.id, name: s.name, short: s.short, brand: W.brands.findIndex((b) => b.id === s.brand) + 1,
      area: 0, format: s.layout, space: 1, venue: 0, x: s.x, y: s.y })),
    brands: W.brands.map((b) => ({ id: b.id, name: b.name, colour: b.colour })),
    segments: [], categories: W.categories.map((c) => ({ id: c.id, name: c.name, key: c.key, colour: c.colour })),
    homes: { n: 0 },
    parking: M.parking.map((f) => ({ id: f.id, name: f.name, kind: f.kind, levels: f.levels, spaces: f.spaces, tiles: colMajor(f.tiles) })),
    venues: M.venues.map((v) => ({ id: v.id, name: v.name, kind: v.kind, stores: v.stores.map((id) => storeIds.indexOf(id) + 1),
      tiles: colMajor(v.tiles ?? []), plan: v.plan ? { cell_m: v.plan.cell_m, rows: v.plan.rows } : null })),
  };
}

// A plan_geometry() for a layout's rows, as model/floors.R sends it: codes
// row by row from the top, each cubicle's block (x, y bottom left, w, h)
// and the cashiers' places and doors in patch units.
function planOf(L, keys) {
  const rows = L.rows; const H = rows.length; const W = rows[0].length;
  const xy = (r, c) => [c, H - 1 - r];
  const cells = (test) => { const out = []; for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (test(rows[r][c])) out.push([r, c]); return out; };
  const seen = new Set(); const boxes = [];
  for (const [r, c] of cells((ch) => ch === "F")) {
    if (seen.has(`${r},${c}`)) continue;
    const stack = [[r, c]]; const block = [];
    while (stack.length) {
      const [a, b] = stack.pop(); const k = `${a},${b}`;
      if (seen.has(k) || rows[a]?.[b] !== "F") continue;
      seen.add(k); block.push(xy(a, b)); stack.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]);
    }
    const xs = block.map((q) => q[0]); const ys = block.map((q) => q[1]);
    boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1]);
  }
  // The queues' heads: one each (model/floors.R refuses a layout with more), as a pair.
  const head = (ch) => { const h = cells((x) => x === ch); return h.length ? xy(...h[0]) : undefined; };
  return { format: L.id, name: L.name, width: W, height: H, cell_m: 0.5, codes: adapter.rowsToCodes(rows, keys),
    labels: [], cubicle_boxes: boxes, tills: cells((ch) => ch === "c").map(([r, c]) => xy(r, c)), doors: cells((ch) => ch === "=").map(([r, c]) => xy(r, c)),
    fr_head: head("W"), till_head: head("Q") };
}

const flagship = json("layouts/flagship.layout.json");
const keys = world.categories.map((c) => c.key);
const geo = geometryOf(world);

// A renderer that draws nothing and counts; a canvas with what OrbitControls needs.
function fakeRenderer() {
  const canvas = dom.element("canvas");
  const root = { addEventListener() {}, removeEventListener() {} };
  Object.assign(canvas, { getRootNode: () => root, ownerDocument: root, removeEventListener(type, fn) { const a = this.listeners.get(type) ?? []; this.listeners.set(type, a.filter((f) => f !== fn)); } });
  return { domElement: canvas, calls: 0, setPixelRatio() {}, setSize(w, h) { this.size = [w, h]; }, render(scene, camera) { this.calls++; scene.updateMatrixWorld(); camera.updateMatrixWorld(); },
    dispose() { this.disposed = true; }, forceContextLoss() { this.lost = true; } };
}
function makeView(View, size = [800, 600], opts = {}) {
  const wrap = dom.element("div");
  let renderer;
  const view = new View(wrap, THREE, { ...opts, createRenderer: () => (renderer = fakeRenderer()) });
  wrap.box = { left: 0, top: 0 };
  renderer.domElement.clientWidth = size[0]; renderer.domElement.clientHeight = size[1];
  dom.resize(wrap, ...size);
  return { view, wrap, renderer };
}
// A pointer event at a scene point's place on the canvas.
const at = (view, X, Y, Z) => { const s = view.toScreen(X, Y, Z); return { clientX: s.x, clientY: s.y, button: 0, buttons: 0 }; };
const click = (view, ev) => { view.canvas.dispatch("pointerdown", ev); view.canvas.dispatch("pointerup", ev); };
const translation = (mesh, i) => { const m = new THREE.Matrix4(); mesh.getMatrixAt(i, m); return new THREE.Vector3().setFromMatrixPosition(m); };

// ---- The transformation -------------------------------------------------------------------------

test("a map tile's middle is X = (c + 0.5) p, Z = −(H − r − 0.5) p: the contract's metres with north at −Z", () => {
  const m = { patch: contract.map.patch_m, nx: contract.map.width, ny: contract.map.height };
  for (const k of contract.map.cells) {
    const s = spatial.macroTileCentre(m, k.r, k.c);
    assert.deepEqual([s.X, s.Z], [(k.c + 0.5) * m.patch, -(m.ny - k.r - 0.5) * m.patch]);
    assert.deepEqual([s.X, s.Z], [k.x, -k.y]);                                    // the model's metres
    assert.deepEqual(spatial.macroToScene(k.x, k.y), { X: k.x, Z: -k.y });
    assert.deepEqual(spatial.sceneToMacro(s.X, s.Z), { x: k.x, y: k.y });
    assert.deepEqual(spatial.macroTileAt(m, s.X, s.Z), { r: k.r, c: k.c });
    // The page's own helpers agree (world-store.js, used by the editors).
    const page = tileCentre({ patch_m: m.patch, height: m.ny }, k.r, k.c);
    assert.deepEqual([page.x, page.y], [k.x, k.y]);
    assert.deepEqual(tileAt({ patch_m: m.patch, height: m.ny }, s.X, -s.Z), { r: k.r, c: k.c });
  }
  // North is −Z and east +X: row 0 is the scene's most negative Z, column 0 its least X.
  const nw = spatial.macroTileCentre(m, 0, 0); const se = spatial.macroTileCentre(m, m.ny - 1, m.nx - 1);
  assert.ok(nw.Z < se.Z && nw.X < se.X);
});

test("a floor cell's middle is X = (c + 0.5) × 0.5, Z = −(H − r − 0.5) × 0.5, and an agent at patch (x, y) stands at X = (x + 0.5) × 0.5, Z = −(y + 0.5) × 0.5", () => {
  const f = spatial.floorFrame({ width: contract.floor.width, height: contract.floor.height, cell_m: contract.floor.cell_m });
  for (const k of contract.floor.cells) {
    const cell = spatial.floorCellCentre(f, k.r, k.c);
    assert.deepEqual([cell.X, cell.Z], [k.x, -k.y]);
    const agent = spatial.floorToScene(f, k.pxcor, k.pycor);                 // an agent standing on the patch
    assert.deepEqual(agent, cell);
    const back = spatial.sceneToFloor(f, cell.X, cell.Z);
    assert.ok(near(back.x, k.pxcor) && near(back.y, k.pycor));
  }
  // A cubicle's block: its edges bound its cells' middles.
  const b = spatial.floorBox(f, [40, 30, 2, 3]);
  const lo = spatial.floorToScene(f, 40, 30); const hi = spatial.floorToScene(f, 41, 32);
  assert.ok(b.X0 < lo.X && hi.X < b.X1 && b.Z0 < hi.Z && lo.Z < b.Z1);
  assert.deepEqual([b.X1 - b.X0, b.Z1 - b.Z0], [1, 1.5]);
});

test("the 3D scene's ground is the 2D views' picture: the same point lands on the same pixel", () => {
  const k = 0.137; const c = 9.5;
  for (const s of geo.stores) {
    const { X, Z } = spatial.macroToScene(s.x, s.y);
    assert.deepEqual(spatial.sceneToCityViewPx(geo, X, Z, k).map((v) => v.toFixed(9)), spatial.cityViewPx(geo, s.x, s.y, k).map((v) => v.toFixed(9)));
  }
  const plan = planOf(flagship, keys); const f = spatial.floorFrame(plan);
  for (const [x, y] of [[0, 0], [65, 35], [12.3, 7.9], [40, 22]]) {
    const { X, Z } = spatial.floorToScene(f, x, y);
    assert.deepEqual(spatial.sceneToFloorViewPx(plan, X, Z, c).map((v) => v.toFixed(9)), spatial.floorViewPx(plan, x, y, c).map((v) => v.toFixed(9)));
  }
});

test("the ground's texture puts each tile's colour on that tile (texture row 0 the south edge)", async () => {
  const { groundPlane } = await import("../js/fashion/view-3d.js");
  const nx = 7; const ny = 5; const p = 10;
  const colourOf = (r, c) => `rgb(${r * 10},${c * 10},7)`;
  const mesh = groundPlane(THREE, nx, ny, nx * p, ny * p, colourOf);
  const tex = mesh.material.map; const pos = mesh.geometry.attributes.position; const uv = mesh.geometry.attributes.uv;
  // Where the plane puts each texture coordinate.
  for (let i = 0; i < pos.count; i++) {
    assert.ok(near(pos.getX(i), uv.getX(i) * nx * p, 1e-9) && near(pos.getZ(i), -uv.getY(i) * ny * p, 1e-9) && near(pos.getY(i), 0, 1e-9));
  }
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    const mid = spatial.macroTileCentre({ patch: p, nx, ny }, r, c);
    const u = mid.X / (nx * p); const v = -mid.Z / (ny * p);
    const texel = (Math.floor(v * ny) * nx + Math.floor(u * nx)) * 4;
    assert.deepEqual([...tex.image.data.slice(texel, texel + 3)], [r * 10, c * 10, 7]);
  }
});

// ---- The adapter -------------------------------------------------------------------------------------

test("the default world's map, read as scenery: each tile drawn as what it's painted", () => {
  const M = adapter.cityModel(geo, world);
  const count = (re) => world.macro.tiles.join("").split("").filter((ch) => re.test(ch)).length;
  assert.equal(M.tiles.water.length, count(/~/)); assert.equal(M.tiles.park.length, count(/p/));
  assert.equal(M.tiles.homes.length, count(/[1-9]/)); assert.equal(M.tiles.lot.length, count(/P/));
  assert.equal(M.tiles.garage.length, count(/G/)); assert.equal(M.tiles.mall.length, count(/m/)); assert.equal(M.tiles.bridge.length, count(/\+/));
  assert.equal(M.bridges.length, count(/[+f]/));
  // Every road link runs between the middles of two road tiles, one step apart.
  const m = M.frame;
  for (let i = 0; i < M.roads.length; i += 4) {
    const a = spatial.macroTileAt(m, M.roads[i], M.roads[i + 1]); const b = spatial.macroTileAt(m, M.roads[i + 2], M.roads[i + 3]);
    assert.ok(adapter.ROADS.has(geo.land[a.r * m.nx + a.c]) && adapter.ROADS.has(geo.land[b.r * m.nx + b.c]));
    assert.ok(Math.abs(a.r - b.r) <= 1 && Math.abs(a.c - b.c) <= 1 && (a.r !== b.r || a.c !== b.c));
  }
  assert.equal(M.roadDots.length / 2, count(/[=+Hxd]/));
  // Houses stand on home tiles, as many as the map allows.
  assert.ok(M.houses.n >= M.tiles.homes.length && M.houses.n <= adapter.MAX_HOUSES);
  for (let i = 0; i < M.houses.n; i += 97) {
    const t = spatial.macroTileAt(m, M.houses.X[i], M.houses.Z[i]);
    assert.equal(geo.land[t.r * m.nx + t.c], adapter.LAND.homes);
  }
  // The scenery is the same every time it's read.
  assert.deepEqual(adapter.cityModel(geo, world).houses, M.houses);
  // Each store at its point.
  M.stores.forEach((s, i) => assert.deepEqual([s.X, s.Z], [geo.stores[i].x, -geo.stores[i].y]));
});

test("a mall's plan lies on its block of tiles, its storefronts in their own stores' colours", () => {
  const M = adapter.cityModel(geo, world);
  const v = world.macro.venues.find((x) => x.plan); const mv = M.venues.find((x) => x.name === v.name);
  const { cells, cell } = mv.plan;
  const n = (re) => v.plan.rows.join("").split("").filter((ch) => re.test(ch)).length;
  assert.equal(cells.wall.length, n(/#/)); assert.equal(cells.corridor.length, n(/\./)); assert.equal(cells.entrance.length, n(/E/)); assert.equal(cells.front.length, n(/[a-z]/));
  // Inside the block: every cell's middle in one of the venue's tiles.
  const m = M.frame; const tiles = new Set(v.tiles.map(([r, c]) => `${r},${c}`));
  for (const k of [...cells.wall, ...cells.corridor, ...cells.entrance, ...cells.front]) {
    const t = spatial.macroTileAt(m, k.X, k.Z); assert.ok(tiles.has(`${t.r},${t.c}`), `${t.r},${t.c}`);
  }
  // The plan's north-west cell is the block's north-west corner, cell_m in.
  const r0 = Math.min(...v.tiles.map((t) => t[0])); const c0 = Math.min(...v.tiles.map((t) => t[1]));
  const first = cells.wall[0];
  assert.deepEqual([first.X, first.Z], [c0 * m.patch + cell / 2, -(m.ny * m.patch - r0 * m.patch - cell / 2)]);
  // Storefront letters belong to the stores the world file names.
  for (const f of cells.front) assert.ok(Object.values(v.storefronts).includes(geo.stores[f.store].key));
  const letter = (k) => v.plan.rows.join("")[k];
  const fronts = v.plan.rows.join("").split("").map((ch, k) => k).filter((k) => /[a-z]/.test(letter(k)));
  fronts.forEach((k, i) => assert.equal(geo.stores[cells.front[i].store].key, v.storefronts[letter(k)]));
});

test("travellers by kind from a frame, in its order, at X = x, Z = −y; a car faces along its road", () => {
  const M = adapter.cityModel(geo, world);
  // Two road tiles: one on an east-west road, one on a north-south road.
  const m = M.frame; let ew = null; let ns = null;
  for (let r = 1; r < m.ny - 1 && (!ew || !ns); r++) for (let c = 1; c < m.nx - 1; c++) {
    const road = (a, b) => adapter.ROADS.has(geo.land[a * m.nx + b]);
    if (!road(r, c)) continue;
    if (!ew && road(r, c - 1) && road(r, c + 1) && !road(r - 1, c) && !road(r + 1, c)) ew = spatial.macroTileCentre(m, r, c);
    if (!ns && road(r - 1, c) && road(r + 1, c) && !road(r, c - 1) && !road(r, c + 1)) ns = spatial.macroTileCentre(m, r, c);
  }
  const t = { n: 5, x: [ew.X, ns.X, 100, 200, 300], y: [-ew.Z, -ns.Z, 110, 210, 310], brand: [1, 2, 3, 4, 5], back: [0, 1, 0, 0, 0], kind: [1, 1, 2, 3, 2] };
  const T = adapter.travellersOf(t, M);
  assert.deepEqual([T.car.n, T.walker.n, T.parked.n], [2, 2, 1]);
  assert.deepEqual([...T.car.X], [ew.X, ns.X].map(Math.fround)); assert.deepEqual([...T.car.Z], [ew.Z, ns.Z].map(Math.fround));
  assert.deepEqual([...T.walker.index], [2, 4]); assert.deepEqual([...T.walker.X], [100, 300]); assert.deepEqual([...T.walker.Z], [-110, -310]);
  assert.deepEqual([...T.car.back], [0, 1]); assert.deepEqual([...T.parked.brand], [4]);
  assert.ok(near(T.car.yaw[0], 0) && near(T.car.yaw[1], Math.fround(Math.PI / 2)));
  assert.deepEqual(adapter.travellersOf({ n: 0, x: [], y: [], brand: [], back: [], kind: [] }, M).car.n, 0);
});

test("a floor is read from the installed rows only when they are the picture plan_geometry() read", () => {
  const plan = planOf(flagship, keys);
  assert.equal(adapter.rowsForPlan(plan, flagship.rows, keys), flagship.rows);
  // Not the same picture: another size, or a rack moved.
  assert.equal(adapter.rowsForPlan(plan, flagship.rows.slice(1), keys), null);
  const moved = flagship.rows.map((r, i) => (i === 12 ? r.replace("RRRR", "....") : r));
  assert.equal(adapter.rowsForPlan(plan, moved, keys), null);
  // A character no category or fixture has.
  assert.equal(adapter.rowsToCodes(["#?#"], keys), null);

  const withRows = adapter.floorModel(plan, flagship.rows, keys);
  const codesOnly = adapter.floorModel(plan, null, keys);
  assert.ok(withRows.fromRows && !codesOnly.fromRows);
  const n = (re) => flagship.rows.join("").split("").filter((ch) => re.test(ch)).length;
  const C = withRows.cells;
  assert.deepEqual([C.cashier.length, C.behind.length, C.stock.length, C.stockDoor.length, C.frHead.length, C.frLine.length, C.tillHead.length, C.tillLine.length],
    [n(/c/), n(/:/), n(/X/), n(/x/), n(/W/), n(/w/), n(/Q/), n(/q/)]);
  assert.equal(C.queue.length, 0);
  // From the codes alone, the shared codes stay together.
  const K = codesOnly.cells;
  assert.deepEqual([K.behind.length, K.stock.length, K.queue.length, K.cashier.length, K.frHead.length], [n(/[:c]/), n(/[Xx]/), n(/[wWqQ]/), 0, 0]);
  // Either way the same racks, walls and doors, each where the picture has it.
  for (const k of ["rack", "wall", "door", "counter", "cubicle"]) assert.equal(C[k].length, K[k].length);
  for (const cell of C.rack) assert.equal(keys[cell.category - 1], flagship.rows[cell.r][cell.c]);
  // No mirroring: the stockroom (top left of the picture) is north-west, the door (bottom row) on the south wall.
  const f = withRows.frame;
  assert.ok(C.stock.every((s) => s.X < f.width / 2 && s.Z < -f.depth / 2));
  assert.ok(C.door.every((d) => near(d.Z, -0.25)));
  // A cubicle's block covers its F cells.
  for (const cell of C.cubicle) assert.ok(withRows.cubicles.some((b) => b.X0 < cell.X && cell.X < b.X1 && b.Z0 < cell.Z && cell.Z < b.Z1));
});

test("everyone on the floor from a frame: shoppers and staff at their patch's place, cubicles' states", () => {
  const plan = planOf(flagship, keys);
  const a = { n: 2, x: [10, 20.5], y: [5, 7.25], look: [1, 4], visit: [101, 102], staffN: 1, staffX: [60], staffY: [12], staffRole: [1], staffId: [1], staffBusy: [1], cubBusy: [1, 0], cubOpen: [1, 0] };
  const A = adapter.floorAgentsOf(a, plan);
  assert.deepEqual([A.shoppers.X[1], A.shoppers.Z[1]], [Math.fround(21 * 0.5), Math.fround(-7.75 * 0.5)]);
  assert.deepEqual([A.staff.X[0], A.staff.Z[0], A.staff.busy[0]], [30.25, -6.25, 1]);
  assert.deepEqual(A.cubicles, { n: 2, busy: [true, false], open: [true, false] });
});

// ---- The views ----------------------------------------------------------------------------------------

const homesXY = (() => {                                 // a household in the middle of every 50th home tile
  const xs = []; const ys = []; const m = { patch: geo.patch, nx: geo.nx, ny: geo.ny };
  geo.land.forEach((v, i) => { if (v === 3 && i % 50 === 0) { const t = spatial.macroTileCentre(m, Math.floor(i / geo.nx), i % geo.nx); xs.push(t.X); ys.push(-t.Z); } });
  return Int32Array.from([...xs, ...ys]);
})();

test("Market 3D: frames move the travellers and nothing else, one render per animation frame, none while hidden", () => {
  const { view, renderer } = makeView(Market3DView);
  view.setGeometry(geo, homesXY, world);
  view.setActive(true);
  dom.frames();
  assert.equal(view.staticBuilds, 1); assert.equal(renderer.calls, 1);
  const scenery = [...view.statics.children];
  // Thirty frames before the next animation frame: one render, the last frame's travellers.
  const store = geo.stores[0];
  for (let k = 0; k < 30; k++) view.setTravellers({ n: 3, x: [store.x + k, 500, 900], y: [store.y, 600, 950], brand: [1, 2, 3], back: [0, 0, 0], kind: [1, 2, 3] });
  dom.frames();
  assert.equal(renderer.calls, 2); assert.equal(view.staticBuilds, 1);
  assert.deepEqual(view.statics.children, scenery);
  const car = view.agents.car; const walker = view.agents.walker; const parked = view.agents.parked;
  assert.deepEqual([car.count, walker.count, parked.count], [1, 1, 1]);
  const p = translation(car, 0);
  assert.deepEqual([p.x, p.z], [store.x + 29, -store.y]);
  assert.deepEqual([translation(walker, 0).x, translation(walker, 0).z], [500, -600]);
  assert.deepEqual([translation(parked, 0).x, translation(parked, 0).z], [900, -950]);
  // In the 2D view (inactive), or with its tab hidden (no size): no rendering at all.
  view.setActive(false);
  view.setTravellers({ n: 0, x: [], y: [], brand: [], back: [], kind: [] }); dom.frames();
  assert.equal(renderer.calls, 2);
  view.setActive(true); dom.frames(); assert.equal(renderer.calls, 3);
  dom.resize(view.wrap, 0, 0);
  view.setTravellers({ n: 0, x: [], y: [], brand: [], back: [], kind: [] }); dom.frames();
  assert.equal(renderer.calls, 3);
  dom.resize(view.wrap, 800, 600); dom.frames();
  assert.equal(renderer.calls, 4); assert.equal(view.staticBuilds, 1);
  // More travellers than the meshes hold: they grow; still no scenery rebuilt.
  const n = 300;
  view.setTravellers({ n, x: Array.from({ length: n }, (_, i) => i * 10), y: Array.from({ length: n }, (_, i) => i * 5), brand: Array(n).fill(1), back: Array(n).fill(0), kind: Array(n).fill(1) });
  dom.frames();
  assert.equal(view.agents.car.count, n); assert.equal(view.staticBuilds, 1);
  assert.deepEqual([translation(view.agents.car, 299).x, translation(view.agents.car, 299).z], [2990, -1495]);
  // Households take the Market tab's colours; the stores' halos today's visits.
  view.setHomes(new Uint8Array(homesXY.length / 2).fill(2), "brand");
  view.setStores(geo.stores.map((_, i) => ({ visits: i, inside: 0, sales: 0, promo: i === 0 })));
  dom.frames();
  assert.equal(view.halos.count, geo.stores.length); assert.equal(view.staticBuilds, 1);
  assert.equal(view.storeLabels[0].node.textContent, `${geo.stores[0].short} %`);
  view.dispose();
});

test("Market 3D: a new installed world rebuilds the scenery and lets the old go; dispose() lets everything go", () => {
  const { view, renderer, wrap } = makeView(Market3DView);
  view.setGeometry(geo, homesXY, world); view.setActive(true); dom.frames();
  let disposed = 0;
  view.statics.traverse((o) => o.geometry?.addEventListener("dispose", () => disposed++));
  const before = view.statics.children.length;
  // Edits in the Setup tab's draft don't reach the view: only setGeometry (GEOMETRY, after a Setup) does.
  view.setTravellers({ n: 0, x: [], y: [], brand: [], back: [], kind: [] }); dom.frames();
  assert.equal(view.staticBuilds, 1);
  const next = structuredClone(geo); next.stores = next.stores.slice(0, 3);
  view.setGeometry(next, homesXY, world); dom.frames();
  assert.equal(view.staticBuilds, 2); assert.ok(disposed >= before - 2, `${disposed} of ${before}`);
  assert.equal(view.storeMesh.count, 3);
  const rendered = renderer.calls;
  let all = 0; let gone = 0;
  view.scene.traverse((o) => { if (o.geometry) { all++; o.geometry.addEventListener("dispose", () => gone++); } });
  view.dispose();
  assert.ok(renderer.disposed && renderer.lost);
  assert.ok(gone >= all - 1, `${gone} of ${all}`);
  assert.equal(view.canvas.listeners.get("pointerdown")?.length ?? 0, 0);
  assert.ok(!wrap.children.includes(view.canvas));
  view.setTravellers({ n: 0, x: [], y: [], brand: [], back: [], kind: [] });
  dom.frames(); assert.equal(renderer.calls, rendered);
});

test("Market 3D: a click on a store opens it; on the ground, picks the household nearest the point", () => {
  const picked = { store: null, home: null };
  const { view } = makeView(Market3DView, [800, 600], { onStore: (id) => { picked.store = id; }, onHome: (x, y) => { picked.home = [x, y]; } });
  view.setGeometry(geo, homesXY, world); view.setActive(true); dom.frames();
  const s = view.model.stores[4];
  view.controls.target.set(s.X, 0, s.Z); view.camera.position.set(s.X + 200, 400, s.Z + 300); view.controls.update(); view.cameraChanged();
  click(view, at(view, s.X, s.height, s.Z));
  assert.equal(picked.store, 5);
  // A drag is the camera's, not a click.
  picked.store = null;
  const ev = at(view, s.X, s.height, s.Z);
  view.canvas.dispatch("pointerdown", ev); view.canvas.dispatch("pointerup", { ...ev, clientX: ev.clientX + 40 });
  assert.equal(picked.store, null);
  // The ground 120 m south-east of the store: that point, in metres.
  click(view, at(view, s.X + 120, 0, s.Z + 120));
  assert.ok(picked.store === null && near(picked.home[0], geo.stores[4].x + 120, 0.5) && near(picked.home[1], geo.stores[4].y - 120, 0.5), String(picked.home));
  // The reset view goes back to the whole map.
  view.reset();
  assert.ok(near(view.controls.target.x, view.model.frame.width / 2) && near(view.controls.target.z, -view.model.frame.depth / 2));
  view.dispose();
});

test("Store 3D: the plan's fixtures, frames move shoppers and staff only, cubicles and racks recoloured in place", () => {
  const plan = planOf(flagship, keys);
  const { view, renderer } = makeView(Store3DView);
  view.setPlan(plan, flagship.rows, keys); view.setSells([1, 2, 3]); view.setActive(true); dom.frames();
  assert.equal(view.staticBuilds, 1);
  const named = Object.fromEntries(view.statics.children.filter((c) => c.name).map((c) => [c.name, c.count ?? 1]));
  const n = (re) => flagship.rows.join("").split("").filter((ch) => re.test(ch)).length;
  assert.equal(named.walls, n(/#/)); assert.equal(named.counter, n(/\$/)); assert.equal(named.stockroom, n(/X/)); assert.equal(named.cubicles, plan.cubicle_boxes.length);
  assert.equal(named.racks, n(new RegExp(`[${keys.join("")}]`)));
  // Racks of categories not sold are grey; selling another recolours them, no rebuild.
  const rack = view.rackMesh; const k = view.model.cells.rack.findIndex((r) => r.category === 5);
  const c0 = new THREE.Color(); rack.getColorAt(k, c0);
  view.setSells([1, 2, 3, 5]); dom.frames();
  const c1 = new THREE.Color(); rack.getColorAt(k, c1);
  assert.ok(!c0.equals(c1) && view.staticBuilds === 1);
  // A frame: shoppers and staff where it puts them.
  const a = { n: 2, x: [10, 20], y: [5, 7], look: [1, 4], visit: [101, 102], staffN: 2, staffX: [60, 30], staffY: [12, 20], staffRole: [1, 2], staffId: [1, 1], staffBusy: [1, 0],
    cubBusy: plan.cubicle_boxes.map((_, i) => (i === 0 ? 1 : 0)), cubOpen: plan.cubicle_boxes.map((_, i) => (i < 4 ? 1 : 0)), frQ: 0, tillQ: 0, receipts: 9, inStore: 2 };
  const calls = renderer.calls;
  for (let i = 0; i < 10; i++) view.setAgents(a);
  dom.frames();
  assert.equal(renderer.calls, calls + 1); assert.equal(view.staticBuilds, 1);
  const f = view.model.frame;
  const s1 = translation(view.meshes.shopper, 1); const w0 = translation(view.meshes.staff, 0);
  assert.deepEqual([s1.x, s1.z], [spatial.floorToScene(f, 20, 7).X, spatial.floorToScene(f, 20, 7).Z]);
  assert.deepEqual([w0.x, w0.z], [spatial.floorToScene(f, 60, 12).X, spatial.floorToScene(f, 60, 12).Z]);
  // Cubicles: busy, free and closed apart.
  const col = (i) => { const c = new THREE.Color(); view.cubicleMesh.getColorAt(i, c); return c.getHexString(); };
  assert.ok(col(0) !== col(1) && col(1) !== col(5) && col(0) !== col(5));
  assert.equal(view.receiptLabel.node.textContent, "9 receipts");
  // The followed shopper and the worker in the inspector, ringed where they stand.
  view.setFollow(102); view.setInspect({ kind: "assistant", server: 1 }); dom.frames();
  assert.ok(view.followRing.visible && near(view.followRing.position.x, s1.x) && near(view.followRing.position.z, s1.z));
  assert.ok(view.inspectRing.visible && near(view.inspectRing.position.x, spatial.floorToScene(f, 30, 20).X));
  // Heat on the floor, in heat mode only.
  view.setHeat(new Float64Array(plan.width * plan.height).fill(1)); dom.frames();
  assert.equal(view.heatPlane.visible, false);
  view.setMode("heat"); dom.frames();
  assert.equal(view.heatPlane.visible, true); assert.equal(view.staticBuilds, 1);
  // The same plan again changes nothing; another plan rebuilds.
  view.setPlan(plan, flagship.rows, keys); dom.frames(); assert.equal(view.staticBuilds, 1);
  const small = json("layouts/small.layout.json");
  view.setPlan(planOf(small, keys), small.rows, keys); dom.frames(); assert.equal(view.staticBuilds, 2);
  view.dispose();
  assert.ok(renderer.disposed);
});

test("Store 3D: a click on a shopper or a worker makes the 2D floor's call, at their place; on the floor, at the point", () => {
  const plan = planOf(flagship, keys);
  const calls = [];
  const { view } = makeView(Store3DView, [900, 560], { onClick: (x, y) => calls.push([x, y]) });
  view.setPlan(plan, flagship.rows, keys); view.setActive(true);
  view.setAgents({ n: 1, x: [20.4], y: [8.6], look: [2], visit: [7], staffN: 1, staffX: [44], staffY: [16], staffRole: [2], staffId: [1], staffBusy: [0], cubBusy: [], cubOpen: [] });
  dom.frames();
  const f = view.model.frame;
  const s = spatial.floorToScene(f, 20.4, 8.6); const w = spatial.floorToScene(f, 44, 16);
  click(view, at(view, s.X, 1.3, s.Z));
  click(view, at(view, w.X, 1.3, w.Z));
  const p = spatial.floorToScene(f, 5, 30);
  click(view, at(view, p.X, 0, p.Z));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].map((v) => Math.round(v * 100) / 100), [20.4, 8.6]);
  assert.deepEqual(calls[1], [44, 16]);
  assert.ok(near(calls[2][0], 5, 0.01) && near(calls[2][1], 30, 0.01), String(calls[2]));
  view.dispose();
});

test("the 2D/3D switch sends nothing to the simulation; without WebGL it stays in 2D and says why", async () => {
  const sent = []; const banners = [];
  const app = { view: (...a) => sent.push(["view", a]), action: (...a) => sent.push(["action", a]), set: (...a) => sent.push(["set", a]),
    client: { request: (...a) => sent.push(["request", a]), post: (...a) => sent.push(["post", a]) }, banner: (t, m) => banners.push(t) };
  const shown = [];
  let made = null;
  const sw = new ViewSwitch({ app, what: "Map", load: async () => ({ THREE }), supported: () => true, apply: (is3d) => shown.push(is3d),
    create: () => (made = makeView(Market3DView).view) });
  await sw.set("3d");
  assert.ok(sw.is3d && made && made.active && !sw.reset.hidden);
  await sw.set("2d");
  assert.ok(!sw.is3d && !made.active && sw.reset.hidden);
  await sw.set("3d");
  assert.deepEqual(shown, [true, false, true]);
  assert.deepEqual(sent, []);
  // Lost WebGL: back to 2D, the 3D view let go.
  made.onLost();
  assert.ok(!sw.is3d && sw.view === null && banners.length === 1);
  // No WebGL at all.
  const off = new ViewSwitch({ app, what: "Floor", load: async () => { throw new Error("must not load"); }, supported: () => false, apply: (is3d) => shown.push(is3d), create: () => null });
  await off.set("3d");
  assert.ok(!off.is3d && off.view === null && off.seg.root.children[1].disabled);
  assert.equal(banners.at(-1), "3D isn't available in this browser");
  assert.deepEqual(sent, []);
});

// ---- The camera: presets, moves, the compass, Focus --------------------------------------------------
//
//   - every preset's pose is worked out from what's installed and picked:
//     an area's tiles, a store's point in cityModel(), the floor's size,
//     the tills plan_geometry() places, a shopper where the live frame has
//     them by their visit's id; and in different worlds and floors
//   - with nothing picked (or nothing to frame) a preset is unavailable and
//     says why; wrong data is a CameraTargetError, thrown before the camera
//     moves, so it keeps its last valid pose
//   - a move eases over ~700 ms, drawn frame by frame and then no more;
//     grabbing the camera stops it where it is, another action replaces it;
//     hidden, it ends at once; disposed, nothing more is drawn
//   - the compass shows where north (−Z) is on screen and turns the view
//     to face it, keeping target, distance and height; Reset goes back to
//     the Overview; every move stays inside the controls' limits
//   - camera actions call nothing that reaches the simulation

const { CameraTargetError, View3D, TRANSITION_MS, easeInOut } = await import("../js/fashion/view-3d.js");
const { CameraBar, targetSelect } = await import("../js/fashion/camera-bar.js");
const strip = json("worlds/strip_mall.world.json");

// A view with a clock the test turns: run(ms) moves it on and draws the frames asked for.
function camView(View, opts = {}, size = [800, 600]) {
  const made = makeView(View, size, opts);
  let now = 1000;
  made.view.clock = () => now;
  made.run = (ms, step = 16) => { for (let t = 0; t < ms; t += step) { now += step; dom.frames(); } };
  return made;
}
const poseNear = (a, b, eps = 1e-6) => near(a.target.X, b.target.X, eps) && near(a.target.Y, b.target.Y, eps) && near(a.target.Z, b.target.Z, eps)
  && near(a.distance, b.distance, eps * Math.max(1, b.distance)) && near(a.polar, b.polar, eps) && near(Math.cos(a.azimuth - b.azimuth), 1, eps);
const onScreen = (view, X, Y, Z) => { const s = view.toScreen(X, Y, Z); return s.on && s.x >= -1 && s.y >= -1 && s.x <= view.wrap.clientWidth + 1 && s.y <= view.wrap.clientHeight + 1; };
// An area's tiles, counted from the world file itself (not the adapter).
function areaTilesOf(W, key) {
  const out = []; W.macro.area_tiles.forEach((row, r) => [...row].forEach((ch, c) => { if (ch === key) out.push({ r, c }); }));
  return out;
}

test("Market camera: Neighborhood frames the box round an area's own tiles, in worlds of different sizes; Street sits low round a store's cityModel() point", () => {
  for (const W of [world, strip]) {
    const g = geometryOf(W);
    const { view, run } = camView(Market3DView);
    view.setGeometry(g, new Int32Array(0), W); view.setActive(true); dom.frames();
    W.macro.areas.forEach((a, i) => {
      const tiles = areaTilesOf(W, a.key);
      const r = view.presetTarget("neighborhood", { area: i + 1 });
      if (!tiles.length) { assert.equal(r.ok, false); return; }
      const p = W.macro.patch_m; const ny = W.macro.tiles.length;
      const X0 = Math.min(...tiles.map((t) => t.c)) * p; const X1 = (Math.max(...tiles.map((t) => t.c)) + 1) * p;
      const Z0 = -(ny - Math.min(...tiles.map((t) => t.r))) * p; const Z1 = -(ny - Math.max(...tiles.map((t) => t.r)) - 1) * p;
      assert.ok(r.ok && near(r.pose.target.X, (X0 + X1) / 2) && near(r.pose.target.Z, (Z0 + Z1) / 2), `${W.name} ${a.name}`);
      assert.equal(r.label, `Neighborhood · ${a.name}`);
      view.goPreset("neighborhood", { area: i + 1 }); run(TRANSITION_MS + 100);
      assert.ok(poseNear(view.currentPose(), view.constrain(r.pose), 1e-4));
      // Every corner of the area's ground is on the canvas.
      for (const [X, Z] of [[X0, Z0], [X1, Z0], [X0, Z1], [X1, Z1]]) assert.ok(onScreen(view, X, 0, Z), `${W.name} ${a.name} corner ${X},${Z}`);
      assert.equal(view.cameraState.mode, "neighborhood");
    });
    // Street: round each store's own point, low, from the side the camera was already on.
    const before = view.currentPose().azimuth;
    view.model.stores.forEach((s, i) => {
      const r = view.presetTarget("street", { store: i + 1 });
      assert.ok(r.ok && r.pose.target.X === g.stores[i].x && r.pose.target.Z === -g.stores[i].y);
      assert.ok(near(Math.cos(r.pose.azimuth - before), 1, 1e-9));
      assert.ok(Math.PI / 2 - r.pose.polar < 0.45, "low: under 26° above the ground");
    });
    view.goPreset("street", { store: 2 }); run(TRANSITION_MS + 100);
    const s = view.model.stores[1];
    assert.ok(onScreen(view, s.X, s.height / 2, s.Z) && view.cameraState.label === `Street · ${g.stores[1].name}`);
    // Each Street distance is inside the controls' limits.
    assert.ok(view.distance >= view.controls.minDistance - 1e-9 && view.distance <= view.controls.maxDistance + 1e-9);
    view.dispose();
  }
});

test("Market camera: with nothing picked, Neighborhood and Street are unavailable and say why; wrong targets throw and leave the camera where it was", () => {
  const { view, run } = camView(Market3DView);
  // Nothing installed.
  assert.equal(view.presetTarget("overview").ok, false);
  assert.match(view.presetTarget("street", { store: 1 }).reason, /isn't installed/);
  view.setGeometry(geo, homesXY, world); view.setActive(true); dom.frames();
  for (const [name, args, re] of [["neighborhood", {}, /Pick an area/], ["street", {}, /Pick a store/], ["neighborhood", { area: null }, /Pick an area/]]) {
    const r = view.presetTarget(name, args);
    assert.ok(!r.ok && !r.defect && re.test(r.reason), `${name}: ${r.reason}`);
    const pose = view.currentPose();
    const out = view.goPreset(name, args);
    assert.ok(!out.ok && poseNear(view.currentPose(), pose) && !view.transition, "the camera doesn't move, nothing is substituted");
  }
  // An area with no tiles: listed, not pickable, and says so.
  const g = structuredClone(geo); g.areas.push({ id: "empty", name: "Nowhere", colour: "#000000", x: NaN, y: NaN });
  view.setGeometry(g, homesXY, world); dom.frames();
  const t = view.cameraTargets();
  assert.deepEqual(t.areas.map((a) => a.ok), g.areas.map((_, i) => i < g.areas.length - 1));
  const empty = view.presetTarget("neighborhood", { area: g.areas.length });
  assert.ok(!empty.ok && !empty.defect && /no tiles/.test(empty.reason));
  // No such area or store: a defect, thrown, the camera untouched.
  view.goPreset("street", { store: 3 }); run(TRANSITION_MS + 50);
  const last = view.currentPose();
  assert.throws(() => view.goPreset("neighborhood", { area: 99 }), (e) => e instanceof CameraTargetError && /no area 99/.test(e.message));
  assert.throws(() => view.goPreset("street", { store: 0 }), CameraTargetError);
  // A store not at a real point (corrupt geometry): thrown before any move.
  view.model.stores[4].X = NaN;
  assert.throws(() => view.goPreset("street", { store: 5 }), (e) => e instanceof CameraTargetError && /not a point/.test(e.message));
  assert.throws(() => view.animateTo({ target: { X: 1, Y: 0, Z: Infinity }, distance: 10, polar: 1, azimuth: 0 }), (e) => e instanceof CameraTargetError && /target Z = Infinity/.test(e.message));
  assert.throws(() => view.animateTo({ target: { X: 1, Y: 0, Z: 1 }, distance: 0, polar: 1, azimuth: 0 }), CameraTargetError);
  assert.ok(poseNear(view.currentPose(), last) && !view.transition && view.cameraState.mode === "street");
  // A geometry layer that isn't the map's size: a defect, not an empty area.
  const bad = structuredClone(geo); bad.area = bad.area.slice(1);
  view.setGeometry(bad, homesXY, world); dom.frames();
  const d = view.presetTarget("neighborhood", { area: 1 });
  assert.ok(d.defect && /area layer has/.test(d.reason));
  // runAction shows a defect (onCameraError) and logs it; it doesn't swallow it.
  const errors = []; view.onCameraError = (e) => errors.push(e);
  const quiet = console.error; console.error = () => {};
  try { view.runAction(() => view.goPreset("neighborhood", { area: 1 })); } finally { console.error = quiet; }
  assert.ok(errors.length === 1 && errors[0] instanceof CameraTargetError && /failed/.test(view.cameraState.note));
  view.onCameraError = null;
  assert.throws(() => { console.error = () => {}; try { view.runAction(() => view.goPreset("neighborhood", { area: 1 })); } finally { console.error = quiet; } }, CameraTargetError);
  view.dispose();
});

test("camera moves: eased over ~700 ms, drawn each frame and then not at all; a drag stops one where it is; another action replaces it", () => {
  const { view, run, renderer } = camView(Market3DView);
  view.setGeometry(geo, homesXY, world); view.setActive(true); dom.frames();
  const home = view.currentPose();
  const target = view.presetTarget("street", { store: 3 }).pose;
  view.goPreset("street", { store: 3 });
  assert.ok(view.transition && view.raf, "a move asks for a frame");
  // The first steps are near the start (slow in), the middle between, the end exact.
  run(48);
  const early = view.currentPose();
  assert.ok(early.distance < home.distance && early.distance > target.distance);
  assert.ok(Math.abs(early.target.X - home.target.X) < 0.05 * Math.abs(target.target.X - home.target.X));
  const calls = renderer.calls;
  run(TRANSITION_MS / 2 - 48);
  const mid = view.currentPose();
  assert.ok(renderer.calls > calls, "drawn while moving");
  assert.ok(Math.abs(mid.target.X - home.target.X) > 0.3 * Math.abs(target.target.X - home.target.X));
  // Labels are placed again each frame of the move.
  const placed = () => view.labels.filter((l) => !l.node.hidden).map((l) => [l, l.node.style.transform]);
  const before = placed();
  run(64);
  assert.ok(before.length && before.every(([l, t]) => l.node.style.transform !== t), "names move with the camera");
  run(TRANSITION_MS);
  assert.ok(poseNear(view.currentPose(), view.constrain(target), 1e-6) && !view.transition && view.raf === 0, "ended: no more frames asked for");
  const done = renderer.calls; run(500); assert.equal(renderer.calls, done, "nothing drawn once still");
  // Clip planes follow the distance through the move.
  assert.ok(view.camera.near <= view.distance / 100 && view.camera.far > view.distance);

  // A drag in the middle of a move: the move stops there and the camera is the user's.
  view.goPreset("overview"); run(TRANSITION_MS / 3);
  const r = view.canvas.getBoundingClientRect(); const x = r.left + 400; const y = r.top + 300;
  view.canvas.dispatch("pointerdown", pointer(x, y));
  assert.equal(view.transition, null);
  const grabbed = view.currentPose();
  run(TRANSITION_MS);
  assert.ok(poseNear(view.currentPose(), grabbed), "not dragged on to the Overview after the user took the camera");
  view.canvas.dispatch("pointermove", pointer(x + 60, y + 10));
  view.canvas.dispatch("pointerup", pointer(x + 60, y + 10, { buttons: 0 }));
  run(50);
  assert.equal(view.cameraState.mode, "manual");
  // The wheel and the arrow keys stop a move too.
  view.goPreset("overview"); run(100);
  view.canvas.dispatch("wheel", { deltaY: 100, deltaMode: 0, clientX: x, clientY: y, preventDefault() {}, ctrlKey: false });
  assert.equal(view.transition, null);
  view.goPreset("street", { store: 1 }); run(100);
  view.canvas.dispatch("keydown", { code: "ArrowLeft", key: "ArrowLeft", preventDefault() {} });
  assert.equal(view.transition, null);
  // Another action mid-move: the new move starts from where the camera is.
  view.goPreset("overview"); run(200);
  const at = view.currentPose();
  view.goPreset("street", { store: 5 });
  assert.ok(poseNear(view.transition.from, at), "replaced, from the camera's place");
  run(TRANSITION_MS + 50);
  assert.ok(poseNear(view.currentPose(), view.constrain(view.presetTarget("street", { store: 5 }).pose), 1e-6));
  assert.equal(view.cameraState.mode, "street");
  view.dispose();
});

test("camera moves: hidden mid-move, the camera ends where it was going and no frame is asked for; disposed mid-move, nothing more happens; out of the controls' limits, held to them", () => {
  const { view, run, renderer } = camView(Market3DView);
  view.setGeometry(geo, homesXY, world); view.setActive(true); dom.frames();
  view.goPreset("street", { store: 2 }); run(100);
  view.setActive(false);
  assert.ok(!view.transition && poseNear(view.currentPose(), view.constrain(view.presetTarget("street", { store: 2 }).pose), 1e-6));
  const calls = renderer.calls; run(300); assert.equal(renderer.calls, calls);
  // While hidden, an action goes there at once.
  view.goPreset("overview");
  assert.ok(!view.transition && poseNear(view.currentPose(), view.home.pose, 1e-6));
  // A tab with no size: the move waits, and ends on the first frame drawn after the time is up.
  view.setActive(true); dom.frames();
  view.goPreset("street", { store: 4 }); dom.resize(view.wrap, 0, 0); run(TRANSITION_MS * 2);
  dom.resize(view.wrap, 800, 600); run(16);
  assert.ok(!view.transition && poseNear(view.currentPose(), view.constrain(view.presetTarget("street", { store: 4 }).pose), 1e-6));
  // Limits: nearer than allowed, or under the lowest angle, is held to them.
  const p = view.currentPose();
  view.animateTo({ ...p, distance: view.controls.minDistance / 10, polar: 1.55 }, { duration: 0 });
  assert.ok(near(view.distance, view.controls.minDistance, 1e-6) && near(view.currentPose().polar, view.controls.maxPolarAngle, 1e-6));
  view.animateTo({ ...p, distance: view.controls.maxDistance * 10, polar: 0 }, { duration: 0 });
  assert.ok(near(view.distance, view.controls.maxDistance, 1e-3) && near(view.currentPose().polar, view.controls.minPolarAngle, 1e-6));
  // Disposed mid-move.
  view.goPreset("street", { store: 1 }); run(50);
  view.dispose();
  assert.ok(!view.transition && view.raf === 0);
  const after = renderer.calls; run(500); assert.equal(renderer.calls, after);
  assert.ok(!view.wrap.children.includes(view.compass));
});

test("the compass: N points where north (−Z) is on screen, from any side and from overhead; a click turns the view to face north, keeping target, distance and height; Reset goes to the Overview", () => {
  const { view, run } = camView(Store3DView);
  const plan = planOf(flagship, keys);
  view.setPlan(plan, flagship.rows, keys); view.setActive(true); dom.frames();
  assert.equal(view.compass.hidden, false);
  const t = view.home.pose.target;
  // Where north is on screen: from the target a step toward −Z, clockwise from up.
  const northOnScreen = () => {
    const a = view.toScreen(t.X, t.Y, t.Z); const b = view.toScreen(t.X, t.Y, t.Z - 0.01);
    return ((Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI) + 360) % 360;
  };
  const apart = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
  for (const polar of [view.controls.minPolarAngle, 0.6, 1.2]) {
    for (const az of [0, 0.7, Math.PI / 2, 2.5, Math.PI, -2, -Math.PI / 2]) {
      view.animateTo({ target: { ...t }, distance: 20, polar, azimuth: az }, { duration: 0 });
      const screen = northOnScreen(); const needle = view.compassHeading;
      assert.equal(view.needle.style.transform, `rotate(${needle >= 359.95 ? "0.0" : needle.toFixed(1)}deg)`);
      // The heading: exactly where north is from overhead, and facing north, east, south or west.
      const cardinal = [0, Math.PI / 2, Math.PI, -Math.PI / 2].some((c) => near(Math.cos(az - c), 1, 1e-12));
      if (polar === view.controls.minPolarAngle) assert.ok(apart(screen, needle) < 0.2, `overhead, azimuth ${az}: north at ${screen.toFixed(2)}°, needle ${needle.toFixed(2)}°`);
      else if (cardinal) assert.ok(apart(screen, needle) < 0.01, `polar ${polar} azimuth ${az}: north at ${screen.toFixed(2)}°, needle ${needle.toFixed(2)}°`);
      // Otherwise the same quarter of the dial (the ground's slant leans it toward the nearest of those).
      else assert.ok(Math.floor(screen / 90) === Math.floor(needle / 90) && apart(screen, needle) < 45, `polar ${polar} azimuth ${az}: north at ${screen.toFixed(1)}°, needle ${needle.toFixed(1)}°`);
      assert.ok(near(needle, ((az * 180 / Math.PI) + 360) % 360, 1e-9));
    }
  }
  // Facing east, then the compass: facing north, the rest kept, through a move.
  view.animateTo({ target: { X: 5, Y: 0.85, Z: -6 }, distance: 9, polar: 0.9, azimuth: -Math.PI / 2 }, { duration: 0 });
  view.compass.dispatch("click");
  assert.ok(view.transition);
  run(TRANSITION_MS / 2);
  const mid = view.currentPose();
  assert.ok(near(mid.distance, 9, 1e-6) && near(mid.polar, 0.9, 1e-6) && near(mid.target.X, 5) && near(mid.target.Z, -6), "turns round the target, at the same distance and height");
  run(TRANSITION_MS);
  const n = view.currentPose();
  assert.ok(near(n.azimuth, 0, 1e-9) && near(n.distance, 9, 1e-6) && near(n.polar, 0.9, 1e-9) && near(n.target.Y, 0.85));
  assert.ok(near(view.compassHeading % 360, 0, 1e-6) && view.cameraState.mode === "north");
  // North of the target is straight up the screen now.
  const a = view.toScreen(5, 0, -6); const b = view.toScreen(5, 0, -10);
  assert.ok(Math.abs(b.x - a.x) < 1e-6 && b.y < a.y);
  assert.ok(view.faceNorth().already && /Already facing north/.test(view.cameraState.note));
  // Reset (the 2D/3D switch's button): back to the Overview, by a move.
  const sw = new ViewSwitch({ app: { banner() {} }, what: "Floor", load: async () => ({}), supported: () => true, apply() {}, create: () => view });
  sw.view = view;
  sw.reset.click();
  assert.ok(view.transition);
  run(TRANSITION_MS + 50);
  assert.ok(poseNear(view.currentPose(), view.home.pose, 1e-6) && view.cameraState.mode === "overview");
  view.dispose();
});

// A floor drawn for a test: rows of the layout characters, read as plan_geometry() reads them.
const floorOf = (rows) => planOf({ id: "test", name: "Test", rows }, keys);
const wall = (w) => "#".repeat(w);
const pad = (s, w) => `#${s}${".".repeat(w - 2 - s.length)}#`;

test("Store camera: Top-down shows the whole floor from overhead, north up, on floors of different sizes; Overview is where the view opened", () => {
  for (const L of ["flagship", "standard", "small", "intimates"].map((id) => json(`layouts/${id}.layout.json`))) {
    for (const size of [[800, 600], [420, 640]]) {
      const plan = planOf(L, keys);
      const { view, run } = camView(Store3DView, {}, size);
      view.setPlan(plan, L.rows, keys); view.setActive(true); dom.frames();
      const r = view.goPreset("topdown"); run(TRANSITION_MS + 50);
      const p = view.currentPose(); const f = view.model.frame;
      assert.ok(r.ok && near(p.polar, view.controls.minPolarAngle, 1e-9) && near(p.azimuth, 0, 1e-9) && near(p.target.X, f.width / 2) && near(p.target.Z, -f.depth / 2));
      for (const [X, Z] of [[0, 0], [f.width, 0], [0, -f.depth], [f.width, -f.depth]]) assert.ok(onScreen(view, X, 0, Z), `${L.id} ${size}: corner ${X},${Z}`);
      // Every fixture and agent standing on the floor is under it, so in view.
      for (const c of view.model.cells.counter) assert.ok(onScreen(view, c.X, 1, c.Z));
      view.goPreset("overview"); run(TRANSITION_MS + 50);
      assert.ok(poseNear(view.currentPose(), view.home.pose, 1e-6));
      view.dispose();
    }
  }
});

test("Store camera: Shopper looks low at the inspector's shopper, found by visit id in the live frame — unavailable when not selected, not live, or not there; a defect when the frame contradicts itself", () => {
  const plan = planOf(flagship, keys);
  const { view, run } = camView(Store3DView);
  view.setPlan(plan, flagship.rows, keys); view.setActive(true); dom.frames();
  const sel = { kind: "shopper", visit: 202 };
  const frame = (xs, visits) => ({ n: xs.length, x: xs.map((p) => p[0]), y: xs.map((p) => p[1]), look: xs.map(() => 1), visit: visits,
    staffN: 1, staffX: [60], staffY: [12], staffRole: [1], staffId: [1], staffBusy: [0], cubBusy: [], cubOpen: [] });
  assert.match(view.presetTarget("shopper", {}).reason, /Select a shopper/);
  assert.match(view.presetTarget("shopper", { selection: { kind: "cashier", server: 1 } }).reason, /Select a shopper/);
  view.setAgents(frame([[10, 5], [20, 7]], [201, 202]));
  assert.match(view.presetTarget("shopper", { selection: sel }).reason, /isn't drawn live/);
  view.setLive(true);
  const r = view.presetTarget("shopper", { selection: sel });
  const f = view.model.frame;
  assert.ok(r.ok && near(r.pose.target.X, spatial.floorToScene(f, 20, 7).X) && near(r.pose.target.Z, spatial.floorToScene(f, 20, 7).Z));
  assert.ok(r.pose.distance < 8 && Math.PI / 2 - r.pose.polar < 0.5);
  // By visit, never by place: the same visit first in the next frame.
  view.setAgents(frame([[30, 9], [10, 5]], [202, 201]));
  const r2 = view.presetTarget("shopper", { selection: sel });
  assert.ok(near(r2.pose.target.X, spatial.floorToScene(f, 30, 9).X));
  view.goPreset("shopper", { selection: sel }); run(TRANSITION_MS + 50);
  assert.ok(onScreen(view, r2.pose.target.X, 1, r2.pose.target.Z) && view.cameraState.label === "Shopper · visit #202");
  // Not in the frame: a normal state, said plainly.
  view.setAgents(frame([[10, 5]], [201]));
  const gone = view.presetTarget("shopper", { selection: sel });
  assert.ok(!gone.ok && !gone.defect && /isn't on this floor/.test(gone.reason));
  // In it twice, or at no real point: the frame is wrong.
  view.setAgents(frame([[10, 5], [11, 5]], [202, 202]));
  assert.ok(view.presetTarget("shopper", { selection: sel }).defect);
  view.setAgents(frame([[NaN, 5]], [202]));
  const nan = view.presetTarget("shopper", { selection: sel });
  assert.ok(nan.defect && /not a point/.test(nan.reason));
  const pose = view.currentPose();
  assert.throws(() => view.goPreset("shopper", { selection: sel }), CameraTargetError);
  assert.ok(poseNear(view.currentPose(), pose));
  // No frame since the store changed.
  view.setAgents(null);
  assert.match(view.presetTarget("shopper", { selection: sel }).reason, /No live frame/);
  view.dispose();
});

test("Store camera: Checkout frames the tills plan_geometry() places, their counters and the till queue (its line only from the installed rows); several till zones together or one by one; none is unavailable; a till off any till cell is a defect", () => {
  const plan = planOf(flagship, keys);
  const { view, run } = camView(Store3DView);
  view.setPlan(plan, flagship.rows, keys); view.setActive(true); dom.frames();
  const g = view.checkout;
  assert.equal(g.problem, null);
  assert.equal(g.zones.length, 1);
  assert.deepEqual(g.zones[0].tills, plan.tills.map((_, i) => i + 1));
  const n = (re) => flagship.rows.join("").split("").filter((ch) => re.test(ch)).length;
  assert.equal(g.zones[0].cells, n(/[$:c]/));
  assert.equal(g.queue.line.length, n(/[qQ]/));
  const r = view.goPreset("checkout"); run(TRANSITION_MS + 50);
  assert.ok(r.ok && r.label === "Checkout" && !r.note);
  const f = view.model.frame;
  for (const [x, y] of plan.tills) { const p = spatial.floorToScene(f, x, y); assert.ok(onScreen(view, p.X, 1, p.Z), `till at ${x},${y}`); }
  for (const q of [...view.model.cells.tillLine, ...view.model.cells.tillHead]) assert.ok(onScreen(view, q.X, 0, q.Z), `queue cell ${q.r},${q.c}`);
  // Tighter than the whole floor.
  assert.ok(view.distance < view.home.pose.distance);
  // Without the installed rows: the head only, and it says so; the shared queue code isn't read as the till queue's line.
  const { view: v2 } = camView(Store3DView);
  v2.setPlan(plan, null, keys); v2.setActive(true); dom.frames();
  assert.ok(v2.checkout.queue.head && v2.checkout.queue.line === null);
  const r2 = v2.presetTarget("checkout");
  assert.ok(r2.ok && /head/.test(r2.note));
  // Framed from what is known: every till and the queue's head on the canvas.
  v2.goPreset("checkout"); v2.animateTo(r2.pose, { duration: 0 });
  const hb = v2.checkout.queue.head;
  assert.ok(onScreen(v2, (hb.X0 + hb.X1) / 2, 0, (hb.Z0 + hb.Z1) / 2), "the queue's head");
  for (const [x, y] of plan.tills) { const p = spatial.floorToScene(v2.model.frame, x, y); assert.ok(onScreen(v2, p.X, 1, p.Z), `till at ${x},${y}`); }
  // No queue head in the data at all: the tills alone, and it says so.
  const noHead = { ...plan }; delete noHead.till_head;
  v2.setPlan(noHead, null, keys);
  assert.match(v2.presetTarget("checkout").note, /no place for the till queue/);
  v2.dispose();

  // Two counters close together: one framing for both, Every till.
  const W = 40;
  const close = floorOf([wall(W), pad("$:c:#$:c:", W), pad("$:::#$:::", W), pad("", W), pad(".....qqQ", W), pad("", W), "#".repeat(18) + "==" + "#".repeat(20)]);
  view.setPlan(close, null, keys);
  const ch = view.checkoutChoices();
  assert.ok(ch.zones.length === 2 && ch.together);
  assert.deepEqual(ch.zones.map((z) => z.label), ["Till 1", "Till 2"]);
  const both = view.presetTarget("checkout");
  assert.ok(both.ok && both.label === "Checkout · every till");
  const one = view.presetTarget("checkout", { zone: 2 });
  assert.ok(one.ok && one.label === "Checkout · Till 2" && /every till together/.test(one.note));
  assert.ok(one.pose.target.X > both.pose.target.X, "zone 2 is the eastern counter");
  // Far apart: no framing of both at once, so one must be picked.
  const far = floorOf([wall(70), pad(`$:c:${".".repeat(58)}$:c:`, 70), pad(`$:::${".".repeat(58)}$:::`, 70), pad("", 70), pad(".".repeat(30) + "qqQ", 70), pad("", 70), "#".repeat(30) + "==" + "#".repeat(38)]);
  view.setPlan(far, null, keys);
  assert.ok(!view.checkoutChoices().together);
  const pick = view.presetTarget("checkout");
  assert.ok(!pick.ok && !pick.defect && /pick a till zone/.test(pick.reason));
  const west = view.presetTarget("checkout", { zone: 1 });
  assert.ok(west.ok && west.pose.target.X < view.model.frame.width / 4);
  assert.ok(view.presetTarget("checkout", { zone: 3 }).defect);
  // No till at all: unavailable, and why.
  const none = floorOf([wall(20), pad("", 20), pad("", 20), "#".repeat(8) + "==" + "#".repeat(10)]);
  view.setPlan(none, null, keys);
  const nt = view.presetTarget("checkout");
  assert.ok(!nt.ok && !nt.defect && /no till/.test(nt.reason));
  assert.deepEqual(view.checkoutChoices(), { zones: [], together: false });
  // A till plan_geometry() puts on a cell that isn't a cashier's place: the data contradicts itself.
  const bad = { ...planOf(flagship, keys), tills: [[1, 1]] };
  const quiet = console.error; console.error = () => {};
  try { view.setPlan(bad, null, keys); } finally { console.error = quiet; }
  const d = view.presetTarget("checkout");
  assert.ok(d.defect && /not a cashier's place/.test(d.reason));
  assert.throws(() => view.goPreset("checkout"), CameraTargetError);
  const badHead = { ...planOf(flagship, keys), till_head: [1.5, "x"] };
  console.error = () => {};
  try { view.setPlan(badHead, null, keys); } finally { console.error = quiet; }
  assert.ok(view.presetTarget("checkout").defect);
  view.dispose();
});

test("Focus turns to the selection keeping the camera's direction and height, changes no selection, and calls nothing; with several targets it aims at the one selected", () => {
  const calls = [];
  const { view, run } = camView(Market3DView, { onStore: (...a) => calls.push(["store", a]), onHome: (...a) => calls.push(["home", a]) });
  view.setGeometry(geo, homesXY, world); view.setActive(true); dom.frames();
  view.animateTo({ ...view.currentPose(), azimuth: 1.1, polar: 0.8 }, { duration: 0 });
  assert.match(view.focusTarget(null).reason, /Select an area, a store or a household/);
  assert.match(view.focusTarget({ kind: "household" }).reason, /No household is picked/);
  const s = geo.stores[6];
  view.focus({ kind: "store", store: 7 }); run(TRANSITION_MS + 50);
  let p = view.currentPose();
  assert.ok(near(p.target.X, s.x) && near(p.target.Z, -s.y) && near(p.azimuth, 1.1, 1e-9) && near(p.polar, 0.8, 1e-9));
  view.setSelected({ x: 1234, y: 2345 });
  view.focus({ kind: "household", id: 9 }); run(TRANSITION_MS + 50);
  p = view.currentPose();
  assert.ok(near(p.target.X, 1234) && near(p.target.Z, -2345) && near(p.azimuth, 1.1, 1e-9) && view.cameraState.label === "Focus · household #9");
  view.focus({ kind: "area", area: 2 }); run(TRANSITION_MS + 50);
  const box = adapter.areaExtent(geo, 2).box;
  for (const [X, Z] of [[box.X0, box.Z0], [box.X1, box.Z1]]) assert.ok(onScreen(view, X, 0, Z));
  assert.deepEqual(view.selected, { x: 1234, y: 2345 }, "the household picked stays picked");
  view.setSelected({ x: NaN, y: 3 });
  assert.ok(view.focusTarget({ kind: "household" }).defect);
  assert.deepEqual(calls, []);
  view.dispose();

  // On a floor: the shopper or the worker in the inspector, where the live frame has them.
  const plan = planOf(flagship, keys);
  const st = camView(Store3DView, { onClick: (...a) => calls.push(["click", a]) });
  st.view.setPlan(plan, flagship.rows, keys); st.view.setActive(true); st.view.setLive(true);
  st.view.setAgents({ n: 1, x: [20], y: [8], look: [1], visit: [7], staffN: 2, staffX: [44, 50], staffY: [16, 4], staffRole: [1, 2], staffId: [1, 1], staffBusy: [0, 1], cubBusy: [], cubOpen: [] });
  dom.frames();
  st.view.animateTo({ ...st.view.currentPose(), azimuth: -0.4, polar: 1.0 }, { duration: 0 });
  st.view.focus({ kind: "assistant", server: 1 }); st.run(TRANSITION_MS + 50);
  const a = spatial.floorToScene(st.view.model.frame, 50, 4);
  p = st.view.currentPose();
  assert.ok(near(p.target.X, a.X) && near(p.target.Z, a.Z) && near(p.azimuth, -0.4, 1e-9) && near(p.polar, 1.0, 1e-9));
  assert.ok(!st.view.focusTarget({ kind: "cashier", server: 2 }).ok);
  assert.deepEqual(calls, []);
  st.view.dispose();
});

test("after camera moves, clicks still pick what's under the pointer; a new world or floor puts the camera back at the Overview", () => {
  const picked = [];
  const { view, run } = camView(Market3DView, { onStore: (id) => picked.push(id) });
  view.setGeometry(geo, homesXY, world); view.setActive(true); dom.frames();
  view.goPreset("street", { store: 5 }); run(TRANSITION_MS + 50);
  const s = view.model.stores[4];
  click(view, at(view, s.X, s.height, s.Z));
  assert.deepEqual(picked, [5]);
  // A new installed world mid-move: no move left over, the new world's Overview.
  view.goPreset("street", { store: 2 }); run(100);
  const next = structuredClone(geo); next.stores = next.stores.slice(0, 4);
  view.setGeometry(next, homesXY, world);
  assert.ok(!view.transition && view.cameraState.mode === "overview" && poseNear(view.currentPose(), view.home.pose, 1e-6));
  view.dispose();
  const plan = planOf(flagship, keys);
  const st = camView(Store3DView);
  st.view.setPlan(plan, flagship.rows, keys); st.view.setActive(true); dom.frames();
  st.view.goPreset("topdown"); st.run(100);
  const small = json("layouts/small.layout.json");
  st.view.setPlan(planOf(small, keys), small.rows, keys);
  assert.ok(!st.view.transition && st.view.cameraState.mode === "overview" && near(st.view.currentPose().target.X, st.view.model.frame.width / 2));
  st.view.dispose();
});

test("the camera bar: an unavailable action stays focusable, says why (title, read-out, under the bar) and doesn't run; the preset showing is pressed", () => {
  const ran = [];
  const bar = new CameraBar({ label: "Test camera", presets: [{ id: "overview", label: "Overview", title: "o" }, { id: "street", label: "Street", title: "s" }],
    onPreset: (id) => ran.push(id), onFocus: () => ran.push("focus"), onStop: () => ran.push("stop") });
  const button = (label) => bar.root.find((n) => n.tagName === "BUTTON" && n.textContent === label);
  bar.setAvailable("street", { ok: false, reason: "Pick a store for the street view." });
  const b = button("Street");
  assert.equal(b.getAttribute("aria-disabled"), "true");
  assert.equal(b.title, "Pick a store for the street view.");
  assert.equal(b.disabled, false, "still focusable");
  const why = bar.root.find((n) => n.attributes?.get("id") === b.getAttribute("aria-describedby"));
  assert.match(why.textContent, /Unavailable: Pick a store/);
  assert.match(bar.note.textContent, /Street: Pick a store/);
  bar.setState({ mode: "overview", label: "Overview", note: "" });
  b.click();
  assert.deepEqual(ran, []);
  assert.equal(bar.status.textContent, "Camera: Overview — Pick a store for the street view.");
  // Refreshed each frame with the same state: the reason stays up.
  for (let i = 0; i < 3; i++) bar.setState({ mode: "overview", label: "Overview", note: "" });
  assert.match(bar.status.textContent, /Pick a store/);
  bar.setAvailable("street", { ok: true });
  b.click(); button("Overview").click(); button("Focus").click();
  assert.deepEqual(ran, ["street", "overview", "focus"]);
  assert.equal(bar.note.hidden, true);
  bar.setState({ mode: "street", label: "Street · Shop", note: "" });
  assert.deepEqual([button("Overview").getAttribute("aria-pressed"), b.getAttribute("aria-pressed")], ["false", "true"]);
  assert.equal(bar.status.textContent, "Camera: Street · Shop");
  bar.setState({ mode: "manual", label: "Moved by hand", note: "" });
  assert.equal(b.getAttribute("aria-pressed"), "false");
  // A target picker: nothing picked at first; an unpickable choice can't be kept.
  const changes = [];
  const sel = targetSelect({ label: "Area", placeholder: "Pick an area…", onChange: (v) => changes.push(v) });
  assert.equal(sel.setOptions([{ value: 1, label: "A" }, { value: 2, label: "B", disabled: true }], 2), null);
  assert.equal(sel.setOptions([{ value: 1, label: "A" }, { value: 2, label: "B" }], 2), 2);
  assert.equal(sel.setOptions([{ value: 1, label: "A" }], 2), null, "gone from the new world: nothing picked");
  sel.node.value = "1"; sel.node.dispatch("change");
  sel.node.value = ""; sel.node.dispatch("change");
  assert.deepEqual(changes, [1, null]);
});

test("easing and steps: slow in and out, a pose half-way is between, the short way round", () => {
  assert.ok(near(View3D.lerpPose({ target: { X: 0, Y: 0, Z: 0 }, distance: 10, polar: 1, azimuth: 3 }, { target: { X: 10, Y: 0, Z: 0 }, distance: 1000, polar: 0.5, azimuth: -3 }, 0.5).distance, 100));
  const half = View3D.lerpPose({ target: { X: 0, Y: 0, Z: 0 }, distance: 10, polar: 1, azimuth: 3 }, { target: { X: 10, Y: 0, Z: 0 }, distance: 10, polar: 0.5, azimuth: -3 }, 0.5);
  assert.ok(near(half.target.X, 5) && near(half.polar, 0.75) && Math.abs(Math.sin(half.azimuth)) < 1e-9 && Math.cos(half.azimuth) < 0, "through south-west-ish π, not round through 0");
  assert.ok(easeInOut(0) === 0 && easeInOut(1) === 1 && near(easeInOut(0.5), 0.5) && easeInOut(0.1) < 0.1 && easeInOut(0.9) > 0.9);
});

// ---- Following a shopper with the camera ---------------------------------------------------------------
//
//   - Follow starts only for a shopper in the inspector who is in the
//     current live frame, found by their visit's id, never their place in it
//   - the camera moves round them, then keeps its offset from them as each
//     frame moves them; the user can still turn and zoom, not pan
//   - it stops, leaving the camera where it is and the controls as they
//     were, when: Stop follow; a live frame without the visit ("Shopper no
//     longer visible in this store."); another preset, Reset or Focus; the
//     floor changes; the view is hidden or disposed; the floor stops being
//     live
//   - a malformed frame, or one with the visit twice, stops it as an error,
//     shown and logged, not as a departure

const followFrame = (pts, visits, extra = {}) => ({ n: pts.length, x: pts.map((p) => p[0]), y: pts.map((p) => p[1]), look: pts.map(() => 2), visit: visits,
  staffN: 1, staffX: [60], staffY: [12], staffRole: [1], staffId: [1], staffBusy: [0], cubBusy: [], cubOpen: [], frQ: 0, tillQ: 0, receipts: 0, inStore: pts.length, ...extra });

function followView() {
  const plan = planOf(flagship, keys);
  const made = camView(Store3DView);
  made.view.setPlan(plan, flagship.rows, keys); made.view.setActive(true); made.view.setLive(true);
  made.view.setAgents(followFrame([[10, 5], [20, 7], [30, 9]], [301, 302, 303]));
  dom.frames();
  made.f = made.view.model.frame;
  return made;
}

test("Follow camera: starts round the inspector's shopper, found by visit id; unavailable (and why) when not a shopper, not live or not in the frame; a defect when the frame contradicts itself", () => {
  const { view, run, f } = followView();
  assert.match(view.followCamera(null).reason, /Select a shopper/);
  assert.match(view.followCamera({ kind: "cashier", server: 1 }).reason, /Select a shopper/);
  assert.ok(!view.followCamera({ kind: "shopper", visit: 999 }).ok && view.tracking === null);
  view.setLive(false);
  assert.match(view.followCamera({ kind: "shopper", visit: 302 }).reason, /isn't drawn live/);
  view.setLive(true);
  view.setAgents(followFrame([[10, 5], [20, 7]], [302, 302]));
  assert.throws(() => view.followCamera({ kind: "shopper", visit: 302 }), CameraTargetError);
  assert.equal(view.tracking, null);
  view.setAgents(followFrame([[10, 5], [20, 7], [30, 9]], [301, 302, 303]));
  const r = view.followCamera({ kind: "shopper", visit: 302 });
  assert.ok(r.ok && view.tracking.id === 302 && view.cameraState.mode === "follow" && view.controls.enablePan === false);
  assert.equal(view.trackBadge.hidden, false);
  assert.match(view.trackBadge.textContent, /visit #302/);
  run(TRANSITION_MS + 50);
  const at = spatial.floorToScene(f, 20, 7);
  assert.ok(near(view.controls.target.x, at.X) && near(view.controls.target.z, at.Z) && view.distance < 8);
  view.dispose();
});

test("Follow camera: each live frame moves the camera with the shopper (by visit id, wherever they are in the frame's order), keeping its offset; the user can turn and zoom, not pan", () => {
  const { view, run, f } = followView();
  view.followCamera({ kind: "shopper", visit: 302 }); run(TRANSITION_MS + 50);
  const offset = () => view.camera.position.clone().sub(view.controls.target);
  const o0 = offset();
  // Across racks, the fitting rooms, the queue and a till: frame after frame, in a different order each time.
  const path = [[22, 8], [25, 12], [41.5, 30], [50, 20], [56, 14], [60, 10]];
  path.forEach(([x, y], k) => {
    const others = [[10, 5 + k], [30, 9]];
    const order = k % 2 ? [[x, y], ...others] : [...others, [x, y]];
    const visits = k % 2 ? [302, 301, 303] : [301, 303, 302];
    view.setAgents(followFrame(order, visits)); dom.frames();
    const p = spatial.floorToScene(f, x, y);
    assert.ok(near(view.controls.target.x, p.X) && near(view.controls.target.z, p.Z), `frame ${k}: on the shopper`);
    assert.ok(offset().distanceTo(o0) < 1e-9, `frame ${k}: the same offset`);
    assert.ok(onScreen(view, p.X, 1, p.Z));
  });
  // Frames during the move in: the move ends on the shopper where they are now.
  view.followCamera({ kind: "shopper", visit: 301 });
  run(200);
  view.setAgents(followFrame([[12, 6], [30, 9], [60, 10]], [301, 303, 302]));
  run(TRANSITION_MS);
  const p1 = spatial.floorToScene(f, 12, 6);
  assert.ok(view.tracking.id === 301 && near(view.controls.target.x, p1.X) && near(view.controls.target.z, p1.Z));
  // Turning by the pointer and zooming by the wheel keep following; panning is off.
  const r = view.canvas.getBoundingClientRect(); const x = r.left + 400; const y = r.top + 300;
  view.canvas.dispatch("pointerdown", pointer(x, y)); view.canvas.dispatch("pointermove", pointer(x + 50, y)); view.canvas.dispatch("pointerup", pointer(x + 50, y, { buttons: 0 }));
  view.canvas.dispatch("wheel", { deltaY: -100, deltaMode: 0, clientX: x, clientY: y, preventDefault() {}, ctrlKey: false });
  const turned = offset();
  assert.ok(view.tracking && view.cameraState.mode === "follow" && turned.distanceTo(o0) > 0.01);
  assert.ok(near(view.controls.target.x, p1.X) && near(view.controls.target.z, p1.Z), "zooming while following zooms round the shopper, not toward the pointer");
  assert.equal(view.controls.zoomToCursor, false);
  // Shift + arrow keys turn the camera too (the controls ignore keys while panning is off).
  const az = view.currentPose().azimuth;
  view.canvas.dispatch("keydown", { code: "ArrowLeft", key: "ArrowLeft", shiftKey: true, preventDefault() {} });
  assert.ok(view.currentPose().azimuth < az && view.tracking);
  const kept = offset();
  view.setAgents(followFrame([[14, 6], [30, 9], [60, 10]], [301, 303, 302])); dom.frames();
  assert.ok(offset().distanceTo(kept) < 1e-9 && near(view.controls.target.x, spatial.floorToScene(f, 14, 6).X), "the turned offset is kept");
  // A right-drag (pan) doesn't move the target off the shopper.
  const t = view.controls.target.clone();
  view.canvas.dispatch("pointerdown", pointer(x, y, { button: 2 })); view.canvas.dispatch("pointermove", pointer(x + 80, y + 40, { button: 2, buttons: 2 })); view.canvas.dispatch("pointerup", pointer(x + 80, y + 40, { button: 2, buttons: 0 }));
  assert.ok(view.controls.target.distanceTo(t) < 1e-9);
  // The compass turns round the shopper and keeps following.
  view.compass.dispatch("click"); run(TRANSITION_MS + 50);
  assert.ok(view.tracking && near(view.currentPose().azimuth, 0, 1e-9));
  view.dispose();
});

test("Follow camera: a live frame without the visit ends it as a departure — camera left where it is, controls restored, no reset — and says only that the shopper isn't visible", () => {
  const { view, run } = followView();
  view.followCamera({ kind: "shopper", visit: 303 }); run(TRANSITION_MS + 50);
  view.setAgents(followFrame([[33, 11]], [303])); dom.frames();
  const pose = view.currentPose();
  const stops = []; view.onTrackingStop = (s) => stops.push(s);
  view.setAgents(followFrame([[10, 5]], [301])); dom.frames();
  assert.equal(view.tracking, null);
  assert.ok(poseNear(view.currentPose(), pose), "left where it was");
  assert.ok(view.controls.enablePan === true && view.controls.zoomToCursor === true && view.trackBadge.hidden);
  assert.equal(view.cameraState.mode, "manual");
  assert.equal(view.cameraState.note, "Shopper no longer visible in this store.");
  assert.deepEqual(stops.map((s) => [s.id, s.error ?? null]), [[303, null]]);
  run(500); assert.ok(poseNear(view.currentPose(), pose) && view.raf === 0, "and stays there, nothing more drawn");
  view.dispose();
});

test("Follow camera: malformed or contradictory frames end it as an error, shown and logged, never as a departure", () => {
  const quiet = console.error;
  for (const [what, frame, re] of [
    ["the visit twice", followFrame([[10, 5], [20, 7]], [302, 302]), /visit #302 appears 2 times/],
    ["another visit twice", followFrame([[20, 7], [10, 5], [11, 5]], [302, 301, 301]), /visit #301 appears 2 times/],
    ["no real point", followFrame([[NaN, 7]], [302]), /not a point/],
    ["arrays shorter than n", { ...followFrame([[20, 7]], [302]), n: 3 }, /x has 1 values for 3/],
    ["a visit id that isn't one", followFrame([[20, 7], [10, 5]], [302, 1.5]), /visit id 1.5/],
    ["off the floor", followFrame([[500, 7]], [302]), /not a point of the 66 × 36 floor/],
  ]) {
    const { view, run } = followView();
    view.followCamera({ kind: "shopper", visit: 302 }); run(TRANSITION_MS + 50);
    const pose = view.currentPose();
    const errors = []; const logged = [];
    view.onCameraError = (e) => errors.push(e);
    console.error = (...a) => logged.push(a.join(" "));
    try { view.setAgents(frame); dom.frames(); } finally { console.error = quiet; }
    assert.equal(view.tracking, null, what);
    assert.ok(errors.length === 1 && errors[0] instanceof CameraTargetError && re.test(errors[0].message), `${what}: ${errors[0]?.message}`);
    assert.ok(logged.length >= 1, `${what}: logged`);
    assert.ok(view.cameraState.note !== "Shopper no longer visible in this store." && /stopped/i.test(view.cameraState.note), `${what}: ${view.cameraState.note}`);
    assert.ok(poseNear(view.currentPose(), pose) && view.controls.enablePan === true);
    view.dispose();
  }
});

test("Follow camera: a preset, Reset or Focus, a new floor, hiding or disposing the view, or the floor no longer live each end it; the camera is reset only where asked or the floor changed", () => {
  const cases = [
    ["Top-down", (v) => v.goPreset("topdown"), "topdown"],
    ["Reset", (v) => v.goPreset("overview"), "overview"],
    ["Focus", (v) => v.focus({ kind: "cashier", server: 1 }), "focus"],
    ["hidden", (v) => v.setActive(false), "manual"],
    ["not live", (v) => v.setLive(false), "manual"],
    ["Stop follow", (v) => v.stopTracking("Stopped following."), "manual"],
  ];
  for (const [what, act, mode] of cases) {
    const { view, run } = followView();
    view.followCamera({ kind: "shopper", visit: 301 }); run(TRANSITION_MS + 50);
    const pose = view.currentPose();
    act(view);
    assert.equal(view.tracking, null, what);
    assert.ok(view.controls.enablePan && view.trackBadge.hidden, what);
    assert.equal(view.cameraState.mode, mode, what);
    if (mode === "manual") assert.ok(poseNear(view.currentPose(), pose), `${what}: the camera stays where it was`);
    // A frame after: nothing follows any more.
    view.setActive(true); view.setLive(true);
    view.setAgents(followFrame([[40, 20]], [301])); run(TRANSITION_MS + 50);
    if (mode === "manual") assert.ok(poseNear(view.currentPose(), pose), `${what}: not following`);
    view.dispose();
  }
  // A new floor: following ends, and the new floor's Overview.
  const { view, run } = followView();
  view.followCamera({ kind: "shopper", visit: 301 }); run(TRANSITION_MS + 50);
  const small = json("layouts/small.layout.json");
  view.setPlan(planOf(small, keys), small.rows, keys);
  assert.ok(view.tracking === null && view.controls.enablePan && view.cameraState.mode === "overview" && /floor changed/.test(view.cameraState.note));
  // Disposed while following: no frames asked for, no listeners left.
  view.setLive(true); view.setAgents(followFrame([[10, 5]], [301]));
  view.followCamera({ kind: "shopper", visit: 301 }); run(100);
  view.dispose();
  assert.ok(view.tracking === null && view.raf === 0 && !view.transition);
  assert.equal(view.canvas.listeners.get("keydown")?.length ?? 0, 0);
  view.setAgents(followFrame([[12, 5]], [301]));
  assert.equal(view.tracking, null);
});

test("Follow camera: tracking moves on with frames only — no frames, no animation; nothing is sent to the simulation", () => {
  const sent = [];
  const { view, run, renderer } = followView();
  view.onClick = (...a) => sent.push(a);
  view.followCamera({ kind: "shopper", visit: 302 }); run(TRANSITION_MS + 50);
  const calls = renderer.calls;
  run(1000);
  assert.equal(renderer.calls, calls, "no frame, nothing drawn: following isn't an animation of its own");
  view.setAgents(followFrame([[21, 7]], [302])); run(100);
  assert.equal(renderer.calls, calls + 1, "a frame: one render");
  assert.deepEqual(sent, []);
  view.dispose();
});

test("the inspector's Follow camera: shown for a shopper with the 3D floor, says why it can't start, turns into Stop follow while following; the panel's own content is untouched", async () => {
  const { Inspector } = await import("../js/fashion/inspector.js");
  const calls = [];
  const ins = new Inspector({ onClose() {}, onHousehold() {}, onFollowCamera: (active) => calls.push(active), app: { brands: [], brandName: (b) => `Brand ${b}` } });
  const b = ins.followButton;
  ins.setFollowCamera({ shown: true, ok: false, active: false, reason: "Visit #5 isn't on this floor in the current frame." });
  assert.ok(!ins.followBox.hidden && b.getAttribute("aria-disabled") === "true" && /isn't on this floor/.test(b.title) && /Unavailable/.test(ins.followWhy.textContent));
  b.click();
  assert.deepEqual(calls, []);
  assert.match(ins.followNote.textContent, /isn't on this floor/);
  ins.setFollowCamera({ shown: true, ok: true, active: false });
  b.click();
  ins.setFollowCamera({ shown: true, ok: true, active: true });
  assert.ok(b.textContent === "Stop follow" && b.getAttribute("aria-pressed") === "true");
  b.click();
  assert.deepEqual(calls, [false, true]);
  ins.setFollowCamera({ shown: false, ok: false, active: false });
  assert.ok(ins.followBox.hidden);
});
