// Charts, drawn as SVG from the numbers R sends. Thin marks, recessive
// axes, a crosshair or per-mark tooltip on every chart, text in text ink
// and colour only on the marks. No charting library: each chart is a small
// class with update(data) that redraws at the container's width.

import { el, fmt } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}
function text(parent, x, y, str, attrs = {}) {
  const t = s("text", { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}

// ---- The one tooltip ------------------------------------------------------------

const tooltip = {
  get el() { return document.getElementById("tooltip"); },
  show(event, title, rows) {
    const box = this.el;
    if (!box) return;
    box.replaceChildren();
    if (title) box.append(el("div", { class: "tt-title", text: title }));
    for (const row of rows) {
      box.append(el("div", { class: "tt-row" },
        el("i", { class: "tt-key", vars: { "--c": row.colour ?? "transparent" } }),
        el("b", { text: row.value }), el("span", { text: row.name ?? "" })));
    }
    box.hidden = false;
    const { innerWidth: W, innerHeight: H } = window;
    const r = box.getBoundingClientRect();
    let x = event.clientX + 14; let y = event.clientY + 14;
    if (x + r.width > W - 8) x = event.clientX - r.width - 14;
    if (y + r.height > H - 8) y = event.clientY - r.height - 14;
    box.style.left = `${Math.max(8, x)}px`; box.style.top = `${Math.max(8, y)}px`;
  },
  hide() { const box = this.el; if (box) box.hidden = true; },
};
export { tooltip };

// Round numbers for an axis.
export function niceTicks(lo, hi, count = 4) {
  if (!(hi > lo)) { hi = lo + 1; }
  const span = hi - lo;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => span / st <= count) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 1e-6; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

// A bar with its data end rounded (4 px) and square at the baseline.
function barPath(x, y0, w, y1, r = 4) {
  const up = y1 < y0;
  const h = Math.abs(y1 - y0);
  const rr = Math.min(r, w / 2, h);
  if (h < 0.5) return "";
  if (up) return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`;
  return `M${x},${y0}V${y1 - rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 - rr}V${y0}Z`;
}
function hbarPath(x0, y, x1, h, r = 4) {
  const w = x1 - x0; const rr = Math.min(r, h / 2, Math.abs(w));
  if (Math.abs(w) < 0.5) return "";
  if (w > 0) return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 - rr},${y + h}H${x0}Z`;
  return `M${x0},${y}H${x1 + rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 + rr},${y + h}H${x0}Z`;
}

class Chart {
  constructor(parent, opts = {}) {
    this.opts = opts;
    this.root = el("div", { class: "chart" });
    this.root.style.height = `${opts.height ?? 180}px`;
    this.svg = s("svg", { role: "img", "aria-label": opts.label ?? "" }, this.root);
    parent.append(this.root);
    if (opts.legend) { this.legendBox = el("div", { class: "legend" }); parent.append(this.legendBox); }
    this.data = null;
    let lastW = 0;
    new ResizeObserver(() => {
      const w = this.root.clientWidth;
      if (Math.abs(w - lastW) > 1) { lastW = w; this.render(); }
    }).observe(this.root);
  }
  update(data) { this.data = data; this.render(); }
  size() { return { W: Math.max(60, this.root.clientWidth), H: this.opts.height ?? 180 }; }
  clear() { this.svg.replaceChildren(); const { W, H } = this.size(); this.svg.setAttribute("viewBox", `0 0 ${W} ${H}`); return { W, H }; }
  setLegend(items, line = false) {
    if (!this.legendBox) return;
    const key = JSON.stringify(items.map((i) => [i.name, i.colour]));
    if (key === this.legendKey) return;
    this.legendKey = key;
    this.legendBox.replaceChildren(...items.map((it) => el("span", {},
      el("i", { class: line ? "legend-line" : "legend-swatch square", vars: { "--c": it.colour } }), it.name)));
  }
  empty(W, H, message = "No data yet") {
    text(this.svg, W / 2, H / 2, message, { "text-anchor": "middle", class: "label-ink" });
  }
}

// ---- Lines and areas --------------------------------------------------------------

// data: { x: labels, series: [{ name, colour, values }], ribbons? }
// opts: stacked, normalize, area, yMax, yMin, format, xFormat, bands, endLabels
// ribbons: [{ name, colour, lo, hi, opacity? }], shaded under the lines
// where lo and hi are both given (a forecast's intervals); they count in
// the y range, and the tooltip gives each as "lo – hi".
export class LineChart extends Chart {
  render() {
    const { W, H } = this.clear();
    const d = this.data;
    const o = this.opts;
    if (!d || !d.series?.length || !d.x?.length) return this.empty(W, H, o.emptyText);
    this.setLegend(d.series, !o.stacked);
    const n = d.x.length;
    const series = d.series.map((sr) => ({ ...sr, values: sr.values.map((v) => (Number.isFinite(v) ? v : null)) }));
    const finite = (v) => (Number.isFinite(v) ? v : null);
    const ribbons = (d.ribbons ?? []).map((rb) => ({ ...rb, lo: rb.lo.map(finite), hi: rb.hi.map(finite) }));
    // Stacks: each series' base and top.
    let tops = series.map((sr) => sr.values);
    let bases = series.map(() => new Array(n).fill(0));
    if (o.stacked) {
      const acc = new Array(n).fill(0);
      const totals = new Array(n).fill(0);
      if (o.normalize) series.forEach((sr) => sr.values.forEach((v, i) => { totals[i] += v ?? 0; }));
      tops = []; bases = [];
      for (const sr of series) {
        const b = acc.slice();
        const t = sr.values.map((v, i) => { const val = o.normalize ? (totals[i] ? (v ?? 0) / totals[i] : 0) : (v ?? 0); acc[i] += val; return acc[i]; });
        bases.push(b); tops.push(t);
      }
    }
    const all = [...tops.flat(), ...ribbons.flatMap((rb) => [...rb.lo, ...rb.hi])].filter((v) => v !== null);
    let yMax = o.yMax ?? Math.max(...all, 0);
    let yMin = o.yMin ?? Math.min(0, ...all);
    if (o.normalize) { yMax = 1; yMin = 0; }
    const ticks = niceTicks(yMin, yMax, o.ticks ?? 4);
    yMin = Math.min(yMin, ticks[0]); yMax = Math.max(yMax, ticks.at(-1));
    const f = o.format ?? fmt.compact;
    const left = 8 + Math.max(...ticks.map((t) => f(t).length)) * 6.2;
    const right = o.endLabels ? 70 : 10;
    const top = 8; const bottom = 22;
    const X = (i) => left + (n === 1 ? (W - left - right) / 2 : (i * (W - left - right)) / (n - 1));
    const Y = (v) => top + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - top - bottom);

    for (const band of o.bands?.(d) ?? []) {
      s("rect", { x: X(band.from) - (n > 1 ? (W - left - right) / (n - 1) / 2 : 0), y: top, width: Math.max(1, X(band.to) - X(band.from) + (n > 1 ? (W - left - right) / (n - 1) : 0)),
        height: H - top - bottom, fill: band.colour, opacity: 0.12 }, this.svg);
    }
    for (const t of ticks) {
      s("line", { x1: left, x2: W - right, y1: Y(t), y2: Y(t), class: t === 0 ? "axis-line" : "grid-line" }, this.svg);
      text(this.svg, left - 6, Y(t) + 4, f(t), { "text-anchor": "end" });
    }
    // Each ribbon, over each run of points with both ends.
    for (const rb of ribbons) {
      let run = [];
      const flush = () => {
        if (run.length > 1) s("path", { d: `M${run.map((i) => `${X(i).toFixed(1)},${Y(rb.hi[i]).toFixed(1)}`).join("L")}L${run.slice().reverse().map((i) => `${X(i).toFixed(1)},${Y(rb.lo[i]).toFixed(1)}`).join("L")}Z`,
          fill: rb.colour, opacity: rb.opacity ?? 0.15 }, this.svg);
        run = [];
      };
      for (let i = 0; i < n; i++) { if (rb.lo[i] !== null && rb.hi[i] !== null) run.push(i); else flush(); }
      flush();
    }
    const xf = o.xFormat ?? ((l) => l);
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - left - right) / 70))));
    for (let i = 0; i < n; i += every) text(this.svg, X(i), H - 6, xf(d.x[i], i), { "text-anchor": i === 0 && n > 1 ? "start" : "middle" });

    const path = (vals) => {
      let p = ""; let pen = false;
      vals.forEach((v, i) => {
        if (v === null) { pen = false; return; }
        p += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true;
      });
      return p;
    };
    // A line needs two points: a value with none beside it (the first day
    // or week of a season) is drawn as a dot, and a lone stack as a bar.
    const lone = (vals, i) => vals[i] !== null && (i === 0 || vals[i - 1] === null) && (i === n - 1 || vals[i + 1] === null);
    series.forEach((sr, k) => {
      if (o.stacked && n === 1) {
        const w = Math.min(40, (W - left - right) * 0.2);
        s("rect", { x: X(0) - w / 2, y: Y(tops[k][0]), width: w, height: Math.max(0, Y(bases[k][0]) - Y(tops[k][0])), fill: sr.colour, opacity: 0.88 }, this.svg);
      } else if (o.stacked) {
        const upper = tops[k].map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
        const lower = bases[k].map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).reverse();
        s("path", { d: `M${upper.join("L")}L${lower.join("L")}Z`, fill: sr.colour, opacity: 0.88 }, this.svg);
        s("path", { d: path(tops[k]), fill: "none", stroke: "var(--surface)", "stroke-width": 2 }, this.svg);
      } else {
        if (o.area) s("path", { d: `${path(sr.values)}L${X(lastIndex(sr.values))},${Y(Math.max(0, yMin))}L${X(firstIndex(sr.values))},${Y(Math.max(0, yMin))}Z`, fill: sr.colour, opacity: 0.1 }, this.svg);
        s("path", { d: path(sr.values), fill: "none", stroke: sr.colour, "stroke-width": sr.width ?? 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": sr.dash }, this.svg);
        if (!o.endLabels) sr.values.forEach((v, i) => { if (lone(sr.values, i)) s("circle", { cx: X(i), cy: Y(v), r: 3.5, fill: sr.colour }, this.svg); });
      }
    });
    if (o.endLabels && !o.stacked) {
      const ends = series.map((sr) => ({ sr, i: lastIndex(sr.values) })).filter((e) => e.i >= 0);
      const placed = [];
      for (const e of ends.sort((a, b) => Y(a.sr.values[a.i]) - Y(b.sr.values[b.i]))) {
        let y = Y(e.sr.values[e.i]);
        if (placed.length && y - placed.at(-1) < 13) y = placed.at(-1) + 13;
        placed.push(y);
        s("circle", { cx: X(e.i), cy: Y(e.sr.values[e.i]), r: 4, fill: e.sr.colour, stroke: "var(--surface)", "stroke-width": 2 }, this.svg);
        text(this.svg, X(e.i) + 8, y + 4, `${f(e.sr.values[e.i])} ${e.sr.short ?? ""}`.trim(), { class: "label-ink" });
      }
    }
    // Crosshair and tooltip.
    const cross = s("line", { class: "crosshair", y1: top, y2: H - bottom, visibility: "hidden" }, this.svg);
    const hit = s("rect", { x: left, y: 0, width: Math.max(1, W - left - right), height: H, class: "hit" }, this.svg);
    const tf = o.tipFormat ?? f;
    hit.addEventListener("pointermove", (ev) => {
      const r = this.svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - left) / (W - left - right || 1)) * (n - 1))));
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
      const rows = series.map((sr, k) => ({ colour: sr.colour, name: sr.name,
        value: o.stacked && o.normalize ? fmt.pct((tops[k][i] - bases[k][i]), 0) : tf(sr.values[i]) })).reverse();
      // A ribbon's range at the point, where it has one.
      const ranges = ribbons.filter((rb) => rb.lo[i] !== null && rb.hi[i] !== null).map((rb) => ({ colour: rb.colour, name: rb.name, value: `${tf(rb.lo[i])} – ${tf(rb.hi[i])}` }));
      tooltip.show(ev, o.tipTitle ? o.tipTitle(d.x[i], i) : xf(d.x[i], i), [...(o.stacked ? rows : rows.reverse()).filter((r) => o.stacked || r.value !== "—" || !ranges.length), ...ranges]);
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tooltip.hide(); });
  }
}
const lastIndex = (v) => { for (let i = v.length - 1; i >= 0; i--) if (v[i] !== null && v[i] !== undefined) return i; return -1; };
const firstIndex = (v) => v.findIndex((x) => x !== null && x !== undefined);

// ---- Bars -----------------------------------------------------------------------------

// data: { categories, series: [{ name, colour, values, lo?, hi? }] }
// opts: stacked, horizontal, format, valueLabels, yMin, yMax, catFormat
export class BarChart extends Chart {
  render() {
    const { W, H } = this.clear();
    const d = this.data; const o = this.opts;
    if (!d || !d.categories?.length || !d.series?.length) return this.empty(W, H, o.emptyText);
    if (d.series.length > 1) this.setLegend(d.series);
    return o.horizontal ? this.#horizontal(W, H, d, o) : this.#vertical(W, H, d, o);
  }

  #vertical(W, H, d, o) {
    const nc = d.categories.length; const ns = d.series.length;
    const f = o.format ?? fmt.compact;
    let hi = -Infinity; let lo = Infinity;
    for (let c = 0; c < nc; c++) {
      if (o.stacked) {
        let pos = 0; let neg = 0;
        for (const sr of d.series) { const v = sr.values[c] ?? 0; if (v >= 0) pos += v; else neg += v; }
        hi = Math.max(hi, pos); lo = Math.min(lo, neg);
      } else {
        for (const sr of d.series) {
          const v = sr.values[c]; if (!Number.isFinite(v)) continue;
          hi = Math.max(hi, v, sr.hi?.[c] ?? v); lo = Math.min(lo, v, sr.lo?.[c] ?? v);
        }
      }
    }
    if (!Number.isFinite(hi)) { hi = 1; lo = 0; }
    hi = o.yMax ?? Math.max(hi, 0); lo = o.yMin ?? Math.min(lo, 0);
    const ticks = niceTicks(lo, hi, o.ticks ?? 4);
    lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks.at(-1));
    const left = 8 + Math.max(...ticks.map((t) => f(t).length)) * 6.2;
    const top = o.valueLabels ? 16 : 8; const bottom = o.catLabels === false ? 8 : 22; const right = 6;
    const Y = (v) => top + (1 - (v - lo) / (hi - lo || 1)) * (H - top - bottom);
    for (const t of ticks) {
      s("line", { x1: left, x2: W - right, y1: Y(t), y2: Y(t), class: t === 0 ? "axis-line" : "grid-line" }, this.svg);
      text(this.svg, left - 6, Y(t) + 4, f(t), { "text-anchor": "end" });
    }
    const band = (W - left - right) / nc;
    const groupW = o.stacked ? Math.min(o.barMax ?? 24, band * 0.7) : Math.min(band * 0.8, ns * (o.barMax ?? 24) + (ns - 1) * 2);
    const barW = o.stacked ? groupW : (groupW - (ns - 1) * 2) / ns;
    const catF = o.catFormat ?? ((c) => c);
    const every = Math.max(1, Math.ceil(nc / Math.max(1, Math.floor((W - left - right) / (o.catWidth ?? 46)))));
    for (let c = 0; c < nc; c++) {
      const x0 = left + band * c + (band - groupW) / 2;
      if (o.catLabels !== false && c % every === 0) text(this.svg, left + band * (c + 0.5), H - 6, catF(d.categories[c], c), { "text-anchor": "middle" });
      let pos = 0; let neg = 0;
      d.series.forEach((sr, k) => {
        const v = sr.values[c];
        if (!Number.isFinite(v)) return;
        let x; let y0; let y1;
        if (o.stacked) {
          x = x0;
          if (v >= 0) { y0 = Y(pos); pos += v; y1 = Y(pos); } else { y0 = Y(neg); neg += v; y1 = Y(neg); }
          // The surface gap between stacked segments.
          if (k > 0) y0 += v >= 0 ? -1 : 1;
          if (k < ns - 1) y1 += v >= 0 ? 1 : -1;
        } else { x = x0 + k * (barW + 2); y0 = Y(0); y1 = Y(v); }
        const last = !o.stacked || k === lastNonZero(d.series, c);
        const p = o.stacked && !last ? `M${x},${y0}V${y1}H${x + barW}V${y0}Z` : barPath(x, y0, barW, y1);
        const colour = sr.colours?.[c] ?? sr.colour;
        const mark = s("path", { d: p, fill: colour, class: "mark" }, this.svg);
        if (!o.stacked && sr.lo && Number.isFinite(sr.lo[c]) && Number.isFinite(sr.hi[c])) {
          const cx = x + barW / 2;
          s("line", { x1: cx, x2: cx, y1: Y(sr.lo[c]), y2: Y(sr.hi[c]), stroke: "var(--ink-2)", "stroke-width": 1.5 }, this.svg);
          for (const yy of [Y(sr.lo[c]), Y(sr.hi[c])]) s("line", { x1: cx - 4, x2: cx + 4, y1: yy, y2: yy, stroke: "var(--ink-2)", "stroke-width": 1.5 }, this.svg);
        }
        if (o.valueLabels && !o.stacked) text(this.svg, x + barW / 2, v >= 0 ? y1 - 4 : y1 + 12, f(v), { "text-anchor": "middle", class: "label-ink" });
        const hitRect = s("rect", { x: x - 1, y: Math.min(y0, y1) - 6, width: barW + 2, height: Math.abs(y1 - y0) + 12, class: "hit" }, this.svg);
        const tip = (ev) => {
          mark.classList.add("is-hover");
          const extra = sr.lo && Number.isFinite(sr.lo[c]) ? ` (95%: ${f(sr.lo[c])} to ${f(sr.hi[c])})` : "";
          tooltip.show(ev, catF(d.categories[c], c, true), [{ colour, name: sr.name, value: (o.tipFormat ?? f)(v) + extra }]);
        };
        hitRect.addEventListener("pointermove", tip);
        hitRect.addEventListener("pointerleave", () => { mark.classList.remove("is-hover"); tooltip.hide(); });
      });
      if (o.stacked && o.valueLabels) text(this.svg, x0 + groupW / 2, Y(pos) - 4, f(pos), { "text-anchor": "middle", class: "label-ink" });
    }
  }

  #horizontal(W, H, d, o) {
    const nc = d.categories.length;
    const f = o.format ?? fmt.compact;
    const labelW = o.labelWidth ?? 120;
    const rowH = (H - 4) / nc;
    const barH = Math.min(o.barMax ?? 18, rowH * 0.7);
    let hi = 0;
    for (let c = 0; c < nc; c++) {
      const sum = o.stacked ? d.series.reduce((a, sr) => a + Math.max(0, sr.values[c] ?? 0), 0) : Math.max(...d.series.map((sr) => sr.values[c] ?? 0));
      hi = Math.max(hi, sum);
    }
    hi = o.yMax ?? (hi || 1);
    const right = o.valueLabels ? 56 : 8;
    const X = (v) => labelW + (v / hi) * (W - labelW - right);
    for (let c = 0; c < nc; c++) {
      const y = 2 + rowH * c + (rowH - barH) / 2;
      text(this.svg, labelW - 8, y + barH / 2 + 4, (o.catFormat ?? ((x) => x))(d.categories[c], c), { "text-anchor": "end", class: "label-ink" });
      let acc = 0;
      const ns = d.series.length;
      d.series.forEach((sr, k) => {
        const v = sr.values[c] ?? 0;
        if (!(v > 0)) return;
        const x0 = X(acc) + (k > 0 && o.stacked ? 1 : 0); acc += o.stacked ? v : 0;
        const x1 = o.stacked ? X(acc) - (k < ns - 1 ? 1 : 0) : X(v);
        const last = !o.stacked || k === lastNonZero(d.series, c);
        const p = last ? hbarPath(x0, y, x1, barH) : `M${x0},${y}H${x1}V${y + barH}H${x0}Z`;
        const colour = sr.colours?.[c] ?? sr.colour;
        const mark = s("path", { d: p, fill: colour, class: "mark" }, this.svg);
        const hitRect = s("rect", { x: x0, y: y - 3, width: Math.max(2, x1 - x0), height: barH + 6, class: "hit" }, this.svg);
        hitRect.addEventListener("pointermove", (ev) => { mark.classList.add("is-hover"); tooltip.show(ev, d.categories[c], [{ colour, name: sr.name, value: (o.tipFormat ?? f)(v) }]); });
        hitRect.addEventListener("pointerleave", () => { mark.classList.remove("is-hover"); tooltip.hide(); });
      });
      if (o.valueLabels) {
        const total = o.stacked ? acc : Math.max(...d.series.map((sr) => sr.values[c] ?? 0));
        text(this.svg, X(o.stacked ? acc : total) + 6, y + barH / 2 + 4, (o.valueFormat ?? f)(o.labelOf ? o.labelOf(c) : total), { class: "label-ink" });
      }
    }
  }
}
const lastNonZero = (series, c) => { for (let k = series.length - 1; k >= 0; k--) if ((series[k].values[c] ?? 0) !== 0) return k; return -1; };

// ---- Donut ------------------------------------------------------------------------------

// data: { slices: [{ name, colour, value }], centre: { value, label } }
export class Donut extends Chart {
  render() {
    const { W, H } = this.clear();
    const d = this.data;
    if (!d) return this.empty(W, H);
    const total = d.slices.reduce((a, sl) => a + Math.max(0, sl.value), 0);
    if (!total) return this.empty(W, H, this.opts.emptyText);
    this.setLegend(d.slices);
    const R = Math.min(W, H) / 2 - 4; const r = R * 0.62;
    const cx = W / 2; const cy = H / 2;
    let a0 = -Math.PI / 2;
    for (const sl of d.slices) {
      if (!(sl.value > 0)) continue;
      const a1 = a0 + (2 * Math.PI * sl.value) / total;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, a) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
      const path = sl.value >= total ? `M${cx - R},${cy}A${R},${R} 0 1 1 ${cx + R},${cy}A${R},${R} 0 1 1 ${cx - R},${cy}M${cx - r},${cy}A${r},${r} 0 1 0 ${cx + r},${cy}A${r},${r} 0 1 0 ${cx - r},${cy}Z`
        : `M${p(R, a0)}A${R},${R} 0 ${large} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${large} 0 ${p(r, a0)}Z`;
      const mark = s("path", { d: path, fill: sl.colour, stroke: "var(--surface)", "stroke-width": 2, class: "mark", "fill-rule": "evenodd" }, this.svg);
      mark.addEventListener("pointermove", (ev) => tooltip.show(ev, sl.name, [{ colour: sl.colour, name: sl.detail ?? "", value: `${fmt.pct(sl.value / total, 1)} · ${(this.opts.format ?? fmt.int)(sl.value)}` }]));
      mark.addEventListener("pointerleave", () => tooltip.hide());
      a0 = a1;
    }
    if (d.centre) {
      text(this.svg, cx, cy + 2, d.centre.value, { "text-anchor": "middle", class: "value-ink", style: "font-size:18px" });
      text(this.svg, cx, cy + 18, d.centre.label, { "text-anchor": "middle" });
    }
  }
}

// ---- Scatter ------------------------------------------------------------------------------

// data: { points: [{ x, y, r, colour, label, rows }] }
// opts: xFormat, yFormat, xLabel, yLabel, xMax, yMax
export class Scatter extends Chart {
  render() {
    const { W, H } = this.clear();
    const d = this.data; const o = this.opts;
    const pts = (d?.points ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!pts.length) return this.empty(W, H, o.emptyText);
    const xf = o.xFormat ?? fmt.num1; const yf = o.yFormat ?? fmt.pct;
    const xMax = o.xMax ?? (Math.max(...pts.map((p) => p.x)) * 1.05 || 1);
    const yMax = o.yMax ?? (Math.max(...pts.map((p) => p.y)) * 1.05 || 1);
    const xt = niceTicks(0, xMax, 5); const yt = niceTicks(0, yMax, 4);
    const left = 10 + Math.max(...yt.map((t) => yf(t).length)) * 6.2; const bottom = 34; const top = 8; const right = 10;
    const X = (v) => left + (v / xt.at(-1)) * (W - left - right);
    const Y = (v) => top + (1 - v / yt.at(-1)) * (H - top - bottom);
    for (const t of yt) { s("line", { x1: left, x2: W - right, y1: Y(t), y2: Y(t), class: t === 0 ? "axis-line" : "grid-line" }, this.svg); text(this.svg, left - 6, Y(t) + 4, yf(t), { "text-anchor": "end" }); }
    for (const t of xt) text(this.svg, X(t), H - 20, xf(t), { "text-anchor": "middle" });
    if (o.xLabel) text(this.svg, (left + W - right) / 2, H - 4, o.xLabel, { "text-anchor": "middle", class: "label-ink" });
    const marks = pts.map((p) => s("circle", { cx: X(p.x), cy: Y(p.y), r: p.r ?? 5, fill: p.colour, "fill-opacity": 0.85, stroke: "var(--surface)", "stroke-width": 2, class: "mark" }, this.svg));
    const hit = s("rect", { x: 0, y: 0, width: W, height: H, class: "hit" }, this.svg);
    hit.addEventListener("pointermove", (ev) => {
      const r = this.svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W; const py = ((ev.clientY - r.top) / r.height) * H;
      let best = -1; let bd = 24 * 24;
      pts.forEach((p, i) => { const dd = (X(p.x) - px) ** 2 + (Y(p.y) - py) ** 2; if (dd < bd) { bd = dd; best = i; } });
      marks.forEach((m, i) => m.classList.toggle("is-hover", i === best));
      if (best < 0) return tooltip.hide();
      const p = pts[best];
      tooltip.show(ev, p.label, p.rows ?? [{ colour: p.colour, value: `${xf(p.x)} · ${yf(p.y)}` }]);
    });
    hit.addEventListener("pointerleave", () => { marks.forEach((m) => m.classList.remove("is-hover")); tooltip.hide(); });
  }
}

// ---- Waterfall -------------------------------------------------------------------------------

// data: { steps: [{ label, value, total? }] } — a total bar stands on zero,
// the others float from the running sum.
export class Waterfall extends Chart {
  render() {
    const { W, H } = this.clear();
    const d = this.data; const o = this.opts;
    if (!d?.steps?.length) return this.empty(W, H);
    const f = o.format ?? fmt.money;
    let run = 0; const bars = [];
    for (const st of d.steps) {
      if (st.total) { bars.push({ ...st, from: 0, to: st.value }); run = st.value; }
      else { bars.push({ ...st, from: run, to: run + st.value }); run += st.value; }
    }
    const lo = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)));
    const hi = Math.max(0, ...bars.map((b) => Math.max(b.from, b.to)));
    const ticks = niceTicks(lo, hi, 4);
    const y0 = Math.min(lo, ticks[0]); const y1 = Math.max(hi, ticks.at(-1));     // the bars, not just the ticks, fit
    const left = 8 + Math.max(...ticks.map((t) => f(t).length)) * 6.2; const top = 16; const bottom = 34; const right = 6;
    const Y = (v) => top + (1 - (v - y0) / (y1 - y0 || 1)) * (H - top - bottom);
    for (const t of ticks) { s("line", { x1: left, x2: W - right, y1: Y(t), y2: Y(t), class: t === 0 ? "axis-line" : "grid-line" }, this.svg); text(this.svg, left - 6, Y(t) + 4, f(t), { "text-anchor": "end" }); }
    const band = (W - left - right) / bars.length; const bw = Math.min(28, band * 0.6);
    bars.forEach((b, i) => {
      const x = left + band * i + (band - bw) / 2;
      const colour = b.total ? "var(--ink-2)" : b.value >= 0 ? "var(--good)" : "var(--critical)";
      const mark = s("path", { d: `M${x},${Y(b.from)}H${x + bw}V${Y(b.to)}H${x}Z`, fill: colour, class: "mark" }, this.svg);
      if (i < bars.length - 1) s("line", { x1: x + bw, x2: x + band, y1: Y(b.to), y2: Y(b.to), stroke: "var(--axis)", "stroke-dasharray": "2 2" }, this.svg);
      text(this.svg, x + bw / 2, Math.min(Y(b.from), Y(b.to)) - 4, f(b.value), { "text-anchor": "middle", class: "label-ink", style: "font-size:10px" });
      const words = b.label.split(" ");
      text(this.svg, x + bw / 2, H - 18, words[0], { "text-anchor": "middle" });
      if (words.length > 1) text(this.svg, x + bw / 2, H - 6, words.slice(1).join(" "), { "text-anchor": "middle" });
      mark.addEventListener("pointermove", (ev) => tooltip.show(ev, b.label, [{ colour, value: f(b.value) }]));
      mark.addEventListener("pointerleave", () => tooltip.hide());
    });
  }
}

// A table heat map: rows x columns of shares, the cell's shade by value on
// one sequential hue.
export function heatTable(container, { rows, cols, values, format = fmt.pct, title, low = 0, high = 1 }) {
  const table = el("table", { class: "data heat" });
  const thead = el("tr", {}, el("th", { text: title ?? "" }), ...cols.map((c) => el("th", { class: "num", text: c })));
  table.append(el("thead", {}, thead));
  const body = el("tbody");
  rows.forEach((r, i) => {
    body.append(el("tr", {}, el("td", { text: r }), ...cols.map((c, j) => {
      const v = values[i]?.[j];
      const t = Number.isFinite(v) ? Math.max(0, Math.min(1, (v - low) / (high - low || 1))) : 0;
      const td = el("td", { class: "num", text: format(v) });
      td.style.background = Number.isFinite(v) ? `color-mix(in srgb, var(--focus) ${Math.round(8 + 72 * t)}%, var(--surface))` : "";
      td.style.color = t > 0.55 ? "#fff" : "";
      return td;
    })));
  });
  table.append(body);
  container.replaceChildren(table);
}
