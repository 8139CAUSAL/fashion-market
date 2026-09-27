// A brand's calendar as a Gantt: the season's days across, rows down.
// Promotions are named bars; replenishment entries thin bands with a tick
// on each order day; markdowns are shaded from their first day to the
// season's end (they're permanent), with a tick on each day they act; the
// days products land are diamonds. Bars and bands that overlap in time in
// one row take lanes of their own; a row's markdowns share a strip under
// them. A tick can be a day gone (solid, with
// what happened) or a day to come (lighter). Used by the Setup tab's
// calendar editor (the plan) and the Assortment tab (the season as it has
// run, and as it's planned).
//
//   drawCalendar(container, {
//     days, today?,
//     rows: [{ label, colour?,
//              bars: [{ key?, name, from, to, depth, colour?, bad?, note? }],
//              bands: [{ key?, name, from, to, ticks, colour?, bad?, note? }],
//              steps: [{ key?, name, from, depth, label?, ticks?, bad?, note? }],
//              marks: [{ day, names }] }],
//     selected?, onSelect?(key) })
//   a tick: { day, state?: "done" | "future", title, rows: [{ value, name }] }

import { el, fmt } from "./ui.js";
import { tooltip } from "./charts.js";

const NS = "http://www.w3.org/2000/svg";
const LABEL_W = 150;
const LANE_H = 20;
const STEP_H = 20;
const PAD = 6;

function s(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

// Each item's lane in its row: the first where it overlaps no other.
function lanes(items) {
  const ends = [];
  return items.map((b) => {
    let k = ends.findIndex((end) => end < b.from);
    if (k < 0) { k = ends.length; ends.push(b.to); } else ends[k] = b.to;
    return k;
  });
}

export function drawCalendar(container, { days, today, rows, selected, onSelect }) {
  const W = Math.max(640, container.clientWidth || 900);
  const plotW = W - LABEL_W - 12;
  const x = (d) => LABEL_W + ((d - 1) / days) * plotW;
  const mid = (d) => x(d) + plotW / days / 2;
  const laid = rows.map((r) => {
    const items = [...(r.bars ?? []).map((b) => ({ ...b, kind: "bar" })), ...(r.bands ?? []).map((b) => ({ ...b, kind: "band" }))]
      .sort((a, b) => a.from - b.from);
    const lane = lanes(items);
    const steps = [...(r.steps ?? [])].sort((a, b) => a.from - b.from);
    const n = lane.length ? Math.max(...lane) + 1 : steps.length ? 0 : 1;
    return { ...r, items, lane, steps, n, h: n * LANE_H + (steps.length ? STEP_H : 0) + 2 * PAD };
  });
  const top = 22;
  const H = top + laid.reduce((a, r) => a + r.h, 0) + 8;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "calendar-chart", role: "img", "aria-label": "Calendar" });
  svg.style.width = "100%"; svg.style.height = `${H}px`;

  // The weeks.
  for (let d = 1; d <= days; d += 7) {
    s("line", { x1: x(d), x2: x(d), y1: top - 4, y2: H - 6, class: "grid-line" }, svg);
    const t = s("text", { x: x(d) + 3, y: 12, class: "axis-text" }, svg);
    t.textContent = d === 1 ? "day 1" : String(d);
  }
  s("line", { x1: x(days + 1), x2: x(days + 1), y1: top - 4, y2: H - 6, class: "grid-line" }, svg);

  const clickable = (node, key) => {
    if (!onSelect || key === undefined) return;
    node.classList.add("clickable");
    node.addEventListener("click", () => onSelect(key));
  };
  const state = (item) => `${item.bad ? " bad" : ""}${item.key !== undefined && item.key === selected ? " is-on" : ""}`;
  // Ticks on the days an entry acts, from y0 to y1.
  const ticks = (list, y0, y1, colour) => {
    for (const t of list ?? []) {
      const node = s("line", { x1: mid(t.day), x2: mid(t.day), y1: y0, y2: y1, class: `cal-tick${t.state ? ` ${t.state}` : ""}`, stroke: colour }, svg);
      const hit = s("rect", { x: mid(t.day) - 4, y: y0 - 2, width: 8, height: y1 - y0 + 4, class: "cal-hit" }, svg);
      hover(hit, t.title, t.rows ?? []);
      node.style.pointerEvents = "none";
    }
  };

  let y = top;
  for (const r of laid) {
    s("rect", { x: 0, y, width: W, height: r.h, class: "cal-row" }, svg);
    if (r.colour) s("rect", { x: 4, y: y + r.h / 2 - 5, width: 10, height: 10, rx: 2, fill: r.colour }, svg);
    const label = s("text", { x: r.colour ? 20 : 4, y: y + r.h / 2 + 4, class: "label-ink" }, svg);
    label.textContent = r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label;
    // Markdowns, in the strip under the lanes: shaded from their first day
    // to the end, deeper as they go down, with a tick on each day they act.
    const sy = y + PAD + r.n * LANE_H;
    r.steps.forEach((m, i) => {
      const x0 = x(m.from); const x1 = x(days + 1);
      const node = s("rect", { x: x0, y: sy, width: Math.max(2, x1 - x0), height: STEP_H - 2, rx: 3,
        class: `cal-step${state(m)}`, "fill-opacity": 0.1 + 0.45 * m.depth }, svg);
      const t = s("text", { x: x0 + 4, y: sy + STEP_H - 6, class: "cal-step-text" }, svg);
      const room = ((i + 1 < r.steps.length ? x(r.steps[i + 1].from) : x1) - x0 - 8) / 5.6;
      const full = m.label ?? `${fmt.pct(m.depth)} ${m.name}`;
      t.textContent = room >= full.length ? full : room >= 4 ? `${full.slice(0, Math.max(3, Math.floor(room) - 1))}…` : "";
      hover(node, m.name, [{ value: "", name: m.note ?? `${fmt.pct(m.depth)} off full price from day ${m.from}` }]);
      clickable(node, m.key);
      ticks(m.ticks, sy + 1, sy + 7, "var(--ink-2)");
    });
    // Products landing.
    for (const mk of r.marks ?? []) {
      const cx = x(mk.day) + 2; const cy = y + r.h / 2;
      const node = s("path", { d: `M${cx},${cy - 6}L${cx + 5},${cy}L${cx},${cy + 6}L${cx - 5},${cy}Z`, class: "cal-mark" }, svg);
      hover(node, `Day ${mk.day}: lands`, mk.names.map((n) => ({ value: "", name: n })));
    }
    // Promotions and replenishment, lane by lane.
    r.items.forEach((b, i) => {
      const x0 = x(b.from); const x1 = x(b.to + 1);
      const by = y + PAD + r.lane[i] * LANE_H;
      const colour = b.colour ?? "var(--accent)";
      if (b.kind === "band") {
        const node = s("rect", { x: x0, y: by + 11, width: Math.max(3, x1 - x0 - 1), height: 5, rx: 2.5, class: `cal-band${state(b)}`, fill: colour }, svg);
        const hit = s("rect", { x: x0, y: by, width: Math.max(3, x1 - x0 - 1), height: LANE_H - 2, class: "cal-hit" }, svg);
        const t = s("text", { x: x0 + 2, y: by + 8, class: "cal-band-text" }, svg);
        const room = (x1 - x0 - 4) / 5.6;
        t.textContent = room >= b.name.length ? b.name : room >= 4 ? `${b.name.slice(0, Math.max(3, Math.floor(room) - 1))}…` : "";
        hover(hit, b.name, b.note ? [{ value: "", name: b.note }] : []);
        clickable(hit, b.key);
        node.style.pointerEvents = "none";
        ticks(b.ticks, by + 8, by + 19, colour);
        return;
      }
      const node = s("rect", { x: x0, y: by + 1, width: Math.max(3, x1 - x0 - 1), height: LANE_H - 3, rx: 4,
        class: `cal-bar${state(b)}`, fill: colour }, svg);
      const t = s("text", { x: x0 + 4, y: by + LANE_H - 6, class: "cal-bar-text" }, svg);
      const room = (x1 - x0 - 8) / 6.2;
      const full = `${b.name} ${fmt.pct(b.depth)}`;
      t.textContent = room >= full.length ? full : room >= 4 ? `${full.slice(0, Math.max(3, Math.floor(room) - 1))}…` : "";
      hover(node, b.name, [{ value: fmt.pct(b.depth), name: `off, days ${b.from} to ${b.to}` }, ...(b.note ? [{ value: "", name: b.note }] : [])]);
      clickable(node, b.key);
    });
    y += r.h;
  }
  if (today) {
    const tx = mid(today);
    s("line", { x1: tx, x2: tx, y1: top - 6, y2: H - 4, class: "cal-today" }, svg);
    const t = s("text", { x: tx + 3, y: top - 8, class: "cal-today-text" }, svg);
    t.textContent = "today";
  }
  container.replaceChildren(svg);
}

function hover(node, title, rows) {
  node.addEventListener("pointermove", (ev) => tooltip.show(ev, title, rows));
  node.addEventListener("pointerleave", () => tooltip.hide());
}

export const legendItem = (cls, label) => el("span", {}, el("i", { class: `legend-swatch ${cls}` }), label);
