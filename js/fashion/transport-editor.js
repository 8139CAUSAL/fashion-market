// The macro world's "Parking & venues" layer: the parking the end user
// builds, the shopping venues that tie stores together, a mall's plan of
// corridors and storefronts, and what the model says can't be reached.
//
// Nothing here is made for the user: a lot or a garage is the block of P
// or G tiles they painted, made a facility with a click, its spaces,
// entrances and exits theirs to set; kerb spaces are clicked onto a street
// one at a time. Everything lives in the draft (macro.parking,
// macro.venues and each store's venue) and is read by the model (model/
// transport.R): the preview's warnings, the facility's households and the
// trip tool come from the same calculations Setup will make.

import { el, fmt, card, textField, numberField, checkbox, segmented, cssVar } from "./ui.js";
import { GridEditor, toolbar } from "./grid-editor.js";
import { clone, newId, newName, placed, tileAt } from "./world-store.js";

const KINDS = { lot: "Surface lot", garage: "Parking garage", kerb: "Kerb spaces" };
const VENUE_KINDS = { mall: "Enclosed mall", strip: "Strip mall", district: "Shopping district" };
const M2_PER_SPACE = 25; const KERB_M_PER_SPACE = 6;          // as model/transport.R bounds them
const STOREFRONTS = "abcdefghijklmnopqrstuvwxyz";

export function maxSpaces(kind, tiles, levels, patch) {
  return kind === "kerb" ? tiles * 2 * Math.floor(patch / KERB_M_PER_SPACE) : Math.floor(tiles * patch * patch * levels / M2_PER_SPACE);
}

// The tiles of a block of `ch` around (r, c), sharing sides, not in `taken`.
export function blockOf(rows, r, c, ch, taken = new Set()) {
  const H = rows.length; const W = rows[0].length; const out = []; const seen = new Set([`${r},${c}`]); const todo = [[r, c]];
  while (todo.length) {
    const [rr, cc] = todo.pop();
    if (rows[rr][cc] !== ch || taken.has(`${rr},${cc}`)) continue;
    out.push([rr, cc]);
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const r2 = rr + dr; const c2 = cc + dc; const k = `${r2},${c2}`;
      if (r2 >= 0 && c2 >= 0 && r2 < H && c2 < W && !seen.has(k)) { seen.add(k); todo.push([r2, c2]); }
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// A default plan for a mall of h x w tiles at k cells a tile: walls, a
// cross of corridors, an entrance in the middle of each side, and a
// storefront for each store off the corridors (a, b, ...).
export function defaultPlan(h, w, k, n) {
  const H = h * k; const W = w * k;
  const P = Array.from({ length: H }, () => Array(W).fill("#"));
  const rm = Math.floor(H / 2); const cm = Math.floor(W / 2);
  for (let r = 0; r < H; r++) for (let c = cm - 1; c <= cm + 1; c++) if (c >= 0 && c < W) P[r][c] = ".";
  for (let c = 0; c < W; c++) for (let r = rm - 1; r <= rm + 1; r++) if (r >= 0 && r < H) P[r][c] = ".";
  for (let c = cm - 1; c <= cm + 1; c++) { P[0][c] = "E"; P[H - 1][c] = "E"; }
  for (let r = rm - 1; r <= rm + 1; r++) { P[r][0] = "E"; P[r][W - 1] = "E"; }
  // Storefronts along the corridors' sides, spread out.
  const spots = [];
  for (let c = 2; c < W - 2; c += 4) { if (Math.abs(c - cm) > 2) { spots.push([rm - 2, c]); spots.push([rm + 2, c]); } }
  for (let r = 2; r < H - 2; r += 4) { if (Math.abs(r - rm) > 2) { spots.push([r, cm - 2]); spots.push([r, cm + 2]); } }
  for (let i = 0; i < Math.min(n, spots.length); i++) { const [r, c] = spots[i]; if (r >= 0 && c >= 0 && r < H && c < W) P[r][c] = STOREFRONTS[i]; }
  return P.map((r) => r.join(""));
}

export class TransportTools {
  constructor(host) {
    this.host = host;                           // the MapEditor
    this.mode = "select"; this.fac = null; this.venue = null; this.trip = null; this.tripAt = null;
    this.parkingCard = card("Parking", { sub: "built by you · wait for Setup" });
    this.venuesCard = card("Shopping venues", { sub: "malls, strip malls, districts" });
    this.accessCard = card("Getting there", { sub: "what the model can't reach" });
    this.planCard = card("The mall's plan", { sub: "" });
    this.planCard.root.hidden = true;
    this.plan = null;
  }

  get draft() { return this.host.world.draft; }
  get m() { return this.draft.macro; }
  edit(fn) { this.host.editor.record(); this.host.world.edit(fn); this.host.afterTransportEdit(); }

  // ---- The palette: what a click on the map does -----------------------------------------------

  palette() {
    const modes = [
      ["select", "Select", "Click a facility or a venue on the map to edit it"],
      ["lot", "Make a lot or garage", "Click a block of painted parking lot (P) or garage (G) tiles: it becomes a facility with the spaces it can hold, for you to set"],
      ["kerb", "Kerb space", "Click a street or driveway tile to mark one more parking space on its kerb (Shift-click takes one away)"],
      ["vehicle", "Vehicle entrance", "Click a tile of the selected facility, beside a street, to let cars in and out there (again to remove)"],
      ["pedestrian", "Pedestrian exit", "Click a tile of the selected facility where people leave it on foot (again to remove)"],
      ["mall", "Mall building", "Click a block of mall (m) tiles: it becomes the selected mall's building"],
      ["trip", "Trip from a home", "Click a home tile: the model's way from there to the selected store, by car and on foot"],
    ];
    const f = this.selectedFac();
    const v = this.selectedVenue();
    const btns = modes.map(([id, label, title]) => el("button", {
      type: "button", class: `chip-btn${this.mode === id ? " is-on" : ""}`, title, "aria-pressed": String(this.mode === id),
      disabled: ((id === "vehicle" || id === "pedestrian") && !f) || (id === "mall" && !(v && v.kind === "mall")) || null,
      onclick: () => { this.mode = id; this.host.renderPalette(); this.host.editor.draw(); },
    }, label));
    const note = {
      select: "Select a facility or a venue on the map, or in the lists beside it. Paint P (lot), G (garage) or m (mall) on the Land layer first.",
      lot: "Click a block of P or G tiles. Nothing parks on painted tiles until they are made a facility here.",
      kerb: "Click a street or driveway tile: one space more on its kerb. A road is for driving; only the spaces you mark here are for parking.",
      vehicle: f ? `${f.name}: click its tiles beside a street (or a driveway) to make them vehicle entrances. Cars reach it only there.` : "",
      pedestrian: f ? `${f.name}: click its tiles where people leave it on foot.` : "",
      mall: v ? `${v.name}: click a rectangle of m tiles for its building; then draw its plan beside the map.` : "",
      trip: "Click a home tile: the trip to the selected store (pick one on the Stores layer) as the model would make it.",
    }[this.mode];
    return { nodes: [el("div", { class: "palette-group" }, el("div", { class: "palette-title", text: "Click the map to" }), el("div", { class: "palette-row" }, ...btns))], note };
  }

  // ---- Clicks on the map -------------------------------------------------------------------------

  down(ev, cell) {
    const ed = this.host.editor;
    if (!ed.inside(cell.r, cell.c)) return true;
    const ch = ed.at(0, cell.r, cell.c);
    const key = `${cell.r},${cell.c}`;
    const m = this.m;
    switch (this.mode) {
      case "select": {
        const f = m.parking.findIndex((x) => x.tiles.some(([r, c]) => r === cell.r && c === cell.c));
        const v = m.venues.findIndex((x) => (x.tiles ?? []).some(([r, c]) => r === cell.r && c === cell.c) ||
          x.stores.some((id) => { const s = this.draft.stores.find((y) => y.id === id); if (!s || !placed(s)) return false; const t = tileAt(m, s.x, s.y); return t.r === cell.r && t.c === cell.c; }));
        this.fac = f >= 0 ? m.parking[f].id : null;
        if (v >= 0) this.venue = m.venues[v].id;
        this.host.renderPalette(); this.render(); ed.draw();
        return true;
      }
      case "lot": {
        if (ch !== "P" && ch !== "G") { this.host.app.banner("Not a parking tile", "Paint a block of P (surface lot) or G (garage) on the Land layer, then click it here."); return true; }
        const taken = new Set(m.parking.filter((x) => x.kind !== "kerb").flatMap((x) => x.tiles.map(([r, c]) => `${r},${c}`)));
        if (taken.has(key)) { this.fac = m.parking.find((x) => x.tiles.some(([r, c]) => `${r},${c}` === key)).id; this.mode = "vehicle"; this.host.renderPalette(); this.render(); ed.draw(); return true; }
        const tiles = blockOf(ed.rows(0), cell.r, cell.c, ch, taken);
        const kind = ch === "P" ? "lot" : "garage";
        const levels = kind === "garage" ? 3 : 1;
        const name = newName(m.parking, KINDS[kind]);
        const id = newId(m.parking, name);
        this.edit((d) => d.macro.parking.push({ id, name, kind, tiles, levels, spaces: maxSpaces(kind, tiles.length, levels, d.macro.patch_m),
          vehicle_access: [], pedestrian_access: [], search_s: kind === "garage" ? 45 : 60, level_s: kind === "garage" ? 30 : 0, transfer_s: kind === "garage" ? 75 : 20 }));
        this.fac = id; this.mode = "vehicle";
        this.host.app.banner(`${name}: ${tiles.length} tiles`, "Now click its tiles beside a street for its vehicle entrances, then where people leave it on foot. Its spaces are set to what it can hold: change them beside the map.");
        this.host.renderPalette(); this.render();
        return true;
      }
      case "kerb": {
        if (ch !== "=" && ch !== "d") { this.host.app.banner("Not a street", "A kerb space is marked along a street (=) or a driveway (d)."); return true; }
        const k = m.parking.findIndex((x) => x.kind === "kerb" && x.tiles.some(([r, c]) => r === cell.r && c === cell.c));
        const most = maxSpaces("kerb", 1, 1, m.patch_m);
        if (ev.shiftKey) {
          if (k < 0) return true;
          this.edit((d) => { const f = d.macro.parking[k]; if (f.spaces > 1) f.spaces--; else this.#removeFacility(d, f.id); });
        } else if (k >= 0) {
          const f = m.parking[k];
          if (f.spaces >= maxSpaces("kerb", f.tiles.length, 1, m.patch_m)) { this.host.app.banner("This kerb is full", `A street tile's two kerbs hold at most ${most} spaces (${KERB_M_PER_SPACE} m each).`); return true; }
          this.edit((d) => { d.macro.parking[k].spaces++; });
          this.fac = f.id;
        } else {
          const name = newName(m.parking, "Kerb spaces"); const id = newId(m.parking, name);
          this.edit((d) => d.macro.parking.push({ id, name, kind: "kerb", tiles: [[cell.r, cell.c]], levels: 1, spaces: 1,
            vehicle_access: [[cell.r, cell.c]], pedestrian_access: [[cell.r, cell.c]], search_s: 90, level_s: 0, transfer_s: 0 }));
          this.fac = id;
        }
        this.render(); ed.draw();
        return true;
      }
      case "vehicle": case "pedestrian": {
        const f = this.selectedFac(); if (!f) return true;
        if (!f.tiles.some(([r, c]) => r === cell.r && c === cell.c)) { this.host.app.banner("Not one of its tiles", `An entrance or exit is one of ${f.name}'s own tiles.`); return true; }
        const side = this.mode === "vehicle" ? "vehicle_access" : "pedestrian_access";
        this.edit((d) => {
          const g = d.macro.parking.find((x) => x.id === f.id);
          const i = g[side].findIndex(([r, c]) => r === cell.r && c === cell.c);
          if (i >= 0) g[side].splice(i, 1); else { g[side].push([cell.r, cell.c]); g[side].sort((a, b) => a[0] - b[0] || a[1] - b[1]); }
        });
        this.render(); ed.draw();
        return true;
      }
      case "mall": {
        const v = this.selectedVenue(); if (!v || v.kind !== "mall") return true;
        if (ch !== "m") { this.host.app.banner("Not a mall tile", "Paint the mall's building with mall (m) tiles on the Land layer, then click it here."); return true; }
        const tiles = blockOf(ed.rows(0), cell.r, cell.c, "m");
        this.edit((d) => { const g = d.macro.venues.find((x) => x.id === v.id); g.tiles = tiles; g.plan = this.#freshPlan(g, tiles, d); });
        this.render(); ed.draw();
        return true;
      }
      case "trip": { this.#trip(cell); return true; }
      default: return false;
    }
  }

  #removeFacility(d, id) {
    d.macro.parking = d.macro.parking.filter((x) => x.id !== id);
    for (const v of d.macro.venues) v.parking = v.parking.filter((x) => x !== id);
    if (this.fac === id) this.fac = null;
  }

  #freshPlan(v, tiles, d) {
    const rs = tiles.map(([r]) => r); const cs = tiles.map(([, c]) => c);
    const h = Math.max(...rs) - Math.min(...rs) + 1; const w = Math.max(...cs) - Math.min(...cs) + 1;
    const cell = v.plan?.cell_m ?? Math.max(1, Math.round(d.macro.patch_m / 10));
    const k = Math.max(1, Math.round(d.macro.patch_m / cell));
    const rows = defaultPlan(h, w, k, v.stores.length);
    v.storefronts = Object.fromEntries(v.stores.slice(0, 26).map((id, i) => [STOREFRONTS[i], id]).filter(([L]) => rows.some((r) => r.includes(L))));
    return { cell_m: d.macro.patch_m / k, rows };
  }

  async #trip(cell) {
    const ed = this.host.editor;
    const st = this.draft.stores.find((s) => s.id === this.host.selected && placed(s)) ?? this.draft.stores.find(placed);
    if (!st) return;
    const ch = ed.at(0, cell.r, cell.c);
    if (!/[1-9]/.test(ch)) { this.host.app.banner("Not a home", "Click a home tile: a trip starts where a household lives."); return; }
    this.tripAt = { r: cell.r, c: cell.c, store: st.id };
    this.trip = { busy: true };
    this.render();
    let t;
    try { t = await this.host.app.client.request("PREVIEW_TRIP", { text: this.host.world.text(), r: cell.r, c: cell.c, store: st.id, car: true }); }
    catch (e) { t = { ok: false, message: e.message }; }
    this.trip = t;
    this.render(); ed.draw();
  }

  selectedFac() { return this.m.parking.find((x) => x.id === this.fac) ?? null; }
  selectedVenue() { return this.m.venues.find((x) => x.id === this.venue) ?? null; }

  // ---- Beside the map ---------------------------------------------------------------------------

  render() {
    if (!this.draft) return;
    this.#renderParking(); this.#renderVenues(); this.#renderAccess(); this.#renderPlan();
  }

  #renderParking() {
    const m = this.m; const p = this.host.previewState === "fresh" ? this.host.preview : null;
    const stats = new Map((p?.parking ?? []).map((x) => [x.id, x]));
    const rows = m.parking.map((f) => {
      const s = stats.get(f.id);
      const most = maxSpaces(f.kind, f.tiles.length, f.levels, m.patch_m);
      return el("button", { type: "button", class: `store-row${f.id === this.fac ? " is-on" : ""}`, onclick: () => { this.fac = f.id; this.mode = "select"; this.host.renderPalette(); this.render(); this.host.editor.reveal(f.tiles); this.host.editor.draw(); } },
        el("span", { text: `${f.name}` }), el("span", { class: `sub${!f.vehicle_access.length || !f.pedestrian_access.length ? " bad" : ""}`,
          text: `${KINDS[f.kind]} · ${fmt.int(f.spaces)} of ${fmt.int(most)} spaces${s ? ` · ${fmt.int(s.households)} households can drive to it` : ""}${!f.vehicle_access.length ? " · no vehicle entrance" : ""}${!f.pedestrian_access.length ? " · no pedestrian exit" : ""}` }));
    });
    const f = this.selectedFac();
    const body = [m.parking.length ? el("div", { class: "store-list" }, ...rows)
      : el("p", { class: "note bad", text: "No parking has been built. Households can only walk: paint a lot (P) or a garage (G) and make it a facility, or mark kerb spaces on a street." })];
    if (f) body.push(this.#facilityEditor(f, stats.get(f.id)));
    this.parkingCard.body.replaceChildren(...body);
    this.parkingCard.setSub(`${m.parking.length} built · ${fmt.int(m.parking.reduce((a, x) => a + x.spaces, 0))} spaces · wait for Setup`);
  }

  #facilityEditor(f, s) {
    const m = this.m; const schema = this.host.world.schema?.fields?.parking ?? {};
    const set = (k) => (v) => this.edit((d) => { d.macro.parking.find((x) => x.id === f.id)[k] = v; });
    const most = maxSpaces(f.kind, f.tiles.length, f.levels, m.patch_m);
    const num = (k, label, extra = {}) => numberField({ label, value: f[k], min: schema[k]?.min ?? 0, max: extra.max ?? schema[k]?.max, step: 1, onChange: set(k) }).root;
    const stores = s ? s.stores.map((i) => `${this.draft.stores.filter(placed)[i - 1]?.short ?? i} (${fmt.num1(s.walk_min[i - 1])} min)`) : [];
    return el("div", { class: "facility-editor" },
      el("h3", { class: "setup-heading", text: f.name }),
      textField({ label: "Name", value: f.name, onChange: set("name") }).root,
      el("div", { class: "settings-grid" },
        f.kind === "garage" ? num("levels", "Levels", { max: 12 }) : null,
        num("spaces", `Spaces (at most ${fmt.int(most)})`, { max: most }),
        num("search_s", "Finding a space (s)"),
        f.kind === "garage" ? num("level_s", "Each level up (s)") : null,
        f.kind !== "kerb" ? num("transfer_s", "Space to exit on foot (s)") : null),
      el("p", { class: "note", text: f.kind === "kerb" ? `${f.tiles.length} street tile${f.tiles.length === 1 ? "" : "s"}: cars park along the kerb and people step onto the sidewalk.`
        : `${f.tiles.length} tiles · vehicle entrances: ${f.vehicle_access.map(([r, c]) => `(${r}, ${c})`).join(", ") || "none yet"} · pedestrian exits: ${f.pedestrian_access.map(([r, c]) => `(${r}, ${c})`).join(", ") || "none yet"}` }),
      s ? el("p", { class: "note", text: `The model: ${fmt.int(s.households)} households can drive to it; for ${fmt.int(s.demand)} it's the place to park for some store. Stores within walking distance: ${stores.join(", ") || "none"}.` }) : null,
      el("div", { class: "row wrap" },
        f.kind !== "kerb" ? el("button", { type: "button", class: "btn small", text: "Set vehicle entrances", onclick: () => { this.mode = "vehicle"; this.host.renderPalette(); this.host.editor.draw(); } }) : null,
        f.kind !== "kerb" ? el("button", { type: "button", class: "btn small", text: "Set pedestrian exits", onclick: () => { this.mode = "pedestrian"; this.host.renderPalette(); this.host.editor.draw(); } }) : null,
        el("button", { type: "button", class: "btn small danger", text: "Remove it", title: "Remove this facility: its spaces are gone at the next Setup (the painted tiles stay)", onclick: () => this.edit((d) => this.#removeFacility(d, f.id)) })));
  }

  #renderVenues() {
    const m = this.m; const d = this.draft;
    const kindSeg = segmented({ label: "New venue", options: Object.entries(VENUE_KINDS).map(([value, label]) => ({ value, label: `+ ${label}` })), onChange: (kind) => {
      const name = newName(m.venues, VENUE_KINDS[kind]); const id = newId(m.venues, name);
      this.edit((dd) => dd.macro.venues.push({ id, name, kind, stores: [], parking: [] }));
      this.venue = id; if (kind === "mall") this.mode = "mall"; this.host.renderPalette(); this.render();
    } });
    const list = el("div", { class: "store-list" }, ...m.venues.map((v) => el("button", { type: "button", class: `store-row${v.id === this.venue ? " is-on" : ""}`,
      onclick: () => { this.venue = v.id; this.host.renderPalette(); this.render(); this.host.editor.draw(); } },
    el("span", { text: v.name }), el("span", { class: "sub", text: `${VENUE_KINDS[v.kind]} · ${v.stores.length} stores · ${v.parking.length} parking` }))));
    const v = this.selectedVenue();
    const body = [kindSeg.root, m.venues.length ? list : el("p", { class: "note", text: "No venues yet. A venue ties stores together: an enclosed mall with its corridors, a strip mall along a walkway, or a district of streets." })];
    if (v) {
      const set = (fn) => this.edit((dd) => fn(dd.macro.venues.find((x) => x.id === v.id), dd));
      const member = (s) => v.stores.includes(s.id);
      body.push(el("div", { class: "facility-editor" },
        el("h3", { class: "setup-heading", text: v.name }),
        textField({ label: "Name", value: v.name, onChange: (x) => set((g) => { g.name = x; }) }).root,
        el("p", { class: "note", text: v.kind === "mall" ? "An enclosed mall: its building is a rectangle of m tiles, and its plan (corridors, entrances, storefronts) is drawn below. Shoppers walk its corridors from store to store."
          : v.kind === "strip" ? "A strip mall: its stores stand on the map's own walkable tiles (a walkway, s) beside the parking they share." : "A district: its stores on the map's streets and plazas, with the parking it shares." }),
        el("div", { class: "palette-title", text: "Its stores" }),
        el("div", { class: "check-list" }, ...d.stores.map((s) => {
          const other = d.macro.venues.find((x) => x.id !== v.id && x.stores.includes(s.id));
          const cb = checkbox({ label: `${s.short}${other ? ` (in ${other.name})` : ""}`, checked: member(s), onChange: (on) => set((g, dd) => {
            for (const x of dd.macro.venues) x.stores = x.stores.filter((id) => id !== s.id);
            const st = dd.stores.find((y) => y.id === s.id);
            if (on) { g.stores.push(s.id); st.venue = g.id; } else delete st.venue;
            if (g.kind === "mall" && g.storefronts) {
              if (!on) for (const [L, id] of Object.entries(g.storefronts)) { if (id === s.id) delete g.storefronts[L]; }
            }
            reorder(st);
          }) });
          return cb.root;
        })),
        el("div", { class: "palette-title", text: "The parking it shares" }),
        m.parking.length ? el("div", { class: "check-list" }, ...m.parking.map((f) => checkbox({ label: f.name, checked: v.parking.includes(f.id),
          onChange: (on) => set((g) => { g.parking = on ? [...g.parking, f.id] : g.parking.filter((x) => x !== f.id); }) }).root)) : el("p", { class: "note", text: "No parking built yet." }),
        el("div", { class: "row wrap" },
          v.kind === "mall" ? el("button", { type: "button", class: "btn small", text: v.tiles ? "Pick its building again" : "Pick its building", onclick: () => { this.mode = "mall"; this.host.renderPalette(); } }) : null,
          el("button", { type: "button", class: "btn small danger", text: "Remove the venue", onclick: () => this.edit((dd) => {
            dd.macro.venues = dd.macro.venues.filter((x) => x.id !== v.id);
            for (const s of dd.stores) if (s.venue === v.id) delete s.venue;
            this.venue = null;
          }) }))));
    }
    this.venuesCard.body.replaceChildren(...body);
  }

  // What the model says can't be reached, each on its tiles, and the trip.
  #renderAccess() {
    const p = this.host.preview; const fresh = this.host.previewState === "fresh";
    const body = [];
    if (this.trip) body.push(this.#tripText());
    if (!p || !fresh) body.push(el("p", { class: "note", text: this.host.previewState === "problems" ? "The map has problems to fix first (below the map)." : "Waiting for the model's preview of this draft…" }));
    else {
      body.push(el("p", { class: "note", text: `Household-store pairs within reach: ${fmt.int(p.by_car ?? 0)} by car, ${fmt.int(p.on_foot ?? 0)} on foot.` }));
      if (!p.warnings?.length) body.push(el("p", { class: "note ok", text: "Every store can be reached, and every facility used." }));
      else body.push(el("div", { class: "problems" }, ...p.warnings.map((w) => el("button", { type: "button", class: "problem", text: w.message,
        title: w.path, onclick: () => { this.host.editor.setHighlights(w.tiles ?? []); if (w.tiles?.length) this.host.editor.reveal(w.tiles); } }))));
    }
    this.accessCard.body.replaceChildren(...body);
    this.accessCard.setSub(fresh && p?.warnings ? `${p.warnings.length} warning${p.warnings.length === 1 ? "" : "s"} from the model` : "from the model's preview");
  }

  #tripText() {
    const t = this.trip; const st = this.draft.stores.find((s) => s.id === this.tripAt?.store);
    if (t.busy) return el("p", { class: "note", text: "Working out the trip…" });
    if (!t.ok) return el("p", { class: "note bad", text: t.message ?? "No trip." });
    const min = (x) => `${fmt.num1(x)} min`;
    const lines = [el("b", { text: `From row ${this.tripAt.r}, column ${this.tripAt.c} to ${st?.name}: ${t.mode === "drive" ? "by car" : t.mode === "walk" ? "on foot" : "no way there"}` })];
    if (t.drive) lines.push(el("div", { text: `By car: ${min(t.drive.drive_min)} driving (${fmt.num1(t.drive.drive_km)} km), ${min(t.drive.park_min)} parking at ${t.drive.facility}, ${min(t.drive.walk_min)} walking (${Math.round(t.drive.walk_km * 1000)} m).` }));
    else lines.push(el("div", { text: "By car: no facility it can drive to has the store within walking distance." }));
    lines.push(el("div", { text: t.walk.ok ? `On foot: ${min(t.walk.min)} (${fmt.num1(t.walk.km)} km)${t.walk.within ? "" : ", further than shoppers will walk"}.` : "On foot: no way there." }));
    return el("div", { class: "trip-text" }, ...lines);
  }

  // ---- A mall's plan ----------------------------------------------------------------------------

  #renderPlan() {
    const v = this.selectedVenue();
    const show = v && v.kind === "mall" && v.plan && v.tiles?.length;
    this.planCard.root.hidden = !show;
    if (!show) return;
    this.planCard.head.querySelector("h2").textContent = `${v.name}: plan`;
    this.planCard.setSub(`${v.plan.rows[0].length} x ${v.plan.rows.length} cells of ${fmt.num1(v.plan.cell_m)} m · corridors, entrances, storefronts`);
    if (!this.plan) {
      const wrap = el("div", { class: "editor-canvas plan-canvas" });
      const colour = (ch) => {
        if (ch === "#") return cssVar("--map-building", wrap);
        if (ch === ".") return cssVar("--map-plaza", wrap);
        if (ch === "E") return "#2f9e44";
        const id = this.selectedVenue()?.storefronts?.[ch];
        const s = this.draft.stores.find((x) => x.id === id);
        return this.draft.brands.find((b) => b.id === s?.brand)?.colour ?? "#ff00ff";
      };
      const editor = new GridEditor(wrap, {
        layers: [{ id: "plan", erase: "#", colour }], cellPx: 10,
        names: { material: (ch) => ({ "#": "Wall", ".": "Corridor", E: "Entrance" }[ch] ?? `Storefront ${ch}`), layer: () => "Plan" },
        cellM: () => this.selectedVenue()?.plan?.cell_m,
        onStroke: () => {
          const rows = editor.rows(0); const id = this.plan.venue;
          this.host.world.edit((d) => { const g = d.macro.venues.find((x) => x.id === id); if (g?.plan) g.plan.rows = rows; });
          this.host.afterTransportEdit({ plan: false });
        },
      });
      const palette = el("div", { class: "palette inline" });
      this.plan = { editor, wrap, palette, venue: null, bar: toolbar(editor) };
      this.planCard.body.replaceChildren(el("div", { class: "editor-bar" }, this.plan.bar), palette, wrap,
        el("p", { class: "note", text: "Walls (#) can't be walked through. Corridors join the entrances (on the plan's edge, opening onto the map tile beyond) to each store's storefront. Each storefront is where its store's floor begins." }));
    }
    const key = JSON.stringify([v.id, v.plan.rows]);
    if (this.plan.key !== key) { this.plan.editor.load([v.plan.rows], { keepView: this.plan.venue === v.id }); this.plan.key = key; this.plan.venue = v.id; }
    const items = [["#", "Wall"], [".", "Corridor"], ["E", "Entrance"], ...v.stores.map((id, i) => {
      const L = Object.entries(v.storefronts ?? {}).find(([, x]) => x === id)?.[0] ?? STOREFRONTS[i];
      return [L, `${this.draft.stores.find((s) => s.id === id)?.short ?? id}'s storefront (${L})`, id];
    })];
    this.plan.palette.replaceChildren(...items.map(([ch, label, id]) => el("button", { type: "button", class: "swatch named", "aria-checked": String(this.plan.editor.paint === ch), role: "radio",
      onclick: () => {
        if (id && !(v.storefronts?.[ch] === id)) this.host.world.edit((d) => { const g = d.macro.venues.find((x) => x.id === v.id); g.storefronts = { ...(g.storefronts ?? {}), [ch]: id }; });
        this.plan.editor.setPaint(ch); this.plan.editor.setTool("pencil"); this.#renderPlan();
      } }, el("i", { class: "swatch-chip", vars: { "--c": ch === "#" ? cssVar("--map-building") : ch === "." ? cssVar("--map-plaza") : ch === "E" ? "#2f9e44" : this.draft.brands.find((b) => b.id === this.draft.stores.find((s) => s.id === id)?.brand)?.colour ?? "#888" } }), el("em", { text: label }))));
  }

  // ---- On the map -------------------------------------------------------------------------------

  draw(ctx, ed) {
    const m = this.m; const z = ed.zoom; const on = this.host.layer === "transport";
    ctx.save();
    // Each facility: its tiles outlined, its entrances (a car's triangle) and exits (a walker's dot).
    for (const f of m.parking) {
      const sel = f.id === this.fac;
      ctx.strokeStyle = f.kind === "garage" ? "#5c6070" : f.kind === "kerb" ? "#3b6bb5" : "#3b6bb5";
      ctx.lineWidth = sel ? 3 : on ? 1.5 : 1; ctx.globalAlpha = on ? 1 : 0.6;
      for (const [r, c] of f.tiles) { const q = ed.toScreen(r, c); ctx.strokeRect(q.x + 1, q.y + 1, z - 2, z - 2); }
      if (z >= 6 || sel) {
        for (const [r, c] of f.kind === "kerb" ? [] : f.vehicle_access) { const q = ed.toScreen(r, c); triangle(ctx, q.x + z / 2, q.y + z / 2, Math.max(3, z * 0.3), "#1c3f8a"); }
        for (const [r, c] of f.kind === "kerb" ? [] : f.pedestrian_access) { const q = ed.toScreen(r, c); dot(ctx, q.x + z / 2, q.y + z * 0.75, Math.max(2, z * 0.14), "#2f9e44"); }
      }
      if (f.kind === "kerb" && z >= 8) {
        ctx.fillStyle = "#1c3f8a"; ctx.font = `700 ${Math.max(9, Math.min(14, z * 0.4))}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const [r, c] = f.tiles[0]; const q = ed.toScreen(r, c); ctx.fillText(`${f.spaces}`, q.x + z / 2, q.y + z / 2);
      }
    }
    // Malls: the plan over the building, once the cells can be seen.
    for (const v of m.venues) {
      if (v.kind !== "mall" || !v.tiles?.length || !v.plan) continue;
      const r0 = Math.min(...v.tiles.map(([r]) => r)); const c0 = Math.min(...v.tiles.map(([, c]) => c));
      const k = m.patch_m / v.plan.cell_m; const cz = z / k;
      if (cz >= 1.2) {
        v.plan.rows.forEach((row, pr) => { for (let pc = 0; pc < row.length; pc++) {
          const ch = row[pc]; if (ch === "#") continue;
          ctx.fillStyle = ch === "." ? "rgba(255,255,255,0.75)" : ch === "E" ? "#2f9e44" : "#c2255c";
          const q = ed.toScreen(r0, c0); ctx.fillRect(q.x + pc * cz, q.y + pr * cz, Math.ceil(cz), Math.ceil(cz));
        } });
      }
      if (v.id === this.venue) { ctx.strokeStyle = "#c2255c"; ctx.lineWidth = 2.5; const q = ed.toScreen(r0, c0); ctx.strokeRect(q.x, q.y, (Math.max(...v.tiles.map(([, c]) => c)) - c0 + 1) * z, (Math.max(...v.tiles.map(([r]) => r)) - r0 + 1) * z); }
    }
    // The trip: the drive (blue), the walk from the car (green), or the walk from home.
    if (this.trip?.ok) {
      const path = (xy, colour, w) => {
        if (!xy?.length) return;
        ctx.strokeStyle = colour; ctx.lineWidth = w; ctx.lineJoin = "round"; ctx.beginPath();
        for (let i = 0; i < xy.length; i += 2) { const x = ed.ox + (xy[i] / m.patch_m) * z; const y = ed.oy + (m.height - xy[i + 1] / m.patch_m) * z; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
        ctx.stroke();
      };
      if (this.trip.mode === "drive") { path(this.trip.drive?.drive_route, "#1c7ed6", 4); path(this.trip.drive?.walk_route, "#2f9e44", 3); }
      else path(this.trip.walk?.route, "#2f9e44", 3);
    }
    ctx.restore();
  }
}

function triangle(ctx, x, y, s, colour) { ctx.fillStyle = colour; ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s * 0.8); ctx.lineTo(x - s, y + s * 0.8); ctx.closePath(); ctx.fill(); }
function dot(ctx, x, y, r, colour) { ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

// A store's keys in the world file's order.
export function reorder(s) {
  const out = {};
  for (const k of ["id", "name", "short", "brand", "layout", "x", "y", "venue", "staff"]) if (s[k] !== undefined) out[k] = s[k];
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, out);
  return s;
}

export { clone };
