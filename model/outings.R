# Shopping outings: a household's whole journey, from leaving home to
# getting back, with its vehicle and its store visits.
#
#   Household -> outing -> store visits -> purchases
#
# An outing is made by a shopper on foot, or by car with the household's
# own car (vehicle id = household). A driver drives the road network
# (transport.R) to a parking facility the end user has built, takes a
# space if one is free (occupied from the moment the car arrives until it
# pulls out again), parks (finding a space, and in a garage climbing to the
# level with one), gets out (the facility's transfer time), and walks the
# pedestrian network to a store's door. Inside, the store's own floor
# simulation runs the visit (store.R). Back at the door, the shopper decides
# whether to walk on to another store or to go home: back to the same car
# at the same facility, then home. A walker walks from home and back.
#
#   home -depart-> driving -at facility-> parking -> transfer -> walking -> visit
#        -> [at the door: another store?] -> walking -> visit -> ...
#        -> walking -> transfer -> unparking (the space freed) -> driving -> home
#
# A full facility: the shopper tries the next facility that serves the
# store (driving there on the roads), while the trip still beats having
# stayed home; otherwise drives home. A household's outings run one after
# another: a shopping outing due to leave while the household's trip to
# return items is still out waits for it to get home.
#
# Another store, at the door. The shopper came out with a number of
# categories in mind (drawn in the morning, as a store visit's racks always
# were) and a taste for each that day; a visit browses those its brand
# sells that they haven't bought yet. Once they have bought in as many
# categories as they came for, or their budget is gone, they go home.
# Otherwise every store they haven't been to today, that sells something
# they still want, that they can walk to and enter before last entry, and
# that is within their radius, is weighed as in the morning (taste,
# range for what's still wanted, loyalty, price, promotions, marketing,
# memory of bad visits, today's included, word of mouth, layout, offers,
# return window) less the extra walking (to it, and from it back to the
# car or home, against going straight back), against going home (the
# appeal of staying home, plus the budget already spent: as in the morning,
# where the chance of shopping falls with the square root of the share of
# the budget left), with the day's random taste on each (a logit). The
# events are taken in time order within each step, after the store floors,
# so every space freed before a car arrives is free when it does.

OE_DEPART <- 1L; OE_AT_FAC <- 2L; OE_LEFT <- 3L; OE_HOME <- 4L
OG_SHOP <- 1L; OG_RETURN <- 2L
OUTING_ENDS <- c("went home", "got what they came for", "budget spent", "couldn't park", "too late to get there",
                 "returned items", "nothing else within reach")
END_HOME <- 1L; END_GOT <- 2L; END_BUDGET <- 3L; END_NO_PARK <- 4L; END_LATE <- 5L; END_RETURNED <- 6L; END_NOTHING <- 7L
# Legs of an outing: driving, parking (finding a space, climbing levels),
# parked (the car in its space), walking, getting between the space and
# the pedestrian exit, inside a store, unparking (leaving the space and
# the levels).
OL_DRIVE <- 1L; OL_PARK <- 2L; OL_PARKED <- 3L; OL_WALK <- 4L; OL_TRANSFER <- 5L; OL_INSIDE <- 6L; OL_UNPARK <- 7L
OL_FIELDS <- c("outing", "kind", "t0", "t1", "graph", "field", "from", "rev", "fac", "store")
PK_FIELDS <- c("fac", "outing", "vehicle", "t_in", "t_out", "level")

og <- NULL; pk <- NULL; ol <- NULL

# ---- The day's outings ---------------------------------------------------------------------

# The day's outings: shopping outings for households h to their chosen
# stores (planned door times `door`, their categories' taste CT and how
# many they want, and the margin of the store's appeal over staying home),
# and return trips (households r to stores rs with ledger lines `lines`,
# at door times r_door). Each is planned by the household's cheapest way
# there (`tc`, travel_costs()).
new_outings <- function(h, store, door, ct, n_want, margin, tc, r = integer(), rs = integer(), r_door = numeric(), lines = list(), r_tc = NULL) {
  n <- length(h) + length(r)
  H <- c(h, r); S <- c(store, rs)
  mode <- c(tc$mode[cbind(seq_along(h), store)], if (length(r)) r_tc$mode[cbind(seq_along(r), rs)])
  fac <- c(tc$fac[cbind(seq_along(h), store)], if (length(r)) r_tc$fac[cbind(seq_along(r), rs)])
  T <- city
  tile <- mk$hh$tile[H]
  # The planned journey to the door, to work out when to leave.
  pre <- numeric(n)
  drv <- mode == MODE_DRIVE
  if (any(drv)) {
    k <- fac[drv]
    pre[drv] <- fac_drive(tile[drv], k)$t + FAC$search_s[k] + FAC$transfer_s[k] + T$fw_t[cbind(k, S[drv])]
  }
  wk <- mode == MODE_WALK
  pre[wk] <- T$wf$time[cbind(tile[wk], S[wk])]
  door_t <- c(door, r_door)
  og <<- list(
    n = n, hh = H, kind = rep(c(OG_SHOP, OG_RETURN), c(length(h), length(r))), mode = mode, fac = fac, vnode = integer(n),
    dest = S, at = S, t_door = door_t, t_depart = door_t - pre, t_home = rep(NA_real_, n),
    ev_at = door_t - pre, ev_kind = rep(OE_DEPART, n), waiting = logical(n), ended = integer(n),
    n_visits = integer(n), cur_v = integer(n), first_v = integer(n), spent = numeric(n), margin = c(margin, rep(Inf, length(r))),
    ct = rbind(ct, matrix(0, length(r), N_CATS)), n_want = c(n_want, integer(length(r))), got = matrix(FALSE, n, N_CATS),
    visited = matrix(FALSE, n, N_STORES), grudge = matrix(0, n, N_BRANDS), tried = matrix(FALSE, n, max(1L, N_FAC)),
    ret_lines = c(vector("list", length(h)), lines), park_row = integer(n), parked_leg = integer(n), busy = integer(mk$hh$n), fails = integer())
  pk <<- list(n = 0L, m = matrix(0, 256, length(PK_FIELDS), dimnames = list(NULL, PK_FIELDS)), rows = vector("list", N_FAC))
  ol <<- list(n = 0L, m = matrix(0, 8L * n + 64L, length(OL_FIELDS), dimnames = list(NULL, OL_FIELDS)), route = list())
}

# The quickest drive from tiles `tile` to facilities `k` (one each): the
# time, and the node (a drivable tile at one of its vehicle entrances) it
# ends at, and that node's field.
fac_drive <- function(tile, k) {
  T <- city
  t <- rep(Inf, length(tile)); node <- integer(length(tile)); field <- integer(length(tile))
  for (f in unique(k)) {
    i <- which(k == f); cols <- which(T$vnode_fac == f)
    if (!length(cols)) next
    m <- matrix(T$vf$time[tile[i], cols, drop = FALSE], length(i))
    best <- row_max(-m)
    t[i] <- -best$max; field[i] <- cols[best$k]; node[i] <- T$vnodes[cols[best$k]]
  }
  list(t = t, node = node, field = field)
}

ol_add <- function(o, kind, t0, t1, graph = 0L, field = 0L, from = 0L, rev = 0L, fac = 0L, store = 0L) {
  k <- length(o)
  if (!k) return(integer())
  n <- ol$n; cap <- dim(ol$m)[1L]
  if (n + k > cap) ol$m <<- rbind(ol$m, matrix(0, max(k, cap), length(OL_FIELDS)))
  rows <- n + seq_len(k)
  ol$m[rows, ] <<- cbind(o, kind, t0, t1, graph, field, from, rev, fac, store)
  ol$n <<- n + k
  rows
}

pk_add <- function(fac, o, t_in, level) {
  n <- pk$n; cap <- dim(pk$m)[1L]
  if (n + 1L > cap) pk$m <<- rbind(pk$m, matrix(0, cap, length(PK_FIELDS)))
  pk$m[n + 1L, ] <<- c(fac, o, og$hh[o], t_in, Inf, level)
  pk$n <<- n + 1L
  pk$rows[[fac]] <<- c(pk$rows[[fac]], n + 1L)
  n + 1L
}

# Many cars taking spaces at once (facilities f, outings o, at times t, on levels).
pk_add_many <- function(f, o, t, level) {
  k <- length(o); n <- pk$n; cap <- dim(pk$m)[1L]
  if (n + k > cap) pk$m <<- rbind(pk$m, matrix(0, max(k, cap), length(PK_FIELDS)))
  rows <- n + seq_len(k)
  pk$m[rows, ] <<- cbind(f, o, og$hh[o], t, Inf, level)
  pk$n <<- n + k
  for (ff in unique(f)) pk$rows[[ff]] <<- c(pk$rows[[ff]], rows[f == ff])
  rows
}

# Cars in facility f at time t.
occupancy <- function(f, t) {
  r <- pk$rows[[f]]
  if (!length(r)) return(0L)
  sum(pk$m[r, "t_in"] <= t & pk$m[r, "t_out"] > t)
}

# Outings still to finish (someone not home yet, or not yet set out).
outings_pending <- function() !is.null(og) && og$n > 0L && any(is.na(og$t_home) & (is.finite(og$ev_at) | og$cur_v > 0L | og$waiting))

# ---- Each step ---------------------------------------------------------------------------------

# Every outing event due before s1, in time order (a run of events of one
# kind at a time).
outings_step <- function(s1) {
  if (is.null(og) || !og$n) return(invisible())
  repeat {
    due <- which(og$ev_at < s1)
    if (!length(due)) break
    o <- due[order(og$ev_at[due], due)]
    kind <- og$ev_kind[o]
    run <- o[seq_len(match(TRUE, kind != kind[1], nomatch = length(o) + 1L) - 1L)]
    switch(kind[1], og_depart(run), og_at_fac(run), og_left(run), og_home(run))
  }
}

og_depart <- function(o) {
  t <- og$ev_at[o]
  # One outing at a time for a household.
  first <- !duplicated(og$hh[o])
  wait <- o[!first | og$busy[og$hh[o]] > 0L]
  if (length(wait)) { og$waiting[wait] <<- TRUE; og$ev_at[wait] <<- Inf }
  o <- setdiff(o, wait); t <- og$ev_at[o]
  if (!length(o)) return(invisible())
  T <- city
  tile <- mk$hh$tile[og$hh[o]]
  drv <- og$mode[o] == MODE_DRIVE
  # Too late to reach the door before last entry: they don't go.
  pre <- numeric(length(o))
  dv <- NULL
  if (any(drv)) {
    k <- og$fac[o[drv]]
    dv <- fac_drive(tile[drv], k)
    pre[drv] <- dv$t + FAC$search_s[k] + FAC$transfer_s[k] + T$fw_t[cbind(k, og$dest[o[drv]])]
  }
  pre[!drv] <- T$wf$time[cbind(tile[!drv], og$dest[o[!drv]])]
  late <- t + pre >= LAST_ENTRY_S
  if (any(late)) og_end(o[late], t[late], END_LATE, travelled = FALSE)
  go <- !late
  og$t_depart[o[go]] <<- t[go]
  og$busy[og$hh[o[go]]] <<- o[go]
  d1 <- which(go & drv); w1 <- which(go & !drv)
  if (length(d1)) {
    j <- match(d1, which(drv))
    k <- og$fac[o[d1]]
    og$vnode[o[d1]] <<- dv$node[j]
    ol_add(o[d1], OL_DRIVE, t[d1], t[d1] + dv$t[j], 1L, dv$field[j], tile[d1], 0L, k)
    og$ev_at[o[d1]] <<- t[d1] + dv$t[j]; og$ev_kind[o[d1]] <<- OE_AT_FAC
  }
  if (length(w1)) {
    s <- og$dest[o[w1]]
    wt <- T$wf$time[cbind(tile[w1], s)]
    ol_add(o[w1], OL_WALK, t[w1], t[w1] + wt, 2L, s, tile[w1], 0L, 0L, s)
    og$ev_at[o[w1]] <<- Inf
    at_door(o[w1], s, t[w1] + wt)
  }
}

# Cars reaching their facility, in the order they arrive: a space if one
# is free, else the next facility serving the store, or home.
og_at_fac <- function(o) {
  T <- city
  door_o <- integer(); door_s <- integer(); door_t <- numeric()
  L <- list(o = integer(), kind = integer(), t0 = numeric(), t1 = numeric(), graph = integer(), field = integer(), from = integer(), rev = integer(), fac = integer(), store = integer())
  leg <- function(i, kind, t0, t1, graph = 0L, field = 0L, from = 0L, rev = 0L, fac = 0L, store = 0L) {
    n <- length(i); r <- function(x) rep_len(x, n)
    L$o <<- c(L$o, i); L$kind <<- c(L$kind, r(kind)); L$t0 <<- c(L$t0, r(t0)); L$t1 <<- c(L$t1, r(t1)); L$graph <<- c(L$graph, r(graph))
    L$field <<- c(L$field, r(field)); L$from <<- c(L$from, r(from)); L$rev <<- c(L$rev, r(rev)); L$fac <<- c(L$fac, r(fac)); L$store <<- c(L$store, r(store))
  }
  # Where a facility has room for every car reaching it in this run, they
  # all park at once (each on the level its arrival finds: the cars in at
  # that moment, and those of the run ahead of it); the cars of a facility
  # that may fill are taken one at a time, in the order they arrive.
  fac_o <- og$fac[o]
  easy <- logical(length(o))
  for (f in unique(fac_o)) {
    j <- which(fac_o == f); t <- og$ev_at[o[j]]
    r <- pk$rows[[f]]
    base <- if (length(r)) .colSums(outer(pk$m[r, "t_in"], t, "<=") & outer(pk$m[r, "t_out"], t, ">"), length(r), length(j)) else numeric(length(j))
    occ <- base + seq_along(j) - 1L
    if (all(occ < FAC$spaces[f])) easy[j] <- TRUE
  }
  if (any(easy)) {
    e <- o[easy]; t <- og$ev_at[e]; f <- og$fac[e]; s <- og$dest[e]
    occ <- integer(length(e))
    for (ff in unique(f)) {
      j <- which(f == ff); r <- pk$rows[[ff]]
      base <- if (length(r)) .colSums(outer(pk$m[r, "t_in"], t[j], "<=") & outer(pk$m[r, "t_out"], t[j], ">"), length(r), length(j)) else numeric(length(j))
      occ[j] <- base + seq_along(j) - 1L
    }
    per <- ceiling(FAC$spaces[f] / FAC$levels[f])
    level <- ifelse(FAC$kind[f] == "garage", pmin(FAC$levels[f], occ %/% per + 1), 1)
    og$park_row[e] <<- pk_add_many(f, e, t, level)
    t1 <- t + FAC$search_s[f] + (level - 1) * FAC$level_s[f]; t2 <- t1 + FAC$transfer_s[f]
    ex <- T$fw_node[cbind(f, s)]; wt <- T$fw_t[cbind(f, s)]
    k <- length(e)
    leg(e, rep(OL_PARK, k), t, t1, 0L, 0L, 0L, 0L, f, 0L)
    leg(e, rep(OL_PARKED, k), t1, rep(Inf, k), 0L, 0L, 0L, 0L, f, 0L)
    leg(e, rep(OL_TRANSFER, k), t1, t2, rep(2L, k), s, ex, 0L, f, 0L)
    leg(e, rep(OL_WALK, k), t2, t2 + wt, rep(2L, k), s, ex, 0L, f, s)
    og$ev_at[e] <<- Inf
    door_o <- c(door_o, e); door_s <- c(door_s, s); door_t <- c(door_t, t2 + wt)
  }
  for (j in which(!easy)) {
    i <- o[j]; t <- og$ev_at[i]; f <- og$fac[i]; s <- og$dest[i]
    occ <- occupancy(f, t)
    if (occ < FAC$spaces[f]) {
      per <- ceiling(FAC$spaces[f] / FAC$levels[f])
      level <- if (FAC$kind[f] == "garage") min(FAC$levels[f], occ %/% per + 1) else 1
      og$park_row[i] <<- pk_add(f, i, t, level)
      park <- FAC$search_s[f] + (level - 1) * FAC$level_s[f]
      t1 <- t + park; t2 <- t1 + FAC$transfer_s[f]
      ex <- T$fw_node[f, s]; wt <- T$fw_t[f, s]
      leg(i, OL_PARK, t, t1, fac = f)
      leg(i, OL_PARKED, t1, Inf, fac = f)
      leg(i, OL_TRANSFER, t1, t2, 2L, s, ex, 0L, f)
      leg(i, OL_WALK, t2, t2 + wt, 2L, s, ex, 0L, f, s)
      og$ev_at[i] <<- Inf
      door_o <- c(door_o, i); door_s <- c(door_s, s); door_t <- c(door_t, t2 + wt)
      next
    }
    # Full.
    og$tried[i, f] <<- TRUE
    og$fails <<- c(og$fails, f)
    h <- og$hh[i]
    mk$park_fail[h, f] <<- mk$park_fail[h, f] + 1          # remembered against it, as a bad visit is (market.R)
    kap <- SEGMENTS$km[mk$hh$segment[h]]
    node <- og$vnode[i]
    best <- 0L; best_extra <- Inf; best_dt <- NA; best_field <- 0L; best_node <- 0L
    plan <- kap * (P$park_w * (FAC$search_s[f] + FAC$transfer_s[f]) / 60 + P$walk_w * T$fw_t[f, s] / 60)
    for (k in seq_len(N_FAC)) {
      if (og$tried[i, k] || !(T$fw_m[k, s] <= P$max_walk_km * 1000)) next
      cols <- which(T$vnode_fac == k)
      if (!length(cols)) next
      tt <- T$vf$time[node, cols]
      if (!any(is.finite(tt))) next
      c1 <- which.min(tt)
      extra <- kap * (P$drive_w * tt[c1] / 60 + P$park_w * (FAC$search_s[k] + FAC$transfer_s[k]) / 60 + P$walk_w * T$fw_t[k, s] / 60) - plan
      if (extra < best_extra) { best <- k; best_extra <- extra; best_dt <- tt[c1]; best_field <- cols[c1]; best_node <- T$vnodes[cols[c1]] }
    }
    if (best > 0L && og$margin[i] - best_extra > 0) {
      og$margin[i] <<- og$margin[i] - best_extra
      leg(i, OL_DRIVE, t, t + best_dt, 1L, best_field, node, 0L, best)
      og$fac[i] <<- best; og$vnode[i] <<- best_node
      og$ev_at[i] <<- t + best_dt
      next
    }
    # Nowhere to park: home (a return trip posts its items back instead).
    if (og$kind[i] == OG_RETURN) post_returns(i)
    field <- which(T$vnodes == node & T$vnode_fac == f)[1]
    dt <- T$vf$time[mk$hh$tile[h], field]
    leg(i, OL_DRIVE, t, t + dt, 1L, field, mk$hh$tile[h], 1L, f)
    og$ended[i] <<- END_NO_PARK
    og$ev_at[i] <<- t + dt; og$ev_kind[i] <<- OE_HOME
  }
  if (length(L$o)) {
    rows <- ol_add(L$o, L$kind, L$t0, L$t1, L$graph, L$field, L$from, L$rev, L$fac, L$store)
    pr <- rows[L$kind == OL_PARKED]
    og$parked_leg[L$o[L$kind == OL_PARKED]] <<- pr
  }
  if (length(door_o)) { k <- order(match(door_o, o)); at_door(door_o[k], door_s[k], door_t[k]) }   # in the order they arrived
}

# A return trip that couldn't park: the household posts the items back.
post_returns <- function(i) post_returns_lines(og$ret_lines[[i]])

# Shoppers reaching store doors at `arrive`: a visit each (store.R takes
# it from there), or, past last entry, the door is shut to them.
at_door <- function(o, s, arrive) {
  shut <- arrive >= LAST_ENTRY_S
  if (any(shut)) {
    i <- o[shut]
    og$cur_v[i] <<- 0L; og$at[i] <<- s[shut]
    og$ended[i] <<- END_LATE
    og$ev_at[i] <<- arrive[shut]; og$ev_kind[i] <<- OE_LEFT
  }
  o <- o[!shut]; s <- s[!shut]; arrive <- arrive[!shut]
  if (!length(o)) return(invisible())
  v <- add_store_visits(o, s, arrive)
  og$visited[cbind(o, s)] <<- TRUE
  og$n_visits[o] <<- og$n_visits[o] + 1L
  og$first_v[o[og$first_v[o] == 0L]] <<- v[og$first_v[o] == 0L]
  og$cur_v[o] <<- v; og$at[o] <<- s
  og$ev_at[o] <<- Inf
}

# Visits ending (store.R, leave): the shopper is at the store's door.
outing_left <- function(v) {
  o <- d$outing[v]
  k <- o > 0L
  if (!any(k)) return(invisible())
  og$ev_at[o[k]] <<- d$gone[v[k]]; og$ev_kind[o[k]] <<- OE_LEFT
}

# At the door after a visit: what it did for the outing, then on to
# another store, or home.
og_left <- function(o) {
  t <- og$ev_at[o]; T <- city
  v <- og$cur_v[o]
  done <- v > 0L
  if (any(done)) {
    vv <- v[done]; oo <- o[done]
    ol_add(oo, OL_INSIDE, d$arrive[vv], d$gone[vv], store = d$store[vv])
    paid <- d$outcome[vv] == 1L
    og$spent[oo] <<- og$spent[oo] + d$sales[vv] * paid
    if (any(paid)) {
      held <- d$basket[vv[paid], , drop = FALSE]
      sold <- held > 0
      cat <- matrix(sku_category(held + (held == 0L), rep(d$brand[vv[paid]], MAX_ITEMS)), sum(paid))
      for (j in seq_len(MAX_ITEMS)) {
        ok <- sold[, j]
        og$got[cbind(oo[paid][ok], cat[ok, j])] <<- TRUE
      }
    }
    bad <- d$outcome[vv] %in% c(4L, 5L, 7L)
    if (any(bad)) og$grudge[cbind(oo[bad], d$brand[vv[bad]])] <<- og$grudge[cbind(oo[bad], d$brand[vv[bad]])] + 1
    og$cur_v[oo] <<- 0L
  }
  s <- og$at[o]
  next_s <- integer(length(o))
  reason <- og$ended[o]
  reason[reason == 0L & og$kind[o] == OG_RETURN] <- END_RETURNED
  ask <- which(reason == 0L)
  if (length(ask)) {
    ch <- next_stop(o[ask], s[ask], t[ask])
    next_s[ask] <- ch$store; reason[ask] <- ch$reason
  }
  on <- which(next_s > 0L)
  if (length(on)) {
    s2 <- next_s[on]
    from <- T$entrance[s[on]]
    wt <- T$wf$time[cbind(from, s2)]
    ol_add(o[on], OL_WALK, t[on], t[on] + wt, 2L, s2, from, 0L, 0L, s2)
    at_door(o[on], s2, t[on] + wt)
  }
  home <- which(next_s == 0L)
  if (length(home)) og_end(o[home], t[home], reason[home])
}

# The journey home from the door of the store each is at (or, for one who
# never set out, nothing): back to the car and home, or on foot.
og_end <- function(o, t, reason, travelled = TRUE) {
  og$ended[o] <<- ifelse_int(og$ended[o] > 0L, og$ended[o], reason)
  if (!travelled) {
    og$t_home[o] <<- t; og$ev_at[o] <<- Inf
    return(invisible())
  }
  T <- city
  s <- og$at[o]; tile <- mk$hh$tile[og$hh[o]]
  back <- numeric(length(o))
  drv <- og$mode[o] == MODE_DRIVE & og$park_row[o] > 0L
  for (j in which(drv)) {
    i <- o[j]; f <- og$fac[i]; row <- og$park_row[i]
    ex <- T$fw_node[f, s[j]]; wt <- T$fw_t[f, s[j]]
    t1 <- t[j] + wt; t2 <- t1 + FAC$transfer_s[f]
    level <- pk$m[row, "level"]
    t3 <- t2 + (level - 1) * FAC$level_s[f]
    field <- which(T$vnodes == og$vnode[i] & T$vnode_fac == f)[1]
    dt <- T$vf$time[tile[j], field]
    ol_add(i, OL_WALK, t[j], t1, 2L, s[j], ex, 1L, f, s[j])
    ol_add(i, OL_TRANSFER, t1, t2, 2L, s[j], ex, 1L, f)
    pk$m[row, "t_out"] <<- t2                          # the car pulls out of its space
    ol$m[og$parked_leg[i], "t1"] <<- t2
    ol_add(i, OL_UNPARK, t2, t3, fac = f)
    ol_add(i, OL_DRIVE, t3, t3 + dt, 1L, field, tile[j], 1L, f)
    back[j] <- t3 + dt
  }
  wk <- which(!drv)
  if (length(wk)) {
    wt <- T$wf$time[cbind(tile[wk], s[wk])]
    ol_add(o[wk], OL_WALK, t[wk], t[wk] + wt, 2L, s[wk], tile[wk], 1L, 0L, s[wk])
    back[wk] <- t[wk] + wt
  }
  og$ev_at[o] <<- back; og$ev_kind[o] <<- OE_HOME
}

og_home <- function(o) {
  t <- og$ev_at[o]
  og$t_home[o] <<- t; og$ev_at[o] <<- Inf
  h <- og$hh[o]
  og$busy[h[og$busy[h] == o]] <<- 0L
  # A household's next outing that was waiting for it leaves now.
  w <- which(og$waiting & og$hh %in% h)
  if (length(w)) {
    og$waiting[w] <<- FALSE
    og$ev_at[w] <<- pmax(og$t_depart[w], t[match(og$hh[w], h)])
    og$ev_kind[w] <<- OE_DEPART
  }
}

# Which stores can be walked to from which (within the longest walk), and
# how long it takes: worked out once per world and weights.
store_walks <- function() {
  key <- c(world_version, P$max_walk_km, N_STORES)
  if (!is.null(walks_cache) && identical(walks_cache$key, key)) return(walks_cache)
  T <- city; S <- N_STORES
  from <- rep(T$entrance, times = S); to <- rep(seq_len(S), each = S)
  t <- matrix(T$wf$time[cbind(from, to)], S); m <- matrix(T$wf$length[cbind(from, to)], S)
  near <- m <= P$max_walk_km * 1000; diag(near) <- FALSE
  walks_cache <<- list(key = key, t = t, m = m, near = near)
  walks_cache
}
walks_cache <- NULL

# ---- Another store? ---------------------------------------------------------------------------

# For outings o at the doors of stores s at times t: the next store each
# walks to (0: home), and why they go home.
next_stop <- function(o, s, t) {
  n <- length(o); T <- city
  h <- og$hh[o]; seg <- mk$hh$segment[h]
  store <- integer(n); reason <- rep(END_HOME, n)
  left <- mk$budget_left[h] - og$spent[o]
  wanted <- og$n_want[o] - .rowSums(og$got[o, , drop = FALSE], n, N_CATS)
  reason[wanted <= 0] <- END_GOT
  reason[left <= 0 & wanted > 0] <- END_BUDGET
  ask <- which(wanted > 0 & left > 0)
  if (!length(ask)) return(list(store = store, reason = reason))
  o <- o[ask]; s <- s[ask]; t <- t[ask]; h <- h[ask]; seg <- seg[ask]; m <- length(o)
  # Every store each could walk to from its door (the pairs only).
  S <- N_STORES
  near <- store_walks()$near
  pairs <- which(near[s, , drop = FALSE], arr.ind = TRUE)
  row <- pairs[, 1]; si <- pairs[, 2]
  hi <- h[row]; oi <- o[row]
  b <- STORES$brand[si]
  W <- matrix(-Inf, m, S)
  if (length(row)) {
    walk <- T$wf$time[cbind(T$entrance[s[row]], si)]
    # The walk back: to the car's facility, or home.
    drv <- og$mode[oi] == MODE_DRIVE
    back_from <- function(store) ifelse(drv, T$fw_t[cbind(pmax(og$fac[oi], 1L), store)], T$wf$time[cbind(mk$hh$tile[hi], store)])
    extra <- walk + back_from(si) - back_from(s[row])
    # Still wanted: liked categories not yet bought, by the brand.
    need <- CATEGORY_TASTE[seg, , drop = FALSE] * !og$got[o, , drop = FALSE]
    sells <- .rowSums(need[row, , drop = FALSE] * CARRIES[b, , drop = FALSE], length(row), N_CATS)
    share <- sells / .rowSums(need, m, N_CATS)[row]
    share[!is.finite(share)] <- 0
    reach <- promo_reach(h)
    pr <- promo_heard(reach)
    buzz <- buzz_of(h)
    w <- store_appeal(hi, b, si, row, pr, buzz, if (P$range_w == 0) 0 else P$range_w * log(share)) -
      P$grudge_w * TIER_MEMORY[cbind(b, mk$tier[cbind(hi, b)])] * og$grudge[cbind(oi, b)] -
      SEGMENTS$km[seg[row]] * P$walk_w * extra / 60
    ok <- !og$visited[cbind(oi, si)] & sells > 0 & is.finite(walk) & t[row] + walk < LAST_ENTRY_S &
      mk$km[cbind(hi, si)] <= SEGMENTS$radius_km[seg[row]] * TIER_RADIUS[cbind(b, mk$tier[cbind(hi, b)])] + 1e-9
    w[!ok] <- -Inf
    W[cbind(row, si)] <- w
  }
  none <- .rowSums(is.finite(W), m, S) == 0
  home <- P$outside - 0.5 * log(pmax(1e-9, (mk$budget_left[h] - og$spent[o]) / mk$hh$budget[h])) + gumbel(m)
  V <- W + matrix(gumbel(m * S), m)
  pick <- row_max(cbind(home, V))$k - 1L
  store[ask] <- pick
  reason[ask] <- ifelse_int(none, END_NOTHING, END_HOME)
  list(store = store, reason = reason)
}

# The appeal of brand b's store si to household hi, without the trip and
# the day's random taste: what the morning's choice weighs (market.R), for
# pairs (row: each pair's row in `pr` and `buzz`, the households' promotions
# heard and word of mouth). `range` is the range's value for each pair.
store_appeal <- function(hi, b, si, row, pr, buzz, range) {
  hb <- cbind(hi, b)
  tier <- mk$tier[hb]
  bt <- cbind(b, tier)
  sg <- mk$hh$segment[hi]
  price <- price_position()[b] * (1 - pr$off[cbind(row, b)]) * (1 - mk$at$coupon[hb])
  P$taste_w * mk$hh$taste[hb] + range + TIER_PULL[bt] - P$price_w * SEGMENTS$price[sg] * TIER_PRICE[bt] * log(price) +
    PROMO_W * SEGMENTS$promo[sg] * pr$heard[cbind(row, b)] + AD_W * LEVERS$ad$value[b] -
    P$grudge_w * TIER_MEMORY[bt] * mk$grudge[hb] + P$wom * buzz[cbind(row, b)] +
    FORMAT_APPEAL[STORES$format[si]] + mk$at$util[hb] + RETURN_PULL[["store"]] * window_cover()[b]
}

# ---- Store visits, made as shoppers reach the door ------------------------------------------------

# A new visit for each outing o at store s, arriving at `arrive`: its racks
# (the categories still wanted that the brand sells, by the day's taste),
# walking speed and door (draws), and what it carries in (a coupon, the
# budget left after what the outing has already paid; returns: the items).
add_store_visits <- function(o, s, arrive) {
  k <- length(o)
  h <- og$hh[o]; b <- STORES$brand[s]; fmt <- STORES$format[s]
  ret <- og$kind[o] == OG_RETURN
  seg <- mk$hh$segment[h]
  zone <- matrix(0L, k, MAX_ITEMS + 1L); n_zones <- integer(k)
  shop <- which(!ret)
  if (length(shop)) {
    CT <- og$ct[o[shop], , drop = FALSE]
    ok <- CARRIES[b[shop], , drop = FALSE] & CATEGORY_TASTE[seg[shop], , drop = FALSE] > 0 & !og$got[o[shop], , drop = FALSE]
    CT[!ok] <- -Inf
    # Each shopper's categories by the day's taste, highest first (ties to
    # the first): one sort for them all.
    ns <- length(shop)
    idx <- order(rep(seq_len(ns), times = N_CATS), -as.vector(CT), rep(seq_len(N_CATS), each = ns))
    ranked <- matrix((idx - 1L) %/% ns + 1L, nrow = N_CATS)
    zone[shop, seq_len(min(N_CATS, MAX_ITEMS + 1L))] <- t(ranked)[, seq_len(min(N_CATS, MAX_ITEMS + 1L)), drop = FALSE]
    left <- og$n_want[o[shop]] - .rowSums(og$got[o[shop], , drop = FALSE], length(shop), N_CATS)
    n_zones[shop] <- pmax(1L, pmin(MAX_ITEMS + 1L, left, .rowSums(ok, length(shop), N_CATS)))
  }
  speed <- runif(k, WALK_MPS[1], WALK_MPS[2])
  at <- fl$entrance[fmt]
  many <- which(fl$n_doors[fmt] > 1L)
  if (length(many)) at[many] <- door_in(fmt[many])
  hb <- cbind(h, b)
  coupon <- mk$at$coupon[hb]; coupon[ret] <- 0
  from <- mk$at$coupon_from[hb]; from[ret] <- 0L
  lines <- og$ret_lines[o]; lines[!ret] <- list(NULL)
  v <- d_append(list(hh = h, store = s, brand = b, online = rep(FALSE, k), ret = ret, ret_lines = lines, arrive = arrive, speed = speed,
                     zone = zone, n_zones = n_zones, at = at, coupon = coupon, coupon_from = from,
                     budget = mk$budget_left[h] - og$spent[o], reached = promo_reach(h), outing = o, stop = og$n_visits[o] + 1L,
                     items = ifelse_int(ret, lengths(lines), 0L)))
  schedule_floor(v)
  v
}

# Visits joining the floors' arrivals, in time order among those still to come.
schedule_floor <- function(v) {
  done <- seq_len(d$next_in - 1L)
  rest <- c(d$by_arrival[-done], v)
  if (!length(done)) rest <- c(d$by_arrival, v)
  d$by_arrival <<- c(d$by_arrival[done], rest[order(d$arrive[rest], rest)])
}

# ---- The chronology, for the page and the checks --------------------------------------------

# Where everyone on the outside is at time t: cars driving (and which way),
# cars parked (in their facility's tiles), and people walking (outdoors,
# or along a mall's corridors). x, y in metres; kind 1 a car on the
# move, 2 a walker, 3 a parked car; the brand of the store they're going
# to or coming from, and whether they're on the way home.
outside_at <- function(t) {
  none <- list(x = numeric(), y = numeric(), kind = integer(), brand = integer(), back = logical(), outing = integer())
  if (is.null(ol) || !ol$n) return(none)
  m <- ol$m[seq_len(ol$n), , drop = FALSE]
  on <- which(m[, "t0"] <= t & m[, "t1"] > t & m[, "kind"] %in% c(OL_DRIVE, OL_WALK, OL_PARKED, OL_PARK, OL_UNPARK, OL_TRANSFER))
  if (!length(on)) return(none)
  xy <- leg_xy(on, t)
  kind <- m[on, "kind"]
  o <- m[on, "outing"]
  list(x = xy[, 1], y = xy[, 2], kind = ifelse_int(kind == OL_DRIVE, 1L, ifelse_int(kind %in% c(OL_WALK, OL_TRANSFER), 2L, 3L)),
       brand = STORES$brand[og$dest[o]], back = og$ended[o] > 0L, outing = o)
}

# How many are out of doors at time t (not inside a store, not home).
outside_count <- function(t) {
  if (is.null(ol) || !ol$n) return(0)
  m <- ol$m[seq_len(ol$n), , drop = FALSE]
  length(unique(m[m[, "t0"] <= t & m[, "t1"] > t & m[, "kind"] %in% c(OL_DRIVE, OL_WALK, OL_PARK, OL_TRANSFER, OL_UNPARK), "outing"]))
}

# Positions of legs `rows` at time t.
leg_xy <- function(rows, t) {
  T <- city
  m <- ol$m[rows, , drop = FALSE]
  out <- matrix(NA_real_, length(rows), 2)
  for (j in seq_along(rows)) {
    k <- m[j, "kind"]
    if (k %in% c(OL_DRIVE, OL_WALK)) {
      out[j, ] <- route_point(rows[j], t)
    } else if (k == OL_TRANSFER) {
      out[j, ] <- T$node_xy[m[j, "from"], ]
    } else {
      f <- m[j, "fac"]; tl <- FAC$tiles[[f]]
      tile <- tl[(m[j, "outing"] - 1L) %% length(tl) + 1L]
      off <- (((og$hh[m[j, "outing"]] * c(7919, 104729)) %% 37) / 37 - 0.5) * 0.8 * T$patch
      out[j, ] <- T$node_xy[tile, ] + off
    }
  }
  out
}

# The nodes of leg r's route, in the order they're travelled, with the
# seconds into the leg each is reached.
leg_route <- function(r) {
  if (length(ol$route) >= r && !is.null(ol$route[[r]])) return(ol$route[[r]])
  T <- city
  m <- ol$m[r, ]
  fields <- if (m[["graph"]] == 1) T$vf else T$wf
  k <- m[["field"]]
  nodes <- graph_route(fields, m[["from"]], k)
  tm <- fields$time[nodes, k]
  out <- if (m[["rev"]] == 1) list(nodes = rev(nodes), at = rev(tm)) else list(nodes = nodes, at = tm[1] - tm)
  ol$route[[r]] <<- out
  out
}

route_point <- function(r, t) {
  T <- city
  rt <- leg_route(r)
  t0 <- ol$m[r, "t0"]
  s <- t - t0
  i <- findInterval(s, rt$at, rightmost.closed = TRUE)
  i <- max(1L, min(i, length(rt$nodes)))
  j <- min(i + 1L, length(rt$nodes))
  f <- if (j > i) (s - rt$at[i]) / max(rt$at[j] - rt$at[i], 1e-9) else 0
  f <- min(1, max(0, f))
  T$node_xy[rt$nodes[i], ] + (T$node_xy[rt$nodes[j], ] - T$node_xy[rt$nodes[i], ]) * f
}

# One outing's chronology, leg by leg, for the inspector and the checks.
outing_story <- function(o) {
  m <- ol$m[seq_len(ol$n), , drop = FALSE]
  m <- m[m[, "outing"] == o, , drop = FALSE]
  m <- m[order(m[, "t0"], m[, "kind"] == OL_PARKED), , drop = FALSE]
  LEG <- c("driving", "parking", "parked", "walking", "between the space and the exit", "in a store", "pulling out")
  lapply(seq_len(nrow(m)), function(i) list(kind = LEG[m[i, "kind"]], t0 = m[i, "t0"], t1 = m[i, "t1"],
                                             facility = if (m[i, "fac"] > 0) FAC$name[m[i, "fac"]] else NULL,
                                             store = if (m[i, "store"] > 0) STORES$name[m[i, "store"]] else NULL))
}
