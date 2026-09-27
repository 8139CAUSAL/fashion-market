// The macro world's editor, on the Setup tab: the market map, painted.
//
//   Land     open land, roads (a road over water is a bridge), water,
//            parks, shops, and homes at a density from 1 to 9
//   Areas    optional named regions, painted on their own layer, each with
//            the make-up of the households who live there
//   Stores   where each store stands: select one (on the map or in the
//            list), click the map to put it there, drag one to move it.
//            Stores are made, named and staffed in the micro world
//            (store-editor.js). A block of land moved with the select tool
//            takes the stores standing on it along.
//
// Undo covers the tiles, where the stores stand and which areas there are
// (an area's make-up stays as last set).
//
// After every stroke the draft goes to R, which places the households and
// routes every trip the way Setup would, and says how many households
// there are, how many have no store within their radius (their homes
// highlighted), and how many households have each store in reach.

import { el, fmt, card, select, textField, numberField, colourField, settingLever, cssVar, checkbox, segmented } from "./ui.js";
import { GridEditor, toolbar } from "./grid-editor.js";
import { mix } from "./city-view.js";
import { clone, newId, newName } from "./world-store.js";
import { placed } from "./store-editor.js";

// Each tile's name, and what it does in the model (city.R) as the palette
// says it: parks and shops look different and cross like open land; homes
// share the map's households by density.
const LAND = [
  { ch: ".", label: "Open land" }, { ch: "=", label: "Road" }, { ch: "~", label: "Water" },
  { ch: "p", label: "Park", note: () => "Park (looks only: trips cross it like open land)" },
  { ch: "s", label: "Shops", note: () => "Shops (looks only: trips cross them like open land)" },
  ...Array.from({ length: 9 }, (_, i) => ({ ch: String(i + 1), label: `Homes, density ${i + 1}`, short: String(i + 1),
    note: (m) => `Homes, density ${i + 1} (a share of the map's ${fmt.int(m.households)} households, by density)` })),
];
const AREA_KEYS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ANCHORS = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"];

export class MapEditor {
  constructor(root, app) {
    this.app = app; this.world = app.world;
    this.layer = "land"; this.selected = null; this.preview = null; this.overlay = false;
    this.onEditStore = null;             // opens a store in the micro world (Setup)
    this.previewTimer = 0; this.previewSeq = 0;

    // The canvas and its tools.
    const wrap = el("div", { class: "editor-canvas map-editor-canvas" });
    this.editor = new GridEditor(wrap, {
      layers: [
        { id: "land", erase: ".", colour: (ch) => this.#landColour(ch) },
        { id: "areas", erase: ".", colour: (ch) => this.#areaColour(ch), alpha: 0.35 },
      ],
      cellPx: 5,
      onStroke: () => this.#stroked(),
      onPick: (ch) => this.#picked(ch),
      onHover: (cell) => this.#hover(cell),
      onDrop: (mv) => this.#dropped(mv),
      drawOver: (ctx, ed) => this.#drawOver(ctx, ed),
      snapshot: () => this.#undoState(),
      restore: (u) => this.#restoreUndo(u),
      pointer: { down: (ev, cell) => this.#storeDown(ev, cell), move: (ev, cell) => this.#storeMove(ev, cell), up: () => this.#storeUp() },
    });
    this.editor.transform = (ch, old) => {
      if (this.layer !== "land") return ch;
      if (ch === "=" && (old === "~" || old === "+")) return "+";       // a road over water is a bridge
      return ch;
    };
    this.tools = toolbar(this.editor);
    this.layerSeg = segmented({ label: "Layer", value: "land", options: [
      { value: "land", label: "Land" }, { value: "areas", label: "Areas" }, { value: "stores", label: "Stores" }],
    onChange: (v) => this.#setLayer(v) });
    this.palette = el("div", { class: "palette", role: "radiogroup", "aria-label": "Paint" });
    this.hoverText = el("div", { class: "editor-hover" });
    this.overlayBox = checkbox({ label: "Colour homes by stores in reach", onChange: (v) => { this.overlay = v; this.editor.draw(); } });

    // Readouts.
    this.readout = el("div", { class: "readouts" });

    const canvasCard = card("The map", { sub: "paint it; stores go on the Stores layer" });
    canvasCard.body.append(el("div", { class: "editor-bar" }, this.layerSeg.root, this.tools), this.palette,
      wrap, el("div", { class: "editor-foot" }, this.hoverText, this.overlayBox.root), this.readout);

    // Beside the map: what the layer edits.
    this.side = el("div", { class: "grid" });
    this.settingsCard = card("Map settings", { sub: "wait for Setup" });
    this.areasCard = card("Areas", { sub: "who lives where · wait for Setup" });
    this.storesCard = card("Stores", { sub: "by brand" });
    this.storeCard = card("The selected store", { sub: "" });
    this.side.append(this.storesCard.root, this.storeCard.root, this.areasCard.root, this.settingsCard.root);
    root.append(el("div", { class: "grid map-editor" }, canvasCard.root, this.side));
  }

  // ---- Loading the draft -------------------------------------------------------------------

  show() {
    const d = this.world.draft;
    if (!d) return;
    const key = JSON.stringify([d.macro.width, d.macro.height, d.macro.tiles, d.macro.area_tiles]);
    if (key !== this.loadedKey) {
      this.editor.load([d.macro.tiles, d.macro.area_tiles], { keepView: !!this.loadedKey && this.loadedSize === `${d.macro.width}x${d.macro.height}` });
      this.loadedKey = key; this.loadedSize = `${d.macro.width}x${d.macro.height}`;
    }
    this.#setLayer(this.layer);
    this.#renderSide();
    this.#schedulePreview(0);
  }

  // The draft was replaced (Import): start over from it.
  reload() { this.loadedKey = null; this.editor.clearHistory(); this.selected = null; this.show(); }

  // ---- Colours ---------------------------------------------------------------------------------

  #landColour(ch) {
    const r = this.editor.wrap;
    switch (ch) {
      case ".": return cssVar("--map-land", r);
      case "~": return cssVar("--map-water", r);
      case "p": return cssVar("--map-park", r);
      case "s": return cssVar("--map-shops", r);
      case "=": return cssVar("--map-road-paint", r);
      case "+": return mix(cssVar("--map-road-paint", r), cssVar("--map-water", r), 0.45);
      default: {
        const k = Number(ch);
        if (k >= 1 && k <= 9) return mix(cssVar("--map-land", r), cssVar("--map-homes", r), 0.25 + 0.75 * (k / 9));
        return "#ff00ff";
      }
    }
  }

  #areaColour(ch) {
    if (ch === ".") return null;
    const a = (this.world.draft?.macro.areas ?? []).find((x) => x.key === ch);
    return a ? a.colour : "#ff00ff";
  }

  // ---- Layers and the palette ----------------------------------------------------------------------

  #setLayer(layer) {
    this.layer = layer;
    this.layerSeg.set(layer);
    const areas = this.editor.layers[1];
    areas.alpha = layer === "areas" ? 0.7 : 0.3; areas.image = null;
    this.editor.setActive(layer === "areas" ? 1 : 0);
    this.tools.hidden = layer === "stores";
    if (layer === "stores") this.editor.setTool("pan");
    else if (["pan"].includes(this.editor.tool)) this.editor.setTool("pencil");
    this.#renderPalette();
    this.editor.draw();
  }

  #renderPalette() {
    const d = this.world.draft;
    let items;
    if (this.layer === "land") {
      items = LAND.map((t) => ({ ch: t.ch, label: t.note?.(d.macro) ?? t.label, colour: this.#landColour(t.ch), short: t.short }));
      if (!LAND.some((t) => t.ch === this.editor.paint)) this.editor.setPaint("=");
    } else if (this.layer === "areas") {
      items = [{ ch: ".", label: "No area", colour: "transparent" }, ...d.macro.areas.map((a) => ({ ch: a.key, label: a.name, colour: a.colour }))];
      if (!items.some((t) => t.ch === this.editor.paint)) this.editor.setPaint(items[1]?.ch ?? ".");
    } else {
      this.palette.replaceChildren(this.#storeTools());
      return;
    }
    this.palette.replaceChildren(...items.map((t) => el("button", {
      type: "button", class: "swatch", role: "radio", "aria-checked": String(this.editor.paint === t.ch), title: t.label, "aria-label": t.label,
      vars: { "--c": t.colour }, onclick: () => { this.editor.setPaint(t.ch); if (["erase", "pick", "select", "pan"].includes(this.editor.tool)) this.editor.setTool("pencil"); this.#renderPalette(); },
    }, t.short ? el("span", { text: t.short }) : null, el("em", { text: t.label }))));
  }

  #picked() { this.editor.setTool("pencil"); this.#renderPalette(); }

  // The Stores layer's own tools: what a click does.
  #storeTools() {
    const st = this.world.draft.stores.find((s) => s.id === this.selected);
    const text = st && !placed(st) ? `Click the map where ${st.name} goes (not on water).`
      : "Select a store on the map or in the list; drag it to move it. A store not on the map yet goes where you click once it's selected.";
    return el("div", { class: "store-tools" }, el("span", { class: "note", text }));
  }

  // A store from the list (or the micro world): selected, on the Stores layer.
  placeStore(id) {
    this.selected = id;
    this.#setLayer("stores");
    this.#renderSide(); this.editor.draw();
  }

  // ---- Undo ---------------------------------------------------------------------------------------

  // What undo keeps besides the tiles: where each store stands (null: not
  // on the map), and the areas.
  #undoState() {
    const d = this.world.draft;
    return { at: Object.fromEntries(d.stores.map((s) => [s.id, placed(s) ? [s.x, s.y] : null])), areas: clone(d.macro.areas) };
  }

  // Back to a kept state: stores stand where they stood (a store made since
  // keeps its place), and the areas are those there were, each with its
  // latest make-up.
  #restoreUndo(u) {
    this.world.edit((d) => {
      for (const s of d.stores) {
        if (!(s.id in u.at)) continue;
        const p = u.at[s.id];
        if (p) { s.x = p[0]; s.y = p[1]; } else { delete s.x; delete s.y; }
      }
      const now = new Map(d.macro.areas.map((a) => [a.id, a]));
      d.macro.areas = u.areas.map((a) => now.get(a.id) ?? clone(a));
    });
    this.#renderPalette();
  }

  // ---- Strokes, and the preview ---------------------------------------------------------------------

  #stroked() {
    const rows = [this.editor.rows(0), this.editor.rows(1)];
    this.world.edit((d) => {
      d.macro.tiles = rows[0]; d.macro.area_tiles = rows[1];
      d.macro.width = this.editor.W; d.macro.height = this.editor.H;
    }, { source: "map" });
    this.loadedKey = JSON.stringify([this.editor.W, this.editor.H, rows[0], rows[1]]);
    this.loadedSize = `${this.editor.W}x${this.editor.H}`;
    this.#renderSide();
    this.#schedulePreview();
  }

  // The stores standing in a block of land (rows r0.., columns c0..).
  #storesIn(r0, c0, h, w) {
    const m = this.world.draft.macro;
    return this.world.draft.stores.filter((s) => {
      if (!placed(s)) return false;
      const r = m.height - 1 - Math.floor(s.y / m.patch_m); const c = Math.floor(s.x / m.patch_m);
      return r >= r0 && r < r0 + h && c >= c0 && c < c0 + w;
    });
  }

  // A block of land moved (not copied): the stores on it go with it; one
  // it takes off the map is kept, not on the map yet.
  #dropped(mv) {
    if (mv.layer !== 0 || mv.copy || (!mv.dr && !mv.dc)) return;
    const moving = this.#storesIn(mv.r0, mv.c0, mv.h, mv.w);
    if (!moving.length) return;
    const m = this.world.draft.macro;
    let off = 0;
    this.world.edit(() => {
      for (const s of moving) {
        const x = s.x + mv.dc * m.patch_m; const y = s.y - mv.dr * m.patch_m;
        if (x >= 0 && y >= 0 && x < m.width * m.patch_m && y < m.height * m.patch_m) { s.x = x; s.y = y; } else { delete s.x; delete s.y; off++; }
      }
    });
    if (off) this.app.banner(`${off} store${off === 1 ? "" : "s"} moved off the map`, "They're still in the world, not on the map yet: the Stores layer puts them back.");
  }

  #schedulePreview(ms = 350) {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.#runPreview(), ms);
  }

  async #runPreview() {
    if (!this.app.ready) { this.#schedulePreview(500); return; }
    const seq = ++this.previewSeq;
    this.readout.classList.add("busy");
    let p;
    try { p = await this.app.client.request("PREVIEW_MACRO", { text: this.world.text() }); } catch (e) { p = { problems: [{ path: "", message: e.message }] }; }
    if (seq !== this.previewSeq) return;
    this.readout.classList.remove("busy");
    this.preview = p;
    this.#renderReadout();
    this.#renderStores();
    this.editor.draw();
  }

  #renderReadout() {
    const p = this.preview;
    if (!p) { this.readout.replaceChildren(); return; }
    if (p.problems?.length) {
      this.readout.replaceChildren(el("div", { class: "problems" }, el("b", { text: "The map can't be read yet:" }),
        ...p.problems.map((q) => el("button", { type: "button", class: "problem", text: `${q.path ? `${q.path}: ` : ""}${q.message}`, onclick: () => this.editor.setHighlights(q.tiles ?? []) }))));
      return;
    }
    const stranded = p.stranded;
    this.readout.replaceChildren(
      el("div", { class: "stat" }, el("div", { class: "stat-label", text: "Households" }), el("div", { class: "stat-value", text: fmt.int(p.households) })),
      el("div", { class: `stat${stranded ? " warn" : ""}` }, el("div", { class: "stat-label", text: "No store in reach" }),
        el("div", { class: "stat-value", text: fmt.int(stranded) }), el("div", { class: "stat-sub", text: stranded ? "their homes are outlined in red" : "every household can shop" })),
      el("p", { class: "note", text: "Worked out as Setup would: households placed on home tiles by density, each store's reach by the fastest route and each segment's radius (before loyalty stretches it)." }));
  }

  #hover(cell) {
    if (!cell) { this.hoverText.textContent = ""; return; }
    const d = this.world.draft; const m = d.macro;
    const ch = this.editor.at(0, cell.r, cell.c); const ak = this.editor.at(1, cell.r, cell.c);
    const land = LAND.find((t) => t.ch === ch)?.label ?? (ch === "+" ? "Bridge" : ch);
    const area = m.areas.find((a) => a.key === ak)?.name ?? "no area";
    const km = (v) => (v * m.patch_m / 1000).toFixed(v * m.patch_m >= 10000 ? 0 : 2);
    let extra = "";
    const t = this.preview?.tiles;
    if (t) {
      const i = this.#tileIndex(cell.r, cell.c);
      if (i >= 0) extra = ` · ${fmt.int(t.households[i])} household${t.households[i] === 1 ? "" : "s"}, ${fmt.num1(t.stores[i])} stores in reach${t.stranded[i] ? ` (${t.stranded[i]} with none)` : ""}`;
    }
    this.hoverText.textContent = `${land} · ${area} · ${km(cell.c + 0.5)} km east, ${km(m.height - cell.r - 0.5)} km north${extra}`;
  }

  #tileIndex(r, c) {
    const t = this.preview?.tiles; if (!t) return -1;
    if (!this.tileLookup || this.tileLookup.src !== t) {
      const map = new Map(); t.row.forEach((rr, i) => map.set(rr * 100000 + t.col[i], i));
      this.tileLookup = { src: t, map };
    }
    return this.tileLookup.map.get(r * 100000 + c) ?? -1;
  }

  // ---- Drawing over the map ---------------------------------------------------------------------

  #drawOver(ctx, ed) {
    const d = this.world.draft; if (!d) return;
    const z = ed.zoom;
    const p = this.preview?.tiles;
    if (p && (this.overlay || this.preview.stranded)) {
      const maxS = Math.max(1, ...p.stores);
      for (let i = 0; i < p.row.length; i++) {
        const s = ed.toScreen(p.row[i], p.col[i]);
        if (this.overlay) {
          const t = p.stores[i] / maxS;
          ctx.fillStyle = `rgba(${Math.round(230 - 180 * t)},${Math.round(90 + 100 * t)},${Math.round(60 + 160 * t)},0.8)`;
          ctx.fillRect(s.x, s.y, z, z);
        }
        if (p.stranded[i]) { ctx.strokeStyle = "#e03131"; ctx.lineWidth = Math.max(1, Math.min(2.5, z / 3)); ctx.strokeRect(s.x + 0.5, s.y + 0.5, Math.max(1, z - 1), Math.max(1, z - 1)); }
      }
    }
    // Stores: a square in the brand's colour, the selected one ringed. A
    // block of land being moved carries its stores.
    const m = d.macro;
    const size = Math.max(4, Math.min(12, z * 1.2));
    ctx.font = `600 11px ${cssVar("--font", ed.wrap) || "system-ui"}`;
    const b0 = ed.lifted && ed.active === 0 && !ed.lifted.copy ? ed.lifted : null;
    const carried = new Set(b0 ? this.#storesIn(b0.r0, b0.c0, b0.h, b0.w) : []);
    for (const st of d.stores) {
      if (!placed(st)) continue;
      const b = d.brands.find((x) => x.id === st.brand);
      const shift = carried.has(st) ? [b0.r - b0.r0, b0.c - b0.c0] : [0, 0];
      const c = st.x / m.patch_m + shift[1]; const r = m.height - st.y / m.patch_m + shift[0];
      const x = ed.ox + c * z; const y = ed.oy + r * z;
      ctx.fillStyle = b?.colour ?? "#888"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
      ctx.fillRect(x - size / 2, y - size / 2, size, size); ctx.strokeRect(x - size / 2, y - size / 2, size, size);
      if (st.id === this.selected) { ctx.strokeStyle = cssVar("--ink", ed.wrap); ctx.lineWidth = 2; ctx.strokeRect(x - size / 2 - 3, y - size / 2 - 3, size + 6, size + 6); }
      if (this.layer === "stores" && z >= 3) {
        ctx.lineWidth = 3; ctx.strokeStyle = cssVar("--surface", ed.wrap); ctx.strokeText(st.short, x + size / 2 + 3, y + 4);
        ctx.fillStyle = cssVar("--ink", ed.wrap); ctx.fillText(st.short, x + size / 2 + 3, y + 4);
      }
    }
  }

  // ---- Stores on the map ------------------------------------------------------------------------

  #storeAt(ev) {
    const d = this.world.draft; const ed = this.editor; const m = d.macro;
    const rect = ed.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left; const y = ev.clientY - rect.top;
    let best = null; let bd = 12 * 12;
    for (const st of d.stores) {
      if (!placed(st)) continue;
      const sx = ed.ox + (st.x / m.patch_m) * ed.zoom; const sy = ed.oy + (m.height - st.y / m.patch_m) * ed.zoom;
      const dd = (sx - x) ** 2 + (sy - y) ** 2;
      if (dd < bd) { bd = dd; best = st; }
    }
    return best;
  }

  #storeDown(ev, cell) {
    if (this.layer !== "stores" || ev.button !== 0) return false;
    const d = this.world.draft; const m = d.macro;
    // The selected store isn't on the map yet: it goes where the click is.
    const waiting = d.stores.find((s) => s.id === this.selected && !placed(s));
    if (waiting) {
      if (!this.editor.inside(cell.r, cell.c)) return true;
      if (this.editor.at(0, cell.r, cell.c) === "~") { this.app.banner("Not on water", "A store has to stand on land."); return true; }
      this.editor.record();
      this.world.edit(() => { waiting.x = (cell.c + 0.5) * m.patch_m; waiting.y = (m.height - cell.r - 0.5) * m.patch_m; });
      this.#renderPalette(); this.#renderSide(); this.editor.draw(); this.#schedulePreview();
      return true;
    }
    const st = this.#storeAt(ev);
    if (!st) { if (this.selected) { this.selected = null; this.#renderSide(); this.editor.draw(); } return false; }
    this.selected = st.id;
    this.moving = { id: st.id, snap: this.#undoState(), moved: false };
    try { this.editor.canvas.setPointerCapture(ev.pointerId); } catch { /* a pointer the browser no longer tracks */ }
    this.#renderSide(); this.editor.draw();
    return true;
  }

  #storeMove(ev, cell) {
    if (!this.moving) return false;
    const d = this.world.draft; const m = d.macro;
    if (!this.editor.inside(cell.r, cell.c) || this.editor.at(0, cell.r, cell.c) === "~") return true;
    const st = d.stores.find((s) => s.id === this.moving.id);
    const x = (cell.c + 0.5) * m.patch_m; const y = (m.height - cell.r - 0.5) * m.patch_m;
    if (st.x !== x || st.y !== y) { st.x = x; st.y = y; this.moving.moved = true; this.editor.draw(); }
    return true;
  }

  #storeUp() {
    if (!this.moving) return false;
    const mv = this.moving; this.moving = null;
    if (mv.moved) {
      this.editor.record(mv.snap);
      this.world.edit(() => {});
      this.#renderSide(); this.#schedulePreview();
    }
    return true;
  }

  // ---- Beside the map ---------------------------------------------------------------------------

  #renderSide() {
    this.#renderStores();
    this.#renderStore();
    this.#renderAreas();
    this.#renderSettings();
  }

  // Stores, by brand, with how many households have each in reach.
  #renderStores() {
    const d = this.world.draft;
    const reach = this.preview?.reach;
    const body = el("div", { class: "store-list" });
    for (const b of d.brands) {
      const mine = d.stores.map((s, i) => ({ s, i })).filter((x) => x.s.brand === b.id);
      body.append(el("div", { class: "store-group", vars: { "--brand": b.colour } }, el("div", { class: "brand-name" }, el("i", { class: "dot" }), b.name, el("span", { class: "sub", text: ` · ${mine.length} store${mine.length === 1 ? "" : "s"}` })),
        ...mine.map(({ s, i }) => el("button", { type: "button", class: `store-row${s.id === this.selected ? " is-on" : ""}`, onclick: () => this.placeStore(s.id) },
          el("span", { text: s.name }),
          placed(s) ? el("span", { class: "sub", text: reach && !this.preview.problems?.length ? `${fmt.compact(reach[i])} in reach` : "" })
            : el("span", { class: "sub bad", text: "not on the map" })))));
    }
    this.storesCard.body.replaceChildren(body);
    this.storesCard.setSub(`${d.stores.length} stores · households with each in reach`);
  }

  // The selected store: where it stands. Its name, brand, layout and staff
  // are the micro world's.
  #renderStore() {
    const d = this.world.draft;
    const st = d.stores.find((s) => s.id === this.selected);
    this.storeCard.root.hidden = !st;
    if (!st) return;
    const b = d.brands.find((x) => x.id === st.brand);
    const L = d.layouts.find((l) => l.id === st.layout);
    this.storeCard.head.querySelector("h2").textContent = st.name;
    this.storeCard.setSub(`${b?.name ?? st.brand} · ${L?.name ?? st.layout} layout`);
    const area = placed(st) ? d.macro.areas.find((a) => a.key === d.macro.area_tiles?.[d.macro.height - 1 - Math.floor(st.y / d.macro.patch_m)]?.[Math.floor(st.x / d.macro.patch_m)]) : null;
    this.storeCard.body.replaceChildren(
      el("p", { class: `note${placed(st) ? "" : " bad"}`, text: placed(st) ? `Stands ${area ? `in ${area.name}` : "outside every area"}. Drag it on the map to move it.` : "Not on the map yet: click the map where it goes." }),
      el("div", { class: "row" }, el("button", { type: "button", class: "btn small", text: "Its name, brand, layout and staff (Micro world)", onclick: () => this.onEditStore?.(st.id) })));
  }

  // Areas and the make-up of their households.
  #renderAreas() {
    const d = this.world.draft; const schema = this.world.schema; if (!schema) return;
    const m = d.macro;
    if (!m.areas.some((a) => a.id === this.area)) this.area = m.areas[0]?.id ?? "__default";
    const list = el("div", { class: "area-list" }, ...m.areas.map((a) => el("div", { class: `area-row${a.id === this.area ? " is-on" : ""}` },
      colourField({ label: `Colour of ${a.name}`, value: a.colour, onChange: (v) => { this.world.edit(() => { a.colour = v; }); this.editor.refreshColours(); this.#renderPalette(); } }).root,
      el("button", { type: "button", class: "linkish", text: a.name, onclick: () => { this.area = a.id; this.#setLayer("areas"); this.editor.setPaint(a.key); this.#renderPalette(); this.#renderAreas(); } }),
      el("span", { class: "sub", text: this.#areaHouseholds(a) }),
      el("button", { type: "button", class: "icon-btn", "aria-label": `Delete ${a.name}`, title: `Delete ${a.name} (its tiles become no area)`, text: "×", onclick: () => this.#deleteArea(a) }))),
    el("div", { class: `area-row${this.area === "__default" ? " is-on" : ""}` }, el("i", { class: "legend-swatch square", vars: { "--c": "transparent" } }),
      el("button", { type: "button", class: "linkish", text: "Outside every area", onclick: () => { this.area = "__default"; this.#renderAreas(); } })));
    const add = el("button", { type: "button", class: "btn small", text: "Add area", disabled: m.areas.length >= (schema.limits.areas ?? 40) || null, onclick: () => this.#addArea() });
    const a = m.areas.find((x) => x.id === this.area);
    const mk = a ?? m.default_makeup;
    const nameField = a ? textField({ label: "Name", value: a.name, onChange: (v) => { this.world.edit(() => { a.name = v; }); this.#renderAreas(); this.#renderPalette(); } }).root : null;
    const budget = settingLever(schema.fields.area.budget, { value: mk.budget, onChange: (v) => this.world.edit(() => { mk.budget = v; }) });
    const mixBlock = (what, keys, labels) => {
      const total = el("span", { class: "sub" });
      const showTotal = () => { const s = keys.reduce((acc, k) => acc + (mk[what][k] ?? 0), 0); total.textContent = `adds up to ${fmt.pct(s, 1)}`; total.classList.toggle("bad", Math.abs(s - 1) > 0.005); };
      showTotal();
      return el("div", {}, el("h3", { class: "setup-heading" }, what === "segment_mix" ? "Segments " : "Sizes ", total),
        el("div", { class: "settings-grid compact" }, ...keys.map((k, i) => settingLever({ label: labels[i], min: 0, max: 1, step: 0.01, format: "pct" }, {
          value: mk[what][k] ?? 0, onChange: (v) => { this.world.edit(() => { mk[what][k] = v; }); showTotal(); } }).root)));
    };
    this.areasCard.body.replaceChildren(list, el("div", { class: "row" }, add),
      el("div", { class: "area-detail" }, el("h3", { class: "setup-heading", text: a ? a.name : "Households outside every area" }), nameField, budget.root,
        mixBlock("segment_mix", d.segments.map((s) => s.id), d.segments.map((s) => s.name)),
        mixBlock("size_mix", schema.sizes, schema.sizes)));
  }

  #areaHouseholds(a) {
    const t = this.preview?.tiles; if (!t) return "";
    let n = 0;
    t.row.forEach((r, i) => { if (this.editor.at(1, r, t.col[i]) === a.key) n += t.households[i]; });
    return `${fmt.compact(n)} households`;
  }

  #addArea() {
    const d = this.world.draft; const m = d.macro;
    const key = [...AREA_KEYS].find((k) => !m.areas.some((a) => a.key === k));
    const base = m.areas.find((x) => x.id === this.area) ?? m.default_makeup;
    const name = newName(m.areas, "New area");
    const hue = (m.areas.length * 67) % 360;
    const area = { key, id: newId(m.areas, name), name, colour: hslHex(hue, 45, 85), budget: base.budget,
      segment_mix: clone(base.segment_mix), size_mix: clone(base.size_mix) };
    this.editor.record();
    this.world.edit(() => { m.areas.push(area); });
    this.area = area.id;
    this.#setLayer("areas"); this.editor.setPaint(key); this.#renderPalette(); this.#renderAreas();
  }

  #deleteArea(a) {
    const d = this.world.draft; const m = d.macro;
    this.editor.record();
    const rows = this.editor.rows(1).map((row) => row.split(a.key).join("."));
    this.world.edit(() => { m.areas = m.areas.filter((x) => x.id !== a.id); m.area_tiles = rows; });
    this.editor.load([m.tiles, rows], { keepView: true });
    this.loadedKey = null;
    this.#renderPalette(); this.#renderAreas(); this.#schedulePreview();
  }

  // Map settings: size and scale, households, speeds, parking, word of mouth.
  #renderSettings() {
    const d = this.world.draft; const schema = this.world.schema; if (!schema) return;
    const m = d.macro;
    const f = schema.fields.macro;
    const setM = (k) => (v) => {
      this.world.edit(() => { m[k] = v; });
      if (k === "patch_m") this.editor.draw();
      if (k === "households" && this.layer === "land") this.#renderPalette();
      this.#schedulePreview();
    };
    const w = numberField({ label: "Width (tiles)", value: m.width, min: 8, max: 600, onChange: () => {} });
    const h = numberField({ label: "Height (tiles)", value: m.height, min: 8, max: 600, onChange: () => {} });
    let anchor = "nw";
    const anchors = el("div", { class: "anchor-grid", role: "radiogroup", "aria-label": "Keep the map anchored to" }, ...ANCHORS.map((a) => el("button", {
      type: "button", role: "radio", "aria-checked": String(a === anchor), title: `Keep the map at the ${a}`, onclick: (ev) => {
        anchor = a; for (const b of anchors.children) b.setAttribute("aria-checked", String(b === ev.currentTarget));
      } })));
    const limit = schema.limits.map_tiles;
    const apply = el("button", { type: "button", class: "btn small", text: "Resize", onclick: () => {
      const W = Number(w.input.value); const H = Number(h.input.value);
      if (W * H > limit) { this.app.banner("Too big", `${W} × ${H} is ${fmt.int(W * H)} tiles; a map has at most ${fmt.int(limit)}.`); return; }
      if (W === this.editor.W && H === this.editor.H) return;
      const oldH = this.editor.H;
      const { dx, dy } = this.editor.resize(W, H, anchor);
      this.#afterResize(dx, dy, W, H, oldH);
    } });
    this.settingsCard.body.replaceChildren(
      el("div", { class: "resize" }, w.root, h.root, el("div", { class: "field" }, el("span", { text: "Keep at" }), anchors), apply),
      el("p", { class: "note", text: `${fmt.int(m.width)} × ${fmt.int(m.height)} tiles of ${fmt.int(m.patch_m)} m: ${fmt.num1(m.width * m.patch_m / 1000)} × ${fmt.num1(m.height * m.patch_m / 1000)} km. At most ${fmt.int(limit)} tiles.` }),
      el("div", { class: "settings-grid" }, ...["patch_m", "households", "road_mps", "local_mps", "park_s", "wom_m"].map((k) => settingLever(f[k], { value: m[k], onChange: setM(k) }).root)));
  }

  // After the canvas grew or was cropped: the map's rows, and the stores on
  // the map moved with the land. A store cropped away stays in the world,
  // not on the map yet (as does one that wasn't on it). A store's y is
  // measured from the south edge, so it moves with the rows added or cut
  // below.
  #afterResize(dx, dy, W, H, oldH) {
    const m = this.world.draft.macro;
    const rows = [this.editor.rows(0), this.editor.rows(1)];
    const south = (H - oldH) - dy;
    let off = 0;
    this.world.edit((w) => {
      w.macro.width = W; w.macro.height = H; w.macro.tiles = rows[0]; w.macro.area_tiles = rows[1];
      for (const s of w.stores) {
        if (!placed(s)) continue;
        const x = s.x + dx * m.patch_m; const y = s.y + south * m.patch_m;
        if (x >= 0 && y >= 0 && x < W * m.patch_m && y < H * m.patch_m) { s.x = x; s.y = y; } else { delete s.x; delete s.y; off++; }
      }
    });
    this.loadedKey = JSON.stringify([W, H, rows[0], rows[1]]); this.loadedSize = `${W}x${H}`;
    this.#renderSide(); this.#schedulePreview();
    if (off) this.app.banner(`${off} store${off === 1 ? "" : "s"} cropped off the map`, "They're still in the world, not on the map yet: the Stores layer puts them back.");
  }
}

function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
