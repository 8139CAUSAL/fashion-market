// The market map: the painted tiles from R's world (drawn smoothed, roads
// as lines along their tiles), the areas' names, every household as a dot
// in the colour of the brand it last bought from (or its segment, its
// area, or the offer it holds), every store, and — at watch pace — every
// shopper on the road, driving the fastest route on the store clock.

import { cssVar, fmt, el } from "./ui.js";
import { tooltip } from "./charts.js";

// Land codes (model/city.R): 0 open, 1 water, 2 park, 3 homes, 4 shops, 5 road, 6 bridge.
const LAND_VARS = ["--map-land", "--map-water", "--map-park", null, "--map-shops", "--map-land", "--map-water"];
const storeSize = (space) => 7 * Math.max(0.3, space ?? 1) ** 0.45;

export class CityView {
  constructor(wrap, { onStore, onHome, onLocalPromo, promoPads = true } = {}) {
    this.wrap = wrap;
    this.canvas = el("canvas", { "aria-label": "Map of the market: its areas, households and stores" });
    this.overlay = el("div", { class: "map-overlay" });
    this.caption = el("div", { class: "view-caption" });
    wrap.append(this.canvas, this.overlay, this.caption);
    this.ctx = this.canvas.getContext("2d");
    this.geo = null; this.homes = null; this.codes = null; this.mode = "brand";
    this.travellers = null; this.storeStats = null; this.selected = null; this.hover = -1;
    this.onStore = onStore; this.onHome = onHome; this.onLocalPromo = onLocalPromo; this.withPads = promoPads;
    this.promoBrand = 1; this.brands = null;
    this.layers = { base: null, homes: null };
    this.pads = [];
    new ResizeObserver(() => this.#resize()).observe(wrap);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { this.layers.base = null; this.layers.homes = null; this.paint(); });
    this.canvas.addEventListener("pointermove", (ev) => this.#pointer(ev));
    this.canvas.addEventListener("pointerleave", () => { this.hover = -1; tooltip.hide(); this.canvas.style.cursor = ""; this.paint(); });
    this.canvas.addEventListener("click", (ev) => this.#click(ev));
  }

  setGeometry(geo, homesXY) {
    this.geo = geo;
    const n = homesXY.length / 2;
    this.homes = { n, x: homesXY.subarray(0, n), y: homesXY.subarray(n) };
    this.codes = null;
    this.layers.base = null; this.layers.homes = null;
    if (this.promoBrand > geo.brands.length) this.promoBrand = 1;
    if (this.withPads) this.#buildPads();
    this.wrap.style.aspectRatio = `${geo.width} / ${geo.height}`;
    this.#resize();
  }

  setHomes(codes, mode) { this.codes = codes; this.mode = mode; this.layers.homes = null; this.paint(); }
  setTravellers(t) { this.travellers = t; this.paint(); }
  setStores(stats) { this.storeStats = stats; this.paint(); }
  setSelected(h) { this.selected = h; this.paint(); }
  setCaption(text) { this.caption.textContent = text; this.caption.hidden = !text; }

  // The local promotion pads: one per area, starting or stopping the
  // chosen brand's promotion there.
  setPromoBrand(b) { this.promoBrand = b; this.setPromos(this.brands); }
  setPromos(brands) {
    this.brands = brands;
    const br = brands?.[this.promoBrand - 1];
    for (const pad of this.pads) {
      const left = br?.local_left?.[pad.area] ?? 0;
      const block = left > 0 ? "" : br?.local_block?.[pad.area] ?? "";
      pad.button.setAttribute("aria-pressed", String(left > 0));
      pad.button.disabled = !!block;
      pad.button.textContent = left > 0 ? `Stop (${left} d)` : "Start";
      pad.button.style.setProperty("--brand", `var(--brand-${this.promoBrand})`);
      pad.button.title = block ? `${br?.name ?? ""} can't start a promotion in ${this.geo.areas[pad.area].name}: it would overlap ${block}`
        : `${br?.name ?? ""} local promotion in ${this.geo.areas[pad.area].name}${left > 0 ? `: ${left} days left (click to stop)` : " (click to start, from tomorrow)"}`;
    }
  }

  // ---- Geometry ---------------------------------------------------------------

  get scale() { return this.canvas.width / this.geo.width; }
  toPx(x, y) { const k = this.scale; return [x * k, (this.geo.height - y) * k]; }
  toWorld(px, py) { const k = this.scale; return [px / k, this.geo.height - py / k]; }

  #resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.wrap.clientWidth * dpr));
    const h = this.geo ? Math.round(w * this.geo.height / this.geo.width) : Math.round(w * 0.75);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.layers.base = null; this.layers.homes = null;
    }
    this.#placePads();
    this.paint();
  }

  #buildPads() {
    this.overlay.replaceChildren();
    this.pads = this.geo.areas.map((area, k) => {
      if (!Number.isFinite(area.x)) return null;
      const button = el("button", { type: "button", "aria-pressed": "false", text: "Start",
        onclick: (ev) => { ev.stopPropagation(); this.onLocalPromo?.(this.promoBrand, k + 1); } });
      const node = el("div", { class: "promo-pad" }, el("div", { class: "pad-title", text: area.name }), button);
      this.overlay.append(node);
      return { node, button, area: k };
    }).filter(Boolean);
    this.#placePads();
    if (this.brands) this.setPromos(this.brands);
  }

  // Each area's pad sits where its name goes.
  #placePads() {
    if (!this.geo || !this.pads.length || !this.canvas.width) return;
    const dpr = window.devicePixelRatio || 1;
    for (const pad of this.pads) {
      const a = this.geo.areas[pad.area];
      const [px, py] = this.toPx(a.x, a.y);
      Object.assign(pad.node.style, { left: `${px / dpr}px`, top: `${py / dpr}px` });
    }
  }

  // ---- Painting ---------------------------------------------------------------

  #buildBase() {
    const g = this.geo; const W = this.canvas.width; const H = this.canvas.height;
    const layer = new OffscreenCanvas(W, H); const ctx = layer.getContext("2d");
    const root = this.wrap;
    const land = LAND_VARS.map((v) => (v ? cssVar(v, root) : null));
    const dark = isDark();
    const homeBase = cssVar("--map-homes", root);
    const tints = g.areas.map((a) => (dark ? mix(a.colour, cssVar("--map-land", root), 0.78) : a.colour));
    // Land use, one pixel per tile (homes in their area's tint, denser
    // darker; roads as the land under them), then scaled up smoothly.
    const img = new ImageData(g.nx, g.ny);
    for (let i = 0; i < g.land.length; i++) {
      const code = g.land[i];
      let c;
      if (code === 3) {
        const base = tints[g.area[i] - 1] ?? mix(cssVar("--map-land", root), homeBase, 0.5);
        c = hex(mix(base, homeBase, dark ? 0.05 + 0.03 * g.density[i] : 0.04 * g.density[i]));
      } else c = hex(land[code] ?? land[0]);
      img.data.set([c[0], c[1], c[2], 255], i * 4);
    }
    const tmp = new OffscreenCanvas(g.nx, g.ny); tmp.getContext("2d").putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tmp, 0, 0, W, H);
    // Roads: a line along each run of road tiles, bridges and all. Two road
    // tiles touching only at a corner are joined where a trip can cross
    // that corner: the router never cuts one past water (grid.R).
    const k = this.scale; const p = g.patch;
    const isRoad = (r, c) => r >= 0 && c >= 0 && r < g.ny && c < g.nx && (g.land[r * g.nx + c] === 5 || g.land[r * g.nx + c] === 6);
    const passable = (r, c) => g.land[r * g.nx + c] !== 1;
    const diagonal = (r, c, r2, c2) => isRoad(r2, c2) && !isRoad(r, c2) && !isRoad(r2, c) && passable(r, c2) && passable(r2, c);
    const cx = (c) => (c + 0.5) * p * k; const cy = (r) => (r + 0.5) * p * k;
    const roads = new Path2D();
    for (let r = 0; r < g.ny; r++) for (let c = 0; c < g.nx; c++) {
      if (!isRoad(r, c)) continue;
      const link = (r2, c2) => { roads.moveTo(cx(c), cy(r)); roads.lineTo(cx(c2), cy(r2)); };
      if (isRoad(r, c + 1)) link(r, c + 1);
      if (isRoad(r + 1, c)) link(r + 1, c);
      if (diagonal(r, c, r + 1, c + 1)) link(r + 1, c + 1);
      if (diagonal(r, c, r + 1, c - 1)) link(r + 1, c - 1);
      const alone = !isRoad(r - 1, c) && !isRoad(r + 1, c) && !isRoad(r, c - 1) && !isRoad(r, c + 1) &&
        !diagonal(r, c, r - 1, c - 1) && !diagonal(r, c, r - 1, c + 1) && !diagonal(r, c, r + 1, c - 1) && !diagonal(r, c, r + 1, c + 1);
      if (alone) { roads.moveTo(cx(c), cy(r)); roads.lineTo(cx(c) + 0.1, cy(r)); }
    }
    const dpr = window.devicePixelRatio || 1;
    const rw = Math.max(2, 0.52 * p * k);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = cssVar("--map-road-edge", root); ctx.lineWidth = rw + Math.max(1, 2 * dpr); ctx.stroke(roads);
    ctx.strokeStyle = cssVar("--map-road", root); ctx.lineWidth = rw; ctx.stroke(roads);
    // Area names (where there are pads, the pad carries the name).
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const a of this.withPads ? [] : g.areas) {
      if (!Number.isFinite(a.x)) continue;
      const [px, py] = this.toPx(a.x, a.y);
      ctx.font = `650 ${Math.round(14 * dpr)}px ${cssVar("--font", root) || "system-ui"}`;
      halo(ctx, a.name.toUpperCase(), px, py, cssVar("--map-label", root), cssVar("--map-land", root), dpr, 0.16);
    }
    this.layers.base = layer;
  }

  #buildHomes() {
    const W = this.canvas.width; const H = this.canvas.height;
    const layer = new OffscreenCanvas(W, H); const ctx = layer.getContext("2d");
    if (this.homes && this.codes) {
      const palette = this.#homePalette();
      const k = this.scale; const gh = this.geo.height;
      const size = Math.max(1.5, (window.devicePixelRatio || 1) * 1.6);
      // One path per colour.
      const paths = palette.map(() => new Path2D());
      for (let i = 0; i < this.homes.n; i++) {
        const c = this.codes[i]; const p = paths[c] ?? paths[0];
        p.rect(this.homes.x[i] * k - size / 2, (gh - this.homes.y[i]) * k - size / 2, size, size);
      }
      // Households that haven't bought yet (or are in no offer) go under
      // the rest, and recede when offers are shown.
      paths.forEach((p, c) => { ctx.globalAlpha = c === 0 && this.mode === "offer" ? 0.35 : 1; ctx.fillStyle = palette[c]; ctx.fill(p); });
      ctx.globalAlpha = 1;
    }
    this.layers.homes = layer;
  }

  #homePalette() {
    const r = this.wrap; const g = this.geo;
    switch (this.mode) {
      case "segment": return ["#999", ...g.segments.map((s) => s.colour)];
      case "offer": return [cssVar("--brand-0", r), cssVar("--offer-0", r), cssVar("--offer-1", r), cssVar("--offer-2", r)];
      case "area": return [cssVar("--brand-0", r), ...g.areas.map((a) => mix(a.colour, "#555555", 0.55))];
      default: return [cssVar("--brand-0", r), ...g.brands.map((b) => b.colour)];
    }
  }

  paint() {
    const ctx = this.ctx; const W = this.canvas.width; const H = this.canvas.height;
    if (!this.geo) { ctx.clearRect(0, 0, W, H); return; }
    if (!this.layers.base) this.#buildBase();
    if (!this.layers.homes) this.#buildHomes();
    ctx.drawImage(this.layers.base, 0, 0);
    ctx.drawImage(this.layers.homes, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    const r = this.wrap; const surface = cssVar("--surface", r);
    const colours = this.geo.brands.map((b) => b.colour);

    // Shoppers on the road.
    const t = this.travellers;
    if (t && t.n) {
      const rad = Math.max(3, 3.4 * dpr);
      for (let pass = 0; pass < 2; pass++) {
        const paths = colours.map(() => new Path2D());
        for (let i = 0; i < t.n; i++) {
          if ((t.back[i] === 1) !== (pass === 0)) continue;
          const p = paths[t.brand[i] - 1]; if (!p) continue;
          const [px, py] = this.toPx(t.x[i], t.y[i]);
          p.moveTo(px + rad, py); p.arc(px, py, rad, 0, Math.PI * 2);
        }
        // Heading home (first, underneath) fades; heading out is solid,
        // ringed so it stands off the households.
        ctx.globalAlpha = pass === 0 ? 0.55 : 1;
        paths.forEach((p, b) => {
          ctx.lineWidth = Math.max(1.5, 1.6 * dpr); ctx.strokeStyle = surface; ctx.stroke(p);
          ctx.fillStyle = colours[b]; ctx.fill(p);
        });
      }
      ctx.globalAlpha = 1;
    }

    // Stores: a square in the brand's colour, grown by today's visits.
    const stats = this.storeStats;
    const maxVisits = Math.max(1, ...(stats ?? []).map((s) => s.visits));
    const placed = [];
    const ink = cssVar("--map-label", r); const land = cssVar("--map-land", r);
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.font = `600 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
    const order = this.geo.stores.map((s, i) => i).sort((a, b) => this.geo.stores[b].y - this.geo.stores[a].y);
    const labels = this.geo.stores.length <= 40 || this.canvas.width / dpr > 900;
    for (const i of order) {
      const st = this.geo.stores[i]; const stat = stats?.[i];
      const [px, py] = this.toPx(st.x, st.y);
      const size = storeSize(st.space) * dpr;
      const colour = colours[st.brand - 1] ?? "#888";
      if (stat) {
        const glow = size * (0.9 + 1.4 * Math.sqrt(stat.visits / maxVisits));
        ctx.beginPath(); ctx.arc(px, py, glow, 0, Math.PI * 2);
        ctx.fillStyle = colour; ctx.globalAlpha = 0.16; ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.fillStyle = colour;
      ctx.strokeStyle = surface; ctx.lineWidth = 2 * dpr;
      roundRect(ctx, px - size, py - size, 2 * size, 2 * size, 3 * dpr); ctx.fill(); ctx.stroke();
      if (stat?.promo) { ctx.fillStyle = "#fff"; ctx.font = `700 ${Math.round(9 * dpr)}px system-ui`; ctx.textAlign = "center"; ctx.fillText("%", px, py + 0.5); ctx.textAlign = "left"; ctx.font = `600 ${Math.round(11 * dpr)}px system-ui, sans-serif`; }
      if (i === this.hover) { ctx.strokeStyle = ink; ctx.lineWidth = 1.5 * dpr; roundRect(ctx, px - size - 3 * dpr, py - size - 3 * dpr, 2 * size + 6 * dpr, 2 * size + 6 * dpr, 4 * dpr); ctx.stroke(); }
      if (!labels && i !== this.hover) continue;
      // Label to the right, moved down past any label already there.
      const label = st.short;
      const w = ctx.measureText(label).width; const h = 13 * dpr;
      const lx = px + size + 4 * dpr; let ly = py;
      for (let tries = 0; tries < 6 && placed.some((b) => lx < b.x + b.w && lx + w > b.x && ly - h / 2 < b.y + b.h / 2 && ly + h / 2 > b.y - b.h / 2); tries++) ly += h;
      placed.push({ x: lx, y: ly, w, h });
      halo(ctx, label, lx, ly, ink, land, dpr, 0);
    }

    // The household picked for the preference card.
    if (this.selected) {
      const [px, py] = this.toPx(this.selected.x, this.selected.y);
      ctx.beginPath(); ctx.arc(px, py, 7 * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = ink; ctx.lineWidth = 2 * dpr; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 11 * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = surface; ctx.lineWidth = 2 * dpr; ctx.stroke();
    }
  }

  // ---- Pointer ------------------------------------------------------------------

  #storeAt(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const k = this.canvas.width / rect.width;
    const px = (ev.clientX - rect.left) * k; const py = (ev.clientY - rect.top) * k;
    let best = -1; let bd = (14 * (window.devicePixelRatio || 1)) ** 2;
    this.geo.stores.forEach((st, i) => {
      const [sx, sy] = this.toPx(st.x, st.y);
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return { best, px, py };
  }

  #pointer(ev) {
    if (!this.geo) return;
    const { best } = this.#storeAt(ev);
    if (best !== this.hover) { this.hover = best; this.paint(); }
    this.canvas.style.cursor = best >= 0 ? "pointer" : "crosshair";
    if (best < 0) return tooltip.hide();
    const st = this.geo.stores[best]; const stat = this.storeStats?.[best];
    tooltip.show(ev, st.name, [
      { colour: this.geo.brands[st.brand - 1]?.colour, value: this.geo.brands[st.brand - 1]?.name, name: `${st.format} layout · ${st.area ? this.geo.areas[st.area - 1]?.name : "outside every area"}` },
      { value: fmt.int(stat?.visits), name: "visits today" },
      { value: fmt.int(stat?.inside), name: "in the store now" },
      { value: fmt.money(stat?.sales), name: "sales this season" },
      { value: "Click", name: "to open its floor" },
    ]);
  }

  #click(ev) {
    if (!this.geo) return;
    const { best, px, py } = this.#storeAt(ev);
    if (best >= 0) return this.onStore?.(best + 1);
    const [x, y] = this.toWorld(px, py);
    this.onHome?.(x, y);
  }
}

// ---- Drawing helpers --------------------------------------------------------------

const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function halo(ctx, str, x, y, ink, bg, dpr, spacing) {
  if (spacing) str = str.split("").join(String.fromCharCode(8202));
  ctx.lineWidth = 3.5 * dpr; ctx.strokeStyle = bg; ctx.lineJoin = "round";
  ctx.strokeText(str, x, y); ctx.fillStyle = ink; ctx.fillText(str, x, y);
}

function hex(c) {
  if (!c) return [200, 200, 200];
  c = c.trim();
  if (c.startsWith("rgb")) return c.match(/[\d.]+/g).slice(0, 3).map(Number);
  const h = c.replace("#", "");
  const v = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
}

export function mix(a, b, t) {
  const A = hex(a); const B = hex(b);
  const c = A.map((v, i) => Math.round(v * (1 - t) + B[i] * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
