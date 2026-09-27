// The loading screen over the world view.
//
// The engine reports each boot step as active or done (and the library's
// download in bytes); the model step is the main thread's own. The bar only
// moves for real progress: finished steps, plus the fraction of the library
// that has arrived.

const WEIGHTS = { runtime: 0.5, library: 0.2, netlogor: 0.2, model: 0.1 };

export class LoadingScreen {
  #root;
  #steps;
  #bytes;
  #bar;
  #libraryFraction = 0;

  constructor(root) {
    this.#root = root;
    this.#steps = new Map([...root.querySelectorAll("[data-step]")].map((el) => [el.dataset.step, el]));
    this.#bytes = root.querySelector("[data-bytes]");
    this.#bar = root.querySelector(".loading-bar");
  }

  // Back to the start, e.g. for a rebuild.
  reset(title = "Starting the NetLogoR engine") {
    this.#root.querySelector(".loading-title").textContent = title;
    for (const el of this.#steps.values()) delete el.dataset.state;
    this.#bytes.textContent = "";
    this.#libraryFraction = 0;
    this.#update();
    this.#root.hidden = false;
  }

  step(name, state, { loaded, total } = {}) {
    const el = this.#steps.get(name);
    if (!el) return;
    el.dataset.state = state;
    if (name === "library") {
      if (total) {
        this.#libraryFraction = loaded / total;
        this.#bytes.textContent = `${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
      }
      if (state === "done") this.#libraryFraction = 1;
    }
    this.#update();
  }

  // Marks whatever was in progress as failed and leaves the screen up, so
  // the banner explaining why has context.
  fail() {
    for (const el of this.#steps.values()) {
      if (el.dataset.state === "active") el.dataset.state = "error";
    }
  }

  hide() {
    this.#root.hidden = true;
  }

  #update() {
    let progress = 0;
    for (const [name, el] of this.#steps) {
      if (el.dataset.state === "done") progress += WEIGHTS[name];
      else if (name === "library") progress += WEIGHTS.library * this.#libraryFraction;
    }
    this.#bar.style.setProperty("--progress", progress.toFixed(3));
  }
}
