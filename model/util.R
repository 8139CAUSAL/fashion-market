# Small helpers. Several replace base R functions whose fixed cost per call
# dominates short vectors in webR (see the measurements in README.md).
#
# The hot code uses dim(m)[1L], not nrow(m): with NetLogoR's dependencies
# loaded, nrow() and ncol() are S4 generics, and dispatching one costs more
# than the work it does.

gumbel <- function(n) -log(-log(runif(n)))

# Runs `code` from a fixed seed, then puts the random number stream back, so
# building the city or picking something for the page never changes what
# the simulation draws next.
with_seed <- function(seed, code) {
  saved <- if (exists(".Random.seed", envir = globalenv())) get(".Random.seed", envir = globalenv())
  on.exit(if (is.null(saved)) rm(".Random.seed", envir = globalenv())
          else assign(".Random.seed", saved, envir = globalenv()))
  set.seed(seed)
  code
}

# A random pick for the page ("pick a random shopper"): its own stream, so
# looking never changes the season.
ui_pick <- function(x) {
  if (!length(x)) return(x)
  ui_draws <<- ui_draws + 1L
  x[with_seed(P$seed * 7919 + ui_draws, sample.int(length(x), 1))]
}
ui_draws <- 0L

# ifelse() without its overhead, for plain vectors.
ifelse_int <- function(test, yes, no) {
  out <- rep_len(no, length(test))
  out[test] <- rep_len(yes, length(test))[test]
  out
}

# The largest value in each row of a matrix, and its column (the first, if
# tied). max.col() does this too, at four times the cost in webR.
row_max <- function(m) {
  dm <- dim(m)
  k <- rep.int(1L, dm[1L])
  best <- m[, 1L]
  for (j in seq_len(dm[2L])[-1L]) {
    b <- m[, j] > best
    k[b] <- j
    best[b] <- m[b, j]
  }
  list(k = k, max = best)
}

# The order in which requests `key` made at times `t` are met: each one's
# place among the requests with the same key, earliest first.
rank_within <- function(key, t) {
  if (!anyDuplicated(key)) return(rep.int(1L, length(key)))
  o <- order(key, t)
  rank <- integer(length(key))
  rank[o] <- seq_along(o) - match(key[o], key[o]) + 1L
  rank
}

# Sums `x` into `n` bins by integer `bin` (1..n).
bin_sum <- function(bin, x, n) {
  out <- numeric(n)
  if (!length(bin)) return(out)
  r <- rowsum(as.numeric(x), bin)
  out[as.integer(rownames(r))] <- r[, 1]
  out
}

clamp <- function(x, lo, hi) pmin(pmax(x, lo), hi)

clock_hm <- function(s) sprintf("%02d:%02d", OPEN_HOUR + s %/% 3600, s %% 3600 %/% 60)
