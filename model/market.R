# The market: each day, which households go clothes shopping and where.
#
# A household is in the market today with a chance that depends on its
# segment, the day of the week, the point in the season, the season's
# demand events (world.R, demand_multipliers), how much of its season
# budget is left, promotions and marketing it has heard of, and
# any offers it holds, as long as some store is within its reach, or some
# brand has an online store. In the market, it weighs every store within its
# radius, and every online store, against staying home (a multinomial
# logit). The radius is its segment's, stretched brand by brand by its
# loyalty tier with the brand (a loyal shopper goes further). A store's
# appeal adds up:
#
#   the household's own taste for the brand (drawn once, kept all season)
#   what the brand sells: the racks it has for the categories the
#     household's segment likes (range_value)
#   the pull of its loyalty tier with the brand
#   price position times the household's price sensitivity (less, the more loyal),
#     less what the promotions reaching it take off, and its coupon
#   promotions it has heard of (calendar.R), and the brand's marketing
#   the trip there, along the fastest route
#   memory of bad visits to the brand (not in my size, a queue walked out of)
#   word of mouth: the buzz about the brand on the patch it lives on, which
#     follows its neighbours' shopping and spreads from patch to patch
#   the store's layout (a flagship draws more than a small shop)
#   offers it holds that are good at the brand
#   the brand's return window (the share of the returns it might want that
#     the window covers, returns.R)
#
# It then drives there along the fastest route, and back. An online store
# has no trip and no layout: in their place, the segment's taste for
# shopping online, the wait for delivery, and any delivery charge (weighed
# with the prices, as a share of a typical order). Its return window pulls
# harder, since the shopper can't try anything on (online.R).
#
# A household with returns due today makes a trip of its own to return
# them (returns.R), beside any shopping it does.

dow_of <- function(day) (day - 1L) %% 7L + 1L
week_of <- function(day) (day - 1L) %/% 7L + 1L

# Demand over the season: the launch fortnight is busy, a week with new
# products landing gives a lift (as much as the share of brands they land
# at), and clearance draws bargain hunters: as many as the share of the
# brands' products in the stores that are at half price or less, on the
# racks today (the Assortment's "Clearance").
season_curve <- function(day) {
  w <- week_of(day)
  drops <- mean(.rowSums(PROD_OK & PROD_WEEK == w, N_BRANDS, N_PROD) > 0)
  1 + 0.18 * (w <= 2) + 0.1 * drops + 0.12 * clearance_share()
}

# Each brand's price position today: its list prices' against the market,
# times its price change.
price_position <- function() LEVERS$price$value * PRICE_POS

# What brand b's range is worth to a shopper of segment `seg` choosing a
# store (seg and b alike long): the weight of the range times the log of
# the share of the segment's taste for categories that the brand sells. In
# the store, the shopper picks racks by that taste among the categories
# the brand sells (new_visits), and the log of the summed tastes is the
# value of that choice (a nested logit's inclusive value); this is it
# against a brand selling every category. So a brand selling every
# category the segment likes adds 0, and one selling none of them adds
# -Inf: the segment never goes there. At weight 0 the range is ignored.
range_value <- function(seg, b) {
  if (P$range_w == 0) return(0)
  P$range_w * log(RANGE_SHARE[cbind(seg, b)])
}

# Households h x brands: the buzz about each brand on the word-of-mouth
# patch each household lives on, read from that world with of() (city.R).
buzz_of <- function(h) matrix(of(world = mk$wom, agents = mk$wom_at[h, , drop = FALSE], var = BRANDS$id), length(h))

# Households x brands: each household's radius for each brand's stores, km.
radius_km <- function(h) {
  SEGMENTS$radius_km[mk$hh$segment[h]] * matrix(TIER_RADIUS[cbind(rep(seq_len(N_BRANDS), each = length(h)), as.vector(mk$tier[h, , drop = FALSE]))], length(h))
}

start_day <- function() {
  day <<- day + 1L
  new_today()
  dow <- dow_of(day)
  morning()                              # stock lands and arrives, the calendar orders and marks down (stock.R)
  prices_today()                         # the promotions running today (calendar.R)
  offers_morning()                       # today's offers go out (offers.R)
  back <- returns_morning()              # returns due today: posted now, or a trip to a store (returns.R)
  mk$park_fail <<- mk$park_fail * P$memory   # a facility found full is remembered, and fades as a bad visit does
  hh <- mk$hh
  n <- hh$n
  seg <- hh$segment
  all_h <- seq_len(n)
  reach <- promo_reach(all_h)
  pr <- promo_heard(reach)
  heard <- .rowSums(pr$heard, n, N_BRANDS) / N_BRANDS   # share of brands with a promotion reaching the household
  # Some store within reach (of each brand, the nearest against the
  # radius, by the household's way there), or any online store.
  reach_any <- .rowSums(mk$near_km <= radius_km(all_h), n, N_BRANDS) > 0 | any(ONLINE$on)
  ad <- LEVERS$ad$value
  shop <- SEGMENTS$shop[seg] * DOW_TRAFFIC[dow] * season_curve(day) * DEMAND_EVENT[day] *
    sqrt(pmax(0, mk$budget_left / hh$budget)) *
    (1 + AD_SHOP * mean(ad) + PROMO_SHOP * SEGMENTS$promo[seg] * heard) * mk$at$shop * reach_any
  i <- which(runif(n) < shop)
  m <- length(i)
  buzz <- buzz_of(i)                     # word of mouth on the patch each of them lives on, by brand

  # Every store in reach against staying home: its appeal (outings.R,
  # store_appeal), less the generalized cost of the trip there by the
  # household's cheapest way (transport.R, travel_costs), plus the pull of
  # the other stores it could walk on to from there.
  tc <- travel_costs(hh$tile[i], seg[i], hh$car[i], city, mk$park_fail[i, , drop = FALSE])
  s <- rep(seq_len(N_STORES), each = m)
  b <- STORES$brand[s]
  hi <- rep(i, times = N_STORES)
  row <- rep.int(seq_len(m), N_STORES)
  sg <- seg[hi]
  pri <- list(heard = pr$heard[i, , drop = FALSE], off = pr$off[i, , drop = FALSE])
  W <- store_appeal(hi, b, s, row, pri, buzz, range_value(sg, b))
  inr <- tc$km <= SEGMENTS$radius_km[sg] * TIER_RADIUS[cbind(b, mk$tier[cbind(hi, b)])]
  W[!inr] <- -Inf
  dim(W) <- c(m, N_STORES)
  V <- W - tc$cost + cluster_pull(W, seg[i]) + matrix(gumbel(m * N_STORES), m)
  V[!inr] <- -Inf
  home <- P$outside + gumbel(m)
  # Every online store, in reach of everyone.
  bo <- which(ONLINE$on)
  Vo <- NULL
  if (length(bo)) {
    k <- length(bo)
    b <- rep(bo, each = m)
    hi <- rep(i, times = k)
    hb <- cbind(hi, b)
    bt <- cbind(b, mk$tier[hb])
    sg <- seg[hi]
    price <- price_position()[b] * (1 - pr$off[hb]) * (1 - mk$at$coupon[hb]) * (1 + delivery_share()[b])
    Vo <- P$taste_w * hh$taste[hb] + range_value(sg, b) + TIER_PULL[bt] - P$price_w * SEGMENTS$price[sg] * TIER_PRICE[bt] * log(price) +
      PROMO_W * SEGMENTS$promo[sg] * pr$heard[hb] + AD_W * ad[b] -
      P$grudge_w * TIER_MEMORY[bt] * mk$grudge[hb] + P$wom * buzz[cbind(rep.int(seq_len(m), k), b)] + mk$at$util[hb] +
      SEGMENTS$online[sg] - DELIVERY_W * ONLINE$delivery_days[b] + RETURN_PULL[["online"]] * cover_now()[b] + gumbel(m * k)
    dim(Vo) <- c(m, k)
  }
  all_v <- cbind(home, V, Vo)
  best <- row_max(all_v)
  pick <- best$k - 1L
  went <- pick > 0
  store <- went & pick <= N_STORES
  online <- pick > N_STORES
  today$in_market <<- tabulate(hh$bin[i], AREA_BINS)
  today$stayed_home <<- tabulate(hh$bin[i[!went]], AREA_BINS)
  today$in_market_hh <<- i
  today$dest <<- tabulate(pick[store], N_STORES)            # outings each store drew
  js <- which(store)
  sub <- function(x) list(cost = x$cost[js, , drop = FALSE], mode = x$mode[js, , drop = FALSE], fac = x$fac[js, , drop = FALSE], km = x$km[js, , drop = FALSE])
  new_day(i[js], pick[js], best$max[js] - home[js], sub(tc),
          i[online], bo[pick[online] - N_STORES], reach[i[online], , drop = FALSE], back)
}

cover_now <- function() window_cover()

# The pull of the stores a shopper could walk on to from each store
# (households x stores, from W, the appeal of every store without the
# trip): cluster_w times the log of one plus the sum of their exp(appeal
# less the walk from this store's door), over stores within the longest
# walk. 0 where there are none.
cluster_pull <- function(W, seg) {
  if (P$cluster_w == 0 || N_STORES < 2L) return(0)
  sw <- store_walks(); walk <- sw$t; near <- sw$near                  # from s (row) to s2 (col)
  out <- matrix(0, dim(W)[1L], N_STORES)
  kap <- SEGMENTS$km[seg]
  for (s in which(.rowSums(near, N_STORES, N_STORES) > 0)) {
    s2 <- which(near[s, ])
    E <- exp(W[, s2, drop = FALSE] - outer(kap * P$walk_w, walk[s, s2] / 60))
    out[, s] <- log1p(.rowSums(E, dim(W)[1L], length(s2)))
  }
  P$cluster_w * out
}

# The day's visit table (d) and outings (outings.R). Online visits are
# made here, with their racks drawn as a store visit's always were; a
# store visit is made when its shopper reaches the store's door
# (add_store_visits). Shopping outings (households h to stores `store`,
# their margin over staying home, and travel costs tc rows for them) get
# their door times and the categories they're after (draws: an hour then a
# moment in it, the day's taste for each category, then how many); return
# trips (`back`) get their door times (an hour then a moment).
new_day <- function(h, store, margin, tc, h_on = integer(), b_on = integer(), reach_on = NULL, back = NULL) {
  G <- outing_plan(h)
  O <- browse_plan(h_on, b_on)
  r <- back$hh %||% integer(); rs <- back$store %||% integer(); nr <- length(r)
  r_door <- numeric()
  if (nr) {
    hour <- sample.int(length(HOURLY), nr, replace = TRUE, prob = HOURLY)
    r_door <- pmin(LAST_ENTRY_S, (hour - 1) * 3600 + runif(nr, 0, 3600))
  }
  r_tc <- if (nr) travel_costs(mk$hh$tile[r], mk$hh$segment[r], mk$hh$car[r], city, mk$park_fail[r, , drop = FALSE]) else NULL
  if (nr) {
    # A return trip goes only where the household can get to.
    ok <- r_tc$mode[cbind(seq_len(nr), rs)] > 0L
    if (any(!ok)) { for (j in which(!ok)) post_returns_lines(back$lines[[j]]) }
    keep <- which(ok)
    r <- r[keep]; rs <- rs[keep]; r_door <- r_door[keep]; back$lines <- back$lines[keep]
    r_tc <- lapply(r_tc, function(x) x[keep, , drop = FALSE])
  }
  d <<- visit_table()
  if (length(h_on)) {
    v <- d_append(list(hh = h_on, store = integer(length(h_on)), brand = b_on, online = rep(TRUE, length(h_on)), ret = logical(length(h_on)),
                       arrive = O$arrive, zone = O$zone, n_zones = O$n_zones, coupon = mk$at$coupon[cbind(h_on, b_on)],
                       coupon_from = mk$at$coupon_from[cbind(h_on, b_on)], budget = mk$budget_left[h_on], reached = reach_on))
    d$on_order <<- v[order(d$arrive[v])]
  }
  new_outings(h, store, G$arrive, G$ct, G$n_want, margin, tc, r, rs, r_door, back$lines %||% list(), r_tc)
  legs <<- new_legs(64L + 12L * (length(h) + length(h_on) + nr))
  staff <<- new_staff_log()
  vlog <<- list(n = 0L, m = matrix(0, 64L + 12L * (length(h) + length(h_on) + nr), VLOG_COLS))
  queues <<- new_queues()
  exits <<- list(v = integer(), t0 = numeric(), outcome = integer())
  next_step <<- 0; clock <<- 0
}

post_returns_lines <- function(lines) {
  if (!length(lines)) return(invisible())
  b <- ledger$i[lines[1], "brand"]
  book_returns(lines, 0L)
  today$post_parcels[b] <<- today$post_parcels[b] + 1
  today$post_cost[b] <<- today$post_cost[b] + RETURNS$post_cost[b]
}

# Shopping outings for households h: when they mean to reach their first
# store's door (an hour, then a moment in it), the day's taste for every
# category, and how many categories they're after (draws, in that order).
outing_plan <- function(h) {
  v <- length(h)
  if (!v) return(list(arrive = numeric(), ct = matrix(0, 0, N_CATS), n_want = integer()))
  seg <- mk$hh$segment[h]
  hour <- sample.int(length(HOURLY), v, replace = TRUE, prob = HOURLY)
  CT <- log(CATEGORY_TASTE[seg, , drop = FALSE]) + matrix(gumbel(v * N_CATS), v)
  arrive <- pmin(LAST_ENTRY_S, (hour - 1) * 3600 + runif(v, 0, 3600))
  n_want <- pmin(MAX_ITEMS + 1L, 1L + rpois(v, SEGMENTS$zones[seg] - 1), .rowSums(CATEGORY_TASTE[seg, , drop = FALSE] > 0, v, N_CATS))
  list(arrive = arrive, ct = CT, n_want = as.integer(n_want))
}

# ---- The visit table --------------------------------------------------------------------

# One row per visit, in every field below; d_append() adds rows, as the
# day goes on. Fields not given take their defaults.
VISIT_VEC <- c("hh", "seg", "size", "area", "bin", "store", "outlet", "brand", "format", "tier", "online", "ret", "arrive", "speed",
               "n_zones", "zi", "at", "ev_at", "ev_kind", "items", "n_try", "promo_row", "coupon", "coupon_from", "coupon_saved",
               "budget", "spent", "advised", "tried", "missed_size", "too_dear", "wait", "outcome", "outcome_at", "gone",
               "sales", "full_value", "units", "cogs", "delivery", "outing", "stop")
VISIT_MAT <- c(zone = MAX_ITEMS + 1L, basket = MAX_ITEMS, paid_for = MAX_ITEMS, full_for = MAX_ITEMS, md_for = MAX_ITEMS, off_for = MAX_ITEMS)

visit_table <- function() {
  out <- list(v = 0L)
  int <- c("hh", "seg", "size", "area", "bin", "store", "outlet", "brand", "format", "tier", "n_zones", "zi", "at", "ev_kind", "items",
           "n_try", "promo_row", "coupon_from", "outcome", "units", "outing", "stop")
  lgl <- c("online", "ret", "tried", "missed_size", "too_dear")
  for (f in VISIT_VEC) out[[f]] <- if (f %in% int) integer() else if (f %in% lgl) logical() else numeric()
  for (f in names(VISIT_MAT)) out[[f]] <- if (f %in% c("zone", "basket")) matrix(0L, 0, VISIT_MAT[[f]]) else matrix(0, 0, VISIT_MAT[[f]])
  out$reached <- matrix(FALSE, 0, length(today_promos$k))
  out$ret_lines <- list()
  c(out, list(promos = today_promos$k, promo_off = matrix(0, 0, N_PROD), n_promo = 0L, events = 0L, late = 0L,
              by_arrival = integer(), next_in = 1L, active = integer(), on_order = integer(), on_next = 1L))
}

d_append <- function(x) {
  k <- length(x$hh)
  if (!k) return(integer())
  hh <- mk$hh; v0 <- d$v
  rows <- v0 + seq_len(k)
  b <- x$brand; st <- x$store
  online <- x$online; ret <- x$ret
  fmt <- ifelse_int(online, 0L, STORES$format[pmax(st, 1L)])
  arrive <- x$arrive
  promos <- promo_rows(b, x$reached)
  get <- function(f, default) if (is.null(x[[f]])) rep_len(default, k) else x[[f]]
  new <- list(hh = x$hh, seg = hh$segment[x$hh], size = hh$size[x$hh], area = hh$area[x$hh], bin = hh$bin[x$hh],
              store = st, outlet = ifelse_int(online, N_STORES + b, st), brand = b, format = fmt, tier = mk$tier[cbind(x$hh, b)],
              online = online, ret = ret, arrive = arrive, speed = get("speed", 0), n_zones = get("n_zones", 0L), zi = integer(k),
              at = get("at", 0L), ev_at = arrive, ev_kind = rep(EV_MOVE, k), items = get("items", 0L), n_try = integer(k),
              promo_row = promos$row + d$n_promo, coupon = x$coupon, coupon_from = as.integer(x$coupon_from), coupon_saved = numeric(k),
              budget = x$budget, spent = numeric(k), advised = numeric(k), tried = logical(k), missed_size = logical(k), too_dear = logical(k),
              wait = numeric(k), outcome = integer(k), outcome_at = rep(NA_real_, k), gone = rep(Inf, k),
              sales = numeric(k), full_value = numeric(k), units = integer(k), cogs = numeric(k), delivery = numeric(k),
              outing = get("outing", 0L), stop = get("stop", 0L))
  for (f in VISIT_VEC) d[[f]][rows] <<- new[[f]]          # grown in place (R over-allocates a vector assigned past its end)
  # Matrices keep room to spare: rows past d$v are unused.
  cap <- dim(d$zone)[1L]
  if (v0 + k > cap) {
    more <- max(k, cap, 64L)
    for (f in names(VISIT_MAT)) d[[f]] <<- rbind(d[[f]], matrix(if (f %in% c("zone", "basket")) 0L else 0, more, VISIT_MAT[[f]]))
    d$reached <<- rbind(d$reached, matrix(FALSE, more, dim(d$reached)[2L]))
  }
  if (!is.null(x$zone)) d$zone[rows, ] <<- x$zone
  if (length(x$reached)) d$reached[rows, ] <<- x$reached
  np <- d$n_promo; pc <- dim(d$promo_off)[1L]; kp <- dim(promos$off)[1L]
  if (np + kp > pc) d$promo_off <<- rbind(d$promo_off, matrix(0, max(kp, pc, 16L), N_PROD))
  d$promo_off[np + seq_len(kp), ] <<- promos$off
  d$n_promo <<- np + kp
  d$ret_lines[rows] <<- if (is.null(x$ret_lines)) vector("list", k) else x$ret_lines
  d$v <<- v0 + k
  rows
}

# Shoppers h at brands `brand`: when they come (draws: an hour, then a
# moment in it), and the racks they'll browse (draws: the day's taste for
# each category, then how many).
browse_plan <- function(h, brand) {
  v <- length(h)
  if (!v) return(list(arrive = numeric(), zone = matrix(0L, 0, MAX_ITEMS + 1L), n_zones = integer()))
  seg <- mk$hh$segment[h]
  hour <- sample.int(length(HOURLY), v, replace = TRUE, prob = HOURLY)
  CT <- log(CATEGORY_TASTE[seg, , drop = FALSE]) + matrix(gumbel(v * N_CATS), v)
  CT[!CARRIES[brand, , drop = FALSE]] <- -Inf
  zone <- matrix(0L, v, MAX_ITEMS + 1L)
  for (k in seq_len(MAX_ITEMS + 1L)) {
    zone[, k] <- row_max(CT)$k
    CT[cbind(seq_len(v), zone[, k])] <- -Inf
  }
  arrive <- pmin(LAST_ENTRY_S, (hour - 1) * 3600 + runif(v, 0, 3600))
  n_zones <- pmin(MAX_ITEMS + 1L, 1L + rpois(v, SEGMENTS$zones[seg] - 1),
                  .rowSums(CARRIES[brand, , drop = FALSE] & CATEGORY_TASTE[seg, , drop = FALSE] > 0, v, N_CATS))
  list(arrive = arrive, zone = zone, n_zones = n_zones)
}

# The store clock runs to `to`, taking every simulation step that begins by
# then (a step's decisions are made as it begins, so everything drawn at `to`
# is settled). Inf runs the day out: every shopper still in a store leaves.
advance <- function(to) {
  while (next_step <= to && !day_over()) {
    run_step(next_step, next_step + STEP_S)
    next_step <<- next_step + STEP_S
  }
  clock <<- if (is.finite(to)) to else next_step
}

day_over <- function() next_step >= DAY_S && d$next_in > length(d$by_arrival) && d$on_next > length(d$on_order) && !any(is.finite(d$ev_at[d$active])) &&
  !outings_pending()

# After closing: what the day did to each household (the brand it last
# bought from, its budget, less what it paid and plus its refunds, its
# loyalty tiers, bad visits it remembers), word of mouth, and the fate of
# the day's sales (returns.R).
end_day <- function() {
  hh <- mk$hh
  paid <- d$outcome == 1L
  bad <- d$outcome %in% c(4L, 5L, 7L)         # not in my size, a queue walked out of
  # A household may have bought at several stores today: its last brand is
  # the one it paid at last, and its budget comes down by everything it paid.
  pv <- which(paid)
  pv <- pv[order(d$outcome_at[pv], pv)]
  mk$last_brand[d$hh[pv]] <<- d$brand[pv]                  # the last assignment, the latest purchase, wins
  mk$customer[cbind(d$hh[paid], d$brand[paid])] <<- TRUE
  season_log_add()
  spent <- rowsum(d$sales[paid] + d$delivery[paid], d$hh[paid])
  if (length(spent)) mk$budget_left[as.integer(rownames(spent))] <<- mk$budget_left[as.integer(rownames(spent))] - spent[, 1]
  rf <- refunds_today()
  if (length(rf$hh)) {
    back <- rowsum(rf$refund, rf$hh)
    mk$budget_left[as.integer(rownames(back))] <<- mk$budget_left[as.integer(rownames(back))] + back[, 1]
  }
  mk$grudge <<- mk$grudge * P$memory
  if (any(bad)) {
    g <- table((d$brand[bad] - 1L) * hh$n + d$hh[bad])     # two bad visits to one brand count twice
    k <- as.integer(names(g))
    mk$grudge[k] <<- mk$grudge[k] + as.numeric(g)
  }
  tiers_evening(rf)

  # Word of mouth: on each patch of its world, the feeling about each brand
  # follows how the shopping of the households living there went, in its
  # stores and online, good (paid) against bad. Then each brand's buzz
  # spreads to the neighbouring patches: NetLogoR's diffuse() has every
  # patch give WOM_SPREAD of it, in equal shares, to its eight neighbours.
  shop <- !d$ret
  paid <- paid[shop]; bad <- bad[shop]
  buzz <- of(world = mk$wom, agents = patches(mk$wom), var = BRANDS$id)    # patches x brands, in NetLogoR's cell order
  cells <- NROW(buzz)
  key <- (d$brand[shop] - 1L) * cells + mk$wom_cell[d$hh[shop]]
  n <- tabulate(key, cells * N_BRANDS)
  net <- tabulate(key[paid], cells * N_BRANDS) - 2 * tabulate(key[bad], cells * N_BRANDS)
  heard <- n > 0
  buzz[heard] <- 0.9 * buzz[heard] + 0.1 * (net[heard] / (n[heard] + 3))
  mk$wom <<- NLset(world = mk$wom, agents = patches(mk$wom), var = BRANDS$id, val = buzz)
  for (id in BRANDS$id) mk$wom <<- diffuse(mk$wom, pVar = id, share = WOM_SPREAD, nNeighbors = 8)

  offers_evening()
  returns_evening()
  tally_day()
}

# ---- Travel on the map ----------------------------------------------------------------

# Everyone outdoors at store time `t` (outings.R, outside_at): cars on the
# move, people walking, cars parked. Positions in metres.
travellers_at <- function(t) outside_at(t)
