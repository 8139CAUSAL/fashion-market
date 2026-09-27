// Tests for share links: line diffs and workspace encoding round trips.
//
//   node --test tools/test-share.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { diffLines, applyPatch, encodeWorkspace, decodeWorkspace } from "../js/share.js";

const read = (file) => readFileSync(new URL(`../templates/${file}`, import.meta.url), "utf8");
// The gallery's presets, read the way the page reads them.
const presets = Object.fromEntries(
  JSON.parse(read("index.json")).templates.map(({ id, spec, model }) => [
    id,
    { id, spec: read(spec), model: read(model) },
  ])
);
const loadPreset = async (id) => presets[id];

test("a diff reproduces the edited text", () => {
  const base = "a\nb\nc\nd\ne";
  for (const edited of ["a\nb\nc\nd\ne", "a\nB\nc\nd\ne", "x\na\nb\nd\ne\ny", "", "e\nd\nc\nb\na", "a\nb\nc\nd\ne\n"]) {
    assert.equal(applyPatch(base, diffLines(base, edited)), edited);
  }
});

test("diffs round-trip on every preset with scattered edits", () => {
  for (const { model } of Object.values(presets)) {
    const lines = model.split("\n");
    lines.splice(3, 1, "# changed line");
    lines.splice(Math.floor(lines.length / 2), 0, "added <- 1", "added2 <- 2");
    lines.splice(lines.length - 2, 1);
    const edited = lines.join("\n");
    assert.equal(applyPatch(model, diffLines(model, edited)), edited);
  }
});

test("an untouched preset becomes a tiny link", async () => {
  const hash = await encodeWorkspace(presets.zombies, presets.zombies);
  assert.equal(hash, "preset=zombies");
  const back = await decodeWorkspace(`#${hash}`, loadPreset);
  assert.equal(back.model, presets.zombies.model);
  assert.equal(back.spec, presets.zombies.spec);
});

test("a tweaked preset travels as a short diff", async () => {
  const workspace = {
    spec: presets.zombies.spec.replace("population 20..500 = 100", "population 20..800 = 300"),
    model: presets.zombies.model.replace('ZOMBIE <- "#51cf66"', 'ZOMBIE <- "#ff6b6b"'),
  };
  const hash = await encodeWorkspace(workspace, presets.zombies);
  assert.ok(hash.startsWith("m="));
  assert.ok(hash.length < 300, `link too long: ${hash.length}`);

  const back = await decodeWorkspace(`#${hash}`, loadPreset);
  assert.equal(back.spec, workspace.spec);
  assert.equal(back.model, workspace.model);
  assert.equal(back.presetId, "zombies");
  assert.equal(back.warning, null);
});

test("every preset, heavily edited, fits a 2,000-character link", async () => {
  for (const preset of Object.values(presets)) {
    const workspace = {
      spec: preset.spec + "\nnote \"shared with a friend\"\n",
      model: preset.model.replace(/setup <- function\(\) \{/, "setup <- function() {\n  set.seed(7)") + "\n# my notes\n",
    };
    const hash = await encodeWorkspace(workspace, preset);
    assert.ok(hash.length < 2000, `${preset.id}: ${hash.length} characters`);
    const back = await decodeWorkspace(`#${hash}`, loadPreset);
    assert.equal(back.model, workspace.model, preset.id);
    assert.equal(back.spec, workspace.spec, preset.id);
  }
});

test("a model written from scratch travels whole", async () => {
  const workspace = { spec: "button setup\nbutton go forever .right(setup)", model: "setup <- function() {}\ngo <- function() {}" };
  const hash = await encodeWorkspace(workspace, null);
  const back = await decodeWorkspace(`#${hash}`, loadPreset);
  assert.deepEqual({ spec: back.spec, model: back.model }, workspace);
  assert.equal(back.presetId, null);
});

test("a link made from an older preset says so", async () => {
  const base = presets.zombies;
  const workspace = { spec: base.spec, model: base.model + "\n# edit\n" };
  const hash = await encodeWorkspace(workspace, base);
  const changed = async (id) => ({ ...presets[id], model: presets[id].model + "\n# preset updated since\n" });
  const back = await decodeWorkspace(`#${hash}`, changed);
  assert.match(back.warning, /earlier version/);
});

test("a hash without a model is ignored", async () => {
  assert.equal(await decodeWorkspace("#", loadPreset), null);
  assert.equal(await decodeWorkspace("#something=else", loadPreset), null);
});
