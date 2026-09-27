// NetLogoR Workbench — simulation engine worker.
//
// Owns the webR session, so R never runs on the UI thread. Boot sequence:
// start webR and download the pre-bundled NetLogoR library image in
// parallel, mount the image, attach NetLogoR, then report WEBR_READY.
//
// Messages (plain postMessage):
//   worker → main  STATUS      { stage, message, loaded?, total? }
//                  WEBR_READY  { timings, crossOriginIsolated, channel, netlogor }
//                  ERROR       { stage, message }
//                  LOG         { stream, text }            R stdout / stderr
//                  RESULT      { id, ok, value | error }    reply to a request
//   main → worker  EVAL        { id, code }                 dev helper
//                  (and the requests in `handlers` below, each answered
//                  with a RESULT)

import { WEBR_BASE_URL, VFS_IMAGE_URL, VFS_MOUNT_POINT, WORKBENCH_R_URL, DATA_BASE_URL } from "../js/config.js";
import { rString, rNumber, rList, rValue, safeFileName } from "../js/r-code.js";

const startedAt = performance.now();
const elapsed = () => Math.round(performance.now() - startedAt);

const ENGINE_R_PATH = "/workbench.R";
const MODEL_R_PATH = "/model.R";

// webR captures R's output by default, which would swallow anything the
// model prints. Letting streams through sends print()/cat() to the output
// queue instead, where forwardOutput() picks it up for the output log.
//
// Conditions stay captured: that is what turns an R error into a JS
// exception carrying the R message. Without it, a failing tick returns NULL
// and the run loop spins on silently.
const R_EVAL = { captureStreams: false };

let webR = null;
let stage = "boot";

// Requests can arrive while webR is still starting (the interface is built
// as soon as the page loads). They wait here rather than failing.
let bootFinished;
let bootFailed;
const booted = new Promise((resolve, reject) => {
  bootFinished = resolve;
  bootFailed = reject;
});
booted.catch(() => {});  // handled per request

const post = (type, payload = {}, transfer = []) => self.postMessage({ type, ...payload }, transfer);

// R errors arrive wrapped in webR's own handler frame, or labelled "unknown
// source" when R gave no call (stop(..., call. = FALSE)); the model author
// only wants the part that came from their code.
const errorText = (err) =>
  String(err?.message ?? err)
    .replace(/^Error in (`h\(simpleError\(msg, call\)\)`|unknown source):\s*/, "")
    .trim();
const status = (message, extra = {}) => post("STATUS", { stage, message, ...extra });

// Boot progress for the loading screen: runtime, library and netlogor steps
// go active → done; the library download also reports bytes.
const step = (name, state, extra = {}) => post("STEP", { step: name, state, ...extra });

// ---- Boot -------------------------------------------------------------

async function startWebR() {
  const { WebR } = await import(`${WEBR_BASE_URL}webr.mjs`);
  webR = new WebR({
    baseUrl: WEBR_BASE_URL,
    // Interactive, because that is the mode in which R polls for events —
    // without it webR.interrupt() can never reach a running computation.
    interactive: true,
    // Skips webR's on-demand XHR fetches for R's help and doc files, which
    // the Workbench never reads.
    createLazyFilesystem: false,
  });
  await webR.init();
  forwardOutput();
}

// Streams the gzipped image through the native decompressor, reporting
// download progress (in compressed bytes) at most every 100 ms.
async function fetchLibraryImage() {
  const checked = (response) => {
    if (!response.ok) throw new Error(`${response.url} → HTTP ${response.status}`);
    return response;
  };

  const metadataPromise = fetch(`${VFS_IMAGE_URL}.js.metadata`).then(checked).then((r) => r.json());
  const response = checked(await fetch(`${VFS_IMAGE_URL}.data.gz`));

  const total = Number(response.headers.get("Content-Length")) || 0;
  let loaded = 0;
  let lastReport = 0;
  const progress = new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      const now = performance.now();
      if (now - lastReport > 100) {
        lastReport = now;
        status("Downloading NetLogoR library…", { loaded, total });
        step("library", "active", { loaded, total });
      }
      controller.enqueue(chunk);
    },
  });

  const stream = response.body.pipeThrough(progress).pipeThrough(new DecompressionStream("gzip"));
  const [blob, metadata] = await Promise.all([new Response(stream).blob(), metadataPromise]);
  return { blob, metadata };
}

async function boot() {
  const timings = {};
  try {
    stage = "download";
    status("Starting R and downloading NetLogoR…");
    step("runtime", "active");
    step("library", "active");
    const [, image] = await Promise.all([
      startWebR().then(() => {
        timings.webr = elapsed();
        step("runtime", "done");
      }),
      fetchLibraryImage().then((img) => {
        timings.download = elapsed();
        return img;
      }),
    ]);

    stage = "mount";
    status("Mounting NetLogoR library…");
    await webR.FS.mkdir(VFS_MOUNT_POINT);
    await webR.FS.mount("WORKERFS", { packages: [{ blob: image.blob, metadata: image.metadata }] }, VFS_MOUNT_POINT);
    await webR.evalRVoid(`.libPaths(c("${VFS_MOUNT_POINT}", .libPaths()))`);
    // Everything the Workbench needs is in the mounted image. Pointing the
    // repository at a sentinel makes an accidental install.packages() fail
    // loudly instead of quietly downloading packages over the network.
    await webR.evalRVoid('options(repos = c(CRAN = "https://packages.disabled.invalid/"))');
    timings.mount = elapsed();
    step("library", "done");

    stage = "netlogor";
    status("Loading NetLogoR…");
    step("netlogor", "active");
    const available = await webR.evalRBoolean('requireNamespace("NetLogoR", quietly = TRUE)');
    if (!available) throw new Error("requireNamespace(\"NetLogoR\") returned FALSE for the bundled library.");
    await webR.evalRVoid("suppressPackageStartupMessages(library(NetLogoR))");
    const netlogor = {
      version: await webR.evalRString('as.character(packageVersion("NetLogoR"))'),
      path: await webR.evalRString('find.package("NetLogoR")'),
    };

    // The engine's own R helpers: sourced from a file so R errors carry
    // line numbers from r/workbench.R.
    await writeRFile(ENGINE_R_PATH, await fetch(WORKBENCH_R_URL).then((r) => r.text()));
    await webR.evalRVoid(`source("${ENGINE_R_PATH}", local = globalenv())`);
    // R's default graphics device is pdf(), which needs files this webR setup
    // leaves out. webR's own canvas device needs none: plot widgets capture
    // it (see drawDisplay), and captureR() relies on the default device when
    // it restores the previous one. Stray plots from model code land here and
    // are dropped (see forwardOutput).
    await webR.evalRVoid("options(device = webr::canvas)");
    timings.netlogor = elapsed();
    step("netlogor", "done");

    stage = "ready";
    bootFinished();
    post("WEBR_READY", {
      timings,
      crossOriginIsolated: self.crossOriginIsolated,
      channel: self.crossOriginIsolated ? "SharedArrayBuffer" : "PostMessage",
      netlogor,
    });
  } catch (err) {
    bootFailed(new Error(`Engine failed to start (${stage}): ${err?.message ?? err}`));
    post("ERROR", { stage, message: errorText(err) });
  }
}

// Collects R console output for the output log. Lines are buffered and sent
// with the monitor updates, so a model that prints every tick can't flood
// the main thread with messages. Output from the boot itself (R's startup
// banner) is dropped; boot problems are reported as ERROR messages instead.
async function forwardOutput() {
  for (;;) {
    const msg = await webR.read();
    // A plot drawn outside a plot widget (plot() in go(), say) arrives as a
    // picture nobody asked for: let it go.
    if (msg.type === "canvas") msg.data?.image?.close?.();
    if (stage === "ready" && (msg.type === "stdout" || msg.type === "stderr")) {
      logLines.push(msg.data);
      if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
      if (!run.active) flushMonitors(true);
    }
  }
}

// ---- R helpers --------------------------------------------------------

async function writeRFile(path, text) {
  await webR.FS.writeFile(path, text instanceof Uint8Array ? text : new TextEncoder().encode(text));
}

// Data files a model reads with workbench_data("name") are fetched from
// templates/data/ into R's filesystem before the model loads. Scanning the
// code keeps models self-contained text (so they survive a share link) while
// the data ships with the app. Only plain file names are accepted.
const DATA_DIR = "/data";
const fetchedData = new Set();

async function fetchModelData(code) {
  const names = [...code.matchAll(/workbench_data\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  const wanted = [...new Set(names)].filter((name) => !fetchedData.has(name));
  if (!wanted.length) return;

  if (!fetchedData.size) await webR.FS.mkdir(DATA_DIR);
  for (const name of wanted) {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`workbench_data("${name}"): use a plain file name from templates/data/.`);
    status(`Loading ${name}…`);
    const response = await fetch(new URL(name, DATA_BASE_URL));
    if (!response.ok) throw new Error(`workbench_data("${name}"): templates/data/${name} → HTTP ${response.status}`);
    await writeRFile(`${DATA_DIR}/${name}`, new Uint8Array(await response.arrayBuffer()));
    fetchedData.add(name);
  }
}

// Calls an R expression that returns a list and hands back plain JS data.
// .wb_json() keeps the shape predictable instead of webR's nested
// representation of R objects.
async function call(expression) {
  return JSON.parse(await webR.evalRString(`.wb_json(${expression})`, R_EVAL));
}

// ---- Frames -----------------------------------------------------------

// Reads one packed frame out of R as bytes the main thread can adopt
// without copying. See .wb_frame_raw() in r/workbench.R for the layout.
async function readFrame(force = false) {
  const shelter = await new webR.Shelter();
  try {
    const result = await shelter.evalR(`.wb_frame_raw(${force ? "TRUE" : "FALSE"})`, R_EVAL);
    const bytes = await result.toTypedArray();
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  } finally {
    await shelter.purge();
  }
}

async function sendFrame(force = false) {
  const buffer = await readFrame(force);
  run.inFlight += 1;
  post("FRAME", { buffer }, [buffer]);
}

// ---- Monitors and output ----------------------------------------------

// Monitors are read on their own slow cadence (about 11 Hz) rather than
// every frame: the canvas can run at 60 fps without the DOM text updates
// having to keep up. R's console output rides along on the same messages.
const MONITOR_INTERVAL_MS = 90;
let monitorsReadAt = 0;
let logLines = [];

// Returns whether it read them (they're due, or forced).
async function flushMonitors(force = false) {
  const now = performance.now();
  if (!force && now - monitorsReadAt < MONITOR_INTERVAL_MS) return false;
  monitorsReadAt = now;

  const values = Object.keys(monitorSpecs).length ? await call(".wb_read_monitors()") : {};
  const log = logLines;
  logLines = [];
  if (Object.keys(values).length || log.length) post("MONITORS", { values, log });
  return true;
}

let monitorSpecs = {};

// ---- Plots and reports ------------------------------------------------

// The interface's plots and reports: name → { kind, update, width, height,
// columns }, sizes in CSS pixels from the page. They draw only once setup()
// has run, since their code reads the model.
let displays = new Map();
let modelReady = false;

// While the model runs, plots and reports redraw within a time budget so
// they never slow it much: they may use the time the run would sleep to keep
// a set speed, plus about a tenth of R's working time (DISPLAY_SHARE). A
// display becomes due with the frames (update ticks) or with the monitors
// (update monitor); due displays are drawn while there's time, the one that
// has waited longest first, so every display gets its turn. One that costs
// more than its share simply redraws less often; its data lives in R, so
// nothing is lost. Redraws the model or the user asks for (setup, buttons,
// update_display()) aren't limited.
const DISPLAY_SHARE = 0.1;
const displayBudget = { creditMs: 0 };

function earnDisplayTime(workedMs) {
  displayBudget.creditMs = Math.min(250, displayBudget.creditMs + (workedMs * DISPLAY_SHARE) / (1 - DISPLAY_SHARE));
}

function markDue(update) {
  for (const display of displays.values()) if (display.update === update) display.due = true;
}

// `spare` gives the time left before the run's next tick is due (0 or less
// at full speed); drawing within it costs no credit.
async function drawDueDisplays(spare) {
  if (!modelReady) return;
  const due = [...displays].filter(([, d]) => d.due).sort(([, a], [, b]) => (a.drawnAt ?? 0) - (b.drawnAt ?? 0));
  for (const [name] of due) {
    const free = Math.max(0, spare());
    if (displayBudget.creditMs + free <= 0) return;
    const started = performance.now();
    await drawDisplay(name);
    displayBudget.creditMs -= Math.max(0, performance.now() - started - free);
  }
}

// Draws one plot or report and sends it to the page. A plot's code draws on
// webR's canvas device at the widget's size (at twice the resolution, for
// sharp text); the picture crosses to the page without copying. A plot that
// draws nothing leaves the page's picture as it was.
async function drawDisplay(name) {
  const display = displays.get(name);
  if (!display) return;
  display.due = false;
  display.drawnAt = performance.now();
  if (display.kind === "report") {
    post("DISPLAY", { name, ...(await call(`.wb_report_text(${rString(name)}, ${Math.max(20, display.columns | 0)}L)`)) });
    return;
  }

  const shelter = await new webR.Shelter();
  try {
    const drawn = await shelter.captureR(`.wb_draw_plot(${rString(name)})`, {
      captureGraphics: { width: display.width, height: display.height, bg: "white" },
      captureStreams: false,
      captureConditions: false,
      withAutoprint: false,
    });
    const error = (await drawn.result.toArray())[0];
    const image = drawn.images.at(-1) ?? null;
    for (const extra of drawn.images.slice(0, -1)) extra.close();
    if (error) {
      image?.close();
      post("DISPLAY", { name, error });
    } else if (image) {
      post("DISPLAY", { name, image }, [image]);
    }
  } finally {
    await shelter.purge();
  }
}

// Draws the displays `which` names: "all", "live" (all but manual ones),
// "ticks" or "monitor" (those with that update), or a list of names.
async function drawDisplays(which) {
  if (!modelReady || !displays.size) return;
  const names = Array.isArray(which)
    ? which
    : [...displays].filter(([, d]) => which === "all" || (which === "live" ? d.update !== "manual" : d.update === which))
      .map(([name]) => name);
  for (const name of names) await drawDisplay(name);
}

// What model code asked for while it ran: plots and reports to redraw
// (update_display) and files to download (workbench_download).
async function settle() {
  const pending = await call(".wb_take_pending()");
  if (pending.displays.length) await drawDisplays(pending.displays);
  for (const { path, name } of pending.downloads) {
    const bytes = await webR.FS.readFile(path);
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    post("DOWNLOAD", { name, bytes: buffer }, [buffer]);
  }
}

// After model code ran outside the run loop (a button, an import, a single
// tick): everything on the page catches up.
async function showState() {
  await sendFrame();
  await flushMonitors(true);
  await drawDisplays("live");
  await settle();
}

// The simulation runs as fast as R allows; frames are only packed when the
// main thread has painted the last one (it acknowledges each frame), so the
// display samples the run rather than throttling it, and no work goes into
// frames nobody will see.
const run = { active: false, ticksPerFrame: 1, ticksPerSecond: 0, inFlight: 0, busy: null, interrupting: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const acknowledge = () => {
  run.inFlight = Math.max(0, run.inFlight - 1);
};

async function runLoop() {
  while (run.active) {
    const tickStarted = performance.now();
    try {
      // Kept on `run` so STOP can tell whether a tick is still outstanding.
      run.busy = webR.evalRBoolean(`.wb_run_tick(${run.ticksPerFrame}L)`, R_EVAL);
      const stopRequested = await run.busy;
      run.busy = null;
      if (stopRequested) {
        // The model called stop_run(): finish like a pressed stop button, with
        // the final state on screen.
        run.active = false;
        await showState();
        break;
      }
      // Displays that follow the ticks become due with the frames, those
      // that follow the monitors with them; due ones draw within their time
      // budget (see drawDueDisplays), never on every tick.
      earnDisplayTime(performance.now() - tickStarted);
      const period = run.ticksPerSecond > 0 ? 1000 / run.ticksPerSecond : 0;
      const spare = () => period - (performance.now() - tickStarted);
      if (run.inFlight === 0) {
        await sendFrame();
        markDue("ticks");
      }
      if (await flushMonitors()) {
        markDue("monitor");
        await settle();
      }
      await drawDueDisplays(spare);

      // The speed control: hold each tick to a minimum duration. 0 = as fast
      // as R can go.
      if (run.ticksPerSecond > 0) {
        const remaining = 1000 / run.ticksPerSecond - (performance.now() - tickStarted);
        if (remaining > 1) await sleep(remaining);
      }
    } catch (err) {
      run.busy = null;
      run.active = false;
      // An interrupt we asked for is reported by STOP, not as a failure.
      if (!run.interrupting) post("ERROR", { stage: "go", message: errorText(err) });
    }
  }
  run.interrupting = false;
  post("RUN_STATE", { running: false });
}

// ---- Requests ---------------------------------------------------------

const handlers = {
  // Replaces the model in the session: the previous setup()/go() are
  // overwritten, but a Rebuild (PR 3.2) restarts the worker for a clean slate.
  async LOAD_MODEL({ code }) {
    await fetchModelData(code);
    await writeRFile(MODEL_R_PATH, code);
    return call(`.wb_load_model(${rString(MODEL_R_PATH)})`);
  },

  // Pushes widget values into the session. Sent before setup() so the model
  // can read them, and again whenever a control moves.
  async SET_VARS({ values }) {
    if (!values || !Object.keys(values).length) return { set: 0 };
    await webR.evalRVoid(`.wb_set_vars(${rList(values)})`, R_EVAL);
    return { set: Object.keys(values).length };
  },

  async GET_VARS({ names }) {
    const argument = names?.length ? `c(${names.map(rString).join(", ")})` : "NULL";
    return call(`.wb_get_vars(${argument})`);
  },

  // Monitor reporters come from the interface spec and are parsed once.
  async SET_MONITORS({ monitors }) {
    monitorSpecs = monitors ?? {};
    const specs = Object.entries(monitorSpecs)
      .map(([name, spec]) => `${name} = list(reporter = ${rString(spec.reporter)}, digits = ${rNumber(spec.digits)})`)
      .join(", ");
    await webR.evalRVoid(`.wb_set_monitors(list(${specs}))`, R_EVAL);
    await flushMonitors(true);
    return { monitors: Object.keys(monitorSpecs).length };
  },

  // The interface's views, in order: what each one draws and how (see
  // .wb_set_views). Once setup() has run, a complete frame follows at once,
  // so a new or changed view shows the current state without waiting for a
  // tick.
  async SET_VIEWS({ views, version }) {
    const ready = await webR.evalRBoolean(`.wb_set_views(list(${views.map(rValue).join(", ")}), ${Math.trunc(version)}L)`, R_EVAL);
    if (ready && !run.active) await sendFrame(true);
    return { views: views.length };
  },

  // A file from an `import` widget: written into R's filesystem, then the
  // import's own code runs with the import's name standing for the file's
  // path (see .wb_import). When the page replays imports into a fresh
  // session before setup(), nothing is drawn (restore: true).
  async IMPORT({ name, fileName, bytes, code, restore = false }) {
    const dir = await webR.evalRString(`.wb_import_dir(${rString(name)})`, R_EVAL);
    const path = `${dir}/${safeFileName(fileName)}`;
    await writeRFile(path, new Uint8Array(bytes));
    await webR.evalRVoid(`.wb_import(${rString(name)}, ${rString(path)}, ${rString(code)})`, R_EVAL);
    if (!restore) await showState();
    return { path };
  },

  async SETUP({ seed, values }) {
    run.active = false;
    if (values && Object.keys(values).length) {
      await webR.evalRVoid(`.wb_set_vars(${rList(values)})`, R_EVAL);
    }
    modelReady = false;
    const state = await call(`.wb_setup(${rNumber(seed)})`);
    modelReady = true;
    await sendFrame(true);
    await flushMonitors(true);
    // setup() starts the model over: every plot and report redraws, manual
    // ones included.
    await drawDisplays("all");
    await settle();
    return state;
  },

  // The interface's plots and reports, with their sizes. Once setup() has
  // run they draw at once (a new size, or new code, shows straight away).
  async SET_DISPLAYS({ displays: specs }) {
    displays = new Map(specs.map((spec) => [spec.name, spec]));
    const forR = specs.map(({ name, kind, code, update }) => ({ name, kind, code, update }));
    await webR.evalRVoid(`.wb_set_displays(${rValue(forR)})`, R_EVAL);
    await drawDisplays("all");
    return { displays: specs.length };
  },

  // A button's code, evaluated in the model's environment.
  async ACTION({ code }) {
    await webR.evalRVoid(`.wb_action(${rString(code)})`, R_EVAL);
    await showState();
    return { ok: true };
  },

  async TICK({ n = 1 }) {
    const state = await call(`.wb_go(${Math.max(1, Math.trunc(n))}L)`);
    await showState();
    return state;
  },

  async SET_SPEED({ ticksPerSecond = 0 }) {
    run.ticksPerSecond = Math.max(0, Number(ticksPerSecond) || 0);
    return { ticksPerSecond: run.ticksPerSecond };
  },

  async RUN({ ticksPerFrame = 1, ticksPerSecond }) {
    run.ticksPerFrame = Math.max(1, Math.trunc(ticksPerFrame));
    if (ticksPerSecond !== undefined) run.ticksPerSecond = Math.max(0, Number(ticksPerSecond) || 0);
    if (!run.active) {
      run.active = true;
      post("RUN_STATE", { running: true });
      runLoop();
    }
    return { running: true, ticksPerFrame: run.ticksPerFrame };
  },

  // Stops after the current tick. If that tick never finishes — model code
  // with a loop that cannot end — R is interrupted so the session stays
  // usable instead of being lost.
  async STOP({ graceMs = 750 } = {}) {
    run.active = false;
    if (!run.busy) return { running: false, interrupted: false };

    const timedOut = Symbol("timeout");
    const outcome = await Promise.race([
      run.busy.catch(() => {}),
      new Promise((resolve) => setTimeout(() => resolve(timedOut), graceMs)),
    ]);
    if (outcome !== timedOut) return { running: false, interrupted: false };

    run.interrupting = true;
    webR.interrupt();
    return { running: false, interrupted: true };
  },

  async BENCH({ n = 100, seed = 42 }) {
    return call(`.wb_bench(${Math.max(1, Math.trunc(n))}L, ${rNumber(seed)})`);
  },

  async EVAL({ code }) {
    const result = await webR.evalR(code, R_EVAL);
    try {
      return await result.toJs();
    } finally {
      webR.destroy(result);
    }
  },
};

self.addEventListener("message", async (event) => {
  const { type, id, ...payload } = event.data ?? {};
  if (type === "ACK") return acknowledge();

  // Model code that never returns (an endless loop in go()) blocks R, not
  // this worker, so an interrupt can still reach it — but only over the
  // SharedArrayBuffer channel. Without isolation, Rebuild is the way out.
  if (type === "INTERRUPT") {
    run.active = false;
    try {
      webR?.interrupt();
    } catch (err) {
      post("ERROR", { stage: "interrupt", message: errorText(err) });
    }
    return;
  }

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
