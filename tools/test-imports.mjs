// Tests for imported-file handling (js/imports.js) and for writing R code
// from JavaScript values (js/r-code.js), which imports and views rely on.
//
//   node --test tools/test-imports.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { ImportStore, ImportError, IMPORT_LIMIT_BYTES, accepts, chooseFile, describeImport, formatBytes } from "../js/imports.js";
import { rString, rValue, rList, safeFileName } from "../js/r-code.js";

const file = (name, type = "", size = 10) => {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
};

test("accept lists work as in HTML: endings, exact types and type/*", () => {
  assert.equal(accepts(null, file("anything.bin")), true);
  assert.equal(accepts(".csv", file("Data.CSV")), true, "endings ignore case");
  assert.equal(accepts(".csv", file("data.txt", "text/csv")), false, "an ending means the ending");
  assert.equal(accepts("text/csv", file("data.txt", "text/csv")), true);
  assert.equal(accepts("image/*", file("map.png", "image/png")), true);
  assert.equal(accepts(".geojson,.json", file("area.json")), true);
  assert.equal(accepts(".geojson,.json", file("area.shp")), false);
});

test("an import takes exactly one acceptable file under the size limit", () => {
  const widget = { name: "roads", label: "Road network (.rds)", accept: ".rds" };
  assert.equal(chooseFile(widget, [file("roads.rds")]).name, "roads.rds");

  const rejects = (files, pattern) => assert.throws(() => chooseFile(widget, files), (err) => {
    assert.ok(err instanceof ImportError);
    assert.match(err.message, pattern);
    return true;
  });
  rejects([], /No file was chosen/);
  rejects([file("a.rds"), file("b.rds")], /Drop one file: "Road network \(\.rds\)" takes a single file/);
  rejects([file("roads.shp")], /roads\.shp isn't one of the files this import takes \(\.rds\)/);
  rejects([file("huge.rds", "", IMPORT_LIMIT_BYTES + 1)], /huge\.rds is 50\.0 MB; an import can be at most 50\.0 MB/);
  assert.equal(chooseFile(widget, [file("edge.rds", "", IMPORT_LIMIT_BYTES)]).name, "edge.rds", "exactly 50 MB is fine");
});

test("an import widget describes its file", () => {
  assert.deepEqual(describeImport(null), { state: "empty", text: "No file yet" });
  const record = { fileName: "revenue.csv", size: 2048, state: "ready" };
  assert.deepEqual(describeImport(record), { state: "ready", text: "revenue.csv · 2.0 kB" });
  assert.equal(describeImport({ ...record, state: "reading" }).text, "Reading revenue.csv…");
  assert.equal(describeImport({ ...record, state: "failed" }).text, "revenue.csv · 2.0 kB · its code failed");
  assert.deepEqual([formatBytes(12), formatBytes(1536), formatBytes(3 * 1024 * 1024)], ["12 B", "1.5 kB", "3.0 MB"]);
});

test("the store keeps one file per import, and knows which imports still need one", () => {
  const store = new ImportStore();
  const widgets = [{ name: "a" }, { name: "b" }];
  store.set("a", { fileName: "one.csv" });
  store.set("a", { fileName: "two.csv" });
  assert.equal(store.get("a").fileName, "two.csv");
  assert.deepEqual(store.missing(widgets).map((w) => w.name), ["b"]);
  store.clear();
  assert.equal(store.get("a"), null);
});

test("R code from JavaScript values: strings are always quoted data", () => {
  assert.equal(rString('say "hi" \\ bye'), '"say \\"hi\\" \\\\ bye"');
  assert.equal(rString('"); unlink("/"); ("'), '"\\"); unlink(\\"/\\"); (\\""');
  assert.equal(rValue(null), "NULL");
  assert.equal(rValue(2), "2L");
  assert.equal(rValue(0.5), "0.5");
  assert.equal(rValue(Infinity), "NA");
  assert.equal(rValue(["black", "#fff"]), 'c("black", "#fff")');
  assert.equal(rValue([]), "list()");
  assert.equal(
    rValue([{ name: "city", colors: { values: ["black"] }, layer: null }]),
    'list(list(name = "city", colors = list(values = c("black")), layer = NULL))'
  );
  assert.equal(rList({ speed: 2, torus: true, label: "a\"b" }), 'list(speed = 2, torus = TRUE, label = "a\\"b")');
});

test("imported file names can't reach outside their folder", () => {
  assert.equal(safeFileName("revenue.csv"), "revenue.csv");
  assert.equal(safeFileName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(safeFileName("a\\b.csv"), "a_b.csv");
  assert.equal(safeFileName(".."), "file");
  assert.equal(safeFileName("new\nline.csv"), "newline.csv");
});
