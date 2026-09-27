// The Setup tab's "Offers": for the brand chosen, its offers, named coupons
// on its calendar (an email, a direct mailing, whatever the brand calls
// them). Each is drawn as a bar over the days it runs and edited in a panel
// beside the calendar that says in a line what it does: its coupon, what
// sending one costs, the share of the households it reaches that it's sent
// to (drawn at random on its first day), and the share of those held out.
//
// Offers change the world and wait for Setup; the model checks them as
// they're edited (the same check Setup runs), and the problems show here,
// red on the calendar. The Offers tab measures each against its holdout.

import { el, fmt, card, select, textField, numberField, checkbox, settingLever } from "./ui.js";
import { newId, newName } from "./world-store.js";
import { drawCalendar } from "./calendar-chart.js";
import { offerText, possessive } from "./entry-text.js";

export class OfferEditor {
  constructor(root, app) {
    this.app = app; this.world = app.world; this.root = root;
    this.brand = null; this.selected = null; this.problems = []; this.checkTimer = 0; this.checkSeq = 0;
  }

  get draft() { return this.world.draft; }
  get b() { return this.draft?.brands.find((x) => x.id === this.brand); }
  get brandIndex() { return this.draft.brands.findIndex((x) => x.id === this.brand); }

  show() {
    const d = this.draft;
    if (!d || !this.world.schema) return;
    if (!d.brands.some((x) => x.id === this.brand)) this.brand = d.brands.find((x) => d.families.find((f) => f.id === x.family)?.ours)?.id ?? d.brands[0]?.id;
    this.#render();
    this.#scheduleCheck(0);
  }

  // A problem's place: the brand and the offer.
  goTo(path) {
    const m = path.match(/^brands\[(\d+)\]/);
    if (m) this.brand = this.draft.brands[Number(m[1]) - 1]?.id ?? this.brand;
    const e = path.match(/calendar\.offers\[(\d+)\]/);
    this.selected = e ? Number(e[1]) - 1 : null;
  }

  #render() {
    const b = this.b; if (!b) return;
    const d = this.draft;
    const brandSel = select({ label: "Brand", value: this.brand, onChange: (v) => { this.brand = v; this.selected = null; this.#render(); this.#scheduleCheck(0); },
      options: d.families.filter((f) => d.brands.some((x) => x.family === f.id))
        .map((f) => ({ group: f.name, options: d.brands.filter((x) => x.family === f.id).map((x) => ({ value: x.id, label: x.name })) })) });
    this.problemsBox = el("div", { class: "range-problems" });
    const c = card(`${possessive(b.name)} offers`, { sub: "named coupons on its calendar, each sent to a random share of the households it reaches, some held out", right: el("span", { class: "tag", text: "at Setup" }) });
    const add = el("button", { type: "button", class: "btn small", text: "Add offer", disabled: b.calendar.offers.length >= (this.world.schema.limits.offers ?? 40) || null, onclick: () => this.#add() });
    this.gantt = el("div", { class: "calendar-box" });
    this.editorBox = el("div", { class: "entry-editor" });
    c.body.append(el("div", { class: "row" }, add), el("div", { class: "calendar-layout" }, this.gantt, this.editorBox),
      el("p", { class: "note", text: `On an offer's first morning, its audience is drawn at random from the households it reaches (their tier with ${b.name} that day, where they live), and a random share of it is held out: sent nothing, so the Offers tab can measure what the coupon added. The rest are sent it, at a cost each; it's good for one purchase until the offer's last day. A household holding coupons from two offers uses the deeper.` }));
    this.root.replaceChildren(el("div", { class: "filters" }, brandSel.root), this.problemsBox, el("div", { class: "grid range-grid" }, c.root));
    requestAnimationFrame(() => this.#drawGantt());
    this.#renderEntry();
    this.#showProblems();
  }

  #edit(fn, rerender = false) {
    this.world.edit(fn);
    this.#scheduleCheck();
    if (rerender) this.#render(); else this.#drawGantt();
  }

  // A new offer: two weeks from day 1 (or the season, if shorter), to a
  // fifth of every tier, everywhere, a tenth held out.
  #add() {
    const b = this.b; const list = b.calendar.offers;
    const name = newName(list, "New offer");
    this.#edit(() => {
      list.push({ id: newId(list, name), name, from: 1, to: Math.min(14, this.draft.season_days), depth: 0.15, send_cost: 0.05, audience: 0.2, holdout: 0.1,
        tiers: b.loyalty.tiers.map((t) => t.id), areas: [], also_at: [] });
    });
    this.selected = list.length - 1;
    this.#render();
  }

  // One row per offer, its bar over the days it runs.
  #drawGantt() {
    const b = this.b; if (!b || !this.gantt) return;
    const d = this.draft;
    if (!b.calendar.offers.length) { this.gantt.replaceChildren(el("p", { class: "empty", text: `${b.name} sends no offers. Add one to put it on the calendar.` })); return; }
    const bad = new Set(this.problems.map((p) => p.path.match(/calendar\.offers\[(\d+)\]/)).filter(Boolean).map((m) => Number(m[1]) - 1));
    const rows = b.calendar.offers.map((e, i) => ({ label: e.name, colour: b.colour, bars: Number.isInteger(e.from) && Number.isInteger(e.to) && e.from <= e.to
      ? [{ key: i, name: e.name, from: e.from, to: e.to, depth: e.depth, colour: b.colour, bad: bad.has(i), note: offerText(e, b, d) }] : [] }));
    drawCalendar(this.gantt, { days: d.season_days, rows, selected: this.selected, onSelect: (k) => { this.selected = k; this.#drawGantt(); this.#renderEntry(); } });
  }

  // The selected offer, in the panel beside the calendar.
  #renderEntry() {
    const b = this.b; const box = this.editorBox; if (!b || !box) return;
    const e = b.calendar.offers[this.selected ?? -1];
    if (!e) { box.replaceChildren(el("p", { class: "empty", text: b.calendar.offers.length ? "Click an offer to edit it, or add one." : "Add an offer to edit it here." })); return; }
    const d = this.draft; const F = this.world.schema.fields.offer;
    const line = el("p", { class: "entry-line" });
    const count = el("p", { class: "note" });
    const say = () => { line.textContent = offerText(e, b, d); count.textContent = this.#estimate(e, b); };
    const edit = (fn, panel = false) => { this.#edit(fn); if (panel) this.#renderEntry(); else say(); };
    const day = (k, label) => numberField({ label, value: e[k], min: 1, max: d.season_days, onChange: (v) => edit(() => { e[k] = Math.round(v); }) }).root;
    const lev = (k, label) => settingLever(F[k], { label, value: e[k], onChange: (v) => edit(() => { e[k] = v; }) }).root;
    const parts = [el("div", { class: "entry-kind", text: "Offer" }),
      textField({ label: "Name", value: e.name, maxLength: 60, onChange: (v) => edit(() => { e.name = v; }) }).root,
      el("div", { class: "two" }, day("from", "First day (sent)"), day("to", "Last day (good until)")),
      lev("depth"),
      numberField({ label: F.send_cost.label, value: e.send_cost, min: F.send_cost.min, max: F.send_cost.max, step: F.send_cost.step, onChange: (v) => edit(() => { e.send_cost = v; }) }).root,
      lev("audience", "Audience: of the households it reaches, drawn at random"), lev("holdout", "Held out: of the audience, sent nothing")];
    parts.push(el("h3", { class: "setup-heading", text: `Who it reaches (their tier with ${b.name})` }),
      el("div", { class: "checks" }, ...b.loyalty.tiers.map((t) => checkbox({ label: t.name, checked: e.tiers.includes(t.id), onChange: (v) => edit(() => {
        e.tiers = b.loyalty.tiers.map((x) => x.id).filter((id) => (id === t.id ? v : e.tiers.includes(id)));
      }) }).root)));
    const areas = d.macro.areas ?? [];
    const every = checkbox({ label: "Every area", checked: !e.areas.length, onChange: (v) => edit(() => { e.areas = v ? [] : areas.slice(0, 1).map((a) => a.id); }, true) });
    parts.push(el("h3", { class: "setup-heading", text: "Where" }), el("div", { class: "checks" }, every.root,
      ...(e.areas.length ? areas.map((a) => checkbox({ label: a.name, checked: e.areas.includes(a.id), onChange: (v) => edit(() => {
        e.areas = areas.map((x) => x.id).filter((id) => (id === a.id ? v : e.areas.includes(id)));
      }) }).root) : [])));
    const others = d.families.flatMap((f) => d.brands.filter((x) => x.family === f.id)).filter((x) => x.id !== b.id);
    parts.push(el("h3", { class: "setup-heading", text: `Also good at (besides ${b.name})` }), el("div", { class: "checks" }, ...others.map((x) => checkbox({ label: x.name, checked: e.also_at.includes(x.id), onChange: (v) => edit(() => {
      e.also_at = others.map((y) => y.id).filter((id) => (id === x.id ? v : e.also_at.includes(id)));
    }) }).root)));
    const del = el("button", { type: "button", class: "btn small danger", text: "Remove this offer", onclick: () => {
      const i = this.selected; this.selected = null;
      this.#edit(() => { b.calendar.offers.splice(i, 1); }, true);
    } });
    const mine = this.problems.filter((p) => p.path.startsWith(`brands[${this.brandIndex + 1}].calendar.offers[${this.selected + 1}]`));
    say();
    parts.push(line, count, ...mine.map((p) => el("div", { class: "bad", text: p.message })), el("div", { class: "row" }, del));
    box.replaceChildren(...parts);
  }

  // How many households that is, roughly: of the map's households, the
  // tiers' starting shares (tiers move during the season, and areas hold
  // their own shares of the map, so only an offer to every area is counted).
  #estimate(e, b) {
    if (e.areas.length) return "";
    const n = (this.draft.macro.households ?? 0) * b.loyalty.tiers.filter((t) => e.tiers.includes(t.id)).reduce((a, t) => a + t.share, 0) * e.audience;
    const held = Math.round(n * e.holdout);
    const sent = Math.round(n) - held;
    return `About ${fmt.int(Math.round(n))} households, at the tiers' starting shares: ${fmt.int(sent)} sent the coupon (${fmt.money(sent * e.send_cost)}), ${fmt.int(held)} held out.`;
  }

  // ---- The model's check --------------------------------------------------------------------

  #scheduleCheck(ms = 500) {
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => this.#check(), ms);
  }

  async #check() {
    if (!this.app.ready) { this.#scheduleCheck(800); return; }
    if (this.root.closest("[hidden]")) return;
    const seq = ++this.checkSeq;
    let r;
    try { r = await this.app.client.request("CHECK_WORLD", { text: this.world.text() }); } catch { return; }
    if (seq !== this.checkSeq || !this.b) return;
    this.problems = (r.problems ?? []).filter((p) => p.path.startsWith(`brands[${this.brandIndex + 1}].calendar.offers`));
    this.#showProblems();
    this.#drawGantt();
    this.#renderEntry();
  }

  #showProblems() {
    const box = this.problemsBox; if (!box) return;
    box.replaceChildren(this.problems.length
      ? el("div", { class: "problems" }, el("b", { text: `${this.problems.length} problem${this.problems.length === 1 ? "" : "s"} with ${possessive(this.b.name)} offers: Setup won't start this world until they're fixed` }),
        ...this.problems.map((p) => el("button", { type: "button", class: "problem", onclick: () => { this.goTo(p.path); this.#drawGantt(); this.#renderEntry(); } },
          el("code", { text: p.path }), ` ${p.message}`)))
      : el("div", { class: "ok-line", text: "No problems: the model can run these offers." }));
  }
}
