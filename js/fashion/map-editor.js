// The macro world's editor, on the Setup tab: the market map, painted.
//
//   Land     open land, roads (a road over water is a bridge), water,
//            parks, shops, and homes at a density from 1 to 9. The palette
//            names each tile and says what it does in the model: which
//            shape the simulation, which are looks only.
//   Areas    optional named regions, painted on their own layer, each with
//            the make-up of the households who live there (shown beside
//            the map for the area being painted, and named on the map)
//   Parking & venues  the parking the user builds (lots and garages made
//            from painted P and G tiles, kerb spaces clicked onto streets),
//            shopping venues (malls with a plan of corridors, strip malls,
//            districts), what the model can't reach, and a trip as the
//            model would make it (transport-editor.js)
//   Stores   where each store stands, as a pin in its brand's colour (the
//            map's shops tiles are ground, not stores): select one (on the
//            map or in the list), click the map to put it there, drag one
//            to move it. Stores are made, named and staffed in the micro
//            world (store-editor.js). A block of land moved with the
//            select tool takes the stores standing on it along.
//
// A starting geography (geography.js) replaces the map's tiles, repaints
// the world's areas onto its districts and puts the stores on its sites,
// after asking; nothing else in the world changes, and undo brings the
// old map back.
//
// Undo covers the tiles, where the stores stand and which areas there are
// (an area's make-up stays as last set).
//
// After every stroke the draft goes to R, which places the households and
// routes every trip the way Setup would, and says how many households
// there are, how many have no store within their radius (their homes
// highlighted), and how many households have each store in reach. The
// map says which of the three it is showing: the draft being painted, the
// model's preview of that draft, and the world installed at the last
// Setup, which is what the simulation runs until the next one.

import { el, fill, fmt, card, textField, numberField, colourField, settingLever, cssVar, checkbox, segmented } from "./ui.js";
import { GridEditor, toolbar } from "./grid-editor.js";
import { mix } from "./city-view.js";
import { clone, newId, newName, placed, tileAt, tileCentre, setPlace, unplace } from "./world-store.js";
import { loadGeographies, applyGeography, geographyNeeds, AREA_KEYS } from "./geography.js";
import { TransportTools } from "./transport-editor.js";

const mps = (v) => `${fmt.num1(v)} m/s`;

// Each tile's name, its group on the palette, and what it does in the model
// (transport.R): who can cross it, cars or people or both or neither.
const LAND = [
  { ch: ".", group: "ground", label: "Open land", does: () => "People can walk across it; cars can't. Nobody lives on it." },
  { ch: "p", group: "ground", label: "Park", does: () => "People walk its paths; cars can't enter it." },
  { ch: "w", group: "ground", label: "Woodland", does: () => "No one gets through: paint a footpath across it for a trail." },
  { ch: "~", group: "ground", label: "Water", does: () => "No one crosses it, and no store stands on it. A street painted over it becomes a bridge, a footpath a footbridge." },
  { ch: "#", group: "ground", label: "Building or barrier", does: () => "Solid: no car and no one on foot gets through. Walls, fences, blocks." },
  { ch: "=", group: "cars", label: "Street", does: (m) => `Cars drive it at ${mps(m.road_mps)}; people walk its sidewalks. A street gives no parking: mark kerb spaces on it (Parking & venues).` },
  { ch: "H", group: "cars", label: "Highway", does: (m) => `Cars only, at ${mps(m.road_mps)}: no sidewalks, and people can't cross it except at a crossing.` },
  { ch: "x", group: "cars", label: "Crossing", does: (m) => `On a highway: cars drive through at ${mps(m.road_mps)}, and people can cross there.` },
  { ch: "d", group: "cars", label: "Driveway", does: (m) => `A driveway or service road: cars at ${mps(m.local_mps)}, and people. It joins a lot's entrance to a street.` },
  { ch: "-", group: "people", label: "Footpath", does: (m) => `People only, at ${mps(m.walk_mps ?? 1.3)}: a path, or a trail through woodland. Over water it becomes a footbridge.` },
  { ch: "s", group: "people", label: "Pedestrian street", does: () => "A plaza, a pedestrian street or a strip mall's walkway: people only. Shops' doors open onto it." },
  { ch: "P", group: "parking", label: "Parking lot", does: () => "A surface lot's ground: people walk across it; cars park on it only once it's made a facility (Parking & venues), in by its entrances." },
  { ch: "G", group: "parking", label: "Parking garage", does: () => "A garage's building: once made a facility, cars go in at its entrances and people leave by its exits; no one passes through." },
  { ch: "m", group: "parking", label: "Mall building", does: () => "An enclosed mall's building: crossed only along its plan's corridors (Parking & venues)." },
  ...Array.from({ length: 9 }, (_, i) => ({ ch: String(i + 1), label: `Homes, density ${i + 1}`, short: String(i + 1), density: i + 1,
    does: (m) => `Households live here; its local streets carry cars at ${mps(m.local_mps)} and people.` })),
];
const ANCHORS = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"];

export class MapEditor {
  constructor(root, app) {
    this.app = app; this.world = app.world;
    this.layer = "land"; this.paintLayer = "land"; this.selected = null; this.preview = null; this.overlay = false;
    this.onEditStore = null;             // opens a store in the micro world (Setup)
    this.onOpenLayout = null;            // opens a layout's floor plan in the micro world (Setup)
    this.previewTimer = 0; this.previewRev = 0; this.previewState = "none";
    this.geographies = null; this.asking = null;

    // The canvas and its tools.
    const wrap = el("div", { class: "editor-canvas map-editor-canvas" });
    this.editor = new GridEditor(wrap, {
      layers: [
        { id: "land", erase: ".", colour: (ch) => this.#landColour(ch) },
        { id: "areas", erase: ".", colour: (ch) => this.#areaColour(ch), alpha: 0.35 },
      ],
      cellPx: 5,
      names: { material: (ch, layer) => this.#materialName(ch, layer), layer: (i) => (i === 1 ? "Areas" : "Land") },
      cellM: () => this.world.draft?.macro.patch_m,
      onStroke: () => this.#stroked(),
      onPick: (ch) => this.#picked(ch),
      onHover: (cell) => this.#hover(cell),
      onToolChange: (tool) => this.#toolChanged(tool),
      onDrop: (mv) => this.#dropped(mv),
      drawOver: (ctx, ed) => this.#drawOver(ctx, ed),
      snapshot: () => this.#undoState(),
      restore: (u) => this.#restoreUndo(u),
      pointer: { down: (ev, cell) => this.#storeDown(ev, cell), move: (ev, cell) => this.#storeMove(ev, cell), up: () => this.#storeUp(), cancel: () => this.#storeCancel() },
    });
    this.editor.transform = (ch, old) => {
      if (this.layer !== "land") return ch;
      if (ch === "=" && (old === "~" || old === "+")) return "+";       // a road over water is a bridge
      if (ch === "-" && (old === "~" || old === "f")) return "f";       // a footpath over water is a footbridge
      return ch;
    };
    this.transport = new TransportTools(this);
    this.tools = toolbar(this.editor, { place: {
      label: "Place store", title: "Place store: put the world's stores on the map, and drag one to move it (the Stores layer)",
      onClick: () => this.#setLayer("stores"), active: () => this.layer === "stores", describe: () => this.#storeHint() } });
    this.layerSeg = segmented({ label: "Layer", value: "land", options: [
      { value: "land", label: "Land", title: "Paint the ground: roads, water, parks, shops and homes" },
      { value: "areas", label: "Areas", title: "Paint named areas: who lives where" },
      { value: "transport", label: "Parking & venues", title: "Build parking, tie stores into venues, draw a mall's plan, and see what can't be reached" },
      { value: "stores", label: "Stores", title: "Put the stores on the map" }],
    onChange: (v) => this.#setLayer(v) });
    this.palette = el("div", { class: "palette inline", role: "radiogroup", "aria-label": "Paint" });
    this.paletteNote = el("p", { class: "palette-note" });
    this.hoverText = el("div", { class: "editor-hover" });
    this.overlayBox = checkbox({ label: "Colour homes by stores in reach", onChange: (v) => { this.overlay = v; this.editor.draw(); } });

    // What's being looked at (draft, preview, installed), and the readouts.
    this.stateBox = el("div", { class: "world-states", role: "status" });
    this.readout = el("div", { class: "readouts" });

    const canvasCard = card("The map", { sub: "draw it; the model previews every stroke" });
    canvasCard.root.classList.add("canvas-card");
    canvasCard.head.querySelector("h2").after(this.layerSeg.root);
    canvasCard.body.append(el("div", { class: "editor-bar" }, this.tools), this.palette, this.paletteNote,
      wrap, el("div", { class: "editor-foot" }, this.hoverText, this.overlayBox.root), this.stateBox, this.readout);

    // Beside the map: what the layer edits.
    this.side = el("div", { class: "grid map-side" });
    this.startCard = card("Start from a geography", { sub: "the map only" });
    this.legendCard = card("What the map does", { sub: "in the simulation" });
    this.settingsCard = card("Map settings", { sub: "wait for Setup" });
    this.areasCard = card("Areas", { sub: "who lives where · wait for Setup" });
    this.storesCard = card("Stores", { sub: "by brand" });
    this.storeCard = card("The selected store", { sub: "" });
    root.append(el("div", { class: "grid map-editor" }, canvasCard.root, this.side));
    this.world.addEventListener("change", () => this.#renderStates());
  }

  // ---- Loading the draft -------------------------------------------------------------------

  show() {
    const d = this.world.draft;
    if (!d) return;
    const key = JSON.stringify([d.macro.width, d.macro.height, d.macro.tiles, d.macro.area_tiles]);
    if (key !== this.loadedKey) {
      this.editor.load([d.macro.tiles, d.macro.area_tiles], { keepView: !!this.loadedKey && this.loadedSize === `${d.macro.width}x${d.macro.height}` });
      this.loadedKey = key; this.loadedSize = `${d.macro.width}x${d.macro.height}`;
      this.areaLabels = null; this.densitySum = undefined;
    }
    this.#setLayer(this.layer);
    this.#renderSide();
    this.#renderStates();
    this.#schedulePreview(0);
    if (!this.geographies) loadGeographies().then((g) => { this.geographies = g; this.#renderStart(); }).catch(() => { this.geographies = []; this.#renderStart(); });
  }

  // The draft was replaced (Import): start over from it.
  reload() { this.loadedKey = null; this.editor.clearHistory(); this.selected = null; this.asking = null; this.show(); }

  // ---- Colours ---------------------------------------------------------------------------------

  #landColour(ch) {
    const r = this.editor.wrap;
    switch (ch) {
      case ".": return cssVar("--map-land", r);
      case "~": return cssVar("--map-water", r);
      case "p": return cssVar("--map-park", r);
      case "s": return cssVar("--map-plaza", r);
      case "=": return cssVar("--map-road-paint", r);
      case "+": return mix(cssVar("--map-road-paint", r), cssVar("--map-water", r), 0.45);
      case "w": return cssVar("--map-wood", r);
      case "#": return cssVar("--map-building", r);
      case "-": return cssVar("--map-path", r);
      case "f": return mix(cssVar("--map-path", r), cssVar("--map-water", r), 0.45);
      case "H": return cssVar("--map-highway", r);
      case "x": return mix(cssVar("--map-highway", r), "#ffffff", 0.45);
      case "d": return mix(cssVar("--map-road-paint", r), cssVar("--map-land", r), 0.45);
      case "P": return cssVar("--map-lot", r);
      case "G": return cssVar("--map-garage", r);
      case "m": return cssVar("--map-mall", r);
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
    if (layer !== "stores" && layer !== "transport") this.paintLayer = layer;
    if (layer === "stores" || layer === "transport") this.editor.setTool("pan");
    else if (["pan"].includes(this.editor.tool)) this.editor.setTool("pencil");
    this.#renderPalette();
    this.#orderSide();
    this.tools.sync();
    this.editor.draw();
  }

  // A painting tool picked while the stores are being placed: back to the
  // layer that was being painted.
  #toolChanged(tool) {
    if ((this.layer === "stores" || this.layer === "transport") && tool !== "pan") this.#setLayer(this.paintLayer ?? "land");
  }

  // A tile's name, as the palette says it.
  #materialName(ch, layer) {
    if (layer === 1) return ch === "." ? "No area" : this.world.draft?.macro.areas.find((a) => a.key === ch)?.name ?? ch;
    return LAND.find((t) => t.ch === ch)?.label ?? ({ "+": "Bridge", f: "Footbridge" }[ch] ?? ch);
  }

  // Households a home tile of density k is expected to hold: the map's
  // households are shared among its home tiles in proportion to density
  // (draw_homes in city.R), so a tile of density k gets k parts in the sum
  // of every home tile's density (itself included, on a map with no homes
  // yet).
  #perTile(k) {
    const m = this.world.draft.macro;
    if (this.densitySum === undefined) {
      const data = this.editor.layers[0].data; let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = data[i] - 48; if (v >= 1 && v <= 9) sum += v; }
      this.densitySum = sum;
    }
    return m.households * k / (this.densitySum || k);
  }

  #renderPalette() {
    const d = this.world.draft; const m = d.macro;
    const pick = (ch) => { this.editor.setPaint(ch); if (["erase", "pick", "select", "pan"].includes(this.editor.tool)) this.editor.setTool("pencil"); };
    const swatch = (t, after) => el("button", {
      type: "button", class: `swatch${t.short ? "" : " named"}`, role: "radio", "aria-checked": String(this.editor.paint === t.ch), title: t.title ?? t.label, "aria-label": t.label,
      vars: { "--c": t.colour }, onclick: () => { pick(t.ch); after?.(); this.#renderPalette(); },
    }, t.short ? el("span", { text: t.short }) : [el("i", { class: "swatch-chip" }), el("em", { text: t.text ?? t.label })]);
    const group = (title, ...nodes) => el("div", { class: "palette-group" }, el("div", { class: "palette-title", text: title }), el("div", { class: "palette-row" }, ...nodes));
    if (this.layer === "land") {
      if (!LAND.some((t) => t.ch === this.editor.paint)) this.editor.setPaint("=");
      const cur = LAND.find((t) => t.ch === this.editor.paint);
      const of = (g) => LAND.filter((t) => t.group === g).map((t) => swatch({ ...t, colour: this.#landColour(t.ch), title: `${t.label}: ${t.does(m)}` }));
      // A bridge or a footbridge isn't painted on its own: it's what a street or a footpath over water becomes.
      const hint = (ch, label, title, paint) => el("button", { type: "button", class: "swatch named hint", title, "aria-label": title,
        vars: { "--c": this.#landColour(ch) }, onclick: () => { pick(paint); this.#renderPalette(); } }, el("i", { class: "swatch-chip" }), el("em", { text: label }));
      const homes = LAND.filter((t) => t.density).map((t) => swatch({ ...t, colour: this.#landColour(t.ch),
        title: `${t.label} of 9: households live here, about ${fmt.num1(this.#perTile(t.density))} a tile on this map; cars and people use its local streets` }));
      this.palette.replaceChildren(group("Ground", ...of("ground")),
        group("For cars", ...of("cars"), hint("+", "Bridge", "Bridge: what a street painted over water becomes, for cars and people. Click to paint streets.", "=")),
        group("For people", ...of("people"), hint("f", "Footbridge", "Footbridge: what a footpath painted over water becomes, for people only. Click to paint footpaths.", "-")),
        group("Parking and malls (then build them on Parking & venues)", ...of("parking")),
        group("Homes: where households live", el("span", { class: "ramp-end", text: "sparse" }), ...homes, el("span", { class: "ramp-end", text: "dense" })));
      this.paletteNote.textContent = cur.density
        ? `${cur.label} of 9. Households live on home tiles, more of them the denser the tile: about ${fmt.num1(this.#perTile(cur.density))} a tile at this density (the map's ${fmt.int(m.households)} households, shared by density).`
        : `${cur.label}. ${cur.does(m)}`;
    } else if (this.layer === "transport") {
      const t = this.transport.palette();
      this.palette.replaceChildren(...t.nodes);
      this.paletteNote.textContent = t.note;
    } else if (this.layer === "areas") {
      const items = [{ ch: ".", label: "No area", colour: "transparent" }, ...m.areas.map((a) => ({ ch: a.key, label: a.name, colour: a.colour, id: a.id }))];
      if (!items.some((t) => t.ch === this.editor.paint)) this.editor.setPaint(items[1]?.ch ?? ".");
      const add = el("button", { type: "button", class: "swatch named add", title: "A new named area, ready to paint", "aria-label": "New area",
        disabled: m.areas.length >= (this.world.schema?.limits.areas ?? 40) || null, onclick: () => this.#addArea() }, el("em", { text: "+ New area" }));
      this.palette.replaceChildren(group("Areas: who lives where", ...items.map((t) => swatch(t, () => { if (t.id) { this.area = t.id; this.#renderAreas(); } })), add));
      const a = m.areas.find((x) => x.key === this.editor.paint);
      this.paletteNote.textContent = a
        ? `${a.name}. Households on its tiles take their segment, size and budget from its make-up, set beside the map. Paint it with a large brush, or Fill a block of homes.`
        : m.areas.length ? "No area. Households outside every area take the map's default make-up." : "No areas yet: every household takes the map's default make-up. Add one to give a part of the map its own.";
    } else {
      const waiting = d.stores.filter((s) => !placed(s));
      this.palette.replaceChildren(el("div", { class: "store-tools" },
        waiting.length ? el("span", { class: "palette-title", text: `${waiting.length} not on the map yet:` }) : null,
        ...waiting.slice(0, 12).map((s) => el("button", { type: "button", class: `chip-btn${s.id === this.selected ? " is-on" : ""}`, title: `Select ${s.name}, then click the map where it goes`,
          vars: { "--brand": d.brands.find((b) => b.id === s.brand)?.colour ?? "#888" }, onclick: () => this.placeStore(s.id) }, el("i", { class: "dot" }), s.short)),
        waiting.length > 12 ? el("span", { class: "sub", text: `and ${waiting.length - 12} more, in the list` }) : null));
      this.paletteNote.textContent = waiting.length ? "Pick a store that isn't on the map yet, here or in the list, then click the map where it goes: the next one is picked for you."
        : "Every store is on the map: a pin in its brand's colour. Point at one for its name.";
    }
    this.tools.sync();
  }

  renderPalette() { this.#renderPalette(); }

  // The Parking & venues layer, with tiles (a warning's) shown on the map.
  showTransport(tiles) {
    this.#setLayer("transport");
    if (tiles?.length) { this.editor.setHighlights(tiles); this.editor.reveal(tiles); }
  }

  // A change on the Parking & venues layer: everything that shows it, and
  // the model's preview of it.
  afterTransportEdit({ plan = true } = {}) {
    if (plan) this.transport.render(); else { this.transport.render(); }
    this.#renderPalette(); this.#renderStores(); this.editor.draw(); this.#schedulePreview();
  }

  // The eyedropper took a tile: paint with it (an area becomes the one
  // whose make-up is shown).
  #picked(ch) {
    this.editor.setTool("pencil");
    if (this.layer === "areas") { const a = this.world.draft.macro.areas.find((x) => x.key === ch); if (a) { this.area = a.id; this.#renderAreas(); } }
    this.#renderPalette();
  }

  // The Stores layer's own words: what a click does.
  #storeHint() {
    const st = this.world.draft?.stores.find((s) => s.id === this.selected);
    return st && !placed(st) ? `Place store · click the map where ${st.name} goes (not on water)`
      : "Place store · select a store on the map or in the list and drag it to move it; one not on the map yet goes where you click once it's selected";
  }

  // The areas and their households' make-up, for painting (from Setup's
  // "Population").
  showAreas() { this.#setLayer("areas"); this.areasCard.root.scrollIntoView({ block: "nearest" }); }

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
    return { at: Object.fromEntries(d.stores.map((s) => [s.id, placed(s) ? [s.x, s.y] : null])), areas: clone(d.macro.areas),
      parking: clone(d.macro.parking ?? []), venues: clone(d.macro.venues ?? []), venue: Object.fromEntries(d.stores.map((s) => [s.id, s.venue ?? null])) };
  }

  // Back to a kept state: stores stand where they stood (a store made since
  // keeps its place), and the areas are those there were, each with its
  // latest make-up.
  #restoreUndo(u) {
    this.world.edit((d) => {
      for (const s of d.stores) {
        if (!(s.id in u.at)) continue;
        const p = u.at[s.id];
        if (p) setPlace(s, p[0], p[1]); else unplace(s);
      }
      const now = new Map(d.macro.areas.map((a) => [a.id, a]));
      d.macro.areas = u.areas.map((a) => now.get(a.id) ?? clone(a));
      if (u.parking) { d.macro.parking = clone(u.parking); d.macro.venues = clone(u.venues); }
      if (u.venue) for (const s of d.stores) if (s.id in u.venue) { if (u.venue[s.id]) s.venue = u.venue[s.id]; else delete s.venue; }
    });
    this.#renderPalette(); this.transport.render(); this.#schedulePreview();
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
    this.areaLabels = null; this.densitySum = undefined;
    if (this.layer === "land") this.#renderPalette();
    this.#renderSide();
    this.#schedulePreview();
  }

  // The stores standing in a block of land (rows r0.., columns c0..).
  #storesIn(r0, c0, h, w) {
    const m = this.world.draft.macro;
    return this.world.draft.stores.filter((s) => {
      if (!placed(s)) return false;
      const { r, c } = tileAt(m, s.x, s.y);
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
        if (x >= 0 && y >= 0 && x < m.width * m.patch_m && y < m.height * m.patch_m) setPlace(s, x, y); else { unplace(s); off++; }
      }
    });
    if (off) this.app.banner(`${off} store${off === 1 ? "" : "s"} moved off the map`, "They're still in the world, not on the map yet: the Stores layer puts them back.");
  }

  // The draft changed in a way the preview shows: what's on screen is of an
  // older draft until the model answers for this one. One request goes to
  // R once the changes pause, never one a tile or a pointer move.
  #schedulePreview(ms = 350) {
    this.previewRev++;
    this.previewState = "waiting";
    this.#renderStates();
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.#runPreview(), ms);
  }

  async #runPreview() {
    if (!this.app.ready) { clearTimeout(this.previewTimer); this.previewTimer = setTimeout(() => this.#runPreview(), 500); return; }
    const rev = this.previewRev;
    this.readout.classList.add("busy");
    let p;
    try { p = await this.app.client.request("PREVIEW_MACRO", { text: this.world.text() }); } catch (e) { p = { problems: [{ path: "", message: e.message }] }; }
    // An answer for a draft that has changed since it was asked for is
    // dropped: the newer draft's own request is on its way.
    if (rev !== this.previewRev) return;
    this.readout.classList.remove("busy");
    this.preview = p;
    this.previewState = p.problems?.length ? "problems" : "fresh";
    this.#renderStates();
    this.#renderReadout();
    this.#renderStores();
    this.#renderAreas();
    this.transport.render();
    this.editor.draw();
  }

  // The three worlds, told apart: the draft being drawn, the model's
  // preview of it, and the world the simulation is running.
  #renderStates() {
    const d = this.world.draft; const inst = this.world.installed;
    if (!d || !this.stateBox) return;
    const n = this.world.pending;
    const chip = (kind, name, text, title) => el("span", { class: `state-chip ${kind}`, title }, el("b", { text: name }), text);
    const previews = {
      none: ["", "not worked out yet"], waiting: ["busy", "working it out for this draft…"],
      fresh: ["ok", "worked out by the model for this draft"], problems: ["bad", "can't be worked out until the map's problems are fixed"],
    }[this.previewState];
    this.stateBox.replaceChildren(
      chip(n ? "draft warn" : "draft", "Draft", n ? `${n} change${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""} for Setup` : "same as the installed world",
        "The world being drawn here. It's kept in the browser, and changes nothing in the simulation until Setup."),
      chip(`preview ${previews[0]}`, "Preview", previews[1], "The numbers below: the model places this draft's households and routes their trips the way Setup would."),
      chip("installed", "Installed", inst ? `${inst.name}: what the simulation runs${n ? " until Setup" : ""}` : "none yet",
        "The world installed at the last Setup. Go runs it, whatever is drawn here, until Setup installs the draft."));
  }

  #renderReadout() {
    const p = this.preview; const d = this.world.draft;
    if (!p) { this.readout.replaceChildren(); return; }
    const needs = geographyNeeds(d);
    const waiting = needs.unplaced ? el("div", { class: "needs" }, el("b", { text: `${needs.unplaced} store${needs.unplaced === 1 ? " isn't" : "s aren't"} on the map yet.` }),
      " Setup starts a world only when every store is on the map. ",
      el("button", { type: "button", class: "btn small", text: "Place them", onclick: () => this.placeStore(d.stores.find((s) => !placed(s)).id) })) : null;
    if (p.problems?.length) {
      fill(this.readout, el("div", { class: "problems" }, el("b", { text: "Before this map can run:" }),
        ...p.problems.map((q) => el("button", { type: "button", class: "problem", text: `${q.path ? `${q.path}: ` : ""}${q.message}`, onclick: () => { this.editor.setHighlights(q.tiles ?? []); this.editor.reveal(q.tiles); } }))), waiting);
      return;
    }
    const stranded = p.stranded;
    const outside = p.tiles ? p.households - d.macro.areas.reduce((acc, a) => acc + this.#areaCount(a), 0) : null;
    fill(this.readout,
      el("div", { class: "stat" }, el("div", { class: "stat-label", text: "Households" }), el("div", { class: "stat-value", text: fmt.int(p.households) }),
        d.macro.areas.length && outside !== null ? el("div", { class: "stat-sub", text: `${fmt.int(p.households - outside)} in areas, ${fmt.int(outside)} outside` }) : null),
      el("div", { class: `stat${stranded ? " warn" : ""}` }, el("div", { class: "stat-label", text: "No store in reach" }),
        el("div", { class: "stat-value", text: fmt.int(stranded) }), el("div", { class: "stat-sub", text: stranded ? "their homes are outlined in red" : "every household can shop" })),
      el("div", { class: `stat${p.warnings?.length ? " warn" : ""}` }, el("div", { class: "stat-label", text: "Getting there" }),
        el("div", { class: "stat-value", text: p.warnings?.length ? `${p.warnings.length} warning${p.warnings.length === 1 ? "" : "s"}` : "all reachable" }),
        el("div", { class: "stat-sub" }, `${fmt.compact(p.by_car ?? 0)} trips by car, ${fmt.compact(p.on_foot ?? 0)} on foot in reach · `,
          el("button", { type: "button", class: "linkish", text: "Parking & venues", onclick: () => this.#setLayer("transport") }))),
      el("div", { class: `stat${needs.unplaced ? " warn" : ""}` }, el("div", { class: "stat-label", text: "Stores on the map" }), el("div", { class: "stat-value", text: `${d.stores.length - needs.unplaced} of ${d.stores.length}` })),
      waiting,
      el("p", { class: "note", text: "Worked out as Setup would: households placed on home tiles by density, each store's reach by each household's cheapest way there (driving the roads to parking you've built and walking on, or walking all the way) and its segment's radius (before loyalty stretches it)." }));
  }

  #hover(cell) {
    if (!cell) { this.hoverText.textContent = ""; return; }
    const d = this.world.draft; const m = d.macro;
    const ch = this.editor.at(0, cell.r, cell.c); const ak = this.editor.at(1, cell.r, cell.c);
    const land = this.#materialName(ch, 0);
    const area = m.areas.find((a) => a.key === ak)?.name ?? "no area";
    const km = (v) => (v * m.patch_m / 1000).toFixed(v * m.patch_m >= 10000 ? 0 : 2);
    let extra = "";
    const t = this.preview?.tiles;
    if (t && this.previewState === "fresh") {
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
    // The preview's tiles are of the draft it was worked out for: while a
    // newer draft waits for its own, they aren't drawn over it.
    if (p && this.previewState === "fresh" && (this.overlay || this.preview.stranded)) {
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
    this.transport.draw(ctx, ed);                // the parking and malls, on every layer
    const font = cssVar("--font", ed.wrap) || "system-ui"; const ink = cssVar("--ink", ed.wrap); const surface = cssVar("--surface", ed.wrap);
    const text = (s, x, y) => { ctx.lineWidth = 3; ctx.strokeStyle = surface; ctx.strokeText(s, x, y); ctx.fillStyle = ink; ctx.fillText(s, x, y); };
    // Stores: a pin in the brand's colour, its point where the store
    // stands; the selected one ringed, and named once there's room (or
    // it's the one selected or pointed at). A block of land being moved
    // carries its stores. On the Areas layer the pins are faint, under
    // the areas' names.
    const m = d.macro;
    const size = this.layer === "stores" ? 18 : 14;
    const b0 = ed.lifted && ed.active === 0 && !ed.lifted.copy ? ed.lifted : null;
    const carried = new Set(b0 ? this.#storesIn(b0.r0, b0.c0, b0.h, b0.w) : []);
    ctx.font = `600 11px ${font}`;
    const named = [];
    if (this.layer === "areas") ctx.globalAlpha = 0.45;
    for (const st of d.stores) {
      if (!placed(st)) continue;
      const b = d.brands.find((x) => x.id === st.brand);
      const shift = carried.has(st) ? [b0.r - b0.r0, b0.c - b0.c0] : [0, 0];
      const c = st.x / m.patch_m + shift[1]; const r = m.height - st.y / m.patch_m + shift[0];
      const x = ed.ox + c * z; const y = ed.oy + r * z;
      const on = st.id === this.selected; const over = st.id === this.hoverStore;
      pin(ctx, x, y, on || over ? size + 4 : size, b?.colour ?? "#888", on ? ink : "#fff", on ? 2.5 : 1.5);
      if (on || over || (this.layer !== "areas" && z >= 8)) named.push([st.short, x + size / 2 + 5, y - size * 0.6]);
    }
    ctx.globalAlpha = 1;
    for (const [s, x, y] of named) text(s, x, y);
    // On the Areas layer, each area's name where it lies, the one being painted in bold.
    if (this.layer === "areas") {
      ctx.textAlign = "center";
      for (const a of this.#areaLabels()) {
        const q = ed.toScreen(a.r, a.c);
        ctx.font = `${a.id === this.area ? 700 : 500} ${a.id === this.area ? 13 : 12}px ${font}`;
        text(a.name, q.x, q.y);
      }
      ctx.textAlign = "start";
    }
  }

  // Where to write each area's name: the middle of its tiles.
  #areaLabels() {
    if (this.areaLabels) return this.areaLabels;
    const ed = this.editor; const data = ed.layers[1].data;
    const sums = new Map();
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 46) continue;
      let s = sums.get(data[i]); if (!s) { s = [0, 0, 0]; sums.set(data[i], s); }
      s[0] += Math.floor(i / ed.W); s[1] += i % ed.W; s[2]++;
    }
    this.areaLabels = (this.world.draft?.macro.areas ?? []).flatMap((a) => {
      const s = sums.get(a.key.charCodeAt(0));
      return s ? [{ id: a.id, name: a.name, r: s[0] / s[2] + 0.5, c: s[1] / s[2] + 0.5 }] : [];
    });
    return this.areaLabels;
  }

  // ---- Stores on the map ------------------------------------------------------------------------

  // The store whose pin is under the pointer (a finger gets more room).
  #storeAt(ev) {
    const d = this.world.draft; const ed = this.editor; const m = d.macro;
    const rect = ed.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left; const y = ev.clientY - rect.top;
    const reach = ev.pointerType === "touch" ? 26 : 15;
    let best = null; let bd = reach * reach;
    for (const st of d.stores) {
      if (!placed(st)) continue;
      const sx = ed.ox + (st.x / m.patch_m) * ed.zoom; const sy = ed.oy + (m.height - st.y / m.patch_m) * ed.zoom - 9;
      const dd = (sx - x) ** 2 + (sy - y) ** 2;
      if (dd < bd) { bd = dd; best = st; }
    }
    return best;
  }

  #storeDown(ev, cell) {
    if (this.layer === "transport" && ev.button === 0) return this.transport.down(ev, cell);
    if (this.layer !== "stores" || ev.button !== 0) return false;
    const d = this.world.draft; const m = d.macro;
    // The selected store isn't on the map yet: it goes where the click is,
    // and the next one waiting is selected.
    const waiting = d.stores.find((s) => s.id === this.selected && !placed(s));
    if (waiting) {
      if (!this.editor.inside(cell.r, cell.c)) return true;
      if (this.editor.at(0, cell.r, cell.c) === "~") { this.app.banner("Not on water", "A store has to stand on land."); return true; }
      this.editor.record();
      this.world.edit(() => { const p = tileCentre(m, cell.r, cell.c); setPlace(waiting, p.x, p.y); });
      const next = d.stores.find((s) => !placed(s));
      if (next) this.selected = next.id;
      this.#renderPalette(); this.#renderSide(); this.editor.draw(); this.#schedulePreview();
      return true;
    }
    const st = this.#storeAt(ev);
    if (!st) { if (this.selected) { this.selected = null; this.#renderPalette(); this.#renderSide(); this.editor.draw(); } return false; }
    this.selected = st.id;
    this.moving = { id: st.id, snap: this.#undoState(), moved: false };
    this.#renderPalette(); this.#renderSide(); this.editor.draw();
    return true;
  }

  #storeMove(ev, cell) {
    if (!this.moving) {
      // Over a pin on the Stores layer: it can be picked up.
      if (this.layer === "stores" && ev.pointerType !== "touch") {
        const over = this.#storeAt(ev)?.id ?? null;
        if (over !== this.hoverStore) { this.hoverStore = over; this.editor.canvas.style.cursor = over ? "pointer" : "grab"; this.editor.draw(); }
      } else if (this.hoverStore) { this.hoverStore = null; this.editor.draw(); }
      return false;
    }
    const d = this.world.draft; const m = d.macro;
    if (!this.editor.inside(cell.r, cell.c) || this.editor.at(0, cell.r, cell.c) === "~") return true;      // not off the map, not onto water
    const st = d.stores.find((s) => s.id === this.moving.id);
    const { x, y } = tileCentre(m, cell.r, cell.c);
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

  // The drag was taken away before it was let go: the store goes back to
  // where it was picked up.
  #storeCancel() {
    if (!this.moving) return;
    const mv = this.moving; this.moving = null;
    const st = this.world.draft.stores.find((s) => s.id === mv.id);
    const at = mv.snap.at[mv.id];
    if (st && at) { st.x = at[0]; st.y = at[1]; }
    this.editor.draw();
  }

  // ---- Beside the map ---------------------------------------------------------------------------

  #renderSide() {
    this.#renderStart();
    this.#renderLegend();
    this.#renderStores();
    this.#renderStore();
    this.#renderAreas();
    this.#renderSettings();
    this.transport.render();
    if (!this.side.children.length) this.#orderSide();
  }

  // What the layer edits comes first beside the map.
  #orderSide() {
    const tc = this.transport;
    const first = { land: [this.legendCard, this.startCard], areas: [this.areasCard], stores: [this.storeCard, this.storesCard],
      transport: [tc.accessCard, tc.parkingCard, tc.venuesCard, tc.planCard] }[this.layer];
    const all = [this.startCard, this.legendCard, tc.accessCard, tc.parkingCard, tc.venuesCard, tc.planCard, this.storeCard, this.storesCard, this.areasCard, this.settingsCard];
    const order = [...first, ...all.filter((c) => !first.includes(c))].map((c) => c.root);
    if (order.some((n, i) => this.side.children[i] !== n)) this.side.replaceChildren(...order);
  }

  // What each kind of tile does in the model, and which are looks only.
  #renderLegend() {
    const m = this.world.draft.macro;
    const row = (colour, name, text) => el("div", { class: "legend-row" }, el("i", { class: "legend-swatch square", vars: { "--c": colour } }), el("b", { text: name }), el("span", { text }));
    const who = (t) => row(this.#landColour(t.ch), t.label, t.does(m));
    this.legendCard.body.replaceChildren(
      el("p", { class: "note", text: "Cars and people move on separate networks read from these tiles: every tile says who can cross it. Areas never change that." }),
      el("h3", { class: "setup-heading", text: "Ground" }), ...LAND.filter((t) => t.group === "ground").map(who),
      el("h3", { class: "setup-heading", text: "For cars" }), ...LAND.filter((t) => t.group === "cars").map(who),
      el("h3", { class: "setup-heading", text: "For people" }), ...LAND.filter((t) => t.group === "people").map(who),
      el("h3", { class: "setup-heading", text: "Parking and malls" }), ...LAND.filter((t) => t.group === "parking").map(who),
      el("h3", { class: "setup-heading", text: "Homes" }), who(LAND.find((t) => t.density === 5)),
      row("linear-gradient(135deg, #e8c9a8, #b9d5ea)", "Areas", "their own layer: who lives there (segments, sizes, budget). Painting an area over water or woodland changes nothing about crossing it."),
      el("div", { class: "legend-row" }, pinIcon(), el("b", { text: "Stores" }), el("span", { text: "pins: each store's door. Shoppers drive to parking and walk to it, or walk from home, within their segment's radius" })));
  }

  // Stores, by brand, with how many households have each in reach.
  #renderStores() {
    const d = this.world.draft;
    const reach = this.previewState === "fresh" ? this.preview?.reach : null;
    const body = el("div", { class: "store-list" });
    for (const b of d.brands) {
      const mine = d.stores.map((s, i) => ({ s, i })).filter((x) => x.s.brand === b.id);
      body.append(el("div", { class: "store-group", vars: { "--brand": b.colour } }, el("div", { class: "brand-name" }, el("i", { class: "dot" }), b.name, el("span", { class: "sub", text: ` · ${mine.length} store${mine.length === 1 ? "" : "s"}` })),
        ...mine.map(({ s, i }) => el("button", { type: "button", class: `store-row${s.id === this.selected ? " is-on" : ""}`, onclick: () => this.placeStore(s.id) },
          el("span", { text: s.name }),
          placed(s) ? el("span", { class: "sub", text: reach ? `${fmt.compact(reach[i])} in reach` : "" })
            : el("span", { class: "sub bad", text: "not on the map" })))));
    }
    const waiting = d.stores.filter((s) => !placed(s)).length;
    this.storesCard.body.replaceChildren(body);
    this.storesCard.setSub(`${d.stores.length} stores${waiting ? ` · ${waiting} not on the map yet` : ""} · households with each in reach`);
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
    const at = placed(st) ? tileAt(d.macro, st.x, st.y) : null;
    const area = at ? d.macro.areas.find((a) => a.key === d.macro.area_tiles?.[at.r]?.[at.c]) : null;
    this.storeCard.body.replaceChildren(
      el("p", { class: `note${placed(st) ? "" : " bad"}`, text: placed(st) ? `Stands ${area ? `in ${area.name}` : "outside every area"}. Drag its pin on the map to move it.` : "Not on the map yet: click the map where it goes." }),
      el("div", { class: "row wrap" },
        el("button", { type: "button", class: "btn small", text: "Draw its floor plan", title: `Open the ${L?.name ?? st.layout} layout in the Micro world`, onclick: () => this.onOpenLayout?.(st.layout) }),
        el("button", { type: "button", class: "btn small", text: "Its name, brand, layout and staff", title: "Open the store in the Micro world", onclick: () => this.onEditStore?.(st.id) })));
  }

  // Households living on an area's tiles, from the model's preview.
  #areaCount(a) {
    const t = this.preview?.tiles; if (!t) return 0;
    let n = 0;
    t.row.forEach((r, i) => { if (this.editor.at(1, r, t.col[i]) === a.key) n += t.households[i]; });
    return n;
  }

  // Areas and the make-up of their households: the one being painted (or
  // picked in the list) has its households, budget, segments and sizes
  // under its name and colour.
  #renderAreas() {
    const d = this.world.draft; const schema = this.world.schema; if (!schema) return;
    const held = document.activeElement;
    if (held && this.areasCard.root.contains(held) && held.type === "range") return;       // a slider in hand keeps its place
    const m = d.macro;
    if (!m.areas.some((a) => a.id === this.area)) this.area = m.areas[0]?.id ?? "__default";
    const fresh = this.previewState === "fresh" && this.preview?.tiles;
    const count = (a) => (fresh ? `${fmt.compact(this.#areaCount(a))} households` : "");
    const select = (a) => { this.area = a.id; this.#setLayer("areas"); this.editor.setPaint(a.key); this.#renderPalette(); this.#renderAreas(); };
    const list = el("div", { class: "area-list" }, ...m.areas.map((a) => el("div", { class: `area-row${a.id === this.area ? " is-on" : ""}`, vars: { "--area": a.colour } },
      colourField({ label: `Colour of ${a.name}`, value: a.colour, onChange: (v) => { this.world.edit(() => { a.colour = v; }); this.editor.refreshColours(); this.#renderPalette(); this.#renderAreas(); } }).root,
      el("button", { type: "button", class: "linkish", text: a.name, title: `Paint ${a.name} and set who lives there`, onclick: () => select(a) }),
      el("span", { class: "sub", text: count(a) }),
      el("button", { type: "button", class: "icon-btn", "aria-label": `Delete ${a.name}`, title: `Delete ${a.name} (its tiles become no area)`, text: "×", onclick: () => this.#deleteArea(a) }))),
    el("div", { class: `area-row${this.area === "__default" ? " is-on" : ""}` }, el("i", { class: "legend-swatch square", vars: { "--c": "transparent" } }),
      el("button", { type: "button", class: "linkish", text: "Outside every area", onclick: () => { this.area = "__default"; this.#renderAreas(); } }),
      el("span", { class: "sub", text: fresh ? `${fmt.compact(this.preview.households - m.areas.reduce((acc, a) => acc + this.#areaCount(a), 0))} households` : "" }), el("span")));
    const add = el("button", { type: "button", class: "btn small", text: "Add area", disabled: m.areas.length >= (schema.limits.areas ?? 40) || null, onclick: () => this.#addArea() });
    const a = m.areas.find((x) => x.id === this.area);
    const mk = a ?? m.default_makeup;
    const nameField = a ? textField({ label: "Name", value: a.name, onChange: (v) => { this.world.edit(() => { a.name = v; }); this.areaLabels = null; this.#renderAreas(); this.#renderPalette(); this.editor.draw(); } }) : null;
    const budget = settingLever(schema.fields.area.budget, { value: mk.budget, onChange: (v) => this.world.edit(() => { mk.budget = v; }) });
    const mixBlock = (what, keys, labels) => {
      const total = el("span", { class: "sub" });
      const showTotal = () => { const s = keys.reduce((acc, k) => acc + (mk[what][k] ?? 0), 0); total.textContent = `adds up to ${fmt.pct(s, 1)}`; total.classList.toggle("bad", Math.abs(s - 1) > 0.005); };
      showTotal();
      return el("div", {}, el("h3", { class: "setup-heading" }, what === "segment_mix" ? "Segments " : "Sizes ", total),
        el("div", { class: "settings-grid compact" }, ...keys.map((k, i) => settingLever({ label: labels[i], min: 0, max: 1, step: 0.01, format: "pct" }, {
          value: mk[what][k] ?? 0, onChange: (v) => { this.world.edit(() => { mk[what][k] = v; }); showTotal(); } }).root)));
    };
    const who = a ? count(a) : "";
    this.areasCard.body.replaceChildren(list, el("div", { class: "row" }, add),
      el("div", { class: "area-detail", vars: { "--area": a?.colour ?? "transparent" } },
        el("div", { class: "area-head" }, el("h3", { text: a ? a.name : "Households outside every area" }), who ? el("span", { class: "sub", text: who }) : null),
        el("p", { class: "note", text: a ? "The households living on this area's tiles: their budget, and the shares of each segment and size. Paint the area on the map with the Areas layer." : "The make-up of the households living outside every painted area." }),
        nameField?.root, budget.root,
        mixBlock("segment_mix", d.segments.map((s) => s.id), d.segments.map((s) => s.name)),
        mixBlock("size_mix", schema.sizes, schema.sizes)));
    this.areaName = nameField;
  }

  // A new area: named, coloured, with the make-up of the area it was made
  // beside (or the map's default), ready to paint with a brush big enough
  // for a neighbourhood.
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
    this.#setLayer("areas"); this.editor.setPaint(key);
    if (this.editor.brush === 1) this.editor.setBrush(7);
    if (!["pencil", "fill", "rect"].includes(this.editor.tool)) this.editor.setTool("pencil");
    this.#renderPalette(); this.#renderAreas();
    this.areaName?.input.select?.();
  }

  #deleteArea(a) {
    const d = this.world.draft; const m = d.macro;
    this.editor.record();
    const rows = this.editor.rows(1).map((row) => row.split(a.key).join("."));
    this.world.edit(() => { m.areas = m.areas.filter((x) => x.id !== a.id); m.area_tiles = rows; });
    this.editor.load([m.tiles, rows], { keepView: true });
    this.loadedKey = null; this.areaLabels = null;
    this.#renderPalette(); this.#renderAreas(); this.#schedulePreview();
  }

  // ---- Starting geographies ----------------------------------------------------------------------

  // A geography to start from: the map only. Picking one says what it will
  // replace and what it leaves, and asks first.
  #renderStart() {
    const d = this.world.draft; if (!d) return;
    if (!this.geographies) { this.startCard.body.replaceChildren(el("p", { class: "note", text: "Loading the starting geographies…" })); return; }
    const m = d.macro;
    const buttons = this.geographies.map((g) => el("button", { type: "button", class: `geo-btn${this.asking?.id === g.id ? " is-on" : ""}`, title: g.about, dataset: { geography: g.id },
      onclick: () => { this.asking = this.asking?.id === g.id ? null : g; this.#renderStart(); } },
    geographyThumb(g, (ch) => this.#landColour(ch)), el("b", { text: g.name }), el("span", { class: "sub", text: g.blank ? `${m.width} × ${m.height} tiles` : `${g.width} × ${g.height} tiles` })));
    let ask = null;
    if (this.asking) {
      const g = this.asking;
      const W = g.blank ? m.width : g.width; const H = g.blank ? m.height : g.height;
      const sites = g.sites?.length ?? 0;
      const km = (n) => fmt.num1(n * m.patch_m / 1000);
      ask = el("div", { class: "confirm" },
        el("p", {}, el("b", { text: `Replace the map with ${g.name}?` }), ` ${g.about}`),
        el("ul", { class: "plain" },
          el("li", { text: `The map's tiles are replaced: ${W} × ${H} tiles, ${km(W)} × ${km(H)} km at this map's ${fmt.int(m.patch_m)} m a tile.` }),
          el("li", { text: g.blank ? "Every area's tiles are cleared. The areas themselves, and the households set for them, are kept."
            : `Your ${m.areas.length} area${m.areas.length === 1 ? " is" : "s are"} kept, with the households set for ${m.areas.length === 1 ? "it" : "them"}, and repainted onto its ${g.areas.length} district${g.areas.length === 1 ? "" : "s"}${g.areas.length > m.areas.length ? ` (${g.areas.length - m.areas.length} new, with the default make-up)` : ""}.` }),
          el("li", { text: sites ? `Your ${d.stores.length} stores go to its ${sites} store sites${d.stores.length > sites ? `; ${d.stores.length - sites} wait on the Stores layer` : ""}.`
            : `Your ${d.stores.length} stores come off the map and wait on the Stores layer: it can't run until homes are painted and the stores are placed.` }),
          el("li", { text: "Nothing else changes: brands, ranges, shoppers, offers, layouts, map settings and the season stay as they are. Undo brings this map back." })),
        el("div", { class: "row" },
          el("button", { type: "button", class: "btn small primary", text: "Replace the map", onclick: () => this.#startFrom(g) }),
          el("button", { type: "button", class: "btn small", text: "Keep this map", onclick: () => { this.asking = null; this.#renderStart(); } })));
    }
    fill(this.startCard.body, el("div", { class: "geo-list" }, ...buttons), ask,
      this.asking ? null : el("p", { class: "note", text: "Each replaces the map's tiles and keeps the rest of the world. You're asked first, and Undo brings the old map back." }));
  }

  #startFrom(g) {
    this.editor.record();
    let out;
    this.world.edit((d) => { out = applyGeography(d, g); }, { source: "map" });
    const m = this.world.draft.macro;
    this.editor.load([m.tiles, m.area_tiles]);
    this.loadedKey = JSON.stringify([m.width, m.height, m.tiles, m.area_tiles]); this.loadedSize = `${m.width}x${m.height}`;
    this.areaLabels = null; this.densitySum = undefined; this.asking = null; this.selected = null;
    this.editor.setHighlights([]);
    this.#setLayer(g.blank ? "land" : this.layer);
    this.#renderSide(); this.#schedulePreview(0);
    this.app.banner(`The map is now ${g.name}`, g.blank ? "Paint homes for the households to live on, then roads, and place the stores. Undo brings the old map back."
      : `${out.placed} store${out.placed === 1 ? "" : "s"} on its sites${out.unplaced ? `, ${out.unplaced} waiting on the Stores layer` : ""}. Everything else in the world is as it was; Undo brings the old map back.`);
  }

  // ---- Map settings ----------------------------------------------------------------------------------

  // Size and scale, households, speeds, parking, word of mouth.
  #renderSettings() {
    const d = this.world.draft; const schema = this.world.schema; if (!schema) return;
    const held = document.activeElement;
    if (held && this.settingsCard.root.contains(held) && ["range", "number"].includes(held.type)) return;      // a setting in hand keeps its place
    const m = d.macro;
    const f = schema.fields.macro;
    const setM = (k) => (v) => {
      this.world.edit(() => { m[k] = v; });
      if (k === "patch_m") this.editor.draw();
      this.#renderPalette(); this.#renderLegend();
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
      el("p", { class: "note", text: `${fmt.int(m.width)} × ${fmt.int(m.height)} tiles of ${fmt.int(m.patch_m)} m: ${fmt.num1(m.width * m.patch_m / 1000)} × ${fmt.num1(m.height * m.patch_m / 1000)} km. At most ${fmt.int(limit)} tiles. Zooming the view changes neither.` }),
      el("div", { class: "settings-grid" }, ...["patch_m", "households", "road_mps", "local_mps", "walk_mps", "wom_m"].map((k) => settingLever(f[k], { value: m[k], onChange: setM(k) }).root)));
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
        if (x >= 0 && y >= 0 && x < W * m.patch_m && y < H * m.patch_m) setPlace(s, x, y); else { unplace(s); off++; }
      }
    });
    this.loadedKey = JSON.stringify([W, H, rows[0], rows[1]]); this.loadedSize = `${W}x${H}`;
    this.areaLabels = null; this.densitySum = undefined;
    this.#renderSide(); this.#schedulePreview();
    if (off) this.app.banner(`${off} store${off === 1 ? "" : "s"} cropped off the map`, "They're still in the world, not on the map yet: the Stores layer puts them back.");
  }
}

// A store's pin: a head in the brand's colour over the point where the
// store stands. (The map's shops tiles are squares of ground.)
function pin(ctx, x, y, size, colour, edge, width) {
  const r = size / 2; const cy = y - size * 0.95;
  ctx.beginPath();
  ctx.arc(x, cy, r, Math.PI * 0.83, Math.PI * 0.17);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = colour; ctx.fill();
  ctx.lineWidth = width; ctx.strokeStyle = edge; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, cy, r * 0.36, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
}

function pinIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "12"); svg.setAttribute("height", "12"); svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"); p.setAttribute("fill", "var(--accent)");
  svg.append(p); return svg;
}

// A geography's picture, small: its tiles in the map's colours.
function geographyThumb(g, colour) {
  const W = g.width ?? 16; const H = g.height ?? 12;
  const c = el("canvas", { class: "geo-thumb", width: W, height: H, "aria-hidden": "true" });
  const ctx = c.getContext("2d");
  if (!g.tiles) { ctx.fillStyle = colour("."); ctx.fillRect(0, 0, W, H); return c; }
  const cache = new Map();
  g.tiles.forEach((row, r) => {
    for (let x = 0; x < row.length; x++) {
      let col = cache.get(row[x]); if (!col) { col = colour(row[x]); cache.set(row[x], col); }
      ctx.fillStyle = col; ctx.fillRect(x, r, 1, 1);
    }
  });
  return c;
}

function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
