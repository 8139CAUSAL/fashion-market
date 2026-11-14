# Small worlds for the transportation checks (tools/test-transport.R): the
# default world's brands, layouts and shoppers on maps drawn here tile by
# tile, so every route, space and storefront is known.
#
# mall_world(): 30 x 20 tiles of 50 m.
#
#        0         1         2
#        012345678901234567890123456789
#    0   ..............................
#    2   ==============================      north road
#    3   55555555=...GG......=.........      G: garage (3 levels), entered from the road at (3,13)
#    5   55555555=...ssss....=.........      s: plaza between the garage's exit (4,14) and the mall
#    6   55555555=...mmmmssPP=.........      m: Millbrook-style enclosed mall, 4 x 4 tiles, plan of 10 m cells
#   10   55555555=.pppppppppp=.........      p: park (walkable, not drivable)
#   13   55555555=..sssssss..=.........      s: the strip mall's walkway, its stores along it
#   14   55555555=..PPPPPPP..=.........      P: the strip mall's lot, entered from the south road at (16,12)
#   17   ==============================      south road
#
# Homes on the west (density 5), roads on columns 8 and 20. The mall's
# plan: a cross of corridors with entrances north (onto the plaza), east
# (onto the plaza beside the lot) and storefronts a-d in the four corners.

transport_base <- function(root) world_read(file.path(root, "worlds", "default.world.json"))

tiles_blank <- function(W, H, ch = ".") matrix(ch, H, W)
put <- function(m, r, c, ch) { for (rr in r) for (cc in c) m[rr + 1L, cc + 1L] <- ch; m }
rows_of <- function(m) as.list(apply(m, 1, paste, collapse = ""))
rc <- function(...) lapply(list(...), function(p) as.list(p))

mall_plan_rows <- function() {
  P <- matrix("#", 20, 20)
  P[9:12, ] <- "."; P[, 9:12] <- "."                        # corridors (rows/cols 8-11, 0-based)
  P[1, 9:12] <- "E"                                         # north entrance, onto tile (5, 13/14)
  P[9:12, 20] <- "E"                                        # east entrance, onto tile (7/8, 16)
  P[8, 3:5] <- "a"; P[8, 16:18] <- "b"                      # storefronts on the corridor's north side
  P[13, 3:5] <- "c"; P[13, 16:18] <- "d"                    # ... and its south side
  as.list(apply(P, 1, paste, collapse = ""))
}

# The store list for the small worlds: four in the mall, three on the strip.
small_stores <- function(base) {
  pick <- function(id) base$stores[[match(id, vapply(base$stores, `[[`, "", "id"))]]
  at <- function(s, id, name, x, y, venue = NULL) { s$id <- id; s$name <- name; s$short <- substr(name, 1, 16); s$x <- x; s$y <- y; s$venue <- venue; s }
  list(
    at(pick("ours_mm"), "m_ours", "Mall Ours", 650, 650, "mall"),
    at(pick("value_mm"), "m_value", "Mall Value", 725, 650, "mall"),
    at(pick("fast_mm"), "m_fast", "Mall Fast", 650, 575, "mall"),
    at(pick("prem_ot"), "m_prem", "Mall Premium", 725, 575, "mall"),
    at(pick("ours_int_mm"), "s_int", "Strip Intimates", 575, 325, "strip"),
    at(pick("value_ot"), "s_value", "Strip Value", 675, 325, "strip"),
    at(pick("fast_ot"), "s_fast", "Strip Fast", 775, 325, "strip"))
}

mall_world <- function(root, households = 3000, garage_spaces = 300, lot_spaces = 200, strip_spaces = 200, levels = 3, seed = 1L) {
  W <- transport_base(root)
  nx <- 30; ny <- 20
  t <- tiles_blank(nx, ny)
  t <- put(t, 2, 0:29, "="); t <- put(t, 17, 0:29, "=")
  t <- put(t, 3:16, 0:7, "5")
  t <- put(t, 2:17, 8, "="); t <- put(t, 2:17, 20, "=")
  t <- put(t, 3:4, 13:14, "G")
  t <- put(t, 5, 12:15, "s")
  t <- put(t, 6:9, 12:15, "m")
  t <- put(t, 6:9, 16:17, "s"); t <- put(t, 6:9, 18:19, "P")
  t <- put(t, 10:12, 10:19, "p")
  t <- put(t, 13, 11:17, "s")
  t <- put(t, 14:16, 11:17, "P")
  M <- W$macro
  M$patch_m <- 50; M$width <- nx; M$height <- ny; M$households <- households; M$wom_m <- 200
  M$tiles <- rows_of(t); M$area_tiles <- rows_of(tiles_blank(nx, ny)); M$areas <- list()
  M$parking <- list(
    list(id = "garage", name = "Mall garage", kind = "garage", tiles = rc(c(3, 13), c(3, 14), c(4, 13), c(4, 14)), levels = levels,
         spaces = garage_spaces, vehicle_access = rc(c(3, 13)), pedestrian_access = rc(c(4, 14)), search_s = 40, level_s = 30, transfer_s = 60),
    list(id = "mall_lot", name = "Mall lot", kind = "lot", tiles = rc(c(6, 18), c(6, 19), c(7, 18), c(7, 19), c(8, 18), c(8, 19), c(9, 18), c(9, 19)),
         levels = 1, spaces = lot_spaces, vehicle_access = rc(c(7, 19)), pedestrian_access = rc(c(7, 18), c(8, 18)), search_s = 60, level_s = 0, transfer_s = 30),
    list(id = "strip_lot", name = "Strip lot", kind = "lot", tiles = do.call(rc, lapply(as.list(as.data.frame(t(expand.grid(14:16, 11:17)))), identity)),
         levels = 1, spaces = strip_spaces, vehicle_access = rc(c(16, 12)), pedestrian_access = rc(c(14, 12), c(14, 14), c(14, 16)),
         search_s = 45, level_s = 0, transfer_s = 30))
  W$stores <- small_stores(W)
  M$venues <- list(
    list(id = "mall", name = "The Mall", kind = "mall", stores = list("m_ours", "m_value", "m_fast", "m_prem"), parking = list("garage", "mall_lot"),
         tiles = do.call(rc, lapply(as.list(as.data.frame(t(expand.grid(6:9, 12:15)))), identity)),
         plan = list(cell_m = 10, rows = mall_plan_rows()), storefronts = list(a = "m_ours", b = "m_value", c = "m_fast", d = "m_prem")),
    list(id = "strip", name = "The Strip", kind = "strip", stores = list("s_int", "s_value", "s_fast"), parking = list("strip_lot")))
  W$macro <- M
  # Everyone shops within this small town.
  W$segments <- lapply(W$segments, function(s) { s$radius_km <- 50; s })
  W$seed <- seed
  W
}

install_world <- function(W, root, seed = 1L) {
  p <- world_load(world_text(W), file.path(root, "layouts"))
  if (length(p)) stop(paste(vapply(p, function(x) paste0(x$path, ": ", x$message), ""), collapse = "\n"))
  fl <<- NULL; city <<- NULL; hh_cache <<- NULL; world_key <<- list(layouts = "", routes = "", households = "")
  setup(seed)
  invisible(TRUE)
}
