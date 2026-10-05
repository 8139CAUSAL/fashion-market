# What each tab shows, built from the tallies (tally.R), the ledger
# (returns.R) and today's visits. Sent to the page as JSON a few times a
# second, for the visible tab only, after tally_live() has brought today's
# row up to the clock. Nothing here changes the simulation or draws random
# numbers. Series by day go through I() so a one-day season is still a
# list in JSON. "Ours" is our family of brands, set against every other
# brand.
#
# Gross and net. Sales are rung up gross; a refund is booked on the day of
# the return, against the store or online store that made the sale. Sales,
# revenue, share and spend are net of refunds unless they say "gross",
# with gross sales and refunds beside them where they matter. The Offers
# tab alone counts a return against the purchase it reverses (offers.R).

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

# A tally by day, area and outlet (sales, units, ...), or by day and
# outlet (refunds, ...), or by day and store: day x brand. A brand with no
# stores, or no online store, has zeros there.
brand_days <- function(what, dd = days_so_far()) {
  if (!length(dd)) return(matrix(0, 0, N_BRANDS))
  x <- tally[[what]]
  x <- if (length(dim(x)) == 3L) apply(x[dd, , , drop = FALSE], c(1, 3), sum) else x[dd, , drop = FALSE]   # day x outlet (or store)
  if (length(dd) == 1) x <- matrix(x, 1)
  x %*% (outer(OUTLET_BRAND[seq_len(dim(x)[2L])], seq_len(N_BRANDS), "==") * 1)
}

# Net sales by day and brand: gross sales less the day's refunds; `online`
# TRUE or FALSE for one channel.
net_days <- function(dd = days_so_far(), online = NA) {
  if (!length(dd)) return(matrix(0, 0, N_BRANDS))
  keep <- if (is.na(online)) rep(TRUE, N_OUTLETS) else OUTLET_ONLINE == online
  x <- apply(tally$sales[dd, , , drop = FALSE], c(1, 3), sum) - tally$refunds[dd, , drop = FALSE]
  if (length(dd) == 1) x <- matrix(x, 1)
  x %*% (outer(OUTLET_BRAND, seq_len(N_BRANDS), "==") * keep)
}

# A tally by day and outlet (or store), over days dd: by outlet.
day_sum <- function(what, dd = days_so_far()) {
  x <- tally[[what]]
  if (!length(dd)) return(numeric(dim(x)[2L]))
  colSums(x[dd, , drop = FALSE])
}

ours_mean <- function(v) if (any(OURS_B)) mean(v[OURS_B]) else NA
rivals_mean <- function(v) if (any(!OURS_B)) mean(v[!OURS_B]) else NA

# ---- Header ---------------------------------------------------------------------------

report_header <- function() {
  dd <- days_so_far()
  net <- colSums(net_days(dd))
  v <- if (length(dd)) tally$visits[dd, , , , drop = FALSE] else array(0, c(1, 1, N_OUTLETS, N_OUTCOMES))
  ours <- OURS_B[OUTLET_BRAND]
  entered <- sum(v[, , ours, ]); paid <- sum(v[, , ours, 1])
  list(day = day, week = week_of(day), dow = DAYS[dow_of(day)], clock = clock_hm(min(clock, DAY_S)),
       clock_s = clock, pace = P$pace, watch_speed = P$watch_speed, season_over = season_over,
       season_days = SEASON_DAYS, season_weeks = SEASON_WEEKS, days_done = days_complete(), world_version = world_version,
       share = if (sum(net)) sum(net[OURS_B]) / sum(net) else NA, sales = sum(net[OURS_B]),      # net of refunds
       conversion = if (entered) paid / entered else NA,                                           # shopping visits, in our stores and online
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
                     categories = MAX_CATEGORIES, products = MAX_PRODUCTS, offers = MAX_OFFERS,
                     demand_events = MAX_DEMAND_EVENTS),
       wages = as.list(WAGE), return_reasons = RETURN_REASONS, line_states = LINE_STATES)
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
  arrived <- rd$d$arrive <= rd$t & !rd$d$ret
  visits_day <- tabulate(rd$d$store[arrived], N_STORES)
  inside <- tabulate(rd$d$store[rd$d$arrive <= clock & rd$d$gone > clock], N_STORES)
  net_outlet <- store_sum("sales", dd) - day_sum("refunds", dd)
  running <- cal$pr$brand[today_promos$k]
  bd <- net_days(dd)
  online <- colSums(net_days(dd, TRUE))
  gross <- colSums(brand_days("sales", dd)); refunds <- colSums(brand_days("refunds", dd))
  pos <- price_position()
  weeks <- if (length(dd)) week_of(dd) else integer()
  list(
    day_label = rd$label,
    stores = lapply(seq_len(N_STORES), function(s) list(
      id = s, visits = visits_day[s], inside = inside[s], sales = net_outlet[s],
      promo = STORES$brand[s] %in% running)),
    brands = lapply(seq_len(N_BRANDS), function(b) list(
      name = BRANDS$name[b], colour = BRANDS$colour[b], family = BRANDS$family[b], ours = OURS_B[b],
      price = pos[b], ad = LEVERS$ad$value[b],
      cashiers = LEVERS$cashiers$value[b], assistants = LEVERS$assistants$value[b],
      on_today = lapply(today_promos$k[running == b], function(k) list(name = cal$pr$name[k], depth = cal$pr$depth[k], to = cal$pr$to[k],
                                                                       on = promo_on_text(b, cal$pr$cover[k, ]), reach = promo_reach_text(b, k))),
      stores = sum(STORES$brand == b), online = ONLINE$on[b])),
    customers = last_row("customers", dd) %||% tabulate(mk$last_brand + 1L, N_BRANDS + 1L),
    sales_share = if (length(dd)) round(pmax(bd, 0) / pmax(rowSums(pmax(bd, 0)), 1), 4) else list(),
    revenue = I(colSums(bd)), revenue_online = I(online), gross = I(gross), refunds = I(refunds),
    weekly = if (length(dd)) lapply(sort(unique(weeks)), function(w) colSums(bd[weeks == w, , drop = FALSE])) else list(),
    areas = lapply(seq_len(N_AREAS), function(k) {
      here <- mk$hh$area == k
      list(name = AREAS$name[k], households = sum(here), customers = tabulate(mk$last_brand[here] + 1L, N_BRANDS + 1L))
    }),
    shopper = shopper_panel(selected$household)
  )
}

# The parts of a household's appeal for each store today (without the day's
# random taste), and for each online store: what the Market tab's household
# card and the inspector show. Stores out of its reach are NA; a brand
# without an online store has none (online_parts rows for ONLINE$on only).
appeal_parts <- function(h) {
  hh <- mk$hh
  seg <- hh$segment[h]
  s <- seq_len(N_STORES); b <- STORES$brand
  pr <- promo_heard(promo_reach(h))
  cover <- window_cover()
  buzz <- buzz_of(h)[1, ]
  parts_of <- function(b, price, trip, place, pull) {
    tier <- mk$tier[h, b]; bt <- cbind(b, tier)
    cbind(
      taste = P$taste_w * hh$taste[h, b],
      range = range_value(rep(seg, length(b)), b),
      loyalty = TIER_PULL[bt],
      price = -P$price_w * SEGMENTS$price[seg] * TIER_PRICE[bt] * log(price),
      promotion = PROMO_W * SEGMENTS$promo[seg] * pr$heard[1, b] + AD_W * LEVERS$ad$value[b],
      distance = trip,
      memory = -P$grudge_w * TIER_MEMORY[bt] * mk$grudge[h, b],
      word_of_mouth = P$wom * buzz[b],
      store = place,
      offers = mk$at$util[h, b],
      returns = pull * cover[b])
  }
  price <- price_position()[b] * (1 - pr$off[1, b]) * (1 - mk$at$coupon[h, b])
  parts <- parts_of(b, price, -P$km_w * SEGMENTS$km[seg] * mk$km[h, s], FORMAT_APPEAL[STORES$format], RETURN_PULL[["store"]])
  reach <- mk$km[h, s] <= SEGMENTS$radius_km[seg] * TIER_RADIUS[cbind(b, mk$tier[h, b])]
  bo <- which(ONLINE$on)
  online <- NULL
  if (length(bo)) {
    price_o <- price_position()[bo] * (1 - pr$off[1, bo]) * (1 - mk$at$coupon[h, bo]) * (1 + delivery_share()[bo])
    online <- parts_of(bo, price_o, numeric(length(bo)), SEGMENTS$online[seg] - DELIVERY_W * ONLINE$delivery_days[bo], RETURN_PULL[["online"]])
  }
  list(parts = parts, appeal = ifelse(reach, rowSums(parts), NA), reach = reach,
       online_brands = bo, online = online, online_appeal = if (length(bo)) rowSums(online) else numeric())
}
APPEAL_LABELS <- c(taste = "their own taste for the brand", range = "what the brand sells", loyalty = "their loyalty to the brand", price = "the prices",
                   promotion = "promotions and marketing", distance = "the trip", memory = "bad visits they remember",
                   word_of_mouth = "word of mouth", store = "the store itself", offers = "an offer they hold", returns = "the return window")

# One household, as the Market tab's card shows it: its appeal for each
# brand's best choice today (its best store in reach, or its online store),
# the favourite and how far ahead it is, its tier with each brand, the
# stores in its reach, offers it holds, its visits, and its ledger: what it
# bought, paid and returned (returns.R). A brand selling nothing its
# segment likes isn't a choice, in reach or not.
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
  vo <- rep(NA_real_, N_BRANDS)
  if (length(a$online_brands)) vo[a$online_brands] <- ifelse(is.finite(a$online[, "range"]), a$online_appeal, NA)
  online_best <- !is.na(vo) & (is.na(vb) | vo > vb)
  v <- ifelse(online_best, vo, vb)
  o <- order(-v, na.last = NA)
  L <- vlog_season_rows(h)
  visit_outcome <- function(i) if (L[i, 4] == OUT_RETURNED) TRIP_OUTCOME else if (L[i, 3] == 0) ONLINE_OUTCOMES[L[i, 4]] else OUTCOMES[L[i, 4]]
  list(
    id = h, area = if (hh$area[h] > 0) AREAS$name[hh$area[h]] else "Outside every area",
    segment = SEGMENTS$name[hh$segment[h]], size = SIZES[hh$size[h]],
    budget = hh$budget[h], budget_left = mk$budget_left[h], x = hh$x[h], y = hh$y[h],
    last_brand = mk$last_brand[h], outside = P$outside, radius_km = SEGMENTS$radius_km[hh$segment[h]],
    brands = lapply(seq_len(N_BRANDS), function(k) {
      t <- tier_outlook(h, k)
      j <- match(k, a$online_brands)
      base <- list(brand = k, tier = t$name, tier_k = t$tier, tiers = TIER_N[k], in_reach = !is.na(v[k]), sells_nothing = !any(likes[b == k]),
                   online = online_best[k])
      if (is.na(v[k])) return(base)
      if (online_best[k]) c(base, list(store_name = "online", appeal = vo[k], km = 0), as.list(a$online[j, ]))
      else c(base, list(store_name = STORES$name[best[k]], appeal = a$appeal[best[k]], km = mk$km[h, best[k]]), as.list(a$parts[best[k], ]))
    }),
    reach = list(n = sum(a$reach), stores = I(STORES$name[a$reach]), online = I(BRANDS$name[a$online_brands])),
    favourite = if (length(o)) o[1] else NA, gap = if (length(o) > 1) v[o[1]] - v[o[2]] else NA,
    offers = lapply(offers_held(h), function(k) list(brand = OFFERS$brand[k], name = OFFERS$name[k], depth = OFFERS$depth[k], until = OFFERS$to[k])),
    visits = lapply(rev(seq_len(nrow(L)))[seq_len(min(8, nrow(L)))], function(i) list(
      day = L[i, 1], store = if (L[i, 3] > 0) STORES$name[L[i, 3]] else sprintf("%s online", BRANDS$name[L[i, 5]]),
      outcome = visit_outcome(i), sales = L[i, 6])),
    ledger = household_ledger(h)
  )
}

# ---- Strategy ------------------------------------------------------------------------------

# `forecast` is the series the forecast is for (forecast.R).
report_strategy <- function(forecast = "ours") {
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
  bd <- net_days(dd)
  ever <- last_row("ever", dd) %||% numeric(N_BRANDS + 1L)
  customers <- ever[seq_len(N_BRANDS)]        # by brand; a household can be a customer of several
  sales <- colSums(bd)
  gross <- colSums(brand_days("sales", dd)); refunds <- colSums(brand_days("refunds", dd))
  online <- colSums(net_days(dd, TRUE))
  units <- colSums(brand_days("units", dd)); returned <- colSums(brand_days("ret_units", dd))
  receipts <- brand_of_stores(store_sum_visits_paid(dd))      # paid visits: receipts in the stores, and online orders
  weeks <- if (length(dd)) week_of(dd) else integer()
  paid_days <- brand_days_paid(dd)
  weekly_receipt <- lapply(sort(unique(weeks)), function(w) {
    s <- colSums(bd[weeks == w, , drop = FALSE]); n <- colSums(paid_days[weeks == w, , drop = FALSE])
    c(ours = sum(s[OURS_B]) / max(1, sum(n[OURS_B])), competitors = sum(s[!OURS_B]) / max(1, sum(n[!OURS_B])))
  })
  budget <- vapply(seq_len(N_SEGMENTS), function(g) sum(mk$hh$budget[mk$hh$segment == g]), 0)
  wallet <- if (length(dd)) colSums(tally$wallet[dd, , , drop = FALSE] - tally$wallet_refunds[dd, , , drop = FALSE]) else matrix(0, N_SEGMENTS, N_BRANDS)
  wallet <- matrix(wallet, N_SEGMENTS)
  list(
    levers = levers,
    share_history = if (length(dd)) tally$share[dd, , drop = FALSE] / pmax(rowSums(tally$share[dd, , drop = FALSE]), 1) else list(),
    revenue = list(ours = sum(sales[OURS_B]), competitors = sum(sales[!OURS_B]), by_brand = I(sales),
                   gross = I(gross), refunds = I(refunds), online = I(online)),
    spend_per_customer = list(by_brand = I(sales / pmax(1, customers))),
    avg_receipt = list(ours = sum(sales[OURS_B]) / max(1, sum(receipts[OURS_B])), competitors = sum(sales[!OURS_B]) / max(1, sum(receipts[!OURS_B]))),
    receipt_history = weekly_receipt,
    online_share = I(ifelse(sales > 0, online / pmax(sales, 1e-9), NA)), has_online = I(ONLINE$on),
    return_rate = I(ifelse(units > 0, returned / pmax(units, 1), NA)), refund_rate = I(ifelse(gross > 0, refunds / pmax(gross, 1e-9), NA)),
    wallet = lapply(seq_len(N_SEGMENTS), function(g) list(segment = SEGMENTS$name[g], budget = budget[g], spend = I(wallet[g, ]))),
    # Households that have bought: from our family (whatever else), or only from competitors.
    customers = list(ours = households_bought_ours(), rivals_only = ever[N_BRANDS + 1L]),
    contribution = contribution(dd),
    forecast = forecast_report(forecast)
  )
}

households_bought_ours <- function() sum(.rowSums(mk$customer[, OURS_B, drop = FALSE], mk$hh$n, sum(OURS_B)) > 0)

# Paid visits (receipts in the stores, and online orders), by outlet.
store_sum_visits_paid <- function(dd) {
  if (!length(dd)) return(numeric(N_OUTLETS))
  colSums(colSums(tally$visits[dd, , , 1, drop = FALSE], dims = 1), dims = 1)
}
brand_days_paid <- function(dd) {
  if (!length(dd)) return(matrix(0, 0, N_BRANDS))
  x <- apply(tally$visits[dd, , , 1, drop = FALSE], c(1, 3), sum)
  if (length(dd) == 1) x <- matrix(x, 1)
  x %*% (outer(OUTLET_BRAND, seq_len(N_BRANDS), "==") * 1)
}

# Each brand's season so far, from full-price value to contribution: the
# full-price value of what was sold, less markdowns and promotions given
# away (gross sales), less refunds (net sales); the cost of goods, net of
# the returns put back in stock, and the returns written off, at cost;
# staff, marketing, offers, logistics (deliveries and units shipped to the
# stores); online, each order's picking and packing and shipping, and the
# delivery charges shoppers paid; return postage; and at the season's end
# the stock left, written down to what it fetches. Until then, the stock
# left is shown at cost. Rent and overheads are left out.
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
  refunds <- by_day("refunds", TRUE); back <- by_day("ret_back_cost", TRUE); lost <- by_day("ret_lost_cost", TRUE)
  ret_units <- by_day("ret_units", TRUE); lost_units <- by_day("ret_lost_units", TRUE)
  fulfilment <- by_day("fulfilment"); shipping <- by_day("shipping"); delivery <- by_day("delivery"); post <- by_day("post_cost")
  orders <- by_day("orders"); parcels <- by_day("post_parcels")
  left <- stock_left_cost()
  lapply(seq_len(N_BRANDS), function(b) list(
    brand = b, full_price = full[b], discounts = full[b] - sales[b], gross = sales[b], refunds = refunds[b], sales = sales[b] - refunds[b],
    cogs = cogs[b] - back[b] - lost[b], written_off = lost[b], returned_units = ret_units[b], written_off_units = lost_units[b],
    staff = staff[b], marketing = ads[b], offers = offers[b], logistics = logistics[b], deliveries = deliveries[b], shipped = shipped[b],
    online = ONLINE$on[b], orders = orders[b], fulfilment = fulfilment[b], shipping = shipping[b], delivery = delivery[b],
    return_post = post[b], parcels = parcels[b],
    writedown = writedown[b], stock_left = left[b], salvage = P_STOCK$salvage[b], written_down = season_done(),
    contribution = sales[b] - refunds[b] - (cogs[b] - back[b]) - staff[b] - ads[b] - offers[b] - logistics[b] -
      fulfilment[b] - shipping[b] + delivery[b] - post[b] - writedown[b]))
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
  back <- returns_by_purchase()
  offers <- lapply(mine, function(i) offer_results(i, rd, detail = i == k, back = back))
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
                  used = total("used"), send_total = total("send_total"), discount = total("discount"), refunds = total("refunds"),
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

# area: 0 every area, k one area, N_AREAS + 1 outside every area. channel:
# "store", the brand's stores (or one store), or "online", its online store
# (the store filter doesn't apply).
report_funnel <- function(brand = 0L, area = 0L, store = 0L, scope = "season", channel = "store") {
  dd <- days_so_far()
  online <- identical(channel, "online")
  brands <- if (brand > 0) brand else seq_len(N_BRANDS)
  outlets <- if (online) N_STORES + brands[ONLINE$on[brands]] else if (store > 0) store else which(STORES$brand %in% brands)
  bins <- if (area > 0) area else seq_len(AREA_BINS)
  rd <- report_day()
  shop <- !rd$d$ret
  if (scope == "day") {
    dv <- rd$d
    arrived <- dv$arrive <= rd$t & shop
    in_s <- dv$outlet %in% outlets & dv$bin %in% bins & arrived
    o <- tabulate(dv$outcome[in_s & dv$outcome > 0], N_OUTCOMES)
    entered <- sum(in_s)
    in_market <- sum(rd$today$in_market[bins]); stayed <- sum(rd$today$stayed_home[bins])
    went_store <- sum(dv$bin %in% bins & arrived & !dv$online); went_online <- sum(dv$bin %in% bins & arrived & dv$online)
  } else {
    v <- if (length(dd)) tally$visits[dd, bins, outlets, , drop = FALSE] else array(0, c(1, 1, 1, N_OUTCOMES))
    o <- apply(v, 4, sum)
    in_market <- sum(tally$in_market[dd, bins]); stayed <- sum(tally$stayed_home[dd, bins])
    by_ch <- function(on) if (length(dd)) sum(tally$visits[dd, bins, OUTLET_ONLINE == on, , drop = FALSE]) else 0
    went_store <- by_ch(FALSE); went_online <- by_ch(TRUE)
    entered <- sum(o)
  }
  # Each stage, and the visits lost at it: each way a visit ends is lost at
  # one stage (events.R). "Past fitting rooms" includes shoppers with
  # nothing to try on, who go straight to the tills. Before the first, a
  # household in the market stayed home, or shopped somewhere else: another
  # store, or online (or, for an online store, a store or another online
  # store).
  stage_names <- if (online) ONLINE_STAGES else FUNNEL_STAGES
  stage_of <- if (online) ONLINE_STAGE else OUTCOME_STAGE
  reasons <- if (online) ONLINE_OUTCOMES else OUTCOMES
  n <- c(in_market, entered, numeric(length(stage_names) - 2L))
  for (k in seq_along(n)[-(1:2)]) n[k] <- n[k - 1L] - sum(o[which(stage_of == k - 1L)])
  first <- if (online) list(list(reason = "stayed home", n = stayed), list(reason = "went to a store", n = went_store),
                            list(reason = "ordered from another brand online", n = max(0, went_online - entered)))
           else list(list(reason = "stayed home", n = stayed), list(reason = "went to another store", n = max(0, went_store - entered)),
                     list(reason = "shopped online", n = went_online))
  stages <- lapply(seq_along(stage_names), function(k) list(name = stage_names[k], n = n[k],
    lost = if (k == 1L) first else lapply(which(stage_of == k), function(i) list(reason = reasons[i], n = o[i]))))
  sb <- if (brand > 0) brand else if (store > 0) STORES$brand[store] else which(OURS_B)[1]
  list(stages = stages, scope = scope, channel = if (online) "online" else "store", day_label = rd$label,
       live = if (online) NULL else live_stages(outlets, bins), returns = funnel_returns(outlets, bins, if (scope == "day") rd$day else dd),
       staff = list(brand = sb, assistants = LEVERS$assistants$value[sb], skill = LEVERS$skill$value[sb],
                    cashiers = LEVERS$cashiers$value[sb], scan_s = LEVERS$scan_s$value[sb], stores = sum(STORES$brand == sb)),
       online_brands = I(which(ONLINE$on)),
       filter = list(brand = brand, area = area, store = store, channel = if (online) "online" else "store"))
}

# After paying: the items bought at `outlets` by households living in
# `bins`, on days `days`, and what has happened to them since: returned
# (by reason), on the way to the shopper, with them and still returnable,
# or kept. Returns come after the visit; they don't change its stages.
funnel_returns <- function(outlets, bins, days) {
  I <- ledger$i
  rows <- which(I[seq_len(ledger$n), "day"] %in% days)
  st <- I[rows, "store"]
  outlet <- ifelse_int(st == 0L, N_STORES + I[rows, "brand"], st)
  L <- ledger_view(rows[outlet %in% outlets & mk$hh$bin[I[rows, "hh"]] %in% bins])
  state <- line_states(L)
  list(items = length(L$hh), value = sum(L$paid), refunds = sum(L$refund),
       returned = lapply(seq_along(RETURN_REASONS), function(r) list(reason = RETURN_REASONS[r], n = sum(L$returned & L$reason == r))),
       on_the_way = sum(state == 1L), returnable = sum(state == 2L), kept = sum(state == 3L))
}

# Shoppers at each stage right now (for the dots in the funnel's circles):
# on the way to a store, browsing, carrying items, at the fitting rooms, at
# the tills, and paid today. Trips to return items aren't counted.
live_stages <- function(stores, bins) {
  t <- clock
  sel <- d$store %in% stores & d$bin %in% bins & !d$ret
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
  here <- dv$store == s & dv$arrive <= t & !dv$ret          # shopping visits
  back <- dv$store == s & dv$ret & dv$outcome > 0           # trips to return items, done
  ended <- here & dv$outcome > 0
  o <- tabulate(dv$outcome[ended], N_OUTCOMES)
  paid <- ended & dv$outcome == 1L
  m <- rd$legs$m[seq_len(rd$legs$n), , drop = FALSE]
  m <- m[m[, "store"] == s & m[, "t0"] <= t, , drop = FALSE]
  dur <- pmin(m[, "t1"], t) - m[, "t0"]
  waits <- function(k) { w <- m[, "kind"] == k; if (any(w)) mean(dur[w]) else NA }
  hours <- seq_len(DAY_S / 3600)
  busy_by_hour <- function(k, servers) {
    w <- m[, "kind"] %in% k
    vapply(hours, function(h) {
      a <- pmax(m[w, "t0"], (h - 1) * 3600); b <- pmin(m[w, "t1"], h * 3600, t)
      sum(pmax(0, b - a)) / max(1e-9, servers * 3600)
    }, 0)
  }
  sm <- rd$staff$m[seq_len(rd$staff$n), , drop = FALSE]; sm <- sm[sm[, "store"] == s & sm[, "job"] != JOB_REFUND, , drop = FALSE]
  staff_hour <- vapply(hours, function(h) {
    a <- pmax(sm[, "t0"], (h - 1) * 3600); b <- pmin(sm[, "t1"], h * 3600, t)
    sum(pmax(0, b - a)) / max(1e-9, S$assistants[s] * 3600)
  }, 0)
  f <- STORES$format[s]
  dd <- days_so_far()
  season <- if (length(dd)) list(
    traffic = I(apply(tally$visits[dd, , s, , drop = FALSE], 1, sum)),
    paid = I(apply(tally$visits[dd, , s, 1, drop = FALSE], 1, sum)),
    sales = I(apply(tally$sales[dd, , s, drop = FALSE], 1, sum) - tally$refunds[dd, s]),       # net of the day's refunds of its sales
    returns = I(tally$taken_back[dd, s]),
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
               sales = sum(dv$sales[paid]), refunds = rd$today$refunds[s], net_sales = sum(dv$sales[paid]) - rd$today$refunds[s],
               taken_back = rd$today$taken_back[s], return_trips = sum(back),
               refund_s = sum(pmin(m[m[, "kind"] == REFUND, "t1"], t) - m[m[, "kind"] == REFUND, "t0"]),
               avg_receipt = if (sum(paid)) mean(dv$sales[paid]) else NA,
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
                till_util = mean(busy_by_hour(c(PAY, REFUND), S$cashiers[s])[hours * 3600 <= max(3600, min(t, DAY_S)) + 3599]),
                returned = sum(back),
                paid = o[1], left = sum(o[-1]), lost_fr = o[5], lost_till = o[7]),
    queues = list(fr = rd$today$fr_q[s, ], till = rd$today$till_q[s, ]),
    util = list(fitting = busy_by_hour(TRY, S$fitting_rooms[s]), tills = busy_by_hour(c(PAY, REFUND), S$cashiers[s]),
                refunds = busy_by_hour(REFUND, S$cashiers[s]), assistants = if (S$assistants[s] > 0) staff_hour else NULL),
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
       returning = returning_items(dv$ret_lines[[v]]),
       done = dv$outcome[v] > 0 && dv$gone[v] <= rd$t,
       log = lapply(seq_len(nrow(L)), function(i) list(t = clock_hm(L[i, 2]), text = lines[[i]])))
}

# The items a trip brings back (its ledger lines): each with what was paid,
# where and when it was bought, and why it's going back.
returning_items <- function(lines) {
  if (!length(lines)) return(list())
  L <- ledger_view(lines)
  lapply(seq_along(lines), function(j) list(item = sku_text(L$sku[j], L$brand[j]), price = L$paid[j], day = L$day[j],
                                            bought = if (L$online[j]) "online" else STORES$name[L$store[j]], reason = RETURN_REASONS[max(1L, L$reason[j])]))
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
  if (gone) now <- sprintf("Left at %s: %s", clock_hm(dv$gone[v]), c(OUTCOMES, TRIP_OUTCOME)[dv$outcome[v]])
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
      "7" = sprintf("Returning items %s", anchor_text(s, a)),
      "")
  }
  # Why they came here: the two biggest reasons from their appeal for this
  # store today (their household's card on the Market tab shows it all).
  ap <- appeal_parts(h)
  parts <- ap$parts[s, ]
  top <- names(sort(parts[parts > 0], decreasing = TRUE))[seq_len(min(2, sum(parts > 0)))]
  if (dv$ret[v]) top <- character()
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
    reasons = I(unname(APPEAL_LABELS[top])), trip = dv$ret[v], returning = returning_items(dv$ret_lines[[v]]),
    tier = tier_outlook(h, br), brand = BRANDS$name[br],
    offers = lapply(offers_held(h), function(k) list(brand = BRANDS$name[OFFERS$brand[k]], name = OFFERS$name[k], depth = OFFERS$depth[k],
                                                     until = OFFERS$to[k], good_here = OFFER_GOOD[k, br])),
    promotions = I(visit_promotions(v, rd)),
    budget_left = dv$budget[v] - dv$spent[v], budget = dv$budget[v],
    thoughts = event_thoughts(L, br),
    ledger = household_ledger(h)
  )
}

ordinal <- function(k) paste0(k, if (k %% 100 %in% 11:13) "th" else c("st", "nd", "rd", rep("th", 7))[(k %% 10) + (k %% 10 == 0) * 10])
# A worker: a cashier serves at their till, and takes returns back there;
# an assistant fetches sizes and advises. What they're doing now, and their
# day so far.
worker_panel <- function(s, kind, k, rd) {
  dv <- rd$d; t <- rd$t
  f <- STORES$format[s]
  span <- max(1, min(t, DAY_S))
  if (kind == "cashier") {
    if (k > fl$n_tills[f]) return(NULL)
    m <- rd$legs$m[seq_len(rd$legs$n), , drop = FALSE]
    till <- fl$till_first[f] + k - 1L
    mine <- m[m[, "store"] == s & m[, "kind"] %in% c(PAY, REFUND) & m[, "a"] == till & m[, "t0"] <= t, , drop = FALSE]
    cur <- mine[mine[, "t1"] > t, , drop = FALSE]
    waiting <- sum(m[, "store"] == s & m[, "kind"] == WAIT_TILL & m[, "t0"] <= t & m[, "t1"] > t)
    busy <- pmin(mine[, "t1"], t) - mine[, "t0"]
    refunds <- mine[, "kind"] == REFUND
    returned <- if (any(refunds)) sum(lengths(dv$ret_lines[mine[refunds, "visit"]])) else 0
    now <- "Waiting for a customer"
    if (nrow(cur)) {
      w <- cur[1, "visit"]
      now <- if (cur[1, "kind"] == REFUND) sprintf("Taking back %d item%s from visit #%d, done at %s", length(dv$ret_lines[[w]]), if (length(dv$ret_lines[[w]]) == 1) "" else "s", w, clock_hm(cur[1, "t1"]))
             else sprintf("Serving visit #%d: %d item%s, done at %s", w, dv$units[w], if (dv$units[w] == 1) "" else "s", clock_hm(cur[1, "t1"]))
    }
    return(list(kind = "cashier", server = k, title = sprintf("Cashier %d, %s", k, STORES$name[s]), till = k, open = k <= S$cashiers[s],
                now = now, serving = if (nrow(cur)) cur[1, "visit"] else NULL, queue = waiting,
                served = sum(!refunds), items = sum(dv$units[mine[!refunds, "visit"]]), busy = sum(busy) / span,
                returns = sum(refunds), returned = returned, refund_busy = sum(busy[refunds]) / span))
  }
  if (k > S$assistants[s]) return(NULL)
  sm <- rd$staff$m[seq_len(rd$staff$n), , drop = FALSE]
  mine <- sm[sm[, "store"] == s & sm[, "job"] != JOB_REFUND & sm[, "server"] == k & sm[, "t0"] <= t, , drop = FALSE]
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
  sold_store <- prod_totals(stock$sold)[b, ]
  sold_online <- prod_totals(stock$online, TRUE)[b, ]
  sold <- sold_store + sold_online                        # gross units sold
  net <- net_sold()[b, ]                                  # ... less those returned
  returned <- sold - net
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
  # Each unit sold, where it is now (returns.R): with a shopper (on the way,
  # returnable, kept), back in stock, or written off.
  I <- ledger$i
  lines <- which(I[seq_len(ledger$n), "brand"] == b)
  L <- ledger_view(lines)
  where <- matrix(tabulate((product_of(L$sku) - 1L) * length(LINE_STATES) + line_states(L), N_PROD * length(LINE_STATES)), N_PROD, byrow = TRUE)
  refunds <- bin_sum(product_of(L$sku), L$refund, N_PROD)
  products <- lapply(ok, function(k) list(
    id = k, name = PROD_NAME[b, k], category = PROD_CAT[b, k], day = PROD_DAY[b, k],
    full_price = full[k], price = full[k] * (1 - md[k]), markdown = md[k], cost = PROD_COST[b, k],
    bought = bought[k], sold = sold[k], sold_online = sold_online[k], returned = returned[k], net_sold = net[k],
    return_rate = if (sold[k] > 0) returned[k] / sold[k] else NA, refunds = refunds[k],
    in_stores = in_stores[k], at_dc = at_dc[k],
    sell_through = net[k] / max(1, bought[k]), lost = missed[k],
    cover = if (recent[k] > 0) (left$stores[b, k] + at_dc[k]) / recent[k] else NA, state = state[k],
    revenue = net[k] * full[k]))
  # Size availability: the share of the brand's stores with at least one of
  # the size on the floor, in some product of the category that's in the stores.
  cats <- which(CARRIES[b, ])
  cat_sku <- PROD_CAT[b, sku_prod()]; live <- launched[b, sku_prod()]
  avail <- t(vapply(cats, function(c) vapply(seq_len(N_SIZES), function(z) {
    sk <- which(cat_sku == c & size_of(seq_len(N_SKU)) == z & live)
    if (!length(rows)) return(NA_real_)
    mean(rowSums(stock$rack[rows, sk, drop = FALSE]) > 0)
  }, 0), numeric(N_SIZES)))
  dd <- days_so_far()
  fill <- if (length(dd) && length(rows)) rowSums(tally$size_fill[dd, rows, drop = FALSE]) / pmax(1, rowSums(tally$size_req[dd, rows, drop = FALSE])) else numeric()
  states <- colSums(where)
  list(brand = b, week = week_of(max(1L, day)), day = day, products = products, categories = CATEGORIES, category_colours = CATEGORY_COLOURS,
       sells = I(cats), sizes = SIZES, states = PRODUCT_STATES, counts = as.list(table(factor(state[ok], PRODUCT_STATES))),
       availability = matrix(avail, length(cats)), fill = I(fill), stores = length(rows), online = ONLINE$on[b],
       window = RETURNS$window_days[b],
       totals = list(bought = sum(bought), sold = sum(sold), sold_online = sum(sold_online), returned = sum(returned), net_sold = sum(net),
                     in_stores = sum(in_stores), at_dc = sum(at_dc), in_transit = sum(in_tr), lost = sum(missed),
                     with_shoppers = sum(states[1:3]), on_the_way = states[1], returnable = states[2], kept = states[3],
                     back_in_stock = states[4], written_off = states[5]),
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
  o <- if (length(dd)) apply(tally$visits[dd, , !OUTLET_ONLINE, , drop = FALSE], 4, sum) else numeric(N_OUTCOMES)     # store visits
  oo <- if (length(dd)) apply(tally$visits[dd, , OUTLET_ONLINE, 1:4, drop = FALSE], 4, sum) else numeric(4)          # online visits
  ds <- tally$dwell_stats[dd, , drop = FALSE]
  s <- c(n = sum(ds[, "n"]), sum = sum(ds[, "sum"]), sumsq = sum(ds[, "sumsq"]), min = min(Inf, ds[, "min"]), max = max(-Inf, ds[, "max"]))
  dw <- if (length(dd)) colSums(tally$dwell[dd, , , drop = FALSE]) else matrix(0, 2, 46)
  mean_m <- if (s[["n"]]) s[["sum"]] / s[["n"]] else NA
  sd_m <- if (s[["n"]] > 1) sqrt(max(0, (s[["sumsq"]] - s[["n"]] * mean_m^2) / (s[["n"]] - 1))) else NA
  util_role <- function(k, rows = seq_len(N_STORES)) I(if (length(dd)) rowMeans(tally$util[dd, rows, k, drop = FALSE], na.rm = TRUE) else numeric())
  ours <- which(OURS_B[STORES$brand])
  fill_all <- if (length(dd)) rowSums(tally$size_fill[dd, , drop = FALSE]) / pmax(1, rowSums(tally$size_req[dd, , drop = FALSE])) else numeric()
  fill_ours <- if (length(dd)) rowSums(tally$size_fill[dd, ours, drop = FALSE]) / pmax(1, rowSums(tally$size_req[dd, ours, drop = FALSE])) else numeric()
  list(outcomes = o, outcome_names = OUTCOMES, online_outcomes = oo, online_outcome_names = ONLINE_OUTCOMES, any_online = any(ONLINE$on),
       returns = list(trips = sum(tally$trips[dd, ]), taken_back = sum(tally$taken_back[dd, ]), refund_hours = sum(tally$refund_s[dd, ]) / 3600,
                      parcels = sum(tally$post_parcels[dd, ])),
       dwell = list(bought = dw[1, ], not = dw[2, ], bin_min = 2,
                    n = s[["n"]], mean = mean_m, min = if (is.finite(s[["min"]])) s[["min"]] else NA,
                    max = if (is.finite(s[["max"]])) s[["max"]] else NA, sd = sd_m),
       util = list(all = list(fitting = util_role(1), tills = util_role(2), assistants = util_role(3), returns = util_role(4)),
                   ours = list(fitting = util_role(1, ours), tills = util_role(2, ours), assistants = util_role(3, ours), returns = util_role(4, ours))),
       fill = list(all = I(fill_all), ours = I(fill_ours)),
       contribution = contribution(dd))
}

# ---- Export ----------------------------------------------------------------------------------

# The season's daily results, one row per finished day and brand: visits
# and receipts by channel, gross sales (in the stores and online), returns
# (units, and the refunds, booked on the day of the return against the
# channel that sold), net sales, and the costs, as the Scorecard counts
# them (cost of goods net of the returns back in stock and those written
# off, the returns written off at cost, online orders' costs, the delivery
# charges shoppers paid, and return postage).
export_csv <- function() {
  dd <- seq_len(days_complete())
  if (!length(dd)) return("day,week,brand\n")
  rows <- expand.grid(brand = seq_len(N_BRANDS), day = dd)
  i <- cbind(match(rows$day, dd), rows$brand)
  pick <- function(x) x[i]
  # Day x brand, from a day x outlet table, for one channel or both.
  by_brand <- function(x, online = NA) {
    keep <- if (is.na(online)) rep(TRUE, dim(x)[2L]) else OUTLET_ONLINE[seq_len(dim(x)[2L])] == online
    x %*% (outer(OUTLET_BRAND[seq_len(dim(x)[2L])], seq_len(N_BRANDS), "==") * keep)
  }
  per_outlet <- function(what) { x <- apply(tally[[what]][dd, , , drop = FALSE], c(1, 3), sum); if (length(dd) == 1) matrix(x, 1) else x }
  per_day <- function(what) tally[[what]][dd, , drop = FALSE]
  visits <- apply(tally$visits[dd, , , , drop = FALSE], c(1, 3), sum)
  paid <- apply(tally$visits[dd, , , 1, drop = FALSE], c(1, 3), sum)
  if (length(dd) == 1) { visits <- matrix(visits, 1); paid <- matrix(paid, 1) }
  sales <- per_outlet("sales"); refunds <- per_day("refunds")
  cogs <- per_outlet("cogs") - per_day("ret_back_cost") - per_day("ret_lost_cost")
  out <- data.frame(day = rows$day, week = week_of(rows$day), weekday = DAYS[dow_of(rows$day)],
                    brand = BRANDS$name[rows$brand], family = FAMILIES$name[BRANDS$family[rows$brand]],
                    store_visits = pick(by_brand(visits, FALSE)), receipts = pick(by_brand(paid, FALSE)),
                    online_visits = pick(by_brand(visits, TRUE)), online_orders = pick(by_brand(paid, TRUE)),
                    gross_sales = round(pick(by_brand(sales)), 2), store_gross_sales = round(pick(by_brand(sales, FALSE)), 2),
                    online_gross_sales = round(pick(by_brand(sales, TRUE)), 2),
                    returns_units = pick(by_brand(per_day("ret_units"))), returns_value = round(pick(by_brand(refunds)), 2),
                    net_sales = round(pick(by_brand(sales - refunds)), 2), store_net_sales = round(pick(by_brand(sales - refunds, FALSE)), 2),
                    online_net_sales = round(pick(by_brand(sales - refunds, TRUE)), 2),
                    full_price_value = round(pick(by_brand(per_outlet("full"))), 2), units = pick(by_brand(per_outlet("units"))),
                    cost_of_goods = round(pick(by_brand(cogs)), 2), returns_written_off_at_cost = round(pick(by_brand(per_day("ret_lost_cost"))), 2),
                    staff_cost = round(pick(by_brand(per_day("staff_cost"))), 2),
                    marketing = round(tally$ad_cost[i], 2), offers = round(tally$offer_cost[i], 2),
                    logistics = round(pick(by_brand(per_day("logistics"))), 2),
                    online_fulfilment = round(tally$fulfilment[i], 2), online_shipping = round(tally$shipping[i], 2),
                    delivery_charges = round(tally$delivery[i], 2), return_postage = round(tally$post_cost[i], 2))
  csv_field <- function(x) { x <- trimws(as.character(x)); ifelse(grepl("[,\"]", x), paste0("\"", gsub("\"", "\"\"", x), "\""), x) }
  paste(c(paste(names(out), collapse = ","), apply(out, 1, function(r) paste(csv_field(r), collapse = ","))), collapse = "\n")
}
