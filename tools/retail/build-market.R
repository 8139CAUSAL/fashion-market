#!/usr/bin/env Rscript
# Builds templates/data/retail-<market>.rds: the real geography of a retail
# market for the retail example (see PLAN-retail-market.md).
#
#   1. the drive network (arterials and up) from OpenStreetMap, contracted to
#      junctions,
#   2. where people live: the Census 2020 population-weighted centre of every
#      block group, with households, income, household size and car
#      ownership from the ACS 2019-2023 five-year estimates,
#   3. stores: the chain's, placed at their ZIP code's centre, and competing
#      supermarkets from OpenStreetMap,
#   4. drive time and distance from every block group to every store,
#   5. roads rasterised onto patches for drawing,
#   6. how far people drive to shop (tools/retail/nhts-shopping.R), the
#      target the distance sensitivity is calibrated to.
#
#   Rscript tools/retail/build-market.R
#
# No API keys: Overpass, and the Census Bureau's bulk files. Downloads are
# cached in tools/.cache/retail/.
#
# The chain's stores come from the Carbo-Loading store table when
# dunnhumby_Carbo-Loading.zip is in the cache, else from
# tools/.cache/retail/stores-provisional.csv (a partial list), and the data
# file says which. Nothing from dunnhumby is written into this script.
#
# Travel is by car on an undirected network: one-way streets are treated as
# two-way, and residential streets are left out. The short trip from a
# block group's centre (or a ZIP centre) to the nearest junction is added as
# straight-line distance x CIRCUITY at ACCESS_MPH.
#
# Map data © OpenStreetMap contributors (ODbL). Census data: US Census
# Bureau. NHTS: US Department of Transportation.

MARKET <- list(
  id = "louisville",
  name = "Louisville, KY-IN",
  cbsa = "31140",
  bbox = c(south = 37.99, west = -85.96, north = 38.42, east = -85.40),
  # Counties the box touches (state + county FIPS); block groups outside the
  # box are dropped.
  counties = c("21111", "21185", "21029", "21211", "21215", "18019", "18043", "18061")
)
PATCH_M <- 150

ROAD_CLASSES <- data.frame(
  highway = c("motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
              "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified"),
  mph = c(60, 40, 50, 35, 40, 30, 35, 30, 30, 25, 25),       # when maxspeed isn't tagged
  tier = c(3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1)                  # for drawing
)
SIGNAL_FACTOR <- 1.15   # slows everything but motorways and trunks for lights and turns
ACCESS_MPH <- 20
CIRCUITY <- 1.3
ACS_YEAR <- 2023

script_path <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
root <- normalizePath(file.path(dirname(script_path), "..", ".."))
cache <- file.path(root, "tools", ".cache", "retail")
dir.create(cache, showWarnings = FALSE, recursive = TRUE)
out <- file.path(root, "templates", "data", sprintf("retail-%s.rds", MARKET$id))

cached <- function(name) file.path(cache, name)
download <- function(url, dest, what) {
  if (file.exists(dest)) return(invisible(dest))
  message("Downloading ", what, "…")
  status <- system2("curl", c("-sSfL", "-m", "300", "-A", shQuote("NetLogoR-Workbench build script"),
                             shQuote(url), "-o", shQuote(dest)))
  if (status != 0) { unlink(dest); stop("Download failed: ", url) }
  invisible(dest)
}
overpass <- function(query, dest, what) {
  if (file.exists(dest)) return(invisible(dest))
  message("Downloading ", what, " from Overpass…")
  status <- system2("curl", c("-sSf", "-m", "300", "-A", shQuote("NetLogoR-Workbench build script"),
                             "--data-urlencode", shQuote(paste0("data=", query)),
                             "https://overpass-api.de/api/interpreter", "-o", shQuote(dest)))
  if (status != 0) { unlink(dest); stop("Overpass download failed: ", what) }
  invisible(dest)
}

bb <- MARKET$bbox
bbox_q <- sprintf("%s,%s,%s,%s", bb["south"], bb["west"], bb["north"], bb["east"])

# Metres east and north of the box's south-west corner.
lat0 <- mean(bb[c("south", "north")]) * pi / 180
to_metres <- function(lon, lat) {
  cbind(x = (lon - bb[["west"]]) * pi / 180 * 6371000 * cos(lat0),
        y = (lat - bb[["south"]]) * pi / 180 * 6371000)
}
in_box <- function(lon, lat) {
  lat >= bb[["south"]] & lat <= bb[["north"]] & lon >= bb[["west"]] & lon <= bb[["east"]]
}
extent <- to_metres(bb[["east"]], bb[["north"]])
W <- ceiling(extent[1, "x"] / PATCH_M); H <- ceiling(extent[1, "y"] / PATCH_M)

# ---- 1. The drive network ------------------------------------------------

roads_file <- overpass(
  sprintf('[out:json][timeout:240];way["highway"~"^(%s)$"](%s);(._;>;);out body;',
          paste(ROAD_CLASSES$highway, collapse = "|"), bbox_q),
  cached(sprintf("roads-osm-%s.json", MARKET$id)), "roads"
)
osm <- jsonlite::fromJSON(roads_file, simplifyVector = FALSE)$elements
types <- vapply(osm, `[[`, "", "type")
nodes <- osm[types == "node"]
ways <- osm[types == "way"]
rm(osm)

node_id <- vapply(nodes, function(n) as.character(n$id), "")
node_xy <- to_metres(vapply(nodes, `[[`, 0, "lon"), vapply(nodes, `[[`, 0, "lat"))
way_nodes <- lapply(ways, function(w) match(vapply(w$nodes, as.character, ""), node_id))
way_class <- match(vapply(ways, function(w) w$tags$highway, ""), ROAD_CLASSES$highway)

mph_of <- function(w, class) {
  tag <- w$tags$maxspeed
  v <- if (is.null(tag)) NA_real_ else suppressWarnings(as.numeric(sub("^([0-9.]+).*$", "\\1", tag)))
  if (is.na(v) || v < 5) ROAD_CLASSES$mph[class] else v   # US tags are in mph
}
way_mph <- mapply(mph_of, ways, way_class)
fast <- ROAD_CLASSES$highway[way_class] %in% c("motorway", "motorway_link", "trunk", "trunk_link")
metres_per_min <- way_mph * 1609.344 / 60 / ifelse(fast, 1, SIGNAL_FACTOR)
rm(ways, nodes)

# Junctions: where ways meet, and where they end.
uses <- tabulate(unlist(way_nodes), nbins = nrow(node_xy))
ends <- unique(unlist(lapply(way_nodes, function(n) n[c(1, length(n))])))
is_junction <- uses >= 2
is_junction[ends] <- TRUE

# Every consecutive pair of nodes (for drawing), and the ways cut at
# junctions into edges (for routing).
segments <- vector("list", length(way_nodes))
edges <- vector("list", length(way_nodes))
for (k in seq_along(way_nodes)) {
  n <- way_nodes[[k]]
  if (length(n) < 2) next
  d <- sqrt(diff(node_xy[n, "x"])^2 + diff(node_xy[n, "y"])^2)
  segments[[k]] <- cbind(from = n[-length(n)], to = n[-1], tier = ROAD_CLASSES$tier[way_class[k]])
  at <- which(is_junction[n])
  cum <- c(0, cumsum(d))
  edges[[k]] <- cbind(from = n[at[-length(at)]], to = n[at[-1]],
                      metres = diff(cum[at]), minutes = diff(cum[at]) / metres_per_min[k])
}
segments <- do.call(rbind, segments)
edges <- do.call(rbind, edges)
edges <- edges[edges[, "from"] != edges[, "to"], , drop = FALSE]

junctions <- sort(unique(c(edges[, "from"], edges[, "to"])))
J <- length(junctions)
jxy <- node_xy[junctions, , drop = FALSE]
ef <- match(edges[, "from"], junctions); et <- match(edges[, "to"], junctions)

# Both directions, sorted by origin: edges out of junction u are
# off[u] .. off[u + 1] - 1.
from <- c(ef, et); to <- c(et, ef)
e_min <- rep(edges[, "minutes"], 2); e_m <- rep(edges[, "metres"], 2)
o <- order(from)
from <- from[o]; to <- to[o]; e_min <- e_min[o]; e_m <- e_m[o]
degree <- tabulate(from, nbins = J)
off <- c(1L, cumsum(degree) + 1L)
message(sprintf("Drive network: %d junctions, %d road sections", J, nrow(edges)))

# Fastest routes from one junction to all others (label-correcting search,
# vectorised by frontier). Returns minutes and the metres of each route.
fastest_from <- function(source) {
  t <- rep(Inf, J); m <- rep(Inf, J)
  t[source] <- 0; m[source] <- 0
  frontier <- source
  while (length(frontier)) {
    k <- degree[frontier]
    frontier <- frontier[k > 0]; k <- k[k > 0]
    if (!length(frontier)) break
    e <- sequence(k, from = off[frontier])
    cand <- rep(t[frontier], k) + e_min[e]
    cand_m <- rep(m[frontier], k) + e_m[e]
    v <- to[e]
    better <- cand < t[v]
    if (!any(better)) break
    v <- v[better]; cand <- cand[better]; cand_m <- cand_m[better]
    o <- order(v, cand)
    v <- v[o]; cand <- cand[o]; cand_m <- cand_m[o]
    first <- !duplicated(v)
    v <- v[first]
    t[v] <- cand[first]; m[v] <- cand_m[first]
    frontier <- v
  }
  list(minutes = t, metres = m)
}

# Only the connected network around the centre is usable.
centre <- which.min((jxy[, "x"] - extent[1, "x"] / 2)^2 + (jxy[, "y"] - extent[1, "y"] / 2)^2)
reachable <- is.finite(fastest_from(centre)$minutes)
message(sprintf("%.1f%% of junctions are reachable from the centre", 100 * mean(reachable)))
usable <- which(reachable)

nearest_junction <- function(xy) {
  vapply(seq_len(nrow(xy)), function(i) {
    usable[which.min((jxy[usable, "x"] - xy[i, 1])^2 + (jxy[usable, "y"] - xy[i, 2])^2)]
  }, 0L)
}
access <- function(xy, j) {
  metres <- sqrt((xy[, 1] - jxy[j, "x"])^2 + (xy[, 2] - jxy[j, "y"])^2) * CIRCUITY
  cbind(metres = metres, minutes = metres / (ACCESS_MPH * 1609.344 / 60))
}

# ---- 2. Where people live ------------------------------------------------

states <- unique(substr(MARKET$counties, 1, 2))
centres <- do.call(rbind, lapply(states, function(st) {
  f <- download(sprintf("https://www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/CenPop2020_Mean_BG%s.txt", st),
                cached(sprintf("CenPop2020_Mean_BG%s.txt", st)), sprintf("2020 block-group centres (state %s)", st))
  read.csv(f, colClasses = "character", fileEncoding = "UTF-8-BOM")
}))
centres$geoid <- with(centres, paste0(STATEFP, COUNTYFP, TRACTCE, BLKGRPCE))
centres$lat <- as.numeric(centres$LATITUDE); centres$lon <- as.numeric(centres$LONGITUDE)
centres$population_2020 <- as.integer(centres$POPULATION)
bg <- centres[substr(centres$geoid, 1, 5) %in% MARKET$counties & in_box(centres$lon, centres$lat) &
                centres$population_2020 > 0, c("geoid", "lon", "lat", "population_2020")]

# ACS tables, cut down to the market's counties as they stream in.
acs_table <- function(table) {
  f <- cached(sprintf("acs%d-%s-%s.dat", ACS_YEAR, table, MARKET$id))
  if (!file.exists(f)) {
    message("Downloading ACS table ", toupper(table), "…")
    url <- sprintf("https://www2.census.gov/programs-surveys/acs/summary_file/%d/table-based-SF/data/5YRData/acsdt5y%d-%s.dat",
                   ACS_YEAR, ACS_YEAR, table)
    pattern <- sprintf("^(GEO_ID|1500000US(%s))", paste(MARKET$counties, collapse = "|"))
    status <- system(sprintf("curl -sSfL -m 600 %s | grep -E '%s' > %s", shQuote(url), pattern, shQuote(f)))
    if (status != 0 || file.size(f) == 0) { unlink(f); stop("ACS download failed: ", table) }
  }
  d <- read.delim(f, sep = "|", colClasses = "character")
  d$geoid <- sub("^1500000US", "", d$GEO_ID)
  d
}
acs_value <- function(d, column) {
  v <- suppressWarnings(as.numeric(d[[column]]))
  v[v < 0] <- NA   # the Census codes suppressed estimates as large negatives
  v[match(bg$geoid, d$geoid)]
}
b11001 <- acs_table("b11001"); b19013 <- acs_table("b19013")
b25010 <- acs_table("b25010"); b25044 <- acs_table("b25044")
bg$households <- acs_value(b11001, "B11001_E001")
bg$median_income <- acs_value(b19013, "B19013_E001")
bg$household_size <- acs_value(b25010, "B25010_E001")
bg$no_vehicle_share <- (acs_value(b25044, "B25044_E003") + acs_value(b25044, "B25044_E010")) /
  acs_value(b25044, "B25044_E001")
bg <- bg[!is.na(bg$households) & bg$households > 0, ]
message(sprintf("%d block groups, %s households", nrow(bg), format(sum(bg$households), big.mark = ",")))

# ---- 3. Stores -----------------------------------------------------------

zcta_zip <- download(sprintf("https://www2.census.gov/geo/docs/maps-data/data/gazetteer/%d_Gazetteer/%d_Gaz_zcta_national.zip",
                             ACS_YEAR, ACS_YEAR),
                     cached(sprintf("%d_Gaz_zcta_national.zip", ACS_YEAR)), "ZIP code centres")
zcta <- read.delim(unz(zcta_zip, sprintf("%d_Gaz_zcta_national.txt", ACS_YEAR)), colClasses = "character")
names(zcta) <- trimws(names(zcta))
zcta$lat <- as.numeric(zcta$INTPTLAT); zcta$lon <- as.numeric(zcta$INTPTLONG)

# The chain's store table: dunnhumby's, or the provisional list.
chain_table <- function() {
  zip <- cached("dunnhumby_Carbo-Loading.zip")
  if (file.exists(zip)) {
    inside <- unzip(zip, list = TRUE)$Name
    f <- grep("store", inside, ignore.case = TRUE, value = TRUE)
    f <- f[grepl("\\.(csv|txt)$", f, ignore.case = TRUE)]
    if (length(f) != 1) stop("Can't tell which file in ", basename(zip), " is the store table: ",
                             paste(inside, collapse = ", "))
    d <- read.csv(unz(zip, f), colClasses = "character")
    names(d) <- tolower(names(d))
    return(list(stores = d, provisional = FALSE, source = paste("dunnhumby Carbo-Loading,", f)))
  }
  f <- cached("stores-provisional.csv")
  if (!file.exists(f)) stop("No store table: put dunnhumby_Carbo-Loading.zip in tools/.cache/retail/.")
  message("Using the provisional store list; the Carbo-Loading store table will replace it.")
  list(stores = read.csv(f, colClasses = "character"), provisional = TRUE,
       source = "provisional list of the chain's stores (partial)")
}
chain <- chain_table()
chain_stores <- merge(chain$stores[c("store", "store_zip_code")], zcta[c("GEOID", "lon", "lat")],
                      by.x = "store_zip_code", by.y = "GEOID")
# PO-box and single-business ZIPs have no ZIP area, so no centre to use.
unplaced <- setdiff(chain$stores$store, chain_stores$store)
if (length(unplaced)) {
  warning(sprintf("%d of the chain's stores have a ZIP code with no Census ZIP area and are left out: %s",
                  length(unplaced), paste(sprintf("store %s (%s)", unplaced,
                    chain$stores$store_zip_code[match(unplaced, chain$stores$store)]), collapse = ", ")),
          call. = FALSE, immediate. = TRUE)
}
chain_stores <- chain_stores[in_box(chain_stores$lon, chain_stores$lat), ]

shops_file <- overpass(
  sprintf(paste0('[out:json][timeout:120];(nwr["shop"~"^(supermarket|wholesale)$"](%1$s);',
                 'nwr["shop"="department_store"]["name"~"Walmart|Target|Meijer",i](%1$s););out center tags;'),
          bbox_q),
  cached(sprintf("shops-osm-%s.json", MARKET$id)), "supermarkets"
)
shops <- jsonlite::fromJSON(shops_file, simplifyVector = FALSE)$elements
tag <- function(el, key) if (is.null(el$tags[[key]])) NA_character_ else el$tags[[key]]
competitors <- data.frame(
  osm = vapply(shops, function(el) paste0(substr(el$type, 1, 1), el$id), ""),
  name = vapply(shops, tag, "", "name"),
  brand = vapply(shops, tag, "", "brand"),
  shop = vapply(shops, tag, "", "shop"),
  lon = vapply(shops, function(el) if (is.null(el$lon)) el$center$lon else el$lon, 0),
  lat = vapply(shops, function(el) if (is.null(el$lat)) el$center$lat else el$lat, 0)
)
competitors <- competitors[!is.na(competitors$name) & in_box(competitors$lon, competitors$lat), ]
# A shop mapped twice (a point and its building) counts once.
cxy <- to_metres(competitors$lon, competitors$lat)
dupe <- vapply(seq_len(nrow(competitors)), function(i) {
  any(seq_len(i - 1) %in% which(competitors$name[seq_len(i - 1)] == competitors$name[i] &
                                  sqrt((cxy[seq_len(i - 1), 1] - cxy[i, 1])^2 + (cxy[seq_len(i - 1), 2] - cxy[i, 2])^2) < 150))
}, FALSE)
competitors <- competitors[!dupe, ]

stores <- rbind(
  data.frame(chain = TRUE, store = chain_stores$store, zip = chain_stores$store_zip_code,
             osm = NA, name = NA, brand = NA, shop = NA, lon = chain_stores$lon, lat = chain_stores$lat),
  data.frame(chain = FALSE, store = NA, zip = NA, osm = competitors$osm, name = competitors$name,
             brand = competitors$brand, shop = competitors$shop, lon = competitors$lon, lat = competitors$lat)
)
message(sprintf("%d of the chain's stores, %d competing stores", sum(stores$chain), sum(!stores$chain)))

# ---- 4. Drive times ------------------------------------------------------

bg_xy <- to_metres(bg$lon, bg$lat)
st_xy <- to_metres(stores$lon, stores$lat)
bg_j <- nearest_junction(bg_xy); st_j <- nearest_junction(st_xy)
bg_access <- access(bg_xy, bg_j); st_access <- access(st_xy, st_j)

started <- Sys.time()
routes <- lapply(st_j, fastest_from)
message(sprintf("Routed from %d stores in %.0f s", length(st_j), as.numeric(Sys.time() - started, units = "secs")))
drive_minutes <- vapply(seq_along(routes), function(s) {
  routes[[s]]$minutes[bg_j] + bg_access[, "minutes"] + st_access[s, "minutes"]
}, numeric(nrow(bg)))
drive_miles <- vapply(seq_along(routes), function(s) {
  (routes[[s]]$metres[bg_j] + bg_access[, "metres"] + st_access[s, "metres"]) / 1609.344
}, numeric(nrow(bg)))
# Two places on the same junction are still a short drive apart.
same <- outer(bg_j, st_j, "==")
direct <- sqrt(outer(bg_xy[, 1], st_xy[, 1], "-")^2 + outer(bg_xy[, 2], st_xy[, 2], "-")^2) * CIRCUITY
drive_minutes[same] <- (direct / (ACCESS_MPH * 1609.344 / 60))[same]
drive_miles[same] <- (direct / 1609.344)[same]
dimnames(drive_minutes) <- dimnames(drive_miles) <- NULL

# ---- 5. Roads on patches -------------------------------------------------

roads <- matrix(0L, nrow = H, ncol = W)   # row 1 = top (max pycor)
a <- node_xy[segments[, "from"], , drop = FALSE] / PATCH_M
b <- node_xy[segments[, "to"], , drop = FALSE] / PATCH_M
steps <- pmax(2L, as.integer(ceiling(sqrt(rowSums((b - a)^2)) * 3)))
seg <- rep(seq_len(nrow(segments)), steps)
t <- sequence(steps, from = 0L) / rep(steps - 1L, steps)
px <- floor(a[seg, 1] + (b[seg, 1] - a[seg, 1]) * t)
py <- floor(a[seg, 2] + (b[seg, 2] - a[seg, 2]) * t)
inside <- px >= 0 & px < W & py >= 0 & py < H
cells <- cbind(H - py[inside], px[inside] + 1)
tier <- segments[seg[inside], "tier"]
o <- order(tier)                          # higher tiers written last win
roads[cells[o, , drop = FALSE]] <- as.integer(tier[o])

# ---- 6. Save -------------------------------------------------------------

nhts_file <- cached(sprintf("nhts-shopping-%s.rds", MARKET$cbsa))
if (!file.exists(nhts_file)) {
  status <- system2("Rscript", c(shQuote(file.path(root, "tools", "retail", "nhts-shopping.R")), MARKET$cbsa))
  if (status != 0) stop("tools/retail/nhts-shopping.R failed")
}
nhts <- as.data.frame(readRDS(nhts_file))

to_patch <- function(xy) unname(xy / PATCH_M)
market <- list(
  id = MARKET$id, name = MARKET$name, cbsa = MARKET$cbsa, bbox = MARKET$bbox,
  world = c(minPxcor = 0, maxPxcor = W - 1, minPycor = 0, maxPycor = H - 1),
  patch_metres = PATCH_M,
  roads = roads,                     # H x W, row 1 = north; 0 none, 1 minor, 2 major, 3 motorway
  block_groups = data.frame(
    geoid = bg$geoid, x = to_patch(bg_xy[, 1]), y = to_patch(bg_xy[, 2]),
    population_2020 = bg$population_2020, households = bg$households,
    median_income = bg$median_income, household_size = bg$household_size,
    no_vehicle_share = round(bg$no_vehicle_share, 3)
  ),
  stores = data.frame(
    chain = stores$chain, store = stores$store, zip = stores$zip, osm = stores$osm,
    name = stores$name, brand = stores$brand, shop = stores$shop,
    x = to_patch(st_xy[, 1]), y = to_patch(st_xy[, 2])
  ),
  drive_minutes = round(drive_minutes, 1),   # block group x store
  drive_miles = round(drive_miles, 2),
  nhts_shopping = nhts,
  chain_stores_provisional = chain$provisional,
  sources = c(
    roads = "OpenStreetMap via Overpass: highways from unclassified up",
    competitors = "OpenStreetMap via Overpass: shop=supermarket|wholesale, and Walmart/Target/Meijer department stores",
    chain = paste(chain$source, "- placed at ZIP (ZCTA) internal points, Census Gazetteer", ACS_YEAR),
    homes = "US Census Bureau: 2020 population-weighted block-group centres",
    households = sprintf("US Census Bureau: ACS %d-%d five-year estimates, tables B11001, B19013, B25010, B25044",
                         ACS_YEAR - 4, ACS_YEAR),
    trips = "2017 National Household Travel Survey (US DOT), via tools/retail/nhts-shopping.R"
  ),
  attribution = "Map data © OpenStreetMap contributors (ODbL) · US Census Bureau · 2017 NHTS"
)
saveRDS(market, out, compress = "xz")
message(sprintf("Wrote %s (%.0f kB): %dx%d patches of %d m, %d block groups x %d stores",
                file.path("templates", "data", basename(out)), file.size(out) / 1024, W, H, PATCH_M,
                nrow(bg), nrow(stores)))
