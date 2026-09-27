# The market: each day, which households go clothes shopping and where.
#
# A household is in the market today with a chance that depends on its
# segment, the day of the week, the point in the season, how much of its
# season budget is left, promotions and marketing it has heard of, and any
# offers it holds, as long as some store is within its reach. In the
# market, it weighs every store within its radius against staying home (a
# multinomial logit, as households do in the digital twin preset). The
# radius is its segment's, stretched brand by brand by its loyalty tier
# with the brand (a loyal shopper goes further). A store's appeal adds up:
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
#   word of mouth from its neighbourhood
#   the store's layout (a flagship draws more than a small shop)
#   offers it holds that are good at the brand
#
# It then drives there along the fastest route, and back.

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
  hh <- mk$hh
  n <- hh$n
  seg <- hh$segment
  all_h <- seq_len(n)
  reach <- promo_reach(all_h)
  pr <- promo_heard(reach)
  heard <- .rowSums(pr$heard, n, N_BRANDS) / N_BRANDS   # share of brands with a promotion reaching the household
  # Some store within reach: of each brand, the nearest against the radius.
  reach_any <- .rowSums(mk$near_km <= radius_km(all_h), n, N_BRANDS) > 0
  ad <- LEVERS$ad$value
  shop <- SEGMENTS$shop[seg] * DOW_TRAFFIC[dow] * season_curve(day) *
    sqrt(pmax(0, mk$budget_left / hh$budget)) *
    (1 + AD_SHOP * mean(ad) + PROMO_SHOP * SEGMENTS$promo[seg] * heard) * mk$at$shop * reach_any
  i <- which(runif(n) < shop)
  m <- length(i)

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
  V <- P$taste_w * hh$taste[hb] + range_value(sg, b) + TIER_PULL[bt] - P$price_w * SEGMENTS$price[sg] * TIER_PRICE[bt] * log(price) +
    PROMO_W * SEGMENTS$promo[sg] * pa + AD_W * ad[b] -
    P$km_w * SEGMENTS$km[sg] * km -
    P$grudge_w * TIER_MEMORY[bt] * mk$grudge[hb] + P$wom * mk$buzz[cbind(hh$cell[hi], b)] +
    FORMAT_APPEAL[STORES$format[s]] + mk$at$util[hb] + gumbel(m * N_STORES)
  V[km > SEGMENTS$radius_km[sg] * TIER_RADIUS[bt]] <- -Inf
  dim(V) <- c(m, N_STORES)
  pick <- row_max(cbind(P$outside + gumbel(m), V))$k - 1L
  went <- pick > 0
  today$in_market <<- tabulate(hh$bin[i], AREA_BINS)
  today$stayed_home <<- tabulate(hh$bin[i[!went]], AREA_BINS)
  today$in_market_hh <<- i
  new_visits(i[went], pick[went], reach[i[went], , drop = FALSE])
}

# Today's visits: who, where, when they arrive, which racks they'll browse
# (their segment's favourite of the categories the brand sells, in a
# random order), and what comes off their prices (the promotions reaching
# them, and a coupon: its depth, and the offer it's from).
new_visits <- function(h, store, reach) {
  hh <- mk$hh
  v <- length(h); seg <- hh$segment[h]
  brand <- STORES$brand[store]; fmt <- STORES$format[store]
  hour <- sample.int(length(HOURLY), v, replace = TRUE, prob = HOURLY)
  CT <- log(CATEGORY_TASTE[seg, , drop = FALSE]) + matrix(gumbel(v * N_CATS), v)
  CT[!CARRIES[brand, , drop = FALSE]] <- -Inf
  zone <- matrix(0L, v, MAX_ITEMS + 1L)
  for (k in seq_len(MAX_ITEMS + 1L)) {
    zone[, k] <- row_max(CT)$k
    CT[cbind(seq_len(v), zone[, k])] <- -Inf
  }
  arrive <- pmin(LAST_ENTRY_S, (hour - 1) * 3600 + runif(v, 0, 3600))
  hb <- cbind(h, brand)
  travel <- mk$drive_s[cbind(h, store)] + MACRO$park_s
  coupon <- mk$at$coupon[hb]
  n_zones <- pmin(MAX_ITEMS + 1L, 1L + rpois(v, SEGMENTS$zones[seg] - 1),
                  .rowSums(CARRIES[brand, , drop = FALSE] & CATEGORY_TASTE[seg, , drop = FALSE] > 0, v, N_CATS))
  promos <- promo_rows(brand, reach)

  d <<- list(
    v = v, hh = h, seg = seg, size = hh$size[h], area = hh$area[h], bin = hh$bin[h],
    store = store, brand = brand, format = fmt, tier = mk$tier[hb],
    arrive = arrive, travel = travel, speed = runif(v, WALK_MPS[1], WALK_MPS[2]),
    zone = zone, n_zones = n_zones, zi = integer(v),
    at = fl$entrance[fmt],                     # the anchor they're at, or last left (a store with several doors: below)
    ev_at = arrive, ev_kind = rep(EV_MOVE, v), # their next decision: when, and what
    items = integer(v), n_try = integer(v),    # carried, and of those to try on
    basket = matrix(0L, v, MAX_ITEMS), paid_for = matrix(0, v, MAX_ITEMS), full_for = matrix(0, v, MAX_ITEMS),
    md_for = matrix(0, v, MAX_ITEMS), off_for = matrix(0, v, MAX_ITEMS),     # each item's markdown, and promotion, when taken
    promos = today_promos$k, promo_row = promos$row, promo_off = promos$off, reached = reach, coupon = coupon, coupon_from = mk$at$coupon_from[hb], coupon_saved = numeric(v),
    budget = mk$budget_left[h], spent = numeric(v), advised = numeric(v), tried = logical(v),
    missed_size = logical(v), too_dear = logical(v), wait = numeric(v),
    outcome = integer(v), outcome_at = rep(NA_real_, v), gone = rep(Inf, v),
    sales = numeric(v), full_value = numeric(v), units = integer(v), cogs = numeric(v),
    events = 0L, late = 0L,
    by_arrival = order(arrive), next_in = 1L, active = integer()
  )
  # In a store with several doors, each shopper comes in by one of them (a
  # draw made only where there's a choice).
  many <- which(fl$n_doors[fmt] > 1L)
  if (length(many)) d$at[many] <<- door_in(fmt[many])
  legs <<- new_legs(12L * v)
  staff <<- new_staff_log()
  vlog <<- list(n = 0L, m = matrix(0, 12L * v, VLOG_COLS))
  queues <<- new_queues()
  exits <<- list(v = integer(), t0 = numeric(), outcome = integer())
  trips <<- NULL
  next_step <<- 0; clock <<- 0
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

day_over <- function() next_step >= DAY_S && d$next_in > d$v && !any(is.finite(d$ev_at[d$active]))

# After closing: what the day did to each household (the brand it last
# bought from, its budget, its loyalty tiers, bad visits it remembers), and
# word of mouth.
end_day <- function() {
  hh <- mk$hh
  paid <- d$outcome == 1L
  bad <- d$outcome %in% c(4L, 5L, 7L)         # not in my size, a queue walked out of
  mk$last_brand[d$hh[paid]] <<- d$brand[paid]
  mk$customer[cbind(d$hh[paid], d$brand[paid])] <<- TRUE
  season_log_add()
  mk$budget_left[d$hh[paid]] <<- mk$budget_left[d$hh[paid]] - d$sales[paid]
  g <- cbind(d$hh[bad], d$brand[bad])
  mk$grudge <<- mk$grudge * P$memory
  mk$grudge[g] <<- mk$grudge[g] + 1
  tiers_evening()

  # Word of mouth: each neighbourhood's feeling about each brand follows
  # how its households' visits went, good (paid) against bad.
  cell <- hh$cell[d$hh]
  key <- (d$brand - 1L) * N_WOM_CELLS + cell
  n <- tabulate(key, N_WOM_CELLS * N_BRANDS)
  net <- tabulate(key[paid], N_WOM_CELLS * N_BRANDS) - 2 * tabulate(key[bad], N_WOM_CELLS * N_BRANDS)
  heard <- n > 0
  mk$buzz[heard] <<- 0.9 * mk$buzz[heard] + 0.1 * (net[heard] / (n[heard] + 3))

  offers_evening()
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
