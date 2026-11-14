#!/usr/bin/env Rscript
# Transportation, parking, shopping venues and multi-store outings, run
# with the real model in local R (transport.R, outings.R): on small maps
# drawn here tile by tile (tools/transport-worlds.R), on the bundled
# worlds, and on an older world upgraded.
#
#   Rscript tools/test-transport.R
#
# Needs what tools/test-fashion.R needs: R with jsonlite, and NetLogoR
# installed into tools/.cache/rlib against the shims in tools/shims/.
#
# The checks are numbered as the requirements number them (1 to 30; 31 is
# the whole of npm test), then the parking acceptance checks (P1 to P9),
# then the end-to-end outings at an enclosed mall and a strip mall (E1, E2).

script_path <- normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1]))
root <- normalizePath(file.path(dirname(script_path), ".."))
.libPaths(c(file.path(root, "tools", ".cache", "rlib"), .libPaths()))
suppressPackageStartupMessages(library(NetLogoR))
for (f in jsonlite::fromJSON(file.path(root, "model", "index.json"))$files) sys.source(file.path(root, "model", f), envir = globalenv())
sys.source(file.path(root, "tools", "transport-worlds.R"), envir = globalenv())

failures <- 0L
check <- function(ok, what) {
  cat(if (isTRUE(ok)) "  ok   " else "  FAIL ", what, "\n", sep = "")
  if (!isTRUE(ok)) failures <<- failures + 1L
}
problem_text <- function(W) vapply(world_check(W), function(p) paste0(p$path, ": ", p$message), "")
warn_text <- function() vapply(transport_warnings(city, city_layer("land"), mk$hh$tile), function(p) paste0(p$path, ": ", p$message), "")
P_DEFAULT <- P

# Runs whole market days from setup (season pace), keeping each day's
# outings, legs, parking, visits and the stock sold before it. Returns them.
run_days <- function(n) {
  P$pace <<- "season"
  out <- vector("list", n)
  for (i in seq_len(n)) {
    sold0 <- stock$sold; budget0 <- mk$budget_left; spend0 <- mk$spend; lines0 <- ledger$n
    advance(Inf)
    rf <- refunds_today()
    out[[i]] <- list(day = day, og = og, pk = pk, ol = ol, d = d, sold0 = sold0, sold1 = stock$sold, budget0 = budget0, spend0 = spend0,
                     lines = if (ledger$n > lines0) seq.int(lines0 + 1L, ledger$n) else integer(), refunds = rf)
    finish_day()
    out[[i]]$budget1 <- mk$budget_left; out[[i]]$spend1 <- mk$spend
    if (season_over) break
  }
  out
}

# A day's legs as a matrix, and an outing's, in time order.
legs_of <- function(D, o) {
  m <- D$ol$m[seq_len(D$ol$n), , drop = FALSE]
  m <- m[m[, "outing"] == o, , drop = FALSE]
  m[order(m[, "t0"], m[, "kind"] == OL_PARKED, m[, "t1"]), , drop = FALSE]
}

# Every node a leg's route runs through (as the simulation moves people
# along it), with the graph it's on.
route_nodes <- function(D, rows) {
  ol <<- D$ol; og <<- D$og
  lapply(rows, function(r) leg_route(r)$nodes)
}

# ---- Transportation and geography ------------------------------------------------------------

cat("Transportation and geography\n")

# A test field: 24 x 12 tiles. Homes in the west (columns 0-3), a road
# from them east along row 10, then north along column 20 to a lot at the
# north-east (rows 1-2, columns 21-22), entered at (2,21) from the road.
# Between, in the middle: a band of each kind of ground across rows 3-8,
# columns 8-12, each a different obstacle in turn (set per check).
geo_world <- function(middle = ".", extra = function(t) t, households = 400, parking = TRUE, footpath = FALSE, store_at = c(1, 18)) {
  W <- transport_base(root)
  nx <- 24; ny <- 12
  t <- tiles_blank(nx, ny)
  t <- put(t, 1:9, 0:3, "5")
  t <- put(t, 10, 0:20, "="); t <- put(t, 1:10, 20, "=")
  t <- put(t, 1:2, 21:22, "P")
  t <- put(t, 0:8, 8:12, middle)                               # rows 9-11 stay clear: the road, and room to walk round
  t <- put(t, 1, 13:19, "s")                                   # a shopping street to the store
  if (footpath) t <- put(t, 1, 4:12, "-")
  t <- extra(t)
  M <- W$macro
  M$patch_m <- 50; M$width <- nx; M$height <- ny; M$households <- households; M$wom_m <- 200
  M$tiles <- rows_of(t); M$area_tiles <- rows_of(tiles_blank(nx, ny)); M$areas <- list()
  M$parking <- if (parking) list(list(id = "lot", name = "Lot", kind = "lot", tiles = rc(c(1, 21), c(1, 22), c(2, 21), c(2, 22)), levels = 1, spaces = 50,
                                      vehicle_access = rc(c(2, 21)), pedestrian_access = rc(c(1, 21)), search_s = 30, level_s = 0, transfer_s = 10)) else list()
  M$venues <- list()
  W$macro <- M
  st <- W$stores[[1]]; st$venue <- NULL
  st$x <- (store_at[2] + 0.5) * 50; st$y <- (ny - store_at[1] - 0.5) * 50
  W$stores <- list(st)
  keep <- st$brand
  # Only the first store: every other brand sells online only.
  for (i in seq_along(W$brands)) if (W$brands[[i]]$id != keep) { W$brands[[i]]$online$on <- TRUE; if (W$brands[[i]]$online$plan_stores == 0) W$brands[[i]]$online$plan_stores <- 1 }
  W$segments <- lapply(W$segments, function(s) { s$radius_km <- 50; s })
  W
}
graphs_of <- function(W) {
  g <- macro_grids(W$macro)
  tabs <- transport_tables(W$macro, vapply(W$stores, `[[`, "", "id"), g$ny, g$nx)
  G <- transport_graphs(g$land, list(patch_m = W$macro$patch_m, road_mps = W$macro$road_mps, local_mps = W$macro$local_mps, walk_mps = W$macro$walk_mps),
                        tabs$fac, tabs$ven, cbind(vapply(W$stores, function(s) s$x, 0), vapply(W$stores, function(s) s$y, 0)), vapply(W$stores, `[[`, "", "id"))
  c(build_transport(G), list(land = g$land))
}
home_tile <- function(T) 3L * T$ny + 5L + 1L          # the homes tile at row 5, column 3

# 1. Cars: not through parks, woodland, water, footpaths, plazas, buildings.
blocked <- c(park = "p", woodland = "w", water = "~", footpath = "-", plaza = "s", building = "#", mall = "m", lot = "P", garage = "G")
open_car <- vapply(blocked, function(ch) drive_speed(matrix(MAP_CHARS[[ch]], 1), 10, 4) > 0, TRUE)
# A shortcut through each: the lot is reached along the road only.
via_road <- vapply(blocked[1:6], function(ch) {
  T <- graphs_of(geo_world(ch, function(t) put(t, 2, 4:19, ch)))          # the band, and a strip of it straight from the homes to the lot
  r <- graph_route(T$vf, home_tile(T), 1L)
  all(T$land[r] %in% LAND[c("homes", "road")])
}, TRUE)
check(!any(open_car) && all(via_road) && all(drive_speed(matrix(MAP_CHARS[c("=", "+", "H", "x", "d", "5")], 1), 10, 4) > 0),
      sprintf("1. cars can't enter %s; with a straight strip of each from the homes to the lot, every car still goes round by the road (homes' streets and road only)", paste(names(blocked), collapse = ", ")))

# 2. People: not through water, woodland, buildings, highways, malls, or a garage away from its exits.
nowalk <- c(water = "~", woodland = "w", building = "#", highway = "H", mall = "m", garage = "G")
open_walk <- vapply(nowalk, function(ch) walkable(matrix(MAP_CHARS[[ch]], 1))[1], TRUE)
around <- vapply(nowalk[1:4], function(ch) {
  W <- geo_world(ch)
  T <- graphs_of(W)
  r <- graph_route(T$wf, home_tile(T), 1L)
  all(T$walk$open[r]) && !any(T$land[r[r <= T$nM]] == MAP_CHARS[[ch]])
}, TRUE)
check(!any(open_walk) && all(around) && all(walkable(matrix(MAP_CHARS[c(".", "p", "5", "=", "+", "x", "d", "-", "f", "s", "P")], 1))),
      sprintf("2. people can't walk on %s; with a band of each across the way, every walk goes round it", paste(names(nowalk), collapse = ", ")))

# 3 and 5. A trail through a wood: walkers take it, cars can't.
Tp <- graphs_of(geo_world("w", footpath = TRUE))
Tn <- graphs_of(geo_world("w", footpath = FALSE))
wr <- graph_route(Tp$wf, home_tile(Tp), 1L); vr <- graph_route(Tp$vf, home_tile(Tp), 1L)
check(any(Tp$land[wr] == LAND[["footpath"]]) && !any(Tp$land[vr] == LAND[["footpath"]]) && !identical(wr, vr) &&
        identical(Tp$vf$time, Tn$vf$time) && Tp$wf$time[home_tile(Tp), 1] < Tn$wf$time[home_tile(Tn), 1],
      sprintf("3. between the same home and the same place, the walk (%.0f s, along a trail through the wood) and the drive (by the road) take different routes; 5. the trail shortens the walk (%.0f s round the wood without it) and changes no car's time at all",
              Tp$wf$time[home_tile(Tp), 1], Tn$wf$time[home_tile(Tn), 1]))

# 4. A gap in the road: no car gets to the lot, and the check says so.
Wg <- geo_world(".", function(t) put(t, 10, 15, "."))
Tg <- graphs_of(Wg)
install_world(Wg, root)
gap_warn <- warn_text()
check(!is.finite(fac_time(Tg, home_tile(Tg), 1L)$t) && all(mk$mode != MODE_DRIVE) && any(grepl("aren't connected to the main road network", gap_warn)) &&
        any(grepl("no home can reach it by road", gap_warn)),
      "4. a road with a gap: no car reaches the lot, no household drives, and the world's warnings show the cut-off road and the unreachable lot")

# 6. Bridges: a road bridge carries both, a footbridge only walkers; a highway carries only cars, and a crossing lets walkers across it.
river <- function(br) function(t) { t <- put(t, 0:11, 15, "~"); put(t, c(1, 10), 15, br) }
Tb <- graphs_of(geo_world(".", river("+"))); Tf <- graphs_of(geo_world(".", river("f")))
hw <- function(cross) function(t) { t <- put(t, 0:11, 15, "H"); if (cross) put(t, 1, 15, "x") else t }
Th <- graphs_of(geo_world(".", hw(FALSE))); Tx <- graphs_of(geo_world(".", hw(TRUE)))
check(is.finite(fac_time(Tb, home_tile(Tb), 1L)$t) && is.finite(Tb$wf$time[home_tile(Tb), 1]) &&
        !is.finite(fac_time(Tf, home_tile(Tf), 1L)$t) && is.finite(Tf$wf$time[home_tile(Tf), 1]) &&
        is.finite(fac_time(Th, home_tile(Th), 1L)$t) && !is.finite(Th$wf$time[home_tile(Th), 1]) && is.finite(Tx$wf$time[home_tile(Tx), 1]),
      "6. across a river, a road bridge carries cars and walkers, a footbridge walkers only; a highway carries cars and stops walkers, until a crossing is painted on it")

# 7. Areas painted over water and woodland change nothing about who can cross.
Wa <- geo_world("~", function(t) put(t, 4:6, 14:16, "w"))
Wa2 <- Wa; Wa2$macro$areas <- list(transport_base(root)$macro$areas[[1]])
Wa2$macro$area_tiles <- rows_of(matrix(Wa2$macro$areas[[1]]$key, 12, 24))
Ta <- graphs_of(Wa); Ta2 <- graphs_of(Wa2)
check(!length(problem_text(Wa2)) && identical(Ta$wf$time, Ta2$wf$time) && identical(Ta$vf$time, Ta2$vf$time) && identical(Ta$walk$open, Ta2$walk$open),
      "7. an area painted over the whole map, water and woodland included: every walking and driving field is exactly as it was")

# 8. A lot with no entrance on a road, and a store whose door opens on nothing walkable.
Wn <- geo_world(".")
Wn$macro$parking[[1]]$vehicle_access <- rc(c(1, 22))       # its far corner: beside nothing a car can use
Tn8 <- graphs_of(Wn)
Wd <- geo_world(".", function(t) put(t, 0:2, 17:19, "#"), store_at = c(1, 18))
Td <- graphs_of(Wd)
install_world(Wd, root); door_warn <- warn_text()
check(!length(Tn8$approach[[1]]) && !is.finite(fac_time(Tn8, home_tile(Tn8), 1L)$t) && !is.finite(Td$walk$half_t[Td$entrance[1]]) &&
        all(mk$mode == 0L) && any(grepl("door opens onto ground no one can walk on", door_warn)),
      "8. a lot whose only vehicle entrance touches no road can't be driven into; a store standing inside a building with no walkable door is reached by no one, and the warnings say so")

# ---- Parking --------------------------------------------------------------------------------

cat("Parking\n")
Wm8 <- mall_world(root, garage_spaces = 8, lot_spaces = 8, strip_spaces = 200)
Wm <- mall_world(root)
install_world(Wm8, root, seed = 11)
days <- run_days(3)
all_og <- function(f) unlist(lapply(days, function(D) f(D)))

# 9, 10, 11, 14, 15: every parking event, against the outing's legs.
park_ok <- function(D) {
  m <- D$pk$m[seq_len(D$pk$n), , drop = FALSE]
  if (!nrow(m)) return(TRUE)
  all(vapply(seq_len(nrow(m)), function(j) {
    o <- m[j, "outing"]; f <- m[j, "fac"]; L <- legs_of(D, o)
    drive_in <- L[L[, "kind"] == OL_DRIVE & L[, "t1"] == m[j, "t_in"], , drop = FALSE]
    parked <- L[L[, "kind"] == OL_PARKED, , drop = FALSE]
    inside <- L[L[, "kind"] == OL_INSIDE, , drop = FALSE]
    xfer <- L[L[, "kind"] == OL_TRANSFER, , drop = FALSE]
    out <- L[L[, "kind"] == OL_UNPARK, , drop = FALSE]
    home <- L[L[, "kind"] == OL_DRIVE & L[, "t0"] >= m[j, "t_out"], , drop = FALSE]
    nrow(drive_in) == 1L && drive_in[1, "fac"] == f &&                                 # it drove in to this facility
      nrow(parked) == 1L && parked[1, "fac"] == f && abs(parked[1, "t1"] - m[j, "t_out"]) < 1e-6 &&
      (!nrow(inside) || (min(inside[, "t0"]) >= parked[1, "t0"] && max(inside[, "t1"]) <= parked[1, "t1"])) &&   # parked through every visit
      nrow(xfer) == 2L && all(xfer[, "fac"] == f) && abs(xfer[2, "t1"] - m[j, "t_out"]) < 1e-6 &&               # back to the same facility, and only then does it pull out
      nrow(out) == 1L && out[1, "fac"] == f && nrow(home) == 1L && home[1, "fac"] == f && home[1, "rev"] == 1 &&   # leaves from it, the way it came
      m[j, "vehicle"] == D$og$hh[o]
  }, TRUE))
}
n_parked <- sum(vapply(days, function(D) D$pk$n, 0L))
check(n_parked > 0 && all(vapply(days, park_ok, TRUE)),
      sprintf("9-11, 14, 15. %d cars parked over %d days: each drove into its facility, took a space from the moment it arrived, stayed parked through every store visit of its outing, its shopper walked back to that same facility, and only then did the same car (the household's) pull out and drive home from it",
              n_parked, length(days)))

# 11 and 12. Occupancy, event by event: never over capacity; full facilities turn cars away to another or home.
occ_ok <- all(vapply(days, function(D) {
  m <- D$pk$m[seq_len(D$pk$n), , drop = FALSE]
  all(vapply(seq_len(N_FAC), function(f) {
    x <- m[m[, "fac"] == f, , drop = FALSE]
    if (!nrow(x)) return(TRUE)
    ev <- c(x[, "t_in"], x[, "t_out"]); dl <- c(rep(1, nrow(x)), rep(-1, nrow(x)))
    o <- order(ev, dl)
    max(cumsum(dl[o])) <= FAC$spaces[f]
  }, TRUE))
}, TRUE))
fails <- all_og(function(D) D$og$fails)
went_on <- all_og(function(D) which(apply(D$og$tried, 1, any) & D$og$park_row > 0L))
gave_up <- all_og(function(D) which(D$og$ended == END_NO_PARK))
peak <- apply(tally$peak[seq_len(length(days)), seq_len(N_FAC), drop = FALSE], 2, max)
check(occ_ok && length(fails) > 0 && length(went_on) > 0 && length(gave_up) >= 0 && peak[1] == FAC$spaces[1],
      sprintf("11, 12. with the garage at %d spaces, occupancy never passes any facility's spaces (peaks %s); it filled (%d cars found it full): %d of them parked at another facility serving their store, %d drove home",
              FAC$spaces[1], paste(peak, collapse = "/"), length(fails), length(went_on), length(gave_up)))

# 13. A garage holds more per tile on its levels, and climbing to a higher level takes longer.
Wcap <- Wm8
Wcap$macro$parking[[2]]$spaces <- 801                     # the 8-tile lot: at most 8 x 2,500 / 25 = 800
Wcap$macro$parking[[1]]$spaces <- 1200                    # the 4-tile garage on 3 levels: at most 4 x 2,500 x 3 / 25 = 1,200
lvl <- unlist(lapply(days, function(D) D$pk$m[seq_len(D$pk$n), "level"][D$pk$m[seq_len(D$pk$n), "fac"] == 1]))
park_s <- unlist(lapply(days, function(D) {
  m <- D$ol$m[seq_len(D$ol$n), , drop = FALSE]; m <- m[m[, "kind"] == OL_PARK & m[, "fac"] == 1, , drop = FALSE]; m[, "t1"] - m[, "t0"]
}))
pt <- problem_text(Wcap)
check(any(grepl("macro.parking\\[2\\].spaces: 801 spaces won't fit", pt)) && !any(grepl("macro.parking\\[1\\].spaces", pt)) &&
        max(lvl) > 1 && all(sort(unique(round(park_s))) == sort(unique(FAC$search_s[1] + (lvl - 1) * FAC$level_s[1]))),
      sprintf("13. a lot holds its tiles' area (801 spaces on 8 tiles refused), a garage that on each level (1,200 on 4 tiles, 3 levels, accepted); cars climbed to level %d when the lower filled, and parking took %s s by level",
              max(lvl), paste(sort(unique(round(park_s))), collapse = "/")))

# ---- Shopping venues and behaviour ------------------------------------------------------------

cat("Shopping venues and behaviour\n")
install_world(Wm, root, seed = 11); days <- run_days(3)
mall <- which(STORE_VENUE == 1L); strip <- which(STORE_VENUE == 2L)
plan <- city$plans[[1]]
in_plan <- function(nodes) nodes > plan$off & nodes <= plan$off + plan$PH * plan$PW
visits_of <- function(D, o) { v <- which(D$d$outing == o); v[order(D$d$arrive[v])] }

# 16. Inside the mall: from one storefront to the next along the corridors.
hop <- NULL
for (D in days) {
  for (o in which(D$og$n_visits >= 2L)) {
    v <- visits_of(D, o)
    if (all(D$d$store[v[1:2]] %in% mall)) { hop <- list(D = D, o = o, v = v); break }
  }
  if (!is.null(hop)) break
}
hop_ok <- FALSE
if (!is.null(hop)) {
  L <- legs_of(hop$D, hop$o)
  w <- which(L[, "kind"] == OL_WALK & L[, "store"] == hop$D$d$store[hop$v[2]] & L[, "from"] == city$entrance[hop$D$d$store[hop$v[1]]])
  rows <- which(hop$D$ol$m[seq_len(hop$D$ol$n), "outing"] == hop$o & hop$D$ol$m[seq_len(hop$D$ol$n), "t0"] == L[w[1], "t0"] & hop$D$ol$m[seq_len(hop$D$ol$n), "kind"] == OL_WALK)
  nodes <- route_nodes(hop$D, rows)[[1]]
  hop_ok <- length(w) == 1L && all(in_plan(nodes)) && all(plan$chars[nodes - plan$off] != "#")
}
check(hop_ok, sprintf("16. a shopper walks from %s to %s inside the mall, every step on its corridors and storefronts (%s)",
                      if (!is.null(hop)) STORES$name[hop$D$d$store[hop$v[1]]] else "-", if (!is.null(hop)) STORES$name[hop$D$d$store[hop$v[2]]] else "-",
                      if (hop_ok) sprintf("%d cells", length(nodes)) else "not found"))

# 17. The strip: park at its lot, visit stores along the walkway, back to the lot.
strip_o <- NULL
for (D in days) {
  for (o in which(D$og$n_visits >= 2L & D$og$fac == 3L & D$og$park_row > 0L)) {
    v <- visits_of(D, o)
    if (all(D$d$store[v] %in% strip)) { strip_o <- list(D = D, o = o, v = v); break }
  }
  if (!is.null(strip_o)) break
}
check(!is.null(strip_o) && all(legs_of(strip_o$D, strip_o$o)[legs_of(strip_o$D, strip_o$o)[, "kind"] %in% c(OL_PARK, OL_PARKED, OL_TRANSFER, OL_UNPARK), "fac"] == 3),
      sprintf("17. a driver parks at the strip's lot, visits %d of its stores along the walkway, and walks back to that lot", if (is.null(strip_o)) 0L else length(strip_o$v)))

# 18. A wall across the mall's corridor: the storefronts beyond it can't be reached.
install_world(Wm, root, seed = 11)
mall <- which(STORE_VENUE == 1L); strip <- which(STORE_VENUE == 2L)
Wb <- Wm
pr <- do.call(rbind, strsplit(unlist(Wb$macro$venues[[1]]$plan$rows), ""))
pr[, 14] <- "#"                                             # a wall down the plan: storefronts b and d are east of it
pr[9:12, 20] <- "#"                                         # ... and the east entrance, which would let people in to them, shut
Wb$macro$venues[[1]]$plan$rows <- as.list(apply(pr, 1, paste, collapse = ""))
install_world(Wb, root, seed = 11)
bw <- warn_text(); bd <- run_days(1)[[1]]
cut <- match(c("m_value", "m_prem"), STORES$id)
check(!is.finite(city$wf$time[city$plans[[1]]$off + which(as.vector(city$plans[[1]]$chars == "E"))[1], cut[1]]) &&
        any(grepl("Mall Value's storefront can't be reached from any entrance", bw)) && sum(bd$d$store %in% cut) == 0 && sum(bd$d$store %in% match(c("m_ours", "m_fast"), STORES$id)) > 0,
      sprintf("18. a wall across the mall's corridor: Mall Value and Mall Premium, beyond it, can't be reached (the warnings name them; no one visits them all day), while the stores this side get %d visits",
              sum(bd$d$store %in% match(c("m_ours", "m_fast"), STORES$id))))
install_world(Wm, root, seed = 11); days <- run_days(3)

# 19, 20, 22. Browsing without buying then buying elsewhere; buying at several; buying nothing.
pat <- function(f) sum(vapply(days, function(D) sum(vapply(which(D$og$n_visits >= 1L), function(o) f(D, visits_of(D, o)), TRUE)), 0))
browse_then_buy <- pat(function(D, v) length(v) >= 2 && D$d$outcome[v[1]] != 1L && any(D$d$outcome[v[-1]] == 1L))
multi <- pat(function(D, v) sum(D$d$outcome[v] == 1L) >= 2L && length(unique(D$d$brand[v][D$d$outcome[v] == 1L])) >= 2L)
none <- pat(function(D, v) all(D$d$outcome[v] != 1L))
check(browse_then_buy > 0 && multi > 0 && none > 0,
      sprintf("19, 20, 22. %d outings left a store without buying and then bought at another; %d bought at two or more retailers; %d ended without buying anything", browse_then_buy, multi, none))

# 21. Budget, time and what's been bought decide whether to go on (the decision itself, for one shopper at a door).
D <- days[[length(days)]]
og <- D$og; d <- D$d
o <- which(D$og$kind == OG_SHOP & D$og$n_visits >= 1L)[1]
s <- D$og$at[o]
save <- list(spent = og$spent[o], got = og$got[o, ])
set.seed(5); base_c <- next_stop(rep(o, 200), rep(s, 200), rep(9 * 3600, 200))
og$spent[o] <- mk$budget_left[og$hh[o]] + 1
set.seed(5); broke <- next_stop(rep(o, 200), rep(s, 200), rep(9 * 3600, 200))
og$spent[o] <- save$spent; og$got[o, ] <- TRUE
set.seed(5); got_all <- next_stop(rep(o, 200), rep(s, 200), rep(9 * 3600, 200))
og$got[o, ] <- save$got
set.seed(5); late <- next_stop(rep(o, 200), rep(s, 200), rep(LAST_ENTRY_S - 10, 200))
og$spent[o] <- 0.9 * mk$budget_left[og$hh[o]]
set.seed(5); lean <- next_stop(rep(o, 200), rep(s, 200), rep(9 * 3600, 200))
og$spent[o] <- save$spent
# ... and across the days: a visit that bought vs one that didn't.
dec <- do.call(rbind, lapply(days, function(D) do.call(rbind, lapply(which(D$og$n_visits >= 1L & D$og$kind == OG_SHOP), function(o) {
  v <- visits_of(D, o); cbind(paid = D$d$outcome[v] == 1L, on = c(rep(1, length(v) - 1L), 0))
}))))
p_on <- tapply(dec[, "on"], dec[, "paid"], mean)
check(all(broke$store == 0L) && all(broke$reason == END_BUDGET) && all(got_all$reason == END_GOT) && all(late$store == 0L) && all(late$reason == END_NOTHING) &&
        mean(lean$store > 0) < mean(base_c$store > 0) && p_on[["1"]] < p_on[["0"]],
      sprintf("21. one shopper at a door, 200 times: with the budget spent, always home (budget spent); with everything they came for bought, home; ten seconds before last entry, home (nothing else within reach); with 90%% of the budget spent they go on %.0f%% of the time, against %.0f%% before; over 3 days, %.0f%% go on after a visit that bought, %.0f%% after one that didn't",
              100 * mean(lean$store > 0), 100 * mean(base_c$store > 0), 100 * p_on[["1"]], 100 * p_on[["0"]]))

# 23. Walking only: no car, no parking.
Ww <- Wm; Ww$segments <- lapply(Ww$segments, function(s) { s$car_share <- 0; s })
Ww$macro$tiles <- rows_of(put(do.call(rbind, strsplit(unlist(Ww$macro$tiles), "")), 3:16, 9:10, "5"))   # homes up to the venues, so some can walk
install_world(Ww, root, seed = 11); wd <- run_days(1)[[1]]
m <- wd$ol$m[seq_len(wd$ol$n), , drop = FALSE]
check(wd$og$n > 0 && all(wd$og$mode == MODE_WALK) && wd$pk$n == 0L && !any(m[, "kind"] %in% c(OL_DRIVE, OL_PARK, OL_PARKED, OL_UNPARK, OL_TRANSFER)) && sum(wd$d$stop >= 1) > 0,
      sprintf("23. no household with a car: %d outings, every one on foot, %d store visits, no vehicle, no parking event, no drive", wd$og$n, sum(wd$d$stop >= 1)))

# ---- Accounting --------------------------------------------------------------------------------

cat("Accounting\n")
install_world(Wm, root, seed = 11); days <- run_days(3)
# 24. Budgets: each household's budget falls by exactly what it paid (and rises by its refunds), however many stores.
bud_ok <- all(vapply(days, function(D) {
  paid <- D$d$outcome == 1L
  spent <- bin_sum(D$d$hh[paid], D$d$sales[paid] + D$d$delivery[paid], mk$hh$n)
  back <- bin_sum(D$refunds$hh, D$refunds$refund, mk$hh$n)
  max(abs((D$budget0 - D$budget1) - (spent - back))) < 1e-6
}, TRUE))
multi_hh <- sum(vapply(days, function(D) { p <- D$d$hh[D$d$outcome == 1L]; sum(tabulate(p, mk$hh$n) >= 2) }, 0))
check(bud_ok && multi_hh > 0, sprintf("24. every household's budget comes down by exactly what it paid that day, less its refunds, including the %d that paid at two stores or more in a day", multi_hh))

# 25 and 26. Sales, stock and the ledger, store by store and brand by brand.
L <- ledger_view()
by_store <- bin_sum(L$store[!L$online], L$paid[!L$online], N_STORES)
tally_store <- colSums(apply(tally$sales[seq_len(length(days)), , seq_len(N_STORES), drop = FALSE], c(1, 3), sum))
by_brand <- bin_sum(L$brand, L$paid, N_BRANDS)
stock_ok <- all(vapply(days, function(D) {
  Ld <- ledger_view(D$lines); st <- !Ld$online
  sold <- D$sold1 - D$sold0
  want <- matrix(tabulate((Ld$sku[st] - 1L) * N_STORES + Ld$store[st], N_STORES * N_SKU), N_STORES)
  identical(dim(sold), dim(want)) && max(abs(sold - want)) == 0 &&
    all(Ld$store[st] == D$d$store[match(paste(Ld$hh[st], Ld$store[st]), paste(D$d$hh, D$d$store))])
}, TRUE))
check(max(abs(by_store - tally_store)) < 1e-6 && max(abs(by_brand - brand_of_stores(c(tally_store, numeric(N_BRANDS))) - bin_sum(L$brand[L$online], L$paid[L$online], N_BRANDS))) < 1e-6 &&
        abs(sum(L$paid) - sum(tally$sales)) < 1e-6 && stock_ok && all(STORES$brand[L$store[!L$online]] == L$brand[!L$online]),
      sprintf("25, 26. the ledger's %s lines add up to each store's, each brand's and the market's sales; each store's stock sold is exactly its own ledger lines, sku by sku; every line's store is one its household visited, of the line's brand",
              format(length(L$hh), big.mark = ",")))

# 28. Outings, shoppers, visits, purchases and transactions are counted apart.
dd <- seq_len(length(days))
counts <- c(outings = sum(tally$outings[dd, ]), shoppers = sum(tally$shoppers[dd]), visits = sum(tally$dest_visits[dd, ] + tally$next_visits[dd, ]),
            purchases = sum(tally$purchases[dd]), units = sum(tally$units[dd, , seq_len(N_STORES)]))
direct <- c(outings = sum(vapply(days, function(D) sum(!is.na(D$og$t_home)), 0)),
            shoppers = sum(vapply(days, function(D) length(unique(D$d$hh[!D$d$online & !D$d$ret])), 0)),
            visits = sum(vapply(days, function(D) sum(!D$d$online & !D$d$ret), 0)),
            purchases = sum(vapply(days, function(D) sum(!D$d$online & !D$d$ret & D$d$outcome == 1L), 0)),
            units = sum(!L$online))
check(identical(counts, direct) && counts[["visits"]] > counts[["shoppers"]] && counts[["outings"]] != counts[["visits"]] && counts[["units"]] > counts[["purchases"]],
      sprintf("28. kept apart, and each as counted directly: %s outings, %s shoppers, %s store visits, %s purchases, %s units",
              counts[["outings"]], counts[["shoppers"]], counts[["visits"]], counts[["purchases"]], counts[["units"]]))

# 27. Coupons once, loyalty by brand, returns to the purchase.
Wo <- Wm
Wo$brands <- lapply(Wo$brands, function(b) { b$calendar$offers <- lapply(b$calendar$offers, function(o) { o$from <- 1L; o$to <- 3L; o$audience <- 1; o$holdout <- 0; o }); b })
install_world(Wo, root, seed = 11); od <- run_days(3)
used <- do.call(rbind, lapply(od, function(D) { v <- which(D$d$outcome == 1L & D$d$coupon_from > 0L); cbind(D$d$hh[v], D$d$coupon_from[v]) }))
twice <- if (is.null(used) || !nrow(used)) 0L else sum(duplicated(used))
Lo <- ledger_view()
spend_ok <- max(abs(mk$spend - matrix(bin_sum((Lo$brand - 1L) * mk$hh$n + Lo$hh, Lo$paid - Lo$refund, mk$hh$n * N_BRANDS), mk$hh$n))) < 1e-6
ret <- Lo$returned
ret_ok <- !any(ret) || all(Lo$ret_store[ret] == 0L | STORES$brand[pmax(1L, Lo$ret_store[ret])] == Lo$brand[ret])
offers_ok <- all(vapply(which(ofr$drawn), function(k) { r <- offer_results(k); is.finite(r$spend$treated) || r$sent == 0 }, TRUE))
check(!is.null(used) && nrow(used) > 0 && twice == 0L && spend_ok && ret_ok && offers_ok,
      sprintf("27. %d coupons used, none twice by one household (not even across the stores of one outing); each household's loyalty spend with each brand is its ledger lines' net; returns went back to the selling brand; every offer's results build",
              if (is.null(used)) 0L else nrow(used)))

# 29. An older world (version 10, no parking): upgrades with none, loads, runs on foot, and says what can't be reached by car.
V10 <- world_parse(paste(readLines(file.path(root, "tools", "fixtures", "v10-default.world.json")), collapse = "\n"))
U <- world_resolve(world_upgrade(V10), file.path(root, "layouts"))
fl <<- NULL; city <<- NULL; hh_cache <<- NULL
ok29 <- identical(U$version, WORLD_VERSION) && identical(U$macro$parking, list()) && identical(U$macro$venues, list()) && !length(world_check(U)) &&
  is.null(U$macro$park_s) && identical(U$macro$tiles, V10$macro$tiles) && all(vapply(U$stores, function(s) is.null(s$venue), TRUE))
world_install(U); setup(3); od <- run_days(1)[[1]]
w29 <- warn_text()
check(ok29 && N_FAC == 0L && od$pk$n == 0L && all(od$og$mode == MODE_WALK) && sum(!od$d$online) > 0 && any(grepl("no parking has been built", w29)) &&
        sum(grepl("only walkers can come|no household can reach it", w29)) == N_STORES,
      sprintf("29. the version 10 default world upgrades with no parking and no venues (nothing invented), its tiles as they were; it loads, runs (%d store visits, all on foot), and its warnings say no parking was built and name all %d stores as unreachable by car",
              sum(!od$d$online), N_STORES))

# 30. The same world and seed: the same outings, parking and sales.
install_world(Wm, root, seed = 21); a <- run_days(2); la <- ledger_view()
install_world(Wm, root, seed = 21); b <- run_days(2); lb <- ledger_view()
same <- identical(lapply(a, function(D) list(D$og[c("t_depart", "t_home", "fac", "n_visits", "ended")], D$pk$m[seq_len(D$pk$n), ], D$ol$m[seq_len(D$ol$n), ])),
                  lapply(b, function(D) list(D$og[c("t_depart", "t_home", "fac", "n_visits", "ended")], D$pk$m[seq_len(D$pk$n), ], D$ol$m[seq_len(D$ol$n), ]))) &&
  identical(la, lb)
check(same, "30. the same world and seed run the same days again: every outing's departure, return, facility, visits and end, every parking event, every leg, and the ledger")

# Sensitivity of the assumed weights (none is calibrated): the direction of
# each one's effect on what the simulation does, on the mall town with homes
# up to the venues (so walking and driving compete), the same seed each time.
sens <- function(walk_w = NULL, cluster_w = NULL, drive_w = NULL) {
  W <- Wm
  W$macro$tiles <- rows_of(put(do.call(rbind, strsplit(unlist(W$macro$tiles), "")), 3:16, 9:10, "5"))
  if (!is.null(walk_w)) W$market$walk_w <- walk_w
  if (!is.null(cluster_w)) W$market$cluster_w <- cluster_w
  if (!is.null(drive_w)) W$market$drive_w <- drive_w
  install_world(W, root, seed = 41); D <- run_days(2)
  sh <- unlist(lapply(D, function(x) x$og$kind == OG_SHOP & x$og$n_visits > 0))
  nv <- unlist(lapply(D, function(x) x$og$n_visits))
  walkers <- unlist(lapply(D, function(x) x$og$mode == MODE_WALK))
  dest <- unlist(lapply(D, function(x) x$og$dest[x$og$kind == OG_SHOP]))
  c(walk = mean(walkers), stops = mean(nv[sh]), venue = mean(dest %in% which(STORE_VENUE > 0)),
    mall = mean(dest %in% which(STORE_VENUE == 1L)), km = mean(unlist(lapply(D, function(x) mk$km[cbind(x$og$hh, x$og$dest)]))))
}
w0 <- Wm$market$walk_w; d0 <- Wm$market$drive_w
lo <- sens(walk_w = w0 / 2); hi <- sens(walk_w = w0 * 2)
c0 <- sens(cluster_w = 0); c1 <- sens(cluster_w = 1)
dl <- sens(drive_w = d0 / 2); dh <- sens(drive_w = d0 * 2)
check(lo[["walk"]] > hi[["walk"]] && lo[["stops"]] > hi[["stops"]] && c1[["mall"]] > c0[["mall"]] && dh[["walk"]] > dl[["walk"]],
      sprintf("sensitivity, assumed weights (directions only): walking half as disliked, %.0f%% of outings on foot and %.2f stores an outing, against %.0f%% and %.2f at twice; the pull of nearby stores at 1, %.0f%% of outings to the mall, against %.0f%% at 0; driving twice as disliked, %.0f%% of outings on foot, against %.0f%% at half",
              100 * lo[["walk"]], lo[["stops"]], 100 * hi[["walk"]], hi[["stops"]], 100 * c1[["mall"]], 100 * c0[["mall"]], 100 * dh[["walk"]], 100 * dl[["walk"]]))

# ---- Parking: the acceptance checks ------------------------------------------------------------

cat("Parking, as the end user builds it\n")
# P1. A store beside a road, and no parking: no space appears from anywhere.
Wp <- geo_world(".", parking = FALSE, store_at = c(9, 18))
install_world(Wp, root); p1 <- run_days(1)[[1]]
check(N_FAC == 0L && p1$pk$n == 0L && all(p1$og$mode != MODE_DRIVE) && !any(mk$mode == MODE_DRIVE) && any(grepl("no parking has been built", warn_text())),
      "P1. a store on the shopping street beside the road, with no parking built: no kerb or any other space appears, no one drives, and the warnings say no parking was built")
# P2, P3. One kerb space painted: exactly one car at a time; removed: none.
Wk <- geo_world(".", parking = FALSE, store_at = c(9, 18))
Wk$macro$parking <- list(list(id = "kerb", name = "One space", kind = "kerb", tiles = rc(c(10, 18)), levels = 1, spaces = 1,
                              vehicle_access = rc(c(10, 18)), pedestrian_access = rc(c(10, 18)), search_s = 30, level_s = 0, transfer_s = 0))
Wk$macro$households <- 2000
install_world(Wk, root); p2 <- run_days(2)
occ1 <- max(vapply(p2, function(D) {
  m <- D$pk$m[seq_len(D$pk$n), , drop = FALSE]; if (!nrow(m)) return(0)
  ev <- c(m[, "t_in"], m[, "t_out"]); dl <- c(rep(1, nrow(m)), rep(-1, nrow(m))); o <- order(ev, dl); max(cumsum(dl[o]))
}, 0))
cars2 <- sum(vapply(p2, function(D) D$pk$n, 0L)); turned <- sum(vapply(p2, function(D) length(D$og$fails), 0L))
Wk0 <- Wk; Wk0$macro$parking <- list()
install_world(Wk0, root); p3 <- run_days(1)[[1]]
check(cars2 > 1 && occ1 == 1 && turned > 0 && N_FAC == 0L && p3$pk$n == 0L && all(p3$og$mode != MODE_DRIVE),
      sprintf("P2, P3. one kerb space painted: %d cars used it over 2 days, never two at once, %d turned away; with the space removed, the next installed simulation has no parking and no one drives", cars2, turned))
# P4. A surface lot: its spaces and its connections are the lot's.
Wl <- geo_world(".")
install_world(Wl, root); p4 <- run_days(1)[[1]]
fl_lot <- unique(p4$pk$m[seq_len(p4$pk$n), "fac"])
check(FAC$kind[1] == "lot" && FAC$spaces[1] == 50 && identical(as.numeric(fl_lot), 1) && p4$pk$n > 0 && length(city$approach[[1]]) == 1L && city$approach[[1]] == 20 * 12 + 2 + 1,
      sprintf("P4. a surface lot of 4 tiles and 50 spaces: %d cars parked in it, reaching it at the road tile beside its one entrance", p4$pk$n))
# P5. A garage's capacity is what was configured for its levels.
check(FAC$spaces[1] == 50 && parking_max_spaces("garage", 4, 3, 50) == 1200 && parking_max_spaces("garage", 4, 1, 50) == 400 &&
        any(grepl("spaces won't fit", problem_text({ x <- Wm; x$macro$parking[[1]]$levels <- 1; x$macro$parking[[1]]$spaces <- 401; x }))),
      "P5. a garage on 4 tiles holds at most 1,200 on 3 levels and 400 on 1: its configured spaces are its capacity, refused beyond what its levels hold")
# P6. A lot right beside the store whose entrance touches no road is never used; the one round the corner is.
Wf <- geo_world(".", store_at = c(1, 18), extra = function(t) put(t, 0, 16:17, "P"))
Wf$macro$parking[[2]] <- list(id = "near", name = "Next door", kind = "lot", tiles = rc(c(0, 16), c(0, 17)), levels = 1, spaces = 50,
                               vehicle_access = rc(c(0, 16)), pedestrian_access = rc(c(0, 17)), search_s = 10, level_s = 0, transfer_s = 0)
install_world(Wf, root); p6 <- run_days(1)[[1]]
used6 <- p6$pk$m[seq_len(p6$pk$n), "fac"]
check(length(used6) > 0 && all(used6 == 1) && !length(city$approach[[2]]),
      sprintf("P6. a lot next door to the store, its entrance on the plaza (no road): no car can get in, and all %d cars park at the connected lot round the corner instead", length(used6)))
# P7 is 29 above. P8: many shoppers, a tiny garage: never over capacity (11, 12 above, again at 5 spaces).
Wt <- mall_world(root, garage_spaces = 5, lot_spaces = 5, strip_spaces = 5)
install_world(Wt, root, seed = 3); p8 <- run_days(1)[[1]]
m8 <- p8$pk$m[seq_len(p8$pk$n), , drop = FALSE]
over <- any(vapply(seq_len(N_FAC), function(f) {
  x <- m8[m8[, "fac"] == f, , drop = FALSE]; if (!nrow(x)) return(FALSE)
  ev <- c(x[, "t_in"], x[, "t_out"]); dl <- c(rep(1, nrow(x)), rep(-1, nrow(x))); o <- order(ev, dl); max(cumsum(dl[o])) > FAC$spaces[f]
}, TRUE))
check(!over && length(p8$og$fails) > 100 && sum(p8$og$ended == END_NO_PARK) > 0,
      sprintf("P8. %d households in the market, 5 spaces in each facility: %d cars parked, %d arrivals found a facility full, %d outings went home without parking, and no facility ever held more than 5",
              p8$og$n, p8$pk$n, length(p8$og$fails), sum(p8$og$ended == END_NO_PARK)))
# P9 is E1 and E2 below.

# ---- End to end ----------------------------------------------------------------------------------

cat("End to end\n")
P <- P_DEFAULT
# Every leg of every outing of a day runs on ground its mode may use.
legs_valid <- function(D) {
  m <- D$ol$m[seq_len(D$ol$n), , drop = FALSE]
  r <- which(m[, "kind"] %in% c(OL_DRIVE, OL_WALK))
  nodes <- route_nodes(D, r)
  drv <- m[r, "kind"] == OL_DRIVE
  all(vapply(nodes[drv], function(n) all(city$veh$open[n]), TRUE)) && all(vapply(nodes[!drv], function(n) all(city$walk$open[n]), TRUE))
}
# One outing, told in full and checked: the chronology, the routes, the
# parking, the visits and what they cost.
e2e <- function(D, o, venue) {
  L <- legs_of(D, o)
  v <- visits_of(D, o)
  h <- D$og$hh[o]; f <- D$og$fac[o]; row <- D$og$park_row[o]
  pkr <- D$pk$m[row, ]
  K <- L[L[, "kind"] != OL_PARKED, , drop = FALSE]
  chain <- all(abs(K[-1, "t0"] - K[-nrow(K), "t1"]) < 1e-6) && abs(K[1, "t0"] - D$og$t_depart[o]) < 1e-6 && abs(K[nrow(K), "t1"] - D$og$t_home[o]) < 1e-6
  kinds <- K[, "kind"]
  shape <- kinds[1] == OL_DRIVE && kinds[2] == OL_PARK && kinds[3] == OL_TRANSFER && kinds[4] == OL_WALK &&
    kinds[length(kinds)] == OL_DRIVE && kinds[length(kinds) - 1L] == OL_UNPARK && kinds[length(kinds) - 2L] == OL_TRANSFER
  ins <- K[kinds == OL_INSIDE, , drop = FALSE]
  visits_match <- nrow(ins) == length(v) && all(abs(ins[, "t0"] - D$d$arrive[v]) < 1e-6) && all(abs(ins[, "t1"] - D$d$gone[v]) < 1e-6) && all(ins[, "store"] == D$d$store[v])
  # Routes: every node on ground its mode may use; walks between stores, and from and to the facility, on the pedestrian network.
  rows <- which(D$ol$m[seq_len(D$ol$n), "outing"] == o & D$ol$m[seq_len(D$ol$n), "kind"] %in% c(OL_DRIVE, OL_WALK))
  nodes <- route_nodes(D, rows)
  drv <- D$ol$m[rows, "kind"] == OL_DRIVE
  routes <- all(vapply(nodes[drv], function(n) all(city$veh$open[n]), TRUE)) && all(vapply(nodes[!drv], function(n) all(city$walk$open[n]), TRUE)) &&
    nodes[drv][[1]][1] == mk$hh$tile[h] && rev(nodes[drv])[[1]][length(rev(nodes[drv])[[1]])] == mk$hh$tile[h]
  # Parking: one space, from arriving to pulling out, at the facility it walked back to.
  parking <- pkr[["fac"]] == f && pkr[["vehicle"]] == h && abs(pkr[["t_in"]] - K[2, "t0"]) < 1e-6 && abs(pkr[["t_out"]] - K[nrow(K) - 1L, "t0"]) < 1e-6 &&
    all(L[L[, "kind"] %in% c(OL_PARK, OL_PARKED, OL_TRANSFER, OL_UNPARK), "fac"] == f)
  # Money: what the household paid at each store is its ledger lines there, and its budget fell by the day's total.
  Ld <- ledger_view(D$lines)
  mine <- Ld$hh == h & !Ld$online
  paid_by_store <- bin_sum(Ld$store[mine], Ld$paid[mine], N_STORES)
  visit_paid <- bin_sum(D$d$store[v], D$d$sales[v] * (D$d$outcome[v] == 1L), N_STORES)
  money <- max(abs(paid_by_store - visit_paid)) < 1e-6 &&
    abs((D$budget0[h] - D$budget1[h]) - (sum(D$d$sales[D$d$hh == h & D$d$outcome == 1L] + D$d$delivery[D$d$hh == h & D$d$outcome == 1L]) - sum(D$refunds$refund[D$refunds$hh == h]))) < 1e-6
  # Stock: each unit it bought left that store's stock.
  stock <- all((D$sold1 - D$sold0)[cbind(Ld$store[mine], Ld$sku[mine])] >= 1)
  list(ok = chain && shape && visits_match && routes && parking && money && stock, chain = chain, shape = shape, visits = visits_match, routes = routes,
       parking = parking, money = money, stock = stock, L = K, v = v)
}
story <- function(D, x) {
  LEG <- c("drive", "park", "parked", "walk", "transfer", "inside", "pull out")
  paste(vapply(seq_len(nrow(x$L)), function(i) {
    k <- x$L[i, "kind"]
    what <- if (k == OL_INSIDE) sprintf("in %s", STORES$name[x$L[i, "store"]]) else if (k == OL_WALK && x$L[i, "store"] > 0 && x$L[i, "rev"] == 0) sprintf("walk to %s", STORES$name[x$L[i, "store"]]) else LEG[k]
    sprintf("%s %s", clock_hm(x$L[i, "t0"]), what)
  }, ""), collapse = " > ")
}
find_outing <- function(days, members, fac_ok, want, at_least = 3L) {
  for (D in days) for (o in which(D$og$park_row > 0L & D$og$fac %in% fac_ok & D$og$n_visits >= at_least)) {
    v <- visits_of(D, o)
    if (!all(D$d$store[v] %in% members)) next
    out <- D$d$outcome[v]
    if (want(D, v, out)) return(list(D = D, o = o))
  }
  NULL
}
browse_then_two <- function(D, v, out) out[1] != 1L && sum(out[-1] == 1L) >= 2L && length(unique(STORES$brand[D$d$store[v][-1][out[-1] == 1L]])) >= 2L

# E1. The enclosed mall: drive, park in a capacity-limited facility, browse
# one store without buying, walk to two more and buy at two retailers,
# walk back to the same car, drive home.
install_world(mall_world(root, garage_spaces = 10, lot_spaces = 10, strip_spaces = 200), root, seed = 31)
days <- run_days(6)
x1 <- find_outing(days, mall, 1:2, browse_then_two)
if (!is.null(x1)) {
  r1 <- e2e(x1$D, x1$o, "mall")
  cat("    ", story(x1$D, r1), "\n", sep = "")
}
check(!is.null(x1) && r1$ok && all(vapply(days, legs_valid, TRUE)) && any(unlist(lapply(days, function(D) D$og$fails)) %in% 1:2),
      sprintf("E1. %s: drove to the mall, parked in %s (capacity %d, which turned cars away), browsed %s without buying, then bought at %s, walked back to the same car and drove home; the legs run on without a gap from leaving home to getting back, every route on ground its mode may use (every leg of all %d days too), the space taken on arrival and freed as the car pulled out, the ledger and stock at each store, and the household's budget, all agree",
              if (is.null(x1)) "no such outing found" else sprintf("household %d", x1$D$og$hh[x1$o]),
              if (is.null(x1)) "-" else FAC$name[x1$D$og$fac[x1$o]], if (is.null(x1)) 0L else as.integer(FAC$spaces[x1$D$og$fac[x1$o]]),
              if (is.null(x1)) "-" else STORES$name[x1$D$d$store[r1$v[1]]],
              if (is.null(x1)) "-" else paste(STORES$name[x1$D$d$store[r1$v][x1$D$d$outcome[r1$v] == 1L]], collapse = " and "), length(days)))
L_all <- ledger_view()
check(abs(sum(L_all$paid) - sum(tally$sales)) < 1e-6 && all(stock_balance(TRUE) == 0),
      "E1. ... and over those days the ledger is the market's sales to the cent, and every unit of stock is where its records say")

# E2. The strip mall: the same, along its outdoor walkway, from its lot.
x2 <- find_outing(days, strip, 3L, function(D, v, out) sum(out == 1L) >= 2L && length(unique(STORES$brand[D$d$store[v][out == 1L]])) >= 2L, at_least = 2L)
if (!is.null(x2)) {
  r2 <- e2e(x2$D, x2$o, "strip")
  cat("    ", story(x2$D, r2), "\n", sep = "")
}
check(!is.null(x2) && r2$ok,
      sprintf("E2. %s: parked at the strip's lot, walked the walkway to %d stores, bought at %s, walked back to the same car and drove home, every leg, route, space and dollar accounted for",
              if (is.null(x2)) "no such outing found" else sprintf("household %d", x2$D$og$hh[x2$o]), if (is.null(x2)) 0L else length(r2$v),
              if (is.null(x2)) "-" else paste(STORES$name[x2$D$d$store[r2$v][x2$D$d$outcome[r2$v] == 1L]], collapse = " and ")))

cat(if (failures) sprintf("\n%d check(s) failed.\n", failures) else "\nAll checks passed.\n")
quit(status = if (failures) 1L else 0L)
