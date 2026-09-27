// Records the world canvas to a video file, entirely in the browser.
//
// canvas.captureStream() feeds MediaRecorder, which encodes as the model
// runs; stopping hands back a Blob the page downloads. No server, no
// frame stitching, no ffmpeg.

// Best first: MP4 plays everywhere, but only some browsers can encode it,
// so WebM is the fallback.
const PREFERRED_TYPES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export function supportedMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export class CanvasRecorder {
  #canvas;
  #recorder = null;
  #chunks = [];
  #startedAt = 0;

  constructor(canvas) {
    this.#canvas = canvas;
  }

  get recording() {
    return this.#recorder?.state === "recording";
  }

  get elapsedMs() {
    return this.recording ? performance.now() - this.#startedAt : 0;
  }

  // `fps` is the capture rate requested of the canvas; the recorder simply
  // encodes whatever the render loop paints.
  start({ fps = 30 } = {}) {
    if (this.recording) return;

    const mimeType = supportedMimeType();
    if (!mimeType) throw new Error("This browser cannot record video from a canvas.");

    const stream = this.#canvas.captureStream(fps);
    this.#recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    this.#chunks = [];
    this.#recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) this.#chunks.push(event.data);
    });
    this.#recorder.start(1000);  // flush every second, so long runs stay safe
    this.#startedAt = performance.now();
    return { mimeType };
  }

  // Resolves once the encoder has flushed everything it holds.
  stop() {
    return new Promise((resolve, reject) => {
      const recorder = this.#recorder;
      if (!recorder || recorder.state === "inactive") {
        resolve(null);
        return;
      }
      recorder.addEventListener("stop", () => {
        const blob = new Blob(this.#chunks, { type: recorder.mimeType });
        this.#chunks = [];
        this.#recorder = null;
        resolve({ blob, mimeType: recorder.mimeType });
      }, { once: true });
      recorder.addEventListener("error", (event) => reject(event.error ?? new Error("Recording failed.")), { once: true });
      recorder.stop();
    });
  }
}

export const extensionFor = (mimeType) => (mimeType.includes("mp4") ? "mp4" : "webm");
