// A painted grid, edited with a sprite editor's tools: the canvas both world
// editors share (the market map, a store's floor plan). One character per
// cell, on one or more layers painted over each other (the map's land, and
// its areas on top).
//
//   draw (the pencil) and erase, with a brush of 1, 3 x 3 or 7 x 7 cells
//     ([ and ] change it; Shift keeps the stroke straight): the brush's
//     whole footprint is shown before it paints, and painted at every cell
//     along the stroke, so a fast stroke leaves no gaps
//   rectangle (Shift: just its edge), line, fill, eyedropper
//   select and move (drag out a block; drag it to move it, with Alt to copy;
//     Delete clears it, Escape drops it)
//   the owner's own tools: a path (dragged out one side-to-side step at a
//     time, shortened by going back along it; the owner says what it paints),
//     and a stamp (a small picture put down with a click; [ and ] turn it).
//     The brush's size changes neither.
//   undo and redo (Cmd/Ctrl-Z, Shift-Cmd/Ctrl-Z): one drag is one step
//   canvas size (grow or crop, the content anchored to a chosen edge)
//   two views, one click apart: Overview (0) fits the whole grid; Draw (1)
//     shows cells big enough to paint one by one (about 16 px), around
//     where the editing was. Zoom (Cmd/Ctrl + wheel, a pinch, or the
//     buttons) and pan (the hand tool, Space-drag, the middle button, or
//     two fingers) go between them.
//
// A cell is a logical cell of the grid, never a screen pixel: the view's
// zoom and offset change what's seen, not the grid, its size, or what a
// cell stands for (a map tile's metres, a floor tile's half metre).
//
// The owner says what each character looks like, what the eraser paints,
// and what else to draw on top (stores, problems, overlays); it hears about
// every finished stroke and every block moved, and can keep its own state
// (a map's stores and areas) in the same undo history.

import { el } from "./ui.js";

export const TOOLS = [
  { id: "pencil", name: "Draw", label: "Draw", key: "b", icon: "M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" },
  { id: "rect", name: "Rectangle", label: "Rectangle, Shift for its edge only", key: "r", icon: "M4 5h16v14H4z" },
  { id: "line", name: "Line", label: "Line", key: "l", icon: "M3.3 19.3L19.3 3.3l1.4 1.4-16 16z" },
  { id: "fill", name: "Fill", label: "Fill", key: "g", icon: "M16.6 8.9L8.1.4 6.7 1.8l2.4 2.4-5.2 5.2a1.5 1.5 0 0 0 0 2.1l5.5 5.5a1.5 1.5 0 0 0 2.1 0l5.1-5.1a1.5 1.5 0 0 0 0-2.1zM5.2 10L10 5.2 14.8 10H5.2zM19 11.5s-2 2.2-2 3.5a2 2 0 0 0 4 0c0-1.3-2-3.5-2-3.5z" },
  { id: "erase", name: "Erase", label: "Erase", key: "e", icon: "M16.2 3.6l4.2 4.2a1.5 1.5 0 0 1 0 2.1L11 19.3H20v2H8.9l-5.3-5.3a1.5 1.5 0 0 1 0-2.1L14.1 3.6a1.5 1.5 0 0 1 2.1 0zM5.7 15l3.7 3.7L13 15l-3.7-3.7L5.7 15z" },
  { id: "pick", name: "Eyedropper", label: "Eyedropper", key: "i", icon: "M20.7 5.6l-2.3-2.3a1 1 0 0 0-1.4 0l-3.1 3.1-1.9-1.9-1.4 1.4 1.4 1.4L3 16.3V21h4.7l9-9 1.4 1.4 1.4-1.4-1.9-1.9 3.1-3.1a1 1 0 0 0 0-1.4zM6.9 19H5v-1.9l8.1-8.1 1.9 1.9L6.9 19z" },
  { id: "select", name: "Select and move", label: "Select and move", key: "m", icon: "M3 3h4v2H5v2H3V3zm6 0h6v2H9V3zm8 0h4v4h-2V5h-2V3zM3 9h2v6H3V9zm16 0h2v6h-2V9zM3 17h2v2h2v2H3v-4zm16 0h2v4h-4v-2h2v-2zM9 19h6v2H9v-2z" },
  { id: "pan", name: "Pan", label: "Pan", key: "h", icon: "M13 1.5a1.5 1.5 0 0 0-3 0V11h-1V3.5a1.5 1.5 0 0 0-3 0V14l-2.3-2.3a1.6 1.6 0 0 0-2.3 2.2L7 19.5A6 6 0 0 0 11.3 22H14a6 6 0 0 0 6-6V6.5a1.5 1.5 0 0 0-3 0V11h-1V2.5a1.5 1.5 0 0 0-3 0V11h-1V1.5z" },
];
// Brushes, by the cells along a side: logical cells, whatever the zoom.
export const BRUSHES = [
  { size: 1, name: "Small", short: "S" },
  { size: 3, name: "Medium", short: "M" },
  { size: 7, name: "Large", short: "L" },
];
const BRUSH_TOOLS = ["pencil", "erase"];
const PAINT_TOOLS = ["pencil", "rect", "line", "fill"];
const HISTORY = 100;
const DRAW_PX = 16;              // Draw view: screen px per cell (20 for a finger)
const MIN_ZOOM = 0.5; const MAX_ZOOM = 64;
const EDGE = 24;                 // how far the grid's edge may be panned into the view, px
const SNAP_PX = 6;               // cells this many device px or more are kept a whole number of px

export class GridEditor {
  // layers: [{ id, erase, colour(ch) -> css colour or null (transparent), alpha }]
  // tools: the owner's own, [{ id, label, key, icon, kind: "path", paint(cells) -> [[r, c, ch]] }
  //   or { ..., kind: "stamp" } (the picture: setStamp)].
  // names: what to call things in words, { material(ch, layer), layer(i), stamp() }.
  // cellM: () -> a cell's width in metres (the brush's footprint is given in both).
  // pointer: the owner may take a press (a store on the map): { down, move, up, cancel }.
  constructor(wrap, { layers, cellPx = 8, drawPx, tools = [], names, cellM, onStroke, onPick, onHover, onToolChange, onDrop, onState, drawOver, snapshot, restore, pointer }) {
    this.wrap = wrap;
    this.canvas = el("canvas", { tabindex: 0, "aria-label": "Editor canvas" });
    this.status = el("div", { class: "editor-status" });
    // On a touch screen or a narrow window the toolbar is often scrolled out
    // of sight while drawing: undo, redo and the view stay on the canvas.
    // A finger's tap acts as it lifts (a click a browser drops after a
    // stroke can't lose it); the click that follows is then let go by.
    const quick = (text, label, fn) => {
      const b = el("button", { type: "button", class: "quick-btn", text, title: label, "aria-label": label });
      let down = null; let lifted = 0;
      b.addEventListener("pointerdown", (ev) => { down = ev.pointerId; });
      b.addEventListener("pointerup", (ev) => {
        if (ev.pointerType === "mouse" || down !== ev.pointerId || b.disabled) return;
        down = null; lifted = performance.now(); fn();
      });
      b.addEventListener("click", () => { if (performance.now() - lifted < 800) return; fn(); });
      return b;
    };
    this.quick = {
      undo: quick("↶", "Undo", () => this.undo()), redo: quick("↷", "Redo", () => this.redo()),
      view: quick("⤢", "Overview or Draw view", () => this.setView(this.mode === "overview" ? "draw" : "overview")),
    };
    this.quickBar = el("div", { class: "canvas-quick", role: "group", "aria-label": "Undo, redo and the view" }, this.quick.undo, this.quick.redo, this.quick.view);
    wrap.append(this.canvas, this.status, this.quickBar);
    this.ctx = this.canvas.getContext("2d");
    this.layers = layers.map((L) => ({ ...L, data: new Uint16Array(0), image: null }));
    this.active = 0;
    this.W = 0; this.H = 0;
    this.zoom = cellPx; this.ox = 0; this.oy = 0;          // screen px per cell, and the view's offset
    this.mode = "overview";                                // "overview", "draw", or null after zooming by hand
    this.drawPx = drawPx ?? (globalThis.matchMedia?.("(pointer: coarse)").matches ? 20 : DRAW_PX);
    this.tool = "pencil";
    this.brush = 1;
    this.paint = layers[0].erase;
    this.hover = null; this.drag = null; this.selection = null; this.lifted = null;
    this.focus = null; this.viewFocus = null;              // where the editing was, and where the Draw view last looked
    this.touches = new Map(); this.owned = null;
    this.highlights = [];
    this.undoStack = []; this.redoStack = [];
    this.extraTools = tools; this.stamp = null;
    this.cb = { onStroke, onPick, onHover, onToolChange, onDrop, onState, drawOver, snapshot, restore, pointer, names, cellM };
    this.spaceDown = false;
    new ResizeObserver(() => this.#resize()).observe(wrap);
    this.canvas.addEventListener("pointerdown", (ev) => this.#down(ev));
    this.canvas.addEventListener("pointermove", (ev) => this.#move(ev));
    this.canvas.addEventListener("pointerup", (ev) => this.#up(ev));
    this.canvas.addEventListener("pointercancel", (ev) => this.#cancelled(ev));
    this.canvas.addEventListener("lostpointercapture", (ev) => this.#cancelled(ev));
    this.canvas.addEventListener("pointerleave", (ev) => {
      if (this.drag && ev.pointerId === this.drag.pointerId) return;     // a captured stroke goes on outside the canvas
      this.hover = null; this.cb.onHover?.(null); this.draw();
    });
    this.canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());   // a long press paints, it doesn't open a menu
    this.canvas.addEventListener("wheel", (ev) => this.#wheel(ev), { passive: false });
    this.canvas.addEventListener("keydown", (ev) => this.#key(ev));
    this.canvas.addEventListener("keyup", (ev) => {
      if (ev.key === " ") { this.spaceDown = false; this.#cursor(); }
      if (ev.key === "Shift") this.#reshape(false);
    });
    // Space let go while the canvas didn't have the keyboard: the pan it held ends.
    this.canvas.addEventListener("blur", () => { this.spaceDown = false; this.#cursor(); });
    globalThis.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => this.refreshColours());
  }

  // ---- Content ---------------------------------------------------------------------

  // Every layer's rows (arrays of strings), all the same size.
  load(rowsByLayer, { keepView = false } = {}) {
    this.cancel();
    const first = rowsByLayer[0];
    this.H = first.length; this.W = first[0]?.length ?? 0;
    this.layers.forEach((L, i) => { L.data = encodeRows(rowsByLayer[i] ?? [], this.W, this.H, L.erase); L.image = null; });
    this.selection = null; this.lifted = null;
    if (!keepView) { this.focus = null; this.viewFocus = null; this.fit(); }
    this.draw();
    this.#state();
  }

  rows(layer = 0) { return decodeRows(this.layers[layer].data, this.W, this.H); }
  at(layer, r, c) { return String.fromCharCode(this.layers[layer].data[r * this.W + c]); }

  setActive(i) { this.cancel(); this.active = i; this.selection = null; this.lifted = null; this.draw(); this.#state(); }
  setPaint(ch) { this.paint = ch; this.draw(); this.#state(); }
  setTool(tool) {
    this.cancel();
    if (this.lifted) this.#drop();
    this.tool = tool; this.selection = null; this.#cursor(); this.draw();
    this.cb.onToolChange?.(tool);
    this.#state();
  }
  // The brush: 1, 3 or 7 cells along a side (BRUSHES), for draw and erase.
  setBrush(size) {
    const b = BRUSHES.find((x) => x.size === size) ?? BRUSHES[0];
    this.brush = b.size; this.draw(); this.#state();
  }
  setHighlights(tiles) { this.highlights = tiles ?? []; this.draw(); }
  // The stamp tool's picture: rows of characters, a space where it leaves
  // the plan as it is.
  setStamp(rows) { this.stamp = rows; this.draw(); this.#state(); }
  turnStamp(k = 1) {
    for (let i = 0; i < ((k % 4) + 4) % 4; i++) {
      const s = this.stamp; if (!s?.length) return;
      this.stamp = Array.from({ length: s[0].length }, (_, r) => Array.from({ length: s.length }, (_, c) => s[s.length - 1 - c][r]).join(""));
    }
    this.draw(); this.#state();
  }
  #ownTool(id = this.tool) { return this.extraTools.find((t) => t.id === id); }
  refreshColours() { for (const L of this.layers) L.image = null; this.draw(); }

  // Something the toolbar shows changed: the tool, the brush, what's
  // painted, the layer, the view, or what undo and redo can do.
  #state() {
    if (this.quick) {
      this.quick.undo.disabled = !this.canUndo; this.quick.redo.disabled = !this.canRedo;
      this.quick.view.textContent = this.mode === "overview" ? "Draw" : "Overview";
      this.quick.view.title = this.mode === "overview" ? "Draw view: tiles big enough to paint one by one" : "Overview: the whole grid";
    }
    this.cb.onState?.(this);
  }

  // ---- In words --------------------------------------------------------------------------

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // A length of `cells` cells, in cells and (when the owner says what a cell
  // measures) in metres: "3 × 3 tiles (150 × 150 m)".
  footprintText(w, h = w) {
    const tiles = `${w} × ${h} tile${w * h === 1 ? "" : "s"}`;
    const m = this.cb.cellM?.();
    if (!(m > 0)) return tiles;
    const len = (n) => { const v = n * m; return v >= 1000 ? `${trim(v / 1000)} km` : `${trim(v)} m`; };
    return `${tiles} (${len(w)} × ${len(h)})`;
  }

  // What a press would do now: the action, the material, the layer, and
  // the brush's footprint.
  describe() {
    const t = [...TOOLS, ...this.extraTools].find((x) => x.id === this.tool);
    const names = this.cb.names ?? {};
    const layer = this.layers.length > 1 || names.layer ? names.layer?.(this.active) ?? this.layers[this.active].id : null;
    const material = (ch) => names.material?.(ch, this.active) ?? ch;
    const parts = [t?.name ?? t?.label ?? this.tool];
    if (PAINT_TOOLS.includes(this.tool)) parts.push(material(this.paint));
    else if (this.tool === "erase") parts.push(`back to ${material(this.layers[this.active].erase)}`);
    else if (this.tool === "stamp" && this.stamp) parts.push(names.stamp?.() ?? "Stamp");
    else if (t?.kind === "path") parts.push(material(this.paint));
    if (layer) parts.push(`${layer} layer`);
    if (BRUSH_TOOLS.includes(this.tool)) {
      const b = BRUSHES.find((x) => x.size === this.brush);
      parts.push(`${b.name} brush, ${this.footprintText(b.size)}`);
    } else if (this.tool === "stamp" && this.stamp?.length) parts.push(this.footprintText(this.stamp[0].length, this.stamp.length));
    else if (this.tool === "select") parts.push("drag out a block, drag it to move it (Alt copies), Delete clears it");
    else if (this.tool === "pan") parts.push("drag to move the view");
    else if (this.tool === "pick") parts.push("click a tile to paint with what's there");
    return parts.join(" · ");
  }

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
    this.#state();
  }
  undo() {
    this.cancel();
    if (this.lifted) this.#drop();
    const s = this.undoStack.pop(); if (!s) return;
    this.redoStack.push(this.#snapshot());
    this.#restoreSnap(s);
    this.#clampView();
    this.cb.onStroke?.({ undo: true });
    this.#state();
  }
  redo() {
    this.cancel();
    const s = this.redoStack.pop(); if (!s) return;
    this.undoStack.push(this.#snapshot());
    this.#restoreSnap(s);
    this.#clampView();
    this.cb.onStroke?.({ redo: true });
    this.#state();
  }
  clearHistory() { this.undoStack.length = 0; this.redoStack.length = 0; this.#state(); }

  // ---- Canvas size ---------------------------------------------------------------------------

  // Grows or crops every layer to W x H, the content anchored to an edge
  // (anchor: "nw", "n", "ne", "w", "c", "e", "sw", "s", "se"). Returns how
  // many cells the content moved right and down.
  resize(W, H, anchor = "nw") {
    this.cancel();
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
    this.focus = null; this.viewFocus = null;
    this.fit();
    return { dx, dy };
  }

  // ---- View ---------------------------------------------------------------------------------

  get dpr() { return globalThis.devicePixelRatio || 1; }

  // The zoom at which the whole grid fits: a whole number of device pixels
  // a cell once cells are big enough for their edges to show (every cell
  // the same size on screen, its edges sharp); below that, as big as fits.
  #fitZoom() {
    const w = this.wrap.clientWidth; const h = this.wrap.clientHeight;
    let z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (w - 16) / this.W, (h - 16) / this.H));
    const d = this.dpr;
    if (z * d >= SNAP_PX) z = Math.floor(z * d) / d;
    return z;
  }

  // Overview: the whole grid, fitted to the canvas.
  fit() {
    const w = this.wrap.clientWidth; const h = this.wrap.clientHeight;
    if (!this.W || !w || !h) return;
    if (this.mode !== "overview") this.viewFocus = this.#viewCentre();
    this.zoom = this.#fitZoom();
    this.ox = (w - this.W * this.zoom) / 2; this.oy = (h - this.H * this.zoom) / 2;
    this.mode = "overview";
    this.#snap();
    this.draw();
    this.#state();
  }
  overview() { this.fit(); }

  // Draw: cells big enough to paint one by one, around `cell` (by default
  // the selected block, the cell under the pointer, where the Draw view
  // last looked, or where the last stroke ended).
  drawView(cell) {
    const w = this.wrap.clientWidth; const h = this.wrap.clientHeight;
    if (!this.W || !w || !h) return;
    const at = cell ?? this.#focusCell();
    this.zoom = Math.min(MAX_ZOOM, Math.max(this.drawPx, this.#fitZoom()));
    this.ox = w / 2 - (at.c + 0.5) * this.zoom; this.oy = h / 2 - (at.r + 0.5) * this.zoom;
    this.mode = "draw";
    this.#clampView();
    this.draw();
    this.#state();
  }
  setView(mode) { if (mode === "draw") this.drawView(); else this.fit(); }

  // The cell at the middle of the view (it may be a fraction of a cell off).
  #viewCentre() {
    const r = (this.wrap.clientHeight / 2 - this.oy) / this.zoom - 0.5; const c = (this.wrap.clientWidth / 2 - this.ox) / this.zoom - 0.5;
    return { r: Math.max(0, Math.min(this.H - 1, r)), c: Math.max(0, Math.min(this.W - 1, c)) };
  }

  #focusCell() {
    const s = this.selection ?? (this.lifted ? { r0: this.lifted.r, c0: this.lifted.c, r1: this.lifted.r + this.lifted.h - 1, c1: this.lifted.c + this.lifted.w - 1 } : null);
    if (s) return { r: (s.r0 + s.r1) / 2, c: (s.c0 + s.c1) / 2 };
    if (this.hover && this.inside(this.hover.r, this.hover.c)) return this.hover;
    if (this.mode !== "overview") return this.#viewCentre();
    return this.viewFocus ?? this.focus ?? { r: (this.H - 1) / 2, c: (this.W - 1) / 2 };
  }

  // Brings tiles ([[r, c]]) into view: nothing to do in the Overview; in
  // a closer view, the middle of them goes to the middle of the canvas.
  reveal(tiles) {
    if (!tiles?.length || this.mode === "overview") return;
    let r0 = Infinity; let r1 = -Infinity; let c0 = Infinity; let c1 = -Infinity;
    for (const [r, c] of tiles) { r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
    this.ox = this.wrap.clientWidth / 2 - ((c0 + c1) / 2 + 0.5) * this.zoom; this.oy = this.wrap.clientHeight / 2 - ((r0 + r1) / 2 + 0.5) * this.zoom;
    this.#clampView();
    this.draw();
  }

  zoomBy(k, cx = this.wrap.clientWidth / 2, cy = this.wrap.clientHeight / 2) {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * k));
    this.ox = cx - ((cx - this.ox) * z) / this.zoom; this.oy = cy - ((cy - this.oy) * z) / this.zoom;
    this.zoom = z;
    this.mode = null;
    this.#clampView();
    this.draw();
    this.#state();
  }

  // The grid never leaves the view: smaller than the canvas, it sits in the
  // middle; larger, its edge stops a little way in.
  #clampView() {
    const w = this.wrap.clientWidth; const h = this.wrap.clientHeight;
    if (!w || !h || !this.W) return;
    const gw = this.W * this.zoom; const gh = this.H * this.zoom;
    this.ox = gw <= w - 2 * EDGE ? (w - gw) / 2 : Math.max(w - gw - EDGE, Math.min(EDGE, this.ox));
    this.oy = gh <= h - 2 * EDGE ? (h - gh) / 2 : Math.max(h - gh - EDGE, Math.min(EDGE, this.oy));
    this.#snap();
  }

  // The view's offset on whole device pixels, so tiles and grid lines are sharp.
  #snap() { const d = this.dpr; this.ox = Math.round(this.ox * d) / d; this.oy = Math.round(this.oy * d) / d; }

  // Screen (CSS px within the canvas) to cell, and cell to screen.
  cellAt(x, y) { return { r: Math.floor((y - this.oy) / this.zoom), c: Math.floor((x - this.ox) / this.zoom) }; }
  toScreen(r, c) { return { x: this.ox + c * this.zoom, y: this.oy + r * this.zoom }; }
  inside(r, c) { return r >= 0 && c >= 0 && r < this.H && c < this.W; }

  // The canvas changed size: the Overview fits it again; a closer view
  // keeps looking at the same cell.
  #resize() {
    const w = this.wrap.clientWidth; const h = this.wrap.clientHeight;
    const cw = Math.round(w * this.dpr); const ch = Math.round(h * this.dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    if (!w || !h) return;
    if (!this.sized) { this.sized = true; this.fit(); }
    else if (this.mode === "overview") this.fit();
    else if (this.vw && (this.vw !== w || this.vh !== h)) {
      this.ox += (w - this.vw) / 2; this.oy += (h - this.vh) / 2;
      this.#clampView();
    }
    this.vw = w; this.vh = h;
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
    this.#paintGrid(ctx, w, h);
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
    // The stamp, where a click would put it: every one of its cells, and its outline.
    if (this.tool === "stamp" && this.stamp && this.hover && !this.drag) {
      this.#paintCells(this.#stampCells(this.hover.r, this.hover.c));
      this.#outline(this.hover.r, this.hover.c, this.hover.r + this.stamp.length - 1, this.hover.c + this.stamp[0].length - 1);
    }
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
    this.#paintBrush(ctx);
    this.status.textContent = this.hover && this.inside(this.hover.r, this.hover.c)
      ? `row ${this.hover.r + 1}, column ${this.hover.c + 1} · ${this.W} × ${this.H}` : `${this.W} × ${this.H}`;
  }

  // Cell boundaries, once cells are big enough to paint one by one, with
  // every tenth line stronger (ten map tiles, five metres of floor).
  #paintGrid(ctx, w, h) {
    const z = this.zoom; const d = this.dpr;
    if (z < 8) return;
    const x0 = Math.max(0, Math.floor(-this.ox / z)); const x1 = Math.min(this.W, Math.ceil((this.wrap.clientWidth - this.ox) / z));
    const y0 = Math.max(0, Math.floor(-this.oy / z)); const y1 = Math.min(this.H, Math.ceil((this.wrap.clientHeight - this.oy) / z));
    const lines = (major) => {
      ctx.beginPath();
      for (let c = x0; c <= x1; c++) if ((c % 10 === 0) === major) { const x = this.ox + c * z; ctx.moveTo(x, this.oy + y0 * z); ctx.lineTo(x, this.oy + y1 * z); }
      for (let r = y0; r <= y1; r++) if ((r % 10 === 0) === major) { const y = this.oy + r * z; ctx.moveTo(this.ox + x0 * z, y); ctx.lineTo(this.ox + x1 * z, y); }
      ctx.stroke();
    };
    ctx.lineWidth = 1 / d;
    ctx.strokeStyle = `rgba(128,128,128,${z >= 12 ? 0.32 : 0.2})`; lines(false);
    ctx.strokeStyle = "rgba(110,110,110,0.6)"; lines(true);
    void w; void h;
  }

  // The brush where a press would paint: its whole footprint (clipped at the
  // grid's edge) in what it paints, outlined. Other tools show their cell.
  #paintBrush(ctx) {
    const hv = this.drag?.kind === "paint" ? { r: this.drag.r, c: this.drag.c } : this.hover;
    if (!hv || ["pan", "select", "stamp"].includes(this.spaceDown ? "pan" : this.tool)) return;
    if (this.drag && this.drag.kind !== "paint") return;
    if (!BRUSH_TOOLS.includes(this.tool)) {
      if (!this.inside(hv.r, hv.c)) return;
      this.#outline(hv.r, hv.c, hv.r, hv.c);
      return;
    }
    const half = (this.brush - 1) >> 1;
    const r0 = Math.max(0, hv.r - half); const r1 = Math.min(this.H - 1, hv.r + half);
    const c0 = Math.max(0, hv.c - half); const c1 = Math.min(this.W - 1, hv.c + half);
    if (r0 > r1 || c0 > c1) return;
    if (!this.drag) {
      const L = this.layers[this.active];
      const p = this.toScreen(r0, c0);
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = L.colour(this.#valueFor()) ?? "rgba(128,128,128,0.35)";
      ctx.fillRect(p.x, p.y, (c1 - c0 + 1) * this.zoom, (r1 - r0 + 1) * this.zoom);
      ctx.globalAlpha = 1;
    }
    this.#outline(r0, c0, r1, c1);
  }

  // The edge of a block of cells, light under dark so it shows on any tile.
  #outline(r0, c0, r1, c1) {
    const ctx = this.ctx; const p = this.toScreen(r0, c0);
    const w = (c1 - c0 + 1) * this.zoom; const h = (r1 - r0 + 1) * this.zoom;
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.strokeRect(p.x + 0.5, p.y + 0.5, w - 1, h - 1);
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.strokeRect(p.x + 0.5, p.y + 0.5, w - 1, h - 1);
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

  // The brush put down with its centre on (r, c): every cell of its
  // footprint that's on the grid.
  #dab(r, c, ch, changed) {
    if (this.brush === 1) { this.#set(r, c, ch, changed); return; }
    for (const [rr, cc] of footprint(r, c, this.brush, this.H, this.W)) this.#set(rr, cc, ch, changed);
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

  #capture(ev) { try { this.canvas.setPointerCapture(ev.pointerId); } catch { /* a pointer the browser no longer tracks */ } }

  #down(ev) {
    this.canvas.focus({ preventScroll: true });
    const { x, y } = this.#pos(ev);
    if (ev.pointerType === "touch") {
      this.touches.set(ev.pointerId, { x, y });
      // A second finger: whatever the first was doing is dropped, and the
      // two move and zoom the view.
      if (this.touches.size === 2 && this.owned === null) { this.#capture(ev); this.#startPinch(); return; }
      if (this.touches.size > 1) return;
    }
    // A press by a pointer already pressing: its release was never heard,
    // so what it was doing is dropped.
    if (this.drag && this.drag.pointerId === ev.pointerId) this.cancel();
    if (this.owned === ev.pointerId) { this.owned = null; this.cb.pointer?.cancel?.(ev, this); }
    if (this.drag || this.owned !== null) return;               // one press at a time
    const cell = this.cellAt(x, y);
    this.hover = cell;
    this.#capture(ev);                                          // its release reaches the canvas wherever it happens
    // The owner may take the press (a store on the map).
    if (ev.button === 0 && !this.spaceDown && this.cb.pointer?.down?.(ev, cell, this)) { this.owned = ev.pointerId; return; }
    if (ev.button === 1 || this.spaceDown || this.tool === "pan") {
      this.drag = { kind: "pan", pointerId: ev.pointerId, x, y, ox: this.ox, oy: this.oy };
      this.canvas.style.cursor = "grabbing";
      return;
    }
    // A pen's eraser end erases, whatever the tool.
    const rubber = ev.pointerType === "pen" && (ev.button === 5 || (ev.buttons & 32) !== 0);
    if (ev.button !== 0 && !rubber) return;
    const { r, c } = cell;
    switch (rubber ? "erase" : this.tool) {
      case "pencil": case "erase": {
        const snap = this.#snapshot(); const changed = { n: 0 };
        const value = rubber ? this.layers[this.active].erase : this.#valueFor();
        this.#dab(r, c, value, changed);
        this.drag = { kind: "paint", pointerId: ev.pointerId, r, c, r0: r, c0: c, value, snap, changed };
        this.layers[this.active].image = null; this.draw();
        break;
      }
      case "rect": case "line":
        this.drag = { kind: this.tool, pointerId: ev.pointerId, r0: r, c0: c, r1: r, c1: c, value: this.paint, preview: shape(this.tool, r, c, r, c) };
        this.draw();
        break;
      case "stamp":
        if (this.stamp) { this.focus = { r, c }; this.#apply(this.#stampCells(r, c)); }
        break;
      case "fill": {
        if (!this.inside(r, c)) return;
        const snap = this.#snapshot();
        this.focus = { r, c };
        if (this.#fill(r, c, this.paint)) { this.#commit(snap); }
        break;
      }
      case "pick":
        if (!this.inside(r, c)) return;
        this.paint = this.at(this.active, r, c);
        this.cb.onPick?.(this.paint);
        this.#state();
        break;
      case "select": {
        const s = this.selection;
        if (this.lifted && inBlock(this.lifted, r, c)) {
          this.drag = { kind: "move", pointerId: ev.pointerId, r, c, br: this.lifted.r, bc: this.lifted.c };
        } else if (s && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1) {
          this.#lift(ev.altKey);
          this.drag = { kind: "move", pointerId: ev.pointerId, r, c, br: this.lifted.r, bc: this.lifted.c };
        } else {
          if (this.lifted) this.#drop();
          this.selection = null;
          this.drag = { kind: "select", pointerId: ev.pointerId, r0: clampTo(r, this.H), c0: clampTo(c, this.W) };
          this.selection = { r0: this.drag.r0, c0: this.drag.c0, r1: this.drag.r0, c1: this.drag.c0 };
          this.draw();
        }
        break;
      }
      default: {
        const own = this.#ownTool();
        if (own?.kind !== "path" || !this.inside(r, c)) break;
        this.drag = { kind: "path", pointerId: ev.pointerId, paint: own.paint, cells: [[r, c]] };
        this.drag.preview = own.paint(this.drag.cells);
        this.draw();
        break;
      }
    }
  }

  #move(ev) {
    const { x, y } = this.#pos(ev);
    if (ev.pointerType === "touch" && this.touches.has(ev.pointerId)) this.touches.set(ev.pointerId, { x, y });
    const dg = this.drag;
    if (dg?.kind === "pinch") { if (dg.ids.includes(ev.pointerId)) this.#pinch(); return; }
    const cell = this.cellAt(x, y);
    if (this.owned !== null) { if (ev.pointerId === this.owned) this.cb.pointer?.move?.(ev, cell, this); return; }
    if (dg && ev.pointerId !== dg.pointerId) return;            // another finger, or a mouse beside a pen
    if (!dg && this.cb.pointer?.move?.(ev, cell, this)) return;
    const was = this.hover;
    this.hover = cell;
    if (!was || was.r !== cell.r || was.c !== cell.c) this.cb.onHover?.(this.inside(cell.r, cell.c) ? cell : null);
    if (!dg) { this.draw(); return; }
    if (dg.kind === "pan") { this.ox = dg.ox + x - dg.x; this.oy = dg.oy + y - dg.y; this.#clampView(); this.draw(); return; }
    if (dg.kind === "paint") {
      // Every position the pointer reported since the last event, joined
      // cell by cell: however fast it moved, the stroke has no gaps.
      const rect = this.canvas.getBoundingClientRect();
      const samples = ev.getCoalescedEvents?.() ?? [];
      const cells = samples.length > 1 ? samples.map((s) => this.cellAt(s.clientX - rect.left, s.clientY - rect.top)) : [];
      cells.push(cell);
      for (let to of cells) {
        if (ev.shiftKey) to = Math.abs(to.r - dg.r0) > Math.abs(to.c - dg.c0) ? { r: to.r, c: dg.c0 } : { r: dg.r0, c: to.c };   // Shift: straight
        for (const [r, c] of lineCells(dg.r, dg.c, to.r, to.c)) this.#dab(r, c, dg.value, dg.changed);
        dg.r = to.r; dg.c = to.c;
      }
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
    if (ev.pointerType === "touch") this.touches.delete(ev.pointerId);
    if (this.owned !== null) {
      if (ev.pointerId !== this.owned) return;
      this.owned = null;
      this.cb.pointer?.up?.(ev, this);
      return;
    }
    const dg = this.drag;
    if (!dg) return;
    if (dg.kind === "pinch") { if (dg.ids.includes(ev.pointerId)) { this.drag = null; this.#state(); } return; }
    if (ev.pointerId !== dg.pointerId) return;
    this.drag = null;
    if (dg.kind === "pan") { this.#cursor(); return; }
    if (dg.kind === "paint") {
      this.focus = { r: clampTo(dg.r, this.H), c: clampTo(dg.c, this.W) };
      if (dg.changed.n) this.#commit(dg.snap); else this.draw();
      return;
    }
    if (dg.kind === "rect" || dg.kind === "line") {
      const cells = dg.kind === "rect" ? shape("rect", dg.r0, dg.c0, dg.r1, dg.c1, ev.shiftKey).filter(([r, c]) => this.inside(r, c)) : dg.preview;
      this.focus = { r: clampTo(dg.r1, this.H), c: clampTo(dg.c1, this.W) };
      this.#apply(cells.map(([r, c]) => [r, c, dg.value]));
      return;
    }
    if (dg.kind === "path") { this.#apply(dg.preview); return; }
    if (dg.kind === "select") { this.draw(); return; }
    if (dg.kind === "move") this.draw();
  }

  // The browser took the pointer away (a call, a gesture of its own, the
  // capture lost): what the press was doing is dropped, not finished.
  #cancelled(ev) {
    if (ev.pointerType === "touch") this.touches.delete(ev.pointerId);
    if (this.owned !== null) {
      if (ev.pointerId !== this.owned) return;
      this.owned = null;
      if (this.cb.pointer?.cancel) this.cb.pointer.cancel(ev, this); else this.cb.pointer?.up?.(ev, this);
      return;
    }
    const dg = this.drag;
    if (!dg) return;
    if (dg.kind === "pinch" ? dg.ids.includes(ev.pointerId) : ev.pointerId === dg.pointerId) this.cancel();
  }

  // Drops the press in progress: a half-drawn stroke is taken back (it was
  // never one step of the history), a shape or a path isn't painted, a
  // block being moved stays picked up where it was.
  cancel() {
    const dg = this.drag;
    if (!dg) return;
    this.drag = null;
    if (dg.kind === "paint" && dg.changed.n) {
      this.layers.forEach((L, i) => { L.data = dg.snap.data[i]; L.image = null; });
    } else if (dg.kind === "move" && this.lifted) { this.lifted.r = dg.br; this.lifted.c = dg.bc; }
    else if (dg.kind === "select") this.selection = null;
    else if (dg.kind === "pan") this.#cursor();
    this.draw();
    this.#state();
  }

  // Two fingers: the point between them stays under them as they move, and
  // the view zooms as they part.
  #startPinch() {
    this.cancel();
    const [a, b] = [...this.touches.keys()];
    const p = this.touches.get(a); const q = this.touches.get(b);
    this.drag = { kind: "pinch", ids: [a, b], d: Math.max(1, Math.hypot(p.x - q.x, p.y - q.y)), mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2, zoom: this.zoom, ox: this.ox, oy: this.oy };
    this.hover = null; this.cb.onHover?.(null);
    this.draw();
  }

  #pinch() {
    const dg = this.drag;
    const p = this.touches.get(dg.ids[0]); const q = this.touches.get(dg.ids[1]);
    if (!p || !q) return;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, dg.zoom * Math.hypot(p.x - q.x, p.y - q.y) / dg.d));
    const mx = (p.x + q.x) / 2; const my = (p.y + q.y) / 2;
    this.ox = mx - ((dg.mx - dg.ox) * z) / dg.zoom; this.oy = my - ((dg.my - dg.oy) * z) / dg.zoom;
    if (z !== this.zoom) this.mode = null;
    this.zoom = z;
    this.#clampView();
    this.draw();
  }

  #commit(snap) {
    this.undoStack.push(snap);
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.layers[this.active].image = null;
    this.draw();
    this.cb.onStroke?.({});
    this.#state();
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
    if (ev.key === "Escape") { if (this.drag) { this.cancel(); return; } if (this.lifted) this.#drop(); this.selection = null; this.draw(); return; }
    if ((ev.key === "Delete" || ev.key === "Backspace") && this.selection) { ev.preventDefault(); this.#clearSelection(); return; }
    if ((ev.key === "Enter") && this.lifted) { this.#drop(); return; }
    if (ev.key === "+" || ev.key === "=") { this.zoomBy(1.25); return; }
    if (ev.key === "-") { this.zoomBy(0.8); return; }
    if (ev.key === "0") { this.fit(); return; }
    if (ev.key === "1") { this.drawView(); return; }
    if (ev.key === "[" || ev.key === "]") {
      // The stamp turns; any other tool's brush shrinks or grows.
      if (this.tool === "stamp") { this.turnStamp(ev.key === "]" ? 1 : -1); return; }
      const i = BRUSHES.findIndex((b) => b.size === this.brush) + (ev.key === "]" ? 1 : -1);
      this.setBrush(BRUSHES[Math.max(0, Math.min(BRUSHES.length - 1, i))].size);
      return;
    }
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
const trim = (v) => String(Math.round(v * 100) / 100);

// The cells a square brush of `size` cells a side covers with its centre
// on (r, c), clipped to an H x W grid: [[r, c]]. `size` is odd (1, 3, 7).
export function footprint(r, c, size, H, W) {
  const half = (size - 1) >> 1;
  const out = [];
  for (let rr = Math.max(0, r - half); rr <= Math.min(H - 1, r + half); rr++) {
    for (let cc = Math.max(0, c - half); cc <= Math.min(W - 1, c + half); cc++) out.push([rr, cc]);
  }
  return out;
}

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

// ---- The toolbar ---------------------------------------------------------------------------------

const ICONS = {
  undo: "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z",
  redo: "M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z",
  place: "M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z",
};

function svgIcon(d, size = 16) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", String(size)); svg.setAttribute("height", String(size)); svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); p.setAttribute("fill", "currentColor");
  svg.append(p); return svg;
}

// A GridEditor's tools, in two rows and a line of words.
//
//   first    Draw, the brush's size, Fill, Erase, Place (the owner's: a
//            store on the map, a fixture on a floor), Undo and Redo, each
//            with its icon and its name; then the view: Overview or Draw,
//            and zoom
//   More     rectangle, line, eyedropper, select and move, pan, and the
//            owner's own tools (less a stamp: its pictures are chosen on
//            the owner's palette)
//   words    what a press would do now: the action, the material, the
//            layer, and the brush's footprint in tiles and metres
//
// place: { label, title, onClick(), active() } from the owner.
export function toolbar(editor, { place } = {}) {
  const ALL = [...TOOLS, ...editor.extraTools];
  const byId = (id) => ALL.find((t) => t.id === id);
  const synced = [];
  const toolButton = (t, labelled) => {
    const b = el("button", { type: "button", class: `tool${labelled ? " labelled" : ""}`, title: `${t.label} (${t.key.toUpperCase()})`, "aria-label": t.label,
      "aria-pressed": "false", dataset: { tool: t.id }, onclick: () => { editor.setTool(t.id); editor.canvas.focus({ preventScroll: true }); } },
    svgIcon(t.icon), labelled ? el("span", { text: t.name ?? t.label }) : null);
    synced.push(() => b.setAttribute("aria-pressed", String(editor.tool === t.id && !place?.active?.())));
    return b;
  };
  const action = (name, title, icon, fn, enabled) => {
    const b = el("button", { type: "button", class: "tool labelled", title, "aria-label": title, onclick: () => { fn(); editor.canvas.focus({ preventScroll: true }); } }, svgIcon(icon), el("span", { text: name }));
    if (enabled) synced.push(() => { b.disabled = !enabled(); });
    return b;
  };
  // The brush's size: a square as many cells a side as it paints.
  const brushes = el("div", { class: "brush-sizes", role: "radiogroup", "aria-label": "Brush size" }, el("span", { class: "tool-caption", text: "Brush" }),
    ...BRUSHES.map((b) => {
      const btn = el("button", { type: "button", class: "tool brush", role: "radio", "aria-checked": "false", dataset: { brush: String(b.size) },
        onclick: () => { editor.setBrush(b.size); if (!BRUSH_TOOLS.includes(editor.tool) || place?.active?.()) editor.setTool("pencil"); editor.canvas.focus({ preventScroll: true }); } },
      el("i", { class: "brush-dot", vars: { "--n": String(b.size) } }), el("span", { text: b.short }));
      synced.push(() => {
        btn.setAttribute("aria-checked", String(editor.brush === b.size));
        const t = `${b.name} brush: ${editor.footprintText(b.size)}`;
        btn.title = `${t} ([ and ] change the size)`; btn.setAttribute("aria-label", t);
      });
      return btn;
    }));
  const placeBtn = place ? el("button", { type: "button", class: "tool labelled", title: place.title ?? place.label, "aria-label": place.title ?? place.label, "aria-pressed": "false",
    dataset: { tool: "place" }, onclick: () => place.onClick() }, svgIcon(ICONS.place), el("span", { text: place.label })) : null;
  if (placeBtn) synced.push(() => placeBtn.setAttribute("aria-pressed", String(!!place.active?.())));
  const view = el("div", { class: "seg view-seg", role: "group", "aria-label": "View" },
    ...[["overview", "Overview", "Overview: the whole grid (0)"], ["draw", "Draw", "Draw view: tiles big enough to paint one by one, where you were editing (1)"]].map(([mode, text, title]) => {
      const b = el("button", { type: "button", text, title, "aria-pressed": "false", dataset: { view: mode }, onclick: () => { editor.setView(mode); editor.canvas.focus({ preventScroll: true }); } });
      synced.push(() => b.setAttribute("aria-pressed", String(editor.mode === mode)));
      return b;
    }));
  const small = (text, title, fn) => el("button", { type: "button", class: "tool text", title, "aria-label": title, text, onclick: fn });
  const first = el("div", { class: "tool-row primary" },
    toolButton(byId("pencil"), true), brushes, toolButton(byId("fill"), true), toolButton(byId("erase"), true), placeBtn,
    el("span", { class: "tool-gap" }),
    action("Undo", "Undo (Cmd/Ctrl-Z)", ICONS.undo, () => editor.undo(), () => editor.canUndo),
    action("Redo", "Redo (Shift-Cmd/Ctrl-Z)", ICONS.redo, () => editor.redo(), () => editor.canRedo),
    el("span", { class: "tool-gap" }), view,
    small("−", "Zoom out (-)", () => editor.zoomBy(0.8)), small("+", "Zoom in (+)", () => editor.zoomBy(1.25)));
  const more = ALL.filter((t) => !["pencil", "fill", "erase"].includes(t.id) && t.kind !== "stamp");
  const second = el("div", { class: "tool-row secondary" }, el("span", { class: "tool-caption", text: "More tools" }), ...more.map((t) => toolButton(t, true)));
  const words = el("div", { class: "tool-info" });
  synced.push(() => { words.textContent = place?.active?.() ? place.describe?.() ?? place.label : editor.describe(); });
  const sync = () => { for (const fn of synced) fn(); };
  const prev = editor.cb.onState;
  editor.cb.onState = (ed) => { sync(); prev?.(ed); };
  sync();
  const root = el("div", { class: "toolbar", role: "toolbar", "aria-label": "Drawing tools" }, first, second, words);
  root.sync = sync;
  return root;
}
