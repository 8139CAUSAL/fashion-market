// Paints simulation frames onto world canvases.
//
// A frame arrives from the engine worker as one transferred ArrayBuffer
// (layout documented in r/workbench.R): a short header, then one section
// per view with patch values as float32, turtles as blocked float32 columns,
// and RGB colour tables. Anything unchanged since a view's previous frame is
// left out and carried over here — a static city map crosses once, not
// sixty times a second. Nothing allocates per turtle, so painting keeps up
// with the simulation.

const FRAME_HEADER_BYTES = 12;
const SECTION_HEADER_BYTES = 56;

const FLAG_PATCHES = 1;
const FLAG_TURTLE_COLOURS = 2;
const FLAG_PATCH_COLOURS = 4;
const FLAG_CATEGORICAL = 8;
const FLAG_MISSING = 16;
const FLAG_TURTLE_SHAPES = 32;

const SHAPE_ARROW = 0;
const SHAPE_DOT = 1;
const SHAPE_SQUARE = 2;

// Patch palettes for continuous values, low value first. Viridis is the
// default: perceptually even, and readable on a dark stage. (A view whose
// patches are categories uses its own colours instead; see r/workbench.R.)
export const PALETTES = {
  viridis: [
    [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
    [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
  ],
  gray: [[12, 14, 18], [255, 255, 255]],
  heat: [[9, 6, 24], [96, 19, 69], [173, 45, 66], [227, 101, 30], [246, 176, 27], [252, 253, 191]],
};

function buildPaletteLut(stops) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(stops.length - 1, lo + 1);
    const f = t - lo;
    for (let c = 0; c < 3; c++) {
      lut[i * 3 + c] = stops[lo][c] + (stops[hi][c] - stops[lo][c]) * f;
    }
  }
  return lut;
}

// The set of views a frame was packed for (see SET_VIEWS), read without
// parsing the rest.
export const frameVersion = (buffer) => new DataView(buffer).getInt32(8, true);

// Splits a frame into its views. `previous` holds each view's last frame,
// in the same order, to carry over what this one left out.
export function parseFrame(buffer, previous = []) {
  const data = new DataView(buffer);
  const frame = {
    ticks: data.getInt32(0, true),
    version: data.getInt32(8, true),
    views: [],
  };
  let offset = FRAME_HEADER_BYTES;
  for (let i = 0; i < data.getInt32(4, true); i++) {
    const section = parseSection(buffer, offset, previous[i]);
    frame.views.push(section);
    offset += section.bytes;
  }
  return frame;
}

function parseSection(buffer, start, previous) {
  const view = new DataView(buffer, start);
  const int = (i) => view.getInt32(i * 4, true);
  const float = (i) => view.getFloat32(40 + i * 4, true);

  const frame = {
    bytes: int(0),
    turtleCount: int(1),
    width: int(2),
    height: int(3),
    turtleColourCount: int(5),
    flags: int(6),
    shape: int(7),
    patchColourCount: int(8),
    patchMin: float(0),
    patchMax: float(1),
    minPxcor: float(2),
    minPycor: float(3),
  };
  frame.categorical = Boolean(frame.flags & FLAG_CATEGORICAL);
  // The view's world doesn't exist (yet): nothing to draw.
  frame.missing = Boolean(frame.flags & FLAG_MISSING);
  if (frame.missing) return frame;

  let offset = start + SECTION_HEADER_BYTES;
  const patchCount = frame.width * frame.height;
  if (frame.flags & FLAG_PATCHES) {
    frame.patches = new Float32Array(buffer, offset, patchCount);
    offset += patchCount * 4;
  } else {
    frame.patches = previous?.patches;
  }

  // Five columns per turtle, and a sixth when turtles have shapes of their
  // own.
  frame.turtleShapes = null;
  if (frame.turtleCount > 0) {
    const columns = frame.flags & FLAG_TURTLE_SHAPES ? 6 : 5;
    frame.turtles = new Float32Array(buffer, offset, frame.turtleCount * columns);
    offset += frame.turtleCount * columns * 4;
    if (columns === 6) frame.turtleShapes = frame.turtles.subarray(frame.turtleCount * 5);
  }

  if (frame.flags & FLAG_TURTLE_COLOURS) {
    frame.turtleColours = new Uint8Array(buffer, offset, frame.turtleColourCount * 3);
    offset += frame.turtleColourCount * 3;
  } else {
    frame.turtleColours = previous?.turtleColours;
  }

  frame.patchColours = frame.flags & FLAG_PATCH_COLOURS
    ? new Uint8Array(buffer, offset, frame.patchColourCount * 3)
    : (frame.categorical ? previous?.patchColours : null);

  return frame;
}

export class WorldRenderer {
  #canvas;
  #ctx;
  #paletteName = "viridis";
  #lut = buildPaletteLut(PALETTES.viridis);
  #patchCanvas = new OffscreenCanvas(1, 1);
  #patchCtx = this.#patchCanvas.getContext("2d");
  #patchImage = null;
  // What the patch image was last built from; unchanged inputs skip the
  // per-patch colouring and only the blit remains.
  #patchSource = { patches: null, lut: null, colours: null, min: 0, max: 0 };
  frame = null;

  constructor(canvas) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d", { alpha: false });
  }

  setFrame(frame) {
    this.frame = frame;
  }

  // Drops the current frame so a rebuild starts from an empty stage.
  clear() {
    this.frame = null;
    this.#patchImage = null;
    this.#patchSource = { patches: null, lut: null, colours: null, min: 0, max: 0 };
  }

  // The continuous palette is drawn here, not in R, so switching it repaints
  // the frame already on screen without touching the model.
  setPalette(name) {
    const stops = PALETTES[name];
    if (!stops || name === this.#paletteName) return;
    this.#paletteName = name;
    this.#lut = buildPaletteLut(stops);
    this.paint();
  }

  paint() {
    const frame = this.frame;
    const { width: cw, height: ch } = this.#canvas;
    if (!frame || cw === 0) return;

    this.#paintPatches(frame, cw, ch);
    if (frame.turtleCount > 0) this.#paintTurtles(frame, cw / frame.width, ch / frame.height);
  }

  // Patches are drawn into an image the size of the world in patches, then
  // scaled up in one nearest-neighbour blit.
  #paintPatches(frame, cw, ch) {
    const { patches, width, height, patchMin, patchMax } = frame;
    if (!patches) return;

    const source = this.#patchSource;
    const colours = frame.categorical ? frame.patchColours : null;
    const stale = !this.#patchImage || source.patches !== patches || source.lut !== this.#lut ||
      source.colours !== colours || source.min !== patchMin || source.max !== patchMax;

    if (stale) {
      if (!this.#patchImage || this.#patchImage.width !== width || this.#patchImage.height !== height) {
        this.#patchCanvas.width = width;
        this.#patchCanvas.height = height;
        this.#patchImage = this.#patchCtx.createImageData(width, height);
      }
      if (colours) this.#colourCategories(patches, colours);
      else this.#colourContinuous(patches, patchMin, patchMax);
      this.#patchCtx.putImageData(this.#patchImage, 0, 0);
      this.#patchSource = { patches, lut: this.#lut, colours, min: patchMin, max: patchMax };
    }

    this.#ctx.imageSmoothingEnabled = false;
    this.#ctx.drawImage(this.#patchCanvas, 0, 0, cw, ch);
  }

  #colourContinuous(patches, min, max) {
    const pixels = this.#patchImage.data;
    const span = max - min;
    const scale = span > 0 ? 255 / span : 0;
    const lut = this.#lut;
    for (let i = 0, p = 0; i < patches.length; i++, p += 4) {
      const value = patches[i];
      const index = (Number.isFinite(value) ? Math.round((value - min) * scale) : 0) * 3;
      pixels[p] = lut[index];
      pixels[p + 1] = lut[index + 1];
      pixels[p + 2] = lut[index + 2];
      pixels[p + 3] = 255;
    }
  }

  // patch_colors: patch value 0 takes the first colour, 1 the second, ...
  #colourCategories(patches, colours) {
    const pixels = this.#patchImage.data;
    const last = colours.length / 3 - 1;
    for (let i = 0, p = 0; i < patches.length; i++, p += 4) {
      const value = patches[i];
      const index = (Number.isFinite(value) ? Math.min(last, Math.max(0, Math.round(value))) : 0) * 3;
      pixels[p] = colours[index];
      pixels[p + 1] = colours[index + 1];
      pixels[p + 2] = colours[index + 2];
      pixels[p + 3] = 255;
    }
  }

  // Turtles are drawn in their own shape, else the view's — arrowheads
  // pointing along their heading (0 = north, clockwise, as in NetLogo), dots
  // or squares — batched into one path per colour and shape. Batches are
  // drawn in the order of their first turtle, so turtles made later (stores
  // after shoppers, say) draw on top.
  #paintTurtles(frame, scaleX, scaleY) {
    const ctx = this.#ctx;
    const { turtles, turtleCount, turtleColours, turtleShapes, minPxcor, minPycor, height, shape: viewShape } = frame;
    const shapeOf = turtleShapes ? (i) => turtleShapes[i] : () => viewShape;
    const originY = minPycor + height - 0.5;
    const radius = 0.45 * Math.min(scaleX, scaleY);

    const xs = turtles.subarray(0, turtleCount);
    const ys = turtles.subarray(turtleCount, turtleCount * 2);
    const headings = turtles.subarray(turtleCount * 2, turtleCount * 3);
    const sizes = turtles.subarray(turtleCount * 3, turtleCount * 4);
    const colourIndex = turtles.subarray(turtleCount * 4, turtleCount * 5);

    ctx.lineJoin = "round";
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";

    // Each batch (colour and shape) in the order of its first turtle.
    const first = new Map();
    for (let i = 0; i < turtleCount; i++) {
      const batch = colourIndex[i] * 3 + shapeOf(i);
      if (!first.has(batch)) first.set(batch, i);
    }
    const batches = [...first.keys()].sort((a, b) => first.get(a) - first.get(b));

    for (const batch of batches) {
      const c = Math.floor(batch / 3);
      const shape = batch % 3;
      let path = null;
      for (let i = first.get(batch); i < turtleCount; i++) {
        if (colourIndex[i] !== c || shapeOf(i) !== shape) continue;
        path ??= new Path2D();

        const cx = (xs[i] - minPxcor + 0.5) * scaleX;
        const cy = (originY - ys[i]) * scaleY;
        const r = radius * sizes[i];

        if (shape === SHAPE_DOT) {
          path.moveTo(cx + 0.8 * r, cy);
          path.arc(cx, cy, 0.8 * r, 0, 2 * Math.PI);
        } else if (shape === SHAPE_SQUARE) {
          path.rect(cx - 0.75 * r, cy - 0.75 * r, 1.5 * r, 1.5 * r);
        } else {
          const angle = (headings[i] * Math.PI) / 180;
          // Forward points along the heading; right is 90° clockwise from it.
          const fx = Math.sin(angle) * r;
          const fy = -Math.cos(angle) * r;
          const rx = -fy;
          const ry = fx;
          path.moveTo(cx + fx, cy + fy);                        // nose
          path.lineTo(cx - 0.75 * fx + 0.7 * rx, cy - 0.75 * fy + 0.7 * ry);
          path.lineTo(cx - 0.35 * fx, cy - 0.35 * fy);          // tail notch
          path.lineTo(cx - 0.75 * fx - 0.7 * rx, cy - 0.75 * fy - 0.7 * ry);
          path.closePath();
        }
      }
      if (!path) continue;
      ctx.fillStyle = turtleColours
        ? `rgb(${turtleColours[c * 3]},${turtleColours[c * 3 + 1]},${turtleColours[c * 3 + 2]})`
        : "#ffffff";
      ctx.fill(path);
      if (shape !== SHAPE_ARROW) ctx.stroke(path);
    }
  }
}
