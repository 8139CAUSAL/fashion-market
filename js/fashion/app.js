// Fashion market — the page. Starts the simulation worker (R in webR) with
// the world last set up, wires the header's run controls and the tabs, and
// hands each tab the numbers R sends for it. Every chart is drawn here from
// those numbers; every number comes from the model's agents.
//
// The world: the Setup tab edits a draft (world-store.js). Setup sends the
// draft to R when it holds changes that wait for Setup; R checks it and
// installs it, or says what's wrong and the season goes on as it was.

import { el, fmt } from "./ui.js";
import { WorldStore } from "./world-store.js";
import { SetupTab } from "./tabs/setup.js";
import { MarketTab } from "./tabs/market.js";
import { StrategyTab } from "./tabs/strategy.js";
import { OffersTab } from "./tabs/offers.js";
import { FunnelTab } from "./tabs/funnel.js";
import { StoreTab } from "./tabs/store.js";
import { AssortmentTab } from "./tabs/assortment.js";
import { ScorecardTab } from "./tabs/scorecard.js";
import { CodeDrawer } from "./code-drawer.js";

const $ = (sel) => document.querySelector(sel);

// ---- The worker ---------------------------------------------------------------

class SimClient extends EventTarget {
  #worker = new Worker(new URL("../../workers/sim.worker.js", import.meta.url), { type: "module" });
  #next = 1;
  #pending = new Map();
  constructor() {
    super();
    this.#worker.addEventListener("message", ({ data }) => {
      if (data.type === "RESULT") {
        const p = this.#pending.get(data.id);
        if (!p) return;
        this.#pending.delete(data.id);
        data.ok ? p.resolve(data.value) : p.reject(new Error(data.error));
        return;
      }
      this.dispatchEvent(new CustomEvent(data.type, { detail: data }));
    });
    this.#worker.addEventListener("error", (ev) => this.dispatchEvent(new CustomEvent("ERROR", { detail: { stage: "worker", message: ev.message || "The simulation worker failed to load." } })));
  }
  request(type, payload = {}) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ type, id, ...payload });
    });
  }
  post(type, payload = {}) { this.#worker.postMessage({ type, ...payload }); }
  ack() { this.#worker.postMessage({ type: "ACK" }); }
}

// A frame from frame_pack() in model/frames.R.
function parseFrame(buffer) {
  const f = new Float64Array(buffer);
  let i = 4;
  const take = (n) => { const a = f.subarray(i, i + n); i += n; return a; };
  const nt = f[i++];
  const travellers = { n: nt, x: take(nt), y: take(nt), brand: take(nt), back: take(nt) };
  const n = f[i++];
  const floor = { n, x: take(n), y: take(n), look: take(n), visit: take(n) };
  const ns = f[i++];
  Object.assign(floor, { staffN: ns, staffX: take(ns), staffY: take(ns), staffRole: take(ns), staffId: take(ns), staffBusy: take(ns) });
  const nc = f[i++];
  Object.assign(floor, { cubBusy: take(nc), cubOpen: take(nc) });
  Object.assign(floor, { frQ: f[i], tillQ: f[i + 1], receipts: f[i + 2], inStore: f[i + 3] });
  return { homesVersion: f[1], clock: f[2], day: f[3], travellers, floor };
}

// ---- The app ---------------------------------------------------------------------

class App {
  constructor() {
    this.client = new SimClient();
    this.world = new WorldStore();
    this.tab = "market";
    this.header = null;
    this.geometry = null;
    this.plans = null;
    this.running = false;
    this.seasonOver = false;
    this.pendingFrame = null;
    this.ready = false;

    const panels = (id) => $(`#tab-${id}`);
    this.tabs = {
      setup: new SetupTab(panels("setup"), this),
      market: new MarketTab(panels("market"), this),
      strategy: new StrategyTab(panels("strategy"), this),
      offers: new OffersTab(panels("offers"), this),
      funnel: new FunnelTab(panels("funnel"), this),
      store: new StoreTab(panels("store"), this),
      assortment: new AssortmentTab(panels("assortment"), this),
      scorecard: new ScorecardTab(panels("scorecard"), this),
    };
    this.code = new CodeDrawer($("#code-drawer"), $("#btn-code"), $("#btn-code-close"), this.world);
    this.#wireHeader();
    this.#wireTabs();
    this.#wireClient();
    this.#renderLoop();
    this.world.addEventListener("change", () => this.#pendingBadge());
    new ResizeObserver(() => document.documentElement.style.setProperty("--header-h", `${$("#header").offsetHeight}px`)).observe($("#header"));
    // The world to open with: the one last set up, if it was kept.
    this.client.post("BOOT", { world: this.world.savedInstalled });
    window.fashion = this;       // for the browser console
  }

  // ---- Requests the tabs make -----------------------------------------------------

  // A live setting: R applies it now (to the thing with this id, if it's
  // installed) and says the value it took.
  async set(kind, name, value, extra = {}) {
    try {
      const out = await this.client.request("SET", { kind, name, value, ...extra });
      return Array.isArray(out) && out.length === 1 && !Array.isArray(value) ? out[0] : out;
    } catch (e) { this.error("A setting wasn't applied", e); return undefined; }
  }
  action(name, args = {}) {
    return this.client.request("ACTION", { name, args }).catch((e) => this.error("That didn't work", e));
  }
  view(partial) {
    return this.client.request("VIEW", partial).catch((e) => this.error("The view couldn't update", e));
  }
  async exportCsv() {
    const csv = await this.client.request("EXPORT");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `fashion-market-season-day-${this.header?.days_done ?? 0}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // Setup: a new season, in the draft world when it holds changes that
  // wait for Setup. If R finds problems, it isn't installed: the Setup tab
  // lists them and the season goes on.
  async setupSeason() {
    const pending = this.world.pending;
    let result;
    try {
      result = await this.client.request("SETUP", pending ? { world: this.world.text() } : {});
    } catch (e) { this.error("Setup failed", e); return; }
    if (result?.ok === false) {
      this.tabs.setup.showProblems(result.problems, "Setup didn't start this world. Until these are fixed, the season goes on in the world set up before.");
      this.selectTab("setup");
      return;
    }
    this.tabs.setup.showProblems([]);
  }

  // Clicking a store anywhere opens its floor, drawn: from the fastest
  // speed it drops to the last watching one.
  openStore(id) {
    this.tabs.store.select(id);
    this.selectTab("store");
    if (this.header && this.header.pace !== "watch") this.setSpeed(String(this.header.watch_speed));
  }

  // A household on the Market tab's card.
  openHousehold(h) {
    this.action("pick_household", { household: h });
    this.selectTab("market");
  }

  // Speed: store seconds per second of screen (the model's watch pace), or
  // "day", a market day per tick without drawing (its season pace).
  async setSpeed(v) {
    $("#speed").value = v;
    if (v !== "day") await this.set("market", "watch_speed", Number(v));
    await this.set("market", "pace", v === "day" ? "season" : "watch");
  }

  selectTab(id) {
    if (!this.tabs[id]) return;
    this.tab = id;
    for (const btn of document.querySelectorAll(".tab")) {
      const on = btn.id === `tab-btn-${id}`;
      btn.setAttribute("aria-selected", String(on));
      btn.tabIndex = on ? 0 : -1;
      $(`#${btn.getAttribute("aria-controls")}`).hidden = !on;
    }
    history.replaceState(null, "", `#${id}`);
    this.tabs[id].onShow?.();
    this.view({ tab: id, ...(this.tabs[id].viewState?.() ?? {}) });
  }

  error(title, err) {
    const message = err?.message ?? String(err);
    console.error(`[fashion] ${title}: ${message}`);
    this.banner(title, message, true);
  }

  banner(title, message, isError = false) {
    $(".banner")?.remove();
    const box = el("div", { class: `banner${isError ? "" : " info"}`, role: isError ? "alert" : "status" }, el("b", { text: title }), message ? el("pre", { text: message }) : null);
    box.addEventListener("click", () => box.remove());
    document.body.append(box);
    setTimeout(() => box.remove(), 12000);
  }

  // Names and colours of the installed world, for every tab.
  get brands() { return this.geometry?.brands ?? []; }
  get stores() { return this.geometry?.stores ?? []; }
  get areas() { return this.geometry?.areas ?? []; }
  get categories() { return this.geometry?.categories ?? []; }
  brandName(b) { return this.brands[b - 1]?.name ?? `Brand ${b}`; }
  // Brands in the order legends list them: our family first, then each family.
  get brandOrder() {
    const fams = this.geometry?.families ?? [];
    const rank = (b) => (b.ours ? -1 : b.family);
    return this.brands.map((b, i) => ({ ...b, index: i + 1, familyName: fams[b.family - 1]?.name ?? "" }))
      .sort((a, b) => rank(a) - rank(b) || a.index - b.index);
  }
  get oursName() { return (this.geometry?.families ?? []).find((f) => f.ours)?.name ?? "Ours"; }

  // ---- Wiring ----------------------------------------------------------------------

  #wireHeader() {
    this.runButton = $("#btn-run");
    this.runButton.addEventListener("click", () => this.toggleRun());
    $("#btn-step").addEventListener("click", () => this.client.request("STEP").catch((e) => this.error("Step failed", e)));
    $("#btn-setup").addEventListener("click", () => this.setupSeason());
    $("#speed").addEventListener("change", (ev) => this.setSpeed(ev.target.value));
  }

  toggleRun() {
    if (this.seasonOver) return;
    this.client.request(this.running ? "PAUSE" : "RUN").catch((e) => this.error("Run failed", e));
  }

  #wireTabs() {
    const buttons = [...document.querySelectorAll(".tab")];
    buttons.forEach((btn, i) => {
      btn.addEventListener("click", () => this.selectTab(btn.id.replace("tab-btn-", "")));
      btn.addEventListener("keydown", (ev) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
        if (!step) return;
        ev.preventDefault();
        const next = buttons[(i + step + buttons.length) % buttons.length];
        next.focus(); next.click();
      });
    });
    const initial = location.hash.slice(1);
    if (this.tabs[initial]) this.selectTab(initial);
  }

  #wireClient() {
    const c = this.client;
    c.addEventListener("STEP", ({ detail }) => this.#loadingStep(detail));
    c.addEventListener("SCHEMA", ({ detail }) => {
      this.world.schema = JSON.parse(detail.json);
      this.tabs.setup.onSchema?.(this.world.schema);
    });
    c.addEventListener("READY", ({ detail }) => {
      console.info(`[fashion] ready: NetLogoR ${detail.netlogor}; timings ms ${JSON.stringify(detail.timings)}`);
      this.ready = true;
      for (const id of ["#btn-setup", "#btn-run", "#btn-step"]) $(id).disabled = false;
      $("#loading").hidden = true;
      if (detail.fellBack) this.banner("The world set up last time couldn't be installed", "The default world is running. Your draft is on the Setup tab.");
      this.view({ tab: this.tab, ...(this.tabs[this.tab].viewState?.() ?? {}) });
    });
    c.addEventListener("ERROR", ({ detail }) => {
      this.error(detail.stage === "run" ? "The simulation stopped with an error" : `The simulation failed while ${detail.stage}`, new Error(detail.message));
      for (const li of document.querySelectorAll(".loading-steps li[data-state=active]")) li.dataset.state = "error";
    });
    c.addEventListener("GEOMETRY", async ({ detail }) => {
      this.geometry = JSON.parse(detail.city);
      this.plans = JSON.parse(detail.plans);
      this.#worldColours();
      await this.world.upgradeSaved((text) => this.client.request("CHECK_WORLD", { text }), this.world.schema?.world_version);
      this.world.setInstalled(detail.world);
      for (const tab of Object.values(this.tabs)) tab.onGeometry?.(this.geometry, detail.homes, this.plans);
      this.#intro();
      // Each tab's view may point past the new world's brands and stores.
      this.view({ tab: this.tab, ...(this.tabs[this.tab].viewState?.() ?? {}) });
    });
    c.addEventListener("HOMES", ({ detail }) => {
      for (const tab of Object.values(this.tabs)) tab.onHomes?.(detail.codes, detail.mode, detail.brand);
    });
    c.addEventListener("FRAME", ({ detail }) => {
      if (this.pendingFrame) this.client.ack();          // replaced before it was painted
      this.pendingFrame = detail.buffer;
    });
    c.addEventListener("HEADER", ({ detail }) => this.#header(JSON.parse(detail.json)));
    c.addEventListener("REPORT", ({ detail }) => {
      const tab = this.tabs[detail.tab];
      try { tab?.update(JSON.parse(detail.json)); } catch (err) { this.error(`The ${detail.tab} tab couldn't draw`, err); }
    });
    c.addEventListener("RUN_STATE", ({ detail }) => {
      this.running = detail.running;
      if (detail.seasonOver !== undefined) this.seasonOver = detail.seasonOver;
      this.#runButton();
    });
  }

  // Brand, category and segment colours are the world's, in light and dark themes.
  #worldColours() {
    const root = document.documentElement.style;
    for (let i = 1; i <= 40; i++) { root.removeProperty(`--brand-${i}`); root.removeProperty(`--cat-${i}`); }
    this.brands.forEach((b, i) => root.setProperty(`--brand-${i + 1}`, b.colour));
    this.categories.forEach((c, i) => root.setProperty(`--cat-${i + 1}`, c.colour));
    const ours = this.brands.find((b) => b.ours);
    if (ours) root.setProperty("--ours", ours.colour);
    (this.geometry.segments ?? []).forEach((s, i) => root.setProperty(`--seg-${i + 1}`, s.colour));
  }

  #intro() {
    const g = this.geometry;
    $("#loading-sub").textContent = "";
    const m = document.querySelector('meta[name="description"]');
    if (m) m.content = `A season of fashion retail: ${g.brands.length} brands, ${g.stores.length} stores, ${fmt.int(g.homes.n)} households, as an agent-based model in R running in the browser.`;
  }

  #pendingBadge() {
    const n = this.world.pending;
    const b = $("#btn-setup");
    b.classList.toggle("has-changes", n > 0);
    b.title = n ? `Start the season in the world on the Setup tab (${n} change${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""} for Setup)` : "Start the season from the settings on the Setup tab";
    $("#setup-changes").textContent = n ? String(n) : "";
    $("#setup-changes").hidden = !n;
  }

  #runButton() {
    const b = this.runButton;
    b.textContent = this.seasonOver ? "Season over" : this.running ? "Pause" : "Go";
    b.disabled = !this.ready || this.seasonOver;
    b.setAttribute("aria-pressed", String(this.running));
  }

  #renderLoop() {
    const tick = () => {
      requestAnimationFrame(tick);
      if (!this.pendingFrame) return;
      const frame = parseFrame(this.pendingFrame);
      this.pendingFrame = null;
      this.tabs.market.onFrame?.(frame);
      if (this.tab === "store") this.tabs.store.onFrame?.(frame);
      this.client.ack();
    };
    requestAnimationFrame(tick);
  }

  #header(h) {
    this.header = h;
    const speed = $("#speed");
    if (document.activeElement !== speed) speed.value = h.pace === "watch" ? String(h.watch_speed) : "day";
    const clock = h.pace === "watch" || h.clock_s > 0 ? h.clock : "";
    const t = $("#clock-text");
    t.replaceChildren(`Week ${Math.min(h.season_weeks, h.week)} · ${h.dow} `, el("span", { text: h.season_over ? "season over" : clock || "day " + h.day }));
    const frac = (h.days_done + (h.pace === "watch" ? Math.min(1, h.clock_s / 36000) : 0)) / h.season_days;
    $("#season-bar").style.width = `${(100 * Math.min(1, frac)).toFixed(1)}%`;
    const tiles = $("#headline");
    tiles.querySelector('[data-k="share"]').textContent = fmt.pct(h.share, 1);
    tiles.querySelector('[data-k="sales"]').textContent = fmt.money(h.sales);
    tiles.querySelector('[data-k="conversion"]').textContent = fmt.pct(h.conversion, 1);
    tiles.querySelector('[data-k="people"]').textContent = h.pace === "watch" ? `${fmt.int(h.in_stores)} · ${fmt.int(h.on_road)}` : "— · —";
    if (h.season_over !== this.seasonOver) { this.seasonOver = h.season_over; }
    this.#runButton();
  }

  #loadingStep({ step, state, loaded, total }) {
    const li = document.querySelector(`.loading-steps [data-step="${step}"]`);
    if (!li) return;
    li.dataset.state = state;
    if (step === "library" && total) li.querySelector("[data-bytes]").textContent = `${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
    const weights = { runtime: 0.35, library: 0.3, netlogor: 0.1, model: 0.25 };
    let p = 0;
    for (const item of document.querySelectorAll(".loading-steps li")) {
      if (item.dataset.state === "done") p += weights[item.dataset.step];
      else if (item.dataset.step === "library" && total && step === "library") p += weights.library * (loaded / total);
    }
    $("#loading-bar").style.setProperty("--p", p.toFixed(3));
  }
}

new App();
