#!/usr/bin/env Rscript
# Checks the shim packages in tools/shims/ against independent reference
# implementations, so a shim that silently disagrees with the package it
# stands in for is caught here rather than inside a model.
#
#   Rscript tools/test-shims.R

script_path <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
project_root <- normalizePath(file.path(dirname(script_path), ".."))
lib <- file.path(tempdir(), "shim-lib")
dir.create(lib, showWarnings = FALSE)

for (pkg in c("terra", "quickPlot", "SpaDES.tools")) {
  install.packages(file.path(project_root, "tools", "shims", pkg), lib = lib,
                   repos = NULL, type = "source", quiet = TRUE,
                   INSTALL_opts = c("--no-docs", "--no-html", "--no-byte-compile"))
}
terra <- loadNamespace("terra", lib.loc = lib)
spades <- loadNamespace("SpaDES.tools", lib.loc = lib)
loadNamespace("quickPlot", lib.loc = lib)

failures <- 0L
check <- function(label, ok) {
  if (!isTRUE(ok)) failures <<- failures + 1L
  cat(if (isTRUE(ok)) "ok   " else "FAIL ", label, "\n", sep = "")
}

# ---- Reference neighbours ---------------------------------------------

# Cells are numbered row-major. Returns the neighbours of `cell` in a
# nrow x ncol grid, computed from row/column arithmetic rather than the
# cell-number arithmetic the shim uses.
reference_neighbours <- function(cell, nrow, ncol, directions, torus) {
  r <- (cell - 1L) %/% ncol + 1L
  c0 <- (cell - 1L) %% ncol + 1L
  offsets <- if (directions == 8) {
    list(c(-1,-1), c(-1,0), c(-1,1), c(0,-1), c(0,1), c(1,-1), c(1,0), c(1,1))
  } else {
    list(c(-1,0), c(0,-1), c(0,1), c(1,0))
  }
  out <- integer(0)
  for (o in offsets) {
    rr <- r + o[1]
    cc <- c0 + o[2]
    if (torus) {
      rr <- (rr - 1L) %% nrow + 1L
      cc <- (cc - 1L) %% ncol + 1L
    } else if (rr < 1 || rr > nrow || cc < 1 || cc > ncol) {
      next
    }
    out <- c(out, (rr - 1L) * ncol + cc)
  }
  as.integer(sort(out))
}

for (dims in list(c(5L, 7L), c(4L, 4L), c(3L, 6L))) {
  m <- matrix(0, nrow = dims[1], ncol = dims[2])
  for (directions in c(4, 8)) {
    for (torus in c(FALSE, TRUE)) {
      cells <- seq_len(dims[1] * dims[2])
      a <- spades$adj(m, cells = cells, directions = directions, torus = torus)
      same <- vapply(cells, function(cell) {
        got <- sort(a[a[, "from"] == cell, "to"])
        identical(as.integer(got), reference_neighbours(cell, dims[1], dims[2], directions, torus))
      }, logical(1))
      check(sprintf("adj %dx%d directions=%d torus=%s", dims[1], dims[2], directions, torus), all(same))
    }
  }
}

# Neighbour ordering must match SpaDES.tools (topl, top, topr, lef, rig, botl,
# bot, botr) because NetLogoR::neighbors() returns rows in that order.
m <- matrix(0, nrow = 5, ncol = 5)
a <- spades$adj(m, cells = 13L, directions = 8, torus = FALSE)
check("adj neighbour order", identical(as.integer(a[, "to"]), c(7L, 8L, 9L, 12L, 14L, 17L, 18L, 19L)))

a <- spades$adj(m, cells = c(1L, 2L), directions = 4, torus = FALSE, id = c(10L, 20L))
check("adj column order (from, to, id)", identical(colnames(a), c("from", "to", "id")))

# ---- wrap --------------------------------------------------------------

bounds <- terra$ext(-0.5, 9.5, -0.5, 9.5)
w <- spades$wrap(cbind(x = c(-1, 10, 4), y = c(4, -2, 4)), bounds)
check("wrap moves points across the torus",
      isTRUE(all.equal(unname(w), rbind(c(9, 4), c(0, 8), c(4, 4)))))
check("wrap keeps interior points", isTRUE(all.equal(unname(w[3, ]), c(4, 4))))

# ---- terra extent and distance ----------------------------------------

e <- terra$ext(0, 10, 0, 20)
check("ext is a SpatExtent", inherits(e, "SpatExtent"))
check("ext accessors", identical(c(terra$xmin(e), terra$xmax(e), terra$ymin(e), terra$ymax(e)), c(0, 10, 0, 20)))
check("ext xy order", identical(as.numeric(terra$ext(c(0, 1, 10, 21), xy = TRUE)), c(0, 10, 1, 21)))
check("as.vector(ext)", identical(as.vector(e), c(0, 10, 0, 20)))

p <- cbind(c(0, 3), c(0, 4))
q <- cbind(c(3, 0), c(4, 0))
check("distance pairwise", identical(terra$distance(p, q, pairwise = TRUE), c(5, 5)))
check("distance matrix", identical(dim(terra$distance(p, q)), c(2L, 2L)))
check("distance matrix values", identical(terra$distance(p, q)[1, 1], 5))

cat(sprintf("\n%s\n", if (failures == 0L) "All shim checks passed." else sprintf("%d check(s) FAILED.", failures)))
quit(status = if (failures == 0L) 0L else 1L)
