# The subset of terra that NetLogoR's matrix-world code calls, in plain R.
# Everything here mirrors terra's behaviour for those calls; anything that
# needs real rasters stops with an explanatory error instead.

unsupported <- function(what) {
  stop(what, " needs the full 'terra' package, which is not available in the ",
       "Fashion Market. Use worldMatrix/worldArray objects instead.", call. = FALSE)
}

# ---- Extents -----------------------------------------------------------

# A SpatExtent is a numeric vector c(xmin, xmax, ymin, ymax), as returned by
# as.vector() on a real terra extent.
setClass("SpatExtent", contains = "numeric")

setMethod("show", "SpatExtent", function(object) {
  cat("SpatExtent :", paste(format(object@.Data), collapse = ", "), "(xmin, xmax, ymin, ymax)\n")
})

# ext(xmin, xmax, ymin, ymax), or with xy = TRUE, ext(xmin, ymin, xmax, ymax).
# Arguments may be given separately or as one vector.
ext <- function(x, ..., xy = FALSE) {
  v <- as.numeric(unlist(c(list(x), list(...))))
  if (length(v) != 4L) stop("ext() needs four coordinates.", call. = FALSE)
  if (isTRUE(xy)) v <- v[c(1L, 3L, 2L, 4L)]
  new("SpatExtent", v)
}

xmin <- function(x) as.numeric(x)[1L]
xmax <- function(x) as.numeric(x)[2L]
ymin <- function(x) as.numeric(x)[3L]
ymax <- function(x) as.numeric(x)[4L]

# ---- Distances ---------------------------------------------------------

# Planar distances between two sets of points (two-column matrices).
# pairwise = TRUE gives the distance from x[i, ] to y[i, ] (a one-row input
# is recycled); otherwise the full nrow(x) by nrow(y) distance matrix.
distance <- function(x, y, lonlat = FALSE, pairwise = FALSE, ...) {
  if (isTRUE(lonlat)) unsupported("Geographic (lonlat) distance")
  x <- as.matrix(x)
  y <- as.matrix(y)
  if (pairwise) {
    n <- max(nrow(x), nrow(y))
    if (!nrow(x) %in% c(1L, n) || !nrow(y) %in% c(1L, n)) {
      stop("distance(pairwise = TRUE) needs inputs with the same number of rows.", call. = FALSE)
    }
    sqrt((x[, 1] - y[, 1])^2 + (x[, 2] - y[, 2])^2)
  } else {
    sqrt(outer(x[, 1], y[, 1], "-")^2 + outer(x[, 2], y[, 2], "-")^2)
  }
}

# ---- Rasters (not supported) ------------------------------------------

setClass("SpatRaster", representation("VIRTUAL"))

setGeneric("nrow")
setGeneric("ncol")
setMethod("nrow", "SpatRaster", function(x) unsupported("nrow() on a SpatRaster"))
setMethod("ncol", "SpatRaster", function(x) unsupported("ncol() on a SpatRaster"))

# NetLogoR evaluates crs() once when it is built; matrix worlds carry no CRS.
crs <- function(x, ...) ""

rast <- function(...) unsupported("rast()")
values <- function(x, ...) unsupported("values()")
plot <- function(x, y, ...) unsupported("terra::plot()")
