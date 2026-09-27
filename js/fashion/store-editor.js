// The micro world's stores, on the Setup tab: a store is a name, a brand
// and a layout (its floor plan), with its staff. A brand's stores can run
// different layouts. Stores are made here; the Macro world's Stores layer
// puts each on the map.
//
// A store's name, brand and layout change the world and wait for Setup;
// its staffing and service are live.

import { el, card, select, textField, settingLever } from "./ui.js";
import { newId, newName } from "./world-store.js";
import { layoutCapacity } from "./layout-editor.js";

export class StoreEditor {
  constructor(root, app, { openLayout, openMap } = {}) {
    this.app = app; this.world = app.world; this.openLayout = openLayout; this.openMap = openMap;
    this.selected = null; this.addBrand = null; this.addLayout = null;
    this.listCard = card("Stores", { sub: "" });
    this.storeCard = card("The selected store", { sub: "" });
    root.append(el("div", { class: "grid setup-two store-editor" }, this.listCard.root, this.storeCard.root));
  }

  show() {
    const d = this.world.draft;
    if (!d || !this.world.schema) return;
    if (!d.stores.some((s) => s.id === this.selected)) this.selected = null;
    this.#renderList();
    this.#renderStore();
  }

  select(id) { this.selected = id; this.show(); }

  // Stores by brand: each with its layout, and whether it's on the map yet.
  #renderList() {
    const d = this.world.draft;
    if (!d.brands.some((b) => b.id === this.addBrand)) this.addBrand = d.brands[0]?.id;
    if (!d.layouts.some((l) => l.id === this.addLayout)) this.addLayout = d.layouts[0]?.id;
    const layoutName = (id) => d.layouts.find((l) => l.id === id)?.name ?? id;
    const list = el("div", { class: "store-list" });
    for (const b of d.brands) {
      const mine = d.stores.filter((s) => s.brand === b.id);
      list.append(el("div", { class: "store-group", vars: { "--brand": b.colour } },
        el("div", { class: "brand-name" }, el("i", { class: "dot" }), b.name, el("span", { class: "sub", text: ` · ${mine.length} store${mine.length === 1 ? "" : "s"}` })),
        ...mine.map((s) => el("button", { type: "button", class: `store-row${s.id === this.selected ? " is-on" : ""}`, onclick: () => this.select(s.id) },
          el("span", { text: s.name }),
          el("span", { class: `sub${placed(s) ? "" : " bad"}`, text: placed(s) ? layoutName(s.layout) : `${layoutName(s.layout)} · not on the map` })))));
    }
    // A new store: its name, brand and layout.
    const brand = select({ label: "Brand", value: this.addBrand, options: d.brands.map((b) => ({ value: b.id, label: b.name })), onChange: (v) => { this.addBrand = v; this.#renderList(); } });
    const layout = select({ label: "Layout", value: this.addLayout, options: d.layouts.map((l) => ({ value: l.id, label: l.name })), onChange: (v) => { this.addLayout = v; this.#renderList(); } });
    const b = d.brands.find((x) => x.id === this.addBrand); const L = d.layouts.find((x) => x.id === this.addLayout);
    const name = textField({ label: "Name", value: newName(d.stores, `${b?.name ?? "New"} ${L?.name ?? "store"}`), maxLength: 80 });
    const add = el("button", { type: "button", class: "btn small", text: "Add store", disabled: d.stores.length >= this.world.schema.limits.stores || null, onclick: () => this.#add(name.input.value.trim()) });
    const unplaced = d.stores.filter((s) => !placed(s)).length;
    this.listCard.setSub(`${d.stores.length} of at most ${this.world.schema.limits.stores}, by brand${unplaced ? ` · ${unplaced} not on the map yet` : ""}`);
    this.listCard.body.replaceChildren(list,
      el("h3", { class: "setup-heading", text: "A new store" }),
      el("div", { class: "grid two" }, name.root, brand.root, layout.root, el("div", { class: "field end" }, add)),
      el("p", { class: "note", text: "A store is a name, a brand and a layout (its floor plan, below); a brand's stores can run different layouts. The Macro world's Stores layer puts each store on the map." }));
  }

  #add(text) {
    const d = this.world.draft;
    const b = d.brands.find((x) => x.id === this.addBrand) ?? d.brands[0];
    const L = d.layouts.find((x) => x.id === this.addLayout) ?? d.layouts[0];
    const name = newName(d.stores, text || `${b.name} ${L.name}`);
    const cap = layoutCapacity(L.rows);
    const n = d.stores.filter((s) => s.brand === b.id).length + 1;
    const lev = b.levers;
    const st = {
      id: newId(d.stores, name), name, short: `${b.name.slice(0, 13).trim()} ${n}`, brand: b.id, layout: L.id,
      staff: { cashiers: Math.max(1, Math.min(lev.cashiers, cap.tills || 1)), assistants: lev.assistants, fitting_rooms: Math.max(1, cap.cubicles),
               skill: lev.skill, scan_s: lev.scan_s, try_s: 150, max_fr_q: 8, max_till_q: 10 },
    };
    this.world.edit((w) => { w.stores.push(st); });
    this.select(st.id);
    this.app.banner(`${name} added`, "It isn't on the map yet: the Macro world's Stores layer puts it there, and Setup starts a world only when every store is on the map.");
  }

  // The selected store: its name, brand and layout (wait for Setup), where
  // it stands, and its staffing and service (live).
  #renderStore() {
    const d = this.world.draft; const schema = this.world.schema;
    const st = d.stores.find((s) => s.id === this.selected);
    if (!st) {
      this.storeCard.setSub("");
      this.storeCard.body.replaceChildren(el("p", { class: "empty", text: "Pick a store to see its name, brand, layout and staff, or add one." }));
      return;
    }
    const b = d.brands.find((x) => x.id === st.brand);
    const L = d.layouts.find((l) => l.id === st.layout);
    const cap = L ? layoutCapacity(L.rows) : { tills: 1, cubicles: 1 };
    this.storeCard.setSub(`${b?.name ?? st.brand} · ${L?.name ?? st.layout}`);
    const edit = (fn) => { this.world.edit(fn); this.#renderList(); this.storeCard.setSub(`${d.brands.find((x) => x.id === st.brand)?.name ?? st.brand} · ${d.layouts.find((l) => l.id === st.layout)?.name ?? st.layout}`); };
    const name = textField({ label: "Name", value: st.name, onChange: (v) => edit(() => { st.name = v; }) });
    const short = textField({ label: "Short name (on the map)", value: st.short, maxLength: 16, onChange: (v) => edit(() => { st.short = v; }) });
    const brand = select({ label: "Brand", value: st.brand, options: d.brands.map((x) => ({ value: x.id, label: x.name })), onChange: (v) => { edit(() => { st.brand = v; }); this.#renderStore(); } });
    const lay = select({ label: "Layout", value: st.layout, options: d.layouts.map((l) => ({ value: l.id, label: l.name })), onChange: (v) => {
      const c2 = layoutCapacity(d.layouts.find((l) => l.id === v).rows);
      edit(() => { st.layout = v; st.staff.cashiers = Math.min(st.staff.cashiers, Math.max(1, c2.tills)); st.staff.fitting_rooms = Math.min(st.staff.fitting_rooms, Math.max(1, c2.cubicles)); });
      this.#renderStore();
    } });
    const area = placed(st) ? areaOf(d, st) : null;
    const where = el("div", { class: "row wrap" },
      el("span", { class: `sub${placed(st) ? "" : " bad"}`, text: placed(st) ? `On the map${area ? ` in ${area.name}` : ", outside every area"}.` : "Not on the map yet." }),
      el("button", { type: "button", class: "btn small", text: placed(st) ? "Move it on the map" : "Put it on the map", onclick: () => this.openMap?.(st.id) }),
      el("button", { type: "button", class: "btn small", text: "Open its layout", onclick: () => this.openLayout?.(st.layout) }));
    const del = el("button", { type: "button", class: "btn small danger", text: "Delete store", onclick: () => {
      this.world.edit((w) => { w.stores = w.stores.filter((s) => s.id !== st.id); });
      this.selected = null; this.show();
    } });
    const staff = el("div", { class: "settings-grid" }, ...Object.entries(schema.fields.staff).map(([k, spec]) => {
      const max = k === "cashiers" ? Math.max(1, cap.tills) : k === "fitting_rooms" ? Math.max(1, cap.cubicles) : spec.max;
      return settingLever(spec, { value: st.staff[k], max, onChange: async (v) => {
        this.world.live((w) => { const s2 = w.stores.find((x) => x.id === st.id); if (s2) s2.staff[k] = v; });
        const took = await this.app.set("store", k, v, { store: st.id });
        if (took !== undefined && took !== v && this.world.store(st.id)?.staff) this.world.live((w) => { const s2 = w.stores.find((x) => x.id === st.id); if (s2) s2.staff[k] = took; });
      } }).root;
    }));
    this.storeCard.body.replaceChildren(el("div", { class: "grid two" }, name.root, short.root, brand.root, lay.root), where,
      el("h3", { class: "setup-heading", text: "Staffing and service (live)" }), staff,
      el("p", { class: "note", text: `Wages: cashiers $${schema.wages.cashier}/h, assistants $${schema.wages.assistant}/h.` }), el("div", { class: "row" }, del));
  }
}

export const placed = (s) => Number.isFinite(s.x) && Number.isFinite(s.y);

// The area a placed store stands in, from the map's area layer.
function areaOf(d, st) {
  const m = d.macro;
  const r = m.height - 1 - Math.floor(st.y / m.patch_m); const c = Math.floor(st.x / m.patch_m);
  const key = m.area_tiles?.[r]?.[c];
  return m.areas.find((a) => a.key === key) ?? null;
}
