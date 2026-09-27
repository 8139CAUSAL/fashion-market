// Small DOM helpers and formats shared by every tab.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key === "vars") for (const [k, v] of Object.entries(value)) node.style.setProperty(k, v);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const brandVar = (b) => `var(--brand-${b})`;

// A slider's track is filled up to its thumb (see css/fashion.css).
export function paintRange(input) {
  const min = Number(input.min) || 0; const max = Number(input.max) || 100;
  input.style.setProperty("--fill", `${(100 * (Number(input.value) - min)) / (max - min || 1)}%`);
}
document.addEventListener("input", (ev) => { if (ev.target?.type === "range") paintRange(ev.target); });

// Reads a CSS custom property (for the canvases, which can't use var()).
export function cssVar(name, root = document.documentElement) {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export const fmt = {
  int: (v) => (isNum(v) ? nf0.format(v) : "—"),
  num1: (v) => (isNum(v) ? nf1.format(v) : "—"),
  num2: (v) => (isNum(v) ? nf2.format(v) : "—"),
  pct: (v, d = 0) => (isNum(v) ? `${(100 * v).toFixed(d)}%` : "—"),
  pp: (v, d = 1) => (isNum(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(100 * v).toFixed(d)} pts` : "—"),
  money: (v) => {
    if (!isNum(v)) return "—";
    const a = Math.abs(v); const s = v < 0 ? "−" : "";
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
    if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(0)}K`;
    if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
    return `${s}$${a.toFixed(a < 100 ? 2 : 0)}`;
  },
  money2: (v) => (isNum(v) ? `${v < 0 ? "−" : ""}$${nf2.format(Math.abs(v))}` : "—"),
  compact: (v) => {
    if (!isNum(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
    return nf0.format(v);
  },
  mins: (s) => (isNum(s) ? (s < 60 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`) : "—"),
};

// A labelled slider with its value. `onChange` fires while dragging
// (throttled) and on release, so the model follows the hand.
export function lever({ label, min, max, step, value, format = (v) => v, onChange, id, title }) {
  const input = el("input", { type: "range", min, max, step, value, id, "aria-label": label, title });
  const out = el("output", { text: format(Number(value)) });
  const root = el("label", { class: "lever" }, el("span", { class: "lever-label", text: label }), out, input);
  paintRange(input);
  let timer = 0; let last = Number(value);
  const send = () => {
    const v = Number(input.value);
    if (v === last) return;
    last = v;
    onChange?.(v);
  };
  input.addEventListener("input", () => {
    out.textContent = format(Number(input.value));
    clearTimeout(timer);
    timer = setTimeout(send, 180);
  });
  input.addEventListener("change", () => { clearTimeout(timer); send(); });
  return {
    root, input,
    set(v) {
      if (document.activeElement === input || !Number.isFinite(Number(v))) return;
      input.value = v; last = Number(v); out.textContent = format(Number(v)); paintRange(input);
    },
    setMax(m) { input.max = m; paintRange(input); },
  };
}

export function select({ label, options, value, onChange, id, hideLabel = false }) {
  const node = el("select", { id, "aria-label": label });
  const setOptions = (opts, keep = node.value) => {
    node.replaceChildren(...opts.map((o) => {
      if (o.group) {
        return el("optgroup", { label: o.group }, ...o.options.map((q) => el("option", { value: q.value, text: q.label })));
      }
      return el("option", { value: o.value, text: o.label });
    }));
    if (keep !== undefined && [...node.options].some((o) => o.value === String(keep))) node.value = String(keep);
  };
  setOptions(options, value);
  node.addEventListener("change", () => onChange?.(node.value));
  const root = hideLabel ? node : el("label", { class: "field" }, el("span", { text: label }), node);
  return { root, node, setOptions, set(v) { node.value = String(v); }, get value() { return node.value; } };
}

export function segmented({ options, value, onChange, label }) {
  const root = el("div", { class: "seg", role: "group", "aria-label": label });
  const buttons = options.map((o) => el("button", {
    type: "button", text: o.label, title: o.title, "aria-pressed": String(o.value === value),
    onclick: () => { set(o.value); onChange?.(o.value); },
  }));
  const set = (v) => buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(options[i].value === v)));
  root.append(...buttons);
  return { root, set };
}

export function card(title, { sub, right, cls } = {}) {
  const body = el("div", { class: "card-body" });
  const head = el("div", { class: "card-head" }, el("h2", { text: title }), sub ? el("span", { class: "sub", text: sub }) : null,
    right ? el("div", { class: "right" }, right) : null);
  const root = el("section", { class: `card ${cls ?? ""}` }, head, body);
  return { root, body, head, setSub(text) { let s = head.querySelector(".sub"); if (!s) { s = el("span", { class: "sub" }); head.children[0].after(s); } s.textContent = text; } };
}

// A grid of stat tiles: label, value, and an optional line under it.
export function stats(container, specs) {
  const tiles = new Map();
  for (const spec of specs) {
    const value = el("div", { class: "stat-value", text: "—" });
    const sub = el("div", { class: "stat-sub" });
    container.append(el("div", { class: "stat", title: spec.title }, el("div", { class: "stat-label", text: spec.label }), value, sub));
    tiles.set(spec.key, { value, sub });
  }
  return {
    update(values) {
      for (const [key, tile] of tiles) {
        const v = values[key];
        if (v === undefined) continue;
        if (typeof v === "object" && v !== null) { tile.value.textContent = v.value; tile.sub.textContent = v.sub ?? ""; }
        else tile.value.textContent = v;
      }
    },
  };
}

// A legend row: swatches (or line keys) beside text-ink labels.
export function legend(items, { line = false, square = false } = {}) {
  return el("div", { class: "legend" }, ...items.map((it) => el("span", {},
    el("i", { class: line ? "legend-line" : `legend-swatch${square ? " square" : ""}`, vars: { "--c": it.colour } }),
    it.label)));
}

// A setting's format, by the name model/params.R gives it.
export const formatOf = (name) => ({
  num1: fmt.num1, num2: fmt.num2, int: fmt.int, pct: (v) => fmt.pct(v), pct1: (v) => fmt.pct(v, 1), money: fmt.money2,
}[name] ?? fmt.num2);

// A slider for a setting from the model's schema (label, range, step, format).
export function settingLever(spec, { value, onChange, label, max, title } = {}) {
  return lever({ label: label ?? spec.label, min: spec.min, max: max ?? spec.max, step: spec.step, value: value ?? spec.min,
    format: formatOf(spec.format), onChange, title });
}

// A text field that reports its value when it changes (on blur or Enter).
export function textField({ label, value = "", onChange, maxLength = 80, hideLabel = false, size, placeholder }) {
  const input = el("input", { type: "text", value, maxlength: maxLength, "aria-label": label, size, placeholder });
  let last = value;
  const send = () => {
    const v = input.value.trim();
    if (!v) { input.value = last; return; }
    if (v !== last) { last = v; onChange?.(v); }
  };
  input.addEventListener("change", send);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") input.blur(); });
  const root = hideLabel ? input : el("label", { class: "field" }, el("span", { text: label }), input);
  return { root, input, set(v) { if (document.activeElement !== input) { input.value = v; last = v; } } };
}

// A number typed in, kept within its range.
export function numberField({ label, value, min, max, step = 1, onChange, hideLabel = false }) {
  const input = el("input", { type: "number", value, min, max, step, inputmode: "decimal", "aria-label": label });
  input.addEventListener("change", () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) v = Number(min ?? 0);
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    input.value = v;
    onChange?.(v);
  });
  const root = hideLabel ? input : el("label", { class: "field" }, el("span", { text: label }), input);
  return { root, input, set(v) { if (document.activeElement !== input) input.value = v; } };
}

export function checkbox({ label, checked = false, onChange, title }) {
  const input = el("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange?.(input.checked));
  const root = el("label", { class: "check", title }, input, el("span", { text: label }));
  return { root, input, set(v) { input.checked = !!v; } };
}

export function colourField({ label, value, onChange }) {
  const input = el("input", { type: "color", value, "aria-label": label, title: label });
  input.addEventListener("change", () => onChange?.(input.value));
  return { root: input, input, set(v) { input.value = v; } };
}
