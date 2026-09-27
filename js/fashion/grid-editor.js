// A painted grid, edited with a sprite editor's tools: the canvas both world
// editors share (the market map, a store's floor plan). One character per
// cell, on one or more layers painted over each other (the map's land, and
// its areas on top).
//
//   pencil, rectangle (Shift: just its edge), line, fill, eraser, eyedropper
//   select and move (drag out a block; drag it to move it, with Alt to copy;
//     Delete clears it, Escape drops it)
//   the owner's own tools: a path (dragged out one side-to-side step at a
//     time, shortened by going back along it; the owner says what it paints),
//     and a stamp (a small picture put down with a click; [ and ] turn it)
//   undo and redo (Cmd/Ctrl-Z, Shift-Cmd/Ctrl-Z)
//   canvas size (grow or crop, the content anchored to a chosen edge)
//   zoom (Cmd/Ctrl + wheel or pinch, or the buttons) and pan (the hand
//     tool, Space-drag or the middle button)
//
// The owner says what each character looks like, what the eraser paints,
// and what else to draw on top (stores, problems, overlays); it hears about
// every finished stroke and every block moved, and can keep its own state
// (a map's stores and areas) in the same undo history.

import { el } from "./ui.js";

export const TOOLS = [
  { id: "pencil", label: "Pencil", key: "b", icon: "M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" },
  { id: "rect", label: "Rectangle, Shift for its edge only", key: "r", icon: "M4 5h16v14H4z" },
  { id: "line", label: "Line", key: "l", icon: "M4 20L20 4" },
  { id: "fill", label: "Fill", key: "g", icon: "M16.6 8.9L8.1.4 6.7 1.8l2.4 2.4-5.2 5.2a1.5 1.5 0 0 0 0 2.1l5.5 5.5a1.5 1.5 0 0 0 2.1 0l5.1-5.1a1.5 1.5 0 0 0 0-2.1zM5.2 10L10 5.2 14.8 10H5.2zM19 11.5s-2 2.2-2 3.5a2 2 0 0 0 4 0c0-1.3-2-3.5-2-3.5z" },
  { id: "erase", label: "Eraser", key: "e", icon: "M16.2 3.6l4.2 4.2a1.5 1.5 0 0 1 0 2.1L11 19.3H20v2H8.9l-5.3-5.3a1.5 1.5 0 0 1 0-2.1L14.1 3.6a1.5 1.5 0 0 1 2.1 0zM5.7 15l3.7 3.7L13 15l-3.7-3.7L5.7 15z" },
  { id: "pick", label: "Eyedropper", key: "i", icon: "M20.7 5.6l-2.3-2.3a1 1 0 0 0-1.4 0l-3.1 3.1-1.9-1.9-1.4 1.4 1.4 1.4L3 16.3V21h4.7l9-9 1.4 1.4 1.4-1.4-1.9-1.9 3.1-3.1a1 1 0 0 0 0-1.4zM6.9 19H5v-1.9l8.1-8.1 1.9 1.9L6.9 19z" },
  { id: "select", label: "Select and move", key: "m", icon: "M3 3h4v2H5v2H3V3zm6 0h6v2H9V3zm8 0h4v4h-2V5h-2V3zM3 9h2v6H3V9zm16 0h2v6h-2V9zM3 17h2v2h2v2H3v-4zm16 0h2v4h-4v-2h2v-2zM9 19h6v2H9v-2z" },
  { id: "pan", label: "Pan", key: "h", icon: "M13 1.5a1.5 1.5 0 0 0-3 0V11h-1V3.5a1.5 1.5 0 0 0-3 0V14l-2.3-2.3a1.6 1.6 0 0 0-2.3 2.2L7 19.5A6 6 0 0 0 11.3 22H14a6 6 0 0 0 6-6V6.5a1.5 1.5 0 0 0-3 0V11h-1V2.5a1.5 1.5 0 0 0-3 0V11h-1V1.5z" },
];
const HISTORY = 100;

export class GridEditor {
  // layers: [{ id, erase, colour(ch) -> css colour or null (transparent), alpha }]
  // tools: the owner's own, [{ id, label, key, icon, kind: "path", paint(cells) -> [[r, c, ch]] }
  //   or { ..., kind: "stamp" } (the picture: setStamp)].
  constructor(wrap, { layers, cellPx = 8, tools = [], onStroke, onPick, onHover, onToolChange, onDrop, drawOver, snapshot, restore, pointer }) {
    this.wrap = wrap;
    this.canvas = el("canvas", { tabindex: 0, "aria-label": "Editor canvas" });
    this.status = el("div", { class: "editor-status" });
    wrap.append(this.canvas, this.status);
    this.ctx = this.canvas.getContext("2d");
    this.layers = layers.map((L) => ({ ...L, data: new Uint16Array(0), image: null }));
    this.active = 0;
    this.W = 0; this.H = 0;
    this.zoom = cellPx; this.ox = 0; this.oy = 0;          // screen px per cell, and the view's offset
    this.tool = "pencil";
    this.paint = layers[0].erase;
    this.hover = null; this.drag = null; this.selection = null; this.lifted = null;
    this.highlights = [];
    this.undoStack = []; this.redoStack = [];
    this.extraTools = tools; this.stamp = null;
    this.cb = { onStroke, onPick, onHover, onToolChange, onDrop, drawOver, snapshot, restore, pointer };
    this.spaceDown = false;
    new ResizeObserver(() => this.#resize()).observe(wrap);
    this.canvas.addEventListener("pointerdown", (ev) => this.#down(ev));
    this.canvas.addEventListener("pointermove", (ev) => this.#move(ev));
    this.canvas.addEventListener("pointerup", (ev) => this.#up(ev));
    this.canvas.addEventListener("pointercancel", (ev) => this.#up(ev));
    this.canvas.addEventListener("pointerleave", () => { this.hover = null; this.cb.onHover?.(null); this.draw(); });
    this.canvas.addEventListener("wheel", (ev) => this.#wheel(ev), { passive: false });
    this.canvas.addEventListener("keydown", (ev) => this.#key(ev));
    this.canvas.addEventListener("keyup", (ev) => {
      if (ev.key === " ") { this.spaceDown = false; this.#cursor(); }
      if (ev.key === "Shift") this.#reshape(false);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.refreshColours());
  }

  // ---- Content ---------------------------------------------------------------------

  // Every layer's rows (arrays of strings), all the same size.
  load(rowsByLayer, { keepView = false } = {}) {
    const first = rowsByLayer[0];
    this.H = first.length; this.W = first[0]?.length ?? 0;
    this.layers.forEach((L, i) => { L.data = encodeRows(rowsByLayer[i] ?? [], this.W, this.H, L.erase); L.image = null; });
    this.selection = null; this.lifted = null;
    if (!keepView) this.fit();
    this.draw();
  }

  rows(layer = 0) { return decodeRows(this.layers[layer].data, this.W, this.H); }
  at(layer, r, c) { return String.fromCharCode(this.layers[layer].data[r * this.W + c]); }

  setActive(i) { this.active = i; this.selection = null; this.lifted = null; this.draw(); }
  setPaint(ch) { this.paint = ch; }
  setTool(tool) {
    if (this.lifted) this.#drop();
    this.tool = tool; this.selection = null; this.#cursor(); this.draw();
    this.cb.onToolChange?.(tool);
  }
  setHighlights(tiles) { this.highlights = tiles ?? []; this.draw(); }
  // The stamp tool's picture: rows of characters, a space where it leaves
  // the plan as it is.
  setStamp(rows) { this.stamp = rows; this.draw(); }
  turnStamp(k = 1) {
    for (let i = 0; i < ((k % 4) + 4) % 4; i++) {
      const s = this.stamp; if (!s?.length) return;
      this.stamp = Array.from({ length: s[0].length }, (_, r) => Array.from({ length: s.length }, (_, c) => s[s.length - 1 - c][r]).join(""));
    }
    this.draw();
  }
  #ownTool(id = this.tool) { return this.extraTools.find((t) => t.id === id); }
  refreshColours() { for (const L of this.layers) L.image = null; this.draw(); }

  // ---- History --------------------------------------------------------------------------

  #snapshot() {
    return { W: this.W, H: this.H, data: this.layers.map((L) => L.data.slice()), extra: this.cb.snapshot?.() };
  }
  #restoreSnap(s) {
    this.W = s.W; this.H = s.H;
    this.layers.forEach((L, i) => { L.data = s.data[i].slice(); L.image = null; });
    if (s.extra !== undefined) this.cb.restore?.(s.extra);
    this.selection = null; this.lifted = null;
    this.draw();
  }
  // Before any change: what undo goes back to (with the owner's state as
  // it is now, or as given: a store dragged is recorded as it was picked up).
  record(extra) {
    const snap = this.#snapshot();
    if (extra !== undefined) snap.extra = extra;
    this.undoStack.push(snap);
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  undo() {
    if (this.lifted) this.#drop();
    const s = this.undoStack.pop(); if (!s) return;
    this.redoStack.push(this.#snapshot());
    this.#restoreSnap(s);
    this.cb.onStroke?.({ undo: true });
  }
  redo() {
    const s = this.redoStack.pop(); if (!s) return;
    this.undoStack.push(this.#snapshot());
    this.#restoreSnap(s);
    this.cb.onStroke?.({ redo: true });
  }
  clearHistory() { this.undoStack.length = 0; this.redoStack.length = 0; }

  // ---- Canvas size ---------------------------------------------------------------------------

  // Grows or crops every layer to W x H, the content anchored to an edge
  // (anchor: "nw", "n", "ne", "w", "c", "e", "sw", "s", "se"). Returns how
  // many cells the content moved right and down.
  resize(W, H, anchor = "nw") {
    const dx = anchor.includes("w") ? 0 : anchor.includes("e") ? W - this.W : Math.floor((W - this.W) / 2);
    const dy = anchor.includes("n") ? 0 : anchor.includes("s") ? H - this.H : Math.floor((H - this.H) / 2);
    this.record();
    for (const L of this.layers) {
      const out = new Uint16Array(W * H).fill(L.erase.charCodeAt(0));
      for (let r = 0; r < this.H; r++) {
        const rr = r + dy; if (rr < 0 || rr >= H) continue;
        for (let c = 0; c < this.W; c++) {
          const cc = c + dx; if (cc < 0 || cc >= W) continue;
          out[rr * W + cc] = L.data[r * this.W + c];
        }
      }
      L.data = out; L.image = null;
    }
    this.W = W; this.H = H;
    this.selection = null; this.lifted = null;
    this.fit();
    return { dx, dy };
  }

  // ---- View ---------------------------------------------------------------------------------

  get dpr() { return window.devicePixelRatio || 1; }

  fit() {
    const w = this.wrap.clientWidth; const h = this.wrap.clientHeight;
    if (!this.W || !w || !h) return;
    this.zoom = Math.max(0.5, Math.min((w - 16) / this.W, (h - 16) / this.H));
    this.ox = (w - this.W * this.zoom) / 2; this.oy = (h - this.H * this.zoom) / 2;
    this.draw();
  }

  zoomBy(k, cx = this.wrap.clientWidth / 2, cy = this.wrap.clientHeight / 2) {
    const z = Math.max(0.5, Math.min(64, this.zoom * k));
    this.ox = cx - ((cx - this.ox) * z) / this.zoom; this.oy = cy - ((cy - this.oy) * z) / this.zoom;
    this.zoom = z;
    this.draw();
  }

  // Screen (CSS px within the canvas) to cell, and cell to screen.
  cellAt(x, y) { return { r: Math.floor((y - this.oy) / this.zoom), c: Math.floor((x - this.ox) / this.zoom) }; }
  toScreen(r, c) { return { x: this.ox + c * this.zoom, y: this.oy + r * this.zoom }; }
  inside(r, c) { return r >= 0 && c >= 0 && r < this.H && c < this.W; }

  #resize() {
    const w = this.wrap.clientWidth; const h = this.wrap.clientHeight;
    const cw = Math.round(w * this.dpr); const ch = Math.round(h * this.dpr);
    const first = !this.canvas.width;
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    if (first || !this.sized) { this.sized = true; this.fit(); }
    this.draw();
  }

  // ---- Drawing ----------------------------------------------------------------------------------

  #layerImage(L) {
    if (L.image) return L.image;
    const img = new ImageData(Math.max(1, this.W), Math.max(1, this.H));
    const cache = new Map();
    for (let i = 0; i < L.data.length; i++) {
      const code = L.data[i];
      let rgba = cache.get(code);
      if (!rgba) { rgba = toRgba(L.colour(String.fromCharCode(code)), L.alpha ?? 1); cache.set(code, rgba); }
      img.data.set(rgba, i * 4);
    }
    const c = new OffscreenCanvas(Math.max(1, this.W), Math.max(1, this.H));
    c.getContext("2d").putImageData(img, 0, 0);
    L.image = c;
    return c;
  }

  draw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.#paint(); });
  }

  #paint() {
    const ctx = this.ctx; const d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.W) return;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const w = this.W * this.zoom; const h = this.H * this.zoom;
    this.layers.forEach((L) => { if (!L.hidden) ctx.drawImage(this.#layerImage(L), this.ox, this.oy, w, h); });
    // Grid lines once cells are big enough to paint one by one.
    if (this.zoom >= 9) {
      ctx.strokeStyle = "rgba(128,128,128,0.18)"; ctx.lineWidth = 1 / d; ctx.beginPath();
      for (let c = 0; c <= this.W; c++) { const x = this.ox + c * this.zoom; ctx.moveTo(x, this.oy); ctx.lineTo(x, this.oy + h); }
      for (let r = 0; r <= this.H; r++) { const y = this.oy + r * this.zoom; ctx.moveTo(this.ox, y); ctx.lineTo(this.ox + w, y); }
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(128,128,128,0.6)"; ctx.lineWidth = 1; ctx.strokeRect(this.ox - 0.5, this.oy - 0.5, w + 1, h + 1);
    this.cb.drawOver?.(ctx, this);
    // A block being moved.
    if (this.lifted) {
      const L = this.layers[this.active]; const b = this.lifted;
      for (let r = 0; r < b.h; r++) for (let c = 0; c < b.w; c++) {
        const ch = String.fromCharCode(b.cells[r * b.w + c]);
        const col = L.colour(ch);
        if (!col) continue;
        const p = this.toScreen(b.r + r, b.c + c);
        ctx.globalAlpha = 0.85; ctx.fillStyle = col; ctx.fillRect(p.x, p.y, this.zoom, this.zoom);
      }
      ctx.globalAlpha = 1;
    }
    // The shape being drawn, before it's let go.
    if (this.drag?.preview) this.#paintCells(this.drag.preview, this.drag.value);
    // The stamp, where a click would put it.
    if (this.tool === "stamp" && this.stamp && this.hover && !this.drag) this.#paintCells(this.#stampCells(this.hover.r, this.hover.c));
    // Problems' tiles.
    if (this.highlights.length) {
      ctx.strokeStyle = "#e03131"; ctx.lineWidth = Math.max(1.5, Math.min(3, this.zoom / 4));
      for (const [r, c] of this.highlights) { const p = this.toScreen(r, c); ctx.strokeRect(p.x + 0.5, p.y + 0.5, this.zoom - 1, this.zoom - 1); }
    }
    const sel = this.selection ?? (this.lifted ? { r0: this.lifted.r, c0: this.lifted.c, r1: this.lifted.r + this.lifted.h - 1, c1: this.lifted.c + this.lifted.w - 1 } : null);
    if (sel) {
      const p = this.toScreen(sel.r0, sel.c0);
      ctx.setLineDash([4, 3]); ctx.strokeStyle = "#1c7ed6"; ctx.lineWidth = 1.5;
      ctx.strokeRect(p.x, p.y, (sel.c1 - sel.c0 + 1) * this.zoom, (sel.r1 - sel.r0 + 1) * this.zoom);
      ctx.setLineDash([]);
    }
    if (this.hover && this.inside(this.hover.r, this.hover.c) && !["pan", "select", "stamp"].includes(this.tool)) {
      const p = this.toScreen(this.hover.r, this.hover.c);
      ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1; ctx.strokeRect(p.x + 0.5, p.y + 0.5, this.zoom - 1, this.zoom - 1);
    }
    this.status.textContent = this.hover && this.inside(this.hover.r, this.hover.c)
      ? `row ${this.hover.r + 1}, column ${this.hover.c + 1} · ${this.W} × ${this.H}` : `${this.W} × ${this.H}`;
  }

  // Cells about to be painted: [r, c] in `value`, or [r, c, ch].
  #paintCells(cells, value) {
    const ctx = this.ctx; const L = this.layers[this.active];
    ctx.globalAlpha = 0.75;
    for (const [r, c, ch] of cells) {
      if (!this.inside(r, c)) continue;
      ctx.fillStyle = L.colour(ch ?? value) ?? "rgba(128,128,128,0.4)";
      const p = this.toScreen(r, c); ctx.fillRect(p.x, p.y, this.zoom, this.zoom);
    }
    ctx.globalAlpha = 1;
  }

  // ---- Painting ----------------------------------------------------------------------------------

  #set(r, c, ch, changed) {
    if (!this.inside(r, c)) return;
    const L = this.layers[this.active];
    const i = r * this.W + c;
    const code = this.cb.transform ? this.cb.transform(ch, String.fromCharCode(L.data[i])).charCodeAt(0) : ch.charCodeAt(0);
    if (L.data[i] !== code) { L.data[i] = code; changed.n++; }
  }

  // What painting `ch` over `old` leaves (a road over water is a bridge).
  set transform(fn) { this.cb.transform = fn; }

  #fill(r, c, ch) {
    const L = this.layers[this.active];
    const target = L.data[r * this.W + c];
    const code = ch.charCodeAt(0);
    if (target === code) return 0;
    const stack = [r * this.W + c]; let n = 0;
    const seen = new Uint8Array(this.W * this.H);
    while (stack.length) {
      const i = stack.pop();
      if (seen[i] || L.data[i] !== target) continue;
      seen[i] = 1;
      const rr = Math.floor(i / this.W); const cc = i % this.W;
      const changed = { n: 0 };
      this.#set(rr, cc, ch, changed); n += changed.n;
      if (cc > 0) stack.push(i - 1);
      if (cc < this.W - 1) stack.push(i + 1);
      if (rr > 0) stack.push(i - this.W);
      if (rr < this.H - 1) stack.push(i + this.W);
    }
    return n;
  }

  #valueFor() { return this.tool === "erase" ? this.layers[this.active].erase : this.paint; }

  // The stamp's cells with its top left at (r, c): [r, c, ch].
  #stampCells(r, c) {
    const out = [];
    (this.stamp ?? []).forEach((row, i) => { for (let j = 0; j < row.length; j++) if (row[j] !== " ") out.push([r + i, c + j, row[j]]); });
    return out;
  }

  // Paints [r, c, ch] cells as one step of the history.
  #apply(cells) {
    const snap = this.#snapshot(); const changed = { n: 0 };
    for (const [r, c, ch] of cells) this.#set(r, c, ch, changed);
    if (changed.n) this.#commit(snap); else this.draw();
  }

  // ---- Pointer ---------------------------------------------------------------------------------------

  #pos(ev) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  #cursor() {
    const t = this.spaceDown ? "pan" : this.tool;
    this.canvas.style.cursor = { pan: "grab", pick: "copy", select: "crosshair" }[t] ?? "crosshair";
  }

  #down(ev) {
    this.canvas.focus();
    const { x, y } = this.#pos(ev);
    const cell = this.cellAt(x, y);
    // The owner may take the click (a store on the map).
    if (ev.button === 0 && !this.spaceDown && this.cb.pointer?.down?.(ev, cell, this)) return;
    try { this.canvas.setPointerCapture(ev.pointerId); } catch { /* a pointer the browser no longer tracks */ }
    if (ev.button === 1 || this.spaceDown || this.tool === "pan") {
      this.drag = { kind: "pan", x, y, ox: this.ox, oy: this.oy };
      this.canvas.style.cursor = "grabbing";
      return;
    }
    if (ev.button !== 0) return;
    const { r, c } = cell;
    switch (this.tool) {
      case "pencil": case "erase": {
        const snap = this.#snapshot(); const changed = { n: 0 };
        this.#set(r, c, this.#valueFor(), changed);
        this.drag = { kind: "paint", r, c, snap, changed };
        this.layers[this.active].image = null; this.draw();
        break;
      }
      case "rect": case "line":
        this.drag = { kind: this.tool, r0: r, c0: c, r1: r, c1: c, value: this.paint, preview: shape(this.tool, r, c, r, c) };
        this.draw();
        break;
      case "stamp":
        if (this.stamp) this.#apply(this.#stampCells(r, c));
        break;
      case "fill": {
        if (!this.inside(r, c)) return;
        const snap = this.#snapshot();
        if (this.#fill(r, c, this.paint)) { this.#commit(snap); }
        break;
      }
      case "pick":
        if (!this.inside(r, c)) return;
        this.paint = this.at(this.active, r, c);
        this.cb.onPick?.(this.paint);
        break;
      case "select": {
        const s = this.selection;
        if (this.lifted && inBlock(this.lifted, r, c)) {
          this.drag = { kind: "move", r, c, br: this.lifted.r, bc: this.lifted.c };
        } else if (s && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1) {
          this.#lift(ev.altKey);
          this.drag = { kind: "move", r, c, br: this.lifted.r, bc: this.lifted.c };
        } else {
          if (this.lifted) this.#drop();
          this.selection = null;
          this.drag = { kind: "select", r0: clampTo(r, this.H), c0: clampTo(c, this.W) };
          this.selection = { r0: this.drag.r0, c0: this.drag.c0, r1: this.drag.r0, c1: this.drag.c0 };
          this.draw();
        }
        break;
      }
      default: {
        const own = this.#ownTool();
        if (own?.kind !== "path" || !this.inside(r, c)) break;
        this.drag = { kind: "path", paint: own.paint, cells: [[r, c]] };
        this.drag.preview = own.paint(this.drag.cells);
        this.draw();
        break;
      }
    }
  }

  #move(ev) {
    const { x, y } = this.#pos(ev);
    const cell = this.cellAt(x, y);
    if (this.cb.pointer?.move?.(ev, cell, this)) return;
    const was = this.hover;
    this.hover = cell;
    if (!was || was.r !== cell.r || was.c !== cell.c) this.cb.onHover?.(this.inside(cell.r, cell.c) ? cell : null);
    const dg = this.drag;
    if (!dg) { this.draw(); return; }
    if (dg.kind === "pan") { this.ox = dg.ox + x - dg.x; this.oy = dg.oy + y - dg.y; this.draw(); return; }
    if (dg.kind === "paint") {
      for (const [r, c] of lineCells(dg.r, dg.c, cell.r, cell.c)) this.#set(r, c, this.#valueFor(), dg.changed);
      dg.r = cell.r; dg.c = cell.c;
      this.layers[this.active].image = null;
    } else if (dg.kind === "rect" || dg.kind === "line") {
      dg.r1 = cell.r; dg.c1 = cell.c;
      dg.preview = shape(dg.kind, dg.r0, dg.c0, dg.r1, dg.c1, ev.shiftKey).filter(([r, c]) => this.inside(r, c));
    } else if (dg.kind === "path") {
      // One side-to-side step at a time; going back along the path shortens it.
      const [r0, c0] = dg.cells[dg.cells.length - 1];
      for (const [r, c] of lineCells(r0, c0, cell.r, cell.c).slice(1)) {
        if (!this.inside(r, c)) break;
        const k = dg.cells.findIndex(([rr, cc]) => rr === r && cc === c);
        if (k >= 0) dg.cells.length = k + 1; else dg.cells.push([r, c]);
      }
      dg.preview = dg.paint(dg.cells);
    } else if (dg.kind === "select") {
      const r1 = clampTo(cell.r, this.H); const c1 = clampTo(cell.c, this.W);
      this.selection = { r0: Math.min(dg.r0, r1), c0: Math.min(dg.c0, c1), r1: Math.max(dg.r0, r1), c1: Math.max(dg.c0, c1) };
    } else if (dg.kind === "move") {
      this.lifted.r = dg.br + cell.r - dg.r; this.lifted.c = dg.bc + cell.c - dg.c;
    }
    this.draw();
  }

  #up(ev) {
    if (this.cb.pointer?.up?.(ev, this)) return;
    const dg = this.drag; this.drag = null;
    if (!dg) return;
    if (dg.kind === "pan") { this.#cursor(); return; }
    if (dg.kind === "paint") { if (dg.changed.n) this.#commit(dg.snap); return; }
    if (dg.kind === "rect" || dg.kind === "line") {
      const cells = dg.kind === "rect" ? shape("rect", dg.r0, dg.c0, dg.r1, dg.c1, ev.shiftKey).filter(([r, c]) => this.inside(r, c)) : dg.preview;
      this.#apply(cells.map(([r, c]) => [r, c, dg.value]));
      return;
    }
    if (dg.kind === "path") { this.#apply(dg.preview); return; }
    if (dg.kind === "select") { this.draw(); return; }
    if (dg.kind === "move") this.draw();
  }

  #commit(snap) {
    this.undoStack.push(snap);
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.layers[this.active].image = null;
    this.draw();
    this.cb.onStroke?.({});
  }

  // Selection: lift the block (leaving the eraser's value behind, unless
  // copying), move it, drop it.
  #lift(copy) {
    const s = this.selection; const L = this.layers[this.active];
    const w = s.c1 - s.c0 + 1; const h = s.r1 - s.r0 + 1;
    const cells = new Uint16Array(w * h);
    this.liftSnap = this.#snapshot();
    const erase = L.erase.charCodeAt(0);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = (s.r0 + r) * this.W + s.c0 + c;
      cells[r * w + c] = L.data[i];
      if (!copy) L.data[i] = erase;
    }
    L.image = null;
    this.lifted = { r: s.r0, c: s.c0, w, h, cells, r0: s.r0, c0: s.c0, copy };
    this.selection = null;
  }

  #drop() {
    const b = this.lifted; if (!b) return;
    const L = this.layers[this.active];
    for (let r = 0; r < b.h; r++) for (let c = 0; c < b.w; c++) {
      const rr = b.r + r; const cc = b.c + c;
      if (this.inside(rr, cc)) L.data[rr * this.W + cc] = b.cells[r * b.w + c];
    }
    this.lifted = null;
    this.cb.onDrop?.({ layer: this.active, r0: b.r0, c0: b.c0, w: b.w, h: b.h, dr: b.r - b.r0, dc: b.c - b.c0, copy: b.copy });
    this.#commit(this.liftSnap);
  }

  #clearSelection() {
    const s = this.selection; if (!s) return;
    const snap = this.#snapshot(); const changed = { n: 0 };
    const erase = this.layers[this.active].erase;
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) this.#set(r, c, erase, changed);
    if (changed.n) this.#commit(snap);
  }

  // A rectangle being dragged out, filled or just its edge.
  #reshape(hollow) {
    const dg = this.drag; if (dg?.kind !== "rect") return;
    dg.preview = shape("rect", dg.r0, dg.c0, dg.r1, dg.c1, hollow).filter(([r, c]) => this.inside(r, c));
    this.draw();
  }

  #wheel(ev) {
    if (!(ev.ctrlKey || ev.metaKey)) return;         // plain scrolling scrolls the page
    ev.preventDefault();
    const { x, y } = this.#pos(ev);
    this.zoomBy(Math.exp(-ev.deltaY * 0.01), x, y);
  }

  #key(ev) {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === "z") { ev.preventDefault(); ev.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && ev.key.toLowerCase() === "y") { ev.preventDefault(); this.redo(); return; }
    if (mod) return;
    if (ev.key === " ") { ev.preventDefault(); this.spaceDown = true; this.#cursor(); return; }
    if (ev.key === "Shift") { this.#reshape(true); return; }
    if (ev.key === "Escape") { if (this.lifted) this.#drop(); this.selection = null; this.draw(); return; }
    if ((ev.key === "Delete" || ev.key === "Backspace") && this.selection) { ev.preventDefault(); this.#clearSelection(); return; }
    if ((ev.key === "Enter") && this.lifted) { this.#drop(); return; }
    if (ev.key === "+" || ev.key === "=") { this.zoomBy(1.25); return; }
    if (ev.key === "-") { this.zoomBy(0.8); return; }
    if (ev.key === "0") { this.fit(); return; }
    if ((ev.key === "[" || ev.key === "]") && this.tool === "stamp") { this.turnStamp(ev.key === "]" ? 1 : -1); return; }
    const t = [...TOOLS, ...this.extraTools].find((x) => x.key === ev.key.toLowerCase());
    if (t) this.setTool(t.id);
  }
}

// ---- Helpers ------------------------------------------------------------------------------------

function encodeRows(rows, W, H, erase) {
  const data = new Uint16Array(W * H).fill(erase.charCodeAt(0));
  for (let r = 0; r < H; r++) {
    const row = rows[r] ?? "";
    for (let c = 0; c < W && c < row.length; c++) data[r * W + c] = row.charCodeAt(c);
  }
  return data;
}

function decodeRows(data, W, H) {
  const out = [];
  for (let r = 0; r < H; r++) out.push(String.fromCharCode(...data.subarray(r * W, (r + 1) * W)));
  return out;
}

const clampTo = (v, n) => Math.max(0, Math.min(n - 1, v));
const inBlock = (b, r, c) => r >= b.r && r < b.r + b.h && c >= b.c && c < b.c + b.w;

// The cells of a line, both ends included, one step along a row or a
// column at a time (whichever keeps nearer the true line). Each cell
// shares a side with the next, so a painted road, bridge, corridor or wall
// joins the way the router moves: it never cuts a corner (grid.R).
export function lineCells(r0, c0, r1, c1) {
  const dr = Math.abs(r1 - r0); const dc = Math.abs(c1 - c0);
  const sr = r0 < r1 ? 1 : -1; const sc = c0 < c1 ? 1 : -1;
  const out = [[r0, c0]];
  let r = r0; let c = c0;
  for (let ir = 0, ic = 0; ir < dr || ic < dc;) {
    if ((1 + 2 * ic) * dr < (1 + 2 * ir) * dc) { c += sc; ic++; } else { r += sr; ir++; }
    out.push([r, c]);
  }
  return out;
}

// A line's cells, or a rectangle's (filled, or its edge only).
function shape(kind, r0, c0, r1, c1, hollow = false) {
  if (kind === "line") return lineCells(r0, c0, r1, c1);
  const out = [];
  const [ra, rb] = [Math.min(r0, r1), Math.max(r0, r1)]; const [ca, cb] = [Math.min(c0, c1), Math.max(c0, c1)];
  for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) if (!hollow || r === ra || r === rb || c === ca || c === cb) out.push([r, c]);
  return out;
}

const probe = document.createElement("canvas").getContext("2d");
function toRgba(colour, alpha) {
  if (!colour) return [0, 0, 0, 0];
  probe.fillStyle = "#000"; probe.fillStyle = colour;
  const s = probe.fillStyle;
  let rgb; let a = 1;
  if (s.startsWith("#")) rgb = [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  else { const m = s.match(/[\d.]+/g).map(Number); rgb = m.slice(0, 3); if (m.length > 3) a = m[3]; }
  return [rgb[0], rgb[1], rgb[2], Math.round(255 * a * alpha)];
}

// A row of tool buttons for a GridEditor (the shared ones, then the
// owner's, less a stamp: its pictures are chosen on the owner's palette),
// with undo, redo and zoom.
export function toolbar(editor, { tools = [...TOOLS, ...editor.extraTools].filter((t) => t.kind !== "stamp").map((t) => t.id) } = {}) {
  const ALL = [...TOOLS, ...editor.extraTools];
  const icon = (d) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); p.setAttribute("fill", "currentColor");
    svg.append(p); return svg;
  };
  const shown = ALL.filter((t) => tools.includes(t.id));
  const buttons = shown.map((t) => el("button", {
    type: "button", class: "tool", title: `${t.label} (${t.key.toUpperCase()})`, "aria-label": t.label, "aria-pressed": String(editor.tool === t.id),
    onclick: () => editor.setTool(t.id) }, icon(t.icon)));
  const sync = () => buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(shown[i].id === editor.tool)));
  const prev = editor.cb.onToolChange;
  editor.cb.onToolChange = (t) => { sync(); prev?.(t); };
  const small = (text, title, fn) => el("button", { type: "button", class: "tool text", title, "aria-label": title, text, onclick: fn });
  return el("div", { class: "toolbar", role: "toolbar", "aria-label": "Tools" }, ...buttons, el("span", { class: "tool-gap" }),
    small("↶", "Undo (Cmd/Ctrl-Z)", () => editor.undo()), small("↷", "Redo (Shift-Cmd/Ctrl-Z)", () => editor.redo()),
    el("span", { class: "tool-gap" }),
    small("−", "Zoom out (-)", () => editor.zoomBy(0.8)), small("+", "Zoom in (+)", () => editor.zoomBy(1.25)), small("Fit", "Fit (0)", () => editor.fit()));
}
