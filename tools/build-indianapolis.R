#!/usr/bin/env Rscript
# Builds the real road network of Indianapolis for two templates:
# templates/data/indianapolis.rds for the promotion-and-supply-chain
# template (steps 1-7), and templates/data/indianapolis-twin.rds for the
# digital twin (steps 8-11).
#
# The browser can't route or read OpenStreetMap, so the heavy lifting
# happens here, once:
#
#   1. fetch the drivable roads (tertiary and up) in the box from Overpass
#      (cached),
#   2. project lon/lat to metres around the box centre,
#   3. keep the largest connected piece of the network,
#   4. contract it to junctions, keeping each road's real geometry,
#   5. place the fictional business on it: one distribution centre on the
#      west side by I-70, ten stores spread where the road network (a proxy
#      for where people live) is densest, and the point where trucks from
#      the plant enter the map on I-70 east,
#   6. find each truck's fastest route, timing roads by type (Dijkstra
#      from the DC),
#   7. rasterise the roads onto 100 m patches for drawing, and keep points
#      along the smaller roads as candidate homes for households,
#   8. fetch the real supermarkets in the box (cached) and put each on the
#      road network,
#   9. pick the fictional chain's stores among them, and its Store A,
#  10. find the fastest route from every junction to every supermarket
#      (Dijkstra from each), so a shopper's drive in the browser is a
#      lookup,
#  11. simplify each road's geometry, timed along its length, and put each
#      candidate home on the network.
#
#   Rscript tools/build-indianapolis.R
#
# The map and the supermarkets' sites are real; the retailer, its stores,
# its DC and its households are not. Map data © OpenStreetMap contributors,
# available under the ODbL.

BBOX <- c(south = 39.62, west = -86.36, north = 39.93, east = -85.94)
PATCH_M <- 100                   # metres per patch
N_STORES <- 10
HOME_SPACING_M <- 150            # one candidate home every 150 m of road
DC_NEAR <- c(lon = -86.27, lat = 39.735)      # west side, by I-70 and I-465
PLANT_ROAD <- "I 70"                          # trucks from the plant come in on I-70 from the east
SPEED_KMH <- c(tertiary = 40, secondary = 50, primary = 60, motorway = 100)   # for routing trucks

TIERS <- list(
  tertiary = c("tertiary"),
  secondary = c("secondary", "secondary_link"),
  primary = c("primary", "primary_link", "trunk", "trunk_link"),
  motorway = c("motorway", "motorway_link")
)

script_path <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
root <- normalizePath(file.path(dirname(script_path), ".."))
cache <- file.path(root, "tools", ".cache", "indy-osm.json")
out <- file.path(root, "templates", "data", "indianapolis.rds")
dir.create(dirname(out), showWarnings = FALSE, recursive = TRUE)

# ---- 1. OpenStreetMap data --------------------------------------------

# Runs an Overpass query into `file`, unless it's there already. The main
# Overpass server is often too busy for a query this size; the mirrors
# serve the same data.
overpass <- function(query, file, what) {
  if (file.exists(file)) return(invisible(file))
  servers <- c("https://overpass-api.de/api/interpreter",
               "https://overpass.kumi.systems/api/interpreter",
               "https://overpass.private.coffee/api/interpreter",
               "https://overpass.openstreetmap.fr/api/interpreter",
               "https://maps.mail.ru/osm/tools/overpass/api/interpreter")
  for (server in servers) {
    message("Downloading ", what, " from ", server, "…")
    status <- system2("curl", c("-sS", "-m", "300", "-A", shQuote("NetLogoR-Workbench build script"),
                               "--data-urlencode", shQuote(paste0("data=", query)),
                               server, "-o", shQuote(file)))
    if (status == 0 && identical(readChar(file, 1), "{")) return(invisible(file))
    unlink(file)
  }
  stop("Every Overpass server failed; try again later.")
}

pattern <- paste(unlist(TIERS), collapse = "|")
overpass(sprintf('[out:json][timeout:180];way["highway"~"^(%s)$"](%s,%s,%s,%s);(._;>;);out body;',
                 pattern, BBOX["south"], BBOX["west"], BBOX["north"], BBOX["east"]),
         cache, "roads")

osm <- jsonlite::fromJSON(cache, simplifyVector = FALSE)$elements
types <- vapply(osm, `[[`, "", "type")

nodes <- osm[types == "node"]
node_id <- vapply(nodes, function(n) as.character(n$id), "")
node_lon <- vapply(nodes, `[[`, 0, "lon")
node_lat <- vapply(nodes, `[[`, 0, "lat")

ways <- osm[types == "way"]
highway <- vapply(ways, function(w) if (is.null(w$tags$highway)) NA_character_ else w$tags$highway, "")
road_ref <- vapply(ways, function(w) if (is.null(w$tags$ref)) "" else w$tags$ref, "")
tier_of <- function(h) {
  for (i in seq_along(TIERS)) if (h %in% TIERS[[i]]) return(i)
  NA_integer_
}
way_tier <- vapply(highway, tier_of, 0L)
keep <- !is.na(way_tier)
ways <- ways[keep]; way_tier <- way_tier[keep]; road_ref <- road_ref[keep]

# ---- 2. Project to metres ------------------------------------------------

lat0 <- mean(BBOX[c("south", "north")])
lon0 <- mean(BBOX[c("west", "east")])
EARTH <- 6371008.8
to_metres <- function(lon, lat) {
  cbind(x = EARTH * cos(lat0 * pi / 180) * (lon - lon0) * pi / 180,
        y = EARTH * (lat - lat0) * pi / 180)
}
xy_all <- to_metres(node_lon, node_lat)

inside <- node_lat >= BBOX["south"] & node_lat <= BBOX["north"] &
  node_lon >= BBOX["west"] & node_lon <= BBOX["east"]

# Edges between consecutive nodes of each way, clipped to the box, as
# indices into the node table (one match() for all of them).
way_refs <- lapply(ways, function(w) vapply(w$nodes, as.character, ""))
way_len <- lengths(way_refs)
refs <- match(unlist(way_refs), node_id)
way_of <- rep(seq_along(ways), way_len)
last <- cumsum(way_len)
from_at <- setdiff(seq_along(refs), last)          # every node but each way's last
edge_from <- refs[from_at]; edge_to <- refs[from_at + 1L]
edge_way <- way_of[from_at]
ok <- inside[edge_from] & inside[edge_to] & edge_from != edge_to
edge_from <- edge_from[ok]; edge_to <- edge_to[ok]; edge_way <- edge_way[ok]
edge_tier <- way_tier[edge_way]

# ---- 3. Largest connected component --------------------------------------

used <- unique(c(edge_from, edge_to))
ef <- match(edge_from, used); et <- match(edge_to, used)

parent <- seq_along(used)
find <- function(i) { while (parent[i] != i) { parent[i] <<- parent[parent[i]]; i <- parent[i] }; i }
for (k in seq_along(ef)) { ra <- find(ef[k]); rb <- find(et[k]); if (ra != rb) parent[ra] <- rb }
roots <- vapply(seq_along(used), find, 0L)
main <- as.integer(names(which.max(table(roots))))
in_main <- roots == main

keep_edge <- in_main[ef] & in_main[et]
ef <- ef[keep_edge]; et <- et[keep_edge]; edge_tier <- edge_tier[keep_edge]; edge_way <- edge_way[keep_edge]

# Drop duplicate edges (the same pair can appear in two ways).
key <- ifelse(ef < et, paste(ef, et), paste(et, ef))
dup <- duplicated(key)
ef <- ef[!dup]; et <- et[!dup]; edge_tier <- edge_tier[!dup]; edge_way <- edge_way[!dup]

xy <- unname(xy_all[used, , drop = FALSE])
message(sprintf("Road network: %d nodes, %d segments in the largest connected component",
                length(unique(c(ef, et))), length(ef)))

# ---- 4. Contract to junctions ---------------------------------------------

n <- length(used)
adj <- split(c(et, ef), c(ef, et))
adj <- lapply(seq_len(n), function(i) adj[[as.character(i)]] %||% integer())
node_tier <- integer(n)
for (k in seq_along(ef)) {
  node_tier[ef[k]] <- max(node_tier[ef[k]], edge_tier[k])
  node_tier[et[k]] <- max(node_tier[et[k]], edge_tier[k])
}
degree <- lengths(adj)
is_junction <- degree > 0 & degree != 2
junction_nodes <- which(is_junction)
junction_index <- integer(n); junction_index[junction_nodes] <- seq_along(junction_nodes)

# Each segment's travel time at its road type's speed, so trucks take the
# interstates the way real ones do. Segments are looked up by a numeric key.
edge_key <- pmin(ef, et) * (n + 1) + pmax(ef, et)
seg_seconds <- sqrt(rowSums((xy[ef, , drop = FALSE] - xy[et, , drop = FALSE])^2)) / SPEED_KMH[edge_tier] * 3.6

# Walk from each junction along each road until the next junction, keeping
# the node chain as the road's geometry. Each road is found from both ends,
# and two junctions can be joined by more than one road; the fastest stays.
walked <- list(); walked_from <- integer(); walked_to <- integer()
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
    walked[[length(walked) + 1]] <- chain
    walked_from <- c(walked_from, junction_index[j]); walked_to <- c(walked_to, junction_index[cur])
  }
}
walked_len <- lengths(walked)
seg_a <- unlist(lapply(walked, function(ch) ch[-length(ch)]))
seg_b <- unlist(lapply(walked, function(ch) ch[-1]))
seg_time <- seg_seconds[match(pmin(seg_a, seg_b) * (n + 1) + pmax(seg_a, seg_b), edge_key)]
walked_time <- as.numeric(rowsum(seg_time, rep(seq_along(walked), walked_len - 1L)))
pair <- paste(pmin(walked_from, walked_to), pmax(walked_from, walked_to))
fastest <- order(pair, walked_time)
fastest <- fastest[!duplicated(pair[fastest])]
chains <- walked[fastest]
chain_from <- walked_from[fastest]; chain_to <- walked_to[fastest]; chain_time <- walked_time[fastest]
J <- length(junction_nodes)
message(sprintf("Contracted to %d junctions and %d roads", J, length(chains)))

jadj <- vector("list", J); jw <- vector("list", J); jchain <- vector("list", J)
for (k in seq_along(chains)) {
  a <- chain_from[k]; b <- chain_to[k]
  jadj[[a]] <- c(jadj[[a]], b); jw[[a]] <- c(jw[[a]], chain_time[k]); jchain[[a]] <- c(jchain[[a]], k)
  jadj[[b]] <- c(jadj[[b]], a); jw[[b]] <- c(jw[[b]], chain_time[k]); jchain[[b]] <- c(jchain[[b]], k)
}
jxy <- xy[junction_nodes, , drop = FALSE]
jtier <- node_tier[junction_nodes]

# ---- 5. Places --------------------------------------------------------------

nearest_junction <- function(p, allowed = seq_len(J)) {
  allowed[which.min((jxy[allowed, 1] - p[1])^2 + (jxy[allowed, 2] - p[2])^2)]
}
connected <- which(lengths(jadj) >= 1)
set.seed(20260924)

# Candidate homes: points every HOME_SPACING_M along the tertiary and
# secondary roads. Where there are more of those roads, there are more
# homes.
home_points <- list()
for (k in which(edge_tier <= 2)) {
  a <- xy[ef[k], ]; b <- xy[et[k], ]
  len <- sqrt(sum((b - a)^2))
  count <- floor(len / HOME_SPACING_M + runif(1))
  if (count < 1) next
  t <- (seq_len(count) - runif(1)) / count
  home_points[[length(home_points) + 1]] <- cbind(a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
}
homes <-do.call(rbind, home_points)
message(sprintf("%d candidate homes along the smaller roads", nrow(homes)))

# Stores go where the homes cluster, on the nearest secondary or bigger
# road, like a real chain siting stores by population.
arterial <- intersect(which(jtier >= 2 & jtier <= 3), connected)
centres <- kmeans(homes, centers = N_STORES, nstart = 20, iter.max = 100)$centers
centres <- centres[order(-centres[, 2], centres[, 1]), , drop = FALSE]   # north to south, for stable numbering
store_j <- vapply(seq_len(N_STORES), function(i) nearest_junction(centres[i, ], arterial), 0L)

dc_j <- nearest_junction(to_metres(DC_NEAR["lon"], DC_NEAR["lat"]), intersect(which(jtier >= 3), connected))

# The plant's trucks enter where PLANT_ROAD leaves the box on the east.
plant_nodes <- unique(c(ef[road_ref[edge_way] == PLANT_ROAD & edge_tier == 4],
                        et[road_ref[edge_way] == PLANT_ROAD & edge_tier == 4]))
plant_nodes <- plant_nodes[is_junction[plant_nodes]]
if (!length(plant_nodes)) stop("No junction on ", PLANT_ROAD, " in the network.")
entry_j <- junction_index[plant_nodes[which.max(xy[plant_nodes, 1])]]

# ---- 6. Truck routes ----------------------------------------------------------

# Dijkstra from the DC. On an undirected network the tree's parent pointer
# is the next step towards the DC, so one tree gives every route.
dijkstra <- function(source) {
  dist <- rep(Inf, J); parent <- rep(NA_integer_, J); via <- rep(NA_integer_, J); done <- rep(FALSE, J)
  dist[source] <- 0; parent[source] <- 0L
  repeat {
    open <- which(!done & is.finite(dist))
    if (!length(open)) break
    u <- open[which.min(dist[open])]
    done[u] <- TRUE
    nb <- jadj[[u]]; alt <- dist[u] + jw[[u]]
    better <- alt < dist[nb]
    if (any(better)) {
      dist[nb[better]] <- alt[better]
      parent[nb[better]] <- u
      via[nb[better]] <- jchain[[u]][better]
    }
  }
  list(dist = dist, parent = parent, via = via)
}
tree <- dijkstra(dc_j)
message("Routed every junction to the DC")

# The road geometry from junction `from` to the DC, in metres.
route_to_dc <- function(from) {
  points <- list(jxy[from, , drop = FALSE])
  at <- from
  while (at != dc_j) {
    k <- tree$via[at]
    chain <- chains[[k]]
    if (junction_index[chain[1]] != at) chain <- rev(chain)
    points[[length(points) + 1]] <- xy[chain[-1], , drop = FALSE]
    at <- tree$parent[at]
  }
  unname(do.call(rbind, points))
}

to_patch <- function(m) m / PATCH_M
# A route in patches, with the distance travelled at each point, so a truck
# part-way along is one interpolation.
as_route <- function(points_m) {
  p <- to_patch(points_m)
  step <- sqrt(rowSums((p[-1, , drop = FALSE] - p[-nrow(p), , drop = FALSE])^2))
  keep <- c(TRUE, step > 0)
  p <- p[keep, , drop = FALSE]
  list(x = p[, 1], y = p[, 2], along = c(0, cumsum(step[step > 0])))
}
store_routes <- lapply(store_j, function(j) {                     # DC -> store
  back <- route_to_dc(j)
  as_route(back[nrow(back):1, , drop = FALSE])
})
plant_route <- as_route(route_to_dc(entry_j))                                                                  # entry -> DC
message(sprintf("Store routes: %s km", paste(round(vapply(store_routes, function(r) max(r$along), 0) * PATCH_M / 1000, 1), collapse = ", ")))

# ---- 7. Roads on patches ------------------------------------------------------

min_px <- floor(min(to_patch(xy[, 1]))) - 1; max_px <- ceiling(max(to_patch(xy[, 1]))) + 1
min_py <- floor(min(to_patch(xy[, 2]))) - 1; max_py <- ceiling(max(to_patch(xy[, 2]))) + 1
width <- max_px - min_px + 1; height <- max_py - min_py + 1
roads <- matrix(0L, nrow = height, ncol = width)   # row 1 = top (max pycor)

for (k in order(edge_tier)) {
  a <- to_patch(xy[ef[k], ]); b <- to_patch(xy[et[k], ])
  steps <- max(2, ceiling(sqrt(sum((b - a)^2)) * 3))
  t <- seq(0, 1, length.out = steps)
  px <- round(a[1] + (b[1] - a[1]) * t); py <- round(a[2] + (b[2] - a[2]) * t)
  cells <- cbind(max_py - py + 1, px - min_px + 1)
  roads[cells] <- pmax(roads[cells], edge_tier[k])
}

# ---- Save ---------------------------------------------------------------------

place <- function(j) unname(to_patch(jxy[j, ]))
city <- list(
  world = c(minPxcor = min_px, maxPxcor = max_px, minPycor = min_py, maxPycor = max_py),
  road_tiers = roads,                     # 0 none, 1 tertiary, 2 secondary, 3 primary, 4 motorway
  homes = unname(to_patch(homes)),        # candidate homes, patch units
  stores = t(vapply(store_j, place, numeric(2))),
  dc = place(dc_j),
  plant_entry = place(entry_j),
  store_routes = store_routes,            # DC -> each store along the roads
  plant_route = plant_route,              # map edge on I-70 -> DC
  patch_metres = PATCH_M,
  attribution = "Map data © OpenStreetMap contributors (ODbL)"
)
saveRDS(city, out, compress = "xz")
message(sprintf("Wrote %s (%.0f kB): %dx%d patches of %d m",
                file.path("templates", "data", basename(out)), file.size(out) / 1024, width, height, PATCH_M))

# ---- 8. Supermarkets ------------------------------------------------------------

# The twin's shoppers do their weekly shop at the real supermarkets in the
# box: the sites OpenStreetMap tags shop=supermarket with the brand of a
# full-line grocery chain. Independent, specialty and ethnic grocers, dollar
# stores and food service serve other trips, so they're left out.
GROCERS <- c("aldi", "fresh thyme", "kroger", "kroger marketplace", "meijer", "needler's fresh market",
             "safeway", "save-a-lot", "the fresh market", "trader joe's", "walmart",
             "walmart neighborhood market", "whole foods market")
N_OURS <- 24                     # the fictional chain's stores among them
SAME_SITE_M <- 150               # a node and a building for one store
ACCESS_KMH <- 20                 # off the network (side streets, car parks), in a straight line
SIMPLIFY_M <- 15                 # road geometry kept to within 15 m

twin_out <- file.path(root, "templates", "data", "indianapolis-twin.rds")
market_cache <- file.path(root, "tools", ".cache", "indy-supermarkets.json")
overpass(sprintf('[out:json][timeout:120];nwr["shop"="supermarket"](%s,%s,%s,%s);out center tags;',
                 BBOX["south"], BBOX["west"], BBOX["north"], BBOX["east"]),
         market_cache, "supermarkets")

shops <- jsonlite::fromJSON(market_cache, simplifyVector = FALSE)$elements
brand <- vapply(shops, function(s) tolower(s$tags$brand %||% ""), "")
shop_lon <- vapply(shops, function(s) s$lon %||% s$center$lon, 0)
shop_lat <- vapply(shops, function(s) s$lat %||% s$center$lat, 0)
grocer <- brand %in% GROCERS
site <- to_metres(shop_lon[grocer], shop_lat[grocer])
distinct <- rep(TRUE, nrow(site))
for (i in seq_len(nrow(site))[-1]) {
  earlier <- which(distinct[seq_len(i - 1)])
  distinct[i] <- min((site[earlier, 1] - site[i, 1])^2 + (site[earlier, 2] - site[i, 2])^2) > SAME_SITE_M^2
}
site <- unname(site[distinct, , drop = FALSE])
K <- nrow(site)
message(sprintf("%d supermarkets of %d grocery chains (of %d sites tagged shop=supermarket)",
                K, length(unique(brand[grocer])), length(shops)))

# Each supermarket joins the network at the nearest junction; so does each
# candidate home. The drive between the site and its junction is timed in a
# straight line at ACCESS_KMH.
reachable <- which(is.finite(tree$dist))
nearest_junctions <- function(p) {
  vapply(seq_len(nrow(p)), function(i) {
    reachable[which.min((jxy[reachable, 1] - p[i, 1])^2 + (jxy[reachable, 2] - p[i, 2])^2)]
  }, 0L)
}
access_seconds <- function(p, j) sqrt(rowSums((p - jxy[j, , drop = FALSE])^2)) / ACCESS_KMH * 3.6
site_j <- nearest_junctions(site)
home_j <- nearest_junctions(homes)

# ---- 9. The fictional chain -------------------------------------------------------

# A market leader: a third of the sites, drawn at random, so that like a
# real chain's its stores sit near each other in places and far apart in
# others. Store A, the one that runs the promotion, is the chain's store
# nearest the middle of where people live.
set.seed(20260925)
ours <- sort(sample(K, N_OURS))
middle <- colMeans(homes)
store_a <- ours[which.min((site[ours, 1] - middle[1])^2 + (site[ours, 2] - middle[2])^2)]

# ---- 10. Every drive to every supermarket ---------------------------------------

# One Dijkstra tree per supermarket: from any junction, the road to take
# towards it (`via`, 0 at its own junction) and the seconds it takes.
via <- matrix(0L, K, J)
seconds <- matrix(NA_integer_, K, J)
for (k in seq_len(K)) {
  t_k <- dijkstra(site_j[k])
  via[k, ] <- ifelse(is.na(t_k$via), 0L, t_k$via)
  seconds[k, ] <- as.integer(round(t_k$dist))
}
message(sprintf("Routed every junction to each of the %d supermarkets", K))

# ---- 11. Road geometry and homes ---------------------------------------------------

# Each road's points, simplified (Douglas-Peucker) and timed: seconds from
# the road's first junction at every point kept, at the speed of each
# stretch's road type. Roads run from road_from to road_to.
simplify <- function(p, tolerance) {
  keep <- c(TRUE, logical(nrow(p) - 2), TRUE)
  spans <- list(c(1L, nrow(p)))
  while (length(spans)) {
    span <- spans[[1]]; spans <- spans[-1]
    if (span[2] - span[1] < 2) next
    inner <- (span[1] + 1):(span[2] - 1)
    a <- p[span[1], ]; d <- p[span[2], ] - a
    off <- abs(d[1] * (p[inner, 2] - a[2]) - d[2] * (p[inner, 1] - a[1])) / max(1e-9, sqrt(sum(d^2)))
    if (max(off) > tolerance) {
      m <- inner[which.max(off)]
      keep[m] <- TRUE
      spans <- c(spans, list(c(span[1], m), c(m, span[2])))
    }
  }
  which(keep)
}
road_points <- vector("list", length(chains)); road_times <- vector("list", length(chains))
for (k in seq_along(chains)) {
  ch <- chains[[k]]
  step <- seg_seconds[match(pmin(ch[-length(ch)], ch[-1]) * (n + 1) + pmax(ch[-length(ch)], ch[-1]), edge_key)]
  kept <- simplify(xy[ch, , drop = FALSE], SIMPLIFY_M)
  road_points[[k]] <- to_patch(xy[ch[kept], , drop = FALSE])
  road_times[[k]] <- c(0, cumsum(step))[kept]
}
road_n <- lengths(road_times)
message(sprintf("Road geometry: %d points, simplified from %d", sum(road_n), sum(lengths(chains))))

twin <- list(
  world = city$world,
  road_tiers = roads,                              # as in indianapolis.rds
  junctions = unname(to_patch(jxy)),               # J x 2, patch units
  road_from = chain_from, road_to = chain_to,      # the junctions each road joins
  road_first = cumsum(c(1L, road_n[-length(road_n)])),   # its first point in `points`
  road_n = road_n,
  road_seconds = vapply(road_times, max, 0),
  points = unname(do.call(rbind, road_points)),
  point_seconds = unlist(road_times),              # seconds from the road's road_from end
  stores = unname(to_patch(site)),                 # K x 2, the real sites
  store_junction = site_j,
  store_access = access_seconds(site, site_j),
  ours = seq_len(K) %in% ours,                     # the fictional chain's stores
  store_a = store_a,
  via = via,                                       # K x J: the road towards store k from junction j
  seconds = seconds,                               # K x J: seconds to store k from junction j
  homes = unname(to_patch(homes)),                 # candidate homes, patch units
  home_junction = home_j,
  home_access = access_seconds(homes, home_j),
  patch_metres = PATCH_M,
  attribution = "Map data and supermarket sites © OpenStreetMap contributors (ODbL)"
)
saveRDS(twin, twin_out, compress = "xz")
message(sprintf("Wrote %s (%.0f kB): %d supermarkets, %d of them the chain's; Store A is number %d",
                file.path("templates", "data", basename(twin_out)), file.size(twin_out) / 1024, K, N_OURS, store_a))
