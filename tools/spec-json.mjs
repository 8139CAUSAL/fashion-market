#!/usr/bin/env node
// Prints what an interface spec asks of R, as JSON, using the Workbench's
// own parser, so tools/check-templates.R runs a model exactly as the page
// would (loops, panels and all):
//
//   node tools/spec-json.mjs templates/zombies.ui
//
//   {
//     "errors":   [{ line, message }],
//     "values":   { name: value },             pushed before setup()
//     "monitors": [{ name, reporter, digits }],
//     "views":    [view spec],                 as sent with SET_VIEWS
//     "imports":  [{ name, label, accept, code }],
//     "displays": [{ name, kind, code, update }]  plots and reports
//   }

import { readFileSync } from "node:fs";
import { parseSpec, viewSpec, displaySpec, DEFAULT_VIEW, VALUE_TYPES, DISPLAY_TYPES } from "../js/spec-parser.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: node tools/spec-json.mjs file.ui");
  process.exit(2);
}

const { widgets, errors } = parseSpec(readFileSync(path, "utf8"));
const shown = widgets.filter((widget) => !widget.gap);
const ofType = (type) => shown.filter((widget) => widget.type === type);
const views = ofType("view").map(viewSpec);

process.stdout.write(JSON.stringify({
  errors,
  values: Object.fromEntries(shown.filter((w) => VALUE_TYPES.includes(w.type)).map((w) => [w.name, w.value])),
  monitors: ofType("monitor").map(({ name, reporter, digits }) => ({ name, reporter, digits: digits ?? null })),
  views: views.length ? views : [DEFAULT_VIEW],
  imports: ofType("import").map(({ name, label, accept, code }) => ({ name, label, accept, code })),
  displays: shown.filter((w) => DISPLAY_TYPES.includes(w.type)).map(displaySpec),
}));
