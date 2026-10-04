# Each brand's calendar: its promotions, markdowns and replenishment over
# the season.
#
# The world's calendar is the plan (world.R checks it). The running
# calendar starts from it at Setup. What each markdown and each order did on
# its days is recorded beside the plan.
#
# A promotion takes a share off some products (the whole range, some
# categories, chosen products) from its first day to its last, for the
# households it reaches: its tiers of the brand, in its areas (or
# everywhere). A product has at most one promotion on any day for any
# household. Households it reaches hear of it, in proportion to how much of
# the brand's range in the stores it covers; at the rack, a product's price
# is its promoted price.
#
# Markdowns and replenishment act on chosen days: once, or on some weekdays
# from one day to another. Each acts in the morning, before opening, on the
# stock and sales up to the night before, and a product takes at most one
# entry of each kind a day. A markdown takes a share off full price, to the
# season's end: it's permanent, the deeper markdown always wins, and so a
# markdown never raises a price (markdowns_today). Replenishment orders
# stock from the DC (stock.R, replenish_today). A brand's price rules say
# whether its promotions also come off marked-down products.
#
# A product's price on a day (the shopper's, at the rack):
#   its list price x the brand's price change
#   less its markdown in force
#   less its promotion in force, if the household is reached (and, on a
#     marked-down product, only if the brand's promotions apply to them)
#   less the household's coupon, if it holds one good here (offers.R)

# ---- The plan, from the world ---------------------------------------------------------

# The world's calendars as tables (world_install): what each entry covers,
# and for a promotion, the tiers and areas it reaches.
calendar_install <- function(brands, W) {
  area_ids <- if (is.list(W$macro$areas)) vapply(W$macro$areas, function(a) a$id, "") else character()
  pr <- list(); md <- list(); rp <- list()
  for (b in seq_len(length(brands))) {
    cal <- brands[[b]]$calendar
    for (x in cal$promotions) pr[[length(pr) + 1L]] <- list(
      brand = b, id = x$id, name = x$name, from = as.integer(x$from), to = as.integer(x$to), depth = as.numeric(x$depth),
      cover = calendar_cover(b, x), tiers = match(unlist(x$tiers), TIER_IDS_OF(brands[[b]])),
      areas = match(unlist(x$areas), area_ids), source = "plan")
    for (x in cal$markdowns) md[[length(md) + 1L]] <- c(entry_when(x), list(
      brand = b, id = x$id, name = x$name, which = x$which, by = as.numeric(x$by), min_days = as.numeric(x$min_days),
      rest_days = as.numeric(x$rest_days), mode = x$mode, depth = as.numeric(x$depth), max = as.numeric(x$max),
      cover = calendar_cover(b, x)))
    for (x in cal$replenishment) rp[[length(rp) + 1L]] <- c(entry_when(x), list(
      brand = b, id = x$id, name = x$name, rule = x$rule, cover_weeks = as.numeric(x$cover), reorder_weeks = as.numeric(x$reorder),
      cover = calendar_cover(b, x)))
  }
  CAL_PLAN <<- list(promotions = pr, markdowns = md, replenishment = rp)
}

# When a markdown or replenishment entry acts: its span, its weekdays (as
# their numbers, Monday 1), and a flag for each day of the season.
entry_when <- function(x) {
  wd <- as.character(unlist(x$weekdays))
  acts <- logical(SEASON_DAYS)
  acts[entry_days(as.integer(x$from), as.integer(x$to), wd)] <- TRUE
  list(from = as.integer(x$from), to = as.integer(x$to), weekdays = match(wd, DAYS), acts = acts)
}

# The entries of a kind acting today.
acting_today <- function(entries) which(vapply(entries, function(x) x$acts[day], TRUE))

TIER_IDS_OF <- function(b) vapply(b$loyalty$tiers, function(t) t$id, "")

# The products of brand b a calendar entry covers (a logical over the
# brand's product numbers).
calendar_cover <- function(b, x) {
  ok <- PROD_OK[b, ]
  items <- unlist(x$items)
  switch(x$on,
    range = ok,
    categories = ok & PROD_CAT[b, ] %in% match(items, CATEGORY_IDS),
    products = ok & PROD_ID[b, ] %in% items)
}

# ---- The running calendar ----------------------------------------------------------------

# At Setup: the plan, as matrices the day's work indexes. Promotions: brand,
# days, depth, the products each covers (cover: promotions x products), the
# tiers (promotions x MAX_TIERS) and area bins (promotions x AREA_BINS) it
# reaches, and where it came from (the plan). The records of what markdowns
# and orders did start empty.
init_calendar <- function() {
  cal <<- list(pr = promo_table(CAL_PLAN$promotions),
               taken = list(entry = integer(), day = integer(), took = integer(), deeper = integer(), on_plan = integer(),
                            too_new = integer(), rested = integer(), not_in = integer()),
               orders = list(entry = integer(), day = integer(), units = numeric(), arrive = integer()))
  prices_today()
}

promo_table <- function(entries) {
  k <- length(entries)
  t <- list(n = k, brand = integer(k), name = character(k), from = integer(k), to = integer(k), depth = numeric(k),
            source = character(k),
            cover = matrix(FALSE, k, N_PROD), tiers = matrix(FALSE, k, MAX_TIERS), bins = matrix(FALSE, k, AREA_BINS))
  for (i in seq_len(k)) {
    x <- entries[[i]]
    t$brand[i] <- x$brand; t$name[i] <- x$name; t$from[i] <- x$from; t$to[i] <- x$to; t$depth[i] <- x$depth
    t$source[i] <- x$source
    t$cover[i, ] <- x$cover
    t$tiers[i, x$tiers] <- TRUE
    t$bins[i, ] <- if (length(x$areas)) seq_len(AREA_BINS) %in% x$areas else TRUE
  }
  t
}

# ---- Today ---------------------------------------------------------------------------

# Before the day's decisions (after the morning's markdowns): the
# promotions running today, with how much of its brand's range in the
# stores each covers.
prices_today <- function() {
  t <- cal$pr
  on <- which(t$from <= day & t$to >= day)
  applies <- function(k) {                             # the products promotion k takes something off today
    b <- t$brand[k]
    t$cover[k, ] & (P_PRICE$promos_on_markdowns[b] | markdown[b, ] <= 0)
  }
  share <- vapply(on, function(k) {
    b <- t$brand[k]
    live <- launched[b, ] & PROD_OK[b, ]
    if (any(live)) sum(applies(k) & live) / sum(live) else 0
  }, 0)
  today_promos <<- list(k = on, share = share,
                        off = matrix(vapply(on, function(k) applies(k) * t$depth[k], numeric(N_PROD)), length(on), N_PROD, byrow = TRUE))
}

# Households x today's promotions: which reach each household (its tier
# with the promotion's brand, and where it lives).
promo_reach <- function(h) {
  t <- cal$pr; on <- today_promos$k
  out <- matrix(FALSE, length(h), length(on))
  bins <- mk$hh$bin[h]
  for (j in seq_along(on)) {
    k <- on[j]
    out[, j] <- t$tiers[k, ][mk$tier[h, t$brand[k]]] & t$bins[k, ][bins]
  }
  out
}

# Households x brands: how much of each brand's range the promotions that
# reach the household cover (what it hears of), and the share they take off
# it, on average (what it expects to save).
promo_heard <- function(reach) {
  n <- dim(reach)[1L]
  heard <- matrix(0, n, N_BRANDS); off <- matrix(0, n, N_BRANDS)
  t <- cal$pr
  for (j in seq_along(today_promos$k)) {
    k <- today_promos$k[j]; b <- t$brand[k]
    r <- reach[, j]
    if (!any(r)) next
    heard[r, b] <- heard[r, b] + today_promos$share[j]
    off[r, b] <- off[r, b] + t$depth[k] * today_promos$share[j]
  }
  list(heard = heard, off = off)
}

# Today's visits' promotions: the share off each of its brand's products for
# every visit, as a small table of the distinct combinations (visits
# reached by the same promotions share a row).
promo_rows <- function(brand, reach) {
  v <- length(brand); on <- today_promos$k
  if (!length(on)) return(list(row = rep(1L, v), off = matrix(0, 1, N_PROD)))
  pb <- cal$pr$brand[on]
  bit <- integer(length(on))                          # each promotion's place among its brand's today
  for (b in unique(pb)) bit[pb == b] <- seq_len(sum(pb == b)) - 1L
  M <- max(bit) + 1
  mask <- numeric(v)
  for (j in seq_along(on)) { r <- reach[, j] & brand == pb[j]; mask[r] <- mask[r] + 2^bit[j] }
  key <- (brand - 1) * 2^M + mask
  u <- unique(key)
  off <- matrix(0, length(u), N_PROD)
  for (i in seq_along(u)) {
    b <- u[i] %/% 2^M + 1; m <- u[i] %% 2^M
    for (j in which(pb == b & (m %/% 2^bit) %% 2 == 1)) {
      p <- today_promos$off[j, ] > 0
      off[i, p] <- today_promos$off[j, p]
    }
  }
  list(row = match(key, u), off = off)
}

# ---- Markdowns ----------------------------------------------------------------------------

# The calendar's markdowns today (its entries acting today), each on the
# products its entry covers, in this order:
#   a product not yet in the stores is left alone
#   one marked down in the last `rest_days` days rests (0: none rest)
#   behind plan: one in the stores fewer than `min_days` days is too new to
#     judge, and one that has sold through at least its plan by last night,
#     less `by` points, is on plan (its plan: the brand's sell-through
#     target, times the share of the product's planned sales due by then)
#   the rest go `to` a depth off full price, or `deeper` by a step, to at
#     most `max`; one already that deep or deeper keeps its price (the
#     deeper markdown always wins: a markdown never raises a price)
# Each entry's day is recorded, with how many products it took and why it
# left the others.
markdowns_today <- function() {
  on <- acting_today(CAL_PLAN$markdowns)
  if (!length(on)) return(invisible())
  judged <- NULL
  for (k in on) {
    x <- CAL_PLAN$markdowns[[k]]; b <- x$brand
    live <- x$cover & launched[b, ]
    rested <- live & day - marked_on[b, ] < x$rest_days
    left <- live & !rested
    too_new <- on_plan <- logical(N_PROD)
    if (x$which == "behind") {
      if (is.null(judged)) judged <- sell_through_now()
      too_new <- left & day - PROD_DAY[b, ] < x$min_days
      on_plan <- left & !too_new & !(judged$st[b, ] < P_PRICE$md_target[b] * judged$plan[b, ] - x$by)
      left <- left & !too_new & !on_plan
    }
    now <- markdown[b, ]
    to <- if (x$mode == "to") pmax(now, x$depth) else pmax(now, pmin(x$max, now + x$depth))
    take <- left & to > now
    markdown[b, take] <<- to[take]
    marked_on[b, take] <<- day
    r <- cal$taken
    cal$taken <<- list(entry = c(r$entry, k), day = c(r$day, day), took = c(r$took, sum(take)), deeper = c(r$deeper, sum(left & !take)),
                       on_plan = c(r$on_plan, sum(on_plan)), too_new = c(r$too_new, sum(too_new)), rested = c(r$rested, sum(rested)),
                       not_in = c(r$not_in, sum(x$cover & !launched[b, ])))
  }
}

# Brand x product: each product's sell-through (sold, net of returns, of
# what was bought) and its planned sell-through, by last night.
sell_through_now <- function() {
  bought <- prod_totals(stock$bought, by_brand = TRUE)
  list(st = net_sold() / pmax(bought, 1), plan = planned_by(day - 1L))
}

