/*
 * coi-serviceworker.js — cross-origin isolation and asset caching for static
 * hosts.
 *
 * webR is fastest (and interruptible) when it can use SharedArrayBuffer, which
 * browsers only expose on cross-origin isolated pages. That requires the
 * COOP/COEP response headers, which GitHub Pages cannot send. This file fills
 * the gap: loaded as a classic <script>, it registers itself as a service
 * worker; running as that service worker, it re-serves every response with
 * the headers added. After a one-time reload the page is isolated.
 *
 * Since every request passes through it anyway, it also caches the heavy,
 * rarely-changing downloads so return visits start without the network:
 *   - a published webR release (webr.r-wasm.org/vX.Y.Z/) never changes, so
 *     it is cached for good;
 *   - the NetLogoR library image, the editor bundle and model data files are
 *     served from the cache at once and refreshed in the background, so a
 *     new deployment arrives on the following visit.
 *
 * When the server already sends the headers (tools/serve.R), the page is
 * isolated on first load and this script does nothing.
 *
 * The isolation approach follows gzuidhof/coi-serviceworker (MIT), trimmed to
 * COEP require-corp only so it behaves the same in every browser.
 */

if (typeof window === "undefined") {
  // ---- Service worker context -------------------------------------------
  const CACHE = "netlogor-assets-v1";
  const IMMUTABLE = /^https:\/\/webr\.r-wasm\.org\/v\d+\.\d+\.\d+\//;
  const REVALIDATE = /\/(vfs|vendor|templates\/data)\//;

  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
      // Drop caches from earlier versions of this worker.
      for (const key of await caches.keys()) {
        if (key.startsWith("netlogor-assets-") && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })());
  });

  self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((client) => client.navigate(client.url)));
    }
  });

  const isolated = (response) => {
    // Opaque responses can't be modified; they must carry their own CORP.
    if (response.status === 0) return response;
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };

  const fetchAndStore = async (request) => {
    const response = isolated(await fetch(request));
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  };

  const cacheFirst = async (request) => (await caches.match(request)) ?? fetchAndStore(request);

  const staleWhileRevalidate = async (request, event) => {
    const cached = await caches.match(request);
    const refresh = fetchAndStore(request);
    if (!cached) return refresh;
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  };

  self.addEventListener("fetch", (event) => {
    const request = event.request;
    // Chrome bug workaround: this combination throws when re-fetched.
    if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

    const url = new URL(request.url);
    const cacheable = request.method === "GET" && !request.headers.has("range");

    if (cacheable && IMMUTABLE.test(request.url)) {
      event.respondWith(cacheFirst(request));
    } else if (cacheable && url.origin === self.location.origin && REVALIDATE.test(url.pathname)) {
      event.respondWith(staleWhileRevalidate(request, event));
    } else {
      event.respondWith(fetch(request).then(isolated));
    }
  });
} else {
  // ---- Window context ----------------------------------------------------
  (() => {
    const RELOAD_KEY = "coiReloadedBySelf";
    const reloadedBySelf = window.sessionStorage.getItem(RELOAD_KEY);
    window.sessionStorage.removeItem(RELOAD_KEY);

    // Already isolated (headers from the server, or this worker did its job),
    // or the browser has no notion of isolation at all.
    if (window.crossOriginIsolated !== false) return;

    // Never reload twice in a row; if isolation failed once it will fail again.
    if (reloadedBySelf) {
      console.warn("[coi] Page is still not cross-origin isolated after reload; continuing without SharedArrayBuffer.");
      return;
    }

    if (!window.isSecureContext) {
      console.info("[coi] Not a secure context; cross-origin isolation unavailable.");
      return;
    }
    if (!navigator.serviceWorker) {
      console.info("[coi] Service workers unavailable (private mode?); continuing without isolation.");
      return;
    }

    const reload = (reason) => {
      window.sessionStorage.setItem(RELOAD_KEY, reason);
      window.location.reload();
    };

    navigator.serviceWorker.register(window.document.currentScript.src).then(
      (registration) => {
        registration.addEventListener("updatefound", () => reload("updatefound"));
        // Active but not yet controlling this page: reload so it can.
        if (registration.active && !navigator.serviceWorker.controller) reload("notcontrolling");
      },
      (err) => console.warn("[coi] Service worker registration failed; continuing without SharedArrayBuffer.", err)
    );
  })();
}
