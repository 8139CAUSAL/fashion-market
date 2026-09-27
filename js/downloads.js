// Files leaving the browser for the user's disk: recordings, and files a
// model hands over with workbench_download().

// A media type for a file name, so the saved file opens in the right app.
const TYPES = {
  csv: "text/csv", tsv: "text/tab-separated-values", txt: "text/plain", md: "text/markdown",
  json: "application/json", geojson: "application/geo+json", html: "text/html", xml: "application/xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", pdf: "application/pdf",
  mp4: "video/mp4", webm: "video/webm", zip: "application/zip",
};

export function mediaTypeFor(name) {
  const extension = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return TYPES[extension] ?? "application/octet-stream";
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  // Give the download a moment to start before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
