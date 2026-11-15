// A stand-in for the browser, just enough to run the editors' canvas
// (js/fashion/grid-editor.js) under `node --test`: elements that keep their
// attributes, children and listeners, a 2D context that accepts every call,
// and a ResizeObserver and animation frames the test runs by hand.
//
//   const dom = installDom();            // before importing the page's modules
//   dom.resize(wrap, 800, 600);          // gives the element a size, tells its observer
//   dom.frames();                        // runs the frames asked for
//   canvas.dispatch("pointerdown", { clientX, clientY, ... })

class FakeNode {}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parent = null;
    this.attributes = new Map(); this.listeners = new Map();
    this.dataset = {}; this.className = ""; this.textContent = "";
    this.hidden = false; this.disabled = false; this.title = "";
    this.clientWidth = 0; this.clientHeight = 0; this.width = 0; this.height = 0;
    this.captured = new Set();
    const style = { props: new Map(), setProperty(k, v) { this.props.set(k, v); }, getPropertyValue(k) { return this.props.get(k) ?? ""; } };
    this.style = style;
    this.box = { left: 0, top: 0 };
  }
  // The classes, kept in className.
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const set = (list) => { this.className = list.join(" "); };
    return {
      add: (...c) => set([...new Set([...names(), ...c])]),
      remove: (...c) => set(names().filter((n) => !c.includes(n))),
      contains: (c) => names().includes(c),
      toggle: (c, on = !names().includes(c)) => { set(on ? [...new Set([...names(), c])] : names().filter((n) => n !== c)); return on; },
    };
  }
  append(...nodes) { for (const n of nodes) { if (n instanceof FakeElement) n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  dispatch(type, ev = {}) {
    const e = { type, target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, ...ev };
    for (const fn of this.listeners.get(type) ?? []) fn(e);
    return e;
  }
  click() { this.dispatch("click"); }
  focus() { this.focused = true; }
  setPointerCapture(id) { this.captured.add(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  getBoundingClientRect() { return { left: this.box.left, top: this.box.top, width: this.clientWidth, height: this.clientHeight, right: this.box.left + this.clientWidth, bottom: this.box.top + this.clientHeight }; }
  getContext() { this.context ??= fakeContext(); return this.context; }
  // Every element under this one, itself included.
  all() { return [this, ...this.children.filter((c) => c instanceof FakeElement).flatMap((c) => c.all())]; }
  find(test) { return this.all().find(test); }
  findAll(test) { return this.all().filter(test); }
  get text() { return this.textContent + this.children.map((c) => (c instanceof FakeElement ? c.text : c.text ?? "")).join(""); }
}

// A drawing context: properties read back as set, every method a no-op
// that counts its calls.
function fakeContext() {
  const state = { fillStyle: "#000000", calls: {} };
  return new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args) => { t.calls[k] = (t.calls[k] ?? 0) + 1; t.last = { name: k, args }; };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

export function installDom({ dpr = 1 } = {}) {
  const observers = [];
  const media = { coarse: false };
  let queue = [];
  const g = globalThis;
  g.Node = FakeNode;
  g.document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: (text) => ({ text: String(text) }),
    addEventListener() {},
    documentElement: new FakeElement("html"),
    body: new FakeElement("body"),
  };
  g.window = g;
  g.devicePixelRatio = dpr;
  g.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe(el) { this.el = el; } disconnect() {} };
  g.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
  g.cancelAnimationFrame = () => {};
  g.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return fakeContext(); } };
  g.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
  g.matchMedia = (q) => ({ matches: media.coarse && q.includes("coarse"), addEventListener() {} });
  g.getComputedStyle = () => ({ getPropertyValue: () => "#808080" });
  return {
    element: (tag = "div") => new FakeElement(tag),
    // Whether the pointer is a finger (pointer: coarse), for editors made from now on.
    coarse(on) { media.coarse = on; },
    // Gives `el` a size and tells whoever observes it.
    resize(el, w, h) { el.clientWidth = w; el.clientHeight = h; for (const o of observers) if (o.el === el) o.cb(); },
    // Runs the animation frames asked for so far (and those they ask for).
    frames() { for (let i = 0; i < 5 && queue.length; i++) { const q = queue; queue = []; for (const fn of q) fn(); } },
  };
}

// A pointer event at a point of the canvas (CSS px from its top left).
export function pointer(x, y, extra = {}) {
  return { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: x, clientY: y, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...extra };
}
