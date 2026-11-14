// Builds the transport layer of the bundled worlds, by hand, as an end user
// would in the world builder: the tiles that carry cars and people where
// the old maps left them ambiguous, and every parking facility and shopping
// venue, each placed explicitly. Nothing here is derived automatically from
// roads or stores: each lot, garage, kerb, entrance and exit below is a
// decision written out, and each can be edited or removed in the editor.
//
//   node tools/build-transport.mjs
//
// Reads a version 10 or 11 world and writes it at version 11 (the same
// upgrade model/world.R makes: no parking, no venues, the travel weights
// from km_w), then applies the layer. Running it twice gives the same file.
//
//   worlds/default.world.json   Millbrook Mall becomes an enclosed mall (its
//                               four stores' storefronts on a plan of 10 m
//                               cells) with a three-level garage and a
//                               surface lot; Old Town, Riverside and
//                               Eastfield are walkable districts with a
//                               garage, lots and marked kerb spaces; the
//                               Retail Park and the Outlet have lots of
//                               their own.
//   worlds/strip_mall.world.json   the strip's ten stores in two buildings
//                               facing a plaza, their doors on its walkways,
//                               a lot behind each building (arcades through
//                               to the plaza) and kerb spaces on the west road.

import { readFileSync, writeFileSync } from "node:fs";
import { worldText } from "../js/fashion/world-store.js";

const at = (p) => new URL(`../${p}`, import.meta.url);

// The version 10 -> 11 upgrade (model/world.R, upgrade_v10).
export function upgradeV10(W) {
  if (W.version !== 10) return W;
  W.version = 11;
  const M = {};
  for (const [k, v] of Object.entries(W.macro)) {
    if (k === "park_s") continue;
    M[k] = v;
    if (k === "local_mps") M.walk_mps = 1.3;
  }
  M.parking ??= []; M.venues ??= [];
  W.macro = M;
  const mk = {};
  for (const [k, v] of Object.entries(W.market)) {
    if (k !== "km_w") { mk[k] = v; continue; }
    const dw = Number((v * W.macro.road_mps * 60 / 1000).toPrecision(6));
    Object.assign(mk, { drive_w: dw, park_w: Number((1.5 * dw).toPrecision(6)), walk_w: Number((2 * dw).toPrecision(6)), cluster_w: 0.3, max_walk_km: 2 });
  }
  W.market = mk;
  W.segments = W.segments.map((s) => ({ ...s, car_share: s.car_share ?? 1 }));
  return W;
}

// Tiles as a grid of characters, rows from the north edge, 0-based.
function grid(rows) {
  const t = rows.map((r) => r.split(""));
  return {
    t,
    set(r0, r1, c0, c1, ch) { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) t[r][c] = ch; },
    get: (r, c) => t[r][c],
    rows: () => t.map((r) => r.join("")),
  };
}
const block = (r0, r1, c0, c1) => { const out = []; for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push([r, c]); return out; };

function facility(id, name, kind, tiles, { levels = 1, spaces, vehicle, pedestrian, search_s, level_s = 0, transfer_s }) {
  return { id, name, kind, tiles, levels, spaces, vehicle_access: vehicle, pedestrian_access: pedestrian ?? tiles, search_s, level_s, transfer_s };
}

// A mall's plan: walls, a cross of corridors, entrances on the edge, and a
// storefront per store opening onto the corridor.
function mallPlan(H, W, { corridor, entrances, fronts }) {
  const P = Array.from({ length: H }, () => Array(W).fill("#"));
  for (const [r0, r1, c0, c1] of corridor) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) P[r][c] = ".";
  for (const [r0, r1, c0, c1] of entrances) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) P[r][c] = "E";
  for (const [ch, r, c0, c1] of fronts) for (let c = c0; c <= c1; c++) P[r][c] = ch;
  return P.map((r) => r.join(""));
}

function storeAt(W, id, venue) {
  const s = W.stores.find((x) => x.id === id);
  if (!s) throw new Error(`no store ${id}`);
  if (venue) s.venue = venue; else delete s.venue;
  return s;
}
const tileCentre = (M, r, c) => ({ x: (c + 0.5) * M.patch_m, y: (M.height - r - 0.5) * M.patch_m });

// ---- The default world --------------------------------------------------------------------

function defaultWorld(W) {
  W = upgradeV10(W);
  const M = W.macro;
  const g = grid(M.tiles);

  // Millbrook Mall: an enclosed mall on rows 83-87, columns 42-46 (250 x
  // 250 m), its plaza around it, a garage north of it reached by a
  // driveway off the road, and a surface lot to its east off the road.
  g.set(83, 87, 42, 46, "m");
  g.set(82, 82, 41, 48, "s"); g.set(83, 88, 41, 41, "s"); g.set(88, 88, 41, 48, "s"); g.set(83, 88, 47, 47, "s");
  g.set(80, 81, 43, 46, "G"); g.set(82, 82, 43, 46, "s");
  g.set(83, 88, 48, 48, "P");
  g.set(80, 81, 47, 48, "s");
  // Old Town: a four-level garage on the edge of the shopping streets.
  g.set(35, 36, 41, 43, "G");
  // Riverside: a surface lot west of the shops, off the road.
  g.set(26, 28, 111, 113, "P");
  // Eastfield: a lot behind the high street.
  g.set(93, 95, 113, 115, "P");
  // Millbrook Retail Park and the Outlet: lots of their own.
  g.set(94, 95, 26, 29, "P");
  g.set(77, 78, 56, 57, "P");
  M.tiles = g.rows();

  M.parking = [
    facility("millbrook_garage", "Millbrook Mall garage", "garage", block(80, 81, 43, 46),
      { levels: 3, spaces: 600, vehicle: [[80, 43]], pedestrian: [[81, 44], [81, 45]], search_s: 45, level_s: 30, transfer_s: 75 }),
    facility("millbrook_lot", "Millbrook Mall surface lot", "lot", block(83, 88, 48, 48),
      { spaces: 220, vehicle: [[85, 48], [88, 48]], pedestrian: block(83, 88, 48, 48), search_s: 60, transfer_s: 20 }),
    facility("old_town_garage", "Old Town garage", "garage", block(35, 36, 41, 43),
      { levels: 4, spaces: 420, vehicle: [[35, 41]], pedestrian: [[35, 42]], search_s: 45, level_s: 30, transfer_s: 75 }),
    facility("old_town_kerb", "Old Town kerb spaces", "kerb", [[29, 37], [29, 38], [29, 43], [29, 44]],
      { spaces: 24, vehicle: [[29, 37], [29, 38], [29, 43], [29, 44]], search_s: 120, transfer_s: 0 }),
    facility("riverside_lot", "Riverside lot", "lot", block(26, 28, 111, 113),
      { spaces: 160, vehicle: [[27, 111]], pedestrian: [[26, 113], [27, 113], [28, 113]], search_s: 60, transfer_s: 20 }),
    facility("riverside_kerb", "Riverside Quay kerb spaces", "kerb", [[29, 123], [29, 124], [29, 125], [29, 126]],
      { spaces: 28, vehicle: [[29, 123], [29, 124], [29, 125], [29, 126]], search_s: 120, transfer_s: 0 }),
    facility("eastfield_lot", "Eastfield lot", "lot", block(93, 95, 113, 115),
      { spaces: 140, vehicle: [[94, 113]], pedestrian: [[93, 114], [93, 115]], search_s: 60, transfer_s: 20 }),
    facility("eastfield_kerb", "Eastfield High St kerb spaces", "kerb", [[89, 117], [89, 118], [89, 119], [89, 120]],
      { spaces: 30, vehicle: [[89, 117], [89, 118], [89, 119], [89, 120]], search_s: 120, transfer_s: 0 }),
    facility("campus_kerb", "Eastfield Campus kerb spaces", "kerb", [[94, 130], [95, 130]],
      { spaces: 14, vehicle: [[94, 130], [95, 130]], search_s: 90, transfer_s: 0 }),
    facility("retail_park_lot", "Millbrook Retail Park lot", "lot", block(94, 95, 26, 29),
      { spaces: 150, vehicle: [[95, 29]], pedestrian: [[95, 26], [95, 27], [95, 28]], search_s: 45, transfer_s: 20 }),
    facility("outlet_lot", "Millbrook Outlet lot", "lot", block(77, 78, 56, 57),
      { spaces: 80, vehicle: [[78, 57]], pedestrian: [[77, 57], [78, 57]], search_s: 45, transfer_s: 20 }),
  ];

  // The mall's plan: 25 x 25 cells of 10 m over its 5 x 5 tiles. A cross of
  // corridors (rows and columns 11-13), entrances on all four sides (onto
  // the garage's plaza north, the lot east, the plazas south and west),
  // and a storefront for each store in each quarter.
  const plan = mallPlan(25, 25, {
    corridor: [[11, 13, 0, 24], [0, 24, 11, 13]],
    entrances: [[0, 0, 11, 13], [11, 13, 24, 24], [24, 24, 11, 13], [11, 13, 0, 0]],
    fronts: [["a", 14, 4, 6], ["b", 10, 18, 20], ["c", 14, 18, 20], ["d", 10, 4, 6]],
  });
  M.venues = [
    { id: "millbrook_mall", name: "Millbrook Mall", kind: "mall", stores: ["ours_mm", "ours_int_mm", "value_mm", "fast_mm"],
      parking: ["millbrook_garage", "millbrook_lot"], tiles: block(83, 87, 42, 46), plan: { cell_m: 10, rows: plan },
      storefronts: { a: "ours_mm", b: "ours_int_mm", c: "value_mm", d: "fast_mm" } },
    { id: "old_town", name: "Old Town", kind: "district", stores: ["ours_ot", "ours_int_ot", "value_ot", "prem_ot", "fast_ot"],
      parking: ["old_town_garage", "old_town_kerb"] },
    { id: "riverside", name: "Riverside", kind: "district", stores: ["ours_rs", "ours_int_rs", "prem_rs", "prem_rq"],
      parking: ["riverside_lot", "riverside_kerb"] },
    { id: "eastfield", name: "Eastfield High St", kind: "district", stores: ["ours_ef", "value_ef", "fast_eh"],
      parking: ["eastfield_lot", "eastfield_kerb"] },
  ];
  // The mall's stores stand in its quarters, by their storefronts.
  const quarter = { ours_mm: [86, 43], ours_int_mm: [84, 46], value_mm: [86, 46], fast_mm: [84, 43] };
  for (const [id, [r, c]] of Object.entries(quarter)) Object.assign(storeAt(W, id, "millbrook_mall"), tileCentre(M, r, c));
  for (const v of M.venues.slice(1)) for (const id of v.stores) storeAt(W, id, v.id);
  W.stores = W.stores.map(orderStore);
  return W;
}

// A store's keys in the world file's order.
function orderStore(s) {
  const out = {};
  for (const k of ["id", "name", "short", "brand", "layout", "x", "y", "venue", "staff"]) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

// ---- The strip mall world ---------------------------------------------------------------------

function stripWorld(W) {
  W = upgradeV10(W);
  const M = W.macro;
  const g = grid(M.tiles);
  // Two buildings of shop units (rows 48-53 and 66-71, columns 45-114)
  // face each other across the open plaza with its pond; each store's door
  // is on the walkway along its building's plaza side (rows 54 and 65). An
  // arcade (a footpath) runs through each building at column 80.
  g.set(48, 53, 45, 114, "#"); g.set(54, 54, 45, 114, "s");
  g.set(66, 71, 45, 114, "#"); g.set(65, 65, 45, 114, "s");
  g.set(48, 53, 80, 80, "-"); g.set(66, 71, 80, 80, "-");
  // A lot behind each building. The north lot is entered by driveways from
  // the roads on either side; the south lot through the three gaps in the
  // hedge along the south road.
  g.set(42, 46, 45, 114, "P");
  g.set(44, 44, 42, 44, "d"); g.set(44, 44, 115, 117, "d");
  g.set(72, 76, 45, 114, "P");
  for (const c of [51, 76, 101]) g.set(77, 77, c, c, "d");
  M.tiles = g.rows();
  M.parking = [
    facility("north_lot", "North lot", "lot", block(42, 46, 45, 114),
      { spaces: 200, vehicle: [[44, 45], [44, 114]], pedestrian: [[46, 80], [46, 45], [46, 114]], search_s: 50, transfer_s: 20 }),
    facility("south_lot", "South lot", "lot", block(72, 76, 45, 114),
      { spaces: 300, vehicle: [[76, 51], [76, 76], [76, 101]], pedestrian: [[72, 80], [72, 45], [72, 114]], search_s: 50, transfer_s: 20 }),
    facility("plaza_kerb", "Kerb spaces on the west road", "kerb", [[55, 41], [56, 41], [57, 41], [62, 41], [63, 41], [64, 41]],
      { spaces: 12, vehicle: [[55, 41], [56, 41], [57, 41], [62, 41], [63, 41], [64, 41]], search_s: 90, transfer_s: 0 }),
  ];
  M.venues = [{ id: "the_strip", name: "The strip", kind: "strip", stores: W.stores.map((s) => s.id), parking: ["north_lot", "south_lot", "plaza_kerb"] }];
  for (const s of W.stores) s.venue = "the_strip";
  W.stores = W.stores.map(orderStore);
  return W;
}

for (const [file, build] of [["worlds/default.world.json", defaultWorld], ["worlds/strip_mall.world.json", stripWorld]]) {
  const W = build(JSON.parse(readFileSync(at(file), "utf8")));
  writeFileSync(at(file), worldText(W));
  console.log(`wrote ${file}`);
}
