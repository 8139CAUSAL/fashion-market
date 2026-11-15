// The Market and Store tabs' 3D views in a real browser (headless Chromium,
// Playwright, WebGL), with the real model running in webR: what they draw
// is the installed NetLogoR world and its agents, read back from R; a
// click in 3D does what a click in 2D does; switching 2D and 3D leaves the
// season exactly as it would have been; the scenery is rebuilt by a Setup
// that installs a world and by nothing else; and without WebGL the page
// stays in 2D.
//
//   node tools/test-browser-3d.mjs [--webr=/path/to/webr/dist]
//
// --webr serves webR from a local copy of its npm package's dist/, as
// tools/test-browser.mjs does. Needs playwright and a Chromium it can launch.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

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
const check = (ok, what, detail) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) { failures++; if (detail !== undefined) console.log(`       measured: ${JSON.stringify(detail)}`); } };

// SwiftShader: WebGL without a GPU, as on a CI machine.
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
if (webrDir) {
  await context.route("https://webr.r-wasm.org/v0.6.0/**", async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/v0\.6\.0\//, "");
    try {
      let body = await readFile(join(webrDir, p));
      if (p === "webr.mjs") body = body.toString().replace(/^import \{ createRequire \} from 'module';[\s\S]*?var __dirname = [^\n]*\n/, 'const require = undefined; var __filename = ""; var __dirname = "";\n');
      await route.fulfill({ status: 200, body, headers: { "Content-Type": TYPES[extname(p)] ?? "application/octet-stream", ...COI } });
    } catch { await route.fulfill({ status: 404, headers: COI }); }
  });
}

// ---- Without WebGL ---------------------------------------------------------------------------------------

console.log("Without WebGL");
{
  const page = await context.newPage();
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return /webgl/.test(kind) ? null : get.call(this, kind, ...rest); };
  });
  const loaded = [];
  page.on("request", (r) => { if (/vendor\/three\.js/.test(r.url())) loaded.push(r.url()); });
  await page.goto(base);
  // The switch is on the page from the start (under the loading card, while the model boots).
  await page.evaluate(() => document.querySelector("#tab-market .view-switch .seg button:nth-child(2)").click());
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => ({ is3d: window.fashion.tabs.market.dims.is3d, disabled: document.querySelector("#tab-market .view-switch .seg button:nth-child(2)").disabled,
    banner: document.querySelector(".banner")?.textContent ?? "", map2d: !document.querySelector("#tab-market .map-wrap:not(.view3d-wrap)").hidden }));
  check(!s.is3d && s.disabled && /3D isn't available/.test(s.banner) && s.map2d && !loaded.length,
    "with no WebGL, 3D stays off: the 2D map stays, the 3D button is disabled with the reason given, and Three.js is never loaded");
  await page.close();
}

// ---- The installed world in 3D ----------------------------------------------------------------------------

const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const threeRequests = [];
page.on("request", (r) => { if (/vendor\/three\.js/.test(r.url())) threeRequests.push(r.url()); });
await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.goto(base);
console.log("Booting the model in webR…");
await page.waitForFunction(() => window.fashion?.ready, null, { timeout: 600_000, polling: 1000 });
const R = (code) => page.evaluate((c) => window.fashion.client.request("EVAL", { code: c }), code);
const nums = async (code) => (await R(code)).values;
check(!threeRequests.length, "the page boots and runs without loading Three.js: nothing 3D is fetched until a 3D view is asked for");

console.log("Market 3D");
await page.click('#tab-market .view-switch button:text-is("3D")');
await page.waitForFunction(() => window.fashion.tabs.market.dims.view?.renders > 0, null, { timeout: 60_000 });
const gl = await page.evaluate(() => { const v = window.fashion.tabs.market.dims.view; const c = v.renderer.getContext(); return { webgl: !!c, w: v.canvas.width, h: v.canvas.height, hidden2d: document.querySelector("#tab-market .map-wrap:not(.view3d-wrap)").hidden }; });
check(gl.webgl && gl.w > 100 && gl.hidden2d && threeRequests.length === 1, `the 3D switch loads the pinned Three.js once and draws the market with WebGL (${gl.w}×${gl.h}), the 2D map set aside`);

// The stores, where R has them.
const storeXY = await nums("c(STORES$x, STORES$y)");
const placed = await page.evaluate(() => {
  const v = window.fashion.tabs.market.dims.view; const m = new v.THREE.Matrix4(); const p = new v.THREE.Vector3();
  return Array.from({ length: v.storeMesh.count }, (_, i) => { v.storeMesh.getMatrixAt(i, m); p.setFromMatrixPosition(m); return [p.x, p.z]; });
});
const ns = storeXY.length / 2;
check(placed.length === ns && placed.every(([X, Z], i) => X === storeXY[i] && Z === -storeXY[ns + i]),
  `all ${ns} stores stand in 3D at R's STORES$x, STORES$y (X = x, Z = −y), no mirroring, turn or offset`);
// The tiles, as NetLogoR's map world has them.
const tiles = await page.evaluate(() => {
  const v = window.fashion.tabs.market.dims.view; const M = v.model; const g = v.geo;
  const rc = (X, Z) => { const r = M.frame.ny - 1 - Math.floor(-Z / M.frame.patch); const c = Math.floor(X / M.frame.patch); return g.land[r * g.nx + c]; };
  return { buildings: M.buildings.every((b) => rc(b.X, b.Z) === 8), houses: Array.from({ length: M.houses.n }, (_, i) => rc(M.houses.X[i], M.houses.Z[i])).every((v2) => v2 === 3),
    n: M.houses.n, homeTiles: M.tiles.homes.length, water: M.tiles.water.length };
});
const water = (await nums("sum(of(world = MACRO$world, agents = patches(MACRO$world), var = 'land') == 1)"))[0];
check(tiles.houses && tiles.buildings && tiles.water === water,
  `the scenery is NetLogoR's map world: ${tiles.n} houses all on its home patches (${tiles.homeTiles}), buildings on building patches, ${tiles.water} water tiles as of() reads them`);

// Everyone outdoors at watch pace: the frame's travellers, and R's.
await page.selectOption("#speed", "600");
await R("advance(4 * 3600)");
await page.click("#btn-step");
await page.waitForTimeout(1500);
const out = await page.evaluate(() => {
  const tab = window.fashion.tabs.market; const v = tab.dims.view; const t = tab.shown.travellers;
  const m = new v.THREE.Matrix4(); const p = new v.THREE.Vector3(); const at = (mesh, i) => { mesh.getMatrixAt(i, m); p.setFromMatrixPosition(m); return [p.x, p.z]; };
  const ok = { car: 0, walker: 0, parked: 0 }; const n = { car: 0, walker: 0, parked: 0 }; const names = { 1: "car", 2: "walker", 3: "parked" };
  for (let i = 0; i < t.n; i++) {
    const k = names[t.kind[i]]; const [X, Z] = at(v.agents[k], n[k]++);
    if (X === t.x[i] && Z === -t.y[i]) ok[k]++;
  }
  return { n: t.n, counts: Object.fromEntries(Object.entries(v.agents).map(([k, mesh]) => [k, mesh.count])), ok, x: Array.from(t.x), y: Array.from(t.y), kind: Array.from(t.kind) };
});
const rt = await nums("local({ tr <- travellers_at(clock); c(length(tr$x), round(tr$x), round(tr$y), tr$kind) })");
const nr = rt[0];
const same = nr === out.n && out.x.every((x, i) => x === rt[1 + i] && out.y[i] === rt[1 + nr + i] && out.kind[i] === rt[1 + 2 * nr + i]);
check(out.n > 0 && same && out.ok.car === out.counts.car && out.ok.walker === out.counts.walker && out.ok.parked === out.counts.parked,
  `at watch pace, everyone outdoors in 3D is R's travellers_at(clock): ${out.counts.car} cars driving, ${out.counts.walker} walking, ${out.counts.parked} parked, each at (x, −y) of the frame`);

// Ticking moves the agents, never the scenery; a hidden view draws nothing.
const builds0 = await page.evaluate(() => window.fashion.tabs.market.dims.view.staticBuilds);
for (let k = 0; k < 5; k++) await page.click("#btn-step");
await page.waitForTimeout(800);
const builds1 = await page.evaluate(() => window.fashion.tabs.market.dims.view.staticBuilds);
check(builds0 === 1 && builds1 === 1, "five ticks later the scenery is the one built at first: agents move, nothing static is rebuilt");
await page.click("#tab-btn-funnel");
const r0 = await page.evaluate(() => window.fashion.tabs.market.dims.view.renders);
for (let k = 0; k < 3; k++) await page.click("#btn-step");
await page.waitForTimeout(800);
const r1 = await page.evaluate(() => window.fashion.tabs.market.dims.view.renders);
check(r1 === r0, "on another tab the 3D market draws nothing");
await page.click("#tab-btn-market");
await page.waitForTimeout(500);

// How long a frame of the whole market takes to draw here (SwiftShader: the CPU, no GPU).
const timing = await page.evaluate(() => {
  const v = window.fashion.tabs.market.dims.view; const t0 = performance.now();
  for (let i = 0; i < 10; i++) v.render();
  return { ms: (performance.now() - t0) / 10, tris: v.renderer.info.render.triangles, calls: v.renderer.info.render.calls };
});
console.log(`    (the whole default market in 3D: ${timing.calls} draw calls, ${timing.tris.toLocaleString()} triangles, ${timing.ms.toFixed(1)} ms a frame in SwiftShader)`);

// ---- The 3D camera on the Market tab -----------------------------------------------------------------------

console.log("Market 3D camera");
const camPose = (tab) => page.evaluate((t) => { const v = window.fashion.tabs[t].dims.view;
  return { ...v.currentPose(), mode: v.cameraState.mode, label: v.cameraState.label, note: v.cameraState.note, moving: !!v.transition, raf: v.raf }; }, tab);
const settled = (tab) => page.waitForFunction((t) => { const v = window.fashion.tabs[t].dims.view; return !v.transition && !v.raf; }, tab, { timeout: 10_000 });
const btn = (tab, label) => `#tab-${tab} .camera-bar button:text-is("${label}")`;
const attr = (sel, name) => page.getAttribute(sel, name);
// Every message the page sends the simulation from here on, to show that camera actions send none.
await page.evaluate(() => {
  const c = window.fashion.client; window.__sent = [];
  const request = c.request.bind(c); const post = c.post.bind(c);
  c.request = (type, payload) => { window.__sent.push(type); return request(type, payload); };
  c.post = (type, payload) => { window.__sent.push(type); return post(type, payload); };
});
const sentSince = async () => page.evaluate(() => window.__sent.splice(0));
await sentSince();
const bar = await page.evaluate(() => ({ shown: !document.querySelector("#tab-market .camera-bar").hidden, status: document.querySelector("#tab-market .camera-status").textContent,
  compass: !document.querySelector("#tab-market .view3d-compass").hidden }));
check(bar.shown && bar.compass && /Camera: Overview/.test(bar.status), `in 3D the camera controls and the compass are over the map ("${bar.status}")`);
const nb = { disabled: await attr(btn("market", "Neighborhood"), "aria-disabled"), title: await attr(btn("market", "Neighborhood"), "title"),
  st: await attr(btn("market", "Street"), "aria-disabled"), note: await page.textContent("#tab-market .camera-note") };
const p0 = await camPose("market");
await page.click(btn("market", "Neighborhood"), { force: true });     // pressed anyway: Playwright won't press an aria-disabled button by itself
await page.waitForTimeout(300);
const p1 = await camPose("market");
const said = await page.textContent("#tab-market .camera-status");
check(nb.disabled === "true" && nb.st === "true" && /Pick an area/.test(nb.title) && /Neighborhood: Pick an area/.test(nb.note) && /Pick an area/.test(said)
  && !p1.moving && Math.abs(p1.distance - p0.distance) < 1e-6 && p1.mode === "overview",
  `with no area or store picked, Neighborhood and Street are unavailable, say why ("${nb.title}"), and pressing one moves nothing`);
// Pick an area: Neighborhood frames its own tiles.
const areaPick = await page.evaluate(() => {
  const g = window.fashion.geometry; const k = g.areas.findIndex((a) => a.name) + 2;     // the second area
  let r0 = 1e9, r1 = -1, c0 = 1e9, c1 = -1;
  g.area.forEach((v, i) => { if (v !== k) return; const r = Math.floor(i / g.nx); const c = i % g.nx; r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); });
  const p = g.patch; return { k, name: g.areas[k - 1].name, X0: c0 * p, X1: (c1 + 1) * p, Z0: -(g.ny - r0) * p, Z1: -(g.ny - r1 - 1) * p };
});
await page.selectOption('#tab-market .camera-bar select[aria-label="Area"]', String(areaPick.k));
await page.click(btn("market", "Neighborhood"));
const mid = await camPose("market");
await settled("market");
const nbh = await page.evaluate((a) => { const v = window.fashion.tabs.market.dims.view; const t = v.controls.target;
  const on = [[a.X0, a.Z0], [a.X1, a.Z0], [a.X0, a.Z1], [a.X1, a.Z1]].every(([X, Z]) => v.toScreen(X, 0, Z).on);
  return { X: t.x, Z: t.z, on, mode: v.cameraState.mode, pressed: document.querySelector('#tab-market .camera-bar button[aria-pressed="true"]')?.textContent }; }, areaPick);
check(mid.moving && Math.abs(nbh.X - (areaPick.X0 + areaPick.X1) / 2) < 1e-6 && Math.abs(nbh.Z - (areaPick.Z0 + areaPick.Z1) / 2) < 1e-6 && nbh.on && nbh.pressed === "Neighborhood",
  `Neighborhood moves (eased) to ${areaPick.name}: the middle of the box round its own tiles, all four corners of it on the canvas, the button pressed`);
// Street: round a picked store's point, low.
const storePick = await page.evaluate(() => { const s = window.fashion.geometry.stores[5]; return { id: s.id, x: s.x, y: s.y, name: s.name }; });
await page.selectOption('#tab-market .camera-bar select[aria-label="Store"]', String(storePick.id));
await page.click(btn("market", "Street"));
await settled("market");
const street = await camPose("market");
const shownStore = await page.evaluate((id) => { const v = window.fashion.tabs.market.dims.view; const s = v.model.stores[id - 1]; return v.toScreen(s.X, s.height / 2, s.Z).on; }, storePick.id);
check(Math.abs(street.target.X - storePick.x) < 1e-6 && Math.abs(street.target.Z + storePick.y) < 1e-6 && Math.PI / 2 - street.polar < 0.45 && shownStore && street.label === `Street · ${storePick.name}`,
  `Street sits low (${((Math.PI / 2 - street.polar) * 180 / Math.PI).toFixed(0)}° up) round ${storePick.name} at R's STORES$x, STORES$y, the store on the canvas`);
// A drag in the middle of a move takes the camera: the move stops where it is.
// (A long move, so the real mouse lands in the middle of it however slowly SwiftShader draws the whole market.)
await page.evaluate(() => { const v = window.fashion.tabs.market.dims.view; v.animateTo(v.home.pose, { mode: "overview", label: "Overview", duration: 4000 }); });
await page.waitForTimeout(300);
const box = await page.evaluate(() => { const r = window.fashion.tabs.market.dims.view.canvas.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.evaluate(() => { const v = window.fashion.tabs.market.dims.view; v.canvas.addEventListener("pointerdown", () => { window.__movingAtGrab = !!v.transition; }, { capture: true, once: true }); });
await page.mouse.move(box.x, box.y); await page.mouse.down();
const grabbed = await camPose("market");
await page.mouse.move(box.x + 80, box.y + 20, { steps: 4 }); await page.mouse.up();
await page.waitForTimeout(1000);
const dragged = await camPose("market");
const homeDist = await page.evaluate(() => window.fashion.tabs.market.dims.view.home.pose.distance);
const wasMoving = await page.evaluate(() => window.__movingAtGrab);
check(wasMoving && !grabbed.moving && !dragged.moving && dragged.mode === "manual" && Math.abs(dragged.distance - homeDist) > 1 && Math.abs(dragged.distance - grabbed.distance) < 1e-6,
  "a mouse drag in the middle of a move stops it where it is: the camera is the user's (moved by hand), not carried on to the Overview", { grabbed, dragged, homeDist });
// A move replaced by another: from where the camera is.
await page.click(btn("market", "Neighborhood")); await page.waitForTimeout(200);
await page.click(btn("market", "Street")); await settled("market");
const replaced = await camPose("market");
check(replaced.mode === "street" && Math.abs(replaced.target.X - storePick.x) < 1e-6, "Street pressed while Neighborhood is moving replaces the move and ends at the store");
// The compass: facing north, keeping target, distance and height.
await page.evaluate(() => { const v = window.fashion.tabs.market.dims.view; v.animateTo({ ...v.currentPose(), azimuth: 2.2 }, { duration: 0 }); });
const beforeN = await camPose("market");
await page.click("#tab-market .view3d-compass");
await settled("market");
const north = await camPose("market");
const needle = await page.evaluate(() => document.querySelector("#tab-market .view3d-compass .needle").style.transform);
const up = await page.evaluate(() => { const v = window.fashion.tabs.market.dims.view; const t = v.controls.target; const a = v.toScreen(t.x, 0, t.z); const b = v.toScreen(t.x, 0, t.z - 10); return Math.abs(b.x - a.x) < 0.5 && b.y < a.y; });
check(Math.abs(north.azimuth) < 1e-9 && Math.abs(north.distance - beforeN.distance) < 1e-6 && Math.abs(north.polar - beforeN.polar) < 1e-9 && Math.abs(north.target.X - beforeN.target.X) < 1e-6 && /^rotate\(0(\.0)?deg\)$/.test(needle) && up,
  "the compass turns the view to face north (−Z straight up the screen), keeping its target, distance and height; the needle points up", { beforeN, north, needle, up });
// Focus: on the household picked last (the Market tab's own pick).
await page.click('#tab-market button:text-is("Pick a random household")');
await page.waitForFunction(() => window.fashion.tabs.market.dims.view.selected, null, { timeout: 30_000 });
await sentSince();
const hh = await page.evaluate(() => window.fashion.tabs.market.dims.view.selected);
const focusTitle = await attr(btn("market", "Focus"), "title");
await page.click(btn("market", "Focus"));
await settled("market");
const focused = await camPose("market");
check(/household/.test(focusTitle) && Math.abs(focused.target.X - hh.x) < 1e-6 && Math.abs(focused.target.Z + hh.y) < 1e-6 && Math.abs(focused.azimuth) < 1e-9 && Math.abs(focused.polar - north.polar) < 1e-9 && focused.mode === "focus",
  `Focus turns to the household picked last (${focusTitle}), keeping the camera's direction and height`, { hh, focused, north });
// Reset: the Overview.
await page.click('#tab-market .view-switch button:text-is("Reset view")');
await settled("market");
const reset = await page.evaluate(() => { const v = window.fashion.tabs.market.dims.view; const p = v.currentPose(); const h = v.home.pose;
  return Math.abs(p.distance - h.distance) < 1e-6 && Math.abs(p.azimuth - h.azimuth) < 1e-9 && Math.abs(p.target.X - h.target.X) < 1e-6 && v.cameraState.mode === "overview"; });
check(reset, "Reset view moves back to the Overview the 3D map opened with");
// Selection still works: a click on the ground picks the household nearest it.
const clicked = await page.evaluate(() => { const v = window.fashion.tabs.market.dims.view; const s = v.model.stores[2];
  const sp = v.toScreen(s.X + 300, 0, s.Z + 300); const r = v.canvas.getBoundingClientRect(); return { x: r.left + sp.x, y: r.top + sp.y }; });
await page.mouse.click(clicked.x, clicked.y);
await page.waitForTimeout(300);
const camSent = await sentSince();
check(camSent.length === 1 && camSent[0] === "ACTION", `after the camera moves, a click on the ground still asks R for the household there (the page sent ${JSON.stringify(camSent)}); the camera actions sent nothing`);
// 2D and back: the camera controls only in 3D.
await page.click('#tab-market .view-switch button:text-is("2D")');
const bar2d = await page.evaluate(() => document.querySelector("#tab-market .camera-bar").hidden);
await page.click('#tab-market .view-switch button:text-is("3D")');
await page.waitForTimeout(300);
const bar3d = await page.evaluate(() => !document.querySelector("#tab-market .camera-bar").hidden && window.fashion.tabs.market.dims.view.active);
check(bar2d && bar3d, "the camera controls are hidden in 2D and back with the 3D view");

// A click on a store in 3D opens its floor, as on the 2D map.
const target = await page.evaluate(() => {
  const v = window.fashion.tabs.market.dims.view; const s = v.model.stores[2];
  v.controls.target.set(s.X, 0, s.Z); v.camera.position.set(s.X + 250, 450, s.Z + 380); v.controls.update(); v.cameraChanged(); v.render();
  const sp = v.toScreen(s.X, s.height / 2, s.Z); const r = v.canvas.getBoundingClientRect();
  return { x: r.left + sp.x, y: r.top + sp.y };
});
await page.mouse.click(target.x, target.y);
await page.waitForTimeout(800);
const opened = await page.evaluate(() => ({ tab: window.fashion.tab, store: window.fashion.tabs.store.store }));
check(opened.tab === "store" && opened.store === 3, "a click on a store in 3D opens its floor on the Store tab, as a click on the 2D map does");

// ---- The store in 3D ---------------------------------------------------------------------------------------

console.log("Store 3D");
await page.click('#tab-store .view-switch button:text-is("3D")');
await page.waitForFunction(() => window.fashion.tabs.store.dims.view?.renders > 0, null, { timeout: 60_000 });
await page.click("#btn-step");
await page.waitForTimeout(1500);
const floor = await page.evaluate(() => {
  const tab = window.fashion.tabs.store; const v = tab.dims.view; const M = v.model;
  const st = window.fashion.geometry.stores[tab.store - 1];
  const rows = window.fashion.world.installed.layouts.find((L) => L.id === st.format).rows;
  const count = (re) => rows.join("").split("").filter((ch) => re.test(ch)).length;
  const kindAt = (x, y) => { const r = M.frame.H - 1 - Math.round(y); const c = Math.round(x); return M.kind[r * M.frame.W + c]; };
  const a = tab.shown.agents;
  const m = new v.THREE.Matrix4(); const p = new v.THREE.Vector3();
  const placedOk = Array.from({ length: a.n }, (_, i) => { v.meshes.shopper.getMatrixAt(i, m); p.setFromMatrixPosition(m); return Math.abs(p.x - (a.x[i] + 0.5) * 0.5) < 1e-5 && Math.abs(p.z + (a.y[i] + 0.5) * 0.5) < 1e-5; });
  const standing = Array.from({ length: a.n }, (_, i) => kindAt(a.x[i], a.y[i]));
  return { fromRows: M.fromRows, walls: M.cells.wall.length, wallChars: count(/#/), cashier: M.cells.cashier.length, cashierChars: count(/c/),
    frHead: M.cells.frHead.length, n: a.n, placed: placedOk.every(Boolean), standing, staff: a.staffN, store: tab.store, builds: v.staticBuilds };
});
const walkable = new Set(["floor", "door", "frLine", "frHead", "tillLine", "tillHead", "queue", "cubicle", "rack"]);
check(floor.fromRows && floor.walls === floor.wallChars && floor.cashier === floor.cashierChars && floor.frHead === 1,
  `the floor is the installed layout: plan_geometry()'s codes with its own rows, ${floor.walls} wall cells, ${floor.cashier} cashiers' places told from behind the counter, the fitting-room queue's head`);
check(floor.n > 0 && floor.placed && floor.standing.every((k) => walkable.has(k)),
  `${floor.n} shoppers at R's floor positions (X = (x + 0.5) × 0.5, Z = −(y + 0.5) × 0.5), every one on open floor, a queue, a doorway or in a cubicle (${[...new Set(floor.standing)].join(", ")}): nothing mirrored into a wall`);

// A click on a shopper in 3D: the inspector shows that shopper, as from the 2D floor.
const who = await page.evaluate(() => {
  const tab = window.fashion.tabs.store; const v = tab.dims.view; const a = tab.shown.agents;
  const i = 0; const X = (a.x[i] + 0.5) * 0.5; const Z = -(a.y[i] + 0.5) * 0.5;
  v.controls.target.set(X, 0, Z); v.camera.position.set(X + 4, 9, Z + 7); v.controls.update(); v.cameraChanged(); v.render();
  const sp = v.toScreen(X, 1.2, Z); const r = v.canvas.getBoundingClientRect();
  return { x: r.left + sp.x, y: r.top + sp.y, visit: a.visit[i] };
});
await page.mouse.click(who.x, who.y);
await page.waitForFunction((visit) => window.fashion.tabs.store.inspector.root.textContent.includes(String(visit)), who.visit, { timeout: 30_000 }).catch(() => {});
const panel = await page.evaluate(() => window.fashion.tabs.store.inspector.root.textContent);
check(panel.includes(String(who.visit)), `a click on a shopper in 3D inspects that shopper (visit #${who.visit}), as a click on the 2D floor does`);
// A worker.
const worker = await page.evaluate(() => {
  const tab = window.fashion.tabs.store; const v = tab.dims.view; const a = tab.shown.agents;
  const X = (a.staffX[0] + 0.5) * 0.5; const Z = -(a.staffY[0] + 0.5) * 0.5;
  v.controls.target.set(X, 0, Z); v.camera.position.set(X + 3, 8, Z + 6); v.controls.update(); v.cameraChanged(); v.render();
  const sp = v.toScreen(X, 1.2, Z); const r = v.canvas.getBoundingClientRect();
  return { x: r.left + sp.x, y: r.top + sp.y, role: a.staffRole[0] === 1 ? "cashier" : "assistant", id: a.staffId[0] };
});
await page.mouse.click(worker.x, worker.y);
await page.waitForFunction((role) => window.fashion.tabs.store.dims.view.inspectRing.visible && window.fashion.tabs.store.inspector.root.textContent.toLowerCase().includes(role),
  worker.role, { timeout: 30_000 }).catch(() => {});
const ring = await page.evaluate(() => { const v = window.fashion.tabs.store.dims.view; return v.inspectRing.visible; });
const panel2 = await page.evaluate(() => window.fashion.tabs.store.inspector.root.textContent.toLowerCase());
check(ring && panel2.includes(worker.role), `a click on a ${worker.role} in 3D opens their work in the inspector, and rings them on the 3D floor`);
check(floor.builds === 1, "the floor's fixtures were built once for the store, whatever the frames did");

// ---- The 3D camera on the Store tab ---------------------------------------------------------------------------

console.log("Store 3D camera");
await sentSince();
// The worker is in the inspector: Shopper needs a shopper; Focus aims at the worker.
const shopperOff = { aria: await attr(btn("store", "Shopper"), "aria-disabled"), title: await attr(btn("store", "Shopper"), "title") };
check(shopperOff.aria === "true" && /Select a shopper/.test(shopperOff.title), `with a worker in the inspector, Shopper is unavailable and says why ("${shopperOff.title}")`);
await page.click(btn("store", "Focus"));
await settled("store");
const wf = await page.evaluate(() => { const tab = window.fashion.tabs.store; const v = tab.dims.view; const a = v.agents; const ins = tab.shown.inspect;
  const role = ins.kind === "cashier" ? 1 : 2; let i = -1; for (let k = 0; k < a.staffN; k++) if (a.staffRole[k] === role && a.staffId[k] === ins.server) i = k;
  const t = v.controls.target; return { ok: i >= 0 && Math.abs(t.x - (a.staffX[i] + 0.5) * 0.5) < 1e-6 && Math.abs(t.z + (a.staffY[i] + 0.5) * 0.5) < 1e-6, label: v.cameraState.label }; });
check(wf.ok, `Focus turns to the ${worker.role} in the inspector, where the current frame has them (${wf.label})`);
// Top-down: the whole floor from overhead, north up.
await page.click(btn("store", "Top-down"));
await settled("store");
const td = await page.evaluate(() => { const v = window.fashion.tabs.store.dims.view; const f = v.model.frame; const p = v.currentPose();
  return { corners: [[0, 0], [f.width, 0], [0, -f.depth], [f.width, -f.depth]].every(([X, Z]) => v.toScreen(X, 0, Z).on), polar: p.polar, az: p.azimuth, min: v.controls.minPolarAngle, w: f.width, d: f.depth }; });
check(td.corners && Math.abs(td.polar - td.min) < 1e-9 && Math.abs(td.az) < 1e-9, `Top-down looks straight down (as near as the controls allow), north up, the whole ${td.w} × ${td.d} m floor on the canvas`);
// Checkout: the tills plan_geometry() places, and the till queue's cells from the installed rows.
await page.click(btn("store", "Checkout"));
await settled("store");
const co = await page.evaluate(() => { const v = window.fashion.tabs.store.dims.view; const f = v.model.frame;
  const tills = v.plan.tills.map(([x, y]) => v.toScreen((x + 0.5) * 0.5, 1, -(y + 0.5) * 0.5).on);
  const queue = [...v.model.cells.tillLine, ...v.model.cells.tillHead].map((q) => v.toScreen(q.X, 0, q.Z).on);
  return { tills, queue, zones: v.checkout.zones.length, line: v.checkout.queue.line?.length ?? null, dist: v.distance, home: v.home.pose.distance, label: v.cameraState.label, note: v.cameraState.note }; });
check(co.tills.length > 0 && co.tills.every(Boolean) && co.line > 0 && co.queue.every(Boolean) && co.dist < co.home,
  `Checkout frames the ${co.tills.length} till(s) of plan_geometry() and the till queue's ${co.line} cells from the installed rows, closer than the Overview (${co.label})`);
// Shopper: the one in the inspector, by visit id, in the live frame.
const pick = await page.evaluate(() => { const tab = window.fashion.tabs.store; const v = tab.dims.view; const a = tab.shown.agents;
  const i = a.n - 1; const X = (a.x[i] + 0.5) * 0.5; const Z = -(a.y[i] + 0.5) * 0.5;
  v.animateTo({ target: { X, Y: 0, Z }, distance: 9, polar: 0.9, azimuth: 0.4 }, { duration: 0 }); v.render();
  const sp = v.toScreen(X, 1.2, Z); const r = v.canvas.getBoundingClientRect(); return { x: r.left + sp.x, y: r.top + sp.y, visit: a.visit[i] }; });
await page.mouse.click(pick.x, pick.y);
await page.waitForFunction((visit) => window.fashion.tabs.store.shown.inspect?.visit === visit, pick.visit, { timeout: 30_000 }).catch(() => {});
await page.waitForFunction(() => [...document.querySelectorAll("#tab-store .camera-bar button")].find((b) => b.textContent === "Shopper")?.getAttribute("aria-disabled") === "false", null, { timeout: 30_000 }).catch(() => {});
await page.click(btn("store", "Shopper"));
await settled("store");
const sp = await page.evaluate(() => { const tab = window.fashion.tabs.store; const v = tab.dims.view; const a = v.agents; const visit = tab.shown.inspect?.visit;
  const i = Array.from(a.visit.subarray(0, a.n)).indexOf(visit); const t = v.controls.target; const p = v.currentPose();
  return { visit, i, ok: i >= 0 && Math.abs(t.x - (a.x[i] + 0.5) * 0.5) < 1e-6 && Math.abs(t.z + (a.y[i] + 0.5) * 0.5) < 1e-6, low: Math.PI / 2 - p.polar, d: p.distance, label: v.cameraState.label }; });
check(sp.visit === pick.visit && sp.ok && sp.low < 0.5 && sp.d < 8, `Shopper looks low (${(sp.low * 180 / Math.PI).toFixed(0)}° up, ${sp.d.toFixed(1)} m) at visit #${sp.visit}, where the live frame has that visit (${sp.label})`);
const storeSent = await sentSince();
check(storeSent.length === 1 && storeSent[0] === "ACTION", `the store's camera actions sent the simulation nothing (only the click on the shopper asked R to inspect: ${JSON.stringify(storeSent)})`);

// ---- Same season in 2D and 3D --------------------------------------------------------------------------------

console.log("2D and 3D leave the season as it is");
// The same ticks from the same Setup, once watched in 3D and once in 2D, on the Store tab: the
// random numbers drawn, the clock, every visit and the takings agree.
const fingerprint = () => nums("c(sum(.Random.seed), clock, day, legs$n, nrow(d), sum(d$outcome), sum(tally$sales))");
const runFrom = async (dims) => {
  await page.evaluate((d) => window.fashion.tabs.store.dims.set(d), dims);
  await page.evaluate(() => window.fashion.setupSeason());
  await page.waitForTimeout(500);
  await page.selectOption("#speed", "600");
  await page.waitForTimeout(300);
  for (let k = 0; k < 40; k++) await page.evaluate(() => window.fashion.client.request("STEP"));
  return fingerprint();
};
const in3d = await runFrom("3d");
const in2d = await runFrom("2d");
check(JSON.stringify(in3d) === JSON.stringify(in2d) && in3d[3] > 0,
  `40 ticks from Setup watched in 3D and in 2D: the same random-number state, clock, ${in3d[3]} walking legs, ${in3d[4]} visits and takings (${JSON.stringify(in3d.map((v) => Math.round(v)))})`);

// From the fresh Setup (day 1, early): the season's pace at watch speed (600×) with the market drawn in 2D, then in 3D: store
// seconds per second of screen. The worker runs R on its own thread and doesn't wait for
// the page to draw, so 3D shouldn't slow it.
const pace = async (dims) => {
  await page.evaluate((d) => window.fashion.tabs.market.dims.set(d), dims);
  await page.waitForTimeout(300);
  const [c0, d0] = await nums("c(clock, day)"); const t0 = Date.now();
  await page.evaluate(() => window.fashion.client.request("RUN"));
  await page.waitForTimeout(8000);
  await page.evaluate(() => window.fashion.client.request("PAUSE"));
  const [c1, d1] = await nums("c(clock, day)");
  return d1 === d0 ? (c1 - c0) / ((Date.now() - t0) / 1000) : NaN;          // within one store day
};
await page.click("#tab-btn-market");
const pace2d = await pace("2d"); const pace3d = await pace("3d");
check(pace3d >= 0.75 * pace2d, `at 600× the season runs at ${pace2d.toFixed(0)} store seconds a second with the 2D map and ${pace3d.toFixed(0)} with the 3D one`);

// ---- Setup: rebuilt by an installed world only -----------------------------------------------------------------

console.log("Setup and the 3D scenery");
await page.click("#tab-btn-market");
await page.evaluate(() => window.fashion.tabs.market.dims.set("3d"));
await page.waitForTimeout(500);
const b0 = await page.evaluate(() => window.fashion.tabs.market.dims.view.staticBuilds);
// A tile of open land, painted a building in the draft: nothing in 3D until Setup.
const spot = await page.evaluate(() => {
  const w = window.fashion.world; const rows = w.draft.macro.tiles;
  // Open land with open land all round it, so no store, road or route is touched.
  for (let r = 2; r < rows.length - 2; r++) for (let c = 2; c < rows[r].length - 2; c++) {
    if ([-1, 0, 1].every((dr) => [-1, 0, 1].every((dc) => rows[r + dr][c + dc] === "."))) return { r, c };
  }
  return null;
});
await page.evaluate(({ r, c }) => window.fashion.world.edit((d) => { const row = d.macro.tiles[r]; d.macro.tiles[r] = row.slice(0, c) + "#" + row.slice(c + 1); }), spot);
await page.waitForTimeout(500);
const drafted = await page.evaluate(() => window.fashion.tabs.market.dims.view.staticBuilds);
check(drafted === b0, "a tile painted in the Setup tab's draft changes nothing in 3D before Setup");
await page.evaluate(() => window.fashion.setupSeason());
await page.waitForFunction((b) => window.fashion.tabs.market.dims.view.staticBuilds > b, b0, { timeout: 300_000, polling: 500 }).catch(() => {});
const after = await page.evaluate(({ r, c }) => { const v = window.fashion.tabs.market.dims.view; const M = v.model; const X = (c + 0.5) * M.frame.patch; const Z = -(M.frame.ny - r - 0.5) * M.frame.patch;
  return { builds: v.staticBuilds, building: M.buildings.some((b) => b.X === X && b.Z === Z) }; }, spot);
check(after.builds === b0 + 1 && after.building, "Setup installs it: the 3D market is rebuilt once, with a building on that tile");
const camAfter = await page.evaluate(() => { const tab = window.fashion.tabs.market; const v = tab.dims.view; const p = v.currentPose(); const h = v.home.pose;
  return { mode: v.cameraState.mode, home: Math.abs(p.distance - h.distance) < 1e-6 && p.target.X === h.target.X, area: tab.cam.area, store: tab.cam.store, active: tab.cam.active,
    areaSel: document.querySelector('#tab-market .camera-bar select[aria-label="Area"]').value, nbh: [...document.querySelectorAll("#tab-market .camera-bar button")].find((b) => b.textContent === "Neighborhood").getAttribute("aria-disabled") }; });
check(camAfter.mode === "overview" && camAfter.home && camAfter.area === null && camAfter.store === null && camAfter.areaSel === "" && camAfter.nbh === "true",
  "a Setup that installs a world puts the 3D camera back at the new world's Overview and clears what was picked for it: nothing in the old world is aimed at in the new one");
// A world R refuses: the 3D market stays the installed one.
await page.evaluate(() => window.fashion.world.edit((d) => { d.stores[0].layout = "no_such_layout"; }));
await page.evaluate(() => window.fashion.setupSeason());
await page.waitForTimeout(3000);
const refused = await page.evaluate(() => ({ builds: window.fashion.tabs.market.dims.view.staticBuilds, problems: document.querySelector("#tab-setup")?.textContent ?? "" }));
check(refused.builds === after.builds && /no_such_layout/.test(refused.problems), "a Setup R refuses (a store with no such layout) leaves the 3D market as it was: the installed world");
await page.evaluate(() => window.fashion.world.adoptInstalled());

// Back to 2D: the 2D map is back with everyone outdoors.
await page.click("#tab-btn-market");
await page.click('#tab-market .view-switch button:text-is("2D")');
await page.waitForTimeout(300);
const back = await page.evaluate(() => ({ hidden3d: document.querySelector("#tab-market .view3d-wrap").hidden, shown2d: !document.querySelector("#tab-market .map-wrap:not(.view3d-wrap)").hidden, active: window.fashion.tabs.market.dims.view.active }));
check(back.hidden3d && back.shown2d && !back.active, "2D again: the 2D map is shown and the 3D view stops drawing");

check(!errors.length, errors.length ? `no errors in the page: ${errors.slice(0, 3).join(" | ")}` : "no errors in the page");
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll 3D browser checks passed.");
process.exit(failures ? 1 : 0);
