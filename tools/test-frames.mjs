// Tests for reading packed frames (js/renderer.js parseFrame), built by hand
// to the layout documented in r/workbench.R. tools/test-engine.R checks that
// R writes that layout.
//
//   node --test tools/test-frames.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { parseFrame, frameVersion } from "../js/renderer.js";

// One view's section: header, then whatever `parts` it carries.
function section({ turtles = 0, width = 0, height = 0, colours = 0, flags = 0, categories = 0,
  patches = null, turtleData = null, colourBytes = null, categoryBytes = null }) {
  const body = [];
  if (patches) body.push(new Uint8Array(new Float32Array(patches).buffer));
  if (turtleData) body.push(new Uint8Array(new Float32Array(turtleData).buffer));
  if (colourBytes) body.push(new Uint8Array(colourBytes));
  if (categoryBytes) body.push(new Uint8Array(categoryBytes));
  let bytes = 56 + body.reduce((n, b) => n + b.length, 0);
  const padding = (4 - (bytes % 4)) % 4;
  bytes += padding;

  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  [bytes, turtles, width, height, 1, colours, flags, 0, categories, 1].forEach((v, i) => view.setInt32(i * 4, v, true));
  [0, 1, -2, -1].forEach((v, i) => view.setFloat32(40 + i * 4, v, true));
  let offset = 56;
  for (const part of body) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function frame(ticks, version, sections) {
  const total = 12 + sections.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setInt32(0, ticks, true);
  view.setInt32(4, sections.length, true);
  view.setInt32(8, version, true);
  let offset = 12;
  for (const s of sections) {
    out.set(s, offset);
    offset += s.length;
  }
  return out.buffer;
}

test("reads each view's section in order, with odd-length colour tables padded", () => {
  const buffer = frame(7, 3, [
    // 2 × 2 patches, one turtle, one turtle colour (3 bytes → padding)
    section({ turtles: 1, width: 2, height: 2, colours: 1, flags: 1 | 2, patches: [1, 2, 3, 4],
      turtleData: [0.5, -0.5, 90, 1, 0], colourBytes: [255, 0, 0] }),
    // patches only, and categories (2 colours: 6 bytes → padding)
    section({ width: 3, height: 1, flags: 1 | 4 | 8, categories: 2, patches: [0, 1, 0], categoryBytes: [0, 0, 0, 9, 9, 9] }),
    // a world that doesn't exist yet
    section({ flags: 16 }),
  ]);

  assert.equal(frameVersion(buffer), 3);
  const f = parseFrame(buffer);
  assert.equal(f.ticks, 7);
  assert.equal(f.views.length, 3);

  const [a, b, c] = f.views;
  assert.deepEqual([...a.patches], [1, 2, 3, 4]);
  assert.deepEqual([...a.turtles], [0.5, -0.5, 90, 1, 0]);
  assert.deepEqual([...a.turtleColours], [255, 0, 0]);
  assert.deepEqual([a.minPxcor, a.minPycor], [-2, -1]);

  assert.deepEqual([...b.patches], [0, 1, 0]);
  assert.equal(b.categorical, true);
  assert.deepEqual([...b.patchColours], [0, 0, 0, 9, 9, 9]);
  assert.equal(b.turtleCount, 0);

  assert.equal(c.missing, true);
  assert.equal(c.patches, undefined);
});

test("what a view's frame leaves out is carried over from that view's previous frame", () => {
  const first = parseFrame(frame(1, 1, [
    section({ turtles: 1, width: 1, height: 1, colours: 1, flags: 1 | 2, patches: [5], turtleData: [0, 0, 0, 1, 0], colourBytes: [1, 2, 3] }),
    section({ width: 1, height: 1, flags: 1, patches: [9] }),
  ]));
  const next = parseFrame(frame(2, 1, [
    section({ turtles: 1, width: 1, height: 1, colours: 1, flags: 0, turtleData: [1, 1, 0, 1, 0] }),
    section({ width: 1, height: 1, flags: 1, patches: [10] }),
  ]), first.views);

  assert.deepEqual([...next.views[0].patches], [5], "unchanged patches stay from view 0's last frame");
  assert.deepEqual([...next.views[0].turtleColours], [1, 2, 3]);
  assert.deepEqual([...next.views[0].turtles], [1, 1, 0, 1, 0]);
  assert.deepEqual([...next.views[1].patches], [10], "view 1's new patches, not view 0's");
});

test("turtles with shapes of their own carry a sixth column", () => {
  const f = parseFrame(frame(3, 1, [
    section({ turtles: 2, width: 1, height: 1, colours: 1, flags: 1 | 2 | 32, patches: [0],
      turtleData: [0, 1, 0, 1, 90, 0, 1, 2, 0, 0, 1, 2], colourBytes: [9, 9, 9] }),
    section({ turtles: 1, width: 1, height: 1, flags: 1, patches: [0], turtleData: [0, 0, 0, 1, 0] }),
  ]));
  const [own, plain] = f.views;
  assert.deepEqual([...own.turtles.subarray(0, 10)], [0, 1, 0, 1, 90, 0, 1, 2, 0, 0]);
  assert.deepEqual([...own.turtleShapes], [1, 2], "a dot and a square");
  assert.deepEqual([...own.turtleColours], [9, 9, 9], "the colour table follows the shapes");
  assert.equal(plain.turtleShapes, null);
});
