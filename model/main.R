# Fashion market: setup(), go(), and the settings that act live.
#
# One simulation, two paces:
#   season  one tick is a market day: every store's day, step by step
#   watch   one tick is a few seconds of store time (P$watch_speed / 30):
#           the steps it crosses; the page draws the market's traffic and a
#           store's floor as they are at that second
# The same seed gives the same season at either pace (tools/test-fashion.R
# checks it), because drawing and reporting never use the random numbers.
#
# The world. setup() starts a season in the installed world (world.R): its
# map, stores, layouts, brands, segments, and every setting as it stands.
# A new world is installed at Setup; until then, changes to the world wait.
# Live settings (a brand's levers, stock rules and price rules, a store's
# staffing, the market's weights) act from the moment they change; the page names brands and stores by id, so a change
# to one that isn't installed yet simply waits for Setup.
#
# State. The map and the store floors are NetLogoR worlds, and the
# households are NetLogoR turtles (city.R). While the season runs, their
# state lives in plain vectors in global lists (mk, d, stock, ...), updated
# in place with `x$field[i] <<- value`: webR runs NetLogoR's agent tables,
# and environments, far slower than it updates a vector in place.

fl <- NULL; city <- NULL; hh_cache <- NULL; km_cache <- NULL
mk <- NULL; d <- NULL; legs <- NULL; staff <- NULL; vlog <- NULL; queues <- NULL; exits <- NULL
stock <- NULL; tally <- NULL; today <- NULL; ofr <- NULL; cal <- NULL; prev <- NULL; season_log <- NULL
cat_price <- NULL; markdown <- NULL; marked_on <- NULL; pop <- NULL; launched <- NULL; today_promos <- NULL
day <- 0L; clock <- 0; next_step <- 0; season_over <- FALSE
P <- DEFAULTS
P_STOCK <- NULL; P_PRICE <- NULL
S <- NULL
selected <- list(household = NA_integer_, visit = NA_integer_, visit_day = NA_integer_, inspect = NULL)
homes_version <- 0L
world_version <- 0L

setup <- function(seed = P$seed) {
  P$seed <<- seed
  set.seed(seed)
  if (is.null(fl)) { fl <<- build_floors(); world_version <<- world_version + 1L }
  MAX_SERVERS <<- fl$max_servers
  if (is.null(city)) { city <<- build_city(); hh_cache <<- NULL }
  if (is.null(hh_cache)) {
    hh_cache <<- build_households(city)
    km_cache <<- trip_tables(city, hh_cache)
    world_version <<- world_version + 1L
  }
  n <- hh_cache$n
  near <- vapply(seq_len(N_BRANDS), function(b) {             # each household's nearest store of each brand, km
    s <- which(STORES$brand == b)
    do.call(pmin, c(lapply(s, function(k) km_cache$km[, k]), Inf))
  }, numeric(n))
  mk <<- list(hh = hh_cache, km = km_cache$km, drive_s = km_cache$drive_s, near_km = matrix(near, n),
              grudge = matrix(0, n, N_BRANDS), last_brand = integer(n),
              budget_left = hh_cache$budget, buzz = matrix(0.3, N_WOM_CELLS, N_BRANDS), customer = matrix(FALSE, n, N_BRANDS),
              tier = hh_cache$tier0, tier0 = hh_cache$tier0, spend = matrix(0, n, N_BRANDS), spend_day = 0L)
  prev <<- NULL
  season_log <<- list(n = 0L, m = matrix(0L, 3500L * SEASON_DAYS, 4), sales = numeric(3500L * SEASON_DAYS))
  day <<- 0L; season_over <<- FALSE; trips <<- NULL
  selected <<- list(household = NA_integer_, visit = NA_integer_, visit_day = NA_integer_, inspect = NULL)
  init_catalogue()
  init_tally()
  new_today()
  init_stock()
  init_calendar()
  init_offers()
  start_day()
  homes_version <<- homes_version + 1L
  invisible(TRUE)
}

# One tick. Returns TRUE when the season is over.
go <- function() {
  if (season_over) return(TRUE)
  if (P$pace == "season") {
    advance(Inf)
    finish_day()
  } else {
    advance(clock + P$watch_speed / 30)
    if (day_over() && clock >= DAY_S + 900) finish_day()
  }
  season_over
}

finish_day <- function() {
  end_day()
  prev <<- list(d = d, legs = legs, staff = staff, today = today, vlog = vlog, day = day)
  homes_version <<- homes_version + 1L
  if (day >= SEASON_DAYS) { season_over <<- TRUE; return(invisible()) }
  start_day()
}

# The world the app opens with, from `root` (worlds/ and layouts/).
load_default_world <- function(root) {
  text <- paste(readLines(file.path(root, "worlds", "default.world.json"), warn = FALSE), collapse = "\n")
  problems <- world_load(text, file.path(root, "layouts"))
  if (length(problems)) stop("the default world has problems: ", paste(vapply(problems, function(p) paste0(p$path, ": ", p$message), ""), collapse = "; "))
  invisible(TRUE)
}

# ---- Live settings ------------------------------------------------------------------

# A brand or store named by id (or number): its number in the installed
# world, or NA if it isn't installed (the change waits for Setup).
brand_index <- function(b) if (is.character(b)) match(b, BRANDS$id) else as.integer(b)
store_index <- function(s) if (is.character(s)) match(s, STORES$id) else as.integer(s)

# A brand lever: price change, promotion depth (for the Market tab's
# buttons), marketing, or staffing (which sets every store of the brand,
# from this moment of the store day on).
set_lever <- function(name, brand, value) {
  L <- LEVERS[[name]]
  if (is.null(L)) stop("no lever called ", name)
  value <- clamp(as.numeric(value), L$min, L$max)
  if (L$kind == "int") value <- round(value)
  b <- brand_index(brand)
  if (is.na(b)) return(invisible(value))
  LEVERS[[name]]$value[b] <<- value
  if (name == "price") cat_price[b, ] <<- value * LIST_PRICE[b, ]
  if (name %in% c("cashiers", "assistants", "skill", "scan_s")) {
    for (s in which(STORES$brand == b)) set_store(s, name, value)
  }
  invisible(value)
}

# One store's staffing and service settings. Cashiers and fitting rooms go
# up to what its layout has.
set_store <- function(store, name, value) {
  f <- FIELDS$staff[[name]]
  if (is.null(f)) stop("no store setting called ", name)
  value <- as.numeric(value)
  if (f$kind == "int") value <- round(value)
  s <- store_index(store)
  if (is.na(s)) return(invisible(clamp(value, f$min, f$max)))
  lay <- STORES$format[s]
  hi <- switch(name, cashiers = fl$n_tills[lay], fitting_rooms = fl$n_cubicles[lay], f$max)
  value <- clamp(value, f$min, hi)
  S[s, name] <<- value
  row <- switch(name, fitting_rooms = FR_ROW + s, cashiers = TILL_ROW + s, assistants = STAFF_ROW + s, NA)
  if (!is.na(row) && !is.null(queues)) resize_queue(row, value, clock)
  invisible(value)
}

MARKET_FIELDS <- c("seed", names(FIELDS$market), "pace", "watch_speed")
set_market <- function(name, value) {
  if (!name %in% MARKET_FIELDS) stop("no setting called ", name)
  if (name == "pace") {
    if (!value %in% c("season", "watch")) stop("pace is season or watch")
  } else {
    value <- as.numeric(value)
    f <- FIELDS$market[[name]]
    if (!is.null(f)) value <- clamp(if (f$kind == "int") round(value) else value, f$min, f$max)
    if (name == "seed") value <- clamp(round(value), 1, .Machine$integer.max)
    if (name == "watch_speed") value <- clamp(value, 1, 36000)
  }
  P[[name]] <<- value
  invisible(value)
}

set_stock <- function(name, brand, value) {
  if (name == "allocation") {
    if (!value %in% ALLOCATIONS) stop("allocation is flat or learned")
  } else {
    f <- FIELDS$stock[[name]]
    if (is.null(f)) stop("no stock rule called ", name)
    value <- clamp(as.numeric(value), f$min, f$max)
    if (f$kind == "int") value <- round(value)
  }
  b <- brand_index(brand)
  if (!is.na(b)) P_STOCK[b, name] <<- value
  invisible(value)
}

# A brand's price rules: whether its promotions come off marked-down
# products (from this moment: today's prices are worked out again), and its
# sell-through target (what its markdowns behind plan measure against, from
# the next one).
set_pricing <- function(name, brand, value) {
  if (name == "promos_on_markdowns") {
    value <- isTRUE(as.logical(value))
  } else {
    f <- FIELDS$pricing[[name]]
    if (is.null(f)) stop("no price rule called ", name)
    value <- clamp(as.numeric(value), f$min, f$max)
    if (f$kind == "int") value <- round(value)
  }
  b <- brand_index(brand)
  if (is.na(b)) return(invisible(value))
  P_PRICE[b, name] <<- value
  if (name == "promos_on_markdowns" && !is.null(cal)) {
    prices_today()
    promos <- promo_rows(d$brand, d$reached)
    d$promo_row <<- promos$row; d$promo_off <<- promos$off
  }
  invisible(value)
}

# ---- Picks for the page ------------------------------------------------------------

pick_household <- function(h = NA) {
  if (is.na(h)) h <- ui_pick(seq_len(mk$hh$n))
  selected$household <<- as.integer(h)
  invisible(h)
}

# Follow a shopper: one in the store now (clicked, or at random), else any
# of today's visits there. Following opens the inspector on them too.
follow_visit <- function(store, v = NA) {
  if (is.na(v)) {
    here <- which(d$store == store & d$arrive <= clock & d$gone > clock)
    if (!length(here)) here <- which(d$store == store & d$arrive <= max(clock, DAY_S))
    v <- ui_pick(here)
  }
  if (length(v) && !is.na(v)) {
    selected[c("visit", "visit_day")] <<- list(as.integer(v), day)
    selected$inspect <<- list(kind = "shopper", store = as.integer(store), visit = as.integer(v), day = day)
  }
  invisible(v)
}

# A click on a store's floor: the nearest shopper or worker within 1.5 m.
# A shopper is followed and inspected; a worker is inspected.
inspect_at <- function(store, x, y) {
  f <- floor_agents(store, clock)
  ds <- (f$x - x)^2 + (f$y - y)^2
  dw <- (f$staff_x - x)^2 + (f$staff_y - y)^2
  best_s <- if (length(ds)) which.min(ds) else 0L
  best_w <- if (length(dw)) which.min(dw) else 0L
  s_d <- if (best_s) ds[best_s] else Inf; w_d <- if (best_w) dw[best_w] else Inf
  if (min(s_d, w_d) > 9) return(invisible(NA))
  if (w_d < s_d) {
    selected$inspect <<- list(kind = if (f$staff_role[best_w] == 1L) "cashier" else "assistant", store = as.integer(store),
                              server = as.integer(f$staff_id[best_w]), day = day)
    return(invisible(TRUE))
  }
  follow_visit(store, f$visit[best_s])
}

close_inspector <- function() { selected$inspect <<- NULL; invisible(TRUE) }
