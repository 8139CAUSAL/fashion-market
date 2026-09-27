// NetLogoR Workbench — application entry point.
//
// Wires the shell (workbench drawer, DPR-aware world canvas) and boots the
// webR engine worker, mirroring its progress in the toolbar status pill.

import { EngineClient, EngineTerminated } from "./engine.js";
import { TEMPLATES_URL } from "./config.js";
import { parseFrame, frameVersion } from "./renderer.js";
import { WorldViews } from "./views.js";
import { parseSpec } from "./spec-parser.js";
import { resolveLayout } from "./layout.js";
import { WidgetGrid } from "./widgets.js";
import { attachEditor } from "./editor.js";
import { showBanner, dismissBanner, clearBanners, hasBanner } from "./banners.js";
import { ImportStore, ImportError, chooseFile, describeImport, formatBytes } from "./imports.js";
import { CanvasRecorder, extensionFor, supportedMimeType } from "./recorder.js";
import { downloadBlob, mediaTypeFor } from "./downloads.js";
import { encodeWorkspace, decodeWorkspace } from "./share.js";
import { LoadingScreen } from "./loading.js";

const $ = (selector) => document.querySelector(selector);

const els = {
  workspace: $("#workspace"),
  stage: $("#stage"),
  stageGrid: $(".stage-grid"),
  editButton: $("#btn-edit"),
  closeDrawerButton: $("#btn-close-drawer"),
  status: $("#engine-status"),
  statusText: $("#engine-status .status-text"),
  canvas: $("#view"),
  viewBox: $("#view-box"),
  tickCounter: $("#tick-counter"),
  fpsCounter: $("#fps-counter"),
  modelEditor: $("#editor-model"),
  specEditor: $("#editor-ui"),
  widgetGrid: $("#widget-grid"),
  widgetPanel: $(".widget-panel"),
  viewPanel: $(".view-panel"),
  rebuildButton: $("#btn-rebuild"),
  recordButton: $("#btn-record"),
  shareButton: $("#btn-share"),
  presetSelect: $("#preset-select"),
  speed: $("#speed"),
  speedReadout: $("#speed-readout"),
  banners: $("#banners"),
};

const loading = new LoadingScreen($("#loading"));

function setTicks(ticks) {
  els.tickCounter.textContent = `ticks: ${ticks}`;
}

function setEngineStatus(state, text) {
  els.status.dataset.state = state;
  els.statusText.textContent = text;
}

// ---- Workbench drawer -------------------------------------------------

const DRAWER_KEY = "netlogor.drawer";

function setDrawerOpen(open, { remember = true } = {}) {
  els.workspace.dataset.drawer = open ? "open" : "closed";
  els.editButton.setAttribute("aria-pressed", String(open));
  if (remember) {
    try { localStorage.setItem(DRAWER_KEY, open ? "open" : "closed"); } catch { /* ignore */ }
  }
}

// The code drawer starts open only where there's room for it beside the
// world; after that it stays however the viewer left it.
function initDrawer() {
  let saved = null;
  try { saved = localStorage.getItem(DRAWER_KEY); } catch { /* storage unavailable */ }
  setDrawerOpen(saved ? saved === "open" : window.innerWidth >= 1400, { remember: false });

  els.editButton.addEventListener("click", () => {
    setDrawerOpen(els.workspace.dataset.drawer !== "open");
  });
  els.closeDrawerButton.addEventListener("click", () => setDrawerOpen(false));
  initTabs();
}

// Interface and Model share the drawer, one at a time.
function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];

  const select = (tab) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute("aria-controls")).hidden = !selected;
    }
    tab.focus({ preventScroll: true });
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      select(tabs[(index + step + tabs.length) % tabs.length]);
    });
  });
}

// ---- World views ------------------------------------------------------

// The first view is the page's own canvas (with the loading screen, tick
// counter and speed); each further `view` line gets its own (js/views.js).
const worldViews = new WorldViews({ box: els.viewBox, canvas: els.canvas, home: els.viewPanel });

// Repaints only when a new frame has arrived, then acknowledges it so the
// worker knows it can send the next one — one acknowledgement per frame,
// however many views it holds. That paces the simulation to the display
// instead of letting frames pile up on the main thread.
const view = { engine: null, pending: null, lastFpsAt: 0, framesSinceFps: 0 };

// Started once, for the lifetime of the page: a rebuild swaps the engine
// underneath it rather than starting a second loop.
function startRenderLoop() {
  const tickFrame = (now) => {
    requestAnimationFrame(tickFrame);
    if (!view.pending) return;

    const frame = view.pending;
    view.pending = null;
    worldViews.show(frame);
    setTicks(frame.ticks);
    view.engine?.ack();

    view.framesSinceFps += 1;
    if (now - view.lastFpsAt >= 500) {
      const fps = (1000 * view.framesSinceFps) / (now - view.lastFpsAt);
      els.fpsCounter.textContent = `${fps.toFixed(0)} fps · ${frame.views[0]?.turtleCount ?? 0} turtles`;
      view.lastFpsAt = now;
      view.framesSinceFps = 0;
    }
  };
  requestAnimationFrame(tickFrame);
}

function receiveFrame(buffer) {
  // A frame packed for an older set of views doesn't fit the canvases now
  // on screen; the engine sends a complete one for the new set.
  if (frameVersion(buffer) !== app.viewsVersion) {
    view.engine?.ack();
    return;
  }
  const frame = parseFrame(buffer, view.pending?.views ?? worldViews.frames);
  // Only the newest frame is worth painting; acknowledge the one it replaces
  // so the worker's in-flight count doesn't drift and stall the run.
  if (view.pending) view.engine.ack();
  view.pending = frame;
  worldViews.fit(frame);
}

// ---- Interface spec ---------------------------------------------------

// ---- Widget ↔ R binding ----------------------------------------------

// Last value sent to (or read back from) R for each widget. A change is only
// forwarded when it differs from this, and values arriving from R are
// recorded here before touching a control, so neither side can echo the
// other into a loop.
const bound = new Map();

async function pushWidgetValues(engine, values) {
  const changed = {};
  for (const [name, value] of Object.entries(values)) {
    if (bound.get(name) === value) continue;
    bound.set(name, value);
    changed[name] = value;
  }
  if (Object.keys(changed).length) await engine.request("SET_VARS", { values: changed });
  return changed;
}

// Follows variables the model assigns itself. Controls are updated directly,
// which fires no change events, and `bound` is updated first so the new
// value is never sent straight back to R.
async function pullWidgetValues(engine) {
  const names = Object.keys(widgetGrid.values);
  if (!names.length) return;
  const values = await engine.request("GET_VARS", { names });
  for (const [name, value] of Object.entries(values ?? {})) {
    if (bound.get(name) === value) continue;
    bound.set(name, value);
    widgetGrid.setValue(name, value);
    if (name === "palette") followPaletteChooser();
  }
}

// A chooser named `palette` picks the continuous palette for every view
// that doesn't name its own (see js/views.js).
function followPaletteChooser() {
  worldViews.setPalette(widgetGrid.values.palette);
}

const widgetGrid = new WidgetGrid($("#widget-grid"), {
  onAction: (widget) => runWidgetAction(widget),
  onToggle: (widget, running) => toggleRun(widget, running),
  onChange: (name, value) => {
    bound.set(name, value);
    app.engine?.request("SET_VARS", { values: { [name]: value } }).catch(reportError);
    if (name === "palette") followPaletteChooser();
  },
  onImport: (widget, files) => importFile(widget, files).catch(reportError),
});

// Parses the spec, resolves the relative placements into grid cells and
// builds the widgets. Problems are listed in a banner rather than thrown
// away, and a placement that fails is simply ignored, so a half-finished spec
// still shows what it can.
function buildInterface(text) {
  const { widgets, errors } = parseSpec(text);
  const layout = resolveLayout(widgets, {
    onError: (err) => errors.push({ line: err.line, message: err.message }),
  });

  widgetGrid.render(layout);
  // Editing the interface mid-run rebuilds the buttons; the one that's
  // running stays pressed, so pressing it again still stops the run.
  if (app.running) widgetGrid.setRunning(app.runningButton, true);
  for (const widget of widgetGrid.imports) showImport(widget.name);
  followPaletteChooser();
  placeViews();
  sendDisplaySpecs();
  errors.sort((a, b) => a.line - b.line);
  showSpecErrors(errors);
  sendMonitorSpecs();
  return { layout, errors };
}

// The world views go wherever the spec's `view` lines put them. Without any,
// the one view keeps its own panel to the right of the controls. Moving the
// elements keeps each canvas, its picture and the loading screen.
function placeViews() {
  const inline = worldViews.arrange(widgetGrid.viewSlots);
  els.stageGrid.classList.toggle("has-inline-view", inline);
  sendViewSpecs();
}

// Tells R what each view draws, whenever that changes and once for each new
// engine. The version comes back in every frame, so frames packed for the
// old views can be told apart and dropped.
function sendViewSpecs() {
  const engine = app.engine;
  if (!engine) return;
  const views = worldViews.specs;
  const key = JSON.stringify(views);
  if (app.viewsSent.engine === engine && app.viewsSent.key === key) return;
  app.viewsSent = { engine, key };
  app.viewsVersion += 1;
  engine.request("SET_VIEWS", { views, version: app.viewsVersion }).catch(reportError);
}

// Hands the plots and reports to R, with the size each widget has to fill.
// Sent with every rebuild of the widgets, like the monitors: new widgets
// start empty, and once setup() has run the engine draws them at once.
function sendDisplaySpecs() {
  if (!app.engine) return;
  app.engine.request("SET_DISPLAYS", { displays: widgetGrid.displaySpecs() }).catch(reportError);
}

// A file the model handed over with workbench_download(). Straight after a
// click (a button's code wrote it) the browser lets the page save it at
// once; otherwise, e.g. at the end of a run, it waits in a banner for a
// click, because browsers block downloads nobody asked for.
function offerDownload({ name, bytes }) {
  const blob = new Blob([bytes], { type: mediaTypeFor(name) });
  const size = formatBytes(blob.size);
  if (navigator.userActivation?.isActive) {
    downloadBlob(blob, name);
    widgetGrid.appendOutput(`Saved ${name} (${size})`);
    return;
  }
  widgetGrid.appendOutput(`${name} is ready to save (${size})`);
  showBanner(els.banners, {
    key: `download-${name}`,
    kind: "info",
    title: `${name} is ready to save (${size})`,
    detail: "The model made this file. It stays in this browser tab until you save it.",
    action: { label: "Save", run: () => downloadBlob(blob, name) },
  });
}

// Hands the monitors' reporters to R, which parses them once.
function sendMonitorSpecs() {
  if (!app.engine) return;
  const monitors = Object.fromEntries(
    widgetGrid.monitors.map((widget) => [widget.name, { reporter: widget.reporter, digits: widget.digits }])
  );
  app.engine.request("SET_MONITORS", { monitors }).catch(reportError);
}

function showSpecErrors(errors) {
  if (!errors.length) return dismissBanner("spec");

  showBanner(els.banners, {
    key: "spec",
    kind: "error",
    title: errors.length === 1 ? "Interface spec: 1 problem" : `Interface spec: ${errors.length} problems`,
    detail: errors.map((error) => `line ${error.line}: ${error.message}`).join("\n"),
  });
}

// Rebuilding the widgets is cheap and touches nothing in R, so the grid can
// follow the spec as it is typed. Re-running the model is a separate,
// deliberate step: Rebuild (PR 3.2).
const editors = { spec: null, model: null };

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function initEditors() {
  const rebuildInterface = debounce((text) => buildInterface(text), 200);
  [editors.spec, editors.model] = await Promise.all([
    attachEditor(els.specEditor, { language: "spec", onChange: rebuildInterface }),
    attachEditor(els.modelEditor, { language: "r", onChange: () => markModelDirty() }),
  ]);
}

// Model edits only take effect on Rebuild, so the button says when it has
// something to apply.
function markModelDirty(dirty = true) {
  app.modelDirty = dirty;
  els.rebuildButton.classList.toggle("is-dirty", dirty);
  els.rebuildButton.title = dirty ? "Model changed — rebuild to apply" : "Restart the engine and run setup()";
}

// ---- Imports ----------------------------------------------------------

// Files from `import` widgets (see js/imports.js). The page keeps them for
// Rebuilds; R gets a path and the import's own code decides what the file
// means.
const imports = new ImportStore();

function showImport(name) {
  widgetGrid.setImport(name, describeImport(imports.get(name)));
}

// A file picked or dropped on an import widget: checked, kept, then handed
// to R, where the import's code runs.
async function importFile(widget, files) {
  const title = widget.label || widget.name;
  let file;
  try {
    file = chooseFile(widget, files);
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    showBanner(els.banners, { key: `import-${widget.name}`, kind: "warning", title: `Couldn't import into “${title}”`, detail: err.message });
    return;
  }

  // Read once: the page keeps its own copy, so a Rebuild doesn't depend on
  // the original file still being where it was.
  const bytes = await file.arrayBuffer();
  const record = imports.set(widget.name, {
    fileName: file.name,
    size: file.size,
    type: file.type,
    blob: new Blob([bytes], { type: file.type }),
  });
  await runImport(app.engine, widget, record, { bytes });
  if (record.state !== "ready") return;
  await pullWidgetValues(app.engine);
  if (hasBanner("imports")) announceImports();
}

// Sends one import to R. `restore` replays it into a fresh session before
// setup(), without drawing.
async function runImport(engine, widget, record, { bytes = null, restore = false } = {}) {
  record.state = "reading";
  showImport(widget.name);
  try {
    const payload = bytes ?? await record.blob.arrayBuffer();
    await engine.request("IMPORT", { name: widget.name, fileName: record.fileName, bytes: payload, code: widget.code, restore }, [payload]);
    record.state = "ready";
    dismissBanner(`import-${widget.name}`);
  } catch (err) {
    record.state = "failed";
    // A Rebuild replays the import in the new session; an engine it
    // replaced has nothing left to report.
    if (engine === app.engine) {
      reportError(err, { key: `import-${widget.name}`, title: `The import “${widget.label || widget.name}” failed` });
    }
  } finally {
    showImport(widget.name);
  }
}

// Replays every import that has a file into a fresh session, in the order
// the spec lists them, each import's code seeing what the earlier ones made.
async function restoreImports(engine) {
  for (const widget of widgetGrid.imports) {
    const record = imports.get(widget.name);
    if (record) await runImport(engine, widget, record, { restore: true });
  }
}

// A model opens without its imported files (share links never carry them),
// so it says which it still needs; the note goes once each import has one.
function announceImports() {
  const missing = imports.missing(widgetGrid.imports);
  if (!missing.length) return dismissBanner("imports");
  const names = missing.map((widget) => widget.label || widget.name);
  showBanner(els.banners, {
    key: "imports",
    kind: "warning",
    title: `${names.length === 1 ? "Import" : "Imports"} required: ${names.join(", ")}`,
    detail: "This model reads files you import yourself: choose or drop each one on its import control. " +
      "Files stay in this browser tab; share links never carry them.",
  });
}

// A file dropped anywhere but on an import widget would make the browser
// open it in place of the Workbench (and lose the workspace).
function guardFileDrops() {
  for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (event) => {
      if ([...(event.dataTransfer?.types ?? [])].includes("Files")) event.preventDefault();
    });
  }
}

// ---- Model actions ----------------------------------------------------

const app = {
  engine: null,
  running: false,
  runningButton: null, // the forever button that started the run
  readyText: "NetLogoR ready",
  templateId: null,
  baseline: null,     // the spec and model as last loaded, to detect edits
  preset: null,       // { id, spec, model } the workspace started from, for share links
  seed: undefined,
  viewsVersion: 0,    // which set of views the frames on their way should fit
  viewsSent: {},      // the views last sent, and to which engine
};

// A failure in the model never takes the interface with it: the message is
// shown, the engine keeps running, and Rebuild offers a clean slate.
function reportError(err, { title = "The model stopped with an error", key = "model" } = {}) {
  if (err instanceof EngineTerminated) return;
  const message = err?.message ?? String(err);
  setEngineStatus("error", "Model error");
  els.status.title = message;
  widgetGrid.appendOutput(`Error: ${message}`);
  console.error(`[model] ${message}`);
  showBanner(els.banners, {
    key,
    kind: "error",
    title,
    detail: message,
    action: { label: "Rebuild", run: () => rebuild() },
  });
}

// `button setup` runs the model's setup(), which also reseeds the widget
// values and resets the tick counter; any other button just runs its code.
async function runWidgetAction(widget) {
  try {
    if (widget.action === "setup()") {
      await stopRun();
      const state = await app.engine.request("SETUP", { values: widgetGrid.values });
      setTicks(state.ticks);
      await pullWidgetValues(app.engine);
    } else {
      await app.engine.request("ACTION", { code: widget.action });
      await pullWidgetValues(app.engine);
    }
  } catch (err) {
    reportError(err);
  }
}

// A forever button runs the model until pressed again. If the model is stuck
// in R, a plain stop never arrives, so the request is backed by an interrupt.
async function toggleRun(widget, running) {
  try {
    if (running) {
      await app.engine.request("RUN", { ticksPerFrame: 1, ticksPerSecond: currentSpeed() });
      app.running = true;
      app.runningButton = widget.name;
    } else {
      const engine = app.engine;
      await withInterruptRescue(engine, async () => {
        const result = await engine.request("STOP");
        if (result?.interrupted) reportInterrupted();
        // Reading values back needs R, which a stuck tick still owns — so
        // this is inside the rescue, not after it.
        await pullWidgetValues(engine);
      });
      app.running = false;
    }
  } catch (err) {
    widgetGrid.setRunning(widget.name, false);
    reportError(err);
  }
}

async function stopRun() {
  if (!app.running) return;
  const engine = app.engine;
  await withInterruptRescue(engine, () => engine.request("STOP"));
  app.running = false;
  for (const widget of widgetGrid.foreverButtons) widgetGrid.setRunning(widget.name, false);
}

// Model code that never returns would otherwise leave the interface waiting
// forever. If the work hasn't finished in time, R is interrupted — the page
// itself never blocks, because R runs in the worker.
function reportInterrupted() {
  showBanner(els.banners, {
    key: "stuck",
    kind: "warning",
    title: "The model was taking too long, so R was interrupted",
    detail: "A tick never finished — check go() for a loop that cannot end. The session is still usable; Rebuild starts a fresh one.",
    action: { label: "Rebuild", run: () => rebuild() },
  });
}

async function withInterruptRescue(engine, work, { timeoutMs = 1000 } = {}) {
  const rescue = setTimeout(() => {
    console.warn("[engine] R did not respond in time; interrupting");
    engine.interrupt();
    reportInterrupted();
  }, timeoutMs);
  try {
    return await work();
  } finally {
    clearTimeout(rescue);
  }
}

// ---- Engine -----------------------------------------------------------

function startEngine() {
  const engine = new EngineClient();
  app.engine = engine;
  view.engine = engine;

  engine.addEventListener("STATUS", ({ detail }) => {
    const pct = detail.total ? ` ${Math.round((100 * detail.loaded) / detail.total)}%` : "";
    setEngineStatus("loading", `${detail.message}${pct}`);
  });

  engine.addEventListener("STEP", ({ detail }) => loading.step(detail.step, detail.state, detail));

  engine.addEventListener("WEBR_READY", ({ detail }) => {
    const seconds = (performance.now() / 1000).toFixed(1);
    app.readyText = `NetLogoR ${detail.netlogor.version} ready`;
    setEngineStatus("ready", app.readyText);
    els.status.title = `Ready ${seconds}s after page load · ${detail.channel} channel`;
    console.info(`[engine] WEBR_READY at ${seconds}s (worker timings ms: ${JSON.stringify(detail.timings)}; ` +
      `channel=${detail.channel}; NetLogoR ${detail.netlogor.version} from ${detail.netlogor.path})`);
    applyWorkspace(engine);
  });

  engine.addEventListener("ERROR", ({ detail }) => {
    if (!["go", "interrupt"].includes(detail.stage)) loading.fail();
    const titles = {
      go: "The model stopped during go()",
      interrupt: "Could not interrupt the model",
    };
    reportError(new Error(detail.message), {
      key: `engine-${detail.stage}`,
      title: titles[detail.stage] ?? `The engine failed while ${detail.stage}`,
    });
  });

  // The worker stops running when a tick fails; release the forever buttons
  // so the interface matches.
  engine.addEventListener("RUN_STATE", ({ detail }) => {
    app.running = detail.running;
    if (!detail.running) {
      for (const widget of widgetGrid.foreverButtons) widgetGrid.setRunning(widget.name, false);
    }
  });

  engine.addEventListener("MONITORS", ({ detail }) => {
    for (const [name, text] of Object.entries(detail.values ?? {})) widgetGrid.setMonitor(name, text);
    for (const line of detail.log ?? []) widgetGrid.appendOutput(line);
  });

  engine.addEventListener("FRAME", ({ detail }) => receiveFrame(detail.buffer));

  // A plot's picture or a report's text. A picture for a widget that has
  // gone meanwhile is let go at once.
  engine.addEventListener("DISPLAY", ({ detail }) => {
    if (!widgetGrid.showDisplay(detail.name, detail)) detail.image?.close();
  });
  engine.addEventListener("DOWNLOAD", ({ detail }) => offerDownload(detail));

  return engine;
}

// Sends whatever is in the editors to a ready engine: build the widgets,
// load the model, seed the widget variables, then run setup().
async function applyWorkspace(engine) {
  loading.step("model", "active");
  try {
    buildInterface(editors.spec.getValue());
    await engine.request("LOAD_MODEL", { code: editors.model.getValue() });
    // Widget values reach R before setup() runs, so the model can read them.
    await pushWidgetValues(engine, widgetGrid.values);
    sendMonitorSpecs();
    // Imported files go back in, and their code runs again, before setup()
    // so what it made is there for the model.
    await restoreImports(engine);
    announceImports();

    const state = await engine.request("SETUP", { seed: app.seed });
    setTicks(state.ticks);
    markModelDirty(false);
    setEngineStatus("ready", app.readyText);
    loading.step("model", "done");
    loading.hide();
    console.info(`[model] setup() in ${state.elapsedMs.toFixed(0)}ms · ${state.turtles} turtles · ` +
      `world ${state.world ? `${state.world.width}x${state.world.height}` : "(none yet)"} · R memory ${state.memoryMb}MB`);

    widgetGrid.setDisabled(false);

    const benchTicks = Number(new URLSearchParams(location.search).get("bench"));
    if (benchTicks > 0) await runBenchmark(engine, benchTicks);
  } catch (err) {
    // A rebuild replaced this engine part-way (say, another preset was
    // picked while this one loaded): the new engine owns the screen now.
    if (err instanceof EngineTerminated) return;
    widgetGrid.setDisabled(false);
    loading.fail();
    reportError(err);
  }
}

// Rebuild: throw the whole R session away and start again from the
// editors. Terminating the worker is the only way to be certain no
// variable, agentset or half-finished tick survives from the last model.
async function rebuild() {
  console.info("[engine] rebuild: terminating engine worker");
  app.engine?.terminate();
  app.engine = null;
  app.running = false;

  bound.clear();
  clearBanners();
  view.pending = null;
  worldViews.clear();
  // The controls stay on screen, so a view placed among them doesn't jump;
  // they come back to life once the new session has run setup().
  widgetGrid.setDisabled(true);
  setTicks(0);
  els.fpsCounter.textContent = "— fps";

  setEngineStatus("loading", "Rebuilding…");
  loading.reset("Restarting the engine");
  startEngine();
}

async function runBenchmark(engine, n) {
  setEngineStatus("loading", `Running ${n} ticks…`);
  const result = await engine.request("BENCH", { n, seed: 42 });
  setTicks(result.ticks);
  setEngineStatus("ready", `${n} ticks in ${(result.elapsedMs / 1000).toFixed(2)}s`);
  console.info(`[bench] ${result.ticks} headless ticks with ${result.turtles} turtles in ` +
    `${result.elapsedMs.toFixed(0)}ms (${result.msPerTick.toFixed(2)}ms/tick, ` +
    `${(1000 / result.msPerTick).toFixed(0)} ticks/s); R memory ${result.memoryBeforeMb}MB → ${result.memoryAfterMb}MB`);
  return result;
}

// ---- Recording --------------------------------------------------------

const recorder = new CanvasRecorder(els.canvas);

function initRecorder() {
  const mimeType = supportedMimeType();
  if (!mimeType) {
    els.recordButton.title = "This browser can't record canvas video.";
    return;
  }

  els.recordButton.disabled = false;
  els.recordButton.title = `Record the world view as .${extensionFor(mimeType)}`;
  els.recordButton.addEventListener("click", () => toggleRecording());
}

function setRecordingUI(recording) {
  els.recordButton.setAttribute("aria-pressed", String(recording));
  els.recordButton.classList.toggle("is-recording", recording);
  els.recordButton.querySelector(".btn-label").textContent = recording ? "Stop" : "Record";
}

async function toggleRecording() {
  try {
    if (recorder.recording) {
      const seconds = (recorder.elapsedMs / 1000).toFixed(1);
      const result = await recorder.stop();
      setRecordingUI(false);
      if (!result?.blob?.size) throw new Error("Nothing was recorded.");

      const name = `netlogor-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${extensionFor(result.mimeType)}`;
      downloadBlob(result.blob, name);
      widgetGrid.appendOutput(`Saved ${name} (${seconds}s, ${(result.blob.size / 1048576).toFixed(1)} MB)`);
      console.info(`[record] ${name} · ${seconds}s · ${(result.blob.size / 1048576).toFixed(1)} MB · ${result.mimeType}`);
    } else {
      const { mimeType } = recorder.start({ fps: 30 });
      setRecordingUI(true);
      console.info(`[record] recording as ${mimeType}`);
    }
  } catch (err) {
    setRecordingUI(false);
    reportError(err, { key: "record", title: "Recording failed" });
  }
}

// ---- Speed ------------------------------------------------------------

// Ticks per second for each step of the speed slider; 0 means "as fast as
// R can go". Like NetLogo's speed slider, it only paces the run.
const SPEEDS = [1, 2, 5, 10, 20, 30, 60, 0];
const SPEED_KEY = "netlogor.speed";

const currentSpeed = () => SPEEDS[Number(els.speed.value)] ?? 30;

function initSpeed() {
  try {
    const saved = localStorage.getItem(SPEED_KEY);
    if (saved !== null && SPEEDS[Number(saved)] !== undefined) els.speed.value = saved;
  } catch { /* storage unavailable: keep the default */ }

  const show = () => {
    const speed = currentSpeed();
    els.speedReadout.textContent = speed ? `${speed}/s` : "max";
  };
  show();

  els.speed.addEventListener("input", () => {
    show();
    try { localStorage.setItem(SPEED_KEY, els.speed.value); } catch { /* ignore */ }
    app.engine?.request("SET_SPEED", { ticksPerSecond: currentSpeed() }).catch(() => {});
  });
}

// ---- Preset gallery ---------------------------------------------------

const gallery = new Map();

async function initGallery() {
  const index = await fetch(new URL("index.json", TEMPLATES_URL)).then((r) => r.json());
  els.presetSelect.replaceChildren(
    ...index.templates.map((template) => {
      gallery.set(template.id, template);
      return Object.assign(document.createElement("option"), {
        value: template.id,
        textContent: template.name,
        title: template.description ?? "",
      });
    })
  );
  els.presetSelect.disabled = false;
  els.presetSelect.addEventListener("change", () => loadTemplate(els.presetSelect.value, { confirmReplace: true }));
  return gallery.has(index.default) ? index.default : index.templates[0]?.id;
}

// True when the editors hold edits the loaded preset doesn't have.
function editorsChanged() {
  return Boolean(app.baseline) &&
    (editors.spec.getValue() !== app.baseline.spec || editors.model.getValue() !== app.baseline.model);
}

const presetCache = new Map();

// A preset's spec and model text.
async function fetchPreset(id) {
  const template = gallery.get(id);
  if (!template) throw new Error(`There is no preset called “${id}”.`);
  if (!presetCache.has(id)) {
    const [spec, model] = await Promise.all([
      fetch(new URL(template.spec, TEMPLATES_URL)).then((r) => r.text()),
      fetch(new URL(template.model, TEMPLATES_URL)).then((r) => r.text()),
    ]);
    presetCache.set(id, { id, spec, model });
  }
  return presetCache.get(id);
}

// Fills the editors. `preset` is the preset this workspace derives from (for
// share links), or null for one written from scratch.
function setWorkspace({ spec, model }, preset) {
  // Imported files belong to the workspace they were imported into.
  imports.clear();
  editors.spec.setValue(spec);
  editors.model.setValue(model);
  app.baseline = { spec, model };
  app.preset = preset;
  app.templateId = preset?.id ?? null;
  showPresetSelection(app.templateId);
  markModelDirty(false);
}

function showPresetSelection(id) {
  els.presetSelect.querySelector("option[data-custom]")?.remove();
  if (id) {
    els.presetSelect.value = id;
  } else {
    const custom = Object.assign(document.createElement("option"), { textContent: "Shared model", value: "" });
    custom.dataset.custom = "";
    custom.disabled = true;
    els.presetSelect.prepend(custom);
    els.presetSelect.value = "";
  }
}

// Puts a preset in the editors and, once the engine exists, rebuilds so it
// runs in a fresh R session.
async function loadTemplate(id, { confirmReplace = false } = {}) {
  const template = gallery.get(id);
  if (!template) return;

  if (confirmReplace && editorsChanged() &&
      !window.confirm(`Replace the current interface and model with “${template.name}”? Your edits will be lost.`)) {
    showPresetSelection(app.templateId);
    return;
  }

  const preset = await fetchPreset(id);
  setWorkspace(preset, preset);
  // The address bar no longer describes what's on screen.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);

  if (app.engine) await rebuild();
}

// ---- Share links -------------------------------------------------------

async function shareWorkspace() {
  try {
    const hash = await encodeWorkspace(
      { spec: editors.spec.getValue(), model: editors.model.getValue() },
      app.preset
    );
    history.replaceState(null, "", `#${hash}`);
    const url = location.href;

    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch { /* clipboard blocked: the banner shows the link instead */ }

    showBanner(els.banners, {
      key: "share",
      kind: "info",
      title: copied ? `Link copied — ${url.length.toLocaleString()} characters` : "Copy this link to share the model",
      detail: url,
    });
  } catch (err) {
    reportError(err, { key: "share", title: "Couldn't make a share link" });
  }
}

// Opens a model from the address bar, if there is one. Returns true when it
// filled the editors.
async function openSharedLink() {
  if (!location.hash) return false;
  try {
    const shared = await decodeWorkspace(location.hash, fetchPreset);
    if (!shared) return false;
    const preset = shared.presetId ? await fetchPreset(shared.presetId) : null;
    setWorkspace(shared, preset);
    showBanner(els.banners, {
      key: "shared",
      kind: shared.warning ? "warning" : "info",
      title: preset ? `Opened a shared model based on “${gallery.get(preset.id).name}”` : "Opened a shared model",
      detail: [shared.warning, "Its R code runs only here, inside this browser tab."].filter(Boolean).join("\n"),
    });
    return true;
  } catch (err) {
    reportError(err, { key: "shared", title: "This share link couldn't be opened" });
    return false;
  }
}

// ---- Boot -------------------------------------------------------------

async function boot() {
  initDrawer();
  guardFileDrops();
  startRenderLoop();
  els.rebuildButton.addEventListener("click", () => rebuild());
  els.rebuildButton.disabled = false;
  initRecorder();
  initSpeed();

  await initEditors();

  // A share link or a preset fills the editors; from here on the editors are
  // the source of truth, including across rebuilds.
  const first = await initGallery();
  if (!(await openSharedLink())) await loadTemplate(first);

  els.shareButton.disabled = false;
  els.shareButton.addEventListener("click", () => shareWorkspace());
  // Pasting a different share link into the address bar opens it.
  window.addEventListener("hashchange", async () => {
    if (await openSharedLink()) rebuild();
  });

  widgetGrid.setDisabled(true);
  startEngine();

  // Debugging handle for the browser console.
  window.workbench = { app, editors, widgetGrid, worldViews, rebuild, loadTemplate };
}

boot();
