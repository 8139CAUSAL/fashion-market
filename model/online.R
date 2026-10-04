# The online store: a brand's range, sold from its distribution centre (DC).
#
# A brand may have an online store (world.R), in reach of every household.
# In the market-day choice (market.R) it's one more option for each
# household: the brand's appeal as at its stores (taste, what it sells,
# loyalty, price less promotions and coupons, promotions and marketing,
# memory of bad visits, word of mouth, offers held), with the segment's
# taste for shopping online, the wait for delivery and any delivery charge
# in place of the trip and the store's layout.
#
# An online visit has no floor, no queues and no fitting rooms. It comes at
# a moment of the store day, as a store visit does, and the online store
# settles the visits that came in each five minutes (ONLINE_BATCH_S) at the
# end of them, in the order they came. The shopper goes
# through the categories they're after among those the brand sells, and in
# each picks the product that appeals most, as at the racks (store.R), if
# they can afford it with the delivery charge, in their own size from the
# DC's stock: "not in my size" happens only when the DC is out. With
# anything picked, the order is placed as it's settled: charged then, its
# stock leaving the DC then. It reaches the household after the brand's delivery days,
# and can be returned only after that (returns.R). Each order costs the
# brand its picking and packing and its shipping, and the shopper pays the
# delivery charge, which isn't refunded with a return.

# Each brand's typical full price today: the middle of its list prices,
# times its price change. A delivery charge is weighed against
# ONLINE_BASKET_ITEMS of it.
typical_price <- function() {
  vapply(seq_len(N_BRANDS), function(b) stats::median(LIST_PRICE[b, PROD_OK[b, ]]), 0) * LEVERS$price$value
}

# The delivery charge as a share of a typical order, by brand.
delivery_share <- function() ONLINE$delivery_charge / (ONLINE_BASKET_ITEMS * typical_price())

# The online visits that came before store time s (they come off a list
# sorted by time), settled together, in the order they came.
online_step <- function(s) {
  k <- d$on_next
  o <- d$on_order
  while (k <= length(o) && d$arrive[o[k]] < s) k <- k + 1L
  if (k == d$on_next) return(invisible())
  v <- o[d$on_next:(k - 1L)]
  d$on_next <<- k
  for (z in seq_len(MAX_ITEMS + 1L)) {
    w <- v[d$n_zones[v] >= z & d$items[v] < MAX_ITEMS]
    if (!length(w)) break
    d$zi[w] <<- z
    online_pick(w, d$arrive[w])
  }
  online_close(v)
}

# Each online shopper, in the category they've reached, picks the product
# that appeals most (as pick_items does at a rack), if it clears the bar
# and they can afford it with the delivery charge, in their size from the
# DC, first come first served.
online_pick <- function(v, e) {
  n <- length(v)
  cat <- d$zone[cbind(v, d$zi[v])]
  brand <- d$brand[v]
  K <- N_SLOT
  prod <- PROD_SLOT[cbind(rep(brand, K), rep(cat, K), rep(seq_len(K), each = n))]
  none <- prod == 0L
  prod[none] <- 1L
  dim(prod) <- c(n, K)
  bs <- (as.vector(prod) - 1L) * N_BRANDS + brand
  rp <- rack_price(v, prod)
  full <- rp$full; md <- rp$md; off <- rp$off; price <- rp$price
  relative <- price / TYPICAL_PRICE[cat]
  psens <- SEGMENTS$price[d$seg[v]]
  taste <- matrix(gumbel(n * K), n) + matrix(pop[bs], n)
  U <- taste - PICK_W * psens * log(relative) + MARKDOWN_W * matrix(md, n) - PICK_BAR
  U[!matrix(launched[bs], n) | none] <- -Inf
  left <- d$budget[v] - d$spent[v] - ONLINE$delivery_charge[brand]
  best <- row_max(ifelse_mat(price <= left, U, -Inf))
  want <- best$max > 0
  liked <- row_max(U)$max > 0
  d$too_dear[v[!want & liked]] <<- TRUE
  w <- which(want)
  if (!length(w)) return(invisible())
  sku <- (prod[cbind(w, best$k[w])] - 1L) * N_SIZES + d$size[v[w]]
  got <- rank_within((brand[w] - 1L) * N_SKU + sku, e[w]) <= stock$dc[cbind(brand[w], sku)]
  if (any(got)) {
    add_units("dc", brand[w][got], sku[got], -1)
    add_units("online", brand[w][got], sku[got], 1)
  }
  d$missed_size[v[w][!got]] <<- TRUE
  g <- which(got)
  if (!length(g)) return(invisible())
  vv <- v[w][g]
  slot <- d$items[vv] + 1L
  d$items[vv] <<- slot
  d$basket[cbind(vv, slot)] <<- sku[g]
  at <- cbind(w, best$k[w])[g, , drop = FALSE]
  paid <- price[at]
  d$paid_for[cbind(vv, slot)] <<- paid
  d$full_for[cbind(vv, slot)] <<- full[at]
  d$md_for[cbind(vv, slot)] <<- matrix(md, n)[at]
  d$off_for[cbind(vv, slot)] <<- off[at]
  d$spent[vv] <<- d$spent[vv] + paid
}

# Online visits settled: an order for each with anything picked (charged
# now, in the ledger, its costs to the brand), and every other visit ends
# as a store visit leaving the floor would (nothing appealed, too
# expensive, or not in my size).
online_close <- function(v) {
  t <- d$arrive[v]
  d$outcome_at[v] <<- t                # when the shopper came (the order is settled within five minutes)
  d$gone[v] <<- t
  d$ev_at[v] <<- Inf
  buy <- d$items[v] > 0
  none <- v[!buy]
  if (length(none)) {
    reason <- 2L + d$too_dear[none]
    reason[d$missed_size[none]] <- 4L
    d$outcome[none] <<- reason
  }
  o <- v[buy]
  if (!length(o)) return(invisible())
  b <- d$brand[o]
  settle_sale(o, KIND_ONLINE, day + as.integer(ONLINE$delivery_days[b]))
  d$delivery[o] <<- ONLINE$delivery_charge[b]
  d$outcome[o] <<- 1L
  today$orders <<- today$orders + tabulate(b, N_BRANDS)
  today$fulfilment <<- today$fulfilment + bin_sum(b, ONLINE$fulfilment_cost[b], N_BRANDS)
  today$shipping <<- today$shipping + bin_sum(b, ONLINE$shipping_cost[b], N_BRANDS)
  today$delivery <<- today$delivery + bin_sum(b, ONLINE$delivery_charge[b], N_BRANDS)
}

# A sale settled, for visits v with items in their baskets (in a store at
# the till, or an online order): the receipt (sales, full-price value,
# units, cost of goods, and what markdowns, promotions and the coupon took
# off), and a ledger line for each unit, of `kind`, reaching the household
# on day `in_hand`. In a store, `tried` says which shoppers went through the
# fitting rooms: an item they bought of a category that's tried on was
# tried on, and any other was bought untried.
settle_sale <- function(v, kind, in_hand, tried = NULL) {
  held <- d$basket[v, , drop = FALSE]
  n <- length(v)
  sold <- held > 0
  d$sales[v] <<- .rowSums(d$paid_for[v, , drop = FALSE], n, MAX_ITEMS)
  d$full_value[v] <<- .rowSums(d$full_for[v, , drop = FALSE] * sold, n, MAX_ITEMS)
  d$units[v] <<- .rowSums(sold, n, MAX_ITEMS)
  d$cogs[v] <<- .rowSums(matrix(PROD_COST[cbind(rep(d$brand[v], MAX_ITEMS), product_of(as.vector(held + (held == 0L))))], n) * sold, n, MAX_ITEMS)
  # What they saved, item by item: markdowns off full price, promotions off
  # the marked-down price, the coupon off the rest.
  full <- d$full_for[v, , drop = FALSE] * sold
  md <- full * d$md_for[v, , drop = FALSE]
  promo <- (full - md) * d$off_for[v, , drop = FALSE]
  coupon <- full - md - promo - d$paid_for[v, , drop = FALSE] * sold
  d$coupon_saved[v] <<- .rowSums(coupon, n, MAX_ITEMS)
  # The ledger, visit by visit, item by item.
  k <- which(t(sold)) - 1L
  if (!length(k)) return(list(md = md, promo = promo))
  row <- k %/% MAX_ITEMS + 1L
  at <- (k %% MAX_ITEMS) * n + row                   # each item's place in the visits x items tables
  dv <- v[row]
  big <- (k %% MAX_ITEMS) * d$v + dv                 # ... and in the day's
  if (!is.null(tried)) kind <- ifelse_int(tried[row] & TRY_ON[sku_category(held[at], d$brand[dv])], KIND_TRIED, KIND_UNTRIED)
  ledger_add(d$hh[dv], d$brand[dv], d$store[dv], held[at], d$full_for[big], d$md_for[big], d$off_for[big], d$paid_for[big],
             ifelse_int(d$coupon[dv] > 0, d$coupon_from[dv], 0L), kind, rep_len(in_hand, n)[row])
  list(md = md, promo = promo)
}
