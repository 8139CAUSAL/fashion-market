// Tests for coi-serviceworker.js, run in a simulated service worker scope:
// in-memory Cache Storage and a scripted fetch.
//
//   node --test tools/test-sw.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../coi-serviceworker.js", import.meta.url), "utf8");
const ORIGIN = "https://example.github.io";

function serviceWorkerScope() {
  const listeners = {};
  const store = new Map();
  const network = [];

  const caches = {
    open: async () => ({
      put: async (request, response) => store.set(request.url, response),
    }),
    match: async (request) => store.get(request.url)?.clone(),
    keys: async () => ["netlogor-assets-v1"],
    delete: async () => true,
  };

  let version = 0;
  const fetch = async (request) => {
    network.push(request.url);
    version += 1;
    return new Response(`body ${version}`, { status: 200, headers: { "Content-Type": "text/plain" } });
  };

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting() {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(source, { self, caches, fetch, Response, Headers, URL, console });

  // Dispatches a fetch event and resolves with the response it produced.
  const request = async (path, init = {}) => {
    const req = new Request(path.startsWith("http") ? path : ORIGIN + path, init);
    let responded = null;
    const pending = [];
    listeners.fetch({
      request: req,
      respondWith: (promise) => (responded = promise),
      waitUntil: (promise) => pending.push(promise),
    });
    const response = await responded;
    await Promise.all(pending);
    return response;
  };

  return { request, network, store };
}

test("adds the isolation headers to ordinary responses", async () => {
  const sw = serviceWorkerScope();
  const response = await sw.request("/index.html");
  assert.equal(response.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
  assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(sw.store.size, 0, "app code is not cached");
});

test("caches a versioned webR release for good", async () => {
  const sw = serviceWorkerScope();
  const url = "https://webr.r-wasm.org/v0.6.0/R.wasm";
  const first = await sw.request(url);
  const second = await sw.request(url);
  assert.equal(await first.text(), "body 1");
  assert.equal(await second.text(), "body 1", "second visit comes from the cache");
  assert.equal(sw.network.length, 1);
  assert.equal(second.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
});

test("does not pin webR's moving 'latest' channel", async () => {
  const sw = serviceWorkerScope();
  await sw.request("https://webr.r-wasm.org/latest/webr.mjs");
  await sw.request("https://webr.r-wasm.org/latest/webr.mjs");
  assert.equal(sw.network.length, 2);
});

test("serves the library image from cache and refreshes it in the background", async () => {
  const sw = serviceWorkerScope();
  const first = await sw.request("/vfs/netlogor-lib.data.gz");
  assert.equal(await first.text(), "body 1");

  const second = await sw.request("/vfs/netlogor-lib.data.gz");
  assert.equal(await second.text(), "body 1", "answered from the cache");
  assert.equal(sw.network.length, 2, "while fetching a fresh copy");

  const third = await sw.request("/vfs/netlogor-lib.data.gz");
  assert.equal(await third.text(), "body 2", "the refreshed copy is used next time");
});

test("leaves range requests and non-GET requests alone", async () => {
  const sw = serviceWorkerScope();
  await sw.request("/vfs/netlogor-lib.data.gz", { headers: { range: "bytes=0-99" } });
  await sw.request("/templates/data/gottingen.rds", { method: "POST", body: "x" });
  assert.equal(sw.store.size, 0);
});
