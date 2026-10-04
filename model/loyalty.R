# Loyalty tiers: each brand has its own ladder (in the default world: no
# loyalty, low, mid, high), and every household stands on a rung of every
# brand's ladder. A tier with a brand changes how the household weighs that
# brand's stores: its pull, how much price matters there, how long a bad
# visit is remembered, how far the household will travel to it, and how it
# responds to the brand's offers.
#
# A tier is earned by spend, as a loyalty programme's status is: each tier
# has the spend with the brand in a season that reaches it (the lowest
# tier, nothing). The season is the qualifying period.
#   At Setup      each brand's tiers are handed out by the households' taste
#                 for the brand, those who like it most in its highest tier,
#                 down to the tiers' shares: where last season's spend put
#                 them, each having spent at least its tier's spend.
#   This season   a household's spend with the brand (what it paid, after
#                 markdowns, promotions and coupons, less its refunds: net
#                 of returns) adds up; the evening it reaches a higher
#                 tier's spend, the household moves up. It keeps the tier
#                 it holds for the rest of the season, even if a return
#                 takes its spend back below it.
#   Season's end  each household is where its season's net spend puts it:
#                 the tier it started in (kept), a higher one (moved up), or
#                 a lower one (dropped). Until then, one below its starting
#                 tier's spend hasn't re-qualified yet.

TIER_N <- NULL
TIER_COLS <- c("share", "spend", "pull", "price", "memory", "radius", "offers")
TIER_MOVES <- c("moved up", "kept", "not re-qualified yet")

tiers_install <- function(brands) {
  B <- length(brands); K <- MAX_TIERS
  TIER_N <<- vapply(brands, function(b) length(b$loyalty$tiers), 0L)
  TIER_IDS <<- lapply(brands, function(b) vapply(b$loyalty$tiers, `[[`, "", "id"))
  TIER_NAMES <<- lapply(brands, function(b) vapply(b$loyalty$tiers, `[[`, "", "name"))
  tab <- function(col, fill) {
    m <- matrix(fill, B, K)
    for (b in seq_len(B)) m[b, seq_len(TIER_N[b])] <- vapply(brands[[b]]$loyalty$tiers, function(t) as.numeric(t[[col]]), 0)
    m
  }
  TIER_SHARE <<- tab("share", 0); TIER_SPEND <<- tab("spend", Inf); TIER_PULL <<- tab("pull", 0); TIER_PRICE <<- tab("price", 1)
  TIER_MEMORY <<- tab("memory", 1); TIER_RADIUS <<- tab("radius", 1); TIER_OFFERS <<- tab("offers", 1)
}

# Households x brands: the tier each starts the season in, by rank of taste.
initial_tiers <- function(taste) {
  n <- dim(taste)[1L]
  out <- matrix(1L, n, N_BRANDS)
  for (b in seq_len(N_BRANDS)) {
    k <- TIER_N[b]
    top <- cumsum(rev(TIER_SHARE[b, seq_len(k)]))            # share of households at or above each tier, from the top
    place <- integer(n); place[order(-taste[, b])] <- seq_len(n)
    from_top <- findInterval((place - 0.5) / n, c(0, top[-k]))  # 1: the top tier
    out[, b] <- k + 1L - from_top
  }
  out
}

# The tier a season's spend `spend` with brand b reaches.
spend_tier <- function(spend, b) findInterval(spend, TIER_SPEND[b, seq_len(TIER_N[b])])

# Households x brands: each household's net spend with each brand this
# season, with today's purchases and refunds so far when they haven't been
# added yet (the reports' view of the season, like tally_live's).
season_spend <- function(rd = report_day()) {
  sp <- mk$spend
  if (rd$day > mk$spend_day) {
    paid <- which(rd$d$outcome == 1L)
    if (length(paid)) {
      hb <- cbind(rd$d$hh[paid], rd$d$brand[paid])
      sp[hb] <- sp[hb] + rd$d$sales[paid]
    }
    rf <- refunds_today(rd$today$returned)
    if (length(rf$hh)) sp[cbind(rf$hh, rf$brand)] <- sp[cbind(rf$hh, rf$brand)] - rf$refund
  }
  sp
}

# After closing: today's purchases add to each household's season spend,
# and its refunds today (rf, refunds_today()) come off it. A household
# whose spend with a brand has reached a higher tier moves up to it; the
# highest spend each has reached is kept (spend_max), since that's what its
# tier stands on until the season's end.
tiers_evening <- function(rf = refunds_today()) {
  paid <- which(d$outcome == 1L)
  mk$spend_day <<- day
  if (length(rf$hh)) mk$spend[cbind(rf$hh, rf$brand)] <<- mk$spend[cbind(rf$hh, rf$brand)] - rf$refund
  if (!length(paid)) return(invisible())
  hb <- cbind(d$hh[paid], d$brand[paid])                 # a household makes one shopping visit a day
  mk$spend[hb] <<- mk$spend[hb] + d$sales[paid]
  mk$spend_max[hb] <<- pmax(mk$spend_max[hb], mk$spend[hb])
  for (b in unique(hb[, 2])) {
    h <- hb[hb[, 2] == b, 1]
    reached <- spend_tier(mk$spend[h, b], b)
    up <- reached > mk$tier[h, b]
    if (any(up)) mk$tier[h[up], b] <<- reached[up]
  }
}

# Brand b's households by the tier they started in against the tier their
# season's spend reaches so far (starting tier x reached tier), and each
# household's move: 1 moved up, 2 kept, 3 not re-qualified yet (dropped,
# at the season's end).
tier_moves <- function(b, spend = season_spend()[, b]) {
  K <- TIER_N[b]
  start <- mk$tier0[, b]
  reached <- spend_tier(spend, b)
  move <- ifelse(reached > start, 1L, ifelse(reached == start, 2L, 3L))
  list(start = start, reached = reached, move = move,
       matrix = matrix(tabulate((start - 1L) * K + reached, K * K), K, K, byrow = TRUE))
}

# How household h stands with brand b: its tier, what it has spent this
# season, the spend to the next tier, and whether it has re-qualified for
# the tier it started in.
tier_outlook <- function(h, b) {
  k <- mk$tier[h, b]; k0 <- mk$tier0[h, b]
  spend <- season_spend()[h, b]
  nxt <- if (k < TIER_N[b]) k + 1L else NA_integer_
  list(tier = k, name = TIER_NAMES[[b]][k], top = k >= TIER_N[b], bottom = k <= 1L, spend = spend,
       next_name = if (is.na(nxt)) NULL else TIER_NAMES[[b]][nxt], to_next = if (is.na(nxt)) NA else TIER_SPEND[b, nxt] - spend,
       started = TIER_NAMES[[b]][k0], keep_spend = TIER_SPEND[b, k0], requalified = spend >= TIER_SPEND[b, k0],
       move = TIER_MOVES[if (spend_tier(spend, b) > k0) 1L else if (spend >= TIER_SPEND[b, k0]) 2L else 3L])
}
