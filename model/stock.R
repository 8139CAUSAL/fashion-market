# Products and stock: each brand's range, the season's buy at a distribution
# centre (DC), what each store holds on the floor and in its stockroom, and
# the replenishment its calendar orders, arriving after a lead time.
#
# A brand's range is its own (world.R installs it): products in the world's
# categories, each landing in the stores on its own day, each in 5 sizes. A
# store's stock is a row of SKUs, product by size (SKU (p - 1) * N_SIZES +
# size, p the product's number in its brand's range). How well a product
# will sell is a hidden popularity the plan doesn't know, so some sell out
# early and others need marking down: the classic fashion problem. Sizes
# matter because shoppers only take their own size, and each area's
# households run to different sizes.
#
# A brand plans its sales by category (units a standard store sells a
# week), shared among the category's products in the stores that week. A
# store's planned sales of a category, and how deep its racks of it are,
# scale with the category's rack faces in its layout (against a standard
# store's: STORE_SPACE, world.R).

sku_prod <- function() rep(seq_len(N_PROD), each = N_SIZES)
product_of <- function(sku) (sku - 1L) %/% N_SIZES + 1L
size_of <- function(sku) (sku - 1L) %% N_SIZES + 1L
# The category of each SKU of a brand's (brand and sku alike long).
sku_category <- function(sku, brand) PROD_CAT[cbind(brand, product_of(as.vector(sku)))]

# Brand x product: each product's planned share of its category's sales in
# week w (0 before it lands). The products of a category in the stores that
# week share it equally.
week_share <- function(w) {
  live <- PROD_OK & PROD_WEEK <= w
  key <- (PROD_CAT - 1L) * N_BRANDS + row(PROD_CAT)
  n <- tabulate(key[live], N_BRANDS * N_CATS)
  share <- matrix(0, N_BRANDS, N_PROD)
  share[live] <- 1 / n[key[live]]
  share
}

# The share of week w that's in the season (the last week may be short).
week_weight <- function(w) min(7, SEASON_DAYS - 7 * (w - 1)) / 7

# Each brand's size curve: the market's size mix, which is what a flat
# allocation sends every store.
market_size_curve <- function() tabulate(mk$hh$size, N_SIZES) / mk$hh$n

init_catalogue <- function() {
  cat_price <<- LEVERS$price$value * LIST_PRICE          # brand x product, full price today
  markdown <<- matrix(0, N_BRANDS, N_PROD)               # the markdown in force on each product (calendar.R)
  marked_on <<- matrix(-Inf, N_BRANDS, N_PROD)           # ... and the day it was last marked down
  pop <<- with_seed(P$seed * 101 + 7, matrix(rnorm(N_BRANDS * N_PROD, 0, 0.55), N_BRANDS))
  launched <<- matrix(FALSE, N_BRANDS, N_PROD)           # in the stores: each lands on the morning of its day (morning())
}

# The season's buy, per brand and SKU: planned weekly sales across the
# brand's stores, for the weeks each product is in the stores, split by the
# market's size curve.
season_plan <- function() {
  vol <- matrix(0, N_BRANDS, N_PROD)                                         # brand x product: its stores' space for it
  by_brand <- rowsum(SPACE_SP, STORES$brand)
  vol[as.integer(rownames(by_brand)), ] <- by_brand
  share <- Reduce(`+`, lapply(seq_len(SEASON_WEEKS), function(w) week_share(w) * week_weight(w)))   # weeks of a category's sales, per product
  curve <- market_size_curve()
  per_prod <- (vol * P_STOCK$season_buy) * PLAN_CAT * share                     # brand x product
  plan <- per_prod[, sku_prod(), drop = FALSE] * matrix(rep(curve, N_PROD), N_BRANDS, N_SKU, byrow = TRUE)
  round(plan)
}

# A store's demand for a SKU is what it sold, plus what shoppers asked for
# in a size that wasn't there. Each morning the day before is counted in,
# and an order sees the demand up to last night: its estimate is the last
# seven days, blended half and half with the estimate made on the same
# weekday a week before (count_demand).
init_stock <- function() {
  zero <- matrix(0, N_STORES, N_SKU)
  stock <<- list(rack = zero, room = zero, go_back = zero, sold = zero, missed = zero,
                 dc = season_plan(), transit = list(day = numeric(), store = integer(), sku = integer(), n = numeric()),
                 day_demand = rep(list(zero), 7L),        # each of the last seven days' demand, in its weekday's place
                 estimate = rep(list(zero), 7L),          # each weekday's estimate of a week's demand
                 estimated = logical(7L),                 # ... once it has one
                 demand = zero,                           # the latest estimate
                 days_counted = 0L, counted = zero,       # days of demand counted, and sold + missed by then
                 at_order = zero,                         # sold by each product's last order (replace what sold)
                 booked = matrix(FALSE, SEASON_DAYS + MAX_LEAD_DAYS + 1L, N_STORES))   # a delivery to the store that day
  stock$bought <<- stock$dc
}

# Rack space for each SKU in each store: a few of each size, more for the
# common sizes and for categories with more rack faces.
rack_capacity <- function() {
  curve <- market_size_curve()
  per <- pmax(1, round(RACK_UNITS * N_SIZES * curve))
  SPACE_SP[, sku_prod(), drop = FALSE] * matrix(rep(per, N_PROD), N_STORES, N_SKU, byrow = TRUE)
}

# Products landing (brand x product, TRUE for each): each store gets its
# opening allocation, the brand's weeks of planned sales, split by its
# allocation rule.
allocate_launch <- function(new) {
  if (!any(new)) return(invisible())
  f <- weekly_forecast()
  for (b in which(.rowSums(new, N_BRANDS, N_PROD) > 0)) {
    cols <- which(new[b, sku_prod()])
    ship_from_dc(b, cols, ceiling(P_STOCK$opening_weeks[b] * f[STORES$brand == b, cols, drop = FALSE]), direct = TRUE)
  }
}

# Expected weekly demand per store and SKU. A product's rate comes from its
# `demand` estimate (what the store has sold, and failed to sell for want
# of a size, lately), blended with the plan; with no estimate, the plan.
# It's split into sizes by the market's size curve (flat allocation) or by
# the store's own demand by size so far (learned).
weekly_forecast <- function(demand = NULL) {
  wk <- max(1L, week_of(max(day, 1L)))
  rate <- PLAN_CAT[STORES$brand, , drop = FALSE] * SPACE_SP *
    week_share(wk)[STORES$brand, , drop = FALSE]                               # store x product, the plan
  if (!is.null(demand)) {
    by_prod <- t(rowsum(t(demand), sku_prod()))
    seen <- by_prod > 0
    rate[seen] <- 0.5 * rate[seen] + 0.5 * by_prod[seen]
  }
  curve <- matrix(rep(market_size_curve(), N_PROD), N_STORES, N_SKU, byrow = TRUE)
  learned <- P_STOCK$allocation[STORES$brand] == "learned"
  if (any(learned)) {
    sz <- size_of(seq_len(N_SKU))
    total <- stock$sold + stock$missed
    for (s in which(learned)) {
      by_size <- tapply(total[s, ], sz, sum)
      if (sum(by_size) >= 30) {
        mix <- (by_size + 5 * market_size_curve()) / (sum(by_size) + 5)
        curve[s, ] <- mix[sz]
      }
    }
  }
  rate[, sku_prod()] * curve
}

# Sends stock of brand b from its DC to its stores: `w` units per store
# (rows: the brand's stores) of SKUs `cols`, limited by what the DC has
# (shared out in proportion when it's short). Direct shipments land today;
# others after the lead time. Returns what was sent.
#
# Logistics are charged as stock leaves the DC, at the brand's fees then: a
# fee for each unit, and a fee for each store delivery. A store receives a
# delivery on each day an order of at least a unit arrives for it, so
# stock bound for one store on one day shares a delivery.
ship_from_dc <- function(b, cols, w, direct = FALSE) {
  rows <- which(STORES$brand == b)
  need <- colSums(w)
  have <- stock$dc[b, cols]
  short <- need > have
  if (any(short)) w[, short] <- floor(w[, short, drop = FALSE] * rep(have[short] / need[short], each = length(rows)))
  stock$dc[b, cols] <<- stock$dc[b, cols] - colSums(w)
  charge_logistics(b, rows, .rowSums(w, length(rows), length(cols)), if (direct) day else day + P_STOCK$lead_days[b])
  if (direct) {
    stock$room[rows, cols] <<- stock$room[rows, cols] + w
  } else {
    nz <- which(w > 0, arr.ind = TRUE)
    if (nrow(nz)) {
      stock$transit$day <<- c(stock$transit$day, rep(day + P_STOCK$lead_days[b], nrow(nz)))
      stock$transit$store <<- c(stock$transit$store, rows[nz[, 1]])
      stock$transit$sku <<- c(stock$transit$sku, cols[nz[, 2]])
      stock$transit$n <<- c(stock$transit$n, w[nz])
    }
  }
  w
}

# Units `n` sent to stores `rows` of brand b, arriving on day `arrive`.
charge_logistics <- function(b, rows, n, arrive) {
  s <- rows[n > 0]; n <- n[n > 0]
  if (!length(s)) return(invisible())
  new_stop <- !stock$booked[cbind(arrive, s)]
  stock$booked[cbind(arrive, s)] <<- TRUE
  today$deliveries[s] <<- today$deliveries[s] + new_stop
  today$shipped[s] <<- today$shipped[s] + n
  today$logistics[s] <<- today$logistics[s] + new_stop * P_STOCK$delivery_fee[b] + n * P_STOCK$unit_fee[b]
}

# Before opening, in the order a store's morning runs: products landing
# today go out to the stores (their opening allocation), deliveries due
# today arrive, yesterday's demand is counted in, the calendar's
# replenishment orders go out and its markdowns are taken (calendar.R),
# and the floor is filled from the stockroom. The day's prices are set
# after (prices_today).
# (An order counts the stock on its way as well as in the store, so it
# would order the same before the day's deliveries as after.)
morning <- function() {
  new <- !launched & PROD_DAY <= day
  if (any(new)) {
    launched[new] <<- TRUE
    allocate_launch(new)
  }
  arrivals()
  count_demand()
  replenish_today()
  markdowns_today()
  reshelve()
  refill_floor()
}

# Deliveries due today go into the stockrooms.
arrivals <- function() {
  due <- stock$transit$day <= day
  if (!any(due)) return(invisible())
  idx <- cbind(stock$transit$store[due], stock$transit$sku[due])
  add <- tapply(stock$transit$n[due], (idx[, 1] - 1L) * N_SKU + idx[, 2], sum)
  k <- as.integer(names(add))
  at <- cbind((k - 1L) %/% N_SKU + 1L, (k - 1L) %% N_SKU + 1L)
  stock$room[at] <<- stock$room[at] + as.vector(add)
  for (f in c("day", "store", "sku", "n")) stock$transit[[f]] <<- stock$transit[[f]][!due]
}

# Yesterday's demand at every store goes into its weekday's place among the
# last seven days. Once seven days are counted, today's weekday gets its
# estimate: the last seven days, blended half and half with the estimate
# made on this weekday a week ago (the first time, the seven days alone).
# Until then an order goes by the plan.
count_demand <- function() {
  if (day <= 1L) return(invisible())
  total <- stock$sold + stock$missed
  stock$day_demand[[dow_of(day - 1L)]] <<- total - stock$counted
  stock$counted <<- total
  stock$days_counted <<- stock$days_counted + 1L
  if (stock$days_counted < 7L) return(invisible())
  week <- Reduce(`+`, stock$day_demand)
  k <- dow_of(day)
  stock$estimate[[k]] <<- if (stock$estimated[k]) 0.5 * stock$estimate[[k]] + 0.5 * week else week
  stock$estimated[k] <<- TRUE
  stock$demand <<- stock$estimate[[k]]
}

# Today's demand estimate, for an order (NULL before there is one).
demand_today <- function() {
  k <- dow_of(day)
  if (stock$estimated[k]) stock$estimate[[k]] else NULL
}

# The calendar's replenishment orders today (calendar.R: its entries acting
# today), each for the products its entry covers that are in the stores.
#   top up to cover  orders each store up to `cover` weeks of expected
#                    demand beyond the brand's lead time, for each size
#                    whose stock (rack, stockroom and on the way) is under
#                    `reorder` weeks beyond it (reorder = cover: always)
#   replace what sold  ships each store what it sold of each size since the
#                    product's last order
# What's ordered leaves the DC today and arrives after the lead time.
replenish_today <- function() {
  on <- acting_today(CAL_PLAN$replenishment)
  if (!length(on)) return(invisible())
  f <- weekly_forecast(demand_today())
  lead <- P_STOCK$lead_days[STORES$brand] / 7
  pos <- stock$rack + stock$room + in_transit()
  for (k in on) {
    x <- CAL_PLAN$replenishment[[k]]; b <- x$brand
    rows <- STORES$brand == b
    cols <- which((launched[b, ] & x$cover)[sku_prod()])
    if (!length(cols) || !any(rows)) next
    if (x$rule == "replace") {
      w <- stock$sold[rows, cols, drop = FALSE] - stock$at_order[rows, cols, drop = FALSE]
    } else {
      p <- pos[rows, cols, drop = FALSE]
      fc <- f[rows, cols, drop = FALSE]
      w <- pmax(ceiling(fc * (lead[rows] + x$cover_weeks) - p), 0)
      w[!(p < fc * (lead[rows] + x$reorder_weeks))] <- 0
    }
    stock$at_order[rows, cols] <<- stock$sold[rows, cols, drop = FALSE]
    sent <- ship_from_dc(b, cols, w)
    o <- cal$orders
    cal$orders <<- list(entry = c(o$entry, k), day = c(o$day, day), units = c(o$units, sum(sent)),
                        arrive = c(o$arrive, day + as.integer(P_STOCK$lead_days[b])))
  }
}

in_transit <- function() {
  out <- matrix(0, N_STORES, N_SKU)
  if (length(stock$transit$n)) {
    add <- tapply(stock$transit$n, (stock$transit$store - 1L) * N_SKU + stock$transit$sku, sum)
    k <- as.integer(names(add))
    out[cbind((k - 1L) %/% N_SKU + 1L, (k - 1L) %% N_SKU + 1L)] <- as.vector(add)
  }
  out
}

refill_floor <- function() {
  cap <- rack_capacity()
  cap[!launched[STORES$brand, sku_prod(), drop = FALSE]] <- 0
  move <- pmin(stock$room, pmax(cap - stock$rack, 0))
  stock$rack <<- stock$rack + move
  stock$room <<- stock$room - move
}

# Brand x product: the share of each product's planned sales for the
# season due by the end of day t.
planned_by <- function(t) {
  w <- seq_len(SEASON_WEEKS)
  weekly <- vapply(w, function(k) as.vector(week_share(k) * week_weight(k)), numeric(N_BRANDS * N_PROD))
  in_week <- pmin(7, SEASON_DAYS - 7 * (w - 1))                 # the season's days in each week
  done <- pmin(pmax(t - 7 * (w - 1), 0), in_week) / in_week      # ... and the share of them done by day t
  matrix(rowSums(weekly * rep(done, each = N_BRANDS * N_PROD)) / rowSums(weekly), N_BRANDS)
}

# Brand x product: units of each product left, in the stores (with what's
# on its way to them) and at the DC.
product_left <- function() {
  list(stores = prod_totals(stock$rack + stock$room + stock$go_back + in_transit()),
       dc = prod_totals(stock$dc, by_brand = TRUE))
}

# Brand x product: each product's state in its season (its number in
# PRODUCT_STATES): on order until it lands; sold through once 5% or less of
# its buy is left; clearance at half price or less; marked down; or at full
# price.
PRODUCT_STATES <- c("On order", "Full price", "Markdown", "Clearance", "Sold through")
product_states <- function(left = product_left()) {
  bought <- prod_totals(stock$bought, by_brand = TRUE)
  s <- ifelse(markdown >= 0.5, 4L, ifelse(markdown > 0, 3L, 2L))
  s[left$stores + left$dc <= 0.05 * bought] <- 5L
  s[!launched] <- 1L
  s
}

# The share of the brands' products in the stores (landed, not sold
# through) at half price or less, brand by brand, on average.
clearance_share <- function() {
  s <- product_states()
  shelf <- .rowSums(PROD_OK & s >= 2L & s <= 4L, N_BRANDS, N_PROD)
  mean(ifelse(shelf > 0, .rowSums(PROD_OK & s == 4L, N_BRANDS, N_PROD) / pmax(shelf, 1), 0))
}

# Each brand's stock left (in the stores, on the way and at the DC), at cost.
stock_left_cost <- function(left = product_left()) .rowSums((left$stores + left$dc) * PROD_COST, N_BRANDS, N_PROD)

# Units by brand and product: from a store x SKU table (summed over each
# brand's stores), or from a brand x SKU one.
prod_totals <- function(m, by_brand = FALSE) {
  if (!by_brand) m <- rowsum(m, STORES$brand, reorder = TRUE)
  t(rowsum(t(m), sku_prod(), reorder = TRUE))
}

# A store x SKU table summed by category: store x category.
by_category <- function(m) {
  out <- matrix(0, N_STORES, N_CATS)
  for (b in seq_len(N_BRANDS)) {
    rows <- STORES$brand == b
    if (any(rows)) out[rows, ] <- m[rows, , drop = FALSE] %*% SKU_CAT[[b]]
  }
  out
}

# Everything a brand bought is sold, on a rack, in a stockroom, waiting to
# be reshelved, on its way or still at the DC (checked at the end of each
# day).
stock_balance <- function() {
  held <- rowsum(stock$rack + stock$room + stock$go_back + stock$sold + in_transit(), STORES$brand, reorder = TRUE)
  rowSums(stock$bought) - rowSums(held) - rowSums(stock$dc)
}
