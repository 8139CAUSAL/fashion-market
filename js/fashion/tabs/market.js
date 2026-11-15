// Market: the macro world, its brands and what each is doing to win the
// households. After the consumer-market picture: the promotions running
// today (each brand's calendar sets them, on the Setup tab's Range and
// calendar), households coloured by the brand they last bought from, one
// household's latent preference and its ledger (what it bought, paid and
// returned), and share, sales and revenue, net of refunds, in the stores
// and online. The brands' levers are on the Setup tab.

import { el, fmt, select, card, brandVar } from "../ui.js";
import { LineChart, BarChart, Donut, tooltip } from "../charts.js";
import { CityView } from "../city-view.js";
import { possessive } from "../entry-text.js";
import { ledgerView } from "../ledger-view.js";
import { ViewSwitch } from "../view-switch.js";
import { loadMarket3D } from "../three-loader.js";
import { CameraBar, targetSelect } from "../camera-bar.js";

const CAMERA_PRESETS = [
  { id: "overview", label: "Overview", title: "The whole market from above, as the 3D view opens" },
  { id: "neighborhood", label: "Neighborhood", title: "The area picked beside these buttons: its roads, stores, households and everyone out in it" },
  { id: "street", label: "Street", title: "Low, round the store picked beside these buttons: its storefront, streets, cars and walkers" },
];

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
    // The map in 2D (CityView) or 3D (Market3DView, made on first use): the
    // same installed world, the same frames, the same clicks.
    const onStore = (id) => app.openStore(id);
    const onHome = (x, y) => app.action("pick_home_at", { x: Math.round(x), y: Math.round(y) });
    const wrap = el("div", { class: "canvas-wrap map-wrap" });
    const wrap3d = el("div", { class: "canvas-wrap map-wrap view3d-wrap", hidden: true });
    this.shown = { geo: null, homes: null, codes: null, mode: "brand", stores: null, selected: null, travellers: null, caption: "" };
    this.dims = new ViewSwitch({ app, what: "Map", load: loadMarket3D,
      create: ({ THREE, Market3DView }) => {
        const v = new Market3DView(wrap3d, THREE, { onStore, onHome });
        const s = this.shown;
        if (s.geo) v.setGeometry(s.geo, s.homes, app.world.installed);
        if (s.codes) v.setHomes(s.codes, s.mode);
        if (s.stores) v.setStores(s.stores);
        if (s.selected) v.setSelected(s.selected);
        if (s.travellers) v.setTravellers(s.travellers);
        v.setCaption(s.caption);
        v.onCameraState = () => this.#camera();
        v.onCameraError = (err) => app.error("The 3D camera couldn't do that", err);
        this.#cameraTargets(v);
        return v;
      },
      apply: (is3d) => {
        wrap.hidden = is3d; wrap3d.hidden = !is3d;
        this.camBar.root.hidden = !is3d;
        if (is3d) this.#camera();
        // Back in 2D: the map catches up with everyone outdoors.
        if (!is3d && this.shown.travellers) this.map.setTravellers(this.shown.travellers);
      } });
    // The 3D camera: presets, Focus, and what they aim at. Nothing is picked
    // for the user; Focus aims at what was selected last (an area or store
    // picked here, or a household picked on the map), and says so.
    this.cam = { area: null, store: null, active: null, household: null, reported: new Set() };
    this.camBar = new CameraBar({ label: "Map camera", presets: CAMERA_PRESETS,
      onPreset: (id) => this.dims.view?.runAction(() => this.dims.view.goPreset(id, { area: this.cam.area, store: this.cam.store })),
      onFocus: () => this.dims.view?.runAction(() => this.dims.view.focus(this.cam.active)) });
    this.areaSel = targetSelect({ label: "Area", placeholder: "Pick an area…", onChange: (v) => this.#pick("area", v) });
    this.storeSel = targetSelect({ label: "Store", placeholder: "Pick a store…", onChange: (v) => this.#pick("store", v) });
    this.camBar.targets.append(this.areaSel.root, this.storeSel.root);
    const mapCard = card("The market", { sub: "click a store to open its floor · click a home to see that household",
      right: el("span", { class: "row" }, modeSel.root, this.offerSel.root, this.dims.root) });
    this.legendBox = el("div", { class: "map-legend" });
    mapCard.body.append(this.camBar.root, wrap, wrap3d, this.legendBox);
    this.map = new CityView(wrap, { onStore, onHome });
    // One household, beside the map it's picked from.
    const shopper = card("One household", {
      right: el("button", { type: "button", class: "btn small", text: "Pick a random household", onclick: () => app.action("pick_household") }),
    });
    this.shopperBox = el("div", { class: "shopper" }, el("p", { class: "empty", text: "Pick a household, or click a home on the map." }));
    shopper.body.append(this.shopperBox);
    top.append(el("div", { class: "grid" }, this.promoPanel.root, shopper.root), mapCard.root);
    // That household's ledger: what it bought, paid and returned.
    this.ledgerCard = card("What the household bought, and returned", { sub: "every item this season, newest first" });
    this.ledgerBox = el("div");
    this.ledgerCard.body.append(this.ledgerBox);
    this.ledgerCard.root.hidden = true;

    // Bottom row.
    const bottom = el("div", { class: "grid market-bottom" });
    const pie = card("Customers", { sub: "households by brand last bought" });
    this.donut = new Donut(pie.body, { height: 170, legend: true, emptyText: "No purchases yet" });
    const dyn2 = card("Sales dynamic", { sub: "each brand's share of the day's net sales" });
    this.shareChart = new LineChart(dyn2.body, { height: 170, stacked: true, normalize: true, format: (v) => fmt.pct(v), legend: true,
      xFormat: (x) => `day ${x}`, tipTitle: (x) => `Day ${x}`, emptyText: "Run the season to see sales" });
    this.revCard = card("Revenue this season", { sub: "net of refunds · in the stores and online" });
    this.revChart = new BarChart(this.revCard.body, { height: 170, format: fmt.money, valueLabels: true, stacked: true, legend: true, emptyText: "No sales yet" });
    this.revNote = el("p", { class: "note" });
    this.revCard.body.append(this.revNote);
    const rev = this.revCard;
    const wk = card("Weekly revenue", { sub: "net of refunds" });
    this.weekChart = new LineChart(wk.body, { height: 170, format: fmt.money, legend: true, xFormat: (x) => `wk ${x}`, tipTitle: (x) => `Week ${x}`, emptyText: "Run the season to see sales" });
    bottom.append(pie.root, dyn2.root, rev.root, wk.root);
    // Getting about: the day's outings, their store visits, and the parking.
    this.travelCard = card("Getting about", { sub: "outings, store visits and parking, today" });
    this.travelBox = el("div", { class: "travel" });
    this.travelCard.body.append(this.travelBox);
    root.append(top, this.ledgerCard.root, bottom, this.travelCard.root);
  }

  // ---- The 3D camera ------------------------------------------------------------------------

  // An area or store picked in the camera controls (null: none).
  #pick(kind, value) {
    this.cam[kind] = value;
    if (value !== null) this.cam.active = kind === "area" ? { kind, area: value } : { kind, store: value };
    else if (this.cam.active?.kind === kind) this.cam.active = null;
    this.#camera();
  }

  // The pickers' choices: the installed world's areas and stores (an area
  // with no tiles listed, but not pickable).
  #cameraTargets(v = this.dims.view) {
    if (!v) return;
    const t = v.cameraTargets();
    this.cam.area = this.areaSel.setOptions(t.areas.map((a) => ({ value: a.index, label: a.ok ? a.name : `${a.name} (no tiles)`, disabled: !a.ok, title: a.reason || undefined })), this.cam.area);
    const groups = [...(this.app.geometry?.areas ?? []).map((a, k) => ({ name: a.name, k: k + 1 })), { name: "Outside every area", k: 0 }];
    this.cam.store = this.storeSel.setOptions(groups.map((g) => ({ group: g.name, options: t.stores.filter((s) => s.area === g.k).map((s) => ({ value: s.index, label: s.name, disabled: !s.ok })) }))
      .filter((g) => g.options.length), this.cam.store);
    if (this.cam.active?.kind === "area" && this.cam.area === null) this.cam.active = null;
    if (this.cam.active?.kind === "store" && this.cam.store === null) this.cam.active = null;
    this.#camera();
  }

  // Which camera actions can run now, and what the camera shows.
  #camera() {
    const v = this.dims.view; if (!v || this.camBar.root.hidden) return;
    const avail = (id, r) => {
      if (r.defect && !this.cam.reported.has(r.reason)) { this.cam.reported.add(r.reason); this.app.error("A 3D camera target is wrong", new Error(r.reason)); }
      this.camBar.setAvailable(id, r.ok ? { ok: true } : { ok: false, reason: r.defect ? `Error: ${r.reason}` : r.reason });
    };
    const args = { area: this.cam.area, store: this.cam.store };
    for (const id of ["overview", "neighborhood", "street"]) avail(id, v.presetTarget(id, args));
    const f = v.focusTarget(this.cam.active);
    avail("focus", f);
    if (f.ok) this.camBar.setFocusTitle(`Turn the camera to ${f.label.replace(/^Focus · /, "")}, the last thing selected`);
    this.camBar.setState(v.cameraState);
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
    const road = el("span", {}, el("i", { class: "legend-swatch", vars: { "--c": "var(--ink-2)" } }), "car on the road (ringed), walker (small)");
    const parked = el("span", {}, el("i", { class: "legend-swatch square", vars: { "--c": "var(--map-car)" } }), "parked car");
    const lots = el("span", {}, el("i", { class: "legend-swatch square", vars: { "--c": "#3b6bb5" } }), "P lot, G garage");
    this.legendBox.replaceChildren(...items.map(([n, c]) => el("span", {}, el("i", { class: "legend-swatch", vars: { "--c": c } }), n)), storeKey, road, parked, lots);
  }

  viewState() { return { homesMode: this.mode, homesBrand: this.offerBrand }; }

  onGeometry(geo, homes) {
    const n = geo.brands.length;
    if (this.offerBrand > n) this.offerBrand = 1;
    const opts = this.app.brandOrder.map((b) => ({ value: b.index, label: b.name }));
    this.offerSel.setOptions(opts, this.offerBrand);
    this.map.setGeometry(geo, homes);
    Object.assign(this.shown, { geo, homes, codes: null, stores: null, selected: null, travellers: null });
    this.dims.view?.setGeometry(geo, homes, this.app.world.installed);
    // A new world: nothing picked for the camera in it yet.
    Object.assign(this.cam, { area: null, store: null, active: null, household: null });
    this.#cameraTargets();
    this.intro.textContent = `${n} brand${n === 1 ? "" : "s"} run ${geo.stores.length} stores across a market of ${fmt.int(geo.homes.n)} households${geo.areas.length ? ` in ${geo.areas.length} areas` : ""}. Every dot is a household, in the colour of the brand it last bought from. Press Go to play the season and watch shoppers drive to the stores, and back to return things. Online shoppers don't drive, so they aren't on the map.`;
    this.#legend();
  }
  onHomes(codes, mode, brand) {
    if (mode !== this.mode || (mode === "offer" && brand !== this.offerBrand)) return;
    this.map.setHomes(codes, mode);
    Object.assign(this.shown, { codes, mode });
    this.dims.view?.setHomes(codes, mode);
  }
  onFrame(frame) {
    if (this.app.tab !== "market") return;
    this.shown.travellers = frame.travellers;
    if (this.dims.is3d) this.dims.view.setTravellers(frame.travellers);
    else this.map.setTravellers(frame.travellers);
  }

  update(r) {
    const order = this.app.brandOrder;
    this.map.setStores(r.stores);
    const caption = this.app.header?.pace === "watch" ? `${fmt.int(this.app.header?.on_road)} shoppers out of doors` : `${r.day_label}'s visits shown by each store's halo`;
    this.map.setCaption(caption);
    Object.assign(this.shown, { stores: r.stores, caption });
    this.dims.view?.setStores(r.stores);
    this.dims.view?.setCaption(caption);
    this.#travel(r.travel);
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
    const online = (b) => r.revenue_online[b.index - 1];
    this.revChart.update({ categories: order.map((b) => b.name), series: [
      { name: "In the stores", colour: "var(--ink-2)", colours: order.map((b) => brandVar(b.index)), values: order.map((b) => r.revenue[b.index - 1] - online(b)) },
      { name: "Online", colour: "color-mix(in srgb, var(--ink-2) 45%, var(--surface))", colours: order.map((b) => `color-mix(in srgb, ${brandVar(b.index)} 45%, var(--surface))`), values: order.map(online) }] });
    const g = r.gross.reduce((a, x) => a + x, 0); const rf = r.refunds.reduce((a, x) => a + x, 0);
    this.revNote.textContent = g ? `Every brand: ${fmt.money(g)} sold, less ${fmt.money(rf)} refunded (${fmt.pct(rf / g, 1)}), is ${fmt.money(g - rf)}. A refund comes off on the day of the return.` : "";
    this.weekChart.update(r.weekly.length ? { x: r.weekly.map((_, i) => i + 1), series: series(r.weekly) } : null);
    this.#shopper(r.shopper);
  }

  // The day's journeys, and the parking, from the simulation's tallies.
  #travel(t) {
    if (!t) { this.travelBox.replaceChildren(el("p", { class: "empty", text: "Run the season to see the day's outings." })); return; }
    this.travelCard.setSub(`${t.day_label} · outings, store visits and parking`);
    const stat = (label, value, sub) => el("div", { class: "stat" }, el("div", { class: "stat-label", text: label }), el("div", { class: "stat-value", text: value }), sub ? el("div", { class: "stat-sub", text: sub }) : null);
    const visits = t.destination_visits + t.follow_on;
    const stops = t.stops.map((n, k) => (n ? `${n} with ${k}${k === t.stops.length - 1 ? "+" : ""}` : null)).filter(Boolean).join(", ");
    const table = t.parking.length ? el("table", { class: "table compact" },
      el("thead", {}, el("tr", {}, ...["Parking", "Spaces", "Now", "Most at once", "Parked", "Found it full"].map((h) => el("th", { text: h })))),
      el("tbody", {}, ...t.parking.map((f) => el("tr", {}, el("td", { text: `${f.name}` }), el("td", { text: fmt.int(f.spaces) }), el("td", { text: f.now === null || f.now === undefined ? "–" : fmt.int(f.now) }),
        el("td", { class: f.peak >= f.spaces ? "bad" : "", text: fmt.int(f.peak) }), el("td", { text: fmt.int(f.parked) }), el("td", { class: f.turned_away ? "bad" : "", text: fmt.int(f.turned_away) })))))
      : el("p", { class: "note bad", text: "No parking has been built in this world: no one can drive, so every outing is on foot." });
    this.travelBox.replaceChildren(
      el("div", { class: "stats" },
        stat("Outings home", fmt.int(t.outings), `${fmt.int(t.by_car)} by car, ${fmt.int(t.on_foot)} on foot`),
        stat("Households in stores", fmt.int(t.shoppers), "each counted once, however many stores"),
        stat("Store visits", fmt.int(visits), `${fmt.int(t.destination_visits)} the outing's destination, ${fmt.int(t.follow_on)} walked on to from another store`),
        stat("Purchases", fmt.int(t.purchases), "visits that paid")),
      el("p", { class: "note", text: `Shopping outings by how many stores they visited: ${stops || "none yet"}. How outings ended: ${t.ends.filter((e) => e.n).map((e) => `${e.reason} ${fmt.int(e.n)}`).join(", ") || "none home yet"}.` }),
      t.venues.length ? el("p", { class: "note", text: `Venues: ${t.venues.map((v) => `${v.name} ${fmt.int(v.visits)} visits (${fmt.int(v.follow_on)} walked on to)`).join("; ")}.` }) : null,
      table);
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
    this.shown.selected = { x: s.x, y: s.y };
    this.dims.view?.setSelected(this.shown.selected);
    // Another household picked: it's what Focus aims at now.
    if (s.id !== this.cam.household) { this.cam.household = s.id; this.cam.active = { kind: "household", id: s.id }; this.#camera(); }
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
      add("text", { x: L - 8, y: y + 13, "text-anchor": "end", class: "label-ink" }, `${br.name.length > 11 ? `${br.name.slice(0, 10)}…` : br.name}${b.online ? " ⌂" : ""}`);
      const x0 = X(Math.min(0, b.appeal)); const x1 = X(Math.max(0, b.appeal));
      const bar = add("rect", { x: x0, y: y + 3, width: Math.max(1, x1 - x0), height: 14, rx: 3, fill: brandVar(br.index), class: "mark" });
      add("text", { x: X(Math.max(0, b.appeal)) + 5, y: y + 14, class: "label-ink" }, fmt.num2(b.appeal) + (s.favourite === br.index ? "  ★" : ""));
      bar.addEventListener("pointermove", (ev) => tooltip.show(ev, b.online ? `${br.name} online · ${b.tier}` : `${b.store_name} · ${fmt.num1(b.km)} km · ${b.tier}`, [
        { colour: brandVar(br.index), value: fmt.num2(b.appeal), name: "appeal" },
        { value: fmt.num2(b.taste), name: "own taste for the brand" }, { value: fmt.num2(b.range), name: "what the brand sells" },
        { value: fmt.num2(b.loyalty), name: `loyalty (${b.tier})` },
        { value: fmt.num2(b.price), name: b.online ? "price, with the delivery charge" : "price" }, { value: fmt.num2(b.promotion), name: "promotion and marketing" },
        ...(b.online ? [] : [{ value: fmt.num2(b.distance), name: "trip" }]), { value: fmt.num2(b.memory), name: "memory of bad visits" },
        { value: fmt.num2(b.word_of_mouth), name: "word of mouth" }, { value: fmt.num2(b.store), name: b.online ? "shopping online, and the wait for delivery" : "the store's layout" },
        { value: fmt.num2(b.offers), name: "offers held" }, { value: fmt.num2(b.returns), name: "the return window" }]));
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
      el("div", { class: "stat-sub" }, `${s.reach.n} store${s.reach.n === 1 ? "" : "s"} within its ${fmt.num1(s.radius_km)} km radius${s.reach.online.length ? `, and ${s.reach.online.join(", ")} online (⌂: online is its best choice there)` : ""}${out.length ? ` · out of reach: ${out.join(", ")}` : ""}${nothing.length ? ` · selling nothing they like: ${nothing.join(", ")}` : ""}`),
      el("div", { class: "tier-chips" }, ...order.map((b) => el("span", { class: "chip", vars: { "--brand": brandVar(b.index) }, title: `Loyalty tier with ${b.name}` },
        el("i", { class: "dot" }), `${b.name}: ${s.brands[b.index - 1].tier}`))),
      fav ? el("p", { class: "note" }, `Leans to ${fav}${Number.isFinite(s.gap) ? ` by ${fmt.num2(s.gap)}: a rival gaining that much appeal (a promotion, a shorter trip, a bad visit to ${fav}) would switch them` : ""}. Each day's choice also carries a random taste.`)
        : el("p", { class: "note", text: "No store is within this household's reach: it's outside the market." }),
      ...s.offers.map((o) => el("div", { class: "badge live" }, `Holds ${possessive(this.app.brandName(o.brand))} ${o.name}: ${fmt.pct(o.depth)} off, until day ${o.until}`)),
      s.visits?.length ? el("div", { class: "story" }, ...s.visits.map((v) => el("div", {}, el("time", { text: `day ${v.day}` }), `${v.store}: ${v.outcome}${v.sales ? ` (${fmt.money2(v.sales)})` : ""}`))) : el("p", { class: "note", text: "No visits yet this season." }),
    ];
    box.replaceChildren(inReach.length ? svg : el("span"), ...lines.filter(Boolean));
    this.ledgerCard.root.hidden = false;
    this.ledgerCard.head.querySelector("h2").textContent = `Household #${s.id}: what it bought, and returned`;
    this.ledgerBox.replaceChildren(ledgerView(s.ledger, this.app));
  }
}
