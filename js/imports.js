// Files imported into R by the interface's `import` widgets.
//
// An import hands R a file's path and runs the import's own R code; what the
// file means is entirely up to that code. The page keeps each file for as
// long as the workspace it was imported into: a Rebuild writes it into the
// new R session and reruns the import's code before setup(), and loading
// another model or a share link lets it go. That matches the editors, which
// also live only as long as the page. Files never leave the browser and
// never go into share links.

export const IMPORT_LIMIT_BYTES = 50 * 1024 * 1024;

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportError";
  }
}

// One file per import name: { fileName, size, type, blob, state, error }.
// `state` is "reading" while R runs the import's code, then "ready" or
// "failed".
export class ImportStore {
  #files = new Map();

  get(name) {
    return this.#files.get(name) ?? null;
  }

  set(name, record) {
    this.#files.set(name, record);
    return record;
  }

  clear() {
    this.#files.clear();
  }

  // The imports among `widgets` still waiting for a file.
  missing(widgets) {
    return widgets.filter((widget) => !this.#files.has(widget.name));
  }
}

// Whether a file matches an import's `accept` list (file endings and media
// types, as in HTML; null accepts anything). The file picker applies the
// same list, so this holds dropped files to it too.
export function accepts(accept, file) {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return accept.split(",").some((item) => {
    if (item.startsWith(".")) return name.endsWith(item);
    if (item.endsWith("/*")) return type.startsWith(item.slice(0, -1));
    return type === item;
  });
}

// The one file an import takes from a pick or a drop, or an ImportError
// saying why none can be used.
export function chooseFile(widget, files) {
  const list = [...files];
  if (!list.length) throw new ImportError("No file was chosen.");
  if (list.length > 1) throw new ImportError(`Drop one file: "${widget.label || widget.name}" takes a single file.`);
  const [file] = list;
  if (!accepts(widget.accept, file)) {
    throw new ImportError(`${file.name} isn't one of the files this import takes (${widget.accept.split(",").join(", ")}).`);
  }
  if (file.size > IMPORT_LIMIT_BYTES) {
    throw new ImportError(`${file.name} is ${formatBytes(file.size)}; an import can be at most ${formatBytes(IMPORT_LIMIT_BYTES)}.`);
  }
  return file;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// What an import widget says about its file.
export function describeImport(record) {
  if (!record) return { state: "empty", text: "No file yet" };
  const file = `${record.fileName} · ${formatBytes(record.size)}`;
  if (record.state === "reading") return { state: "reading", text: `Reading ${record.fileName}…` };
  if (record.state === "failed") return { state: "failed", text: `${file} · its code failed` };
  return { state: "ready", text: file };
}
