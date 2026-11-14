// Tests for the world builder's page side: where a drawn tile is on the
// map, starting a world from a geography, and the files that ship with
// it. The model's side of the same contract is tools/test-world-builder.R.
//
//   node --test tools/test-world-builder.mjs
//
//   - the page's tile, patch and metre helpers agree with the contract in
//     tools/fixtures/spatial-contract.json (the R test checks the model's
//     NetLogoR worlds against the same file)
//   - a store put on the map, taken off and put back, writes out as it was
//   - starting the default world from each geography replaces the map and
//     nothing else: its areas keep their make-up and are repainted onto
//     the districts, its stores go to the sites, Blank clears the map and
//     takes the stores off it
//   - every shipped geography is sound, its sites on land, and the starter
//     worlds in tools/fixtures/geographies/ are what geography.js makes
//     today (node tools/build-geographies.mjs writes them again)
//   - a layout's tills and fitting rooms are counted as the model counts them

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tileAt, tileCentre, patchOf, setPlace, unplace, placed, worldText, clone } from "../js/fashion/world-store.js";
import { loadGeographies, applyGeography, geographyProblems, geographyOfWorld, siteTile, geographyNeeds, BLANK, MAX_AREAS } from "../js/fashion/geography.js";

const file = (p) => new URL(`../${p}`, import.meta.url);
const json = (p) => JSON.parse(readFileSync(file(p), "utf8"));
const contract = json("tools/fixtures/spatial-contract.json");
const defaultWorld = () => json("worlds/default.world.json");
const getFile = async (url) => JSON.parse(readFileSync(url, "utf8"));
const geographies = await loadGeographies(file("worlds/"), getFile);

// Everything in a world but its map and where its stores stand.
const rest = (w) => {
  const x = clone(w);
  delete x.macro.tiles; delete x.macro.area_tiles; delete x.macro.width; delete x.macro.height;
  delete x.macro.parking; delete x.macro.venues;                // built on the map: they go with it
  for (const s of x.stores) delete s.venue;
  x.macro.areas = x.macro.areas.map(({ id, name, colour, budget, segment_mix, size_mix }) => ({ id, name, colour, budget, segment_mix, size_mix }));
  for (const s of x.stores) unplace(s);
  return x;
};

// ---- Where a tile is --------------------------------------------------------------------------

test("a map tile is the patch pxcor = column, pycor = height - 1 - row, and its middle in metres", () => {
  const m = contract.map;
  assert.deepEqual([m.width, m.height, m.patch_m], [defaultWorld().macro.width, defaultWorld().macro.height, defaultWorld().macro.patch_m]);
  for (const k of m.cells) {
    assert.deepEqual(patchOf(m, k.r, k.c), { pxcor: k.pxcor, pycor: k.pycor });
    assert.deepEqual(tileCentre(m, k.r, k.c), { x: k.x, y: k.y });
    assert.deepEqual(tileAt(m, k.x, k.y), { r: k.r, c: k.c });
    // Anywhere in the tile is the tile; its south-west corner too, and not its north-east one.
    const sw = { x: k.c * m.patch_m, y: (m.height - 1 - k.r) * m.patch_m };
    assert.deepEqual(tileAt(m, sw.x, sw.y), { r: k.r, c: k.c });
    assert.deepEqual(tileAt(m, sw.x + m.patch_m - 1e-6, sw.y + m.patch_m - 1e-6), { r: k.r, c: k.c });
    assert.deepEqual(tileAt(m, sw.x + m.patch_m, sw.y + m.patch_m), { r: k.r - 1, c: k.c + 1 });
  }
});

test("a floor tile follows the same rule at half a metre", () => {
  const f = contract.floor;
  const plan = json(f.layout);
  assert.deepEqual([plan.rows[0].length, plan.rows.length], [f.width, f.height]);
  const m = { width: f.width, height: f.height, patch_m: f.cell_m };
  for (const k of f.cells) {
    assert.deepEqual(patchOf(m, k.r, k.c), { pxcor: k.pxcor, pycor: k.pycor });
    assert.deepEqual(tileCentre(m, k.r, k.c), { x: k.x, y: k.y });
    assert.deepEqual(tileAt(m, k.x, k.y), { r: k.r, c: k.c });
  }
});

test("every store in the shipped worlds stands on a land tile of its map", () => {
  for (const p of ["worlds/default.world.json", "worlds/strip_mall.world.json"]) {
    const w = json(p); const m = w.macro;
    for (const s of w.stores) {
      const { r, c } = tileAt(m, s.x, s.y);
      assert.ok(r >= 0 && r < m.height && c >= 0 && c < m.width, `${p}: ${s.id}`);
      assert.notEqual(m.tiles[r][c], "~", `${p}: ${s.id} stands on water`);
    }
  }
});

// ---- A store put on the map ---------------------------------------------------------------------

test("a store taken off the map and put back writes out as it was", () => {
  const w = defaultWorld();
  const text = worldText(w);
  const s = w.stores[0]; const at = [s.x, s.y];
  unplace(s);
  assert.equal(placed(s), false);
  assert.deepEqual(Object.keys(s), ["id", "name", "short", "brand", "layout", "venue", "staff"]);
  setPlace(s, at[0], at[1]);
  assert.deepEqual(Object.keys(s), ["id", "name", "short", "brand", "layout", "x", "y", "venue", "staff"]);
  assert.equal(worldText(w), text);
  setPlace(s, 10, 20);                                      // a store on the map moves where it is
  assert.deepEqual([s.x, s.y, Object.keys(s).indexOf("x")], [10, 20, 5]);
});

// ---- Starting from a geography ------------------------------------------------------------------

test("the geographies are Blank, the default city and the shipped files, every one sound", () => {
  assert.deepEqual(geographies.map((g) => g.id), ["blank", "default", ...json("worlds/geographies/index.json").geographies]);
  for (const g of geographies) {
    assert.deepEqual(geographyProblems(g), [], g.id);
    for (const site of g.sites) {
      const { r, c } = siteTile(g, site);
      assert.ok(r >= 0 && c >= 0 && r < g.height && c < g.width, `${g.id}: site ${site.u}, ${site.v} on the map`);
      assert.notEqual(g.tiles[r][c], "~", `${g.id}: site ${site.u}, ${site.v} on land`);
    }
    if (!g.blank) {
      assert.ok(g.tiles.some((row) => /[1-9]/.test(row)), `${g.id} has homes`);
      for (const a of g.areas) assert.ok(g.area_tiles.some((row) => row.includes(a.key)), `${g.id}: district ${a.name} is painted`);
    }
  }
});

test("starting from a geography changes the map and where the stores stand, nothing else", () => {
  for (const g of geographies.filter((x) => !x.blank && x.id !== "default")) {
    const before = defaultWorld(); const w = defaultWorld();
    const out = applyGeography(w, g);
    assert.deepEqual(rest(w), rest(before), `${g.id}: everything but the map is as it was`);
    assert.deepEqual([w.macro.width, w.macro.height, w.macro.tiles], [g.width, g.height, g.tiles]);
    // The world's areas, kept in order with their make-up, are painted where its districts are.
    assert.deepEqual(w.macro.areas.map((a) => a.id), before.macro.areas.map((a) => a.id));
    const keyOf = new Map(g.areas.map((ga, i) => [ga.key, w.macro.areas[i].key]));
    for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) {
      const ch = g.area_tiles[r][c];
      assert.equal(w.macro.area_tiles[r][c], ch === "." ? "." : keyOf.get(ch));
    }
    // The parking and venues are the geography's, built by hand on its map
    // (tools/build-geographies.mjs); a venue's members are the stores put on its sites.
    assert.deepEqual(w.macro.parking, g.parking, `${g.id}: its parking`);
    assert.equal(w.macro.venues.length, g.venues.length);
    w.macro.venues.forEach((v, k) => {
      const sites = g.venues[k].sites.map((id) => g.sites.find((x) => x.id === id));
      assert.deepEqual(v.stores, w.stores.filter((s) => sites.some((x) => x.u * w.macro.patch_m === s.x && x.v * w.macro.patch_m === s.y)).map((s) => s.id));
      for (const id of v.stores) assert.equal(w.stores.find((s) => s.id === id).venue, v.id);
    });
    // Every store on a site, each site used once, in the order the file gives them.
    assert.deepEqual([out.placed, out.unplaced, out.reused, out.added], [19, 0, 4, 0]);
    w.stores.forEach((s, i) => {
      const site = g.sites[i];
      assert.deepEqual([s.x, s.y], [site.u * w.macro.patch_m, site.v * w.macro.patch_m], `${g.id}: ${s.id}`);
      assert.deepEqual(Object.keys(s).filter((k) => k !== "venue"), Object.keys(before.stores[i]).filter((k) => k !== "venue"), `${g.id}: ${s.id} keeps the file's key order`);
    });
  }
});

test("starting from the default city puts every store back where the default world has it", () => {
  const w = defaultWorld();
  const def = geographies.find((g) => g.id === "default");
  applyGeography(w, geographies.find((g) => g.id === "river_town"));
  applyGeography(w, def);
  assert.equal(worldText(w), worldText(defaultWorld()));
});

test("Blank keeps the map's size, clears it, keeps the areas' make-up, and takes the stores off it", () => {
  const before = defaultWorld(); const w = defaultWorld();
  const out = applyGeography(w, BLANK);
  assert.deepEqual([w.macro.width, w.macro.height], [160, 120]);
  assert.ok(w.macro.tiles.every((r) => r === ".".repeat(160)) && w.macro.area_tiles.every((r) => r === ".".repeat(160)));
  assert.deepEqual(w.macro.areas, before.macro.areas);
  assert.deepEqual([out.placed, out.unplaced], [0, 19]);
  assert.deepEqual(geographyNeeds(w), { unplaced: 19, homes: false });
  assert.deepEqual([w.macro.parking, w.macro.venues], [[], []]);   // nothing built on a blank map
  assert.ok(w.stores.every((s) => !("venue" in s)));
  assert.deepEqual(rest(w), rest(before));
});

test("districts more than the world has areas become new areas with the default make-up, never more than the model allows", () => {
  const w = defaultWorld();
  w.macro.areas = w.macro.areas.slice(0, 2);
  w.macro.area_tiles = w.macro.area_tiles.map((r) => r.replace(/[^.oa]/g, ".").replace(/[^.]/g, (ch) => (["o", "r"].includes(ch) ? ch : ".")));
  const g = geographies.find((x) => x.id === "harbour_bay");
  const out = applyGeography(w, g);
  assert.deepEqual([out.reused, out.added], [2, 2]);
  const added = w.macro.areas.slice(2);
  assert.deepEqual(added.map((a) => a.name), g.areas.slice(2).map((a) => a.name));
  for (const a of added) {
    assert.deepEqual([a.budget, a.segment_mix, a.size_mix], [w.macro.default_makeup.budget, w.macro.default_makeup.segment_mix, w.macro.default_makeup.size_mix]);
    assert.ok(/^[A-Za-z0-9]$/.test(a.key) && w.macro.area_tiles.some((r) => r.includes(a.key)));
  }
  assert.equal(new Set(w.macro.areas.map((a) => a.key)).size, w.macro.areas.length);
  // At the model's limit, a district with no area to take is left unpainted.
  const full = defaultWorld();
  const keys = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN";
  full.macro.areas = Array.from({ length: MAX_AREAS }, (_, i) => ({ ...clone(full.macro.areas[0]), key: keys[i], id: `a${i}`, name: `A${i}` }));
  const g2 = { ...g, areas: [...g.areas, { key: "z", id: "extra", name: "Extra", colour: "#123456" }], area_tiles: g.area_tiles.map((r, i) => (i === 0 ? `z${r.slice(1)}` : r)) };
  const out2 = applyGeography(full, g2);
  assert.equal(full.macro.areas.length, MAX_AREAS);
  assert.equal(out2.added, 0);
});

test("the default city is the default world's own map and stores", () => {
  const w = defaultWorld();
  const g = geographyOfWorld(w, { id: "x", name: "x" });
  assert.deepEqual(geographyProblems(g), []);
  assert.deepEqual(g.sites.map((s) => s.store), w.stores.map((s) => s.id));
  const mm = (v) => Math.round(v * 1000) / 1000;
  assert.deepEqual(g.sites.map((s) => [mm(s.u * 50), mm(s.v * 50)]), w.stores.map((s) => [s.x, s.y]));
});

test("the starter worlds in tools/fixtures/geographies are what geography.js makes today", () => {
  for (const id of json("worlds/geographies/index.json").geographies) {
    const w = defaultWorld();
    applyGeography(w, geographies.find((g) => g.id === id));
    assert.equal(readFileSync(file(`tools/fixtures/geographies/${id}.world.json`), "utf8"), worldText(w), `${id}: run node tools/build-geographies.mjs`);
  }
});

test("the geography files are what tools/build-geographies.mjs draws", () => {
  for (const g of geographies.filter((x) => !x.blank && x.id !== "default")) {
    assert.equal(readFileSync(file(`worlds/geographies/${g.id}.geography.json`), "utf8"), worldText(g));
    assert.equal(g.kind, "fashion-geography");
  }
});

// ---- Floors -------------------------------------------------------------------------------------------

test("a layout's tills and fitting rooms are counted as the model counts them", async () => {
  const dom = await import("./fake-dom.mjs");
  dom.installDom();
  const { layoutCapacity, blankShell } = await import("../js/fashion/layout-editor.js");
  // As model/floors.R reads the prefabs: cashier's places, and 4-connected blocks of F.
  const want = { flagship: { tills: 5, cubicles: 6 }, standard: { tills: 3, cubicles: 4 }, small: { tills: 2, cubicles: 2 }, intimates: { tills: 2, cubicles: 4 } };
  for (const [id, cap] of Object.entries(want)) assert.deepEqual(layoutCapacity(json(`layouts/${id}.layout.json`).rows), cap, id);
  const shell = blankShell();
  assert.deepEqual([shell.length, shell[0].length], [24, 40]);
  assert.equal(shell.at(-1).split("=").length - 1, 4);
  assert.deepEqual(layoutCapacity(shell), { tills: 0, cubicles: 0 });
});
