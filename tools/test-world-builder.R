#!/usr/bin/env Rscript
# The world builder, run against the model in local R: that what the
# editors draw is what the simulation's NetLogoR worlds hold, tile for
# patch, and that each kind of drawn edit changes what it should in the
# model's own calculations (and nothing else). The page's side of the same
# contract is tools/test-world-builder.mjs.
#
#   - the coordinate contract (tools/fixtures/spatial-contract.json): a
#     tile in row r and column c is the patch pxcor = c, pycor = H - 1 - r,
#     in the map's NetLogoR world (its land, density and area), in the
#     routing's matrices, in the page's tiles, for every household and
#     store, and on a store's floor; word of mouth on its own coarser
#     patches
#   - the world file's text: the starter worlds read back as written, and
#     every older world in tools/fixtures still reads with no problems;
#     the map editor's preview leaves the installed world as it was
#   - what drawn edits do: a road shortens trips along it; water can't be
#     crossed and a bridge can; denser homes hold more households in
#     proportion; an area's make-up is who lives on its tiles; a store
#     moved away from the homes reaches fewer of them; walls lengthen
#     walks and can cut places off, a plan with no door is refused; rack
#     tiles with floor beside them are rack space, at the store as well;
#     tills, fitting rooms and queues are counted, and staffing beyond
#     them is refused
#   - the starter worlds (the default world on each geography): they pass
#     the model's world check, run, and run the same twice
#
#   Rscript tools/test-world-builder.R
#
# Needs what tools/test-fashion.R needs: R with jsonlite, and NetLogoR
# installed into tools/.cache/rlib against the shims in tools/shims/.

script_path <- normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1]))
root <- normalizePath(file.path(dirname(script_path), ".."))
.libPaths(c(file.path(root, "tools", ".cache", "rlib"), .libPaths()))
suppressPackageStartupMessages(library(NetLogoR))
for (f in jsonlite::fromJSON(file.path(root, "model", "index.json"))$files) sys.source(file.path(root, "model", f), envir = globalenv())

failures <- 0L
check <- function(ok, what) {
  cat(if (isTRUE(ok)) "  ok   " else "  FAIL ", what, "\n", sep = "")
  if (!isTRUE(ok)) failures <<- failures + 1L
}

base <- world_read(file.path(root, "worlds", "default.world.json"))
contract <- jsonlite::fromJSON(file.path(root, "tools", "fixtures", "spatial-contract.json"), simplifyVector = FALSE)

# ---- Helpers -------------------------------------------------------------------------------------

chars_of <- function(rows) do.call(rbind, strsplit(unlist(rows), ""))
rows_of <- function(m) as.list(apply(m, 1, paste, collapse = ""))
blank <- function(W, H, ch = ".") matrix(ch, H, W)
block <- function(m, r, c, ch) { m[r + 1L, c + 1L] <- ch; m }        # 0-based rows and columns, as the editors number them
problem_text <- function(W) vapply(world_check(W), function(p) paste0(p$path, ": ", p$message), "")

# The default world on a map of its own: `tiles` (and `area_tiles`) as
# character matrices, row 1 the north edge; its 19 stores in the middle of
# the tiles `sites` (rows and columns, 0-based), in turn.
small_world <- function(tiles, area_tiles = blank(ncol(tiles), nrow(tiles)), areas = list(), sites, households = 3000, patch = 50) {
  W <- base
  W$macro$width <- ncol(tiles); W$macro$height <- nrow(tiles); W$macro$patch_m <- patch
  W$macro$households <- households; W$macro$wom_m <- 500
  W$macro$tiles <- rows_of(tiles); W$macro$area_tiles <- rows_of(area_tiles); W$macro$areas <- areas
  for (i in seq_along(W$stores)) {
    s <- sites[[1L + (i - 1L) %% length(sites)]]
    W$stores[[i]]$x <- (s[2] + 0.5) * patch; W$stores[[i]]$y <- (nrow(tiles) - s[1] - 0.5) * patch
  }
  W
}

# An area: its key, id, and make-up, from the default world's first area.
area <- function(key, id, budget, segment = NULL) {
  a <- base$macro$areas[[1]]
  a$key <- key; a$id <- id; a$name <- id; a$budget <- budget
  if (!is.null(segment)) a$segment_mix <- lapply(setNames(nm = names(a$segment_mix)), function(k) if (k == segment) 1 else 0)
  a
}

install <- function(W, seed = 1L) {
  pb <- world_check(W)
  if (length(pb)) stop("the world has problems: ", paste(vapply(pb, function(p) paste0(p$path, ": ", p$message), ""), collapse = "; "))
  world_install(W); P$pace <<- "season"; setup(seed)
  invisible(TRUE)
}

# Where each household lives, as the editors number tiles: row and column, 0-based.
hh_rc <- function() { ny <- city$ny; cbind(r = (mk$hh$tile - 1L) %% ny, c = (mk$hh$tile - 1L) %/% ny) }
in_block <- function(rc, r0, r1, c0, c1) rc[, "r"] >= r0 & rc[, "r"] <= r1 & rc[, "c"] >= c0 & rc[, "c"] <= c1

# ---- The coordinate contract, on the map ------------------------------------------------------------

cat("Drawn tiles and NetLogoR patches: the map\n")
install(base)
M <- base$macro; ny <- M$height; nx <- M$width; p <- M$patch_m
painted <- list(land = matrix(unname(MAP_CHARS[chars_of(M$tiles)]), ny),
                density = matrix(match(chars_of(M$tiles), as.character(1:9), nomatch = 0L), ny),
                area = matrix(match(chars_of(M$area_tiles), vapply(M$areas, `[[`, "", "key"), nomatch = 0L), ny))
cells <- contract$map$cells
ok_cells <- vapply(cells, function(k) {
  at <- cbind(pxcor = k$pxcor, pycor = k$pycor)
  all(vapply(names(painted), function(v) as.integer(of(world = MACRO$world, agents = at, var = v)) == painted[[v]][k$r + 1, k$c + 1] &&
                                         city_layer(v)[k$r + 1, k$c + 1] == painted[[v]][k$r + 1, k$c + 1], TRUE)) &&
    k$pxcor == k$c && k$pycor == ny - 1 - k$r &&
    floor(k$x / p) == k$pxcor && floor(k$y / p) == k$pycor &&                       # a point's patch, as store_area() finds it
    tile_of(k$x, k$y, p, ny) == k$c * ny + k$r + 1 &&                                # the routing's cell
    cellFromPxcorPycor(MACRO$world, k$pxcor, k$pycor) == k$r * nx + k$c + 1          # NetLogoR's own numbering: row by row from the top left
}, TRUE)
check(all(ok_cells) && contract$map$width == nx && contract$map$height == ny && contract$map$patch_m == p,
      sprintf("at the contract's %d tiles (the four corners among them), the tile in row r, column c is patch (c, %d - r) on all three layers, the routing's cell and NetLogoR's cell number agree, and its middle is at (c + 0.5, %d - r - 0.5) x %s m",
              length(cells), ny - 1, ny, json_number(p)))
order <- vapply(names(painted), function(v) identical(as.integer(of(world = MACRO$world, agents = patches(MACRO$world), var = v)), as.vector(t(painted[[v]]))), TRUE)
check(all(order), "NetLogoR gives the patches row by row from the north-west corner: of() over patches() is each painted layer transposed (as.vector(t(...))), as city_world() builds it")

# An asymmetric map: something different at each corner, on every layer.
odd <- blank(17, 11)
odd <- block(odd, 0, 0, "9"); odd <- block(odd, 0, 16, "~"); odd <- block(odd, 10, 0, "="); odd <- block(odd, 10, 16, "p"); odd <- block(odd, 4, 11, "s")
odd <- block(odd, 2:6, 2:6, "3")
oa <- blank(17, 11); oa <- block(oa, 0, 0, "a"); oa <- block(oa, 10, 0, "b"); oa <- block(oa, 2:6, 2:6, "a")
Wodd <- small_world(odd, oa, list(area("a", "north", 400), area("b", "south", 600)), sites = list(c(8, 8)), households = 500)
install(Wodd)
at <- function(c, r) cbind(pxcor = c, pycor = 10 - r)
lv <- function(v, c, r) as.integer(of(world = MACRO$world, agents = at(c, r), var = v))
check(lv("land", 0, 0) == LAND[["homes"]] && lv("density", 0, 0) == 9L && lv("area", 0, 0) == 1L &&
        lv("land", 16, 0) == LAND[["water"]] && lv("land", 0, 10) == LAND[["road"]] && lv("area", 0, 10) == 2L &&
        lv("land", 16, 10) == LAND[["park"]] && lv("land", 11, 4) == LAND[["shops"]] &&
        as.integer(of(world = MACRO$world, agents = cbind(pxcor = 0, pycor = 0), var = "land")) == LAND[["road"]],
      "on a 17 x 11 map with a different tile at each corner: patch (0, 10) is the north-west tile (homes 9, area a), (16, 10) the north-east (water), (0, 0) the south-west (road, area b), (16, 0) the south-east (park)")

# Every household and store, on the default world: where it is, its patch, its tile, its area.
install(base)
rc <- hh_rc()
xy_rc <- cbind(r = ny - 1 - floor(mk$hh$y / p), c = floor(mk$hh$x / p))
here <- patchHere(MACRO$world, mk$hh$agents)
check(identical(unname(rc[, "r"]), as.integer(xy_rc[, "r"])) && identical(unname(rc[, "c"]), as.integer(xy_rc[, "c"])) &&
        all(here[, "pxcor"] == rc[, "c"]) && all(here[, "pycor"] == ny - 1 - rc[, "r"]) &&
        all(painted$land[cbind(rc[, "r"] + 1, rc[, "c"] + 1)] == LAND[["homes"]]) && identical(mk$hh$area, painted$area[cbind(rc[, "r"] + 1, rc[, "c"] + 1)]),
      sprintf("all %s households: the tile their x and y fall in is the patch their turtle stands on, a home tile, and their area is the area painted there",
              format(mk$hh$n, big.mark = ",")))
srow <- ny - 1 - floor(STORES$y / p); scol <- floor(STORES$x / p)
check(all(city$store_tile == scol * ny + srow + 1) && identical(STORES$area, painted$area[cbind(srow + 1, scol + 1)]) && all(painted$land[cbind(srow + 1, scol + 1)] != LAND[["water"]]),
      sprintf("all %d stores: x and y in metres fall in the tile the routing starts their trips from, on land, and their area is the area painted under them", N_STORES))
# Word of mouth: its own NetLogoR world over the map, with patches wom_m across.
wn <- dim(mk$wom)
check(wn[2] == ceiling(MACRO$width_m / MACRO$wom_m) && wn[1] == ceiling(MACRO$height_m / MACRO$wom_m) &&
        all(mk$wom_at[, "pxcor"] == floor(mk$hh$x / MACRO$wom_m)) && all(mk$wom_at[, "pycor"] == floor(mk$hh$y / MACRO$wom_m)),
      sprintf("word of mouth keeps its own %d x %d patches of %s m, and each household reads the one its home falls in", wn[2], wn[1], json_number(MACRO$wom_m)))

# ---- The coordinate contract, on a floor ----------------------------------------------------------

cat("Drawn tiles and NetLogoR patches: a floor\n")
fc <- contract$floor
plan <- build_plan(PLANS[["flagship"]])
H <- plan$H
ok_floor <- vapply(fc$cells, function(k) as.numeric(of(world = plan$world, agents = cbind(pxcor = k$pxcor, pycor = k$pycor))) == floor_codes(plan$chars[k$r + 1, k$c + 1]) &&
                     k$pxcor == k$c && k$pycor == H - 1 - k$r && floor(k$x / CELL_M) == k$c && floor(k$y / CELL_M) == H - 1 - k$r, TRUE)
ch_at <- function(xy) plan$chars[cbind(H - xy[, 2], xy[, 1] + 1)]
on_path <- plan$open[cbind(H - plan$path_xy[, 2], plan$path_xy[, 1] + 1)] | plan$chars[cbind(H - plan$path_xy[, 2], plan$path_xy[, 1] + 1)] == "F"
check(all(ok_floor) && plan$W == fc$width && H == fc$height &&
        all(ch_at(plan$anchor_xy[plan$doors, , drop = FALSE]) == "=") && all(ch_at(plan$cashier_xy) == "c") && all(ch_at(plan$cubicle_in) == "F") &&
        ch_at(plan$fr_slots[1, , drop = FALSE]) == "W" && ch_at(plan$till_slots[1, , drop = FALSE]) == "Q" && all(on_path),
      sprintf("the Flagship's floor world: the contract's %d tiles are their patches with their codes; its doors, cashiers, cubicles and queue heads are read at the tiles painted so; and every one of its %s walking steps is on open floor (or into a cubicle)",
              length(fc$cells), format(nrow(plan$path_xy), big.mark = ",")))

# ---- The world file's text, and the preview -----------------------------------------------------

cat("The world file, and the preview\n")
starters <- jsonlite::fromJSON(file.path(root, "worlds", "geographies", "index.json"))$geographies
same_text <- vapply(starters, function(id) {
  path <- file.path(root, "tools", "fixtures", "geographies", paste0(id, ".world.json"))
  text <- paste0(paste(readLines(path, warn = FALSE), collapse = "\n"), "\n")
  identical(world_text(world_parse(text)), text)
}, TRUE)
check(all(same_text), sprintf("the starter worlds (%s) read back as written, text for text: the page's world_text and the model's agree", paste(starters, collapse = ", ")))
old <- c(file.path("v1-world", "default.world.json"), "v2-default.world.json", "v5-default.world.json", "v6-default.world.json", "v7-default.world.json", "v8-default.world.json")
old_ok <- vapply(old, function(f) {
  W <- world_resolve(world_upgrade(world_parse(paste(readLines(file.path(root, "tools", "fixtures", f), warn = FALSE), collapse = "\n"))), file.path(root, "layouts"))
  !length(world_check(W))
}, TRUE)
check(all(old_ok), sprintf("every older world in tools/fixtures (%d files, versions 1 to 8) still upgrades and reads with no problems", length(old)))
# The map editor's preview of a changed draft leaves the installed world alone.
install(base)
before <- list(world = world_text(WORLD), land = city_layer("land"), routes = city$fields$time, hh = mk$hh$tile, stores = STORES)
draft <- base; draft$macro$tiles <- rows_of(block(chars_of(draft$macro$tiles), 0:30, 0:30, "~")); draft$stores[[1]]$x <- 100; draft$stores[[1]]$y <- 100
pv <- macro_preview(draft)
check(!length(pv$problems) && identical(world_text(WORLD), before$world) && identical(city_layer("land"), before$land) &&
        identical(city$fields$time, before$routes) && identical(mk$hh$tile, before$hh) && identical(STORES, before$stores),
      "the map editor's preview of a draft (a lake painted, a store moved) leaves the installed world, its map, routes, households and stores exactly as they were")

# ---- What drawn edits do ------------------------------------------------------------------------------

cat("What drawn edits do\n")
# A strip of open land: homes in the west, the stores' block in the east.
strip <- blank(60, 20)
strip <- block(strip, 8:11, 2:6, "5"); strip <- block(strip, 8:11, 53:57, "s")
sites <- lapply(0:18, function(i) c(8 + i %/% 5, 53 + i %% 5))

# Roads.
install(small_world(strip, sites = sites))
slow <- list(t = mean(mk$drive_s[, 1]), km = mean(mk$km[, 1]))
road <- block(strip, 12, 0:59, "=")
install(small_world(road, sites = sites))
fast <- list(t = mean(mk$drive_s[, 1]), km = mean(mk$km[, 1]))
r1 <- grid_routes(city$fields, mk$hh$tile[1], 1L)
on_road <- mean(city_layer("land")[r1$cells] == LAND[["road"]])
check(fast$t < 0.6 * slow$t && fast$km >= slow$km - 1e-9 && on_road > 0.75,
      sprintf("a road painted from the homes to the stores: the trip to a store falls from %.0f s to %.0f s on average (%.2f to %.2f km, a little further but at %s m/s, not %s), and a household's route runs %.0f%% of its tiles on the road",
              slow$t, fast$t, slow$km, fast$km, json_number(MACRO$road_mps), json_number(MACRO$local_mps), 100 * on_road))

# Water and bridges.
river <- block(road, 0:19, 30, "~")
pv <- macro_preview(small_world(river, sites = sites))
bridged <- block(river, 12, 30, "+")
Wb <- small_world(bridged, sites = sites)
pv2 <- macro_preview(Wb)
install(Wb)
rb <- grid_routes(city$fields, mk$hh$tile[1], 1L)
land <- city_layer("land")
crosses <- (30 * city$ny + 12 + 1) %in% rb$cells
wet <- Wb; wet$stores[[2]]$x <- (30 + 0.5) * 50; wet$stores[[2]]$y <- (20 - 5 - 0.5) * 50
check(pv$stranded == 3000 && all(pv$reach == 0) && pv2$stranded == 0 && all(pv2$reach == 3000) && crosses && !any(land[rb$cells] == LAND[["water"]]) &&
        land[13, 31] == LAND[["bridge"]] && macro_speed(land, MACRO$road_mps, MACRO$local_mps)[13, 31] == MACRO$road_mps &&
        any(grepl("^stores\\[2\\]: stands on water$", problem_text(wet))),
      sprintf("a river painted across the road leaves all %s households with no store in reach; one bridge tile on the road reaches them all again, every route crossing at the bridge (at road speed) and none through water; a store put on the river is refused",
              format(pv$households, big.mark = ",")))

# Density.
two <- blank(40, 20); two <- block(two, 5:14, 5:14, "2"); two <- block(two, 5:14, 25:34, "8")
mid <- lapply(0:18, function(i) c(i, 20))
install(small_world(two, sites = mid, households = 5000))
share <- mean(in_block(hh_rc(), 5, 14, 25, 34))
even <- block(two, 5:14, 25:34, "2")
install(small_world(even, sites = mid, households = 5000))
share2 <- mean(in_block(hh_rc(), 5, 14, 25, 34))
check(abs(share - 0.8) < 0.02 && abs(share2 - 0.5) < 0.03,
      sprintf("two blocks of 100 home tiles, density 2 and 8: %.1f%% of the households live in the dense one (8 / (2 + 8) = 80%%); painted density 2, %.1f%% (50%%)", 100 * share, 100 * share2))

# Areas.
at2 <- blank(40, 20); at2 <- block(at2, 5:14, 5:14, "a"); at2 <- block(at2, 5:14, 25:34, "b")
segs <- vapply(base$segments, `[[`, "", "id")
areas2 <- list(area("a", "west", 300, segs[1]), area("b", "east", 900, segs[2]))
install(small_world(two, at2, areas2, sites = mid, households = 5000))
rc2 <- hh_rc(); A <- in_block(rc2, 5, 14, 5, 14); B <- in_block(rc2, 5, 14, 25, 34)
ratio <- mean(mk$hh$budget[B] / SEGMENTS$budget[mk$hh$segment[B]]) / mean(mk$hh$budget[A] / SEGMENTS$budget[mk$hh$segment[A]])
seg_a <- all(mk$hh$segment[A] == 1L) && all(mk$hh$segment[B] == 2L) && all(mk$hh$area[A] == 1L) && all(mk$hh$area[B] == 2L)
half <- block(at2, 5:14, 25:29, "a")
install(small_world(two, half, areas2, sites = mid, households = 5000))
rc3 <- hh_rc(); moved <- in_block(rc3, 5, 14, 25, 29)
check(seg_a && abs(ratio - 3) < 0.15 && all(mk$hh$segment[moved] == 1L) && all(mk$hh$area[moved] == 1L) && abs(mean(mk$hh$segment == 1L) - (sum(A) + sum(moved)) / mk$hh$n) < 1e-12,
      sprintf("two areas, all %s and all %s, budgets $300 and $900: every household on each area's tiles is its segment, with %.2f times the budget (3); half the east block repainted west makes its %s households %s",
              SEGMENTS$name[1], SEGMENTS$name[2], ratio, format(sum(moved), big.mark = ","), SEGMENTS$name[1]))

# A store moved.
pv_here <- macro_preview(base)
away <- base
far <- which(chars_of(base$macro$tiles) == ".", arr.ind = TRUE)
far <- far[order(-far[, 2], -far[, 1])[1], ]                    # the open tile furthest east (then south)
away$stores[[1]]$x <- (far[2] - 1 + 0.5) * 50; away$stores[[1]]$y <- (120 - far[1] + 0.5) * 50
pv_away <- macro_preview(away)
install(base); km_here <- mean(mk$km[, 1])
install(away); km_away <- mean(mk$km[, 1])
check(pv_away$reach[1] < pv_here$reach[1] && km_away > km_here && identical(pv_away$reach[-1], pv_here$reach[-1]) && STORES$area[1] == painted$area[far[1], far[2]],
      sprintf("%s dragged from its district to the map's east edge (row %d, column %d): the households with it in reach fall from %s to %s, their average trip to it grows from %.1f to %.1f km, every other store's reach is unchanged, and its area is the one painted where it now stands",
              base$stores[[1]]$name, far[1] - 1, far[2] - 1, format(round(pv_here$reach[1]), big.mark = ","), format(round(pv_away$reach[1]), big.mark = ","), km_here, km_away))

# Walls and doors.
TEST_PLAN <- c(
  "####################",
  "#XXX#DDDDDD#FF#FF###",
  "#XXX#......#FF#FF###",
  "##x##......#....W..#",
  "#..........#.www...#",
  "#..................#",
  "#TTTT......$$$.....#",
  "#..........:c:.....#",
  "#..........:::.Qqq.#",
  "#..................#",
  "#########==#########")
keys <- c("D", "T"); nm <- c("Denim", "Tops")
pl <- build_plan(TEST_PLAN, keys, nm)
# The door's side of the floor meets the till's only above the counter and
# below it (row 6 and row 10, column 12): a wall in the first gap sends the
# walk round by the second; walls in both cut the till off.
walk <- function(pl) pl$walk_m[pl$entrance, pl$till]
wall <- TEST_PLAN; substr(wall[6], 12, 12) <- "#"
pl2 <- build_plan(wall, keys, nm)
shut <- wall; substr(shut[10], 12, 12) <- "#"
nodoor <- TEST_PLAN; substr(nodoor[11], 10, 11) <- "##"
check(walk(pl2) > walk(pl) + 1 && any(grepl("can't be walked to", vapply(layout_problems(shut, keys, nm), `[[`, "", "message"))) &&
        any(vapply(layout_problems(nodoor, keys, nm), `[[`, "", "message") == "no door (=)"),
      sprintf("a wall tile drawn in the gap above the counter lengthens the walk from the door to where the till's customer pays from %.1f m to %.1f m (round by the gap below); walling that gap too cuts the till off, which is refused, and so is a plan with no door", walk(pl), walk(pl2)))

# Racks.
summary_of <- function(rows) layout_report(rows, keys, nm)$summary
more <- TEST_PLAN; substr(more[10], 2, 7) <- "DDDDDD"           # a new row out on the floor, by the front wall
deep <- TEST_PLAN; substr(deep[3], 6, 11) <- "DDDDDD"           # a row in front of the first: the first now has no floor beside it
s0 <- summary_of(TEST_PLAN); s1 <- summary_of(more); s2 <- summary_of(deep)
check(s0$faces[1] == 6 && s1$racks[1] == 12 && s1$faces[1] == 12 && s2$racks[1] == 12 && s2$faces[1] == 6 && s1$space > s0$space && s2$space == s0$space,
      sprintf("racks: a second row of denim out on the floor doubles denim's faces (6 to 12; rack space %.3f to %.3f a standard store); painted instead in front of the first, it hides it: 12 rack tiles, still 6 faces, no more space", s0$space, s1$space))
Wr <- base
sm <- match("small", vapply(Wr$layouts, `[[`, "", "id"))
rows <- unlist(Wr$layouts[[sm]]$rows); ch <- chars_of(rows)
dk <- which(ch == "D", arr.ind = TRUE)
grow <- dk[1, ]; spots <- which(ch == "." & (row(ch) == grow[1] + 1 | row(ch) == grow[1] - 1) & abs(col(ch) - grow[2]) <= 3, arr.ind = TRUE)
install(base)
s_small <- which(STORES$format == sm)[1]; kD <- match("D", FIXTURES)
space0 <- STORE_SPACE[s_small, kD]; faces0 <- LAYOUT_FACES[sm, kD]
ch2 <- ch; ch2[spots[1, , drop = FALSE]] <- "D"
Wr$layouts[[sm]]$rows <- as.list(apply(ch2, 1, paste, collapse = ""))
if (!length(world_check(Wr))) { world_install(Wr); space1 <- STORE_SPACE[s_small, kD]; faces1 <- LAYOUT_FACES[sm, kD] } else { space1 <- NA; faces1 <- NA }
check(isTRUE(faces1 > faces0) && isTRUE(abs(space1 / space0 - faces1 / faces0) < 1e-9),
      sprintf("a denim rack tile painted onto the Small layout: its denim faces go from %d to %s, and so does the denim space of %s, which runs it (%.3f to %.3f a standard store)",
              as.integer(faces0), format(faces1), STORES$name[s_small], space0, space1))

# Fitting rooms, tills and queues.
till2 <- TEST_PLAN; substr(till2[6], 16, 18) <- "$::"; substr(till2[7], 16, 18) <- "$c:"; substr(till2[8], 16, 18) <- "$::"     # the editor's till unit, as it stamps it
one_cub <- TEST_PLAN; substr(one_cub[2], 15, 15) <- "F"; substr(one_cub[3], 15, 15) <- "F"
longq <- TEST_PLAN; substr(longq[9], 15, 19) <- "Qqqqq"
loose <- TEST_PLAN; substr(loose[6], 19, 19) <- "q"
twohead <- TEST_PLAN; substr(twohead[6], 17, 17) <- "Q"
r_t <- summary_of(till2); r_c <- summary_of(one_cub); r_q <- summary_of(longq)
msgs <- function(rows) vapply(layout_problems(rows, keys, nm), `[[`, "", "message")
check(s0$tills == 1 && r_t$tills == 2 && !length(layout_problems(till2, keys, nm)) && s0$cubicles == 2 && r_c$cubicles == 1 && s0$till_places == 3 && r_q$till_places == 5 &&
        nrow(build_plan(longq, keys, nm)$till_slots) == 5 && any(grepl("not joined to its head", msgs(loose))) && any(grepl("needs one head \\(Q\\); there are 2", msgs(twohead))),
      "a till unit stamped beside the first makes 2 tills, read with no problems; the wall between two cubicles erased makes them 1; the till queue drawn two places longer has 5 places, not 3, in order from its head; a queue tile not joined to its head, or a second head, is refused")
Ws <- base
si <- which(vapply(Ws$stores, `[[`, "", "layout") == "small")[1]
Ws$stores[[si]]$staff$cashiers <- 3
staff_msg <- problem_text(Ws)
ch3 <- chars_of(unlist(Ws$layouts[[sm]]$rows)); cash <- which(ch3 == "c")
ch3[cash[2]] <- ":"
Ws2 <- base; Ws2$layouts[[sm]]$rows <- as.list(apply(ch3, 1, paste, collapse = "")); Ws2$stores[[si]]$staff$cashiers <- 2
world_install(Ws2 <- if (length(world_check(Ws2))) Ws2 else Ws2)
check(any(grepl(sprintf("^stores\\[%d\\]\\.staff\\.cashiers: Small has 2 tills$", si), staff_msg)) &&
        any(grepl(sprintf("^stores\\[%d\\]\\.staff\\.cashiers: Small has 1 tills$", si), problem_text(Ws2))),
      sprintf("staffing beyond what the plan has is refused: %s can't open 3 tills on the Small layout's 2, nor 2 once a cashier's place is erased", base$stores[[si]]$name))
Wq <- base; ch4 <- chars_of(unlist(Wq$layouts[[sm]]$rows)); ch4[cash[2]] <- ":"
Wq$layouts[[sm]]$rows <- as.list(apply(ch4, 1, paste, collapse = ""))
for (i in which(vapply(Wq$stores, `[[`, "", "layout") == "small")) Wq$stores[[i]]$staff$cashiers <- 1
world_install(Wq); fl <- build_floors()
check(fl$n_tills[sm] == 1L && fl$n_tills[match("standard", FORMATS)] == 3L,
      "and the simulation's floors open the tills painted: the Small layout with a cashier's place erased has 1 till where shoppers pay, the Standard still 3")

# ---- The starter worlds --------------------------------------------------------------------------------

cat("The starter worlds\n")
for (id in starters) {
  path <- file.path(root, "tools", "fixtures", "geographies", paste0(id, ".world.json"))
  W <- world_read(path, file.path(root, "layouts"))
  pb <- world_check(W)
  ran <- FALSE; same <- FALSE; facts <- ""
  if (!length(pb)) {
    world_install(W); P$pace <- "season"; setup(1)
    for (i in 1:3) { advance(Inf); finish_day() }
    sales <- tally$sales; visits <- apply(tally$visits, 3, sum)[seq_len(N_STORES)]
    rc <- hh_rc(); land <- city_layer("land")
    on_homes <- all(land[cbind(rc[, "r"] + 1, rc[, "c"] + 1)] == LAND[["homes"]])
    ran <- sum(sales) > 0 && sum(visits > 0) >= N_STORES - 2 && on_homes
    facts <- sprintf("%d x %d tiles, %s households on its home tiles, %d of %d stores visited, $%s sold in 3 days", MACRO$nx, MACRO$ny,
                     format(mk$hh$n, big.mark = ","), sum(visits > 0), N_STORES, format(round(sum(sales)), big.mark = ","))
    setup(1); for (i in 1:3) { advance(Inf); finish_day() }
    same <- identical(tally$sales, sales)
  }
  check(!length(pb) && ran && same, sprintf("the default world on %s passes the model's world check and runs: %s; the same seed runs the same days again%s", id, facts,
                                           if (length(pb)) paste0(" (", pb[[1]]$path, ": ", pb[[1]]$message, ")") else ""))
}

cat(if (failures) sprintf("\n%d check(s) failed.\n", failures) else "\nAll checks passed.\n")
quit(status = if (failures) 1L else 0L)
