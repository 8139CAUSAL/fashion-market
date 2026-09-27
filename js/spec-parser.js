// Parser for the interface spec. Most lines declare one widget, with an
// optional placement chained on the end:
//
//   button setup
//   button go forever .right()
//   slider population 10..500 = 200 step 10 .under(setup)
//   monitor "turtles" { NLcount(turtles) } .right(population)
//   view w 10 h 8 .right(go)
//   view heat "Heat" world heat_map turtles none palette heat .right()
//   import roads "Road network (.rds)" accept ".rds" { net <<- readRDS(roads) }
//   plot epidemic "Epidemic" { plot(history$t, history$infected, type = "l") } w 8 h 4
//   report summary "Summary" { summary_table } update manual
//
// Lines can also be grouped and generated:
//
//   panel run "Run"              a titled box, placed as one block
//     ...
//   end
//   for s in [a, b, c]           repeats the lines inside, filling in {s}
//     slider rate_{s} "{s}" 0..1 = 0.5
//   end
//   for d in [a, b, c] if d != s skipped values leave an empty space
//
// This is a real parser rather than evaluated code: a spec that arrives in a
// shared link can describe widgets, and nothing else.
//
// parseSpec() returns every generated item in spec order. Besides widgets
// that includes panels (type "panel") and gaps (gap: true), the empty spaces
// an `if` filter leaves so that columns stay aligned. Each item carries an
// `id`, the `panel` id it sits in (or null), and its `relations`.

export const WIDGET_TYPES = ["button", "slider", "switch", "chooser", "input", "monitor", "note", "output", "view", "import", "plot", "report"];

// Widgets that show what R code draws (plot) or prints (report), redrawn
// when their `update` says.
export const DISPLAY_TYPES = ["plot", "report"];
export const DISPLAY_UPDATES = ["ticks", "monitor", "manual"];

// Widgets whose value is an R variable of the same name.
export const VALUE_TYPES = ["slider", "switch", "chooser", "input"];

export const PLACEMENTS = ["right", "under", "left", "above"];

// How a view can draw: continuous patch palettes (js/renderer.js has the
// colours) and turtle shapes.
export const PALETTE_NAMES = ["viridis", "gray", "heat"];
export const TURTLE_SHAPES = ["arrow", "dot", "square"];

// What a view draws and how, as the engine wants it (see .wb_set_views in
// r/workbench.R). Without any `view` line there is one: DEFAULT_VIEW.
export function viewSpec(widget) {
  const { name, world, turtles, layer, colors, palette, shape } = widget;
  return { name, world, turtles, layer, colors, palette, shape };
}

// What a plot or report asks of the engine (see .wb_set_displays in
// r/workbench.R); its size in pixels comes from the page.
export function displaySpec(widget) {
  const { name, type: kind, code, update } = widget;
  return { name, kind, code, update };
}

export const DEFAULT_VIEW = Object.freeze(viewSpec({
  name: "view", world: "world", turtles: "turtles", layer: null, colors: null, palette: null, shape: null,
}));

// Column and row spans, in grid cells.
const DEFAULT_SPAN = {
  button: { cols: 2, rows: 1 },
  slider: { cols: 4, rows: 1 },
  switch: { cols: 3, rows: 1 },
  chooser: { cols: 3, rows: 1 },
  input: { cols: 3, rows: 1 },
  monitor: { cols: 2, rows: 1 },
  note: { cols: 4, rows: 1 },
  output: { cols: 4, rows: 3 },
  view: { cols: 8, rows: 8 },
  import: { cols: 4, rows: 1 },
  plot: { cols: 8, rows: 4 },
  report: { cols: 6, rows: 4 },
};

// A plot follows the world view (once per frame shown); a report, like a
// monitor, is text refreshed about 10 times a second.
const DEFAULT_UPDATE = { plot: "ticks", report: "monitor" };

const R_NAME = /^(?:[A-Za-z]|\.(?![0-9]))[A-Za-z0-9._]*$/;

const R_RESERVED = new Set([
  "if", "else", "repeat", "while", "function", "for", "in", "next", "break",
  "TRUE", "FALSE", "NULL", "Inf", "NaN", "NA", "NA_integer_", "NA_real_",
  "NA_character_", "NA_complex_", "...",
]);

// Variables the engine itself assigns or defines: a slider called `ticks`
// would be overwritten every tick.
const ENGINE_NAMES = new Set(["world", "turtles", "ticks", "stop_run", "workbench_data", "workbench_download", "update_display"]);

const PLACEMENT_START = /^\.(right|under|left|above)\s*\(/;
const INTERPOLATION = /\{([A-Za-z_.][A-Za-z0-9_.]*)\}/g;

export class SpecError extends Error {
  constructor(message, line) {
    super(message);
    this.name = "SpecError";
    this.line = line;
  }
}

// ---- Scanner ----------------------------------------------------------

// Splits the spec into logical lines, keeping { ... } blocks of R code
// together even when they span several lines, and dropping comments.
function splitLogicalLines(text) {
  const lines = [];
  let current = "";
  let startLine = 0;
  let depth = 0;

  text.split(/\r?\n/).forEach((raw, index) => {
    let line = depth > 0 ? raw : stripComment(raw);
    depth += countBraces(line);
    if (current === "") startLine = index + 1;
    current += (current ? "\n" : "") + line;
    if (depth <= 0) {
      if (current.trim()) lines.push({ text: current.trim(), line: startLine });
      current = "";
      depth = 0;
    }
  });

  if (current.trim()) lines.push({ text: current.trim(), line: startLine });
  return lines;
}

function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
    else if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function countBraces(line) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
    else if (!inString && ch === "{") depth++;
    else if (!inString && ch === "}") depth--;
  }
  return depth;
}

const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9._?-]/.test(ch);

// `{x}` glued to a word (`lam_{x}`) is meant as interpolation. If it
// survived interpolation, x isn't a loop variable here.
function notALoopVariable(name, loopVars) {
  const known = loopVars.length ? ` (loop variables here: ${loopVars.join(", ")})` : "";
  return `{${name}} isn't a loop variable${known}, so it can't be part of a name.`;
}

function tokenize(source, lineNumber, loopVars = []) {
  const tokens = [];
  let i = 0;

  const fail = (message) => {
    throw new SpecError(message, lineNumber);
  };

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) { i++; continue; }

    if (ch === '"') {
      let value = "";
      i++;
      while (i < source.length && source[i] !== '"') {
        value += source[i] === "\\" ? source[++i] : source[i];
        i++;
      }
      if (source[i] !== '"') fail("Unclosed quote.");
      i++;
      tokens.push({ type: "string", value });
      continue;
    }

    if (ch === "{") {
      let depth = 0;
      const start = ++i;
      let inString = false;
      for (; i < source.length; i++) {
        const c = source[i];
        if (c === '"' && source[i - 1] !== "\\") inString = !inString;
        else if (!inString && c === "{") depth++;
        else if (!inString && c === "}") {
          if (depth === 0) break;
          depth--;
        }
      }
      if (source[i] !== "}") fail("Unclosed { block.");
      const value = source.slice(start, i).trim();
      i++;
      if (isWordChar(source[i]) && /^[A-Za-z_.][A-Za-z0-9_.]*$/.test(value)) fail(notALoopVariable(value, loopVars));
      tokens.push({ type: "block", value });
      continue;
    }

    if (ch === "[") {
      const end = source.indexOf("]", i);
      if (end === -1) fail("Unclosed [ list.");
      const items = splitList(source.slice(i + 1, end));
      if (!items.length) fail("A list needs at least one choice.");
      tokens.push({ type: "list", value: items });
      i = end + 1;
      continue;
    }

    const placement = source.slice(i).match(PLACEMENT_START);
    if (placement) {
      const kind = placement[1];
      const open = i + placement[0].length - 1;
      const close = source.indexOf(")", open);
      if (close === -1) fail(`Unclosed .${kind}(.`);
      tokens.push({ type: "placement", value: parsePlacement(kind, source.slice(open + 1, close), fail) });
      i = close + 1;
      continue;
    }

    if (ch === "=") { tokens.push({ type: "equals" }); i++; continue; }

    const rest = source.slice(i);
    const range = rest.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)/);
    if (range) {
      tokens.push({ type: "range", value: [Number(range[1]), Number(range[2])] });
      i += range[0].length;
      continue;
    }

    const number = rest.match(/^-?\d+(?:\.\d+)?/);
    if (number) {
      tokens.push({ type: "number", value: Number(number[0]) });
      i += number[0].length;
      continue;
    }

    // Words take NetLogo-style characters too (`horizon-hours`,
    // `record?`), so the name check can say what to write instead. A
    // placement glued on (`forever.right(setup)`) ends the word.
    if (/[A-Za-z_.]/.test(ch)) {
      let end = i + 1;
      while (end < source.length && isWordChar(source[end]) && !PLACEMENT_START.test(source.slice(end))) end++;
      const glued = source.slice(end).match(/^\{([A-Za-z_.][A-Za-z0-9_.]*)\}/);
      if (glued) fail(notALoopVariable(glued[1], loopVars));
      tokens.push({ type: "word", value: source.slice(i, end) });
      i = end;
      continue;
    }

    fail(`Unexpected character "${ch}".`);
  }

  return tokens;
}

function splitList(text) {
  return text
    .split(",")
    .map((item) => item.trim().replace(/^"|"$/g, ""))
    .filter((item) => item !== "");
}

// .right(name), .right(name, 1), and the bare forms .right() and .right(1),
// which place relative to the previous line.
function parsePlacement(kind, inside, fail) {
  const args = inside.split(",").map((arg) => arg.trim());
  if (args.length > 2) fail(`.${kind}() takes a widget name and an optional padding, e.g. .${kind}(setup, 1).`);

  let target = args[0] || null;
  let gap = args[1];
  if (target !== null && /^-?\d/.test(target)) {
    if (gap !== undefined) fail(`.${kind}() takes the widget name first, then the padding.`);
    gap = target;
    target = null;
  }
  gap = gap === undefined || gap === "" ? 0 : Number(gap);
  if (!Number.isInteger(gap) || gap < 0) fail(`.${kind}() padding must be a whole number of cells.`);
  return { kind, target, gap };
}

// ---- Names ------------------------------------------------------------

const article = (word) => (/^[aeiou]/i.test(word) ? "An" : "A");

const slug = (text) =>
  String(text).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// The nearest valid R name to a NetLogo-style one.
function suggestName(name) {
  let fixed = name.replace(/[^A-Za-z0-9._]+/g, "_").replace(/^_+|_+$/g, "");
  if (!R_NAME.test(fixed)) fixed = `x_${fixed}`;
  return fixed;
}

const isRName = (name) => R_NAME.test(name) && !R_RESERVED.has(name);

// An import's `accept` list: file endings (".csv") and media types
// ("text/csv", "image/*"), separated by commas.
function parseAccept(text, fail) {
  const items = text.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const bad = items.find((item) => !/^\.[a-z0-9][a-z0-9._-]*$/.test(item) && !/^[a-z]+\/(\*|[a-z0-9.+-]+)$/.test(item));
  if (!items.length || bad) {
    fail(`\`accept\` lists file endings like .csv or types like text/csv, separated by commas${bad ? `; "${bad}" is neither` : ""}.`);
  }
  return items.join(",");
}

function checkName(name, type, hasLabel, fail) {
  if (!R_NAME.test(name)) {
    const fixed = suggestName(name);
    const label = hasLabel ? "" : ` "${name}"`;
    fail(`\`${name}\` isn't an R name. Write \`${type} ${fixed}${label}\`: names use letters, digits, "." and "_", and a quoted label can say anything.`);
  }
  if (R_RESERVED.has(name)) fail(`\`${name}\` is a reserved word in R, so it can't be a name.`);
  if (VALUE_TYPES.includes(type) && ENGINE_NAMES.has(name)) {
    fail(`\`${name}\` belongs to the engine. Give this ${type} another name.`);
  }
  if (type === "import" && ENGINE_NAMES.has(name)) {
    fail(`\`${name}\` belongs to the engine, and inside the import's code the name stands for the file's path. Give this import another name.`);
  }
}

// ---- Widget parsing ---------------------------------------------------

function parseWidget(source, lineNumber, loopVars) {
  const tokens = tokenize(source, lineNumber, loopVars);
  const fail = (message) => {
    throw new SpecError(message, lineNumber);
  };

  const head = tokens.shift();
  if (!head || head.type !== "word") fail("Every line starts with a widget type, e.g. `slider speed 0..10 = 5`.");
  const type = head.value.toLowerCase();
  if (!WIDGET_TYPES.includes(type)) {
    fail(`Unknown widget "${head.value}". Use one of: ${WIDGET_TYPES.join(", ")}, or panel, for, end.`);
  }

  const widget = {
    type,
    line: lineNumber,
    relations: [],
    cols: DEFAULT_SPAN[type].cols,
    rows: DEFAULT_SPAN[type].rows,
  };

  const take = (predicate) => {
    const index = tokens.findIndex(predicate);
    return index === -1 ? undefined : tokens.splice(index, 1)[0];
  };
  const takeType = (type) => take((token) => token.type === type);
  const takeKeyword = (word) => take((token) => token.type === "word" && token.value.toLowerCase() === word);

  // A keyword followed by a value of one of `types`, e.g. `world heat_map`.
  // Returns the value's token, or undefined when the keyword isn't there.
  const takeValue = (word, types, message) => {
    const index = tokens.findIndex((t) => t.type === "word" && t.value.toLowerCase() === word);
    if (index === -1) return undefined;
    const value = tokens[index + 1];
    if (!types.includes(value?.type)) fail(message);
    tokens.splice(index, 2);
    return value;
  };

  // A keyword followed by a number, e.g. `step 10`, `digits 2`, `w 3`.
  const takeSetting = (word) => {
    const index = tokens.findIndex((t) => t.type === "word" && t.value.toLowerCase() === word);
    if (index === -1) return undefined;
    const value = tokens[index + 1];
    if (!value || value.type !== "number") fail(`\`${word}\` needs a number, e.g. ${word} 2.`);
    tokens.splice(index, 2);
    return value.value;
  };

  // Name, then an optional quoted label: `slider speed "Speed (m/s)" 0..10`.
  // Buttons, monitors, notes, outputs and views may give just a label; their
  // names are then made from it, and never clash (see nameAutomatically).
  // Strings later on the line are values.
  // `view w 10 h 8` and `view world heat` have no name: a setting and its
  // value isn't one.
  const isSetting = (index) => {
    const word = tokens[index]?.type === "word" ? tokens[index].value.toLowerCase() : null;
    const next = tokens[index + 1];
    if (["w", "h", "step", "digits"].includes(word)) return next?.type === "number";
    if (type === "view" && ["world", "turtles", "layer", "palette", "shape"].includes(word)) return ["word", "string", "number"].includes(next?.type);
    if (type === "view" && word === "colors") return ["word", "list"].includes(next?.type);
    if (type === "import" && word === "accept") return ["word", "string"].includes(next?.type);
    if (DISPLAY_TYPES.includes(type) && word === "update") return next?.type === "word";
    return false;
  };
  const first = isSetting(0) ? undefined : tokens[0];
  if (first?.type === "block" && /^[A-Za-z_.][A-Za-z0-9_.]*$/.test(first.value)) {
    fail(notALoopVariable(first.value, loopVars));
  }
  if (type === "note") {
    const name = first?.type === "word" && tokens[1]?.type === "string" ? tokens.shift() : null;
    const text = takeType("string") ?? takeType("word");
    if (!text) fail("A note needs some text: note \"...\".");
    widget.text = widget.label = String(text.value);
    if (name) widget.name = name.value;
  } else if (first?.type === "word") {
    widget.name = tokens.shift().value;
    if (tokens[0]?.type === "string") widget.label = tokens.shift().value;
  } else if (type === "import") {
    // The name is what the import's code calls the file.
    fail(`An import needs a name first: inside its code, the name is the file's path, e.g. \`import roads "Roads (.rds)" { net <<- readRDS(roads) }\`.`);
  } else if (first?.type === "string") {
    if (VALUE_TYPES.includes(type)) {
      const suggested = suggestName(slug(first.value) || type);
      fail(`${article(type)} ${type}'s name is its R variable, so it comes first: \`${type} ${suggested} "${first.value}" …\`.`);
    }
    widget.label = tokens.shift().value;
  } else if (!["output", "view"].includes(type)) {
    fail(`${article(type)} ${type} needs a name, e.g. \`${type} speed\`.`);
  }

  if (widget.name !== undefined) {
    checkName(widget.name, type, widget.label !== undefined, fail);
    // A view shows a caption only when it's given one.
    if (widget.label === undefined && type !== "view") widget.label = widget.name;
  } else {
    widget.auto = true;
    widget.base = slug(widget.label ?? "") || type;
  }

  widget.cols = takeSetting("w") ?? widget.cols;
  widget.rows = takeSetting("h") ?? widget.rows;
  if (widget.cols < 1 || widget.rows < 1 || !Number.isInteger(widget.cols) || !Number.isInteger(widget.rows)) {
    fail("`w` and `h` are whole numbers of cells, 1 or more.");
  }

  // Without code, a button calls the R function it's named after and a
  // monitor reports the R variable it's named after.
  const ownName = widget.name ?? widget.base;
  const needsCode = (what) => {
    if (!R_NAME.test(ownName) || R_RESERVED.has(ownName)) {
      fail(`Give this ${type} some R code: \`${type} "${widget.label}" { ${what} }\`.`);
    }
  };

  switch (type) {
    case "button": {
      widget.forever = Boolean(takeKeyword("forever"));
      const block = takeType("block");
      if (!block) needsCode("...");
      // `button setup` runs setup().
      widget.action = block ? block.value : `${ownName}()`;
      break;
    }

    case "slider": {
      const range = takeType("range");
      if (!range) fail("A slider needs a range, e.g. `slider speed 0..10 = 5`.");
      [widget.min, widget.max] = range.value;
      if (widget.max <= widget.min) fail("A slider's maximum must be greater than its minimum.");
      widget.step = takeSetting("step") ?? defaultStep(widget.min, widget.max);
      widget.value = takeDefault(tokens, "number")?.value ?? widget.min;
      break;
    }

    case "switch": {
      const value = takeDefault(tokens, "word");
      widget.value = value ? ["on", "true", "yes"].includes(String(value.value).toLowerCase()) : false;
      break;
    }

    case "chooser": {
      const list = takeType("list");
      if (!list) fail("A chooser needs choices, e.g. `chooser shape [circle, square]`.");
      widget.choices = list.value;
      const chosen = takeDefault(tokens, "any");
      widget.value = chosen ? String(chosen.value) : widget.choices[0];
      if (!widget.choices.includes(widget.value)) {
        fail(`"${widget.value}" is not one of the choices [${widget.choices.join(", ")}].`);
      }
      break;
    }

    case "input": {
      const value = takeDefault(tokens, "any");
      if (!value) fail("An input needs a starting value, e.g. `input seed = 0`.");
      widget.value = value.value;
      widget.numeric = value.type === "number";
      break;
    }

    case "monitor": {
      const block = takeType("block");
      if (!block) needsCode("...");
      widget.reporter = block ? block.value : ownName;
      // Left undefined, R picks: whole numbers plain, others to 2 decimals.
      widget.digits = takeSetting("digits");
      break;
    }

    case "output":
      widget.rows = Math.max(2, widget.rows);
      break;

    case "view": {
      // What the view draws: R objects, looked up by name every frame.
      const object = (word, example) => {
        const token = takeValue(word, ["word"], `\`${word}\` names an R object, e.g. \`${example}\`.`);
        if (token && !isRName(token.value)) {
          fail(`\`${token.value}\` isn't an R name, so it can't be an object for the view to draw.`);
        }
        return token?.value;
      };
      widget.world = object("world", "view heat world heat_map") ?? "world";
      const turtles = object("turtles", "view walkers turtles walkers");
      widget.turtles = turtles === "none" ? null : turtles ?? "turtles";

      // One layer of a multi-layer world (createWorld() layers stacked with
      // stackWorlds()), by name or number.
      const layer = takeValue("layer", ["word", "string", "number"], "`layer` needs a layer's name or number, e.g. `layer \"elevation\"`.");
      if (layer?.type === "number" && (!Number.isInteger(layer.value) || layer.value < 1)) fail("A layer number counts from 1.");
      widget.layer = layer?.value ?? null;

      // How it colours patches: a colour per patch value (`colors`, from a
      // list or an R object), or along a continuous palette (`palette`).
      // With neither, views of `world` use the model's `patch_colors` and
      // other worlds use the palette chooser (see r/workbench.R).
      const colors = takeValue("colors", ["list", "word"], "`colors` needs a list of colours or an R object holding them, e.g. `colors [black, gray40, red]`.");
      if (colors?.type === "word" && !isRName(colors.value)) fail(`\`${colors.value}\` isn't an R name, so it can't hold the view's colours.`);
      widget.colors = !colors ? null : colors.type === "list" ? { values: colors.value } : { object: colors.value };

      const palette = takeValue("palette", ["word"], `\`palette\` is one of ${PALETTE_NAMES.join(", ")}.`);
      if (palette && !PALETTE_NAMES.includes(palette.value)) fail(`There's no palette "${palette.value}": use one of ${PALETTE_NAMES.join(", ")}.`);
      widget.palette = palette?.value ?? null;
      if (widget.colors && widget.palette) {
        fail("A view colours its patches by category (`colors`) or along a palette (`palette`), not both.");
      }

      // How it draws turtles; without it, the model's `turtle_shape`.
      const shape = takeValue("shape", ["word"], `\`shape\` is one of ${TURTLE_SHAPES.join(", ")}.`);
      if (shape && !TURTLE_SHAPES.includes(shape.value)) fail(`There's no turtle shape "${shape.value}": use one of ${TURTLE_SHAPES.join(", ")}.`);
      widget.shape = shape?.value ?? null;
      break;
    }

    case "plot":
    case "report": {
      const block = takeType("block");
      if (!block) {
        const example = type === "plot" ? "hist(speeds, main = \"\")" : "summary_table";
        fail(`${article(type)} ${type} needs R code that ${type === "plot" ? "draws it" : "gives what to show"}, e.g. \`${type} ${widget.name ?? "name"} "${widget.label ?? "Label"}" { ${example} }\`.`);
      }
      widget.code = block.value;
      const update = takeValue("update", ["word"], `\`update\` is one of ${DISPLAY_UPDATES.join(", ")}.`);
      if (update && !DISPLAY_UPDATES.includes(update.value)) {
        fail(`A ${type} updates on ${DISPLAY_UPDATES.join(", ")}; "${update.value}" isn't one of them.`);
      }
      widget.update = update?.value ?? DEFAULT_UPDATE[type];
      break;
    }

    case "import": {
      // Which files the picker offers, as in HTML: endings and types,
      // separated by commas (".csv, text/plain"). Dropped files are held to
      // the same list.
      const accept = takeValue("accept", ["string", "word"], "`accept` lists the files to offer, e.g. `accept \".csv\"`.");
      widget.accept = accept ? parseAccept(accept.value, fail) : null;
      const block = takeType("block");
      if (!block) {
        fail(`An import needs R code that says what to do with the file, e.g. \`import ${widget.name} "${widget.label}" { data <<- read.csv(${widget.name}) }\`.`);
      }
      widget.code = block.value;
      break;
    }
  }

  let placement;
  while ((placement = takeType("placement"))) widget.relations.push(placement.value);

  const leftover = tokens.find((token) => token.type !== "equals");
  if (leftover?.type === "block" && /^[A-Za-z_.][A-Za-z0-9_.]*$/.test(leftover.value)) {
    fail(`{${leftover.value}} isn't a loop variable${loopVars.length ? ` (loop variables here: ${loopVars.join(", ")})` : ""}.`);
  }
  if (leftover) {
    fail(`Don't know what to do with "${leftover.value ?? leftover.type}" on this line.`);
  }

  return widget;
}

// `panel name ["Title"] [placement]`. Without a title the name is shown; an
// empty title ("") draws a plain frame.
function parsePanel(source, lineNumber, loopVars) {
  const fail = (message) => {
    throw new SpecError(message, lineNumber);
  };
  const tokens = tokenize(source, lineNumber, loopVars);
  tokens.shift();

  const panel = { type: "panel", line: lineNumber, relations: [] };
  if (tokens[0]?.type === "word") {
    panel.name = tokens.shift().value;
    if (tokens[0]?.type === "string") panel.title = tokens.shift().value;
    checkName(panel.name, "panel", panel.title !== undefined, fail);
    panel.title ??= panel.name;
  } else if (tokens[0]?.type === "string") {
    panel.title = tokens.shift().value;
    panel.auto = true;
    panel.base = slug(panel.title) || "panel";
  } else {
    fail("A panel needs a name, e.g. `panel run \"Run\"`, and closes with `end`.");
  }
  panel.label = panel.title;

  for (const token of tokens) {
    if (token.type === "placement") panel.relations.push(token.value);
    else if (token.type === "word" && ["w", "h"].includes(token.value.toLowerCase())) {
      fail("A panel's size comes from what's inside it, so it takes no `w` or `h`.");
    } else fail(`Don't know what to do with "${token.value ?? token.type}" on this line.`);
  }
  return panel;
}

// `for s in [a, b, c] [if s != b and s != c]`
function parseLoop(source, lineNumber, loopVars) {
  const fail = (message) => {
    throw new SpecError(message, lineNumber);
  };
  const header = source.match(/^for\s+(\S+)\s+in\s+\[([^\]]*)\]\s*(.*)$/s);
  if (!header) fail("A loop is written `for s in [a, b, c]` and closes with `end`.");

  const [, variable, list, rest] = header;
  if (!/^[A-Za-z_.][A-Za-z0-9_.]*$/.test(variable)) fail(`\`${variable}\` can't be a loop variable: use letters, digits, "." and "_".`);
  if (loopVars.includes(variable)) fail(`\`${variable}\` is already the variable of an outer loop.`);

  const values = splitList(list);
  if (!values.length) fail("A loop needs at least one value: `for s in [a, b, c]`.");

  let filter = null;
  if (rest.trim()) {
    const condition = rest.trim().match(/^if\s+(.+)$/s);
    if (!condition) fail(`Don't know what to do with "${rest.trim()}" after the loop's list. A filter is written \`if s != b\`.`);
    filter = parseCondition(condition[1], [...loopVars, variable], fail);
  }

  return { variable, values, filter };
}

// Conditions compare loop variables: `==` (or `=`), `!=`, joined by `and`
// and `or` (`and` binds first). The left side is a loop variable; the right
// side is a loop variable or a literal. Returns env => boolean.
function parseCondition(text, loopVars, fail) {
  const tokens = text.match(/==|!=|=|"[^"]*"|[^\s=!"]+/g) ?? [];
  let i = 0;
  const example = "e.g. `if d != o` or `if d != o and d != mk`";

  const operand = (side) => {
    const token = tokens[i++];
    if (token === undefined) fail(`The filter is incomplete: ${example}.`);
    if (token.startsWith('"')) {
      if (side === "left") fail(`A filter starts with a loop variable, ${example}.`);
      const value = token.slice(1, -1);
      return () => value;
    }
    if (loopVars.includes(token)) return (env) => env.get(token);
    if (side === "left") fail(`\`${token}\` isn't a loop variable here (${loopVars.join(", ")}), so a filter can't start with it.`);
    return () => token;
  };

  const comparison = () => {
    const left = operand("left");
    const op = tokens[i++];
    if (!["==", "=", "!="].includes(op)) fail(`A filter compares with == or !=, ${example}.`);
    const right = operand("right");
    return op === "!=" ? (env) => left(env) !== right(env) : (env) => left(env) === right(env);
  };

  const all = () => {
    const parts = [comparison()];
    while (tokens[i] === "and") { i++; parts.push(comparison()); }
    return (env) => parts.every((part) => part(env));
  };

  const parts = [all()];
  while (tokens[i] === "or") { i++; parts.push(all()); }
  if (i < tokens.length) fail(`Don't know what to do with "${tokens[i]}" in the filter; join comparisons with \`and\` or \`or\`.`);
  return (env) => parts.some((part) => part(env));
}

// Consumes `= value` and returns the value token.
function takeDefault(tokens, kind) {
  const index = tokens.findIndex((token) => token.type === "equals");
  if (index === -1) return undefined;
  const value = tokens[index + 1];
  if (!value) return undefined;
  if (kind !== "any" && value.type !== kind) return undefined;
  tokens.splice(index, 2);
  return value;
}

function defaultStep(min, max) {
  const span = max - min;
  if (Number.isInteger(min) && Number.isInteger(max) && span >= 10) return 1;
  return Number((span / 100).toPrecision(1));
}

// ---- Structure --------------------------------------------------------

const headWord = (text) => (text.match(/^[A-Za-z]+/)?.[0] ?? "").toLowerCase();

// Nests the logical lines into panels and loops by their `end` lines.
// Indentation is cosmetic. A block left open runs to the end of the spec.
function buildTree(lines, report) {
  const root = { kind: "root", body: [] };
  const stack = [root];

  for (const { text, line } of lines) {
    const word = headWord(text);
    const current = stack[stack.length - 1];

    if (word === "end" && /^end\b/i.test(text)) {
      if (text.trim().toLowerCase() !== "end") report(new SpecError("Nothing goes after `end` on its line.", line));
      if (stack.length === 1) {
        report(new SpecError("This `end` has no `panel` or `for` to close.", line));
      } else {
        stack.pop();
      }
    } else if (word === "panel" && /^panel\b/i.test(text)) {
      const outer = stack.find((node) => node.kind === "panel");
      // Panels don't nest (yet). The inner one's lines still show, as part
      // of the outer panel, and its `end` still closes it.
      const node = outer
        ? { kind: "group", body: [] }
        : { kind: "panel", source: text, line, body: [] };
      if (outer) {
        report(new SpecError(`A panel can't go inside another panel (the one on line ${outer.line}). Close that one with \`end\` first.`, line));
      }
      current.body.push(node);
      stack.push(node);
    } else if (word === "for" && /^for\b/i.test(text)) {
      const node = { kind: "for", source: text, line, body: [] };
      current.body.push(node);
      stack.push(node);
    } else {
      current.body.push({ kind: "line", source: text, line });
    }
  }

  for (const node of stack.slice(1).reverse()) {
    if (node.kind === "group") continue;
    const what = node.kind === "panel" ? "panel" : "loop";
    report(new SpecError(`This ${what} has no \`end\`.`, node.line));
  }
  return root;
}

// Fills loop variables into a line: names, labels, values, choices and R
// code alike. `{x}` where x isn't a loop variable is left as it is, so R's
// own braces are untouched.
function interpolate(source, env) {
  return source.replace(INTERPOLATION, (match, name) => (env.has(name) ? env.get(name) : match));
}

// ---- Entry point ------------------------------------------------------

export function parseSpec(text) {
  const items = [];
  const errors = [];
  const report = (err) => {
    if (!(err instanceof SpecError)) throw err;
    if (!errors.some((e) => e.line === err.line && e.message === err.message)) {
      errors.push({ line: err.line, message: err.message });
    }
  };

  // Explicit names are the R variables and must be unique; the first line
  // to use one keeps it.
  const claimed = new Map();
  // The last item on each panel (or the top level), for bare placements.
  const previous = new Map();

  const add = (item, scope, gap) => {
    item.id = items.length;
    item.panel = scope?.id ?? null;
    item.gap = gap;
    const key = scope?.id ?? "top";
    for (const relation of item.relations) {
      if (relation.target === null) relation.ref = previous.get(key) ?? null;
    }
    previous.set(key, item.id);
    items.push(item);
  };

  const claim = (item) => {
    if (item.auto || item.gap) return;
    if (claimed.has(item.name)) {
      throw new SpecError(`"${item.name}" is already used on line ${claimed.get(item.name)}.`, item.line);
    }
    claimed.set(item.name, item.line);
  };

  const expand = (nodes, env, scope, gap) => {
    const loopVars = [...env.keys()];
    for (const node of nodes) {
      try {
        if (node.kind === "line") {
          const widget = parseWidget(interpolate(node.source, env), node.line, loopVars);
          claim(Object.assign(widget, { gap }));
          add(widget, scope, gap);
        } else if (node.kind === "panel") {
          let panel = null;
          try {
            panel = parsePanel(interpolate(node.source, env), node.line, loopVars);
            claim(Object.assign(panel, { gap }));
            add(panel, null, gap);
          } catch (err) {
            // A broken panel line still shows its widgets, unframed.
            report(err);
          }
          expand(node.body, env, panel ?? scope, gap);
        } else if (node.kind === "group") {
          expand(node.body, env, scope, gap);
        } else if (node.kind === "for") {
          const loop = parseLoop(interpolate(node.source, env), node.line, loopVars);
          for (const value of loop.values) {
            const inner = new Map(env).set(loop.variable, value);
            const skipped = gap || (loop.filter ? !loop.filter(inner) : false);
            expand(node.body, inner, scope, skipped);
          }
        }
      } catch (err) {
        report(err);
      }
    }
  };

  const tree = buildTree(splitLogicalLines(text ?? ""), report);
  expand(tree.body, new Map(), null, false);
  nameAutomatically(items, claimed);

  errors.sort((a, b) => a.line - b.line);
  return { widgets: items, errors };
}

// Buttons, monitors and notes written with only a label get names made from
// it (`"Unif"` → unif, unif_2, …). They aren't R variables, so they step
// around every explicit name instead of clashing with it.
function nameAutomatically(items, claimed) {
  const taken = new Set(claimed.keys());
  for (const item of items) {
    if (!item.auto) continue;
    if (item.gap) {
      item.name = null;
    } else {
      let name = item.base;
      for (let n = 2; taken.has(name); n++) name = `${item.base}_${n}`;
      item.name = name;
      taken.add(name);
    }
    delete item.base;
  }
  for (const item of items) delete item.auto;
}
