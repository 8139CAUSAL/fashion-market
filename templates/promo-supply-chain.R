# Promotion vs. supply chain, on the real roads of Indianapolis.
#
# Marketing runs a price promotion. Shoppers hear about it from the ad and
# from their neighbours, make extra trips, and stock up. Stores see a spike
# in sales and reorder from the distribution centre (DC); the DC reorders
# from the plant. Every link forecasts from what it sees, so the spike grows
# on its way up the chain (the bullwhip effect), shelves empty, and after the
# promotion everyone is left holding stock while shoppers eat through their
# pantries.
#
# How big the spike gets is uncertain: it depends on who hears, who tells
# whom, and how much they buy. The model runs many futures side by side (at
# setup, and again with the "simulate futures" button) to show that range,
# and to plan stock against it: the "simulated P90" plan stocks each store
# for its 90th-percentile promotion demand across those futures, and for the
# dip that follows. Every plan is then tested on fresh futures.
#
# The run is nine weeks, with the promotion at the start of week 5. setup()
# plays weeks 1-3 at once (a supply chain that knows the plan uses them to
# build stock), so the map starts a week before the promotion. One tick is
# half an hour. The roads are real (OpenStreetMap, baked by
# tools/build-indianapolis.R); the retailer, its ten stores, its DC and its
# shoppers are illustrative, and every behaviour is a slider.
# Map data © OpenStreetMap contributors (ODbL).

TICKS_PER_DAY <- 48
DAYS <- 63
PROMO_START <- 29               # day 1 is a Monday, so the promotion starts on a Monday
FIRST_DAY <- 22                 # the first day the map shows; setup() plays the days before
SLOTS <- 16                     # days of deliveries a pipeline can hold (longer than any lead time)
N_FUTURES <- 60

# Behaviour that isn't on a slider.
ALPHA <- 0.2                    # how fast forecasts follow what they see (exponential smoothing)
DEAL_TRIP <- 0.4                # daily chance that someone after the deal makes a trip for it
SWITCH_STORE <- 0.5             # chance of trying the next-nearest store after being turned away
STOCKPILE_MAX <- 12             # extra units a keen shopper buys at 100% stockpiling and 100% off
TRUCK_LOAD <- 150               # units per truck from the plant
POPULATION_SEED <- 20260924     # the same city of shoppers every time: futures differ, the market doesn't

city <- NULL
market <- NULL
futures <- NULL
history <- NULL

# ---- Setup and go ---------------------------------------------------------

setup <- function() {
  city <<- readRDS(workbench_data("indianapolis.rds"))
  bounds <- city$world
  world <<- createWorld(
    minPxcor = bounds[["minPxcor"]], maxPxcor = bounds[["maxPxcor"]],
    minPycor = bounds[["minPycor"]], maxPycor = bounds[["maxPycor"]],
    data = as.vector(t(city$road_tiers))     # 0 none, 1 tertiary, 2 secondary, 3 primary, 4 interstate
  )
  patch_colors <<- c("#0a0e13", "#161e28", "#1f2a37", "#2c3b4e", "#44628a")

  shoppers <<- make_shoppers(households)
  # The futures of shopper demand, unless these settings already have them.
  # Testing every plan on fresh futures is the "simulate futures" button.
  if (!futures_current()) simulate_demand()
  plan <- supply_multipliers(supply_plan)
  market <<- new_market(shoppers, R = 1, plan = plan)
  history <<- do.call(rbind, lapply(seq_len(FIRST_DAY - 1), function(day) market_day(market, day)$record))

  K <- nrow(city$stores)
  n_trucks <- K * 5 + 16                     # enough for every store truck on the road, and a convoy
  turtles <<- createTurtles(
    n = shoppers$n + K + 1 + n_trucks,
    coords = rbind(shoppers$home, city$stores, city$dc,
                   matrix(city$dc, n_trucks, 2, byrow = TRUE)),
    breed = c(rep("shopper", shoppers$n), rep("store", K), "dc", rep("truck", n_trucks)),
    color = c(rep(IDLE, shoppers$n), rep(STOCKED, K), DC_OK, rep(TRUCK, n_trucks))
  )
  turtles <<- turtlesOwn(turtles = turtles, tVar = "shape",
                         tVal = c(rep("dot", shoppers$n), rep("square", K + 1), rep("arrow", n_trucks)))
  turtles <<- turtlesOwn(turtles = turtles, tVar = "size",
                         tVal = c(rep(SHOPPER_SIZE, shoppers$n), rep(8, K), 12, rep(0, n_trucks)))
  members <<- list(shoppers = seq_len(shoppers$n), stores = shoppers$n + seq_len(K),
               dc = shoppers$n + K + 1, trucks = shoppers$n + K + 1 + seq_len(n_trucks))

  trips <<- data.frame(h = integer(), store = integer(), want = numeric(), served = numeric(), leaves = integer())
  trucks <<- data.frame(route = integer(), from = integer(), to = integer(), load = numeric())
  shelf <<- market$on_hand
  let_down <<- market$turned_away       # what the map shows: updated when shoppers reach the store
}

go <- function() {
  day <- today()
  tick_of_day <- (ticks - 1) %% TICKS_PER_DAY
  if (day > DAYS) return(stop_run())

  if (tick_of_day == 0) start_day(day)
  animate(tick_of_day)

  if (ticks == (DAYS - FIRST_DAY + 1) * TICKS_PER_DAY) {
    cat(run_summary(), "\n", sep = "")
    stop_run()
  }
}

today <- function() FIRST_DAY + max(0, ticks - 1) %/% TICKS_PER_DAY

# "Mon, week 4, 14:30"
calendar <- function() {
  if (ticks == 0) return(sprintf("%s, week %d", "Mon", (FIRST_DAY - 1) %/% 7 + 1))
  day <- today()
  if (day > DAYS) return("the run is over")
  minutes <- ((ticks - 1) %% TICKS_PER_DAY) * 24 * 60 / TICKS_PER_DAY
  sprintf("%s, week %d, %02d:%02d", c("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[(day - 1) %% 7 + 1],
          (day - 1) %/% 7 + 1, minutes %/% 60, minutes %% 60)
}

# A day in the market happens at once (market_day); the ticks that follow
# replay it on the map: shoppers drive to their store and back, and shelves
# empty as they arrive.
start_day <- function(day) {
  before <- market$on_hand + market$pipe[, (day - 1) %% SLOTS + 1]   # shelves after this morning's deliveries
  result <- market_day(market, day)
  history <<- rbind(history, result$record)
  if (day == PROMO_START) cat(sprintf("Day %d: the promotion starts, %d%% off. By tonight %.0f%% of households have heard.\n",
                                      day, discount, 100 * mean(market$aware)))
  if (day == promo_end() + 1) cat(sprintf("Day %d: the promotion ends.\n", day))

  # Shoppers leave between 8:00 and 19:00; the trip takes 1.5 hours each way.
  n <- length(result$shopper)
  trips <<- data.frame(h = result$shopper, store = result$store, want = result$want, served = result$served,
                       leaves = sample(16:37, n, replace = TRUE))
  shelf <<- before

  # Trucks leave the DC this morning and arrive when the lead time is up;
  # the plant's trucks come in on I-70 during the day before they're due.
  start <- ticks + 12
  departing <- which(result$shipped > 0)
  arriving <- market$dc_pipe[, day %% SLOTS + 1]
  convoy <- min(8, ceiling(arriving / TRUCK_LOAD))
  trucks <<- rbind(
    trucks[trucks$to > ticks, , drop = FALSE],
    data.frame(route = departing, from = rep(start, length(departing)),
               to = rep(ticks + store_lead * TICKS_PER_DAY, length(departing)),
               load = result$shipped[departing]),
    data.frame(route = rep(0L, convoy), from = ticks + 6 + 3 * seq_len(convoy) - 3,
               to = ticks + TICKS_PER_DAY - 3 + 3 * seq_len(convoy) - 3,
               load = rep(arriving / max(1, convoy), convoy))
  )
}

animate <- function(tick_of_day) {
  n <- shoppers$n
  x <- shoppers$home[, 1]; y <- shoppers$home[, 2]
  colour <- ifelse(let_down, TURNED_AWAY, ifelse(market$aware, AWARE, IDLE))

  # Shoppers on the road: out for 3 ticks, back for 3.
  t <- tick_of_day - trips$leaves
  out <- t >= 0 & t <= 6
  if (any(out)) {
    h <- trips$h[out]; k <- trips$store[out]
    along <- pmin(t[out], 6 - t[out]) / 3
    x[h] <- x[h] + (city$stores[k, 1] - x[h]) * along
    y[h] <- y[h] + (city$stores[k, 2] - y[h]) * along
    back <- t[out] > 3
    colour[h] <- ifelse(!back, SHOPPING, ifelse(trips$served[out] < trips$want[out], TURNED_AWAY, SERVED))
  }
  # Shelves empty as shoppers arrive, and those turned away find out.
  arrived <- t == 3
  if (any(arrived)) {
    let_down[trips$h[arrived]] <<- trips$served[arrived] < trips$want[arrived]
    sold <- rowsum(trips$served[arrived], trips$store[arrived])
    k <- as.integer(rownames(sold))
    shelf[k] <<- shelf[k] - sold[, 1]
  }
  cover <- shelf / market$mu
  store_colour <- ifelse(shelf <= 0, EMPTY, ifelse(cover < 1, LOW, STOCKED))
  dc_colour <- if (sum(market$owed) > 0) EMPTY else if (market$dc_on_hand < sum(market$mu)) LOW else DC_OK

  # Trucks on the road.
  K <- nrow(city$stores)
  truck_x <- rep(city$dc[1], length(members$trucks)); truck_y <- rep(city$dc[2], length(members$trucks))
  truck_heading <- rep(0, length(members$trucks)); truck_size <- rep(0, length(members$trucks))
  truck_colour <- rep(TRUCK, length(members$trucks))
  moving <- which(trucks$from <= ticks & trucks$to > ticks)
  moving <- moving[seq_len(min(length(moving), length(members$trucks)))]
  for (i in seq_along(moving)) {
    tr <- trucks[moving[i], ]
    route <- if (tr$route == 0) city$plant_route else city$store_routes[[tr$route]]
    p <- position_along(route, (ticks - tr$from) / (tr$to - tr$from))
    truck_x[i] <- p[1]; truck_y[i] <- p[2]; truck_heading[i] <- p[3]
    base <- if (tr$route == 0) TRUCK_LOAD else market$mu[tr$route] * 2
    truck_size[i] <- 5 + 4 * min(1, sqrt(tr$load / base))
    truck_colour[i] <- if (tr$route == 0) PLANT_TRUCK else TRUCK
  }

  turtles <<- setXY(turtles = turtles, xcor = c(x, city$stores[, 1], city$dc[1], truck_x),
                    ycor = c(y, city$stores[, 2], city$dc[2], truck_y), world = world, torus = FALSE)
  turtles <<- NLset(turtles = turtles, agents = turtles, var = "color",
                    val = c(colour, store_colour, dc_colour, truck_colour))
  turtles <<- NLset(turtles = turtles, agents = turtles, var = c("heading", "size"),
                    val = cbind(heading = c(rep(0, n + K + 1), truck_heading),
                                size = c(rep(SHOPPER_SIZE, n), rep(8, K), 12, truck_size)))
}

# Where a truck is `share` of the way along a route: x, y and heading.
position_along <- function(route, share) {
  d <- max(route$along) * min(1, max(0, share))
  i <- min(length(route$along) - 1, findInterval(d, route$along, rightmost.closed = TRUE))
  i <- max(1, i)
  f <- (d - route$along[i]) / max(1e-9, route$along[i + 1] - route$along[i])
  dx <- route$x[i + 1] - route$x[i]; dy <- route$y[i + 1] - route$y[i]
  c(route$x[i] + dx * f, route$y[i] + dy * f, (atan2(dx, dy) * 180 / pi) %% 360)
}

SHOPPER_SIZE <- 3.6
IDLE <- "#7f93ad"
AWARE <- "#e64980"
SHOPPING <- "#f8f9fa"
SERVED <- "#69db7c"
TURNED_AWAY <- "#ff4d4f"
STOCKED <- "#20c997"
LOW <- "#fcc419"
EMPTY <- "#ff2d2d"
DC_OK <- "#4dabf7"
TRUCK <- "#ff922b"
PLANT_TRUCK <- "#91a7ff"

# ---- Shoppers -----------------------------------------------------------------

# The same city of households every time (POPULATION_SEED): where they live,
# which store is nearest, their neighbours, how fast they use the product,
# and whether they buy our brand or a rival's.
make_shoppers <- function(n) {
  with_seed(POPULATION_SEED + n, {

  home <- city$homes[sample(nrow(city$homes), n), , drop = FALSE] + matrix(runif(2 * n, -0.4, 0.4), n)
  to_store <- outer(home[, 1], city$stores[, 1], "-")^2 + outer(home[, 2], city$stores[, 2], "-")^2
  ranked <- t(apply(to_store, 1, order))

  # Word of mouth travels between the six nearest households.
  neighbours <- matrix(0L, n, 6)
  for (rows in split(seq_len(n), ceiling(seq_len(n) / 250))) {
    d2 <- outer(home[rows, 1], home[, 1], "-")^2 + outer(home[rows, 2], home[, 2], "-")^2
    d2[cbind(seq_along(rows), rows)] <- Inf
    neighbours[rows, ] <- t(apply(d2, 1, function(r) order(r)[1:6]))
  }

  shoppers <- list(
    n = n, home = home, store1 = ranked[, 1], store2 = ranked[, 2], neighbours = neighbours,
    rate = rgamma(n, shape = 4, rate = 4 * 8),         # units used a day: one every 8 days on average
    loyal = runif(n) >= switchers / 100,               # buys our brand; the rest buy a rival's
    threshold = runif(n, 0.1, 0.6),                    # the discount it takes a rival's buyer to switch
    trips = runif(n, 1, 3) / 7                         # shopping trips a day
  )

  # Pantries as weeks of normal shopping leave them (the same rules as
  # market_day), so day 1 isn't a rush on the stores.
  pantry <- runif(n, 0, 2)
  for (i in seq_len(60)) {
    pantry <- pmax(0, pantry - shoppers$rate)
    top_up <- which(shoppers$loyal & pantry < 1 & runif(n) < shoppers$trips)
    pantry[top_up] <- pantry[top_up] + ceiling(2 - pantry[top_up])
  }
  shoppers$pantry <- pantry
  shoppers
  })
}

# Runs `code` from a fixed seed, then puts the random number stream back, so
# the live run carries on as if nothing had happened.
with_seed <- function(seed, code) {
  saved <- if (exists(".Random.seed", envir = globalenv())) get(".Random.seed", envir = globalenv())
  on.exit(if (is.null(saved)) rm(".Random.seed", envir = globalenv())
          else assign(".Random.seed", saved, envir = globalenv()))
  set.seed(seed)
  code
}

# ---- The market: shoppers, stores, DC and plant -----------------------------

# R futures side by side: every household, store and pipeline exists once per
# future, so one call to market_day() moves all of them a day on. The live
# map is a market with R = 1.
#
# `plan` is NULL when the supply chain isn't told about the promotion (each
# link forecasts from what it sees), or a stores x days matrix of demand
# multipliers the whole chain plans with.
new_market <- function(shoppers, R, plan = NULL, unlimited = FALSE) {
  N <- shoppers$n; K <- nrow(city$stores)
  m <- new.env()
  m$R <- R; m$N <- N; m$K <- K; m$plan <- plan; m$unlimited <- unlimited

  future <- rep(seq_len(R), each = N)
  m$rate <- rep(shoppers$rate, R)
  m$loyal <- rep(shoppers$loyal, R)
  m$threshold <- rep(shoppers$threshold, R)
  m$trips <- rep(shoppers$trips, R)
  m$store1 <- rep(shoppers$store1, R) + K * (future - 1L)
  m$store2 <- rep(shoppers$store2, R) + K * (future - 1L)
  m$neighbours <- shoppers$neighbours[rep(seq_len(N), R), , drop = FALSE] + N * (future - 1L)

  # How shoppers respond isn't known in advance: each future draws its own
  # ad reach, word of mouth and appetite for stocking up around the sliders.
  m$response <- draw_response(R)

  m$pantry <- rep(shoppers$pantry, R)
  m$aware <- logical(N * R)
  m$bought <- logical(N * R)
  m$turned_away <- logical(N * R)
  m$unmet <- numeric(N * R)             # units a household asked for and didn't get

  # Normal daily demand at each store: its loyal households' usage.
  m$mu <- group_sum(shoppers$rate * shoppers$loyal, shoppers$store1, K)
  mu <- rep(m$mu, R)

  # Start in a steady state: forecasts on normal demand, stock and pipelines
  # at the levels the ordering rules keep.
  m$F <- mu; m$base <- mu
  m$on_hand <- round(mu * (1 + safety_days))
  m$owed <- numeric(K * R)
  m$pipe <- matrix(0, K * R, SLOTS)
  for (d in seq_len(store_lead)) m$pipe[, d] <- round(mu)

  total <- sum(m$mu)
  m$capacity <- plant_capacity / 100 * total
  m$dc_F <- rep(total, R); m$dc_base <- rep(total, R)
  m$dc_on_hand <- rep(round(total * (1 + safety_days)), R)
  m$dc_pipe <- matrix(0, R, SLOTS)
  for (d in seq_len(plant_lead)) m$dc_pipe[, d] <- round(total)
  m$plant_backlog <- numeric(R)
  m$store_demand <- array(0, c(DAYS, K, R))
  m
}

# Each future's shopper response: the sliders' values, each scaled by a
# lognormal factor whose spread is the `uncertainty` slider. The median
# future is the sliders' own.
draw_response <- function(R) {
  spread <- function() exp(rnorm(R, 0, uncertainty / 100))
  data.frame(ad_reach = pmin(100, ad_reach * spread()),
             word_of_mouth = pmin(1, word_of_mouth * spread()),
             stockpiling = stockpiling * spread())
}

promo_end <- function() PROMO_START + promo_days - 1
in_promo <- function(day) day >= PROMO_START & day <= promo_end()
# Days whose sales say nothing about normal demand: the promotion and the
# weeks it takes pantries to empty again.
unusual <- function(day) day >= PROMO_START & day <= promo_end() + 21

group_sum <- function(x, g, n) {
  out <- numeric(n)
  if (length(x)) {
    s <- rowsum(x, g)
    out[as.integer(rownames(s))] <- s[, 1]
  }
  out
}
per_future <- function(x, K) colSums(matrix(x, nrow = K))

# One day for every future at once. Returns the day's record (one row per
# future) and, for the live map, today's shoppers and shipments.
market_day <- function(m, day) {
  N <- m$N; K <- m$K; R <- m$R; NR <- N * R
  slot <- (day - 1) %% SLOTS + 1

  # 1. This morning's deliveries.
  m$on_hand <- m$on_hand + m$pipe[, slot]; m$pipe[, slot] <- 0
  m$dc_on_hand <- m$dc_on_hand + m$dc_pipe[, slot]; m$dc_pipe[, slot] <- 0

  # 2. Households use what's in the pantry.
  m$pantry <- pmax(0, m$pantry - m$rate)

  # 3. The promotion: the ad on the first day, then word of mouth.
  promo <- in_promo(day)
  response <- m$response
  if (day == PROMO_START) m$aware <- runif(NR) < rep(response$ad_reach / 100, each = N)
  if (promo) {
    heard <- rowSums(matrix(m$aware[m$neighbours], ncol = 6))
    m$aware <- m$aware | runif(NR) < 1 - (1 - rep(response$word_of_mouth, each = N))^heard
  }
  if (day == promo_end() + 1) { m$aware[] <- FALSE; m$bought[] <- FALSE }

  # 4. Who shops, and for how much. Regular buyers top up when they run low;
  #    anyone after the deal stocks up, and makes a trip for it.
  #    Only households that would buy if they went need a trip drawn.
  deal <- if (promo) m$aware & !m$bought & (m$loyal | m$threshold <= discount / 100) else logical(NR)
  buyers <- which(deal | (m$loyal & m$pantry < 1))
  trip_chance <- ifelse(deal[buyers], pmax(m$trips[buyers], DEAL_TRIP), m$trips[buyers])
  s <- buyers[runif(length(buyers)) < trip_chance]
  appetite <- STOCKPILE_MAX * response$stockpiling[(s - 1L) %/% N + 1L] * discount / 100
  target <- ifelse(deal[s], 2 + rpois(length(s), appetite), 2)
  want <- pmax(0, ceiling(target - m$pantry[s]))
  s <- s[want > 0]; want <- want[want > 0]

  # 5. Where: the nearest store, or the next nearest after being turned away.
  store <- ifelse(m$turned_away[s] & runif(length(s)) < SWITCH_STORE, m$store2[s], m$store1[s])

  # 6. The shelf: shoppers are served in random order until it's empty.
  if (m$unlimited) {
    served <- want
  } else {
    o <- order(store, runif(length(s)))
    s <- s[o]; want <- want[o]; store <- store[o]
    before <- cumsum(want) - want
    first <- which(!duplicated(store))
    before <- before - rep(before[first], diff(c(first, length(s) + 1L)))
    served <- pmin(want, pmax(0, m$on_hand[store] - before))
  }
  # Demand counts each need once: a shopper back for what an empty shelf
  # didn't give them last time is asking again, not wanting more. So sales
  # lost are needs that were never met.
  new <- want - pmin(want, m$unmet[s])
  m$unmet[s] <- want - served
  m$pantry[s] <- m$pantry[s] + served
  m$turned_away[s] <- served < want
  if (promo) m$bought[s] <- m$bought[s] | served > 0
  demand <- group_sum(new, store, K * R)
  sales <- group_sum(served, store, K * R)
  m$store_demand[day, , ] <- demand

  record <- data.frame(day = day, future = seq_len(R), demand = per_future(demand, K),
                       sales = per_future(sales, K), turned_away = per_future(group_sum(want - served, store, K * R), K))
  if (m$unlimited) return(list(record = record))
  m$on_hand <- m$on_hand - sales

  # 7. Stores forecast and order up to what covers the lead time and the
  #    next day, plus safety stock.
  m$F <- m$F + ALPHA * (sales - m$F)
  if (!unusual(day)) m$base <- m$base + ALPHA * (sales - m$base)
  cover <- store_lead + 1
  ahead <- day + seq_len(cover)
  level <- if (is.null(m$plan)) {
    m$F * (cover + safety_days)
  } else {
    m$base * (rep(rowSums(m$plan[, pmin(ahead, DAYS), drop = FALSE]), R) + safety_days)
  }
  order <- pmax(0, round(level - m$on_hand - rowSums(m$pipe) - m$owed))

  # 8. The DC ships what it owes. Short, it shares out what it has.
  due <- m$owed + order
  due_total <- per_future(due, K)
  fill <- ifelse(due_total > 0, pmin(1, m$dc_on_hand / due_total), 1)
  shipped <- floor(due * rep(fill, each = K))
  m$owed <- due - shipped
  m$dc_on_hand <- m$dc_on_hand - per_future(shipped, K)
  arrive <- (day + store_lead - 1) %% SLOTS + 1
  m$pipe[, arrive] <- m$pipe[, arrive] + shipped

  # 9. The DC forecasts its orders (or, sharing POS data, shoppers' sales)
  #    and orders from the plant. With a plan, it plans for the stores'
  #    promotion orders, which come a store lead time before the sales, and
  #    builds ahead whatever the plant couldn't make in time later on.
  signal <- if (share_pos) per_future(sales, K) else per_future(order, K)
  m$dc_F <- m$dc_F + ALPHA * (signal - m$dc_F)
  if (!unusual(day)) m$dc_base <- m$dc_base + ALPHA * (signal - m$dc_base)
  dc_cover <- plant_lead + 1
  dc_level <- if (is.null(m$plan)) {
    m$dc_F * (dc_cover + safety_days)
  } else {
    planned <- function(days) crossprod(m$plan[, days, drop = FALSE], matrix(m$base, K, R))  # days x futures
    soon <- pmin(day + store_lead + 1 + seq_len(dc_cover), DAYS)
    later <- seq_len(max(0, DAYS - max(soon))) + max(soon)
    build_ahead <- if (length(later)) {
      apply(planned(later) - m$capacity, 2, function(excess) max(0, cumsum(excess)))
    } else 0
    colSums(planned(soon)) + m$dc_base * safety_days + build_ahead
  }
  dc_order <- pmax(0, round(dc_level - m$dc_on_hand - rowSums(m$dc_pipe) - m$plant_backlog +
                              per_future(m$owed, K)))

  # 10. The plant makes what it can.
  m$plant_backlog <- m$plant_backlog + dc_order
  made <- pmin(m$capacity, m$plant_backlog)
  m$plant_backlog <- m$plant_backlog - made
  due_at <- (day + plant_lead - 1) %% SLOTS + 1
  m$dc_pipe[, due_at] <- m$dc_pipe[, due_at] + made

  record$store_orders <- per_future(order, K)
  record$dc_orders <- dc_order
  record$made <- made
  record$store_stock <- per_future(m$on_hand, K)
  record$dc_stock <- m$dc_on_hand
  record$owed <- per_future(m$owed, K)
  list(record = record, shopper = s, store = store - K * ((store - 1) %/% K), want = want, served = served,
       shipped = shipped)
}

# ---- Plans --------------------------------------------------------------------

# What the supply chain plans for, as demand multipliers by store and day.
supply_multipliers <- function(plan) {
  K <- nrow(city$stores)
  switch(plan,
    "not told" = NULL,
    "marketing estimate" = {
      m <- matrix(1, K, DAYS)
      m[, in_promo(seq_len(DAYS))] <- expected_lift
      m
    },
    "simulated P90" = {
      if (!futures_current()) simulate_demand()
      futures$p90_plan
    }
  )
}

# The settings a set of futures depends on.
futures_key <- function() {
  c(households, discount, promo_days, ad_reach, word_of_mouth, stockpiling, switchers, uncertainty)
}
futures_current <- function() !is.null(futures) && identical(futures$key, futures_key())
# ...and the settings the plans' results depend on as well.
plans_key <- function() {
  c(futures_key(), expected_lift, share_pos, store_lead, plant_lead, plant_capacity, safety_days)
}
plans_current <- function() futures_current() && identical(futures$plans_key, plans_key())

# Many futures of shopper demand with shelves that never empty: what
# shoppers would buy, and how uncertain that is. From them, the P90 plan:
# each store stocks for its 90th-percentile promotion demand, shaped like the
# median day, and for the median dip after it.
simulate_demand <- function(R = N_FUTURES) {
  started <- proc.time()[["elapsed"]]
  daily <- matrix(0, DAYS, R)
  with_seed(POPULATION_SEED + 1, {
    m <- new_market(shoppers, R = R, unlimited = TRUE)
    for (day in seq_len(DAYS)) daily[day, ] <- market_day(m, day)$record$demand
  })

  K <- nrow(city$stores)
  promo <- which(in_promo(seq_len(DAYS)))
  after <- promo_end() + seq_len(21)
  mu <- m$mu
  window <- apply(m$store_demand[promo, , , drop = FALSE], c(2, 3), sum)       # stores x futures
  lift <- apply(window, 1, quantile, 0.9) / (mu * length(promo))
  median_day <- apply(daily, 1, median) / sum(mu)
  shape <- median_day[promo] / mean(median_day[promo])
  plan <- matrix(1, K, DAYS)
  plan[, promo] <- outer(lift, shape)
  plan[, after] <- matrix(pmin(1, median_day[after]), K, length(after), byrow = TRUE)

  futures <<- list(key = futures_key(), daily = daily, p90_plan = plan,
                   bands = t(apply(daily, 1, quantile, c(0.1, 0.5, 0.9))),
                   lift = quantile(colSums(daily[promo, , drop = FALSE]) / (sum(mu) * length(promo)), c(0.1, 0.5, 0.9)),
                   seconds = proc.time()[["elapsed"]] - started, plans = NULL)
  cat(sprintf("Simulated %d futures of shopper demand in %.1f s: the promotion lifts demand %.1fx (P10 %.1fx, P90 %.1fx).\n",
              R, futures$seconds, futures$lift[2], futures$lift[1], futures$lift[3]))
}


# The same futures for each supply plan: how often shelves run empty, and
# what the plan costs in stock, at its peak and once the promotion is over.
compare_plans <- function(R = N_FUTURES) {
  if (!futures_current()) simulate_demand(R)
  started <- proc.time()[["elapsed"]]
  window <- PROMO_START:(promo_end() + 7)
  after <- promo_end() + 14
  rows <- lapply(PLANS, function(plan) {
    plan_matrix <- supply_multipliers(plan)
    d <- with_seed(POPULATION_SEED + 2, {            # the same futures for every plan, not those planned on
      m <- new_market(shoppers, R = R, plan = plan_matrix)
      do.call(rbind, lapply(seq_len(DAYS), function(day) market_day(m, day)$record))
    })
    normal <- sum(m$mu)
    w <- d[d$day %in% window, ]
    fill <- pmin(1, tapply(w$sales, w$future, sum) / tapply(w$demand, w$future, sum))
    lost <- tapply(d$demand - d$sales, d$future, sum)
    peak <- tapply(d$store_stock + d$dc_stock, d$future, max) / normal
    left <- with(d[d$day == after, ], (store_stock + dc_stock) / normal)
    data.frame(`supply plan` = plan, `fill rate %` = spread_of(100 * fill), `sales lost (units)` = spread_of(lost),
               `peak stock (days)` = spread_of(peak, 1), `stock 2 weeks after (days)` = spread_of(left, 1),
               check.names = FALSE)
  })
  futures$plans <<- do.call(rbind, rows)
  futures$plans_key <<- plans_key()
  cat(sprintf("Ran the same %d futures under each supply plan in %.1f s.\n", R, proc.time()[["elapsed"]] - started))
}

PLANS <- c("not told", "marketing estimate", "simulated P90")

# "96 (76–100)": the median future, and the 10th to 90th percentile.
spread_of <- function(x, digits = 0) {
  v <- format(round(quantile(x, c(0.1, 0.5, 0.9)), digits), nsmall = digits, trim = TRUE)
  sprintf("%s (%s–%s)", v[2], v[1], v[3])
}

# The button: the demand futures for the current settings (made again only
# if a slider changed since), then every plan tested on fresh ones.
simulate_futures <- function() {
  compare_plans()
  update_display()
}

run_summary <- function() {
  d <- history
  w <- d[d$day %in% PROMO_START:(promo_end() + 7), ]
  sprintf("Run over: fill rate %.0f%% through the promotion, %.0f units of sales lost; orders to the plant peaked at %.1fx a normal day.",
          100 * sum(w$sales) / sum(w$demand), sum(d$demand - d$sales), max(d$dc_orders) / sum(market$mu))
}

# ---- Monitors -----------------------------------------------------------------

promo_status <- function() {
  day <- today()
  if (day < PROMO_START) return(sprintf("starts in %d day%s", PROMO_START - day, if (PROMO_START - day == 1) "" else "s"))
  if (in_promo(day)) return(sprintf("day %d of %d, %.0f%% heard", day - PROMO_START + 1, promo_days, 100 * mean(market$aware)))
  "over"
}

# Share of what shoppers wanted that they got: since the promotion started,
# or so far before it.
fill_rate <- function() {
  d <- history
  if (today() >= PROMO_START) d <- d[d$day >= PROMO_START, ]
  min(100, 100 * sum(d$sales) / max(1, sum(d$demand)))
}
units_lost <- function() sum(history$demand - history$sales)
stock_days <- function(where) {
  stock <- if (where == "stores") sum(market$on_hand) else market$dc_on_hand
  stock / sum(market$mu)
}

# ---- Plots and the report -------------------------------------------------------

SHOPPER_LINE <- "#212529"
STORE_LINE <- "#f76707"
DC_LINE <- "#1c7ed6"
STOCK_STORES <- "#0ca678"
LOST <- "#fa5252"
FUTURE_LINE <- "#7048e8"

# The frame every chart shares: days across (with weeks marked), the
# promotion shaded, and a line at today.
chart_frame <- function(ylim, ylab) {
  par(mar = c(2, 3.4, 1.7, 0.6), mgp = c(2.2, 0.55, 0), tcl = -0.25, cex.axis = 0.8, cex.lab = 0.85)
  plot(NA, xlim = c(1, DAYS), ylim = ylim, xlab = "", ylab = ylab, xaxt = "n", yaxt = "n", bty = "n", xaxs = "i")
  rect(PROMO_START - 0.5, ylim[1], promo_end() + 0.5, ylim[2], col = "#fff0f6", border = NA)
  text(PROMO_START - 0.3, ylim[2], "promotion", adj = c(0, 1), cex = 0.7, col = "#d6336c")
  weeks <- seq(1, DAYS, by = 7)
  abline(v = weeks - 0.5, col = "gray93")
  axis(1, at = weeks + 3, labels = paste("wk", seq_along(weeks)), tick = FALSE, line = -0.8, cex.axis = 0.75)
  axis(2, las = 1, col = NA, col.ticks = "gray70")
  if (!is.null(history) && ticks > 0) abline(v = today(), col = "gray55", lty = 3)
}

# A one-line legend above the chart, so it never covers the data.
top_legend <- function(labels, col, lwd = 2, lty = 1) {
  legend("top", labels, col = col, lwd = lwd, lty = lty, horiz = TRUE, bty = "n", cex = 0.75,
         inset = c(0, -0.16), xpd = NA, seg.len = 1.4, x.intersp = 0.5, text.width = NA)
}

plot_chain <- function() {
  normal <- sum(market$mu)
  d <- history
  y <- cbind(d$demand, d$store_orders, d$dc_orders) / normal
  chart_frame(c(0, max(4, y) * 1.08), "× a normal day")
  abline(h = 1, col = "gray80")
  matlines(d$day, y, lty = 1, lwd = c(2.4, 1.6, 1.6), col = c(SHOPPER_LINE, STORE_LINE, DC_LINE))
  top_legend(c("shoppers' demand", "stores' orders", "DC's orders to the plant"), c(SHOPPER_LINE, STORE_LINE, DC_LINE))
}

plot_stock <- function() {
  normal <- sum(market$mu)
  d <- history
  stores <- d$store_stock / normal; dc <- d$dc_stock / normal; lost <- d$turned_away / normal
  chart_frame(c(0, max(6, stores, dc, lost) * 1.08), "days of normal demand")
  rect(d$day - 0.42, 0, d$day + 0.42, lost, col = LOST, border = NA)
  lines(d$day, stores, col = STOCK_STORES, lwd = 2)
  lines(d$day, dc, col = DC_LINE, lwd = 2)
  top_legend(c("stock in stores", "stock at the DC", "turned away"), c(STOCK_STORES, DC_LINE, LOST), lwd = c(2, 2, 6))
}

plot_futures <- function() {
  normal <- sum(market$mu)
  current <- futures_current()
  top <- if (current) max(futures$daily) / normal else 4
  chart_frame(c(0, max(4, top, history$demand / normal) * 1.08), "× a normal day")
  if (current) {
    matlines(seq_len(DAYS), futures$daily / normal, lty = 1, lwd = 0.8, col = adjustcolor(FUTURE_LINE, 0.18))
    lines(seq_len(DAYS), futures$bands[, 3] / normal, col = FUTURE_LINE, lwd = 1.2, lty = 2)
    lines(seq_len(DAYS), futures$bands[, 2] / normal, col = FUTURE_LINE, lwd = 2)
  } else {
    text(DAYS / 2, 2.4, "Press \"simulate futures\" to see the range", col = "gray45", cex = 0.85)
  }
  lines(history$day, history$demand / normal, col = SHOPPER_LINE, lwd = 2.4)
  top_legend(c("this run", "median future", "90th percentile", "each future"),
             c(SHOPPER_LINE, FUTURE_LINE, FUTURE_LINE, adjustcolor(FUTURE_LINE, 0.4)),
             lwd = c(2.4, 2, 1.2, 0.8), lty = c(1, 1, 2, 1))
}

report_plans <- function() {
  if (!plans_current()) {
    cat(sprintf("Press \"simulate futures\". The P90 plan is made from %d futures of shopper response; then\n", N_FUTURES),
        sprintf("each supply plan runs through the same %d fresh futures, and this table shows the median\n", N_FUTURES),
        "future with the 10th-90th percentile range.\n", sep = "")
    return(invisible())
  }
  cat(sprintf("The promotion lifts demand %.1fx in the median future (%.1fx to %.1fx). Each plan, through the same %d\n",
              futures$lift[2], futures$lift[1], futures$lift[3], N_FUTURES),
      "fresh futures: the median, and the 10th to 90th percentile.\n\n", sep = "")
  print(futures$plans, row.names = FALSE, right = FALSE)
}
