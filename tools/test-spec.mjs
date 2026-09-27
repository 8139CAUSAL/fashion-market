// Tests for the interface spec parser and the layout resolver.
//
//   node --test tools/test-spec.mjs
//
// Both modules are plain logic with no DOM, so they run as-is under Node.

import test from "node:test";
import assert from "node:assert/strict";

import { parseSpec, viewSpec, displaySpec, DEFAULT_VIEW, PALETTE_NAMES } from "../js/spec-parser.js";
import { PALETTES } from "../js/renderer.js";
import { readFileSync } from "node:fs";
import { resolveLayout, gridTracks, LayoutError } from "../js/layout.js";

const parse = (text) => {
  const result = parseSpec(text);
  assert.deepEqual(result.errors, [], "spec should parse cleanly");
  return result.widgets;
};

const layout = (text) => {
  const { widgets } = resolveLayout(parse(text));
  return new Map(widgets.map((w) => [w.name, w]));
};

// ---- Parsing -----------------------------------------------------------

test("parses each widget type", () => {
  const widgets = parse(`
    button setup
    button go forever .right(setup)
    slider population 10..500 = 200 step 10 .under(setup)
    switch trails = on .under(population)
    chooser palette [viridis, gray, heat] = heat .right(trails)
    input seed = 42 .under(trails)
    monitor "mean heading" { mean(of(turtles, "heading")) } digits 1 .under(seed)
    note "Press go."
    output log
  `);

  assert.equal(widgets.length, 9);

  const byName = Object.fromEntries(widgets.map((w) => [w.name, w]));
  assert.equal(byName.setup.action, "setup()", "a button calls the function it is named after");
  assert.equal(byName.go.forever, true);
  assert.deepEqual(
    [byName.population.min, byName.population.max, byName.population.value, byName.population.step],
    [10, 500, 200, 10]
  );
  assert.equal(byName.trails.value, true);
  assert.deepEqual(byName.palette.choices, ["viridis", "gray", "heat"]);
  assert.equal(byName.palette.value, "heat");
  assert.equal(byName.seed.value, 42);
  assert.equal(byName.seed.numeric, true);
  assert.equal(byName.mean_heading.reporter, 'mean(of(turtles, "heading"))');
  assert.equal(byName.mean_heading.digits, 1);
  assert.equal(byName.turtles, undefined, "monitors are named after their label");
  assert.equal(byName.mean_heading.label, "mean heading");
  assert.equal(byName.press_go.text, "Press go.");
});

test("a quoted label goes right after the name; later strings are values", () => {
  const [greeting, speed, shape] = parse(`
    input greeting = "hello"
    slider speed "Speed (m/s)" 0..10 = 2
    chooser shape "Turtle shape" [arrow, dot] = "dot"
  `);
  assert.deepEqual([greeting.label, greeting.value, greeting.numeric], ["greeting", "hello", false]);
  assert.deepEqual([speed.name, speed.label, speed.value], ["speed", "Speed (m/s)", 2]);
  assert.deepEqual([shape.label, shape.value], ["Turtle shape", "dot"]);
});

test("keeps R code blocks intact, including across lines and with braces inside", () => {
  const widgets = parse(`
    button scatter {
      turtles <<- moveTo(turtles, patch(world, 0, 0))
      if (ticks > 10) { turtles <<- die(turtles, who = 1) }
    }
    monitor "high patches" { NLcount(NLwith(patches(world), world, world[world > 0.5])) }
  `);

  assert.match(widgets[0].action, /moveTo/);
  assert.match(widgets[0].action, /if \(ticks > 10\) \{ turtles <<- die/);
  assert.equal(widgets[1].reporter, "NLcount(NLwith(patches(world), world, world[world > 0.5]))");
});

test("ignores comments and blank lines, but not inside strings", () => {
  const widgets = parse(`
    # controls
    button setup    # runs setup()
    note "a # sign in text"
  `);
  assert.equal(widgets.length, 2);
  assert.equal(widgets[1].text, "a # sign in text");
});

test("reports useful errors instead of throwing", () => {
  const { widgets, errors } = parseSpec(`
    button setup
    slidr speed 0..10
    slider speed
    button setup
    chooser shape [circle, square] = triangle
  `);

  assert.equal(widgets.length, 1, "good lines still parse");
  assert.equal(errors.length, 4);
  assert.match(errors[0].message, /Unknown widget "slidr"/);
  assert.equal(errors[0].line, 3);
  assert.match(errors[1].message, /needs a range/);
  assert.match(errors[2].message, /already used on line 2/);
  assert.match(errors[3].message, /not one of the choices/);
});

// ---- Layout ------------------------------------------------------------

test("places widgets under and beside their anchors", () => {
  const at = layout(`
    button setup
    button go .right(setup)
    slider population 10..500 = 200 .under(setup)
  `);

  assert.deepEqual([at.get("setup").row, at.get("setup").col], [1, 1]);
  assert.deepEqual([at.get("go").row, at.get("go").col], [1, 3], "beside setup, past its 2 columns");
  assert.deepEqual([at.get("population").row, at.get("population").col], [2, 1]);
});

test("a widget with no placement starts a new row at the left edge", () => {
  const at = layout(`
    button setup
    slider speed 0..10 = 1
    switch trails = off
  `);
  assert.deepEqual([at.get("speed").row, at.get("speed").col], [2, 1]);
  assert.deepEqual([at.get("trails").row, at.get("trails").col], [3, 1]);
});

test("an unplaced widget returns to the left edge after a .right() chain", () => {
  const at = layout(`
    button setup
    monitor "m" { 1 } .right(setup)
    note "back to the left"
    output log
  `);
  assert.deepEqual([at.get("back_to_the_left").row, at.get("back_to_the_left").col], [2, 1]);
  assert.deepEqual([at.get("log").row, at.get("log").col], [3, 1]);
});

test("padding leaves empty cells", () => {
  const at = layout(`
    button setup
    button go .right(setup, 2)
    note "gap below" .under(setup, 1)
  `);
  assert.equal(at.get("go").col, 5, "2 columns of padding after setup's 2 columns");
  assert.equal(at.get("gap_below").row, 3);
});

test("widgets sharing an anchor never overlap", () => {
  const { widgets } = resolveLayout(parse(`
    button setup
    slider a 0..10 = 1 .under(setup)
    slider b 0..10 = 1 .under(setup)
    slider c 0..10 = 1 .under(setup)
    monitor "m1" { 1 } .right(setup)
    monitor "m2" { 2 } .right(setup)
  `));

  const cells = new Set();
  for (const w of widgets) {
    for (let r = w.row; r < w.row + w.rows; r++) {
      for (let c = w.col; c < w.col + w.cols; c++) {
        const key = `${r}:${c}`;
        assert.ok(!cells.has(key), `${w.name} overlaps another widget at ${key}`);
        cells.add(key);
      }
    }
  }
});

test("reports circular placement", () => {
  const widgets = parse(`
    button a .right(b)
    button b .under(a)
  `);
  assert.throws(() => resolveLayout(widgets), (err) => {
    assert.ok(err instanceof LayoutError);
    assert.match(err.message, /placed in a circle/);
    return true;
  });
});

test("reports placement against an unknown widget", () => {
  const widgets = parse("button go .right(setup)");
  assert.throws(() => resolveLayout(widgets), /does not exist/);
});

test("returns widgets in reading order with grid extents", () => {
  const { widgets, columns, rows } = resolveLayout(parse(`
    slider population 10..500 = 200
    button setup .right(population)
    button go .right(setup)
  `));

  assert.deepEqual(widgets.map((w) => w.name), ["population", "setup", "go"]);
  assert.equal(rows, 1);
  assert.equal(columns, 8, "4 columns of slider plus two 2-column buttons");
});

// ---- The composed grammar: panels, loops, filters, views ---------------

const byName = (widgets) => Object.fromEntries(widgets.filter((w) => w.name).map((w) => [w.name, w]));
const at = (w) => [w.row, w.col];

test("panels: titled, untitled, title defaulting to the name, and label-only", () => {
  const items = parse(`
    panel run "Run"
      button setup
    end
    panel plain ""
      button reset
    end
    panel stats
      monitor "n" { 1 }
    end
    panel "Extra things"
      note "hi"
    end
  `);
  const panels = items.filter((i) => i.type === "panel");
  assert.deepEqual(panels.map((p) => [p.name, p.title]), [
    ["run", "Run"], ["plain", ""], ["stats", "stats"], ["extra_things", "Extra things"],
  ]);
  const w = byName(items);
  assert.equal(w.setup.panel, w.run.id);
  assert.equal(w.reset.panel, w.plain.id);
  assert.equal(w.hi.panel, panels[3].id);
});

test("loops repeat their lines, nest, and fill {s} into names, labels, values, choices and R code", () => {
  const items = parse(`
    for s in [kids, adults]
      for t in [a, b]
        slider rate_{s}_{t} "rate {s}→{t}" 0..1 = 0.5
        chooser pick_{s}_{t} [{s}, {t}, other] = {s}
        input label_{s}_{t} = "{s}/{t}"
        button bump_{s}_{t} { bump("{s}", "{t}"); x <- list(); if (TRUE) { y <- 1 } }
      end
    end
  `);
  const w = byName(items);
  assert.equal(items.length, 16);
  assert.equal(w.rate_adults_a.label, "rate adults→a");
  assert.deepEqual(w.pick_kids_a.choices, ["kids", "a", "other"]);
  assert.equal(w.pick_kids_a.value, "kids");
  assert.equal(w.label_kids_a.value, "kids/a");
  assert.equal(w.bump_kids_a.action, 'bump("kids", "a"); x <- list(); if (TRUE) { y <- 1 }',
    "only loop variables are replaced; R's own braces stay");

  // A quoted loop value can hold a space, for labels and strings.
  const [note] = parse('for t in ["all day"]\n  note "{t}"\nend');
  assert.equal(note.text, "all day");
});

test("an `if` filter skips values but keeps their space, so columns stay aligned", () => {
  const { widgets, gaps } = resolveLayout(parse(`
    note "" w 2
    for g in [x, y, z]
      note "{g}" w 2 .right()
    end
    for a in [x, y, z]
      note "{a}" w 2
      for b in [x, y, z] if b != a
        input rate_{a}_{b} "" = 0.1 w 2 .right()
      end
    end
  `));
  const w = byName(widgets);
  assert.equal(w.rate_x_x, undefined, "the diagonal is skipped");
  assert.equal(gaps.length, 3);
  assert.deepEqual(gaps.map(at), [[2, 3], [3, 5], [4, 7]], "each skipped cell is left empty");
  // Every column lines up under its header.
  for (const [a, row] of [["x", 2], ["y", 3], ["z", 4]]) {
    for (const [b, col] of [["x", 3], ["y", 5], ["z", 7]]) {
      if (a !== b) assert.deepEqual(at(w[`rate_${a}_${b}`]), [row, col], `rate_${a}_${b}`);
    }
  }
  assert.deepEqual(at(w.z), [1, 7]);
});

test("filters: ==, =, !=, and, or, and literals on the right", () => {
  const names = (spec) => parse(spec).filter((i) => !i.gap).map((i) => i.name);
  assert.deepEqual(names(`for d in [a, b, c] if d != b
    button b_{d}
  end`), ["b_a", "b_c"]);
  assert.deepEqual(names(`for d in [a, b, c] if d == b or d = c
    button b_{d}
  end`), ["b_b", "b_c"]);
  assert.deepEqual(names(`for o in [a, b]
    for d in [a, b, c] if d != o and d != c
      button b_{o}_{d}
    end
  end`), ["b_a_b", "b_b_a"]);
  assert.deepEqual(names(`for d in [a, b] if d != "a"
    button b_{d}
  end`), ["b_b"]);
});

test("all four directions, named and bare, with padding", () => {
  const w = byName(resolveLayout(parse(`
    button a
    button b .right()
    button c .under()
    button d .left(c)
    button e .above(a)
    button f .right(b, 1)
    button g .under(1)
  `)).widgets);
  // e sits above a, so everything shifts down one row.
  assert.deepEqual(at(w.e), [1, 1]);
  assert.deepEqual(at(w.a), [2, 1]);
  assert.deepEqual(at(w.b), [2, 3], "bare .right(): beside the previous line");
  assert.deepEqual(at(w.c), [3, 3], "bare .under(): below the previous line");
  assert.deepEqual(at(w.d), [3, 1], ".left(c)");
  assert.deepEqual(at(w.f), [2, 6], ".right(b, 1): one empty cell between");
  assert.deepEqual(at(w.g), [4, 6], ".under(1): bare placement with padding");
});

test("placing left of the first widget shifts the layout instead of going off the edge", () => {
  const w = byName(resolveLayout(parse(`
    button a
    slider s 0..1 .left(a)
    note "next"
  `)).widgets);
  assert.deepEqual(at(w.s), [1, 1]);
  assert.deepEqual(at(w.a), [1, 5]);
  assert.deepEqual(at(w.next), [2, 1], "an unplaced widget starts at the layout's left edge");
});

test("a bare placement on a panel's first line starts at the panel's top-left", () => {
  const w = byName(resolveLayout(parse(`
    button outside
    panel p "P" .right()
      button first .right()
      button second .right(1)
    end
  `)).widgets);
  assert.deepEqual(at(w.first), [1, 3]);
  assert.deepEqual(at(w.second), [1, 6]);
});

test(".right( and friends work with no space before them", () => {
  const w = byName(parse("button setup\nbutton go forever.right(setup)\nslider s 0..1.under(setup)"));
  assert.equal(w.go.forever, true);
  assert.deepEqual(w.go.relations.map((r) => [r.kind, r.target]), [["right", "setup"]]);
  assert.deepEqual(w.s.relations.map((r) => [r.kind, r.target]), [["under", "setup"]]);
  assert.deepEqual([w.s.min, w.s.max], [0, 1]);
});

test("panels are laid out on their own, then placed as one block; rows line up across them", () => {
  const { widgets, panels } = resolveLayout(parse(`
    panel left "Left"
      button a
      slider s 0..1
      button b
    end
    panel right "Right" .right(left)
      button c
      button d .under()
      button e .under()
    end
    panel below "" .under(left)
      button f
    end
  `));
  const p = byName(panels);
  const w = byName(widgets);
  assert.deepEqual([p.left.row, p.left.col, p.left.rows, p.left.cols], [1, 1, 3, 4]);
  assert.deepEqual([p.right.row, p.right.col, p.right.rows, p.right.cols], [1, 5, 3, 2]);
  assert.deepEqual(at(p.below), [4, 1]);
  assert.deepEqual([w.a.row, w.c.row], [1, 1]);
  assert.deepEqual([w.s.row, w.d.row], [2, 2]);
  assert.deepEqual([w.b.row, w.e.row], [3, 3]);
  assert.deepEqual(at(w.c), [1, 5], "a panel's widgets are offset by the panel's position");
  assert.deepEqual(at(w.f), [4, 1]);
});

test("widgets place within their panel; panels place relative to panels or top-level widgets", () => {
  const messages = [];
  resolveLayout(parse(`
    button top
    panel p "P"
      button a
      button b .right(top)
    end
    panel q "Q" .right(a)
      button c .under(a)
    end
  `), { onError: (err) => messages.push(err.message) });
  assert.equal(messages.length, 3);
  const about = (name) => messages.find((m) => m.startsWith(`"${name}"`));
  assert.match(about("b"), /"b" is in panel "p" but is placed relative to "top".*within their own panel/);
  assert.match(about("c"), /"c" is placed relative to "a", which is in panel "p"/);
  assert.match(about("q"), /"q" is placed relative to "a", which is inside panel "p". Place it relative to the panel instead/);
});

test("with onError, a bad placement is reported and ignored instead of throwing", () => {
  const errors = [];
  const { widgets } = resolveLayout(parse("button a .right(nowhere)\nbutton b .right(a)"), {
    onError: (err) => errors.push(err),
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
  assert.deepEqual(widgets.map(at), [[1, 1], [1, 3]]);
});

test("view is a placeable widget: default 8 × 8, sized with w and h, named for placement", () => {
  const w = byName(resolveLayout(parse(`
    button setup
    view w 10 h 6 .right(setup)
    monitor "n" { 1 } .under(view)
  `)).widgets);
  assert.deepEqual([w.view.cols, w.view.rows, w.view.label], [10, 6, undefined], "no caption unless given");
  assert.deepEqual(at(w.view), [1, 3]);
  assert.deepEqual(at(w.n), [7, 3]);

  const [city] = parse('view city "City map" .right()');
  assert.deepEqual([city.name, city.label, city.cols, city.rows], ["city", "City map", 8, 8]);
});

test("several views, each naming what it draws (the TOFIX item 2 examples)", () => {
  const views = parse(`
    view
    view city w 10 h 8
    view heat "Heat" world heat_map w 6 h 8 .right(city)
    view layer2 world landscape layer "elevation" .under(heat)
    view walkers world city_map turtles walkers
    view world heat_map turtles none
    view by_number world landscape layer 2
  `);
  const draws = (v) => [v.name, v.world, v.turtles, v.layer];
  assert.deepEqual(views.map(draws), [
    ["view", "world", "turtles", null],
    ["city", "world", "turtles", null],
    ["heat", "heat_map", "turtles", null],
    ["layer2", "landscape", "turtles", "elevation"],
    ["walkers", "city_map", "walkers", null],
    ["view_2", "heat_map", null, null],
    ["by_number", "landscape", "turtles", 2],
  ]);
  assert.equal(views[2].label, "Heat");
  assert.deepEqual([views[2].cols, views[2].rows], [6, 8]);
});

test("each view says how it draws: categories, a palette, a turtle shape", () => {
  const [city, heat, own, plain] = parse(`
    view city world city_map colors [black, gray40, "#e03131"] shape dot
    view heat world heat_map turtles none palette heat
    view own world landscape colors land_colors
    view
  `);
  assert.deepEqual(viewSpec(city), {
    name: "city", world: "city_map", turtles: "turtles", layer: null,
    colors: { values: ["black", "gray40", "#e03131"] }, palette: null, shape: "dot",
  });
  assert.deepEqual([heat.colors, heat.palette, heat.shape], [null, "heat", null]);
  assert.deepEqual(own.colors, { object: "land_colors" });
  assert.deepEqual(viewSpec(plain), { ...DEFAULT_VIEW }, "a bare view line draws like the default view");

  const messages = (spec) => parseSpec(spec).errors.map((e) => e.message);
  assert.match(messages("view v colors [a] palette heat")[0], /by category \(`colors`\) or along a palette \(`palette`\), not both/);
  assert.match(messages("view v palette rainbow")[0], /There's no palette "rainbow": use one of viridis, gray, heat/);
  assert.match(messages("view v shape star")[0], /There's no turtle shape "star"/);
  assert.match(messages("view v colors my-colours")[0], /`my-colours` isn't an R name/);
  assert.match(messages("view v colors 3")[0], /`colors` needs a list of colours or an R object/);
});

test("the parser's palettes are the ones the renderer can draw", () => {
  assert.deepEqual([...PALETTE_NAMES].sort(), Object.keys(PALETTES).sort());
});

test("import: a name for the file's path, an accept list, and R code", () => {
  const [roads, any] = parse(`
    import roads "Road network (.rds)" accept ".rds, application/octet-stream" { net <<- readRDS(roads) } .right()
    import data { data_path <<- data }
  `);
  assert.deepEqual([roads.name, roads.label, roads.accept, roads.code], ["roads", "Road network (.rds)", ".rds,application/octet-stream", "net <<- readRDS(roads)"]);
  assert.deepEqual([any.label, any.accept, any.cols, any.rows], ["data", null, 4, 1]);
  assert.equal(roads.value, undefined, "an import isn't a value widget");

  const [looped] = parse('for g in [treatment]\n  import {g}_file "{g} (.csv)" accept .csv { {g} <<- read.csv({g}_file) }\nend');
  assert.deepEqual([looped.name, looped.code], ["treatment_file", "treatment <<- read.csv(treatment_file)"]);

  const messages = (spec) => parseSpec(spec).errors.map((e) => e.message);
  assert.match(messages('import "Roads" { x }')[0], /An import needs a name first: inside its code, the name is the file's path/);
  assert.match(messages("import roads accept .rds")[0], /An import needs R code that says what to do with the file/);
  assert.match(messages("import turtles { x }")[0], /`turtles` belongs to the engine/);
  assert.match(messages('import d accept "csv" { x }')[0], /"csv" is neither/);
  assert.match(messages("import horizon-map { x }")[0], /isn't an R name/);
});

test("views in a loop, and view errors", () => {
  const views = parse(`for s in [a, b]
    view v_{s} "{s}" world w_{s} turtles none w 4 h 4 .right()
  end`);
  assert.deepEqual(views.map((v) => [v.name, v.world]), [["v_a", "w_a"], ["v_b", "w_b"]]);

  const messages = (spec) => parseSpec(spec).errors.map((e) => e.message);
  assert.match(messages("view v world 3")[0], /`world` names an R object/);
  assert.match(messages("view v world my-map")[0], /`my-map` isn't an R name/);
  assert.match(messages("view v layer 0")[0], /A layer number counts from 1/);
  assert.match(messages("view v layer")[0], /`layer` needs a layer's name or number/);
  assert.match(messages("view a\nview a")[0], /"a" is already used on line 1/);
});

test("names are R names; labels can say anything", () => {
  const w = byName(parse(`
    slider horizon_hours "horizon-hours" 1..24 = 12
    switch record_invehicle "record-invehicle?" = off
    input .hidden = 1
    button my.action
  `));
  assert.equal(w.horizon_hours.label, "horizon-hours");
  assert.equal(w.record_invehicle.label, "record-invehicle?");
  assert.equal(w[".hidden"].value, 1);
  assert.equal(w["my.action"].action, "my.action()");
});

test("a NetLogo-style name gets an error saying what to write instead", () => {
  const { errors } = parseSpec(`
    slider horizon-hours 1..24 = 12
    switch record-invehicle? = off
    slider span-min "Span" 0..1
    slider if 0..1
    slider ticks 0..1
    slider "Speed (m/s)" 0..1
    input 2fast = 1
  `);
  const messages = errors.map((e) => e.message);
  assert.match(messages[0], /`horizon-hours` isn't an R name\. Write `slider horizon_hours "horizon-hours"`/);
  assert.match(messages[1], /Write `switch record_invehicle "record-invehicle\?"`/);
  assert.match(messages[2], /Write `slider span_min`:/, "with a label already given, only the name changes");
  assert.match(messages[3], /`if` is a reserved word in R/);
  assert.match(messages[4], /`ticks` belongs to the engine/);
  assert.match(messages[5], /A slider's name is its R variable, so it comes first: `slider speed_m_s "Speed \(m\/s\)" …`/);
  assert.match(messages[6], /An input needs a name/);
});

test("the engine's names are fine for widgets that aren't R variables", () => {
  const w = byName(parse("monitor ticks\nbutton world { NULL }"));
  assert.equal(w.ticks.reporter, "ticks");
});

test("label-derived names are automatic and never clash; explicit names must be unique", () => {
  const items = parse(`
    for o in [a, b, c]
      button "Unif" { unif("{o}") }
    end
    button unif { reset() }
    note "Unif"
    monitor "turtles" { 1 }
    output
  `);
  assert.deepEqual(items.map((i) => i.name), ["unif_2", "unif_3", "unif_4", "unif", "unif_5", "turtles", "output"]);
  assert.equal(items[0].action, 'unif("a")');

  const { errors } = parseSpec("button go\nfor s in [a, b]\n  slider speed 0..1\nend");
  assert.match(errors[0].message, /"speed" is already used on line 3/);
});

test("{x} that isn't a loop variable is an error in a name, but left alone elsewhere", () => {
  const { errors } = parseSpec(`
    for s in [a]
      slider lam_{x} 0..1
      slider {y}_lam 0..1
    end
    slider {z} 0..1
  `);
  assert.match(errors[0].message, /\{x\} isn't a loop variable \(loop variables here: s\), so it can't be part of a name/);
  assert.match(errors[1].message, /\{y\} isn't a loop variable/);
  assert.match(errors[2].message, /\{z\} isn.t a loop variable, so it can.t be part of a name/);

  const w = byName(parse('note "{x} stays"\nmonitor "m" { f({x}) }'));
  assert.equal(w.x_stays.text, "{x} stays");
  assert.equal(w.m.reporter, "f({x})");
});

test("block errors: missing or stray end, nested panels, malformed loops and filters", () => {
  const messages = (spec) => parseSpec(spec).errors.map((e) => `${e.line}: ${e.message}`);

  assert.match(messages("panel p \"P\"\n  button a")[0], /^1: This panel has no `end`/);
  assert.match(messages("for s in [a]\n  button b_{s}")[0], /^1: This loop has no `end`/);
  assert.match(messages("button a\nend")[0], /^2: This `end` has no `panel` or `for` to close/);
  assert.match(messages("panel p\n  panel q\n  end\nend")[0], /^2: A panel can't go inside another panel \(the one on line 1\)/);
  assert.match(messages("for s [a, b]\nend")[0], /A loop is written `for s in \[a, b, c\]`/);
  assert.match(messages("for s in []\nend")[0], /at least one value/);
  assert.match(messages("for s in [a]\n  for s in [b]\n  end\nend")[0], /`s` is already the variable of an outer loop/);
  assert.match(messages("for s in [a] if t != a\nend")[0], /`t` isn't a loop variable here \(s\)/);
  assert.match(messages("for s in [a] if s > a\nend")[0], /compares with == or !=/);
  assert.match(messages("for s in [a] where s != a\nend")[0], /A filter is written `if s != b`/);
  assert.match(messages("panel p w 3\nend")[0], /size comes from what's inside it/);
  assert.match(messages("end now")[0], /Nothing goes after `end`/);
});

test("nested panels still show their widgets, inside the outer panel", () => {
  const { widgets, errors } = parseSpec("panel p\n  panel q\n    button a\n  end\n  button b\nend\nbutton c");
  assert.equal(errors.length, 1);
  const w = byName(widgets);
  assert.equal(w.a.panel, w.p.id);
  assert.equal(w.b.panel, w.p.id);
  assert.equal(w.c.panel, null, "the inner end closed the inner panel, not the outer one");
});

test("indentation is cosmetic", () => {
  const flat = parse("panel p\nbutton a\nfor s in [x, y]\nbutton b_{s} .right()\nend\nend");
  const indented = parse("panel p\n      button a\n  for s in [x, y]\n button b_{s} .right()\n  end\n     end");
  const strip = (items) => items.map(({ line, ...rest }) => rest);
  assert.deepEqual(strip(flat), strip(indented));
});

// ---- CSS grid tracks ----------------------------------------------------

test("grid tracks are fixed cells, with gutters only where a panel touches a neighbour", () => {
  const layout = resolveLayout(parse(`
    panel a "A"
      button x w 4
    end
    panel b "B" .under(a)
      button y w 8
    end
    view w 4 h 2 .right(b)
  `));
  const tracks = gridTracks(layout);
  const split = (list) => list.match(/minmax\(var\([^)]*\), auto\)|var\(--[a-z-]+\)/g);
  const cols = split(tracks.columns);
  const rows = split(tracks.rows);
  // a's right edge (after column 4) touches nothing, so no gutter runs
  // through b there; b touches the view (after column 8).
  assert.deepEqual(cols.map((t) => t === "var(--gutter)" ? "|" : "."), [".", ".", ".", ".", ".", ".", ".", ".", "|", ".", ".", ".", "."]);
  // a sits on b: one gutter row between them.
  assert.deepEqual(rows, ["minmax(var(--cell-h), auto)", "var(--gutter)", "minmax(var(--cell-h), auto)", "minmax(var(--cell-h), auto)"]);

  const w = byName(layout.widgets);
  assert.deepEqual(tracks.area(w.view), { row: "3 / 5", column: "10 / 14" }, "the view spans the gutter row");
  const b = byName(layout.panels).b;
  assert.deepEqual(tracks.area(b), { row: "3 / 4", column: "1 / 9" });
  assert.deepEqual(tracks.area(w.y, b), { row: "1 / 2", column: "1 / 9" }, "inside a panel, lines count from the panel");
});

// ---- Existing presets, the ToFix example, and the monorail -------------

const templates = new URL("../templates/", import.meta.url);
const readTemplate = (name) => readFileSync(new URL(name, templates), "utf8");

test("every preset lands in exactly the same cells as before panels, loops and views", () => {
  const snapshot = JSON.parse(readFileSync(new URL("./fixtures/preset-layouts.json", import.meta.url), "utf8"));
  for (const [file, before] of Object.entries(snapshot)) {
    if (file === "comment") continue;
    const layout = resolveLayout(parse(readTemplate(file)));
    const now = Object.fromEntries(layout.widgets.map((w) => [w.name, [w.row, w.col, w.rows, w.cols]]));
    assert.deepEqual(now, before.widgets, file);
    assert.deepEqual([layout.columns, layout.rows], [before.columns, before.rows], file);
  }
});

test("the TOFIX example lays out as declared (its second view and charts come later)", () => {
  const layout = resolveLayout(parse(`
    panel run "Run"
      button setup
      button go forever .right()
      input seed = 0
      slider population 100..5000 = 1000 step 100
    end

    panel rates "Contact rates" .under(run)
      note "" w 2
      for g in [kids, adults, seniors]
        note "{g}" w 2 .right()
      end
      for a in [kids, adults, seniors]
        note "{a}" w 2
        for b in [kids, adults, seniors] if b != a
          input rate_{a}_{b} "" = 0.1 w 2 .right()
        end
      end
    end

    view city w 10 h 8 .right(run)
  `));
  const p = byName(layout.panels);
  const w = byName(layout.widgets);
  assert.deepEqual(at(p.rates), [p.run.rows + 1, 1]);
  assert.equal(layout.widgets.filter((x) => x.name.startsWith("rate_")).length, 6);
  assert.equal(layout.gaps.length, 3);
  // The view goes right of run, sliding past the wider rates panel.
  assert.equal(w.city.row, 1);
  assert.equal(w.city.col, p.rates.col + p.rates.cols);
});

test("the monorail interface: three columns, the view in the middle, the λ grid and O→D matrices", () => {
  const text = readTemplate("monorail.ui");
  const { widgets: items, errors } = parseSpec(text);
  assert.deepEqual(errors, []);
  const layout = resolveLayout(items);
  const p = byName(layout.panels);
  const w = byName(layout.widgets);

  const left = ["run", "policies", "dwell", "arrivals", "export"];
  const centre = ["time", "travel"];
  const right = ["kpi", "waits", "od"];
  for (const name of left) assert.equal(p[name].col, 1, name);
  for (const name of centre) assert.equal(p[name].col, w.view.col, name);
  assert.ok(w.view.col > Math.max(...left.map((n) => p[n].col + p[n].cols - 1)), "view right of the left column");
  for (const name of right) assert.ok(p[name].col > w.view.col + w.view.cols - 1, `${name} right of the view`);
  for (const [upper, lower] of [["run", "policies"], ["policies", "dwell"], ["dwell", "arrivals"], ["arrivals", "export"], ["time", "travel"], ["kpi", "waits"], ["waits", "od"]]) {
    assert.ok(p[lower].row > p[upper].row, `${lower} under ${upper}`);
  }

  // Rows of controls side by side.
  assert.equal(w.setup.row, w.go.row);
  assert.equal(w.go.row, w.export_csv.row);
  assert.equal(w.constant_trains.row, w.fwdrev_trains.row);

  // λ grid: 5 stations × 3 buckets, in aligned columns.
  const lam = layout.widgets.filter((x) => x.name.startsWith("lam_"));
  assert.equal(lam.length, 15);
  assert.equal(new Set(lam.map((x) => x.col)).size, 3);
  assert.equal(new Set(lam.map((x) => x.row)).size, 5);

  // O→D: 3 buckets × 20 cells, the diagonal left empty but aligned.
  const od = layout.widgets.filter((x) => x.name.startsWith("od_"));
  assert.equal(od.length, 60);
  assert.equal(new Set(od.map((x) => x.col)).size, 5);
  assert.equal(layout.gaps.length, 15);
  assert.deepEqual(at(w.od_morning_CO_MK), [w.od_morning_MK_CO.row + 1, w.od_morning_MK_CO.col - 2]);
  assert.equal(layout.widgets.filter((x) => x.label === "Unif").length, 15);

  // About 80 lines instead of about 200.
  assert.ok(text.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#")).length < 100);
});

// ---- Monitors: named, labelled value displays (TOFIX item 4a) ----------

test("NetLogo-style monitors: a name to place against, a label to show, R code to evaluate", () => {
  const layout = resolveLayout(parse(`
    panel stats "Stats"
      monitor infected "Infected" { n_i() }
      monitor recovered "Recovered" { n_r() } .right()
      monitor percent_infected "% Infected" { 100 * n_i() / population } digits 1 w 3 .right()
    end
    monitor r_zero "R0" { mean(R0_values) } digits 2 .under(stats)
    for g in [kids, adults]
      monitor infected_{g} "Infected {g}" { n_i("{g}") } .right()
    end
  `));
  const w = byName(layout.widgets);

  assert.deepEqual([w.infected.label, w.infected.reporter], ["Infected", "n_i()"]);
  assert.deepEqual([w.percent_infected.label, w.percent_infected.digits, w.percent_infected.cols], ["% Infected", 1, 3]);
  assert.deepEqual([at(w.infected), at(w.recovered), at(w.percent_infected)], [[1, 1], [1, 3], [1, 5]]);
  assert.equal(w.r_zero.row, 2, "placed under the panel");
  assert.deepEqual([w.infected_kids.reporter, w.infected_adults.label], ['n_i("kids")', "Infected adults"]);

  // A monitor shows a value; it never becomes an R variable.
  assert.ok(layout.widgets.filter((x) => x.type === "monitor").every((x) => x.value === undefined));
});

test("monitor names follow the name rules; without code a monitor shows the variable it's named after", () => {
  const [ticks, count] = parse('monitor ticks\nmonitor n_agents "Agents" { NLcount(turtles) }');
  assert.deepEqual([ticks.reporter, ticks.label], ["ticks", "ticks"]);
  assert.equal(count.label, "Agents");
  const { errors } = parseSpec('monitor per-cent "%" { 1 }\nmonitor a { 1 }\nmonitor a { 2 }');
  assert.match(errors[0].message, /`per-cent` isn't an R name/);
  assert.match(errors[1].message, /"a" is already used on line 2/);
});

// ---- Plots and reports: R draws or prints them (TOFIX items 4b, 4c) -----

test("plot: a named surface, sized and placed, whose R code draws the picture", () => {
  const layout = resolveLayout(parse(`
    plot epidemic "Epidemic curve" {
      plot(time, infected, type = "l", ylim = c(0, population))
      lines(time, recovered, col = "blue")
    } w 8 h 4
    plot speeds "Speed distribution" {
      hist(speeds, breaks = 30, main = "")
    } w 6 h 4 .right(epidemic)
    plot quick { plot(1) } update monitor .under(epidemic)
    plot later "Later" { plot(2) } update manual .right()
  `));
  const w = byName(layout.widgets);
  assert.equal(w.epidemic.code, 'plot(time, infected, type = "l", ylim = c(0, population))\n      lines(time, recovered, col = "blue")');
  assert.deepEqual([w.epidemic.label, w.epidemic.cols, w.epidemic.rows, w.epidemic.update], ["Epidemic curve", 8, 4, "ticks"]);
  assert.deepEqual(at(w.speeds), [1, 9]);
  assert.deepEqual([w.quick.update, w.quick.label, w.quick.cols, w.quick.rows], ["monitor", "quick", 8, 4], "8 × 4 cells by default");
  assert.equal(w.later.update, "manual");
  assert.deepEqual(displaySpec(w.epidemic), { name: "epidemic", kind: "plot", code: w.epidemic.code, update: "ticks" });
});

test("report: shows what its R code prints; refreshed with the monitors by default", () => {
  const [recent, summary, auto] = parse(`
    report recent "Last ticks" { tail(history, 5) }
    report summary "Summary" { print(summary_table, row.names = FALSE) } update manual w 10 h 3
    report "Wait by station" { wait_table() }
  `);
  assert.deepEqual([recent.update, recent.cols, recent.rows], ["monitor", 6, 4]);
  assert.deepEqual([summary.update, summary.cols, summary.rows], ["manual", 10, 3]);
  assert.equal(auto.name, "wait_by_station", "named from its label, like a monitor");
  assert.ok([recent, summary, auto].every((w) => w.value === undefined), "not R variables");
});

test("plot and report errors, and the engine's own function names", () => {
  const messages = (spec) => parseSpec(spec).errors.map((e) => e.message);
  assert.match(messages("plot p")[0], /A plot needs R code that draws it/);
  assert.match(messages("report r")[0], /A report needs R code that gives what to show/);
  assert.match(messages("plot p { x } update often")[0], /updates on ticks, monitor, manual; "often" isn't one of them/);
  assert.match(messages("report r { x } update")[0], /`update` is one of ticks, monitor, manual/);
  assert.match(messages("slider update_display 0..1")[0], /`update_display` belongs to the engine/);
  assert.match(messages("input workbench_download = 1")[0], /`workbench_download` belongs to the engine/);
});
