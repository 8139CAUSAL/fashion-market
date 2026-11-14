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
in headless Chromium against the running app).

## Phase 3: Make the macro world easy to create

- [ ] 3.1 Land, water, roads, bridges, parks, shops and homes easy to identify and paint.
- [ ] 3.2 Road-over-water bridge transformation preserved.
- [ ] 3.3 Residential density understandable without tile codes.
- [ ] 3.4 Rapid creation of named areas with brushes and fill.
- [ ] 3.5 Each area visually connected to its demographics, segment mix, size mix and budget.
- [ ] 3.6 Area definitions preserved when editing geography.
- [ ] 3.7 Choosing, placing and dragging stores simplified.
- [ ] 3.8 Real stores distinguishable from decorative shops tiles.
- [ ] 3.9 Store-location validation and undo preserved.
- [ ] 3.10 Routing and household-allocation semantics preserved.
- [ ] 3.11 Which land types influence agents, and which only appearance, described.
- [ ] 3.12 Canvas prominent, area and store controls accessible.

## Phase 4: Make store interiors easy to draw

- [ ] 4.1 Shared drawing interface applied to floor plans.
- [ ] 4.2 0.5 m patch resolution preserved.
- [ ] 4.3 Understandable controls for floor, walls, doors, stockroom and stockroom doors.
- [ ] 4.4 Category racks easy to paint and recognise.
- [ ] 4.5 Fitting-room and till stamps preserved.
- [ ] 4.6 Complete stamp footprint previewed.
- [ ] 4.7 Stamp rotation and keyboard controls preserved.
- [ ] 4.8 Queue drawing rules preserved.
- [ ] 4.9 Fixture labels and cues without character codes.
- [ ] 4.10 Large brushes, erasing and block moves trigger the existing validation.
- [ ] 4.11 Validation errors visible at the affected cells.
- [ ] 4.12 Fixture accessibility, rack faces, cashier places, fitting rooms and walking routes preserved.

## Phase 5: Make the world builder a product feature

Templates
- [ ] 5.1 Blank and Default macro starting points.
- [ ] 5.2 At least two more editable starting geographies.
- [ ] 5.3 Runnable starters validated with the model's own world checks.
- [ ] 5.4 A blank draft says what it still needs before it can run.
- [ ] 5.5 Unrelated settings never replaced, draft edits never discarded silently.
- [ ] 5.6 Interior prefabs and the blank shell easy to discover.
- [ ] 5.7 Import/export round-trip fidelity preserved.

Guided user journey
- [ ] 5.8 Three stages: Draw your world → Define your market → Run the simulation.
- [ ] 5.9 Stage 1 connects macro and micro editing without duplicating geometry state.
- [ ] 5.10 Stage 2 surfaces the population, segment, brand, incentive, loyalty, online and return controls.
- [ ] 5.11 Stage 3 connects to world validation, Setup and the simulation controls.
- [ ] 5.12 Full access to the detailed Setup sections and reporting tabs preserved.
- [ ] 5.13 Clear navigation between stages, none forced.
- [ ] 5.14 Canvas-first layout, responsive behaviour, accessibility, contextual guidance.

## Phase 6: Verify the NetLogoR spatial contract

- [ ] 6.1 `pxcor = column`, `pycor = height - 1 - row`.
- [ ] 6.2 NetLogoR patch ordering and the `as.vector(t(...))` transformations.
- [ ] 6.3 All macro layers: land, density, area.
- [ ] 6.4 Store x/y in metres against patch positions.
- [ ] 6.5 Floor-cell coordinates and their NetLogoR representation.
- [ ] 6.6 The word-of-mouth patch world keeps its behaviour.
- [ ] 6.7 Canonical world schema and serialised values intact.
- [ ] 6.8 Import/export and saved-world compatibility.
- [ ] 6.9 Draft edits do not change the installed simulation before Setup.
- [ ] 6.10 No webR calls per painted cell or per pointer movement.
- [ ] 6.11 Road changes → routing.
- [ ] 6.12 Water and bridges → traversability.
- [ ] 6.13 Residential density → household placement probabilities.
- [ ] 6.14 Area membership → demographic assignments.
- [ ] 6.15 Store relocation → accessibility and reach.
- [ ] 6.16 Interior walls and doors → feasible movement.
- [ ] 6.17 Rack edits → rack capacity and access.
- [ ] 6.18 Fitting-room, till and queue edits → their constraints.

## Phase 7: Previews, interaction testing, and regression

- [ ] 7.1 Debounced R-backed macro previews preserved.
- [ ] 7.2 Debounced layout validation and summary preserved.
- [ ] 7.3 Stale preview results never overwrite a newer draft's.
- [ ] 7.4 Household distribution, store reach and stranded households displayed.
- [ ] 7.5 Accessibility, capacity, walking distances and validation issues displayed for interiors.
- [ ] 7.6 Draft changes, calculated previews and the installed world visibly distinguished.
- [~] 7.7 JS tests: brush footprints, interpolation, boundaries, fill, erasing, layer isolation (written with Phase 2).
- [~] 7.8 History tests: one undo per drag, with the owner's state (written with Phase 2).
- [~] 7.9 Zoom/pan invariance, load/reload/resize, pointer cancellation (written with Phase 2).
- [ ] 7.10 Coordinate and serialisation contract tests.
- [ ] 7.11 R-model integration tests of real spatial consequences.
- [ ] 7.12 `npm test` and `Rscript tools/test-fashion.R`.
- [ ] 7.13 Failures and skipped checks recorded with reasons.
- [ ] 7.14 Scenario A: geography → neighbourhoods and roads → stores → validate.
- [ ] 7.15 Scenario B: layout → walls and racks → fixtures and queues → validate.
- [ ] 7.16 Scenario C: install → run → agents on the drawn geography and floors.
- [ ] 7.17 Scenario D: modify the default world → preview → install → rerun.
- [ ] 7.18 Painting, panning, zooming, selecting and placing with pointer and touch.
- [ ] 7.19 Household generation, shopper movement, transport, store choice, interior movement.
- [ ] 7.20 Staffing, queues, inventory, replenishment, pricing, promotions, loyalty, offers, returns, online.
- [ ] 7.21 P&L rollups, accounting consistency, reporting.
- [ ] 7.22 ARIMA forecasts and intervals.
- [ ] 7.23 Determinism for unchanged worlds and seeds.
- [ ] 7.24 World and layout persistence, import/export, backward compatibility.

## Phase 8: Final acceptance and reporting

- [ ] 8.1 Geography editing no longer feels like painting tiny pixels.
- [ ] 8.2 Multi-patch brushes make large-scale editing fast and accurate.
- [ ] 8.3 Roads, neighbourhoods, stores and interiors can be created intuitively.
- [ ] 8.4 Drawn cells correspond to the correct NetLogoR patches.
- [ ] 8.5 Spatial edits affect the correct simulation behaviour.
- [ ] 8.6 Model-derived previews explain meaningful consequences.
- [ ] 8.7 New users can discover the workflow; advanced capabilities remain.
- [ ] 8.8 Economics, reporting, forecasts and saved worlds remain compatible.
- [ ] 8.9 Automated and manual checks substantiate the implementation.
