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
  return { format: L.id, name: L.name, width: W, height: H, cell_m: 0.5, codes: adapter.rowsToCodes(rows, keys),
    labels: [], cubicle_boxes: boxes, tills: cells((ch) => ch === "c").map(([r, c]) => xy(r, c)), doors: cells((ch) => ch === "=").map(([r, c]) => xy(r, c)) };
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
