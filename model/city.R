# The macro world: the market. A map painted in tiles (land, roads, water,
# parks, shops, and homes at a density from 1 to 9), optional named areas
# painted on a layer of their own, the households who live on the home
# tiles, and the fastest route from every tile to every store.
#
# Tiles, one character each, row 1 the north edge. Each says what the
# ground is, and so who can cross it (transport.R has the table: cars and
# people move on separate networks read from these tiles):
#   .  open land (walkable)       ~  water (no one)        p  park (walkable)
#   w  woodland (no one)          #  building or barrier (no one)
#   1 to 9  homes, by density: households are placed on home tiles in
#           proportion to it; their local streets carry cars and people
#   =  street (cars, and people on its sidewalks)   +  road bridge (both)
#   H  highway (cars only)        x  highway crossing (cars, and people across)
#   d  driveway or service road (cars at local speed, and people)
#   -  footpath or trail (people only)   f  footbridge (people only)
#   s  pedestrian street or plaza (people only)
#   P  surface parking lot, G  parking garage: parking only where the end
#      user has made the tiles a facility (macro.parking), entered by its
#      own vehicle entrances and left by its own pedestrian exits
#   m  enclosed mall building: crossed only through its venue's plan
# The area layer has an area's key (one character) on each of its tiles,
# "." elsewhere. Households take their segment, size and budget from the
# area they live in, or the map's default make-up outside every area.
#
# A driving trip follows the fastest route on the vehicle network, a walk
# the fastest on the pedestrian network (transport.R).
#
# What NetLogoR does here:
#   - The map is one NetLogoR world, a patch per tile. Its patches carry
#     three variables: land (the codes below), density (0 off home tiles)
#     and area (0 outside every area). macro_install() builds it from the
#     painted rows, with a createWorld() for each variable, stacked with
#     stackWorlds(). Patch (0, 0) is the south-west tile; NetLogoR numbers
#     the cells row by row from the top left.
#   - It is the map's only source: the routing's speed grid, the draws
#     that place the households, each store's area and the tiles sent to
#     the page are all read from it with of().
#   - The households are NetLogoR turtles on it, created with
#     createTurtles() where draw_homes() places them, with their segment
#     and size as turtle variables (turtlesOwn()). Each takes its area from
#     the patch it stands on (patchHere(), then of()). The vectors the
#     simulation reads (mk$hh) are copies read from the turtles with of().
#   - Word of mouth is a second NetLogoR world over the map, with patches
#     wom_m metres across and one buzz variable per brand. Each evening the
#     day's shopping moves it and diffuse() spreads it to the neighbouring
#     patches (market.R, end_day); each morning the households in the
#     market read the buzz on the patch they live on.
# The routes themselves (grid.R) are worked out on plain matrices, read
# from the map world.

MAP_CHARS <- c("." = 0L, "~" = 1L, p = 2L, s = 4L, "=" = 5L, "+" = 6L, setNames(rep(3L, 9), 1:9),
               w = 7L, "#" = 8L, "-" = 9L, f = 10L, H = 11L, x = 12L, d = 13L, P = 14L, G = 15L, m = 16L)
LAND <- c(open = 0L, water = 1L, park = 2L, homes = 3L, shops = 4L, road = 5L, bridge = 6L,
          woodland = 7L, building = 8L, footpath = 9L, footbridge = 10L, highway = 11L, crossing = 12L,
          driveway = 13L, lot = 14L, garage = 15L, mall = 16L)
CITY_SEED <- 20260925              # the households are drawn from this, whatever the season's seed
MAX_MAP_TILES <- 60000
MAX_AREAS <- 40
MAX_HOUSEHOLDS <- 60000

MACRO <- NULL; AREAS <- NULL; N_AREAS <- 0L; AREA_BINS <- 1L
AREA_SEG_MIX <- NULL; AREA_SIZE_MIX <- NULL

# ---- Reading a map ----------------------------------------------------------------

# The map's tiles as matrices: land code, density (0 off home tiles) and
# area (0 outside every area), from the text rows. Assumes a checked map.
macro_grids <- function(M) {
  ch <- do.call(rbind, strsplit(unlist(M$tiles), ""))
  land <- matrix(MAP_CHARS[ch], nrow(ch))
  density <- matrix(0L, nrow(ch), ncol(ch))
  home <- ch %in% as.character(1:9)
  density[home] <- as.integer(ch[home])
  keys <- vapply(M$areas, function(a) a$key, "")
  ak <- do.call(rbind, strsplit(unlist(M$area_tiles), ""))
  area <- matrix(match(ak, keys, nomatch = 0L), nrow(ak))
  list(land = land, density = density, area = area, ny = nrow(ch), nx = ncol(ch))
}

# How fast a car crosses each tile (m/s; 0: it can't): streets, bridges,
# highways and their crossings at road speed, homes' local streets and
# driveways at local speed, nothing else (transport.R).
macro_speed <- function(land, road_mps, local_mps) drive_speed(land, road_mps, local_mps)

# The tile a point (metres from the south-west corner) stands on, as a
# linear index into the map's matrices.
tile_of <- function(x, y, patch, ny) {
  (floor(x / patch)) * ny + (ny - floor(y / patch))
}

makeup_mix <- function(mk, ids) as.numeric(unlist(mk[ids]))

# ---- Checking a map ------------------------------------------------------------------

check_macro <- function(M, seg_ids, pb) {
  path <- "macro"
  if (!isTRUE(pb$keys(M, path, c("patch_m", "width", "height", "households", "road_mps", "local_mps", "walk_mps", "wom_m",
                                   "tiles", "areas", "area_tiles", "default_makeup", "parking", "venues")))) return(invisible())
  for (k in names(FIELDS$macro)) {
    f <- FIELDS$macro[[k]]
    if (identical(f$kind, "int")) pb$int(M[[k]], join_path(path, k), f$min, f$max) else pb$num(M[[k]], join_path(path, k), f$min, f$max)
  }
  ok_w <- isTRUE(pb$int(M$width, join_path(path, "width"), 8, 600))
  ok_h <- isTRUE(pb$int(M$height, join_path(path, "height"), 8, 600))
  if (ok_w && ok_h && M$width * M$height > MAX_MAP_TILES) {
    pb$add(path, sprintf("%d x %d is %s tiles; at most %s", M$width, M$height, json_number(M$width * M$height), json_number(MAX_MAP_TILES)))
    ok_w <- FALSE
  }
  # Areas, and the make-up of their households.
  keys <- character()
  if (isTRUE(pb$list_of(M$areas, join_path(path, "areas"), 0, MAX_AREAS))) {
    ap <- join_path(path, "areas")
    unique_ids(M$areas, ap, pb)
    for (i in seq_along(M$areas)) {
      a <- M$areas[[i]]; p <- item_path(ap, i)
      if (!isTRUE(pb$keys(a, p, c("key", "id", "name", "colour", "budget", "segment_mix", "size_mix")))) next
      if (!(is.character(a$key) && length(a$key) == 1L && nchar(a$key) == 1L && grepl("^[A-Za-z0-9]$", a$key))) {
        pb$add(join_path(p, "key"), "must be one letter or digit")
      } else if (a$key %in% keys) pb$add(join_path(p, "key"), sprintf("\"%s\" is used twice", a$key)) else keys <- c(keys, a$key)
      pb$str(a$name, join_path(p, "name")); pb$colour(a$colour, join_path(p, "colour"))
      check_makeup(a, p, seg_ids, pb)
    }
  }
  if (isTRUE(pb$keys(M$default_makeup, join_path(path, "default_makeup"), c("budget", "segment_mix", "size_mix")))) {
    check_makeup(M$default_makeup, join_path(path, "default_makeup"), seg_ids, pb)
  }
  if (!ok_w || !ok_h) return(invisible())
  # Word of mouth spreads from patch to patch with NetLogoR's diffuse(),
  # which needs its world at least two patches across each way.
  one <- function(x) is.numeric(x) && length(x) == 1L && is.finite(x)
  if (one(M$patch_m) && one(M$wom_m) && M$wom_m >= min(M$width, M$height) * M$patch_m) {
    pb$add(join_path(path, "wom_m"), sprintf("%s m reaches across the map's whole %s (%s m): word of mouth spreads from patch to patch, so it must reach less than the map's width and height",
                                             json_number(M$wom_m), if (M$height <= M$width) "height" else "width",
                                             json_number(min(M$width, M$height) * M$patch_m)))
  }
  homes <- check_grid(M$tiles, join_path(path, "tiles"), M$width, M$height, names(MAP_CHARS), "tile", pb)
  check_grid(M$area_tiles, join_path(path, "area_tiles"), M$width, M$height, c(".", keys), "area key", pb)
  if (!is.null(homes) && is.numeric(M$households) && M$households > 0 && !any(homes %in% as.character(1:9))) {
    pb$add(join_path(path, "tiles"), "no home tiles for the households to live on")
  }
}

check_makeup <- function(a, p, seg_ids, pb) {
  pb$num(a$budget, join_path(p, "budget"), FIELDS$area$budget$min, FIELDS$area$budget$max)
  for (what in c("segment_mix", "size_mix")) {
    keys <- if (what == "segment_mix") seg_ids else SIZES
    if (isTRUE(pb$per_key(a[[what]], join_path(p, what), keys, 0, 1))) {
      s <- sum(unlist(a[[what]][keys]))
      if (abs(s - 1) > 0.005) pb$add(join_path(p, what), sprintf("shares add up to %.1f%%, not 100%%", 100 * s))
    }
  }
}

# A painted layer: `height` rows of `width` characters from `allowed`.
# Returns its characters (NULL if it isn't a grid).
check_grid <- function(rows, path, width, height, allowed, what, pb) {
  if (!is.list(rows) || !all(vapply(rows, function(r) is.character(r) && length(r) == 1L, TRUE))) {
    pb$add(path, "must be a list of text rows"); return(NULL)
  }
  if (length(rows) != height) { pb$add(path, sprintf("has %d rows; the map is %d high", length(rows), height)); return(NULL) }
  w <- nchar(unlist(rows))
  bad_w <- which(w != width)
  if (length(bad_w)) {
    pb$add(path, sprintf("row %d is %d wide; the map is %d wide", bad_w[1], w[bad_w[1]], width)); return(NULL)
  }
  ch <- do.call(rbind, strsplit(unlist(rows), ""))
  bad <- which(matrix(!(ch %in% allowed), dim(ch)[1L]), arr.ind = TRUE)
  if (length(bad)) {
    b <- bad[seq_len(min(200, nrow(bad))), , drop = FALSE]
    pb$add(path, sprintf("%d tiles aren't a known %s (the first, \"%s\", at row %d, column %d)",
                         nrow(bad), what, ch[bad[1, , drop = FALSE]], bad[1, 1], bad[1, 2]), cbind(b[, 1] - 1L, b[, 2] - 1L))
  }
  ch
}

# Where a store stands. A store made in the micro world has no place until
# it's put on the map (the Macro world's Stores layer).
store_placed <- function(s) is.list(s) && !is.null(s[["x"]]) && !is.null(s[["y"]])

check_store_place <- function(s, p, M, pb) {
  if (is.list(s) && is.null(s[["x"]]) && is.null(s[["y"]])) return(pb$add(p, "not on the map yet: place it on the Macro world's Stores layer"))
  pb$num(s[["x"]], join_path(p, "x")); pb$num(s[["y"]], join_path(p, "y"))
  if (is.null(s[["x"]]) || is.null(s[["y"]])) return(pb$add(p, sprintf("has no %s: a place on the map needs both x and y", if (is.null(s[["x"]])) "x" else "y")))
  if (!is.list(M) || !is.numeric(M$patch_m) || !is.numeric(M$width) || !is.numeric(M$height)) return(invisible())
  if (!(is.numeric(s$x) && is.numeric(s$y) && length(s$x) == 1L && length(s$y) == 1L)) return(invisible())
  wm <- M$width * M$patch_m; hm <- M$height * M$patch_m
  if (s$x < 0 || s$x >= wm || s$y < 0 || s$y >= hm) return(pb$add(p, sprintf("stands off the map (%s, %s m)", json_number(s$x), json_number(s$y))))
  row <- M$height - floor(s$y / M$patch_m); col <- floor(s$x / M$patch_m) + 1
  if (is.list(M$tiles) && length(M$tiles) >= row && is.character(M$tiles[[row]]) && identical(substr(M$tiles[[row]], col, col), "~")) {
    pb$add(p, "stands on water", matrix(c(row - 1L, col - 1L), 1))
  }
}

# ---- Installing ---------------------------------------------------------------------

macro_install <- function(M) {
  g <- macro_grids(M)
  MACRO <<- list(patch_m = as.numeric(M$patch_m), nx = g$nx, ny = g$ny, width_m = g$nx * M$patch_m, height_m = g$ny * M$patch_m,
                 households = as.integer(M$households), road_mps = as.numeric(M$road_mps), local_mps = as.numeric(M$local_mps),
                 walk_mps = as.numeric(M$walk_mps), wom_m = as.numeric(M$wom_m),
                 world = city_world(g))
  ar <- M$areas
  AREAS <<- data.frame(key = vapply(ar, `[[`, "", "key"), id = vapply(ar, `[[`, "", "id"), name = vapply(ar, `[[`, "", "name"),
                       colour = vapply(ar, `[[`, "", "colour"), budget = vapply(ar, function(a) as.numeric(a$budget), 0),
                       stringsAsFactors = FALSE)
  N_AREAS <<- nrow(AREAS)
  AREA_BINS <<- N_AREAS + 1L                         # the last: households outside every area
  mk <- c(ar, list(M$default_makeup))
  AREA_SEG_MIX <<- matrix(vapply(mk, function(a) makeup_mix(a$segment_mix, SEGMENTS$id), numeric(N_SEGMENTS)), N_SEGMENTS)
  AREA_SIZE_MIX <<- matrix(vapply(mk, function(a) makeup_mix(a$size_mix, SIZES), numeric(N_SIZES)), N_SIZES)
  AREA_BUDGET <<- vapply(mk, function(a) as.numeric(a$budget), 0)
}

# The map as one NetLogoR world, a patch per tile, whose patches carry its
# land code, density and area: a createWorld() for each (filled row by row
# from the top left, so from the matrix transposed), stacked. Patch (0, 0)
# is the south-west tile.
city_world <- function(g) {
  layer <- function(m) createWorld(0, g$nx - 1, 0, g$ny - 1, data = as.vector(t(m)))
  stackWorlds(land = layer(g$land), density = layer(g$density), area = layer(g$area))
}

# A variable of the city world, read with of(), as a matrix with row 1 the
# north edge: how the routing (grid.R) and draw_homes() take the map. of()
# gives the patches in NetLogoR's cell order, row by row from the top left.
city_layer <- function(var, world = MACRO$world) {
  dm <- dim(world)
  matrix(as.integer(of(world = world, agents = patches(world), var = var)), dm[1L], dm[2L], byrow = TRUE)
}

# Each store's area (0: outside every area): the area of the patch it
# stands on.
store_area <- function(x, y) {
  p <- MACRO$patch_m
  as.integer(of(world = MACRO$world, agents = cbind(pxcor = floor(x / p), pycor = floor(y / p)), var = "area"))
}

area_bin <- function(area) ifelse_int(area > 0L, area, AREA_BINS)
area_names <- function() c(AREAS$name, "Outside every area")

# ---- Building the city ------------------------------------------------------------------

# The world's two networks (transport.R), from the land read off the
# city world: the fields toward every store entrance on foot and every
# parking facility by car. `store_tile` is the tile each store's pin is on.
build_city <- function() {
  m <- MACRO
  T <- build_transport(transport_graphs(city_layer("land")))
  T$store_tile <- tile_of(STORES$x, STORES$y, m$patch_m, m$ny)
  T
}

# Where households live and who they are: placed on home tiles in
# proportion to their density, each with a segment and a size from the
# make-up of its area (the last column: outside every area). The map
# editor's preview draws them the same way, from the same seed, so what it
# shows is who Setup will create.
draw_homes <- function(land, density, area, ny, patch, n, seg_mix, size_mix) {
  cells <- which(land == LAND[["homes"]])
  tile <- cells[sample.int(length(cells), n, replace = TRUE, prob = density[cells])]
  col <- (tile - 1L) %/% ny; row <- (tile - 1L) %% ny            # 0-based, row 0 at the north edge
  x <- (col + 0.5 + runif(n, -0.45, 0.45)) * patch
  y <- (ny - row - 0.5 + runif(n, -0.45, 0.45)) * patch
  a <- area[tile]
  bin <- ifelse_int(a > 0L, a, dim(seg_mix)[2L])
  segment <- integer(n); size <- integer(n)
  for (k in seq_len(dim(seg_mix)[2L])) {
    i <- which(bin == k)
    if (!length(i)) next
    segment[i] <- sample.int(dim(seg_mix)[1L], length(i), replace = TRUE, prob = seg_mix[, k])
    size[i] <- sample.int(N_SIZES, length(i), replace = TRUE, prob = size_mix[, k])
  }
  list(tile = tile, x = x, y = y, area = a, bin = bin, segment = segment, size = size)
}

# Households, with a budget from their area and segment and a taste for
# each brand. Drawn from CITY_SEED, so the season's seed never moves them.
#
# The households are NetLogoR turtles on the city world, created where
# draw_homes() places them, in patch coordinates (a patch's centre is a
# whole number: a home x metres from the west edge stands at
# x / patch_m - 0.5), with their segment and size as turtle variables.
# Each one's area is the area of the patch it stands on. The vectors kept
# here are read from the turtles and their patches with of(): copies, for
# speed (main.R), not a second source of truth.
build_households <- function() {
  with_seed(CITY_SEED + 1, {
    n <- MACRO$households
    p <- MACRO$patch_m; ny <- MACRO$ny
    world <- MACRO$world
    homes <- draw_homes(city_layer("land"), city_layer("density"), city_layer("area"), ny, p, n, AREA_SEG_MIX, AREA_SIZE_MIX)
    agents <- createTurtles(n = n, coords = cbind(homes$x / p - 0.5, homes$y / p - 0.5), heading = 0)
    agents <- turtlesOwn(agents, tVar = "segment", tVal = homes$segment)
    agents <- turtlesOwn(agents, tVar = "size", tVal = homes$size)

    here <- patchHere(world, agents)
    xy <- of(agents = agents, var = c("xcor", "ycor"))
    area <- as.integer(of(world = world, agents = here, var = "area"))
    bin <- area_bin(area)
    segment <- as.integer(of(agents = agents, var = "segment"))
    budget <- AREA_BUDGET[bin] * SEGMENTS$budget[segment] * rlnorm(n, -0.08, 0.4)
    taste <- matrix(gumbel(n * N_BRANDS), n) + BRAND_FIT[segment, , drop = FALSE]
    car <- runif(n) < SEGMENTS$car_share[segment]          # drawn last, so the draws before it are as they were
    list(
      n = n, agents = agents, x = (xy[, "xcor"] + 0.5) * p, y = (xy[, "ycor"] + 0.5) * p,
      tile = as.integer(here[, "pxcor"] * ny + ny - here[, "pycor"]),     # the patch, numbered as the routing numbers tiles (grid.R)
      area = area, bin = bin, segment = segment, size = as.integer(of(agents = agents, var = "size")),
      budget = budget, taste = taste, tier0 = initial_tiers(taste), car = car
    )
  })
}

# ---- Word of mouth ------------------------------------------------------------------------

# Word of mouth is a NetLogoR world of its own over the map: square patches
# wom_m metres across (the last row and column may reach past the map's
# edge), each with one variable per brand, named by the brand's id: its
# buzz, how the shopping of the households living there has gone at the
# brand lately. Every patch starts the season at 0.3. Each evening the
# day's shopping moves it, and diffuse() spreads it to the neighbouring
# patches (market.R, end_day); each morning the households in the market
# read the buzz on their own patch (market.R, start_day).
wom_world <- function() {
  layer <- createWorld(0, ceiling(MACRO$width_m / MACRO$wom_m) - 1, 0, ceiling(MACRO$height_m / MACRO$wom_m) - 1, data = 0.3)
  do.call(stackWorlds, setNames(rep(list(layer), N_BRANDS), BRANDS$id))
}

# The word-of-mouth patch under each point (metres from the south-west
# corner): pxcor and pycor, a row for each point (as patchHere() gives).
wom_patch <- function(world, x, y) patch(world = world, x = x / MACRO$wom_m - 0.5, y = y / MACRO$wom_m - 0.5, duplicate = TRUE, out = TRUE)

# Every household's trip to every store by its cheapest way there
# (transport.R, travel_costs): the generalized cost in utility, the mode,
# the facility it would park at, and the route's km.
trip_tables <- function(city, hh) travel_costs(hh$tile, hh$segment, hh$car, city)

# ---- The map editor's preview ----------------------------------------------------------------

# What a draft map would do, worked out the way Setup would: its households
# (how many, and how many can reach no store within their segment's radius
# by any way they have), how many households have each store in reach, the
# parking (each facility's spaces, the households that can drive to it, the
# stores within walking distance of it and the minutes' walk), each store's
# access (by car, through which facilities; on foot, how many households),
# everything the networks fail at (transport_warnings, with their tiles),
# and, tile by tile, the households living there and how many stores they
# can reach on average. The networks are kept between calls while the map,
# its parking and venues and where the stores stand stay the same, so
# painting areas or renaming a store is quick.
preview_cache <- list(key = "", T = NULL)

macro_preview <- function(W) {
  pb <- problem_list()
  seg_ids <- if (is.list(W$segments)) vapply(W$segments, function(s) if (is.character(s$id)) s$id else "", "") else character()
  check_macro(W$macro, seg_ids, pb)
  all_stores <- if (is.list(W$stores)) W$stores else list()
  placed <- vapply(all_stores, store_placed, TRUE)          # stores not on the map yet reach no one
  stores <- all_stores[placed]
  for (i in which(placed)) check_store_place(all_stores[[i]], item_path("stores", i), W$macro, pb)
  if (!pb$n()) check_transport(W, pb)
  radius <- vapply(W$segments, function(s) if (is.numeric(s$radius_km)) as.numeric(s$radius_km) else NA_real_, 0)
  if (pb$n() || anyNA(radius)) return(list(problems = pb$get()))
  M <- W$macro
  g <- macro_grids(M)
  ids <- vapply(stores, function(s) s$id, "")
  sx <- vapply(stores, function(s) as.numeric(s$x), 0); sy <- vapply(stores, function(s) as.numeric(s$y), 0)
  tabs <- transport_tables(M, ids, g$ny, g$nx)
  key <- world_text(list(M[c("patch_m", "tiles", "road_mps", "local_mps", "walk_mps", "parking", "venues")], ids, sx, sy))
  if (!identical(key, preview_cache$key)) {
    G <- transport_graphs(g$land, list(patch_m = M$patch_m, road_mps = M$road_mps, local_mps = M$local_mps, walk_mps = M$walk_mps),
                          tabs$fac, tabs$ven, cbind(sx, sy), ids)
    preview_cache <<- list(key = key, T = build_transport(G))
  }
  T <- preview_cache$T
  mix <- c(M$areas, list(M$default_makeup))
  seg_mix <- matrix(vapply(mix, function(a) makeup_mix(a$segment_mix, seg_ids), numeric(length(seg_ids))), length(seg_ids))
  size_mix <- matrix(vapply(mix, function(a) makeup_mix(a$size_mix, SIZES), numeric(N_SIZES)), N_SIZES)
  n <- as.integer(M$households)
  nb <- if (is.list(W$brands)) length(W$brands) else 0L
  car_share <- vapply(W$segments, function(s) as.numeric(s$car_share %||% 1), 0)
  kms <- vapply(W$segments, function(s) as.numeric(s$km), 0)
  # Who lives where, and who has a car: the draws build_households() makes, in its order.
  homes <- if (n > 0) with_seed(CITY_SEED + 1, {
    h <- draw_homes(g$land, g$density, g$area, g$ny, M$patch_m, n, seg_mix, size_mix)
    rlnorm(n); gumbel(n * nb)
    h$car <- runif(n) < car_share[h$segment]
    h
  }) else NULL
  w <- c(W$market[c("drive_w", "park_w", "walk_w", "max_walk_km", "grudge_w")])
  warn <- transport_warnings(T, g$land, if (is.null(homes)) integer() else homes$tile, tabs$fac, tabs$ven,
                             vapply(stores, function(s) text_of(s$name), ""), tabs$store_venue, w$max_walk_km)
  for (k in seq_along(warn)) if (startsWith(warn[[k]]$path, "stores[")) {          # numbered among all the world's stores
    j <- as.integer(sub("^stores\\[([0-9]+)\\].*", "\\1", warn[[k]]$path)); warn[[k]]$path <- item_path("stores", which(placed)[j])
  }
  reach_all <- function(r) { out <- rep(NA_real_, length(all_stores)); out[placed] <- r; I(out) }
  fac_out <- lapply(seq_len(nrow(tabs$fac)), function(k) list(id = tabs$fac$id[k], name = tabs$fac$name[k], kind = tabs$fac$kind[k],
    spaces = tabs$fac$spaces[k], most = parking_max_spaces(tabs$fac$kind[k], length(tabs$fac$tiles[[k]]), tabs$fac$levels[k], M$patch_m),
    entrances = length(T$approach[[k]]), exits = length(T$exits[[k]]),
    stores = I(which(T$fw_m[k, ] <= w$max_walk_km * 1000)), walk_min = I(round(T$fw_t[k, ] / 60, 1)), households = 0L, demand = 0L))
  if (is.null(homes)) return(list(problems = list(), warnings = warn, households = 0L, stranded = 0L, reach = reach_all(integer(length(stores))),
                                  parking = fac_out, tiles = NULL))
  tc <- travel_costs(homes$tile, homes$segment, homes$car, T, NULL, tabs$fac, w, kms[homes$segment])
  inr <- tc$km <= radius[homes$segment]
  count <- .rowSums(inr, n, length(stores))
  for (k in seq_along(fac_out)) {
    fac_out[[k]]$households <- sum(homes$car & is.finite(fac_time(T, homes$tile, k)$t))
    fac_out[[k]]$demand <- sum(.rowSums(tc$fac == k & inr, n, length(stores)) > 0)       # households for whom it's the place to park, for some store
  }
  access <- lapply(seq_along(stores), function(s) list(by_car = sum(inr[, s] & tc$mode[, s] == MODE_DRIVE), on_foot = sum(inr[, s] & tc$mode[, s] == MODE_WALK),
                                                       parking = I(which(T$fw_m[, s] <= w$max_walk_km * 1000)), venue = tabs$store_venue[s]))
  per_tile_n <- tabulate(homes$tile, g$nx * g$ny)
  per_tile_reach <- bin_sum(homes$tile, count, g$nx * g$ny)
  per_tile_stranded <- tabulate(homes$tile[count == 0], g$nx * g$ny)
  lived <- which(per_tile_n > 0)
  row <- (lived - 1L) %% g$ny; col <- (lived - 1L) %/% g$ny
  list(problems = list(), warnings = warn, households = n, stranded = sum(count == 0), reach = reach_all(.colSums(inr, n, length(stores))),
       parking = fac_out, access = access, by_car = sum(tc$mode == MODE_DRIVE & inr), on_foot = sum(tc$mode == MODE_WALK & inr),
       tiles = list(row = row, col = col, households = per_tile_n[lived], stranded = per_tile_stranded[lived],
                    stores = round(per_tile_reach[lived] / per_tile_n[lived], 2)))
}

# One trip on the draft map (the last one previewed), from a home tile (row
# r, column c, 0-based) to store `s` (its number among the placed stores):
# the way the model would take it, with the car and without, and the
# routes, as the simulation would drive and walk them.
trip_preview <- function(r, c, s, car = TRUE, W = NULL) {
  T <- preview_cache$T
  if (is.null(T) || s < 1 || s > length(T$entrance)) return(list(ok = FALSE, message = "no preview yet"))
  tile <- c * T$ny + r + 1
  w <- W$market %||% P
  path_of <- function(fields, from, k, rev = FALSE) {
    if (!is.finite(fields$time[from, k])) return(NULL)
    nodes <- graph_route(fields, from, k); if (rev) nodes <- rev(nodes)
    I(round(as.vector(t(T$node_xy[nodes, , drop = FALSE]))))
  }
  walk <- list(ok = is.finite(T$wf$time[tile, s]), min = T$wf$time[tile, s] / 60, km = T$wf$length[tile, s] / 1000,
               within = T$wf$length[tile, s] <= w$max_walk_km * 1000, route = path_of(T$wf, tile, s))
  fac <- tabs_fac_cost <- NULL
  best <- NULL
  F <- length(T$approach)
  fac <- if (!is.null(W)) transport_tables(W$macro, vapply(Filter(store_placed, W$stores), function(x) x$id, ""), T$ny, T$nx)$fac else FAC
  for (k in seq_len(F)) {
    ft <- fac_time(T, tile, k)
    if (!is.finite(ft$t) || !(T$fw_m[k, s] <= w$max_walk_km * 1000)) next
    cost <- w$drive_w * ft$t / 60 + w$park_w * (fac$search_s[k] + fac$transfer_s[k]) / 60 + w$walk_w * T$fw_t[k, s] / 60
    if (is.null(best) || cost < best$cost) {
      cols <- which(T$vnode_fac == k); col <- cols[which.min(T$vf$time[tile, cols])]
      best <- list(facility = fac$name[k], k = k, cost = cost, drive_min = ft$t / 60, drive_km = ft$m / 1000,
                   park_min = (fac$search_s[k] + fac$transfer_s[k]) / 60, walk_min = T$fw_t[k, s] / 60, walk_km = T$fw_m[k, s] / 1000,
                   drive_route = path_of(T$vf, tile, col), walk_route = path_of(T$wf, T$fw_node[k, s], s))
    }
  }
  wcost <- if (walk$ok && walk$within) w$walk_w * T$wf$time[tile, s] / 60 else Inf
  mode <- if (!is.null(best) && car && best$cost < wcost) "drive" else if (is.finite(wcost)) "walk" else "none"
  list(ok = TRUE, mode = mode, walk = walk, drive = best, walk_cost = wcost)
}

# ---- The map, for the page --------------------------------------------------------------------

# Sent once per world: the tiles (each patch's land, density and area, read
# from the city world with of(), row by row from the top left), the areas
# and where to write their names (near the top of each area, clear of the
# stores that gather in the middle), the stores and the homes.
city_geometry <- function(city, hh) {
  world <- MACRO$world
  tiles <- of(world = world, agents = patches(world), var = c("land", "density", "area"))
  area <- as.integer(tiles[, "area"])
  lab <- lapply(seq_len(N_AREAS), function(k) {
    cells <- which(area == k)
    if (!length(cells)) return(list(x = NA, y = NA))
    col <- (cells - 1L) %% city$nx; row <- (cells - 1L) %/% city$nx
    top <- stats::quantile(row, 0.12, names = FALSE)
    near <- abs(row - top) <= 2
    list(x = (stats::median(col[near]) + 0.5) * MACRO$patch_m, y = (city$ny - top - 0.5) * MACRO$patch_m)
  })
  list(
    width = MACRO$width_m, height = MACRO$height_m, patch = MACRO$patch_m, nx = city$nx, ny = city$ny,
    land = as.integer(tiles[, "land"]), density = as.integer(tiles[, "density"]), area = area,
    areas = lapply(seq_len(N_AREAS), function(k) list(id = AREAS$id[k], name = AREAS$name[k], colour = AREAS$colour[k],
                                                        x = lab[[k]]$x, y = lab[[k]]$y, households = sum(hh$area == k))),
    stores = lapply(seq_len(N_STORES), function(s) list(
      id = s, key = STORES$id[s], name = STORES$name[s], short = STORES$short[s], brand = STORES$brand[s],
      area = STORES$area[s], format = FORMATS[STORES$format[s]], space = STORE_SIZE[s], venue = STORE_VENUE[s],
      x = STORES$x[s], y = STORES$y[s])),
    brands = lapply(seq_len(N_BRANDS), function(b) list(id = BRANDS$id[b], name = BRANDS$name[b], colour = BRANDS$colour[b],
                                                         family = BRANDS$family[b], ours = OURS_B[b], sells = I(which(CARRIES[b, ])))),
    categories = lapply(seq_len(N_CATS), function(k) list(id = CATEGORY_IDS[k], name = CATEGORIES[k], key = FIXTURES[k],
                                                          colour = CATEGORY_COLOURS[k], try_on = TRY_ON[k])),
    families = lapply(seq_len(nrow(FAMILIES)), function(f) list(id = FAMILIES$id[f], name = FAMILIES$name[f], ours = FAMILIES$ours[f])),
    segments = lapply(seq_len(N_SEGMENTS), function(g) list(id = SEGMENTS$id[g], name = SEGMENTS$name[g], colour = SEGMENTS$colour[g])),
    homes = list(n = hh$n),
    parking = lapply(seq_len(N_FAC), function(k) list(id = FAC$id[k], name = FAC$name[k], kind = FAC$kind[k], levels = FAC$levels[k],
                                                      spaces = FAC$spaces[k], tiles = I(FAC$tiles[[k]] - 1L), vehicle_access = I(FAC$veh[[k]] - 1L),
                                                      pedestrian_access = I(FAC$ped[[k]] - 1L))),   # tiles 0-based, column-major (col * ny + row)
    venues = lapply(seq_len(N_VENUES), function(v) list(id = VENUES$id[v], name = VENUES$name[v], kind = VENUES$kind[v],
                                                        stores = I(VENUES$stores[[v]]), parking = I(VENUES$parking[[v]]),
                                                        tiles = I(VENUES$tiles[[v]] - 1L),
                                                        plan = if (is.null(VENUES$plan[[v]])) NULL else list(cell_m = VENUES$plan[[v]]$cell_m,
                                                                     rows = I(apply(VENUES$plan[[v]]$chars, 1, paste, collapse = "")))))
  )
}
