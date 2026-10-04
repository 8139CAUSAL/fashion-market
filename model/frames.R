# What the page draws, placed from the exact times of each activity at
# store time `t`. Nothing here draws random numbers.

# Every shopper in store `s` at time `t`, where their legs put them (one
# trying on stands in the cubicle), and the staff, each with their number:
# cashier k at till k (busy with a sale or a return), assistant k with the
# shopper they're advising, on the way to or from the stockroom door or at
# it for one they're fetching a size for, or waiting at their place on the
# floor.
floor_agents <- function(s, t) {
  f <- STORES$format[s]; plan <- fl$plans[[f]]
  m <- legs$m[seq_len(legs$n), , drop = FALSE]
  m <- m[m[, "store"] == s & m[, "t0"] <= t & m[, "t1"] > t, , drop = FALSE]
  kind <- m[, "kind"]; a <- m[, "a"]; b <- m[, "b"]; v <- m[, "visit"]; t0 <- m[, "t0"]
  x <- fl$anchor_xy[a, 1]; y <- fl$anchor_xy[a, 2]
  w <- kind == WALK
  if (any(w)) {
    metres <- fl$walk_m[cbind(a[w], b[w])] * (t - t0[w]) / pmax(m[w, "t1"] - t0[w], 1e-9)
    p <- path_xy(a[w], b[w], metres)
    x[w] <- p[, 1]; y[w] <- p[, 2]
  }
  tr <- which(kind == TRY)                   # in the cubicle, off the floor at its opening
  if (length(tr)) {
    inside <- plan$cubicle_in[a[tr] - fl$cubicle_first[f] + 1L, , drop = FALSE]
    x[tr] <- inside[, 1]; y[tr] <- inside[, 2]
  }
  br <- kind == BROWSE                       # spread out a little around the spot
  x[br] <- x[br] + ((v[br] * 7919) %% 11) / 11 - 0.5
  y[br] <- y[br] + ((v[br] * 104729) %% 13) / 13 - 0.5
  qlen <- c(0L, 0L)
  for (queue in c(WAIT_FR, WAIT_TILL)) {     # in the queue's line, in the order they joined
    qi <- which(kind == queue)
    if (length(qi)) {
      slots <- if (queue == WAIT_FR) plan$fr_slots else plan$till_slots
      place <- pmin(rank(t0[qi], ties.method = "first"), dim(slots)[1L])
      x[qi] <- slots[place, 1]; y[qi] <- slots[place, 2]
      qlen[queue - WAIT_FR + 1L] <- length(qi)
    }
  }
  cub_busy <- tabulate(a[kind == TRY] - fl$cubicle_first[f] + 1L, fl$n_cubicles[f])
  till_busy <- tabulate(a[kind == PAY | kind == REFUND] - fl$till_first[f] + 1L, fl$n_tills[f])

  # Staff.
  nc <- S$cashiers[s]
  cx <- plan$cashier_xy[seq_len(nc), 1]; cy <- plan$cashier_xy[seq_len(nc), 2]
  sm <- staff$m[seq_len(staff$n), , drop = FALSE]
  sm <- sm[sm[, "store"] == s & sm[, "job"] != JOB_REFUND & sm[, "t0"] <= t & sm[, "t1"] > t, , drop = FALSE]
  na <- S$assistants[s]
  k <- seq_len(na)
  job <- match(k, sm[, "server"])                                  # each assistant's job now, if any
  busy_a <- !is.na(job)
  home <- plan$helper_xy[(k - 1L) %% dim(plan$helper_xy)[1L] + 1L, , drop = FALSE]
  ax <- home[, 1]; ay <- home[, 2]
  ax[busy_a] <- fl$anchor_xy[sm[job[busy_a], "anchor"], 1] + 0.9
  ay[busy_a] <- fl$anchor_xy[sm[job[busy_a], "anchor"], 2] + 0.6
  fetching <- which(busy_a)[sm[job[busy_a], "job"] == JOB_FETCH]
  if (length(fetching)) {                    # out to the stockroom door, and back
    j <- job[fetching]; a0 <- sm[j, "anchor"]
    out <- pmin(fl$fetch_m[a0], pmin(t - sm[j, "t0"], sm[j, "t1"] - t) * STAFF_MPS)   # metres from the rack
    p <- path_xy(a0, fl$fetch_to[a0], out)
    ax[fetching] <- p[, 1]; ay[fetching] <- p[, 2]
  }
  list(x = x, y = y, look = m[, "look"], visit = v,
       staff_x = c(cx, ax), staff_y = c(cy, ay), staff_role = c(rep(1L, nc), rep(2L, na)), staff_id = c(seq_len(nc), k),
       staff_busy = c(till_busy[seq_len(nc)] > 0, busy_a),
       cub_busy = cub_busy, cub_open = seq_len(fl$n_cubicles[f]) <= S$fitting_rooms[s],
       fr_q = qlen[1], till_q = qlen[2],
       receipts = sum(d$store == s & d$outcome == 1L),
       in_store = sum(d$store == s & d$arrive <= t & d$gone > t))
}

# One tick's moving parts for the page, packed as one vector of doubles:
#   header   version, homes version, store clock (s), day
#   map      n, then x, y (metres), brand, going home (0/1) for each traveller
#   floor    n, then x, y (cells), look, visit id for each shopper
#   staff    n, then x, y, role (1 cashier, 2 assistant), number, busy
#   rooms    n, then busy, open for each fitting cubicle
#   store    fitting-room queue, till queue, receipts today, shoppers inside
frame_pack <- function(map = TRUE, store = 0L) {
  t <- clock
  out <- c(1, homes_version, t, day)
  if (map && P$pace == "watch" && !season_over) {
    tr <- travellers_at(t)
    out <- c(out, length(tr$x), round(tr$x), round(tr$y), tr$brand, as.numeric(tr$back))
  } else out <- c(out, 0)
  if (store > 0) {
    fa <- floor_agents(store, t)
    out <- c(out, length(fa$x), round(fa$x, 2), round(fa$y, 2), fa$look, fa$visit,
             length(fa$staff_x), fa$staff_x, fa$staff_y, fa$staff_role, fa$staff_id, as.numeric(fa$staff_busy),
             length(fa$cub_busy), as.numeric(fa$cub_busy > 0), as.numeric(fa$cub_open),
             fa$fr_q, fa$till_q, fa$receipts, fa$in_store)
  } else out <- c(out, 0, 0, 0, 0, 0, 0, 0)
  out
}

# Each household's colour on the map, as a code: the brand it last bought
# from (0: none yet), its segment, its area (0: outside every area), where
# it stands in brand b's offers running today ("offer": 0 not in the
# audience, 1 held out, 2 sent the coupon, 3 used it).
homes_codes <- function(mode = "brand", b = 1L) {
  codes <- switch(mode,
    brand = mk$last_brand,
    segment = mk$hh$segment,
    offer = offer_codes(offers_live()[OFFERS$brand[offers_live()] == min(max(1L, b), N_BRANDS)]),
    area = mk$hh$area,
    mk$last_brand)
  as.raw(codes)
}

# The households in offers `ks`, by their furthest step: used a coupon,
# sent one, held out.
offer_codes <- function(ks) {
  codes <- integer(mk$hh$n)
  for (k in ks[ofr$drawn[ks]]) {
    m <- ofr$members[[k]]
    codes[m] <- pmax(codes[m], ifelse_int(ofr$sent[[k]], ifelse_int(ofr$used[[k]] > 0L, 3L, 2L), 1L))
  }
  codes
}

homes_xy <- function() as.integer(round(c(mk$hh$x, mk$hh$y)))

# Where shoppers walked in store `s` today, up to now: each walk adds one to
# every cell of its path; time standing at a rack, in a queue or in a
# cubicle adds one per half-minute.
heat_cells <- function(s) {
  f <- STORES$format[s]; plan <- fl$plans[[f]]
  m <- legs$m[seq_len(legs$n), , drop = FALSE]
  m <- m[m[, "store"] == s & m[, "t0"] <= clock, , drop = FALSE]
  heat <- numeric(plan$W * plan$H)
  if (!dim(m)[1L]) return(heat)
  w <- m[, "kind"] == WALK
  if (any(w)) {
    pair <- (m[w, "b"] - 1) * fl$NA_all + m[w, "a"]
    first <- fl$path_first[pair]; n <- fl$path_last[pair] - first + 1L
    ok <- !is.na(first)
    rows <- rep(first[ok], n[ok]) + sequence(n[ok]) - 1L
    cell <- (plan$H - 1 - fl$path_y[rows]) * plan$W + fl$path_x[rows] + 1
    heat <- heat + tabulate(cell, length(heat))
  }
  st <- which(m[, "kind"] != WALK)
  if (length(st)) {
    a <- m[st, "a"]
    xy <- fl$anchor_xy[a, , drop = FALSE]
    tr <- m[st, "kind"] == TRY                 # trying on: in the cubicle
    xy[tr, ] <- plan$cubicle_in[a[tr] - fl$cubicle_first[f] + 1L, , drop = FALSE]
    cell <- (plan$H - 1 - xy[, 2]) * plan$W + xy[, 1] + 1
    heat <- heat + bin_sum(cell, (pmin(m[st, "t1"], clock) - m[st, "t0"]) / 30, length(heat))
  }
  heat
}
