// Sentences written from a brand's calendar and stock settings, so the rule
// that differs between two brands is read, not guessed: the line under each
// entry in the calendar editor (Setup), and the Assortment tab's Stock card.
//
// `b` is a brand of a world file, `d` the world (for its categories).

import { fmt } from "./ui.js";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_NAMES = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

export const possessive = (name) => (name.endsWith("s") ? `${name}'` : `${name}'s`);
export const plural = (n, word, many = `${word}s`) => `${fmt.int(n)} ${n === 1 ? word : many}`;
const listText = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const trim = (s) => s.replace(/\.?0+$/, "");
const weeks = (v) => `${trim(fmt.num2(v))} week${v === 1 ? "" : "s"}`;
const points = (v) => plural(Math.round(100 * v), "point");
const leadTime = (n) => `${fmt.int(n)}-day lead time`;

// The day of the season's weekday (day 1 is a Monday).
export const weekdayOf = (day) => WEEKDAYS[(day - 1) % 7];

// The days an entry acts on.
export function entryDays(e) {
  const out = [];
  for (let day = e.from; day <= e.to; day++) if (!e.weekdays.length || e.weekdays.includes(weekdayOf(day))) out.push(day);
  return out;
}

export function whenText(e) {
  if (e.from === e.to) return `Once, day ${e.from}`;
  const span = `days ${e.from} to ${e.to}`;
  if (!e.weekdays.length) return `Every day, ${span}`;
  return `Every ${listText(WEEKDAYS.filter((w) => e.weekdays.includes(w)).map((w) => DAY_NAMES[w]))}, ${span}`;
}

// What an entry is on, in words.
export function onText(e, b, d) {
  if (e.on === "range") return "the whole range";
  const names = e.on === "categories"
    ? d.categories.filter((c) => e.items.includes(c.id)).map((c) => c.name)
    : b.range.filter((p) => e.items.includes(p.id)).map((p) => p.name);
  if (!names.length) return e.on === "categories" ? "no categories" : "no products";
  return names.length > 4 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} other ${e.on === "categories" ? "categories" : "products"}` : listText(names);
}

const whenOn = (e, b, d) => `${whenText(e)}${e.on === "range" ? "" : `, ${onText(e, b, d)}`}`;

export function replenishmentText(e, b, d) {
  if (e.rule === "replace") return `${whenOn(e, b, d)}: ships each store what it sold of each size since the product's last order`;
  const under = e.reorder < e.cover ? `, for each size under ${weeks(e.reorder)}` : "";
  return `${whenOn(e, b, d)}: tops each store up to ${weeks(e.cover)} of demand beyond ${possessive(b.name)} ${leadTime(b.stock.lead_days)}${under}`;
}

export function markdownText(e, b, d) {
  const behind = e.which === "behind";
  const who = behind
    ? `products behind plan (by more than ${points(e.by)}, in the stores ${plural(e.min_days, "day")} or more)`
    : e.on === "range" ? "every product" : "every product on it";
  const verb = behind ? "go" : "goes";
  const what = e.mode === "to" ? `${verb} to ${fmt.pct(e.depth)} off` : `${verb} ${points(e.depth)} deeper, to at most ${fmt.pct(e.max)} off`;
  const rest = e.rest_days > 0 ? `; a product marked down in the last ${plural(e.rest_days, "day")} is left to rest` : "";
  return `${whenOn(e, b, d)}: ${who} ${what}${rest}`;
}

// Who an offer (or a promotion) reaches, in words: its tiers, and where.
export function reachText(e, b, d) {
  const tiers = b.loyalty.tiers.filter((t) => e.tiers.includes(t.id)).map((t) => t.name);
  const who = tiers.length === b.loyalty.tiers.length ? "every tier" : tiers.length ? listText(tiers) : "no one";
  const where = e.areas.length ? listText((d.macro.areas ?? []).filter((a) => e.areas.includes(a.id)).map((a) => a.name)) : "everywhere";
  return `${who}, ${where}`;
}

// An offer, in a line: when, the coupon and where it's good, who gets it,
// who's held out, and what sending costs.
export function offerText(e, b, d) {
  const also = d.brands.filter((x) => e.also_at.includes(x.id)).map((x) => x.name);
  const at = also.length ? `${b.name} and ${listText(also)}` : b.name;
  const when = e.from === e.to ? `Day ${e.from}` : `Days ${e.from} to ${e.to}`;
  return `${when}: a ${fmt.pct(e.depth)} coupon, good for one purchase at ${at}, sent on day ${e.from} to ${fmt.pct(e.audience)} of the households it reaches (${reachText(e, b, d)}), drawn at random; ${fmt.pct(e.holdout)} of them held out and sent nothing. ${fmt.money2(e.send_cost)} to send each.`;
}

// The products of b no replenishment entry covers: they get their opening
// allocation and nothing more.
export function unreplenished(b, d) {
  const covered = new Set();
  for (const e of b.calendar.replenishment ?? []) {
    for (const p of b.range) {
      if (e.on === "range" || (e.on === "categories" && e.items.includes(p.category)) || (e.on === "products" && e.items.includes(p.id))) covered.add(p.id);
    }
  }
  return b.range.filter((p) => !covered.has(p.id));
}

// A brand's stock rules, as the Assortment's Stock card tells them:
// [{ heading, lines: [...] }].
export function stockStory(b, d) {
  const s = b.stock;
  const split = s.allocation === "learned" ? "split by size by each store's own size mix" : "split by size by the market's size curve";
  const reps = b.calendar.replenishment ?? []; const mds = b.calendar.markdowns ?? [];
  const bare = unreplenished(b, d);
  const out = [
    { heading: "Opening allocation", lines: [`When a product lands, each store gets ${weeks(s.opening_weeks)} of its planned sales, ${split}.`] },
    { heading: "Replenishment", lines: reps.length
      ? [...reps.map((e) => `${e.name}: ${replenishmentText(e, b, d)}.`),
        `Orders arrive after the ${leadTime(s.lead_days)}.`,
        ...(bare.length ? [`${plural(bare.length, "product")} no entry covers get${bare.length === 1 ? "s" : ""} the opening allocation and nothing more.`] : [])]
      : [`${b.name} has no replenishment on its calendar: every product gets its opening allocation and nothing more.`] },
    { heading: "Markdowns", lines: [
      ...(mds.length ? mds.map((e) => `${e.name}: ${markdownText(e, b, d)}.`) : [`${b.name} has no markdowns on its calendar.`]),
      ...(mds.some((e) => e.which === "behind") ? [`Behind plan is against ${possessive(b.name)} target, ${fmt.pct(b.pricing.md_target)} sold through by the season's end, on the path of each product's planned sales.`] : []),
      "A markdown holds to the season's end, and the deeper one wins."] },
    { heading: "Costs", lines: [`Each store delivery costs ${fmt.money2(s.delivery_fee)} and each unit shipped ${fmt.money2(s.unit_fee)}; stock left at the season's end fetches ${fmt.pct(s.salvage)} of its cost.`] },
  ];
  return out;
}
