# Digital twin of a promotion, on the real roads of Indianapolis.
#
# Two copies of one city run side by side. They hold the same households,
# who shop on the same days, leave home at the same minutes, carry the same
# baskets and share the same luck: every random draw is made once and used
# in both. One thing differs. With the promotion, Store A mails a coupon for
# its promoted range to the homes near it, and shoppers weigh the saving
# against the drive and the store they're used to. So every difference
# between the two maps is the promotion's doing, down to the single trip: the
# model knows where each shopper would have gone without it, and so what the
# discount cost, whom it drew from the chain's own stores and whom from
# rivals, and who drove over to find the shelf empty.
#
# Choosing a store is a multinomial logit. A store's appeal, in dollars, is
# the household's own taste for it (a Gumbel draw kept for the whole run,
# scaled by the loyalty slider), minus the cost of the drive there and back,
# plus Store A's coupon saving; each shopper goes where it's highest. Drives
# follow the real roads, timed by road type.
#
# Store A restocks the promoted range each morning with what it sold
# `restock_lead` days before, so a rush empties the shelf and the stock for
# it arrives after the rush. Shoppers who find the shelf empty hold it
# against Store A. Tills can serve 1.5 times a store's normal peak; beyond that,
# queues build.
#
# One tick is two minutes of the shopping day, 8:00 to 22:00. Day 1 is an
# ordinary day in both worlds; the promotion starts on day 2, and the run ends
# three days after it. Sliders take effect the next morning. The roads, the
# drive times and the supermarkets' sites are real (OpenStreetMap, baked by
# tools/build-indianapolis.R); the chain, its Store A, the households and
# every behaviour are illustrative.
# Map data and supermarket sites © OpenStreetMap contributors (ODbL).

TICK_MIN <- 2
OPEN <- 8 * 60                  # the map's day, in minutes after midnight
CLOSE <- 22 * 60
DAY_TICKS <- (CLOSE - OPEN) / TICK_MIN
PROMO_START <- 2
DAYS_AFTER <- 3
POPULATION_SEED <- 20260925     # the same city of households every time

# Behaviour that isn't on a slider.
BASKET <- 80                    # a trip's basket at regular prices, $, on average
DEAL_SHARE <- 0.1               # the promoted range's share of a basket (say, fresh meat)
STOCK_UP <- 1.5                 # a coupon holder buys this much more of the range
MARGIN <- 0.3                   # gross margin at regular prices
GRUDGE <- 3                     # $ of appeal Store A loses with a shopper who found the shelf empty
LOOK_MIN <- 5                   # minutes to find the shelf empty
BROWSE_MIN <- c(15, 35)         # minutes in the store before the tills
CHECKOUT_MIN <- 3
TILL_HEADROOM <- 1.5            # tills serve up to 1.5 times a store's normal peak
DEPARTURES <- c(3, 5, 7, 8, 8, 7, 6, 7, 10, 13, 14, 12)   # % of trips leaving home in each hour from 8:00
QUEUE_MIN <- 10                 # the tills' queue is tracked in 10-minute steps

city <- NULL
hh <- NULL
base <- NULL
twins <- NULL
history <- NULL
effects <- NULL
coupon_radius <- NULL

# ---- Setup and go -----------------------------------------------------------

setup <- function() {
  map <- readRDS(workbench_data("indianapolis-twin.rds"))
  K <- nrow(map$stores); a <- map$store_a
  map$group <- ifelse(seq_len(K) == a, 1L, ifelse(map$ours, 2L, 3L))   # Store A, the chain's others, rivals
  map$from_a <- (map$seconds[, map$store_junction[a]] + map$store_access[a] + map$store_access) / 60
  map$point_key <- rep(seq_along(map$road_n), map$road_n) * BIG + map$point_seconds
  map$draw_order <- c(setdiff(seq_len(K), a), a)    # Store A's square on top
  city <<- map

  bounds <- city$world
  world <<- createWorld(
    minPxcor = bounds[["minPxcor"]], maxPxcor = bounds[["maxPxcor"]],
    minPycor = bounds[["minPycor"]], maxPycor = bounds[["maxPycor"]],
    data = as.vector(t(city$road_tiers))       # 0 none, 1 tertiary, 2 secondary, 3 primary, 4 interstate
  )
  patch_colors <<- ROADS
  with_colors <<- c(ROADS, COUPON_AREA, COUPON_EDGE)
  draw_coupon_area()

  hh <<- make_households(households)

  # A normal day, as the households' habits make it: where each one shops,
  # each store's visits (and so its tills), and how much of the promoted
  # range Store A sells.
  usual <- max.col(loyalty * hh$taste - 2 * travel_cost * hh$minutes, ties.method = "first")
  visits <- group_sum(hh$trips, usual, K)
  base <<- list(usual = usual, visits = visits,
                range = sum((hh$trips * DEAL_SHARE * hh$basket)[usual == a]),
                till = pmax(visits, mean(visits)) * max(DEPARTURES) / 100 / 60 * TILL_HEADROOM)   # shoppers a minute

  twins <<- list(without = new_twin(FALSE), with = new_twin(TRUE))
  history <<- NULL
  effects <<- list(daily = NULL, today = NULL)
  turtles_without <<- make_agents(twins$without)
  turtles_with <<- make_agents(twins$with)
}

go <- function() {
  day <- today(); t <- tick_of_day()
  if (day > days()) return(stop_run())
  if (t == 1) start_day(day)
  if (!identical(radius, coupon_radius)) draw_coupon_area()

  turtles_without <<- show_twin(twins$without, turtles_without, t)
  turtles_with <<- show_twin(twins$with, turtles_with, t)
  for (name in names(twins)) {
    sold_out <- twins[[name]]$sold_out
    if (!is.null(sold_out) && sold_out == t) {
      cat(sprintf("%s: %s the promotion, Store A's promoted range is sold out.\n", calendar(),
                  if (name == "with") "with" else "without"))
    }
  }

  if (t == DAY_TICKS) end_day(day)
  if (day == days() && t == DAY_TICKS) {
    cat(run_summary(), "\n", sep = "")
    stop_run()
  }
}

days <- function() PROMO_START - 1 + promo_days + DAYS_AFTER
promo_end <- function() PROMO_START + promo_days - 1
in_promo <- function(day) day >= PROMO_START & day <= promo_end()
today <- function() max(0, ticks - 1) %/% DAY_TICKS + 1
tick_of_day <- function() if (ticks == 0) 0 else (ticks - 1) %% DAY_TICKS + 1

# "Day 3 (promotion day 2 of 4), 14:36"
calendar <- function() {
  day <- today()
  if (day > days()) return("the run is over")
  minute <- OPEN + max(0, tick_of_day() - 1) * TICK_MIN
  what <- if (in_promo(day)) sprintf(" (promotion day %d of %d)", day - PROMO_START + 1, promo_days)
          else if (day > promo_end()) " (after the promotion)" else ""
  sprintf("Day %d%s, %02d:%02d", day, what, minute %/% 60, minute %% 60)
}

# ---- Households ---------------------------------------------------------------

# The same city of households every time (POPULATION_SEED): where they live,
# how long the drive to every supermarket takes, their taste for each, their
# usual basket and how often they shop.
make_households <- function(n) {
  with_seed(POPULATION_SEED + n, {
    K <- nrow(city$stores); a <- city$store_a
    pick <- sample(nrow(city$homes), n, replace = n > nrow(city$homes))
    home <- city$homes[pick, , drop = FALSE] + matrix(runif(2 * n, -0.4, 0.4), n)
    list(
      n = n, home = home, junction = city$home_junction[pick], access = city$home_access[pick],
      # Minutes from each home (rows) to each supermarket (columns), along the roads.
      minutes = (t(city$seconds[, city$home_junction[pick], drop = FALSE]) + city$home_access[pick] +
                 rep(city$store_access, each = n)) / 60,
      taste = matrix(-log(-log(runif(n * K))), n, K),     # standard Gumbel, one per household and store
      basket = BASKET * rlnorm(n, -0.35^2 / 2, 0.35),
      trips = runif(n, 1.5, 3.5) / 7,                      # the daily chance of a shopping trip
      km_to_a = sqrt((home[, 1] - city$stores[a, 1])^2 + (home[, 2] - city$stores[a, 2])^2) *
                city$patch_metres / 1000
    )
  })
}

# Runs `code` from a fixed seed, then puts the random number stream back, so
# the run carries on as if nothing had happened.
with_seed <- function(seed, code) {
  saved <- if (exists(".Random.seed", envir = globalenv())) get(".Random.seed", envir = globalenv())
  on.exit(if (is.null(saved)) rm(".Random.seed", envir = globalenv())
          else assign(".Random.seed", saved, envir = globalenv()))
  set.seed(seed)
  code
}

group_sum <- function(x, g, n) {
  out <- numeric(n)
  if (length(x)) {
    s <- rowsum(x, g)
    out[as.integer(rownames(s))] <- s[, 1]
  }
  out
}

# ---- The twins -------------------------------------------------------------------

new_twin <- function(promo) {
  w <- new.env()
  w$promo <- promo
  w$grudge <- numeric(hh$n)           # $ of Store A's appeal lost after an empty shelf
  w$let_down <- logical(hh$n)
  w$shade <- HOME_SHADES[city$group[base$usual]]     # each home's colour: where it last shopped
  w$stock <- deal_stock * base$range                 # the promoted range at Store A, $ at regular prices
  w$deliveries <- numeric(64)
  w$deliveries[seq_len(restock_lead)] <- base$range  # what the days before the run ordered
  w$done <- c(a_sales = 0, chain_profit = 0, rival_sales = 0, let_down = 0)
  w$today <- NULL
  w$stock_trace <- numeric()
  w
}

make_agents <- function(w) {
  N <- hh$n; K <- nrow(city$stores); s <- city$draw_order
  agents <- createTurtles(
    n = N + K, coords = rbind(hh$home, city$stores[s, , drop = FALSE]),
    breed = c(rep("household", N), rep("store", K)),
    color = c(w$shade, STORE_COLOURS[city$group[s]])
  )
  agents <- turtlesOwn(turtles = agents, tVar = "shape", tVal = c(rep("dot", N), rep("square", K)))
  turtlesOwn(turtles = agents, tVar = "size", tVal = c(rep(HOME_SIZE, N), rep(STORE_SIZE, K)))
}

# The day's luck, drawn once and shared by both worlds: who shops today,
# when they leave home, what their basket is and how long they browse.
start_day <- function(day) {
  for (w in twins) if (!is.null(w$today)) w$done <- w$done + w$today[DAY_TICKS, names(w$done)]
  h <- which(runif(hh$n) < hh$trips)
  n <- length(h)
  hour <- sample(seq_along(DEPARTURES), n, replace = TRUE, prob = DEPARTURES)
  luck <- list(h = h, depart = (hour - 1) * 60 + runif(n, 0, 60),     # minutes after opening
               basket = hh$basket[h] * rlnorm(n, -0.25^2 / 2, 0.25),
               browse = runif(n, BROWSE_MIN[1], BROWSE_MIN[2]))
  for (w in twins) plan_day(w, day, luck)
  class <- compare()
  track_day(twins$without, trip_shades(twins$without))
  track_day(twins$with, trip_shades(twins$with, class))
  if (day == PROMO_START) {
    cat(sprintf("%s: the promotion starts, %d%% off the promoted range for the %.0f%% of households within %d km of Store A.\n",
                calendar(), discount, 100 * mean(hh$km_to_a <= radius), radius))
  }
  if (day == promo_end() + 1) cat(sprintf("%s: the promotion is over.\n", calendar()))
}

# One world's day, all at once: where each shopper goes, what Store A's
# shelf gives them, the tills, and what each basket brings in. The ticks
# that follow play it on the map.
plan_day <- function(w, day, luck) {
  a <- city$store_a; h <- luck$h; K <- nrow(city$stores)
  w$stock <- w$stock + w$deliveries[day]
  morning <- w$stock

  # Where: the store that appeals most. `usual` is where they'd go without
  # the coupon.
  coupon <- w$promo & in_promo(day) & discount > 0 & hh$km_to_a[h] <= radius
  saving <- ifelse(coupon, discount / 100 * DEAL_SHARE * STOCK_UP * luck$basket, 0)
  appeal <- loyalty * hh$taste[h, , drop = FALSE] - 2 * travel_cost * hh$minutes[h, , drop = FALSE]
  appeal[, a] <- appeal[, a] - w$grudge[h]
  usual <- max.col(appeal, ties.method = "first")
  appeal[, a] <- appeal[, a] + saving
  first <- max.col(appeal, ties.method = "first")
  arrive <- luck$depart + hh$minutes[cbind(h, first)]

  # Store A's promoted range goes to shoppers in the order they arrive.
  deal <- coupon & first == a
  want <- DEAL_SHARE * luck$basket * ifelse(deal, STOCK_UP, 1)
  got <- want
  queue <- which(first == a)
  queue <- queue[order(arrive[queue])]
  before <- cumsum(want[queue]) - want[queue]
  got[queue] <- pmin(want[queue], pmax(0, morning - before))
  short <- first == a & got < want - 1e-9
  # Those who came only for the deal, and found none, drive on to their usual store.
  drive_on <- short & got == 0 & usual != a
  final <- ifelse(drive_on, usual, first)
  at_final <- ifelse(drive_on, arrive + LOOK_MIN + city$from_a[usual], arrive)

  ready <- at_final + luck$browse
  leave <- ready + till_wait(final, ready) + CHECKOUT_MIN
  home_at <- leave + hh$minutes[cbind(h, final)]

  at_a <- final == a
  goods <- ifelse(at_a, (1 - DEAL_SHARE) * luck$basket + got, luck$basket)
  paid <- goods - ifelse(deal & at_a, discount / 100 * got, 0)
  profit <- paid - (1 - MARGIN) * goods

  sold <- sum(got[at_a])
  w$stock <- morning - sold
  w$deliveries[day + restock_lead] <- w$deliveries[day + restock_lead] + sold
  let <- short | drive_on
  w$grudge[h[let]] <- GRUDGE
  w$let_down[h[let]] <- TRUE
  w$sold_out <- if (any(short)) tick_at(min(arrive[short])) else NULL

  w$trips <- data.frame(h, first, final, usual, short, drive_on, depart = luck$depart, arrive, at_final,
                        leave, home_at, paid, profit)

  # Today, tick by tick: what the monitors and plots show as the day goes on.
  ours <- city$ours[final]
  shopped_a <- at_a & !drive_on
  w$today <- cbind(
    a_visits = by_tick(as.numeric(shopped_a), at_final),
    a_sales = by_tick(paid * at_a, leave),
    chain_profit = by_tick(profit * ours, leave),
    rival_sales = by_tick(paid * (!ours), leave),
    let_down = by_tick(as.numeric(let), arrive),
    a_wait = by_tick((leave - ready - CHECKOUT_MIN) * at_a, leave),
    a_waited = by_tick(as.numeric(at_a), leave),
    a_stock = morning - by_tick(got * (first == a), arrive)
  )
  w$visits <- apply(matrix(tabulate(final + K * (pmin(tick_at(at_final), DAY_TICKS) - 1), K * DAY_TICKS),
                           K), 1, cumsum)                     # ticks x stores, shoppers so far today
  w$stock_trace <- c(w$stock_trace, w$today[, "a_stock"])
}

# The day in the history. (Its tallies join each world's `done` next morning,
# so the last tick of a day doesn't count them twice.)
end_day <- function(day) {
  for (name in names(twins)) {
    w <- twins[[name]]
    last <- w$today[DAY_TICKS, ]
    tr <- w$trips
    history <<- rbind(history, data.frame(
      day = day, world = name, a_visits = last[["a_visits"]], turned_away = sum(tr$short),
      a_sales = last[["a_sales"]], chain_profit = last[["chain_profit"]], rival_sales = last[["rival_sales"]],
      a_wait = last[["a_wait"]] / max(1, last[["a_waited"]]),
      drive_to_a = if (any(tr$final == city$store_a)) median(hh$minutes[tr$h[tr$final == city$store_a], city$store_a]) else NA
    ))
  }
  effects$daily <<- rbind(effects$daily, cbind(day = day, effect_so_far(DAY_TICKS)))
}

# The time of day as a tick: the first tick at or after `minutes` after opening.
tick_at <- function(minutes) pmax(1, ceiling(minutes / TICK_MIN) + 1)

# How much of `x` has happened by each tick of the day, for events at
# `minutes` after opening. Anything after closing counts at the last tick.
by_tick <- function(x, minutes) {
  out <- numeric(DAY_TICKS)
  if (length(x)) {
    s <- rowsum(x, pmin(DAY_TICKS, tick_at(minutes)))
    out[as.integer(rownames(s))] <- s[, 1]
  }
  cumsum(out)
}

# Minutes each shopper waits at the tills. Shoppers reach a store's tills
# over the day the way today's shoppers everywhere do; a store serves
# base$till a minute, and what it can't serve carries over. (Following the
# day's volume rather than each arrival keeps a small simulated city from
# queueing at random.)
till_wait <- function(store, ready) {
  K <- nrow(city$stores)
  steps <- ceiling(max(ready, CLOSE - OPEN) / QUEUE_MIN)
  step <- pmin(steps, floor(pmax(0, ready) / QUEUE_MIN) + 1)
  profile <- tabulate(step, steps) / length(step)
  visits <- tabulate(store, K)
  backlog <- matrix(0, K, steps)
  b <- numeric(K)
  for (s in seq_len(steps)) {
    b <- pmax(0, b + visits * profile[s] - base$till * QUEUE_MIN)
    backlog[, s] <- b
  }
  backlog[cbind(store, step)] / base$till[store]
}

# ---- The promotion's effect ---------------------------------------------------

# Trip by trip, with the promotion against without: the same household on
# the same trip. Returns each trip's class (NA where nothing changed), and
# keeps what each change did to the chain and its rivals.
compare <- function() {
  A <- twins$without$trips; B <- twins$with$trips
  a <- city$store_a
  changed <- A$final != B$final | abs(A$paid - B$paid) > 1e-6 | B$drive_on
  class <- ifelse(B$drive_on, "gone",
           ifelse(B$final == a & A$final == a, "regulars",
           ifelse(B$final == a & city$ours[A$final], "ours",
           ifelse(B$final == a, "rivals",
           ifelse(A$final == a, "away", "other")))))
  class[!changed] <- NA
  ours_a <- city$ours[A$final]; ours_b <- city$ours[B$final]
  keep <- which(changed)
  effects$today <<- data.frame(
    class = class[keep], tick = pmin(DAY_TICKS, tick_at(pmax(A$leave, B$leave)[keep])),
    trips = rep(1, length(keep)),
    chain_sales = (B$paid * ours_b - A$paid * ours_a)[keep],
    chain_profit = (B$profit * ours_b - A$profit * ours_a)[keep],
    rival_sales = (B$paid * (!ours_b) - A$paid * (!ours_a))[keep]
  )
  class
}

CLASSES <- c(regulars = "Store A's own shoppers", ours = "came from the chain's other stores",
             rivals = "came from rival stores", gone = "came for the deal, found it gone",
             away = "stayed away after an empty shelf", other = "other")
EFFECT_COLUMNS <- c("trips", "chain_sales", "chain_profit", "rival_sales")

# Today's changes that have happened by tick t, summed by class.
effect_so_far <- function(t) {
  out <- matrix(0, length(CLASSES), length(EFFECT_COLUMNS), dimnames = list(names(CLASSES), EFFECT_COLUMNS))
  d <- effects$today
  if (!is.null(d)) {
    d <- d[d$tick <= t, , drop = FALSE]
    if (nrow(d)) {
      s <- rowsum(as.matrix(d[, EFFECT_COLUMNS]), d$class)
      out[rownames(s), ] <- s
    }
  }
  data.frame(class = rownames(out), out, row.names = NULL)
}

# The run so far, by class: the days before today, and today up to now.
effect_totals <- function() {
  now <- effect_so_far(tick_of_day())
  d <- effects$daily
  if (!is.null(d)) d <- d[d$day < today(), , drop = FALSE]
  if (!is.null(d) && nrow(d)) {
    s <- rowsum(as.matrix(d[, EFFECT_COLUMNS]), d$class)[now$class, , drop = FALSE]
    now[, EFFECT_COLUMNS] <- now[, EFFECT_COLUMNS] + s
  }
  now
}

# ---- On the map ------------------------------------------------------------------

ROADS <- c("#080b10", "#11171f", "#161e29", "#1d2837", "#293a51")
COUPON_AREA <- "#1b1320"
COUPON_EDGE <- "#8c3d6d"
PINK <- "#ff8cc6"; BLUE <- "#5fb4ff"; GREY <- "#6f7a87"
GREEN <- "#69db7c"; AMBER <- "#ffc94d"; RED <- "#ff4d4f"
HOME_SHADES <- c(PINK, BLUE, GREY)                    # by store: Store A, the chain's others, rivals
CHANGED <- c(GREEN, AMBER, RED)
STORE_COLOURS <- c("#ff5cd6", "#339af0", "#aab4bf")
STOCK_LOW <- "#ffa94d"; STOCK_EMPTY <- "#ff2d2d"
HOME_SIZE <- 2.4
OUT_SIZE <- 3.6
CHANGED_SIZE <- 4.4                                    # households the promotion changed stand out
STORE_SIZE <- 4
CROWD_SPACING <- 1.1                                   # patches between shoppers at a store

# The promotion's world has the coupon's reach drawn on it.
draw_coupon_area <- function() {
  a <- city$store_a
  r <- radius * 1000 / city$patch_metres
  px <- seq(city$world[["minPxcor"]], city$world[["maxPxcor"]])
  py <- seq(city$world[["maxPycor"]], city$world[["minPycor"]])      # row 1 is the top
  d <- sqrt(outer((py - city$stores[a, 2])^2, (px - city$stores[a, 1])^2, "+"))
  map <- city$road_tiers
  map[map == 0 & d <= r] <- 5L
  map[abs(d - r) <= 0.6] <- 6L
  world_with <<- createWorld(
    minPxcor = city$world[["minPxcor"]], maxPxcor = city$world[["maxPxcor"]],
    minPycor = city$world[["minPycor"]], maxPycor = city$world[["maxPycor"]],
    data = as.vector(t(map))
  )
  coupon_radius <<- radius
}

# What colour each trip shows, out and back: the store it's for, or, with
# the promotion, green for a rival's shopper won and amber for one drawn
# from the chain's own stores.
trip_shades <- function(w, class = NULL) {
  shade <- HOME_SHADES[city$group[w$trips$final]]
  if (!is.null(class)) {
    shade[class %in% "rivals"] <- GREEN
    shade[class %in% "ours"] <- AMBER
  }
  shade
}

BIG <- 1e4   # seconds: longer than any drive, so legs (and roads) share one sorted key

# Where every shopper is at every tick of the day: driving along the roads,
# or at a store, in a crowd around it in the order they came.
track_day <- function(w, shade) {
  tr <- w$trips; a <- city$store_a; n <- nrow(tr)
  on <- which(tr$drive_on); m <- length(on)
  home <- hh$home[tr$h, , drop = FALSE]
  # Home to the first store, and back the same way; for those who drive on,
  # Store A to their usual store, and home from there.
  out <- trace_routes(home, hh$junction[tr$h], hh$access[tr$h], tr$first)
  across <- trace_routes(city$stores[rep(a, m), , drop = FALSE], rep(city$store_junction[a], m),
                         rep(city$store_access[a], m), tr$usual[on])
  back <- trace_routes(home[on, , drop = FALSE], hh$junction[tr$h[on]], hh$access[tr$h[on]], tr$final[on])
  after <- ifelse(tr$short, RED, shade)            # once they've seen the empty shelf
  straight_home <- setdiff(seq_len(n), on)

  # Trips `trips` driving `route` (its legs `legs`) from `start` to `end`.
  drive <- function(route, trips, start, end, colour, legs = trips, reverse = FALSE) {
    s <- ticks_between(start[trips], end[trips])
    if (!length(s$i)) return(NULL)
    trip <- trips[s$i]
    secs <- ((s$tick - 1) * TICK_MIN - start[trip]) * 60
    if (reverse) secs <- (end[trip] - start[trip]) * 60 - secs
    xy <- route_xy(route, legs[s$i], secs)
    data.frame(i = trip, tick = s$tick, x = xy[, 1], y = xy[, 2], shade = colour[trip])
  }
  stay <- function(trips, store, start, end) {
    s <- ticks_between(start[trips], end[trips])
    if (!length(s$i)) return(NULL)
    trip <- trips[s$i]
    data.frame(i = trip, tick = s$tick, store = store[trip], since = start[trip], shade = after[trip])
  }

  driving <- rbind(
    drive(out, seq_len(n), tr$depart, tr$arrive, shade),
    drive(out, straight_home, tr$leave, tr$home_at, after, reverse = TRUE),
    drive(across, on, tr$arrive + LOOK_MIN, tr$at_final, after, legs = seq_len(m)),
    drive(back, on, tr$leave, tr$home_at, after, legs = seq_len(m), reverse = TRUE)
  )
  stays <- rbind(
    stay(on, rep(a, n), tr$arrive, tr$arrive + LOOK_MIN),
    stay(seq_len(n), tr$final, tr$at_final, tr$leave),
    data.frame(i = integer(), tick = integer(), store = integer(), since = numeric(), shade = character())
  )
  w$crowd_a <- tabulate(stays$tick[stays$store == a], DAY_TICKS)
  # Around each store, in the order they came, on a sunflower spiral: a
  # crowd that grows as the store fills.
  key <- stays$store * (DAY_TICKS + 1) + stays$tick
  o <- order(key, stays$since)
  slot <- integer(nrow(stays))
  slot[o] <- seq_along(o) - match(key[o], key[o]) + 1L
  angle <- slot * pi * (3 - sqrt(5))
  reach <- CROWD_SPACING * sqrt(slot + 6)
  stays$x <- city$stores[stays$store, 1] + reach * cos(angle)
  stays$y <- city$stores[stays$store, 2] + reach * sin(angle)
  track <- rbind(driving, stays[, c("i", "tick", "x", "y", "shade")])
  track$h <- tr$h[track$i]
  w$track <- track
  w$by_tick <- split(seq_len(nrow(track)), factor(track$tick, levels = seq_len(DAY_TICKS)))

  # Back home, each home takes its trip's colour: red, for good, once let down.
  w$home_shade <- ifelse(w$let_down[tr$h], RED, shade)
  w$settle <- split(seq_len(n), factor(pmin(DAY_TICKS, tick_at(tr$home_at)), levels = seq_len(DAY_TICKS)))
}

# The ticks of the day within [start, end) minutes after opening, for each
# interval: which interval (i) and which tick.
ticks_between <- function(start, end) {
  first <- as.integer(pmax(1, ceiling(start / TICK_MIN) + 1))
  last <- as.integer(pmin(DAY_TICKS, ceiling(end / TICK_MIN)))
  count <- pmax(0L, last - first + 1L)
  list(i = rep(seq_along(start), count), tick = sequence(count, from = first))
}

# Routes along the roads to stores `to`, from points `from` (n x 2) that
# join the network at junctions `from_j`, `from_s` seconds away. A route is
# its stretches in order: onto the network, each road the store's tree leads
# along, and off the network to the store.
trace_routes <- function(from, from_j, from_s, to) {
  n <- length(to)
  leg <- integer(); road <- integer(); forward <- logical()
  at <- from_j; live <- seq_len(n)
  while (length(live)) {
    r <- city$via[cbind(to[live], at[live])]
    live <- live[r > 0]; r <- r[r > 0]
    if (!length(live)) break
    fwd <- city$road_from[r] == at[live]
    leg <- c(leg, live); road <- c(road, r); forward <- c(forward, fwd)
    at[live] <- ifelse(fwd, city$road_to[r], city$road_from[r])
  }
  # Stretch kinds: 1 onto the network, 2 a road, 3 off it to the store.
  s_leg <- c(seq_len(n), leg, seq_len(n))
  kind <- c(rep(1L, n), rep(2L, length(leg)), rep(3L, n))
  o <- order(s_leg, kind)                          # stable: roads stay in the order driven
  lengths_s <- c(from_s, city$road_seconds[road], city$store_access[to])[o]
  s_leg <- s_leg[o]
  start <- cumsum(lengths_s) - lengths_s
  start <- start - start[match(s_leg, s_leg)]      # seconds from the leg's start
  list(from = from, from_j = from_j, to = to, leg = s_leg, kind = kind[o],
       road = c(integer(n), road, integer(n))[o], forward = c(logical(n), forward, logical(n))[o],
       start = start, length = lengths_s, key = s_leg * BIG + start)
}

# Where each of `legs` of a route is, `secs` seconds after it set off.
route_xy <- function(route, legs, secs) {
  i <- findInterval(legs * BIG + secs, route$key)
  into <- secs - route$start[i]
  f <- pmin(1, pmax(0, into / pmax(route$length[i], 1e-9)))
  kind <- route$kind[i]
  xy <- matrix(0, length(i), 2)
  from <- kind == 1                                 # from the home (or store) to the network
  if (any(from)) {
    p <- route$from[legs[from], , drop = FALSE]
    j <- city$junctions[route$from_j[legs[from]], , drop = FALSE]
    xy[from, ] <- p + (j - p) * f[from]
  }
  to <- kind == 3                                   # from the network to the store
  if (any(to)) {
    st <- route$to[legs[to]]
    j <- city$junctions[city$store_junction[st], , drop = FALSE]
    xy[to, ] <- j + (city$stores[st, , drop = FALSE] - j) * f[to]
  }
  on <- kind == 2                                   # along a road, from whichever end it was entered
  if (any(on)) {
    r <- route$road[i[on]]
    along <- ifelse(route$forward[i[on]], into[on], city$road_seconds[r] - into[on])
    p <- findInterval(r * BIG + along, city$point_key)
    p <- pmin(pmax(p, city$road_first[r]), city$road_first[r] + city$road_n[r] - 2L)
    g <- (along - city$point_seconds[p]) / pmax(city$point_seconds[p + 1] - city$point_seconds[p], 1e-9)
    g <- pmin(1, pmax(0, g))
    xy[on, ] <- city$points[p, , drop = FALSE] + (city$points[p + 1, , drop = FALSE] - city$points[p, , drop = FALSE]) * g
  }
  xy
}

# Moves one world's households and stores to tick t of the day.
show_twin <- function(w, agents, t) {
  N <- hh$n; a <- city$store_a; s <- city$draw_order
  settled <- w$settle[[t]]
  if (length(settled)) w$shade[w$trips$h[settled]] <- w$home_shade[settled]
  x <- hh$home[, 1]; y <- hh$home[, 2]; colour <- w$shade; size <- rep(HOME_SIZE, N)
  rows <- w$by_tick[[t]]
  if (length(rows)) {
    h <- w$track$h[rows]
    x[h] <- w$track$x[rows]; y[h] <- w$track$y[rows]
    colour[h] <- w$track$shade[rows]; size[h] <- OUT_SIZE
  }
  size[colour %in% CHANGED] <- CHANGED_SIZE
  x <- pmin(pmax(x, city$world[["minPxcor"]]), city$world[["maxPxcor"]])
  y <- pmin(pmax(y, city$world[["minPycor"]]), city$world[["maxPycor"]])

  # Stores grow with the day's shoppers; Store A shows its promoted range.
  store_size <- STORE_SIZE + 0.9 * sqrt(w$visits[t, ])
  store_colour <- STORE_COLOURS[city$group]
  stock <- w$today[t, "a_stock"]
  store_colour[a] <- if (stock <= 1e-6) STOCK_EMPTY else if (stock < base$range) STOCK_LOW else STORE_COLOURS[1]

  agents <- setXY(turtles = agents, xcor = c(x, city$stores[s, 1]), ycor = c(y, city$stores[s, 2]),
                  world = world, torus = FALSE)
  agents <- NLset(turtles = agents, agents = agents, var = "color", val = c(colour, store_colour[s]))
  NLset(turtles = agents, agents = agents, var = "size", val = c(size, store_size[s]))
}

# ---- Monitors -------------------------------------------------------------------

# A world's tally for today up to now, or since the run began.
today_value <- function(w, what) {
  t <- tick_of_day()
  if (t == 0 || is.null(w$today)) 0 else w$today[t, what]
}
so_far <- function(name, what) {
  w <- twins[[name]]
  w$done[[what]] + today_value(w, what)
}
a_shoppers <- function(name) today_value(twins[[name]], "a_visits")
a_in_store <- function(name) {
  t <- tick_of_day()
  if (t == 0 || is.null(twins[[name]]$crowd_a)) 0 else twins[[name]]$crowd_a[t]
}
a_wait <- function(name) {
  w <- twins[[name]]
  today_value(w, "a_wait") / max(1, today_value(w, "a_waited"))
}
a_stock <- function(name) {
  w <- twins[[name]]
  stock <- if (tick_of_day() == 0 || is.null(w$today)) w$stock else w$today[tick_of_day(), "a_stock"]
  stock / base$range
}
effect_of <- function(what) sum(effect_totals()[[what]])

run_summary <- function() {
  e <- effect_totals()
  won <- e$trips[e$class == "rivals"]; moved <- e$trips[e$class == "ours"]
  sprintf(paste0("Run over. With the promotion, Store A won %d trips from rival stores and drew %d from the chain's ",
                 "own; the chain's gross profit changed by %s and rivals' sales by %s. Shoppers found the shelf empty %d times."),
          won, moved, dollars(sum(e$chain_profit)), dollars(sum(e$rival_sales)), as.integer(so_far("with", "let_down")))
}

money <- function(x) paste0("$", format(round(x), big.mark = ",", trim = TRUE))
dollars <- function(x) {
  sign <- ifelse(round(x) < 0, "−", ifelse(round(x) > 0, "+", ""))
  paste0(sign, "$", format(round(abs(x)), big.mark = ",", trim = TRUE))
}

# ---- Plots and the report -------------------------------------------------------

WITHOUT_LINE <- "#868e96"
WITH_LINE <- "#d6336c"

# Days across, the promotion shaded, and a line at now. Day d spans
# d - 0.5 to d + 0.5.
chart_frame <- function(ylim, ylab) {
  par(mar = c(2, 3.6, 1.7, 0.6), mgp = c(2.4, 0.55, 0), tcl = -0.25, cex.axis = 0.8, cex.lab = 0.85)
  n <- days()
  plot(NA, xlim = c(0.5, n + 0.5), ylim = ylim, xlab = "", ylab = ylab, xaxt = "n", yaxt = "n", bty = "n", xaxs = "i")
  rect(PROMO_START - 0.5, ylim[1], promo_end() + 0.5, ylim[2], col = "#fff0f6", border = NA)
  text(PROMO_START - 0.4, ylim[2], "promotion", adj = c(0, 1), cex = 0.7, col = "#d6336c")
  abline(v = seq_len(n + 1) - 0.5, col = "gray93")
  axis(1, at = seq_len(n), labels = paste("day", seq_len(n)), tick = FALSE, line = -0.8, cex.axis = 0.75)
  axis(2, las = 1, col = NA, col.ticks = "gray70")
  if (ticks > 0) abline(v = now_x(), col = "gray55", lty = 3)
}
now_x <- function() today() - 0.5 + max(0, tick_of_day() - 1) / DAY_TICKS

top_legend <- function(labels, col, lwd = 2, lty = 1) {
  legend("top", labels, col = col, lwd = lwd, lty = lty, horiz = TRUE, bty = "n", cex = 0.75,
         inset = c(0, -0.16), xpd = NA, seg.len = 1.4, x.intersp = 0.5, text.width = NA)
}

# Each world's days so far: finished days from the history, and today up to now.
days_so_far <- function() {
  done <- if (is.null(history)) NULL else history[history$day < today(), c("day", "world", "a_visits", "turned_away")]
  if (ticks == 0) return(done)
  now <- do.call(rbind, lapply(names(twins), function(name) {
    data.frame(day = today(), world = name, a_visits = a_shoppers(name),
               turned_away = today_value(twins[[name]], "let_down"))
  }))
  rbind(done, now)
}

plot_visits <- function() {
  d <- days_so_far()
  top <- if (is.null(d)) 10 else max(10, d$a_visits)
  chart_frame(c(0, top * 1.1), "shoppers a day")
  if (is.null(d)) return(invisible())
  with_p <- d[d$world == "with", ]; without <- d[d$world == "without", ]
  rect(with_p$day - 0.3, 0, with_p$day + 0.3, with_p$turned_away, col = RED, border = NA)
  lines(without$day, without$a_visits, col = WITHOUT_LINE, lwd = 2, lty = 2, type = "o", pch = 16, cex = 0.6)
  lines(with_p$day, with_p$a_visits, col = WITH_LINE, lwd = 2.4, type = "o", pch = 16, cex = 0.6)
  top_legend(c("without", "with the promotion", "found the shelf empty"), c(WITHOUT_LINE, WITH_LINE, RED),
             lwd = c(2, 2.4, 6), lty = c(2, 1, 1))
}

plot_stock <- function() {
  x <- function(w) {
    n <- length(w$stock_trace)
    (seq_len(n) - 1) %/% DAY_TICKS + 1 - 0.5 + ((seq_len(n) - 1) %% DAY_TICKS) / DAY_TICKS
  }
  shown <- function(w) {
    keep <- seq_len(max(0, (today() - 1) * DAY_TICKS + tick_of_day()))
    list(x = x(w)[keep], y = w$stock_trace[keep] / base$range)
  }
  a <- shown(twins$without); b <- shown(twins$with)
  chart_frame(c(0, max(deal_stock + 2, a$y, b$y) * 1.08), "days of normal sales")
  lines(a$x, a$y, col = WITHOUT_LINE, lwd = 2, lty = 2)
  lines(b$x, b$y, col = WITH_LINE, lwd = 2.4)
  top_legend(c("without", "with the promotion"), c(WITHOUT_LINE, WITH_LINE), lwd = c(2, 2.4), lty = c(2, 1))
}

# The chain's gross profit, with against without, as it adds up.
PROFIT_PARTS <- list(rivals = GREEN, regulars = PINK, ours = AMBER, let_down = RED)
plot_profit <- function() {
  daily <- effects$daily
  steps <- if (is.null(daily)) integer() else sort(unique(daily$day[daily$day < today()]))
  part <- function(classes) {
    at_day_end <- vapply(steps, function(d) sum(daily$chain_profit[daily$day <= d & daily$class %in% classes]), 0)
    now <- effect_so_far(tick_of_day())
    c(0, at_day_end, sum(daily$chain_profit[daily$day %in% steps & daily$class %in% classes]) +
        sum(now$chain_profit[now$class %in% classes]))
  }
  x <- c(0.5, steps + 0.5, if (ticks > 0) now_x() else 0.5)
  parts <- list(rivals = part("rivals"), regulars = part("regulars"), ours = part("ours"),
                let_down = part(c("gone", "away")))
  net <- part(names(CLASSES))
  chart_frame(range(0, unlist(parts), net) * 1.1 + c(-1, 1), "$ vs. without")
  abline(h = 0, col = "gray70")
  for (p in names(parts)) lines(x, parts[[p]], col = PROFIT_PARTS[[p]], lwd = 1.8)
  lines(x, net, col = "#212529", lwd = 2.8)
  legend("topleft", c("net", "won from rivals", "Store A's own shoppers", "from the chain's stores", "empty shelf"),
         col = c("#212529", GREEN, PINK, AMBER, RED), lwd = c(2.8, 1.8, 1.8, 1.8, 1.8), bty = "n", cex = 0.72,
         seg.len = 1.4, x.intersp = 0.5, y.intersp = 0.9, inset = c(0.01, 0.1))
}

report_effect <- function() {
  e <- effect_totals()
  if (sum(e$trips) == 0) {
    cat("Both worlds have the same households making the same trips with the same luck, so until the\n",
        "promotion starts on day 2 they agree trip for trip. From then on, every trip that differs is\n",
        "the promotion's doing, and this table sorts them by where the shopper would have gone without it.\n", sep = "")
    return(invisible())
  }
  e <- e[e$trips > 0 | e$class != "other", ]
  table <- data.frame(`Trips the promotion changed` = CLASSES[e$class], trips = e$trips,
                      `chain's sales` = dollars(e$chain_sales), `chain's gross profit` = dollars(e$chain_profit),
                      `rivals' sales` = dollars(e$rival_sales), check.names = FALSE)
  table <- rbind(table, data.frame(`Trips the promotion changed` = "all of them", trips = sum(e$trips),
                                   `chain's sales` = dollars(sum(e$chain_sales)),
                                   `chain's gross profit` = dollars(sum(e$chain_profit)),
                                   `rivals' sales` = dollars(sum(e$rival_sales)), check.names = FALSE))
  print(table, row.names = FALSE, right = FALSE)
  promo <- if (is.null(history)) NULL else history[in_promo(history$day), ]
  if (!is.null(promo) && nrow(promo)) {
    drive <- tapply(promo$drive_to_a, promo$world, median, na.rm = TRUE)
    cat(sprintf("\nStore A's shoppers drove %.0f minutes to it without the promotion and %.0f with it (median, promotion days).\n",
                drive[["without"]], drive[["with"]]))
  }
}
