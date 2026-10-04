// Market: the macro world, its brands and what each is doing to win the
// households. After the consumer-market picture: the promotions running
// today (each brand's calendar sets them, on the Setup tab's Range and
// calendar), households coloured by the brand they last bought from, one
// household's latent preference, and share, sales and revenue. The brands'
// levers are on the Setup tab.

import { el, fmt, select, card, brandVar } from "../ui.js";
import { LineChart, BarChart, Donut, tooltip } from "../charts.js";
import { CityView } from "../city-view.js";
import { possessive } from "../entry-text.js";

const MODES = [
  { value: "brand", label: "Brand last bought from" },
  { value: "segment", label: "Shopper segment" },
  { value: "offer", label: "Offers from…" },
  { value: "area", label: "Area" },
];

export class MarketTab {
  constructor(root, app) {
    this.app = app; this.mode = "brand"; this.offerBrand = 1;
    this.intro = el("p", { text: "Brands run stores across a market of households. Every dot is a household, in the colour of the brand it last bought from. Press Go to play the season and watch shoppers drive to the stores." });
    root.append(el("div", { class: "tab-intro" }, el("h1", { text: "Market" }), this.intro));

    const top = el("div", { class: "grid market-top" });
    // The promotions running today, read from the calendars.
    this.promoPanel = card("Promotions today", { sub: "a store marked % on the map has one on" });
    this.promoList = el("div", { class: "promo-today" });
    this.promoPanel.body.append(this.promoList,
      el("p", { class: "note", text: "Promotions are set on each brand's calendar: Setup → Range and calendar." }));

    // The map.
    const modeSel = select({ label: "Colour homes by", options: MODES, value: "brand", hideLabel: true, onChange: (v) => { this.mode = v; this.#modeChanged(); } });
    this.offerSel = select({ label: "Brand", options: [], value: 1, hideLabel: true, onChange: (v) => { this.offerBrand = Number(v); this.#modeChanged(); } });
    this.offerSel.root.hidden = true;
    const mapCard = card("The market", { sub: "click a store to open its floor · click a home to see that household",
      right: el("span", { class: "row" }, modeSel.root, this.offerSel.root) });
    const wrap = el("div", { class: "canvas-wrap map-wrap" });
    this.legendBox = el("div", { class: "map-legend" });
    mapCard.body.append(wrap, this.legendBox);
    this.map = new CityView(wrap, {
      onStore: (id) => app.openStore(id),
      onHome: (x, y) => app.action("pick_home_at", { x: Math.round(x), y: Math.round(y) }),
    });
    // One household, beside the map it's picked from.
    const shopper = card("Latent preference of one household", {
      right: el("button", { type: "button", class: "btn small", text: "Pick a random household", onclick: () => app.action("pick_household") }),
    });
    this.shopperBox = el("div", { class: "shopper" }, el("p", { class: "empty", text: "Pick a household, or click a home on the map." }));
    shopper.body.append(this.shopperBox);
    top.append(el("div", { class: "grid" }, this.promoPanel.root, shopper.root), mapCard.root);

    // Bottom row.
    const bottom = el("div", { class: "grid market-bottom" });
    const pie = card("Customers", { sub: "households by brand last bought" });
    this.donut = new Donut(pie.body, { height: 170, legend: true, emptyText: "No purchases yet" });
    const dyn2 = card("Sales dynamic", { sub: "each brand's share of the day's sales" });
    this.shareChart = new LineChart(dyn2.body, { height: 170, stacked: true, normalize: true, format: (v) => fmt.pct(v), legend: true,
      xFormat: (x) => `day ${x}`, tipTitle: (x) => `Day ${x}`, emptyText: "Run the season to see sales" });
    const rev = card("Revenue this season");
    this.revChart = new BarChart(rev.body, { height: 170, format: fmt.money, valueLabels: true, emptyText: "No sales yet" });
    const wk = card("Weekly revenue");
    this.weekChart = new LineChart(wk.body, { height: 170, format: fmt.money, legend: true, xFormat: (x) => `wk ${x}`, tipTitle: (x) => `Week ${x}`, emptyText: "Run the season to see sales" });
    bottom.append(pie.root, dyn2.root, rev.root, wk.root);
    root.append(top, bottom);
  }

  #modeChanged() {
    this.offerSel.root.hidden = this.mode !== "offer";
    this.#legend();
    this.app.view({ homesMode: this.mode, homesBrand: this.offerBrand });
  }

  #legend() {
    const g = this.app.geometry; if (!g) return;
    const items = {
      brand: [["Not bought yet", "var(--brand-0)"], ...this.app.brandOrder.map((b) => [b.name, brandVar(b.index)])],
      segment: g.segments.map((s, i) => [s.name, `var(--seg-${i + 1})`]),
      offer: [["In none of its offers today", "var(--brand-0)"], ["Held out", "var(--offer-0)"], ["Sent a coupon", "var(--offer-1)"], ["Used it", "var(--offer-2)"]],
      area: [["Outside every area", "var(--brand-0)"], ...g.areas.map((a) => [a.name, a.colour])],
    }[this.mode];
    const storeKey = el("span", {}, el("i", { class: "legend-swatch square", vars: { "--c": "var(--ink-2)" } }), "store (size: layout; halo: today's visits; % : promotion on)");
    const road = el("span", {}, el("i", { class: "legend-swatch", vars: { "--c": "var(--ink-2)" } }), "shopper on the road");
    this.legendBox.replaceChildren(...items.map(([n, c]) => el("span", {}, el("i", { class: "legend-swatch", vars: { "--c": c } }), n)), storeKey, road);
  }

  viewState() { return { homesMode: this.mode, homesBrand: this.offerBrand }; }

  onGeometry(geo, homes) {
    const n = geo.brands.length;
    if (this.offerBrand > n) this.offerBrand = 1;
    const opts = this.app.brandOrder.map((b) => ({ value: b.index, label: b.name }));
    this.offerSel.setOptions(opts, this.offerBrand);
    this.map.setGeometry(geo, homes);
    this.intro.textContent = `${n} brand${n === 1 ? "" : "s"} run ${geo.stores.length} stores across a market of ${fmt.int(geo.homes.n)} households${geo.areas.length ? ` in ${geo.areas.length} areas` : ""}. Every dot is a household, in the colour of the brand it last bought from. Press Go to play the season and watch shoppers drive to the stores.`;
    this.#legend();
  }
  onHomes(codes, mode, brand) { if (mode === this.mode && (mode !== "offer" || brand === this.offerBrand)) this.map.setHomes(codes, mode); }
  onFrame(frame) {
    if (this.app.tab !== "market") return;
    this.map.setTravellers(frame.travellers);
  }

  update(r) {
    const order = this.app.brandOrder;
    this.map.setStores(r.stores);
    this.map.setCaption(this.app.header?.pace === "watch" ? `${fmt.int(this.app.header?.on_road)} shoppers on the road` : `${r.day_label}'s visits shown by each store's halo`);
    this.#promotions(r.brands);

    const ours = r.customers.slice(1).reduce((a, v, i) => a + (this.app.brands[i]?.ours ? v : 0), 0);
    const all = r.customers.slice(1).reduce((a, b) => a + b, 0);
    this.donut.update({
      slices: [{ name: "Not bought yet", value: r.customers[0], colour: "var(--brand-0)", detail: "households" },
        ...order.map((b) => ({ name: b.name, value: r.customers[b.index], colour: brandVar(b.index), detail: `households · ${b.familyName}` }))],
      centre: { value: fmt.pct(ours / Math.max(1, all), 0), label: "ours, of customers" },
    });
    const days = r.sales_share.length;
    const series = (rows) => order.map((b) => ({ name: b.name, colour: brandVar(b.index), values: rows.map((row) => row[b.index - 1]) }));
    this.shareChart.update(days ? { x: r.sales_share.map((_, i) => i + 1), series: series(r.sales_share) } : null);
    this.revChart.update({ categories: order.map((b) => b.name), series: [{ name: "Revenue", colours: order.map((b) => brandVar(b.index)), values: order.map((b) => r.revenue[b.index - 1]) }] });
    this.weekChart.update(r.weekly.length ? { x: r.weekly.map((_, i) => i + 1), series: series(r.weekly) } : null);
    this.#shopper(r.shopper);
  }

  // Today's promotions, brand by brand (our family first), and the brands
  // with none.
  #promotions(brands) {
    const order = this.app.brandOrder;
    const on = order.filter((b) => brands[b.index - 1]?.on_today.length);
    const none = order.filter((b) => !brands[b.index - 1]?.on_today.length).map((b) => b.name);
    const day = this.app.header?.day;
    this.promoPanel.setSub(`${day ? `day ${day} · ` : ""}a store marked % on the map has one on`);
    this.promoList.replaceChildren(
      ...on.map((b) => el("div", { class: "promo-brand", vars: { "--brand": brandVar(b.index) } },
        el("div", { class: "brand-name" }, el("i", { class: "dot" }), b.name),
        el("ul", {}, ...brands[b.index - 1].on_today.map((p) => el("li", {}, el("b", { text: p.name }),
          `: ${fmt.pct(p.depth)} off ${p.on}; ${p.reach}; to day ${p.to}`))))),
      on.length ? (none.length ? el("p", { class: "sub", text: `None today at ${none.join(", ")}.` }) : null)
        : el("p", { class: "empty", text: "No promotions running today." }));
  }

  #shopper(s) {
    if (!s) return;
    this.map.setSelected({ x: s.x, y: s.y });
    const box = this.shopperBox;
    const order = this.app.brandOrder;
    const inReach = order.filter((b) => s.brands[b.index - 1].in_reach);
    const W = 300; const rowH = 26; const H = rowH * Math.max(1, inReach.length) + 30;
    const vals = inReach.map((b) => s.brands[b.index - 1].appeal);
    const lo = Math.min(0, s.outside, ...vals) - 0.3; const hi = Math.max(0, s.outside, ...vals) + 0.3;
    const L = 78; const X = (v) => L + ((v - lo) / (hi - lo)) * (W - L - 40);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "chart"); svg.style.height = `${H}px`; svg.style.width = "100%";
    const add = (tag, attrs, txt) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (txt !== undefined) n.textContent = txt; svg.append(n); return n; };
    add("line", { x1: X(0), x2: X(0), y1: 4, y2: H - 22, class: "axis-line" });
    inReach.forEach((br, i) => {
      const b = s.brands[br.index - 1];
      const y = 6 + i * rowH;
      add("text", { x: L - 8, y: y + 13, "text-anchor": "end", class: "label-ink" }, br.name.length > 11 ? `${br.name.slice(0, 10)}…` : br.name);
      const x0 = X(Math.min(0, b.appeal)); const x1 = X(Math.max(0, b.appeal));
      const bar = add("rect", { x: x0, y: y + 3, width: Math.max(1, x1 - x0), height: 14, rx: 3, fill: brandVar(br.index), class: "mark" });
      add("text", { x: X(Math.max(0, b.appeal)) + 5, y: y + 14, class: "label-ink" }, fmt.num2(b.appeal) + (s.favourite === br.index ? "  ★" : ""));
      bar.addEventListener("pointermove", (ev) => tooltip.show(ev, `${b.store_name} · ${fmt.num1(b.km)} km · ${b.tier}`, [
        { colour: brandVar(br.index), value: fmt.num2(b.appeal), name: "appeal" },
        { value: fmt.num2(b.taste), name: "own taste for the brand" }, { value: fmt.num2(b.range), name: "what the brand sells" },
        { value: fmt.num2(b.loyalty), name: `loyalty (${b.tier})` },
        { value: fmt.num2(b.price), name: "price" }, { value: fmt.num2(b.promotion), name: "promotion and marketing" },
        { value: fmt.num2(b.distance), name: "trip" }, { value: fmt.num2(b.memory), name: "memory of bad visits" },
        { value: fmt.num2(b.word_of_mouth), name: "word of mouth" }, { value: fmt.num2(b.store), name: "the store's layout" },
        { value: fmt.num2(b.offers), name: "offers held" }]));
      bar.addEventListener("pointerleave", () => tooltip.hide());
    });
    add("line", { x1: X(s.outside), x2: X(s.outside), y1: 2, y2: H - 22, stroke: "var(--ink-2)", "stroke-dasharray": "3 3" });
    add("text", { x: X(s.outside), y: H - 8, "text-anchor": "middle" }, "stay home");
    const fav = s.favourite ? this.app.brandName(s.favourite) : null;
    const nothing = order.filter((b) => s.brands[b.index - 1].sells_nothing).map((b) => b.name);
    const out = order.filter((b) => !s.brands[b.index - 1].in_reach && !s.brands[b.index - 1].sells_nothing).map((b) => b.name);
    const lines = [
      el("div", { class: "stat-sub" }, `Household #${s.id} · ${s.segment} · ${s.area} · size ${s.size}`),
      el("div", { class: "stat-sub" }, `Budget left ${fmt.money(s.budget_left)} of ${fmt.money(s.budget)} · last bought from ${s.last_brand ? this.app.brandName(s.last_brand) : "no one yet"}`),
      el("div", { class: "stat-sub" }, `${s.reach.n} store${s.reach.n === 1 ? "" : "s"} within its ${fmt.num1(s.radius_km)} km radius${out.length ? ` · out of reach: ${out.join(", ")}` : ""}${nothing.length ? ` · selling nothing they like: ${nothing.join(", ")}` : ""}`),
      el("div", { class: "tier-chips" }, ...order.map((b) => el("span", { class: "chip", vars: { "--brand": brandVar(b.index) }, title: `Loyalty tier with ${b.name}` },
        el("i", { class: "dot" }), `${b.name}: ${s.brands[b.index - 1].tier}`))),
      fav ? el("p", { class: "note" }, `Leans to ${fav}${Number.isFinite(s.gap) ? ` by ${fmt.num2(s.gap)}: a rival gaining that much appeal (a promotion, a shorter trip, a bad visit to ${fav}) would switch them` : ""}. Each day's choice also carries a random taste.`)
        : el("p", { class: "note", text: "No store is within this household's reach: it's outside the market." }),
      ...s.offers.map((o) => el("div", { class: "badge live" }, `Holds ${possessive(this.app.brandName(o.brand))} ${o.name}: ${fmt.pct(o.depth)} off, until day ${o.until}`)),
      s.visits?.length ? el("div", { class: "story" }, ...s.visits.map((v) => el("div", {}, el("time", { text: `day ${v.day}` }), `${v.store}: ${v.outcome}${v.sales ? ` (${fmt.money2(v.sales)})` : ""}`))) : el("p", { class: "note", text: "No visits yet this season." }),
    ];
    box.replaceChildren(inReach.length ? svg : el("span"), ...lines.filter(Boolean));
  }
}
