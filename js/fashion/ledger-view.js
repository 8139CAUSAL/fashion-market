// A household's ledger, as the Market tab's household card and the
// inspector show it: its spend by brand (gross, less refunds, and the
// delivery charges it paid), and every item it has bought this season,
// newest first: what it paid and what came off, and whether it went back
// (model/returns.R, household_ledger). `compact`: a line per item, for the
// inspector's narrow column.

import { el, fmt, brandVar } from "./ui.js";

export function ledgerView(L, app, { compact = false } = {}) {
  if (!L) return null;
  if (!L.lines.length) return el("p", { class: "note", text: "Nothing bought yet this season." });
  const name = (b) => app.brandName(b);
  // Where it was bought: the brand's online store, or the store (with its
  // brand, unless the store's name starts with it).
  const where = (x) => (x.online || x.store === "online" ? `${name(x.brand)} online`
    : x.store.startsWith(name(x.brand)) ? x.store : `${name(x.brand)}, ${x.store}`);
  if (compact) {
    return el("div", { class: "ledger compact" },
      el("div", { class: "kv" }, ...L.totals.map((t) => el("div", { class: "kv-row" }, el("span", { class: "k", text: name(t.brand) }),
        el("span", { class: "v", text: `${fmt.money2(t.gross)} spent, ${fmt.money2(t.refunds)} refunded: ${fmt.money2(t.net)} net${t.delivery ? `, ${fmt.money2(t.delivery)} delivery` : ""}` })))),
      el("ul", { class: "plain ledger-scroll" }, ...L.lines.map((x) => el("li", { class: x.returned ? "returned" : "" },
        `Day ${x.day} · ${x.item}, ${fmt.money2(x.paid)} at ${where(x)}`,
        x.returned ? ` · returned day ${x.ret_day} (${x.reason}), ${fmt.money2(x.refund)} back` : ` · ${x.state}`))));
  }
  const totals = el("table", { class: "data ledger-totals" },
    el("thead", {}, el("tr", {}, ...["Brand", "Items", "Returned", "Spent", "Refunds", "Net", "Delivery"].map((h, i) => el("th", { class: i ? "num" : "", text: h })))),
    el("tbody", {}, ...L.totals.map((t) => el("tr", {},
      el("td", {}, el("i", { class: "legend-swatch", vars: { "--c": brandVar(t.brand) }, style: { display: "inline-block", marginRight: "6px" } }), name(t.brand)),
      el("td", { class: "num", text: fmt.int(t.items) }), el("td", { class: "num", text: fmt.int(t.returned) }), el("td", { class: "num", text: fmt.money2(t.gross) }),
      el("td", { class: "num", text: fmt.money2(t.refunds) }), el("td", { class: "num", text: fmt.money2(t.net) }), el("td", { class: "num", text: t.delivery ? fmt.money2(t.delivery) : "—" }))),
    el("tr", { class: "total" }, el("td", { text: "All brands" }), el("td"), el("td"), el("td", { class: "num", text: fmt.money2(L.gross) }),
      el("td", { class: "num", text: fmt.money2(L.refunds) }), el("td", { class: "num", text: fmt.money2(L.net) }), el("td", { class: "num", text: L.delivery ? fmt.money2(L.delivery) : "—" }))));
  const off = (x) => [x.markdown > 0.005 ? `markdown ${fmt.money2(x.markdown)}` : "", x.promotion > 0.005 ? `promotion ${fmt.money2(x.promotion)}` : "",
    x.coupon > 0.005 ? `coupon ${fmt.money2(x.coupon)}${x.offer ? ` (${x.offer})` : ""}` : ""].filter(Boolean).join(", ");
  const items = el("table", { class: "data ledger-lines" },
    el("thead", {}, el("tr", {}, ...["Day", "Bought", "Item", "Full price", "Taken off", "Paid", "Now", "Refund"].map((h, i) => el("th", { class: [3, 5, 7].includes(i) ? "num" : "", text: h })))),
    el("tbody", {}, ...L.lines.map((x) => el("tr", { class: x.returned ? "returned" : "" },
      el("td", { text: `${x.day}` }), el("td", { text: `${where(x)}${x.online ? `, delivered day ${x.delivered}` : ""}` }), el("td", { text: x.item }),
      el("td", { class: "num", text: fmt.money2(x.full) }), el("td", { text: off(x) || "—" }), el("td", { class: "num", text: fmt.money2(x.paid) }),
      el("td", { text: x.returned ? `returned day ${x.ret_day}, ${x.ret_where === "by post" ? "by post" : `at ${x.ret_where}`}: ${x.reason}; ${x.back_in_stock ? "back in stock" : "written off"}` : x.state }),
      el("td", { class: "num", text: x.returned ? fmt.money2(x.refund) : "—" })))));
  return el("div", { class: "ledger" },
    el("div", { class: "table-scroll" }, totals),
    el("div", { class: "table-scroll ledger-scroll" }, items),
    el("p", { class: "note", text: "A refund is what was paid for the item, after markdown, promotion and coupon; a coupon used on a returned item isn't given back, and neither is the delivery charge. Spend with each brand for its loyalty tiers is net of refunds." }));
}
