// The 2D/3D switch on the Market and Store tabs, and the Reset view button
// beside it. 2D is the default and is always there: 3D loads Three.js on
// first use (three-loader.js), and if this browser has no WebGL, or the 3D
// view can't start or loses its WebGL context, the switch goes back to 2D
// and says why. Switching only changes what the page draws: nothing is
// sent to the simulation, so the season runs exactly as it would have.

import { el, segmented } from "./ui.js";
import { webglSupported } from "./three-loader.js";

export class ViewSwitch {
  // `load()` resolves to { THREE, ...modules }; `create(loaded)` makes the 3D
  // view (with the tab's state already in it); `apply(is3d)` shows one view
  // and hides the other; `supported()` says whether WebGL is there.
  constructor({ app, what, load, create, apply, supported = webglSupported }) {
    this.app = app; this.what = what; this.load = load; this.create = create; this.apply = apply; this.supported = supported;
    this.mode = "2d"; this.wanted = "2d"; this.view = null;
    this.seg = segmented({ label: `${what}: 2D or 3D`, value: "2d", options: [
      { value: "2d", label: "2D", title: `The ${what.toLowerCase()} as a plan` },
      { value: "3d", label: "3D", title: `The ${what.toLowerCase()} in 3D: drag to turn it, right-drag (or Shift-drag) to move, scroll to zoom` }],
    onChange: (v) => this.set(v) });
    // Reset: back to the Overview, the starting angle (a camera move: see view-3d.js).
    this.reset = el("button", { type: "button", class: "btn small", text: "Reset view", hidden: true, title: "Back to the starting angle", onclick: () => this.view?.runAction(() => this.view.goPreset("overview")) });
    this.root = el("span", { class: "row view-switch" }, this.seg.root, this.reset);
  }

  get is3d() { return this.mode === "3d"; }

  async set(v) {
    this.wanted = v;
    if (v === "3d" && !this.view) {
      if (!this.supported()) return this.#fallback("3D isn't available in this browser", "It can't draw WebGL, so the 2D view stays.", true);
      try {
        const loaded = await this.load();
        if (this.wanted !== "3d" || this.view) return this.#show();       // switched back while loading
        this.view = this.create(loaded);
        this.view.onLost = () => {
          this.view?.dispose(); this.view = null;
          this.#fallback("The 3D view stopped", "The browser took its WebGL context away; the 2D view is back. Pick 3D to start it again.");
        };
      } catch (err) {
        this.view?.dispose(); this.view = null;
        return this.#fallback("The 3D view couldn't start", err?.message ?? String(err));
      }
    }
    this.#show();
  }

  #show() {
    this.mode = this.wanted === "3d" && this.view ? "3d" : "2d";
    this.seg.set(this.mode);
    this.reset.hidden = this.mode !== "3d";
    this.apply(this.mode === "3d");
    this.view?.setActive(this.mode === "3d");
  }

  #fallback(title, message, disable = false) {
    this.wanted = "2d";
    this.#show();
    if (disable) {
      const b = this.seg.root.children?.[1];
      if (b) { b.disabled = true; b.title = "3D needs WebGL, which this browser doesn't offer"; }
    }
    this.app.banner(title, message);
  }
}
