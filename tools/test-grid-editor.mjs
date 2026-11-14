// Tests for the editors' shared canvas (js/fashion/grid-editor.js), run
// against a stand-in for the browser (tools/fake-dom.mjs): what a press, a
// drag and a key do to the grid's logical cells.
//
//   node --test tools/test-grid-editor.mjs
//
// Brush footprints (exact cells, clipped at the edge), strokes with no
// gaps however fast the pointer moves, fill, erase, layer isolation, the
// history (one drag, one undo; the owner's state with it), the stamp and
// path tools untouched by the brush, a press taken away (cancel), a second
// finger, and the view: zoom and pan change no cell and no size, Overview
// fits the grid, Draw gives cells of 12 to 20 px around where the editing
// was.

import test from "node:test";
import assert from "node:assert/strict";
import { installDom, pointer } from "./fake-dom.mjs";

const dom = installDom();
const { GridEditor, toolbar, footprint, lineCells, BRUSHES, TOOLS } = await import("../js/fashion/grid-editor.js");

const blank = (W, H, ch = ".") => Array.from({ length: H }, () => ch.repeat(W));

// An editor over a W x H grid of two layers (land under areas, as the map
// has), in a canvas of w x h px.
function make({ W = 40, H = 30, w = 800, h = 600, rows, tools = [], ...opts } = {}) {
  const wrap = dom.element();
  const log = { strokes: [], state: 0, restored: [], drops: [] };
  const editor = new GridEditor(wrap, {
    layers: [{ id: "land", erase: ".", colour: () => "#aabbcc" }, { id: "areas", erase: ".", colour: (ch) => (ch === "." ? null : "#ff0000"), alpha: 0.4 }],
    tools,
    onStroke: (s) => log.strokes.push(s), onState: () => { log.state++; }, onDrop: (d) => log.drops.push(d),
    ...opts,
  });
  editor.load(rows ?? [blank(W, H), blank(W, H)]);
  dom.resize(wrap, w, h);
  dom.frames();
  return { editor, wrap, log, canvas: editor.canvas };
}

// The middle of cell (r, c) on the canvas.
const mid = (ed, r, c) => { const p = ed.toScreen(r, c); return [p.x + ed.zoom / 2, p.y + ed.zoom / 2]; };
const down = (t, r, c, extra) => t.canvas.dispatch("pointerdown", pointer(...mid(t.editor, r, c), extra));
const move = (t, r, c, extra) => t.canvas.dispatch("pointermove", pointer(...mid(t.editor, r, c), extra));
const up = (t, r, c, extra) => { const e = pointer(...mid(t.editor, r, c), { buttons: 0, ...extra }); t.canvas.dispatch("pointerup", e); t.canvas.dispatch("lostpointercapture", e); };
const drag = (t, [r0, c0], [r1, c1], extra) => { down(t, r0, c0, extra); move(t, r1, c1, extra); up(t, r1, c1, extra); dom.frames(); };
const key = (t, k, extra = {}) => t.canvas.dispatch("keydown", { key: k, shiftKey: false, ctrlKey: false, metaKey: false, ...extra });

// The cells of a layer that hold `ch`, as "r,c" strings.
const cellsOf = (ed, ch, layer = 0) => {
  const out = new Set();
  ed.rows(layer).forEach((row, r) => { for (let c = 0; c < row.length; c++) if (row[c] === ch) out.add(`${r},${c}`); });
  return out;
};
const keys = (cells) => new Set(cells.map(([r, c]) => `${r},${c}`));
// Every cell within `half` (in rows and in columns) of a cell of `path`, on the grid.
const swept = (path, half, H, W) => {
  const out = new Set();
  for (const [r, c] of path) for (let rr = r - half; rr <= r + half; rr++) for (let cc = c - half; cc <= c + half; cc++) if (rr >= 0 && cc >= 0 && rr < H && cc < W) out.add(`${rr},${cc}`);
  return out;
};

// ---- Footprints and lines ----------------------------------------------------------------

test("the brushes are 1, 3 x 3 and 7 x 7 logical cells", () => {
  assert.deepEqual(BRUSHES.map((b) => [b.name, b.size]), [["Small", 1], ["Medium", 3], ["Large", 7]]);
  for (const b of BRUSHES) {
    const cells = footprint(15, 20, b.size, 30, 40);
    assert.equal(cells.length, b.size * b.size);
    const half = (b.size - 1) / 2;
    assert.deepEqual(keys(cells), swept([[15, 20]], half, 30, 40));
  }
});

test("a footprint is clipped at the grid's edges and never leaves the grid", () => {
  assert.equal(footprint(0, 0, 7, 30, 40).length, 16);            // 4 x 4 in the corner
  assert.equal(footprint(29, 39, 7, 30, 40).length, 16);
  assert.equal(footprint(0, 20, 3, 30, 40).length, 6);            // 2 rows x 3 columns on the top edge
  assert.equal(footprint(15, 39, 7, 30, 40).length, 28);          // 7 rows x 4 columns on the right edge
  assert.equal(footprint(-5, 20, 7, 30, 40).length, 0);           // wholly off the grid
  assert.equal(footprint(-2, 20, 7, 30, 40).length, 14);          // partly off: rows 0 and 1
  for (const [r, c] of [[0, 0], [29, 39], [-3, -3], [31, 41], [5, -1]]) {
    for (const [rr, cc] of footprint(r, c, 7, 30, 40)) assert.ok(rr >= 0 && rr < 30 && cc >= 0 && cc < 40);
  }
});

test("a line's cells run end to end, each sharing a side with the next", () => {
  for (const [r0, c0, r1, c1] of [[0, 0, 0, 9], [0, 0, 9, 0], [2, 3, 17, 31], [17, 31, 2, 3], [5, 5, 5, 5], [0, 39, 29, 0], [10, 10, 11, 37]]) {
    const cells = lineCells(r0, c0, r1, c1);
    assert.deepEqual(cells[0], [r0, c0]); assert.deepEqual(cells.at(-1), [r1, c1]);
    assert.equal(cells.length, Math.abs(r1 - r0) + Math.abs(c1 - c0) + 1);
    for (let i = 1; i < cells.length; i++) assert.equal(Math.abs(cells[i][0] - cells[i - 1][0]) + Math.abs(cells[i][1] - cells[i - 1][1]), 1);
  }
});

// ---- Painting with a brush ------------------------------------------------------------------

test("a click paints exactly the brush's footprint", () => {
  for (const b of BRUSHES) {
    const t = make();
    t.editor.setPaint("="); t.editor.setBrush(b.size);
    drag(t, [15, 20], [15, 20]);
    assert.deepEqual(cellsOf(t.editor, "="), swept([[15, 20]], (b.size - 1) / 2, 30, 40), `${b.name} brush`);
  }
});

test("a brush at the corner paints only the cells on the grid", () => {
  const t = make();
  t.editor.setPaint("~"); t.editor.setBrush(7);
  drag(t, [0, 0], [0, 0]);
  assert.equal(cellsOf(t.editor, "~").size, 16);
  drag(t, [29, 39], [29, 39]);
  assert.equal(cellsOf(t.editor, "~").size, 32);
  assert.deepEqual([t.editor.W, t.editor.H, t.editor.rows(0).length, t.editor.rows(0)[0].length], [40, 30, 30, 40]);
});

test("a fast stroke, one move from end to end, leaves no gap, at every brush size", () => {
  for (const b of BRUSHES) {
    for (const [from, to] of [[[3, 4], [26, 35]], [[26, 4], [3, 35]], [[10, 2], [12, 38]], [[2, 20], [28, 22]]]) {
      const t = make();
      t.editor.setPaint("="); t.editor.setBrush(b.size);
      drag(t, from, to);
      const path = lineCells(...from, ...to);
      assert.deepEqual(cellsOf(t.editor, "="), swept(path, (b.size - 1) / 2, 30, 40), `${b.name} brush, ${from} to ${to}`);
      // Every cell of the path has a painted neighbour beside it: the stroke is one piece.
      const painted = cellsOf(t.editor, "=");
      for (let i = 1; i < path.length; i++) assert.ok(painted.has(`${path[i][0]},${path[i][1]}`));
    }
  }
});

test("a stroke that runs off the grid and back is clipped, not wrapped", () => {
  const t = make();
  t.editor.setPaint("="); t.editor.setBrush(3);
  down(t, 5, 37); move(t, 5, 45); move(t, 9, 45); move(t, 9, 36); up(t, 9, 36);
  const expected = swept([...lineCells(5, 37, 5, 45), ...lineCells(5, 45, 9, 45), ...lineCells(9, 45, 9, 36)], 1, 30, 40);
  assert.deepEqual(cellsOf(t.editor, "="), expected);
  assert.equal(t.editor.rows(0).every((row) => row.length === 40), true);
});

test("the positions the browser coalesced into one move are all painted through", () => {
  const t = make();
  t.editor.setPaint("=");
  const at = (r, c) => { const [x, y] = mid(t.editor, r, c); return { clientX: x, clientY: y }; };
  down(t, 2, 2);
  t.canvas.dispatch("pointermove", pointer(...mid(t.editor, 2, 30), { getCoalescedEvents: () => [at(20, 2), at(20, 30), at(2, 30)] }));
  up(t, 2, 30);
  const expected = keys([...lineCells(2, 2, 20, 2), ...lineCells(20, 2, 20, 30), ...lineCells(20, 30, 2, 30)]);
  assert.deepEqual(cellsOf(t.editor, "="), expected);
});

test("Shift keeps a stroke straight, along its longer way", () => {
  const t = make();
  t.editor.setPaint("=");
  down(t, 10, 5); move(t, 13, 30, { shiftKey: true }); up(t, 13, 30, { shiftKey: true });
  assert.deepEqual(cellsOf(t.editor, "="), keys(lineCells(10, 5, 10, 30)));
});

test("a road over water becomes a bridge under every cell of the brush, once", () => {
  const rows = blank(40, 30); for (let r = 10; r < 20; r++) rows[r] = "~".repeat(40);
  const t = make({ rows: [rows, blank(40, 30)] });
  t.editor.transform = (ch, old) => (ch === "=" && (old === "~" || old === "+") ? "+" : ch);
  t.editor.setPaint("="); t.editor.setBrush(3);
  drag(t, [5, 20], [24, 20]);
  const road = cellsOf(t.editor, "="); const bridge = cellsOf(t.editor, "+");
  assert.equal(bridge.size, 10 * 3); assert.equal(road.size, (20 - 10) * 3 + 3 + 3);       // rows 4 to 9 and 20 to 25
  for (const k of bridge) { const r = Number(k.split(",")[0]); assert.ok(r >= 10 && r < 20); }
  assert.equal(cellsOf(t.editor, "~").size, 10 * 40 - 30);
});

// ---- Erase, fill, layers ------------------------------------------------------------------------

test("the eraser puts back the layer's own empty tile over the brush's footprint", () => {
  const t = make({ rows: [blank(40, 30, "5"), blank(40, 30)] });
  t.editor.setTool("erase"); t.editor.setBrush(7);
  drag(t, [15, 10], [15, 20]);
  assert.deepEqual(cellsOf(t.editor, "."), swept(lineCells(15, 10, 15, 20), 3, 30, 40));
  assert.equal(cellsOf(t.editor, "5").size, 1200 - 7 * 17);
});

test("painting and erasing change the active layer only", () => {
  const t = make({ rows: [blank(40, 30, "3"), blank(40, 30)] });
  const land = t.editor.rows(0);
  t.editor.setActive(1); t.editor.setPaint("a"); t.editor.setBrush(7);
  drag(t, [5, 5], [20, 30]);
  assert.deepEqual(t.editor.rows(0), land);
  assert.ok(cellsOf(t.editor, "a", 1).size > 49);
  const areas = t.editor.rows(1);
  t.editor.setActive(0); t.editor.setTool("erase");
  drag(t, [5, 5], [20, 30]);
  assert.deepEqual(t.editor.rows(1), areas);
  assert.equal(cellsOf(t.editor, ".").size, cellsOf(t.editor, "a", 1).size);
  t.editor.setTool("fill"); t.editor.setPaint("~");
  drag(t, [28, 1], [28, 1]);
  assert.deepEqual(t.editor.rows(1), areas);
});

test("fill takes the tiles joined side to side, stops at the rest, and is one step", () => {
  const rows = blank(40, 30);
  for (let c = 5; c <= 15; c++) { rows[5] = rows[5].slice(0, c) + "#" + rows[5].slice(c + 1); rows[15] = rows[15].slice(0, c) + "#" + rows[15].slice(c + 1); }
  for (let r = 5; r <= 15; r++) rows[r] = rows[r].slice(0, 5) + "#" + rows[r].slice(6, 15) + "#" + rows[r].slice(16);
  const t = make({ rows: [rows, blank(40, 30)] });
  t.editor.setTool("fill"); t.editor.setPaint("p");
  drag(t, [10, 10], [10, 10]);
  assert.equal(cellsOf(t.editor, "p").size, 9 * 9);                 // inside the walls only
  assert.equal(t.editor.undoStack.length, 1);
  // A corner is not a way through: a diagonal gap doesn't leak.
  const d = blank(6, 6).map((row, r) => row.slice(0, r) + "#" + row.slice(r + 1));
  const u = make({ W: 6, H: 6, rows: [d, blank(6, 6)] });
  u.editor.setTool("fill"); u.editor.setPaint("p");
  drag(u, [0, 5], [0, 5]);
  assert.equal(cellsOf(u.editor, "p").size, 15);
  assert.equal(cellsOf(u.editor, ".").size, 15);
  // Filling a tile with what it already is changes nothing and adds no step.
  drag(u, [0, 5], [0, 5]);
  assert.equal(u.editor.undoStack.length, 1);
});

// ---- History ---------------------------------------------------------------------------------------

test("one drag is one undo, whatever it painted; redo paints it again", () => {
  const t = make({ rows: [blank(40, 30, "4"), blank(40, 30)] });
  const before = t.editor.rows(0);
  t.editor.setPaint("="); t.editor.setBrush(7);
  down(t, 3, 3); for (const [r, c] of [[3, 30], [25, 30], [25, 5], [10, 5], [10, 20]]) move(t, r, c); up(t, 10, 20);
  const after = t.editor.rows(0);
  assert.notDeepEqual(after, before);
  assert.equal(t.editor.undoStack.length, 1);
  assert.equal(t.log.strokes.length, 1);
  t.editor.undo();
  assert.deepEqual(t.editor.rows(0), before);
  assert.equal(t.editor.canUndo, false); assert.equal(t.editor.canRedo, true);
  t.editor.redo();
  assert.deepEqual(t.editor.rows(0), after);
  key(t, "z", { ctrlKey: true });
  assert.deepEqual(t.editor.rows(0), before);
  key(t, "z", { ctrlKey: true, shiftKey: true });
  assert.deepEqual(t.editor.rows(0), after);
});

test("a drag that changes nothing adds no step", () => {
  const t = make({ rows: [blank(40, 30, "="), blank(40, 30)] });
  t.editor.setPaint("=");
  drag(t, [3, 3], [20, 20]);
  assert.equal(t.editor.undoStack.length, 0);
  assert.equal(t.log.strokes.length, 0);
});

test("undo takes the owner's state back with the tiles", () => {
  let stores = { a: [10, 10] };
  const t = make({ snapshot: () => structuredClone(stores), restore: (s) => { stores = s; } });
  t.editor.setPaint("=");
  drag(t, [3, 3], [3, 9]);                          // the stroke keeps the stores as they were when it began
  stores = { a: [50, 50] };
  t.editor.record({ a: [10, 10] });                 // a store dragged: recorded as it was picked up
  stores = { a: [90, 90] };
  assert.equal(t.editor.undoStack.length, 2);
  t.editor.undo();
  assert.deepEqual(stores, { a: [10, 10] });
  assert.equal(cellsOf(t.editor, "=").size, 7);     // the tiles of that step were the same
  t.editor.undo();
  assert.deepEqual(stores, { a: [10, 10] });
  assert.equal(cellsOf(t.editor, "=").size, 0);
  t.editor.redo(); t.editor.redo();
  assert.deepEqual(stores, { a: [90, 90] });
  assert.equal(cellsOf(t.editor, "=").size, 7);
});

test("a block moved with the select tool is one step, and takes only its layer", () => {
  const rows = blank(40, 30); rows[4] = rows[4].slice(0, 4) + "ss" + rows[4].slice(6);
  const t = make({ rows: [rows, blank(40, 30, "a")] });
  t.editor.setTool("select");
  drag(t, [3, 3], [6, 7]);
  down(t, 4, 4); move(t, 14, 24); up(t, 14, 24);
  key(t, "Enter");
  assert.deepEqual(cellsOf(t.editor, "s"), keys([[14, 24], [14, 25]]));
  assert.equal(cellsOf(t.editor, "a", 1).size, 1200);
  assert.equal(t.editor.undoStack.length, 1);
  assert.deepEqual(t.log.drops[0], { layer: 0, r0: 3, c0: 3, w: 5, h: 4, dr: 10, dc: 20, copy: false });
  t.editor.undo();
  assert.deepEqual(t.editor.rows(0), rows);
});

// ---- The owner's tools ----------------------------------------------------------------------------------

const STAMP = { id: "stamp", label: "Stamp", key: "t", kind: "stamp", icon: "" };
const PATH = { id: "queue", label: "Queue", key: "u", kind: "path", icon: "", paint: (cells) => cells.map(([r, c], k) => [r, c, k ? "q" : "Q"]) };

test("a stamp puts down its own cells, whatever the brush's size, and turns with ] and [", () => {
  const t = make({ tools: [PATH, STAMP] });
  t.editor.setBrush(7);
  t.editor.setStamp(["####", "#FF#", "#FF#", "#FF#"]);
  t.editor.setTool("stamp");
  drag(t, [10, 10], [10, 10]);
  assert.equal(cellsOf(t.editor, "#").size, 10); assert.equal(cellsOf(t.editor, "F").size, 6);
  assert.deepEqual(cellsOf(t.editor, "F"), keys([[11, 11], [11, 12], [12, 11], [12, 12], [13, 11], [13, 12]]));
  assert.equal(t.editor.undoStack.length, 1);
  key(t, "]");
  assert.deepEqual(t.editor.stamp, ["####", "FFF#", "FFF#", "####"]);
  assert.equal(t.editor.brush, 7);                 // [ and ] turn the stamp; the brush stays as it was
  key(t, "["); key(t, "[");
  assert.deepEqual(t.editor.stamp, ["####", "#FFF", "#FFF", "####"]);
  // A space in the stamp leaves the plan as it is.
  t.editor.setStamp(["$ :"]);
  drag(t, [20, 20], [20, 20]);
  assert.equal(t.editor.at(0, 20, 21), ".");
});

test("a path tool paints one cell a step along the drag, whatever the brush's size", () => {
  const t = make({ tools: [PATH, STAMP] });
  t.editor.setBrush(7);
  t.editor.setTool("queue");
  down(t, 10, 10); move(t, 10, 16); move(t, 14, 16); move(t, 12, 16); up(t, 12, 16);
  assert.deepEqual(cellsOf(t.editor, "Q"), keys([[10, 10]]));
  assert.deepEqual(cellsOf(t.editor, "q"), keys([...lineCells(10, 11, 10, 16), [11, 16], [12, 16]]));   // going back along it shortened it
  assert.equal(t.editor.undoStack.length, 1);
});

test("[ and ] change the brush's size for the drawing tools", () => {
  const t = make({ tools: [PATH, STAMP] });
  assert.equal(t.editor.brush, 1);
  key(t, "]"); assert.equal(t.editor.brush, 3);
  key(t, "]"); assert.equal(t.editor.brush, 7);
  key(t, "]"); assert.equal(t.editor.brush, 7);
  key(t, "["); key(t, "["); key(t, "["); assert.equal(t.editor.brush, 1);
});

// ---- A press taken away ---------------------------------------------------------------------------------

test("a stroke the browser cancels is taken back, and is never a step of the history", () => {
  const t = make({ rows: [blank(40, 30, "2"), blank(40, 30)] });
  const before = t.editor.rows(0);
  t.editor.setPaint("="); t.editor.setBrush(7);
  down(t, 5, 5); move(t, 20, 30);
  assert.ok(cellsOf(t.editor, "=").size > 100);
  t.canvas.dispatch("pointercancel", pointer(0, 0));
  assert.deepEqual(t.editor.rows(0), before);
  assert.equal(t.editor.undoStack.length, 0); assert.equal(t.log.strokes.length, 0);
  assert.equal(t.editor.drag, null);
  // The next stroke works as ever.
  drag(t, [5, 5], [5, 9]);
  assert.equal(t.editor.undoStack.length, 1);
  assert.ok(cellsOf(t.editor, "=").size >= 5 * 7);
});

test("losing the pointer's capture mid-stroke cancels it; after a finished stroke it does nothing", () => {
  const t = make();
  t.editor.setPaint("=");
  down(t, 5, 5); move(t, 5, 20);
  t.canvas.dispatch("lostpointercapture", pointer(0, 0));
  assert.equal(cellsOf(t.editor, "=").size, 0);
  drag(t, [8, 5], [8, 20]);                         // its pointerup is followed by lostpointercapture
  assert.equal(cellsOf(t.editor, "=").size, 16);
  assert.equal(t.editor.undoStack.length, 1);
});

test("Escape drops the stroke in hand; a shape or a path cancelled paints nothing", () => {
  const t = make({ tools: [PATH, STAMP] });
  t.editor.setPaint("=");
  down(t, 5, 5); move(t, 5, 20); key(t, "Escape");
  assert.equal(cellsOf(t.editor, "=").size, 0);
  up(t, 5, 20);
  assert.equal(t.editor.undoStack.length, 0);
  for (const tool of ["rect", "line", "queue"]) {
    t.editor.setTool(tool);
    down(t, 5, 5); move(t, 9, 20);
    t.canvas.dispatch("pointercancel", pointer(0, 0));
    assert.deepEqual(t.editor.rows(0), blank(40, 30), tool);
  }
  assert.equal(t.editor.undoStack.length, 0);
});

test("a press is captured, so its release is heard wherever it happens", () => {
  const t = make();
  down(t, 5, 5);
  assert.ok(t.canvas.captured.has(1));
  up(t, 5, 5);
});

test("a second pointer doesn't join or end a stroke in hand", () => {
  const t = make();
  t.editor.setPaint("=");
  down(t, 5, 5); move(t, 5, 10);
  down(t, 20, 20, { pointerId: 2, pointerType: "pen" }); move(t, 25, 25, { pointerId: 2, pointerType: "pen" }); up(t, 25, 25, { pointerId: 2, pointerType: "pen" });
  assert.ok(t.editor.drag);
  move(t, 5, 15); up(t, 5, 15);
  assert.deepEqual(cellsOf(t.editor, "="), keys(lineCells(5, 5, 5, 15)));
  assert.equal(t.editor.undoStack.length, 1);
});

test("a second finger drops the first one's stroke and the two zoom and move the view", () => {
  const t = make();
  t.editor.setPaint("=");
  const touch = (id) => ({ pointerId: id, pointerType: "touch" });
  down(t, 10, 10, touch(1)); move(t, 10, 20, touch(1));
  assert.equal(cellsOf(t.editor, "=").size, 11);
  const z0 = t.editor.zoom;
  t.canvas.dispatch("pointerdown", pointer(500, 300, touch(2)));
  assert.equal(cellsOf(t.editor, "=").size, 0);                     // the half-drawn stroke is taken back
  assert.equal(t.editor.drag.kind, "pinch");
  // The fingers part to twice as far: the view zooms about the point between them.
  const a = t.editor.touches.get(1); const b = t.editor.touches.get(2);
  const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
  const under = { r: (my - t.editor.oy) / t.editor.zoom, c: (mx - t.editor.ox) / t.editor.zoom };
  t.canvas.dispatch("pointermove", pointer(mx + (a.x - mx) * 2, my + (a.y - my) * 2, touch(1)));
  t.canvas.dispatch("pointermove", pointer(mx + (b.x - mx) * 2, my + (b.y - my) * 2, touch(2)));
  assert.ok(Math.abs(t.editor.zoom - 2 * z0) < 1e-9);
  assert.ok(Math.abs((my - t.editor.oy) / t.editor.zoom - under.r) < 0.1 && Math.abs((mx - t.editor.ox) / t.editor.zoom - under.c) < 0.1);
  t.canvas.dispatch("pointerup", pointer(0, 0, touch(2))); t.canvas.dispatch("pointerup", pointer(0, 0, touch(1)));
  assert.equal(t.editor.drag, null);
  assert.equal(t.editor.undoStack.length, 0);
  assert.deepEqual([t.editor.W, t.editor.H], [40, 30]);
  assert.deepEqual(t.editor.rows(0), blank(40, 30));
});

test("the owner can take a press, and hears it cancelled", () => {
  const heard = [];
  const t = make({ pointer: { down: () => { heard.push("down"); return true; }, move: () => { heard.push("move"); return true; }, up: () => heard.push("up"), cancel: () => heard.push("cancel") } });
  t.editor.setPaint("=");
  down(t, 5, 5); move(t, 5, 9); up(t, 5, 9);
  assert.deepEqual(heard, ["down", "move", "up"]);
  down(t, 5, 5); t.canvas.dispatch("pointercancel", pointer(0, 0));
  assert.deepEqual(heard.slice(3), ["down", "cancel"]);
  assert.equal(cellsOf(t.editor, "=").size, 0);
  assert.equal(t.editor.owned, null);
});

// ---- The view --------------------------------------------------------------------------------------------

test("screen and cell agree at every zoom and pan", () => {
  const t = make({ W: 160, H: 120, w: 970, h: 628 });
  const views = [() => t.editor.fit(), () => t.editor.drawView(), () => t.editor.zoomBy(1.7, 300, 200), () => t.editor.zoomBy(0.4, 800, 500), () => t.editor.drawView({ r: 0, c: 0 }), () => t.editor.drawView({ r: 119, c: 159 })];
  for (const go of views) {
    go();
    for (const [r, c] of [[0, 0], [119, 159], [60, 80], [17, 133]]) {
      const [x, y] = mid(t.editor, r, c);
      assert.deepEqual(t.editor.cellAt(x, y), { r, c });
      const p = t.editor.toScreen(r, c);
      assert.deepEqual(t.editor.cellAt(p.x + 0.01, p.y + 0.01), { r, c });
      assert.deepEqual(t.editor.cellAt(p.x + t.editor.zoom - 0.01, p.y + t.editor.zoom - 0.01), { r, c });
    }
  }
});

test("zooming and panning change no cell and no size; painting lands on the same cell at any zoom", () => {
  const t = make({ W: 160, H: 120, w: 970, h: 628 });
  t.editor.setPaint("=");
  const before = t.editor.rows(0);
  t.editor.drawView({ r: 40, c: 40 }); t.editor.zoomBy(1.3); t.editor.zoomBy(0.2, 10, 10); t.editor.fit(); key(t, "+"); key(t, "-"); key(t, "1"); key(t, "0");
  t.editor.setTool("pan"); drag(t, [50, 50], [70, 90]); t.editor.setTool("pencil");
  t.canvas.dispatch("wheel", { ctrlKey: true, deltaY: -120, clientX: 300, clientY: 300 });
  assert.deepEqual(t.editor.rows(0), before);
  assert.deepEqual([t.editor.W, t.editor.H, t.editor.undoStack.length], [160, 120, 0]);
  const targets = [[0, 0], [119, 159], [60, 80], [33, 101]];
  const views = [() => t.editor.fit(), (r, c) => t.editor.drawView({ r, c }), (r, c) => { t.editor.drawView({ r, c }); t.editor.zoomBy(2.2); }, (r, c) => { t.editor.drawView({ r, c }); t.editor.zoomBy(0.6); }];
  for (const [r, c] of targets) {
    for (const go of views) {
      go(r, c);
      drag(t, [r, c], [r, c]);
      assert.deepEqual(cellsOf(t.editor, "="), keys([[r, c]]));
      t.editor.undo();
    }
  }
});

test("Overview fits the whole grid in the canvas, on whole pixels a cell", () => {
  for (const [W, H, w, h] of [[160, 120, 970, 628], [66, 36, 716, 628], [36, 21, 716, 628], [600, 100, 970, 628], [160, 120, 358, 420]]) {
    const t = make({ W, H, w, h });
    assert.equal(t.editor.mode, "overview");
    const p0 = t.editor.toScreen(0, 0); const p1 = t.editor.toScreen(H, W);
    assert.ok(p0.x >= 0 && p0.y >= 0 && p1.x <= w && p1.y <= h, `${W} x ${H} in ${w} x ${h}`);
    if (t.editor.zoom >= 2) assert.equal(t.editor.zoom, Math.floor(t.editor.zoom));
    assert.ok(t.editor.zoom * W > w - 16 - W || t.editor.zoom * H > h - 16 - H);     // as big as fits
  }
});

test("Draw gives cells of 12 to 20 px, around where the editing was, and Overview and back returns there", () => {
  const t = make({ W: 160, H: 120, w: 970, h: 628 });
  assert.ok(t.editor.zoom < 8);                       // the Overview's cells are too small to paint one by one
  t.editor.setPaint("=");
  drag(t, [66, 80], [70, 90]);                        // the last stroke ended at (70, 90)
  t.editor.drawView();
  assert.equal(t.editor.mode, "draw");
  assert.ok(t.editor.zoom >= 12 && t.editor.zoom <= 20);
  let centre = t.editor.cellAt(970 / 2, 628 / 2);
  assert.ok(Math.abs(centre.r - 70) <= 1 && Math.abs(centre.c - 90) <= 1, JSON.stringify(centre));
  // Pan somewhere else, go to the Overview and come back: the same place.
  t.editor.setTool("pan"); drag(t, [70, 90], [76, 105]); t.editor.setTool("pencil");
  const looked = t.editor.cellAt(970 / 2, 628 / 2);
  t.canvas.dispatch("pointerleave", pointer(0, 0));   // the pointer goes to the toolbar's buttons
  t.editor.fit();
  assert.equal(t.editor.mode, "overview");
  t.editor.drawView();
  centre = t.editor.cellAt(970 / 2, 628 / 2);
  assert.ok(Math.abs(centre.r - looked.r) <= 1 && Math.abs(centre.c - looked.c) <= 1);
  // With the pointer on the map, the 1 key goes to the cell under it.
  t.editor.fit();
  move(t, 40, 60); key(t, "1");
  centre = t.editor.cellAt(970 / 2, 628 / 2);
  assert.ok(Math.abs(centre.r - 40) <= 1 && Math.abs(centre.c - 60) <= 1);
  t.canvas.dispatch("pointerleave", pointer(0, 0));
  // A selected block is what the Draw view goes to.
  t.editor.fit(); t.editor.setTool("select");
  drag(t, [50, 60], [60, 80]);
  t.canvas.dispatch("pointerleave", pointer(0, 0));
  t.editor.drawView();
  centre = t.editor.cellAt(970 / 2, 628 / 2);
  assert.ok(Math.abs(centre.r - 55) <= 1 && Math.abs(centre.c - 70) <= 1);
  assert.deepEqual(t.editor.selection, { r0: 50, c0: 60, r1: 60, c1: 80 });
  // Editing at the map's very corner: the Draw view goes as near as the grid's edge lets it, the cell in view.
  t.editor.setTool("pencil"); t.editor.fit();
  drag(t, [119, 159], [119, 159]);
  t.editor.drawView();
  const p = t.editor.toScreen(119, 159);
  assert.ok(p.x >= 0 && p.x + t.editor.zoom <= 970 && p.y >= 0 && p.y + t.editor.zoom <= 628);
  // The grid and its size are as they were.
  assert.deepEqual([t.editor.W, t.editor.H], [160, 120]);
});

test("a grid that fits at Draw's scale is shown whole in both views", () => {
  const t = make({ W: 36, H: 21, w: 716, h: 628 });
  const z = t.editor.zoom;
  assert.ok(z >= 12);
  t.editor.drawView();
  assert.equal(t.editor.zoom, z);
  const p0 = t.editor.toScreen(0, 0); const p1 = t.editor.toScreen(21, 36);
  assert.ok(p0.x >= 0 && p0.y >= 0 && p1.x <= 716 && p1.y <= 628);
});

test("a finger gets bigger cells in the Draw view", () => {
  dom.coarse(true);
  const t = make({ W: 160, H: 120, w: 358, h: 420 });
  dom.coarse(false);
  t.editor.drawView();
  assert.equal(t.editor.zoom, 20);
});

test("the grid can't be panned out of sight", () => {
  const t = make({ W: 160, H: 120, w: 970, h: 628 });
  t.editor.drawView({ r: 60, c: 80 });
  t.editor.setTool("pan");
  for (let i = 0; i < 20; i++) { t.canvas.dispatch("pointerdown", pointer(900, 600)); t.canvas.dispatch("pointermove", pointer(10, 10)); t.canvas.dispatch("pointerup", pointer(10, 10)); }
  const p = t.editor.toScreen(120, 160);
  assert.ok(p.x >= 970 - 30 && p.y >= 628 - 30);       // the far corner stops near the canvas's corner
  for (let i = 0; i < 20; i++) { t.canvas.dispatch("pointerdown", pointer(10, 10)); t.canvas.dispatch("pointermove", pointer(900, 600)); t.canvas.dispatch("pointerup", pointer(900, 600)); }
  const q = t.editor.toScreen(0, 0);
  assert.ok(q.x <= 30 && q.y <= 30);
});

test("when the canvas changes size, the Overview fits again and the Draw view keeps its place", () => {
  const t = make({ W: 160, H: 120, w: 970, h: 628 });
  dom.resize(t.wrap, 600, 500);
  let p1 = t.editor.toScreen(120, 160);
  assert.ok(t.editor.toScreen(0, 0).x >= 0 && p1.x <= 600 && p1.y <= 500);
  t.editor.drawView({ r: 30, c: 100 });
  const z = t.editor.zoom;
  dom.resize(t.wrap, 900, 640);
  assert.equal(t.editor.zoom, z);
  const centre = t.editor.cellAt(450, 320);
  assert.ok(Math.abs(centre.r - 30) <= 1 && Math.abs(centre.c - 100) <= 1);
  assert.deepEqual([t.editor.W, t.editor.H], [160, 120]);
});

// ---- Loading, reloading and the canvas's size ------------------------------------------------------------

test("rows go in and come out the same, on every layer", () => {
  const land = ["=~ps+.19", "12345678", "9........", "........"].map((r) => r.padEnd(9, "."));
  const areas = ["aAzZ09...", ".........", "bbbbbbbbb", "........."];
  const t = make({ W: 9, H: 4, rows: [land, areas] });
  assert.deepEqual(t.editor.rows(0), land);
  assert.deepEqual(t.editor.rows(1), areas);
  assert.ok(t.editor.layers[0].data instanceof Uint16Array);
  assert.equal(t.editor.layers[0].data.length, 36);
  assert.equal(t.editor.at(0, 0, 4), "+"); assert.equal(t.editor.at(1, 0, 3), "Z");
});

test("loading again with the view kept keeps the zoom and the place; a new grid starts in the Overview", () => {
  const t = make({ W: 160, H: 120, w: 970, h: 628 });
  t.editor.drawView({ r: 20, c: 30 });
  const view = [t.editor.zoom, t.editor.ox, t.editor.oy, t.editor.mode];
  const rows = blank(160, 120, "3");
  t.editor.load([rows, blank(160, 120)], { keepView: true });
  assert.deepEqual([t.editor.zoom, t.editor.ox, t.editor.oy, t.editor.mode], view);
  assert.deepEqual(t.editor.rows(0), rows);
  t.editor.load([blank(80, 60), blank(80, 60)]);
  assert.equal(t.editor.mode, "overview");
  assert.deepEqual([t.editor.W, t.editor.H], [80, 60]);
});

test("loading drops a stroke in hand", () => {
  const t = make();
  t.editor.setPaint("=");
  down(t, 5, 5); move(t, 5, 20);
  t.editor.load([blank(40, 30, "2"), blank(40, 30)]);
  up(t, 5, 20);
  assert.deepEqual(t.editor.rows(0), blank(40, 30, "2"));
  assert.equal(t.editor.undoStack.length, 0);
});

test("the canvas's size grows and crops from the chosen edge, every layer alike, as one step", () => {
  const land = blank(10, 8); land[0] = "=" + land[0].slice(1); land[7] = land[7].slice(0, 9) + "~";
  const areas = blank(10, 8, "a");
  const t = make({ W: 10, H: 8, rows: [land, areas] });
  assert.deepEqual(t.editor.resize(14, 10, "nw"), { dx: 0, dy: 0 });
  assert.equal(t.editor.at(0, 0, 0), "="); assert.equal(t.editor.at(0, 7, 9), "~");
  assert.equal(t.editor.at(1, 9, 13), "."); assert.equal(t.editor.at(1, 7, 9), "a");
  t.editor.undo();
  assert.deepEqual(t.editor.rows(0), land); assert.deepEqual([t.editor.W, t.editor.H], [10, 8]);
  assert.deepEqual(t.editor.resize(14, 10, "se"), { dx: 4, dy: 2 });
  assert.equal(t.editor.at(0, 2, 4), "="); assert.equal(t.editor.at(0, 9, 13), "~");
  assert.deepEqual(t.editor.resize(6, 4, "c"), { dx: -4, dy: -3 });
  assert.deepEqual([t.editor.W, t.editor.H, t.editor.rows(0).length, t.editor.rows(1)[0].length], [6, 4, 4, 6]);
  assert.equal(t.editor.mode, "overview");
  assert.equal(t.editor.undoStack.length, 2);
});

// ---- The toolbar -----------------------------------------------------------------------------------------

test("the toolbar's first row is Draw, the brush's size, Fill, Erase, Place, Undo and Redo, each with its name", () => {
  const t = make({ tools: [PATH, STAMP], names: { material: (ch) => ({ "=": "Road", ".": "Open land" }[ch] ?? ch), layer: (i) => (i ? "Areas" : "Land") }, cellM: () => 50 });
  let placing = false;
  const bar = toolbar(t.editor, { place: { label: "Place store", onClick: () => { placing = true; bar.sync(); }, active: () => placing } });
  const first = bar.children[0];
  const names = first.findAll((e) => e.tagName === "BUTTON" && (e.dataset.tool || e.getAttribute("aria-label")?.match(/^(Undo|Redo)/))).map((b) => b.text);
  assert.deepEqual(names, ["Draw", "Fill", "Erase", "Place store", "Undo", "Redo"]);
  const brushes = first.findAll((e) => e.dataset.brush);
  assert.deepEqual(brushes.map((b) => b.getAttribute("aria-label")), ["Small brush: 1 × 1 tile (50 m × 50 m)", "Medium brush: 3 × 3 tiles (150 m × 150 m)", "Large brush: 7 × 7 tiles (350 m × 350 m)"]);
  // Every other tool is in the second row, by name (the stamp's pictures are the owner's palette's).
  const more = bar.children[1].findAll((e) => e.dataset.tool).map((b) => b.dataset.tool);
  assert.deepEqual(more, ["rect", "line", "pick", "select", "pan", "queue"]);
  assert.deepEqual(TOOLS.map((x) => x.id).filter((id) => !more.includes(id)), ["pencil", "fill", "erase"]);
  // What a press would do, in words.
  const words = () => bar.children[2].text;
  t.editor.setPaint("="); t.editor.setBrush(3);
  assert.equal(words(), "Draw · Road · Land layer · Medium brush, 3 × 3 tiles (150 m × 150 m)");
  t.editor.setTool("erase"); t.editor.setBrush(7);
  assert.equal(words(), "Erase · back to Open land · Land layer · Large brush, 7 × 7 tiles (350 m × 350 m)");
  // The buttons follow the editor.
  const pressed = (id) => bar.find((e) => e.dataset.tool === id).getAttribute("aria-pressed");
  assert.equal(pressed("erase"), "true"); assert.equal(pressed("pencil"), "false");
  assert.equal(brushes[2].getAttribute("aria-checked"), "true");
  const undo = bar.find((e) => e.getAttribute("aria-label")?.startsWith("Undo"));
  assert.equal(undo.disabled, true);
  t.editor.setTool("pencil");
  drag(t, [5, 5], [5, 9]);
  assert.equal(undo.disabled, false);
  undo.click();
  assert.equal(undo.disabled, true);
  // A brush's button picks the size and the Draw tool; the view's buttons switch the view.
  t.editor.setTool("select");
  brushes[1].click();
  assert.deepEqual([t.editor.brush, t.editor.tool], [3, "pencil"]);
  bar.find((e) => e.dataset.view === "draw").click();
  assert.equal(t.editor.mode, "draw");
  assert.equal(bar.find((e) => e.dataset.view === "draw").getAttribute("aria-pressed"), "true");
  bar.find((e) => e.dataset.view === "overview").click();
  assert.equal(t.editor.mode, "overview");
  // Place is the owner's.
  bar.find((e) => e.dataset.tool === "place").click();
  assert.equal(placing, true);
  assert.equal(pressed("place"), "true"); assert.equal(pressed("pencil"), "false");
});

test("drawing every frame of every tool raises nothing", () => {
  const t = make({ tools: [PATH, STAMP], W: 160, H: 120, w: 970, h: 628 });
  t.editor.setStamp(["$::", "$c:", "$::"]);
  for (const tool of ["pencil", "erase", "rect", "line", "fill", "pick", "select", "pan", "queue", "stamp"]) {
    for (const view of ["overview", "draw"]) {
      t.editor.setView(view); t.editor.setTool(tool); t.editor.setBrush(7);
      const c = t.editor.cellAt(400, 300);
      move(t, c.r, c.c); dom.frames();
      down(t, c.r, c.c); dom.frames(); move(t, c.r + 2, c.c + 3); dom.frames(); up(t, c.r + 2, c.c + 3); dom.frames();
    }
  }
  t.editor.setHighlights([[3, 3], [4, 4]]); dom.frames();
  assert.ok(t.editor.ctx.calls.drawImage > 0);
});
