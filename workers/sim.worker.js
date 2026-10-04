// Fashion market — simulation worker.
//
// Owns the webR session running the R model (model/*.R), so R never runs on
// the page's thread. Boots webR with the pre-bundled NetLogoR library,
// sources the model, installs the world the page asks for (the one it last
// set up, or the default), runs setup(), then ticks go() while the page asks
// it to (Go), and installs a new world and runs setup() again when the page
// asks (Setup). After each tick it sends what the page has on screen: the
// moving parts of the map and of the watched store's floor (one packed
// frame, acknowledged by the page before the next is sent), and the numbers
// for the visible tab, a few times a second.
//
// worker → page   STEP {step, state, loaded?, total?}   boot progress
//                 READY {netlogor, timings}
//                 SCHEMA {json}                         every setting's range, once
//                 GEOMETRY {world, city, plans, homes}  after each world is installed
//                 HOMES {version, mode, brand, codes}   household colours, when they change
//                 FRAME {buffer}                        see frame_pack() in model/frames.R
//                 REPORT {tab, json} · HEADER {json}
//                 RUN_STATE {running, seasonOver}
//                 ERROR {stage, message} · RESULT {id, ok, value|error}
// page → worker   BOOT {world}: the world to open with (null: the default),
//                 then requests, each answered with a RESULT (see `handlers`), and ACK

import { WEBR_BASE_URL, VFS_IMAGE_URL, VFS_MOUNT_POINT } from "../js/config.js";
import { rString, rNumber } from "../js/r-code.js";

const ROOT_URL = new URL("../", import.meta.url).href;
const MODEL_URL = new URL("model/", ROOT_URL).href;
const R_EVAL = { captureStreams: false };
const WATCH_FPS = 30;
const REPORT_MS = 250;          // the visible tab's numbers, at most this often
const SLOW_REPORT_MS = 1000;    // ... for the tabs whose reports cost more
const WORLD_DIR = "/world";     // the default world and the prefab layouts, in R's filesystem

let webR = null;
let stage = "boot";
let bootDone;
let bootFail;
const booted = new Promise((resolve, reject) => { bootDone = resolve; bootFail = reject; });
booted.catch(() => {});
let gotWorld;
const startWorld = new Promise((resolve) => { gotWorld = resolve; });

const post = (type, payload = {}, transfer = []) => self.postMessage({ type, ...payload }, transfer);
const step = (name, state, extra = {}) => post("STEP", { step: name, state, ...extra });
const errorText = (err) =>
  String(err?.message ?? err).replace(/^Error in (`h\(simpleError\(msg, call\)\)`|unknown source):\s*/, "").trim();
const encode = (text) => new TextEncoder().encode(text);

// ---- Boot ---------------------------------------------------------------

async function startWebR() {
  const { WebR } = await import(`${WEBR_BASE_URL}webr.mjs`);
  // Interactive, so webR.interrupt() can reach a running computation.
  webR = new WebR({ baseUrl: WEBR_BASE_URL, interactive: true, createLazyFilesystem: false });
  await webR.init();
  drainOutput();
}

async function fetchLibraryImage() {
  const checked = (r) => { if (!r.ok) throw new Error(`${r.url} → HTTP ${r.status}`); return r; };
  const metadataPromise = fetch(`${VFS_IMAGE_URL}.js.metadata`).then(checked).then((r) => r.json());
  const response = checked(await fetch(`${VFS_IMAGE_URL}.data.gz`));
  const total = Number(response.headers.get("Content-Length")) || 0;
  let loaded = 0; let last = 0;
  const progress = new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      const now = performance.now();
      if (now - last > 100) { last = now; step("library", "active", { loaded, total }); }
      controller.enqueue(chunk);
    },
  });
  const stream = response.body.pipeThrough(progress).pipeThrough(new DecompressionStream("gzip"));
  const [blob, metadata] = await Promise.all([new Response(stream).blob(), metadataPromise]);
  return { blob, metadata };
}

const fetchText = (url) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${new URL(url).pathname} → HTTP ${r.status}`);
  return r.text();
});

// The model's R files, in the order model/index.json lists them.
async function loadModel() {
  const index = await fetch(new URL("index.json", MODEL_URL)).then((r) => r.json());
  await webR.FS.mkdir("/model");
  for (const name of index.files) {
    const text = await fetchText(new URL(name, MODEL_URL).href);
    await webR.FS.writeFile(`/model/${name}`, encode(text));
    await webR.evalRVoid(`source(${rString(`/model/${name}`)}, local = globalenv())`, R_EVAL);
  }
}

// The default world and the prefab layouts it (and "copy of a prefab")
// can refer to.
async function loadWorldFiles() {
  await webR.FS.mkdir(WORLD_DIR);
  await webR.FS.mkdir(`${WORLD_DIR}/worlds`);
  await webR.FS.mkdir(`${WORLD_DIR}/layouts`);
  const index = JSON.parse(await fetchText(new URL("layouts/index.json", ROOT_URL).href));
  for (const id of index.prefabs) {
    await webR.FS.writeFile(`${WORLD_DIR}/layouts/${id}.layout.json`, encode(await fetchText(new URL(`layouts/${id}.layout.json`, ROOT_URL).href)));
  }
  await webR.FS.writeFile(`${WORLD_DIR}/worlds/default.world.json`, encode(await fetchText(new URL("worlds/default.world.json", ROOT_URL).href)));
}

// Installs a world from its JSON text: its problems, or none (installed).
async function installWorld(text) {
  await webR.FS.writeFile(`${WORLD_DIR}/draft.world.json`, encode(text));
  return JSON.parse(await rJson(`world_load_file(${rString(`${WORLD_DIR}/draft.world.json`)}, ${rString(`${WORLD_DIR}/layouts`)})`));
}

async function boot() {
  const timings = {};
  const t0 = performance.now();
  try {
    stage = "download";
    step("runtime", "active"); step("library", "active");
    const [, image] = await Promise.all([
      startWebR().then(() => { timings.webr = Math.round(performance.now() - t0); step("runtime", "done"); }),
      fetchLibraryImage(),
    ]);
    stage = "mount";
    await webR.FS.mkdir(VFS_MOUNT_POINT);
    await webR.FS.mount("WORKERFS", { packages: [{ blob: image.blob, metadata: image.metadata }] }, VFS_MOUNT_POINT);
    await webR.evalRVoid(`.libPaths(c("${VFS_MOUNT_POINT}", .libPaths()))`);
    await webR.evalRVoid('options(repos = c(CRAN = "https://packages.disabled.invalid/"))');
    step("library", "done");

    stage = "netlogor";
    step("netlogor", "active");
    await webR.evalRVoid("suppressPackageStartupMessages(library(NetLogoR))");
    const netlogor = await webR.evalRString('as.character(packageVersion("NetLogoR"))');
    step("netlogor", "done");

    stage = "model";
    step("model", "active");
    await loadModel();
    await loadWorldFiles();
    post("SCHEMA", { json: await rJson("world_schema()") });
    // The world the page last set up, if it still installs; else the default.
    const saved = await startWorld;
    let fellBack = false;
    if (saved) {
      const problems = await installWorld(saved);
      if (problems.length) fellBack = true;
    }
    if (!saved || fellBack) await webR.evalRVoid(`load_default_world(${rString(WORLD_DIR)})`, R_EVAL);
    const s0 = performance.now();
    await webR.evalRVoid("setup()", R_EVAL);
    timings.setup = Math.round(performance.now() - s0);
    timings.total = Math.round(performance.now() - t0);
    await sendGeometry();
    stage = "ready";
    step("model", "done");
    bootDone();
    post("READY", { netlogor, timings, fellBack });
    await sendAll(true);
  } catch (err) {
    bootFail(err);
    post("ERROR", { stage, message: errorText(err) });
  }
}

// R's console output goes to the browser console; stray pictures are dropped.
async function drainOutput() {
  for (;;) {
    const msg = await webR.read();
    if (msg.type === "canvas") msg.data?.image?.close?.();
    else if (msg.type === "stderr") console.warn(`[R] ${msg.data}`);
    else if (msg.type === "stdout") console.info(`[R] ${msg.data}`);
  }
}

// ---- Talking to R -------------------------------------------------------------

const rJson = (expr) => webR.evalRString(`to_json(${expr})`, R_EVAL);

async function rTyped(expr) {
  const shelter = await new webR.Shelter();
  try {
    const result = await shelter.evalR(expr, R_EVAL);
    const array = await result.toTypedArray();
    return array.byteOffset === 0 && array.byteLength === array.buffer.byteLength ? array : array.slice();
  } finally {
    await shelter.purge();
  }
}

// The installed world: its map, floors and households, and the world file
// itself (as Export writes it).
async function sendGeometry() {
  const world = await webR.evalRString("world_text(WORLD)", R_EVAL);
  const city = await rJson("city_geometry(city, mk$hh)");
  const plans = await rJson("lapply(seq_along(FORMATS), plan_geometry)");
  const homes = await rTyped("homes_xy()");
  homes_.version = -1;
  post("GEOMETRY", { world, city, plans, homes }, [homes.buffer]);
}

// ---- What the page shows ------------------------------------------------------------

// Set by the page (VIEW): the visible tab and what it's looking at.
const view = {
  tab: "market", store: 1, brand: 1, heat: false, homesMode: "brand", homesBrand: 1, mapOn: true,
  offers: { brand: 1, offer: 0 },
  funnel: { brand: 0, area: 0, store: 0, scope: "season" },
};
const homes_ = { version: -1, mode: null, brand: null };
const reports = { at: 0, slowAt: 0 };
const SLOW_TABS = new Set(["strategy", "offers", "assortment", "scorecard"]);

function reportExpr() {
  switch (view.tab) {
    case "setup": return "report_setup()";
    case "market": return "report_market()";
    case "strategy": return "report_strategy()";
    case "offers": return `report_offers(${rNumber(view.offers.brand)}, ${rNumber(view.offers.offer)})`;
    case "funnel": {
      const f = view.funnel;
      return `report_funnel(${rNumber(f.brand)}, ${rNumber(f.area)}, ${rNumber(f.store)}, ${rString(f.scope)})`;
    }
    case "store": return `report_store(${rNumber(view.store)}, heat = ${view.heat ? "TRUE" : "FALSE"})`;
    case "assortment": return `report_assortment(${rNumber(view.brand)})`;
    case "scorecard": return "report_scorecard()";
    default: return null;
  }
}

async function sendReport(force = false) {
  const now = performance.now();
  const slow = SLOW_TABS.has(view.tab);
  if (!force && now - (slow ? reports.slowAt : reports.at) < (slow ? SLOW_REPORT_MS : REPORT_MS)) return;
  reports.at = now;
  if (slow) reports.slowAt = now;
  await webR.evalRVoid("tally_live()", R_EVAL);        // today so far, into the season's numbers
  post("HEADER", { json: await rJson("report_header()") });
  const expr = reportExpr();
  if (expr) post("REPORT", { tab: view.tab, json: await rJson(expr) });
}

async function sendHomes(force = false) {
  if (!view.mapOn) return;
  const version = await webR.evalRNumber("homes_version");
  if (!force && version === homes_.version && view.homesMode === homes_.mode && view.homesBrand === homes_.brand) return;
  const codes = await rTyped(`homes_codes(${rString(view.homesMode)}, ${rNumber(view.homesBrand)})`);
  homes_.version = version; homes_.mode = view.homesMode; homes_.brand = view.homesBrand;
  post("HOMES", { version, mode: view.homesMode, brand: view.homesBrand, codes }, [codes.buffer]);
}

const run = { active: false, inFlight: 0, busy: null };

async function sendFrame(force = false) {
  if (!force && run.inFlight > 0) return;
  const store = view.tab === "store" ? view.store : 0;
  const frame = await rTyped(`frame_pack(map = ${view.mapOn ? "TRUE" : "FALSE"}, store = ${rNumber(store)})`);
  run.inFlight += 1;
  post("FRAME", { buffer: frame.buffer }, [frame.buffer]);
}

async function sendAll(force = false) {
  await sendHomes(force);
  await sendFrame(force);
  await sendReport(force);
}

// ---- The run loop ---------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// At watch pace a tick is 1/30 of a second of screen time, so ticks keep to
// a timetable: after a slow one (a costly report), the next ones catch up,
// and store time keeps pace with the speed it's labelled, real time too.
// Further behind than MAX_BEHIND_MS (the page hidden, R busy), the
// timetable starts again from now rather than racing ahead.
const TICK_MS = 1000 / WATCH_FPS;
const MAX_BEHIND_MS = 250;

async function runLoop() {
  let due = performance.now();      // when the next watch tick is due
  while (run.active) {
    try {
      run.busy = webR.evalRBoolean("go()", R_EVAL);
      const over = await run.busy;
      run.busy = null;
      const season = (await webR.evalRString("P$pace")) === "season";
      await sendHomes();
      await sendFrame();
      await sendReport(season);
      if (over) {
        run.active = false;
        await sendAll(true);
        post("RUN_STATE", { running: false, seasonOver: true });
        break;
      }
      if (!season) {
        due += TICK_MS;
        const now = performance.now();
        if (now - due > MAX_BEHIND_MS) due = now;
        else if (due - now > 1) await sleep(due - now);
      } else {
        due = performance.now();
        await sleep(0);     // lets the page's requests in between days
      }
    } catch (err) {
      run.busy = null;
      run.active = false;
      post("ERROR", { stage: "run", message: errorText(err) });
    }
  }
  post("RUN_STATE", { running: false });
}

// ---- Requests -------------------------------------------------------------------------------

// Values from the page as R literals: numbers, text, true/false, or a list
// of text. Page input is only ever data.
const rArg = (value) => {
  if (Array.isArray(value)) return `c(${value.map((v) => rString(v)).join(", ")})`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return rString(value);
  return rNumber(value);
};

// Levers and actions the page may call, and the R code each runs.
const ACTIONS = {
  pick_household: ({ household }) => `pick_household(${household ? rNumber(household) : "NA"})`,
  pick_home_at: ({ x, y }) => `pick_household(which.min((mk$hh$x - ${rNumber(x)})^2 + (mk$hh$y - ${rNumber(y)})^2))`,
  follow_visit: ({ store }) => `follow_visit(${rNumber(store)})`,
  inspect_at: ({ store, x, y }) => `inspect_at(${rNumber(store)}, ${rNumber(x)}, ${rNumber(y)})`,
  close_inspector: () => "close_inspector()",
};

// Live settings, by the id of the brand or store they belong to.
const SETTERS = {
  lever: ({ name, brand, value }) => `set_lever(${rString(name)}, ${rArg(brand)}, ${rArg(value)})`,
  store: ({ name, store, value }) => `set_store(${rArg(store)}, ${rString(name)}, ${rArg(value)})`,
  market: ({ name, value }) => `set_market(${rString(name)}, ${rArg(value)})`,
  stock: ({ name, brand, value }) => `set_stock(${rString(name)}, ${rArg(brand)}, ${rArg(value)})`,
  pricing: ({ name, brand, value }) => `set_pricing(${rString(name)}, ${rArg(brand)}, ${rArg(value)})`,
};

// Waits for the tick in progress, so a change never lands inside one.
async function between(work) {
  if (run.busy) await run.busy.catch(() => {});
  return work();
}

const handlers = {
  async RUN() {
    if (!run.active) {
      run.active = true;
      post("RUN_STATE", { running: true });
      runLoop();
    }
    return { running: true };
  },

  async PAUSE() {
    run.active = false;
    if (run.busy) await run.busy.catch(() => {});
    return { running: false };
  },

  async STEP() {
    return between(async () => {
      await webR.evalRBoolean("go()", R_EVAL);
      await sendAll(true);
      return { ok: true };
    });
  },

  // A new season, in a new world if the page sends one (the draft, with the
  // changes waiting for Setup). A world with problems isn't installed: the
  // season goes on, and the page is told why.
  async SETUP({ world } = {}) {
    run.active = false;
    return between(async () => {
      if (world) {
        const problems = await installWorld(world);
        if (problems.length) return { ok: false, problems };
      }
      await webR.evalRVoid("setup()", R_EVAL);
      if (world) await sendGeometry();
      homes_.version = -1;
      await sendAll(true);
      post("RUN_STATE", { running: false, seasonOver: false });
      return { ok: true };
    });
  },

  // A world file's problems, without installing it, and the world as this
  // model reads it (upgraded from an older version, prefab layouts inline):
  // { problems, text }.
  async CHECK_WORLD({ text }) {
    return between(async () => {
      await webR.FS.writeFile(`${WORLD_DIR}/check.world.json`, encode(text));
      return JSON.parse(await rJson(`world_check_file(${rString(`${WORLD_DIR}/check.world.json`)}, ${rString(`${WORLD_DIR}/layouts`)})`));
    });
  },

  // The map editor's readouts for a draft world.
  async PREVIEW_MACRO({ text }) {
    return between(async () => {
      await webR.FS.writeFile(`${WORLD_DIR}/preview.world.json`, encode(text));
      return JSON.parse(await rJson(`world_preview_file(${rString(`${WORLD_DIR}/preview.world.json`)})`));
    });
  },

  // The layout editor's problems and summary for a picture, read by the
  // categories of the world being edited ([{ key, name }]).
  async CHECK_LAYOUT({ rows, categories }) {
    return between(async () => {
      await webR.FS.writeFile(`${WORLD_DIR}/layout.json`, encode(JSON.stringify({ rows, categories })));
      return JSON.parse(await rJson(`layout_report_file(${rString(`${WORLD_DIR}/layout.json`)})`));
    });
  },

  async SET(payload) {
    const make = SETTERS[payload.kind];
    if (!make) throw new Error(`unknown setting kind ${payload.kind}`);
    return between(async () => {
      const value = await webR.evalR(make(payload), R_EVAL);
      let out;
      try { out = await value.toJs(); } finally { webR.destroy(value); }
      await sendAll(true);
      return out?.values ?? out;
    });
  },

  async ACTION({ name, args = {} }) {
    const make = ACTIONS[name];
    if (!make) throw new Error(`unknown action ${name}`);
    return between(async () => {
      await webR.evalRVoid(make(args), R_EVAL);
      await sendAll(true);
      return { ok: true };
    });
  },

  // What's on screen changed: another tab, store, brand, filter, colouring.
  async VIEW(next) {
    Object.assign(view, next);
    if (next.funnel) view.funnel = { ...view.funnel, ...next.funnel };
    if (next.offers) view.offers = { ...view.offers, ...next.offers };
    view.mapOn = view.tab === "market";
    if (!run.active) return between(async () => { await sendAll(true); return { ok: true }; });
    reports.at = 0; reports.slowAt = 0;
    return { ok: true };
  },

  async EXPORT() {
    return between(() => webR.evalRString("export_csv()", R_EVAL));
  },

  async EVAL({ code }) {
    const result = await webR.evalR(code, R_EVAL);
    try { return await result.toJs(); } finally { webR.destroy(result); }
  },
};

self.addEventListener("message", async (event) => {
  const { type, id, ...payload } = event.data ?? {};
  if (type === "ACK") { run.inFlight = Math.max(0, run.inFlight - 1); return; }
  if (type === "BOOT") { gotWorld(payload.world ?? null); return; }
  const handler = handlers[type];
  if (!handler) return;
  try {
    await booted;
    post("RESULT", { id, ok: true, value: await handler(payload) });
  } catch (err) {
    post("RESULT", { id, ok: false, error: errorText(err) });
  }
});

boot();
