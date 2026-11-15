// The camera controls over a 3D view (the Market and Store tabs, under
// the 2D/3D switch): a button per camera preset, Focus, the pickers that
// say what a preset aims at, and a line saying what the camera shows now.
// It decides nothing: the tab says which actions can run now and, when one
// can't, why; the view does the moving (view-3d.js). An action that can't
// run stays in the bar, marked unavailable (aria-disabled, so it can still
// be focused and read), its reason in its title, read out with it, listed
// under the bar, and shown in the status line if it's pressed anyway.

import { el } from "./ui.js";

let uid = 0;

export class CameraBar {
  // `presets`: [{ id, label, title }]; `onPreset(id)`, `onFocus()`, `onStop()`.
  constructor({ label, presets, onPreset, onFocus, onStop = null }) {
    this.actions = new Map();          // id → { button, reason, title, ok, why }
    this.presetIds = presets.map((p) => p.id);
    const group = el("div", { class: "seg camera-presets", role: "group", "aria-label": `${label}: presets` },
      ...presets.map((p) => this.#action(p.id, p.label, p.title, () => onPreset(p.id), true)));
    this.focusButton = this.#action("focus", "Focus", "Turn the camera to the selection", () => onFocus(), false, "btn small");
    this.targets = el("span", { class: "camera-targets" });
    this.stopButton = el("button", { type: "button", class: "btn small camera-stop", text: "Stop follow", hidden: true, onclick: () => onStop?.() });
    this.status = el("span", { class: "camera-status", role: "status", "aria-live": "polite" });
    this.note = el("p", { class: "camera-note" });
    this.root = el("div", { class: "camera-bar", role: "toolbar", "aria-label": label, hidden: true },
      el("div", { class: "camera-row" }, group, this.focusButton, this.targets, this.stopButton),
      el("div", { class: "camera-row" }, this.status), this.note);
  }

  #action(id, label, title, run, preset, cls = "") {
    const rid = `camera-why-${++uid}`;
    const reason = el("span", { class: "visually-hidden", id: rid });
    const button = el("button", { type: "button", class: cls || undefined, text: label, title, "aria-describedby": rid, ...(preset ? { "aria-pressed": "false" } : {}) });
    button.addEventListener("click", () => {
      const a = this.actions.get(id);
      if (!a.ok) { this.#explain(a.why); return; }
      run();
    });
    this.actions.set(id, { button, reason, title, ok: true, why: "" });
    return el("span", { class: "camera-action" }, button, reason);
  }

  // Whether action `id` can run now and, if not, why ({ ok, reason }).
  setAvailable(id, { ok, reason = "" }) {
    const a = this.actions.get(id); if (!a) return;
    if (a.ok === ok && a.why === reason) return;
    a.ok = ok; a.why = ok ? "" : reason;
    a.button.setAttribute("aria-disabled", String(!ok));
    toggleClass(a.button, "is-disabled", !ok);
    a.button.title = ok ? a.title : reason;
    a.reason.textContent = ok ? "" : `Unavailable: ${reason}`;
    const off = [...this.actions.entries()].filter(([, x]) => !x.ok).map(([k, x]) => `${this.#name(k)}: ${x.why}`);
    this.note.textContent = off.join(" · ");
    this.note.hidden = !off.length;
  }

  // What Focus would aim at, on its button.
  setFocusTitle(title) {
    const a = this.actions.get("focus"); a.title = title;
    if (a.ok) a.button.title = title;
  }

  isAvailable(id) { return this.actions.get(id)?.ok ?? false; }

  #name(id) { return this.actions.get(id).button.textContent; }

  // What the camera shows now (the view's cameraState). Called whenever
  // anything changes (each frame, on the Store tab): the reason an
  // unavailable action was pressed stays up until the camera's state does.
  setState(state) {
    for (const id of this.presetIds) this.actions.get(id).button.setAttribute("aria-pressed", String(state.mode === id));
    const tracking = state.mode === "follow";
    this.stopButton.hidden = !tracking;
    const text = `Camera: ${state.label || state.mode}${state.note ? ` — ${state.note}` : ""}`;
    if (text !== this.stateText) { this.stateText = text; this.explained = ""; }
    this.setStatus(this.explained ? `${text} — ${this.explained}` : text, tracking);
  }

  // Why a pressed action didn't run, after what the camera shows.
  #explain(why) {
    this.explained = why;
    this.setStatus(this.stateText ? `${this.stateText} — ${why}` : why, this.status.className.includes("tracking"));
  }

  setStatus(text, tracking = false) {
    if (this.status.textContent !== text) this.status.textContent = text;
    toggleClass(this.status, "tracking", tracking);
  }
}

// A picker for what a camera action aims at: a first option that picks
// nothing, then the installed world's own (some unavailable, and saying why).
export function targetSelect({ label, placeholder, onChange }) {
  const node = el("select", { "aria-label": label });
  node.addEventListener("change", () => onChange(node.value === "" ? null : Number(node.value)));
  const root = el("label", { class: "field camera-field" }, el("span", { text: label }), node);
  const option = (o) => el("option", { value: String(o.value), text: o.label, disabled: o.disabled ? true : undefined, title: o.title });
  return {
    root, node,
    // `options`: [{ value, label, disabled, title }] or [{ group, options }]; `value`: kept if still there, else nothing picked.
    setOptions(options, value = null, first = placeholder) {
      node.replaceChildren(el("option", { value: "", text: first }),
        ...options.map((o) => (o.group ? el("optgroup", { label: o.group }, ...o.options.map(option)) : option(o))));
      const keep = value !== null && [...(node.querySelectorAll?.("option") ?? flatOptions(node))]
        .some((o) => o.getAttribute("value") === String(value) && o.getAttribute("disabled") === null);
      node.value = keep ? String(value) : "";
      return keep ? value : null;
    },
    get value() { return node.value === "" ? null : Number(node.value); },
  };
}

// A class on or off (by className, which every DOM the page runs in has).
function toggleClass(node, cls, on) {
  const list = node.className.split(/\s+/).filter((c) => c && c !== cls);
  if (on) list.push(cls);
  node.className = list.join(" ");
}

// Every option under a select (for a DOM without querySelectorAll).
function flatOptions(node) {
  return (node.children ?? []).flatMap((c) => (c.tagName === "OPTGROUP" ? c.children : [c]));
}
