// The world on the page: the draft being edited on the Setup tab, and the
// world installed at the last Setup. Live settings (a brand's levers, stock
// rules and price rules, a store's staffing, the market's weights) change
// both at once and act from that moment;
// every other change waits in the draft for the next Setup, which sends the
// whole draft to R. Both are kept in the browser, so a reload loses neither
// a half-painted map nor the world that was running.

const KEYS = { draft: "fashion.world.draft", installed: "fashion.world.installed" };

// ---- The world file's text -----------------------------------------------------

// Laid out as model/world.R's world_text() writes it: two-space indents,
// short arrays and objects on one line, long ones one item per line,
// numbers to 15 significant digits.
export function worldText(x) { return `${jsonValue(x, "")}\n`; }

function jsonValue(x, indent) {
  const inner = `${indent}  `;
  if (x === null || x === undefined) return "null";
  if (typeof x === "object") {
    const obj = !Array.isArray(x);
    const keys = obj ? Object.keys(x) : null;
    const vals = obj ? keys.map((k) => x[k]) : x;
    if (!vals.length) return obj ? "{}" : "[]";
    let items = vals.map((v) => jsonValue(v, inner));
    if (obj) items = items.map((s, i) => `${JSON.stringify(keys[i])}: ${s}`);
    const flat = vals.every((v) => v === null || typeof v !== "object" || !(Array.isArray(v) ? v.length : Object.keys(v).length));
    const [open, close] = obj ? ["{", "}"] : ["[", "]"];
    if (flat && items.reduce((a, s) => a + s.length, 0) + 2 * items.length <= 100) return `${open}${items.join(", ")}${close}`;
    return `${open}\n${items.map((s) => inner + s).join(",\n")}\n${indent}${close}`;
  }
  if (typeof x === "string") return JSON.stringify(x);
  if (typeof x === "boolean") return x ? "true" : "false";
  return jsonNumber(x);
}

// sprintf("%.15g") as R writes it, exponents without leading zeros.
function jsonNumber(v) {
  if (!Number.isFinite(v)) return "null";
  if (v === 0) return "0";
  const [m, e] = v.toExponential(14).split("e");
  const E = Number(e);
  if (E < -4 || E >= 15) return `${m.replace(/\.?0+$/, "")}e${E < 0 ? "-" : "+"}${Math.abs(E)}`;
  const f = v.toFixed(Math.max(0, 14 - E));
  return f.includes(".") ? f.replace(/\.?0+$/, "") : f;
}

export const clone = (x) => structuredClone(x);

// ---- Ids and names ------------------------------------------------------------------

export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "item";
}

// An id no item in `items` has yet, from `name`.
export function newId(items, name) {
  const taken = new Set(items.map((x) => x.id));
  const base = slug(name);
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) if (!taken.has(`${base}_${k}`)) return `${base}_${k}`;
}

export function newName(items, base) {
  const taken = new Set(items.map((x) => x.name));
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) if (!taken.has(`${base} ${k}`)) return `${base} ${k}`;
}

// ---- Live settings, and what waits for Setup ----------------------------------------

export const LIVE_STOCK = ["allocation", "lead_days", "opening_weeks", "delivery_fee", "unit_fee", "salvage"];

// The world with its live settings taken out: what differs here waits for
// the next Setup.
function structural(w) {
  const x = clone(w);
  delete x.market;
  for (const b of x.brands ?? []) {
    delete b.levers; delete b.pricing;
    if (b.stock) for (const k of LIVE_STOCK) delete b.stock[k];
  }
  for (const s of x.stores ?? []) delete s.staff;
  return x;
}

// How many things differ between two lists of items with ids: added,
// removed or changed.
function listChanges(a = [], b = []) {
  const byId = new Map(b.map((x) => [x.id, JSON.stringify(x)]));
  let n = 0;
  for (const x of a) { const y = byId.get(x.id); if (y === undefined || y !== JSON.stringify(x)) n++; byId.delete(x.id); }
  return n + byId.size;
}

export function countChanges(draft, installed) {
  if (!draft || !installed) return 0;
  const d = structural(draft); const i = structural(installed);
  let n = 0;
  if (d.name !== i.name) n++;
  if (d.seed !== i.seed) n++;
  if (d.season_days !== i.season_days) n++;
  const md = d.macro ?? {}; const mi = i.macro ?? {};
  const settings = (m) => JSON.stringify(["patch_m", "width", "height", "households", "road_mps", "local_mps", "park_s", "wom_m"].map((k) => m[k]));
  if (settings(md) !== settings(mi)) n++;
  if (JSON.stringify(md.tiles) !== JSON.stringify(mi.tiles)) n++;
  if (JSON.stringify(md.area_tiles) !== JSON.stringify(mi.area_tiles)) n++;
  if (JSON.stringify(md.default_makeup) !== JSON.stringify(mi.default_makeup)) n++;
  n += listChanges(md.areas, mi.areas);
  for (const k of ["categories", "layouts", "stores", "families", "brands", "segments"]) n += listChanges(d[k], i[k]);
  n += listChanges(d.demand_events, i.demand_events);
  const catOrder = (w) => JSON.stringify((w.categories ?? []).map((c) => c.id));
  if (!listChanges(d.categories, i.categories) && catOrder(d) !== catOrder(i)) n++;
  const order = (w) => JSON.stringify((w.brands ?? []).map((b) => b.id));
  if (!listChanges(d.brands, i.brands) && order(d) !== order(i)) n++;
  return n;
}

// ---- The store ------------------------------------------------------------------------

export class WorldStore extends EventTarget {
  constructor() {
    super();
    this.draft = null;
    this.installed = null;
    this.schema = null;
    this.prefabs = null;
    this.saveTimer = 0;
    this.savedDraft = read(KEYS.draft);
    this.savedInstalled = read(KEYS.installed);
  }

  // The world R installed (at boot, or at a Setup): the draft starts from
  // it unless a draft was kept.
  setInstalled(text, { keepDraft = true } = {}) {
    this.installed = JSON.parse(text);
    write(KEYS.installed, text);
    if (!this.draft) {
      let kept = null;
      if (keepDraft && this.savedDraft) { try { kept = JSON.parse(this.savedDraft); } catch { kept = null; } }
      this.draft = kept ?? clone(this.installed);
    }
    this.#changed({ installed: true });
  }

  // A draft kept from an older version of the model: `read` (the model's
  // CHECK_WORLD) gives it as this version reads it, or it's dropped.
  async upgradeSaved(read, version) {
    if (this.draft || !this.savedDraft) return;
    let v = null;
    try { v = JSON.parse(this.savedDraft).version; } catch { v = null; }
    if (v === version) return;
    try { this.savedDraft = (await read(this.savedDraft))?.text ?? null; } catch { this.savedDraft = null; }
  }

  // The draft becomes exactly the installed world (after a Setup of it).
  adoptInstalled() {
    this.draft = clone(this.installed);
    this.#save();
    this.#changed({ installed: true });
  }

  get pending() { return countChanges(this.draft, this.installed); }

  // An edit to the draft that waits for Setup. `fn` changes the draft in place.
  edit(fn, detail = {}) {
    fn(this.draft);
    this.#save();
    this.#changed(detail);
  }

  // A live setting: set in the draft and, where the thing is installed, in
  // the installed world too (R already has it).
  live(fn, detail = {}) {
    fn(this.draft);
    if (this.installed) { try { fn(this.installed); } catch { /* not installed yet */ } }
    write(KEYS.installed, worldText(this.installed));
    this.#save();
    this.#changed({ live: true, ...detail });
  }

  replaceDraft(world) {
    this.draft = world;
    this.#save();
    this.#changed({ replaced: true });
  }

  text() { return worldText(this.draft); }

  brand(id, w = this.draft) { return w?.brands?.find((b) => b.id === id); }
  store(id, w = this.draft) { return w?.stores?.find((s) => s.id === id); }
  layout(id, w = this.draft) { return w?.layouts?.find((l) => l.id === id); }
  segment(id, w = this.draft) { return w?.segments?.find((s) => s.id === id); }
  family(id, w = this.draft) { return w?.families?.find((f) => f.id === id); }

  // The prefab layouts (layouts/*.layout.json), fetched once.
  async loadPrefabs() {
    if (this.prefabs) return this.prefabs;
    const base = new URL("../../layouts/", import.meta.url);
    const index = await fetch(new URL("index.json", base)).then((r) => r.json());
    this.prefabs = await Promise.all(index.prefabs.map(async (id) => {
      const L = await fetch(new URL(`${id}.layout.json`, base)).then((r) => r.json());
      const { kind, version, ...layout } = L;
      return layout;
    }));
    return this.prefabs;
  }

  // A world file's prefab layouts ({"prefab": "flagship"}), put inline.
  async resolvePrefabs(world) {
    if (!Array.isArray(world?.layouts) || !world.layouts.some((L) => L && L.prefab && Object.keys(L).length === 1)) return world;
    const prefabs = await this.loadPrefabs();
    world.layouts = world.layouts.map((L) => (L && L.prefab && Object.keys(L).length === 1 ? clone(prefabs.find((p) => p.id === L.prefab) ?? L) : L));
    return world;
  }

  #save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => write(KEYS.draft, worldText(this.draft)), 300);
  }

  #changed(detail) { this.dispatchEvent(new CustomEvent("change", { detail })); }
}

// Browser storage can be missing or full; the app works without it.
function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key, value) { try { localStorage.setItem(key, value); } catch { /* not kept */ } }

// A file the user saves.
export function download(name, text, type = "application/json") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// A file the user picks, as text.
export function pickFile(accept = ".json,application/json") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = accept;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, text: await file.text() } : null);
    });
    input.click();
  });
}
