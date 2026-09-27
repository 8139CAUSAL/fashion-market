// The model's R code, file by file, read-only: what's running is exactly
// what's shown. The last tab is the world: the one on the Setup tab,
// exactly as Export would write it.

import { el } from "./ui.js";

const MODEL_URL = new URL("../../model/", import.meta.url);
const VENDOR_URL = new URL("../../vendor/codemirror.js", import.meta.url);
const WORLD_TAB = "world.json";

export class CodeDrawer {
  constructor(root, openButton, closeButton, world) {
    this.root = root; this.files = root.querySelector("#code-files"); this.body = root.querySelector("#code-body");
    this.openButton = openButton; this.loaded = null; this.view = null; this.texts = new Map(); this.world = world;
    this.showing = null; this.buttons = [];
    openButton.addEventListener("click", () => this.toggle());
    closeButton.addEventListener("click", () => this.toggle(false));
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && this.isOpen) this.toggle(false); });
    let timer = 0;
    world?.addEventListener("change", () => { clearTimeout(timer); timer = setTimeout(() => this.refresh(), 400); });
  }

  get isOpen() { return this.root.classList.contains("open"); }

  async toggle(open = !this.isOpen) {
    this.root.classList.toggle("open", open);
    this.root.inert = !open;
    this.root.setAttribute("aria-hidden", String(!open));
    this.openButton.setAttribute("aria-expanded", String(open));
    if (open) await (this.loaded ??= this.#load());
  }

  // The world changed: show it again if it's the tab open.
  refresh() { if (this.isOpen && this.showing === WORLD_TAB) this.#show(WORLD_TAB); }

  async #load() {
    const index = await fetch(new URL("index.json", MODEL_URL)).then((r) => r.json());
    const names = [...index.files, WORLD_TAB];
    this.buttons = names.map((name) => el("button", { type: "button", role: "tab", text: name, "aria-selected": "false", onclick: () => this.#show(name) }));
    this.files.replaceChildren(...this.buttons);
    await Promise.all(index.files.map(async (name) => this.texts.set(name, await fetch(new URL(name, MODEL_URL)).then((r) => r.text()))));
    try { this.cm = await import(VENDOR_URL); } catch { this.cm = null; }
    this.#show(index.files.includes("main.R") ? "main.R" : index.files[0]);
  }

  #show(name) {
    this.showing = name;
    this.buttons.forEach((b) => b.setAttribute("aria-selected", String(b.textContent === name)));
    const text = name === WORLD_TAB ? (this.world?.draft ? this.world.text() : "") : this.texts.get(name) ?? "";
    const cm = this.cm;
    if (!cm) { this.body.replaceChildren(el("pre", { text })); return; }
    const { EditorView, EditorState, StreamLanguage, HighlightStyle, syntaxHighlighting, tags } = cm;
    const highlight = HighlightStyle.define([
      { tag: tags.keyword, color: "var(--focus)", fontWeight: "600" },
      { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
      { tag: tags.string, color: "var(--accent-ink)" },
      { tag: tags.number, color: "var(--cat-7)" },
      { tag: tags.atom, color: "var(--cat-7)" },
      { tag: tags.operator, color: "var(--ink-2)" },
    ]);
    this.view?.destroy();
    this.view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [cm.lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false),
          ...(name === WORLD_TAB ? [] : [StreamLanguage.define(cm.rMode)]), syntaxHighlighting(highlight),
          EditorView.theme({ "&": { fontSize: "12px", background: "var(--surface)", color: "var(--ink)" },
            ".cm-gutters": { background: "var(--surface-2)", color: "var(--muted)", border: "none" },
            ".cm-content": { fontFamily: "var(--mono)" } })],
      }),
    });
    this.body.replaceChildren(this.view.dom);
  }
}
