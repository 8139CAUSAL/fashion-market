# Offers: each brand's targeted coupons, named entries on its calendar (an
# email, a direct mailing, whatever the brand calls it). An offer runs from
# its first day to its last:
#
#   its audience  on its first morning, a share of the households it reaches
#                 (its tiers with the brand, in its areas or everywhere),
#                 drawn at random
#   held out      a share of the audience, drawn at random, is sent nothing;
#                 the rest are sent the coupon, at a cost each
#   the coupon    a share off one purchase, until the offer's last day, at
#                 the brand or at any other brand it's good at (a sister
#                 brand, say); a household holding several uses the deepest
#                 good where it shops
#
# A household holding a coupon is more likely to go shopping, and more
# drawn to the brands it's good at: by its segment's response to offers,
# times its tier's, less as it gets more of the brand's offers (fatigue).
# The discount itself comes off the prices it weighs, and pays. The
# simulation keeps that response hidden. An offer's effect is measured as a
# brand measures one: the households sent it against those held out, over
# the offer's days. Every purchase an audience household makes on those
# days, at any brand, is logged against the offer, so the reports can say
# where the extra spend came from.

FATIGUE_K <- 0.5                             # response shrinks by exp(-FATIGUE_K * fatigue)
FATIGUE_DECAY <- 0.94                        # share of fatigue kept each day
BUY_COLS <- c("offer", "member", "brand", "day", "sales", "margin", "coupon")

# Every brand's offers, from the world, in one table (OFFERS: brand, id,
# name, days, depth, cost to send, audience, held out), with the tiers each
# reaches (offers x MAX_TIERS), its areas (their numbers; none: everywhere)
# and the brands its coupon is good at (offers x brands).
offers_install <- function(brands, W) {
  area_ids <- if (is.list(W$macro$areas)) vapply(W$macro$areas, function(a) a$id, "") else character()
  ids <- vapply(brands, `[[`, "", "id")
  x <- unlist(lapply(seq_along(brands), function(b) lapply(brands[[b]]$calendar$offers, function(o) c(list(brand = b), o))), recursive = FALSE)
  num <- function(f) vapply(x, function(o) as.numeric(o[[f]]), 0)
  OFFERS <<- data.frame(brand = vapply(x, function(o) as.integer(o$brand), 0L), id = vapply(x, function(o) o$id, ""),
                        name = vapply(x, function(o) o$name, ""), from = as.integer(num("from")), to = as.integer(num("to")),
                        depth = num("depth"), send_cost = num("send_cost"), audience = num("audience"), holdout = num("holdout"),
                        stringsAsFactors = FALSE)
  K <- length(x)
  OFFER_TIERS <<- matrix(FALSE, K, MAX_TIERS)
  OFFER_GOOD <<- matrix(FALSE, K, length(brands))
  OFFER_AREAS <<- vector("list", K)
  for (k in seq_len(K)) {
    b <- OFFERS$brand[k]
    OFFER_TIERS[k, match(unlist(x[[k]]$tiers), TIER_IDS[[b]])] <<- TRUE
    OFFER_GOOD[k, c(b, match(unlist(x[[k]]$also_at), ids))] <<- TRUE
    OFFER_AREAS[[k]] <<- match(unlist(x[[k]]$areas), area_ids)
  }
}

# At Setup: no audience drawn yet, and no one tired of any brand's offers.
init_offers <- function() {
  K <- nrow(OFFERS); none <- vector("list", K)
  ofr <<- list(drawn = logical(K), members = none, sent = none, used = none, tier = none, shop = none, util = none, slot = none,
               buys = matrix(0, 20000, length(BUY_COLS), dimnames = list(NULL, BUY_COLS)), n_buys = 0L, logged = 0L,
               bins = matrix(vapply(OFFER_AREAS, function(a) if (length(a)) seq_len(AREA_BINS) %in% a else rep(TRUE, AREA_BINS),
                                    logical(AREA_BINS)), K, AREA_BINS, byrow = TRUE))
  mk$fatigue <<- matrix(0, mk$hh$n, N_BRANDS)
  mk$at <<- offer_effects()
}

# The offers running on day `t` (their audience drawn).
offers_live <- function(t = day) which(OFFERS$from <= t & OFFERS$to >= t & ofr$drawn)

# What every household's coupons do today: the lift in its chance of
# shopping, the pull at each brand, and the coupon it can use at each brand
# (its depth, and which offer it's from: the deepest it holds there).
offer_effects <- function() {
  n <- mk$hh$n; B <- N_BRANDS
  out <- list(shop = rep(1, n), util = matrix(0, n, B), coupon = matrix(0, n, B), coupon_from = matrix(0L, n, B))
  for (k in offers_live()) {
    holds <- which(ofr$sent[[k]] & ofr$used[[k]] == 0L)
    if (!length(holds)) next
    h <- ofr$members[[k]][holds]
    out$shop[h] <- out$shop[h] + ofr$shop[[k]][holds]
    for (a in which(OFFER_GOOD[k, ])) {
      out$util[h, a] <- out$util[h, a] + ofr$util[[k]][holds]
      deeper <- h[OFFERS$depth[k] > out$coupon[h, a]]
      out$coupon[deeper, a] <- OFFERS$depth[k]; out$coupon_from[deeper, a] <- k
    }
  }
  out
}

# Morning: fatigue fades, today's offers draw their audiences and send
# their coupons (charged today), and an offer that ended yesterday stops
# watching for its households' purchases.
offers_morning <- function() {
  mk$fatigue <<- mk$fatigue * FATIGUE_DECAY
  cost <- numeric(N_BRANDS)
  for (k in which(OFFERS$from == day)) cost[OFFERS$brand[k]] <- cost[OFFERS$brand[k]] + draw_audience(k)
  for (k in which(OFFERS$to == day - 1L)) ofr$slot[k] <<- list(NULL)
  today$offer_cost <<- cost
  mk$at <<- offer_effects()
}

# Offer k's audience: a share of the households it reaches, drawn at
# random; the first of them drawn, as many as its holdout, are held out
# (so they're a random share too). Each household sent the coupon gets its
# hidden response, and one more of the brand's offers to tire of. Returns
# what sending cost.
draw_audience <- function(k) {
  b <- OFFERS$brand[k]; hh <- mk$hh
  eligible <- which(OFFER_TIERS[k, ][mk$tier[, b]] & ofr$bins[k, ][hh$bin])
  m <- round(OFFERS$audience[k] * length(eligible))
  members <- eligible[sample.int(length(eligible), m)]
  sent <- seq_len(m) > round(OFFERS$holdout[k] * m)
  h <- members[sent]
  tier <- mk$tier[members, b]
  eff <- exp(-FATIGUE_K * mk$fatigue[h, b]) * TIER_OFFERS[cbind(rep(b, length(h)), tier[sent])]
  shop <- numeric(m); util <- numeric(m)
  shop[sent] <- eff * OFFER_SHOP[hh$segment[h]]
  util[sent] <- eff * OFFER_PULL[hh$segment[h]]
  mk$fatigue[h, b] <<- mk$fatigue[h, b] + 1
  slot <- integer(hh$n); slot[members] <- seq_len(m)
  ofr$members[[k]] <<- members; ofr$sent[[k]] <<- sent; ofr$used[[k]] <<- integer(m); ofr$tier[[k]] <<- tier
  ofr$shop[[k]] <<- shop; ofr$util[[k]] <<- util; ofr$slot[[k]] <<- slot
  ofr$drawn[k] <<- TRUE
  OFFERS$send_cost[k] * sum(sent)
}

# Evening: the coupons used today are spent, and every purchase today by a
# household in the audience of an offer running today is logged against it.
offers_evening <- function() {
  ofr$logged <<- day
  paid <- which(d$outcome == 1L)
  if (!length(paid)) return(invisible())
  used <- paid[d$coupon_from[paid] > 0L]
  for (k in unique(d$coupon_from[used])) {
    h <- d$hh[used[d$coupon_from[used] == k]]
    ofr$used[[k]][ofr$slot[[k]][h]] <<- day
  }
  rows <- offer_buys(d, paid, day)
  n <- ofr$n_buys; r <- dim(rows)[1L]
  if (!r) return(invisible())
  if (n + r > dim(ofr$buys)[1L]) ofr$buys <<- rbind(ofr$buys, matrix(0, max(r, dim(ofr$buys)[1L]), length(BUY_COLS)))
  ofr$buys[n + seq_len(r), ] <<- rows
  ofr$n_buys <<- n + r
}

# The purchases (paid visits `paid` of the day's visits `dv`, on day `t`)
# by households in the audiences of the offers running that day, or of
# offer `only`: one row each (BUY_COLS), with what its coupon took off
# when the coupon was the offer's.
offer_buys <- function(dv, paid, t, only = NULL) {
  out <- matrix(0, 0, length(BUY_COLS), dimnames = list(NULL, BUY_COLS))
  for (k in if (is.null(only)) offers_live(t) else only) {
    slot <- ofr$slot[[k]]
    if (is.null(slot) || !length(paid)) next
    pos <- slot[dv$hh[paid]]
    v <- paid[pos > 0L]
    if (!length(v)) next
    out <- rbind(out, cbind(k, pos[pos > 0L], dv$brand[v], t, dv$sales[v], dv$sales[v] - dv$cogs[v],
                            ifelse(dv$coupon_from[v] == k, dv$coupon_saved[v], 0)))
  }
  out
}

# The offers household h holds now: sent, not used, running today.
offers_held <- function(h) {
  k <- offers_live()
  k[vapply(k, function(i) { p <- ofr$slot[[i]][h]; p > 0L && ofr$sent[[i]][p] && ofr$used[[i]][p] == 0L }, TRUE)]
}

# ---- What the log says ---------------------------------------------------------------

# The purchases logged against offer k, and, while it runs, today's so
# far (logged in the evening).
offer_purchases <- function(k, rd = report_day()) {
  L <- ofr$buys[seq_len(ofr$n_buys), , drop = FALSE]
  L <- L[L[, "offer"] == k, , drop = FALSE]
  if (rd$day > ofr$logged && rd$day >= OFFERS$from[k] && rd$day <= OFFERS$to[k]) {
    L <- rbind(L, offer_buys(rd$d, which(rd$d$outcome == 1L), rd$day, only = k))
  }
  L
}

# The difference between two groups' means, with a 95% interval (Welch).
diff_ci <- function(x, a, b) {
  na <- sum(a); nb <- sum(b)
  if (na < 2 || nb < 2) return(list(diff = NA, lo = NA, hi = NA, treated = if (na) mean(x[a]) else NA, control = if (nb) mean(x[b]) else NA))
  ma <- mean(x[a]); mb <- mean(x[b])
  se <- sqrt(stats::var(x[a]) / na + stats::var(x[b]) / nb)
  list(diff = ma - mb, lo = ma - mb - 1.96 * se, hi = ma - mb + 1.96 * se, treated = ma, control = mb)
}

# Offer k, as measured so far: its state, audience, coupons used, and what
# the households sent it did against those held out, per household over
# the offer's days (to today, while it runs), at the brands its coupon is
# good at (the brand, and any other it names): spend, how many bought,
# margin (sales less cost of goods); and from those, its extra sales and
# extra margin (less what sending cost). With `detail`, also: spend per
# household day by day, the difference by tier, and where the extra spend
# came from (every brand, the net for our family).
offer_results <- function(k, rd = report_day(), detail = FALSE) {
  b <- OFFERS$brand[k]
  o <- OFFERS[k, ]
  done <- days_complete()
  state <- if (!ofr$drawn[k]) "planned" else if (done >= o$to) "closed" else "running"
  base <- list(offer = k, id = o$id, name = o$name, from = o$from, to = o$to, depth = o$depth, send_cost = o$send_cost,
               audience = o$audience, holdout = o$holdout, state = state,
               tiers = I(TIER_NAMES[[b]][OFFER_TIERS[k, seq_len(TIER_N[b])]]),
               areas = I(if (length(OFFER_AREAS[[k]])) AREAS$name[OFFER_AREAS[[k]]] else character()),
               also_at = I(BRANDS$name[OFFER_GOOD[k, ] & seq_len(N_BRANDS) != b]))
  if (state == "planned") return(base)
  sent <- ofr$sent[[k]]; held <- !sent; m <- length(sent)
  L <- offer_purchases(k, rd)
  per <- matrix(bin_sum((L[, "brand"] - 1) * m + L[, "member"], L[, "sales"], m * N_BRANDS), m, N_BRANDS)
  good <- OFFER_GOOD[k, ]
  own <- good[L[, "brand"]]
  margin <- bin_sum(L[own, "member"], L[own, "margin"], m)
  bought <- tabulate(L[own, "member"], m) > 0
  at <- .rowSums(per[, good, drop = FALSE], m, sum(good))
  spend <- diff_ci(at, sent, held); gm <- diff_ci(margin, sent, held); conv <- diff_ci(as.numeric(bought), sent, held)
  n_sent <- sum(sent)
  cost <- o$send_cost * n_sent
  out <- c(base, list(
    measured_to = min(o$to, rd$day), sent = n_sent, held_out = sum(held), used = sum(ofr$used[[k]] > 0L), send_total = cost,
    discount = sum(L[, "coupon"]),
    spend = spend, conversion = conv, margin = gm,
    lift = if (isTRUE(spend$control > 0)) spend$treated / spend$control - 1 else NA,
    extra_sales = spend$diff * n_sent, extra_margin = gm$diff * n_sent - cost))
  if (!detail) return(out)
  days <- seq(o$from, out$measured_to)
  daily <- function(g) {
    s <- bin_sum(L[own & g[L[, "member"]], "day"] - o$from + 1, L[own & g[L[, "member"]], "sales"], length(days))
    cumsum(s) / max(1, sum(g))
  }
  tiers <- ofr$tier[[k]]
  by_tier <- lapply(which(OFFER_TIERS[k, seq_len(TIER_N[b])]), function(t) {
    x <- diff_ci(at, sent & tiers == t, held & tiers == t)
    c(list(tier = TIER_NAMES[[b]][t], sent = sum(sent & tiers == t), held_out = sum(held & tiers == t)), x)
  })
  rel <- function(j) if (j == b) "self" else if (BRANDS$family[j] == BRANDS$family[b]) "sister" else "competitor"
  c(out, list(
    days = I(days), sent_curve = I(daily(sent)), held_curve = I(daily(held)), by_tier = by_tier,
    sources = list(rows = lapply(seq_len(N_BRANDS), function(j) c(list(brand = j, relation = rel(j), good = OFFER_GOOD[k, j]), diff_ci(per[, j], sent, held))),
                   family = diff_ci(.rowSums(per[, OURS_B, drop = FALSE], m, sum(OURS_B)), sent, held),
                   total = diff_ci(.rowSums(per, m, N_BRANDS), sent, held))))
}
