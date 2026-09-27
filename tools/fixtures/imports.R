# Imports (see imports.ui): walkers wander an area map the user imports,
# beside a summary of a revenue table they import. Neither import does
# anything by itself: their code below and in the interface decides.

# Patch categories: 0 ground, then one per kind of shape in the map.
area_kinds <- c(park = 1, water = 2, building = 3)
area_colors <- c("#26231f", "#3f7d3a", "#2f6fb0", "#8a7f72")

# Until the table is imported there is nothing to summarise.
treatment <- numeric(0)
control <- numeric(0)

# Reads a GeoJSON file of polygons onto a grid of patches `width` wide: each
# patch takes the kind (a feature's "kind" property) of the last polygon its
# centre falls in, or 0. Coordinates are used as flat x/y, which suits a
# small area.
read_area <- function(path, width = 60) {
  geo <- jsonlite::fromJSON(path, simplifyVector = FALSE)
  shapes <- list()
  for (feature in geo$features) {
    kind <- area_kinds[feature$properties$kind]
    if (!length(kind) || is.na(kind)) next
    polygons <- switch(feature$geometry$type,
      Polygon = list(feature$geometry$coordinates),
      MultiPolygon = feature$geometry$coordinates,
      list()
    )
    for (rings in polygons) {
      shapes[[length(shapes) + 1L]] <- list(kind = kind, rings = lapply(rings, function(ring) {
        do.call(rbind, lapply(ring, function(point) as.numeric(point[1:2])))
      }))
    }
  }
  if (!length(shapes)) stop("No park, water or building polygons in ", basename(path), call. = FALSE)

  points <- do.call(rbind, lapply(shapes, function(s) do.call(rbind, s$rings)))
  xmin <- min(points[, 1]); ymin <- min(points[, 2])
  size <- (max(points[, 1]) - xmin) / width
  height <- ceiling((max(points[, 2]) - ymin) / size)

  # Patch centres, row by row from the top, as createWorld() fills them.
  cx <- rep(xmin + (seq_len(width) - 0.5) * size, times = height)
  cy <- rep(ymin + (rev(seq_len(height)) - 0.5) * size, each = width)
  kinds <- numeric(width * height)
  for (s in shapes) kinds[inside(cx, cy, s$rings)] <- s$kind

  createWorld(0, width - 1, 0, height - 1, data = kinds)
}

# Even-odd point-in-polygon test over all of a polygon's rings, so holes
# (the inner rings) are left out.
inside <- function(px, py, rings) {
  hit <- logical(length(px))
  for (ring in rings) {
    x <- ring[, 1]; y <- ring[, 2]
    j <- c(length(x), seq_len(length(x) - 1L))
    for (i in seq_along(x)) {
      k <- j[i]
      crosses <- ((y[i] > py) != (y[k] > py)) &
        (px < (x[k] - x[i]) * (py - y[i]) / (y[k] - y[i]) + x[i])
      hit <- xor(hit, crosses)
    }
  }
  hit
}

setup <- function() {
  if (is.null(get0("map_world", envir = globalenv(), inherits = FALSE))) {
    cat("Import an area map to put walkers on it.\n")
    turtles <<- NULL
    return(invisible(NULL))
  }
  turtles <<- createTurtles(n = walkers, coords = randomXYcor(map_world, n = walkers), color = "white")
}

go <- function() {
  if (is.null(turtles)) return(stop_run())
  turtles <<- right(turtles, angle = runif(NLcount(turtles), -30, 30))
  turtles <<- fd(turtles, dist = 0.5, world = map_world, torus = TRUE)
}
