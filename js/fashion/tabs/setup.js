// Setup: every setting of the model, and the world itself, on one tab.
// Setup (in the header) starts a season from them; Go runs it.
//
//   Brands       brands in their families, and each brand's settings (its
//                online store and return policy among them)
//   Range and calendar  each brand's products, promotions and markdowns,
//                and its price rules (range-editor.js)
//   Shoppers     the categories, segments, and the market's weights
//   Offers       each brand's offers: named coupons on its calendar
//                (offer-editor.js)
//   Macro world  the market map, its areas, and where each store stands
//   Micro world  the stores (name, brand, layout, staff) and the layouts
//   Season       its length, the seed, and its demand events: days whose
//                demand is lifted or suppressed (season-editor.js)
//
// Live settings (a brand's prices, staff, stock and price rules, a store's
// staffing, the market's weights) act from the moment they change.
// Everything else changes the world, which waits for the next Setup: the tab says how many changes are waiting, and Setup
// sends the world to the model, which checks it before starting it.

import { el, fmt, card, select, segmented, textField, numberField, colourField, checkbox, settingLever, lever } from "../ui.js";
import { MapEditor } from "../map-editor.js";
import { LayoutEditor, layoutCapacity } from "../layout-editor.js";
import { RangeEditor } from "../range-editor.js";
import { OfferEditor } from "../offer-editor.js";
import { StoreEditor } from "../store-editor.js";
import { DemandEventEditor } from "../season-editor.js";
import { clone, newId, newName, slug, download, pickFile, worldText, LIVE_STOCK } from "../world-store.js";
import { unreplenished, plural } from "../entry-text.js";

const SECTIONS = [
  { value: "brands", label: "Brands" }, { value: "range", label: "Range and calendar" }, { value: "shoppers", label: "Shoppers" }, { value: "offers", label: "Offers" },
  { value: "macro", label: "Macro world" }, { value: "micro", label: "Micro world" }, { value: "season", label: "Season" },
];
const MARKET_SHOWN = ["taste_w", "range_w", "km_w", "memory", "wom"];
const LIVE = el("span", { class: "tag live", text: "live" });
const WAITS = el("span", { class: "tag", text: "at Setup" });
const tag = (live) => (live ? LIVE : WAITS).cloneNode(true);

export class SetupTab {
  constructor(root, app) {
    this.app = app; this.world = app.world;
    this.section = "brands"; this.brand = null; this.segment = null; this.confirm = null;

    root.append(el("div", { class: "tab-intro" }, el("h1", { text: "Setup" }),
      el("p", { text: "Every setting of the model, and the world it runs in. Settings marked live act at once; the rest change the world, which waits for the next Setup. Press Setup to start the season, then Go." })));

    // The world: its name, import and export, and what waits for Setup.
    this.nameField = textField({ label: "World", value: "", onChange: (v) => this.world.edit((d) => { d.name = v; }) });
    this.importSel = select({ label: "Import world", hideLabel: true, value: "", options: [
      { value: "", label: "Import world…" }, { value: "default", label: "Default world" }, { value: "file", label: "From file…" }],
    onChange: (v) => { this.importSel.set(""); if (v) this.#import(v); } });
    const exportBtn = el("button", { type: "button", class: "btn", text: "Export world", onclick: () => download(`${slug(this.world.draft?.name ?? "world")}.world.json`, this.world.text()) });
    this.pendingBox = el("span", { class: "pending" });
    this.problemsBox = el("div", { class: "problems-panel", hidden: true });
    this.sectionSeg = segmented({ label: "Setup sections", value: this.section, options: SECTIONS, onChange: (v) => this.#show(v) });
    root.append(el("div", { class: "world-bar" }, this.nameField.root, this.importSel.root, exportBtn, this.pendingBox), this.problemsBox,
      el("div", { class: "section-strip" }, this.sectionSeg.root));

    this.panels = {};
    for (const s of SECTIONS) { this.panels[s.value] = el("div", { class: "setup-section", hidden: s.value !== this.section }); root.append(this.panels[s.value]); }
    this.mapEditor = new MapEditor(this.panels.macro, app);
    this.storeEditor = new StoreEditor(this.panels.micro, app, {
      openLayout: (id) => { this.layoutEditor.current = id; this.layoutEditor.show(); this.layoutEditor.root?.scrollIntoView({ behavior: "smooth", block: "start" }); },
      openMap: (id) => { this.#show("macro"); this.mapEditor.placeStore(id); },
    });
    this.layoutEditor = new LayoutEditor(this.panels.micro, app);
    this.mapEditor.onEditStore = (id) => { this.#show("micro"); this.storeEditor.select(id); };
    this.layoutEditor.onStaff = () => this.storeEditor.show();
    this.rangeEditor = new RangeEditor(this.panels.range, app, { goTo: (p) => this.#goTo(p) });
    this.offerEditor = new OfferEditor(this.panels.offers, app);
    this.eventEditor = new DemandEventEditor(app);

    this.world.addEventListener("change", ({ detail }) => this.#changed(detail));
  }

  onSchema() { this.#render(); }
  onGeometry() { this.#render(); }
  onShow() { this.#render(); }
  // A report refreshes only the Season card's line about the season running,
  // so the demand events being edited beside it keep their focus.
  update(r) { this.facts = r; if (this.section === "season") this.#seasonFacts(); }

  // Problems with the world: from a refused Setup, or a file that can't be
  // imported. Clicking one goes to where it is.
  showProblems(problems, heading) {
    if (!problems?.length) { this.problemsBox.hidden = true; this.problemsBox.replaceChildren(); return; }
    this.problemsBox.hidden = false;
    this.problemsBox.replaceChildren(el("div", { class: "problems-head" }, el("b", { text: heading ?? `${problems.length} problems` }),
      el("button", { type: "button", class: "icon-btn", "aria-label": "Close", text: "×", onclick: () => this.showProblems([]) })),
    el("div", { class: "problems" }, ...problems.map((p) => el("button", { type: "button", class: "problem", onclick: () => this.#goTo(p) },
      el("code", { text: p.path || "file" }), ` ${p.message}`))));
  }

  #goTo(p) {
    const path = p.path ?? "";
    const idx = (name) => { const m = path.match(new RegExp(`^${name}\\[(\\d+)\\]`)); return m ? Number(m[1]) - 1 : -1; };
    if (/^brands\[\d+\]\.calendar\.offers/.test(path)) { this.offerEditor.goTo(path); this.#show("offers"); }
    else if (/^brands\[\d+\]\.(range|calendar|pricing)/.test(path)) { this.rangeEditor.goTo(path); this.#show("range"); }
    else if (path.startsWith("brands")) { const i = idx("brands"); if (i >= 0) this.brand = this.world.draft.brands[i]?.id; this.#show("brands"); }
    else if (path.startsWith("families")) this.#show("brands");
    else if (path.startsWith("categories")) this.#show("shoppers");
    else if (path.startsWith("segments") || path.startsWith("market")) { const i = idx("segments"); if (i >= 0) this.segment = this.world.draft.segments[i]?.id; this.#show("shoppers"); }
    else if (path.startsWith("layouts")) { const i = idx("layouts"); if (i >= 0) this.layoutEditor.current = this.world.draft.layouts[i]?.id; this.#show("micro"); if (p.tiles) this.layoutEditor.editor.setHighlights(p.tiles); }
    else if (path.startsWith("stores")) {
      // Where a store stands is the map's; the rest of it is the micro world's.
      const id = this.world.draft.stores[idx("stores")]?.id ?? null;
      if (/\.(x|y)$/.test(path) || /^(not on the map|stands |has no [xy])/.test(p.message)) { this.#show("macro"); if (id) this.mapEditor.placeStore(id); }
      else { this.#show("micro"); if (id) this.storeEditor.select(id); }
    }
    else if (path.startsWith("macro")) { this.#show("macro"); if (p.tiles) this.mapEditor.editor.setHighlights(p.tiles); }
    else if (path === "seed" || path === "season_days") this.#show("season");
    else if (path.startsWith("demand_events")) { this.eventEditor.goTo(path); this.#show("season"); }
  }

  #show(section) {
    this.section = section;
    this.sectionSeg.set(section);
    for (const [k, p] of Object.entries(this.panels)) p.hidden = k !== section;
    this.#render();
  }

  #changed(detail) {
    const n = this.world.pending;
    this.pendingBox.replaceChildren(n ? el("span", { class: "badge warn", text: `${n} change${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""} for Setup` }) : el("span", { class: "badge", text: "Nothing waits for Setup" }));
    if (detail?.replaced) { this.mapEditor.reload(); this.layoutEditor.reload(); this.#render(); }
    this.app.code?.refresh?.();
  }

  #render() {
    const d = this.world.draft;
    if (!d || !this.world.schema) return;
    this.nameField.set(d.name);
    this.#changed();
    switch (this.section) {
      case "brands": this.#renderBrands(); break;
      case "range": this.rangeEditor.show(); break;
      case "shoppers": this.#renderShoppers(); break;
      case "offers": this.offerEditor.show(); break;
      case "macro": this.mapEditor.show(); break;
      case "micro": this.storeEditor.show(); this.layoutEditor.show(); break;
      case "season": this.#renderSeason(); break;
      default: break;
    }
  }

  // ---- Import --------------------------------------------------------------------------------

  // A world from a file (or the default): checked in full first; with any
  // problem nothing changes and every problem is listed. Otherwise it
  // becomes the draft (as this version of the model reads it: a file from an
  // older version is upgraded), and takes effect at the next Setup.
  async #import(from) {
    let text; let name = "the default world";
    try {
      if (from === "default") text = await fetch(new URL("../../../worlds/default.world.json", import.meta.url)).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
      else { const f = await pickFile(); if (!f) return; text = f.text; name = f.name; }
    } catch (e) { this.app.error("The world couldn't be read", e); return; }
    let world;
    try { world = JSON.parse(text); } catch (e) { this.showProblems([{ path: "", message: `not a JSON file: ${e.message}` }], `Nothing was imported: ${name} can't be read.`); return; }
    world = await this.world.resolvePrefabs(world);
    const checked = await this.app.client.request("CHECK_WORLD", { text: worldText(world) }).catch((e) => ({ problems: [{ path: "", message: e.message }] }));
    const problems = checked.problems ?? [];
    if (problems.length) { this.showProblems(problems, `Nothing was imported: ${name} has ${problems.length} problem${problems.length === 1 ? "" : "s"}.`); return; }
    this.showProblems([]);
    world = JSON.parse(checked.text);
    this.brand = null; this.segment = null;
    this.world.replaceDraft(world);
    this.app.banner(`Imported ${world.name}`, "It takes effect at the next Setup.");
  }

  // ---- Brands ----------------------------------------------------------------------------------

  #renderBrands() {
    const d = this.world.draft; const schema = this.world.schema;
    if (!d.brands.some((b) => b.id === this.brand)) this.brand = d.brands[0]?.id;
    const b = d.brands.find((x) => x.id === this.brand);

    // Families and their brands.
    const list = el("div", { class: "brand-list" });
    for (const f of d.families) {
      const mine = d.brands.filter((x) => x.family === f.id);
      const fname = textField({ label: "Family name", hideLabel: true, value: f.name, onChange: (v) => this.world.edit(() => { f.name = v; }) });
      const ours = el("label", { class: "check", title: "Our family: \"ours\" in every report" },
        el("input", { type: "radio", name: "ours-family", checked: f.ours || null, onchange: () => this.world.edit((w) => { for (const g of w.families) g.ours = g.id === f.id; }) }), el("span", { text: "ours" }));
      const add = el("button", { type: "button", class: "btn small", text: "Add brand", disabled: d.brands.length >= schema.limits.brands || null, onclick: () => this.#addBrand(f) });
      const drop = mine.length ? null : el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${f.name}`, title: "Remove this family (it has no brands)", text: "×",
        onclick: () => { this.world.edit((w) => { w.families = w.families.filter((g) => g.id !== f.id); }); this.#renderBrands(); } });
      list.append(el("div", { class: "family" }, el("div", { class: "family-head" }, fname.root, ours, add, drop),
        ...mine.map((x) => this.#brandRow(x))));
    }
    list.append(el("button", { type: "button", class: "btn small", text: "Add family", onclick: () => {
      const name = newName(d.families, "New family");
      this.world.edit((w) => { w.families.push({ id: newId(w.families, name), name, ours: false }); });
      this.#renderBrands();
    } }));
    const left = card("Brands", { sub: `${d.brands.length} of at most ${schema.limits.brands}, by family` });
    left.body.append(list);
    if (this.confirm?.kind === "brand") left.body.append(this.confirm.node);

    this.brandRight = el("div", { class: "grid" });
    if (b) this.brandRight.append(...this.#brandSettings(b));
    this.panels.brands.replaceChildren(el("div", { class: "grid setup-two" }, left.root, this.brandRight));
  }

  // Another brand selected: its row marked, its settings on the right; the
  // list isn't redrawn, so a name being typed keeps its focus.
  #selectBrand(id) {
    if (this.brand === id) return;
    this.brand = id;
    for (const row of this.panels.brands.querySelectorAll(".brand-row")) row.classList.toggle("is-on", row.dataset.id === id);
    const b = this.world.brand(id);
    if (b && this.brandRight) this.brandRight.replaceChildren(...this.#brandSettings(b));
  }

  #brandRow(b) {
    const d = this.world.draft;
    const colour = colourField({ label: `Colour of ${b.name}`, value: b.colour, onChange: (v) => this.world.edit(() => { b.colour = v; }) });
    const name = textField({ label: "Brand name", hideLabel: true, value: b.name, onChange: (v) => {
      this.world.edit(() => { b.name = v; });
      if (this.brand === b.id && this.brandRight) this.brandRight.replaceChildren(...this.#brandSettings(b));
    } });
    name.input.addEventListener("focus", () => this.#selectBrand(b.id));
    const stores = d.stores.filter((s) => s.brand === b.id);
    const remove = el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${b.name}`, title: `Remove ${b.name}`, text: "×", onclick: () => this.#askRemoveBrand(b) });
    return el("div", { class: `brand-row${b.id === this.brand ? " is-on" : ""}`, dataset: { id: b.id }, vars: { "--brand": b.colour }, onclick: (ev) => {
      if (ev.target.closest("input,button")) return;
      this.#selectBrand(b.id);
    } }, colour.root, name.root, el("span", { class: "sub", text: `${stores.length} store${stores.length === 1 ? "" : "s"}${b.online?.on ? " · online" : ""}` }), remove);
  }

  // A new brand starts as a copy of the one above it: the family's last,
  // or the selected brand for an empty family.
  #addBrand(f) {
    const d = this.world.draft;
    const inFam = d.brands.filter((x) => x.family === f.id);
    const src = inFam.at(-1) ?? d.brands.find((x) => x.id === this.brand) ?? d.brands[0];
    const name = newName(d.brands, "New brand");
    const b = { ...clone(src), id: newId(d.brands, name), name, family: f.id, colour: shiftHue(src.colour, 47) };
    b.calendar.offers = [];
    this.world.edit((w) => {
      const at = inFam.length ? w.brands.indexOf(inFam.at(-1)) + 1 : w.brands.length;
      w.brands.splice(at, 0, b);
    });
    this.brand = b.id;
    this.#renderBrands();
    this.app.banner(`${name} added`, "It has no stores yet, and Setup starts a world only when every brand runs one: stores are made in the Micro world and put on the map in the Macro world (Stores layer).");
  }

  #askRemoveBrand(b) {
    const d = this.world.draft;
    if (d.brands.length <= 1) { this.app.banner("A world needs a brand", "This is the only one."); return; }
    const stores = d.stores.filter((s) => s.brand === b.id);
    const node = el("div", { class: "confirm" }, el("p", { text: stores.length
      ? `Remove ${b.name} and the ${stores.length} store${stores.length === 1 ? "" : "s"} it runs: ${stores.map((s) => s.name).join(", ")}?`
      : `Remove ${b.name}? It runs no stores.` }),
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn small danger", text: "Remove", onclick: () => {
        this.world.edit((w) => {
          w.brands = w.brands.filter((x) => x.id !== b.id);
          w.stores = w.stores.filter((s) => s.brand !== b.id);
          for (const x of w.brands) for (const e of x.calendar.offers) e.also_at = e.also_at.filter((id) => id !== b.id);
        });
        this.confirm = null; this.#renderBrands();
      } }),
      el("button", { type: "button", class: "btn small", text: "Keep", onclick: () => { this.confirm = null; this.#renderBrands(); } })));
    this.confirm = { kind: "brand", node };
    this.#renderBrands();
  }

  // The selected brand's settings.
  #brandSettings(b) {
    const d = this.world.draft; const schema = this.world.schema; const F = schema.fields;
    const out = [];
    const lev = (k) => settingLever(schema.levers[k], { value: b.levers[k], onChange: async (v) => {
      this.world.live((w) => {
        const x = w.brands.find((y) => y.id === b.id); if (!x) return;
        x.levers[k] = v;
        if (["cashiers", "assistants", "skill", "scan_s"].includes(k)) {
          for (const s of w.stores) if (s.brand === b.id) {
            const L = w.layouts.find((l) => l.id === s.layout);
            s.staff[k] = k === "cashiers" && L ? Math.max(1, Math.min(v, layoutCapacity(L.rows).tills || 1)) : v;
          }
        }
      });
      await this.app.set("lever", k, v, { brand: b.id });
    } }).root;

    const price = card(`${b.name}: price and marketing`, { right: tag(true) });
    price.body.append(el("div", { class: "settings-grid" }, lev("price"), lev("ad")),
      el("p", { class: "note", text: "How much each segment likes this brand is set under Shoppers." }));
    const staff = card("Staff, in every store of the brand", { right: tag(true) });
    staff.body.append(el("div", { class: "settings-grid" }, lev("cashiers"), lev("assistants"), lev("skill"), lev("scan_s")),
      el("p", { class: "note", text: "Sets every one of the brand's stores; one store can then be changed on its own (Macro world, Stores)." }));

    const stock = card("Stock");
    const alloc = select({ label: "Size allocation to stores", value: b.stock.allocation, options: [
      { value: "flat", label: "Flat: the market's size curve" }, { value: "learned", label: "Learned: each store's own size mix" }],
    onChange: (v) => this.#liveStock(b, "allocation", v) });
    const st = (k) => settingLever(F.stock[k], { value: b.stock[k], onChange: (v) => (LIVE_STOCK.includes(k) ? this.#liveStock(b, k, v) : this.world.edit(() => { b.stock[k] = v; })) }).root;
    // The plan: units a week for each category the brand sells (has products
    // in), in the world's order. One it has just started selling has no
    // number yet, and Setup waits for one.
    const sold = d.categories.filter((c) => b.range.some((p) => p.category === c.id));
    const unplanned = el("div", { class: "bad" });
    const sayUnplanned = () => {
      const missing = sold.filter((c) => b.stock.plan[c.id] === undefined).map((c) => c.name);
      unplanned.textContent = missing.length ? `${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no planned units yet: Setup won't start this world until ${missing.length === 1 ? "it has" : "they have"}.` : "";
    };
    const plan = el("div", { class: "plan-grid" }, ...sold.map((c) => numberField({ label: c.name, value: b.stock.plan[c.id], min: F.plan.min, max: F.plan.max,
      onChange: (v) => {
        this.world.edit(() => { b.stock.plan = Object.fromEntries(sold.filter((x) => x.id === c.id || b.stock.plan[x.id] !== undefined).map((x) => [x.id, x.id === c.id ? v : b.stock.plan[x.id]])); });
        sayUnplanned();
      } }).root));
    sayUnplanned();
    const reps = b.calendar.replenishment.length; const mds = b.calendar.markdowns.length; const bare = unreplenished(b, d).length;
    stock.body.append(el("h3", { class: "setup-heading" }, "Sending stock to the stores ", tag(true)),
      el("div", { class: "settings-grid" }, alloc.root, st("lead_days"), st("opening_weeks")),
      el("p", { class: "note", text: `${possessive(b.name)} calendar (Range and calendar) says when and how much it orders, and when it marks down: ${reps ? plural(reps, "replenishment entry", "replenishment entries") : "no replenishment"} and ${mds ? plural(mds, "markdown") : "no markdowns"}.${bare ? ` ${plural(bare, "product")} no replenishment entry covers get${bare === 1 ? "s" : ""} the opening allocation and nothing more.` : ""} The lead time and the size allocation apply to every order.` }),
      el("h3", { class: "setup-heading" }, "What it costs ", tag(true)),
      el("div", { class: "settings-grid" }, st("delivery_fee"), st("unit_fee"), st("salvage")),
      el("p", { class: "note", text: "A store has a delivery on each day stock arrives for it, and every unit that leaves the DC is charged, as it leaves. At the season's end, the stock left (in the stores, on the way and at the DC) is written down to what it fetches, in the brand's contribution on the last day." }),
      el("h3", { class: "setup-heading" }, "The season's buy ", tag(false)),
      el("div", { class: "settings-grid" }, st("season_buy")),
      el("div", { class: "field" }, el("span", { text: "Planned units a week in a standard store, for each category it sells (the plan the season's buy is made from), shared among the category's products in the stores that week" }), plan, unplanned),
      el("p", { class: "note", text: "Its products, their prices and costs, its calendar and price rules: Range and calendar." }));

    out.push(price.root, staff.root, stock.root, this.#onlineCard(b), this.#loyaltyCard(b));
    return out;
  }

  // The brand's online store (if it has one) and its return policy (wait
  // for Setup).
  #onlineCard(b) {
    const F = this.world.schema.fields;
    const c = card("Online store and returns", { right: tag(false) });
    const box = el("div", { hidden: !b.online.on });
    const on = checkbox({ label: `${b.name} sells online`, checked: b.online.on, onChange: (v) => { this.world.edit(() => { b.online.on = v; }); box.hidden = !v; } });
    const ol = (k) => settingLever(F.online[k], { value: b.online[k], onChange: (v) => this.world.edit(() => { b.online[k] = v; }) }).root;
    const rt = (k) => settingLever(F.returns[k], { value: b.returns[k], onChange: (v) => this.world.edit(() => { b.returns[k] = v; }) }).root;
    box.append(el("div", { class: "settings-grid" }, ol("delivery_days"), ol("delivery_charge"), ol("fulfilment_cost"), ol("shipping_cost"), ol("plan_stores")),
      el("p", { class: "note", text: "Every household can order online: no trip, no queues, no fitting rooms. An order comes from the DC in the shopper's size, and reaches them after the delivery days. Each one costs the brand its picking and packing and its shipping; the shopper pays the delivery charge. The online store's planned sales, as standard stores' worth, are added to the season's buy. Each segment's taste for shopping online is set under Shoppers." }));
    c.body.append(on.root, box, el("h3", { class: "setup-heading", text: "Returns" }), el("div", { class: "settings-grid" }, rt("window_days"), rt("post_cost")),
      el("p", { class: "note", text: "Anything bought may come back within the window, counted from the day it reaches the household. It's taken to the brand's nearest store in reach, and back to the tills; with none in reach, it's posted to the DC, the brand paying the postage for each parcel. Items bought online come back most, items tried on in a fitting room least. How often each segment returns things is set under Shoppers. The refund is what was paid. A window of 0 days takes no returns." }));
    return c.root;
  }

  async #liveStock(b, k, v) {
    this.world.live((w) => { const x = w.brands.find((y) => y.id === b.id); if (x) x.stock[k] = v; });
    await this.app.set("stock", k, v, { brand: b.id });
  }

  // Loyalty tiers: the ladder, each tier's share and the spend that earns
  // it (wait for Setup). The lowest tier needs no spend.
  #loyaltyCard(b) {
    const schema = this.world.schema; const F = schema.fields;
    const L = b.loyalty;
    const c = card("Loyalty tiers", { sub: "lowest first · households start by their taste for the brand · earned by spend", right: tag(false) });
    const cols = Object.keys(F.tier);
    const total = el("span", { class: "sub" });
    const sum = () => { const s = L.tiers.reduce((a, t) => a + t.share, 0); total.textContent = `shares add up to ${fmt.pct(s, 1)}`; total.classList.toggle("bad", Math.abs(s - 1) > 0.005); };
    sum();
    const table = el("table", { class: "data tiers" }, el("thead", {}, el("tr", {}, el("th", { text: "Tier" }), ...cols.map((k) => el("th", { class: "num", text: F.tier[k].label })), el("th"))),
      el("tbody", {}, ...L.tiers.map((t) => el("tr", {},
        el("td", {}, textField({ label: "Tier name", hideLabel: true, value: t.name, maxLength: 30, onChange: (v) => { this.world.edit(() => { t.name = v; }); } }).root),
        ...cols.map((k) => el("td", { class: "num" }, this.#tierField(L, t, k, F, sum))),
        el("td", {}, L.tiers.length > 1 ? el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${t.name}`, text: "×", onclick: () => {
          this.world.edit(() => {
            L.tiers = L.tiers.filter((x) => x.id !== t.id);
            for (const e of [...b.calendar.promotions, ...b.calendar.offers]) e.tiers = e.tiers.filter((id) => id !== t.id);
            if (L.tiers[0]) L.tiers[0].spend = 0;
          });
          this.#renderBrands();
        } }) : null)))));
    const add = el("button", { type: "button", class: "btn small", text: "Add tier", disabled: L.tiers.length >= schema.limits.tiers || null, onclick: () => {
      const top = L.tiers.at(-1);
      const name = newName(L.tiers, "New tier");
      this.world.edit(() => {
        const t = { ...clone(top), id: newId(L.tiers, name), name, share: 0, spend: Math.max(50, 5 * Math.round((1.5 * top.spend) / 5)) };
        // Promotions and offers that reach every tier go on reaching every tier.
        for (const e of [...b.calendar.promotions, ...b.calendar.offers]) if (L.tiers.every((x) => e.tiers.includes(x.id))) e.tiers.push(t.id);
        L.tiers.push(t);
      });
      this.#renderBrands();
    } });
    c.body.append(el("div", { class: "table-scroll" }, table), el("div", { class: "row" }, add, total),
      el("p", { class: "note", text: "Pull adds to the appeal of the brand's stores; price sensitivity, memory of bad visits, radius and response to offers multiply the household's usual ones, at this brand." }),
      el("h3", { class: "setup-heading", text: "Earning and losing a tier" }),
      el("p", { class: "note", text: `A tier is earned by what a household spends with ${b.name} in a season (what it pays, after markdowns, promotions and coupons, less what it gets back for returns). Households start where last season's spend put them: in the shares above, those who like ${b.name} most highest, each having spent at least its tier's spend. The evening a household's spend this season reaches a higher tier's, it moves up, and it keeps its tier to the season's end, even if a return takes its spend back below. Then it stands where the season's net spend puts it: it kept its tier, moved up, or dropped. The Offers tab counts each, as the season goes.` }));
    return c.root;
  }

  // One number of a tier: its share (typed as a percentage), the spend that
  // earns it (none for the lowest), or how it changes the household.
  #tierField(L, t, k, F, sum) {
    const first = L.tiers[0] === t;
    const f = numberField({ label: `${F.tier[k].label}, ${t.name}`, hideLabel: true, value: k === "share" ? Math.round(t[k] * 1000) / 10 : t[k],
      min: k === "share" ? 0 : F.tier[k].min, max: k === "share" ? 100 : F.tier[k].max, step: k === "share" ? 0.5 : k === "spend" ? 5 : F.tier[k].step,
      onChange: (v) => { this.world.edit(() => { t[k] = k === "share" ? v / 100 : v; }); sum(); } });
    if (k === "spend" && first) { f.input.disabled = true; f.input.title = "The lowest tier needs no spend"; }
    return f.root;
  }

  // ---- Shoppers -----------------------------------------------------------------------------------

  #renderShoppers() {
    const d = this.world.draft; const schema = this.world.schema; const F = schema.fields;
    if (!d.segments.some((s) => s.id === this.segment)) this.segment = d.segments[0]?.id;
    const seg = d.segments.find((s) => s.id === this.segment);

    const list = el("div", { class: "brand-list" }, ...d.segments.map((s) => el("div", {
      class: `brand-row${s.id === this.segment ? " is-on" : ""}`, onclick: (ev) => { if (ev.target.closest("input,button")) return; this.segment = s.id; this.#renderShoppers(); } },
    colourField({ label: `Colour of ${s.name}`, value: s.colour, onChange: (v) => this.world.edit(() => { s.colour = v; }) }).root,
    textField({ label: "Segment name", hideLabel: true, value: s.name, onChange: (v) => this.world.edit(() => { s.name = v; }) }).root,
    el("span", {}),
    d.segments.length > 1 ? el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${s.name}`, text: "×", onclick: () => this.#removeSegment(s) }) : el("span"))),
    el("button", { type: "button", class: "btn small", text: "Add segment", disabled: d.segments.length >= schema.limits.segments || null, onclick: () => this.#addSegment() }));
    const left = card("Segments", { sub: "who shops · at Setup" });
    left.body.append(list, el("p", { class: "note", text: "A new segment starts at 0% in every area's mix (Macro world, Areas), so nothing changes until it's given a share." }));

    const market = card("The whole market", { right: tag(true) });
    market.body.append(el("div", { class: "settings-grid" }, ...MARKET_SHOWN.map((k) => settingLever(F.market[k], { value: d.market[k], onChange: async (v) => {
      this.world.live((w) => { w.market[k] = v; });
      await this.app.set("market", k, v);
    } }).root)));

    const right = el("div", { class: "grid" });
    if (seg) {
      const cols = card(`${seg.name}`, { sub: "how they shop", right: tag(false) });
      const setS = (k) => (v) => this.world.edit(() => { seg[k] = v; });
      // The radius runs from a walk to a country: typed in, not slid.
      cols.body.append(el("div", { class: "settings-grid two-col" }, ...Object.keys(F.segment).map((k) => (k === "radius_km"
        ? numberField({ label: F.segment[k].label, value: seg[k], min: F.segment[k].min, max: F.segment[k].max, step: 0.5, onChange: setS(k) }).root
        : settingLever(F.segment[k], { value: seg[k], onChange: setS(k) }).root))));
      const taste = card("Taste for each category", { sub: "how likely they browse it", right: tag(false) });
      taste.body.append(el("div", { class: "settings-grid two-col" }, ...d.categories.map((c) => settingLever(F.taste, { label: c.name, value: seg.category_taste[c.id] ?? 0,
        onChange: (v) => this.world.edit(() => { seg.category_taste[c.id] = v; }) }).root)));
      // Held by each brand in the world file (its fit), set here per segment.
      const fit = card("Taste for each brand", { sub: "how much they like each brand's look", right: tag(false) });
      fit.body.append(el("div", { class: "settings-grid two-col" }, ...d.brands.map((b) => lever({ label: b.name, min: -3, max: 3, step: 0.1, value: b.fit[seg.id] ?? 0, format: fmt.num1,
        onChange: (v) => this.world.edit(() => { b.fit[seg.id] = v; }) }).root)));
      const resp = card("How they respond to an offer", { sub: "while they hold its coupon · hidden: offers are measured against their holdout", right: tag(false) });
      resp.body.append(el("div", { class: "settings-grid two-col" }, ...Object.keys(F.response).map((f) => settingLever(F.response[f], {
        value: seg.offer_response[f], onChange: (v) => this.world.edit(() => { seg.offer_response[f] = v; }) }).root)),
        el("p", { class: "note", text: "The lift in their daily chance of shopping, and the pull toward the brands the coupon is good at, beside the discount itself. Their tier's response to offers multiplies both, and both fade as a brand sends them more." }));
      right.append(cols.root, taste.root, fit.root, resp.root);
    }
    this.panels.shoppers.replaceChildren(this.#categoriesCard(), el("div", { class: "grid setup-two" }, el("div", { class: "grid" }, left.root, market.root), right));
  }

  // The world's categories: what's sold, market-wide. Each brand's range
  // picks from them; each segment has a taste for each; each layout paints
  // a category's racks with its key.
  #categoriesCard() {
    const d = this.world.draft; const schema = this.world.schema;
    const c = card("Categories", { sub: `${d.categories.length} of at most ${schema.limits.categories} · what every brand's range is sorted into`, right: tag(false) });
    const sold = (id) => d.brands.filter((b) => b.range.some((p) => p.category === id));
    const rows = d.categories.map((cat) => {
      const used = new Set(d.categories.filter((x) => x !== cat).map((x) => x.key));
      const keys = schema.category_keys.filter((k) => !used.has(k));
      const by = sold(cat.id);
      return el("tr", {},
        el("td", {}, colourField({ label: `Colour of ${cat.name}`, value: cat.colour, onChange: (v) => this.world.edit(() => { cat.colour = v; }) }).root),
        el("td", {}, textField({ label: "Category name", hideLabel: true, value: cat.name, maxLength: 30, onChange: (v) => { this.world.edit(() => { cat.name = v; }); } }).root),
        el("td", {}, select({ label: `Rack key of ${cat.name}`, hideLabel: true, value: cat.key, options: keys.map((k) => ({ value: k, label: k })), onChange: (v) => this.#rekey(cat, v) }).root),
        el("td", { class: "center" }, checkbox({ label: "", checked: cat.try_on, title: `Shoppers try ${cat.name} on`, onChange: (v) => this.world.edit(() => { cat.try_on = v; }) }).root),
        el("td", { class: "num" }, numberField({ label: `Typical price of ${cat.name}`, hideLabel: true, value: cat.price, min: schema.fields.category.price.min, max: schema.fields.category.price.max,
          onChange: (v) => this.world.edit(() => { cat.price = v; }) }).root),
        el("td", { class: "sub", text: by.length ? by.map((b) => b.name).join(", ") : "no one" }),
        el("td", {}, d.categories.length > 1 ? el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${cat.name}`, text: "×", onclick: () => this.#removeCategory(cat) }) : null));
    });
    const table = el("table", { class: "data categories" }, el("thead", {}, el("tr", {}, el("th"), el("th", { text: "Category" }), el("th", { text: "Rack key" }),
      el("th", { text: "Tried on" }), el("th", { class: "num", text: "Typical price ($)" }), el("th", { text: "Sold by" }), el("th"))), el("tbody", {}, ...rows));
    const add = el("button", { type: "button", class: "btn small", text: "Add category", disabled: d.categories.length >= schema.limits.categories || null, onclick: () => this.#addCategory() });
    c.body.append(el("div", { class: "table-scroll" }, table), el("div", { class: "row" }, add),
      el("p", { class: "note", text: "The typical price is what shoppers weigh a product's price against. A layout paints a category's racks with its key; changing the key repaints them. A category a brand sells needs racks in every layout its stores use." }));
    return c.root;
  }

  #addCategory() {
    const d = this.world.draft; const schema = this.world.schema;
    const used = new Set(d.categories.map((x) => x.key));
    const key = schema.category_keys.find((k) => !used.has(k));
    const name = newName(d.categories, "New category");
    const last = d.categories.at(-1);
    this.world.edit((w) => {
      const id = newId(w.categories, name);
      w.categories.push({ id, name, key, colour: shiftHue(last?.colour ?? "#2a78d6", 53), try_on: true, price: 50 });
      for (const s of w.segments) s.category_taste[id] = 1;
    });
    this.#renderShoppers();
  }

  // A category some brand sells can't go: its products would have nowhere to be.
  #removeCategory(cat) {
    const d = this.world.draft;
    const by = d.brands.filter((b) => b.range.some((p) => p.category === cat.id));
    if (by.length) { this.app.banner(`${cat.name} can't be removed`, `${by.map((b) => b.name).join(", ")} sell${by.length === 1 ? "s" : ""} products in it: move them to another category first (Range and calendar).`); return; }
    this.world.edit((w) => {
      w.categories = w.categories.filter((x) => x.id !== cat.id);
      for (const s of w.segments) delete s.category_taste[cat.id];
      for (const b of w.brands) {
        delete b.stock.plan[cat.id];
        for (const e of [...b.calendar.promotions, ...b.calendar.markdowns, ...b.calendar.replenishment]) if (e.on === "categories") e.items = e.items.filter((id) => id !== cat.id);
      }
    });
    this.#renderShoppers();
  }

  // A new key for a category: its racks on every layout are repainted with it.
  #rekey(cat, key) {
    const old = cat.key;
    this.world.edit((w) => {
      const c = w.categories.find((x) => x.id === cat.id); c.key = key;
      for (const L of w.layouts) L.rows = L.rows.map((r) => r.split(old).join(key));
    });
    this.layoutEditor.reload();
    this.#renderShoppers();
  }

  #addSegment() {
    const d = this.world.draft;
    const src = d.segments.find((s) => s.id === this.segment) ?? d.segments[0];
    const name = newName(d.segments, "New segment");
    const s = { ...clone(src), id: newId(d.segments, name), name, colour: shiftHue(src.colour, 61) };
    this.world.edit((w) => {
      w.segments.push(s);
      for (const a of [...w.macro.areas, w.macro.default_makeup]) a.segment_mix[s.id] = 0;
      for (const b of w.brands) b.fit[s.id] = b.fit[src.id] ?? 0;
    });
    this.segment = s.id;
    this.#renderShoppers();
  }

  // Its share of every mix goes to the rest, in proportion.
  #removeSegment(s) {
    this.world.edit((w) => {
      w.segments = w.segments.filter((x) => x.id !== s.id);
      for (const a of [...w.macro.areas, w.macro.default_makeup]) {
        const gone = a.segment_mix[s.id] ?? 0; delete a.segment_mix[s.id];
        const rest = Object.values(a.segment_mix).reduce((x, y) => x + y, 0);
        if (gone > 0 && rest > 0) for (const k of Object.keys(a.segment_mix)) a.segment_mix[k] = Math.round((a.segment_mix[k] / rest) * 1e4) / 1e4;
      }
      for (const b of w.brands) delete b.fit[s.id];
    });
    this.#renderShoppers();
  }

  // ---- Season ---------------------------------------------------------------------------------------

  #renderSeason() {
    const d = this.world.draft;
    const seed = numberField({ label: "Random seed (at Setup)", value: d.seed, min: 1, max: 2147483647, onChange: (v) => this.world.edit(() => { d.seed = Math.round(v); }) });
    const L = this.world.schema.fields.season.days;
    const length = numberField({ label: `${L.label} (at Setup)`, value: d.season_days, min: L.min, max: L.max, onChange: (v) => this.world.edit(() => { d.season_days = Math.round(v); }) });
    const c = card("Season", { right: tag(false) });
    // A new length redraws the demand events, whose days run to it.
    length.input.addEventListener("change", () => this.eventEditor.show());
    this.factsLine = el("p", { class: "note" });   // refreshed by update(), not redrawn
    c.body.append(length.root, el("p", { class: "note", text: "Products land and calendar entries run within the season's days. Day 1 is a Monday." }), seed.root, el("p", { class: "note", text: "The same world and seed give the same season. Households are drawn from the map the same way whatever the seed." }), this.factsLine);
    this.#seasonFacts();
    this.panels.season.replaceChildren(el("div", { class: "grid season-grid" }, c.root, this.eventEditor.show()));
  }

  // The line about the season running now, from the last report.
  #seasonFacts() {
    const f = this.facts;
    if (!this.factsLine) return;
    this.factsLine.hidden = !f;
    if (f) this.factsLine.textContent = `Running now: ${f.world}, ${fmt.int(f.households)} households, ${f.stores.length} stores${f.stranded ? `; ${fmt.int(f.stranded)} households have no store in reach` : ""}.`;
  }
}

const possessive = (name) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

// A colour turned round the colour wheel, for a new brand or segment.
function shiftHue(hex, deg) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) / 255; let g = ((n >> 8) & 255) / 255; let b = (n & 255) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2;
  let h = 0; let s = 0;
  if (max !== min) {
    const dd = max - min; s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
    h = max === r ? (g - b) / dd + (g < b ? 6 : 0) : max === g ? (b - r) / dd + 2 : (r - g) / dd + 4; h *= 60;
  }
  h = (h + deg) % 360;
  const k = (m) => (m + h / 30) % 12; const a = s * Math.min(l, 1 - l);
  const f = (m) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(m) - 3, Math.min(9 - k(m), 1)))));
  return `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
