# Inside the stores: every shopper in every store, on one clock.
#
# The time design. Every activity gets its exact start and end times when it
# begins: walking to a rack, browsing, waiting in a queue, trying on,
# paying. The simulation advances in steps of STEP_S seconds of store time,
# and each step handles, in time order, every decision that falls due within
# it: what a shopper picks off the rack (first come, first served for the
# last unit of a size), and who joins which queue. What the page draws is
# placed from those exact times, at whatever pace the run goes, and drawing
# never draws random numbers, so a season comes out the same whether it's
# run day by day or watched second by second.
#
# A household returning items comes in, walks to the tills, queues however
# long the queue is, and a cashier takes the items back (returns.R): the
# refund is a job in the staff log, like an assistant's.

# Leg kinds: what a shopper is doing from t0 to t1.
WALK <- 1L; BROWSE <- 2L; WAIT_FR <- 3L; WAIT_TILL <- 4L; TRY <- 5L; PAY <- 6L; REFUND <- 7L
# A leg's look on the floor: browsing, carrying items, queuing, trying on,
# paying, leaving empty-handed, leaving with a bag, returning items.
LOOKS <- c("browsing", "carrying", "queuing", "trying on", "paying", "leaving empty-handed", "leaving with a bag", "returning items")
LOOK_RETURNING <- 8L
# Pending decisions.
EV_MOVE <- 1L; EV_FR <- 2L; EV_TILL <- 3L

# Queues of every store in one table, a row each: fitting rooms of stores
# 1..N, then tills, then assistants (who serve a shopper by fetching a size
# or advising). A queue's servers are numbered: fitting room k, cashier k at
# till k, assistant k; the logs record which one served each shopper.
FR_ROW <- 0L; TILL_ROW <- NULL; STAFF_ROW <- NULL     # set with the world (world_install)
MAX_SERVERS <- 6L                                     # set from the layouts (build_floors)
JOB_ADVISE <- 1L; JOB_FETCH <- 2L; JOB_REFUND <- 3L      # an assistant's jobs; a cashier's refunds

servers_of <- function() c(S$fitting_rooms, S$cashiers, S$assistants)

new_queues <- function() {
  servers <- servers_of()
  free <- matrix(Inf, 3L * N_STORES, MAX_SERVERS)
  free[col(free) <= servers] <- 0
  list(free = free, held = matrix(0, 3L * N_STORES, MAX_SERVERS),
       waiting = integer(), since = numeric(), until = numeric())
}

# Opens or closes servers in a store from time `t` on: a server that closes
# finishes whoever it's serving; one that reopens starts when it's free.
resize_queue <- function(row, n, t) {
  k <- seq_len(MAX_SERVERS)
  open <- is.finite(queues$free[row, ])
  closing <- open & k > n
  opening <- !open & k <= n
  if (any(closing)) {
    queues$held[row, closing] <<- queues$free[row, closing]
    queues$free[row, closing] <<- Inf
  }
  if (any(opening)) queues$free[row, opening] <<- pmax(t, queues$held[row, opening])
}

# ---- A step --------------------------------------------------------------------

# One step of store time, [s0, s1): the decisions due within it, in time
# order. Shoppers leaving a rack go first (what they pick, and where they go
# next); then everyone reaching a queue joins it, in the order they reach it,
# including those who left a rack earlier in this step. No decision can lead
# to another of the same shopper within the step (a rack takes at least
# MIN_BROWSE_S, a try-on longer), so as long as the step is no longer than
# that, every decision is taken in time order; `late` counts any that weren't.
#
# Only decisions that compete need putting in order: two shoppers after the
# same size in the same store, or joining the same queue. take() and
# join_queue() sort those by time; everything else is handled in the order
# of the visits, which is as good and much cheaper.
run_step <- function(s0, s1) {
  if (s0 %% 3600 == 0) reshelve()
  if (s0 %% 7200 == 0 && s0 > 0) refill_floor()   # staff bring stock out from the stockroom every two hours
  if (s0 %% 300 == 0) sample_queues(s0)
  if (s0 %% ONLINE_BATCH_S == 0 && d$on_next <= length(d$on_order)) online_step(s0)   # online visits (online.R)
  # Shoppers inside a store, and those arriving this step: only they can
  # have a decision due (arrivals come off a list sorted by time).
  k <- d$next_in
  while (k <= length(d$by_arrival) && d$arrive[d$by_arrival[k]] < s1) k <- k + 1L
  if (k > d$next_in) {
    d$active <<- c(d$active, d$by_arrival[d$next_in:(k - 1L)])
    d$next_in <<- k
  }
  a <- d$active
  if (!length(a)) return(invisible())
  ev <- d$ev_at[a]
  gone <- ev == Inf
  if (any(gone)) { a <- a[!gone]; ev <- ev[!gone]; d$active <<- a }
  due <- a[ev < s1]
  if (!length(due)) return(invisible())
  d$late <<- d$late + sum(d$ev_at[due] < s0)
  moving <- d$ev_kind[due] == EV_MOVE
  queuing <- due[!moving]
  if (any(moving)) {
    sent <- on_move(due[moving])
    queuing <- c(queuing, sent[d$ev_at[sent] < s1])
  }
  if (length(queuing)) on_join(queuing)
  if (length(exits$v)) {
    leave(exits$v, exits$t0, exits$outcome)
    exits <<- list(v = integer(), t0 = numeric(), outcome = integer())
  }
}

# Shoppers finishing at a rack (or just coming in): what they pick, then
# where they go next. Returns those who head for a queue.
on_move <- function(a) {
  e <- d$ev_at[a]
  depart <- e
  d$events <<- d$events + length(a)
  fresh <- d$zi[a] == 0L
  if (any(fresh)) vlog_add(a[fresh], e[fresh], EV_CAME)
  p <- which(!fresh)
  if (length(p)) depart[p] <- pick_items(a[p], e[p])

  more <- d$zi[a] < d$n_zones[a]
  m <- a[more]
  if (length(m)) {
    d$zi[m] <<- d$zi[m] + 1L
    cat <- d$zone[cbind(m, d$zi[m])]
    f <- d$format[m]
    to <- fl$zone_first[cbind(f, cat)] + as.integer(runif(length(m)) * fl$zone_n[cbind(f, cat)])
    walk <- fl$walk_m[cbind(d$at[m], to)] / d$speed[m]
    browse <- rlnorm(length(m), log(SEGMENTS$browse[d$seg[m]]) - 0.125, 0.5)
    browse[browse < MIN_BROWSE_S] <- MIN_BROWSE_S
    t0 <- depart[more]
    k <- length(m)
    look <- 1L + (d$items[m] > 0)
    add_legs(c(m, m), rep(c(WALK, BROWSE), each = k), c(t0, t0 + walk), c(t0 + walk, t0 + walk + browse),
             c(d$at[m], to), c(to, to), c(look, look))
    d$at[m] <<- to
    d$ev_at[m] <<- t0 + walk + browse
  }
  done <- which(!more)
  if (!length(done)) return(integer())
  v <- a[done]; t0 <- depart[done]
  buy <- d$items[v] > 0
  none <- which(!buy)
  if (length(none)) {
    reason <- 2L + d$too_dear[v[none]]                  # nothing appealed, or too expensive
    reason[d$missed_size[v[none]]] <- 4L                 # not in my size
    leave_later(v[none], t0[none], reason)
  }
  b <- which(buy)
  if (!length(b)) return(integer())
  try <- d$n_try[v[b]] > 0
  f <- d$format[v[b]]
  go_to(v[b], t0[b], ifelse_int(try, fl$fr_head[f], fl$till_head[f]), ifelse_int(try, EV_FR, EV_TILL), ifelse_int(d$ret[v[b]], LOOK_RETURNING, 2L))
  v[b]
}

# Each shopper at a rack picks the product that appeals most, if any does
# and they can afford it, in their size: from the rack, first come first
# served, or from the stockroom if an assistant is free to fetch it (the
# farther the stockroom door, the longer the fetch). Some ask a free
# assistant for advice. Returns when each leaves the rack.
#
# A product appeals by the shopper's taste on the day (a random draw), its
# hidden popularity, its price today against the category's typical price
# (calendar.R: markdowns, promotions, a coupon), and the pull of a marked-
# down price; it's taken if that clears the bar.
pick_items <- function(v, e) {
  n <- length(v)
  cat <- d$zone[cbind(v, d$zi[v])]
  store <- d$store[v]; brand <- d$brand[v]
  K <- N_SLOT
  prod <- PROD_SLOT[cbind(rep(brand, K), rep(cat, K), rep(seq_len(K), each = n))]   # n x K, the category's products
  none <- prod == 0L
  prod[none] <- 1L
  dim(prod) <- c(n, K)
  bs <- (as.vector(prod) - 1L) * N_BRANDS + brand       # brand x product tables, indexed linearly
  rp <- rack_price(v, prod)
  full <- rp$full; md <- rp$md; off <- rp$off; price <- rp$price
  relative <- price / TYPICAL_PRICE[cat]                              # against the category's typical price
  psens <- SEGMENTS$price[d$seg[v]]
  taste <- matrix(gumbel(n * K), n) + matrix(pop[bs], n)
  U <- taste - PICK_W * psens * log(relative) + MARKDOWN_W * matrix(md, n) - PICK_BAR
  U[!matrix(launched[bs], n) | none] <- -Inf                          # not in the stores yet, or no such product
  left <- d$budget[v] - d$spent[v]
  afford <- price <= left
  best <- row_max(ifelse_mat(afford, U, -Inf))
  want <- best$max > 0
  top <- row_max(U)
  liked <- top$max > 0
  # The chance, before the day's taste, of taking anything from this rack:
  # every product in the stores they can afford, against the bar.
  V <- exp(matrix(pop[bs], n) - PICK_W * psens * log(relative) + MARKDOWN_W * matrix(md, n) - PICK_BAR)
  V[!is.finite(U) | !afford] <- 0
  chance <- 1 - exp(-.rowSums(V, n, K))
  dear <- which(!want & liked)
  if (length(dear)) {
    d$too_dear[v[dear]] <<- TRUE
    cheapest <- row_max(-ifelse_mat(U[dear, , drop = FALSE] > 0, price[dear, , drop = FALSE], Inf))
    vlog_add(v[dear], e[dear], EV_TOO_DEAR, cat[dear], -cheapest$max, left[dear], prod[cbind(dear, cheapest$k)])
  }
  meh <- which(!want & !liked)
  if (length(meh)) {
    near <- is.finite(top$max[meh])
    vlog_add(v[meh], e[meh], EV_NOTHING, cat[meh], ifelse_int(near, prod[cbind(meh, top$k[meh])], 0L), ifelse(near, top$max[meh], 0))
  }

  depart <- e
  # Asking a free assistant for advice (they don't wait for one).
  ask <- which(runif(n) < ADVISE_P & S$assistants[store] > 0)
  if (length(ask)) {
    q <- join_queue(STAFF_ROW + store[ask], e[ask], ADVISE_S, Inf, 0)
    helped <- q$status == 1L
    h <- ask[helped]
    if (length(h)) {
      d$advised[v[h]] <<- pmax(d$advised[v[h]], S$skill[store[h]])
      depart[h] <- e[h] + ADVISE_S
      add_legs(v[h], BROWSE, e[h], depart[h], d$at[v[h]], d$at[v[h]], 1L + (d$items[v[h]] > 0))
      staff_add(store[h], e[h], depart[h], d$at[v[h]], q$server[helped], JOB_ADVISE, v[h])
      vlog_add(v[h], e[h], EV_ADVISED, q$server[helped])
    }
  }

  w <- which(want & d$items[v] < MAX_ITEMS)
  if (!length(w)) return(depart)
  sku <- (prod[cbind(w, best$k[w])] - 1L) * N_SIZES + d$size[v[w]]
  got <- take("rack", store[w], sku, e[w])
  miss <- which(!got)
  if (length(miss)) {
    add_units("missed", store[w][miss], sku[miss], 1)
    in_room <- stock$room[cbind(store[w][miss], sku[miss])] > 0
    ask <- miss[in_room & S$assistants[store[w][miss]] > 0]
    if (length(ask)) {
      dur <- fetch_time(d$at[v[w][ask]])                   # to the stockroom door and back (floors.R)
      q <- join_queue(STAFF_ROW + store[w][ask], depart[w][ask], dur, Inf, 0)
      helped <- q$status == 1L
      fetch <- ask[helped]
      if (length(fetch)) {
        got[fetch] <- take("room", store[w][fetch], sku[fetch], depart[w][fetch])
        f <- w[fetch]
        t1 <- depart[f] + dur[helped]
        add_legs(v[f], BROWSE, depart[f], t1, d$at[v[f]], d$at[v[f]], 1L + (d$items[v[f]] > 0))
        staff_add(store[f], depart[f], t1, d$at[v[f]], q$server[helped], JOB_FETCH, v[f])
        vlog_add(v[f][got[fetch]], depart[f][got[fetch]], EV_FETCHED, sku[fetch][got[fetch]], q$server[helped][got[fetch]])
        depart[f] <- t1
      }
    }
    lost <- which(!got)
    if (length(lost)) {
      d$missed_size[v[w][lost]] <<- TRUE
      vlog_add(v[w][lost], e[w][lost], EV_NO_SIZE, sku[lost])
    }
  }
  today$size_req <<- today$size_req + tabulate(store[w], N_STORES)
  today$size_fill <<- today$size_fill + tabulate(store[w][got], N_STORES)
  g <- which(got)
  if (length(g)) {
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
    d$n_try[vv] <<- d$n_try[vv] + TRY_ON[cat[w][g]]
    vlog_add(vv, e[w][g], EV_PICKED, sku[g], paid, best$max[w][g], chance[w][g], full[at])
  }
  depart
}

ifelse_mat <- function(test, yes, no) { yes[!test] <- no; yes }

# The price of products `prod` (a matrix, a row per visit v) to each
# shopper at the rack today (calendar.R): full price (list price x the
# brand's price change), less its markdown in force, less the promotion
# reaching the shopper on it, less their coupon.
rack_price <- function(v, prod) {
  n <- length(v); K <- dim(prod)[2L]
  bs <- (as.vector(prod) - 1L) * N_BRANDS + d$brand[v]
  full <- matrix(cat_price[bs], n)
  md <- markdown[bs]
  off <- matrix(d$promo_off[cbind(rep(d$promo_row[v], K), as.vector(prod))], n)
  disc <- (1 - off) * (1 - d$coupon[v])
  list(full = full, md = md, off = off, price = full * (1 - md) * disc)
}

# Takes one unit of each (store, sku) asked for (at times t) from stock$rack
# or stock$room, first come first served, while the stock lasts. Returns
# who got one.
take <- function(where, store, sku, t) {
  got <- rank_within((store - 1L) * N_SKU + sku, t) <= stock[[where]][cbind(store, sku)]
  if (any(got)) add_units(where, store[got], sku[got], -1)
  got
}

# Adds `n` to stock[[where]] for each (store, sku) listed.
add_units <- function(where, store, sku, n) {
  key <- (store - 1L) * N_SKU + sku
  k <- unique(key)
  idx <- cbind((k - 1L) %/% N_SKU + 1L, (k - 1L) %% N_SKU + 1L)
  stock[[where]][idx] <<- stock[[where]][idx] + n * tabulate(match(key, k), length(k))
}

# Walks to a queue's head, where the shopper joins it (decision `kind`) at the
# time they arrive.
go_to <- function(v, t0, to, kind, look = 2L) {
  if (!length(v)) return(invisible())
  walk <- fl$walk_m[cbind(d$at[v], to)] / d$speed[v]
  add_legs(v, WALK, t0, t0 + walk, d$at[v], to, look)
  d$at[v] <<- to
  d$ev_at[v] <<- t0 + walk
  d$ev_kind[v] <<- kind
}

# Visits ending at t0 (after paying, or not): they walk out at the end of
# the step, all at once. Nothing else in the step depends on it.
leave_later <- function(v, t0, outcome) {
  if (!length(v)) return(invisible())
  exits$v <<- c(exits$v, v)
  exits$t0 <<- c(exits$t0, rep_len(t0, length(v)))
  exits$outcome <<- c(exits$outcome, rep_len(outcome, length(v)))
}

# Walks out by the nearest door, and the visit ends. Anything still carried
# goes back to be reshelved.
leave <- function(v, t0, outcome) {
  door <- fl$exit_to[d$at[v]]
  walk <- fl$walk_m[cbind(d$at[v], door)] / d$speed[v]
  add_legs(v, WALK, t0, t0 + walk, d$at[v], door, ifelse_int(outcome == 1L, 7L, 6L))
  d$outcome[v] <<- outcome
  d$outcome_at[v] <<- t0
  d$gone[v] <<- t0 + walk
  d$ev_at[v] <<- Inf
  vlog_add(v, t0 + walk, EV_LEFT, outcome)
  back <- v[outcome != 1L]
  if (length(back)) {
    held <- d$basket[back, , drop = FALSE]
    if (any(held > 0)) add_units("go_back", rep(d$store[back], MAX_ITEMS)[held > 0], held[held > 0], 1)
    d$basket[back, ] <<- 0L
    d$paid_for[back, ] <<- 0
    d$items[back] <<- 0L
    d$n_try[back] <<- 0L
  }
}

# Staff put go-backs out again on the hour.
reshelve <- function() {
  stock$rack <<- stock$rack + stock$go_back
  stock$go_back[] <<- 0
}

# Shoppers reaching the fitting rooms or the tills, in the order they reach
# them: they join, and are served, balk or give up (see join_queue). A
# household returning items waits however long it takes.
on_join <- function(b) {
  j <- d$ev_at[b]
  d$events <<- d$events + length(b)
  fr <- d$ev_kind[b] == EV_FR
  ret <- d$ret[b]
  seg <- d$seg[b]; s <- d$store[b]
  dur <- ifelse_int(fr, TRY_BASE_S + S$try_s[s] * d$n_try[b], PAY_BASE_S + S$scan_s[s] * d$items[b])
  dur[ret] <- REFUND_BASE_S + REFUND_ITEM_S * d$items[b[ret]]
  limit <- pmin(SEGMENTS$max_ahead[seg], ifelse_int(fr, S$max_fr_q[s], S$max_till_q[s]))
  patience <- SEGMENTS$patience[seg]
  limit[ret] <- Inf; patience[ret] <- Inf
  q <- join_queue(s + TILL_ROW * !fr, j, dur, limit, patience)
  served <- q$status == 1L
  end <- q$start + dur
  vlog_add(b, j, ifelse_int(fr, EV_FR_JOINED, EV_TILL_JOINED) + ifelse_int(q$status == 2L, 1L, 0L), q$ahead, ifelse(ret, 0, limit))   # 0: no limit

  # Those who balk leave at once; those who give up stand in the queue
  # until their patience runs out. Either way they leave it all behind.
  gave_up <- q$status == 3L
  if (any(gave_up)) {
    g <- which(gave_up)
    t1 <- j[g] + SEGMENTS$patience[seg[g]]
    add_legs(b[g], WAIT_FR + !fr[g], j[g], t1, d$at[b[g]], d$at[b[g]], 3L)
    vlog_add(b[g], t1, ifelse_int(fr[g], EV_FR_GAVE_UP, EV_TILL_GAVE_UP), SEGMENTS$patience[seg[g]], q$start[g] - j[g])
  }
  lost <- which(!served)
  if (length(lost)) leave_later(b[lost], j[lost] + gave_up[lost] * SEGMENTS$patience[seg[lost]], 5L + 2L * !fr[lost])

  sv <- which(served)
  if (!length(sv)) return(invisible())
  f <- d$format[b[sv]]
  place <- ifelse_int(fr[sv], fl$cubicle_first[f], fl$till_first[f]) + q$server[sv] - 1L
  rs <- ret[sv]
  add_legs(c(b[sv], b[sv]), c(WAIT_FR + !fr[sv], ifelse_int(rs, REFUND, TRY + !fr[sv])),
           c(j[sv], q$start[sv]), c(q$start[sv], end[sv]), c(d$at[b[sv]], place), c(d$at[b[sv]], place),
           c(rep(3L, length(sv)), ifelse_int(rs, LOOK_RETURNING, 4L + !fr[sv])))
  d$at[b[sv]] <<- place
  d$wait[b[sv]] <<- d$wait[b[sv]] + (q$start[sv] - j[sv])
  tried <- sv[fr[sv]]
  if (length(tried)) after_trying(b[tried], end[tried])
  paid <- sv[!fr[sv] & !rs]
  if (length(paid)) pay(b[paid], end[paid])
  back <- sv[rs]
  if (length(back)) refund(b[back], q$start[back], end[back], q$server[back], place[match(back, sv)])
}

# Each item tried on is kept or not (advice from an assistant makes a
# keeper likelier); what isn't goes back. With anything
# left, the shopper heads for the tills.
after_trying <- function(s, end) {
  held <- d$basket[s, , drop = FALSE]
  tried <- held > 0 & TRY_ON[sku_category(held + (held == 0L), rep(d$brand[s], MAX_ITEMS))]
  keep_p <- pmin(0.95, KEEP_P + ADVISE_KEEP * d$advised[s])
  drop <- tried & matrix(runif(length(held)) > keep_p, length(s))
  n_tried <- .rowSums(tried, length(s), MAX_ITEMS)
  if (any(drop)) {
    add_units("go_back", rep(d$store[s], MAX_ITEMS)[drop], held[drop], 1)
    held[drop] <- 0L
    pf <- d$paid_for[s, , drop = FALSE]; pf[drop] <- 0
    d$spent[s] <<- d$spent[s] - .rowSums(d$paid_for[s, , drop = FALSE] * drop, length(s), MAX_ITEMS)
    d$paid_for[s, ] <<- pf
    d$basket[s, ] <<- held
  }
  d$items[s] <<- as.integer(.rowSums(held > 0, length(s), MAX_ITEMS))
  d$n_try[s] <<- 0L
  vlog_add(s, end, EV_TRIED, n_tried, n_tried - .rowSums(drop, length(s), MAX_ITEMS))
  d$tried[s] <<- TRUE
  keep <- d$items[s] > 0
  f <- d$format[s[keep]]
  go_to(s[keep], end[keep], fl$till_head[f], EV_TILL)
  leave_later(s[!keep], end[!keep], 6L)
}

# Paying: the receipt, the stock sold, a ledger line for each item (tried
# on in the fitting room, or not: returns.R), and what it means for the
# household.
pay <- function(v, end) {
  held <- d$basket[v, , drop = FALSE]
  n <- length(v)
  sold <- held > 0
  add_units("sold", rep(d$store[v], MAX_ITEMS)[sold], held[sold], 1)
  saved <- settle_sale(v, KIND_UNTRIED, day, tried = d$tried[v])
  vlog_add(v, end, EV_PAID, d$units[v], d$sales[v], .rowSums(saved$md, n, MAX_ITEMS), .rowSums(saved$promo, n, MAX_ITEMS), d$coupon_saved[v])
  leave_later(v, end, 1L)
}

# Returning: a cashier takes back what each household brought (returns.R:
# the refund, and the unit back in stock or written off), a job from t0 to
# t1 at their till (anchor `till`), in the staff log.
refund <- function(v, t0, t1, server, till) {
  lines <- d$ret_lines[v]
  book_returns(unlist(lines), rep(d$store[v], lengths(lines)))
  staff_add(d$store[v], t0, t1, till, server, JOB_REFUND, v)
  amount <- vapply(lines, function(x) sum(ledger$m[x, "paid"]), 0)
  first <- vapply(lines, `[`, 0L, 1L)
  vlog_add(v, t1, EV_RETURNED, d$items[v], amount, ledger$i[first, "sku"], ledger$i[first, "reason"], server)
  d$items[v] <<- 0L
  leave_later(v, t1, OUT_RETURNED)
}

# ---- Queues ---------------------------------------------------------------------

# Shoppers joining queues `res` at times `t`, each needing `dur` seconds of
# service. Each takes the server that frees first, in the order they
# arrive, unless `max_ahead` or more are already waiting (they balk: status
# 2) or the wait would be longer than `patience` (they stand in the queue
# that long and give up: status 3). Joiners of different queues don't
# interact, so each round handles one joiner per queue at once.
join_queue <- function(res, t, dur, max_ahead, patience) {
  n <- length(res)
  dur <- rep_len(dur, n); max_ahead <- rep_len(max_ahead, n); patience <- rep_len(patience, n)
  keep <- queues$until > min(t)                # no one who stops waiting before now counts again
  if (!all(keep)) {
    queues$waiting <<- queues$waiting[keep]
    queues$since <<- queues$since[keep]
    queues$until <<- queues$until[keep]
  }
  rank <- rank_within(res, t)
  start <- numeric(n); server <- integer(n); status <- integer(n); ahead_all <- integer(n)
  rounds <- max(rank)
  for (r in seq_len(rounds)) {
    i <- if (rounds == 1L) seq_len(n) else which(rank == r)
    ri <- res[i]; ti <- t[i]
    free <- row_max(-queues$free[ri, , drop = FALSE])
    k <- free$k
    st <- -free$max
    closed <- !is.finite(st)                   # no server open at all
    later <- ti > st
    st[later] <- ti[later]
    w <- length(queues$waiting)
    ahead <- if (w) {
      m <- length(i)
      .rowSums(matrix(ri, m, w) == rep(queues$waiting, each = m) & matrix(ti, m, w) < rep(queues$until, each = m), m, w)
    } else 0
    balk <- ahead >= max_ahead[i] | closed
    wait_out <- !balk & st - ti > patience[i]
    ok <- !balk & !wait_out
    if (any(ok)) queues$free[cbind(ri[ok], k[ok])] <<- st[ok] + dur[i][ok]
    if (!all(balk)) {
      until <- ti + patience[i]
      until[ok] <- st[ok]
      queues$waiting <<- c(queues$waiting, ri[!balk])
      queues$since <<- c(queues$since, ti[!balk])
      queues$until <<- c(queues$until, until[!balk])
    }
    start[i] <- st; server[i] <- k; ahead_all[i] <- ahead
    status[i] <- 1L + balk + 2L * wait_out
  }
  list(start = start, server = server, status = status, ahead = ahead_all)
}

# Every 5 minutes: how many stand in each store's fitting-room and till
# queues (for the queue charts).
sample_queues <- function(t) {
  bin <- t / 300 + 1
  if (bin > dim(today$fr_q)[2L]) return(invisible())
  on <- queues$since <= t & queues$until > t
  w <- queues$waiting[on]
  today$fr_q[, bin] <<- tabulate(w[w <= N_STORES], N_STORES)
  today$till_q[, bin] <<- tabulate(w[w > N_STORES & w <= 2L * N_STORES] - N_STORES, N_STORES)
}

# ---- Legs: what every shopper does, from when to when -------------------------

# One row per leg of a shopper's visit: a walk from anchor a to anchor b,
# browsing at a, waiting in a queue, trying on in cubicle a, paying at till
# a; and how it looks on the floor. A matrix with room to spare, since legs
# are added at every decision.
LEG_FIELDS <- c("visit", "store", "kind", "t0", "t1", "a", "b", "look")
new_legs <- function(capacity) list(n = 0L, m = matrix(0, capacity, length(LEG_FIELDS), dimnames = list(NULL, LEG_FIELDS)))

add_legs <- function(v, kind, t0, t1, a, b, look) {
  k <- length(v)
  if (!k) return(invisible())
  n <- legs$n
  cap <- dim(legs$m)[1L]
  if (n + k > cap) legs$m <<- rbind(legs$m, matrix(0, max(k, cap), length(LEG_FIELDS)))
  legs$m[n + seq_len(k), ] <<- cbind(v, d$store[v], kind, t0, t1, a, b, look)
  legs$n <<- n + k
}

# Staff's jobs beside the tills' sales: a row per job (an assistant
# advising, or fetching a size from the stockroom; a cashier taking returns
# back), where and when, which assistant or cashier, and for which visit.
STAFF_FIELDS <- c("store", "t0", "t1", "anchor", "server", "job", "visit")
new_staff_log <- function() list(n = 0L, m = matrix(0, 2000, length(STAFF_FIELDS), dimnames = list(NULL, STAFF_FIELDS)))

staff_add <- function(store, t0, t1, anchor, server, job, visit) {
  k <- length(store)
  if (!k) return(invisible())
  n <- staff$n
  cap <- dim(staff$m)[1L]
  if (n + k > cap) staff$m <<- rbind(staff$m, matrix(0, max(k, cap), length(STAFF_FIELDS)))
  staff$m[n + seq_len(k), ] <<- cbind(store, t0, t1, anchor, server, job, visit)
  staff$n <<- n + k
}

# The story of each visit: what happened, when, and the numbers that
# decided it (a row per event: visit, time, the event's code and up to five
# numbers; events.R says what each event carries, and what's said about it).
VLOG_COLS <- 8L
vlog_add <- function(v, t, code, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0) {
  k <- length(v)
  if (!k) return(invisible())
  n <- vlog$n
  cap <- dim(vlog$m)[1L]
  if (n + k > cap) vlog$m <<- rbind(vlog$m, matrix(0, max(k, cap), VLOG_COLS))
  vlog$m[n + seq_len(k), ] <<- cbind(v, t, code, a1, a2, a3, a4, a5)
  vlog$n <<- n + k
}
