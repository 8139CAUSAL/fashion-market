# Getting about the market: two physical networks read from the painted
# map, the parking the end user has built, and the shopping venues that tie
# stores, their circulation and their parking together.
#
# The map's tiles (city.R) say what the ground is. Who may cross it:
#
#   tile                         car                     on foot
#   .  open land                 no                      yes
#   ~  water                     no                      no
#   p  park                      no                      yes (its paths)
#   w  woodland                  no                      no (paint a trail, -)
#   #  building or barrier       no                      no
#   1-9 homes                    yes, local speed        yes
#   =  street                    yes, road speed         yes (sidewalks)
#   +  road bridge               yes, road speed         yes (footway)
#   H  highway                   yes, road speed         no
#   x  highway crossing          yes, road speed         yes (across it)
#   d  driveway, service road    yes, local speed        yes
#   -  footpath, trail           no                      yes
#   f  footbridge                no                      yes
#   s  pedestrian street, plaza  no                      yes
#   P  surface parking lot       its facility's entrances only   yes
#   G  parking garage            its facility's entrances only   its pedestrian exits only
#   m  enclosed mall             no                      its venue's plan only
#
# Named areas are a layer of their own and never change any of this.
#
# Parking. There is no parking but what the end user has built: each
# facility in macro.parking is a kerb (spaces the user has marked along a
# street), a surface lot (P tiles) or a garage (G tiles, on levels), with
# the spaces the user gave it (never more than its footprint can hold:
# M2_PER_SPACE a space on each level of a lot or garage, KERB_M_PER_SPACE of
# kerb a space on each side of a street tile), the footprint tiles cars
# enter it by (each beside a tile cars can drive on), and the footprint
# tiles people leave it by on foot. A road is connectivity, not permission
# to park. A world without a facility has no driving trips: its households
# can only walk.
#
# Venues. A shopping venue (macro.venues) groups stores: an enclosed mall,
# a strip mall or a walkable district, with the parking it shares. A mall
# is a rectangle of m tiles whose inside is a plan of its own, finer than
# the map (a few metres a cell): corridors (.), walls (#), entrances (E, on
# the plan's edge, opening onto the map tile beyond it) and each member
# store's storefront (a letter, venue.storefronts says whose). A strip mall
# or a district is its stores on the map's own walkable tiles.
#
# The networks are graphs over the map's patches (and the plans' cells),
# each move to one of the eight neighbours without cutting a corner; the
# fields (time, length, next node) toward each target are worked out once
# per world, from the land read off the NetLogoR world with of().

M2_PER_SPACE <- 25                 # a parking space with its share of the aisles, m² (the most a lot's or a garage level's area holds: assumed)
KERB_M_PER_SPACE <- 6              # kerb length a parallel-parked car takes, m (the most a street tile's two kerbs hold: assumed)
PARKING_KINDS <- c("kerb", "lot", "garage")
VENUE_KINDS <- c("mall", "strip", "district")
PLAN_CHARS <- c("#", ".", "E")     # a venue plan: wall, corridor, entrance; a storefront is a lower-case letter
MODE_DRIVE <- 1L; MODE_WALK <- 2L

ROAD_LAND <- c("road", "bridge", "highway", "crossing")
LOCAL_LAND <- c("homes", "driveway")
WALK_LAND <- c("open", "park", "homes", "shops", "road", "bridge", "crossing", "driveway", "footpath", "footbridge", "lot")
KERB_LAND <- c("road", "driveway")          # where a kerb can be marked for parking

drive_speed <- function(land, road_mps, local_mps) {
  sp <- matrix(0, dim(land)[1L], dim(land)[2L])
  sp[land %in% LAND[ROAD_LAND]] <- road_mps
  sp[land %in% LAND[LOCAL_LAND]] <- local_mps
  sp
}
walkable <- function(land) matrix(land %in% LAND[WALK_LAND], dim(land)[1L])
drivable <- function(land) matrix(land %in% LAND[c(ROAD_LAND, LOCAL_LAND)], dim(land)[1L])

# ---- Fields on a graph -------------------------------------------------------------------

# Like grid_fields (grid.R), on any graph of nodes: `half_t` is the time to
# cross half a node (Inf: closed), `half_m` its half width in metres, `nb`
# a nodes x K matrix of neighbours (0: none) and `mult` each column's
# factor (sqrt 2 on a diagonal). A move from a to b costs (half_t[a] +
# half_t[b]) * mult. `targets` is a list of node vectors: each target's
# field leads to the nearest of its nodes. Returns time (s), length (m)
# and next node, nodes x targets.
graph_fields <- function(half_t, half_m, nb, mult, targets) {
  TOL <- 1e-9
  n <- length(half_t); K <- length(targets)
  D <- matrix(Inf, n, K); L <- matrix(Inf, n, K); N <- matrix(0L, n, K)
  if (!K) return(list(time = D, length = L, next_cell = N, n = n))
  tn <- lengths(targets)
  start <- unlist(targets, use.names = FALSE)
  col <- rep(seq_len(K), tn)
  ok <- start > 0L & is.finite(half_t[start])
  pending <- (col[ok] - 1L) * n + start[ok]
  D[pending] <- 0; L[pending] <- 0; N[pending] <- start[ok]
  fin <- half_t[is.finite(half_t)]
  band <- if (length(fin)) 2 * min(fin) else 1
  upto <- 0
  while (length(pending)) {
    upto <- max(upto + band, min(D[pending]))
    repeat {
      due <- D[pending] <= upto
      if (!any(due)) break
      active <- pending[due]; pending <- pending[!due]
      cell <- (active - 1L) %% n + 1L
      base <- active - cell
      improved <- vector("list", dim(nb)[2L])
      for (k in seq_len(dim(nb)[2L])) {
        to_cell <- nb[cell, k]
        ok <- to_cell > 0L
        if (!any(ok)) next
        from <- active[ok]; tc <- to_cell[ok]; to <- base[ok] + tc
        cand <- D[from] + (half_t[cell[ok]] + half_t[tc]) * mult[k]
        better <- cand < D[to] - TOL
        if (!any(better)) next
        to <- to[better]; from <- from[better]; cc <- cell[ok][better]
        D[to] <- cand[better]; L[to] <- L[from] + (half_m[cc] + half_m[tc[better]]) * mult[k]; N[to] <- cc
        improved[[k]] <- to
      }
      pending <- unique(c(pending, unlist(improved, use.names = FALSE)))
    }
  }
  list(time = D, length = L, next_cell = N, n = n)
}

# The nodes of the route from node `from` along field k, to the target.
graph_route <- function(fields, from, k) {
  out <- from; pos <- from
  repeat {
    nx <- fields$next_cell[pos, k]
    if (nx == 0L || nx == pos) break
    out <- c(out, nx); pos <- nx
  }
  out
}

# Neighbours of a grid's open cells, numbered as the grid numbers them
# (column by column), offset by `off`: an n x 8 matrix (grid.R's order:
# N, S, W, E, then the diagonals, which don't cut corners).
grid_nb <- function(H, W, open, off = 0L) {
  nb <- grid_neighbours(H, W, as.vector(open))$cell
  nb[nb > 0L] <- nb[nb > 0L] + off
  nb
}
NB_MULT <- c(1, 1, 1, 1, rep(sqrt(2), 4))

# ---- Reading the parking and venues ------------------------------------------------------

# A list of [row, col] pairs (0-based, as the editors number tiles) as
# linear tile indices of an ny-row map (column-major, as the routing
# numbers them). NA where malformed or off the map.
rc_tiles <- function(x, ny, nx) {
  if (!is.list(x) || !length(x)) return(integer())
  vapply(x, function(p) {
    if (!is.numeric(unlist(p)) || length(unlist(p)) != 2L) return(NA_integer_)
    r <- unlist(p)[1]; c <- unlist(p)[2]
    if (r != round(r) || c != round(c) || r < 0 || r >= ny || c < 0 || c >= nx) return(NA_integer_)
    as.integer(c * ny + r + 1)
  }, 0L)
}
tile_rc <- function(t, ny) cbind((t - 1L) %% ny, (t - 1L) %/% ny)        # 0-based row, col

# The tiles beside (sharing a side with) tile t, on an ny x nx map.
side_tiles <- function(t, ny, nx) {
  r <- (t - 1L) %% ny; c <- (t - 1L) %/% ny
  out <- cbind(ifelse(r > 0, t - 1L, NA), ifelse(r < ny - 1L, t + 1L, NA), ifelse(c > 0, t - ny, NA), ifelse(c < nx - 1L, t + ny, NA))
  out
}

# How many spaces a footprint can hold at most.
parking_max_spaces <- function(kind, n_tiles, levels, patch_m) {
  if (kind == "kerb") return(n_tiles * 2 * floor(patch_m / KERB_M_PER_SPACE))
  floor(n_tiles * patch_m^2 * levels / M2_PER_SPACE)
}

# A venue plan's rows as a character matrix, or NULL.
plan_chars <- function(rows) {
  if (!is.list(rows) && !is.character(rows)) return(NULL)
  rows <- unlist(rows)
  if (!is.character(rows) || !length(rows) || any(nchar(rows) != nchar(rows[1])) || nchar(rows[1]) == 0L) return(NULL)
  do.call(rbind, strsplit(rows, ""))
}

# ---- Checking -----------------------------------------------------------------------------

# Problems with the parking and venues as written (each must be what it
# says it is), into pb. What can't be reached is not a problem with the
# file: transport_warnings() says it.
check_transport <- function(W, pb) {
  M <- W$macro
  if (!is.list(M)) return(invisible())
  ny <- M$height; nx <- M$width
  if (!(is.numeric(ny) && is.numeric(nx) && length(ny) == 1L && length(nx) == 1L)) return(invisible())
  ch <- tryCatch(do.call(rbind, strsplit(unlist(M$tiles), "")), error = function(e) NULL)
  if (is.null(ch) || !identical(dim(ch), c(as.integer(ny), as.integer(nx)))) return(invisible())
  land <- matrix(MAP_CHARS[ch], ny)
  if (anyNA(land)) return(invisible())
  drive_ok <- drivable(land)
  walk_ok <- walkable(land)
  store_ids <- if (is.list(W$stores)) vapply(W$stores, function(s) text_of(s$id), "") else character()
  fac_ids <- character()
  used <- integer()
  if (isTRUE(pb$list_of(M$parking, "macro.parking", 0, 200))) {
    fac_ids <- unique_ids(M$parking, "macro.parking", pb)
    for (i in seq_along(M$parking)) {
      f <- M$parking[[i]]; p <- item_path("macro.parking", i)
      if (!isTRUE(pb$keys(f, p, c("id", "name", "kind", "tiles", "levels", "spaces", "vehicle_access", "pedestrian_access",
                                  "search_s", "level_s", "transfer_s")))) next
      pb$str(f$name, join_path(p, "name"))
      if (!is.character(f$kind) || !isTRUE(one_of(f$kind, join_path(p, "kind"), PARKING_KINDS, pb))) next
      for (k in names(FIELDS$parking)) pb$setting(f[[k]], join_path(p, k), FIELDS$parking[[k]])
      tl <- rc_tiles(f$tiles, ny, nx)
      if (!length(tl) || anyNA(tl)) { pb$add(join_path(p, "tiles"), "must list the facility's tiles as [row, column] pairs on the map"); next }
      if (anyDuplicated(tl)) pb$add(join_path(p, "tiles"), "lists a tile twice")
      want <- switch(f$kind, kerb = LAND[KERB_LAND], lot = LAND[["lot"]], garage = LAND[["garage"]])
      bad <- tl[!(land[tl] %in% want)]
      if (length(bad)) pb$add(join_path(p, "tiles"), sprintf("%d of its tiles aren't %s", length(bad),
                                  switch(f$kind, kerb = "a street or driveway (a kerb is marked along one)", lot = "parking lot tiles (P)", garage = "garage tiles (G)")), tile_rc(bad, ny))
      twice <- tl[tl %in% used]
      if (length(twice) && f$kind != "kerb") pb$add(join_path(p, "tiles"), "shares tiles with another facility", tile_rc(twice, ny))
      used <- c(used, tl)
      if (f$kind != "garage" && is.numeric(f$levels) && f$levels != 1) pb$add(join_path(p, "levels"), sprintf("a %s has one level", f$kind))
      if (is.numeric(f$spaces) && is.numeric(f$levels) && is.numeric(M$patch_m)) {
        most <- parking_max_spaces(f$kind, length(unique(tl)), f$levels, M$patch_m)
        if (f$spaces > most) pb$add(join_path(p, "spaces"), sprintf("%s spaces won't fit: its %d tile%s hold at most %s", json_number(f$spaces), length(unique(tl)), if (length(unique(tl)) == 1L) "" else "s", json_number(most)), tile_rc(tl, ny))
      }
      for (side in c("vehicle_access", "pedestrian_access")) {
        a <- rc_tiles(f[[side]], ny, nx)
        what <- if (side == "vehicle_access") "vehicle entrance" else "pedestrian exit"
        if (!length(a)) { pb$add(join_path(p, side), sprintf("needs at least one %s: a tile of the facility", what)); next }
        if (anyNA(a)) { pb$add(join_path(p, side), "must be [row, column] pairs on the map"); next }
        off <- a[!(a %in% tl)]
        if (length(off)) pb$add(join_path(p, side), sprintf("each %s must be one of the facility's own tiles", what), tile_rc(off, ny))
      }
    }
  }
  if (!isTRUE(pb$list_of(M$venues, "macro.venues", 0, 40))) return(invisible())
  unique_ids(M$venues, "macro.venues", pb)
  member <- character()
  for (i in seq_along(M$venues)) {
    v <- M$venues[[i]]; p <- item_path("macro.venues", i)
    if (!isTRUE(pb$keys(v, p, c("id", "name", "kind", "stores", "parking", "tiles", "plan", "storefronts"), c("id", "name", "kind", "stores", "parking")))) next
    pb$str(v$name, join_path(p, "name"))
    kind_ok <- is.character(v$kind) && isTRUE(one_of(v$kind, join_path(p, "kind"), VENUE_KINDS, pb))
    st <- check_id_list(v$stores, join_path(p, "stores"), store_ids, "store", pb)
    if (is.list(v$stores) && !length(v$stores)) pb$add(join_path(p, "stores"), "a venue needs at least one store")
    again <- intersect(unlist(v$stores), member)
    if (length(again)) pb$add(join_path(p, "stores"), sprintf("%s already belongs to another venue", paste(again, collapse = ", ")))
    member <- c(member, unlist(v$stores))
    check_id_list(v$parking, join_path(p, "parking"), fac_ids, "parking facility", pb)
    if (!kind_ok) next
    if (v$kind == "mall") {
      tl <- rc_tiles(v$tiles, ny, nx)
      if (!length(tl) || anyNA(tl)) { pb$add(join_path(p, "tiles"), "a mall needs its building's tiles, as [row, column] pairs"); next }
      rc <- tile_rc(tl, ny)
      r0 <- min(rc[, 1]); r1 <- max(rc[, 1]); c0 <- min(rc[, 2]); c1 <- max(rc[, 2])
      box <- as.vector(outer(r0:r1, c0:c1, function(r, c) c * ny + r + 1))
      if (length(unique(tl)) != length(box) || !all(box %in% tl)) pb$add(join_path(p, "tiles"), "a mall's building must be a rectangle of tiles", rc)
      notm <- tl[land[tl] != LAND[["mall"]]]
      if (length(notm)) pb$add(join_path(p, "tiles"), "a mall's tiles must be mall building tiles (m)", tile_rc(notm, ny))
      if (!is.list(v$plan)) { pb$add(join_path(p, "plan"), "a mall needs a plan of its corridors, entrances and storefronts"); next }
      if (!isTRUE(pb$keys(v$plan, join_path(p, "plan"), c("cell_m", "rows")))) next
      if (!isTRUE(pb$setting(v$plan$cell_m, join_path(p, "plan", "cell_m"), FIELDS$venue_plan$cell_m))) next
      k <- M$patch_m / v$plan$cell_m
      if (abs(k - round(k)) > 1e-9) { pb$add(join_path(p, "plan", "cell_m"), sprintf("a map tile (%s m) must hold a whole number of plan cells", json_number(M$patch_m))); next }
      pc <- plan_chars(v$plan$rows)
      if (is.null(pc)) { pb$add(join_path(p, "plan", "rows"), "must be a list of text rows of one width"); next }
      want <- c((r1 - r0 + 1) * round(k), (c1 - c0 + 1) * round(k))
      if (!identical(as.numeric(dim(pc)), as.numeric(want))) { pb$add(join_path(p, "plan", "rows"), sprintf("is %d x %d cells; the building is %d x %d cells (%d x %d tiles of %s m at %s m a cell)",
                                                                             ncol(pc), nrow(pc), want[2], want[1], c1 - c0 + 1, r1 - r0 + 1, json_number(M$patch_m), json_number(v$plan$cell_m))); next }
      fronts <- v$storefronts
      letters_ok <- if (is.null(fronts)) character() else names(fronts)
      if (!is.null(fronts) && (!is.list(fronts) || is.null(names(fronts)))) pb$add(join_path(p, "storefronts"), "must map a plan letter to a store")
      bad <- which(!(pc %in% c(PLAN_CHARS, letters_ok)))
      if (length(bad)) pb$add(join_path(p, "plan", "rows"), sprintf("%d cells aren't a wall, a corridor, an entrance or a storefront named in storefronts (\"%s\" is the first)", length(bad), pc[bad[1]]))
      for (L in letters_ok) {
        if (!grepl("^[a-z]$", L)) pb$add(join_path(p, "storefronts", L), "a storefront is a lower-case letter")
        sid <- text_of(fronts[[L]])
        if (!(sid %in% unlist(v$stores))) pb$add(join_path(p, "storefronts", L), sprintf("%s isn't one of the mall's stores", json_value(fronts[[L]], "")))
        if (!any(pc == L)) pb$add(join_path(p, "storefronts", L), "has no cell on the plan")
      }
      miss <- setdiff(unlist(v$stores), vapply(fronts, text_of, ""))
      if (length(miss)) pb$add(join_path(p, "storefronts"), sprintf("%s %s no storefront on the plan", paste(miss, collapse = ", "), if (length(miss) == 1L) "has" else "have"))
      ent <- which(pc == "E", arr.ind = TRUE)
      if (!nrow(ent)) pb$add(join_path(p, "plan", "rows"), "a mall needs an entrance (E) on its plan's edge")
      inner <- ent[!(ent[, 1] %in% c(1, nrow(pc)) | ent[, 2] %in% c(1, ncol(pc))), , drop = FALSE]
      if (nrow(inner)) pb$add(join_path(p, "plan", "rows"), "an entrance (E) must be on the plan's edge")
    } else if (!is.null(v$plan) || !is.null(v$tiles)) {
      pb$add(p, sprintf("a %s is its stores on the map's own walkable tiles: only a mall has tiles and a plan", if (v$kind == "strip") "strip mall" else "district"))
    }
  }
  # A store in a mall stands in its building.
  for (i in seq_along(W$stores)) {
    s <- W$stores[[i]]
    if (is.null(s$venue)) next
    vi <- match(text_of(s$venue), vapply(M$venues, function(v) text_of(v$id), ""))
    if (is.na(vi)) { pb$add(join_path(item_path("stores", i), "venue"), sprintf("no venue called %s", json_value(s$venue, ""))); next }
    if (!(s$id %in% unlist(M$venues[[vi]]$stores))) pb$add(join_path(item_path("stores", i), "venue"), sprintf("%s doesn't list it among its stores", M$venues[[vi]]$name))
  }
  invisible()
}

# ---- Installing ---------------------------------------------------------------------------

FAC <- NULL; N_FAC <- 0L; VENUES <- NULL; N_VENUES <- 0L; STORE_VENUE <- integer()

# The facilities and venues of a checked world (after macro_install and
# the stores): tables the networks and the outings read.
transport_install <- function(W) {
  M <- W$macro; ny <- MACRO$ny; nx <- MACRO$nx
  fs <- M$parking %||% list()
  FAC <<- data.frame(id = vapply(fs, function(f) f$id, ""), name = vapply(fs, function(f) f$name, ""),
                     kind = vapply(fs, function(f) f$kind, ""), stringsAsFactors = FALSE)
  for (k in names(FIELDS$parking)) FAC[[k]] <<- vapply(fs, function(f) as.numeric(f[[k]]), 0)
  FAC$tiles <<- lapply(fs, function(f) rc_tiles(f$tiles, ny, nx))
  FAC$veh <<- lapply(fs, function(f) rc_tiles(f$vehicle_access, ny, nx))
  FAC$ped <<- lapply(fs, function(f) rc_tiles(f$pedestrian_access, ny, nx))
  N_FAC <<- nrow(FAC)
  vs <- M$venues %||% list()
  VENUES <<- data.frame(id = vapply(vs, function(v) v$id, ""), name = vapply(vs, function(v) v$name, ""),
                        kind = vapply(vs, function(v) v$kind, ""), stringsAsFactors = FALSE)
  VENUES$stores <<- lapply(vs, function(v) match(unlist(v$stores), STORES$id))
  VENUES$parking <<- lapply(vs, function(v) match(unlist(v$parking), FAC$id))
  VENUES$tiles <<- lapply(vs, function(v) rc_tiles(v$tiles, ny, nx))
  VENUES$plan <<- lapply(vs, function(v) if (is.list(v$plan)) list(cell_m = as.numeric(v$plan$cell_m), chars = plan_chars(v$plan$rows),
                                                                   fronts = vapply(v$storefronts %||% list(), text_of, "")) else NULL)
  N_VENUES <<- nrow(VENUES)
  STORE_VENUE <<- integer(N_STORES)
  for (k in seq_len(N_VENUES)) STORE_VENUE[VENUES$stores[[k]]] <<- k
}

# The two networks of a world: its nodes (the map's tiles, then each
# mall's plan cells), where each node is (metres from the south-west
# corner), who can cross it, and the store entrances and parking access
# points on them. `land` is the map read off the NetLogoR world.
transport_graphs <- function(land, M = MACRO, fac = FAC, ven = VENUES, store_xy = cbind(STORES$x, STORES$y), store_id = STORES$id) {
  ny <- dim(land)[1L]; nx <- dim(land)[2L]; patch <- M$patch_m; nM <- ny * nx
  tile_xy <- cbind(((seq_len(nM) - 1L) %/% ny + 0.5) * patch, (ny - (seq_len(nM) - 1L) %% ny - 0.5) * patch)
  # Vehicles: the drivable tiles.
  vsp <- as.vector(drive_speed(land, M$road_mps, M$local_mps))
  vopen <- vsp > 0
  vhalf <- rep(Inf, nM); vhalf[vopen] <- 0.5 * patch / vsp[vopen]
  vnb <- grid_nb(ny, nx, vopen)
  # Pedestrians: walkable tiles, the pedestrian exits of garages, and
  # each mall's plan cells.
  wopen <- as.vector(walkable(land))
  for (k in seq_len(N_FAC_of(fac))) if (fac$kind[k] == "garage") wopen[fac$ped[[k]]] <- TRUE
  wnb <- grid_nb(ny, nx, wopen)
  half_m <- rep(patch / 2, nM)
  node_xy <- tile_xy
  links <- matrix(0L, 0, 2)
  plans <- list()
  off <- nM
  for (v in seq_len(if (is.null(ven)) 0L else nrow(ven))) {
    pl <- ven$plan[[v]]
    if (ven$kind[v] != "mall" || is.null(pl) || is.null(pl$chars)) next
    pc <- pl$chars; PH <- nrow(pc); PW <- ncol(pc); cm <- pl$cell_m; kk <- round(patch / cm)
    rc <- tile_rc(ven$tiles[[v]], ny); r0 <- min(rc[, 1]); c0 <- min(rc[, 2])
    popen <- as.vector(pc != "#")
    pnb <- grid_nb(PH, PW, popen, off)
    pi <- seq_len(PH * PW)
    prow <- (pi - 1L) %% PH; pcol <- (pi - 1L) %/% PH                  # 0-based
    pxy <- cbind(c0 * patch + (pcol + 0.5) * cm, (ny - r0) * patch - (prow + 0.5) * cm)
    # Entrances on the edge open onto the map tile beyond that edge.
    ent <- which(as.vector(pc == "E"))
    for (e in ent) {
      r <- prow[e]; c <- pcol[e]
      out <- rbind(if (r == 0) c(r0 - 1, c0 + c %/% kk), if (r == PH - 1) c(r0 + PH / kk, c0 + c %/% kk),
                   if (c == 0) c(r0 + r %/% kk, c0 - 1), if (c == PW - 1) c(r0 + r %/% kk, c0 + PW / kk))
      for (j in seq_len(NROW(out))) {
        rr <- out[j, 1]; cc <- out[j, 2]
        if (rr < 0 || rr >= ny || cc < 0 || cc >= nx) next
        t <- cc * ny + rr + 1
        if (wopen[t]) links <- rbind(links, c(off + e, t))
      }
    }
    fronts <- pl$fronts
    plans[[length(plans) + 1L]] <- list(venue = v, off = off, PH = PH, PW = PW, chars = pc, cell_m = cm, r0 = r0, c0 = c0,
                                        front_node = vapply(names(fronts), function(L) {
                                          cells <- which(as.vector(pc == L)); if (!length(cells)) return(NA_integer_)
                                          as.integer(off + cells[ceiling(length(cells) / 2)]) }, 0L), front_store = match(fronts, store_id))
    wnb <- rbind(wnb, pnb)
    half_m <- c(half_m, rep(cm / 2, PH * PW))
    wopen <- c(wopen, popen)
    node_xy <- rbind(node_xy, pxy)
    off <- off + PH * PW
  }
  n <- off
  # Links: extra neighbour columns, both ways.
  if (nrow(links)) {
    pairs <- rbind(links, links[, 2:1, drop = FALSE])
    deg <- tabulate(pairs[, 1], n)
    extra <- matrix(0L, n, max(deg))
    slot <- ave(pairs[, 1], pairs[, 1], FUN = seq_along)
    extra[cbind(pairs[, 1], slot)] <- pairs[, 2]
    wnb <- cbind(wnb, extra)
  }
  wmult <- c(NB_MULT, rep(1, dim(wnb)[2L] - 8L))
  whalf <- rep(Inf, n); whalf[wopen] <- half_m[wopen] / M$walk_mps
  # Store entrances: a mall store's storefront, any other store's pin.
  ns <- nrow(store_xy)
  entrance <- tile_of(store_xy[, 1], store_xy[, 2], patch, ny)
  in_mall <- rep(FALSE, ns)
  for (pl in plans) {
    ok <- !is.na(pl$front_store) & !is.na(pl$front_node)
    entrance[pl$front_store[ok]] <- pl$front_node[ok]; in_mall[pl$front_store[ok]] <- TRUE
  }
  # Parking: cars reach a lot or a garage at the drivable tiles beside its
  # vehicle entrances; a kerb on its own street tiles. People leave it at
  # its pedestrian exits (a kerb: its street tiles).
  F <- N_FAC_of(fac)
  approach <- vector("list", F); exits <- vector("list", F)
  for (k in seq_len(F)) {
    if (fac$kind[k] == "kerb") {
      approach[[k]] <- fac$tiles[[k]][vopen[fac$tiles[[k]]]]
    } else {
      sides <- as.vector(side_tiles(fac$veh[[k]], ny, nx))
      approach[[k]] <- unique(sides[!is.na(sides) & vopen[sides]])
    }
    e <- fac$ped[[k]]
    exits[[k]] <- e[wopen[e]]
  }
  list(ny = ny, nx = nx, nM = nM, n = n, patch = patch, node_xy = node_xy, plans = plans,
       veh = list(half_t = vhalf, half_m = rep(patch / 2, nM), nb = vnb, mult = NB_MULT, open = vopen),
       walk = list(half_t = whalf, half_m = half_m, nb = wnb, mult = wmult, open = wopen),
       entrance = entrance, in_mall = in_mall, approach = approach, exits = exits)
}
N_FAC_of <- function(fac) if (is.null(fac)) 0L else nrow(fac)

# Everything worked out once per world: both graphs, the fields toward
# every store entrance (on foot) and every facility (by car), and from
# them each facility's walk to each store.
build_transport <- function(G) {
  wf <- graph_fields(G$walk$half_t, G$walk$half_m, G$walk$nb, G$walk$mult, as.list(G$entrance))
  # By car, a field toward each node a car reaches a facility at (so a
  # drive home can retrace the way it came, from the node it arrived at).
  F <- length(G$approach); S <- length(G$entrance)
  vnodes <- as.integer(unlist(G$approach)); vnode_fac <- rep(seq_len(F), lengths(G$approach))
  vf <- graph_fields(G$veh$half_t, G$veh$half_m, G$veh$nb, G$veh$mult, as.list(vnodes))
  fw_t <- matrix(Inf, F, S); fw_m <- matrix(Inf, F, S); fw_node <- matrix(0L, F, S)
  for (k in seq_len(F)) {
    e <- G$exits[[k]]
    if (!length(e)) next
    for (s in seq_len(S)) {
      j <- which.min(wf$time[e, s])
      if (length(j) && is.finite(wf$time[e[j], s])) { fw_t[k, s] <- wf$time[e[j], s]; fw_m[k, s] <- wf$length[e[j], s]; fw_node[k, s] <- e[j] }
    }
  }
  c(G, list(wf = wf, vf = vf, vnodes = vnodes, vnode_fac = vnode_fac, fw_t = fw_t, fw_m = fw_m, fw_node = fw_node))
}

# Driving time and length from tiles to facility k: the quickest of its nodes.
fac_time <- function(T, tile, k) {
  cols <- which(T$vnode_fac == k)
  if (!length(cols)) return(list(t = rep(Inf, length(tile)), m = rep(Inf, length(tile))))
  tm <- matrix(T$vf$time[tile, cols, drop = FALSE], length(tile))
  best <- row_max(-tm)
  list(t = -best$max, m = T$vf$length[cbind(tile, cols[best$k])])
}

# ---- Travel costs --------------------------------------------------------------------------

# The generalized cost of getting from home tiles `tile` (households of
# segments `seg`, with or without a car) to every store, one way, in
# utility (market.R): for each store the cheaper of walking (if a walk
# exists within the longest walk) and driving (with a car, to the
# facility that makes the whole trip cheapest: driving, then finding a
# space and getting out of the facility, then walking to the store's
# door, no further than the longest walk):
#
#   cost = segment km x (drive_w x drive min + park_w x parking min + walk_w x walk min)
#
# plus, for a facility the household has failed to park at lately, the
# memory of it (grudge_w x its weight, as a bad visit is remembered).
# Returns cost, mode (1 drive, 2 walk, 0 none), facility, and the route's
# km (for the segment's radius), households x stores.
travel_costs <- function(tile, seg, car, T = city, fail = NULL) {
  n <- length(tile); S <- length(T$entrance); F <- length(T$approach)
  kap <- SEGMENTS$km[seg]
  maxw <- P$max_walk_km * 1000
  wt <- matrix(T$wf$time[tile, , drop = FALSE], n); wm <- matrix(T$wf$length[tile, , drop = FALSE], n)
  cost <- kap * P$walk_w * wt / 60
  cost[!(wm <= maxw)] <- Inf
  km <- wm / 1000; km[!is.finite(cost)] <- Inf
  mode <- matrix(ifelse_int(is.finite(cost), MODE_WALK, 0L), n); fac <- matrix(0L, n, S)
  for (k in seq_len(F)) {
    ft <- fac_time(T, tile, k); dt <- ft$t; dm <- ft$m
    dt[!car] <- Inf
    pk <- (FAC$search_s[k] + FAC$transfer_s[k]) / 60
    walk_ok <- T$fw_m[k, ] <= maxw
    c1 <- kap * (P$drive_w * dt / 60 + P$park_w * pk) + if (is.null(fail)) 0 else P$grudge_w * fail[, k]
    ck <- outer(c1, rep(1, S)) + outer(kap * P$walk_w, T$fw_t[k, ] / 60)
    ck[, !walk_ok] <- Inf
    better <- ck < cost
    better[is.na(better)] <- FALSE
    if (any(better)) {
      cost[better] <- ck[better]; mode[better] <- MODE_DRIVE; fac[better] <- k
      km[better] <- (outer(dm, rep(1, S)) + outer(rep(1, n), T$fw_m[k, ]))[better] / 1000
    }
  }
  list(cost = cost, mode = mode, fac = fac, km = km)
}

# ---- What can't be reached ------------------------------------------------------------------

# Every way the world's networks fail its shoppers, worked out from the
# same graphs the simulation uses: a list of list(path, message, tiles).
# None of these stops a world being set up; each means some trips can't
# happen, and the simulation doesn't let them.
transport_warnings <- function(T, land, home_tiles, fac = FAC, ven = VENUES, store_names = STORES$name, store_venue = STORE_VENUE) {
  out <- list()
  add <- function(path, message, tiles = NULL) out[[length(out) + 1L]] <<- list(path = path, message = message, tiles = tiles)
  ny <- T$ny; nx <- T$nx; S <- length(T$entrance); F <- length(T$approach)
  homes <- unique(home_tiles)
  rc <- function(t) if (length(t)) tile_rc(t, ny) else NULL
  if (!F) add("macro.parking", "no parking has been built: households can't drive anywhere, only walk")
  # Facilities.
  for (k in seq_len(F)) {
    p <- item_path("macro.parking", k)
    if (!length(T$approach[[k]])) add(p, sprintf("%s: no vehicle entrance touches a street, driveway or homes tile, so no car can get in", fac$name[k]), rc(fac$veh[[k]]))
    else if (length(homes) && !any(is.finite(fac_time(T, homes, k)$t))) add(p, sprintf("%s: no home can reach it by road", fac$name[k]), rc(fac$tiles[[k]]))
    if (!length(T$exits[[k]])) add(p, sprintf("%s: its pedestrian exits open onto nothing walkable", fac$name[k]), rc(fac$ped[[k]]))
    else if (!any(T$fw_m[k, ] <= P$max_walk_km * 1000)) add(p, sprintf("%s: no store's door can be walked to from it within %s km", fac$name[k], json_number(P$max_walk_km)), rc(fac$tiles[[k]]))
  }
  # Parking tiles that belong to no facility.
  used <- unlist(fac$tiles)
  loose <- which(land %in% LAND[c("lot", "garage")]); loose <- loose[!(loose %in% used)]
  if (length(loose)) add("macro.tiles", sprintf("%d parking tiles aren't part of any facility: no one can park there", length(loose)), rc(loose))
  # Stores.
  fac_reached <- vapply(seq_len(F), function(k) length(homes) > 0 && any(is.finite(fac_time(T, homes, k)$t)), TRUE)
  for (s in seq_len(S)) {
    p <- item_path("stores", s)
    e <- T$entrance[s]
    if (!is.finite(T$walk$half_t[e])) { add(p, sprintf("%s: its door opens onto ground no one can walk on", store_names[s]), if (e <= T$nM) rc(e)); next }
    by_car <- F > 0 && any(T$fw_m[, s] <= P$max_walk_km * 1000 & fac_reached)
    on_foot <- length(homes) && any(T$wf$length[homes, s] <= P$max_walk_km * 1000)
    if (!by_car && !on_foot) add(p, sprintf("%s: no household can reach it, by car (no reachable parking within %s km of its door) or on foot", store_names[s], json_number(P$max_walk_km)), if (e <= T$nM) rc(e))
    else if (!by_car) add(p, sprintf("%s: no parking within %s km of its door that a car can reach: only walkers can come", store_names[s], json_number(P$max_walk_km)), if (e <= T$nM) rc(e))
  }
  # Roads that don't join the network most homes use.
  vopen <- T$veh$open
  comp <- graph_components(T$veh$nb, vopen)
  if (max(comp) > 1L) {
    main <- as.integer(names(which.max(table(comp[comp > 0]))))
    off <- which(comp > 0 & comp != main & land %in% LAND[ROAD_LAND])
    if (length(off)) add("macro.tiles", sprintf("%d road tiles aren't connected to the main road network", length(off)), rc(off))
  }
  # Footpaths that lead nowhere.
  wcomp <- graph_components(T$walk$nb, T$walk$open)
  path_t <- which(land %in% LAND[c("footpath", "footbridge")])
  if (length(path_t)) {
    big <- as.integer(names(which.max(table(wcomp[wcomp > 0]))))
    lone <- path_t[wcomp[path_t] != big]
    if (length(lone)) add("macro.tiles", sprintf("%d footpath tiles aren't connected to the main pedestrian network (crossing ground no one can walk on?)", length(lone)), rc(lone))
  }
  # Venues: every store reachable on foot from every other, and from the parking it shares.
  for (v in seq_len(if (is.null(ven)) 0L else nrow(ven))) {
    p <- item_path("macro.venues", v)
    st <- ven$stores[[v]]; st <- st[!is.na(st)]
    if (length(st) > 1L) {
      apart <- outer(st, st, function(a, b) !is.finite(T$wf$time[cbind(T$entrance[a], b)]))
      if (any(apart)) {
        bad <- st[.rowSums(apart, length(st), length(st)) > 0]
        add(p, sprintf("%s: %s can't be walked to from the venue's other stores", ven$name[v], paste(store_names[bad], collapse = ", ")),
            rc(T$entrance[bad][T$entrance[bad] <= T$nM]))
      }
    }
    for (k in ven$parking[[v]]) {
      far <- st[!(T$fw_m[k, st] <= P$max_walk_km * 1000)]
      if (length(far)) add(p, sprintf("%s: from %s, %s can't be walked to", ven$name[v], fac$name[k], paste(store_names[far], collapse = ", ")), rc(fac$tiles[[k]]))
    }
    if (ven$kind[v] == "mall") {
      pl <- Filter(function(x) x$venue == v, T$plans)
      if (length(pl)) {
        pl <- pl[[1]]
        ent <- pl$off + which(as.vector(pl$chars == "E"))
        linked <- ent[vapply(ent, function(e) any(T$walk$nb[e, -(1:8)] > 0 & T$walk$nb[e, -(1:8)] <= T$nM), TRUE)]
        if (!length(linked)) add(p, sprintf("%s: none of its entrances opens onto walkable ground outside", ven$name[v]), rc(ven$tiles[[v]]))
        for (s in st) if (!length(linked) || !any(is.finite(T$wf$time[linked, s]))) add(p, sprintf("%s: %s's storefront can't be reached from any entrance", ven$name[v], store_names[s]))
      }
    }
  }
  out
}

# Connected components of a graph's open nodes (0: closed).
graph_components <- function(nb, open) {
  n <- length(open); comp <- integer(n); id <- 0L
  for (s in which(open)) {
    if (comp[s]) next
    id <- id + 1L; front <- s; comp[s] <- id
    while (length(front)) {
      nx <- as.vector(nb[front, , drop = FALSE]); nx <- unique(nx[nx > 0L])
      nx <- nx[comp[nx] == 0L & open[nx]]
      comp[nx] <- id; front <- nx
    }
  }
  comp
}
