// The micro world's editor, on the Setup tab: store layouts, painted. The
// world's layouts on the left (how big, how many stores use each), the
// plan in the middle (drawn as the Store tab draws floors), and on the
// right the tiles, the layout's properties, and what the model says about
// it: its problems (click one to see its tiles) and, once it has none, its
// floor area, doors, fitting rooms, tills, queue places against the
// stores' queue limits, rack tiles, faces and places to stand per
// category, the longest walk from a door and a fetch from the stockroom.
//
// On the plan, what the model reads from it (layout_uses in floors.R): the
// doors, the places to stand at each category's racks, the cubicles and
// tills numbered in the order staff open them with where their shopper
// stands, each queue's places in order, where assistants fetch from the
// stockroom, and rack tiles with no floor beside them (hatched: not rack
// space).
//
// Tools beyond the canvas's own: the queue tool (drag a queue out from its
// head: one head, a single line joined to it, replacing the old one) and
// stamps (a walled cubicle, a till unit; [ and ] turn them). Undo also
// brings back the staff that a stroke took from the stores running the
// layout.

import { el, fmt, card, select, textField, settingLever, cssVar, numberField } from "./ui.js";
import { GridEditor, toolbar } from "./grid-editor.js";
import { clone, newId, newName, worldText, download, pickFile } from "./world-store.js";

// The tiles, grouped as on the palette (model/floors.R reads them), each
// with what it does in the model where that isn't plain. Racks are the
// world's categories, each painted with its key.
const STRUCTURE = [
  { group: "Structure", tiles: [[".", "Floor"], ["#", "Wall"], ["=", "Door", "on the outer edge; each run is an entrance"],
    ["X", "Stockroom", "looks only"], ["x", "Stockroom door", "assistants fetch sizes from here"]] },
  { group: "Fitting rooms", tiles: [["F", "Cubicle", "touching F tiles are one cubicle"], ["W", "Queue head"], ["w", "Queue line"]] },
  { group: "Tills", tiles: [["$", "Counter"], ["c", "Cashier's place"], [":", "Behind the counter", "looks only"], ["Q", "Queue head"], ["q", "Queue line"]] },
];
export function floorTiles(categories = []) {
  return [STRUCTURE[0], { group: "Racks", note: "only rack tiles with floor beside them hold stock", tiles: categories.map((c) => [c.key, c.name]) }, ...STRUCTURE.slice(1)];
}

// Compound fixtures, put down whole: a cubicle walled on three sides (so
// cubicles side by side never merge), open below; a till's counter with
// its cashier behind, the customer's side to the left. A space leaves the
// plan as it is.
const STAMPS = [
  { id: "cubicle", name: "Walled cubicle", ch: "F", rows: ["####", "#FF#", "#FF#", "#FF#"] },
  { id: "till", name: "Till unit", ch: "c", rows: ["$::", "$c:", "$::"] },
];
const QUEUES = { W: ["W", "w"], w: ["W", "w"], Q: ["Q", "q"], q: ["Q", "q"] };
const QUEUE_TOOL = { id: "queue", label: "Queue: drag from its head (the queue picked on the palette)", key: "u", kind: "path",
  icon: "M4 11h3v2H4zm5 0h3v2H9zm5 0h3v2h-3zM19 8l4 4-4 4z" };
const STAMP_TOOL = { id: "stamp", label: "Stamp", key: "t", kind: "stamp", icon: "" };
const ANCHORS = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"];

// Tills and fitting rooms a picture has: cashier's places, and blocks of F.
export function layoutCapacity(rows) {
  const H = rows.length; const W = rows[0]?.length ?? 0;
  let tills = 0; const seen = new Uint8Array(W * H); let cubicles = 0;
  const at = (r, c) => rows[r][c];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (at(r, c) === "c") tills++;
    if (at(r, c) !== "F" || seen[r * W + c]) continue;
    cubicles++;
    const stack = [[r, c]];
    while (stack.length) {
      const [rr, cc] = stack.pop();
      if (rr < 0 || cc < 0 || rr >= H || cc >= W || seen[rr * W + cc] || at(rr, cc) !== "F") continue;
      seen[rr * W + cc] = 1;
      stack.push([rr + 1, cc], [rr - 1, cc], [rr, cc + 1], [rr, cc - 1]);
    }
  }
  return { tills, cubicles };
}

// The colour of each tile, as the Store tab's floor draws it (racks in their
// category's colour).
export function floorColour(ch, root, categories = []) {
  const v = (name) => cssVar(name, root);
  const a = (c, alpha) => withAlpha(c, alpha);
  const cat = categories.find((c) => c.key === ch);
  if (cat) return a(cat.colour, 0.55);
  switch (ch) {
    case ".": return v("--floor-bg");
    case "#": return v("--floor-wall");
    case "=": return a(v("--good"), 0.5);
    case "F": return a(v("--fitting"), 0.3);
    case "$": return v("--muted");
    case ":": case "c": return ch === "c" ? a(v("--ink"), 0.55) : a(v("--muted"), 0.18);
    case "X": return a(v("--muted"), 0.3);
    case "x": return a(v("--muted"), 0.55);
    case "W": case "Q": return a(v("--muted"), 0.35);
    case "w": case "q": return a(v("--muted"), 0.12);
    default: return "#ff00ff";
  }
}

function withAlpha(colour, alpha) {
  const c = colour.trim();
  if (c.startsWith("#")) {
    const h = c.length === 4 ? c.slice(1).split("").map((x) => x + x).join("") : c.slice(1);
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`;
  }
  return c;
}

// A new layout: walls round a floor, with a door in the middle of the
// south wall.
function blankShell(W = 40, H = 24) {
  const rows = [];
  for (let r = 0; r < H; r++) {
    let row = "";
    for (let c = 0; c < W; c++) row += r === 0 || r === H - 1 || c === 0 || c === W - 1 ? "#" : ".";
    rows.push(row);
  }
  const mid = Math.floor(W / 2) - 2;
  rows[H - 1] = rows[H - 1].slice(0, mid) + "====" + rows[H - 1].slice(mid + 4);
  return rows;
}

export class LayoutEditor {
  constructor(root, app) {
    this.app = app; this.world = app.world;
    this.current = null; this.report = null; this.checkTimer = 0; this.checkSeq = 0;

    this.listBox = el("div", { class: "layout-list" });
    this.newSel = select({ label: "New layout", hideLabel: true, value: "", options: [{ value: "", label: "New…" }], onChange: (v) => { if (v) this.#create(v); this.newSel.set(""); } });
    const left = card("Layouts", { sub: "in this world" });
    left.body.append(this.listBox, el("div", { class: "row wrap" }, this.newSel.root,
      el("button", { type: "button", class: "btn small", text: "Duplicate", onclick: () => this.#duplicate() }),
      el("button", { type: "button", class: "btn small", text: "Delete", onclick: () => this.#delete() })),
    el("div", { class: "row wrap" },
      el("button", { type: "button", class: "btn small", text: "Export layout", onclick: () => this.#export() }),
      el("button", { type: "button", class: "btn small", text: "Import layout", onclick: () => this.#import() })));
    this.leftNote = el("p", { class: "note" });
    left.body.append(this.leftNote);

    const wrap = el("div", { class: "editor-canvas layout-editor-canvas" });
    this.stampId = null;
    this.editor = new GridEditor(wrap, {
      layers: [{ id: "floor", erase: ".", colour: (ch) => floorColour(ch, this.editor?.wrap ?? document.documentElement, this.categories) }],
      cellPx: 10,
      tools: [{ ...QUEUE_TOOL, paint: (cells) => this.#queueCells(cells) }, STAMP_TOOL],
      onStroke: () => this.#stroked(),
      onPick: () => { this.editor.setTool("pencil"); this.#renderPalette(); },
      onToolChange: (t) => this.#toolChanged(t),
      onHover: (cell) => { this.hoverText.textContent = cell ? `${this.#tileName(this.editor.at(0, cell.r, cell.c))} · ${fmt.num1((cell.c + 0.5) / 2)} m, ${fmt.num1((cell.r + 0.5) / 2)} m from the top left` : ""; },
      drawOver: (ctx, ed) => this.#drawUses(ctx, ed),
      snapshot: () => this.#staffOf(),
      restore: (staff) => this.#restoreStaff(staff),
    });
    this.onStaff = null;                   // the stores' staff changed here (Setup redraws the store editor)
    this.editor.setPaint("#");
    this.hoverText = el("div", { class: "editor-hover" });
    this.centre = card("Plan", { sub: "one tile is half a metre" });
    this.centre.body.append(el("div", { class: "editor-bar" }, toolbar(this.editor)), wrap, el("div", { class: "editor-foot" }, this.hoverText));

    this.palette = el("div", { class: "palette grouped" });
    this.props = el("div");
    this.problemsBox = el("div", { class: "problems-box" });
    this.summaryBox = el("div");
    this.sizeBox = el("div");
    const right = el("div", { class: "grid" });
    const pal = card("Tiles"); pal.body.append(this.palette);
    const pr = card("Properties"); pr.body.append(this.props, this.sizeBox);
    const chk = card("What the model says", { sub: "read with the simulation's own code" }); chk.body.append(this.problemsBox, this.summaryBox);
    right.append(pal.root, chk.root, pr.root);
    this.root = el("div", { class: "grid layout-editor" }, left.root, this.centre.root, right);
    root.append(this.root);
    this.#renderPalette();
  }

  show() {
    const d = this.world.draft; if (!d) return;
    this.world.loadPrefabs().then((p) => this.newSel.setOptions([{ value: "", label: "New…" }, { value: "__blank", label: "Blank shell" },
      ...p.map((x) => ({ value: x.id, label: `Copy of ${x.name}` }))], "")).catch(() => {});
    if (!d.layouts.some((l) => l.id === this.current)) this.current = d.layouts[0]?.id ?? null;
    this.#renderPalette();
    this.editor.refreshColours();
    this.#load();
    this.#renderList();
  }

  reload() { this.loadedKey = null; this.editor.clearHistory(); this.show(); }

  get layout() { return this.world.draft?.layouts.find((l) => l.id === this.current); }
  get categories() { return this.world.draft?.categories ?? []; }

  #tileName(ch) {
    for (const g of floorTiles(this.categories)) for (const [c, n] of g.tiles) if (c === ch) return g.group === "Racks" ? `${n} racks` : `${n}${g.group === "Fitting rooms" || g.group === "Tills" ? ` (${g.group.toLowerCase()})` : ""}`;
    return ch;
  }

  // ---- Undo: the staff a stroke took ------------------------------------------------------

  // Tills and fitting rooms open at each store running the layout: a stroke
  // that removes some lowers them, and undo puts them back.
  #staffOf() {
    const L = this.layout;
    return Object.fromEntries((this.world.draft?.stores ?? []).filter((s) => s.layout === L?.id)
      .map((s) => [s.id, { cashiers: s.staff.cashiers, fitting_rooms: s.staff.fitting_rooms }]));
  }

  #restoreStaff(staff) {
    this.world.edit((d) => {
      for (const s of d.stores) if (staff[s.id] && s.layout === this.current) Object.assign(s.staff, staff[s.id]);
    });
    this.onStaff?.();
  }

  // ---- The queue tool and stamps ------------------------------------------------------------

  // The queue tool paints the queue picked on the palette (the till queue
  // unless a fitting-room queue tile is picked).
  #queueKind() { return QUEUES[this.editor.paint] ?? QUEUES.Q; }

  #toolChanged(tool) {
    if (tool === "queue" && !QUEUES[this.editor.paint]) this.editor.setPaint("Q");
    if (tool !== "stamp") this.stampId = null;
    this.#renderPalette();
  }

  // A queue dragged out from its head: the old queue of that kind becomes
  // floor, the first cell its head and the rest its line, one after another.
  #queueCells(path) {
    const [head, line] = this.#queueKind();
    const ed = this.editor; const L = ed.layers[0];
    const on = new Set(path.map(([r, c]) => r * ed.W + c));
    const out = [];
    const h = head.charCodeAt(0); const l = line.charCodeAt(0);
    for (let i = 0; i < L.data.length; i++) if ((L.data[i] === h || L.data[i] === l) && !on.has(i)) out.push([Math.floor(i / ed.W), i % ed.W, "."]);
    path.forEach(([r, c], k) => out.push([r, c, k ? line : head]));
    return out;
  }

  #pickStamp(id) {
    this.stampId = id;
    this.editor.setStamp(STAMPS.find((x) => x.id === id).rows.slice());
    this.editor.setTool("stamp");
  }

  #load() {
    const L = this.layout;
    if (!L) return;
    const key = `${L.id}|${L.rows.join("\n")}`;
    if (key !== this.loadedKey) {
      const same = this.loadedKey?.startsWith(`${L.id}|`);
      this.editor.load([L.rows], { keepView: same });
      if (!same) this.editor.clearHistory();
      this.loadedKey = key;
    }
    this.#renderProps();
    this.#scheduleCheck(0);
  }

  #renderList() {
    const d = this.world.draft;
    const used = (id) => d.stores.filter((s) => s.layout === id);
    this.listBox.replaceChildren(...d.layouts.map((L) => {
      const n = used(L.id).length;
      return el("button", { type: "button", class: `layout-row${L.id === this.current ? " is-on" : ""}`, onclick: () => { this.current = L.id; this.#load(); this.#renderList(); } },
        el("b", { text: L.name }), el("span", { class: "sub", text: `${fmt.num1(L.rows[0].length / 2)} × ${fmt.num1(L.rows.length / 2)} m · ${n ? `used by ${n} store${n === 1 ? "" : "s"}` : "not used"}` }));
    }));
    this.leftNote.textContent = "A layout is a floor plan any store can run; changes here reach every store that uses it at the next Setup.";
  }

  #renderPalette() {
    const tool = this.editor.tool;
    const tiles = floorTiles(this.categories).map((g) => el("div", { class: "palette-group" }, el("div", { class: "palette-title", text: g.note ? `${g.group} (${g.note})` : g.group }),
      el("div", { class: "palette-row" }, ...g.tiles.map(([ch, name, note]) => {
        const label = note ? `${name} (${note})` : name;
        return el("button", {
          type: "button", class: "swatch", role: "radio", "aria-checked": String(tool !== "stamp" && this.editor.paint === ch), title: label, "aria-label": label,
          vars: { "--c": floorColour(ch, this.editor.wrap, this.categories) },
          onclick: () => {
            this.editor.setPaint(ch);
            const keep = tool === "queue" ? QUEUES[ch] : !["erase", "pick", "select", "pan", "stamp"].includes(tool);
            if (!keep) this.editor.setTool("pencil");
            this.#renderPalette();
          },
        }, el("span", { text: ch }), el("em", { text: label }));
      }))));
    const stamps = el("div", { class: "palette-group" }, el("div", { class: "palette-title", text: "Stamps ([ and ] turn them)" }),
      el("div", { class: "palette-row" }, ...STAMPS.map((st) => el("button", {
        type: "button", class: "swatch", role: "radio", "aria-checked": String(tool === "stamp" && this.stampId === st.id), title: st.name, "aria-label": st.name,
        vars: { "--c": floorColour(st.ch, this.editor.wrap, this.categories) }, onclick: () => this.#pickStamp(st.id),
      }, el("span", { text: st.ch }), el("em", { text: st.name }))),
      el("button", { type: "button", class: "btn small", text: "Turn", title: "Turn the stamp a quarter (])", disabled: tool !== "stamp" || null, onclick: () => this.editor.turnStamp(1) })));
    this.palette.replaceChildren(...tiles, stamps);
  }

  #renderProps() {
    const L = this.layout; const schema = this.world.schema;
    if (!L || !schema) return;
    const d = this.world.draft;
    const name = textField({ label: "Name", value: L.name, onChange: (v) => { this.world.edit(() => { L.name = v; }); this.#renderList(); } });
    const draw = settingLever(schema.fields.layout.draw, { value: L.draw, onChange: (v) => this.world.edit(() => { L.draw = v; }),
      title: "How much more this layout attracts shoppers than a store with draw 0, in the same units as price, distance and the rest" });
    this.props.replaceChildren(name.root, draw.root, el("p", { class: "note", text: `Id: ${L.id} (a store names the layout it runs by this).` }));
    // Canvas size.
    const w = numberField({ label: "Width (tiles)", value: L.rows[0].length, min: 5, max: schema.limits.layout_w });
    const h = numberField({ label: "Height (tiles)", value: L.rows.length, min: 5, max: schema.limits.layout_h });
    let anchor = "nw";
    const anchors = el("div", { class: "anchor-grid", role: "radiogroup", "aria-label": "Keep the plan anchored to" }, ...ANCHORS.map((a) => el("button", {
      type: "button", role: "radio", "aria-checked": String(a === anchor), title: `Keep the plan at the ${a}`, onclick: (ev) => {
        anchor = a; for (const b of anchors.children) b.setAttribute("aria-checked", String(b === ev.currentTarget));
      } })));
    const apply = el("button", { type: "button", class: "btn small", text: "Resize", onclick: () => {
      const W = Number(w.input.value); const H = Number(h.input.value);
      if (W === this.editor.W && H === this.editor.H) return;
      this.editor.resize(W, H, anchor);
      this.#stroked();
    } });
    this.sizeBox.replaceChildren(el("h3", { class: "setup-heading", text: "Size" }), el("div", { class: "resize" }, w.root, h.root, el("div", { class: "field" }, el("span", { text: "Keep at" }), anchors), apply),
      el("p", { class: "note", text: `Up to ${schema.limits.layout_w} × ${schema.limits.layout_h} tiles (${schema.limits.layout_w / 2} × ${schema.limits.layout_h / 2} m).` }));
    void d;
  }

  #stroked() {
    const L = this.layout; if (!L) return;
    const rows = this.editor.rows(0);
    const cap = layoutCapacity(rows);
    let lowered = false;
    this.world.edit((d) => {
      L.rows = rows;
      // Stores running this layout can't open more tills or fitting rooms than it has.
      for (const s of d.stores) if (s.layout === L.id) {
        const cashiers = Math.max(1, Math.min(s.staff.cashiers, cap.tills || 1));
        const rooms = Math.max(1, Math.min(s.staff.fitting_rooms, cap.cubicles || 1));
        if (cashiers !== s.staff.cashiers || rooms !== s.staff.fitting_rooms) lowered = true;
        s.staff.cashiers = cashiers; s.staff.fitting_rooms = rooms;
      }
    });
    if (lowered) this.onStaff?.();
    this.loadedKey = `${L.id}|${rows.join("\n")}`;
    this.#renderList(); this.#renderProps();
    this.#scheduleCheck();
  }

  #scheduleCheck(ms = 300) {
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => this.#check(), ms);
  }

  async #check() {
    const L = this.layout; if (!L) return;
    if (!this.app.ready) { this.#scheduleCheck(500); return; }
    const seq = ++this.checkSeq;
    let r;
    try { r = await this.app.client.request("CHECK_LAYOUT", { rows: L.rows, categories: this.categories.map((c) => ({ key: c.key, name: c.name })) }); } catch (e) { r = { problems: [{ message: e.message }] }; }
    if (seq !== this.checkSeq) return;
    this.report = r;
    const problems = r.problems ?? [];
    this.editor.setHighlights([]);
    this.editor.draw();
    this.problemsBox.replaceChildren(problems.length
      ? el("div", { class: "problems" }, el("b", { text: `${problems.length} problem${problems.length === 1 ? "" : "s"}: Setup won't start a world that uses this layout until they're fixed` }),
        ...problems.map((q) => el("button", { type: "button", class: "problem", text: q.message, title: q.tiles ? "Show its tiles" : "", onclick: () => this.editor.setHighlights(q.tiles ?? []) })))
      : el("div", { class: "ok-line", text: "No problems: the model can read this layout." }));
    const marks = el("p", { class: "note", text: "On the plan: doors ringed green; a dot in a category's colour at each place to stand; cubicles, tills and queue places numbered in the order they're used, a ring where a shopper stands to try on or pay; a diamond where assistants fetch from the stockroom; hatched racks have no floor beside them, so hold nothing." });
    const s = r.summary;
    if (!s) { this.summaryBox.replaceChildren(marks); return; }
    const cats = s.categories.map((name, i) => ({ name, i })).filter((c) => s.racks[c.i] > 0);
    this.summaryBox.replaceChildren(
      el("div", { class: "stats compact" },
        ...[["Floor", `${fmt.int(s.floor_m2)} m²`], ["Size", `${fmt.num1(s.width_m)} × ${fmt.num1(s.height_m)} m`], ["Doors", fmt.int(s.doors)], ["Fitting rooms", fmt.int(s.cubicles)],
          ["Tills", fmt.int(s.tills)], ["Rack space", `${fmt.num2(s.space)}× a standard store`], ["Longest walk from a door", `${fmt.num1(s.longest_walk_m)} m`],
          ["A fetch from the stockroom", `${fmt.int(s.fetch_s)} s`, `walking ${fmt.num1(s.fetch_m)} m each way, on average`]]
          .map(([k, v, sub]) => el("div", { class: "stat" }, el("div", { class: "stat-label", text: k }), el("div", { class: "stat-value small", text: v }), sub ? el("div", { class: "stat-sub", text: sub }) : null))),
      el("table", { class: "data" }, el("thead", {}, el("tr", {}, el("th", { text: "Category" }), el("th", { class: "num", text: "Rack tiles" }), el("th", { class: "num", text: "Faces" }), el("th", { class: "num", text: "Places to stand" }))),
        el("tbody", {}, ...cats.map(({ name, i }) => el("tr", {}, el("td", { text: name }), el("td", { class: "num", text: fmt.int(s.racks[i]) }), el("td", { class: "num", text: fmt.int(s.faces[i]) }), el("td", { class: "num", text: fmt.int(s.places[i]) }))))),
      el("p", { class: "note", text: "A category's faces (its rack tiles with floor beside them) set how much of it a store running this layout plans to sell and puts on the floor, against a standard store's. Racks of a category the store's brand doesn't sell stand empty." }),
      this.#queueTable(s), marks);
  }

  // Each queue's painted places, against the longest queue the stores
  // running the layout allow: past the painted line, shoppers are drawn on
  // its last place.
  #queueTable(s) {
    const d = this.world.draft; const L = this.layout;
    const users = d.stores.filter((st) => st.layout === L?.id);
    const row = (what, places, key) => {
      const most = users.length ? Math.max(...users.map((st) => st.staff[key])) : null;
      const over = most !== null && most > places;
      const who = users.filter((st) => st.staff[key] > places).map((st) => st.name);
      return el("tr", {}, el("td", { text: what }), el("td", { class: "num", text: fmt.int(places) }),
        el("td", { class: `num${over ? " bad" : ""}`, text: most === null ? "no store" : fmt.int(most), title: over ? `Longer than the painted line at ${who.join(", ")}` : "" }));
    };
    return el("div", {}, el("table", { class: "data" },
      el("thead", {}, el("tr", {}, el("th", { text: "Queue" }), el("th", { class: "num", text: "Places painted" }), el("th", { class: "num", text: "Longest allowed" }))),
      el("tbody", {}, row("Fitting rooms", s.fr_places, "max_fr_q"), row("Tills", s.till_places, "max_till_q"))),
    el("p", { class: "note", text: "Longest allowed is the most any store running this layout lets queue (its staffing settings); shoppers past the painted line are drawn on its last place." }));
  }

  // ---- What the model reads, on the plan ------------------------------------------------------

  #drawUses(ctx, ed) {
    const u = this.report?.uses; if (!u) return;
    const z = ed.zoom; const root = ed.wrap;
    const centre = ([r, c]) => { const p = ed.toScreen(r, c); return [p.x + z / 2, p.y + z / 2]; };
    const ink = cssVar("--ink", root); const surface = cssVar("--surface", root);
    ctx.save();
    // Rack tiles with no floor beside them: hatched.
    if (u.hidden) {
      ctx.strokeStyle = withAlpha(ink.startsWith("#") ? ink : "#000000", 0.45); ctx.lineWidth = Math.max(1, z / 10);
      ctx.beginPath();
      for (const [r, c] of u.hidden) { const p = ed.toScreen(r, c); ctx.moveTo(p.x, p.y + z); ctx.lineTo(p.x + z, p.y); ctx.moveTo(p.x, p.y + z / 2); ctx.lineTo(p.x + z / 2, p.y); ctx.moveTo(p.x + z / 2, p.y + z); ctx.lineTo(p.x + z, p.y + z / 2); }
      ctx.stroke();
    }
    const dot = (cell, rad, fill, stroke) => {
      const [x, y] = centre(cell);
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = Math.max(1, z / 9); ctx.stroke(); }
    };
    // Places to stand, in their category's colour.
    for (const [r, c, k] of u.spots ?? []) dot([r, c], Math.max(1.5, z * 0.3), this.categories[k - 1]?.colour ?? ink, surface);
    // Doors.
    for (const cell of u.entrances ?? []) dot(cell, Math.max(3, z * 0.55), null, cssVar("--good", root));
    // Where a shopper stands to try on or pay, and the stockroom's openings.
    for (const cell of [...(u.openings ?? []), ...(u.till_spots ?? [])]) dot(cell, Math.max(1.5, z * 0.28), null, ink);
    for (const cell of u.stock ?? []) {
      const [x, y] = centre(cell); const h = Math.max(2.5, z * 0.35);
      ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + h, y); ctx.lineTo(x, y + h); ctx.lineTo(x - h, y); ctx.closePath();
      ctx.fillStyle = ink; ctx.fill();
    }
    // Numbers: cubicles and tills in the order staff open them, and queue
    // places from the head.
    if (z >= 7) {
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const label = (cell, text, size) => {
        const [x, y] = centre(cell);
        ctx.font = `700 ${Math.round(size)}px system-ui, sans-serif`;
        ctx.lineWidth = 3; ctx.strokeStyle = surface; ctx.strokeText(text, x, y);
        ctx.fillStyle = ink; ctx.fillText(text, x, y);
      };
      (u.cubicles ?? []).forEach((cell, i) => label(cell, String(i + 1), Math.min(13, z * 0.8)));
      (u.tills ?? []).forEach((cell, i) => label(cell, String(i + 1), Math.min(13, z * 0.8)));
      for (const line of [u.fr_line, u.till_line]) (line ?? []).forEach((cell, i) => label(cell, String(i + 1), Math.min(11, z * 0.6)));
    }
    ctx.restore();
  }

  // ---- The list's actions -------------------------------------------------------------------

  async #create(kind) {
    const d = this.world.draft;
    let rows; let base = "New layout"; let draw = 0.1;
    if (kind === "__blank") rows = blankShell();
    else {
      const p = (await this.world.loadPrefabs()).find((x) => x.id === kind);
      rows = clone(p.rows); base = `${p.name} copy`; draw = p.draw;
    }
    const name = newName(d.layouts, base);
    const L = { id: newId(d.layouts, name), name, draw, rows };
    this.world.edit((w) => { w.layouts.push(L); });
    this.current = L.id; this.#load(); this.#renderList();
  }

  #duplicate() {
    const L = this.layout; if (!L) return;
    const d = this.world.draft;
    const name = newName(d.layouts, `${L.name} copy`);
    const copy = { ...clone(L), id: newId(d.layouts, name), name };
    this.world.edit((w) => { w.layouts.push(copy); });
    this.current = copy.id; this.#load(); this.#renderList();
  }

  #delete() {
    const L = this.layout; if (!L) return;
    const d = this.world.draft;
    const users = d.stores.filter((s) => s.layout === L.id);
    if (users.length) { this.app.banner(`${L.name} can't be deleted`, `These stores use it: ${users.map((s) => s.name).join(", ")}. Give them another layout first (Stores, above).`); return; }
    if (d.layouts.length <= 1) { this.app.banner("A world needs a layout", "This is the only one."); return; }
    this.world.edit((w) => { w.layouts = w.layouts.filter((x) => x.id !== L.id); });
    this.current = d.layouts[0]?.id; this.loadedKey = null; this.#load(); this.#renderList();
  }

  #export() {
    const L = this.layout; if (!L) return;
    download(`${L.id}.layout.json`, worldText({ kind: "fashion-layout", version: this.world.schema?.layout_version ?? 2, ...L }));
  }

  async #import() {
    const file = await pickFile();
    if (!file) return;
    let L;
    try { L = JSON.parse(file.text); } catch (e) { this.app.banner("Not a layout file", e.message); return; }
    if (L?.kind !== undefined && L.kind !== "fashion-layout") { this.app.banner("Not a layout file", `Its kind is "${L.kind}", not "fashion-layout".`); return; }
    const { kind, version, ...layout } = L ?? {};
    if (!Array.isArray(layout.rows) || !layout.rows.length || !layout.rows.every((r) => typeof r === "string")) { this.app.banner("Not a layout file", "It has no rows of tiles."); return; }
    const d = this.world.draft;
    const name = newName(d.layouts, typeof layout.name === "string" && layout.name.trim() ? layout.name : file.name.replace(/\.layout\.json$|\.json$/, ""));
    const id = newId(d.layouts, typeof layout.id === "string" ? layout.id : name);
    const draw = typeof layout.draw === "number" ? layout.draw : 0.1;
    // A version 1 layout's new-arrivals (N) and promotion (P) tables were
    // racks no shopper went to; they became tops (T) and denim (D) racks.
    const rows = version === 1 ? layout.rows.map((r) => r.replace(/N/g, "T").replace(/P/g, "D")) : layout.rows;
    this.world.edit((w) => { w.layouts.push({ id, name, draw, rows }); });
    this.current = id; this.#load(); this.#renderList();
  }
}
