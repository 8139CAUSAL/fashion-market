# The season's tallies. Every number on every tab is a sum of what
# individual agents did: each visit's outcome, each receipt, each wait, each
# unit taken off a rack, recorded by day, the area the household lives in
# and store, so any filter (a brand, an area, a store) is a sum over the
# same records. "Ours" is our family of brands.
#
# A day's row is written from its visits: finally at closing (end_day), and,
# while the day runs, as it stands at the store clock (tally_live, before
# the page's reports), so the season so far includes today so far.

init_tally <- function() {
  D <- SEASON_DAYS
  A <- AREA_BINS
  per_store <- function() array(0, c(D, A, N_STORES))
  tally <<- list(
    visits = array(0L, c(D, A, N_STORES, N_OUTCOMES)),              # visits by how they ended
    tried = array(0L, c(D, A, N_STORES)),                           # of them, went to a fitting room
    in_market = matrix(0, D, A), stayed_home = matrix(0, D, A),
    sales = per_store(), units = per_store(), cogs = per_store(), full = per_store(),
    staff_cost = matrix(0, D, N_STORES), ad_cost = matrix(0, D, N_BRANDS), offer_cost = matrix(0, D, N_BRANDS),
    deliveries = matrix(0, D, N_STORES), shipped = matrix(0, D, N_STORES), logistics = matrix(0, D, N_STORES),   # charged as stock leaves the DC
    writedown = matrix(0, D, N_BRANDS),                              # stock left at the season's end, less what it fetches
    fr_wait = matrix(0, D, N_STORES), fr_waits = matrix(0, D, N_STORES),
    till_wait = matrix(0, D, N_STORES), till_waits = matrix(0, D, N_STORES),
    util = array(0, c(D, N_STORES, 3)),                              # fitting rooms, tills, assistants
    size_req = matrix(0, D, N_STORES), size_fill = matrix(0, D, N_STORES),
    wallet = array(0, c(D, N_SEGMENTS, N_BRANDS)),                   # spend by segment and brand
    dwell = array(0, c(D, 2, 46)),                                   # minutes in store, 2-minute bins: bought, didn't
    dwell_stats = matrix(c(0, 0, 0, Inf, -Inf), D, 5, byrow = TRUE,
                         dimnames = list(NULL, c("n", "sum", "sumsq", "min", "max"))),
    stock = array(0, c(D, N_STORES, N_CATS)),                        # units on hand at the end of the day
    customers = matrix(0, D, N_BRANDS + 1),                          # households by the brand they last bought from
    ever = matrix(0, D, N_BRANDS + 1),                               # households that have bought from each brand; from competitors only
    share = matrix(0, D, 3),                                         # in-market households: bought ours (our family), another, nothing
    late = numeric(D),
    at = c(day = 0, clock = 0)                                       # when today's row was last written
  )
}

new_today <- function() {
  today <<- list(in_market = integer(AREA_BINS), stayed_home = integer(AREA_BINS), in_market_hh = integer(),
                 offer_cost = numeric(N_BRANDS), fr_q = matrix(0, N_STORES, DAY_S / 300), till_q = matrix(0, N_STORES, DAY_S / 300),
                 size_req = numeric(N_STORES), size_fill = numeric(N_STORES),
                 deliveries = numeric(N_STORES), shipped = numeric(N_STORES), logistics = numeric(N_STORES))
}

# Today's row, brought up to the store clock while the day runs (the page
# calls this before its reports). Nothing before the day starts, and the
# row is final once the day has been tallied at closing.
tally_live <- function() {
  if (season_done() || clock <= 0 || (tally$at[["day"]] == day && tally$at[["clock"]] == clock)) return(invisible())
  tally_day(clock)
}

# Writes today's row of every tally from the day's visits as they stand at
# store time `t` (Inf: the whole day, at closing). Visits count once they've
# ended; costs, waits and busy time up to `t`.
tally_day <- function(t = Inf) {
  i <- day
  if (i > SEASON_DAYS) return(invisible())
  span <- min(t, DAY_S)                        # seconds of the store day so far
  ended <- d$outcome > 0L
  paid <- d$outcome == 1L
  A <- AREA_BINS
  key <- ((d$outcome[ended] - 1L) * N_STORES + (d$store[ended] - 1L)) * A + d$bin[ended]
  tally$visits[i, , , ] <<- array(tabulate(key, A * N_STORES * N_OUTCOMES), c(A, N_STORES, N_OUTCOMES))
  k2 <- (d$store - 1L) * A + d$bin
  dim2 <- c(A, N_STORES)
  tally$tried[i, , ] <<- array(tabulate(k2[d$tried & ended], A * N_STORES), dim2)
  tally$sales[i, , ] <<- array(bin_sum(k2, d$sales, prod(dim2)), dim2)
  tally$units[i, , ] <<- array(bin_sum(k2, d$units, prod(dim2)), dim2)
  tally$cogs[i, , ] <<- array(bin_sum(k2, d$cogs, prod(dim2)), dim2)
  tally$full[i, , ] <<- array(bin_sum(k2, d$full_value, prod(dim2)), dim2)
  # In the market: those who stayed home, and those whose visit has ended
  # (all of them, at closing).
  tally$in_market[i, ] <<- today$stayed_home + tabulate(d$bin[ended], A)
  tally$stayed_home[i, ] <<- today$stayed_home

  staff_n <- S$cashiers * WAGE[["cashier"]] + S$assistants * WAGE[["assistant"]]
  tally$staff_cost[i, ] <<- staff_n * span / 3600
  tally$ad_cost[i, ] <<- LEVERS$ad$value * AD_COST * span / DAY_S
  tally$offer_cost[i, ] <<- today$offer_cost
  tally$deliveries[i, ] <<- today$deliveries
  tally$shipped[i, ] <<- today$shipped
  tally$logistics[i, ] <<- today$logistics
  # At the season's end (the last day's closing), the stock left is
  # written down to what it fetches: the brand's salvage value, of cost.
  if (is.infinite(t) && i == SEASON_DAYS) tally$writedown[i, ] <<- (1 - P_STOCK$salvage) * stock_left_cost()

  # Waits (those over by `t`) and how busy each store's fitting rooms, tills
  # and assistants were up to `t`.
  m <- legs$m[seq_len(legs$n), , drop = FALSE]
  st <- m[, "store"]; kind <- m[, "kind"]
  over <- m[, "t1"] <= t
  dur <- m[, "t1"] - m[, "t0"]
  busy <- pmax(0, pmin(m[, "t1"], t) - m[, "t0"])
  for (k in c(WAIT_FR, WAIT_TILL)) {
    on <- kind == k & over
    w <- bin_sum(st[on], dur[on], N_STORES); n <- tabulate(st[on], N_STORES)
    if (k == WAIT_FR) { tally$fr_wait[i, ] <<- w; tally$fr_waits[i, ] <<- n } else { tally$till_wait[i, ] <<- w; tally$till_waits[i, ] <<- n }
  }
  busy_fr <- bin_sum(st[kind == TRY], busy[kind == TRY], N_STORES)
  busy_till <- bin_sum(st[kind == PAY], busy[kind == PAY], N_STORES)
  sm <- staff$m[seq_len(staff$n), , drop = FALSE]
  busy_staff <- bin_sum(sm[, 1], pmax(0, pmin(sm[, 3], t) - sm[, 2]), N_STORES)
  cap <- function(n) pmax(n, 1e-9) * span
  tally$util[i, , 1] <<- busy_fr / cap(S$fitting_rooms)
  tally$util[i, , 2] <<- busy_till / cap(S$cashiers)
  tally$util[i, , 3] <<- ifelse(S$assistants > 0, busy_staff / cap(S$assistants), NA)

  tally$size_req[i, ] <<- today$size_req
  tally$size_fill[i, ] <<- today$size_fill
  tally$wallet[i, , ] <<- array(bin_sum((d$brand[paid] - 1L) * N_SEGMENTS + d$seg[paid], d$sales[paid], N_SEGMENTS * N_BRANDS),
                                c(N_SEGMENTS, N_BRANDS))
  mins <- (d$gone[ended] - d$arrive[ended]) / 60
  bin <- pmin(46L, as.integer(mins %/% 2) + 1L)
  bought <- paid[ended]
  tally$dwell[i, , ] <<- rbind(tabulate(bin[bought], 46), tabulate(bin[!bought], 46))
  tally$dwell_stats[i, ] <<- if (length(mins)) c(length(mins), sum(mins), sum(mins^2), min(mins), max(mins)) else c(0, 0, 0, Inf, -Inf)
  on_hand <- stock$rack + stock$room + stock$go_back
  tally$stock[i, , ] <<- by_category(on_hand)

  # Households as buyers, with today's purchases so far (end_day has
  # already applied them to mk at closing; applying them again changes
  # nothing).
  last <- mk$last_brand; last[d$hh[paid]] <- d$brand[paid]
  cust <- mk$customer; cust[cbind(d$hh[paid], d$brand[paid])] <- TRUE
  n <- mk$hh$n
  tally$customers[i, ] <<- tabulate(last + 1L, N_BRANDS + 1L)
  ours_any <- .rowSums(cust[, OURS_B, drop = FALSE], n, sum(OURS_B)) > 0
  rivals_any <- .rowSums(cust[, !OURS_B, drop = FALSE], n, sum(!OURS_B)) > 0
  tally$ever[i, ] <<- c(.colSums(cust, n, N_BRANDS), sum(!ours_any & rivals_any))
  ours <- sum(paid & OURS_B[d$brand]); other <- sum(paid) - ours
  tally$share[i, ] <<- c(ours, other, sum(tally$in_market[i, ]) - ours - other)
  tally$late[i] <<- d$late
  tally$at <<- c(day = day, clock = if (is.finite(t)) t else Inf)
}

# ---- Sums over the season ----------------------------------------------------------

season_done <- function() isTRUE(season_over)
# Days finished, and the days with a row so far: those and, while it runs, today.
days_complete <- function() min(day - (!season_done()), SEASON_DAYS)
days_so_far <- function() seq_len(days_complete() + (!season_done() && clock > 0))

# Store-level sums over a set of days: sales by store, and so on.
store_sum <- function(what, days = days_so_far()) {
  x <- tally[[what]][days, , , drop = FALSE]
  colSums(colSums(x, dims = 1), dims = 1)
}

# A tally's row for the latest day so far (NULL before the first).
last_row <- function(what, dd = days_so_far()) if (length(dd)) tally[[what]][max(dd), ] else NULL

brand_of_stores <- function(v) as.vector(rowsum(v, STORES$brand, reorder = TRUE))

# Every visit of the season, compactly (day, household, store, outcome, and
# what was paid), for a household's history and the export.
season_log_add <- function() {
  k <- d$v
  if (!k) return(invisible())
  n <- season_log$n
  cap <- dim(season_log$m)[1L]
  if (n + k > cap) {
    season_log$m <<- rbind(season_log$m, matrix(0L, cap, 4))
    season_log$sales <<- c(season_log$sales, numeric(length(season_log$sales)))
  }
  i <- n + seq_len(k)
  season_log$m[i, ] <<- cbind(day, d$hh, d$store, d$outcome)
  season_log$sales[i] <<- d$sales
  season_log$n <<- n + k
}

vlog_season_rows <- function(h) {
  i <- which(season_log$m[seq_len(season_log$n), 2] == h)
  cbind(season_log$m[i, , drop = FALSE], season_log$sales[i])
}

