// The world views: canvases that draw R worlds, one renderer each.
//
// The first view (in the interface's order) is the page's own canvas. It
// carries the loading screen and the tick counter, speed and fps readout, and
// it is the one Record records. Every further `view` line gets a canvas of
// its own. Without any `view` line, the first view keeps its panel beside the
// controls, drawing `world` and `turtles`.
//
// Frame section i (see r/workbench.R) is drawn by view i. R decides each
// view's categories and turtle shape; the continuous palette is applied here:
// a view's own `palette`, else the model-wide one (the palette chooser).

import { WorldRenderer, PALETTES } from "./renderer.js";
import { DEFAULT_VIEW } from "./spec-parser.js";

const element = (tag, className) => Object.assign(document.createElement(tag), { className });

export class WorldViews {
  #home;
  #primary;
  #extras = new Map();  // name → view, for every view after the first
  #views;               // in frame order
  #palette = "viridis";

  constructor({ box, canvas, home }) {
    this.#home = home;
    this.#primary = this.#watch({ box, canvas, renderer: new WorldRenderer(canvas), spec: DEFAULT_VIEW });
    this.#views = [this.#primary];
  }

  // What each view draws and how, in frame order, as SET_VIEWS wants it.
  get specs() {
    return this.#views.map(({ spec }) => spec);
  }

  // Each view's last frame, to carry over what the next one leaves out.
  get frames() {
    return this.#views.map((view) => view.renderer.frame);
  }

  // Puts each view where the interface says: `slots` are the view widgets'
  // elements with their specs, in spec order. A view keeps its canvas (and
  // picture) as long as its name stays. Returns whether the views are
  // placed among the widgets.
  arrange(slots) {
    if (!slots.length) {
      this.#assign(this.#primary, DEFAULT_VIEW, this.#home);
      this.#views = [this.#primary];
      this.#drop(new Set());
      return false;
    }

    const [first, ...rest] = slots;
    this.#assign(this.#primary, first.spec, first.slot);
    this.#views = [this.#primary];
    for (const { slot, spec } of rest) {
      const view = this.#extras.get(spec.name) ?? this.#create(spec.name);
      this.#assign(view, spec, slot);
      this.#views.push(view);
    }
    this.#drop(new Set(rest.map(({ spec }) => spec.name)));
    return true;
  }

  #assign(view, spec, home) {
    view.spec = spec;
    view.renderer.setPalette(spec.palette ?? this.#palette);
    place(view.box, home);
  }

  // Keeps each frame's shape matched to its world.
  fit(frame) {
    frame.views.forEach((section, i) => {
      const view = this.#views[i];
      if (view && !section.missing && section.height > 0) {
        view.box.style.setProperty("--world-aspect", String(section.width / section.height));
      }
    });
  }

  // Draws one frame: section i on view i.
  show(frame) {
    frame.views.forEach((section, i) => {
      const view = this.#views[i];
      if (!view) return;
      if (section.missing) {
        view.renderer.clear();
        view.note = `${view.spec.world} doesn't exist yet`;
        paintEmpty(view.canvas, view.note);
      } else {
        view.note = null;
        view.renderer.setFrame(section);
        view.renderer.paint();
      }
    });
  }

  // Empties every view, e.g. while R restarts.
  clear() {
    for (const view of this.#views) {
      view.renderer.clear();
      view.note = null;
      paintEmpty(view.canvas);
    }
  }

  // The model-wide continuous palette, for views that don't name their own.
  // Palettes are applied here, so switching one repaints what's on screen
  // without touching the model. An unknown name falls back to viridis.
  setPalette(name) {
    this.#palette = Object.hasOwn(PALETTES, name) ? name : "viridis";
    for (const view of this.#views) view.renderer.setPalette(view.spec.palette ?? this.#palette);
  }

  #create(name) {
    const box = element("div", "view-box");
    const fit = element("div", "view-fit");
    const frame = element("div", "view-frame");
    const canvas = element("canvas", "");
    canvas.setAttribute("aria-label", `World view ${name}`);
    frame.append(canvas);
    fit.append(frame);
    box.append(fit);

    // Room for the tick counter and speed bar the first view carries, kept
    // empty, so views of the same size give their worlds the same space and
    // line up side by side.
    const bar = this.#primary.box.querySelector(".view-meta");
    if (bar) {
      const room = bar.cloneNode(true);
      room.classList.add("view-meta-room");
      for (const node of room.querySelectorAll("[id], [aria-describedby]")) {
        node.removeAttribute("id");
        node.removeAttribute("aria-describedby");
      }
      room.setAttribute("aria-hidden", "true");
      room.inert = true;
      box.append(room);
    }

    const view = this.#watch({ box, canvas, renderer: new WorldRenderer(canvas), spec: null });
    this.#extras.set(name, view);
    return view;
  }

  #drop(keep) {
    for (const [name, view] of this.#extras) {
      if (keep.has(name)) continue;
      view.observer.disconnect();
      view.box.remove();
      this.#extras.delete(name);
    }
  }

  // Keeps the canvas backing store matched to its CSS size ×
  // devicePixelRatio so patches stay crisp, and repaints whenever that size
  // changes.
  #watch(view) {
    const { canvas } = view;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(width * dpr));
      const h = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        view.renderer.frame ? view.renderer.paint() : paintEmpty(canvas, view.note);
      }
    };
    view.observer = new ResizeObserver(resize);
    view.observer.observe(canvas);
    resize();
    return view;
  }
}

function place(box, home) {
  if (box.parentElement !== home) home.append(box);
}

// An empty patch grid, so a view with nothing to draw still reads as a
// world, optionally with a short note in the middle.
function paintEmpty(canvas, note = null) {
  const ctx = canvas.getContext("2d");
  const patches = 33;
  const size = canvas.width / patches;
  ctx.fillStyle = getComputedStyle(canvas.parentElement).backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < patches; i++) {
    const p = Math.round(i * size) + 0.5;
    ctx.moveTo(p, 0);
    ctx.lineTo(p, canvas.height);
    ctx.moveTo(0, p);
    ctx.lineTo(canvas.width, p);
  }
  ctx.stroke();

  if (note) {
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "rgba(229, 232, 237, 0.6)";
    ctx.font = `${12 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(note, canvas.width / 2, canvas.height / 2, canvas.width - 16 * dpr);
  }
}
