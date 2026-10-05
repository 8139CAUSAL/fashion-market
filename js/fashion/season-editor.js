// The Setup tab's Season section: the season's demand
// events, days whose demand is lifted or suppressed. Each event is solid
// (its strength on each of its days: days 3 and 23 at 1.3, demand ×1.3) or
// a ramp (on each of its days, a walk over its ramp days from where it
// starts to its strength: day 90 at -2 over 7 days from -1.4 walks -1.4,
// -1.5 … -2 on days 84 to 90). A strength is a signed fold change: 1.3 is
// ×1.3, -2 is ÷2, and 1 and -1 are no change.
//
// Above the list, every day's effect on demand, as the events add up
// (demand-events.js); below it, the selected event edited in a panel that
// says in a line what it does. Events change the world and wait for Setup;
// the model checks them as they're edited (the same check Setup runs), and
// the problems show here. The Strategy tab's forecast takes them as known
// for every day of the season.

import { el, card, segmented, textField, numberField } from "./ui.js";
import { newId, newName } from "./world-store.js";
import { BarChart } from "./charts.js";
import { demandMultipliers, eventText, parseDays, foldMultiplier, dayName } from "./demand-events.js";

const SHAPES = [{ value: "solid", label: "Solid days" }, { value: "ramp", label: "Ramp up to a day" }];

export class DemandEventEditor {
  constructor(app) {
    this.app = app; this.world = app.world;
    this.selected = null; this.problems = []; this.checkTimer = 0; this.checkSeq = 0;
    this.root = el("div", { class: "grid" });
  }

  get draft() { return this.world.draft; }
  get events() { return this.draft?.demand_events ?? []; }

  // The card, built afresh; then the model's check.
  show() {
    if (!this.draft || !this.world.schema) return this.root;
    this.#render();
    this.#scheduleCheck(0);
    return this.root;
  }

  // A problem's place: the event.
  goTo(path) {
    const m = path.match(/^demand_events\[(\d+)\]/);
    this.selected = m ? Number(m[1]) - 1 : this.selected;
  }

  #render() {
    const limit = this.world.schema.limits.demand_events ?? 40;
    const c = card("Demand events", { sub: "days whose demand is lifted or suppressed · strength 1.3 is demand ×1.3, -2 is demand ÷2", right: el("span", { class: "tag", text: "at Setup" }) });
    const add = el("button", { type: "button", class: "btn small", text: "Add event", disabled: this.events.length >= limit || null, onclick: () => this.#add() });
    this.problemsBox = el("div", { class: "range-problems" });
    const chartBox = el("div");
    this.chart = new BarChart(chartBox, { height: 150, format: (v) => `${Math.round(100 * v)}%`, catWidth: 34,
      catFormat: (c, i, tip) => (tip ? dayName(c) : String(c)), tipFormat: (v) => `${v >= 0 ? "+" : "−"}${Math.abs(100 * v).toFixed(1)}% (×${(1 + v).toFixed(2)})`,
      emptyText: "No demand events: every day runs at the demand the model sets." });
    this.listBox = el("div", { class: "table-scroll" });
    this.editorBox = el("div", { class: "entry-editor" });
    c.body.append(el("div", { class: "row" }, add), this.problemsBox,
      el("h3", { class: "setup-heading", text: "Each day's demand, as the events add up" }), chartBox,
      el("div", { class: "calendar-layout" }, this.listBox, this.editorBox),
      el("p", { class: "note", text: "Demand is each household's daily chance of going clothes shopping (in a store or online). An event multiplies it on its days, on top of the weekday, the point in the season, budgets, promotions and offers; where events overlap, their multipliers multiply. A solid event puts its strength on each of its days. A ramp walks, in equal steps, from where it starts (on the first of its ramp days) to its strength (on its day); a start of 1 or -1 walks from no change. Day 1 is a Monday." }));
    this.root.replaceChildren(c.root);
    this.#drawChart();
    this.#renderList();
    this.#renderEntry();
    this.#showProblems();
  }

  #edit(fn, { list = true, panel = false } = {}) {
    this.world.edit(fn);
    this.#scheduleCheck();
    this.#drawChart();
    if (list) this.#renderList();
    if (panel) this.#renderEntry();
  }

  // A new event: solid, on day 1, demand ×1.3; as a ramp, 7 days from no change.
  #add() {
    const list = this.draft.demand_events;
    const name = newName(list, "New event");
    this.world.edit(() => { list.push({ id: newId(list, name), name, shape: "solid", days: [1], strength: 1.3, ramp_days: 7, from: 1 }); });
    this.selected = list.length - 1;
    this.#scheduleCheck();
    this.#render();
  }

  // Every day's change in demand: lifts up, suppressions down.
  #drawChart() {
    const n = this.draft.season_days;
    const m = demandMultipliers(this.events.filter((e) => Array.isArray(e.days) && Number.isFinite(e.strength) && Number.isFinite(e.from) && e.ramp_days >= 1), n);
    if (m.every((x) => x === 1)) { this.chart.update(null); return; }
    const days = m.map((_, i) => i + 1);
    this.chart.update({ categories: days, series: [{ name: "Demand", colours: m.map((x) => (x >= 1 ? "var(--good)" : "var(--critical)")), values: m.map((x) => x - 1) }] });
  }

  #renderList() {
    if (!this.events.length) { this.listBox.replaceChildren(el("p", { class: "empty", text: "No demand events. Add one to lift or suppress the season's demand on chosen days." })); return; }
    const bad = new Set(this.problems.map((p) => p.path.match(/^demand_events\[(\d+)\]/)).filter(Boolean).map((m) => Number(m[1]) - 1));
    const rows = this.events.map((e, i) => el("tr", { class: `clickable${i === this.selected ? " is-on" : ""}`, onclick: () => { this.selected = i; this.#renderList(); this.#renderEntry(); } },
      el("td", { class: bad.has(i) ? "bad" : "", text: e.name }),
      el("td", { text: e.shape === "ramp" ? `Ramp, ${e.ramp_days} days` : "Solid" }),
      el("td", { text: (e.days ?? []).join(", ") }),
      el("td", { class: "num", text: e.shape === "ramp" ? `${e.from} → ${e.strength}` : String(e.strength) }),
      el("td", { class: "num", text: Number.isFinite(e.strength) ? `×${foldMultiplier(e.strength).toFixed(2)}` : "—" })));
    this.listBox.replaceChildren(el("table", { class: "data" },
      el("thead", {}, el("tr", {}, el("th", { text: "Event" }), el("th", { text: "Shape" }), el("th", { text: "Days" }), el("th", { class: "num", text: "Strength" }), el("th", { class: "num", text: "Demand on its day" }))),
      el("tbody", {}, ...rows)));
  }

  // The selected event, in the panel beside the list.
  #renderEntry() {
    const box = this.editorBox;
    const e = this.events[this.selected ?? -1];
    if (!e) { box.replaceChildren(el("p", { class: "empty", text: this.events.length ? "Click an event to edit it, or add one." : "Add an event to edit it here." })); return; }
    const F = this.world.schema.fields.demand_event;
    const n = this.draft.season_days;
    const line = el("p", { class: "entry-line" });
    const daysBad = el("div", { class: "bad" });
    const say = () => { line.textContent = eventText(e); };
    const edit = (fn, panel = false) => { this.#edit(fn, { panel }); if (!panel) say(); };
    const ramp = e.shape === "ramp";
    const shape = segmented({ label: "Shape", value: e.shape, options: SHAPES, onChange: (v) => edit(() => { e.shape = v; }, true) });
    const days = textField({ label: ramp ? `The day it reaches its strength (or days, e.g. 90), 1 to ${n}` : `Days (e.g. 3, 23), 1 to ${n}`, value: (e.days ?? []).join(", "), maxLength: 800,
      onChange: (v) => {
        const r = parseDays(v);
        if (r.bad !== undefined) { daysBad.textContent = `"${r.bad}" isn't a day: type whole numbers, separated by commas.`; return; }
        daysBad.textContent = "";
        edit(() => { e.days = r.days; });
        days.set(r.days.join(", "));
      } });
    const strength = numberField({ label: F.strength.label, value: e.strength, min: F.strength.min, max: F.strength.max, step: F.strength.step, onChange: (v) => edit(() => { e.strength = v; }) });
    const parts = [el("div", { class: "entry-kind", text: "Demand event" }),
      textField({ label: "Name", value: e.name, maxLength: 60, onChange: (v) => edit(() => { e.name = v; }) }).root,
      shape.root, days.root, daysBad, strength.root];
    if (ramp) {
      parts.push(el("div", { class: "two" },
        numberField({ label: F.ramp_days.label, value: e.ramp_days, min: F.ramp_days.min, max: Math.min(F.ramp_days.max, n), step: 1, onChange: (v) => edit(() => { e.ramp_days = Math.round(v); }) }).root,
        numberField({ label: F.from.label, value: e.from, min: F.from.min, max: F.from.max, step: F.from.step, onChange: (v) => edit(() => { e.from = v; }) }).root));
    }
    const del = el("button", { type: "button", class: "btn small danger", text: "Remove this event", onclick: () => {
      const i = this.selected; this.selected = null;
      this.#edit(() => { this.draft.demand_events.splice(i, 1); }, { panel: true });
    } });
    const mine = this.problems.filter((p) => p.path.startsWith(`demand_events[${this.selected + 1}]`));
    say();
    parts.push(line, ...mine.map((p) => el("div", { class: "bad", text: p.message })), el("div", { class: "row" }, del));
    box.replaceChildren(...parts);
  }

  // ---- The model's check --------------------------------------------------------------------

  #scheduleCheck(ms = 500) {
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => this.#check(), ms);
  }

  async #check() {
    if (!this.app.ready) { this.#scheduleCheck(800); return; }
    if (this.root.closest("[hidden]") || !this.root.isConnected) return;
    const seq = ++this.checkSeq;
    let r;
    try { r = await this.app.client.request("CHECK_WORLD", { text: this.world.text() }); } catch { return; }
    if (seq !== this.checkSeq) return;
    // The panel is drawn again only if its own problems changed, so a field
    // being typed in keeps its focus.
    const mine = (ps) => JSON.stringify(ps.filter((p) => p.path.startsWith(`demand_events[${(this.selected ?? -1) + 1}]`)).map((p) => p.message));
    const before = mine(this.problems);
    this.problems = (r.problems ?? []).filter((p) => p.path.startsWith("demand_events"));
    this.#showProblems();
    this.#renderList();
    if (mine(this.problems) !== before) this.#renderEntry();
  }

  #showProblems() {
    const box = this.problemsBox; if (!box) return;
    box.replaceChildren(this.problems.length
      ? el("div", { class: "problems" }, el("b", { text: `${this.problems.length} problem${this.problems.length === 1 ? "" : "s"} with the demand events: Setup won't start this world until they're fixed` }),
        ...this.problems.map((p) => el("button", { type: "button", class: "problem", onclick: () => { this.goTo(p.path); this.#renderList(); this.#renderEntry(); } },
          el("code", { text: p.path }), ` ${p.message}`)))
      : el("div", { class: "ok-line", text: this.events.length ? `No problems: the model can run ${this.events.length === 1 ? "this event" : `these ${this.events.length} events`}.` : "" }));
  }
}
