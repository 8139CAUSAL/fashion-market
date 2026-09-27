// The inspector: inside a head, on the store floor. Click a shopper or a
// worker on the Store tab's floor and it follows them live. Only what the
// model uses is shown: no mood or need that doesn't drive a decision.
//
// A shopper: what they're doing and where, their basket, the racks still
// on their list, their patience while they queue, why they came, their
// tier with the brand and how close they are to moving, the promotions
// that reach them and any offers they hold, and their visit in the first
// person, from the model's visit log: each thought's tone comes from how
// close the decision was, and hovering one shows the numbers behind it.
// A worker: what they're doing now, and their day so far.

import { el, fmt, card } from "./ui.js";
import { tooltip } from "./charts.js";
import { possessive } from "./entry-text.js";

export class Inspector {
  constructor({ onClose, onHousehold }) {
    this.card = card("Inspector", { right: el("button", { type: "button", class: "icon-btn", "aria-label": "Close the inspector", text: "×", onclick: () => onClose?.() }) });
    this.card.root.classList.add("inspector");
    this.card.root.hidden = true;
    this.onHousehold = onHousehold;
    this.key = null;
    // The thoughts, kept from one update to the next (a visit's log only
    // grows), so hovering one keeps its numbers up.
    this.thoughtBox = el("div", { class: "thoughts" });
    this.thoughtsOf = null; this.thoughtCount = 0;
  }

  get root() { return this.card.root; }

  update(ins) {
    if (!ins) { this.card.root.hidden = true; this.key = null; return; }
    this.card.root.hidden = false;
    this.card.head.querySelector("h2").textContent = ins.title;
    this.card.body.replaceChildren(...(ins.kind === "shopper" ? this.#shopper(ins) : this.#worker(ins)));
  }

  #shopper(s) {
    const out = [];
    out.push(el("div", { class: "stat-sub", text: s.who }));
    out.push(el("div", { class: "now" }, el("span", { class: "label", text: "Now" }), s.now));
    if (s.queue) {
      const share = Math.min(1, s.queue.waited / Math.max(1, s.queue.patience));
      out.push(el("div", { class: "patience" }, el("div", { class: "bar-label" }, "Patience", el("span", { text: `${fmt.mins(s.queue.waited)} of ${fmt.mins(s.queue.patience)}` })),
        el("div", { class: "meter" }, el("span", { style: { width: `${(100 * share).toFixed(1)}%` }, class: share > 0.8 ? "hot" : "" })),
        el("div", { class: "stat-sub", text: `Won't join a queue of more than ${s.queue.max_ahead - 1}.` })));
    }
    out.push(el("div", { class: "kv" },
      row("In the store", fmt.mins(s.in_store_s)),
      row("Budget left", `${fmt.money(s.budget_left)} of ${fmt.money(s.budget)}`),
      row("Still to browse", s.racks_left.length ? s.racks_left.join(", ") : "nothing: heading on")));
    out.push(el("h3", { class: "setup-heading", text: "Basket" }),
      s.basket.length ? el("ul", { class: "plain" }, ...s.basket.map((b) => el("li", { text: `${b.item} · ${fmt.money2(b.price)}` }))) : el("p", { class: "note", text: "Empty." }));
    // Their head.
    const t = s.tier;
    const moves = [`${fmt.money2(t.spend)} spent this season`];
    if (t.top) moves.push("at the top of the ladder");
    else moves.push(`${fmt.money2(t.to_next)} more to reach ${t.next_name}`);
    if (t.keep_spend > 0) moves.push(t.requalified ? `re-qualified for ${t.started}` : `${fmt.money2(t.keep_spend - t.spend)} more to keep ${t.started}, where the season started`);
    out.push(el("h3", { class: "setup-heading", text: "Their head" }),
      el("div", { class: "kv" },
        row("Why they came", s.reasons.length ? capital(s.reasons.join(" and ")) : "Nothing stood out: a random draw of taste"),
        row(`Loyalty to ${s.brand}`, `${t.name}: ${moves.join("; ")}`),
        row("Promotions for them", s.promotions?.length ? s.promotions.join("; ") : "none today"),
        row("Offers held", s.offers.length ? s.offers.map((o) => `${possessive(o.brand)} ${o.name}, ${fmt.pct(o.depth)} off until day ${o.until}${o.good_here ? " (good here)" : ""}`).join("; ") : "none")));
    out.push(el("h3", { class: "setup-heading", text: "Thoughts" }),
      this.#thoughts(s));
    out.push(el("button", { type: "button", class: "btn small", text: `Their household (#${s.household}) on the Market tab`, onclick: () => this.onHousehold?.(s.household) }));
    return out;
  }

  #thoughts(s) {
    const box = this.thoughtBox;
    const of = `${s.household}:${s.visit}`;
    if (this.thoughtsOf !== of || s.thoughts.length < this.thoughtCount) { box.replaceChildren(); this.thoughtsOf = of; this.thoughtCount = 0; }
    for (const t of s.thoughts.slice(this.thoughtCount)) {
      const p = el("p", { text: t.text, class: `${t.tone ? `tone-${t.tone}` : ""}${t.detail ? " has-detail" : ""}` });
      if (t.detail) {
        p.addEventListener("pointermove", (ev) => tooltip.show(ev, "What decided it", [{ value: "", name: t.detail }]));
        p.addEventListener("pointerleave", () => tooltip.hide());
      }
      box.append(p);
    }
    this.thoughtCount = s.thoughts.length;
    return box;
  }

  #worker(w) {
    const out = [el("div", { class: "now" }, el("span", { class: "label", text: "Now" }), w.now)];
    if (w.kind === "cashier") {
      if (!w.open) out.push(el("p", { class: "note", text: "This till is closed: the store has fewer cashiers on than tills." }));
      out.push(el("div", { class: "kv" }, row("Till", String(w.till)), row("Waiting at the tills", fmt.int(w.queue)),
        row("Customers served today", fmt.int(w.served)), row("Items scanned", fmt.int(w.items)), row("Busy", fmt.pct(w.busy))));
    } else {
      out.push(el("div", { class: "kv" }, row("Sizes fetched today", fmt.int(w.fetched)), row("Shoppers advised", fmt.int(w.advised)), row("Busy", fmt.pct(w.busy))));
    }
    out.push(el("p", { class: "note", text: "Workers don't decide or tire in this model: they serve whoever comes next." }));
    return out;
  }
}

const row = (k, v) => el("div", { class: "kv-row" }, el("span", { class: "k", text: k }), el("span", { class: "v", text: v }));
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
