// A store's floor: the plan from R (one cell per half-metre), its racks
// coloured by category and named (racks of a category the store's brand
// doesn't sell stand empty), and everyone in the store at this second
// of store time — shoppers coloured by what they're doing, cashiers at
// their tills, assistants on the floor, each worker with their number. The
// heat mode shades each cell by how much footfall it has had today. The
// agent in the inspector is ringed.

import { cssVar, el } from "./ui.js";
import { tooltip } from "./charts.js";

// FLOOR_CODES in model/floors.R: 0 floor, 1 wall, 2 door, 12 fitting
// cubicle, 13 till counter, 14 behind the counter, 15 stockroom, 16 queue;
// RACK_CODE + k the racks of the world's k-th category.
const RACK_CODE = 100;
export const LOOK_NAMES = ["browsing", "carrying items", "queuing", "trying on", "paying", "leaving empty-handed", "leaving with a bag"];

export class FloorView {
  constructor(wrap, { onClick } = {}) {
    this.wrap = wrap;
    this.canvas = el("canvas", { "aria-label": "Store floor plan with shoppers and staff" });
    this.caption = el("div", { class: "view-caption" });
    wrap.append(this.canvas, this.caption);
    this.ctx = this.canvas.getContext("2d");
    this.plan = null; this.agents = null; this.heat = null; this.mode = "floor"; this.follow = null; this.inspect = null;
    this.base = null; this.onClick = onClick; this.sells = null;
    new ResizeObserver(() => this.#resize()).observe(wrap);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { this.base = null; this.paint(); });
    this.canvas.addEventListener("click", (ev) => { const [x, y] = this.#cellAt(ev); this.onClick?.(x, y); });
    this.canvas.addEventListener("pointermove", (ev) => this.#pointer(ev));
    this.canvas.addEventListener("pointerleave", () => tooltip.hide());
  }

  setPlan(plan) {
    if (this.plan === plan) return;
    this.plan = plan; this.base = null; this.heat = null;
    this.#resize();
  }
  setMode(mode) { this.mode = mode; this.paint(); }
  // The categories the store's brand sells (numbers, 1-based); racks of the
  // rest stand empty.
  setSells(cats) {
    const next = cats ? new Set(cats) : null;
    if (JSON.stringify([...(next ?? [])]) === JSON.stringify([...(this.sells ?? [])])) return;
    this.sells = next; this.base = null; this.paint();
  }
  setAgents(a) { this.agents = a; this.paint(); }
  setHeat(h) { this.heat = h; if (this.mode === "heat") this.paint(); }
  setFollow(v) { this.follow = v; }
  // The inspector's agent: { kind: "shopper", visit } or { kind: "cashier" | "assistant", server }.
  setInspect(target) { this.inspect = target; this.paint(); }
  setCaption(text) { this.caption.textContent = text; this.caption.hidden = !text; }

  get cell() { return this.canvas.width / this.plan.width; }

  #resize() {
    if (!this.plan) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.wrap.clientWidth * dpr));
    const h = Math.round(w * this.plan.height / this.plan.width);
    this.wrap.style.aspectRatio = `${this.plan.width} / ${this.plan.height}`;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.base = null; }
    this.paint();
  }

  #buildBase() {
    const p = this.plan; const c = this.cell; const r = this.wrap;
    const layer = new OffscreenCanvas(this.canvas.width, this.canvas.height); const ctx = layer.getContext("2d");
    const floor = cssVar("--floor-bg", r); const wall = cssVar("--floor-wall", r); const line = cssVar("--floor-line", r);
    const surface = cssVar("--surface", r);
    const catColour = (k) => cssVar(`--cat-${k}`, r);
    ctx.fillStyle = floor; ctx.fillRect(0, 0, layer.width, layer.height);
    // A faint floor grid, one line per metre.
    ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x <= p.width; x += 2) { ctx.moveTo(x * c + 0.5, 0); ctx.lineTo(x * c + 0.5, layer.height); }
    for (let y = 0; y <= p.height; y += 2) { ctx.moveTo(0, y * c + 0.5); ctx.lineTo(layer.width, y * c + 0.5); }
    ctx.stroke();
    for (let row = 0; row < p.height; row++) {
      for (let col = 0; col < p.width; col++) {
        const code = p.codes[row * p.width + col];
        const x = col * c; const y = row * c;
        let fill = null;
        if (code === 1) fill = wall;
        else if (code > RACK_CODE) fill = this.sells && !this.sells.has(code - RACK_CODE) ? mixAlpha(cssVar("--muted", r), 0.12) : mixAlpha(catColour(code - RACK_CODE), 0.55);
        else if (code === 12) fill = mixAlpha(cssVar("--fitting", r), 0.22);
        else if (code === 13) fill = cssVar("--muted", r);
        else if (code === 14) fill = mixAlpha(cssVar("--muted", r), 0.18);
        else if (code === 15) fill = mixAlpha(cssVar("--muted", r), 0.3);
        else if (code === 16) fill = mixAlpha(cssVar("--muted", r), 0.1);
        else if (code === 2) fill = mixAlpha(cssVar("--good", r), 0.5);
        if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, c + 0.5, c + 0.5); }
      }
    }
    // Cubicle walls read as a block of rooms.
    ctx.strokeStyle = surface; ctx.lineWidth = Math.max(1, c * 0.12);
    for (const [x, y, w, h] of p.cubicle_boxes ?? []) ctx.strokeRect(x * c, (p.height - y - h) * c, c * w, c * h);
    // Names on the fixtures.
    const dpr = window.devicePixelRatio || 1;
    const ink = cssVar("--ink", r);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const lab of p.labels) {
      const px = (lab.x + 0.5) * c; const py = (p.height - 1 - lab.y + 0.5) * c;
      ctx.save();
      ctx.translate(px, py);
      if (lab.vertical) ctx.rotate(-Math.PI / 2);
      ctx.font = `600 ${Math.round(Math.max(9, Math.min(13, (c / dpr) * 1.2)) * dpr)}px system-ui, sans-serif`;
      ctx.lineWidth = 3 * dpr; ctx.strokeStyle = floor;
      const empty = lab.category && this.sells && !this.sells.has(lab.category);
      const txt = empty ? `${lab.text} (not stocked)` : lab.text;
      ctx.strokeText(txt, 0, 0);
      ctx.fillStyle = empty ? cssVar("--ink-2", r) : ink; ctx.fillText(txt, 0, 0);
      ctx.restore();
    }
    // The ways in and out: named just inside each door.
    ctx.font = `600 ${Math.round(11 * dpr)}px system-ui`; ctx.fillStyle = ink;
    for (const [dx, dy] of p.doors ?? []) {
      const px = (dx + 0.5) * c; const py = (p.height - 0.5 - dy) * c;
      if (dy === 0) { ctx.textAlign = "center"; ctx.fillText("Entrance · exit", px, py - c * 1.5); }
      else if (dy === p.height - 1) { ctx.textAlign = "center"; ctx.fillText("Entrance · exit", px, py + c * 1.5); }
      else if (dx === 0) { ctx.textAlign = "left"; ctx.fillText("Entrance · exit", px + c * 1.2, py); }
      else { ctx.textAlign = "right"; ctx.fillText("Entrance · exit", px - c * 1.2, py); }
    }
    ctx.textAlign = "center";
    this.base = layer;
  }

  paint() {
    const ctx = this.ctx;
    if (!this.plan) { ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); return; }
    if (!this.base) this.#buildBase();
    ctx.drawImage(this.base, 0, 0);
    const p = this.plan; const c = this.cell; const r = this.wrap; const dpr = window.devicePixelRatio || 1;
    if (this.mode === "heat" && this.heat) this.#paintHeat();
    const a = this.agents;
    if (!a) return;
    // Fitting cubicles in use, and closed.
    (p.cubicle_boxes ?? []).forEach(([x, y, w, h], i) => {
      if (!a.cubOpen[i]) ctx.fillStyle = mixAlpha(cssVar("--muted", r), 0.55);
      else if (a.cubBusy[i]) ctx.fillStyle = mixAlpha(cssVar("--fitting", r), 0.7);
      else return;
      ctx.fillRect(x * c, (p.height - y - h) * c, c * w, c * h);
    });
    const surface = cssVar("--surface", r);
    const X = (x) => (x + 0.5) * c; const Y = (y) => (p.height - 0.5 - y) * c;
    // Shoppers.
    const rad = Math.max(2.5, c * 0.48);
    const looks = [1, 2, 3, 4, 5, 6, 7].map((k) => cssVar(`--look-${k}`, r));
    for (let k = 1; k <= 7; k++) {
      const path = new Path2D();
      for (let i = 0; i < a.n; i++) {
        if (a.look[i] !== k) continue;
        path.moveTo(X(a.x[i]) + rad, Y(a.y[i])); path.arc(X(a.x[i]), Y(a.y[i]), rad, 0, Math.PI * 2);
      }
      ctx.fillStyle = looks[k - 1]; ctx.fill(path);
      ctx.lineWidth = Math.max(1, dpr * 1.2); ctx.strokeStyle = surface; ctx.stroke(path);
    }
    // The shopper being followed.
    const f = this.follow ? [...a.visit].indexOf(this.follow) : -1;
    if (f >= 0) {
      ctx.beginPath(); ctx.arc(X(a.x[f]), Y(a.y[f]), rad * 2.1, 0, Math.PI * 2);
      ctx.strokeStyle = cssVar("--ink", r); ctx.lineWidth = 2 * dpr; ctx.stroke();
    }
    // The worker in the inspector.
    const ins = this.inspect;
    if (ins && ins.kind !== "shopper") {
      for (let i = 0; i < a.staffN; i++) {
        if (a.staffRole[i] !== (ins.kind === "cashier" ? 1 : 2) || a.staffId[i] !== ins.server) continue;
        ctx.beginPath(); ctx.arc(X(a.staffX[i]), Y(a.staffY[i]), Math.max(8, c * 1.3), 0, Math.PI * 2);
        ctx.strokeStyle = cssVar("--focus", r); ctx.lineWidth = 2.5 * dpr; ctx.stroke();
      }
    }
    // Staff: cashiers and assistants, filled when busy.
    for (let i = 0; i < a.staffN; i++) {
      const sx = X(a.staffX[i]); const sy = Y(a.staffY[i]); const sz = Math.max(4, c * 0.62);
      const colour = a.staffRole[i] === 1 ? cssVar("--ink", r) : cssVar("--accent", r);
      ctx.lineWidth = Math.max(1.5, dpr * 1.6);
      ctx.strokeStyle = colour; ctx.fillStyle = a.staffBusy[i] ? colour : surface;
      ctx.fillRect(sx - sz, sy - sz, 2 * sz, 2 * sz); ctx.strokeRect(sx - sz, sy - sz, 2 * sz, 2 * sz);
    }
    // The receipt counter at the tills.
    if (p.tills?.length) {
      const [tx, ty] = p.tills[0];
      ctx.font = `700 ${Math.round(12 * dpr)}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillStyle = cssVar("--ink", r);
      ctx.fillText(`${a.receipts} receipts`, X(tx), Y(ty) - c * 1.4);
    }
  }

  #paintHeat() {
    const p = this.plan; const c = this.cell; const ctx = this.ctx; const h = this.heat;
    let max = 0; for (let i = 0; i < h.length; i++) if (h[i] > max) max = h[i];
    if (!max) return;
    const steps = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
    for (let row = 0; row < p.height; row++) {
      for (let col = 0; col < p.width; col++) {
        const v = h[row * p.width + col];
        if (!(v > 0)) continue;
        const t = Math.sqrt(v / max);
        ctx.globalAlpha = 0.25 + 0.65 * t;
        ctx.fillStyle = steps[Math.min(steps.length - 1, Math.floor(t * steps.length))];
        ctx.fillRect(col * c, row * c, c + 0.5, c + 0.5);
      }
    }
    ctx.globalAlpha = 1;
  }

  #cellAt(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const k = this.canvas.width / rect.width;
    const px = (ev.clientX - rect.left) * k; const py = (ev.clientY - rect.top) * k;
    return [px / this.cell - 0.5, this.plan.height - 0.5 - py / this.cell];
  }

  #pointer(ev) {
    const a = this.agents;
    if (!a || !this.plan) return;
    const [x, y] = this.#cellAt(ev);
    let best = -1; let bd = 2.2;
    for (let i = 0; i < a.n; i++) { const d = (a.x[i] - x) ** 2 + (a.y[i] - y) ** 2; if (d < bd) { bd = d; best = i; } }
    let staff = -1;
    for (let i = 0; i < a.staffN; i++) { const d = (a.staffX[i] - x) ** 2 + (a.staffY[i] - y) ** 2; if (d < bd) { bd = d; staff = i; } }
    this.canvas.style.cursor = best >= 0 || staff >= 0 ? "pointer" : "";
    if (staff >= 0) {
      const role = a.staffRole[staff] === 1 ? "Cashier" : "Assistant";
      return tooltip.show(ev, `${role} ${a.staffId[staff]}`, [{ value: a.staffBusy[staff] ? "busy" : "free" }, { value: "Click", name: "to see their work" }]);
    }
    if (best < 0) return tooltip.hide();
    tooltip.show(ev, `Shopper · visit #${a.visit[best]}`, [
      { colour: `var(--look-${a.look[best]})`, value: LOOK_NAMES[a.look[best] - 1] },
      { value: "Click", name: "to see inside their head" },
    ]);
  }
}

function mixAlpha(colour, alpha) {
  const c = colour.trim();
  if (c.startsWith("#")) {
    const h = c.length === 4 ? c.slice(1).split("").map((x) => x + x).join("") : c.slice(1);
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`;
  }
  return c;
}
