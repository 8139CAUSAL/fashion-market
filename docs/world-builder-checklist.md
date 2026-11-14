# World Builder: implementation checklist

Objective: make drawing exterior geographies and interior retail spaces a
signature Fashion Market feature, with every edited logical cell correctly
connected to the existing NetLogoR simulation.

Status: `[ ]` TODO · `[~]` STARTED · `[x]` FINISHED (implemented and verified
against its acceptance criteria) · `[!]` BLOCKED (with the reason).

## Phase 1: Repository audit and baseline

- [x] 1.1 Read the drawing, world-state, worker, R-model, UI, stylesheet, prefab and test files.
- [x] 1.2 Verified the existing tools and interactions (by reading `grid-editor.js` and by driving them in headless Chromium).
- [x] 1.3 Verified the spatial defaults (below).
- [x] 1.4 Traced the macro path: edit → draft → preview → Setup → NetLogoR → simulation (below).
- [x] 1.5 Traced the micro path: layout checks, floor-world creation, shopper movement (below).
- [x] 1.6 Identified which painted features affect agents and which are decorative (below).
- [x] 1.7 Ran the baseline tests before modifying code (below).
- [x] 1.8 Inspected the drawing UI at 1440 × 900 and at a 390 × 844 touch viewport.
- [x] 1.9 Technical/UX audit and scope (below).

### Audit

**Existing behaviour (before this work).** `GridEditor` (`js/fashion/grid-editor.js`) is the one canvas both
editors share: a `Uint16Array` of character codes per layer, pencil / rectangle / line / fill / eraser /
eyedropper / select-and-move / pan, the owner's path tool (queues) and stamp tool (cubicle, till), a
100-step snapshot history that carries the owner's state (stores, areas, staff), canvas resize, zoom
(Ctrl/Cmd-wheel, buttons, keys) and pan. Strokes were already interpolated cell by cell (`lineCells`), and a
drag was already one undo step. What was missing: the pencil painted one cell (at the default map's fit, 5.1
screen px), there was no brush size, no footprint preview, no one-click way between "see it all" and "cells
big enough to paint", the toolbar was unlabelled icons (the line tool's icon did not render), a
`pointercancel` finished the stroke instead of dropping it, a second pointer joined the stroke in hand, a
press that the owner took (a store) was not captured, and the view could be panned off the grid.

**Spatial defaults.** Default world (`worlds/default.world.json`, version 10): 160 × 120 tiles of 50 m
(8 × 6 km), 24,000 households, road 10 m/s, off-road 4 m/s, word of mouth 500 m. Limits (`model/city.R`,
`model/params.R`): 8 to 600 tiles a side, at most 60,000 tiles, 5 to 5,000 m a tile, at most 40 areas and
60,000 households. Map tiles: `.` open land, `=` road, `+` bridge, `~` water, `p` park, `s` shops, `1` to
`9` homes by density; the area layer holds an area's key or `.`. Floors (`model/floors.R`): 0.5 m a tile
(`CELL_M`), 5 × 5 to 120 × 80 tiles; `.` floor, `#` wall, `=` door, `X`/`x` stockroom and its door, a
category's key for its racks, `F` cubicle, `W`/`w` and `Q`/`q` queue heads and lines, `$` counter, `c`
cashier, `:` behind the counter.

**Macro path.** A finished stroke → `MapEditor.#stroked()` writes `macro.tiles` / `macro.area_tiles` into the
draft (`WorldStore.edit`, kept in `localStorage`) → after 350 ms one `PREVIEW_MACRO` request → the worker
writes the draft to R's filesystem and calls `world_preview_file()` → `macro_preview()` places the households
and routes every trip the way Setup would. Nothing reaches the running simulation until **Setup**:
`SETUP {world}` → `world_load_file()` → `world_check()` → `world_install()` → `macro_install()` builds the
NetLogoR world (`city_world()`: `createWorld()` per variable from `as.vector(t(matrix))`, stacked) →
`setup()` → `build_city()` (routes from `city_layer("land")`), `build_households()` (turtles on the patches)
→ `GEOMETRY` back to the page.

**Micro path.** A finished stroke → `LayoutEditor.#stroked()` writes the layout's `rows` into the draft (and
lowers the staff of stores that lost tills or cubicles) → after 300 ms one `CHECK_LAYOUT` → `layout_report()`
(`layout_scan()` for problems, `build_plan()` for the summary). At Setup `build_floors()` reads every layout
with `build_plan()`: a NetLogoR world of floor codes, the anchors shoppers and staff stand at, and the walking
distances and paths between them (`grid_fields()` on the open cells); shoppers then move along those paths
(`model/store.R`).

**What a painted tile does.** Affects agents: roads and bridges (crossed at road speed), water (impassable,
and no store may stand on it), homes (households are placed on home tiles in proportion to density), areas
(a household's segment, size and budget come from its area's make-up), every other land tile (crossed at
off-road speed), store positions (routes, reach, each store's area). Appearance only: park and shops look
different and are crossed like open land. On a floor, everything is read by the model except the stockroom
(`X`) and behind-the-counter (`:`) tiles, which are looks only; a rack tile with no floor beside it holds
nothing.

**Baseline tests** (before any change; R 4.3.3 from apt, NetLogoR 1.0.6 taken from the app's own
`vfs/netlogor-lib` image because this environment's network policy blocks CRAN):

| Command | Result |
|---|---|
| `node --test tools/test-sw.mjs` | 5 passed, 0 failed |
| `Rscript tools/test-shims.R` | 23 ok, 0 FAIL |
| `Rscript tools/test-fashion.R` | 113 ok, 0 FAIL, "All checks passed." (3 m 46 s) |
| `npm test` as shipped | stopped after the Node tests: `Rscript: not found` (R was not installed yet) |

**Baseline UI.** 1440 × 900: the 160 × 120 map fits at 5.1 px a tile, the Flagship floor at 10.6 px; the
canvas starts 480 px down the page. 390 × 844 touch viewport: the page is 580 px wide (the seven-button
section strip does not wrap, so the page scrolls sideways), the sticky header is 218 px tall, and the map
fits at 3.2 px a tile.

**Scope: the smallest cohesive set of changes.** (1) Extend `GridEditor`: brushes, footprint preview,
Overview / Draw, patch boundaries, pointer robustness, a labelled toolbar. (2) `MapEditor` and
`LayoutEditor`: palettes in words, real stores drawn apart from shops tiles, areas tied to their make-up,
problems shown on their cells, draft / preview / installed made visible. (3) Starting geographies and a
three-stage path through Setup. (4) Tests: the engine in Node, the spatial contract and its consequences in
R. No change to the world file, the `Uint16Array`, the worker's protocol or the model's rules.

## Phase 2: Fix the core patch-drawing experience

Scale and navigation
- [x] 2.1 One-click Overview / Draw control (toolbar; keys `0` and `1`).
- [x] 2.2 Overview fits the complete world into the canvas.
- [x] 2.3 Draw uses about 16 CSS px a patch (20 for a finger; never below 12).
- [x] 2.4 The editing location or the selected block is kept when switching.
- [x] 2.5 Patch boundaries at editing scale (every tenth line stronger).
- [x] 2.6 Crisp rendering, zoom, pan and the existing keyboard shortcuts kept.
- [x] 2.7 Zoom never changes the grid's dimensions or a patch's size.

Brush functionality
- [x] 2.8 Small (1), Medium (3 × 3) and Large (7 × 7) brushes.
- [x] 2.9 Brush sizes are logical patches.
- [x] 2.10 The complete footprint is previewed before painting.
- [x] 2.11 The full footprint is applied along interpolated strokes.
- [x] 2.12 No gaps in fast pointer movements.
- [x] 2.13 Footprints are clipped at the grid's edges.
- [x] 2.14 One completed drag is one undo.
- [x] 2.15 Erasing, the road-over-water transformation and active-layer isolation hold.
- [x] 2.16 The brush changes neither the stamp nor the queue tool.

Drawing controls
- [x] 2.17 Primary toolbar: Draw, Brush size, Fill, Erase, Place, Undo, Redo.
- [x] 2.18 Icons and readable labels.
- [x] 2.19 Rectangle, line, eyedropper, select/move, pan and the owner's tools in a visible second row.
- [x] 2.20 The material, action, layer and physical footprint are shown in words.
- [x] 2.21 Mouse, pen and touch (two fingers pan and zoom; no page scrolling over the canvas).
- [x] 2.22 Pointer cancellation, capture and interruption handled.

Acceptance gate: passed (41 Node tests in `tools/test-grid-editor.mjs`; 26 checks with real pointer events
in headless Chromium against the running app). Measured change: at 1440 × 900 the Overview of the default
map is 4.53 px a tile (the baseline was 5.1 on a taller canvas whose bottom fell below the window); the Draw
view is 16 px.

## Phase 3: Make the macro world easy to create

- [x] 3.1 Every ground tile named on the palette, with what it does in the model; a legend beside the map.
- [x] 3.2 The road-over-water bridge kept (a Bridge swatch paints roads); verified in the browser and in R.
- [x] 3.3 Homes as a ramp from sparse to dense, each with the households a tile of it holds on this map.
- [x] 3.4 New area hands over the large brush; a neighbourhood is two drags.
- [x] 3.5 The area being painted has its colour, households, budget, segment and size mix beside the map, and its name on it.
- [x] 3.6 Painting land leaves every area's definition and make-up untouched (browser check); a geography keeps them too (Node test).
- [x] 3.7 Place store in the toolbar; stores not on the map yet listed as chips; the next one is picked after each placement; pins dragged.
- [x] 3.8 Stores are pins in their brand's colour; shops tiles are said to be ground, not stores.
- [x] 3.9 A store on water is refused; undo puts a moved store back; a cancelled drag puts it back.
- [x] 3.10 No change to routing or household allocation (the R tests check both against drawn edits).
- [x] 3.11 Palette notes and the legend say which tiles shape the simulation and which are looks only.
- [x] 3.12 The canvas fills the window's height; on desktop the side cards scroll on their own, the layer's own card first.

Acceptance gate: passed, 27 of 27 browser checks (a neighbourhood in two drags, 413 → 3,559 households in that
block by the model's preview; a connected road network from four fast strokes; a bridge; an area with its
population set; a store placed, refused on water, dragged with its reach changing, undone).

## Phase 4: Make store interiors easy to draw

- [x] 4.1 The same toolbar, brushes and views on the floor plan.
- [x] 4.2 A tile is half a metre: the footprint, the size fields and the R floor contract say so.
- [x] 4.3 Floor, wall, door, stockroom and stockroom door by name, with what each does.
- [x] 4.4 Racks listed by category name, in its colour; each block named on the plan.
- [x] 4.5 Fitting room and till unit stamps kept (Fixtures, and Place in the toolbar).
- [x] 4.6 A fixture's whole footprint previewed and outlined before it's put down, its size in words.
- [x] 4.7 `[` and `]` turn it; a Turn button too.
- [x] 4.8 The queue tool kept: one head, a line joined to it, the old queue replaced; "Draw its queue" beside each queue's tiles.
- [x] 4.9 No character codes needed (the code is only in a tooltip).
- [x] 4.10 Large-brush strokes, erasing and block moves each trigger one layout check.
- [x] 4.11 Every problem's tiles outlined in red as soon as the model has read the plan; a click shows one problem's tiles and brings them into view.
- [x] 4.12 No change to floors.R; anchors, faces, cashier places, cubicles and walking paths checked in R.

Acceptance gate: passed, 25 of 25 browser checks (a store built from the blank shell passes the model's own
check; a wall that hides racks is shown on its tiles and fixed with the eraser; staff follow the tills, and
undo brings them back).

## Phase 5: Make the world builder a product feature

Templates
- [x] 5.1 Blank and Default city.
- [x] 5.2 River town (120 × 90) and Harbour bay (140 × 100), drawn by `tools/build-geographies.mjs`.
- [x] 5.3 Both pass the model's world check in the browser (CHECK_WORLD) and in R, and run (R: 3 days, every store visited).
- [x] 5.4 Blank: the map says 19 stores aren't on the map yet; Check and run lists "no home tiles" and every store.
- [x] 5.5 A geography changes the map only, after asking, and undo restores it text for text; Import asks before dropping draft changes.
- [x] 5.6 A new layout starts from a blank shell or any prefab, shown as pictures.
- [x] 5.7 Export → the model reads it back → the same text (browser); starter worlds round-trip in R.

Guided user journey
- [x] 5.8 Three stages on one strip: Draw your world → Define your market → Run the simulation.
- [x] 5.9 Macro and Micro world are stage 1; a store's "Draw its floor plan" opens its layout; one draft, no copy.
- [x] 5.10 Stage 2 points to population, segments, brands, promotions, offers, loyalty, online and returns, with a way back.
- [x] 5.11 Check and run: the model's world check, then Setup, Go and Step.
- [x] 5.12 All eight sections and every report tab as before.
- [x] 5.13 Every section one click away; Next and Back under each; none forced.
- [x] 5.14 Draw your world in the header; canvas-first; phones: no sideways scroll, the stages scroll away, undo/redo/view on the canvas; labels and ARIA roles throughout.

Acceptance gate: passed, 21 of 21 browser checks, and 7 of 7 at 390 × 844 with touch input.

## Phase 6: Verify the NetLogoR spatial contract

All in `tools/test-world-builder.R` (model side) and `tools/test-world-builder.mjs` (page side), against
`tools/fixtures/spatial-contract.json`, unless said.

- [x] 6.1 `pxcor = column`, `pycor = height - 1 - row`, at the contract's tiles (the four corners among them).
- [x] 6.2 `of()` over `patches()` is each painted layer `as.vector(t(...))`; `cellFromPxcorPycor` is row by row from the north-west.
- [x] 6.3 Land, density and area, at each tile, in the routing's matrices and on an asymmetric 17 × 11 map.
- [x] 6.4 Every store's x/y falls in the tile its trips start from, on land, in the area painted under it.
- [x] 6.5 The Flagship's floor world: tiles to patches with their codes; doors, cashiers, cubicles, queue heads; every walking step on open floor.
- [x] 6.6 Word of mouth keeps its own coarser patches; each household reads the one its home is in.
- [x] 6.7 The world file's schema and text are unchanged; starter worlds read back as written.
- [x] 6.8 Every older world in tools/fixtures (versions 1 to 8) still reads; the browser's saved draft survives a reload text for text.
- [x] 6.9 The preview leaves the installed world alone (R); with edits waiting, the running model is still the old world (browser).
- [x] 6.10 Strokes send nothing to R while drawing; one preview after they pause (browser: 100 pointer moves, 0 messages during).
- [x] 6.11 A road from homes to stores: 621 s → 316 s average trip, 87% of a route on the road.
- [x] 6.12 A river cuts off all 3,000 households; one bridge tile reconnects them all, every route through it; a store on water refused.
- [x] 6.13 Density 2 and 8 blocks: 80.4% in the dense one (expected 80%); both at 2: 48.0% (50%).
- [x] 6.14 Each area's households are its segment; budgets 2.96× for 3× the area budget; a repainted half changes 2,044 households.
- [x] 6.15 A store moved to the map's edge: reach 22,393 → 15,287, average route 3.7 → 6.9 km, other stores unchanged.
- [x] 6.16 A wall lengthens the walk to a till 3.7 → 5.7 m; walling the other gap cuts it off (refused); no door refused.
- [x] 6.17 A new rack row doubles faces and space; a row in front hides the first (no more space); at the store, STORE_SPACE follows faces.
- [x] 6.18 Tills (and the simulation's open tills), cubicles, queue places, detached or double queue heads, and staffing beyond the tills refused.

## Phase 7: Previews, interaction testing, and regression

- [x] 7.1 The map's preview is still debounced (350 ms), one request after strokes pause.
- [x] 7.2 The layout check is still debounced (300 ms).
- [x] 7.3 Each preview and check carries the draft's revision; an older answer is dropped. Verified on the map with an answer held back 2.5 s; the floor check uses the same guard (not separately timed).
- [x] 7.4 Households (in areas and outside), stores in reach per store and per tile, households with none outlined.
- [x] 7.5 Floor area, doors, fitting rooms, tills, rack space, faces, places to stand, longest walk, fetch time, queue places, problems on their tiles.
- [x] 7.6 Draft / Preview (or Check) / Installed chips under both canvases.
- [x] 7.7 Brush footprints, interpolation, edges, fill, erase, layer isolation (`tools/test-grid-editor.mjs`).
- [x] 7.8 One undo per drag, the owner's state with it (stores, areas, staff).
- [x] 7.9 Zoom/pan invariance, load/reload/resize, pointer cancellation, a second pointer, two fingers.
- [x] 7.10 The coordinate contract fixture, both sides; world text round trips.
- [x] 7.11 R tests of real spatial consequences (6.11–6.18) and the starter worlds run.
- [x] 7.12 `npm test`: exit 0 (Node 59 passed; shims 23 ok; test-fashion 113 ok; test-world-builder 23 ok).
- [x] 7.13 Nothing skipped. Environment notes below.
- [x] 7.14 Scenario A (browser): River town → a neighbourhood and street → a new store → Check and run: ready.
- [x] 7.15 Scenario B: a blank shell → walls, stockroom, 7 categories' racks, fitting rooms, a till, both queues → the model's check passes.
- [x] 7.16 Scenario C: installed (the map and floor tile for tile); 3,000+ driving positions all on land; 300+ shopper positions all on the drawn floor's open tiles; 50 visits counted by the model.
- [x] 7.17 Scenario D: a lake round a store → preview reach 22,393 → 33 → installed: the model agrees (33) → a day runs.
- [x] 7.18 Pointer (Phases 2–5) and touch (one finger draws, two pinch and pan, taps place a store).
- [x] 7.19–7.22 Covered by `tools/test-fashion.R`, unchanged and passing (households, movement, trips, choice, floors, staffing, queues, stock, prices, promotions, loyalty, offers, returns, online, ledger and P&L, reports, forecast).
- [x] 7.23 Same seed, same season (test-fashion), and the starter worlds run the same twice.
- [x] 7.24 Draft persistence across reload; world and layout export/import; older files upgrade.

Environment notes: CRAN and webr.r-wasm.org are blocked by this environment's network policy. R 4.3.3 came
from Ubuntu's packages; NetLogoR 1.0.6 was copied out of the app's own `vfs/netlogor-lib` image (it's plain R);
the browser checks served webR 0.6.0 from its npm package in place of the CDN. Headless Chromium drops the
click of the first tap after a synthetic (CDP) multi-touch sequence; the touch check taps once to clear it, and
the canvas's own Undo/Redo act on a finger's release so they don't depend on that click.

## Phase 8: Final acceptance and reporting

- [x] 8.1 Brushes of 3 × 3 and 7 × 7 tiles and a 16 px Draw view (20 for a finger); one click back to the Overview.
- [x] 8.2 A 7 × 57 tile neighbourhood in one drag; a 247-tile road in two pointer moves with no gaps.
- [x] 8.3 Scenarios A and B, by pointer, from a geography and a blank shell.
- [x] 8.4 Phase 6.1–6.5, tile for tile, on both sides of the contract.
- [x] 8.5 Phase 6.11–6.18 and Scenarios C and D.
- [x] 8.6 The preview's numbers are the model's own, and agree with the installed model (Scenario D).
- [x] 8.7 Draw your world in the header, three stages; every section and tool still there.
- [x] 8.8 test-fashion's 113 checks pass unchanged; older worlds read; the world file's format is unchanged.
- [x] 8.9 The tests above, and the browser checks listed in the report.
