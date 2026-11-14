// Draws the starting geographies in worlds/geographies/ (index.json lists
// them): maps the Macro world's editor can start a world from, each a
// file of tiles, districts and store sites (js/fashion/geography.js says
// how one is used). Nothing here is random: the same script writes the
// same files.
//
// It also writes, for each, the default world started from it, as the
// editor would (tools/fixtures/geographies/<id>.world.json): the worlds
// tools/test-world-builder.R checks and runs with the model, and
// tools/test-world-builder.mjs keeps in step with geography.js.
//
//   node tools/build-geographies.mjs
//
//   river_town    120 x 90 tiles: a river running north to south with
//                 three bridges, an old town on its west bank, a newer
//                 east bank, a village and an estate, parks along the water
//   harbour_bay   140 x 100 tiles: a coast along the south with a bay cut
//                 into it and a bridge across its mouth, a coast road, a
//                 dense harbour front and three districts round it

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { worldText } from "../js/fashion/world-store.js";
import { GEOGRAPHY_KIND, geographyProblems, applyGeography } from "../js/fashion/geography.js";

const out = new URL("../worlds/geographies/", import.meta.url);
const fixtures = new URL("fixtures/geographies/", import.meta.url);

// A map being drawn: a grid of tiles, row 0 the north edge.
function sheet(W, H) {
  const t = Array.from({ length: H }, () => Array(W).fill("."));
  const inside = (r, c) => r >= 0 && c >= 0 && r < H && c < W;
  return {
    W, H, t, inside,
    get: (r, c) => (inside(r, c) ? t[r][c] : null),
    set(r, c, ch) { if (inside(r, c)) t[r][c] = ch; },
    each(fn) { for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) fn(r, c, t[r][c]); },
    rows: () => t.map((row) => row.join("")),
  };
}

// Homes, denser towards each centre: [row, col, the density at its middle, how far it spreads].
function homes(s, centres) {
  s.each((r, c) => {
    let d = 0;
    for (const [cr, cc, peak, spread] of centres) d = Math.max(d, peak * Math.exp(-((r - cr) ** 2 + (c - cc) ** 2) / (2 * spread * spread)));
    const k = Math.round(d);
    if (k >= 1) s.set(r, c, String(Math.min(9, k)));
  });
}

// A road: on land a road, over water a bridge where one is wanted (else the water stays).
const road = (s, r, c, bridge) => { const ch = s.get(r, c); if (ch === null) return; if (ch === "~" || ch === "+") { if (bridge) s.set(r, c, "+"); } else s.set(r, c, "="); };

// Shops in a block, and a store site in the middle of each of its tiles.
function shops(s, sites, r0, c0, h = 2, w = 3) {
  const cluster = [];
  for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) {
    if (["~", "+", "="].includes(s.get(r, c))) continue;
    s.set(r, c, "s");
    cluster.push({ u: c + 0.5, v: s.H - r - 0.5 });
  }
  sites.push(cluster);
}

// The districts: each tile of land near a centre takes the nearest one
// (as far as its radius), [row, col, radius].
function districts(s, centres, keys, allowed = () => true) {
  const a = Array.from({ length: s.H }, () => Array(s.W).fill("."));
  s.each((r, c, ch) => {
    if (ch === "~" || !allowed(r, c)) return;
    let best = -1; let bd = 1;
    centres.forEach(([cr, cc, rad], i) => { const d = Math.hypot(r - cr, c - cc) / rad; if (d < bd) { bd = d; best = i; } });
    if (best >= 0) a[r][c] = keys[best];
  });
  return a.map((row) => row.join(""));
}

// The sites in turn from each cluster, so a brand's stores, taken in order, spread over the map.
function inTurn(clusters) {
  const sites = [];
  for (let i = 0; clusters.some((cl) => i < cl.length); i++) for (const cl of clusters) if (i < cl.length) sites.push(cl[i]);
  return sites;
}

// ---- River town -----------------------------------------------------------------------------------

function riverTown() {
  const s = sheet(120, 90);
  const mid = (r) => 62 + 7 * Math.sin(r / 13);                 // the river's middle, by row
  homes(s, [[45, 40, 9, 13], [45, 84, 7, 12], [14, 22, 5, 6], [74, 96, 4, 6]]);
  s.each((r, c) => { if (Math.abs(c - mid(r)) <= 2.4) s.set(r, c, "~"); });
  // Parks: the banks, and a square in the old town.
  s.each((r, c, ch) => {
    if (ch === "~" || r < 18 || r > 72) return;
    for (let dc = -2; dc <= 2; dc++) if (s.get(r, c + dc) === "~") { s.set(r, c, "p"); return; }
  });
  for (let r = 33; r <= 39; r++) for (let c = 27; c <= 34; c++) s.set(r, c, "p");
  // Roads: five east to west (three of them bridging the river), eight north to south clear of it.
  for (const r of [14, 30, 45, 60, 76]) for (let c = 0; c < s.W; c++) road(s, r, c, [30, 45, 60].includes(r));
  for (const c of [10, 24, 40, 50, 74, 84, 98, 110]) for (let r = 0; r < s.H; r++) road(s, r, c, false);
  const clusters = [];
  shops(s, clusters, 42, 36); shops(s, clusters, 42, 80); shops(s, clusters, 12, 20); shops(s, clusters, 73, 94); shops(s, clusters, 58, 76);
  const areas = [
    { key: "a", id: "old_town", name: "Old Town", colour: "#f1dfc1" }, { key: "b", id: "east_bank", name: "East Bank", colour: "#d9e8cf" },
    { key: "c", id: "mill_village", name: "Mill Village", colour: "#e0dcef" }, { key: "d", id: "southfields", name: "Southfields", colour: "#f2d9d3" }];
  const west = (r, c) => c < mid(r);
  const area_tiles = districts(s, [[45, 40, 30], [45, 84, 28], [14, 22, 13], [74, 96, 13]], areas.map((a) => a.key),
    (r, c) => { const d0 = Math.hypot(r - 45, c - 40) / 30; const d1 = Math.hypot(r - 45, c - 84) / 28; return !(d0 < 1 && !west(r, c) && d0 < d1) && !(d1 < 1 && west(r, c) && d1 < d0); });
  return { kind: GEOGRAPHY_KIND, version: 1, id: "river_town", name: "River town",
    about: "A river running north to south with three bridges: an old town on the west bank, a newer east bank, a village and an estate, with parks along the water.",
    width: s.W, height: s.H, tiles: s.rows(), area_tiles, areas, sites: inTurn(clusters) };
}

// ---- Harbour bay --------------------------------------------------------------------------------

function harbourBay() {
  const s = sheet(140, 100);
  // The coast, by column: the sea is south of it, and a bay is cut into its middle.
  const coast = (c) => 80 + 5 * Math.sin(c / 17) - 20 * Math.exp(-(((c - 70) / 16) ** 2));
  const shore = (c) => Math.floor(coast(c));                   // the first row of sea
  homes(s, [[47, 70, 9, 10], [20, 62, 6, 12], [60, 26, 6, 11], [58, 112, 7, 11], [16, 118, 4, 7]]);
  s.each((r, c) => { if (r >= shore(c)) s.set(r, c, "~"); });
  // The coast road, three tiles in from the sea, joined side to side from column to column; the seafront south of it is park.
  const lane = (c) => shore(c) - 3;
  for (let c = 0; c < s.W; c++) {
    for (let r = lane(c); r < shore(c); r++) if (r > lane(c)) s.set(r, c, "p");
    const next = c + 1 < s.W ? lane(c + 1) : lane(c);
    for (let r = Math.min(lane(c), next); r <= Math.max(lane(c), next); r++) road(s, r, c, false);
  }
  // A hill park in the north-east.
  for (let r = 30; r <= 38; r++) for (let c = 84; c <= 92; c++) s.set(r, c, "p");
  // Roads: three east to west, eight north to south down to the coast road, and one across the bay's mouth, a bridge over the water.
  for (const r of [12, 28, 44]) for (let c = 0; c < s.W; c++) road(s, r, c, false);
  for (const c of [14, 30, 46, 62, 78, 94, 110, 126]) for (let r = 0; r <= lane(c); r++) road(s, r, c, false);
  for (let c = 30; c <= 110; c++) road(s, 72, c, true);
  const clusters = [];
  shops(s, clusters, 49, 64); shops(s, clusters, 25, 58); shops(s, clusters, 58, 26); shops(s, clusters, 56, 106); shops(s, clusters, 14, 122);
  const areas = [
    { key: "h", id: "harbourside", name: "Harbourside", colour: "#f1dfc1" }, { key: "u", id: "uptown", name: "Uptown", colour: "#d9e8cf" },
    { key: "w", id: "westcliff", name: "Westcliff", colour: "#e0dcef" }, { key: "e", id: "eastgate", name: "Eastgate", colour: "#f2d9d3" }];
  const area_tiles = districts(s, [[47, 70, 17], [18, 80, 34], [60, 26, 26], [58, 112, 24]], areas.map((a) => a.key));
  return { kind: GEOGRAPHY_KIND, version: 1, id: "harbour_bay", name: "Harbour bay",
    about: "A coast along the south with a bay cut into it and a bridge across its mouth: a dense harbour front, a coast road and seafront, and three districts round it.",
    width: s.W, height: s.H, tiles: s.rows(), area_tiles, areas, sites: inTurn(clusters) };
}

mkdirSync(out, { recursive: true });
const all = [riverTown(), harbourBay()];
for (const g of all) {
  const problems = geographyProblems(g);
  if (problems.length) throw new Error(`${g.id}: ${problems.join("; ")}`);
  writeFileSync(new URL(`${g.id}.geography.json`, out), worldText(g));
  const count = (ch) => g.tiles.join("").split(ch).length - 1;
  console.log(`${g.id}: ${g.width} x ${g.height}, ${g.tiles.join("").replace(/[^1-9]/g, "").length} home tiles, ${count("=")} road, ${count("+")} bridge, ${count("~")} water, ${g.sites.length} store sites, ${g.areas.length} districts`);
}
writeFileSync(new URL("index.json", out), worldText({ geographies: all.map((g) => g.id) }));

// The default world, started from each.
mkdirSync(fixtures, { recursive: true });
const base = readFileSync(new URL("../worlds/default.world.json", import.meta.url), "utf8");
for (const g of all) {
  const w = JSON.parse(base);
  const how = applyGeography(w, g);
  writeFileSync(new URL(`${g.id}.world.json`, fixtures), worldText(w));
  console.log(`  the default world on ${g.id}: ${how.placed} stores on its sites, ${how.unplaced} waiting; ${how.reused} areas repainted, ${how.added} added`);
}
