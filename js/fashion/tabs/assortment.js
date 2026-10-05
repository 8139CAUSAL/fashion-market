// Assortment: the supply-chain half. Each brand's calendar as the season has
// run it and as it's planned (promotions, markdowns and what each took,
// replenishment and what each order sent, products landing), its products
// through their season (on order, full price, markdown, clearance, sold
// through), which sizes are on the floor, sell-through (net of returns)
// against cover, and where the stock is (returns included: with shoppers,
// back in stock, written off), with the brand's stock rules told from its
// own calendar and settings (they're set on the Setup tab). After the
// product-portfolio picture: a lifecycle pipeline of bubbles, colour by
// category, size by revenue.

import { el, fmt, select, card, stats } from "../ui.js";
import { Scatter, LineChart, heatTable, tooltip } from "../charts.js";
import { drawCalendar } from "../calendar-chart.js";
import { stockStory, plural } from "../entry-text.js";

const NS = "http://www.w3.org/2000/svg";

export class AssortmentTab {
  constructor(root, app) {
    this.app = app; this.brand = 1; this.category = 0; this.sort = { key: "revenue", dir: -1 };
    root.append(el("div", { class: "tab-intro" }, el("h1", { text: "Assortment" }),
      el("p", { text: "Each brand buys its season up front, holds it at a distribution centre, and sends it to its stores by size; its online store sells straight from the DC. Shoppers only take their own size, and each area runs to different sizes, so how the stock is split decides who finds nothing on the rack. A returned item goes back into the stock of the store it's returned to (or the DC), unless it's written off, and sells again: sold here is net of returns." })));
    this.brandSel = select({ label: "Brand", value: 1, options: [], onChange: (v) => { this.brand = Number(v); app.view({ brand: this.brand }); } });
    this.catSel = select({ label: "Category", value: 0, options: [{ value: 0, label: "Every category" }], onChange: (v) => { this.category = Number(v); this.#render(); } });
    root.append(el("div", { class: "filters" }, this.brandSel.root, this.catSel.root));

    const cal = card("Calendar", { sub: "the season so far and planned: promotions, markdowns, replenishment, products landing · hover a tick for what it did" });
    this.calBox = el("div", { class: "calendar-box" });
    cal.body.append(this.calBox);
    const life = card("Product lifecycle", { sub: "bubbles are products · colour: category · size: full-price value sold, net of returns · height: sell-through" });
    this.lifeBox = el("div", { class: "chart" });
    this.lifeLegend = el("div", { class: "legend" });
    life.body.append(this.lifeBox, this.lifeLegend);
    root.append(el("div", { class: "grid assort-top" }, cal.root, life.root));

    const mid = el("div", { class: "grid assort-mid" });
    const av = card("Sizes on the floor", { sub: "share of the brand's stores with the size on a rack, by category" });
    this.availBox = el("div");
    av.body.append(this.availBox);
    const sc = card("Sell-through against cover", { sub: "each product: sold, net of returns, against the stock left in weeks of recent demand" });
    this.scatter = new Scatter(sc.body, { height: 230, xFormat: fmt.num1, yFormat: (v) => fmt.pct(v), xLabel: "weeks of cover", emptyText: "Products appear once they're in the stores" });
    const rules = card("Stock", { sub: "for the brand above · its rules are set on the Setup tab" });
    const tbox = el("div", { class: "stats" });
    this.totals = stats(tbox, [{ key: "bought", label: "Bought" }, { key: "sold", label: "Sold", title: "Units sold, in the stores and online, before returns" },
      { key: "returned", label: "Returned" }, { key: "net", label: "Sold, net of returns" },
      { key: "stores", label: "In stores" }, { key: "dc", label: "At the DC" }, { key: "transit", label: "On the way to stores" },
      { key: "shoppers", label: "With shoppers", title: "Sold and not returned: on the way to an online shopper, with a shopper and still returnable, or kept" },
      { key: "back", label: "Back in stock", title: "Returned and put back in a store's stock or the DC's: counted in the stores or at the DC too" },
      { key: "written_off", label: "Written off", title: "Returned too worn or damaged to sell again" },
      { key: "lost", label: "Asked for, not in size" }]);
    this.fillBox = el("div");
    this.fill = new LineChart(this.fillBox, { height: 110, format: (v) => fmt.pct(v), yMax: 1, xFormat: (x) => `day ${x}`, tipTitle: (x) => `Day ${x}`, emptyText: "After the first day" });
    this.storyBox = el("div", { class: "stock-story" });
    rules.body.append(tbox,
      el("div", { class: "card-head", style: { marginTop: "10px" } }, el("h2", { text: "Size fill rate" }), el("span", { class: "sub", text: "requests met in the shopper's size" })), this.fillBox,
      this.storyBox);
    mid.append(av.root, sc.root, rules.root);
    root.append(mid);

    const tab = card("Products", { sub: "click a column to sort" });
    this.tableBox = el("div", { class: "table-scroll" });
    tab.body.append(this.tableBox);
    root.append(tab.root);
  }

  viewState() { return { brand: this.brand }; }

  onGeometry(geo) {
    if (this.brand > geo.brands.length) this.brand = 1;
    this.brandSel.setOptions(this.app.brandOrder.map((b) => ({ value: b.index, label: b.name })), this.brand);
  }

  update(r) {
    if (r.brand !== this.brand) return;
    this.r = r;
    const catKey = `${r.brand}:${r.sells.join(",")}:${r.categories.join(",")}`;
    if (catKey !== this.catKey) {
      this.catKey = catKey;
      if (!r.sells.includes(this.category)) this.category = 0;
      this.catSel.setOptions([{ value: 0, label: "Every category" }, ...r.sells.map((k) => ({ value: k, label: r.categories[k - 1] }))], this.category);
    }
    const t = r.totals;
    this.totals.update({ bought: fmt.compact(t.bought), sold: { value: fmt.compact(t.sold), sub: r.online ? `${fmt.compact(t.sold_online)} online` : "" },
      returned: { value: fmt.compact(t.returned), sub: t.sold ? fmt.pct(t.returned / t.sold, 1) : "" }, net: fmt.compact(t.net_sold),
      stores: fmt.compact(t.in_stores), dc: fmt.compact(t.at_dc), transit: fmt.compact(t.in_transit),
      shoppers: { value: fmt.compact(t.with_shoppers), sub: `${fmt.compact(t.returnable)} returnable${t.on_the_way ? `, ${fmt.compact(t.on_the_way)} on the way` : ""}, ${fmt.compact(t.kept)} kept` },
      back: fmt.compact(t.back_in_stock), written_off: fmt.compact(t.written_off), lost: fmt.compact(t.lost) });
    this.fill.update(r.fill.length ? { x: r.fill.map((_, i) => i + 1), series: [{ name: "Fill rate", colour: `var(--brand-${r.brand})`, values: r.fill }] } : null);
    heatTable(this.availBox, { rows: r.sells.map((k) => r.categories[k - 1]), cols: r.sizes, values: r.availability, title: "Category" });
    this.#calendar(r);
    this.#story(r);
    this.#render();
  }

  // The brand's stock rules, told from its calendar and settings in the
  // world that's running.
  #story(r) {
    const w = this.app.world.installed; const b = w?.brands[r.brand - 1];
    if (!b) { this.storyBox.replaceChildren(); return; }
    const key = JSON.stringify([b.stock, b.pricing, b.calendar.replenishment, b.calendar.markdowns, b.name]);
    if (key === this.storyKey) return;
    this.storyKey = key;
    this.storyBox.replaceChildren(...stockStory(b, w).flatMap((s) => [el("h3", { text: s.heading }), ...s.lines.map((t) => el("p", { text: t }))]));
  }

  #render() {
    const r = this.r; if (!r) return;
    const styles = r.products.filter((s) => !this.category || s.category === this.category);
    this.lifeLegend.replaceChildren(...r.sells.map((k) => el("span", {}, el("i", { class: "legend-swatch", vars: { "--c": `var(--cat-${k})` } }), r.categories[k - 1])));
    this.#lifecycle(r, styles);
    this.scatter.update({ points: styles.filter((s) => s.state !== "On order" && Number.isFinite(s.cover)).map((s) => ({
      x: Math.min(s.cover, 20), y: s.sell_through, r: 4 + 8 * Math.sqrt(s.revenue / Math.max(1, ...r.products.map((x) => x.revenue))),
      colour: `var(--cat-${s.category})`, label: s.name,
      rows: [{ colour: `var(--cat-${s.category})`, value: fmt.pct(s.sell_through), name: "sold through" }, { value: fmt.num1(s.cover), name: "weeks of cover" }, { value: s.state, name: "" }],
    })) });
    this.#table(styles);
  }

  // The brand's calendar as the season has run it, and as it's planned. A
  // day an entry has acted on is solid, with what it did; a day to come is
  // lighter. A markdown that changed no price says why.
  #calendar(r) {
    const c = r.calendar; const colour = `var(--brand-${r.brand})`;
    const from = { plan: "planned" };
    const past = (day) => day <= c.today;
    const mdTicks = (m) => m.days.map((day) => {
      const x = m.done.find((t) => t.day === day);
      if (!x) return { day, state: past(day) ? undefined : "future", title: `${m.name}: day ${day}`, rows: [{ value: "", name: past(day) ? "not run" : "to come" }] };
      const depth = m.mode === "to" ? fmt.pct(m.depth) : `${Math.round(100 * m.depth)} pts deeper, to at most ${fmt.pct(m.max)}`;
      const why = [[x.took, "taken"], [x.deeper, "already that deep or deeper"], [x.on_plan, "on plan"], [x.too_new, "too new to judge"],
        [x.rested, "resting from a recent markdown"], [x.not_in, "not in the stores yet"]]
        .filter(([n], i) => n > 0 || i === 0).map(([n, name]) => ({ value: fmt.int(n), name }));
      return { day, state: "done", title: `${m.name} · day ${day} · ${depth}`, rows: why };
    });
    const rpTicks = (e) => e.days.map((day) => {
      const x = e.done.find((t) => t.day === day);
      if (!x) return { day, state: past(day) ? undefined : "future", title: `${e.name}: day ${day}`, rows: [{ value: "", name: past(day) ? "not run" : "to come" }] };
      return { day, state: "done", title: `${e.name} · day ${day}`, rows: x.units > 0
        ? [{ value: fmt.int(x.units), name: `units sent, arriving on day ${x.arrive}` }] : [{ value: "0", name: "units sent" }] };
    });
    const rows = [
      { label: "Promotions", bars: c.promotions.map((p) => ({ name: p.name, from: p.from, to: p.to, depth: p.depth, colour, note: `on ${p.on}; ${p.reach}; ${from[p.source] ?? p.source}` })) },
      { label: "Markdowns", steps: c.markdowns.map((m) => ({ name: m.name, from: m.from, depth: m.mode === "to" ? m.depth : m.max,
        label: `${m.mode === "to" ? fmt.pct(m.depth) : `+${Math.round(100 * m.depth)} pts to ${fmt.pct(m.max)}`} ${m.name}`,
        note: `on ${m.on}; ${m.which === "behind" ? "the products behind plan" : "every product"}; ${plural(m.days.length, "day")} it acts`, ticks: mdTicks(m) })) },
      { label: "Replenishment", bands: c.replenishment.map((e) => ({ name: e.name, from: e.from, to: e.to, colour,
        note: `on ${e.on}; ${e.rule === "replace" ? "replace what sold" : "top up to cover"}; ${plural(e.days.length, "order day")}`, ticks: rpTicks(e) })) },
      { label: "Products landing", marks: c.lands.map((l) => ({ day: l.day, names: l.names })) },
    ];
    drawCalendar(this.calBox, { days: c.days, today: c.today, rows });
  }

  #lifecycle(r, styles) {
    const W = Math.max(700, this.lifeBox.clientWidth || 1000); const H = 250;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.style.width = "100%"; svg.style.height = `${H}px`;
    const add = (tag, attrs, txt) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (txt !== undefined) n.textContent = txt; svg.append(n); return n; };
    const lanes = r.states; const gap = 34; const laneW = (W - gap * (lanes.length - 1)) / lanes.length;
    const top = 40; const bottom = H - 10;
    const maxRev = Math.max(1, ...r.products.map((s) => s.revenue));
    lanes.forEach((name, i) => {
      const x = i * (laneW + gap);
      add("rect", { x, y: top, width: laneW, height: bottom - top, rx: 8, fill: "var(--surface-2)" });
      add("text", { x: x + 10, y: 22, class: "label-ink", style: "font-weight:650;font-size:12px" }, name);
      add("text", { x: x + laneW - 10, y: 22, "text-anchor": "end", class: "value-ink" }, fmt.int(r.counts[name] ?? 0));
      for (const [f, lbl] of [[0, "0%"], [0.5, "50%"], [1, "100%"]]) {
        const y = bottom - 12 - f * (bottom - top - 24);
        add("line", { x1: x + 4, x2: x + laneW - 4, y1: y, y2: y, class: "grid-line" });
        if (i === 0) add("text", { x: x + 4, y: y - 3 }, lbl);
      }
      if (i < lanes.length - 1) {
        const ax = x + laneW + 4;
        add("path", { d: `M${ax},${(top + bottom) / 2 - 12}L${ax + gap - 8},${(top + bottom) / 2}L${ax},${(top + bottom) / 2 + 12}Z`, fill: "var(--axis)" });
      }
      const here = styles.filter((s) => s.state === name);
      here.forEach((s, j) => {
        const rr = 4 + 12 * Math.sqrt(s.revenue / maxRev);
        const cx = x + 16 + ((j * 37) % Math.max(1, laneW - 32)) + (j % 2) * 6;
        const cy = bottom - 12 - s.sell_through * (bottom - top - 24);
        const c = add("circle", { cx, cy, r: rr, fill: `var(--cat-${s.category})`, "fill-opacity": 0.8, stroke: "var(--surface)", "stroke-width": 2, class: "mark" });
        c.addEventListener("pointermove", (ev) => tooltip.show(ev, s.name, [
          { colour: `var(--cat-${s.category})`, value: fmt.pct(s.sell_through), name: "sold through" },
          { value: fmt.money2(s.price), name: s.markdown > 0 ? `now (${fmt.pct(s.markdown)} off ${fmt.money2(s.full_price)})` : "full price" },
          { value: fmt.int(s.net_sold), name: `sold, net of ${fmt.int(s.returned)} returned, of ${fmt.int(s.bought)} bought` },
          { value: fmt.int(s.lost), name: "asked for in a size that wasn't there" },
          { value: `day ${s.day}`, name: "in the stores from" }]));
        c.addEventListener("pointerleave", () => tooltip.hide());
      });
    });
    this.lifeBox.replaceChildren(svg);
  }

  #table(styles) {
    const cols = [
      ["name", "Product", (s) => s.name], ["state", "State", (s) => s.state], ["day", "Lands", (s) => `day ${s.day}`, true],
      ["full_price", "Full price", (s) => fmt.money2(s.full_price), true], ["price", "Price now", (s) => fmt.money2(s.price), true],
      ["bought", "Bought", (s) => fmt.int(s.bought), true], ["sold", "Sold", (s) => fmt.int(s.sold), true],
      ["sold_online", "Of which online", (s) => fmt.int(s.sold_online), true], ["returned", "Returned", (s) => fmt.int(s.returned), true],
      ["return_rate", "Return rate", (s) => fmt.pct(s.return_rate, 1), true], ["refunds", "Refunds", (s) => fmt.money(s.refunds), true],
      ["in_stores", "In stores", (s) => fmt.int(s.in_stores), true], ["at_dc", "At DC", (s) => fmt.int(s.at_dc), true],
      ["sell_through", "Sell-through (net)", (s) => fmt.pct(s.sell_through), true], ["lost", "Not in size", (s) => fmt.int(s.lost), true],
      ["cover", "Weeks of cover", (s) => fmt.num1(s.cover), true], ["revenue", "Net sold at full price", (s) => fmt.money(s.revenue), true],
    ];
    const { key, dir } = this.sort;
    const sorted = [...styles].sort((a, b) => {
      const x = a[key]; const y = b[key];
      if (typeof x === "string") return dir * x.localeCompare(y);
      return dir * ((Number.isFinite(x) ? x : -Infinity) - (Number.isFinite(y) ? y : -Infinity));
    });
    const table = el("table", { class: "data" },
      el("thead", {}, el("tr", {}, ...cols.map(([k, h, , num]) => el("th", { class: `sortable${num ? " num" : ""}`, text: h + (k === key ? (dir > 0 ? " ▲" : " ▼") : ""),
        onclick: () => { this.sort = { key: k, dir: k === key ? -dir : -1 }; this.#table(styles); } })))),
      el("tbody", {}, ...sorted.map((s) => el("tr", {}, ...cols.map(([, , f, num], i) => {
        const td = el("td", { class: num ? "num" : "", text: f(s) });
        if (i === 0) td.prepend(el("i", { class: "legend-swatch", vars: { "--c": `var(--cat-${s.category})` }, style: { display: "inline-block", marginRight: "6px" } }));
        return td;
      })))));
    this.tableBox.replaceChildren(table);
  }
}
