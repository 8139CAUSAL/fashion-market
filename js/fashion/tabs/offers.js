// Offers: each brand's offers, named coupons on its calendar (set on the
// Setup tab), measured as a brand measures them: the households sent one
// against the households held out, drawn from the same audience at random,
// over the offer's days. Every number comes from the purchases logged
// against the offer, never from the simulation's hidden response: extra
// spend and margin per household, by tier, and where the extra spend came
// from (the brand itself, the other brands the coupon is good at, its
// sister brands, its competitors). Below, the brand's loyalty tiers: who
// has kept theirs this season, moved up, or not re-qualified yet.

import { el, fmt, select, card, stats, brandVar } from "../ui.js";
import { LineChart, BarChart, tooltip, niceTicks } from "../charts.js";
import { possessive } from "../entry-text.js";

const RELATION = { self: "the brand itself", sister: "sister brand", competitor: "competitor" };
const STATE = { planned: "planned", running: "running", closed: "closed" };
const MOVE_COLOURS = ["var(--tier-up)", "var(--tier-kept)", "var(--tier-down)"];

export class OffersTab {
  constructor(root, app) {
    this.app = app; this.brand = 1; this.pick = 0;
    root.append(el("div", { class: "tab-intro" }, el("h1", { text: "Offers" }),
      el("p", { text: "Each brand's offers: named coupons on its calendar (Setup, Offers). An offer is sent to a random share of the households it reaches, and a random share of those is held out and sent nothing. What an offer earned is what the households sent it spent beyond those held out, over its days, measured from their purchases alone. Below, the brand's loyalty tiers, earned by spend: who has kept theirs this season, who moved up, and who hasn't re-qualified yet." })));

    this.brandSel = select({ label: "Brand", value: 1, options: [], onChange: (v) => { this.brand = Number(v); this.chosen = true; this.pick = 0; this.#view(); } });
    this.offerSel = select({ label: "Offer", value: 0, options: [], onChange: (v) => { this.pick = Number(v); this.#view(); } });
    root.append(el("div", { class: "filters" }, this.brandSel.root, this.offerSel.root));

    const top = el("div", { class: "grid offers-top" });
    this.kpiCard = card("This season's offers");
    const kpis = el("div", { class: "stats" });
    this.kpi = stats(kpis, [
      { key: "run", label: "Offers sent" }, { key: "sent", label: "Coupons sent", title: "One per household in each offer it was sent: a household sent two offers counts twice" },
      { key: "used", label: "Coupons used" }, { key: "send", label: "Cost of sending" },
      { key: "discount", label: "Discount given", title: "What the coupons took off purchases: already out of sales and margin" },
      { key: "extra_sales", label: "Extra sales", title: "Spend per household sent, less spend per household held out, times the households sent" },
      { key: "extra_margin", label: "Extra margin", title: "Margin (sales less cost of goods) per household sent, less per household held out, times the households sent, less the cost of sending" },
    ]);
    this.kpiNote = el("p", { class: "note" });
    this.kpiCard.body.append(kpis, this.kpiNote);

    this.curveCard = card("Spend per household, sent against held out");
    this.curve = new LineChart(this.curveCard.body, { height: 220, format: fmt.money2, legend: true, xFormat: (x) => `day ${x}`, tipTitle: (x) => `By the end of day ${x}`,
      emptyText: "Once the offer has been sent" });
    this.curveNote = el("p", { class: "note" });
    this.curveCard.body.append(this.curveNote);
    top.append(this.kpiCard.root, this.curveCard.root);

    const list = card("Every offer, sent against held out", { sub: "per household over each offer's days, at the brands its coupon is good at · click an offer to see it in detail" });
    this.listBox = el("div", { class: "table-scroll" });
    list.body.append(this.listBox, el("p", { class: "note", text: "Extra per household is what a household sent the coupon spent, beyond one held out, with its 95% interval: an interval across zero can't tell the offer from chance. Spend lift is that extra as a share of what a household held out spent. Extra margin counts margin (sales less cost of goods, so the discount is already in it) and takes off the cost of sending." }));
    root.append(top, el("div", { class: "grid" }, list.root));

    const mid = el("div", { class: "grid offers-mid" });
    this.tierCard = card("Extra spend per household sent, by tier", { sub: "their tier when the offer was sent, 95% interval" });
    this.tierChart = new BarChart(this.tierCard.body, { height: 220, format: fmt.money2, whiskers: true, tipFormat: fmt.money2, emptyText: "Once the offer has been sent" });
    this.srcCard = card("Where the extra spend came from", { sub: "spend per household at every brand over the offer's days, sent against held out, 95% interval", cls: "span-2" });
    this.srcChart = el("div", { class: "chart" });
    this.srcBox = el("div", { class: "table-scroll" });
    this.srcNote = el("p", { class: "note" });
    this.srcCard.body.append(this.srcChart, this.srcBox, this.srcNote);
    mid.append(this.tierCard.root, this.srcCard.root);
    root.append(mid);

    const loyal = el("div", { class: "grid offers-mid" });
    this.movesCard = card("Loyalty tiers this season", { sub: "households by the tier they started in" });
    this.moves = new BarChart(this.movesCard.body, { height: 180, horizontal: true, stacked: true, legend: true, labelWidth: 110, yMax: 1, format: (v) => fmt.pct(v), tipFormat: (v) => fmt.pct(v, 1) });
    this.movesNote = el("p", { class: "note" });
    this.movesCard.body.append(this.movesNote);
    this.tiersCard = card("Where this season's spend puts them", { cls: "span-2" });
    this.tiersBox = el("div", { class: "table-scroll" });
    this.matrixBox = el("div", { class: "table-scroll" });
    this.tiersCard.body.append(this.tiersBox, el("h3", { class: "setup-heading", text: "Started in (rows) against the tier this season's spend reaches (columns)" }), this.matrixBox);
    loyal.append(this.movesCard.root, this.tiersCard.root);
    root.append(loyal);
  }

  #state() { return { offers: { brand: this.brand, offer: this.pick } }; }
  #view() { this.app.view(this.#state()); }
  viewState() { return this.#state(); }
  onShow() { this.#view(); }
  onGeometry(geo) {
    if (this.brand > geo.brands.length) this.brand = 1;
    // Start on our first brand.
    if (!this.chosen) this.brand = this.app.brandOrder.find((b) => b.ours)?.index ?? 1;
    this.pick = 0;
    this.brandSel.setOptions(this.#brandOptions(), this.brand);
  }

  #brandOptions() {
    const groups = [];
    for (const b of this.app.brandOrder) {
      let g = groups.find((x) => x.group === b.familyName);
      if (!g) { g = { group: b.familyName, options: [] }; groups.push(g); }
      g.options.push({ value: b.index, label: b.name });
    }
    return groups;
  }

  update(r) {
    if (r.brand !== this.brand) return;
    const name = this.app.brandName(r.brand);
    // The offer shown: the one picked, or the one R chose (running, else the latest).
    this.offerSel.setOptions(r.offers.length ? r.offers.map((o) => ({ value: o.offer, label: o.name })) : [{ value: 0, label: "No offers" }], r.selected);
    const o = r.offers.find((x) => x.offer === r.selected);

    // The totals take in offers still running, as measured so far.
    const t = r.totals;
    const running = r.offers.filter((x) => x.state === "running").map((x) => x.name);
    this.kpiCard.head.querySelector("h2").textContent = `${possessive(name)} offers this season`;
    this.kpiCard.setSub(running.length ? `to day ${r.today}, with ${running.length > 1 ? `${running.slice(0, -1).join(", ")} and ${running.at(-1)}` : running[0]} still running` : "");
    this.kpi.update({
      run: { value: fmt.int(t.run), sub: t.planned ? `${fmt.int(t.planned)} still to come` : r.offers.length ? "none still to come" : "none on its calendar" },
      sent: { value: fmt.int(t.sent), sub: `${fmt.int(t.held_out)} held out` },
      used: { value: fmt.int(t.used), sub: t.sent ? `${fmt.pct(t.used / t.sent, 1)} of those sent` : "" },
      send: fmt.money(t.send_total), discount: fmt.money(t.discount),
      extra_sales: fmt.money(t.extra_sales), extra_margin: { value: fmt.money(t.extra_margin), sub: t.measured < t.run ? `${fmt.int(t.run - t.measured)} offer${t.run - t.measured === 1 ? "" : "s"} can't be measured yet` : "after the cost of sending" },
    });
    this.kpiNote.textContent = r.offers.length ? "" : `${name} has no offers on its calendar: add them on the Setup tab (Offers), and they start at the next Setup.`;

    this.#list(r);
    this.#selected(o, r, name);
    this.#loyalty(r.loyalty, name);
  }

  // Every offer, a row each; a click shows it below.
  #list(r) {
    const cols = ["Offer", "Days", "State", "Sent", "Held out", "Used", "Bought (sent / held out)", "Spend per household (sent / held out)", "Spend lift","Extra per household sent", "Extra sales", "Extra margin"];
    const num = (i) => i >= 3;
    const rows = r.offers.map((o) => {
      const on = o.offer === r.selected;
      const days = o.from === o.to ? `day ${o.from}` : `${o.from}–${o.to}`;
      const state = o.state === "running" ? `running, to day ${o.to}` : o.state === "planned" ? `sent on day ${o.from}` : STATE[o.state];
      const cells = o.state === "planned" ? [o.name, days, state, "", "", "", "", "", "", "", "", ""] : [
        o.name, days, state, fmt.int(o.sent), fmt.int(o.held_out), `${fmt.int(o.used)} (${fmt.pct(o.sent ? o.used / o.sent : null, 1)})`,
        `${fmt.pct(o.conversion.treated, 1)} / ${fmt.pct(o.conversion.control, 1)}`, `${fmt.money2(o.spend.treated)} / ${fmt.money2(o.spend.control)}`,
        fmt.pct(o.lift), Number.isFinite(o.spend.diff) ? `${fmt.money2(o.spend.diff)} (${fmt.money2(o.spend.lo)} to ${fmt.money2(o.spend.hi)})` : "—",
        fmt.money(o.extra_sales), fmt.money(o.extra_margin)];
      const tr = el("tr", { class: `clickable${on ? " is-on" : ""}`, onclick: () => { this.pick = o.offer; this.#view(); } },
        ...cells.map((c, i) => el("td", { class: `${num(i) ? "num" : ""}${i === 11 && o.extra_margin < 0 ? " neg" : ""}`, text: c })));
      return tr;
    });
    this.listBox.replaceChildren(r.offers.length
      ? el("table", { class: "data offers-list" }, el("thead", {}, el("tr", {}, ...cols.map((c, i) => el("th", { class: num(i) ? "num" : "", text: c })))), el("tbody", {}, ...rows))
      : el("p", { class: "empty", text: "No offers on this brand's calendar." }));
  }

  // The offer shown: spend per household day by day, by tier, and where
  // the extra spend came from.
  #selected(o, r, name) {
    const at = o ? [name, ...o.also_at].join(" and ") : name;
    if (!o || o.state === "planned" || !o.days?.length) {
      this.curve.update(null); this.tierChart.update(null); divergingBars(this.srcChart, null);
      this.curveCard.setSub(o ? o.name : ""); this.curveNote.textContent = o?.state === "planned" ? `${o.name} is sent on day ${o.from}.` : o ? "Sent this morning: its first day's purchases come in tonight." : "";
      this.srcBox.replaceChildren(); this.srcNote.textContent = "";
      return;
    }
    this.curveCard.setSub(`${o.name}, at ${at}, from day ${o.from}`);
    this.curve.update({ x: o.days, series: [
      { name: `Sent the coupon (${fmt.int(o.sent)})`, colour: "var(--offer-1)", values: o.sent_curve },
      { name: `Held out (${fmt.int(o.held_out)})`, colour: "var(--offer-0)", values: o.held_curve }] });
    this.curveNote.textContent = `${o.state === "closed" ? "Closed" : `Measured to day ${o.measured_to}`}: ${Number.isFinite(o.spend.diff) ? `${fmt.money2(o.spend.diff)} more per household sent (${fmt.money2(o.spend.lo)} to ${fmt.money2(o.spend.hi)}), ${fmt.pct(o.lift)} over those held out` : "too few held out to measure"}. ${fmt.pct(o.conversion.treated, 1)} of those sent bought at ${at}, against ${fmt.pct(o.conversion.control, 1)} of those held out.`;
    this.tierChart.update(o.by_tier.length ? { categories: o.by_tier.map((x) => `${x.tier} (${fmt.int(x.sent)})`), series: [{
      name: "Extra spend per household sent", colour: "var(--offer-1)", values: o.by_tier.map((x) => x.diff), lo: o.by_tier.map((x) => x.lo), hi: o.by_tier.map((x) => x.hi) }] } : null);
    this.#sources(o, name);
  }

  // Each brand's row: the change in spend per household there. The brands
  // the coupon is good at are its own effect; its sister brands show
  // cannibalisation (or halo); competitors, what was won from them. Then
  // the net for our family.
  #sources(o, name) {
    const src = o.sources;
    const order = this.app.brandOrder;
    const rows = order.map((b) => ({ b, x: src.rows[b.index - 1] })).filter(({ x }) => x);
    const ok = o.sent > 1 && o.held_out > 1;
    const sub = (x) => `${RELATION[x.relation]}${x.good && x.relation !== "self" ? ", coupon good here" : ""}`;
    divergingBars(this.srcChart, ok ? [...rows.map(({ b, x }) => ({ label: b.name, sub: sub(x), colour: brandVar(b.index), ...x })),
      { label: `Net for ${this.app.oursName}`, sub: "our family", colour: "var(--ink-2)", ...src.family }] : null);
    const range = (x) => (Number.isFinite(x.lo) ? `${fmt.money2(x.lo)} to ${fmt.money2(x.hi)}` : "—");
    const t = el("table", { class: "data" }, el("thead", {}, el("tr", {}, el("th", { text: "Brand" }), el("th", { text: "" }), el("th", { class: "num", text: "Sent" }), el("th", { class: "num", text: "Held out" }),
      el("th", { class: "num", text: "Change" }), el("th", { class: "num", text: "95% interval" }))),
    el("tbody", {}, ...rows.map(({ b, x }) => el("tr", {},
      el("td", {}, el("i", { class: "legend-swatch", vars: { "--c": brandVar(b.index) }, style: { display: "inline-block", marginRight: "6px" } }), b.name),
      el("td", { text: sub(x) }), el("td", { class: "num", text: fmt.money2(x.treated) }), el("td", { class: "num", text: fmt.money2(x.control) }),
      el("td", { class: `num${x.diff < 0 ? " neg" : ""}`, text: fmt.money2(x.diff) }), el("td", { class: "num", text: range(x) }))),
    el("tr", { class: "total" }, el("td", { text: `Net for ${this.app.oursName}` }), el("td"), el("td", { class: "num", text: fmt.money2(src.family.treated) }), el("td", { class: "num", text: fmt.money2(src.family.control) }),
      el("td", { class: "num", text: fmt.money2(src.family.diff) }), el("td", { class: "num", text: range(src.family) }))));
    this.srcBox.replaceChildren(t);
    this.srcNote.textContent = ok
      ? `${fmt.int(o.sent)} households sent ${o.name} against ${fmt.int(o.held_out)} held out. Spend at every brand over the offer's days counts, whoever sold it. On the Setup tab (Offers), "also good at" lets the coupon come off at a sister brand too.`
      : `${name} needs households both sent and held out before this can be measured.`;
  }

  // The brand's tiers: moved up, kept, not re-qualified (dropped, once the
  // season is over), by the tier each household started in.
  #loyalty(L, name) {
    const moves = L.final ? ["moved up", "kept", "dropped"] : L.moves;
    const share = (t, m) => (L.start[t] ? L.by_start[t][m] / L.start[t] : 0);
    this.movesCard.setSub(`households by the tier they started in, with ${name}`);
    this.moves.update({ categories: L.names, series: moves.map((m, k) => ({ name: m, colour: MOVE_COLOURS[k], values: L.names.map((_, t) => share(t, k)) })) });
    const sum = (m) => L.by_start.reduce((a, x) => a + x[m], 0);
    const above = L.start.slice(1).reduce((a, x) => a + x, 0);
    const keptAbove = L.by_start.slice(1).reduce((a, x) => a + x[1], 0);
    this.movesNote.textContent = `${L.final ? "At the season's end" : "So far this season"}: ${fmt.int(sum(0))} households moved up a tier or more; of the ${fmt.int(above)} who started above ${L.names[0]}, ${fmt.int(keptAbove)} ${L.final ? "kept their tier" : "have re-qualified for theirs"} and ${fmt.int(L.by_start.slice(1).reduce((a, x) => a + x[2], 0))} ${L.final ? "dropped" : "haven't yet"}. A household holds the highest tier it has reached until the season ends.`;
    const head = ["Tier", "Season spend to reach", "Started in it", "In it now", "Moved up", L.final ? "Kept" : "Kept (re-qualified)", L.final ? "Dropped" : "Not re-qualified yet", "Spend this season, on average"];
    this.tiersBox.replaceChildren(el("table", { class: "data" }, el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", { class: i ? "num" : "", text: h })))),
      el("tbody", {}, ...L.names.map((t, k) => el("tr", {}, el("td", { text: t }), el("td", { class: "num", text: fmt.money(L.spend[k]) }),
        el("td", { class: "num", text: fmt.int(L.start[k]) }), el("td", { class: "num", text: fmt.int(L.now[k]) }),
        ...[0, 1, 2].map((m) => el("td", { class: "num", text: `${fmt.int(L.by_start[k][m])} (${fmt.pct(share(k, m))})` })),
        el("td", { class: "num", text: fmt.money2(L.spend_by_start[k]) }))))));
    this.matrixBox.replaceChildren(el("table", { class: "data tier-matrix" },
      el("thead", {}, el("tr", {}, el("th", { text: "Started in" }), ...L.names.map((x) => el("th", { class: "num", text: x })))),
      el("tbody", {}, ...L.names.map((t, i) => el("tr", {}, el("td", { text: t }), ...L.names.map((_, j) => el("td", {
        class: `num ${j > i ? "up" : j === i ? "kept" : "down"}`, text: fmt.int(L.matrix[i][j]) })))))));
    this.tiersCard.setSub(`${name}: each tier's households, and where their spend so far puts them`);
  }
}

// Bars either side of zero, each with its 95% interval: a gain to the
// right, a loss (cannibalisation) to the left.
function divergingBars(box, rows) {
  const NS = "http://www.w3.org/2000/svg";
  if (!rows) { box.replaceChildren(el("p", { class: "empty", text: "Once the offer has been sent" })); return; }
  const W = Math.max(420, box.clientWidth || 640); const rowH = 26; const labelW = 190; const right = 70;
  const H = rows.length * rowH + 28;
  const vals = rows.flatMap((r) => [r.diff, r.lo, r.hi]).filter(Number.isFinite);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 5);
  const lo = ticks[0]; const hi = ticks.at(-1);
  const X = (v) => labelW + ((v - lo) / (hi - lo || 1)) * (W - labelW - right);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.style.width = "100%"; svg.style.height = `${H}px`;
  const add = (tag, attrs, txt) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (txt !== undefined) n.textContent = txt; svg.append(n); return n; };
  for (const t of ticks) {
    add("line", { x1: X(t), x2: X(t), y1: 4, y2: H - 20, class: t === 0 ? "axis-line" : "grid-line" });
    add("text", { x: X(t), y: H - 6, "text-anchor": "middle" }, fmt.money(t));
  }
  rows.forEach((r, i) => {
    const y = 6 + i * rowH; const mid = y + 9;
    const last = i === rows.length - 1;
    if (last) add("line", { x1: 0, x2: W, y1: y - 3, y2: y - 3, class: "grid-line" });
    add("text", { x: labelW - 8, y: mid + 4, "text-anchor": "end", class: "label-ink", style: last ? "font-weight:650" : "" }, `${r.label}`);
    if (!Number.isFinite(r.diff)) return;
    const x0 = X(Math.min(0, r.diff)); const x1 = X(Math.max(0, r.diff));
    const bar = add("rect", { x: x0, y: y + 2, width: Math.max(1, x1 - x0), height: 14, rx: 3, fill: r.colour, class: "mark" });
    if (Number.isFinite(r.lo) && Number.isFinite(r.hi)) {
      add("line", { x1: X(r.lo), x2: X(r.hi), y1: mid, y2: mid, stroke: "var(--ink)", "stroke-width": 1.5 });
      for (const v of [r.lo, r.hi]) add("line", { x1: X(v), x2: X(v), y1: mid - 5, y2: mid + 5, stroke: "var(--ink)", "stroke-width": 1.5 });
    }
    add("text", { x: X(Math.max(r.diff, r.hi ?? r.diff)) + 6, y: mid + 4, class: "label-ink" }, fmt.money2(r.diff));
    bar.addEventListener("pointermove", (ev) => tooltip.show(ev, `${r.label} (${r.sub})`, [
      { colour: r.colour, value: fmt.money2(r.diff), name: "change in spend per household" },
      { value: `${fmt.money2(r.lo)} to ${fmt.money2(r.hi)}`, name: "95% interval" },
      { value: `${fmt.money2(r.treated)} vs ${fmt.money2(r.control)}`, name: "sent vs held out" }]));
    bar.addEventListener("pointerleave", () => tooltip.hide());
  });
  box.replaceChildren(svg);
}
