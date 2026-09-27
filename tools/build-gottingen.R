#!/usr/bin/env Rscript
# Builds templates/data/gottingen.rds: the real street network of central
# Göttingen for the zombie outbreak template.
#
# The original notebook downloaded OpenStreetMap data at run time and routed
# with sf/GDAL and dodgr. None of that can run in the browser, so the heavy
# lifting happens here, once:
#
#   1. fetch the walkable streets in the bounding box from Overpass (cached),
#   2. project lon/lat to metres around the box centre,
#   3. keep the largest connected piece of the network,
#   4. contract it to junctions, keeping each street's real geometry,
#   5. pick well-spread destinations and precompute shortest-path trees to
#      each, so a route in the browser is a table lookup, not a search,
#   6. rasterise the streets onto 5 m patches for drawing.
#
#   Rscript tools/build-gottingen.R
#
# Map data © OpenStreetMap contributors, available under the ODbL.

BBOX <- c(south = 51.525, west = 9.925, north = 51.540, east = 9.947)
PATCH_M <- 5                     # metres per patch
N_DESTINATIONS <- 120
PATIENT_ZERO <- list(start = c(lon = 9.9351811, lat = 51.5328328),
                     finish = c(lon = 9.9451256, lat = 51.5308761))

# Street types that pedestrians (and zombies) can use, drawn in three tiers.
TIERS <- list(
  path = c("footway", "path", "steps", "pedestrian", "cycleway", "track", "living_street"),
  street = c("residential", "service", "unclassified"),
  main = c("tertiary", "tertiary_link", "secondary", "secondary_link", "primary", "primary_link")
)

script_path <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
root <- normalizePath(file.path(dirname(script_path), ".."))
cache <- file.path(root, "tools", ".cache", "gottingen-osm.json")
out <- file.path(root, "templates", "data", "gottingen.rds")
dir.create(dirname(out), showWarnings = FALSE, recursive = TRUE)

# ---- 1. OpenStreetMap data --------------------------------------------

if (!file.exists(cache)) {
  query <- sprintf('[out:json][timeout:90];way["highway"](%s,%s,%s,%s);(._;>;);out body;',
                   BBOX["south"], BBOX["west"], BBOX["north"], BBOX["east"])
  message("Downloading streets from Overpass…")
  status <- system2("curl", c("-sS", "-m", "120", "-A", shQuote("NetLogoR-Workbench build script"),
                             "--data-urlencode", shQuote(paste0("data=", query)),
                             "https://overpass-api.de/api/interpreter", "-o", shQuote(cache)))
  if (status != 0) stop("Overpass download failed.")
}

osm <- jsonlite::fromJSON(cache, simplifyVector = FALSE)$elements
types <- vapply(osm, `[[`, "", "type")

nodes <- osm[types == "node"]
node_id <- vapply(nodes, function(n) as.character(n$id), "")
node_lon <- vapply(nodes, `[[`, 0, "lon")
node_lat <- vapply(nodes, `[[`, 0, "lat")

ways <- osm[types == "way"]
highway <- vapply(ways, function(w) if (is.null(w$tags$highway)) NA_character_ else w$tags$highway, "")
blocked <- vapply(ways, function(w) {
  access <- if (is.null(w$tags$access)) "" else w$tags$access
  identical(w$tags$foot, "no") || (access %in% c("private", "no") && !identical(w$tags$foot, "yes"))
}, logical(1))
tier_of <- function(h) {
  for (i in seq_along(TIERS)) if (h %in% TIERS[[i]]) return(i)
  NA_integer_
}
way_tier <- vapply(highway, tier_of, 0L)
keep <- !is.na(way_tier) & !blocked
ways <- ways[keep]
way_tier <- way_tier[keep]

# ---- 2. Project to metres ------------------------------------------------

lat0 <- mean(BBOX[c("south", "north")])
lon0 <- mean(BBOX[c("west", "east")])
EARTH <- 6371008.8
to_metres <- function(lon, lat) {
  cbind(x = EARTH * cos(lat0 * pi / 180) * (lon - lon0) * pi / 180,
        y = EARTH * (lat - lat0) * pi / 180)
}
xy_all <- to_metres(node_lon, node_lat)
rownames(xy_all) <- node_id

inside <- node_lat >= BBOX["south"] & node_lat <= BBOX["north"] &
  node_lon >= BBOX["west"] & node_lon <= BBOX["east"]
names(inside) <- node_id

# Edges between consecutive nodes of each way, clipped to the box.
edge_from <- character(); edge_to <- character(); edge_tier <- integer()
for (i in seq_along(ways)) {
  refs <- vapply(ways[[i]]$nodes, as.character, "")
  if (length(refs) < 2) next
  a <- refs[-length(refs)]
  b <- refs[-1]
  ok <- inside[a] & inside[b] & a != b
  edge_from <- c(edge_from, a[ok]); edge_to <- c(edge_to, b[ok])
  edge_tier <- c(edge_tier, rep(way_tier[i], sum(ok)))
}

# ---- 3. Largest connected component --------------------------------------

used <- unique(c(edge_from, edge_to))
idx <- setNames(seq_along(used), used)
ef <- idx[edge_from]; et <- idx[edge_to]

parent <- seq_along(used)
find <- function(i) { while (parent[i] != i) { parent[i] <<- parent[parent[i]]; i <- parent[i] }; i }
for (k in seq_along(ef)) { ra <- find(ef[k]); rb <- find(et[k]); if (ra != rb) parent[ra] <- rb }
roots <- vapply(seq_along(used), find, 0L)
main <- as.integer(names(which.max(table(roots))))
in_main <- roots == main

keep_edge <- in_main[ef] & in_main[et]
ef <- ef[keep_edge]; et <- et[keep_edge]; edge_tier <- edge_tier[keep_edge]

# Drop duplicate edges (the same pair can appear in two ways).
key <- ifelse(ef < et, paste(ef, et), paste(et, ef))
dup <- duplicated(key)
ef <- ef[!dup]; et <- et[!dup]; edge_tier <- edge_tier[!dup]

xy <- xy_all[used, , drop = FALSE]
message(sprintf("Street network: %d nodes, %d segments in the largest walkable component",
                length(unique(c(ef, et))), length(ef)))

# ---- 4. Contract to junctions ---------------------------------------------

n <- length(used)
adj <- vector("list", n)
for (k in seq_along(ef)) {
  adj[[ef[k]]] <- c(adj[[ef[k]]], et[k])
  adj[[et[k]]] <- c(adj[[et[k]]], ef[k])
}
degree <- lengths(adj)
is_junction <- degree > 0 & degree != 2
junction_nodes <- which(is_junction)
junction_index <- integer(n); junction_index[junction_nodes] <- seq_along(junction_nodes)

seg_len <- function(a, b) sqrt(sum((xy[a, ] - xy[b, ])^2))

# Walk from each junction along each street until the next junction,
# keeping the node chain as the street's geometry.
chains <- list(); chain_from <- integer(); chain_to <- integer(); chain_len <- numeric()
seen_pairs <- new.env()
for (j in junction_nodes) {
  for (first in adj[[j]]) {
    chain <- c(j, first); prev <- j; cur <- first
    while (!is_junction[cur]) {
      nxt <- setdiff(adj[[cur]], prev)
      if (!length(nxt)) break
      prev <- cur; cur <- nxt[1]; chain <- c(chain, cur)
      if (cur == j) break
    }
    if (!is_junction[cur] || cur == j) next
    a <- junction_index[j]; b <- junction_index[cur]
    length_m <- sum(vapply(seq_len(length(chain) - 1), function(i) seg_len(chain[i], chain[i + 1]), 0))
    pair <- paste(min(a, b), max(a, b))
    existing <- seen_pairs[[pair]]
    if (!is.null(existing) && chain_len[existing] <= length_m) next
    if (is.null(existing)) {
      chains[[length(chains) + 1]] <- chain
      chain_from <- c(chain_from, a); chain_to <- c(chain_to, b); chain_len <- c(chain_len, length_m)
      seen_pairs[[pair]] <- length(chains)
    } else {
      chains[[existing]] <- chain; chain_from[existing] <- a; chain_to[existing] <- b; chain_len[existing] <- length_m
    }
  }
}
J <- length(junction_nodes)
message(sprintf("Contracted to %d junctions and %d streets", J, length(chains)))

jadj <- vector("list", J); jw <- vector("list", J)
for (k in seq_along(chains)) {
  a <- chain_from[k]; b <- chain_to[k]
  jadj[[a]] <- c(jadj[[a]], b); jw[[a]] <- c(jw[[a]], chain_len[k])
  jadj[[b]] <- c(jadj[[b]], a); jw[[b]] <- c(jw[[b]], chain_len[k])
}

# ---- 5. Destinations and shortest-path trees ----------------------------

jxy <- xy[junction_nodes, , drop = FALSE]
nearest_junction <- function(lonlat) {
  p <- to_metres(lonlat["lon"], lonlat["lat"])
  which.min((jxy[, 1] - p[1])^2 + (jxy[, 2] - p[2])^2)
}
p0_start <- nearest_junction(PATIENT_ZERO$start)
p0_finish <- nearest_junction(PATIENT_ZERO$finish)

# Farthest-point sampling over real intersections spreads destinations
# evenly across the city.
set.seed(20260921)
candidates <- which(lengths(jadj) >= 3)
dest <- c(p0_finish, sample(candidates, 1))
dmin <- pmin((jxy[candidates, 1] - jxy[dest[1], 1])^2 + (jxy[candidates, 2] - jxy[dest[1], 2])^2,
             (jxy[candidates, 1] - jxy[dest[2], 1])^2 + (jxy[candidates, 2] - jxy[dest[2], 2])^2)
while (length(dest) < N_DESTINATIONS) {
  pick <- candidates[which.max(dmin)]
  dest <- c(dest, pick)
  dmin <- pmin(dmin, (jxy[candidates, 1] - jxy[pick, 1])^2 + (jxy[candidates, 2] - jxy[pick, 2])^2)
}

# Dijkstra from each destination. On an undirected network the tree's
# parent pointer IS the next step towards that destination.
dijkstra_parents <- function(source) {
  dist <- rep(Inf, J); parent <- rep(NA_integer_, J); done <- rep(FALSE, J)
  dist[source] <- 0; parent[source] <- 0L
  repeat {
    open <- which(!done & is.finite(dist))
    if (!length(open)) break
    u <- open[which.min(dist[open])]
    done[u] <- TRUE
    nb <- jadj[[u]]; alt <- dist[u] + jw[[u]]
    better <- alt < dist[nb]
    if (any(better)) { dist[nb[better]] <- alt[better]; parent[nb[better]] <- u }
  }
  parent
}
next_hop <- vapply(dest, dijkstra_parents, integer(J))
message(sprintf("Precomputed shortest-path trees to %d destinations", length(dest)))

# ---- 6. Streets on patches --------------------------------------------------

to_patch <- function(m) m / PATCH_M
min_px <- floor(min(to_patch(xy[, 1]))) - 2; max_px <- ceiling(max(to_patch(xy[, 1]))) + 2
min_py <- floor(min(to_patch(xy[, 2]))) - 2; max_py <- ceiling(max(to_patch(xy[, 2]))) + 2
width <- max_px - min_px + 1; height <- max_py - min_py + 1
streets <- matrix(0L, nrow = height, ncol = width)   # row 1 = top (max pycor)

for (k in seq_along(ef)) {
  a <- to_patch(xy[ef[k], ]); b <- to_patch(xy[et[k], ])
  steps <- max(2, ceiling(sqrt(sum((b - a)^2)) * 3))
  t <- seq(0, 1, length.out = steps)
  px <- round(a[1] + (b[1] - a[1]) * t); py <- round(a[2] + (b[2] - a[2]) * t)
  rows <- max_py - py + 1; cols <- px - min_px + 1
  cells <- cbind(rows, cols)
  streets[cells] <- pmax(streets[cells], edge_tier[k])
}

# ---- Save -------------------------------------------------------------------

city <- list(
  junctions = unname(to_patch(jxy)),                          # J x 2, patch units
  streets = lapply(chains, function(ch) unname(to_patch(xy[ch, , drop = FALSE]))),
  street_from = chain_from, street_to = chain_to,
  destinations = unname(dest),                                # junction indices
  next_hop = unname(next_hop),                                # J x K
  patient_zero = c(start = unname(p0_start), finish = unname(p0_finish)),
  world = c(minPxcor = min_px, maxPxcor = max_px, minPycor = min_py, maxPycor = max_py),
  street_tiers = streets,                                     # 0 none, 1 path, 2 street, 3 main road
  patch_metres = PATCH_M,
  attribution = "Map data © OpenStreetMap contributors (ODbL)"
)
saveRDS(city, out, compress = "xz")
message(sprintf("Wrote %s (%.0f kB): %dx%d patches of %d m",
                file.path("templates", "data", basename(out)), file.size(out) / 1024, width, height, PATCH_M))
