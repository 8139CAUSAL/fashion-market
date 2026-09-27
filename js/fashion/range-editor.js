// The Setup tab's "Range and calendar": for the brand chosen, its products
// (in the world's categories: name, category, list price, cost, the day it
// lands), its calendar (promotions, replenishment and markdowns over the
// season's days, drawn as a Gantt, edited in a panel beside it that says in
// a line what the entry does) and its price rules. Its offers, also on its
// calendar, are the Offers section's (offer-editor.js).
//
// The range and the calendar change the world, and wait for Setup; the
// model checks them as they're edited (the same check Setup runs), and the
// problems show here, red on the calendar. The price rules are live.
//
// A brand sells the categories it has products in, and its plan (Brands,
// Stock) has units a week for those and no others: a category it stops
// selling leaves its plan; one it starts selling needs a number there,
// which the check asks for.

import { el, fmt, card, select, segmented, textField, numberField, checkbox, settingLever } from "./ui.js";
import { clone, newId, newName } from "./world-store.js";
import { drawCalendar } from "./calendar-chart.js";
import { WEEKDAYS, weekdayOf, entryDays, onText, replenishmentText, markdownText, possessive, reachText } from "./entry-text.js";

const LIVE = el("span", { class: "tag live", text: "live" });
const WAITS = el("span", { class: "tag", text: "at Setup" });
const tag = (live) => (live ? LIVE : WAITS).cloneNode(true);
const ON = [{ value: "range", label: "Whole range" }, { value: "categories", label: "Categories" }, { value: "products", label: "Products" }];
// An entry's kind, and its list in a brand's calendar.
const LISTS = { promotion: "promotions", markdown: "markdowns", replenishment: "replenishment" };
const KIND_OF = { promotions: "promotion", markdowns: "markdown", replenishment: "replenishment" };
// A markdown on the Gantt: its depth, or its step and how deep it goes.
const markdownLabel = (e) => (e.mode === "to" ? fmt.pct(e.depth) : `+${Math.round(100 * e.depth)} pts to ${fmt.pct(e.max)}`);

export class RangeEditor {
  // `goTo(problem)`: where the Setup tab shows a problem that isn't the
  // range's or the calendar's (a store's racks, the brand's plan).
  constructor(root, app, { goTo } = {}) {
    this.app = app; this.world = app.world; this.root = root; this.goToElsewhere = goTo;
    this.brand = null; this.selected = null; this.problems = []; this.checkTimer = 0; this.checkSeq = 0; this.pasting = false;
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

  // A problem's place: the brand and, on its calendar, the entry.
  goTo(path) {
    const m = path.match(/^brands\[(\d+)\]/);
    if (m) this.brand = this.draft.brands[Number(m[1]) - 1]?.id ?? this.brand;
    const e = path.match(/calendar\.(promotions|markdowns|replenishment)\[(\d+)\]/);
    this.selected = e ? { kind: KIND_OF[e[1]], i: Number(e[2]) - 1 } : null;
  }

  #render() {
    const b = this.b; if (!b) return;
    const brandSel = select({ label: "Brand", value: this.brand, options: this.#brandOptions(), onChange: (v) => { this.brand = v; this.selected = null; this.#render(); this.#scheduleCheck(0); } });
    this.problemsBox = el("div", { class: "range-problems" });
    this.root.replaceChildren(el("div", { class: "filters" }, brandSel.root),
      this.problemsBox,
      el("div", { class: "grid range-grid" }, this.#productsCard(b), this.#calendarCard(b), this.#rulesCard(b)));
    this.#showProblems();
  }

  #brandOptions() {
    const d = this.draft;
    return d.families.filter((f) => d.brands.some((x) => x.family === f.id)).map((f) => ({ group: f.name, options: d.brands.filter((x) => x.family === f.id).map((x) => ({ value: x.id, label: x.name })) }));
  }

  // An edit to the range or the calendar: the draft changes, the model
  // checks it again.
  #edit(fn, rerender = true) {
    this.world.edit(() => { fn(); if (this.b) keepPlanToRange(this.b); });
    if (rerender) this.#render();
    this.#scheduleCheck();
  }

  // ---- Products ------------------------------------------------------------------------------

  #productsCard(b) {
    const d = this.draft; const F = this.world.schema.fields.product; const cats = d.categories;
    const sells = new Set(b.range.map((p) => p.category));
    const c = card(`${possessive(b.name)} range`, { sub: `${b.range.length} product${b.range.length === 1 ? "" : "s"} in ${sells.size} categor${sells.size === 1 ? "y" : "ies"}`, right: tag(false) });
    const catOptions = cats.map((x) => ({ value: x.id, label: x.name }));
    const rows = [];
    for (const cat of cats) {
      const mine = b.range.filter((p) => p.category === cat.id);
      if (!mine.length) continue;
      rows.push(el("tr", { class: "group-row" }, el("td", { colspan: 6 }, el("i", { class: "legend-swatch", vars: { "--c": cat.colour } }), `${cat.name} · ${mine.length}`)));
      for (const p of mine) rows.push(this.#productRow(b, p, catOptions, F));
    }
    const orphans = b.range.filter((p) => !cats.some((x) => x.id === p.category));
    for (const p of orphans) rows.push(this.#productRow(b, p, catOptions, F));
    const table = el("table", { class: "data products" },
      el("thead", {}, el("tr", {}, el("th", { text: "Product" }), el("th", { text: "Category" }), el("th", { class: "num", text: "List price ($)" }),
        el("th", { class: "num", text: "Cost ($)" }), el("th", { class: "num", text: "Lands on day" }), el("th"))),
      el("tbody", {}, ...rows));
    const add = el("button", { type: "button", class: "btn small", text: "Add product", disabled: b.range.length >= this.world.schema.limits.products || null, onclick: () => {
      const cat = cats.find((x) => sells.has(x.id)) ?? cats[0];
      const name = newName(b.range, `New ${cat.name.toLowerCase()}`);
      this.#edit(() => { b.range.push({ id: newId(b.range, name), name, category: cat.id, price: cat.price, cost: Math.round(cat.price * 50) / 100, day: 1 }); });
    } });
    const paste = el("button", { type: "button", class: "btn small", text: this.pasting ? "Close" : "Paste from a spreadsheet", onclick: () => { this.pasting = !this.pasting; this.#render(); } });
    c.body.append(el("div", { class: "table-scroll products-scroll" }, table), el("div", { class: "row" }, add, paste));
    if (this.pasting) c.body.append(this.#pasteBox(b));
    c.body.append(el("p", { class: "note", text: "A brand sells a category when it has a product in it: its stores need racks for each (Micro world), and its plan needs units a week for each (Brands, Stock). How well a product sells is the model's secret, drawn at Setup." }));
    return c.root;
  }

  #productRow(b, p, catOptions, F) {
    const edit = (fn) => { this.world.edit(fn); this.#scheduleCheck(); this.#drawGantt(); };
    const name = textField({ label: "Product name", hideLabel: true, value: p.name, maxLength: 60, onChange: (v) => edit(() => { p.name = v; }) });
    const cat = select({ label: `Category of ${p.name}`, hideLabel: true, value: p.category, options: catOptions, onChange: (v) => this.#edit(() => { p.category = v; }) });
    const num = (k, step) => numberField({ label: `${F[k].label}, ${p.name}`, hideLabel: true, value: p[k], min: F[k].min, max: k === "day" ? this.draft.season_days : F[k].max, step,
      onChange: (v) => edit(() => { p[k] = k === "day" ? Math.round(v) : v; }) }).root;
    const dup = el("button", { type: "button", class: "icon-btn", "aria-label": `Duplicate ${p.name}`, title: "Duplicate", text: "⧉", onclick: () => {
      const n2 = newName(b.range, `${p.name} 2`);
      this.#edit(() => { b.range.splice(b.range.indexOf(p) + 1, 0, { ...clone(p), id: newId(b.range, n2), name: n2 }); });
    } });
    const del = b.range.length > 1 ? el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${p.name}`, title: "Remove", text: "×", onclick: () => {
      this.#edit(() => {
        b.range = b.range.filter((x) => x !== p);
        for (const e of [...b.calendar.promotions, ...b.calendar.markdowns, ...b.calendar.replenishment]) if (e.on === "products") e.items = e.items.filter((id) => id !== p.id);
      });
    } }) : null;
    return el("tr", { title: `id: ${p.id}` }, el("td", {}, name.root), el("td", {}, cat.root), el("td", { class: "num" }, num("price", 0.01)),
      el("td", { class: "num" }, num("cost", 0.01)), el("td", { class: "num" }, num("day", 1)), el("td", { class: "row-actions" }, dup, del));
  }

  // Rows pasted from a spreadsheet: name, category, price, cost, day.
  #pasteBox(b) {
    const area = el("textarea", { rows: 6, class: "paste-area", placeholder: "Slim jeans\tDenim\t54\t24.30\t1\nWrap dress\tDresses\t70\t31.50\t29", "aria-label": "Products to paste" });
    const out = el("div", { class: "paste-out" });
    const go = el("button", { type: "button", class: "btn small", text: "Add these", onclick: () => {
      const { products, errors } = parseRows(area.value, this.draft, b);
      out.replaceChildren(...errors.map((e) => el("div", { class: "bad", text: e })));
      if (!products.length) return;
      this.#edit(() => { for (const p of products) b.range.push(p); });
      this.app.banner(`${products.length} product${products.length === 1 ? "" : "s"} added to ${b.name}`, errors.length ? `${errors.length} row${errors.length === 1 ? "" : "s"} couldn't be read.` : "");
    } });
    return el("div", { class: "paste-box" },
      el("p", { class: "note", text: "One product per row: name, category, list price, cost, landing day, separated by tabs (as a spreadsheet copies them) or commas. The category is its name or id." }),
      area, el("div", { class: "row" }, go), out);
  }

  // ---- The calendar ---------------------------------------------------------------------------

  #calendarCard(b) {
    const c = card(`${possessive(b.name)} calendar`, { sub: "promotions (bars), replenishment (a band, a tick on each order day), markdowns (shaded to the season's end, a tick on each day they act), products landing (diamonds)", right: tag(false) });
    const gantt = el("div", { class: "calendar-box" });
    const days = this.draft.season_days;
    const add = (kind, make) => {
      const list = b.calendar[LISTS[kind]];
      const e = make(list);
      this.#edit(() => { list.push(e); });
      this.selected = { kind, i: list.length - 1 }; this.#render();
    };
    const addP = el("button", { type: "button", class: "btn small", text: "Add promotion", onclick: () => add("promotion", (list) => {
      const name = newName(list, "New promotion");
      return { id: newId(list, name), name, on: "range", items: [], from: 1, to: 7, depth: 0.2, tiers: b.loyalty.tiers.map((t) => t.id), areas: [] };
    }) });
    const addM = el("button", { type: "button", class: "btn small", text: "Add markdown", onclick: () => add("markdown", (list) => {
      const name = newName(list, "New markdown"); const day = Math.max(1, days - 13);
      return { id: newId(list, name), name, on: "range", items: [], from: day, to: day, weekdays: [], which: "all", by: 0.05, min_days: 14, rest_days: 0, mode: "to", depth: 0.3, max: 0.6 };
    }) });
    const addR = el("button", { type: "button", class: "btn small", text: "Add replenishment", onclick: () => add("replenishment", (list) => {
      const name = newName(list, "New replenishment");
      // On a weekday no other entry orders on, where there is one.
      const taken = new Set(list.flatMap((x) => (x.weekdays.length ? x.weekdays : WEEKDAYS)));
      const wd = ["Mon", "Thu", "Tue", "Wed", "Fri", "Sat", "Sun"].find((w) => !taken.has(w)) ?? "Mon";
      return { id: newId(list, name), name, on: "range", items: [], from: 1, to: days, weekdays: [wd], rule: "top_up", cover: 1.25, reorder: 1.25 };
    }) });
    this.editorBox = el("div", { class: "entry-editor" });
    c.body.append(el("div", { class: "row" }, addP, addR, addM), el("div", { class: "calendar-layout" }, gantt, this.editorBox),
      el("p", { class: "note", text: "A product has at most one promotion on any day for any household: two on the same product and day must reach different tiers or areas. It takes at most one replenishment entry and one markdown entry a day. A product no replenishment entry covers gets its opening allocation and nothing more. The Market tab's promotion buttons add to the calendar as the season runs; the Assortment tab shows it as it ran." }));
    this.gantt = gantt;
    requestAnimationFrame(() => this.#drawGantt());
    this.#renderEntry();
    return c.root;
  }

  #drawGantt() {
    const b = this.b; if (!b || !this.gantt) return;
    const d = this.draft;
    const bad = new Set(this.problems.map((p) => p.path.match(/calendar\.(promotions|markdowns|replenishment)\[(\d+)\]/)).filter(Boolean)
      .map((m) => `${KIND_OF[m[1]]}:${Number(m[2]) - 1}`));
    const key = (kind, i) => `${kind}:${i}`;
    const rowOf = new Map();
    const rows = [];
    const row = (id, label, colour) => { if (!rowOf.has(id)) { rowOf.set(id, rows.length); rows.push({ label, colour, bars: [], bands: [], steps: [], marks: [] }); } return rows[rowOf.get(id)]; };
    row("range", "Whole range");
    const sells = d.categories.filter((x) => b.range.some((p) => p.category === x.id));
    for (const cat of sells) {
      const r = row(`c:${cat.id}`, cat.name, cat.colour);
      const landing = [...new Set(b.range.filter((p) => p.category === cat.id).map((p) => p.day))].sort((x, y) => x - y);
      r.marks = landing.map((day) => ({ day, names: b.range.filter((p) => p.category === cat.id && p.day === day).map((p) => p.name) }));
    }
    const targets = (e) => (e.on === "range" ? ["range"] : e.on === "categories" ? e.items.map((id) => `c:${id}`) : e.items.map((id) => `p:${id}`));
    const ensure = (t) => {
      if (rowOf.has(t) || t === "range") return true;
      if (t.startsWith("p:")) { const p = b.range.find((x) => `p:${x.id}` === t); if (p) { row(t, p.name, d.categories.find((x) => x.id === p.category)?.colour); return true; } }
      if (t.startsWith("c:")) { const cat = d.categories.find((x) => `c:${x.id}` === t); if (cat) { row(t, cat.name, cat.colour); return true; } }
      return false;
    };
    // An entry of `kind`, drawn as `as` in each row it's on.
    const place = (e, i, kind, as, item) => { for (const t of targets(e)) if (ensure(t)) rows[rowOf.get(t)][as].push({ ...item, key: key(kind, i) }); };
    const sound = (e) => Number.isInteger(e.from) && Number.isInteger(e.to) && e.from <= e.to;
    b.calendar.promotions.forEach((e, i) => place(e, i, "promotion", "bars", { name: e.name, from: e.from, to: Math.max(e.from, e.to), depth: e.depth, colour: b.colour, bad: bad.has(key("promotion", i)), note: reachText(e, b, d) }));
    b.calendar.replenishment.forEach((e, i) => {
      if (!sound(e)) return;
      const note = replenishmentText(e, b, d);
      place(e, i, "replenishment", "bands", { name: e.name, from: e.from, to: e.to, colour: b.colour, bad: bad.has(key("replenishment", i)), note,
        ticks: entryDays(e).map((day) => ({ day, title: `${e.name}: day ${day}, ${weekdayOf(day)}`, rows: [{ value: "", name: note }] })) });
    });
    b.calendar.markdowns.forEach((e, i) => {
      if (!sound(e)) return;
      const note = markdownText(e, b, d);
      place(e, i, "markdown", "steps", { name: e.name, from: e.from, depth: e.mode === "to" ? e.depth : e.max, label: `${markdownLabel(e)} ${e.name}`, bad: bad.has(key("markdown", i)), note,
        ticks: entryDays(e).map((day) => ({ day, title: `${e.name}: day ${day}, ${weekdayOf(day)}`, rows: [{ value: "", name: note }] })) });
    });
    const sel = this.selected ? key(this.selected.kind, this.selected.i) : null;
    drawCalendar(this.gantt, { days: d.season_days, rows, selected: sel, onSelect: (k) => {
      const [kind, i] = k.split(":"); this.selected = { kind, i: Number(i) }; this.#drawGantt(); this.#renderEntry();
    } });
  }

  // The selected entry, in the panel beside the Gantt.
  #renderEntry() {
    const b = this.b; const box = this.editorBox; if (!b || !box) return;
    const s = this.selected;
    const list = s ? b.calendar[LISTS[s.kind]] : null;
    const e = list?.[s.i];
    if (!e) { box.replaceChildren(el("p", { class: "empty", text: "Click a promotion, a replenishment entry or a markdown to edit it, or add one." })); return; }
    const d = this.draft; const schema = this.world.schema;
    const line = el("p", { class: "entry-line" });
    const say = () => {
      if (s.kind === "replenishment") line.textContent = `${replenishmentText(e, b, d)}.`;
      else if (s.kind === "markdown") line.textContent = `${markdownText(e, b, d)}.`;
      else line.textContent = `Days ${e.from} to ${e.to}: ${fmt.pct(e.depth)} off ${onText(e, b, d)}, for ${reachText(e, b, d)}.`;
    };
    const edit = (fn, panel = false) => { this.world.edit(fn); this.#scheduleCheck(); this.#drawGantt(); if (panel) this.#renderEntry(); else say(); };
    const name = textField({ label: "Name", value: e.name, maxLength: 60, onChange: (v) => edit(() => { e.name = v; }) });
    const on = segmented({ label: "What it's on", value: e.on, options: ON, onChange: (v) => edit(() => { e.on = v; e.items = []; }, true) });
    let items = null;
    if (e.on === "categories") {
      const cats = d.categories.filter((x) => b.range.some((p) => p.category === x.id));
      items = el("div", { class: "checks" }, ...cats.map((x) => checkbox({ label: x.name, checked: e.items.includes(x.id), onChange: (v) => edit(() => {
        e.items = v ? [...e.items, x.id] : e.items.filter((id) => id !== x.id);
      }) }).root));
    } else if (e.on === "products") {
      items = el("div", { class: "checks product-checks" }, ...b.range.map((p) => checkbox({ label: p.name, checked: e.items.includes(p.id), onChange: (v) => edit(() => {
        e.items = v ? [...e.items, p.id] : e.items.filter((id) => id !== p.id);
      }) }).root));
    }
    const day = (k, label) => numberField({ label, value: e[k], min: 1, max: d.season_days, onChange: (v) => edit(() => { e[k] = Math.round(v); }) }).root;
    const parts = [el("div", { class: "entry-kind", text: { promotion: "Promotion", markdown: "Markdown", replenishment: "Replenishment" }[s.kind] }),
      name.root, el("div", { class: "field" }, el("span", { text: "On" }), on.root), items];
    if (s.kind === "promotion") {
      const depth = settingLever(schema.fields.promotion.depth, { value: e.depth, onChange: (v) => edit(() => { e.depth = v; }) }).root;
      parts.push(el("div", { class: "two" }, day("from", "First day"), day("to", "Last day")), depth);
      parts.push(el("h3", { class: "setup-heading", text: `Who it reaches (their tier with ${b.name})` }),
        el("div", { class: "checks" }, ...b.loyalty.tiers.map((t) => checkbox({ label: t.name, checked: e.tiers.includes(t.id), onChange: (v) => edit(() => {
          e.tiers = v ? [...e.tiers, t.id] : e.tiers.filter((id) => id !== t.id);
        }) }).root)));
      const areas = d.macro.areas ?? [];
      const every = checkbox({ label: "Every area", checked: !e.areas.length, onChange: (v) => edit(() => { e.areas = v ? [] : areas.slice(0, 1).map((a) => a.id); }, true) });
      parts.push(el("h3", { class: "setup-heading", text: "Where" }), el("div", { class: "checks" }, every.root,
        ...(e.areas.length ? areas.map((a) => checkbox({ label: a.name, checked: e.areas.includes(a.id), onChange: (v) => edit(() => {
          e.areas = v ? [...e.areas, a.id] : e.areas.filter((id) => id !== a.id);
        }) }).root) : [])));
    } else {
      parts.push(...this.#whenFields(e, edit));
      if (s.kind === "replenishment") parts.push(...this.#replenishmentFields(e, b, edit));
      else parts.push(...this.#markdownFields(e, edit));
    }
    const del = el("button", { type: "button", class: "btn small danger", text: `Remove this ${s.kind === "replenishment" ? "entry" : s.kind}`, onclick: () => {
      this.selected = null;
      this.#edit(() => { list.splice(s.i, 1); });
    } });
    const mine = this.problems.filter((p) => p.path.startsWith(`brands[${this.brandIndex + 1}].calendar.${LISTS[s.kind]}[${s.i + 1}]`));
    say();
    parts.push(line, ...mine.map((p) => el("div", { class: "bad", text: p.message })), el("div", { class: "row" }, del));
    box.replaceChildren(...parts.filter(Boolean));
  }

  // When a markdown or replenishment entry acts: once on a day, or on
  // chosen weekdays from one day to another (every weekday ticked: every
  // day; at least one stays ticked).
  #whenFields(e, edit) {
    const days = this.draft.season_days;
    const once = e.from === e.to;
    const mode = segmented({ label: "When", value: once ? "once" : "repeat", options: [{ value: "once", label: "Once" }, { value: "repeat", label: "On weekdays" }],
      onChange: (v) => edit(() => {
        if (v === "once") { e.to = e.from; e.weekdays = []; } else { e.to = Math.min(days, Math.max(e.from + 27, e.from + 1)); e.weekdays = [weekdayOf(e.from)]; }
      }, true) });
    const out = [el("div", { class: "field" }, el("span", { text: "When" }), mode.root)];
    if (once) {
      out.push(numberField({ label: "On day", value: e.from, min: 1, max: days, onChange: (v) => edit(() => { e.from = e.to = Math.round(v); e.weekdays = []; }) }).root);
      return out;
    }
    const num = (k, label) => numberField({ label, value: e[k], min: 1, max: days, onChange: (v) => edit(() => { e[k] = Math.round(v); }) }).root;
    const ticked = new Set(e.weekdays.length ? e.weekdays : WEEKDAYS);
    const boxes = WEEKDAYS.map((w) => checkbox({ label: w, checked: ticked.has(w), onChange: (v) => {
      const next = new Set(e.weekdays.length ? e.weekdays : WEEKDAYS);
      if (v) next.add(w); else next.delete(w);
      if (!next.size) { this.#renderEntry(); return; }
      edit(() => { e.weekdays = next.size === WEEKDAYS.length ? [] : WEEKDAYS.filter((x) => next.has(x)); });
    } }).root);
    out.push(el("div", { class: "two" }, num("from", "From day"), num("to", "To day")), el("div", { class: "checks weekdays" }, ...boxes));
    return out;
  }

  #replenishmentFields(e, b, edit) {
    const F = this.world.schema.fields.replenishment;
    const rule = segmented({ label: "Rule", value: e.rule, options: [{ value: "top_up", label: "Top up to cover" }, { value: "replace", label: "Replace what sold" }],
      onChange: (v) => edit(() => { e.rule = v; }, true) });
    const out = [el("div", { class: "field" }, el("span", { text: "Rule" }), rule.root)];
    if (e.rule === "top_up") {
      let reorder = null;
      const cover = settingLever(F.cover, { value: e.cover, onChange: (v) => edit(() => { e.cover = v; if (e.reorder > v) { e.reorder = v; reorder?.set(v); } }) });
      reorder = settingLever(F.reorder, { value: e.reorder, onChange: (v) => edit(() => { e.reorder = Math.min(v, e.cover); if (v > e.cover) reorder.set(e.cover); }) });
      out.push(cover.root, reorder.root,
        el("p", { class: "note", text: `Weeks of each store's expected demand, beyond ${possessive(b.name)} lead time. With the reorder point at the cover it always tops up; lower, it's min/max: small gaps wait, large ones are filled.` }));
    } else {
      out.push(el("p", { class: "note", text: "Each store gets what it sold of each size since the product's last order: no forecast, and stock isn't moved to where demand turns out higher." }));
    }
    return out;
  }

  #markdownFields(e, edit) {
    const F = this.world.schema.fields.markdown;
    const which = segmented({ label: "Which products", value: e.which, options: [{ value: "all", label: "Every product it's on" }, { value: "behind", label: "Only those behind plan" }],
      onChange: (v) => edit(() => { e.which = v; }, true) });
    const out = [el("div", { class: "field" }, el("span", { text: "Which" }), which.root)];
    if (e.which === "behind") {
      out.push(settingLever(F.by, { value: e.by, onChange: (v) => edit(() => { e.by = v; }) }).root,
        settingLever(F.min_days, { value: e.min_days, max: this.draft.season_days, onChange: (v) => edit(() => { e.min_days = v; }) }).root);
    }
    out.push(settingLever(F.rest_days, { value: e.rest_days, max: this.draft.season_days, onChange: (v) => edit(() => { e.rest_days = v; }) }).root);
    const mode = segmented({ label: "Price", value: e.mode, options: [{ value: "to", label: "To a depth" }, { value: "deeper", label: "Deeper by a step" }],
      onChange: (v) => edit(() => { e.mode = v; }, true) });
    out.push(el("div", { class: "field" }, el("span", { text: "Price" }), mode.root),
      settingLever(F.depth, { label: e.mode === "to" ? "Off full price" : "Step deeper (points)", value: e.depth, onChange: (v) => edit(() => { e.depth = v; }) }).root);
    if (e.mode === "deeper") out.push(settingLever(F.max, { label: "No deeper than", value: e.max, onChange: (v) => edit(() => { e.max = v; }) }).root);
    out.push(el("p", { class: "note", text: "A markdown holds to the season's end, and the deeper one wins: a markdown never raises a price (a temporary cut is a promotion)." }));
    return out;
  }

  // ---- Price rules (live) ---------------------------------------------------------------------

  #rulesCard(b) {
    const F = this.world.schema.fields.pricing;
    const c = card("Price rules", { right: tag(true) });
    const note = el("p", { class: "note" });
    const say = () => { note.textContent = `A markdown for the products behind plan measures each against ${possessive(b.name)} target: ${fmt.pct(b.pricing.md_target)} sold through by the season's end, on the path of its planned sales. When and how deep ${b.name} marks down is on its calendar.`; };
    const set = async (k, v) => {
      this.world.live((w) => { const x = w.brands.find((y) => y.id === b.id); if (x) x.pricing[k] = v; });
      say();
      await this.app.set("pricing", k, v, { brand: b.id });
    };
    const stack = checkbox({ label: "Promotions also come off marked-down products", checked: b.pricing.promos_on_markdowns, onChange: (v) => set("promos_on_markdowns", v) });
    say();
    c.body.append(el("div", { class: "checks col" }, stack.root), el("div", { class: "settings-grid" }, settingLever(F.md_target, { value: b.pricing.md_target, onChange: (v) => set("md_target", v) }).root), note);
    return c.root;
  }

  // ---- The model's check ----------------------------------------------------------------------

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
    const i = this.brandIndex + 1; const name = this.b.name;
    this.problems = (r.problems ?? []).filter((p) => p.path.startsWith(`brands[${i}].range`) ||
      (p.path.startsWith(`brands[${i}].calendar`) && !p.path.startsWith(`brands[${i}].calendar.offers`)) ||
      p.path.startsWith(`brands[${i}].stock.plan`) || (p.path.startsWith("stores[") && p.message.startsWith(`${name} sells`)));
    this.#showProblems();
    this.#drawGantt();
    this.#renderEntry();
  }

  #showProblems() {
    const box = this.problemsBox; if (!box) return;
    box.replaceChildren(this.problems.length
      ? el("div", { class: "problems" }, el("b", { text: `${this.problems.length} problem${this.problems.length === 1 ? "" : "s"} with ${possessive(this.b.name)} range or calendar: Setup won't start this world until they're fixed` }),
        ...this.problems.map((p) => el("button", { type: "button", class: "problem", onclick: () => {
          if (!/^brands\[\d+\]\.(range|calendar)/.test(p.path)) { this.goToElsewhere?.(p); return; }
          this.goTo(p.path); this.#drawGantt(); this.#renderEntry();
        } },
          el("code", { text: p.path }), ` ${p.message}`)))
      : el("div", { class: "ok-line", text: "No problems: the model can run this range and calendar." }));
  }
}


// A brand's plan keeps only the categories it sells (it has products in).
function keepPlanToRange(b) {
  const sells = new Set(b.range.map((p) => p.category));
  for (const id of Object.keys(b.stock.plan)) if (!sells.has(id)) delete b.stock.plan[id];
}

// Products from pasted rows: name, category (name or id), list price, cost,
// landing day. Returns the products and a line for each row that couldn't
// be read.
export function parseRows(text, d, b) {
  const products = []; const errors = [];
  const taken = [...b.range];
  text.split(/\r?\n/).forEach((line, k) => {
    if (!line.trim()) return;
    const cells = (line.includes("\t") ? line.split("\t") : line.split(",")).map((x) => x.trim());
    const [name, catText, price, cost, day] = cells;
    const cat = d.categories.find((c) => c.id === catText || c.name.toLowerCase() === (catText ?? "").toLowerCase());
    const num = (x) => Number(String(x ?? "").replace(/[$,\s]/g, ""));
    const p = num(price); const c = num(cost); const dd = Math.round(num(day || 1));
    const why = !name ? "no name" : !cat ? `no category called "${catText ?? ""}"` : !(p > 0) ? "the price isn't a number above 0"
      : !(c >= 0) ? "the cost isn't a number" : !(dd >= 1 && dd <= d.season_days) ? `the day isn't 1 to ${d.season_days}` : null;
    if (why) { errors.push(`Row ${k + 1}: ${why}`); return; }
    const id = newId(taken, name);
    const prod = { id, name: name.slice(0, 60), category: cat.id, price: p, cost: c, day: dd };
    taken.push(prod); products.push(prod);
  });
  return { products, errors };
}
