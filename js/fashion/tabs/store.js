// Store: one store's floor, from the same simulation the market reports
// come from. After the restaurant-flow and sushi pictures: the floor plan
// with fixtures by category and shoppers on it, a footfall heat map, the
// process flow with live counts, and its KPIs. Click a shopper or a worker
// on the floor and the inspector shows inside their head. Its settings are
// on the Setup tab. Households bring returns back to the tills here, from
// any of the brand's stores or its online store. A brand's online store has
// no floor, so it isn't in the picker.

import { el, fmt, select, segmented, card, stats, brandVar } from "../ui.js";
import { LineChart, BarChart } from "../charts.js";
import { FloorView, LOOK_NAMES } from "../floor-view.js";
import { Inspector } from "../inspector.js";

const NS = "http://www.w3.org/2000/svg";
const OUTCOMES = ["paid", "nothing appealed", "too expensive", "not in my size", "left the fitting-room queue", "didn't fit or like it", "walked out of the till queue"];
const HOURS = Array.from({ length: 10 }, (_, i) => `${10 + i}:00`);

export class StoreTab {
  constructor(root, app) {
    this.app = app; this.store = 1; this.mode = "floor"; this.lastFollow = null;
    root.append(el("div", { class: "tab-intro" }, el("h1", { text: "Store" }),
      el("p", { text: "Any store's floor, live. This is the same simulation the market numbers come from: every dot is one visit from a household on the map, and every figure on the other tabs adds up visits like these. Some come only to return something, straight to the tills. The clock runs at the speed set at the top; click a shopper or a worker to see inside their head." })));

    // Picker and view switch.
    this.distSel = select({ label: "Area", hideLabel: true, value: 0, options: [{ value: 0, label: "Every area" }], onChange: () => this.#fillStores() });
    this.storeSel = select({ label: "Store", hideLabel: true, value: 1, options: [], onChange: (v) => this.select(Number(v)) });
    const count = () => this.app.stores.length || 1;
    const prev = el("button", { type: "button", class: "btn", text: "◀", "aria-label": "Previous store", onclick: () => this.select(((this.store + count() - 2) % count()) + 1) });
    const next = el("button", { type: "button", class: "btn", text: "▶", "aria-label": "Next store", onclick: () => this.select((this.store % count()) + 1) });
    this.titleDot = el("i", { class: "key-dot" });
    this.title = el("h1", { text: "" });
    this.subtitle = el("span", { class: "sub" });
    this.viewSeg = segmented({ label: "Store view", value: "floor", options: [
      { value: "floor", label: "Floor" }, { value: "heat", label: "Heat map" }, { value: "flow", label: "Flow" }],
    onChange: (v) => this.#setMode(v) });
    const follow = el("button", { type: "button", class: "btn", text: "Follow a random shopper", onclick: () => app.action("follow_visit", { store: this.store }) });
    root.append(el("div", { class: "filters" },
      el("div", { class: "store-title" }, this.titleDot, this.title, this.subtitle),
      el("div", { class: "store-picker" }, this.distSel.root, this.storeSel.root, prev, next),
      this.viewSeg.root, follow));

    const top = el("div", { class: "grid store-top" });
    // The floor, heat map or flow.
    this.viewCard = card("Floor", { sub: "" });
    this.floorWrap = el("div", { class: "canvas-wrap floor-wrap" });
    this.flowBox = el("div", { class: "chart flow-svg", hidden: true });
    this.floorLegend = el("div", { class: "map-legend" },
      ...LOOK_NAMES.map((n, i) => el("span", {}, el("i", { class: "legend-swatch", vars: { "--c": `var(--look-${i + 1})` } }), n)),
      el("span", {}, el("i", { class: "legend-swatch square", vars: { "--c": "var(--ink)" } }), "cashier"),
      el("span", {}, el("i", { class: "legend-swatch square", vars: { "--c": "var(--accent)" } }), "assistant (filled: busy)"));
    this.viewCard.body.append(this.floorWrap, this.flowBox, this.floorLegend);
    this.floor = new FloorView(this.floorWrap, { onClick: (x, y) => app.action("inspect_at", { store: this.store, x, y }) });

    // The inspector, KPIs and the followed shopper.
    const right = el("div", { class: "grid" });
    this.inspector = new Inspector({ onClose: () => app.action("close_inspector"), onHousehold: (h) => app.openHousehold(h), app });
    right.append(this.inspector.root);
    const k = card("Today", { sub: "" });
    this.kpiCard = k;
    const kbox = el("div", { class: "stats" });
    this.kpi = stats(kbox, [
      { key: "traffic", label: "Traffic" }, { key: "inside", label: "In the store now" },
      { key: "receipts", label: "Receipts" }, { key: "conversion", label: "Conversion" },
      { key: "sales", label: "Sales", title: "Rung up today, before refunds" }, { key: "net", label: "Net sales", title: "Sales less today's refunds of this store's sales, wherever they were returned" },
      { key: "avg_receipt", label: "Average receipt" },
      { key: "upr", label: "Units per receipt" }, { key: "fr_wait", label: "Fitting-room wait" },
      { key: "till_wait", label: "Till wait" }, { key: "lost_fr", label: "Lost at fitting rooms" },
      { key: "lost_till", label: "Walked out at tills" }, { key: "staff", label: "Staff cost" },
      { key: "returns", label: "Returns taken back", title: "Items brought back to this store's tills today, from any of the brand's stores or its online store" },
      { key: "refund_s", label: "Till time on returns" },
    ]);
    k.body.append(kbox);
    const fol = card("Follow a shopper", { sub: "click one on the floor" });
    this.story = el("div", {}, el("p", { class: "empty", text: "No one followed yet." }));
    fol.body.append(this.story);
    right.append(k.root, fol.root);
    top.append(this.viewCard.root, right);

    const bottom = el("div", { class: "grid store-bottom" });
    const q = card("Queues over the day", { sub: "people waiting, every 5 minutes" });
    this.queues = new LineChart(q.body, { height: 170, format: fmt.int, legend: true, xFormat: (x) => x, tipTitle: (x) => x, emptyText: "The day hasn't started" });
    const u = card("Staff utilisation", { sub: "share of each hour busy · tills: selling, and taking returns back" });
    this.util = new LineChart(u.body, { height: 170, format: (v) => fmt.pct(v), legend: true, yMax: 1, xFormat: (x) => x, tipTitle: (x) => `${x} to the next hour` });
    const sh = card("Sales by hour");
    this.byHour = new BarChart(sh.body, { height: 170, format: fmt.money, catFormat: (c) => c.replace(":00", "") });
    const sc = card("Stock by category", { sub: "units in the store after closing" });
    this.stock = new LineChart(sc.body, { height: 170, format: fmt.compact, legend: true, xFormat: (x) => `day ${x}`, tipTitle: (x) => `Day ${x}`, emptyText: "After the first day" });
    const se = card("This store's season", { sub: "visits, receipts, walk-outs and items returned here, by day" });
    this.season = new LineChart(se.body, { height: 170, format: fmt.int, legend: true, xFormat: (x) => `day ${x}`, tipTitle: (x) => `Day ${x}`, emptyText: "After the first day" });
    const oc = card("How visits ended", { sub: "" });
    this.outCard = oc;
    this.outcomes = new BarChart(oc.body, { height: 170, horizontal: true, labelWidth: 170, format: fmt.int, valueLabels: true });
    bottom.append(q.root, u.root, sh.root, sc.root, se.root, oc.root);
    root.append(top, bottom);
  }

  #setMode(mode) {
    this.mode = mode;
    this.floorWrap.hidden = mode === "flow"; this.floorLegend.hidden = mode === "flow";
    this.flowBox.hidden = mode !== "flow";
    this.floor.setMode(mode === "heat" ? "heat" : "floor");
    this.viewCard.root.querySelector("h2").textContent = { floor: "Floor", heat: "Heat map", flow: "Flow" }[mode];
    this.app.view({ heat: mode === "heat" });
  }

  // Stores grouped by the area they stand in (the last group: outside every area).
  #fillStores() {
    const g = this.app.geometry; if (!g) return;
    const a = Number(this.distSel.value);
    const groups = [...g.areas.map((area, k) => ({ name: area.name, k: k + 1 })), { name: "Outside every area", k: 0 }];
    const opts = groups.filter((grp) => !a || a === grp.k || (a === -1 && grp.k === 0))
      .map((grp) => ({ group: grp.name, options: g.stores.filter((s) => s.area === grp.k).map((s) => ({ value: s.id, label: s.name })) }))
      .filter((o) => o.options.length);
    this.storeSel.setOptions(opts, this.store);
  }

  select(id) {
    const g = this.app.geometry;
    if (g && (id < 1 || id > g.stores.length)) id = 1;
    this.store = id;
    if (g) {
      const st = g.stores[id - 1];
      this.#fillStores(); this.storeSel.set(id);
      this.title.textContent = st.name;
      this.titleDot.style.setProperty("--brand", brandVar(st.brand));
      const plan = this.app.plans.find((p) => p.format === st.format);
      this.subtitle.textContent = ` ${this.app.brandName(st.brand)} · ${plan?.name ?? st.format} layout · ${st.area ? g.areas[st.area - 1].name : "outside every area"}`;
      this.floor.setPlan(plan);
      this.floor.setSells(g.brands[st.brand - 1]?.sells ?? null);
      this.floor.setAgents(null);
      this.inspector.update(null);
    }
    if (this.app.tab === "store") this.app.view({ store: id });
  }

  viewState() { return { store: this.store, heat: this.mode === "heat" }; }

  onGeometry(geo) {
    const outside = geo.stores.some((s) => !s.area);
    this.distSel.setOptions([{ value: 0, label: "Every area" }, ...geo.areas.map((d, k) => ({ value: k + 1, label: d.name })), ...(outside ? [{ value: -1, label: "Outside every area" }] : [])], 0);
    this.select(this.store);
  }

  onFrame(frame) {
    const f = frame.floor;
    if (f.n === 0 && f.staffN === 0) return;
    this.floor.setAgents(f);
    this.floor.setCaption(`${fmt.int(f.inStore)} inside · ${fmt.int(f.frQ)} waiting for fitting rooms · ${fmt.int(f.tillQ)} at the tills`);
  }

  update(r) {
    if (r.id !== this.store) return;
    const k = r.kpi;
    this.kpiCard.setSub(r.day_label);
    this.kpi.update({
      traffic: fmt.int(k.traffic), inside: r.live ? fmt.int(k.inside) : "—", receipts: fmt.int(k.receipts),
      conversion: fmt.pct(k.conversion, 0), sales: fmt.money(k.sales), net: { value: fmt.money(k.net_sales), sub: k.refunds ? `${fmt.money(k.refunds)} refunded` : "" },
      returns: { value: fmt.int(k.taken_back), sub: `${fmt.int(k.return_trips)} trip${k.return_trips === 1 ? "" : "s"}` }, refund_s: fmt.mins(k.refund_s),
      avg_receipt: fmt.money2(k.avg_receipt),
      upr: fmt.num2(k.units_per_receipt), fr_wait: fmt.mins(k.fr_wait), till_wait: fmt.mins(k.till_wait),
      lost_fr: fmt.int(k.lost_fr), lost_till: fmt.int(k.lost_till), staff: fmt.money(k.staff_cost),
    });
    if (!r.live) this.floor.setCaption(this.app.header?.pace === "watch" ? "" : "The fastest speed doesn't draw the floor: pick a slower one to watch it");
    if (r.heat) this.floor.setHeat(r.heat);
    this.floor.setFollow(r.follow?.visit ?? null);
    this.floor.setInspect(r.inspect ? { kind: r.inspect.kind, visit: r.inspect.visit, server: r.inspect.server } : null);
    this.inspector.update(r.inspect);
    this.#story(r.follow);
    if (this.mode === "flow") this.#flow(r);

    const bins = r.queues.fr.length;
    const now = r.live ? Math.min(bins, Math.floor((this.app.header?.clock_s ?? 0) / 300) + 1) : bins;
    const lbl = Array.from({ length: bins }, (_, i) => { const m = i * 5; return `${10 + Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; });
    this.queues.update({ x: lbl.slice(0, now), series: [
      { name: "Fitting rooms", colour: "var(--look-4)", values: r.queues.fr.slice(0, now) },
      { name: "Tills", colour: "var(--look-3)", values: r.queues.till.slice(0, now) }] });
    const hrs = r.live ? Math.min(10, Math.floor((this.app.header?.clock_s ?? 0) / 3600) + 1) : 10;
    this.util.update({ x: HOURS.slice(0, hrs), series: [
      { name: "Fitting rooms", colour: "var(--look-4)", values: r.util.fitting.slice(0, hrs) },
      { name: "Tills", colour: "var(--look-3)", values: r.util.tills.slice(0, hrs) },
      { name: "Tills: returns", colour: "var(--look-8)", values: r.util.refunds.slice(0, hrs) },
      ...(r.util.assistants ? [{ name: "Assistants", colour: "var(--accent)", values: r.util.assistants.slice(0, hrs) }] : [])] });
    this.byHour.update({ categories: HOURS, series: [{ name: "Sales", colour: brandVar(r.brand), values: r.sales_by_hour }] });
    const se = r.season;
    if (se) {
      const days = se.traffic.length; const x = Array.from({ length: days }, (_, i) => i + 1);
      const sells = new Set(this.app.brands[r.brand - 1]?.sells ?? []);
      this.stock.update({ x, series: this.app.categories.map((c, j) => ({ name: c.name, colour: `var(--cat-${j + 1})`, values: se.stock.map((row) => row[j]) })).filter((_, j) => sells.has(j + 1)) });
      this.season.update({ x, series: [
        { name: "Visits", colour: "var(--ink-2)", values: se.traffic }, { name: "Receipts", colour: brandVar(r.brand), values: se.paid },
        { name: "Walk-outs at queues", colour: "var(--critical)", values: se.walkouts },
        { name: "Items returned here", colour: "var(--look-8)", values: se.returns }] });
    } else { this.stock.update(null); this.season.update(null); }
    this.outCard.setSub(r.day_label);
    this.outcomes.update({ categories: OUTCOMES, series: [{ name: "Visits", colours: OUTCOMES.map((_, i) => (i === 0 ? "var(--good)" : i >= 3 ? "var(--critical)" : "var(--ink-2)")), values: r.outcomes }] });
  }

  #story(f) {
    if (!f) { if (this.lastFollow !== null) { this.story.replaceChildren(el("p", { class: "empty", text: "No one followed yet." })); this.lastFollow = null; } return; }
    this.lastFollow = f.visit;
    this.story.replaceChildren(...[
      el("div", { class: "stat-sub" }, `Visit #${f.visit} · household #${f.household} · ${f.segment}, size ${f.size}, from ${f.area}${f.returning?.length ? " · came to return" : ""}`),
      el("div", { class: "stat-sub" }, `Drove ${fmt.num1(f.travel_min)} min · arrived ${f.arrive} · budget ${fmt.money(f.budget)}${f.promotions?.length ? ` · ${f.promotions.join(", ")}` : ""}${f.coupon ? ` · ${fmt.pct(f.coupon)} coupon${f.coupon_from ? ` from ${f.coupon_from}` : ""}` : ""}`),
      f.basket?.length ? el("div", { class: "stat-sub" }, `Carrying: ${f.basket.map((b) => `${b.item} ($${Math.round(b.price)})`).join(", ")}`) : null,
      f.returning?.length ? el("div", { class: "stat-sub" }, `Returning: ${f.returning.map((b) => `${b.item} (${fmt.money2(b.price)}, bought ${b.bought} on day ${b.day}: ${b.reason})`).join("; ")}`) : null,
      el("div", { class: "story" }, ...f.log.map((l) => el("div", {}, el("time", { text: l.t }), l.text)))].filter(Boolean));
  }

  // The store as a process, live: entrance, the floor, the fitting rooms,
  // the tills and the exit, with how many passed along each step today and
  // how many left at each.
  #flow(r) {
    const W = Math.max(620, this.flowBox.clientWidth || 760); const H = 360;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.style.width = "100%"; svg.style.height = `${H}px`;
    const add = (tag, attrs, txt) => { const n = document.createElementNS(NS, tag); for (const [k2, v] of Object.entries(attrs)) n.setAttribute(k2, v); if (txt !== undefined) n.textContent = txt; svg.append(n); return n; };
    const f = r.flow;
    const boxes = [
      { label: "Entrance", lines: [`${fmt.int(f.entered)} came in`] },
      { label: "On the floor", lines: [`${fmt.int(f.browsing)} browsing now`] },
      { label: "Fitting rooms", lines: [`${fmt.int(f.fr_busy)} of ${fmt.int(f.fr_open)} busy`, `${fmt.pct(f.fr_util, 0)} used today`], queue: f.fr_queue, colour: "var(--look-4)" },
      { label: "Tills", lines: [`${fmt.int(f.till_busy)} of ${fmt.int(f.till_open)} busy`, `${fmt.pct(f.till_util, 0)} used today`, `${fmt.int(f.returned)} returns taken back`], queue: f.till_queue, colour: "var(--look-3)" },
      { label: "Paid", lines: [`${fmt.int(f.paid)} receipts`] },
    ];
    const flows = [f.entered, f.to_fr, f.to_till, f.paid];
    const losses = [null, [f.left_floor, "left from the floor", "nothing appealed, too dear, no size"], [f.lost_fr + f.left_fr, "left at the fitting rooms", `${fmt.int(f.lost_fr)} gave up the queue, ${fmt.int(f.left_fr)} kept nothing`], [f.lost_till, "walked out at the tills", "the queue was too long"], null];
    const n = boxes.length; const gap = W * 0.05; const bw = (W - gap * (n - 1)) / n; const by = 90; const bh = 86;
    boxes.forEach((b, i) => {
      const x = i * (bw + gap);
      add("rect", { x, y: by, width: bw, height: bh, rx: 8, fill: "var(--surface-2)", stroke: "var(--hairline)" });
      add("text", { x: x + bw / 2, y: by + 22, "text-anchor": "middle", class: "label-ink", style: "font-weight:650;font-size:12px" }, b.label);
      b.lines.forEach((line, j) => add("text", { x: x + bw / 2, y: by + 44 + j * 17, "text-anchor": "middle", class: j === 0 ? "value-ink" : "" }, line));
      if (b.queue !== undefined) {
        const q = Math.min(b.queue, 12);
        for (let j = 0; j < q; j++) add("circle", { cx: x + bw / 2 - 38 + (j % 6) * 15, cy: by - 16 - Math.floor(j / 6) * 15, r: 5.5, fill: b.colour });
        add("text", { x: x + bw / 2, y: by - (q > 6 ? 48 : 34), "text-anchor": "middle" }, b.queue ? `${fmt.int(b.queue)} waiting now` : "no queue now");
      }
      if (i < n - 1) {
        const x2 = (i + 1) * (bw + gap);
        add("path", { d: `M${x + bw + 3},${by + bh / 2}H${x2 - 9}`, stroke: "var(--axis)", "stroke-width": 2, fill: "none" });
        add("path", { d: `M${x2 - 9},${by + bh / 2 - 5}L${x2 - 2},${by + bh / 2}L${x2 - 9},${by + bh / 2 + 5}Z`, fill: "var(--axis)" });
        add("text", { x: x + bw + gap / 2, y: by + bh / 2 - 8, "text-anchor": "middle", class: "value-ink" }, fmt.int(flows[i]));
      }
      const l = losses[i];
      if (l) {
        const cx = x + bw / 2;
        add("path", { d: `M${cx},${by + bh + 3}V${by + bh + 40}`, stroke: "var(--critical)", "stroke-width": 2 });
        add("path", { d: `M${cx - 5},${by + bh + 34}L${cx},${by + bh + 44}L${cx + 5},${by + bh + 34}Z`, fill: "var(--critical)" });
        add("text", { x: cx, y: by + bh + 62, "text-anchor": "middle", class: "value-ink" }, fmt.int(l[0]));
        add("text", { x: cx, y: by + bh + 78, "text-anchor": "middle", class: "label-ink" }, l[1]);
        add("text", { x: cx, y: by + bh + 94, "text-anchor": "middle" }, l[2]);
      }
    });
    add("text", { x: 4, y: H - 8 }, `Counts are ${r.day_label.toLowerCase()}; busy and waiting are right now, while the floor is drawn.`);
    this.flowBox.replaceChildren(svg);
  }
}
