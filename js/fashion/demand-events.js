// MODIFIED: new file. The season's demand events, as the Season section of
// the Setup tab reads them from the draft world: each day's demand
// multiplier, and the line that says what an event does. The same rules as
// model/world.R (fold_multiplier, ramp_walk, demand_multipliers), which is
// what the simulation runs; this is the preview while editing.
//
// A strength is a signed fold change of the day's demand: 1.3 is ×1.3, -2
// is ÷2 (×0.5), and 1 and -1 are no change. A solid event puts its
// strength on each of its days. A ramp walks, on each of its days, from
// `from` (on the first of its ramp days) to its strength (on the day), in
// equal steps; ramp days before day 1 are cut off. Where events overlap,
// their multipliers multiply.

import { weekdayOf } from "./entry-text.js";

export const foldMultiplier = (f) => (f >= 0 ? Math.max(f, 1) : 1 / Math.max(-f, 1));

// A multiplier as a signed fold change: 0.5 is -2, 1.3 is 1.3.
export const multiplierFold = (m) => (m >= 1 ? m : -1 / m);

// A ramp's strengths on its n days, first to last. A start (or a strength)
// of 1 or -1, no change, is taken on the other's side.
export function rampWalk(from, strength, n) {
  let a = from; let b = strength;
  if (Math.abs(a) === 1) a = b < 0 ? -1 : 1;
  else if (Math.abs(b) === 1) b = a < 0 ? -1 : 1;
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / Math.max(1, n - 1));
}

// Each day's demand multiplier, days 1..nDays (index 0 is day 1).
export function demandMultipliers(events, nDays) {
  const m = new Array(nDays).fill(1);
  for (const e of events ?? []) {
    const walk = e.shape === "ramp" ? rampWalk(e.from, e.strength, Math.round(e.ramp_days)) : [e.strength];
    for (const D of e.days ?? []) {
      walk.forEach((f, i) => {
        const day = D - walk.length + 1 + i;
        if (Number.isInteger(day) && day >= 1 && day <= nDays) m[day - 1] *= foldMultiplier(f);
      });
    }
  }
  return m;
}

// "3, 23" (commas or spaces between): the days, ascending, each once; or
// the first piece that isn't a whole number.
export function parseDays(text) {
  const parts = String(text).split(/[\s,;]+/).filter(Boolean);
  const bad = parts.find((p) => !/^\d+$/.test(p));
  if (bad !== undefined) return { bad };
  return { days: [...new Set(parts.map(Number))].sort((a, b) => a - b) };
}

const num = (v) => String(Number(v.toFixed(2)));
const times = (m) => `×${m.toFixed(2)}`;
const pct = (m) => `${m >= 1 ? "+" : "−"}${Math.abs(Math.round(100 * (m - 1)))}%`;
const listText = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
export const daysText = (days) => `${days.length === 1 ? "day" : "days"} ${listText(days)}`;

// What an event does, in a line.
export function eventText(e) {
  const days = e.days ?? [];
  if (!days.length) return "No days yet: type the days it's on.";
  const m = foldMultiplier(e.strength);
  if (e.shape !== "ramp") return `${daysText(days).replace(/^d/, "D")}: demand ${times(m)} (${pct(m)}), strength ${num(e.strength)}.`;
  const n = Math.round(e.ramp_days);
  const walk = rampWalk(e.from, e.strength, n);
  const cut = days.some((D) => D - n + 1 < 1);
  const span = days.length === 1 ? `, days ${Math.max(1, days[0] - n + 1)} to ${days[0]}` : " each";
  return `Ramps into ${daysText(days)} over ${n} days${span}: ${walk.map(num).join(", ")} (demand ${times(foldMultiplier(walk[0]))} on the first, ${times(foldMultiplier(walk.at(-1)))} on the day).${cut ? " Ramp days before day 1 are cut off." : ""}`;
}

// A day as the season's calendar names it: day 1 is a Monday.
export const dayName = (day) => `Day ${day} · ${weekdayOf(day)}, week ${Math.floor((day - 1) / 7) + 1}`;
