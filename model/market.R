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
  hh <- mk$hh
  n <- hh$n
  seg <- hh$segment
  all_h <- seq_len(n)
  reach <- promo_reach(all_h)
  pr <- promo_heard(reach)
  heard <- .rowSums(pr$heard, n, N_BRANDS) / N_BRANDS   # share of brands with a promotion reaching the household
  # Some store within reach (of each brand, the nearest against the
  # radius), or any online store.
  reach_any <- .rowSums(mk$near_km <= radius_km(all_h), n, N_BRANDS) > 0 | any(ONLINE$on)
  ad <- LEVERS$ad$value
  shop <- SEGMENTS$shop[seg] * DOW_TRAFFIC[dow] * season_curve(day) * DEMAND_EVENT[day] *
    sqrt(pmax(0, mk$budget_left / hh$budget)) *
    (1 + AD_SHOP * mean(ad) + PROMO_SHOP * SEGMENTS$promo[seg] * heard) * mk$at$shop * reach_any
  i <- which(runif(n) < shop)
  m <- length(i)
  buzz <- buzz_of(i)                     # word of mouth on the patch each of them lives on, by brand

  # Every store in reach against staying home.
  s <- rep(seq_len(N_STORES), each = m)
  b <- STORES$brand[s]
  hi <- rep(i, times = N_STORES)
  hb <- cbind(hi, b)
  tier <- mk$tier[hb]
  bt <- cbind(b, tier)
  pa <- pr$heard[hb]
  price <- price_position()[b] * (1 - pr$off[hb]) * (1 - mk$at$coupon[hb])
  sg <- seg[hi]
  km <- mk$km[cbind(hi, s)]
  cover <- window_cover()
  V <- P$taste_w * hh$taste[hb] + range_value(sg, b) + TIER_PULL[bt] - P$price_w * SEGMENTS$price[sg] * TIER_PRICE[bt] * log(price) +
    PROMO_W * SEGMENTS$promo[sg] * pa + AD_W * ad[b] -
    P$km_w * SEGMENTS$km[sg] * km -
    P$grudge_w * TIER_MEMORY[bt] * mk$grudge[hb] + P$wom * buzz[cbind(rep.int(seq_len(m), N_STORES), b)] +
    FORMAT_APPEAL[STORES$format[s]] + mk$at$util[hb] + RETURN_PULL[["store"]] * cover[b] + gumbel(m * N_STORES)
  V[km > SEGMENTS$radius_km[sg] * TIER_RADIUS[bt]] <- -Inf
  dim(V) <- c(m, N_STORES)
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
      SEGMENTS$online[sg] - DELIVERY_W * ONLINE$delivery_days[b] + RETURN_PULL[["online"]] * cover[b] + gumbel(m * k)
    dim(Vo) <- c(m, k)
  }
  pick <- row_max(cbind(home, V, Vo))$k - 1L
  went <- pick > 0
  store <- went & pick <= N_STORES
  online <- pick > N_STORES
  today$in_market <<- tabulate(hh$bin[i], AREA_BINS)
  today$stayed_home <<- tabulate(hh$bin[i[!went]], AREA_BINS)
  today$in_market_hh <<- i
  new_visits(i[store], pick[store], reach[i[store], , drop = FALSE],
             i[online], bo[pick[online] - N_STORES], reach[i[online], , drop = FALSE], back, reach[back$hh, , drop = FALSE])
}

# Today's visits: the shoppers in the stores, the online shoppers, and the
# households returning items to a store. Who, where, when they arrive (or
# order), which racks they'll browse (their segment's favourite of the
# categories the brand sells, in a random order), and what comes off their
# prices (the promotions reaching them, and a coupon: its depth, and the
# offer it's from). The store shoppers' draws come first, in the order
# they always have, so a world with no online stores and no returns runs
# as it did.
new_visits <- function(h, store, reach, h_on = integer(), b_on = integer(), reach_on = reach[0, , drop = FALSE], back = NULL,
                       reach_back = reach[0, , drop = FALSE]) {
  hh <- mk$hh
  brand <- STORES$brand[store]; fmt <- STORES$format[store]
  S <- browse_plan(h, brand)
  speed <- runif(length(h), WALK_MPS[1], WALK_MPS[2])
  at <- fl$entrance[fmt]
  # In a store with several doors, each shopper comes in by one of them (a
  # draw made only where there's a choice).
  many <- which(fl$n_doors[fmt] > 1L)
  if (length(many)) at[many] <- door_in(fmt[many])
  O <- browse_plan(h_on, b_on)
  # Returning: a trip to the store, straight to the tills.
  r <- back$hh %||% integer(); rs <- back$store %||% integer(); nr <- length(r)
  r_fmt <- STORES$format[rs]; r_at <- fl$entrance[r_fmt]; r_arrive <- numeric(); r_speed <- numeric()
  if (nr) {
    hour <- sample.int(length(HOURLY), nr, replace = TRUE, prob = HOURLY)
    r_arrive <- pmin(LAST_ENTRY_S, (hour - 1) * 3600 + runif(nr, 0, 3600))
    r_speed <- runif(nr, WALK_MPS[1], WALK_MPS[2])
    many <- which(fl$n_doors[r_fmt] > 1L)
    if (length(many)) r_at[many] <- door_in(r_fmt[many])
  }

  vs <- length(h); vo <- length(h_on); v <- vs + vo + nr
  H <- c(h, h_on, r); B <- c(brand, b_on, STORES$brand[rs]); ST <- c(store, integer(vo), rs)
  online <- rep(c(FALSE, TRUE, FALSE), c(vs, vo, nr)); ret <- rep(c(FALSE, FALSE, TRUE), c(vs, vo, nr))
  hb <- cbind(H, B)
  arrive <- c(S$arrive, O$arrive, r_arrive)
  coupon <- mk$at$coupon[hb]; coupon[ret] <- 0
  coupon_from <- mk$at$coupon_from[hb]; coupon_from[ret] <- 0L
  reached <- rbind(reach, reach_on, reach_back)
  promos <- promo_rows(B, reached)
  floor <- which(!online)

  d <<- list(
    v = v, hh = H, seg = hh$segment[H], size = hh$size[H], area = hh$area[H], bin = hh$bin[H],
    store = ST, outlet = ifelse_int(online, N_STORES + B, ST), brand = B, format = c(fmt, integer(vo), r_fmt), tier = mk$tier[hb],
    online = online, ret = ret, ret_lines = c(vector("list", vs + vo), back$lines),   # returning: the ledger lines they bring back
    arrive = arrive, travel = c(mk$drive_s[cbind(h, store)], numeric(vo), mk$drive_s[cbind(r, rs)]) + MACRO$park_s * !online,
    speed = c(speed, numeric(vo), r_speed),
    zone = rbind(S$zone, O$zone, matrix(0L, nr, MAX_ITEMS + 1L)), n_zones = c(S$n_zones, O$n_zones, integer(nr)), zi = integer(v),
    at = c(at, integer(vo), r_at),             # the anchor they're at, or last left (online: none)
    ev_at = arrive, ev_kind = rep(EV_MOVE, v), # their next decision: when, and what
    items = c(integer(vs + vo), lengths(back$lines)), n_try = integer(v),    # carried (or brought back), and of those to try on
    basket = matrix(0L, v, MAX_ITEMS), paid_for = matrix(0, v, MAX_ITEMS), full_for = matrix(0, v, MAX_ITEMS),
    md_for = matrix(0, v, MAX_ITEMS), off_for = matrix(0, v, MAX_ITEMS),     # each item's markdown, and promotion, when taken
    promos = today_promos$k, promo_row = promos$row, promo_off = promos$off, reached = reached, coupon = coupon, coupon_from = coupon_from, coupon_saved = numeric(v),
    budget = mk$budget_left[H], spent = numeric(v), advised = numeric(v), tried = logical(v),
    missed_size = logical(v), too_dear = logical(v), wait = numeric(v),
    outcome = integer(v), outcome_at = rep(NA_real_, v), gone = rep(Inf, v),
    sales = numeric(v), full_value = numeric(v), units = integer(v), cogs = numeric(v), delivery = numeric(v),
    events = 0L, late = 0L,
    by_arrival = floor[order(arrive[floor])], next_in = 1L, active = integer(),   # visits on a store floor
    on_order = which(online)[order(arrive[online])], on_next = 1L                 # online visits
  )
  legs <<- new_legs(12L * v)
  staff <<- new_staff_log()
  vlog <<- list(n = 0L, m = matrix(0, 12L * v, VLOG_COLS))
  queues <<- new_queues()
  exits <<- list(v = integer(), t0 = numeric(), outcome = integer())
  trips <<- NULL
  next_step <<- 0; clock <<- 0
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

day_over <- function() next_step >= DAY_S && d$next_in > length(d$by_arrival) && d$on_next > length(d$on_order) && !any(is.finite(d$ev_at[d$active]))

# After closing: what the day did to each household (the brand it last
# bought from, its budget, less what it paid and plus its refunds, its
# loyalty tiers, bad visits it remembers), word of mouth, and the fate of
# the day's sales (returns.R).
end_day <- function() {
  hh <- mk$hh
  paid <- d$outcome == 1L
  bad <- d$outcome %in% c(4L, 5L, 7L)         # not in my size, a queue walked out of
  mk$last_brand[d$hh[paid]] <<- d$brand[paid]
  mk$customer[cbind(d$hh[paid], d$brand[paid])] <<- TRUE
  season_log_add()
  mk$budget_left[d$hh[paid]] <<- mk$budget_left[d$hh[paid]] - d$sales[paid] - d$delivery[paid]
  rf <- refunds_today()
  if (length(rf$hh)) {
    back <- rowsum(rf$refund, rf$hh)
    mk$budget_left[as.integer(rownames(back))] <<- mk$budget_left[as.integer(rownames(back))] + back[, 1]
  }
  g <- cbind(d$hh[bad], d$brand[bad])
  mk$grudge <<- mk$grudge * P$memory
  mk$grudge[g] <<- mk$grudge[g] + 1
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

# Where every shopper on the road is at store time `t`: leaving home for the
# store, or driving home after, along the fastest route. Positions in
# metres, the brand they're going to or coming from, and which way.
travellers_at <- function(t) {
  out <- d$arrive > t & d$arrive - d$travel <= t
  back <- is.finite(d$gone) & d$gone <= t & d$gone + d$travel > t
  i <- which(out | back)
  if (!length(i)) return(list(x = numeric(), y = numeric(), brand = integer(), back = logical()))
  build_trips()
  dir_back <- back[i]
  moving <- ifelse(dir_back, t - d$gone[i], t - (d$arrive[i] - d$travel[i])) - MACRO$park_s / 2
  total <- trips$total[i]
  from_home <- ifelse(dir_back, total - moving, moving)
  p <- route_of(i, from_home)
  list(x = p[, 1], y = p[, 2], brand = d$brand[i], back = dir_back, visit = i)
}
