// Where things are, in 3D: the one transformation between the
// simulation's coordinates and the Three.js scenes of the 3D views
// (market-3d.js, store-3d.js). Every position the 3D views draw goes
// through these functions, so the 3D world is the NetLogoR world, placed
// exactly where the 2D views (city-view.js, floor-view.js) draw it.
//
// Three.js: Y is up, east is +X and north is −Z. A simulation point
// (x east, y north of the south-west corner) is X = x, Z = −y, and Y is the
// height it's drawn at.
//
// The map (model/city.R, tools/fixtures/spatial-contract.json): painted
// rows run from the north edge, row 0 first; the tile in row r, column c
// is the NetLogoR patch pxcor = c, pycor = ny − 1 − r, and its middle is
// x = (c + 0.5) p, y = (ny − r − 0.5) p metres, p the patch size. Outdoor
// agents (frame_pack()'s travellers, the households, the stores) are in
// metres. So the tile's middle is X = (c + 0.5) p, Z = −(ny − r − 0.5) p.
//
// A floor (model/floors.R): cells of cell_m (0.5) metres, rows from the
// north edge; the cell in row r, column c is the patch pxcor = c,
// pycor = H − 1 − r. Floor agents (frame_pack()'s shoppers and staff) and
// the plan's fixtures (plan_geometry(): tills, doors, labels) are in patch
// units, a patch's middle at whole numbers, so an agent at (x, y) stands at
// X = (x + 0.5) cell_m, Z = −(y + 0.5) cell_m metres, and the cell in row r,
// column c has its middle at X = (c + 0.5) cell_m, Z = −(H − r − 0.5) cell_m.
// The floor's scene is in metres, the same as the map's.

// ---- The map ---------------------------------------------------------------------------

// The map's size, from city_geometry(): patch (metres), nx, ny (tiles).
export function macroFrame(geo) {
  return { patch: geo.patch, nx: geo.nx, ny: geo.ny, width: geo.nx * geo.patch, depth: geo.ny * geo.patch };
}

// A point in metres (x east, y north) → scene X, Z.
export const macroToScene = (x, y) => ({ X: x, Z: -y });
// ... and back.
export const sceneToMacro = (X, Z) => ({ x: X, y: -Z });

// The middle of the tile in row r (from the north edge), column c.
export function macroTileCentre(m, r, c) {
  return { X: (c + 0.5) * m.patch, Z: -(m.ny - r - 0.5) * m.patch };
}

// The tile a scene point falls in (as tileAt() in world-store.js does for metres).
export function macroTileAt(m, X, Z) {
  return { r: m.ny - 1 - Math.floor(-Z / m.patch), c: Math.floor(X / m.patch) };
}

// city_geometry() sends the tiles row by row from the top left (land,
// density, area) ...
export const rowMajorTile = (m, i) => ({ r: Math.floor(i / m.nx), c: i % m.nx });
// ... and a facility's or venue's tiles 0-based, column-major (col * ny + row).
export const colMajorTile = (m, t) => ({ r: t % m.ny, c: Math.floor(t / m.ny) });

// Where CityView draws a point in metres, in canvas pixels at `k` pixels per
// metre (its toPx()): for checking that the 3D and 2D views agree.
export const cityViewPx = (geo, x, y, k) => [x * k, (geo.height - y) * k];
// A scene point, in the same pixels: the 2D view's picture of the 3D scene's ground.
export const sceneToCityViewPx = (geo, X, Z, k) => [X * k, (geo.height + Z) * k];

// ---- A floor ---------------------------------------------------------------------------

// A floor's size, from plan_geometry(): width, height (cells), cell_m.
export function floorFrame(plan) {
  return { cell: plan.cell_m, W: plan.width, H: plan.height, width: plan.width * plan.cell_m, depth: plan.height * plan.cell_m };
}

// An agent or fixture at patch coordinates (x, y) → scene X, Z (metres).
export function floorToScene(f, x, y) {
  return { X: (x + 0.5) * f.cell, Z: -(y + 0.5) * f.cell };
}
// ... and back, as the 2D view reads a click (FloorView's #cellAt()).
export function sceneToFloor(f, X, Z) {
  return { x: X / f.cell - 0.5, y: -Z / f.cell - 0.5 };
}

// The middle of the cell in row r (from the north edge), column c.
export function floorCellCentre(f, r, c) {
  return { X: (c + 0.5) * f.cell, Z: -(f.H - r - 0.5) * f.cell };
}

// A block of cells as plan_geometry() gives a cubicle's: [x, y, w, h], its
// bottom-left patch and size in cells → its edges in the scene.
export function floorBox(f, [x, y, w, h]) {
  return { X0: x * f.cell, X1: (x + w) * f.cell, Z0: -(y + h) * f.cell, Z1: -y * f.cell };
}

// Where FloorView draws an agent, in canvas pixels at `c` pixels per cell
// (its X() and Y()).
export const floorViewPx = (plan, x, y, c) => [(x + 0.5) * c, (plan.height - 0.5 - y) * c];
// A scene point, in the same pixels.
export const sceneToFloorViewPx = (plan, X, Z, c) => [(X / plan.cell_m) * c, (plan.height + Z / plan.cell_m) * c];
