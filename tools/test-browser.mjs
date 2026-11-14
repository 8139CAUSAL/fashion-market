// The world builder and the simulation in a real browser (headless
// Chromium, Playwright), running the real model in webR: build parking on
// the Macro world's map with pointer events, see the model's preview of it
// (its facility, its households, what it can't reach, a trip), install it
// with Setup, run a day, and check what the simulation did with it, read
// back from R: the outings, the cars parked in the new lot, the visits
// from it, the occupancy, and everyone outdoors on ground they may use.
//
//   node tools/test-browser.mjs [--webr=/path/to/webr/dist]
//
// --webr serves webR from a local copy of its npm package's dist/ in place
// of its CDN (for machines that can't reach the CDN): the dist/ folder of
// https://registry.npmjs.org/webr/-/webr-0.6.0.tgz.
// Needs playwright and a Chromium it can launch.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");      // a global install is found too

const root = fileURLToPath(new URL("..", import.meta.url));
const webrDir = process.argv.find((a) => a.startsWith("--webr="))?.slice(7);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".wasm": "application/wasm", ".gz": "application/gzip", ".data": "application/octet-stream", ".R": "text/plain", ".metadata": "application/json", ".so": "application/octet-stream" };
const COI = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "no-cache" };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", ...COI });
    res.end(await readFile(file));
  } catch { res.writeHead(404, COI); res.end(); }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}/`;

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
if (webrDir) {
  await page.context().route("https://webr.r-wasm.org/v0.6.0/**", async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/v0\.6\.0\//, "");
    try {
      let body = await readFile(join(webrDir, p));
      // The npm package's webr.mjs opens with a banner for Node (createRequire
      // from "module"); the browser gets it without, as the CDN serves it.
      if (p === "webr.mjs") body = body.toString().replace(/^import \{ createRequire \} from 'module';[\s\S]*?var __dirname = [^\n]*\n/, 'const require = undefined; var __filename = ""; var __dirname = "";\n');
      await route.fulfill({ status: 200, body, headers: { "Content-Type": TYPES[extname(p)] ?? "application/octet-stream", ...COI } });
    }
    catch { await route.fulfill({ status: 404, headers: COI }); }
  });
}
// A fresh browser: nothing saved from before.
await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.goto(base);
console.log("Booting the model in webR…");
await page.waitForFunction(() => window.fashion?.ready, null, { timeout: 600_000, polling: 1000 });
const R = (code) => page.evaluate((c) => window.fashion.client.request("EVAL", { code: c }), code);
const num = async (code) => (await R(code)).values[0];

// ---- The installed default world: built parking, real venues ------------------------------------

console.log("The default world");
check(await num("N_FAC") === 11 && await num("N_VENUES") === 4 && await num("sum(STORE_VENUE == 1L)") === 4 && await num("as.numeric(VENUES$kind[1] == 'mall')") === 1,
  "the bundled default world installs in webR with its 11 parking facilities and 4 venues, Millbrook Mall an enclosed mall of 4 stores");

// ---- Building a lot on the map --------------------------------------------------------------------

console.log("Building parking with the world builder");
await page.click("#btn-build");
const ed = "window.fashion.tabs.setup.mapEditor";
await page.waitForFunction(`${ed}.previewState === "fresh"`, null, { timeout: 120_000 });
// Screen point of a tile's middle, on the map editor's canvas.
// The canvas is scrolled into view first, as a user would scroll to it.
const at = async (r, c) => page.evaluate(([r, c, e]) => {
  const m = eval(e); let rect = m.editor.canvas.getBoundingClientRect();
  let p = m.editor.toScreen(r, c);
  // Off the canvas: the Draw view, there (as a user would pan to it).
  if (p.x < 0 || p.y < 0 || p.x + m.editor.zoom > rect.width || p.y + m.editor.zoom > rect.height) { m.editor.drawView({ r, c }); p = m.editor.toScreen(r, c); }
  if (rect.top + p.y < 0 || rect.top + p.y + m.editor.zoom > innerHeight) { window.scrollBy(0, rect.top + p.y - innerHeight / 2); rect = m.editor.canvas.getBoundingClientRect(); }
  return { x: rect.left + p.x + m.editor.zoom / 2, y: rect.top + p.y + m.editor.zoom / 2 };
}, [r, c, ed]);
// Bring a tile into view at the Draw scale.
await page.evaluate(([e]) => { const m = eval(e); m.editor.drawView({ r: 24, c: 128 }); }, [ed]);
const click = async (r, c, opts = {}) => { const p = await at(r, c); await page.mouse.click(p.x, p.y, opts); };
const stroke = async (cells) => {
  const ps = []; for (const [r, c] of cells) ps.push(await at(r, c));
  await page.mouse.move(ps[0].x, ps[0].y); await page.mouse.down();
  for (const p of ps.slice(1)) await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.up();
};
const waitPreview = () => page.waitForFunction(`${ed}.previewState === "fresh" || ${ed}.previewState === "problems"`, null, { timeout: 120_000 });
// Paint four lot tiles (P) by pointer, on the Land layer.
await page.click('button[aria-label="Parking lot"]');
await stroke([[22, 128], [23, 128], [24, 128], [25, 128]]);
const tiles = await page.evaluate((e) => eval(e).world.draft.macro.tiles.slice(22, 26).map((r) => r[128]), ed);
check(JSON.stringify(tiles) === JSON.stringify(["P", "P", "P", "P"]), "four parking-lot tiles painted with the pencil, by pointer, beside Premium Riverside Quay");
await waitPreview();
const before = await page.evaluate((e) => eval(e).preview.warnings.map((w) => w.message), ed);
check(before.some((m) => /parking tiles aren't part of any facility/.test(m)),
  "the model's preview: painted P tiles alone are not parking (\"4 parking tiles aren't part of any facility: no one can park there\")");
// Parking & venues: make the block a facility, then its entrance and exit.
await page.click('button:has-text("Parking & venues")');
await page.click('button:has-text("Make a lot or garage")');
await click(23, 128);
let fac = await page.evaluate((e) => eval(e).world.draft.macro.parking.at(-1), ed);
check(fac?.kind === "lot" && fac.tiles.length === 4 && fac.spaces === 400 && !fac.vehicle_access.length,
  `one click makes the block a lot of ${fac?.tiles.length} tiles; its spaces are set to what it can hold (${fac?.spaces}), and it has no entrance until one is given`);
await waitPreview();
const noEntrance = await page.evaluate((e) => (eval(e).preview.problems ?? []).map((p) => p.message), ed);
check(noEntrance.some((m) => /needs at least one vehicle entrance/.test(m)), "without an entrance the model refuses it: \"needs at least one vehicle entrance\"");
await click(24, 128);                                         // the vehicle-entrance mode is on after making it: beside the road
await page.click('button:has-text("Pedestrian exit")');
await click(23, 128);                                         // beside the store's door
fac = await page.evaluate((e) => eval(e).world.draft.macro.parking.at(-1), ed);
await page.waitForFunction(`${ed}.previewState === "fresh"`, null, { timeout: 120_000 });
const pv = await page.evaluate((e) => { const p = eval(e).preview; return { stat: p.parking.at(-1), warnings: p.warnings.length }; }, ed);
check(JSON.stringify(fac.vehicle_access) === "[[24,128]]" && JSON.stringify(fac.pedestrian_access) === "[[23,128]]" && pv.stat.entrances > 0 && pv.stat.households > 1000 && pv.stat.demand > 0 && pv.stat.stores.length > 0,
  `an entrance beside the road and an exit beside the store's door, by click: the model's preview has ${pv.stat.households} households able to drive to it, ${pv.stat.demand} for whom it's the place to park, and ${pv.stat.stores.length} stores within walking distance`);
// Its spaces set to 6.
await page.evaluate((e) => {
  const card = eval(e).transport.parkingCard.root; const input = [...card.querySelectorAll("label.field")].find((l) => /Spaces/.test(l.textContent)).querySelector("input");
  input.value = "6"; input.dispatchEvent(new Event("change"));
}, ed);
check(await page.evaluate((e) => eval(e).world.draft.macro.parking.at(-1).spaces, ed) === 6, "its spaces set to 6 in its card");
// A kerb space on the street, and one taken away.
await page.click('button:has-text("Kerb space")');
await click(89, 122);
const kerb = await page.evaluate((e) => eval(e).world.draft.macro.parking.at(-1), ed);
await page.keyboard.down("Shift"); await click(89, 122); await page.keyboard.up("Shift");
const gone = await page.evaluate((e) => eval(e).world.draft.macro.parking.every((f) => f.id !== "kerb_spaces"), ed);
check(kerb.kind === "kerb" && kerb.spaces === 1 && JSON.stringify(kerb.tiles) === "[[89,122]]" && gone,
  "a click on a street marks exactly one kerb space; a Shift-click takes it away, and the facility with it");
// A trip, as the model would make it, to Ours Eastfield.
await page.evaluate((e) => { eval(e).selected = "ours_ef"; }, ed);
await page.click('button:has-text("Trip from a home")');
await click(96, 114);
await page.waitForFunction(`${ed}.transport.trip && !${ed}.transport.trip.busy`, null, { timeout: 60_000 });
const trip = await page.evaluate((e) => eval(e).transport.trip, ed);
check(trip.ok && trip.walk.ok && (trip.mode === "walk" || trip.mode === "drive") && trip.walk.route.length > 2,
  `the trip tool, from a home tile to Ours Eastfield: ${trip.mode === "drive" ? `by car via ${trip.drive.facility}` : "on foot"} (${trip.walk.min.toFixed(1)} min on foot), its route drawn from the model's own route`);

// ---- Setup, a day, and what the simulation did -----------------------------------------------------

console.log("Setup and a day");
await page.click("#btn-setup");
await page.waitForFunction(async () => (await window.fashion.client.request("EVAL", { code: "N_FAC" })).values[0] === 12, null, { timeout: 300_000, polling: 2000 });
check(await num("FAC$spaces[12]") === 6 && await num("as.numeric(FAC$kind[12] == 'lot')") === 1, "Setup installs the drawn lot: 12 facilities in the simulation, the new one a lot of 6 spaces");
await page.selectOption("#speed", "day");
const t0 = Date.now();
await page.click("#btn-step");
await page.waitForFunction(async () => (await window.fashion.client.request("EVAL", { code: "day" })).values[0] >= 2, null, { timeout: 600_000, polling: 500 });
console.log(`    (a market day at season pace took ${((Date.now() - t0) / 1000).toFixed(1)} s in webR)`);
const used = await num("sum(prev$d$outing > 0)");
const facts = await R(`with(list(), { m <- pk$m[seq_len(pk$n), , drop = FALSE]; c(pk$n, sum(m[, "fac"] == 12), sum(tally$no_space[1, ]), max(tally$peak[1, ] - FAC$spaces), sum(tally$next_visits[1, ]), sum(tally$outing_mode[1, ])) })`);
const [, , turned, over, follow, outings] = facts.values;
const yesterday = await R(`c(sum(tally$parked[1, ]), tally$parked[1, 12], tally$peak[1, 12])`);
check(yesterday.values[0] > 100 && yesterday.values[1] > 0 && yesterday.values[2] <= 6 && over <= 0 && follow > 0 && outings > 500 && used > 0,
  `a day run in webR: ${yesterday.values[0]} cars parked, ${yesterday.values[1]} of them in the new lot (never more than its 6 at once: ${yesterday.values[2]}), ${turned} arrivals found a facility full, no facility over capacity, ${follow} follow-on store visits from ${outings} outings`);
// Watch pace: everyone outdoors, on ground they may use.
await page.selectOption("#speed", "600");
await page.click("#btn-step"); await page.click("#btn-step");
await R("advance(4 * 3600)");
const out = await R(`local({ o <- outside_at(clock); T <- city
  tile <- function(x, y) floor(x / T$patch) * T$ny + (T$ny - floor(y / T$patch))
  inside <- function(x, y) any(vapply(T$plans, function(p) { r <- (T$ny - y / T$patch); c <- x / T$patch; r >= p$r0 && r < p$r0 + p$PH * p$cell_m / T$patch && c >= p$c0 && c < p$c0 + p$PW * p$cell_m / T$patch }, TRUE))
  car <- o$kind == 1L; walk <- o$kind == 2L; park <- o$kind == 3L
  t <- tile(o$x, o$y)
  c(length(o$x), sum(car), sum(walk), sum(park),
    sum(car & !(T$veh$open[t] | t %in% unlist(FAC$tiles))),
    sum(walk & !(T$walk$open[t] | vapply(seq_along(o$x), function(i) inside(o$x[i], o$y[i]), TRUE) | t %in% unlist(FAC$tiles))),
    sum(park & !(t %in% unlist(FAC$tiles)))) })`);
const [n, cars, walkers, parked, badCar, badWalk, badPark] = out.values;
check(n > 0 && cars > 0 && walkers > 0 && parked > 0 && badCar === 0 && badWalk === 0 && badPark === 0,
  `at 14:00, at watch pace: ${n} people and cars outdoors (${cars} driving, ${walkers} walking, ${parked} parked); every car on a drivable tile (or entering its facility), every walker on walkable ground, a facility's exit or a mall's corridors, every parked car in its facility`);
// The Market tab's Getting about card.
await page.click("#tab-btn-market");
await page.waitForTimeout(1500);
const card = await page.evaluate(() => window.fashion.tabs.market.travelBox?.textContent ?? "");
check(/Outings home/.test(card) && /Store visits/.test(card) && /Found it full/.test(card), "the Market tab's Getting about card shows the outings, store visits and parking from the simulation");
check(!errors.length, errors.length ? `no errors in the page: ${errors.slice(0, 3).join(" | ")}` : "no errors in the page");

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll browser checks passed.");
process.exit(failures ? 1 : 0);
