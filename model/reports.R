# What each tab shows, built from the tallies (tally.R) and from today's
# visits. Sent to the page as JSON a few times a second, for the visible
# tab only, after tally_live() has brought today's row up to the clock.
# Nothing here changes the simulation or draws random numbers. Series by
# day go through I() so a one-day season is still a list in JSON. "Ours"
# is our family of brands, set against every other brand.

to_json <- function(x) jsonlite::toJSON(x, auto_unbox = TRUE, digits = 4, na = "null", null = "null")

`%||%` <- function(a, b) if (is.null(a)) b else a

# "The day" a report means: the one under way at watch pace, or the last one
# finished at season pace (the new day hasn't started yet).
report_day <- function() {
  live <- clock > 0 || is.null(prev)
  if (live) list(live = TRUE, d = d, legs = legs, staff = staff, today = today, vlog = vlog, day = day, t = clock,
                 label = if (day_over()) "Today" else "Today so far")
  else c(prev, list(live = FALSE, t = Inf, label = "Yesterday"))
}

brand_days <- function(what, dd = days_so_far()) {
  if (!length(dd)) return(matrix(0, 0, N_BRANDS))
  x <- apply(tally[[what]][dd, , , drop = FALSE], c(1, 3), sum)          # day x store
  if (length(dd) == 1) x <- matrix(x, 1)
  t(rowsum(t(x), STORES$brand, reorder = TRUE))                           # day x brand
}

ours_mean <- function(v) if (any(OURS_B)) mean(v[OURS_B]) else NA
rivals_mean <- function(v) if (any(!OURS_B)) mean(v[!OURS_B]) else NA

# ---- Header ---------------------------------------------------------------------------

report_header <- function() {
  dd <- days_so_far()
  sales <- brand_of_stores(store_sum("sales", dd))
  v <- if (length(dd)) tally$visits[dd, , , , drop = FALSE] else array(0, c(1, 1, N_STORES, N_OUTCOMES))
  ours <- OURS_B[STORES$brand]
  entered <- sum(v[, , ours, ]); paid <- sum(v[, , ours, 1])
  list(day = day, week = week_of(day), dow = DAYS[dow_of(day)], clock = clock_hm(min(clock, DAY_S)),
       clock_s = clock, pace = P$pace, watch_speed = P$watch_speed, season_over = season_over,
       season_days = SEASON_DAYS, season_weeks = SEASON_WEEKS, days_done = days_complete(), world_version = world_version,
       share = if (sum(sales)) sum(sales[OURS_B]) / sum(sales) else NA, sales = sum(sales[OURS_B]),
       conversion = if (entered) paid / entered else NA,
       in_stores = sum(d$arrive <= clock & d$gone > clock),
       on_road = if (P$pace == "watch") sum((d$arrive > clock & d$arrive - d$travel <= clock) |
                                             (is.finite(d$gone) & d$gone <= clock & d$gone + d$travel > clock)) else 0)
}

# ---- Setup ----------------------------------------------------------------------------

# The installed world's facts the Setup tab shows beside its settings:
# households, how many have no store in reach, and each store's reach.
report_setup <- function() {
  list(world = WORLD$name, seed = P$seed, households = mk$hh$n, stranded = sum(!reach_base()$any),
       reach = reach_base()$per_store, stores = STORES$id)
}

# Every setting's range, label and format, for the page (sent once).
world_schema <- function() {
  list(fields = FIELDS, levers = LEVERS[names(LEVERS)], sizes = SIZES,
       allocations = ALLOCATIONS, map_chars = as.list(MAP_CHARS),
       replenish_rules = REPLENISH_RULES, markdown_which = MARKDOWN_WHICH, markdown_modes = MARKDOWN_MODES, weekdays = DAYS,
       floor_codes = as.list(FLOOR_CODES), floor_key = FLOOR_KEY, rack_code = RACK_CODE, category_keys = CATEGORY_KEYS,
       calendar_on = CALENDAR_ON, world_version = WORLD_VERSION, layout_version = LAYOUT_VERSION,
       limits = list(brands = MAX_BRANDS, stores = MAX_STORES, segments = MAX_SEGMENTS, tiers = MAX_TIERS, areas = MAX_AREAS,
                     map_tiles = MAX_MAP_TILES, households = MAX_HOUSEHOLDS, layout_w = MAX_LAYOUT_W, layout_h = MAX_LAYOUT_H,
                     categories = MAX_CATEGORIES, products = MAX_PRODUCTS, offers = MAX_OFFERS),
       wages = as.list(WAGE))
}

# Which stores each household can reach at its segment's radius (before
# any stretch for loyalty).
reach_base <- function(km = mk$km, seg = mk$hh$segment) {
  r <- km <= SEGMENTS$radius_km[seg]
  list(any = .rowSums(r, dim(r)[1L], dim(r)[2L]) > 0, per_store = .colSums(r, dim(r)[1L], dim(r)[2L]),
       count = .rowSums(r, dim(r)[1L], dim(r)[2L]))
}

# ---- Market ---------------------------------------------------------------------------

report_market <- function() {
  dd <- days_so_far(); rd <- report_day()
  arrived <- rd$d$arrive <= rd$t
  visits_day <- tabulate(rd$d$store[arrived], N_STORES)
  inside <- tabulate(rd$d$store[rd$d$arrive <= clock & rd$d$gone > clock], N_STORES)
  sales_season <- store_sum("sales", dd)
  running <- cal$pr$brand[today_promos$k]
  bd <- brand_days("sales", dd)
  pos <- price_position()
  weeks <- if (length(dd)) week_of(dd) else integer()
  list(
    day_label = rd$label,
    stores = lapply(seq_len(N_STORES), function(s) list(
      id = s, visits = visits_day[s], inside = inside[s], sales = sales_season[s],
      promo = STORES$brand[s] %in% running)),
    brands = lapply(seq_len(N_BRANDS), function(b) list(
      name = BRANDS$name[b], colour = BRANDS$colour[b], family = BRANDS$family[b], ours = OURS_B[b],
      price = pos[b], ad = LEVERS$ad$value[b],
      cashiers = LEVERS$cashiers$value[b], assistants = LEVERS$assistants$value[b],
      on_today = lapply(today_promos$k[running == b], function(k) list(name = cal$pr$name[k], depth = cal$pr$depth[k], to = cal$pr$to[k],
                                                                       on = promo_on_text(b, cal$pr$cover[k, ]), reach = promo_reach_text(b, k))),
      stores = sum(STORES$brand == b))),
    customers = last_row("customers", dd) %||% tabulate(mk$last_brand + 1L, N_BRANDS + 1L),
    sales_share = if (length(dd)) round(bd / pmax(rowSums(bd), 1), 4) else list(),
    revenue = I(colSums(bd)),
    weekly = if (length(dd)) lapply(sort(unique(weeks)), function(w) colSums(bd[weeks == w, , drop = FALSE])) else list(),
    areas = lapply(seq_len(N_AREAS), function(k) {
      here <- mk$hh$area == k
      list(name = AREAS$name[k], households = sum(here), customers = tabulate(mk$last_brand[here] + 1L, N_BRANDS + 1L))
    }),
    shopper = shopper_panel(selected$household)
  )
}

# The parts of a household's appeal for each store today (without the day's
# random taste): what the Market tab's household card and the inspector
# show. Stores out of its reach are NA.
appeal_parts <- function(h) {
  hh <- mk$hh
  seg <- hh$segment[h]
  s <- seq_len(N_STORES); b <- STORES$brand
  pr <- promo_heard(promo_reach(h))
  pa <- pr$heard[1, b]
  tier <- mk$tier[h, b]; bt <- cbind(b, tier)
  price <- price_position()[b] * (1 - pr$off[1, b]) * (1 - mk$at$coupon[h, b])
  parts <- cbind(
    taste = P$taste_w * hh$taste[h, b],
    range = range_value(seg, b),
    loyalty = TIER_PULL[bt],
    price = -P$price_w * SEGMENTS$price[seg] * TIER_PRICE[bt] * log(price),
    promotion = PROMO_W * SEGMENTS$promo[seg] * pa + AD_W * LEVERS$ad$value[b],
    distance = -P$km_w * SEGMENTS$km[seg] * mk$km[h, s],
    memory = -P$grudge_w * TIER_MEMORY[bt] * mk$grudge[h, b],
    word_of_mouth = P$wom * mk$buzz[hh$cell[h], b],
    store = FORMAT_APPEAL[STORES$format],
    offers = mk$at$util[h, b]
  )
  reach <- mk$km[h, s] <= SEGMENTS$radius_km[seg] * TIER_RADIUS[bt]
  list(parts = parts, appeal = ifelse(reach, rowSums(parts), NA), reach = reach)
}
APPEAL_LABELS <- c(taste = "their own taste for the brand", range = "what the brand sells", loyalty = "their loyalty to the brand", price = "the prices",
                   promotion = "promotions and marketing", distance = "the trip", memory = "bad visits they remember",
                   word_of_mouth = "word of mouth", store = "the store itself", offers = "an offer they hold")

# One household, as the Market tab's card shows it: its appeal for each
# brand's best store in reach today, the favourite and how far ahead it
# is, its tier with each brand, the stores in its reach, offers it holds.
# A brand selling nothing its segment likes isn't a choice, in reach or not.
shopper_panel <- function(h) {
  if (is.na(h)) return(NULL)
  hh <- mk$hh
  a <- appeal_parts(h)
  b <- STORES$brand
  likes <- is.finite(a$parts[, "range"])
  best <- vapply(seq_len(N_BRANDS), function(k) {
    s <- which(b == k & a$reach & likes)
    if (length(s)) s[which.max(a$appeal[s])] else NA_integer_
  }, 0L)
  vb <- ifelse(is.na(best), NA, a$appeal[best])
  o <- order(-vb, na.last = NA)
  L <- vlog_season_rows(h)
  list(
    id = h, area = if (hh$area[h] > 0) AREAS$name[hh$area[h]] else "Outside every area",
    segment = SEGMENTS$name[hh$segment[h]], size = SIZES[hh$size[h]],
    budget = hh$budget[h], budget_left = mk$budget_left[h], x = hh$x[h], y = hh$y[h],
    last_brand = mk$last_brand[h], outside = P$outside, radius_km = SEGMENTS$radius_km[hh$segment[h]],
    brands = lapply(seq_len(N_BRANDS), function(k) {
      t <- tier_outlook(h, k)
      c(list(brand = k, tier = t$name, tier_k = t$tier, tiers = TIER_N[k], in_reach = !is.na(best[k]), sells_nothing = !any(likes[b == k])),
        if (!is.na(best[k])) c(list(store_name = STORES$name[best[k]], appeal = a$appeal[best[k]], km = mk$km[h, best[k]]),
                               as.list(a$parts[best[k], ])))
    }),
    reach = list(n = sum(a$reach), stores = I(STORES$name[a$reach])),
    favourite = if (length(o)) o[1] else NA, gap = if (length(o) > 1) vb[o[1]] - vb[o[2]] else NA,
    offers = lapply(offers_held(h), function(k) list(brand = OFFERS$brand[k], name = OFFERS$name[k], depth = OFFERS$depth[k], until = OFFERS$to[k])),
    visits = lapply(rev(seq_len(nrow(L)))[seq_len(min(6, nrow(L)))], function(i) list(
      day = L[i, 1], store = STORES$name[L[i, 3]], outcome = OUTCOMES[L[i, 4]], sales = L[i, 5]))
  )
}

# ---- Strategy ------------------------------------------------------------------------------

report_strategy <- function() {
  dd <- days_so_far()
  # Price is the brands' price position: their prices against the market's.
  pos <- price_position()
  levers <- c(list(list(name = "price", label = "Price position", min = 0, max = max(2, ceiling(max(pos) * 4) / 4), step = 0.01, format = "num2",
                        ours = ours_mean(pos), competitors = rivals_mean(pos), each = I(pos))),
              lapply(c("ad", "cashiers", "assistants"), function(n) {
    L <- LEVERS[[n]]
    list(name = n, label = L$label, min = L$min, max = L$max, step = L$step, format = L$format,
         ours = ours_mean(L$value), competitors = rivals_mean(L$value), each = I(L$value))
  }))
  bd <- brand_days("sales", dd)
  ever <- last_row("ever", dd) %||% numeric(N_BRANDS + 1L)
  customers <- ever[seq_len(N_BRANDS)]        # by brand; a household can be a customer of several
  sales <- colSums(bd)
  receipts <- brand_of_stores(store_sum_visits_paid(dd))
  weeks <- if (length(dd)) week_of(dd) else integer()
  paid_days <- brand_days_paid(dd)
  weekly_receipt <- lapply(sort(unique(weeks)), function(w) {
    s <- colSums(bd[weeks == w, , drop = FALSE]); n <- colSums(paid_days[weeks == w, , drop = FALSE])
    c(ours = sum(s[OURS_B]) / max(1, sum(n[OURS_B])), competitors = sum(s[!OURS_B]) / max(1, sum(n[!OURS_B])))
  })
  budget <- vapply(seq_len(N_SEGMENTS), function(g) sum(mk$hh$budget[mk$hh$segment == g]), 0)
  wallet <- if (length(dd)) colSums(tally$wallet[dd, , , drop = FALSE]) else matrix(0, N_SEGMENTS, N_BRANDS)
  wallet <- matrix(wallet, N_SEGMENTS)
  ours_customers <- if (length(dd)) sum(tally$customers[max(dd), c(FALSE, OURS_B)]) else 0
  list(
    levers = levers,
    share_history = if (length(dd)) tally$share[dd, , drop = FALSE] / pmax(rowSums(tally$share[dd, , drop = FALSE]), 1) else list(),
    revenue = list(ours = sum(sales[OURS_B]), competitors = sum(sales[!OURS_B]), by_brand = I(sales)),
    spend_per_customer = list(by_brand = I(sales / pmax(1, customers))),
    avg_receipt = list(ours = sum(sales[OURS_B]) / max(1, sum(receipts[OURS_B])), competitors = sum(sales[!OURS_B]) / max(1, sum(receipts[!OURS_B]))),
    receipt_history = weekly_receipt,
    wallet = lapply(seq_len(N_SEGMENTS), function(g) list(segment = SEGMENTS$name[g], budget = budget[g], spend = I(wallet[g, ]))),
    # Households that have bought: from our family (whatever else), or only from competitors.
    customers = list(ours = households_bought_ours(), rivals_only = ever[N_BRANDS + 1L]),
    contribution = contribution(dd)
  )
}

households_bought_ours <- function() sum(.rowSums(mk$customer[, OURS_B, drop = FALSE], mk$hh$n, sum(OURS_B)) > 0)

store_sum_visits_paid <- function(dd) {
  if (!length(dd)) return(numeric(N_STORES))
  colSums(colSums(tally$visits[dd, , , 1, drop = FALSE], dims = 1), dims = 1)
}
brand_days_paid <- function(dd) {
  if (!length(dd)) return(matrix(0, 0, N_BRANDS))
  x <- apply(tally$visits[dd, , , 1, drop = FALSE], c(1, 3), sum)
  if (length(dd) == 1) x <- matrix(x, 1)
  t(rowsum(t(x), STORES$brand, reorder = TRUE))
}

# Each brand's season so far: sales, less markdowns and promotions given
# away, cost of goods sold, staff, marketing, offers, logistics (deliveries
# and units shipped), and at the season's end the stock left, written down
# to what it fetches. Until then, the stock left is shown at cost. Rent and
# overheads are left out.
contribution <- function(dd = days_so_far()) {
  sb <- function(what) brand_of_stores(store_sum(what, dd))
  full <- sb("full"); sales <- sb("sales"); cogs <- sb("cogs")
  by_day <- function(what, stores = FALSE) {
    if (!length(dd)) return(numeric(N_BRANDS))
    x <- colSums(tally[[what]][dd, , drop = FALSE])
    if (stores) brand_of_stores(x) else x
  }
  staff <- by_day("staff_cost", TRUE); logistics <- by_day("logistics", TRUE)
  ads <- by_day("ad_cost"); offers <- by_day("offer_cost"); writedown <- by_day("writedown")
  deliveries <- by_day("deliveries", TRUE); shipped <- by_day("shipped", TRUE)
  left <- stock_left_cost()
  lapply(seq_len(N_BRANDS), function(b) list(
    brand = b, full_price = full[b], discounts = full[b] - sales[b], sales = sales[b], cogs = cogs[b],
    staff = staff[b], marketing = ads[b], offers = offers[b], logistics = logistics[b], deliveries = deliveries[b], shipped = shipped[b],
    writedown = writedown[b], stock_left = left[b], salvage = P_STOCK$salvage[b], written_down = season_done(),
    contribution = sales[b] - cogs[b] - staff[b] - ads[b] - offers[b] - logistics[b] - writedown[b]))
}

# ---- Offers --------------------------------------------------------------------------------

# Brand b's offers and loyalty tiers. Every offer on its calendar, as
# measured so far (offers.R, offer_results), the one picked (`k`, an
# offer's number; 0: the one running, else the latest to have run) in
# detail, the brand's totals, and its tiers: households by the tier they
# started in, where their spend this season puts them, and who has kept,
# moved up or not re-qualified yet (dropped, at the season's end).
report_offers <- function(b = 1L, k = 0L) {
  b <- min(max(1L, b), N_BRANDS)
  rd <- report_day()
  mine <- which(OFFERS$brand == b)
  if (!(k %in% mine)) {
    live <- mine[ofr$drawn[mine] & OFFERS$to[mine] >= rd$day]
    ran <- mine[ofr$drawn[mine]]
    k <- if (length(live)) live[1] else if (length(ran)) ran[length(ran)] else if (length(mine)) mine[1] else 0L
  }
  offers <- lapply(mine, function(i) if (i == k) offer_results(i, rd, detail = TRUE) else offer_results(i, rd))
  run <- Filter(function(o) o$state != "planned", offers)
  total <- function(f) sum(vapply(run, function(o) { v <- o[[f]]; if (is.null(v) || !is.finite(v)) 0 else v }, 0))
  measured <- Filter(function(o) is.finite(o$extra_margin), run)
  K <- TIER_N[b]
  sp <- season_spend(rd)[, b]
  tm <- tier_moves(b, sp)
  list(
    brand = b, selected = k, days = SEASON_DAYS, today = rd$day,
    offers = offers,
    totals = list(planned = length(offers) - length(run), run = length(run), sent = total("sent"), held_out = total("held_out"),
                  used = total("used"), send_total = total("send_total"), discount = total("discount"),
                  measured = length(measured), extra_sales = sum(vapply(measured, function(o) o$extra_sales, 0)),
                  extra_margin = sum(vapply(measured, function(o) o$extra_margin, 0))),
    loyalty = list(names = I(TIER_NAMES[[b]]), spend = I(TIER_SPEND[b, seq_len(K)]), moves = TIER_MOVES, final = season_done(),
                   start = I(tabulate(tm$start, K)), now = I(tabulate(mk$tier[, b], K)), reached = I(tabulate(tm$reached, K)),
                   matrix = tm$matrix,
                   by_start = lapply(seq_len(K), function(t) I(tabulate(tm$move[tm$start == t], 3L))),
                   spend_by_start = I(vapply(seq_len(K), function(t) if (any(tm$start == t)) mean(sp[tm$start == t]) else 0, 0)))
  )
}

# ---- Funnel --------------------------------------------------------------------------------

# area: 0 every area, k one area, N_AREAS + 1 outside every area.
report_funnel <- function(brand = 0L, area = 0L, store = 0L, scope = "season") {
  dd <- days_so_far()
  stores <- if (store > 0) store else if (brand > 0) which(STORES$brand == brand) else seq_len(N_STORES)
  bins <- if (area > 0) area else seq_len(AREA_BINS)
  rd <- report_day()
  if (scope == "day") {
    dv <- rd$d
    arrived <- dv$arrive <= rd$t
    in_s <- dv$store %in% stores & dv$bin %in% bins & arrived
    o <- tabulate(dv$outcome[in_s & dv$outcome > 0], N_OUTCOMES)
    entered <- sum(in_s)
    in_market <- sum(rd$today$in_market[bins]); stayed <- sum(rd$today$stayed_home[bins])
    went_any <- sum(dv$bin %in% bins & arrived)
  } else {
    v <- if (length(dd)) tally$visits[dd, bins, stores, , drop = FALSE] else array(0, c(1, 1, 1, N_OUTCOMES))
    o <- apply(v, 4, sum)
    in_market <- sum(tally$in_market[dd, bins]); stayed <- sum(tally$stayed_home[dd, bins])
    went_any <- if (length(dd)) sum(tally$visits[dd, bins, , , drop = FALSE]) else 0
    entered <- sum(o)
  }
  elsewhere <- max(0, went_any - entered)
  # Each stage, and the visits lost at it: each way a visit ends is lost at
  # one stage (events.R). "Past fitting rooms" includes shoppers with
  # nothing to try on, who go straight to the tills.
  n <- c(in_market, entered, numeric(length(FUNNEL_STAGES) - 2L))
  for (k in 3:length(FUNNEL_STAGES)) n[k] <- n[k - 1L] - sum(o[which(OUTCOME_STAGE == k - 1L)])
  stages <- lapply(seq_along(FUNNEL_STAGES), function(k) list(name = FUNNEL_STAGES[k], n = n[k],
    lost = if (k == 1L) list(list(reason = "stayed home", n = stayed), list(reason = "went to another store", n = elsewhere))
           else lapply(which(OUTCOME_STAGE == k), function(i) list(reason = OUTCOMES[i], n = o[i]))))
  sb <- if (brand > 0) brand else if (store > 0) STORES$brand[store] else which(OURS_B)[1]
  list(stages = stages, scope = scope, day_label = rd$label, live = live_stages(stores, bins),
       staff = list(brand = sb, assistants = LEVERS$assistants$value[sb], skill = LEVERS$skill$value[sb],
                    cashiers = LEVERS$cashiers$value[sb], scan_s = LEVERS$scan_s$value[sb], stores = sum(STORES$brand == sb)),
       filter = list(brand = brand, area = area, store = store))
}

# Shoppers at each stage right now (for the dots in the funnel's circles):
# on the way to a store, browsing, carrying items, at the fitting rooms, at
# the tills, and paid today.
live_stages <- function(stores, bins) {
  t <- clock
  sel <- d$store %in% stores & d$bin %in% bins
  on_way <- sum(sel & d$arrive > t & d$arrive - d$travel <= t)
  m <- legs$m[seq_len(legs$n), , drop = FALSE]
  m <- m[m[, "t0"] <= t & m[, "t1"] > t, , drop = FALSE]
  m <- m[sel[m[, "visit"]], , drop = FALSE]
  look <- m[, "look"]; kind <- m[, "kind"]
  c(on_way = on_way,
    browsing = sum(look == 1 & kind %in% c(WALK, BROWSE)),
    carrying = sum(look == 2 & kind %in% c(WALK, BROWSE)),
    fitting = sum(kind %in% c(WAIT_FR, TRY)),
    paying = sum(kind %in% c(WAIT_TILL, PAY)),
    paid = sum(sel & d$outcome == 1L))
}

# ---- Store ---------------------------------------------------------------------------------

report_store <- function(s, heat = FALSE) {
  s <- min(max(1L, s), N_STORES)
  rd <- report_day(); dv <- rd$d; t <- rd$t
  here <- dv$store == s & dv$arrive <= t
  ended <- here & dv$outcome > 0
  o <- tabulate(dv$outcome[ended], N_OUTCOMES)
  paid <- ended & dv$outcome == 1L
  m <- rd$legs$m[seq_len(rd$legs$n), , drop = FALSE]
  m <- m[m[, "store"] == s & m[, "t0"] <= t, , drop = FALSE]
  dur <- pmin(m[, "t1"], t) - m[, "t0"]
  waits <- function(k) { w <- m[, "kind"] == k; if (any(w)) mean(dur[w]) else NA }
  hours <- seq_len(DAY_S / 3600)
  busy_by_hour <- function(k, servers) {
    w <- m[, "kind"] == k
    vapply(hours, function(h) {
      a <- pmax(m[w, "t0"], (h - 1) * 3600); b <- pmin(m[w, "t1"], h * 3600, t)
      sum(pmax(0, b - a)) / max(1e-9, servers * 3600)
    }, 0)
  }
  sm <- rd$staff$m[seq_len(rd$staff$n), , drop = FALSE]; sm <- sm[sm[, "store"] == s, , drop = FALSE]
  staff_hour <- vapply(hours, function(h) {
    a <- pmax(sm[, "t0"], (h - 1) * 3600); b <- pmin(sm[, "t1"], h * 3600, t)
    sum(pmax(0, b - a)) / max(1e-9, S$assistants[s] * 3600)
  }, 0)
  f <- STORES$format[s]
  dd <- days_so_far()
  season <- if (length(dd)) list(
    traffic = I(apply(tally$visits[dd, , s, , drop = FALSE], 1, sum)),
    paid = I(apply(tally$visits[dd, , s, 1, drop = FALSE], 1, sum)),
    sales = I(apply(tally$sales[dd, , s, drop = FALSE], 1, sum)),
    walkouts = I(apply(tally$visits[dd, , s, c(5, 7), drop = FALSE], 1, sum)),
    stock = matrix(tally$stock[dd, s, ], length(dd))) else NULL
  live_now <- rd$live
  fa <- if (live_now) floor_agents(s, clock) else NULL
  list(
    id = s, name = STORES$name[s], brand = STORES$brand[s],
    area = if (STORES$area[s] > 0) AREAS$name[STORES$area[s]] else "Outside every area",
    format = FORMATS[f], layout = LAYOUT_NAMES[f], day_label = rd$label, live = live_now,
    kpi = list(traffic = sum(here), inside = if (live_now) fa$in_store else 0, receipts = sum(paid),
               conversion = if (sum(ended)) sum(paid) / sum(ended) else NA,
               sales = sum(dv$sales[paid]), avg_receipt = if (sum(paid)) mean(dv$sales[paid]) else NA,
               units_per_receipt = if (sum(paid)) mean(dv$units[paid]) else NA,
               fr_wait = waits(WAIT_FR), till_wait = waits(WAIT_TILL),
               lost_fr = o[5], lost_till = o[7], not_in_size = o[4],
               staff_cost = (S$cashiers[s] * WAGE[["cashier"]] + S$assistants[s] * WAGE[["assistant"]]) * min(t, DAY_S) / 3600),
    outcomes = o,
    flow = list(entered = sum(here), browsing = if (live_now) sum(fa$look %in% 1:2) else 0,
                to_fr = sum(here & (dv$tried | dv$outcome == 5L)), to_till = o[1] + o[7],
                left_floor = sum(o[2:4]), left_fr = o[6],
                fr_busy = if (live_now) sum(fa$cub_busy > 0) else 0, fr_open = S$fitting_rooms[s], fr_queue = if (live_now) fa$fr_q else 0,
                till_busy = if (live_now) sum(fa$staff_busy[fa$staff_role == 1]) else 0, till_open = S$cashiers[s],
                till_queue = if (live_now) fa$till_q else 0,
                fr_util = mean(busy_by_hour(TRY, S$fitting_rooms[s])[hours * 3600 <= max(3600, min(t, DAY_S)) + 3599]),
                till_util = mean(busy_by_hour(PAY, S$cashiers[s])[hours * 3600 <= max(3600, min(t, DAY_S)) + 3599]),
                paid = o[1], left = sum(o[-1]), lost_fr = o[5], lost_till = o[7]),
    queues = list(fr = rd$today$fr_q[s, ], till = rd$today$till_q[s, ]),
    util = list(fitting = busy_by_hour(TRY, S$fitting_rooms[s]), tills = busy_by_hour(PAY, S$cashiers[s]),
                assistants = if (S$assistants[s] > 0) staff_hour else NULL),
    sales_by_hour = bin_sum(pmin(10L, as.integer(dv$outcome_at[paid] %/% 3600) + 1L), dv$sales[paid], 10),
    season = season,
    follow = visit_story(s, rd),
    inspect = inspector_panel(s, rd),
    heat = if (heat) heat_cells(s) else NULL
  )
}

sku_text <- function(k, b) sprintf("%s in %s", PROD_NAME[b, product_of(k)], SIZES[size_of(k)])

# The story of one visit, from the visit log, for "follow a shopper": each
# event's line (events.R).
visit_story <- function(s, rd) {
  v <- selected$visit
  if (is.na(v) || !identical(selected$visit_day, rd$day) || v > rd$d$v || rd$d$store[v] != s) return(NULL)
  L <- visit_log(v, rd)
  dv <- rd$d; b <- dv$brand[v]
  lines <- event_lines(L, b)
  h <- dv$hh[v]
  list(visit = v, household = h, segment = SEGMENTS$name[dv$seg[v]], size = SIZES[dv$size[v]],
       area = if (dv$area[v] > 0) AREAS$name[dv$area[v]] else "outside every area", budget = dv$budget[v],
       travel_min = dv$travel[v] / 60, arrive = clock_hm(dv$arrive[v]),
       promotions = I(visit_promotions(v, rd)), coupon = dv$coupon[v],
       coupon_from = if (dv$coupon_from[v] > 0) sprintf("%s's %s", BRANDS$name[OFFERS$brand[dv$coupon_from[v]]], OFFERS$name[dv$coupon_from[v]]) else NULL,
       basket = lapply(which(dv$basket[v, ] > 0), function(j) list(item = sku_text(dv$basket[v, j], b), price = dv$paid_for[v, j])),
       done = dv$outcome[v] > 0 && dv$gone[v] <= rd$t,
       log = lapply(seq_len(nrow(L)), function(i) list(t = clock_hm(L[i, 2]), text = lines[[i]])))
}

# The promotions that reached a visit (that day's, of its brand).
visit_promotions <- function(v, rd) {
  k <- rd$d$promos[rd$d$reached[v, ]]
  k <- k[cal$pr$brand[k] == rd$d$brand[v]]
  sprintf("%s (%.0f%% off)", cal$pr$name[k], 100 * cal$pr$depth[k])
}

visit_log <- function(v, rd) {
  L <- rd$vlog$m[seq_len(rd$vlog$n), , drop = FALSE]
  L <- L[L[, 1] == v & L[, 2] <= rd$t, , drop = FALSE]
  L[order(L[, 2]), , drop = FALSE]
}

# ---- The inspector: inside a head, on the store floor ----------------------------------------

inspector_panel <- function(s, rd) {
  sel <- selected$inspect
  if (is.null(sel) || sel$store != s || !identical(sel$day, rd$day)) return(NULL)
  if (sel$kind == "shopper") {
    if (sel$visit > rd$d$v || rd$d$store[sel$visit] != s) return(NULL)
    return(shopper_head(s, sel$visit, rd))
  }
  worker_panel(s, sel$kind, sel$server, rd)
}

# Where an anchor of store s is, in words.
anchor_text <- function(s, a) {
  f <- STORES$format[s]; p <- fl$plans[[f]]; k <- a - fl$off[f]
  zone <- findInterval(k, p$zone_first)
  if (k < p$entrance) return(sprintf("at the %s racks", CATEGORIES[zone]))
  if (k %in% p$doors) return("at the door")
  if (k %in% p$stock) return("at the stockroom door")
  if (k == p$fr_head) return("at the fitting rooms")
  if (k == p$till_head) return("at the tills")
  if (k %in% p$cubicle) return(sprintf("in fitting room %d", match(k, p$cubicle)))
  sprintf("at till %d", match(k, p$till))
}

# A shopper: what they're doing and where, their basket, the racks still on
# their list, their patience in a queue, why they came, their tier with the
# brand, any offer they hold, and their visit in the first person.
shopper_head <- function(s, v, rd) {
  dv <- rd$d; t <- rd$t; h <- dv$hh[v]; seg <- dv$seg[v]
  m <- rd$legs$m[seq_len(rd$legs$n), , drop = FALSE]
  mine <- m[m[, "visit"] == v, , drop = FALSE]
  cur <- mine[mine[, "t0"] <= t & mine[, "t1"] > t, , drop = FALSE]
  gone <- dv$gone[v] <= t
  queue <- NULL
  if (gone) now <- sprintf("Left at %s: %s", clock_hm(dv$gone[v]), OUTCOMES[dv$outcome[v]])
  else if (dv$arrive[v] > t) now <- sprintf("On the way, arriving at %s", clock_hm(dv$arrive[v]))
  else if (!nrow(cur)) now <- "Just arrived"
  else {
    k <- cur[1, "kind"]; a <- cur[1, "a"]; b <- cur[1, "b"]
    now <- switch(as.character(k),
      "1" = sprintf("Walking %s", sub("^at ", "to ", sub("^in ", "to ", anchor_text(s, b)))),
      "2" = sprintf("Browsing %s", anchor_text(s, a)),
      "3" = , "4" = {
        same <- m[m[, "store"] == s & m[, "kind"] == k & m[, "t0"] <= t & m[, "t1"] > t, , drop = FALSE]
        place <- sum(same[, "t0"] < cur[1, "t0"]) + 1L
        waited <- t - cur[1, "t0"]
        queue <- list(place = place, waited = waited, patience = SEGMENTS$patience[seg],
                      max_ahead = min(SEGMENTS$max_ahead[seg], if (k == WAIT_FR) S$max_fr_q[s] else S$max_till_q[s]))
        sprintf("In the %s queue, %s, waited %s of their %s", if (k == WAIT_FR) "fitting-room" else "till", ordinal(place),
                mins_text(waited), mins_text(SEGMENTS$patience[seg]))
      },
      "5" = sprintf("Trying on %s", anchor_text(s, a)),
      "6" = sprintf("Paying %s", anchor_text(s, a)),
      "")
  }
  # Why they came here: the two biggest reasons from their appeal for this
  # store today (their household's card on the Market tab shows it all).
  ap <- appeal_parts(h)
  parts <- ap$parts[s, ]
  top <- names(sort(parts[parts > 0], decreasing = TRUE))[seq_len(min(2, sum(parts > 0)))]
  br <- dv$brand[v]
  left <- if (dv$n_zones[v] > dv$zi[v]) dv$zone[v, (dv$zi[v] + 1L):dv$n_zones[v]] else integer()
  L <- visit_log(v, rd)
  list(
    kind = "shopper", visit = v, household = h, title = sprintf("Shopper · visit #%d", v),
    who = sprintf("%s, size %s, from %s", SEGMENTS$name[seg], SIZES[dv$size[v]],
                  if (dv$area[v] > 0) AREAS$name[dv$area[v]] else "outside every area"),
    now = now, queue = queue,
    in_store_s = if (dv$arrive[v] <= t) min(t, dv$gone[v]) - dv$arrive[v] else 0,
    basket = lapply(which(dv$basket[v, ] > 0), function(j) list(item = sku_text(dv$basket[v, j], br), price = dv$paid_for[v, j])),
    racks_left = I(CATEGORIES[left]),
    reasons = I(unname(APPEAL_LABELS[top])),
    tier = tier_outlook(h, br), brand = BRANDS$name[br],
    offers = lapply(offers_held(h), function(k) list(brand = BRANDS$name[OFFERS$brand[k]], name = OFFERS$name[k], depth = OFFERS$depth[k],
                                                     until = OFFERS$to[k], good_here = OFFER_GOOD[k, br])),
    promotions = I(visit_promotions(v, rd)),
    budget_left = dv$budget[v] - dv$spent[v], budget = dv$budget[v],
    thoughts = event_thoughts(L, br)
  )
}

ordinal <- function(k) paste0(k, if (k %% 100 %in% 11:13) "th" else c("st", "nd", "rd", rep("th", 7))[(k %% 10) + (k %% 10 == 0) * 10])
# A worker: a cashier serves at their till, an assistant fetches sizes and
# advises. What they're doing now, and their day so far.
worker_panel <- function(s, kind, k, rd) {
  dv <- rd$d; t <- rd$t
  f <- STORES$format[s]
  span <- max(1, min(t, DAY_S))
  if (kind == "cashier") {
    if (k > fl$n_tills[f]) return(NULL)
    m <- rd$legs$m[seq_len(rd$legs$n), , drop = FALSE]
    till <- fl$till_first[f] + k - 1L
    mine <- m[m[, "store"] == s & m[, "kind"] == PAY & m[, "a"] == till & m[, "t0"] <= t, , drop = FALSE]
    cur <- mine[mine[, "t1"] > t, , drop = FALSE]
    waiting <- sum(m[, "store"] == s & m[, "kind"] == WAIT_TILL & m[, "t0"] <= t & m[, "t1"] > t)
    busy <- sum(pmin(mine[, "t1"], t) - mine[, "t0"])
    return(list(kind = "cashier", server = k, title = sprintf("Cashier %d, %s", k, STORES$name[s]), till = k, open = k <= S$cashiers[s],
                now = if (nrow(cur)) sprintf("Serving visit #%d: %d item%s, done at %s", cur[1, "visit"], dv$units[cur[1, "visit"]],
                                             if (dv$units[cur[1, "visit"]] == 1) "" else "s", clock_hm(cur[1, "t1"])) else "Waiting for a customer",
                serving = if (nrow(cur)) cur[1, "visit"] else NULL, queue = waiting,
                served = nrow(mine), items = sum(dv$units[mine[, "visit"]]), busy = busy / span))
  }
  if (k > S$assistants[s]) return(NULL)
  sm <- rd$staff$m[seq_len(rd$staff$n), , drop = FALSE]
  mine <- sm[sm[, "store"] == s & sm[, "server"] == k & sm[, "t0"] <= t, , drop = FALSE]
  cur <- mine[mine[, "t1"] > t, , drop = FALSE]
  busy <- sum(pmin(mine[, "t1"], t) - mine[, "t0"])
  list(kind = "assistant", server = k, title = sprintf("Assistant %d, %s", k, STORES$name[s]),
       now = if (nrow(cur)) sprintf("%s visit #%d %s", if (cur[1, "job"] == JOB_FETCH) "Fetching a size from the stockroom for" else "Advising",
                                    cur[1, "visit"], anchor_text(s, cur[1, "anchor"])) else "Waiting on the floor for a shopper to help",
       helping = if (nrow(cur)) cur[1, "visit"] else NULL,
       fetched = sum(mine[, "job"] == JOB_FETCH), advised = sum(mine[, "job"] == JOB_ADVISE), busy = busy / span)
}

# ---- Assortment ------------------------------------------------------------------------------

report_assortment <- function(b) {
  b <- min(max(1L, b), N_BRANDS)
  rows <- which(STORES$brand == b)
  ok <- which(PROD_OK[b, ])
  sold <- prod_totals(stock$sold)[b, ]
  bought <- prod_totals(stock$bought, TRUE)[b, ]
  missed <- prod_totals(stock$missed)[b, ]
  left <- product_left()                                   # in the stores and on the way, and at the DC
  in_tr <- as.vector(tapply(colSums(in_transit()[rows, , drop = FALSE]), sku_prod(), sum))
  in_stores <- left$stores[b, ] - in_tr
  at_dc <- left$dc[b, ]
  recent <- as.vector(tapply(colSums(stock$demand[rows, , drop = FALSE]), sku_prod(), sum))
  md <- markdown[b, ]
  state <- PRODUCT_STATES[product_states(left)[b, ]]
  full <- cat_price[b, ]
  products <- lapply(ok, function(k) list(
    id = k, name = PROD_NAME[b, k], category = PROD_CAT[b, k], day = PROD_DAY[b, k],
    full_price = full[k], price = full[k] * (1 - md[k]), markdown = md[k], cost = PROD_COST[b, k],
    bought = bought[k], sold = sold[k], in_stores = in_stores[k], at_dc = at_dc[k],
    sell_through = sold[k] / max(1, bought[k]), lost = missed[k],
    cover = if (recent[k] > 0) (left$stores[b, k] + at_dc[k]) / recent[k] else NA, state = state[k],
    revenue = sold[k] * full[k]))
  # Size availability: the share of the brand's stores with at least one of
  # the size on the floor, in some product of the category that's in the stores.
  cats <- which(CARRIES[b, ])
  cat_sku <- PROD_CAT[b, sku_prod()]; live <- launched[b, sku_prod()]
  avail <- t(vapply(cats, function(c) vapply(seq_len(N_SIZES), function(z) {
    sk <- which(cat_sku == c & size_of(seq_len(N_SKU)) == z & live)
    mean(rowSums(stock$rack[rows, sk, drop = FALSE]) > 0)
  }, 0), numeric(N_SIZES)))
  dd <- days_so_far()
  fill <- if (length(dd)) rowSums(tally$size_fill[dd, rows, drop = FALSE]) / pmax(1, rowSums(tally$size_req[dd, rows, drop = FALSE])) else numeric()
  list(brand = b, week = week_of(max(1L, day)), day = day, products = products, categories = CATEGORIES, category_colours = CATEGORY_COLOURS,
       sells = I(cats), sizes = SIZES, states = PRODUCT_STATES, counts = as.list(table(factor(state[ok], PRODUCT_STATES))),
       availability = matrix(avail, length(cats)), fill = I(fill),
       totals = list(bought = sum(bought), sold = sum(sold), in_stores = sum(in_stores), at_dc = sum(at_dc),
                     in_transit = sum(in_tr), lost = sum(missed)),
       calendar = calendar_strip(b))
}

# What a calendar entry of brand b is on (cover: a logical over its
# products), in words: the whole range, or its categories and products.
promo_on_text <- function(b, cover) {
  ok <- PROD_OK[b, ]
  if (all(cover[ok])) return("the whole range")
  cats <- which(CARRIES[b, ])
  whole <- cats[vapply(cats, function(c) all(cover[ok & PROD_CAT[b, ] == c]), TRUE)]
  rest <- which(cover & ok & !(PROD_CAT[b, ] %in% whole))
  paste(c(CATEGORIES[whole], PROD_NAME[b, rest]), collapse = ", ")
}

# Who promotion k of brand b reaches, in words: its tiers, and its areas.
promo_reach_text <- function(b, k) {
  t <- cal$pr
  tiers <- t$tiers[k, seq_len(TIER_N[b])]
  who <- if (all(tiers)) "every tier" else paste(TIER_NAMES[[b]][tiers], collapse = ", ")
  bins <- t$bins[k, ]
  where <- if (all(bins)) "everywhere" else paste(c(AREAS$name, "outside every area")[bins], collapse = ", ")
  paste(who, where, sep = ", ")
}

# Brand b's calendar as it has run so far and is planned: its promotions;
# its markdowns and its replenishment, each entry with the days it acts
# and, for the days gone, what it did (a markdown: how many products it
# took, and why it left the others; an order: the units ordered and the day
# they arrive); and the days its products land.
calendar_strip <- function(b) {
  t <- cal$pr
  on_text <- function(cover) promo_on_text(b, cover)
  reach_text <- function(k) promo_reach_text(b, k)
  mine <- which(t$brand == b & t$from <= t$to)
  mds <- which(vapply(CAL_PLAN$markdowns, function(x) x$brand == b, TRUE))
  reps <- which(vapply(CAL_PLAN$replenishment, function(x) x$brand == b, TRUE))
  tk <- cal$taken; od <- cal$orders
  lands <- sort(unique(PROD_DAY[b, PROD_OK[b, ]]))
  list(days = SEASON_DAYS, today = day,
       promotions = lapply(mine, function(k) list(name = t$name[k], from = t$from[k], to = t$to[k], depth = t$depth[k],
                                                   source = t$source[k], on = on_text(t$cover[k, ]), reach = reach_text(k))),
       markdowns = lapply(mds, function(k) {
         x <- CAL_PLAN$markdowns[[k]]; r <- which(tk$entry == k)
         list(id = x$id, name = x$name, from = x$from, to = x$to, days = I(which(x$acts)), which = x$which, mode = x$mode,
              depth = x$depth, max = x$max, on = on_text(x$cover),
              done = lapply(r, function(i) list(day = tk$day[i], took = tk$took[i], deeper = tk$deeper[i], on_plan = tk$on_plan[i],
                                                too_new = tk$too_new[i], rested = tk$rested[i], not_in = tk$not_in[i])))
       }),
       replenishment = lapply(reps, function(k) {
         x <- CAL_PLAN$replenishment[[k]]; r <- which(od$entry == k)
         list(id = x$id, name = x$name, from = x$from, to = x$to, days = I(which(x$acts)), rule = x$rule, on = on_text(x$cover),
              done = lapply(r, function(i) list(day = od$day[i], units = od$units[i], arrive = od$arrive[i])))
       }),
       lands = lapply(lands, function(dd) list(day = dd, names = I(PROD_NAME[b, PROD_OK[b, ] & PROD_DAY[b, ] == dd]))))
}

# ---- Scorecard ---------------------------------------------------------------------------------

report_scorecard <- function() {
  dd <- days_so_far()
  o <- if (length(dd)) apply(tally$visits[dd, , , , drop = FALSE], 4, sum) else numeric(N_OUTCOMES)
  ds <- tally$dwell_stats[dd, , drop = FALSE]
  s <- c(n = sum(ds[, "n"]), sum = sum(ds[, "sum"]), sumsq = sum(ds[, "sumsq"]), min = min(Inf, ds[, "min"]), max = max(-Inf, ds[, "max"]))
  dw <- if (length(dd)) colSums(tally$dwell[dd, , , drop = FALSE]) else matrix(0, 2, 46)
  mean_m <- if (s[["n"]]) s[["sum"]] / s[["n"]] else NA
  sd_m <- if (s[["n"]] > 1) sqrt(max(0, (s[["sumsq"]] - s[["n"]] * mean_m^2) / (s[["n"]] - 1))) else NA
  util_role <- function(k, rows = seq_len(N_STORES)) I(if (length(dd)) rowMeans(tally$util[dd, rows, k, drop = FALSE], na.rm = TRUE) else numeric())
  ours <- which(OURS_B[STORES$brand])
  fill_all <- if (length(dd)) rowSums(tally$size_fill[dd, , drop = FALSE]) / pmax(1, rowSums(tally$size_req[dd, , drop = FALSE])) else numeric()
  fill_ours <- if (length(dd)) rowSums(tally$size_fill[dd, ours, drop = FALSE]) / pmax(1, rowSums(tally$size_req[dd, ours, drop = FALSE])) else numeric()
  list(outcomes = o, outcome_names = OUTCOMES,
       dwell = list(bought = dw[1, ], not = dw[2, ], bin_min = 2,
                    n = s[["n"]], mean = mean_m, min = if (is.finite(s[["min"]])) s[["min"]] else NA,
                    max = if (is.finite(s[["max"]])) s[["max"]] else NA, sd = sd_m),
       util = list(all = list(fitting = util_role(1), tills = util_role(2), assistants = util_role(3)),
                   ours = list(fitting = util_role(1, ours), tills = util_role(2, ours), assistants = util_role(3, ours))),
       fill = list(all = I(fill_all), ours = I(fill_ours)),
       contribution = contribution(dd))
}

# ---- Export ----------------------------------------------------------------------------------

# The season's daily results, one row per finished day and brand.
export_csv <- function() {
  dd <- seq_len(days_complete())
  if (!length(dd)) return("day,week,brand\n")
  rows <- expand.grid(brand = seq_len(N_BRANDS), day = dd)
  sb <- function(what) { x <- brand_days(what, dd); x[cbind(match(rows$day, dd), rows$brand)] }
  visits <- apply(tally$visits[dd, , , , drop = FALSE], c(1, 3), sum)
  paid <- apply(tally$visits[dd, , , 1, drop = FALSE], c(1, 3), sum)
  if (length(dd) == 1) { visits <- matrix(visits, 1); paid <- matrix(paid, 1) }
  vb <- t(rowsum(t(visits), STORES$brand, reorder = TRUE)); pb <- t(rowsum(t(paid), STORES$brand, reorder = TRUE))
  staff <- t(rowsum(t(tally$staff_cost[dd, , drop = FALSE]), STORES$brand, reorder = TRUE))
  logistics <- t(rowsum(t(tally$logistics[dd, , drop = FALSE]), STORES$brand, reorder = TRUE))
  i <- cbind(match(rows$day, dd), rows$brand)
  out <- data.frame(day = rows$day, week = week_of(rows$day), weekday = DAYS[dow_of(rows$day)],
                    brand = BRANDS$name[rows$brand], family = FAMILIES$name[BRANDS$family[rows$brand]],
                    visits = vb[i], receipts = pb[i],
                    sales = round(sb("sales"), 2), full_price_value = round(sb("full"), 2), units = sb("units"),
                    cost_of_goods = round(sb("cogs"), 2), staff_cost = round(staff[i], 2),
                    marketing = round(tally$ad_cost[i], 2), offers = round(tally$offer_cost[i], 2),
                    logistics = round(logistics[i], 2))
  csv_field <- function(x) { x <- trimws(as.character(x)); ifelse(grepl("[,\"]", x), paste0("\"", gsub("\"", "\"\"", x), "\""), x) }
  paste(c(paste(names(out), collapse = ","), apply(out, 1, function(r) paste(csv_field(r), collapse = ","))), collapse = "\n")
}
