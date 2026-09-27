// Strategy: our family's levers set against the competition's (set on the
// Setup tab), and what they're doing to share, revenue and spend per
// customer. After the strategy-control picture: our bars beside the
// competitors' average, the market share history as a stacked area
// (addressable, ours, other), and revenue per customer with its history.

import { el, fmt, card, brandVar, formatOf } from "../ui.js";
import { LineChart, BarChart, Donut } from "../charts.js";

const SHORT = { price: "Price position", promo_depth: "Promotion depth", ad: "Marketing reach", cashiers: "Cashiers / store", assistants: "Assistants / store" };

export class StrategyTab {
  constructor(root, app) {
    this.app = app;
    this.intro = el("p", { text: "Our brands' levers against the competition's average, and what they buy: share of the market, revenue, spend per customer, and each segment's wallet." });
    root.append(el("div", { class: "tab-intro" }, el("h1", { text: "Strategy" }), this.intro));

    const top = el("div", { class: "grid strategy-top" });
    const levers = card("Strategy control", { sub: "our brands' average beside the competitors' · set on the Setup tab" });
    this.cols = el("div", { class: "lever-columns" });
    levers.body.append(this.cols);
    this.columns = new Map();
    const market = card("The market");
    const inner = el("div", { class: "grid", style: { gridTemplateColumns: "minmax(140px, 0.6fr) minmax(0, 1.4fr)", alignItems: "start" } });
    const users = el("div"); const hist = el("div");
    users.append(el("div", { class: "card-head" }, el("h2", { text: "Customers" }), el("span", { class: "sub", text: "households that have bought" })));
    hist.append(el("div", { class: "card-head" }, el("h2", { text: "Market share history" }), el("span", { class: "sub", text: "of households in the market each day" })));
    this.users = new Donut(users, { height: 160, legend: true, emptyText: "No customers yet" });
    this.share = new LineChart(hist, { height: 190, stacked: true, normalize: true, legend: true, format: (v) => fmt.pct(v),
      xFormat: (x) => `day ${x}`, tipTitle: (x) => `Day ${x}`, emptyText: "Run the season to see the history" });
    inner.append(users, hist);
    market.body.append(inner);
    top.append(levers.root, market.root);

    const bottom = el("div", { class: "grid strategy-bottom" });
    const rev = card("Total revenue", { sub: "this season" });
    this.revenue = new BarChart(rev.body, { height: 180, format: fmt.money, valueLabels: true });
    const spc = card("Spend per customer", { sub: "season revenue ÷ customers, by brand" });
    this.spend = new BarChart(spc.body, { height: 180, format: fmt.money, valueLabels: true, catWidth: 60 });
    const hr = card("Average receipt history", { sub: "by week" });
    this.receipt = new LineChart(hr.body, { height: 180, format: fmt.money, legend: true, endLabels: true, xFormat: (x) => `wk ${x}`, tipTitle: (x) => `Week ${x}`, emptyText: "Run the season to see receipts" });
    const wal = card("Share of wallet", { sub: "each segment's season budget: where it went" });
    this.wallet = new BarChart(wal.body, { height: 180, horizontal: true, stacked: true, labelWidth: 112, format: fmt.money, tipFormat: fmt.money, legend: true });
    bottom.append(rev.root, spc.root, hr.root, wal.root);
    root.append(top, bottom);
  }

  onGeometry() {
    const ours = this.app.brandOrder.filter((b) => b.ours).map((b) => b.name);
    this.intro.textContent = `${this.app.oursName} (${ours.join(", ")}) against the competition: our brands' levers beside the competitors' average, and what they buy — share of the market, revenue, spend per customer, and each segment's wallet.`;
  }

  #column(lv) {
    if (this.columns.has(lv.name)) return this.columns.get(lv.name);
    const f = formatOf(lv.format);
    const bar = (label, colour) => {
      const fill = el("div", { class: "bar-fill", vars: { "--c": colour } });
      const val = el("div", { class: "bar-val" });
      return { root: el("div", { class: "bar-wrap" }, val, el("div", { class: "bar-track" }, fill), el("div", { class: "bar-cap", text: label })), fill, val };
    };
    const comp = bar("Competitors", "var(--ink-2)"); const ours = bar("Ours", "var(--ours)");
    const col = el("div", { class: "lever-col" }, el("h3", { text: SHORT[lv.name] ?? lv.label }), el("div", { class: "pair" }, comp.root, ours.root));
    this.cols.append(col);
    const c = { comp, ours, f };
    this.columns.set(lv.name, c);
    return c;
  }

  update(r) {
    const order = this.app.brandOrder;
    const oursName = this.app.oursName;
    for (const lv of r.levers) {
      const c = this.#column(lv);
      const pct = (v) => (Number.isFinite(v) ? `${Math.max(2, (100 * (v - lv.min)) / (lv.max - lv.min))}%` : "0%");
      c.comp.fill.style.height = pct(lv.competitors); c.comp.val.textContent = c.f(lv.competitors);
      c.ours.fill.style.height = pct(lv.ours); c.ours.val.textContent = c.f(lv.ours);
    }
    const cust = r.customers;
    this.users.update({ slices: [{ name: `Bought from ${oursName}`, value: cust.ours, colour: "var(--ours)" }, { name: "Only from competitors", value: cust.rivals_only, colour: "var(--ink-2)" }],
      centre: { value: fmt.pct(cust.ours / Math.max(1, cust.ours + cust.rivals_only), 0), label: "ours" } });
    const h = r.share_history;
    this.share.update(h.length ? { x: h.map((_, i) => i + 1), series: [
      { name: "Addressable (bought nothing)", colour: "var(--cat-4)", values: h.map((row) => row[2]) },
      { name: oursName, colour: "var(--ours)", values: h.map((row) => row[0]) },
      { name: "Other brands", colour: "var(--ink-2)", values: h.map((row) => row[1]) },
    ] } : null);
    this.revenue.update({ categories: [oursName, "Competitors"], series: [{ name: "Revenue", colours: ["var(--ours)", "var(--ink-2)"], values: [r.revenue.ours, r.revenue.competitors] }] });
    this.spend.update({ categories: order.map((b) => b.name), series: [{ name: "Spend per customer", colours: order.map((b) => brandVar(b.index)), values: order.map((b) => r.spend_per_customer.by_brand[b.index - 1]) }] });
    const rh = r.receipt_history;
    this.receipt.update(rh.length ? { x: rh.map((_, i) => i + 1), series: [
      { name: oursName, short: "ours", colour: "var(--ours)", values: rh.map((w) => w.ours ?? w[0]) },
      { name: "Competitors", short: "rivals", colour: "var(--ink-2)", values: rh.map((w) => w.competitors ?? w[1]) },
    ] } : null);
    this.wallet.update({ categories: r.wallet.map((w) => w.segment), series: [
      ...order.map((b) => ({ name: b.name, colour: brandVar(b.index), values: r.wallet.map((w) => w.spend[b.index - 1]) })),
      { name: "Not spent yet", colour: "var(--surface-3)", values: r.wallet.map((w) => Math.max(0, w.budget - w.spend.reduce((a, x) => a + x, 0))) },
    ] });
  }
}
