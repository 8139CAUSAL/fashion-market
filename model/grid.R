# Routing on a grid, for both worlds: the market map (tiles of tens of
# metres, roads fast, other land slower, water impassable) and a store floor
# (half-metre cells, every open cell the same). One function works out, for
# each target, the fastest time from every cell to it, the length of that
# route, and the next cell along it.
#
# A move goes to any of the 8 neighbours, without cutting a corner (a
# diagonal move needs both cells beside it open). Crossing a cell at speed v
# takes (its size / v) seconds, so a move costs half of each cell's crossing
# time (times sqrt(2) on the diagonal); a cell with speed 0 can't be entered.
#
# The fields grow out from the targets: each round, every cell whose time
# improved in the last one offers its neighbours a route through it, for
# every target at once, until no time improves. The work each round is only
# at the edge of what's changing, so a round is a handful of vector
# operations however big the grid.

# `speed`: rows x cols matrix (row 1 is the north edge), 0 where impassable;
# `size`: a cell's width in metres; `targets`: linear cell indices. Returns
# time (s) and length (m) matrices of cells x targets, and `next_cell`, the
# next cell along the fastest route (the target itself at the target, 0
# where it can't be reached).
grid_fields <- function(speed, size, targets) {
  TOL <- 1e-9                        # an improvement smaller than this is rounding, not a shorter route
  H <- dim(speed)[1L]; W <- dim(speed)[2L]; K <- length(targets); n <- H * W
  open <- as.vector(speed > 0)
  half <- rep(Inf, n); half[open] <- 0.5 * size / as.vector(speed)[open]    # half a cell's crossing time
  nb <- grid_neighbours(H, W, open)
  step_m <- size * nb$len
  D <- matrix(Inf, n, K); L <- matrix(Inf, n, K); N <- matrix(0L, n, K)
  pending <- (seq_len(K) - 1L) * n + as.integer(targets)     # entries of D (cell, target) improved, not yet passed on
  D[pending] <- 0; L[pending] <- 0; N[pending] <- as.integer(targets)
  # Entries are passed on roughly in order of time, a band of `band`
  # seconds at a time (a cell crossed at the fastest speed), so a cell is
  # rarely improved twice: a slow route doesn't race ahead of a fast one.
  band <- size / max(speed)
  upto <- 0
  while (length(pending)) {
    upto <- max(upto + band, min(D[pending]))
    repeat {
      due <- D[pending] <= upto
      if (!any(due)) break
      active <- pending[due]; pending <- pending[!due]
      cell <- (active - 1L) %% n + 1L
      base <- active - cell                                   # the target's column offset
      improved <- vector("list", 8L)
      for (d in 1:8) {
        to_cell <- nb$cell[cell, d]
        ok <- to_cell > 0L
        if (!any(ok)) next
        from <- active[ok]; tc <- to_cell[ok]; to <- base[ok] + tc
        cand <- D[from] + (half[cell[ok]] + half[tc]) * nb$len[d]
        better <- cand < D[to] - TOL
        if (!any(better)) next
        to <- to[better]; from <- from[better]
        D[to] <- cand[better]; L[to] <- L[from] + step_m[d]; N[to] <- cell[ok][better]
        improved[[d]] <- to
      }
      pending <- unique(c(pending, unlist(improved, use.names = FALSE)))
    }
  }
  list(time = D, length = L, next_cell = N, H = H, W = W)
}

# Each open cell's neighbour in each of the 8 directions (0: none, closed,
# or a diagonal that would cut a corner), and each direction's step, in
# cells.
grid_neighbours <- function(H, W, open) {
  r <- rep(seq_len(H), W); c <- rep(seq_len(W), each = H)
  moves <- rbind(c(-1L, 0L), c(1L, 0L), c(0L, -1L), c(0L, 1L), c(-1L, -1L), c(-1L, 1L), c(1L, -1L), c(1L, 1L))
  at <- function(rr, cc) {
    ok <- rr >= 1L & rr <= H & cc >= 1L & cc <= W
    out <- integer(length(rr)); i <- (cc[ok] - 1L) * H + rr[ok]
    out[ok] <- as.integer(i * open[i])
    out
  }
  cell <- vapply(1:8, function(d) at(r + moves[d, 1], c + moves[d, 2]), integer(H * W))
  cell[!open, ] <- 0L
  for (d in 5:8) cell[at(r + moves[d, 1], c) == 0L | at(r, c + moves[d, 2]) == 0L, d] <- 0L
  list(cell = cell, len = c(1, 1, 1, 1, rep(sqrt(2), 4)))
}

# The fastest route from each cell `from[r]` to target `k[r]` (a column of
# the fields), cell by cell. Returns the cells of every route in one vector,
# route by route, with each route's first position and length.
grid_routes <- function(fields, from, k) {
  n <- length(from)
  pos <- as.integer(from)
  cells <- list(pos); owner <- list(seq_len(n)); step <- list(integer(n))
  nx <- fields$next_cell[cbind(pos, k)]
  live <- which(nx != pos & nx > 0L)
  s <- 0L
  while (length(live)) {
    s <- s + 1L
    pos[live] <- fields$next_cell[cbind(pos[live], k[live])]
    cells[[s + 1L]] <- pos[live]; owner[[s + 1L]] <- live; step[[s + 1L]] <- rep.int(s, length(live))
    nx <- fields$next_cell[cbind(pos[live], k[live])]
    live <- live[nx != pos[live] & nx > 0L]
  }
  owner <- unlist(owner); o <- order(owner, unlist(step))
  owner <- owner[o]
  list(cells = unlist(cells)[o], owner = owner, first = match(seq_len(n), owner), n = tabulate(owner, n))
}
