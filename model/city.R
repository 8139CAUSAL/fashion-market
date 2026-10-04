# The macro world: the market. A map painted in tiles (land, roads, water,
# parks, shops, and homes at a density from 1 to 9), optional named areas
# painted on a layer of their own, the households who live on the home
# tiles, and the fastest route from every tile to every store.
#
# Tiles, one character each, row 1 the north edge:
#   .  open land     ~  water       p  park       s  shops
#   =  road          +  bridge (a road over water)
#   1 to 9  homes, by density: households are placed on home tiles in
#           proportion to it
# The area layer has an area's key (one character) on each of its tiles,
# "." elsewhere. Households take their segment, size and budget from the
# area they live in, or the map's default make-up outside every area.
#
# A trip follows the fastest route across the map (grid.R): roads and
# bridges at road speed, other land at local speed, water impassable. The
# map is a NetLogoR world of these land codes, and the households are
# NetLogoR turtles.

MAP_CHARS <- c("." = 0L, "~" = 1L, p = 2L, s = 4L, "=" = 5L, "+" = 6L, setNames(rep(3L, 9), 1:9))
LAND <- c(open = 0L, water = 1L, park = 2L, homes = 3L, shops = 4L, road = 5L, bridge = 6L)
CITY_SEED <- 20260925              # the households are drawn from this, whatever the season's seed
MAX_MAP_TILES <- 60000
MAX_AREAS <- 40
MAX_HOUSEHOLDS <- 60000

MACRO <- NULL; AREAS <- NULL; N_AREAS <- 0L; AREA_BINS <- 1L
AREA_SEG_MIX <- NULL; AREA_SIZE_MIX <- NULL; N_WOM_CELLS <- 1L

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

# How fast a trip crosses each tile (m/s; 0: it can't).
macro_speed <- function(land, road_mps, local_mps) {
  sp <- matrix(local_mps, nrow(land), ncol(land))
  sp[land == LAND[["road"]] | land == LAND[["bridge"]]] <- road_mps
  sp[land == LAND[["water"]]] <- 0
  sp
}

# The tile a point (metres from the south-west corner) stands on, as a
# linear index into the map's matrices.
tile_of <- function(x, y, patch, ny) {
  (floor(x / patch)) * ny + (ny - floor(y / patch))
}

makeup_mix <- function(mk, ids) as.numeric(unlist(mk[ids]))

# ---- Checking a map ------------------------------------------------------------------

check_macro <- function(M, seg_ids, pb) {
  path <- "macro"
  if (!isTRUE(pb$keys(M, path, c("patch_m", "width", "height", "households", "road_mps", "local_mps", "park_s", "wom_m",
                                   "tiles", "areas", "area_tiles", "default_makeup")))) return(invisible())
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
                 park_s = as.numeric(M$park_s), wom_m = as.numeric(M$wom_m),
                 land = g$land, density = g$density, area = g$area)
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
  N_WOM_CELLS <<- ceiling(MACRO$width_m / MACRO$wom_m) * ceiling(MACRO$height_m / MACRO$wom_m)
}

# Each store's area (0: outside every area).
store_area <- function(x, y) MACRO$area[tile_of(x, y, MACRO$patch_m, MACRO$ny)]

area_bin <- function(area) ifelse_int(area > 0L, area, AREA_BINS)
area_names <- function() c(AREAS$name, "Outside every area")

# ---- Building the city ------------------------------------------------------------------

# The map as a NetLogoR world, and every store's routes: time and distance
# from every tile, and the next tile on the way.
build_city <- function() {
  m <- MACRO
  world <- createWorld(0, m$nx - 1, 0, m$ny - 1, data = as.vector(t(m$land)))
  speed <- macro_speed(m$land, m$road_mps, m$local_mps)
  store_tile <- tile_of(STORES$x, STORES$y, m$patch_m, m$ny)
  fields <- grid_fields(speed, m$patch_m, store_tile)
  list(nx = m$nx, ny = m$ny, land = m$land, density = m$density, area = m$area, world = world,
       speed = speed, store_tile = store_tile, fields = fields)
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
build_households <- function(city) {
  with_seed(CITY_SEED + 1, {
    n <- MACRO$households
    p <- MACRO$patch_m
    homes <- draw_homes(city$land, city$density, city$area, city$ny, p, n, AREA_SEG_MIX, AREA_SIZE_MIX)
    tile <- homes$tile; x <- homes$x; y <- homes$y; area <- homes$area; bin <- homes$bin
    segment <- homes$segment; size <- homes$size
    budget <- AREA_BUDGET[bin] * SEGMENTS$budget[segment] * rlnorm(n, -0.08, 0.4)

    # NetLogoR turtles hold the households as the city's agents; the
    # simulation reads their variables into plain vectors, which webR
    # updates far faster (see the note on state in main.R).
    agents <- createTurtles(n = n, coords = cbind(x / p, y / p), heading = 0)
    agents <- turtlesOwn(agents, tVar = "area", tVal = area)
    agents <- turtlesOwn(agents, tVar = "segment", tVal = segment)
    taste <- matrix(gumbel(n * N_BRANDS), n) + BRAND_FIT[segment, , drop = FALSE]
    list(
      n = n, agents = agents, x = x, y = y, tile = tile,
      area = as.integer(of(agents = agents, var = "area")), bin = bin,
      segment = as.integer(of(agents = agents, var = "segment")), size = size,
      budget = budget, taste = taste, tier0 = initial_tiers(taste),
      cell = wom_cell(x, y)
    )
  })
}

wom_cell <- function(x, y) {
  (floor(y / MACRO$wom_m)) * ceiling(MACRO$width_m / MACRO$wom_m) + floor(x / MACRO$wom_m) + 1L
}

# Every household's trip to every store: route length (km) and driving
# time (s), from the store's routes.
trip_tables <- function(city, hh) {
  list(km = matrix(city$fields$length[hh$tile, , drop = FALSE] / 1000, hh$n),
       drive_s = matrix(city$fields$time[hh$tile, , drop = FALSE], hh$n))
}

# ---- The map editor's preview ----------------------------------------------------------------

# What a draft map would do, worked out the way Setup would: its households
# (how many, and how many have no store within their segment's radius), how
# many households have each store in reach, and, tile by tile, the
# households living there and how many stores they can reach on average.
# Routes are kept between calls while the map and the stores' tiles stay
# the same, so painting areas or renaming a store is quick.
preview_cache <- list(key = "", fields = NULL)

macro_preview <- function(W) {
  pb <- problem_list()
  seg_ids <- if (is.list(W$segments)) vapply(W$segments, function(s) if (is.character(s$id)) s$id else "", "") else character()
  check_macro(W$macro, seg_ids, pb)
  all_stores <- if (is.list(W$stores)) W$stores else list()
  placed <- vapply(all_stores, store_placed, TRUE)          # stores not on the map yet reach no one
  stores <- all_stores[placed]
  for (i in which(placed)) check_store_place(all_stores[[i]], item_path("stores", i), W$macro, pb)
  radius <- vapply(W$segments, function(s) if (is.numeric(s$radius_km)) as.numeric(s$radius_km) else NA_real_, 0)
  if (pb$n() || anyNA(radius)) return(list(problems = pb$get()))
  M <- W$macro
  g <- macro_grids(M)
  sx <- vapply(stores, function(s) as.numeric(s$x), 0); sy <- vapply(stores, function(s) as.numeric(s$y), 0)
  tiles <- tile_of(sx, sy, M$patch_m, g$ny)
  key <- world_text(list(M[c("patch_m", "tiles", "road_mps", "local_mps")], tiles))
  if (!identical(key, preview_cache$key)) {
    speed <- macro_speed(g$land, M$road_mps, M$local_mps)
    preview_cache <<- list(key = key, fields = if (length(tiles)) grid_fields(speed, M$patch_m, tiles) else NULL)
  }
  mix <- c(M$areas, list(M$default_makeup))
  seg_mix <- matrix(vapply(mix, function(a) makeup_mix(a$segment_mix, seg_ids), numeric(length(seg_ids))), length(seg_ids))
  size_mix <- matrix(vapply(mix, function(a) makeup_mix(a$size_mix, SIZES), numeric(N_SIZES)), N_SIZES)
  n <- as.integer(M$households)
  homes <- if (n > 0) with_seed(CITY_SEED + 1, draw_homes(g$land, g$density, g$area, g$ny, M$patch_m, n, seg_mix, size_mix)) else NULL
  reach_all <- function(r) { out <- rep(NA_real_, length(all_stores)); out[placed] <- r; I(out) }
  if (is.null(homes)) return(list(problems = list(), households = 0L, stranded = 0L, reach = reach_all(integer(length(stores))), tiles = NULL))
  km <- if (length(tiles)) matrix(preview_cache$fields$length[homes$tile, , drop = FALSE] / 1000, n) else matrix(0, n, 0)
  inr <- km <= radius[homes$segment]
  count <- .rowSums(inr, n, length(tiles))
  per_tile_n <- tabulate(homes$tile, g$nx * g$ny)
  per_tile_reach <- bin_sum(homes$tile, count, g$nx * g$ny)
  per_tile_stranded <- tabulate(homes$tile[count == 0], g$nx * g$ny)
  lived <- which(per_tile_n > 0)
  row <- (lived - 1L) %% g$ny; col <- (lived - 1L) %/% g$ny
  list(problems = list(), households = n, stranded = sum(count == 0), reach = reach_all(.colSums(inr, n, length(tiles))),
       tiles = list(row = row, col = col, households = per_tile_n[lived], stranded = per_tile_stranded[lived],
                    stores = round(per_tile_reach[lived] / per_tile_n[lived], 2)))
}

# ---- Trips on the map, for the page ---------------------------------------------------------

# The day's trips (every visit to a store, to shop or to return items;
# online visits make none), each as the tiles along its route with the
# driving time from home to each, worked out the first time the map is
# drawn that day. route_of(v, s) then gives where visit v is after s
# seconds of driving.
trips <- NULL

build_trips <- function() {
  if (!is.null(trips) && identical(trips$day, day) && identical(trips$v, d$v)) return(invisible())
  hh <- mk$hh
  drive <- which(d$store > 0L)
  if (!length(drive)) { trips <<- list(day = day, v = d$v); return(invisible()) }
  from <- hh$tile[d$hh[drive]]; k <- d$store[drive]
  r <- grid_routes(city$fields, from, k)
  total <- city$fields$time[cbind(from, k)]
  t_at <- total[r$owner] - city$fields$time[cbind(r$cells, k[r$owner])]       # seconds from home
  ny <- city$ny; p <- MACRO$patch_m
  x <- ((r$cells - 1L) %/% ny + 0.5) * p; y <- (ny - (r$cells - 1L) %% ny - 0.5) * p
  # The route starts at the home itself and ends at the store's door.
  x[r$first] <- hh$x[d$hh[drive]]; y[r$first] <- hh$y[d$hh[drive]]
  last <- r$first + r$n - 1L
  x[last] <- STORES$x[k]; y[last] <- STORES$y[k]
  key <- drive[r$owner] * 1e5 + t_at
  # By visit: where each route starts and ends among the cells, and its time.
  at <- function(x) { out <- integer(d$v); out[drive] <- x; out }
  trips <<- list(day = day, v = d$v, key = key, x = x, y = y, first = at(r$first), last = at(last), total = { tt <- numeric(d$v); tt[drive] <- total; tt })
}

# Where visits `v` are after `s` seconds of driving from home.
route_of <- function(v, s) {
  s <- pmin(pmax(s, 0), trips$total[v])
  i <- pmax(findInterval(v * 1e5 + s, trips$key), trips$first[v])
  j <- pmin(i + 1L, trips$last[v])
  t0 <- trips$key[i] - v * 1e5; t1 <- trips$key[j] - v * 1e5
  f <- pmin(1, pmax(0, (s - t0) / pmax(t1 - t0, 1e-9)))
  cbind(trips$x[i] + (trips$x[j] - trips$x[i]) * f, trips$y[i] + (trips$y[j] - trips$y[i]) * f)
}

# ---- The map, for the page --------------------------------------------------------------------

# Sent once per world: the tiles, the areas and where to write their names
# (near the top of each area, clear of the stores that gather in the
# middle), the stores and the homes.
city_geometry <- function(city, hh) {
  lab <- lapply(seq_len(N_AREAS), function(k) {
    cells <- which(city$area == k)
    if (!length(cells)) return(list(x = NA, y = NA))
    col <- (cells - 1L) %/% city$ny; row <- (cells - 1L) %% city$ny
    top <- stats::quantile(row, 0.12, names = FALSE)
    near <- abs(row - top) <= 2
    list(x = (stats::median(col[near]) + 0.5) * MACRO$patch_m, y = (city$ny - top - 0.5) * MACRO$patch_m)
  })
  list(
    width = MACRO$width_m, height = MACRO$height_m, patch = MACRO$patch_m, nx = city$nx, ny = city$ny,
    land = as.integer(t(city$land)), density = as.integer(t(city$density)), area = as.integer(t(city$area)),
    areas = lapply(seq_len(N_AREAS), function(k) list(id = AREAS$id[k], name = AREAS$name[k], colour = AREAS$colour[k],
                                                        x = lab[[k]]$x, y = lab[[k]]$y, households = sum(hh$area == k))),
    stores = lapply(seq_len(N_STORES), function(s) list(
      id = s, key = STORES$id[s], name = STORES$name[s], short = STORES$short[s], brand = STORES$brand[s],
      area = STORES$area[s], format = FORMATS[STORES$format[s]], space = STORE_SIZE[s],
      x = STORES$x[s], y = STORES$y[s])),
    brands = lapply(seq_len(N_BRANDS), function(b) list(id = BRANDS$id[b], name = BRANDS$name[b], colour = BRANDS$colour[b],
                                                         family = BRANDS$family[b], ours = OURS_B[b], sells = I(which(CARRIES[b, ])))),
    categories = lapply(seq_len(N_CATS), function(k) list(id = CATEGORY_IDS[k], name = CATEGORIES[k], key = FIXTURES[k],
                                                          colour = CATEGORY_COLOURS[k], try_on = TRY_ON[k])),
    families = lapply(seq_len(nrow(FAMILIES)), function(f) list(id = FAMILIES$id[f], name = FAMILIES$name[f], ours = FAMILIES$ours[f])),
    segments = lapply(seq_len(N_SEGMENTS), function(g) list(id = SEGMENTS$id[g], name = SEGMENTS$name[g], colour = SEGMENTS$colour[g])),
    homes = list(n = hh$n)
  )
}
