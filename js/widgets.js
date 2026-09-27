// Builds the widget grid from a resolved layout.
//
// Every control here comes straight from the interface spec: the spec says
// what exists and where it sits, this turns that into real DOM. Interaction
// is reported through callbacks — onAction and onToggle for buttons,
// onChange for anything holding a value, onImport for files — which main.js
// forwards to R.
//
// The grid is one page-wide CSS grid of fixed-size cells. A panel is a
// <section> spanning its cells as a subgrid, so the widgets inside it still
// sit on the page's own rows and columns.

import { gridTracks } from "./layout.js";
import { viewSpec, displaySpec, DISPLAY_TYPES } from "./spec-parser.js";

const element = (tag, className, props = {}) => Object.assign(document.createElement(tag), { className, ...props });

// A widget's visible label. An empty label ("") shows none, e.g. the cells
// of a matrix; the control is then named after the widget for screen readers.
function labelFor(widget, wrapper, control) {
  const text = widget.label ?? widget.name;
  if (text) return element("span", "w-label", { textContent: text });
  wrapper.classList.add("is-unlabelled");
  control?.setAttribute("aria-label", widget.name);
  return null;
}

export class WidgetGrid {
  #container;
  #handlers;
  #widgets = new Map();
  #disabled = false;

  // Where each `view` line's world view goes, in spec order:
  // [{ slot, spec }]. Empty when the spec has no view line.
  viewSlots = [];

  constructor(container, handlers = {}) {
    this.#container = container;
    this.#handlers = handlers;
  }

  // Widget values by name, as the model's R variables should see them.
  get values() {
    const values = {};
    for (const [name, entry] of this.#widgets) {
      if (entry.value !== undefined) values[name] = entry.value;
    }
    return values;
  }

  get monitors() {
    return [...this.#widgets.values()].map((entry) => entry.widget).filter((widget) => widget.type === "monitor");
  }

  get foreverButtons() {
    return [...this.#widgets.values()].map((entry) => entry.widget).filter((widget) => widget.forever);
  }

  // What the plots and reports ask of the engine, with the size each has to
  // fill: pixels for a plot, characters per line for a report. Measured
  // from the laid-out page, so call it after render().
  displaySpecs() {
    const specs = [];
    for (const { widget, area } of this.#widgets.values()) {
      if (!DISPLAY_TYPES.includes(widget.type)) continue;
      const { width, height } = area.getBoundingClientRect();
      specs.push({
        ...displaySpec(widget),
        width: Math.max(40, Math.round(width)),
        height: Math.max(30, Math.round(height)),
        columns: Math.max(20, Math.floor((width - 16) / this.#charWidth(area))),
      });
    }
    return specs;
  }

  // Shows what the engine drew or printed: { image } for a plot, { text }
  // for a report, or { error }.
  // Returns whether there was a widget to show it.
  showDisplay(name, shown) {
    const entry = this.#widgets.get(name);
    if (!entry?.show) return false;
    entry.show(shown);
    return true;
  }

  // The width of one character in a report's font, measured once.
  #charWidthPx = 0;
  #charWidth(area) {
    if (!this.#charWidthPx) {
      const probe = element("span", "w-report-text", { textContent: "0".repeat(20) });
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;padding:0;border:0";
      area.append(probe);
      this.#charWidthPx = probe.getBoundingClientRect().width / 20 || 7.2;
      probe.remove();
    }
    return this.#charWidthPx;
  }

  // The import widgets, in spec order (the order their code reruns in).
  get imports() {
    return [...this.#widgets.values()].map((entry) => entry.widget)
      .filter((widget) => widget.type === "import")
      .sort((a, b) => a.id - b.id);
  }

  render(layout) {
    this.#container.replaceChildren();
    this.#widgets.clear();
    this.viewSlots = [];

    const tracks = gridTracks(layout);
    this.#container.style.gridTemplateColumns = tracks.columns;
    this.#container.style.gridTemplateRows = tracks.rows;
    const place = (el, area) => {
      el.style.gridRow = area.row;
      el.style.gridColumn = area.column;
    };

    // Top-level panels and widgets go into the DOM in reading order, and
    // each panel's widgets in reading order inside it.
    const top = [];
    const panels = new Map();
    for (const panel of layout.panels) {
      const section = element("section", "w-panel");
      section.dataset.name = panel.name;
      if (panel.title) {
        section.classList.add("is-titled");
        section.append(element("h3", "w-panel-title", { textContent: panel.title, title: panel.title }));
      }
      place(section, tracks.area(panel));
      panels.set(panel.id, { panel, section });
      top.push({ item: panel, el: section });
    }

    for (const widget of layout.widgets) {
      const entry = this.#build(widget);
      entry.element.classList.add("widget", `widget-${widget.type}`);
      entry.element.dataset.name = widget.name;
      this.#widgets.set(widget.name, entry);

      const home = panels.get(widget.panel);
      place(entry.element, tracks.area(widget, home?.panel));
      if (home) home.section.append(entry.element);
      else top.push({ item: widget, el: entry.element });
    }

    top.sort((a, b) => a.item.row - b.item.row || a.item.col - b.item.col);
    this.#container.append(...top.map(({ el }) => el));
    this.viewSlots.sort((a, b) => a.id - b.id);
    this.#applyDisabled();
  }

  // While R restarts the controls stay where they are, but can't be used.
  setDisabled(disabled) {
    this.#disabled = disabled;
    this.#applyDisabled();
  }

  #applyDisabled() {
    this.#container.inert = this.#disabled;
    this.#container.classList.toggle("is-waiting", this.#disabled);
  }

  // Sets a monitor's displayed value (PR 2.4 feeds these from R).
  setMonitor(name, text) {
    const entry = this.#widgets.get(name);
    if (entry?.setValue) entry.setValue(text);
  }

  // Updates a control to match a value that came from R. Assigning to the
  // DOM directly fires no input/change event, so this can't loop back.
  setValue(name, value) {
    const entry = this.#widgets.get(name);
    if (!entry || entry.value === undefined) return;
    entry.value = value;
    entry.applyValue?.(value);
  }

  // Appends a line to every output widget in the spec.
  appendOutput(text) {
    for (const entry of this.#widgets.values()) {
      if (entry.widget.type === "output") entry.append?.(text);
    }
  }

  // Shows an import's file, as { state, text } (see describeImport).
  setImport(name, shown) {
    this.#widgets.get(name)?.showImport?.(shown);
  }

  // Reflects the run state on a forever button (the element is the button).
  setRunning(name, running) {
    const entry = this.#widgets.get(name);
    if (entry?.widget.forever) entry.element.setAttribute("aria-pressed", String(running));
  }

  #build(widget) {
    switch (widget.type) {
      case "button": return this.#button(widget);
      case "slider": return this.#slider(widget);
      case "switch": return this.#switch(widget);
      case "chooser": return this.#chooser(widget);
      case "input": return this.#input(widget);
      case "monitor": return this.#monitor(widget);
      case "note": return this.#note(widget);
      case "output": return this.#output(widget);
      case "view": return this.#view(widget);
      case "import": return this.#import(widget);
      case "plot": return this.#plot(widget);
      case "report": return this.#report(widget);
      default: return { widget, element: element("div", "w-unknown", { textContent: widget.type }) };
    }
  }

  // A plain button runs its action once; a forever button toggles, staying
  // pressed while the model runs.
  #button(widget) {
    const button = element("button", "w-button", { type: "button", textContent: widget.label || widget.name });
    if (widget.forever) button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      if (widget.forever) {
        const running = button.getAttribute("aria-pressed") !== "true";
        button.setAttribute("aria-pressed", String(running));
        this.#handlers.onToggle?.(widget, running);
      } else {
        this.#handlers.onAction?.(widget);
      }
    });
    return { widget, element: button };
  }

  #slider(widget) {
    const wrapper = element("label", "w-field w-slider");
    const readout = element("output", "w-readout", { textContent: format(widget.value, widget.step) });
    const input = element("input", "w-range", {
      type: "range",
      min: widget.min,
      max: widget.max,
      step: widget.step,
      value: widget.value,
    });
    const label = labelFor(widget, wrapper, input);

    const entry = {
      widget,
      element: wrapper,
      value: widget.value,
      applyValue: (value) => {
        input.value = String(value);
        readout.textContent = format(value, widget.step);
      },
    };
    input.addEventListener("input", () => {
      entry.value = Number(input.value);
      readout.textContent = format(entry.value, widget.step);
      this.#handlers.onChange?.(widget.name, entry.value, widget);
    });

    wrapper.append(...[label, readout, input].filter(Boolean));
    return entry;
  }

  #switch(widget) {
    const wrapper = element("label", "w-field w-switch-field");
    const input = element("input", "w-switch-input", { type: "checkbox", checked: widget.value });
    const track = element("span", "w-switch-track");
    const label = labelFor(widget, wrapper, input);

    const entry = {
      widget,
      element: wrapper,
      value: widget.value,
      applyValue: (value) => { input.checked = Boolean(value); },
    };
    input.addEventListener("change", () => {
      entry.value = input.checked;
      this.#handlers.onChange?.(widget.name, entry.value, widget);
    });

    wrapper.append(...[input, track, label].filter(Boolean));
    return entry;
  }

  #chooser(widget) {
    const wrapper = element("label", "w-field w-chooser");
    const select = element("select", "w-select");
    const label = labelFor(widget, wrapper, select);
    for (const choice of widget.choices) {
      select.append(element("option", "", { value: choice, textContent: choice, selected: choice === widget.value }));
    }

    const entry = {
      widget,
      element: wrapper,
      value: widget.value,
      applyValue: (value) => { select.value = String(value); },
    };
    select.addEventListener("change", () => {
      entry.value = select.value;
      this.#handlers.onChange?.(widget.name, entry.value, widget);
    });

    wrapper.append(...[label, select].filter(Boolean));
    return entry;
  }

  #input(widget) {
    const wrapper = element("label", "w-field w-input");
    const input = element("input", "w-text", {
      type: widget.numeric ? "number" : "text",
      value: String(widget.value),
    });
    const label = labelFor(widget, wrapper, input);

    const entry = {
      widget,
      element: wrapper,
      value: widget.value,
      applyValue: (value) => { input.value = String(value); },
    };
    input.addEventListener("change", () => {
      entry.value = widget.numeric ? Number(input.value) : input.value;
      this.#handlers.onChange?.(widget.name, entry.value, widget);
    });

    wrapper.append(...[label, input].filter(Boolean));
    return entry;
  }

  #monitor(widget) {
    const wrapper = element("div", "w-field w-monitor");
    const value = element("span", "w-value", { textContent: "—" });
    const label = labelFor(widget, wrapper, null);
    if (!label) wrapper.title = widget.reporter;
    wrapper.append(...[label, value].filter(Boolean));
    return {
      widget,
      element: wrapper,
      setValue: (text) => { value.textContent = text; },
    };
  }

  #note(widget) {
    return { widget, element: element("p", "w-note", { textContent: widget.text }) };
  }

  // An empty frame a world view is moved into (see js/views.js), with its
  // caption if the spec gives one.
  #view(widget) {
    const frame = element("div", "w-view");
    if (widget.label) frame.append(element("span", "w-label w-view-label", { textContent: widget.label }));
    this.viewSlots.push({ id: widget.id, slot: frame, spec: viewSpec(widget) });
    return { widget, element: frame };
  }

  // A plot: R's picture of the model, drawn by the plot's code in R (see
  // drawDisplay in the engine worker). The newest picture replaces the last;
  // an error shows in its place until the code works again.
  #plot(widget) {
    const { wrapper, area, error } = this.#displayFrame(widget, "w-plot");
    const canvas = element("canvas", "w-plot-canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", widget.label || widget.name);
    area.prepend(canvas);
    const context = canvas.getContext("bitmaprenderer");
    return {
      widget,
      element: wrapper,
      area,
      show: ({ image, error: message }) => {
        wrapper.classList.toggle("has-error", Boolean(message));
        error.textContent = message ?? "";
        if (image) {
          canvas.width = image.width;
          canvas.height = image.height;
          context.transferFromImageBitmap(image);
        }
      },
    };
  }

  // A report: what its R code prints, as the R console would show it.
  #report(widget) {
    const { wrapper, area, error } = this.#displayFrame(widget, "w-report");
    const text = element("pre", "w-report-text", { tabIndex: 0 });
    area.prepend(text);
    return {
      widget,
      element: wrapper,
      area,
      show: ({ text: content, error: message }) => {
        wrapper.classList.toggle("has-error", Boolean(message));
        error.textContent = message ?? "";
        if (content !== undefined) text.textContent = content;
      },
    };
  }

  #displayFrame(widget, kind) {
    const wrapper = element("figure", `w-display ${kind}`);
    const area = element("div", "w-display-area");
    const error = element("p", "w-display-error");
    error.setAttribute("role", "status");
    area.append(error);
    if (widget.label) wrapper.append(element("figcaption", "w-label w-display-label", { textContent: widget.label }));
    wrapper.append(area);
    return { wrapper, area, error };
  }

  // A file picker that's also a drop target. What happens to the file is up
  // to main.js (onImport), which reports back through setImport.
  #import(widget) {
    const wrapper = element("div", "w-field w-import");
    wrapper.dataset.state = "empty";
    const input = element("input", "w-import-input", { type: "file", tabIndex: -1 });
    if (widget.accept) input.accept = widget.accept;
    input.setAttribute("aria-hidden", "true");
    const status = element("span", "w-import-status", { textContent: "No file yet" });
    status.setAttribute("aria-live", "polite");
    const choose = element("button", "w-import-choose", { type: "button", textContent: "Choose…" });
    choose.setAttribute("aria-label", `Choose a file for ${widget.label || widget.name}`);
    const label = labelFor(widget, wrapper, null);

    const hand = (files) => this.#handlers.onImport?.(widget, files);
    choose.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const files = [...input.files];
      input.value = "";  // so choosing the same file again still counts
      if (files.length) hand(files);
    });

    const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
    wrapper.addEventListener("dragover", (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      wrapper.classList.add("is-dragging");
    });
    wrapper.addEventListener("dragleave", (event) => {
      if (!wrapper.contains(event.relatedTarget)) wrapper.classList.remove("is-dragging");
    });
    wrapper.addEventListener("drop", (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      wrapper.classList.remove("is-dragging");
      hand([...event.dataTransfer.files]);
    });

    const row = element("div", "w-import-row");
    row.append(status, choose);
    wrapper.append(...[label, row, input].filter(Boolean));
    return {
      widget,
      element: wrapper,
      showImport: ({ state, text }) => {
        wrapper.dataset.state = state;
        status.textContent = text;
        choose.textContent = state === "empty" ? "Choose…" : "Replace…";
        choose.disabled = state === "reading";
      },
    };
  }

  // Console-style log. Older lines are trimmed so a chatty model can't grow
  // the DOM without bound.
  #output(widget) {
    const log = element("pre", "w-output", { tabIndex: 0 });
    log.setAttribute("role", "log");
    const lines = [];
    return {
      widget,
      element: log,
      append: (text) => {
        lines.push(text);
        if (lines.length > 500) lines.splice(0, lines.length - 500);
        log.textContent = lines.join("\n");
        log.scrollTop = log.scrollHeight;
      },
    };
  }
}

// Shows as many decimals as the slider's step implies.
function format(value, step = 1) {
  const decimals = String(step).includes(".") ? String(step).split(".")[1].length : 0;
  return Number(value).toFixed(decimals);
}
