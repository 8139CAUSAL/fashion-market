# Port of SpaDES.tools::adj() (2.1.1) for the arguments NetLogoR uses:
# pairs = TRUE, no target/numNeighs. Cells are numbered row-major, as terra
# numbers raster cells. The neighbour order (topl, top, topr, lef, rig, botl,
# bot, botr) and column order (from, to, id) match the original, because
# NetLogoR::neighbors() returns its rows in whatever order adj() produces.
#
# Deliberate difference: the original wraps a torus with cell-number
# arithmetic (`to + numCol * (from - to)`), which is only correct for
# left/right neighbours. For diagonal neighbours it happens to work when the
# world is square and otherwise returns cells outside the grid — e.g. in a
# 3x6 torus, cell 1's bottom-left neighbour comes back as -6 instead of 12.
# This port wraps by row and column instead, so it is correct for every
# world shape.

adj <- function(x = NULL, cells, directions = 8, sort = FALSE, pairs = TRUE,
                include = FALSE, target = NULL, numCol = NULL, numCell = NULL,
                match.adjacent = FALSE, cutoff.for.data.table = 2e3,
                torus = FALSE, id = NULL, numNeighs = NULL, returnDT = FALSE) {
  cells <- as.integer(cells)

  if (is.null(numCol) || is.null(numCell)) {
    if (is.null(x)) stop("must provide either numCol & numCell or a x")
    numCol <- as.integer(ncol(x))
    numCell <- as.integer(nrow(x) * ncol(x))
  }
  numRow <- numCell %/% numCol

  if (!is.null(numNeighs)) {
    stop("SpaDES.tools shim: the numNeighs argument is not supported.", call. = FALSE)
  }

  # Row/column offsets, named as in the original.
  steps <- list(
    topl = c(-1L, -1L), top = c(-1L, 0L), topr = c(-1L, 1L),
    lef = c(0L, -1L), self = c(0L, 0L), rig = c(0L, 1L),
    botl = c(1L, -1L), bot = c(1L, 0L), botr = c(1L, 1L)
  )

  order <- if (identical(directions, "bishop")) {
    if (match.adjacent) c("topl", "botl", "topr", "botr") else c("topl", "topr", "botl", "botr")
  } else if (identical(as.numeric(directions), 8)) {
    if (match.adjacent) c("topl", "lef", "botl", "topr", "rig", "botr", "top", "bot")
    else c("topl", "top", "topr", "lef", "rig", "botl", "bot", "botr")
  } else if (identical(as.numeric(directions), 4)) {
    if (match.adjacent) c("lef", "rig", "top", "bot") else c("top", "lef", "rig", "bot")
  } else {
    stop("directions must be 4 or 8 or 'bishop'")
  }
  if (include) {
    order <- append(order, "self", after = if (match.adjacent) 0L else length(order) %/% 2L)
  }

  rows <- (cells - 1L) %/% numCol + 1L
  cols <- (cells - 1L) %% numCol + 1L

  toCells <- unlist(lapply(order, function(step) {
    rr <- rows + steps[[step]][1L]
    cc <- cols + steps[[step]][2L]
    if (torus) {
      rr <- (rr - 1L) %% numRow + 1L
      cc <- (cc - 1L) %% numCol + 1L
      (rr - 1L) * numCol + cc
    } else {
      # NA marks a neighbour off the edge of the world; dropped below.
      ifelse(rr < 1L | rr > numRow | cc < 1L | cc > numCol, NA_integer_, (rr - 1L) * numCol + cc)
    }
  }), use.names = FALSE)

  adj <- cbind(from = rep.int(cells, times = length(order)), to = as.integer(toCells))
  if (!is.null(id)) adj <- cbind(adj, id = rep.int(id, times = length(order)))

  adj <- adj[!is.na(adj[, "to"]), , drop = FALSE]
  if (!is.null(target)) adj <- adj[adj[, "to"] %in% target, , drop = FALSE]

  if (sort) {
    adj <- if (pairs) {
      if (match.adjacent) adj[order(adj[, "from"], adj[, "to"]), , drop = FALSE]
      else adj[order(adj[, "from"]), , drop = FALSE]
    } else {
      adj[order(adj[, "to"]), , drop = FALSE]
    }
  }

  if (!pairs) {
    if (match.adjacent) return(unique(adj[, "to"]))
    adj <- adj[, if (is.null(id)) "to" else c("to", "id"), drop = FALSE]
  }

  # NetLogoR only asks for a data.table with very large agent sets.
  if (returnDT) data.table::as.data.table(adj) else adj
}

# Port of SpaDES.tools::wrap() for coordinate matrices: moves points that
# fall outside `bounds` to the opposite side of the world.
wrap <- function(X, bounds, withHeading = FALSE) {
  if (isTRUE(withHeading)) {
    stop("SpaDES.tools shim: wrap(withHeading = TRUE) is not supported.", call. = FALSE)
  }
  crds <- if (isS4(X)) X@.Data[, 1:2, drop = FALSE] else X[, 1:2, drop = FALSE]
  if (!identical(tolower(colnames(crds)), c("x", "y"))) {
    stop("When X is a matrix, it must have 2 columns, x and y,",
         "as from say, coordinates(SpatialPointsObj)")
  }
  bounds <- as.numeric(bounds)
  cbind(
    x = (crds[, 1] - bounds[1L]) %% (bounds[2L] - bounds[1L]) + bounds[1L],
    y = (crds[, 2] - bounds[3L]) %% (bounds[4L] - bounds[3L]) + bounds[3L]
  )
}
