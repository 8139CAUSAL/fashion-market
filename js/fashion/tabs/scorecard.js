// Scorecard: the season's statistics, after the multi-tab restaurant's
// Statistics page — satisfied against unsatisfied visits and why, time in
// store with its summary statistics, staff utilisation, the size fill rate,
// and what each brand has earned: its logistics charged as stock leaves the
// DC, and at the season's end its stock left, written down to what it
// fetches (until then, the stock left is shown at cost).

import { el, fmt, select, card, brandVar } from "../ui.js";
import { LineChart, BarChart, Donut, Waterfall } from "../charts.js";

export class ScorecardTab {
  constructor(root, app) {
    this.app = app; this.brand = 1; this.scope = "ours";
    root.append(el("div", { class: "tab-intro" }, el("h1", { text: "Scorecard" }),
      el("p", { text: "The season so far, in totals and distributions. Export the daily results for your own analysis." }),
      el("button", { type: "button", class: "btn", text: "Export daily results (CSV)", onclick: () => app.exportCsv().catch((e) => app.error("Export failed", e)) })));
    const grid = el("div", { class: "grid score-grid" });

    const sat = card("Visits: satisfied and not", { sub: "every store, the season so far" });
    const d1 = el("div"); const b1 = el("div", { style: { marginTop: "8px" } });
    sat.body.append(d1, b1);
    this.satDonut = new Donut(d1, { height: 130, emptyText: "No visits yet" });
    this.reasons = new BarChart(b1, { height: 150, horizontal: true, labelWidth: 176, format: fmt.int, valueLabels: true, valueFormat: fmt.compact });

    const dw = card("Time in store", { sub: "minutes per visit" });
    this.dwellStats = el("div", { class: "stats", style: { marginBottom: "6px" } });
    dw.body.append(this.dwellStats);
    this.dwell = new BarChart(dw.body, { height: 150, stacked: true, format: fmt.compact, legend: true, barMax: 10, catWidth: 34, catFormat: (c) => c });

    const scopeSel = select({ label: "Stores", hideLabel: true, value: "ours", options: [{ value: "ours", label: "Our brands' stores" }, { value: "all", label: "Every store" }], onChange: (v) => { this.scope = v; this.#render(); } });
    const ut = card("Staff utilisation", { sub: "share of the day busy, by day", right: scopeSel.root });
    this.util = new LineChart(ut.body, { height: 170, format: (v) => fmt.pct(v), yMax: 1, legend: true, xFormat: (x) => `day ${x}`, tipTitle: (x) => `Day ${x}`, emptyText: "After the first day" });

    const fl = card("Size fill rate", { sub: "rack visits where the shopper's size was there (or fetched)" });
    this.fill = new LineChart(fl.body, { height: 170, format: (v) => fmt.pct(v), legend: true, xFormat: (x) => `day ${x}`, tipTitle: (x) => `Day ${x}`, emptyText: "After the first day" });

    this.brandSel = select({ label: "Brand", hideLabel: true, value: 1, options: [], onChange: (v) => { this.brand = Number(v); this.#render(); } });
    const brandSel = this.brandSel;
    const wf = card("Where the money went", { sub: "the season so far · rent and overheads left out", right: brandSel.root, cls: "span-2" });
    this.waterfall = new Waterfall(wf.body, { height: 210, format: fmt.money });
    this.leftNote = el("p", { class: "note" });
    wf.body.append(this.leftNote);

    const ct = card("Contribution by brand", { cls: "span-all" });
    this.contribBox = el("div", { class: "table-scroll" });
    ct.body.append(this.contribBox);

    grid.append(sat.root, dw.root, ut.root, fl.root, wf.root, ct.root);
    root.append(grid);
  }

  onGeometry(geo) {
    if (this.brand > geo.brands.length) this.brand = 1;
    this.brandSel.setOptions(this.app.brandOrder.map((b) => ({ value: b.index, label: b.name })), this.brand);
  }

  update(r) { this.r = r; this.#render(); }

  #render() {
    const r = this.r; if (!r) return;
    const o = r.outcomes; const total = o.reduce((a, b) => a + b, 0);
    this.satDonut.update({ slices: [{ name: "Paid", value: o[0], colour: "var(--good)" }, { name: "Left without buying", value: total - o[0], colour: "var(--critical)" }],
      centre: { value: fmt.pct(o[0] / Math.max(1, total), 0), label: "satisfied" } });
    this.reasons.update({ categories: r.outcome_names.slice(1), series: [{ name: "Visits", colour: "var(--critical)", values: o.slice(1) }] });

    const dw = r.dwell;
    this.dwellStats.replaceChildren(...[["Count", fmt.int(dw.n)], ["Mean", fmt.num1(dw.mean)], ["Min", fmt.num1(dw.min)], ["Max", fmt.num1(dw.max)], ["Std dev", fmt.num1(dw.sd)]]
      .map(([k, v]) => el("div", { class: "stat" }, el("div", { class: "stat-label", text: k }), el("div", { class: "stat-value", style: { fontSize: "15px" }, text: v }))));
    const bins = dw.bought.map((_, i) => (i === dw.bought.length - 1 ? `${i * dw.bin_min}+` : `${i * dw.bin_min}`));
    this.dwell.update({ categories: bins, series: [{ name: "Bought", colour: "var(--good)", values: dw.bought }, { name: "Didn't", colour: "var(--ink-2)", values: dw.not }] });

    const u = r.util[this.scope];
    const days = u.fitting.length;
    this.util.update(days ? { x: Array.from({ length: days }, (_, i) => i + 1), series: [
      { name: "Fitting rooms", colour: "var(--look-4)", values: u.fitting }, { name: "Tills", colour: "var(--look-3)", values: u.tills },
      { name: "Assistants", colour: "var(--accent)", values: u.assistants }] } : null);
    this.fill.update(r.fill.all.length ? { x: r.fill.all.map((_, i) => i + 1), series: [
      { name: "Our brands' stores", colour: "var(--ours)", values: r.fill.ours }, { name: "Every store", colour: "var(--ink-2)", values: r.fill.all }] } : null);

    const c = r.contribution[this.brand - 1] ?? r.contribution[0];
    this.waterfall.update({ steps: [
      { label: "Full-price value", value: c.full_price, total: true }, { label: "Markdowns and promotions", value: -c.discounts },
      { label: "Cost of goods", value: -c.cogs }, { label: "Staff", value: -c.staff }, { label: "Marketing", value: -c.marketing },
      ...(c.offers ? [{ label: "Offers", value: -c.offers }] : []), { label: "Logistics", value: -c.logistics },
      ...(c.written_down ? [{ label: "Stock write-down", value: -c.writedown }] : []), { label: "Contribution", value: c.contribution, total: true }] });
    const who = this.app.brandName(c.brand);
    this.leftNote.textContent = c.written_down
      ? `${who} ended the season with ${fmt.money(c.stock_left)} of stock left at cost, written down to the ${fmt.pct(c.salvage)} it fetches: ${fmt.money(c.writedown)} off its contribution. Logistics: ${fmt.int(c.deliveries)} store deliveries, ${fmt.int(c.shipped)} units shipped.`
      : `${who} has ${fmt.money(c.stock_left)} of stock left at cost (in its stores, on the way and at its DC). At the season's end what's left is written down to the ${fmt.pct(c.salvage)} of cost it fetches. Logistics so far: ${fmt.int(c.deliveries)} store deliveries, ${fmt.int(c.shipped)} units shipped.`;

    const cols = [["Brand", (x) => this.app.brandName(x.brand)], ["Sales", (x) => fmt.money(x.sales)], ["Given away", (x) => fmt.money(x.discounts)],
      ["Cost of goods", (x) => fmt.money(x.cogs)], ["Staff", (x) => fmt.money(x.staff)], ["Marketing", (x) => fmt.money(x.marketing)],
      ["Offers", (x) => fmt.money(x.offers)], ["Logistics", (x) => fmt.money(x.logistics)], ["Stock left at cost", (x) => fmt.money(x.stock_left)],
      ["Stock written down", (x) => (x.written_down ? fmt.money(x.writedown) : "at the end")],
      ["Contribution", (x) => fmt.money(x.contribution)], ["Margin", (x) => fmt.pct(x.contribution / Math.max(1, x.sales), 1)]];
    this.contribBox.replaceChildren(el("table", { class: "data" },
      el("thead", {}, el("tr", {}, ...cols.map(([h], i) => el("th", { class: i ? "num" : "", text: h })))),
      el("tbody", {}, ...this.app.brandOrder.map((b) => r.contribution[b.index - 1]).filter(Boolean).map((x) => el("tr", {}, ...cols.map(([, f], i) => {
        const td = el("td", { class: i ? "num" : "", text: f(x) });
        if (!i) td.prepend(el("i", { class: "legend-swatch", vars: { "--c": brandVar(x.brand) }, style: { display: "inline-block", marginRight: "6px" } }));
        return td;
      }))))));
  }
}
