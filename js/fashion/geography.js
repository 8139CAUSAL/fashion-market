// Starting geographies: maps to begin a world's macro geography from.
//
// A geography is the map only: its size in tiles, its land tiles, its
// districts painted as areas, and the sites its stores can stand on.
//
//   Blank          open land and nothing else, the size the map is now
//   Default city   the default world's map (worlds/default.world.json)
//   the rest       worlds/geographies/*.geography.json (index.json lists
//                  them; tools/build-geographies.mjs made them)
//
// Starting from one (applyGeography) changes the draft's map and nothing
// else in the world:
//   - the map's width, height and tiles become the geography's; a tile
//     stays as many metres as the map's settings say
//   - the world's areas are kept, each with its households' make-up, and
//     repainted onto the geography's districts: a district takes the area
//     with its id if the world has one, then the world's areas in order;
//     a district more than the world has areas becomes a new area with
//     the map's default make-up. An area left over keeps its make-up and
//     has no tiles.
//   - the stores go to the geography's sites: a store to the site kept for
//     its id (the default world's stores, on the default map), then the
//     rest in order; stores more than there are sites come off the map
//     and wait on the Stores layer
// The map editor asks before it does this, and keeps the old map in its
// undo history.
//
// A file:
//   { "kind": "fashion-geography", "version": 1, "id", "name", "about",
//     "width", "height", "tiles": [rows], "area_tiles": [rows],
//     "areas": [{ "key", "id", "name", "colour" }],
//     "sites": [{ "u", "v" }] }
// A site is a point in tiles east (u) and north (v) of the map's
// south-west corner, the way the model measures the map (in metres):
// the middle of the tile in row r, column c is u = c + 0.5,
// v = height - r - 0.5.

import { clone, newId, newName, placed } from "./world-store.js";

export const GEOGRAPHY_KIND = "fashion-geography";
export const AREA_KEYS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const MAX_AREAS = 40;                    // as model/city.R allows

export const BLANK = {
  id: "blank", name: "Blank", blank: true, areas: [], sites: [],
  about: "Open land and nothing else, the size the map is now: paint the homes, the roads and the water yourself.",
};

// The geographies to start from: Blank, the default world's map, and the
// files worlds/geographies/index.json lists. `get` fetches a URL as JSON.
export async function loadGeographies(base = new URL("../../worlds/", import.meta.url), get = getJson) {
  const index = await get(new URL("geographies/index.json", base));
  const [world, ...files] = await Promise.all([get(new URL("default.world.json", base)),
    ...index.geographies.map((id) => get(new URL(`geographies/${id}.geography.json`, base)))]);
  return [BLANK, geographyOfWorld(world, { id: "default", name: "Default city",
    about: "The default world's map: four districts either side of a river, on a grid of roads." }), ...files];
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

// A world's map as a geography: its tiles, its areas as districts, and a
// site where each of its stores stands, kept for that store.
export function geographyOfWorld(world, meta) {
  const m = world.macro;
  return {
    ...meta, width: m.width, height: m.height, tiles: m.tiles.slice(), area_tiles: m.area_tiles.slice(),
    areas: m.areas.map(({ key, id, name, colour }) => ({ key, id, name, colour })),
    sites: world.stores.filter(placed).map((s) => ({ u: s.x / m.patch_m, v: s.y / m.patch_m, store: s.id })),
  };
}

// The tile a site stands on: row and column from the north-west corner.
export function siteTile(g, site) { return { r: g.height - 1 - Math.floor(site.v), c: Math.floor(site.u) }; }

// What's wrong with a geography, in words (none: it can be started from).
export function geographyProblems(g) {
  const out = [];
  if (g.blank) return out;
  if (!(Number.isInteger(g.width) && Number.isInteger(g.height) && g.width >= 8 && g.height >= 8 && g.width <= 600 && g.height <= 600)) out.push("width and height must be whole numbers from 8 to 600");
  for (const what of ["tiles", "area_tiles"]) {
    if (!Array.isArray(g[what]) || g[what].length !== g.height || !g[what].every((r) => typeof r === "string" && r.length === g.width)) out.push(`${what} must be ${g.height} rows of ${g.width} characters`);
  }
  if (out.length) return out;
  const land = new Set(".~ps=+123456789");
  if (!g.tiles.every((r) => [...r].every((ch) => land.has(ch)))) out.push("tiles holds a character that isn't a map tile");
  const keys = new Set(g.areas.map((a) => a.key));
  if (keys.size !== g.areas.length || new Set(g.areas.map((a) => a.id)).size !== g.areas.length) out.push("two districts share a key or an id");
  if (!g.area_tiles.every((r) => [...r].every((ch) => ch === "." || keys.has(ch)))) out.push("area_tiles holds a key no district has");
  if (!g.tiles.some((r) => /[1-9]/.test(r))) out.push("no home tiles for households to live on");
  for (const s of g.sites) {
    const { r, c } = siteTile(g, s);
    if (!(r >= 0 && r < g.height && c >= 0 && c < g.width)) out.push(`a site is off the map (${s.u}, ${s.v})`);
    else if (g.tiles[r][c] === "~") out.push(`a site stands on water (row ${r + 1}, column ${c + 1})`);
  }
  return out;
}

// Starts the draft `d`'s map from geography `g`, in place. Returns what
// became of the stores and the areas.
export function applyGeography(d, g) {
  const m = d.macro;
  const W = g.blank ? m.width : g.width; const H = g.blank ? m.height : g.height;
  const empty = () => Array.from({ length: H }, () => ".".repeat(W));

  // The districts, as the world's areas.
  const keyOf = new Map();                       // a district's key -> the key of the world's area painted there
  let reused = 0; let added = 0;
  if (!g.blank) {
    const free = m.areas.slice();
    const take = (a) => { free.splice(free.indexOf(a), 1); reused++; return a.key; };
    const rest = [];
    for (const ga of g.areas) { const a = free.find((x) => x.id === ga.id); if (a) keyOf.set(ga.key, take(a)); else rest.push(ga); }
    for (const ga of rest) {
      if (free.length) { keyOf.set(ga.key, take(free[0])); continue; }
      if (m.areas.length >= MAX_AREAS) continue;                  // no room for another area: the district is left unpainted
      const name = newName(m.areas, ga.name);
      const a = { key: [...AREA_KEYS].find((k) => !m.areas.some((x) => x.key === k)), id: newId(m.areas, name), name, colour: ga.colour,
        budget: m.default_makeup.budget, segment_mix: clone(m.default_makeup.segment_mix), size_mix: clone(m.default_makeup.size_mix) };
      m.areas.push(a); added++;
      keyOf.set(ga.key, a.key);
    }
  }

  m.width = W; m.height = H;
  m.tiles = g.blank ? empty() : g.tiles.slice();
  m.area_tiles = g.blank ? empty() : g.area_tiles.map((row) => [...row].map((ch) => (ch === "." ? "." : keyOf.get(ch) ?? ".")).join(""));

  // The stores, on the sites: metres east and north of the south-west
  // corner, to the millimetre.
  const sites = (g.sites ?? []).slice();
  const mm = (v) => Math.round(v * m.patch_m * 1000) / 1000;
  const put = (s, site) => { s.x = mm(site.u); s.y = mm(site.v); };
  const waiting = [];
  let n = 0;
  for (const s of d.stores) {
    const i = sites.findIndex((x) => x.store === s.id);
    if (i >= 0) { put(s, sites.splice(i, 1)[0]); n++; } else waiting.push(s);
  }
  for (const s of waiting) {
    const site = sites.shift();
    if (site) { put(s, site); n++; } else { delete s.x; delete s.y; }
  }
  return { placed: n, unplaced: d.stores.length - n, reused, added };
}

// What a draft's map still needs before Setup can start it, as far as the
// page can tell without the model (which says the rest): stores not on
// the map yet, and whether anyone has anywhere to live.
export function geographyNeeds(d) {
  return { unplaced: d.stores.filter((s) => !placed(s)).length, homes: d.macro.tiles.some((r) => /[1-9]/.test(r)) };
}
