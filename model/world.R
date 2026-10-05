# The world file: everything the end user builds, in one JSON document.
#
#   season_days  how long the season runs
#   demand_events  days the season's demand is lifted or suppressed: each
#                a solid strength on its days, or a ramp walking up to it
#   categories   what's sold, market-wide: each category's name, colour,
#                the key its racks are painted with, whether it's tried
#                on, and its typical price
#   macro        the market: a painted map of land, roads, water and homes,
#                optional named areas, and how households are made up
#   layouts      store floor plans (the micro world), one text picture each
#   stores       places on the map, each running a layout for a brand
#   families     holding companies; exactly one is ours
#   brands       who sells: prices, staff, stock, taste by segment, loyalty
#                tiers (earned by spend), and the brand's own range (its
#                products) and calendar (its promotions, offers, markdowns
#                and replenishment), with its price rules; its online store
#                (if it has one) and its return policy
#   segments     who shops: how they behave, and how far they'll travel
#   market       market-wide weights
#
# How people behave is the model, not the world; it stays in params.R.
# world_check() lists every problem with a file, precisely, and
# world_install() installs a clean one: it sets the tables the simulation
# reads (BRANDS, STORES, SEGMENTS, the categories and every brand's
# products, ...) and drops what was worked out for the last world (floors,
# the city, routes). Older files are upgraded as they're read
# (world_upgrade): version 1 had a fixed catalogue, the same for every
# brand; version 2 had one replenishment rule for every brand (Mondays) and
# automatic markdowns (a Sunday review) outside the calendar; version 3
# gave every brand a plan for every category, whether it sold it or not;
# version 4 chose stores without regard to what their brands sell;
# version 5 earned loyalty tiers by paid visits and ran each brand's offers
# as a programme outside the calendar (a policy choosing among three kinds
# of offer for its daily contacts); version 6 had a promotion depth for each
# brand and a promotion length for the market, for the Market tab's
# promotion buttons, and no online stores or returns; version 7 had every
# segment return what it bought at the same rates; version 8 had no demand
# events.

WORLD_KIND <- "fashion-world"
LAYOUT_KIND <- "fashion-layout"
WORLD_VERSION <- 9L
LAYOUT_VERSION <- 2L                 # a layout file's own version (its format hasn't changed since the world's version 2)
NO_DAY <- 1e6                        # the landing day of a product slot a brand's range doesn't fill

WORLD <- NULL
world_key <- list(layouts = "", routes = "", households = "")

# ---- Reading and writing ----------------------------------------------------------

world_parse <- function(text) {
  W <- tryCatch(jsonlite::fromJSON(text, simplifyVector = FALSE), error = function(e) e)
  if (inherits(W, "error")) stop("not a JSON file: ", conditionMessage(W), call. = FALSE)
  W
}

world_read <- function(path, prefab_dir = file.path(dirname(dirname(path)), "layouts")) {
  world_resolve(world_upgrade(world_parse(paste(readLines(path, warn = FALSE), collapse = "\n"))), prefab_dir)
}

# Puts each prefab layout ({"prefab": "flagship"}) inline, from its file.
world_resolve <- function(W, prefab_dir) {
  if (!is.list(W$layouts)) return(W)
  W$layouts <- lapply(W$layouts, function(L) {
    if (!is.list(L) || is.null(L$prefab) || length(L) != 1L) return(L)
    f <- file.path(prefab_dir, paste0(L$prefab, ".layout.json"))
    if (!file.exists(f)) return(L)
    layout_from_file(world_parse(paste(readLines(f, warn = FALSE), collapse = "\n")))
  })
  W
}

layout_from_file <- function(L) L[setdiff(names(L), c("kind", "version"))]

# The JSON text of a world (or a layout), laid out the same way the page
# writes it: two-space indents, short arrays on one line, long ones (the
# pictures' rows) one item per line, numbers to 15 significant digits.
world_text <- function(x) paste0(json_value(x, ""), "\n")

json_value <- function(x, indent) {
  inner <- paste0(indent, "  ")
  if (is.null(x)) return("null")
  if (is.list(x)) {
    obj <- !is.null(names(x))
    if (!length(x)) return(if (obj) "{}" else "[]")
    items <- vapply(seq_along(x), function(i) json_value(x[[i]], inner), "")
    if (obj) items <- paste0(vapply(names(x), json_string, ""), ": ", items)
    flat <- all(vapply(x, function(v) !is.list(v) || !length(v), TRUE))
    open <- if (obj) "{" else "["; close <- if (obj) "}" else "]"
    if (flat && sum(nchar(items)) + 2 * length(items) <= 100) return(paste0(open, paste(items, collapse = ", "), close))
    return(paste0(open, "\n", paste0(inner, items, collapse = ",\n"), "\n", indent, close))
  }
  if (length(x) != 1L) return(json_value(as.list(x), indent))
  if (is.character(x)) return(json_string(x))
  if (is.logical(x)) return(if (is.na(x)) "null" else if (x) "true" else "false")
  if (!is.finite(x)) return("null")
  json_number(x)
}

json_string <- function(s) as.character(jsonlite::toJSON(s, auto_unbox = TRUE))

json_number <- function(v) {
  s <- sprintf("%.15g", v)
  s <- sub("e([+-])0*([0-9])", "e\\1\\2", s)       # 1e-07 -> 1e-7, as JavaScript writes it
  sub("e\\+", "e+", s)
}

slug <- function(text) {
  s <- gsub("^_+|_+$", "", gsub("[^a-z0-9]+", "_", tolower(text)))
  if (nzchar(s)) substr(s, 1, 32) else "item"
}

# ---- Version 1 files ---------------------------------------------------------------

# The catalogue every version 1 world had: seven categories, and five
# styles in each at a step of the category's price, landing in three drops.
# A version 1 brand sold all 35 at its price index, costing a share of the
# price; its range is now those 35 products, priced so.
V1_CATALOGUE <- list(
  categories = data.frame(
    id = c("denim", "tops", "knitwear", "outerwear", "dresses", "shoes", "accessories"),
    name = c("Denim", "Tops", "Knitwear", "Outerwear", "Dresses", "Shoes", "Accessories"),
    key = c("D", "T", "K", "O", "R", "S", "A"),
    colour = c("#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7"),
    try_on = c(TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE),
    price = c(60, 30, 50, 120, 70, 80, 25), stringsAsFactors = FALSE),
  steps = c(0.8, 0.9, 1, 1.15, 1.3),               # each style's price against its category's
  days = c(1, 1, 29, 29, 57),                      # the day each lands (Monday of weeks 1, 5 and 9)
  names = list(
    denim = c("Straight-leg jeans", "Slim jeans", "Denim jacket", "Wide-leg jeans", "Selvedge jeans"),
    tops = c("Cotton tee", "Striped top", "Oxford shirt", "Linen shirt", "Silk blouse"),
    knitwear = c("Cotton jumper", "Cardigan", "Merino jumper", "Cable knit", "Cashmere jumper"),
    outerwear = c("Rain jacket", "Bomber jacket", "Trench coat", "Puffer jacket", "Wool coat"),
    dresses = c("Jersey dress", "Shirt dress", "Wrap dress", "Slip dress", "Evening dress"),
    shoes = c("Canvas trainers", "Loafers", "Leather trainers", "Chelsea boots", "Heeled boots"),
    accessories = c("Beanie", "Scarf", "Belt", "Tote bag", "Crossbody bag"))
)

v1_categories <- function() {
  cats <- V1_CATALOGUE$categories
  lapply(seq_len(nrow(cats)), function(k) list(id = cats$id[k], name = cats$name[k], key = cats$key[k], colour = cats$colour[k],
                                               try_on = cats$try_on[k], price = cats$price[k]))
}

# A version 1 brand's range: every style, at its price index, costing
# `cost` of the price.
v1_range <- function(index, cost) {
  C <- V1_CATALOGUE; cats <- C$categories
  unlist(lapply(seq_len(nrow(cats)), function(c) lapply(seq_along(C$steps), function(k) {
    price <- index * (cats$price[c] * C$steps[k])
    list(id = slug(C$names[[cats$id[c]]][k]), name = C$names[[cats$id[c]]][k], category = cats$id[c],
         price = price, cost = cost * price, day = C$days[k])
  })), recursive = FALSE)
}

# Version 1 floor plans had a new-arrivals table (N) and a promotion table
# (P), which shoppers never went to. They become racks: tops and denim.
v1_layout_rows <- function(rows) chartr("NP", "TD", rows)

# An older world, as this version reads it, a version at a time.
world_upgrade <- function(W) {
  version <- if (is.list(W) && is.numeric(W$version) && length(W$version) == 1L) as.integer(W$version) else NA
  if (identical(version, 1L)) { W <- upgrade_v1(W); version <- 2L }
  if (identical(version, 2L)) { W <- upgrade_v2(W); version <- 3L }
  if (identical(version, 3L)) { W <- upgrade_v3(W); version <- 4L }
  if (identical(version, 4L)) { W <- upgrade_v4(W); version <- 5L }
  if (identical(version, 5L)) { W <- upgrade_v5(W); version <- 6L }
  if (identical(version, 6L)) { W <- upgrade_v6(W); version <- 7L }
  if (identical(version, 7L)) { W <- upgrade_v7(W); version <- 8L }
  if (identical(version, 8L)) W <- upgrade_v8(W)
  W
}

num_or <- function(x, default) if (is.numeric(x) && length(x) == 1L) x else default

# A version 1 world, as version 2: the catalogue becomes the world's
# categories and each brand's range (its price index moves into the list
# prices, and its lever becomes a change of 1); the markdown rules move
# from a brand's stock to its price rules, with automatic markdowns on; the
# calendar starts empty. Who a brand's promotions reached was a setting for
# the Market tab's buttons, which now reach every tier; it goes.
upgrade_v1 <- function(W) {
  brand <- function(b) {
    if (!is.list(b) || is.null(names(b))) return(b)
    st <- if (is.list(b$stock)) b$stock else list()
    lev <- b$levers
    index <- if (is.list(lev)) num_or(lev$price, 1) else 1
    if (is.list(lev) && !is.null(lev$price)) lev$price <- 1
    list(id = b$id, name = b$name, family = b$family, colour = b$colour, fit = b$fit, levers = lev,
         stock = list(allocation = st$allocation, season_buy = st$season_buy, lead_days = st$lead_days, plan = st$plan),
         pricing = list(promos_on_markdowns = TRUE, auto_markdowns = TRUE,
                        md_target = st$md_target, md_step = st$md_step, clearance_weeks = st$clearance_weeks),
         loyalty = b$loyalty, offers = b$offers,
         range = v1_range(index, num_or(b$cost, 0.5)),
         calendar = list(promotions = list(), markdowns = list()))
  }
  layout <- function(L) {
    if (is.list(L) && (is.list(L$rows) || is.character(L$rows))) L$rows <- as.list(v1_layout_rows(unlist(L$rows)))
    L
  }
  out <- list(kind = W$kind, version = 2L, name = W$name, seed = W$seed, season_days = 91L,
              categories = v1_categories(), macro = W$macro,
              layouts = if (is.list(W$layouts)) lapply(W$layouts, layout) else W$layouts,
              stores = W$stores, families = W$families,
              brands = if (is.list(W$brands)) lapply(W$brands, brand) else W$brands,
              segments = W$segments, market = W$market)
  c(out[!vapply(out, is.null, TRUE)], W[setdiff(names(W), names(out))])
}

# A version 2 world, as version 3: what a brand did without saying so is
# written into its calendar and stock settings, so the upgraded world runs
# the season it ran, as closely as a product taking one markdown entry a
# day allows.
#   replenishment  it topped each store up to 1.25 weeks of demand beyond
#                  the lead time, every Monday, over its whole range
#   opening        it sent each store two weeks of planned sales when a
#                  product landed
#   markdowns      its planned markdowns act once, on their day; with
#                  automatic markdowns on, a Sunday review took each product
#                  behind plan (more than 5 points behind, in the stores two
#                  weeks) a step deeper, to at most 60%, and in its
#                  clearance weeks everything went to at least half price.
#                  That is a Monday review (the same data: nothing sells
#                  overnight), a final markdown to 50% where the clearance
#                  began, and the review going on after it.
# Deliveries cost nothing then, and unsold stock was never charged: the new
# stock settings get the default world's assumed fees and salvage value. A
# planned markdown of 0% (it put a product back to full price) goes:
# markdowns are now permanent, and a temporary cut is a promotion.
V2_STOCK <- list(opening_weeks = 2, delivery_fee = 150, unit_fee = 0.4, salvage = 0.2)

weekly_replenishment <- function(days) {
  list(id = "weekly_replenishment", name = "Weekly replenishment", on = "range", items = list(), from = 1L, to = as.integer(days),
       weekdays = list("Mon"), rule = "top_up", cover = 1.25, reorder = 1.25)
}

markdown_entry <- function(id, name, from, to, weekdays = list(), which = "all", mode = "to", depth, max = 0.6,
                           on = "range", items = list()) {
  list(id = id, name = name, on = on, items = items, from = as.integer(from), to = as.integer(to), weekdays = weekdays,
       which = which, by = 0.05, min_days = 14L, rest_days = 0L, mode = mode, depth = depth, max = max)
}

# A version 2 brand's automatic markdowns, as calendar entries.
v2_review <- function(pr, days) {
  step <- num_or(pr$md_step, 0.2)
  weeks <- ceiling(days / 7)
  start <- 7 * max(1, weeks - num_or(pr$clearance_weeks, 2)) + 1      # the Monday its clearance was in force from
  review <- function(id, name, from, to) markdown_entry(id, name, from, to, list("Mon"), "behind", "deeper", step)
  out <- list()
  if (start - 1 >= 8) out[[length(out) + 1L]] <- review("weekly_review", "Weekly review", 8, min(days, start - 1))
  if (start <= days) out[[length(out) + 1L]] <- markdown_entry("final_markdown", "Final markdown", start, start, depth = 0.5)
  if (start + 7 <= days) out[[length(out) + 1L]] <- review("clearance_review", "Weekly review, clearance", start + 1, days)
  out
}

upgrade_v2 <- function(W) {
  days <- if (is.numeric(W$season_days) && length(W$season_days) == 1L) W$season_days else 91L
  brand <- function(b) {
    if (!is.list(b) || is.null(names(b))) return(b)
    if (is.list(b$stock) && !is.null(names(b$stock))) {
      st <- b$stock
      b$stock <- c(st[intersect(c("allocation", "season_buy", "lead_days"), names(st))], V2_STOCK,
                   st[setdiff(names(st), c("allocation", "season_buy", "lead_days", names(V2_STOCK)))])
    }
    pr <- if (is.list(b$pricing) && !is.null(names(b$pricing))) b$pricing else NULL
    if (!is.null(pr)) b$pricing <- pr[setdiff(names(pr), c("auto_markdowns", "md_step", "clearance_weeks"))]
    if (is.list(b$calendar) && (!length(b$calendar) || !is.null(names(b$calendar)))) {
      mds <- if (is.list(b$calendar$markdowns)) b$calendar$markdowns else list()
      to_full_price <- function(x) is.list(x) && is.numeric(x$depth) && length(x$depth) == 1L && x$depth == 0
      planned <- lapply(Filter(Negate(to_full_price), mds), function(x) {
        if (!is.list(x) || is.null(names(x)) || !is.numeric(x$from)) return(x)
        markdown_entry(x$id, x$name, x$from, x$from, depth = x$depth, on = x$on, items = x$items)
      })
      auto <- if (!is.null(pr) && isTRUE(pr$auto_markdowns)) v2_review(pr, days) else list()
      taken <- vapply(planned, function(x) if (is.list(x)) text_of(x$id) else "", "")
      for (i in seq_along(auto)) {                    # ids of their own, beside the planned ones
        id <- auto[[i]]$id; k <- 1L
        while (id %in% taken) { k <- k + 1L; id <- paste0(auto[[i]]$id, "_", k) }
        auto[[i]]$id <- id; taken <- c(taken, id)
      }
      b$calendar$markdowns <- c(planned, auto)
      b$calendar$replenishment <- list(weekly_replenishment(days))
    }
    b
  }
  W$version <- 3L
  if (is.list(W$brands)) W$brands <- lapply(W$brands, brand)
  W
}

# A version 3 world, as version 4: a brand's plan (its units a week, by
# category) keeps only the categories it sells, the ones it has products
# in. The rest never counted: a brand buys only what its range holds.
upgrade_v3 <- function(W) {
  brand <- function(b) {
    if (!is.list(b) || !is.list(b$stock) || !is.list(b$stock$plan) || is.null(names(b$stock$plan)) || !is.list(b$range)) return(b)
    sells <- vapply(b$range, function(x) if (is.list(x)) text_of(x$category) else "", "")
    b$stock$plan <- b$stock$plan[names(b$stock$plan) %in% sells]
    if (!length(b$stock$plan)) b$stock$plan <- setNames(list(), character())
    b
  }
  W$version <- 4L
  if (is.list(W$brands)) W$brands <- lapply(W$brands, brand)
  W
}

# A version 4 world, as version 5: a store's appeal weighs what its brand
# sells (market.R, range_value), by the market's weight of the range, 1. A
# world in which every brand sells every category runs as it did.
upgrade_v4 <- function(W) {
  W$version <- 5L
  if (is.list(W$market) && !is.null(names(W$market)) && is.null(W$market[["range_w"]])) W$market$range_w <- 1
  W
}

# A version 5 world, as version 6.
#   loyalty  a tier was earned by paid visits (up one after `up_after` since
#            the last change) and lost by a bad visit or a lapse; now each
#            tier has the season's spend that reaches it. The upgrade makes
#            it the old climb, in visits at the brand's typical price:
#            (k - 1) x up_after x the median of its list prices (the lowest
#            tier: nothing), to the nearest $5.
#   offers   the programme (a policy choosing, for its contacts each day,
#            between a coupon, a styling session, a new-arrivals preview
#            and holding out) becomes, when it was on, one offer on the
#            calendar: its coupon, all season, to as many of its tiers'
#            households as held one of its offers at a time (contacts a day
#            x the window, of the map's households), a quarter held out (as
#            the control was one of four actions), good where its offers
#            were. A segment's response to offers is its response to the
#            coupon.
upgrade_v5 <- function(W) {
  days <- num_or(W$season_days, 91)
  households <- if (is.list(W$macro)) num_or(W$macro$households, 0) else 0
  brand <- function(b) {
    if (!is.list(b) || is.null(names(b))) return(b)
    L <- b$loyalty
    if (is.list(L) && !is.null(names(L)) && is.list(L$tiers)) {
      step <- num_or(L$up_after, 3)
      prices <- if (is.list(b$range)) unlist(lapply(b$range, function(x) if (is.list(x) && is.numeric(x$price)) x$price)) else NULL
      typical <- if (length(prices)) stats::median(prices) else 50
      L$tiers <- lapply(seq_along(L$tiers), function(k) {
        t <- L$tiers[[k]]
        if (!is.list(t) || is.null(names(t))) return(t)
        first <- intersect(c("id", "name", "share"), names(t))
        c(t[first], list(spend = 5 * round((k - 1) * step * typical / 5)), t[setdiff(names(t), c(first, "spend"))])
      })
      b$loyalty <- L[setdiff(names(L), c("up_after", "down_chance", "lapse_days"))]
    }
    o <- b$offers
    b$offers <- NULL
    if (is.list(b$calendar) && (!length(b$calendar) || !is.null(names(b$calendar)))) {
      on <- is.list(o) && isTRUE(o$on) && is.list(o$coupon) && is.list(o$tiers) && length(o$tiers)
      b$calendar$offers <- if (on) list(list(
        id = "coupon", name = "Coupon", from = 1L, to = as.integer(days),
        depth = num_or(o$coupon$depth, 0.15), send_cost = num_or(o$coupon$send, 0),
        audience = if (households > 0) min(1, max(0.01, round(num_or(o$contacts, 0) * num_or(o$window, 7) / households, 2))) else 0.1,
        holdout = 0.25, tiers = o$tiers, areas = list(), also_at = if (is.list(o$also_at)) o$also_at else list())) else list()
    }
    b
  }
  segment <- function(s) {
    if (!is.list(s) || !is.list(s$offer_response) || !is.list(s$offer_response$coupon)) return(s)
    s$offer_response <- s$offer_response$coupon
    s
  }
  W$version <- 6L
  if (is.list(W$brands)) W$brands <- lapply(W$brands, brand)
  if (is.list(W$segments)) W$segments <- lapply(W$segments, segment)
  W
}

# A version 6 world, as version 7.
#   promotions  the Market tab's promotion buttons started promotions
#               mid-season, at each brand's promotion depth, for the
#               market's promotion length. The buttons have gone
#               (promotions are set on the calendar), so those two
#               settings go too.
#   online      no brand had an online store, and no one returned
#               anything: each brand gets an online store that's off, and
#               a return window of no days; each segment a taste for
#               shopping online of 0.
# A season without a button pressed runs as it did.
V6_ONLINE <- list(on = FALSE, delivery_days = 3L, delivery_charge = 4.95, fulfilment_cost = 3, shipping_cost = 5, plan_stores = 1)
V6_RETURNS <- list(window_days = 0L, post_cost = 6)

upgrade_v6 <- function(W) {
  W$version <- 7L
  if (is.list(W$market) && !is.null(names(W$market))) W$market$promo_days <- NULL
  if (is.list(W$brands)) W$brands <- lapply(W$brands, function(b) {
    if (!is.list(b) || is.null(names(b))) return(b)
    if (is.list(b$levers) && !is.null(names(b$levers))) b$levers$promo_depth <- NULL
    if (is.null(b$online)) b$online <- V6_ONLINE
    if (is.null(b$returns)) b$returns <- V6_RETURNS
    b
  })
  if (is.list(W$segments)) W$segments <- lapply(W$segments, function(s) {
    if (is.list(s) && !is.null(names(s)) && is.null(s$online)) s$online <- 0
    s
  })
  W
}

# A version 7 world, as version 8.
#   returns  every segment returned what it bought at the same rates
#            (RETURN_P, by how it was bought); now each segment's tendency
#            to return multiplies them. Each segment gets a tendency of 1,
#            so the world runs the season it ran.
upgrade_v7 <- function(W) {
  W$version <- 8L
  if (is.list(W$segments)) W$segments <- lapply(W$segments, function(s) {
    if (is.list(s) && !is.null(names(s)) && is.null(s$returns)) s$returns <- 1
    s
  })
  W
}

# A version 8 world, as version 9.
#   demand_events  the season had no demand events: every day ran at the
#                  demand the model sets. It gets none, placed after its
#                  length, so it runs the season it ran.
upgrade_v8 <- function(W) {
  W$version <- 9L
  if (is.list(W) && !is.null(names(W)) && is.null(W$demand_events)) {
    at <- match("season_days", names(W))
    W <- if (is.na(at)) c(W, list(demand_events = list())) else append(W, list(demand_events = list()), after = at)
  }
  W
}

# ---- Checking --------------------------------------------------------------------------

# Every problem with a world, as list(path, message, tiles), where `tiles`
# (for a map or a floor plan) are the cells to highlight: row and column
# from the top left, 0-based. An empty list means the world can be set up.
world_check <- function(W) {
  pb <- problem_list()
  if (!is.list(W) || is.null(names(W))) { pb$add("", "a world file is a JSON object"); return(pb$get()) }
  if (!identical(W$kind, WORLD_KIND)) pb$add("kind", sprintf("must be \"%s\"", WORLD_KIND))
  if (!identical(as.integer(W$version), WORLD_VERSION)) pb$add("version", sprintf("must be %d", WORLD_VERSION))
  pb$keys(W, "", c("kind", "version", "name", "seed", "season_days", "demand_events", "categories", "macro", "layouts", "stores", "families",
                   "brands", "segments", "market"))
  pb$str(W$name, "name")
  pb$int(W$seed, "seed", 1, .Machine$integer.max)
  days <- if (isTRUE(pb$int(W$season_days, "season_days", FIELDS$season$days$min, FIELDS$season$days$max))) W$season_days else MAX_SEASON_DAYS
  pb$fields(W$market, "market", FIELDS$market)
  check_demand_events(W$demand_events, days, pb)

  cats <- check_categories(W$categories, pb)
  seg_ids <- check_segments(W$segments, cats$ids, pb)
  fam <- check_families(W$families, pb)
  area_ids <- if (is.list(W$macro) && is.list(W$macro$areas)) {
    vapply(W$macro$areas, function(a) if (is.list(a) && is.character(a$id) && length(a$id) == 1L) a$id else "", "")
  } else character()
  brands <- check_brands(W$brands, fam, seg_ids, cats, area_ids[nzchar(area_ids)], days, pb)
  layouts <- check_layouts(W$layouts, cats, pb)
  check_macro(W$macro, seg_ids, pb)
  check_stores(W$stores, brands, layouts, W, pb)
  pb$get()
}

# A collector of problems, with the checks the sections share. Each check
# returns TRUE when `x` passed (NULL, a missing value, is reported by the
# `keys()` check of the object holding it).
problem_list <- function() {
  items <- list()
  add <- function(path, message, tiles = NULL) {
    items[[length(items) + 1L]] <<- list(path = path, message = message, tiles = tiles)
    invisible(FALSE)
  }
  is_num <- function(x) is.numeric(x) && length(x) == 1L && is.finite(x)
  is_obj <- function(x) is.list(x) && (!length(x) || !is.null(names(x)))
  range_msg <- function(x, lo, hi) sprintf("%s is outside %s to %s", json_number(x), json_number(lo), json_number(hi))

  keys <- function(x, path, allowed, required = allowed) {
    if (!is_obj(x)) return(add(path, "must be an object"))
    for (k in setdiff(required, names(x))) add(join_path(path, k), "missing")
    for (k in setdiff(names(x), allowed)) add(join_path(path, k), "not a setting the world file has")
    invisible(TRUE)
  }
  num <- function(x, path, lo = -Inf, hi = Inf) {
    if (is.null(x)) return(invisible(FALSE))
    if (!is_num(x)) return(add(path, "must be a number"))
    if (x < lo || x > hi) return(add(path, range_msg(x, lo, hi)))
    invisible(TRUE)
  }
  int <- function(x, path, lo = -Inf, hi = Inf) {
    if (is.null(x)) return(invisible(FALSE))
    if (!is_num(x) || x != round(x)) return(add(path, "must be a whole number"))
    if (x < lo || x > hi) return(add(path, range_msg(x, lo, hi)))
    invisible(TRUE)
  }
  str <- function(x, path, max = 80) {
    if (is.null(x)) return(invisible(FALSE))
    if (!is.character(x) || length(x) != 1L) return(add(path, "must be text"))
    if (!nzchar(trimws(x))) return(add(path, "can't be empty"))
    if (nchar(x) > max) return(add(path, sprintf("longer than %d characters", max)))
    invisible(TRUE)
  }
  id <- function(x, path) {
    if (is.null(x)) return(invisible(FALSE))
    if (!is.character(x) || length(x) != 1L || !grepl("^[A-Za-z0-9_-]{1,40}$", x)) {
      return(add(path, "must be an id: letters, digits, _ or -, at most 40"))
    }
    invisible(TRUE)
  }
  colour <- function(x, path) {
    if (is.null(x)) return(invisible(FALSE))
    if (!is.character(x) || length(x) != 1L || !grepl("^#[0-9A-Fa-f]{6}$", x)) return(add(path, "must be a colour like #1c7ed6"))
    invisible(TRUE)
  }
  bool <- function(x, path) {
    if (is.null(x)) return(invisible(FALSE))
    if (!is.logical(x) || length(x) != 1L || is.na(x)) return(add(path, "must be true or false"))
    invisible(TRUE)
  }
  # A number checked against its range in `f` (an entry of FIELDS).
  setting <- function(x, path, f) if (identical(f$kind, "int")) int(x, path, f$min, f$max) else num(x, path, f$min, f$max)
  # An object of numeric settings, each checked against its range in `spec`
  # (a section of FIELDS), with `extra` keys checked by the caller.
  fields <- function(x, path, spec, extra = character()) {
    if (is.null(x)) return(add(path, "missing"))
    if (!isTRUE(keys(x, path, c(names(spec), extra), names(spec)))) return(invisible(FALSE))
    for (k in names(spec)) setting(x[[k]], join_path(path, k), spec[[k]])
    invisible(TRUE)
  }
  # An object with one number per key of `keys` (a mix, a taste table).
  per_key <- function(x, path, keys, lo = -Inf, hi = Inf) {
    if (is.null(x)) return(add(path, "missing"))
    if (!is_obj(x)) return(add(path, "must be an object"))
    for (k in setdiff(keys, names(x))) add(join_path(path, k), "missing")
    for (k in setdiff(names(x), keys)) add(join_path(path, k), "no such id")
    ok <- TRUE
    for (k in intersect(keys, names(x))) ok <- isTRUE(num(x[[k]], join_path(path, k), lo, hi)) && ok
    invisible(ok && all(keys %in% names(x)))
  }
  list_of <- function(x, path, min = 0, max = Inf) {
    if (is.null(x)) return(add(path, "missing"))
    if (!is.list(x) || (length(x) && !is.null(names(x)))) return(add(path, "must be a list"))
    if (length(x) < min) return(add(path, sprintf("needs at least %d", min)))
    if (length(x) > max) return(add(path, sprintf("at most %s allowed", json_number(max))))
    invisible(TRUE)
  }
  list(add = add, get = function() items, n = function() length(items), keys = keys, num = num, int = int,
       str = str, id = id, colour = colour, bool = bool, setting = setting, fields = fields, per_key = per_key, list_of = list_of)
}

join_path <- function(path, ...) {
  for (key in c(...)) path <- if (nzchar(path)) paste0(path, ".", key) else key
  path
}
item_path <- function(path, i) sprintf("%s[%d]", path, i)

unique_ids <- function(items, path, pb) {
  ids <- vapply(items, function(x) if (is.list(x) && is.character(x$id) && length(x$id) == 1L) x$id else "", "")
  sound <- grepl("^[A-Za-z0-9_-]{1,40}$", ids)
  for (i in which(!sound)) pb$id(if (is.list(items[[i]])) items[[i]]$id else NULL, join_path(item_path(path, i), "id"))
  dup <- which(duplicated(ids) & nzchar(ids))
  for (i in dup) pb$add(join_path(item_path(path, i), "id"), sprintf("\"%s\" is used twice", ids[i]))
  ids
}

text_of <- function(x) if (is.character(x) && length(x) == 1L) x else ""

# The season's demand events: each a solid strength on its days, or a ramp
# walking up to its strength on each of its days over its ramp days. A
# strength is a signed fold change (FIELDS$demand_event): 1 or more lifts
# demand, -1 or less suppresses it, and nothing lies between -1 and 1. A
# ramp walks on one side: its start and its strength are both lifts or
# both suppressions, unless one of them is 1 or -1 (no change).
DEMAND_EVENT_KEYS <- c("id", "name", "shape", "days", "strength", "ramp_days", "from")

check_demand_events <- function(evs, days, pb) {
  path <- "demand_events"
  if (!isTRUE(pb$list_of(evs, path, 0, MAX_DEMAND_EVENTS))) return(invisible())
  unique_ids(evs, path, pb)
  F <- FIELDS$demand_event
  fold <- function(x, p) {
    if (!isTRUE(pb$setting(x, p, F$strength))) return(FALSE)
    if (abs(x) < 1) return(pb$add(p, sprintf("%s is between -1 and 1: a strength is 1 or more (a lift) or -1 or less (a suppression); 1 and -1 are no change", json_number(x))))
    TRUE
  }
  for (k in seq_along(evs)) {
    x <- evs[[k]]; p <- item_path(path, k)
    if (!isTRUE(pb$keys(x, p, DEMAND_EVENT_KEYS))) next
    pb$str(x$name, join_path(p, "name"), 60)
    one_of(x$shape, join_path(p, "shape"), DEMAND_SHAPES, pb)
    dp <- join_path(p, "days"); dl <- x$days
    if (is.null(dl)) {                                    # missing: reported with the event's keys
    } else if (!is.list(dl) || (length(dl) && !is.null(names(dl)))) pb$add(dp, "must be a list of days")
    else if (!length(dl)) pb$add(dp, "lists no days")
    else {
      ok <- vapply(seq_along(dl), function(j) {
        if (is.null(dl[[j]])) return(pb$add(item_path(dp, j), "must be a whole number"))
        isTRUE(pb$int(dl[[j]], item_path(dp, j), 1, days))
      }, TRUE)
      if (all(ok) && anyDuplicated(unlist(dl))) pb$add(dp, "lists a day twice")
    }
    s_ok <- fold(x$strength, join_path(p, "strength"))
    f_ok <- fold(x$from, join_path(p, "from"))
    pb$setting(x$ramp_days, join_path(p, "ramp_days"), F$ramp_days)
    if (identical(x$shape, "ramp") && s_ok && f_ok && abs(x$strength) > 1 && abs(x$from) > 1 && sign(x$strength) != sign(x$from)) {
      pb$add(join_path(p, "from"), sprintf("starts at %s and walks to %s: a ramp stays on one side, both lifts or both suppressions (start it at %s, no change, to walk from no change)",
                                           json_number(x$from), json_number(x$strength), if (x$strength < 0) "-1" else "1"))
    }
  }
  invisible()
}

# A strength as a multiplier of demand: 1.3 is x1.3, -2 is /2 (x0.5), and
# 1 and -1 are x1.
fold_multiplier <- function(f) ifelse(f >= 0, pmax(f, 1), 1 / pmax(-f, 1))

# A ramp's strengths on its n days, first to last: `from` on the first,
# `strength` on the last, in equal steps between. A start (or a strength)
# of 1 or -1, no change, is taken on the other's side, so a ramp from no
# change to -2 walks from -1 to -2.
ramp_walk <- function(from, strength, n) {
  if (abs(from) == 1) {
    from <- if (strength < 0) -1 else 1
  } else if (abs(strength) == 1) {
    strength <- if (from < 0) -1 else 1
  }
  from + (strength - from) * (seq_len(n) - 1) / max(1, n - 1)
}

# Each day's demand multiplier, days 1 to n_days, from a world's demand
# events: a solid event's on each of its days, a ramp's on each of its
# days and the ramp days up to it (those before day 1 cut off). Where
# events overlap, their multipliers multiply; a day none touches is 1.
demand_multipliers <- function(events, n_days) {
  m <- rep(1, n_days)
  for (e in events) {
    walk <- if (identical(e$shape, "ramp")) ramp_walk(e$from, e$strength, as.integer(e$ramp_days)) else e$strength
    for (D in as.integer(unlist(e$days))) {
      at <- D - length(walk) + seq_along(walk)
      ok <- at >= 1L & at <= n_days
      m[at[ok]] <- m[at[ok]] * fold_multiplier(walk[ok])
    }
  }
  m
}

# The world's categories: their ids, keys and names (as far as they're
# sound), for the checks that refer to them.
check_categories <- function(cats, pb) {
  none <- list(ids = character(), keys = character(), names = character())
  if (!isTRUE(pb$list_of(cats, "categories", 1, MAX_CATEGORIES))) return(none)
  ids <- unique_ids(cats, "categories", pb)
  keys <- character(length(cats)); names <- character(length(cats))
  for (i in seq_along(cats)) {
    c <- cats[[i]]; p <- item_path("categories", i)
    if (!is.list(c)) { pb$add(p, "must be an object"); next }
    if (!isTRUE(pb$keys(c, p, c("id", "name", "key", "colour", "try_on", "price")))) next
    pb$str(c$name, join_path(p, "name"), 30); pb$colour(c$colour, join_path(p, "colour")); pb$bool(c$try_on, join_path(p, "try_on"))
    pb$setting(c$price, join_path(p, "price"), FIELDS$category$price)
    if (!is.null(c$key)) {
      if (!is.character(c$key) || length(c$key) != 1L || !(c$key %in% CATEGORY_KEYS)) {
        pb$add(join_path(p, "key"), sprintf("must be one capital letter other than %s (the floor plans use those)", paste(setdiff(LETTERS, CATEGORY_KEYS), collapse = ", ")))
      } else keys[i] <- c$key
    }
    names[i] <- text_of(c$name)
  }
  dup <- which(duplicated(keys) & nzchar(keys))
  for (i in dup) pb$add(join_path(item_path("categories", i), "key"), sprintf("\"%s\" is %s's key already", keys[i], names[match(keys[i], keys)]))
  ok <- nzchar(ids) & !duplicated(ids)
  list(ids = ids[ok], keys = keys[ok], names = ifelse(nzchar(names[ok]), names[ok], ids[ok]))
}

check_segments <- function(segs, cat_ids, pb) {
  if (!isTRUE(pb$list_of(segs, "segments", 1, MAX_SEGMENTS))) return(character())
  ids <- unique_ids(segs, "segments", pb)
  for (i in seq_along(segs)) {
    s <- segs[[i]]; p <- item_path("segments", i)
    if (!is.list(s)) { pb$add(p, "must be an object"); next }
    pb$keys(s, p, c("id", "name", "colour", names(FIELDS$segment), "category_taste", "offer_response"))
    pb$str(s$name, join_path(p, "name")); pb$colour(s$colour, join_path(p, "colour"))
    for (k in names(FIELDS$segment)) pb$setting(s[[k]], join_path(p, k), FIELDS$segment[[k]])
    if (isTRUE(pb$per_key(s$category_taste, join_path(p, "category_taste"), cat_ids, 0, 5)) && length(cat_ids) &&
        all(vapply(s$category_taste, function(v) is.numeric(v) && isTRUE(v <= 0), TRUE))) {
      pb$add(join_path(p, "category_taste"), "every category is at 0: shoppers must like something")
    }
    pb$fields(s$offer_response, join_path(p, "offer_response"), FIELDS$response)
  }
  ids[nzchar(ids)]
}

check_families <- function(fams, pb) {
  if (!isTRUE(pb$list_of(fams, "families", 1))) return(list(ids = character(), ours = ""))
  ids <- unique_ids(fams, "families", pb)
  ours <- character()
  for (i in seq_along(fams)) {
    f <- fams[[i]]; p <- item_path("families", i)
    if (!is.list(f)) { pb$add(p, "must be an object"); next }
    pb$keys(f, p, c("id", "name", "ours"), c("id", "name"))
    pb$str(f$name, join_path(p, "name"))
    if (!is.null(f$ours)) { pb$bool(f$ours, join_path(p, "ours")); if (isTRUE(f$ours)) ours <- c(ours, ids[i]) }
  }
  if (length(ours) != 1L) pb$add("families", sprintf("exactly one family must be ours (%d are)", length(ours)))
  list(ids = ids, ours = if (length(ours)) ours[1] else "")
}

# Every brand. Returns, for the store checks, each brand's id, name and the
# categories it sells.
check_brands <- function(brands, fam, seg_ids, cats, area_ids, days, pb) {
  if (!isTRUE(pb$list_of(brands, "brands", 1, MAX_BRANDS))) return(list(ids = character(), names = character(), sells = list(), online = logical()))
  ids <- unique_ids(brands, "brands", pb)
  sells <- vector("list", length(brands))
  online <- logical(length(brands))
  for (i in seq_along(brands)) {
    b <- brands[[i]]; p <- item_path("brands", i)
    if (!is.list(b)) { pb$add(p, "must be an object"); next }
    pb$keys(b, p, c("id", "name", "family", "colour", "fit", "levers", "stock", "pricing", "loyalty", "range", "calendar", "online", "returns"))
    online[i] <- check_online(b$online, join_path(p, "online"), pb)
    if (!is.null(b$returns)) pb$fields(b$returns, join_path(p, "returns"), FIELDS$returns)
    pb$str(b$name, join_path(p, "name")); pb$colour(b$colour, join_path(p, "colour"))
    if (!is.null(b$family) && !(is.character(b$family) && b$family %in% fam$ids)) {
      pb$add(join_path(p, "family"), sprintf("no family called %s", json_value(b$family, "")))
    }
    pb$per_key(b$fit, join_path(p, "fit"), seg_ids, -3, 3)
    pb$fields(b$levers, join_path(p, "levers"), lapply(LEVERS, function(L) list(min = L$min, max = L$max, kind = L$kind)))
    st <- b$stock
    if (!is.null(st)) {
      pb$fields(st, join_path(p, "stock"), FIELDS$stock, extra = c("allocation", "plan"))
      if (!is.null(st$allocation) && !(is.character(st$allocation) && st$allocation %in% ALLOCATIONS)) {
        pb$add(join_path(p, "stock", "allocation"), "must be \"flat\" or \"learned\"")
      }
    } else pb$add(join_path(p, "stock"), "missing")
    pr <- b$pricing
    if (!is.null(pr)) {
      pb$fields(pr, join_path(p, "pricing"), FIELDS$pricing, extra = "promos_on_markdowns")
      pb$bool(pr$promos_on_markdowns, join_path(p, "pricing", "promos_on_markdowns"))
      if (is.list(pr) && is.null(pr$promos_on_markdowns)) pb$add(join_path(p, "pricing", "promos_on_markdowns"), "missing")
    } else pb$add(join_path(p, "pricing"), "missing")
    tiers <- check_loyalty(b$loyalty, join_path(p, "loyalty"), pb)
    range <- check_range(b$range, join_path(p, "range"), cats, days, pb)
    sells[[i]] <- unique(range$cat[nzchar(range$cat)])
    if (is.list(st)) check_plan(st$plan, join_path(p, "stock", "plan"), text_of(b$name), sells[[i]], cats, pb)
    check_calendar(b$calendar, join_path(p, "calendar"), text_of(b$name), range, cats, tiers, area_ids, setdiff(ids, ids[i]), days, pb)
  }
  fam_of <- vapply(brands, function(b) if (is.list(b)) text_of(b$family) else "", "")
  if (nzchar(fam$ours) && !any(fam_of == fam$ours)) pb$add("families", "our family has no brands")
  list(ids = ids, names = vapply(seq_along(brands), function(i) if (is.list(brands[[i]]) && nzchar(text_of(brands[[i]]$name))) brands[[i]]$name else ids[i], ""),
       sells = sells, online = online)
}

# A brand's online store: whether it has one, and, either way, its delivery
# days, the delivery charge to the shopper, what each order costs the brand
# (picking and packing, and shipping), and the sales it plans, as standard
# stores' worth. Returns TRUE when it's on.
check_online <- function(x, path, pb) {
  if (is.null(x)) return(FALSE)
  pb$fields(x, path, FIELDS$online, extra = "on")
  if (!is.list(x)) return(FALSE)
  if (is.null(x$on)) pb$add(join_path(path, "on"), "missing") else pb$bool(x$on, join_path(path, "on"))
  isTRUE(x$on)
}

# A brand's plan: the units a standard store sells a week of each category
# the brand sells (the categories it has products in), and of no other.
check_plan <- function(plan, path, brand_name, sells, cats, pb) {
  if (is.null(plan)) return(pb$add(path, "missing"))
  if (!is.list(plan) || (length(plan) && is.null(names(plan)))) return(pb$add(path, "must be an object"))
  name_of <- function(id) cats$names[match(id, cats$ids)]
  for (k in setdiff(sells, names(plan))) pb$add(join_path(path, k), sprintf("missing: %s sells %s, so its plan needs the units a standard store sells a week", brand_name, name_of(k)))
  for (k in setdiff(names(plan), sells)) {
    pb$add(join_path(path, k), if (k %in% cats$ids) sprintf("%s sells no %s: only the categories it sells have a plan", brand_name, name_of(k)) else "no such category")
  }
  for (k in intersect(sells, names(plan))) pb$setting(plan[[k]], join_path(path, k), FIELDS$plan)
  invisible()
}

# A brand's products. Returns their ids, names and categories (ids; "" for
# one that isn't a category).
check_range <- function(range, path, cats, days, pb) {
  out <- list(ids = character(), names = character(), cat = character())
  if (!isTRUE(pb$list_of(range, path, 1, MAX_PRODUCTS))) return(out)
  ids <- unique_ids(range, path, pb)
  cat <- character(length(range)); names <- character(length(range))
  F <- FIELDS$product
  for (k in seq_along(range)) {
    x <- range[[k]]; p <- item_path(path, k)
    if (!isTRUE(pb$keys(x, p, c("id", "name", "category", "price", "cost", "day")))) next
    pb$str(x$name, join_path(p, "name"), 60); names[k] <- text_of(x$name)
    if (!is.null(x$category)) {
      if (is.character(x$category) && length(x$category) == 1L && x$category %in% cats$ids) cat[k] <- x$category
      else pb$add(join_path(p, "category"), sprintf("no category called %s", json_value(x$category, "")))
    }
    pb$setting(x$price, join_path(p, "price"), F$price)
    pb$setting(x$cost, join_path(p, "cost"), F$cost)
    pb$int(x$day, join_path(p, "day"), 1, days)
  }
  list(ids = ids, names = ifelse(nzchar(names), names, ids), cat = cat)
}

# A brand's calendar: its promotions, markdowns and replenishment, each on
# the whole range, some categories or some products, and its offers
# (coupons sent to households it picks at random, offers.R). A product has at most
# one promotion on any day for any household: two promotions on the same
# product on the same day must reach different households (tiers or areas).
# Markdowns and replenishment act on chosen days (once, or on some weekdays
# from one day to another), and a product takes at most one of each kind a
# day: two entries of a kind on the same product must act on different
# days, so nothing depends on the order they're listed in.
PROMO_KEYS <- c("id", "name", "on", "items", "from", "to", "depth", "tiers", "areas")
MARKDOWN_KEYS <- c("id", "name", "on", "items", "from", "to", "weekdays", "which", "by", "min_days", "rest_days", "mode", "depth", "max")
REPLENISH_KEYS <- c("id", "name", "on", "items", "from", "to", "weekdays", "rule", "cover", "reorder")
OFFER_KEYS <- c("id", "name", "from", "to", "depth", "send_cost", "audience", "holdout", "tiers", "areas", "also_at")
CALENDAR_ON <- c("range", "categories", "products")

# The days an entry acts on: from `from` to `to`, on its weekdays (none
# listed: every day).
entry_days <- function(from, to, weekdays) {
  d <- seq.int(from, to)
  if (length(weekdays)) d[DAYS[dow_of(d)] %in% weekdays] else d
}

check_calendar <- function(cal, path, brand_name, range, cats, tiers, area_ids, other_brands, days, pb) {
  if (!isTRUE(pb$keys(cal, path, c("promotions", "offers", "markdowns", "replenishment")))) return(invisible())
  sells <- unique(range$cat[nzchar(range$cat)])
  # What an entry is on, as the ids of the products it covers (NULL: unsound).
  covers <- function(x, p) {
    if (!(is.character(x$on) && length(x$on) == 1L && x$on %in% CALENDAR_ON)) {
      pb$add(join_path(p, "on"), "must be \"range\", \"categories\" or \"products\""); return(NULL)
    }
    items <- x$items
    if (!is.list(items) || (length(items) && !is.null(names(items)))) { pb$add(join_path(p, "items"), "must be a list of ids"); return(NULL) }
    items <- vapply(items, text_of, "")
    if (x$on == "range") {
      if (length(items)) pb$add(join_path(p, "items"), "an entry on the whole range lists no items")
      return(range$ids)
    }
    if (!length(items)) { pb$add(join_path(p, "items"), sprintf("lists no %s", x$on)); return(NULL) }
    if (anyDuplicated(items)) pb$add(join_path(p, "items"), "lists an id twice")
    ok <- TRUE
    for (j in seq_along(items)) {
      q <- item_path(join_path(p, "items"), j)
      if (x$on == "categories") {
        if (!(items[j] %in% cats$ids)) { pb$add(q, sprintf("no category called %s", json_value(x$items[[j]], ""))); ok <- FALSE }
        else if (!(items[j] %in% sells)) { pb$add(q, sprintf("%s sells no %s", brand_name, cats$names[match(items[j], cats$ids)])); ok <- FALSE }
      } else if (!(items[j] %in% range$ids)) { pb$add(q, sprintf("no product called %s in %s's range", json_value(x$items[[j]], ""), brand_name)); ok <- FALSE }
    }
    if (!ok) return(NULL)
    if (x$on == "categories") range$ids[range$cat %in% items] else items
  }
  # When an entry acts, as its days (NULL: unsound).
  when <- function(x, p) {
    ok <- isTRUE(pb$int(x$from, join_path(p, "from"), 1, days)) & isTRUE(pb$int(x$to, join_path(p, "to"), 1, days))
    if (ok && x$to < x$from) { pb$add(join_path(p, "to"), sprintf("day %d is before its first day, %d", x$to, x$from)); ok <- FALSE }
    wd <- x$weekdays
    if (is.null(wd)) return(NULL)                          # missing: reported with the entry's keys
    if (!is.list(wd) || (length(wd) && !is.null(names(wd)))) { pb$add(join_path(p, "weekdays"), "must be a list of weekdays"); return(NULL) }
    wd <- vapply(wd, text_of, "")
    bad <- which(!(wd %in% DAYS))
    for (j in bad) pb$add(item_path(join_path(p, "weekdays"), j), sprintf("must be one of %s", paste(DAYS, collapse = ", ")))
    if (anyDuplicated(wd)) pb$add(join_path(p, "weekdays"), "lists a weekday twice")
    if (!ok || length(bad)) return(NULL)
    d <- entry_days(x$from, x$to, wd)
    if (!length(d)) { pb$add(join_path(p, "weekdays"), sprintf("none of them falls between day %d and day %d: it never acts", x$from, x$to)); return(NULL) }
    d
  }
  # The rule for markdowns and replenishment: no product takes two entries
  # of a kind on one day.
  one_a_day <- function(sound, lp, kind) {
    for (i in seq_along(sound)) for (j in seq_len(i - 1L)) {
      a <- sound[[j]]; b <- sound[[i]]
      both <- intersect(a$prods, b$prods)
      shared <- intersect(a$days, b$days)
      if (!length(both) || !length(shared)) next
      what <- range$names[match(both[1], range$ids)]
      if (length(both) > 1L) what <- sprintf("%s and %d other product%s", what, length(both) - 1L, if (length(both) == 2L) "" else "s")
      on <- if (length(shared) == 1L) sprintf("day %d", shared) else sprintf("day %d (and %d other day%s)", min(shared), length(shared) - 1L, if (length(shared) == 2L) "" else "s")
      pb$add(item_path(lp, b$k), sprintf("%s and %s (%s[%d]) both act on %s on %s: a product takes at most one %s entry a day",
                                        b$name, a$name, basename_path(lp), a$k, what, on, kind))
    }
  }

  proms <- cal$promotions
  sound <- list()
  if (isTRUE(pb$list_of(proms, join_path(path, "promotions")))) {
    pp <- join_path(path, "promotions")
    unique_ids(proms, pp, pb)
    for (k in seq_along(proms)) {
      x <- proms[[k]]; p <- item_path(pp, k)
      if (!isTRUE(pb$keys(x, p, PROMO_KEYS))) next
      pb$str(x$name, join_path(p, "name"), 60)
      prods <- covers(x, p)
      ok_days <- isTRUE(pb$int(x$from, join_path(p, "from"), 1, days)) & isTRUE(pb$int(x$to, join_path(p, "to"), 1, days))
      if (ok_days && x$to < x$from) { pb$add(join_path(p, "to"), sprintf("day %d is before its first day, %d", x$to, x$from)); ok_days <- FALSE }
      pb$setting(x$depth, join_path(p, "depth"), FIELDS$promotion$depth)
      check_id_list(x$tiers, join_path(p, "tiers"), tiers, "tier", pb)
      if (is.list(x$tiers) && !length(x$tiers)) pb$add(join_path(p, "tiers"), "reaches no tier")
      check_id_list(x$areas, join_path(p, "areas"), area_ids, "area", pb)
      if (!is.null(prods) && ok_days && is.list(x$tiers) && is.list(x$areas)) {
        sound[[length(sound) + 1L]] <- list(k = k, name = text_of(x$name), prods = prods, from = x$from, to = x$to,
                                            tiers = vapply(x$tiers, text_of, ""),
                                            areas = if (length(x$areas)) vapply(x$areas, text_of, "") else c(area_ids, ""))
      }
    }
    # The rule: no household sees two promotions on one product on one day.
    for (i in seq_along(sound)) for (j in seq_len(i - 1L)) {
      a <- sound[[j]]; b <- sound[[i]]
      both <- intersect(a$prods, b$prods)
      d0 <- max(a$from, b$from); d1 <- min(a$to, b$to)
      if (!length(both) || d0 > d1 || !length(intersect(a$tiers, b$tiers)) || !length(intersect(a$areas, b$areas))) next
      what <- range$names[match(both[1], range$ids)]
      if (length(both) > 1L) what <- sprintf("%s and %d other product%s", what, length(both) - 1L, if (length(both) == 2L) "" else "s")
      pb$add(item_path(pp, b$k), sprintf("%s and %s (promotions[%d]) are both on %s on %s, for the same households: a product has at most one promotion a day",
                                        b$name, a$name, a$k, what, if (d0 == d1) sprintf("day %d", d0) else sprintf("days %d to %d", d0, d1)))
    }
  }

  # Offers: a brand's offers may overlap (a household holding two uses the
  # deeper coupon), each on its own random audience.
  ofs <- cal$offers
  if (isTRUE(pb$list_of(ofs, join_path(path, "offers"), 0, MAX_OFFERS))) {
    op <- join_path(path, "offers")
    unique_ids(ofs, op, pb)
    for (k in seq_along(ofs)) {
      x <- ofs[[k]]; p <- item_path(op, k)
      if (!isTRUE(pb$keys(x, p, OFFER_KEYS))) next
      pb$str(x$name, join_path(p, "name"), 60)
      if (isTRUE(pb$int(x$from, join_path(p, "from"), 1, days)) & isTRUE(pb$int(x$to, join_path(p, "to"), 1, days)) && x$to < x$from) {
        pb$add(join_path(p, "to"), sprintf("day %d is before its first day, %d", x$to, x$from))
      }
      for (f in names(FIELDS$offer)) pb$setting(x[[f]], join_path(p, f), FIELDS$offer[[f]])
      check_id_list(x$tiers, join_path(p, "tiers"), tiers, "tier", pb)
      if (is.list(x$tiers) && !length(x$tiers)) pb$add(join_path(p, "tiers"), "reaches no tier")
      check_id_list(x$areas, join_path(p, "areas"), area_ids, "area", pb)
      check_id_list(x$also_at, join_path(p, "also_at"), other_brands, "other brand", pb)
    }
  }

  mds <- cal$markdowns
  if (isTRUE(pb$list_of(mds, join_path(path, "markdowns")))) {
    mp <- join_path(path, "markdowns")
    unique_ids(mds, mp, pb)
    sound <- list()
    for (k in seq_along(mds)) {
      x <- mds[[k]]; p <- item_path(mp, k)
      if (!isTRUE(pb$keys(x, p, MARKDOWN_KEYS))) next
      pb$str(x$name, join_path(p, "name"), 60)
      prods <- covers(x, p)
      d <- when(x, p)
      one_of(x$which, join_path(p, "which"), MARKDOWN_WHICH, pb)
      one_of(x$mode, join_path(p, "mode"), MARKDOWN_MODES, pb)
      for (f in names(FIELDS$markdown)) pb$setting(x[[f]], join_path(p, f), FIELDS$markdown[[f]])
      if (!is.null(prods) && !is.null(d)) sound[[length(sound) + 1L]] <- list(k = k, name = text_of(x$name), prods = prods, days = d)
    }
    one_a_day(sound, mp, "markdown")
  }

  reps <- cal$replenishment
  if (isTRUE(pb$list_of(reps, join_path(path, "replenishment")))) {
    rp <- join_path(path, "replenishment")
    unique_ids(reps, rp, pb)
    sound <- list()
    for (k in seq_along(reps)) {
      x <- reps[[k]]; p <- item_path(rp, k)
      if (!isTRUE(pb$keys(x, p, REPLENISH_KEYS))) next
      pb$str(x$name, join_path(p, "name"), 60)
      prods <- covers(x, p)
      d <- when(x, p)
      one_of(x$rule, join_path(p, "rule"), REPLENISH_RULES, pb)
      F <- FIELDS$replenishment
      if (isTRUE(pb$setting(x$cover, join_path(p, "cover"), F$cover)) & isTRUE(pb$setting(x$reorder, join_path(p, "reorder"), F$reorder)) &&
          x$reorder > x$cover) pb$add(join_path(p, "reorder"), sprintf("%s weeks is above the cover it orders up to, %s", json_number(x$reorder), json_number(x$cover)))
      if (!is.null(prods) && !is.null(d)) sound[[length(sound) + 1L]] <- list(k = k, name = text_of(x$name), prods = prods, days = d)
    }
    one_a_day(sound, rp, "replenishment")
  }
  invisible()
}

# A choice among `allowed`.
one_of <- function(x, path, allowed, pb) {
  if (is.null(x) || (is.character(x) && length(x) == 1L && x %in% allowed)) return(invisible(TRUE))
  pb$add(path, sprintf("must be %s", paste0("\"", allowed, "\"", collapse = " or ")))
}

# The last part of a path ("brands[1].calendar.markdowns" -> "markdowns").
basename_path <- function(path) sub("^.*\\.", "", path)

# A brand's loyalty tiers, lowest first: the shares households start in
# add up to 100%, the lowest tier needs no spend, and each tier needs more
# than the one below.
check_loyalty <- function(L, path, pb) {
  if (!isTRUE(pb$keys(L, path, "tiers"))) return(character())
  tp <- join_path(path, "tiers")
  if (!isTRUE(pb$list_of(L$tiers, tp, 1, MAX_TIERS))) return(character())
  ids <- unique_ids(L$tiers, tp, pb)
  for (k in seq_along(L$tiers)) {
    t <- L$tiers[[k]]; p <- item_path(tp, k)
    pb$fields(t, p, FIELDS$tier, extra = c("id", "name"))
    pb$str(t$name, join_path(p, "name"))
  }
  one <- function(t, f) if (is.list(t) && is.numeric(t[[f]]) && length(t[[f]]) == 1L && is.finite(t[[f]])) t[[f]] else NA_real_
  shares <- vapply(L$tiers, one, 0, "share")
  if (all(is.finite(shares)) && abs(sum(shares) - 1) > 0.005) pb$add(tp, sprintf("shares add up to %.1f%%, not 100%%", 100 * sum(shares)))
  spend <- vapply(L$tiers, one, 0, "spend")
  if (isTRUE(spend[1] != 0)) pb$add(join_path(item_path(tp, 1), "spend"), "the lowest tier is where a household with no spend stands: its spend must be 0")
  for (k in seq_along(spend)[-1]) if (isTRUE(spend[k] <= spend[k - 1])) {
    pb$add(join_path(item_path(tp, k), "spend"), sprintf("$%s is no more than the tier below needs ($%s): each tier needs more spend than the one below",
                                                         json_number(spend[k]), json_number(spend[k - 1])))
  }
  ids
}

check_id_list <- function(x, path, allowed, what, pb) {
  if (!is.list(x) || (length(x) && !is.null(names(x)))) return(pb$add(path, "must be a list of ids"))
  for (j in seq_along(x)) {
    if (!(is.character(x[[j]]) && length(x[[j]]) == 1L && x[[j]] %in% allowed)) {
      pb$add(item_path(path, j), sprintf("no %s called %s", what, json_value(x[[j]], "")))
    }
  }
  if (anyDuplicated(unlist(x))) pb$add(path, "lists an id twice")
  invisible(TRUE)
}

# Every layout, read by the world's categories. Returns, for the store
# checks, each sound layout's tills, fitting rooms and the categories it
# has racks for (NULL for a layout with problems).
check_layouts <- function(layouts, cats, pb) {
  if (!isTRUE(pb$list_of(layouts, "layouts", 1))) return(list(ids = character(), info = list()))
  ids <- unique_ids(layouts, "layouts", pb)
  info <- vector("list", length(layouts))
  for (i in seq_along(layouts)) {
    L <- layouts[[i]]; p <- item_path("layouts", i)
    if (!is.list(L)) { pb$add(p, "must be an object"); next }
    if (!is.null(L$prefab) && length(L) == 1L) { pb$add(join_path(p, "prefab"), sprintf("no prefab layout called %s", json_value(L$prefab, ""))); next }
    pb$keys(L, p, c("id", "name", "draw", "rows"))
    pb$str(L$name, join_path(p, "name"))
    pb$setting(L$draw, join_path(p, "draw"), FIELDS$layout$draw)
    s <- layout_scan(L$rows, cats$keys, cats$names)
    for (q in s$problems) pb$add(join_path(p, "rows"), q$message, q$tiles)
    if (!length(s$problems)) info[[i]] <- list(name = text_of(L$name), tills = length(s$parts$cashiers), cubicles = length(s$parts$blocks),
                                               racks = cats$ids[lengths(s$parts$zone_cells) > 0])
  }
  list(ids = ids, info = info)
}

check_stores <- function(stores, brands, layouts, W, pb) {
  if (!isTRUE(pb$list_of(stores, "stores", 1, MAX_STORES))) return(invisible())
  unique_ids(stores, "stores", pb)
  runs <- character()
  cat_names <- if (is.list(W$categories)) setNames(vapply(W$categories, function(c) text_of(c$name), ""), vapply(W$categories, function(c) text_of(c$id), "")) else character()
  for (i in seq_along(stores)) {
    s <- stores[[i]]; p <- item_path("stores", i)
    if (!is.list(s)) { pb$add(p, "must be an object"); next }
    pb$keys(s, p, c("id", "name", "short", "brand", "layout", "x", "y", "staff"), c("id", "name", "short", "brand", "layout", "staff"))
    pb$str(s$name, join_path(p, "name")); pb$str(s$short, join_path(p, "short"), 16)
    b <- if (is.character(s$brand)) match(s$brand, brands$ids) else NA
    if (!is.null(s$brand) && is.na(b)) pb$add(join_path(p, "brand"), sprintf("no brand called %s", json_value(s$brand, "")))
    else runs <- c(runs, s$brand)
    f <- if (is.character(s$layout)) match(s$layout, layouts$ids) else NA
    if (!is.null(s$layout) && is.na(f)) pb$add(join_path(p, "layout"), sprintf("no layout called %s", json_value(s$layout, "")))
    check_store_place(s, p, W$macro, pb)
    pb$fields(s$staff, join_path(p, "staff"), FIELDS$staff)
    L <- if (!is.na(f)) layouts$info[[f]] else NULL
    if (!is.null(L) && is.list(s$staff)) {
      if (is.numeric(s$staff$cashiers) && s$staff$cashiers > L$tills) pb$add(join_path(p, "staff", "cashiers"), sprintf("%s has %d tills", L$name, L$tills))
      if (is.numeric(s$staff$fitting_rooms) && s$staff$fitting_rooms > L$cubicles) pb$add(join_path(p, "staff", "fitting_rooms"), sprintf("%s has %d fitting rooms", L$name, L$cubicles))
    }
    # Racks for everything the brand sells.
    if (!is.null(L) && !is.na(b)) {
      missing <- setdiff(brands$sells[[b]], L$racks)
      if (length(missing)) {
        pb$add(p, sprintf("%s sells %s, but its layout %s has no %s racks", brands$names[b], paste(cat_names[missing], collapse = ", "),
                          L$name, if (length(missing) == 1L) cat_names[missing] else "such"))
      }
    }
  }
  # A brand sells somewhere: in its stores, or online. One with no stores
  # buys only what its online store plans to sell.
  for (i in seq_along(W$brands)) {
    b <- W$brands[[i]]
    if (!is.list(b) || !is.character(b$id) || b$id %in% runs) next
    if (!isTRUE(brands$online[i])) pb$add(item_path("brands", i), sprintf("%s runs no stores and has no online store: it needs one or the other", b$name %||% b$id))
    else if (identical(b$online$plan_stores, 0) || identical(b$online$plan_stores, 0L)) {
      pb$add(join_path(item_path("brands", i), "online", "plan_stores"), sprintf("%s runs no stores, and its online store plans to sell nothing, so it buys nothing to sell", b$name %||% b$id))
    }
  }
}

# ---- Installing -------------------------------------------------------------------------

# Rack space, from the faces of each store's racks (floors.R):
#   STORE_SPACE   store x category: a category's faces against a standard
#                 store's faces shared evenly among the categories its
#                 brand sells (1 for each in a standard store); 0 for a
#                 category the brand doesn't sell, whose racks stand empty.
#                 It sets the store's planned sales of the category and how
#                 deep its racks are (stock.R).
#   SPACE_SP      store x product: the space of the product's category
#   STORE_SIZE    a store's faces for what its brand sells, against a
#                 standard store's
space_install <- function() {
  faces <- LAYOUT_FACES[STORES$format, , drop = FALSE] * CARRIES[STORES$brand, , drop = FALSE]
  STORE_SPACE <<- faces * N_CARRIED[STORES$brand] / STANDARD_RACK_FACES
  cat <- PROD_CAT[STORES$brand, , drop = FALSE]
  SPACE_SP <<- matrix(STORE_SPACE[cbind(rep(seq_len(N_STORES), N_PROD), pmax(1L, as.vector(cat)))], N_STORES) * (cat > 0L)
  STORE_SIZE <<- .rowSums(faces, N_STORES, N_CATS) / STANDARD_RACK_FACES
}

# Installs a world that world_check() passed: the tables the simulation
# reads. Parts that haven't changed since the last world keep what was
# worked out for them: the floors (while the layouts and the categories'
# keys are the same), the routes (the map and where the stores stand) and
# the households (the map, the segments and the brands' tastes and tiers).
world_install <- function(W) {
  num <- function(items, field) vapply(items, function(x) as.numeric(x[[field]]), 0)
  chr <- function(items, field) vapply(items, function(x) as.character(x[[field]]), "")

  # The season, and what's sold.
  SEASON_DAYS <<- as.integer(W$season_days)
  SEASON_WEEKS <<- as.integer(ceiling(SEASON_DAYS / 7))
  DEMAND_EVENT <<- demand_multipliers(W$demand_events, SEASON_DAYS)   # each day's demand multiplier
  cats <- W$categories
  CATEGORY_IDS <<- chr(cats, "id"); CATEGORIES <<- chr(cats, "name"); FIXTURES <<- chr(cats, "key")
  CATEGORY_COLOURS <<- chr(cats, "colour"); TRY_ON <<- vapply(cats, function(c) isTRUE(c$try_on), TRUE)
  TYPICAL_PRICE <<- num(cats, "price")
  N_CATS <<- length(cats)

  # Shoppers.
  segs <- W$segments
  SEGMENTS <<- data.frame(id = chr(segs, "id"), name = chr(segs, "name"), colour = chr(segs, "colour"), stringsAsFactors = FALSE)
  for (k in names(FIELDS$segment)) SEGMENTS[[k]] <<- num(segs, k)
  N_SEGMENTS <<- length(segs)
  CATEGORY_TASTE <<- matrix(vapply(segs, function(s) as.numeric(unlist(s$category_taste[CATEGORY_IDS])), numeric(N_CATS)), N_SEGMENTS, N_CATS, byrow = TRUE)
  OFFER_SHOP <<- num(lapply(segs, `[[`, "offer_response"), "shop")          # a coupon's hidden effect, by segment
  OFFER_PULL <<- num(lapply(segs, `[[`, "offer_response"), "appeal")

  # Families and brands.
  fams <- W$families
  FAMILIES <<- data.frame(id = chr(fams, "id"), name = chr(fams, "name"),
                          ours = vapply(fams, function(f) isTRUE(f$ours), TRUE), stringsAsFactors = FALSE)
  br <- W$brands
  BRANDS <<- data.frame(id = chr(br, "id"), name = chr(br, "name"), family = match(chr(br, "family"), FAMILIES$id),
                        colour = chr(br, "colour"), stringsAsFactors = FALSE)
  N_BRANDS <<- nrow(BRANDS)
  OUR_FAMILY <<- which(FAMILIES$ours)
  OURS_B <<- BRANDS$family == OUR_FAMILY
  BRAND_FIT <<- matrix(vapply(br, function(b) as.numeric(unlist(b$fit[SEGMENTS$id])), numeric(N_SEGMENTS)), N_SEGMENTS)
  for (n in names(LEVERS)) LEVERS[[n]]$value <<- num(lapply(br, `[[`, "levers"), n)
  stk <- lapply(br, `[[`, "stock")
  P_STOCK <<- data.frame(season_buy = num(stk, "season_buy"), allocation = chr(stk, "allocation"),
                         lead_days = num(stk, "lead_days"), opening_weeks = num(stk, "opening_weeks"),
                         delivery_fee = num(stk, "delivery_fee"), unit_fee = num(stk, "unit_fee"), salvage = num(stk, "salvage"),
                         stringsAsFactors = FALSE)
  pri <- lapply(br, `[[`, "pricing")
  P_PRICE <<- data.frame(promos_on_markdowns = vapply(pri, function(x) isTRUE(x$promos_on_markdowns), TRUE),
                         md_target = num(pri, "md_target"))
  onl <- lapply(br, `[[`, "online")
  ONLINE <<- data.frame(on = vapply(onl, function(x) isTRUE(x$on), TRUE), lapply(setNames(names(FIELDS$online), names(FIELDS$online)), function(k) num(onl, k)))
  RETURNS <<- data.frame(lapply(setNames(names(FIELDS$returns), names(FIELDS$returns)), function(k) num(lapply(br, `[[`, "returns"), k)))
  PLAN_UNITS <<- matrix(vapply(stk, function(s) vapply(CATEGORY_IDS, function(k) as.numeric(s$plan[[k]] %||% 0), 0), numeric(N_CATS)),
                       N_BRANDS, N_CATS, byrow = TRUE)                  # 0 for a category the brand doesn't sell
  range_install(br)
  calendar_install(br, W)
  tiers_install(br)
  offers_install(br, W)

  # The market.
  for (k in names(FIELDS$market)) P[[k]] <<- as.numeric(W$market[[k]])
  P$seed <<- as.numeric(W$seed)

  # Layouts.
  lay <- W$layouts
  PLANS <<- setNames(lapply(lay, function(L) unlist(L$rows)), chr(lay, "id"))
  FORMATS <<- chr(lay, "id")
  LAYOUT_NAMES <<- chr(lay, "name")
  FORMAT_APPEAL <<- num(lay, "draw")
  LAYOUT_FACES <<- matrix(vapply(PLANS, function(rows) rack_faces(do.call(rbind, strsplit(rows, "")), FIXTURES), numeric(N_CATS)),
                          ncol = N_CATS, byrow = TRUE)                  # layout x category: rack faces (floors.R)

  # The map and the stores on it.
  macro_install(W$macro)
  st <- W$stores
  STORES <<- data.frame(id = chr(st, "id"), name = chr(st, "name"), short = chr(st, "short"),
                        brand = match(chr(st, "brand"), BRANDS$id), format = match(chr(st, "layout"), FORMATS),
                        x = num(st, "x"), y = num(st, "y"), stringsAsFactors = FALSE)
  N_STORES <<- nrow(STORES)
  STORES$area <<- store_area(STORES$x, STORES$y)
  # Where a sale is made: a store, or a brand's online store (outlet
  # N_STORES + b). The tallies keep sales, refunds and visits by outlet.
  N_OUTLETS <<- N_STORES + N_BRANDS
  OUTLET_BRAND <<- c(STORES$brand, seq_len(N_BRANDS))
  OUTLET_ONLINE <<- seq_len(N_OUTLETS) > N_STORES
  space_install()
  S <<- data.frame(lapply(setNames(names(FIELDS$staff), names(FIELDS$staff)), function(k) num(lapply(st, `[[`, "staff"), k)))
  TILL_ROW <<- N_STORES; STAFF_ROW <<- 2L * N_STORES

  # What was worked out for the last world, dropped where it no longer fits.
  keys <- list(
    layouts = world_text(list(W$layouts, lapply(cats, `[`, c("key", "name")))),
    routes = world_text(list(W$macro[c("patch_m", "tiles", "road_mps", "local_mps")], lapply(st, `[`, c("x", "y")))),
    households = world_text(list(W$macro, lapply(segs, `[`, c("id", "budget")),
                                 lapply(br, function(b) list(b$id, b$fit, lapply(b$loyalty$tiers, `[`, c("id", "share")))))))
  if (!identical(keys$layouts, world_key$layouts)) fl <<- NULL
  if (!identical(keys$routes, world_key$routes)) city <<- NULL
  if (!identical(keys$households, world_key$households) || is.null(city)) hh_cache <<- NULL
  world_key <<- keys
  WORLD <<- W
  invisible(TRUE)
}

`%||%` <- function(a, b) if (is.null(a)) b else a

# Every brand's range, as brand x product tables: its products in the order
# the range lists them, numbered 1..n for the brand (a store's stock row
# has a column for each product and size, up to the longest range, N_PROD).
#
#   PROD_ID, PROD_NAME  ("" past the end of a range)
#   PROD_CAT            the category's number (0 past the end)
#   LIST_PRICE, PROD_COST, PROD_DAY (the day it lands; NO_DAY past the end)
#   PROD_SLOT           brand x category x k: the category's k-th product
#   CARRIES             brand x category: the brand sells the category
#   PRICE_POS           each brand's price position: the middle of its
#                       products' list prices, each against its category's
#                       typical price
#   RANGE_SHARE         segment x brand: the share of the segment's taste
#                       for categories that falls on those the brand sells
range_install <- function(brands) {
  B <- length(brands)
  n <- vapply(brands, function(b) length(b$range), 0L)
  N_PROD <<- max(n)
  N_SKU <<- N_PROD * N_SIZES
  blank <- function(fill) matrix(fill, B, N_PROD)
  PROD_ID <<- blank(""); PROD_NAME <<- blank(""); PROD_CAT <<- blank(0L)
  LIST_PRICE <<- blank(0); PROD_COST <<- blank(0); PROD_DAY <<- blank(NO_DAY)
  for (b in seq_len(B)) {
    r <- brands[[b]]$range; k <- seq_len(n[b])
    PROD_ID[b, k] <<- vapply(r, function(x) x$id, "")
    PROD_NAME[b, k] <<- vapply(r, function(x) x$name, "")
    PROD_CAT[b, k] <<- match(vapply(r, function(x) x$category, ""), CATEGORY_IDS)
    LIST_PRICE[b, k] <<- vapply(r, function(x) as.numeric(x$price), 0)
    PROD_COST[b, k] <<- vapply(r, function(x) as.numeric(x$cost), 0)
    PROD_DAY[b, k] <<- vapply(r, function(x) as.numeric(x$day), 0)
  }
  PROD_OK <<- PROD_CAT > 0L
  PROD_WEEK <<- (PROD_DAY - 1) %/% 7 + 1
  per <- matrix(0L, B, N_CATS)
  for (b in seq_len(B)) per[b, ] <- tabulate(PROD_CAT[b, PROD_OK[b, ]], N_CATS)
  CARRIES <<- per > 0L
  N_CARRIED <<- rowSums(CARRIES)
  N_SLOT <<- max(per)
  PROD_SLOT <<- array(0L, c(B, N_CATS, N_SLOT))
  for (b in seq_len(B)) for (c in which(CARRIES[b, ])) {
    p <- which(PROD_CAT[b, ] == c)
    PROD_SLOT[b, c, seq_along(p)] <<- p
  }
  PLAN_CAT <<- blank(0)
  PLAN_CAT[PROD_OK] <<- PLAN_UNITS[cbind(row(PROD_CAT)[PROD_OK], PROD_CAT[PROD_OK])]
  PRICE_POS <<- vapply(seq_len(B), function(b) {
    ok <- PROD_OK[b, ]
    stats::median(LIST_PRICE[b, ok] / TYPICAL_PRICE[PROD_CAT[b, ok]])
  }, 0)
  # Summed the same way for every brand, so a brand selling every category
  # a segment likes has exactly 1.
  all_taste <- .rowSums(CATEGORY_TASTE, N_SEGMENTS, N_CATS)
  RANGE_SHARE <<- matrix(vapply(seq_len(B), function(b) {
    .rowSums(CATEGORY_TASTE * rep(CARRIES[b, ], each = N_SEGMENTS), N_SEGMENTS, N_CATS) / all_taste
  }, numeric(N_SEGMENTS)), N_SEGMENTS, B)
  # Each brand's SKUs by category, to sum a store's stock by category.
  SKU_CAT <<- lapply(seq_len(B), function(b) {
    cat <- PROD_CAT[b, rep(seq_len(N_PROD), each = N_SIZES)]
    m <- matrix(0, N_SKU, N_CATS)
    m[cbind(which(cat > 0), cat[cat > 0])] <- 1
    m
  })
}

# ---- Loading ----------------------------------------------------------------------------

# Reads, checks and installs a world from its JSON text. Returns the
# problems (none: installed).
world_load <- function(text, prefab_dir = NULL) {
  W <- tryCatch(world_upgrade(world_parse(text)), error = function(e) e)
  if (inherits(W, "error")) return(list(list(path = "", message = conditionMessage(W), tiles = NULL)))
  if (!is.null(prefab_dir)) W <- world_resolve(W, prefab_dir)
  problems <- world_check(W)
  if (!length(problems)) world_install(W)
  problems
}

# ---- For the page -----------------------------------------------------------------------

# The page hands R a world (or a layout) as a file in R's filesystem.
read_text <- function(path) paste(readLines(path, warn = FALSE, encoding = "UTF-8"), collapse = "\n")

world_load_file <- function(path, prefab_dir = NULL) world_load(read_text(path), prefab_dir)

# A world file's problems, and the world as this version of the model
# reads it (upgraded, prefab layouts inline), for the page to edit.
world_check_file <- function(path, prefab_dir = NULL) {
  W <- tryCatch(world_upgrade(world_parse(read_text(path))), error = function(e) e)
  if (inherits(W, "error")) return(list(problems = list(list(path = "", message = conditionMessage(W), tiles = NULL)), text = NULL))
  if (!is.null(prefab_dir)) W <- world_resolve(W, prefab_dir)
  list(problems = world_check(W), text = world_text(W))
}

world_preview_file <- function(path) {
  W <- tryCatch(world_parse(read_text(path)), error = function(e) e)
  if (inherits(W, "error")) return(list(problems = list(list(path = "", message = conditionMessage(W), tiles = NULL))))
  macro_preview(W)
}

# The layout editor's report: a picture, read by the categories of the
# world being edited ({"rows": [...], "categories": [{"key", "name"}]}).
layout_report_file <- function(path) {
  x <- tryCatch(world_parse(read_text(path)), error = function(e) e)
  if (inherits(x, "error")) return(list(problems = list(list(message = conditionMessage(x), tiles = NULL))))
  cats <- if (is.list(x$categories)) x$categories else list()
  layout_report(x$rows, vapply(cats, function(c) text_of(c$key), ""), vapply(cats, function(c) text_of(c$name), ""))
}
