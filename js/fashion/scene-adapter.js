// The 3D views' adapter: what R sends the page (city_geometry() and
// plan_geometry() in GEOMETRY, frame_pack() in each FRAME, and the
// installed world file) as plain arrays of things to draw, placed in the
// scene by spatial.js. It reads; it decides nothing. Positions and states
// are the simulation's: nothing here moves an agent, routes a trip or
// draws a random number (the scenery's variety, a building's height or a
// tree's place in its tile, comes from a hash of the tile's row and
// column, so the same world always looks the same).
//
// Static scenery (cityModel, floorModel) is read once per installed world;
// the moving parts (travellersOf, floorAgentsOf) once per frame, into
// arrays the views copy into their instanced meshes.

import { macroFrame, macroTileCentre, macroToScene, colMajorTile, floorFrame, floorToScene, floorCellCentre, floorBox } from "./spatial.js";

// Land codes (model/city.R): 0 open, 1 water, 2 park, 3 homes, 4 pedestrian street, 5 road, 6 bridge,
// 7 woodland, 8 building, 9 footpath, 10 footbridge, 11 highway, 12 crossing, 13 driveway, 14 lot, 15 garage, 16 mall.
export const LAND = { open: 0, water: 1, park: 2, homes: 3, plaza: 4, road: 5, bridge: 6, woodland: 7, building: 8, footpath: 9,
  footbridge: 10, highway: 11, crossing: 12, driveway: 13, lot: 14, garage: 15, mall: 16 };
// The tiles drawn as roads and as footpaths, as CityView draws them.
export const ROADS = new Set([5, 6, 11, 12, 13]);
export const PATHS = new Set([9, 10]);
// Ground no trip crosses diagonally past (grid.R's corner rule, as CityView draws it).
const BLOCKING = new Set([1, 7, 8, 14, 15, 16]);

// Traveller kinds in frame_pack(): 1 a car moving, 2 a walker, 3 a parked car.
export const TRAVELLER = { car: 1, walker: 2, parked: 3 };

// A number in [0, 1) from integers: the scenery's variety, the same every time.
export function hash01(a, b = 0, k = 0) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(k | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---- The map ---------------------------------------------------------------------------

// The most houses drawn on the map, whatever its size (a world can have
// 60,000 tiles): fewer per tile on a bigger map.
export const MAX_HOUSES = 60000;

// Everything static on the installed map, from city_geometry() (`geo`) and
// the installed world file (`world`, for what the geometry doesn't carry:
// which store each mall storefront belongs to).
export function cityModel(geo, world = null) {
  const m = macroFrame(geo);
  const { nx, ny, patch: p } = m;
  const land = geo.land;
  const at = (r, c) => (r >= 0 && c >= 0 && r < ny && c < nx ? land[r * nx + c] : -1);
  const centre = (r, c) => macroTileCentre(m, r, c);

  // Tiles by what's drawn on them.
  const tiles = { water: [], park: [], homes: [], plaza: [], building: [], woodland: [], lot: [], garage: [], mall: [], bridge: [], footbridge: [], crossing: [] };
  const KIND = { 1: "water", 2: "park", 3: "homes", 4: "plaza", 6: "bridge", 7: "woodland", 8: "building", 10: "footbridge", 12: "crossing", 14: "lot", 15: "garage", 16: "mall" };
  for (let i = 0; i < land.length; i++) { const k = KIND[land[i]]; if (k) tiles[k].push(i); }

  // Roads: a link between the middles of each two touching road tiles, as
  // CityView draws them (diagonals only where a trip can cross the corner),
  // and a dot for a road tile on its own.
  const isRoad = (r, c) => ROADS.has(at(r, c));
  const passable = (r, c) => !BLOCKING.has(at(r, c));
  const diagonal = (r, c, r2, c2) => isRoad(r2, c2) && !isRoad(r, c2) && !isRoad(r2, c) && passable(r, c2) && passable(r2, c);
  const roads = []; const roadDots = [];
  // Which way a car on each road tile faces (yaw about Y, 0 along X): along
  // its links, so a car is drawn along the road it's on.
  const yaw = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    if (!isRoad(r, c)) continue;
    const ew = isRoad(r, c - 1) || isRoad(r, c + 1); const ns = isRoad(r - 1, c) || isRoad(r + 1, c);
    const d1 = diagonal(r, c, r + 1, c + 1) || diagonal(r, c, r - 1, c - 1); const d2 = diagonal(r, c, r + 1, c - 1) || diagonal(r, c, r - 1, c + 1);
    yaw[r * nx + c] = ew || (!ns && !d1 && !d2) ? 0 : ns ? Math.PI / 2 : d1 ? -Math.PI / 4 : Math.PI / 4;
    const link = (r2, c2) => { const a = centre(r, c); const b = centre(r2, c2); roads.push(a.X, a.Z, b.X, b.Z); };
    if (isRoad(r, c + 1)) link(r, c + 1);
    if (isRoad(r + 1, c)) link(r + 1, c);
    if (diagonal(r, c, r + 1, c + 1)) link(r + 1, c + 1);
    if (diagonal(r, c, r + 1, c - 1)) link(r + 1, c - 1);
    const a = centre(r, c); roadDots.push(a.X, a.Z);
  }
  // Highways and footpaths (and footbridges), along their own tiles.
  const along = (test) => {
    const out = []; const on = (r, c) => test(at(r, c));
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
      if (!on(r, c)) continue;
      const a = centre(r, c);
      if (on(r, c + 1)) { const b = centre(r, c + 1); out.push(a.X, a.Z, b.X, b.Z); }
      if (on(r + 1, c)) { const b = centre(r + 1, c); out.push(a.X, a.Z, b.X, b.Z); }
      if (!on(r, c - 1) && !on(r, c + 1) && !on(r - 1, c) && !on(r + 1, c)) out.push(a.X, a.Z, a.X, a.Z);
    }
    return out;
  };
  const highways = along((v) => v === LAND.highway);
  const paths = along((v) => PATHS.has(v));
  // A bridge's direction: along the road (or path) it carries.
  const bridgeYaw = (i, network) => {
    const r = Math.floor(i / nx); const c = i % nx;
    const ew = network.has(at(r, c - 1)) || network.has(at(r, c + 1));
    const ns = network.has(at(r - 1, c)) || network.has(at(r + 1, c));
    return ns && !ew ? Math.PI / 2 : 0;
  };

  // Houses: on each home tile, by its density (1 to 9), up to four, fewer
  // on a big map; each in its area's colour.
  const perTile = Math.max(1, Math.min(4, Math.floor(MAX_HOUSES / Math.max(1, tiles.homes.length))));
  const houses = { n: 0, X: [], Z: [], size: [], height: [], yaw: [], area: [], density: [] };
  const spots = [[-0.22, -0.22], [0.22, 0.22], [0.22, -0.22], [-0.22, 0.22]];
  for (const i of tiles.homes) {
    const r = Math.floor(i / nx); const c = i % nx; const d = geo.density[i] || 1;
    const n = Math.min(perTile, d >= 7 ? 4 : d >= 4 ? 3 : d >= 2 ? 2 : 1);
    const t = centre(r, c);
    for (let k = 0; k < n; k++) {
      const [dx, dz] = n === 1 ? [0, 0] : spots[k];
      const j = hash01(r, c, k);
      houses.X.push(t.X + (dx + (j - 0.5) * 0.06) * p); houses.Z.push(t.Z + (dz + (hash01(c, r, k) - 0.5) * 0.06) * p);
      houses.size.push(p * (n === 1 ? 0.42 : 0.3) * (0.85 + 0.3 * j));
      houses.height.push(p * (0.1 + 0.025 * d) * (0.8 + 0.4 * hash01(r, c, k + 7)));
      houses.yaw.push(hash01(r, c, k + 3) < 0.5 ? 0 : Math.PI / 2);
      houses.area.push(geo.area[i]); houses.density.push(d);
      houses.n++;
    }
  }

  // Buildings: a block on each building tile, its height from the tile.
  const buildings = tiles.building.map((i) => {
    const r = Math.floor(i / nx); const c = i % nx; const t = centre(r, c);
    return { X: t.X, Z: t.Z, size: p * 0.88, height: p * (0.25 + 0.5 * hash01(r, c, 11)) };
  });

  // Trees: three or four in each woodland tile, one in some park tiles.
  const trees = [];
  const tree = (r, c, k, spread, scale) => {
    const t = centre(r, c);
    trees.push({ X: t.X + (hash01(r, c, k) - 0.5) * spread * p, Z: t.Z + (hash01(c, r, k + 5) - 0.5) * spread * p, scale: p * scale * (0.8 + 0.4 * hash01(r, c, k + 9)) });
  };
  for (const i of tiles.woodland) { const r = Math.floor(i / nx); const c = i % nx; const n = 3 + (hash01(r, c, 1) < 0.5 ? 1 : 0); for (let k = 0; k < n; k++) tree(r, c, k + 20, 0.75, 0.32); }
  for (const i of tiles.park) { const r = Math.floor(i / nx); const c = i % nx; if (hash01(r, c, 2) < 0.45) tree(r, c, 40, 0.6, 0.28); }

  // Bridges, footbridges and crossings: decks over their tiles, along the way they carry.
  const bridges = tiles.bridge.map((i) => ({ ...centre(Math.floor(i / nx), i % nx), yaw: bridgeYaw(i, ROADS), foot: false }))
    .concat(tiles.footbridge.map((i) => ({ ...centre(Math.floor(i / nx), i % nx), yaw: bridgeYaw(i, PATHS), foot: true })));
  const crossings = tiles.crossing.map((i) => ({ ...centre(Math.floor(i / nx), i % nx), yaw: bridgeYaw(i, new Set([LAND.highway])) }));

  // Parking: each facility's tiles and levels (a garage's decks), and where to label it.
  const parking = (geo.parking ?? []).map((f) => {
    const ts = f.tiles.map((t) => colMajorTile(m, t));
    const mid = ts.reduce((a, t) => ({ r: a.r + t.r / ts.length, c: a.c + t.c / ts.length }), { r: 0, c: 0 });
    return { name: f.name, kind: f.kind, levels: Math.max(1, f.levels ?? 1), spaces: f.spaces,
      tiles: ts.map((t) => centre(t.r, t.c)), label: centre(mid.r, mid.c) };
  });

  // Malls: each plan's cells over its block of tiles (roofless: its
  // corridors are where its walkers are), storefronts in their store's colour.
  const storeIndex = new Map((geo.stores ?? []).map((s, i) => [s.key, i]));
  const venues = (geo.venues ?? []).map((v, vi) => {
    const out = { name: v.name, kind: v.kind, stores: v.stores ?? [], plan: null };
    if (!v.plan || !v.tiles?.length) return out;
    const ts = v.tiles.map((t) => colMajorTile(m, t));
    const r0 = Math.min(...ts.map((t) => t.r)); const c0 = Math.min(...ts.map((t) => t.c));
    const cell = v.plan.cell_m;
    const fronts = world?.macro?.venues?.find((w) => w.id === v.id)?.storefronts ?? world?.macro?.venues?.[vi]?.storefronts ?? {};
    const cells = { wall: [], corridor: [], entrance: [], front: [] };
    v.plan.rows.forEach((row, pr) => {
      for (let pc = 0; pc < row.length; pc++) {
        const ch = row[pc];
        // The cell's middle: the block's north-west corner, then pc, pr cells in.
        const X = c0 * p + (pc + 0.5) * cell; const Z = -(ny * p - (r0 * p + (pr + 0.5) * cell));
        if (ch === "#") cells.wall.push({ X, Z });
        else if (ch === ".") cells.corridor.push({ X, Z });
        else if (ch === "E") cells.entrance.push({ X, Z });
        else {
          const key = fronts[ch];
          let store = key !== undefined && storeIndex.has(key) ? storeIndex.get(key) : -1;
          if (store < 0 && out.stores.length) {            // not named: the venue's store nearest the cell
            let bd = Infinity;
            for (const s of out.stores) { const st = geo.stores[s - 1]; if (!st) continue; const d = (st.x - X) ** 2 + (st.y + Z) ** 2; if (d < bd) { bd = d; store = s - 1; } }
          }
          cells.front.push({ X, Z, store });
        }
      }
    });
    out.plan = { cell, cells };
    return out;
  });

  // Stores: each at its point, sized by its layout's rack space (as CityView sizes them).
  const inMall = new Set(); for (const v of venues) if (v.plan) for (const s of v.stores) inMall.add(s - 1);
  const stores = (geo.stores ?? []).map((s, i) => {
    const { X, Z } = macroToScene(s.x, s.y);
    const half = (inMall.has(i) ? 0.16 : 0.3) * p * Math.max(0.3, s.space ?? 1) ** 0.45;
    return { id: s.id, X, Z, half, height: inMall.has(i) ? half * 1.2 : half * 1.6, brand: s.brand, inMall: inMall.has(i) };
  });

  const areas = (geo.areas ?? []).filter((a) => Number.isFinite(a.x)).map((a) => ({ name: a.name, ...macroToScene(a.x, a.y) }));

  return { frame: m, tiles, roads, roadDots, highways, paths, yaw, houses, buildings, trees, bridges, crossings, parking, venues, stores, areas };
}

// ---- Camera targets on the map ---------------------------------------------------------

// An area's ground: the box (scene metres) round every tile city_geometry()
// puts in area `k` (1-based, as its `area` layer numbers them), and how many
// tiles that is; null if it has none. Its roads, stores, households and
// everyone outdoors in it are on those tiles. Throws if the layer isn't
// the map's size (a defect, not an empty area).
export function areaExtent(geo, k) {
  const m = macroFrame(geo);
  if (!Array.isArray(geo.area) && !ArrayBuffer.isView(geo.area)) throw new Error("city_geometry() has no area layer");
  if (geo.area.length !== m.nx * m.ny) throw new Error(`the area layer has ${geo.area.length} tiles, the map ${m.nx} × ${m.ny} = ${m.nx * m.ny}`);
  let r0 = Infinity; let r1 = -Infinity; let c0 = Infinity; let c1 = -Infinity; let n = 0;
  for (let i = 0; i < geo.area.length; i++) {
    if (geo.area[i] !== k) continue;
    const r = Math.floor(i / m.nx); const c = i % m.nx;
    n++; if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c;
  }
  if (!n) return null;
  // The outer edges of the corner tiles: their middles, half a patch out.
  const nw = macroTileCentre(m, r0, c0); const se = macroTileCentre(m, r1, c1); const h = m.patch / 2;
  return { tiles: n, box: { X0: nw.X - h, X1: se.X + h, Z0: nw.Z - h, Z1: se.Z + h } };
}

// A car's facing on the tile it's on: along the road there.
export function carYaw(model, x, y) {
  const { nx, ny, patch } = model.frame;
  const r = ny - 1 - Math.floor(y / patch); const c = Math.floor(x / patch);
  return r >= 0 && c >= 0 && r < ny && c < nx ? model.yaw[r * nx + c] : 0;
}

// The households, from homes_xy() (x's then y's, metres) → scene X, Z.
export function homesOf(homesXY) {
  const n = homesXY.length / 2;
  const X = new Float32Array(n); const Z = new Float32Array(n);
  for (let i = 0; i < n; i++) { X[i] = homesXY[i]; Z[i] = -homesXY[n + i]; }
  return { n, X, Z };
}

// Everyone outdoors in a frame (parseFrame()'s travellers: x, y metres,
// brand, back, kind), by kind, in the scene: X, Z, which way a car faces,
// brand and heading home. Their order within a kind is the frame's.
export function travellersOf(t, model) {
  const out = {};
  for (const [name, kind] of Object.entries(TRAVELLER)) {
    let n = 0;
    for (let i = 0; i < (t?.n ?? 0); i++) if ((t.kind ? t.kind[i] : 1) === kind) n++;
    out[name] = { n, X: new Float32Array(n), Z: new Float32Array(n), yaw: new Float32Array(n), brand: new Int32Array(n), back: new Uint8Array(n), index: new Int32Array(n) };
  }
  const fill = { car: 0, walker: 0, parked: 0 };
  const names = { 1: "car", 2: "walker", 3: "parked" };
  for (let i = 0; i < (t?.n ?? 0); i++) {
    const name = names[t.kind ? t.kind[i] : 1]; if (!name) continue;
    const o = out[name]; const j = fill[name]++;
    o.X[j] = t.x[i]; o.Z[j] = -t.y[i];
    o.yaw[j] = name === "walker" || !model ? 0 : carYaw(model, t.x[i], t.y[i]);
    o.brand[j] = t.brand[i]; o.back[j] = t.back[i] === 1 ? 1 : 0; o.index[j] = i;
  }
  return out;
}

// ---- A floor ---------------------------------------------------------------------------

// FLOOR_CODES and RACK_CODE in model/floors.R: a picture's characters as
// the codes plan_geometry() sends. Several characters share a code (a
// cashier's place and behind the counter; the stockroom and its door; the
// queues' heads and lines); the 3D floor draws them apart from the
// installed layout's rows.
export const RACK_CODE = 100;
const FLOOR_CODES = { ".": 0, "#": 1, "=": 2, F: 12, $: 13, ":": 14, c: 14, X: 15, x: 15, w: 16, W: 16, q: 16, Q: 16 };

// A picture's rows as plan_geometry()'s codes (row by row from the top),
// racks by the world's categories' keys; null if a character is neither.
export function rowsToCodes(rows, keys) {
  const out = [];
  for (const row of rows) for (const ch of row) {
    const k = keys.indexOf(ch);
    if (k >= 0) out.push(RACK_CODE + k + 1);
    else if (ch in FLOOR_CODES) out.push(FLOOR_CODES[ch]);
    else return null;
  }
  return out;
}

// The installed layout's rows, if they're the picture the plan was read
// from (same size, same codes): only then are they used.
export function rowsForPlan(plan, rows, keys) {
  if (!Array.isArray(rows) || rows.length !== plan.height || rows.some((r) => typeof r !== "string" || r.length !== plan.width)) return null;
  const codes = rowsToCodes(rows, keys);
  if (!codes || codes.length !== plan.codes.length) return null;
  for (let i = 0; i < codes.length; i++) if (codes[i] !== plan.codes[i]) return null;
  return rows;
}

// What each cell of a floor is drawn as. From the rows when they match the
// plan; from the codes alone otherwise (a queue is then just a queue).
const CHAR_KIND = { "#": "wall", "=": "door", F: "cubicle", $: "counter", ":": "behind", c: "cashier", X: "stock", x: "stockDoor",
  w: "frLine", W: "frHead", q: "tillLine", Q: "tillHead", ".": "floor" };
const CODE_KIND = { 0: "floor", 1: "wall", 2: "door", 12: "cubicle", 13: "counter", 14: "behind", 15: "stock", 16: "queue" };
export const FLOOR_KINDS = ["floor", "wall", "door", "rack", "cubicle", "counter", "behind", "cashier", "stock", "stockDoor", "frLine", "frHead", "tillLine", "tillHead", "queue"];

// Everything static on a floor: plan_geometry()'s plan, the installed
// layout's rows (or null) and the world's categories' keys.
export function floorModel(plan, rows, keys) {
  const f = floorFrame(plan);
  const pictured = rows ? rowsForPlan(plan, rows, keys) : null;
  const cells = Object.fromEntries(FLOOR_KINDS.map((k) => [k, []]));
  const kind = new Array(plan.width * plan.height);
  for (let r = 0; r < plan.height; r++) for (let c = 0; c < plan.width; c++) {
    const i = r * plan.width + c; const code = plan.codes[i];
    let k;
    if (code > RACK_CODE) k = "rack";
    else if (pictured) k = CHAR_KIND[pictured[r][c]] ?? CODE_KIND[code] ?? "floor";
    else k = CODE_KIND[code] ?? "floor";
    kind[i] = k;
    const at = floorCellCentre(f, r, c);
    cells[k].push(k === "rack" ? { ...at, r, c, category: code - RACK_CODE } : { ...at, r, c });
  }
  const point = ([x, y]) => floorToScene(f, x, y);
  return {
    frame: f, fromRows: !!pictured, kind, cells,
    cubicles: (plan.cubicle_boxes ?? []).map((b) => floorBox(f, b)),
    tills: (plan.tills ?? []).map(point),
    doors: (plan.doors ?? []).map(([x, y]) => ({ ...floorToScene(f, x, y), x, y })),
    labels: (plan.labels ?? []).map((l) => ({ text: l.text, category: l.category ?? null, vertical: !!l.vertical, ...floorToScene(f, l.x, l.y) })),
  };
}

// ---- Camera targets on a floor ---------------------------------------------------------

const COUNTER = 13; const BEHIND = 14;       // FLOOR_CODES: "$", and ":" or "c" (a cashier's place)

// The checkout, from what plan_geometry() says: each till (its cashier's
// place, `tills`, numbered as the model numbers them) and the block of
// counter and cashiers' cells it stands in. Tills whose blocks touch are one
// zone. The till queue is one per layout (model/floors.R allows one head):
// its head is plan_geometry()'s `till_head`, its line the cells the
// installed layout's rows draw as q and Q — only when those rows are the
// picture the plan was read from (floorModel's fromRows); otherwise the
// line's cells are unknown here, and `queue.line` is null, not guessed from
// the shared queue code. `problem` names data that contradicts itself.
export function checkoutGeometry(plan, model) {
  const f = model.frame; const W = f.W; const H = f.H; const cell = f.cell;
  const out = { zones: [], queue: { head: null, line: null }, problem: null };
  const cellBox = (r, c) => ({ X0: c * cell, X1: (c + 1) * cell, Z0: -(H - r) * cell, Z1: -(H - r - 1) * cell });
  const tills = plan.tills ?? [];
  if (!Array.isArray(tills)) { out.problem = `plan_geometry()'s tills for ${plan.format} aren't a list of places`; return out; }
  const zoneOf = new Int32Array(W * H).fill(-1);
  for (let j = 0; j < tills.length; j++) {
    const t = tills[j];
    const [x, y] = Array.isArray(t) ? t : [NaN, NaN];
    const r = H - 1 - y; const c = x;
    if (!Number.isInteger(x) || !Number.isInteger(y) || r < 0 || c < 0 || r >= H || c >= W) {
      out.problem = `till ${j + 1} of ${plan.format} is at (${t}), not a cell of its ${W} × ${H} floor`; return out;
    }
    const code = plan.codes[r * W + c];
    if (code !== BEHIND) { out.problem = `till ${j + 1} of ${plan.format} is at (${x}, ${y}), a cell coded ${code}, not a cashier's place`; return out; }
    if (zoneOf[r * W + c] < 0) {
      // A new zone: every counter and cashier's cell joined to this one.
      const k = out.zones.length; const zone = { tills: [], cells: 0, box: null };
      const stack = [r * W + c]; zoneOf[r * W + c] = k;
      while (stack.length) {
        const i = stack.pop(); const ri = Math.floor(i / W); const ci = i % W;
        zone.cells++;
        const b = cellBox(ri, ci);
        zone.box = zone.box ? union(zone.box, b) : b;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const r2 = ri + dr; const c2 = ci + dc; const i2 = r2 * W + c2;
          if (r2 < 0 || c2 < 0 || r2 >= H || c2 >= W || zoneOf[i2] >= 0) continue;
          const code2 = plan.codes[i2];
          if (code2 === COUNTER || code2 === BEHIND) { zoneOf[i2] = k; stack.push(i2); }
        }
      }
      out.zones.push(zone);
    }
    out.zones[zoneOf[r * W + c]].tills.push(j + 1);
  }
  const h = plan.till_head;
  if (h !== undefined && h !== null) {
    if (!Array.isArray(h) || h.length !== 2 || !Number.isInteger(h[0]) || !Number.isInteger(h[1]) || h[0] < 0 || h[1] < 0 || h[0] >= W || h[1] >= H) {
      out.problem = `plan_geometry()'s till_head for ${plan.format} is ${JSON.stringify(h)}, not a cell of its ${W} × ${H} floor`; return out;
    }
    out.queue.head = cellBox(H - 1 - h[1], h[0]);
  }
  if (model.fromRows) out.queue.line = [...model.cells.tillHead, ...model.cells.tillLine].map((q) => cellBox(q.r, q.c));
  return out;
}

// Where a selected agent stands in a frame (parseFrame()'s floor): a
// shopper by their visit's id ({ kind: "shopper", visit }), never by their
// place in the frame's order; a worker by role and number ({ kind:
// "cashier" | "assistant", server }). { ok: true, at: {X, Z}, x, y, index }
// if they are in it exactly once; { ok: false, reason } if not in it (a
// normal state: they've left, or not come yet); { ok: false, defect: true }
// if the frame contradicts itself about them (in it twice, or not at a
// real point).
export function locateOnFloor(a, plan, sel) {
  const f = floorFrame(plan);
  const shopper = sel?.kind === "shopper";
  const role = sel?.kind === "cashier" ? 1 : sel?.kind === "assistant" ? 2 : 0;
  if (!shopper && !role) return { ok: false, defect: true, reason: `not a shopper or a worker: ${JSON.stringify(sel)}`, context: { sel } };
  const id = shopper ? sel.visit : sel.server;
  const what = shopper ? `visit #${id}` : `${sel.kind} ${id}`;
  if (!Number.isFinite(id)) return { ok: false, defect: true, reason: `the selection has no ${shopper ? "visit id" : "number"} (${id})`, context: { sel } };
  const n = shopper ? a.n : a.staffN;
  const X = shopper ? a.x : a.staffX; const Y = shopper ? a.y : a.staffY;
  const ids = shopper ? a.visit : a.staffId;
  if (!Number.isInteger(n) || n < 0 || !X || !Y || !ids || X.length < n || Y.length < n || ids.length < n || (!shopper && (!a.staffRole || a.staffRole.length < n))) {
    return { ok: false, defect: true, reason: `the frame's ${shopper ? "shoppers" : "staff"} are malformed (n = ${n}, arrays of ${X?.length}, ${Y?.length}, ${ids?.length})`, context: { sel } };
  }
  const hits = [];
  for (let i = 0; i < n; i++) if (ids[i] === id && (shopper || a.staffRole[i] === role)) hits.push(i);
  if (!hits.length) return { ok: false, reason: shopper ? `Visit #${id} isn't on this floor in the current frame.` : `The ${what} isn't on this floor in the current frame.` };
  if (hits.length > 1) return { ok: false, defect: true, reason: `${what} is in the same frame ${hits.length} times (at indices ${hits.join(", ")})`, context: { sel, hits } };
  const i = hits[0]; const x = X[i]; const y = Y[i];
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -1 || y < -1 || x > plan.width || y > plan.height) {
    return { ok: false, defect: true, reason: `${what} is at (${x}, ${y}), not a point of the ${plan.width} × ${plan.height} floor`, context: { sel, x, y } };
  }
  return { ok: true, at: floorToScene(f, x, y), x, y, index: i };
}

// What's wrong with a frame's floor (parseFrame()'s floor), as a list
// (empty: nothing): counts that aren't counts, arrays shorter than their
// count, a shopper or worker not at a real point of the floor, a visit id
// that isn't a whole number or is in the frame more than once. Checked on
// every frame while the camera follows someone: a frame like this is a
// defect, not a shopper leaving.
export function floorFrameProblems(a, plan) {
  const out = [];
  if (!a || typeof a !== "object") return ["there is no floor in the frame"];
  const count = (n, what) => { if (!Number.isInteger(n) || n < 0) { out.push(`its ${what} count is ${n}`); return false; } return true; };
  const arrays = (n, names) => { for (const k of names) if (!a[k] || a[k].length < n) out.push(`${k} has ${a[k]?.length ?? "no"} values for ${n}`); };
  const inFloor = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x >= -1 && y >= -1 && x <= plan.width && y <= plan.height;
  if (count(a.n, "shopper")) {
    arrays(a.n, ["x", "y", "look", "visit"]);
    if (!out.length) {
      const seen = new Map();
      for (let i = 0; i < a.n; i++) {
        if (!inFloor(a.x[i], a.y[i])) out.push(`visit #${a.visit[i]} is at (${a.x[i]}, ${a.y[i]}), not a point of the ${plan.width} × ${plan.height} floor`);
        const v = a.visit[i];
        if (!Number.isInteger(v) || v < 1) out.push(`shopper ${i} has visit id ${v}`);
        else seen.set(v, (seen.get(v) ?? 0) + 1);
      }
      for (const [v, k] of seen) if (k > 1) out.push(`visit #${v} appears ${k} times`);
    }
  }
  if (count(a.staffN, "staff")) {
    const before = out.length;
    arrays(a.staffN, ["staffX", "staffY", "staffRole", "staffId"]);
    if (out.length === before) for (let i = 0; i < a.staffN; i++) if (!inFloor(a.staffX[i], a.staffY[i])) out.push(`worker ${i} is at (${a.staffX[i]}, ${a.staffY[i]}), not a point of the floor`);
  }
  return out;
}

// How tall the solid fixture on each cell of a floor is (0: none), from
// the cells floorModel() draws as blocks: `heights` gives each kind's
// height (walls, racks, the counter, the stockroom, the fitting cubicles,
// the till on a cashier's place). Row by row from the north edge, as
// floorModel()'s `kind`. heightAt(X, Z) reads it at a scene point.
export function fixtureHeights(model, heights) {
  const f = model.frame; const out = new Float32Array(f.W * f.H);
  for (let i = 0; i < out.length; i++) out[i] = heights[model.kind[i]] ?? 0;
  const heightAt = (X, Z) => {
    const c = Math.floor(X / f.cell); const r = f.H - 1 - Math.floor(-Z / f.cell);
    return r >= 0 && c >= 0 && r < f.H && c < f.W ? out[r * f.W + c] : 0;
  };
  return { cells: out, heightAt };
}

// The smallest box holding both.
export function union(a, b) {
  return { X0: Math.min(a.X0, b.X0), X1: Math.max(a.X1, b.X1), Z0: Math.min(a.Z0, b.Z0), Z1: Math.max(a.Z1, b.Z1) };
}

// Everyone on the floor in a frame (parseFrame()'s floor), in the scene:
// shoppers (look, visit) and staff (role 1 cashier, 2 assistant; number;
// busy), and each cubicle's busy and open.
export function floorAgentsOf(a, plan) {
  const f = floorFrame(plan);
  const n = a?.n ?? 0; const ns = a?.staffN ?? 0;
  const shoppers = { n, X: new Float32Array(n), Z: new Float32Array(n), look: new Int32Array(n), visit: new Float64Array(n), x: new Float32Array(n), y: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const s = floorToScene(f, a.x[i], a.y[i]);
    shoppers.X[i] = s.X; shoppers.Z[i] = s.Z; shoppers.look[i] = a.look[i]; shoppers.visit[i] = a.visit[i]; shoppers.x[i] = a.x[i]; shoppers.y[i] = a.y[i];
  }
  const staff = { n: ns, X: new Float32Array(ns), Z: new Float32Array(ns), role: new Int32Array(ns), id: new Int32Array(ns), busy: new Uint8Array(ns), x: new Float32Array(ns), y: new Float32Array(ns) };
  for (let i = 0; i < ns; i++) {
    const s = floorToScene(f, a.staffX[i], a.staffY[i]);
    staff.X[i] = s.X; staff.Z[i] = s.Z; staff.role[i] = a.staffRole[i]; staff.id[i] = a.staffId[i]; staff.busy[i] = a.staffBusy[i] ? 1 : 0;
    staff.x[i] = a.staffX[i]; staff.y[i] = a.staffY[i];
  }
  const nc = a?.cubBusy?.length ?? 0;
  const cubicles = { n: nc, busy: Array.from({ length: nc }, (_, i) => !!a.cubBusy[i]), open: Array.from({ length: nc }, (_, i) => !!a.cubOpen[i]) };
  return { shoppers, staff, cubicles };
}
