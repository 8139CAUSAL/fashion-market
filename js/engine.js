// Main-thread client for the engine worker. Re-dispatches worker messages as
// DOM events (STATUS, WEBR_READY, ERROR, LOG) and wraps request/response
// messages in promises.

// What a request still waiting when its engine is terminated rejects with.
// Only a rebuild terminates an engine, so the work was dropped on purpose:
// it isn't a failure, and the new engine owns the screen.
export class EngineTerminated extends Error {
  constructor() {
    super("Engine terminated.");
    this.name = "EngineTerminated";
  }
}

export class EngineClient extends EventTarget {
  #worker;
  #nextId = 1;
  #pending = new Map();

  constructor() {
    super();
    this.#worker = new Worker(new URL("../workers/engine.worker.js", import.meta.url), { type: "module" });
    this.#worker.addEventListener("message", (event) => this.#onMessage(event.data));
    this.#worker.addEventListener("error", (event) => {
      this.#emit("ERROR", { stage: "worker", message: event.message || "Engine worker failed to load." });
    });
  }

  #onMessage(msg) {
    if (msg.type === "RESULT") {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      msg.ok ? pending.resolve(msg.value) : pending.reject(new Error(msg.error));
      return;
    }
    this.#emit(msg.type, msg);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // Tells the worker a frame has been painted, freeing it to send the next.
  ack() {
    this.#worker.postMessage({ type: "ACK" });
  }

  // Asks R to abandon whatever it is doing (see INTERRUPT in the worker).
  interrupt() {
    this.#worker.postMessage({ type: "INTERRUPT" });
  }

  // `transfer` lists ArrayBuffers in the payload to hand over rather than
  // copy (e.g. an imported file); they're unusable here afterwards.
  request(type, payload = {}, transfer = []) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ type, id, ...payload }, transfer);
    });
  }

  // Terminating takes the webR session with it: the nested worker running R
  // belongs to this worker, so nothing survives a rebuild.
  terminate() {
    this.#worker.terminate();
    for (const { reject } of this.#pending.values()) reject(new EngineTerminated());
    this.#pending.clear();
    console.info("[engine] worker terminated");
  }
}
