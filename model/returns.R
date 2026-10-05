# The sales ledger and returns: every unit sold, who bought it, what they
# paid, and whether it came back.
#
# The ledger has one line per unit sold, in a store or online, written as
# the sale is made: the household, the brand, the store (0: online), the
# day, the product and size, its full price, the markdown and promotion
# taken off (as shares) and the price paid (what the coupon took is the
# rest), the offer whose coupon it was bought with, and the day it reached
# the household (the day of the sale, or of the delivery). When a unit is
# returned, its line gets the day, the store it went back to (0: by post to
# the DC), and the reason; the refund is exactly what was paid for it, and
# the unit is put back in stock or written off. The money figures on every
# tab add up from these lines.
#
# Who returns, and when. An item may come back within its brand's return
# window, counted in days from the day it reaches the household. Each
# evening, every item sold that day is given its fate, hidden from the
# reports as the products' popularity is: whether the household will want
# to send it back (RETURN_P, by how it was bought: online, in a store
# without trying it on, or tried on in a fitting room, times the tendency
# to return of the household's segment, and never more than certain),
# why, and after how many days (RETURN_DAYS on average). A return the
# window has closed on doesn't happen: the household keeps the item. A
# longer window lets more of the wanted returns happen, and draws shoppers
# (market.R): it covers 1 - exp(-window / RETURN_DAYS) of them.
#
# Where. A household takes its returns for a brand to that brand's store
# nearest by route, if it's within the household's reach for the brand (its
# radius, stretched by its tier with the brand), on a trip of their own: it drives there, joins the till queue whatever
# its length, and a cashier takes the items back (REFUND_BASE_S, and
# REFUND_ITEM_S an item: a job in the staff log, store.R). It doesn't shop
# on that trip. Otherwise (a brand with no stores, or none in reach) it
# posts them back to the brand's DC the morning they're due, one parcel a
# household, at the brand's return postage. A returned unit goes back on
# the floor (with the items left behind, reshelved on the hour) or into the
# DC, unless it's one of the share too worn to sell again (the brand's
# write-off rate), written off at cost.
#
# Returns the window would allow after the season's last day never happen
# in the season: the season's figures end with it. The reports count what's
# still returnable at the end.

LEDGER_INT <- c("hh", "brand", "store", "day", "sku", "offer", "kind", "in_hand", "due", "reason", "fate", "ret_day", "ret_store")
LEDGER_NUM <- c("full", "md", "off", "paid")
KIND_ONLINE <- 1L; KIND_UNTRIED <- 2L; KIND_TRIED <- 3L        # rows of RETURN_P
FATE_RESTOCK <- 1L; FATE_WRITE_OFF <- 2L

# The window's share of the returns a shopper might want, by brand.
window_cover <- function() 1 - exp(-RETURNS$window_days / RETURN_DAYS)

# ---- The ledger -----------------------------------------------------------------------------

# Two matrices with room to spare, grown by doubling: whole numbers (as
# integers, LEDGER_INT) and money (LEDGER_NUM). `today` is the first line
# written today; `due` lists, for each day of the season, the lines that
# will come back then.
init_ledger <- function() {
  cap <- 2000L * SEASON_DAYS
  ledger <<- list(n = 0L, today = 1L,
                  i = matrix(0L, cap, length(LEDGER_INT), dimnames = list(NULL, LEDGER_INT)),
                  m = matrix(0, cap, length(LEDGER_NUM), dimnames = list(NULL, LEDGER_NUM)),
                  due = vector("list", SEASON_DAYS))
}

# New lines (each argument one value per unit, or one for all). Returns
# their numbers.
ledger_add <- function(hh, brand, store, sku, full, md, off, paid, offer, kind, in_hand) {
  k <- length(sku)
  if (!k) return(integer())
  n <- ledger$n
  cap <- dim(ledger$i)[1L]
  if (n + k > cap) {
    grow <- max(k, cap)
    ledger$i <<- rbind(ledger$i, matrix(0L, grow, length(LEDGER_INT)))
    ledger$m <<- rbind(ledger$m, matrix(0, grow, length(LEDGER_NUM)))
  }
  rows <- n + seq_len(k)
  int <- function(x) rep_len(as.integer(x), k)
  ledger$i[rows, ] <<- cbind(int(hh), int(brand), int(store), int(day), int(sku), int(offer), int(kind), int(in_hand), 0L, 0L, 0L, 0L, 0L)
  ledger$m[rows, ] <<- cbind(rep_len(full, k), rep_len(md, k), rep_len(off, k), rep_len(paid, k))
  ledger$n <<- n + k
  rows
}

# The ledger so far, as plain columns (a list of vectors, one per field,
# with `cost` and `refund`), optionally only lines `rows`.
ledger_view <- function(rows = seq_len(ledger$n)) {
  I <- ledger$i[rows, , drop = FALSE]; M <- ledger$m[rows, , drop = FALSE]
  out <- c(lapply(setNames(LEDGER_INT, LEDGER_INT), function(f) unname(I[, f])), lapply(setNames(LEDGER_NUM, LEDGER_NUM), function(f) unname(M[, f])))
  out$product <- product_of(out$sku)
  out$cost <- PROD_COST[cbind(out$brand, out$product)]
  out$returned <- out$ret_day > 0L
  out$refund <- out$paid * out$returned
  out$online <- out$store == 0L
  out$outlet <- ifelse_int(out$online, N_STORES + out$brand, out$store)
  out
}

# What the coupon took off each line: the rest of the full price after the
# markdown and the promotion, less what was paid.
ledger_coupon <- function(L) pmax(0, L$full * (1 - L$md) * (1 - L$off) - L$paid)

# ---- Each evening: the fate of the day's sales ------------------------------------------------

# Every unit sold today, at a brand that takes returns, is given its fate:
# whether it will come back, why, on which day, and whether it can be sold
# again. Draws are made only for those brands, so a world without returns
# draws nothing here.
returns_evening <- function() {
  first <- ledger$today
  ledger$today <<- ledger$n + 1L
  if (first > ledger$n || !any(RETURNS$window_days > 0)) return(invisible())
  rows <- seq.int(first, ledger$n)
  b <- ledger$i[rows, "brand"]
  window <- RETURNS$window_days[b]
  rows <- rows[window > 0]; window <- window[window > 0]
  n <- length(rows)
  if (!n) return(invisible())
  u <- runif(n)
  wait <- 1L + as.integer(floor(rexp(n, 1 / RETURN_DAYS)))
  lost <- runif(n) < RETURNS$write_off_rate[ledger$i[rows, "brand"]]
  # Each item's chance of coming back, by reason (cumulated), for how it
  # was bought, times its household's segment's tendency to return; where
  # that would be more than certain, scaled down to certain, the reasons in
  # proportion.
  tendency <- SEGMENTS$returns[mk$hh$segment[ledger$i[rows, "hh"]]]
  cum <- t(apply(RETURN_P, 1, cumsum))[ledger$i[rows, "kind"], , drop = FALSE] * tendency
  cum <- cum / pmax(1, cum[, 3])
  reason <- 1L + (u >= cum[, 1]) + (u >= cum[, 2])
  back <- u < cum[, 3] & wait <= window
  due <- ledger$i[rows, "in_hand"] + wait
  ledger$i[rows, "due"] <<- ifelse_int(back, due, 0L)
  ledger$i[rows, "reason"] <<- ifelse_int(back, reason, 0L)
  ledger$i[rows, "fate"] <<- ifelse_int(back, ifelse_int(lost, FATE_WRITE_OFF, FATE_RESTOCK), 0L)
  soon <- back & due <= SEASON_DAYS
  for (k in unique(due[soon])) ledger$due[[k]] <<- c(ledger$due[[k]], rows[soon & due == k])
}

# ---- Each morning: the returns due today ----------------------------------------------------

# The lines due back today, by household and brand: those with one of the
# brand's stores in reach go there on a trip (returned as list(hh, store,
# lines), for new_visits); the rest are posted back to the DC now.
returns_morning <- function() {
  lines <- if (day <= length(ledger$due)) ledger$due[[day]] else NULL
  none <- list(hh = integer(), store = integer(), lines = list())
  if (!length(lines)) return(none)
  h <- ledger$i[lines, "hh"]; b <- ledger$i[lines, "brand"]
  key <- (h - 1L) * N_BRANDS + b
  first <- !duplicated(key)
  gh <- h[first]; gb <- b[first]
  s <- mk$near_store[cbind(gh, gb)]
  tier <- mk$tier[cbind(gh, gb)]
  reach <- s > 0L
  reach[reach] <- mk$km[cbind(gh[reach], s[reach])] <= SEGMENTS$radius_km[mk$hh$segment[gh[reach]]] * TIER_RADIUS[cbind(gb[reach], tier[reach])] + 1e-9
  group <- match(key, key[first])
  post <- which(!reach)
  if (length(post)) {
    by_post <- lines[group %in% post]
    book_returns(by_post, 0L)
    today$post_parcels <<- today$post_parcels + tabulate(gb[post], N_BRANDS)
    today$post_cost <<- today$post_cost + tabulate(gb[post], N_BRANDS) * RETURNS$post_cost
  }
  trip <- which(reach)
  list(hh = gh[trip], store = s[trip], lines = lapply(trip, function(g) lines[group == g]))
}

# Lines `lines` come back today, at stores `store` (one, or one a line; 0:
# by post to the DC): the refund (what was paid), and the unit back in
# stock or written off. Each is booked today against the outlet that sold
# it.
book_returns <- function(lines, store) {
  if (!length(lines)) return(invisible())
  I <- ledger$i[lines, , drop = FALSE]
  ledger$i[lines, "ret_day"] <<- day
  ledger$i[lines, "ret_store"] <<- as.integer(rep_len(store, length(lines)))
  b <- I[, "brand"]; sku <- I[, "sku"]
  paid <- ledger$m[lines, "paid"]
  cost <- PROD_COST[cbind(b, product_of(sku))]
  outlet <- ifelse_int(I[, "store"] == 0L, N_STORES + b, I[, "store"])
  back <- I[, "fate"] == FATE_RESTOCK
  to <- rep_len(store, length(lines))
  if (any(back & to > 0L)) {
    add_units("go_back", to[back & to > 0L], sku[back & to > 0L], 1)
    add_units("restocked", to[back & to > 0L], sku[back & to > 0L], 1)
  }
  if (any(back & to == 0L)) {                         # brand x SKU tables: add_units() by brand
    add_units("dc", b[back & to == 0L], sku[back & to == 0L], 1)
    add_units("restocked_dc", b[back & to == 0L], sku[back & to == 0L], 1)
  }
  if (any(!back)) add_units("written_off", b[!back], sku[!back], 1)
  today$refunds <<- today$refunds + bin_sum(outlet, paid, N_OUTLETS)
  today$ret_units <<- today$ret_units + tabulate(outlet, N_OUTLETS)
  today$ret_back_cost <<- today$ret_back_cost + bin_sum(outlet[back], cost[back], N_OUTLETS)
  today$ret_lost_cost <<- today$ret_lost_cost + bin_sum(outlet[!back], cost[!back], N_OUTLETS)
  today$ret_lost_units <<- today$ret_lost_units + tabulate(outlet[!back], N_OUTLETS)
  today$taken_back <<- today$taken_back + tabulate(to, N_STORES)
  today$returned <<- c(today$returned, lines)
}

# ---- What the ledger says, for the reports ---------------------------------------------------

# Each household's refunds today so far, by brand: households x brands
# (sparse: the rows and brands with any).
refunds_today <- function(returned = today$returned) {
  if (!length(returned)) return(list(hh = integer(), brand = integer(), refund = numeric()))
  h <- ledger$i[returned, "hh"]; b <- ledger$i[returned, "brand"]
  key <- (h - 1L) * N_BRANDS + b
  r <- rowsum(ledger$m[returned, "paid"], key)
  k <- as.integer(rownames(r))
  list(hh = (k - 1L) %/% N_BRANDS + 1L, brand = (k - 1L) %% N_BRANDS + 1L, refund = r[, 1])
}

# Each line's state today, for the stock and the Assortment: 1 on its way
# to the household (online, not delivered yet), 2 with the household and
# returnable, 3 kept (the window has closed, or the brand takes no
# returns), 4 back in stock, 5 written off.
LINE_STATES <- c("on the way to a shopper", "with a shopper, returnable", "kept", "returned, back in stock", "returned, written off")
line_states <- function(L, now = day) {
  window <- RETURNS$window_days[L$brand]
  s <- ifelse_int(L$in_hand > now, 1L, ifelse_int(window > 0 & now <= L$in_hand + window, 2L, 3L))
  s[L$returned] <- ifelse_int(L$fate[L$returned] == FATE_RESTOCK, 4L, 5L)
  s
}

# The delivery charges households paid, by brand: one an online order (a
# household orders from a brand at most once a day), for the ledger's
# lines L.
delivery_paid <- function(L) {
  on <- L$online
  if (!any(on)) return(numeric(N_BRANDS))
  first <- !duplicated(cbind(L$hh[on], L$day[on]))
  b <- L$brand[on][first]
  tabulate(b, N_BRANDS) * ONLINE$delivery_charge
}

# One household's ledger: every item it has bought this season, what it
# paid and what came off, and whether it went back, and its totals by
# brand: gross spend, refunds, net spend, and delivery charges paid.
household_ledger <- function(h) {
  rows <- which(ledger$i[seq_len(ledger$n), "hh"] == h)
  L <- ledger_view(rows)
  full <- L$full; md <- full * L$md; promo <- (full - md) * L$off; coupon <- ledger_coupon(L)
  state <- line_states(L)
  where <- function(s) if (s > 0L) STORES$name[s] else "by post"
  lines <- lapply(rev(seq_along(rows)), function(j) list(
    day = L$day[j], brand = L$brand[j], online = L$online[j], store = if (L$online[j]) "online" else STORES$name[L$store[j]],
    item = sku_text(L$sku[j], L$brand[j]), full = full[j], markdown = md[j], promotion = promo[j], coupon = coupon[j], paid = L$paid[j],
    offer = if (L$offer[j] > 0L) OFFERS$name[L$offer[j]] else NULL, delivered = if (L$online[j]) L$in_hand[j] else NULL,
    state = LINE_STATES[state[j]], returned = L$returned[j],
    ret_day = if (L$returned[j]) L$ret_day[j] else NULL, ret_where = if (L$returned[j]) where(L$ret_store[j]) else NULL,
    reason = if (L$returned[j]) RETURN_REASONS[L$reason[j]] else NULL, refund = L$refund[j],
    back_in_stock = if (L$returned[j]) L$fate[j] == FATE_RESTOCK else NULL))
  delivery <- delivery_paid(L)
  bs <- sort(unique(c(L$brand, which(delivery > 0))))
  totals <- lapply(bs, function(b) {
    k <- L$brand == b
    list(brand = b, items = sum(k), returned = sum(k & L$returned), gross = sum(L$paid[k]), refunds = sum(L$refund[k]),
         net = sum(L$paid[k]) - sum(L$refund[k]), delivery = delivery[b])
  })
  list(lines = lines, totals = totals,
       gross = sum(L$paid), refunds = sum(L$refund), net = sum(L$paid) - sum(L$refund), delivery = sum(delivery))
}
