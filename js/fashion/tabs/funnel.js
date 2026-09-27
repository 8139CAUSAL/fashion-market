// Funnel: where shoppers are lost between being in the market and paying,
// and why. After the sales-funnel picture: stages as circles holding live
// dots, conversion between stages, losses by reason above each, and the
// two teams that move it — sales assistants and cashiers (set on the
// Setup tab).

import { el, fmt, select, card, brandVar } from "../ui.js";
import { tooltip } from "../charts.js";

const NS = "http://www.w3.org/2000/svg";
const LOSS_COLOURS = ["var(--cat-4)", "var(--cat-2)", "var(--cat-5)"];
const LIVE_LABELS = ["on the way to a store", "browsing", "carrying items", "at the fitting rooms", "at the tills", "paid today"];

export class FunnelTab {
  constructor(root, app) {
    this.app = app;
    this.filter = { brand: 1, area: 0, store: 0, scope: "season" };
    root.append(el("div", { class: "tab-intro" }, el("h1", { text: "Funnel" }),
      el("p", { text: "From households in the market for clothes to receipts. Every loss is one shopper's visit going wrong, recorded with its reason at the moment it happened: nothing appealed, nothing in their size, a queue too long." })));

    const f = this.filter;
    this.brandSel = select({ label: "Brand", value: 1, options: [{ value: 0, label: "All brands" }],
      onChange: (v) => this.#set({ brand: Number(v) }) });
    this.distSel = select({ label: "Households living in", value: 0, options: [{ value: 0, label: "Every area" }],
      onChange: (v) => this.#set({ area: Number(v) }) });
    this.storeSel = select({ label: "Store", value: 0, options: [{ value: 0, label: "Every store" }], onChange: (v) => this.#set({ store: Number(v) }) });
    this.scopeSel = select({ label: "Period", value: "season", options: [{ value: "season", label: "Season so far" }, { value: "day", label: "Today (or yesterday)" }],
      onChange: (v) => this.#set({ scope: v }) });
    root.append(el("div", { class: "filters" }, this.brandSel.root, this.distSel.root, this.storeSel.root, this.scopeSel.root));

    const main = card("The sales funnel", { sub: "" });
    this.mainCard = main;
    this.svgBox = el("div", { class: "funnel-svg" });
    main.body.append(this.svgBox);
    root.append(main.root);

    const bottom = el("div", { class: "grid funnel-bottom" });
    const sa = card("Sales assistants", { sub: "for the brand in the filter · set on the Setup tab" });
    this.saDots = el("div", { class: "staff-dots" });
    this.saText = el("div", { class: "stat-sub" });
    sa.body.append(el("div", { class: "staff-panel" }, this.saDots, this.saText),
      el("p", { class: "note", text: "Assistants fetch a missing size from the stockroom and advise at the racks; advice makes a tried item likelier to be kept." }));
    const ca = card("Cashiers", { sub: "for the brand in the filter · set on the Setup tab" });
    this.caDots = el("div", { class: "staff-dots" });
    this.caText = el("div", { class: "stat-sub" });
    ca.body.append(el("div", { class: "staff-panel" }, this.caDots, this.caText),
      el("p", { class: "note", text: "A shopper who sees too long a queue at the tills walks out, and the items go back on the rack." }));
    bottom.append(sa.root, ca.root);
    root.append(bottom);
  }

  #set(part) {
    Object.assign(this.filter, part);
    this.brandSel.node.disabled = this.filter.store > 0;
    this.app.view({ funnel: { ...this.filter } });
  }

  viewState() { return { funnel: { ...this.filter } }; }

  onGeometry(geo) {
    this.geo = geo;
    // Filters that point past the new world start over.
    if (this.filter.brand > geo.brands.length) this.filter.brand = 1;
    if (this.filter.store > geo.stores.length) this.filter.store = 0;
    if (this.filter.area > geo.areas.length + 1) this.filter.area = 0;
    this.brandSel.setOptions([{ value: 0, label: "All brands" }, ...this.app.brandOrder.map((b) => ({ value: b.index, label: b.name }))], this.filter.brand);
    this.distSel.setOptions([{ value: 0, label: "Every area" }, ...geo.areas.map((a, k) => ({ value: k + 1, label: a.name })), { value: geo.areas.length + 1, label: "Outside every area" }], this.filter.area);
    const groups = [...geo.areas.map((a, k) => ({ name: a.name, k: k + 1 })), { name: "Outside every area", k: 0 }]
      .map((g) => ({ group: g.name, options: geo.stores.filter((s) => s.area === g.k).map((s) => ({ value: s.id, label: s.name })) })).filter((g) => g.options.length);
    this.storeSel.setOptions([{ value: 0, label: "Every store" }, ...groups], this.filter.store);
  }

  update(r) {
    const st = r.stages;
    const scope = r.scope === "season" ? "season so far" : r.day_label.toLowerCase();
    const who = r.filter.store ? this.geo?.stores[r.filter.store - 1]?.name : r.filter.brand ? `${this.app.brandName(r.filter.brand)} stores` : "all stores";
    const areaName = r.filter.area > (this.geo?.areas.length ?? 0) ? "outside every area" : this.geo?.areas[r.filter.area - 1]?.name;
    const where = r.filter.area ? `households ${r.filter.area > (this.geo?.areas.length ?? 0) ? "living" : "in"} ${areaName}` : "every area";
    this.mainCard.setSub(`${who} · ${where} · ${scope}`);
    this.#draw(st, r.live);
    const s = r.staff;
    const n = s.stores;
    this.saText.textContent = `${fmt.int(s.assistants)} per store in ${fmt.int(n)} stores · skill ${fmt.num1(s.skill)}`;
    this.caText.textContent = `${fmt.int(s.cashiers)} per store in ${fmt.int(n)} stores · ${fmt.int(s.scan_s)} s to scan an item`;
    const dots = (box, k, colour) => box.replaceChildren(...Array.from({ length: Math.round(k * n) }, () => el("i", { vars: { "--c": colour } })));
    dots(this.saDots, s.assistants, brandVar(s.brand)); dots(this.caDots, s.cashiers, "var(--ink-2)");
  }

  #draw(stages, live) {
    const W = Math.max(640, this.svgBox.clientWidth || 900); const H = 420;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.style.width = "100%"; svg.style.height = `${H}px`;
    const add = (tag, attrs, txt, parent = svg) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (txt !== undefined) n.textContent = txt; parent.append(n); return n; };
    const k = stages.length; const band = W / k; const cy = 310;
    const n0 = Math.max(1, stages[0].n);
    const r = Math.min(52, band * 0.34);
    const liveArr = Array.isArray(live) ? live : Object.values(live ?? {});
    const anyLive = liveArr.some((v) => v > 0);
    const maxN = Math.max(1, ...stages.map((s) => s.n));
    stages.forEach((s, i) => {
      const cx = band * (i + 0.5);
      // Arrow to the next stage: its width is the share that makes it.
      if (i < k - 1) {
        const nx = band * (i + 1.5);
        const share = s.n ? stages[i + 1].n / s.n : 0;
        const w = Math.max(5, 34 * Math.sqrt(stages[i + 1].n / n0));
        add("path", { d: `M${cx + r + 4},${cy - w / 2}H${nx - r - 16}V${cy - w / 2 - 6}L${nx - r - 3},${cy}L${nx - r - 16},${cy + w / 2 + 6}V${cy + w / 2}H${cx + r + 4}Z`, fill: "var(--surface-3)" });
        add("text", { x: (cx + nx) / 2 - 6, y: cy + Math.max(w / 2, 10) + 26, "text-anchor": "middle", class: "value-ink", style: "font-size:18px" }, fmt.pct(share, 0));
      }
      add("circle", { cx, cy, r, fill: `var(--stage-${i + 1})`, "fill-opacity": 0.2, stroke: `var(--stage-${i + 1})`, "stroke-width": 2 });
      // Dots: the shoppers at this stage right now (watch pace), else the
      // stage's size, the largest stage filling its circle.
      const count = anyLive ? liveArr[i] ?? 0 : Math.round(130 * s.n / maxN);
      const shown = Math.min(count, 160);
      for (let j = 0; j < shown; j++) {
        const a = j * 2.39996; const rr = (r - 6) * Math.sqrt((j + 0.5) / Math.max(shown, 1));
        add("circle", { cx: cx + rr * Math.cos(a), cy: cy + rr * Math.sin(a), r: 2.3, fill: `var(--stage-${Math.min(6, i + 2)})` });
      }
      add("text", { x: cx, y: cy + r + 20, "text-anchor": "middle", class: "label-ink", style: "font-weight:650;font-size:12.5px" }, s.name);
      add("text", { x: cx, y: cy + r + 36, "text-anchor": "middle" }, fmt.int(s.n));
      const hit = add("circle", { cx, cy, r: r + 6, fill: "transparent" });
      hit.addEventListener("pointermove", (ev) => tooltip.show(ev, s.name, [
        { colour: `var(--stage-${i + 1})`, value: fmt.int(s.n), name: "shoppers" },
        anyLive ? { value: fmt.int(liveArr[i]), name: `${LIVE_LABELS[i]} right now` } : { value: "", name: "dots show the stage's size; while the floor is drawn, who's there now" },
      ]));
      hit.addEventListener("pointerleave", () => tooltip.hide());
      if (!s.lost?.length) return;
      // Above the stage: each loss reason's share of the stage's shoppers,
      // its key, and the stage's total loss beside an arrow leaving it.
      const lostN = s.lost.reduce((a, l) => a + l.n, 0);
      const share = s.n ? lostN / s.n : 0;
      const bw = Math.min(28, (band * 0.62) / s.lost.length - 4); const baseY = 96; const hMax = 80;
      const x0 = cx - (s.lost.length * (bw + 4) - 4) / 2;
      add("rect", { x: x0 - 8, y: baseY - hMax - 6, width: s.lost.length * (bw + 4) + 12, height: hMax + 6, rx: 6, fill: "var(--surface-2)" });
      add("line", { x1: x0 - 8, x2: x0 + s.lost.length * (bw + 4) + 4, y1: baseY, y2: baseY, class: "axis-line" });
      s.lost.forEach((l, j) => {
        const v = s.n ? l.n / s.n : 0; const h = Math.max(0, hMax * Math.min(1, v));
        const x = x0 + j * (bw + 4); const rr = Math.min(4, bw / 2, h);
        const bar = add("path", { d: h > 0.5 ? `M${x},${baseY}V${baseY - h + rr}Q${x},${baseY - h} ${x + rr},${baseY - h}H${x + bw - rr}Q${x + bw},${baseY - h} ${x + bw},${baseY - h + rr}V${baseY}Z` : "", fill: LOSS_COLOURS[j], class: "mark" });
        const hitB = add("rect", { x: x - 2, y: baseY - hMax - 6, width: bw + 4, height: hMax + 10, fill: "transparent" });
        hitB.addEventListener("pointermove", (ev) => { bar.classList.add("is-hover"); tooltip.show(ev, `Lost at "${s.name}"`, [{ colour: LOSS_COLOURS[j], value: `${fmt.pct(v, 1)} · ${fmt.int(l.n)}`, name: l.reason }]); });
        hitB.addEventListener("pointerleave", () => { bar.classList.remove("is-hover"); tooltip.hide(); });
        const ky = baseY + 16 + j * 15;
        add("rect", { x: cx - band * 0.44, y: ky - 9, width: 9, height: 9, rx: 2, fill: LOSS_COLOURS[j] });
        add("text", { x: cx - band * 0.44 + 14, y: ky, class: "label-ink", style: "font-size:11px" }, `${l.reason} ${fmt.pct(v, 0)}`);
      });
      const ay = baseY + 16 + s.lost.length * 15;
      add("path", { d: `M${cx - 7},${cy - r - 4}V${ay + 18}H${cx - 13}L${cx},${ay + 4}L${cx + 13},${ay + 18}H${cx + 7}V${cy - r - 4}Z`, fill: "var(--surface-3)" });
      add("text", { x: cx + 18, y: ay + 34, class: "value-ink", style: "font-size:15px" }, `${fmt.pct(share, 0)} lost`);
    });
    this.svgBox.replaceChildren(svg);
  }
}
