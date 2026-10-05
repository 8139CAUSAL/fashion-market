#!/usr/bin/env Rscript
# Writes the default world: worlds/default.world.json, with the prefab
# floor plans in layouts/. Run when the fashion market's fixed city became a
# world file, again when the world file gained categories and each brand's
# range and calendar (version 2), again when replenishment and markdowns
# became calendar entries (version 3), again when the brands got ranges
# of their own (version 5), again when loyalty tiers came to be earned
# by spend and offers became named entries on the calendar (version 6),
# and again when brands could sell online and take returns (version 7);
# kept as the record of where the default world's numbers came from. They were the constants in model/params.R and the
# pictures in model/floors.R: the world is built as the version 1 file it
# was, then upgraded (model/world.R, world_upgrade: the fixed catalogue
# becomes the categories and each brand's 35 products, at its price index;
# each brand replenishes weekly, as every brand did). Then the brands'
# ranges are made distinct ("Distinct ranges" below), our brands' offers
# are put on their calendars ("Offers"), every brand's plan is measured
# from a season of the finished world ("Plans, measured"), and then what
# each loyalty tier's households spend in a season ("Loyalty by spend").
#
# The default world keeps one strategy shared by every brand, so what a
# brand sells, where and at what price are the differences, and any change
# a user introduces is the only other one. Every brand replenishes its
# whole range on Mondays (the upgrade's weekly entry), and marks down on
# one ladder: a first markdown to 20% in week 7 and a second to 40% in week
# 10, each for the products behind plan, and a final markdown of everything
# to 50% in week 12. Its logistics fees and salvage value are assumptions,
# not sourced figures: $150 a store delivery, $0.40 a unit shipped, and 20%
# of cost recovered on stock left at the end.
#
#   Rscript tools/build-default-world.R
#
# Needs NetLogoR installed against the shims in tools/.cache/rlib (see
# tools/test-fashion.R), to run the season the plans are measured from.

script_path <- normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1]))
root <- normalizePath(file.path(dirname(script_path), ".."))

CATEGORY_IDS <- c("denim", "tops", "knitwear", "outerwear", "dresses", "shoes", "accessories")
SIZES <- c("XS", "S", "M", "L", "XL")
named <- function(v, keys) as.list(setNames(v, keys))

# ---- Shoppers -------------------------------------------------------------------

SEGMENTS <- data.frame(
  id = c("value_seekers", "trend_followers", "quality_loyalists", "convenience"),
  name = c("Value seekers", "Trend followers", "Quality loyalists", "Convenience"),
  colour = c("#2a78d6", "#eb6834", "#1baf7a", "#eda100"),
  shop = c(0.10, 0.15, 0.08, 0.11), price = c(2.2, 1.1, 0.4, 0.9), promo = c(1.6, 1.0, 0.5, 0.8),
  km = c(1, 0.9, 0.7, 1.8), radius_km = c(8, 9, 12, 5),
  zones = c(2.5, 3.2, 2.2, 1.5), browse = c(220, 270, 300, 150), patience = c(420, 300, 360, 180),
  max_ahead = c(8, 6, 6, 4), budget = c(0.8, 1.1, 1.4, 0.9), stringsAsFactors = FALSE)
CATEGORY_TASTE <- rbind(c(3, 3, 2, 1, 1, 2, 2), c(2, 3, 1, 2, 3, 2, 3), c(2, 2, 3, 3, 2, 2, 1), c(3, 3, 1, 1, 1, 1, 2))
# The offers' hidden response by offer (rows: coupon, styling, preview) and segment.
LIFT_SHOP <- rbind(c(0.90, 0.30, 0.05, 0.35), c(0.15, 0.30, 0.80, 0.10), c(0.10, 0.65, -0.15, 0.05))
LIFT_UTIL <- rbind(c(0.9, 0.4, 0.1, 0.4), c(0.4, 0.3, 1.0, 0.2), c(0.2, 0.7, -0.4, 0.1))

segments <- lapply(seq_len(nrow(SEGMENTS)), function(g) {
  s <- as.list(SEGMENTS[g, ])
  c(s, list(category_taste = named(CATEGORY_TASTE[g, ], CATEGORY_IDS),
            offer_response = list(coupon = list(shop = LIFT_SHOP[1, g], appeal = LIFT_UTIL[1, g]),
                                  styling = list(shop = LIFT_SHOP[2, g], appeal = LIFT_UTIL[2, g]),
                                  preview = list(shop = LIFT_SHOP[3, g], appeal = LIFT_UTIL[3, g]))))
})

# ---- Brands -----------------------------------------------------------------------

BRANDS <- data.frame(id = c("ours", "value", "premium", "fast"), name = c("Ours", "Value", "Premium", "Fast"),
                     colour = c("#eb6834", "#2a78d6", "#4a3aa7", "#1baf7a"), cost = c(0.45, 0.55, 0.35, 0.50),
                     stringsAsFactors = FALSE)
BRAND_FIT <- rbind(c(0.3, 0.8, -0.8, 0.1), c(0.3, -0.2, 0.1, 0.9), c(0.3, -0.6, 0.9, -0.5), c(0.3, 0.2, -0.1, 0.1))
LEVER_VALUES <- list(price = c(1, 0.7, 1.6, 0.85), promo_depth = c(0.2, 0.15, 0.1, 0.25), ad = c(0.4, 0.3, 0.5, 0.6),
                     cashiers = c(1, 1, 2, 1), assistants = c(1, 0, 2, 1), skill = c(1, 1, 1.2, 0.9), scan_s = c(12, 10, 14, 12))
# The version 1 plans (units a standard store sells a week, by category); every brand's plan is measured again below.
PLAN_UNITS <- rbind(c(99, 88, 71, 122, 110, 126, 193), c(260, 275, 195, 177, 148, 312, 334),
                    c(42, 41, 31, 26, 38, 29, 31), c(202, 252, 103, 158, 155, 233, 214))
TIERS <- data.frame(id = c("none", "low", "mid", "high"), name = c("No loyalty", "Low", "Mid", "High"),
                    share = c(0.45, 0.30, 0.17, 0.08), pull = c(0, 0.3, 0.7, 1.2), price = c(1, 0.9, 0.8, 0.6),
                    memory = c(1, 1, 1, 1), radius = c(1, 1, 1.2, 1.5), offers = c(1, 1, 1, 1), stringsAsFactors = FALSE)

families <- list(list(id = "ours", name = "Our group", ours = TRUE), list(id = "value_co", name = "Value Co", ours = FALSE),
                 list(id = "premium_co", name = "Premium Co", ours = FALSE), list(id = "fast_co", name = "Fast Co", ours = FALSE))
brands <- lapply(seq_len(nrow(BRANDS)), function(b) list(
  id = BRANDS$id[b], name = BRANDS$name[b], family = families[[b]]$id, colour = BRANDS$colour[b], cost = BRANDS$cost[b],
  fit = named(BRAND_FIT[, b], SEGMENTS$id),
  levers = lapply(LEVER_VALUES, `[[`, b),
  stock = list(allocation = "flat", season_buy = 1, lead_days = 4, md_target = 0.8, md_step = 0.2, clearance_weeks = 2,
               plan = named(PLAN_UNITS[b, ], CATEGORY_IDS)),
  loyalty = list(tiers = lapply(seq_len(nrow(TIERS)), function(k) as.list(TIERS[k, ])),
                 up_after = 3, down_chance = 0.3, lapse_days = 60),
  promotions = list(audience = TIERS$id),
  offers = list(on = b == 1, contacts = 300, policy = "epsilon-greedy", eps = 0.1, window = 7,
                tiers = TIERS$id, also_at = list(),
                coupon = list(depth = 0.15, send = 0.25), styling = list(send = 0.25, redeem = 12), preview = list(send = 0.05))
))

# ---- Floor plans --------------------------------------------------------------------

# The prefab plans (layouts/*.layout.json: the three that were pictures in
# model/floors.R, and Intimates, added with version 5): how many tills and
# fitting rooms each has.
PLANS <- lapply(setNames(nm = c("flagship", "standard", "small", "intimates")), function(f) {
  unlist(jsonlite::fromJSON(file.path(root, "layouts", paste0(f, ".layout.json")), simplifyVector = FALSE)$rows)
})
count_blocks <- function(rows, ch) {             # 4-connected blocks of `ch`
  m <- do.call(rbind, strsplit(rows, "")) == ch
  lab <- matrix(0L, nrow(m), ncol(m)); k <- 0L
  for (i in which(m)) {
    if (lab[i]) next
    k <- k + 1L; stack <- i
    while (length(stack)) {
      j <- stack[1]; stack <- stack[-1]
      if (lab[j]) next
      lab[j] <- k
      r <- (j - 1) %% nrow(m) + 1; cc <- (j - 1) %/% nrow(m) + 1
      nb <- c(if (r > 1) j - 1, if (r < nrow(m)) j + 1, if (cc > 1) j - nrow(m), if (cc < ncol(m)) j + nrow(m))
      stack <- c(stack, nb[m[nb] & !lab[nb]])
    }
  }
  k
}
cubicles <- vapply(PLANS, count_blocks, 0L, ch = "F")
tills <- vapply(PLANS, function(rows) sum(unlist(strsplit(rows, "")) == "c"), 0L)

# ---- The city and the stores ------------------------------------------------------------

DISTRICTS <- data.frame(
  name = c("Old Town", "Riverside", "Millbrook", "Eastfield"),
  cx = c(2050, 5950, 2150, 5900), cy = c(4400, 4450, 1600, 1550), radius = c(1500, 1350, 1650, 1450),
  households = c(6500, 4500, 7500, 5500), budget = c(560, 820, 420, 360),
  tint = c("#f1e3c8", "#dcead3", "#e6e0ef", "#f3dcd6"), stringsAsFactors = FALSE)
SEGMENT_MIX <- rbind(c(0.20, 0.30, 0.20, 0.30), c(0.15, 0.20, 0.45, 0.20), c(0.45, 0.15, 0.10, 0.30), c(0.20, 0.50, 0.05, 0.25))
SIZE_MIX <- rbind(c(0.10, 0.22, 0.32, 0.24, 0.12), c(0.06, 0.18, 0.34, 0.28, 0.14), c(0.04, 0.14, 0.28, 0.32, 0.22), c(0.18, 0.32, 0.28, 0.15, 0.07))

STORES <- data.frame(
  id = c("ours_ot", "ours_rs", "ours_mm", "ours_ef", "value_ot", "value_mm", "value_mr", "value_ef",
         "prem_ot", "prem_rs", "prem_mo", "fast_ot", "fast_mm", "fast_ec", "fast_eh", "prem_rq"),
  name = c("Ours Old Town flagship", "Ours Riverside", "Ours Millbrook Mall", "Ours Eastfield",
           "Value Old Town", "Value Millbrook Mall", "Value Millbrook Retail Park", "Value Eastfield",
           "Premium Old Town", "Premium Riverside", "Premium Millbrook Outlet",
           "Fast Old Town", "Fast Millbrook Mall", "Fast Eastfield Campus", "Fast Eastfield High St",
           "Premium Riverside Quay"),
  short = c("Ours OT", "Ours RS", "Ours MM", "Ours EF", "Value OT", "Value MM", "Value MR", "Value EF",
            "Prem OT", "Prem RS", "Prem MO", "Fast OT", "Fast MM", "Fast EC", "Fast EH", "Prem RQ"),
  brand = c(1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4, 3),
  layout = c(1, 2, 2, 3, 3, 2, 2, 3, 2, 2, 2, 2, 2, 3, 2, 3),
  x = c(2050, 5980, 2180, 5750, 1900, 2240, 1420, 6080, 2200, 5850, 2900, 1960, 2120, 6400, 5900, 6350),
  y = c(4460, 4480, 1680, 1480, 4300, 1640, 1100, 1700, 4350, 4370, 2150, 4540, 1600, 1250, 1620, 4800),
  stringsAsFactors = FALSE)
stores <- lapply(seq_len(nrow(STORES)), function(s) {
  b <- STORES$brand[s]; f <- names(PLANS)[STORES$layout[s]]
  list(id = STORES$id[s], name = STORES$name[s], short = STORES$short[s], brand = BRANDS$id[b], layout = f,
       x = STORES$x[s], y = STORES$y[s],
       staff = list(cashiers = min(LEVER_VALUES$cashiers[b], tills[[f]]), assistants = LEVER_VALUES$assistants[b],
                    fitting_rooms = cubicles[[f]], skill = LEVER_VALUES$skill[b], scan_s = LEVER_VALUES$scan_s[b],
                    try_s = 150, max_fr_q = 8, max_till_q = 10))
})

# ---- The map ------------------------------------------------------------------------------

# The city the model generated before maps were painted: four districts
# (blobs around their centres, their edges wobbling with the angle), a few
# parks in each, shops around every store, a river through the middle and
# arterial roads every 500 m both ways. Generated once, from the seed the
# model used, and painted into tiles.
CITY_W <- 8000; CITY_H <- 6000; PATCH_M <- 50; BLOCK_M <- 500
river_x <- function(y) 4000 + 260 * sin(y / 900) + 140 * sin(y / 380 + 1)
set.seed(20260925)
nx <- CITY_W / PATCH_M; ny <- CITY_H / PATCH_M
X <- matrix((seq_len(nx) - 0.5) * PATCH_M, ny, nx, byrow = TRUE); Y <- matrix(rev((seq_len(ny) - 0.5) * PATCH_M), ny, nx)
land <- matrix(0L, ny, nx); district <- matrix(0L, ny, nx); inner <- matrix(Inf, ny, nx)
for (k in seq_len(nrow(DISTRICTS))) {
  dx <- X - DISTRICTS$cx[k]; dy <- Y - DISTRICTS$cy[k]
  a <- atan2(dy, dx); ph <- runif(3, 0, 2 * pi)
  edge <- DISTRICTS$radius[k] * (1 + 0.16 * sin(2 * a + ph[1]) + 0.1 * sin(3 * a + ph[2]) + 0.06 * sin(5 * a + ph[3]))
  rel <- sqrt(dx^2 + dy^2) / edge
  mine <- rel < 1 & rel < inner
  district[mine] <- k; inner[mine] <- rel[mine]
}
land[district > 0] <- 3L
for (k in seq_len(nrow(DISTRICTS))) {
  for (j in 1:3) {
    a <- runif(1, 0, 2 * pi); r <- DISTRICTS$radius[k] * runif(1, 0.35, 0.75)
    c0 <- c(DISTRICTS$cx[k] + r * cos(a), DISTRICTS$cy[k] + r * sin(a))
    land[(X - c0[1])^2 + (Y - c0[2])^2 < runif(1, 140, 260)^2 & district == k] <- 2L
  }
}
for (s in seq_len(nrow(STORES))) land[abs(X - STORES$x[s]) < 110 & abs(Y - STORES$y[s]) < 110] <- 4L
wet <- abs(X - river_x(Y)) < 70
land[wet] <- 1L; district[wet] <- 0L

# Homes: households were placed towards each district's centre (weight
# exp(-2.2 r^2)), a fixed number per district. As densities 1 to 9, scaled
# per district so each still holds about its share of the households.
home <- land == 3L
w <- exp(-2.2 * inner^2)
target <- DISTRICTS$households / sum(DISTRICTS$households)
scale <- rep(9, nrow(DISTRICTS))
dens <- matrix(0L, ny, nx)
for (it in 1:60) {
  dens[home] <- as.integer(pmin(9, pmax(1, round(scale[district[home]] * w[home]))))
  share <- vapply(seq_len(nrow(DISTRICTS)), function(k) sum(dens[home & district == k]), 0) / sum(dens[home])
  scale <- scale * (target / share)^0.8
}
cat("households' share by district, painted:", round(share, 3), " target:", round(target, 3), "\n")

tiles <- matrix(".", ny, nx)
tiles[land == 1L] <- "~"; tiles[land == 2L] <- "p"; tiles[land == 4L] <- "s"
tiles[home] <- as.character(dens[home])
road_cols <- seq(BLOCK_M, CITY_W - BLOCK_M, by = BLOCK_M) / PATCH_M + 1
road_rows <- ny - seq(BLOCK_M, CITY_H - BLOCK_M, by = BLOCK_M) / PATCH_M
road <- matrix(FALSE, ny, nx); road[, road_cols] <- TRUE; road[road_rows, ] <- TRUE
tiles[road] <- ifelse(land[road] == 1L, "+", "=")
keys <- c("o", "r", "m", "e")
area_tiles <- matrix(".", ny, nx); area_tiles[district > 0] <- keys[district[district > 0]]
rows_of <- function(m) as.list(apply(m, 1, paste, collapse = ""))

wt <- DISTRICTS$households / sum(DISTRICTS$households)
macro <- list(
  patch_m = PATCH_M, width = nx, height = ny, households = sum(DISTRICTS$households),
  road_mps = 10, local_mps = 4, park_s = 240, wom_m = 500,
  tiles = rows_of(tiles),
  areas = lapply(seq_len(nrow(DISTRICTS)), function(k) list(
    key = keys[k], id = gsub(" ", "_", tolower(DISTRICTS$name[k])), name = DISTRICTS$name[k], colour = DISTRICTS$tint[k],
    budget = DISTRICTS$budget[k], segment_mix = named(SEGMENT_MIX[k, ], SEGMENTS$id), size_mix = named(SIZE_MIX[k, ], SIZES))),
  area_tiles = rows_of(area_tiles),
  default_makeup = list(budget = round(sum(wt * DISTRICTS$budget)), segment_mix = named(round(as.vector(wt %*% SEGMENT_MIX), 4), SEGMENTS$id),
                        size_mix = named(round(as.vector(wt %*% SIZE_MIX), 4), SIZES))
)

world <- list(
  kind = "fashion-world", version = 1L, name = "Four-district city", seed = 1L,
  macro = macro,
  layouts = lapply(c("flagship", "standard", "small"), function(f) list(prefab = f)),
  stores = stores, families = families, brands = brands, segments = segments,
  market = list(taste_w = 1.2, price_w = 1.5, km_w = 0.22, memory = 0.97, grudge_w = 0.8, wom = 0.35, outside = 2, promo_days = 7)
)

# ---- Upgraded -----------------------------------------------------------------------------

source(file.path(root, "model", "params.R"), local = TRUE)
source(file.path(root, "model", "world.R"), local = TRUE)
W <- world_upgrade(world)
LADDER <- list(
  markdown_entry("first_markdown", "First markdown", 43, 43, which = "behind", depth = 0.2),
  markdown_entry("second_markdown", "Second markdown", 64, 64, which = "behind", depth = 0.4),
  markdown_entry("final_markdown", "Final markdown", 78, 78, depth = 0.5))
for (b in seq_along(W$brands)) W$brands[[b]]$calendar$markdowns <- LADDER

# ---- Distinct ranges ----------------------------------------------------------------------

# Until version 5 every brand sold the same 35 apparel products, at its own
# price index. Now the brands differ in what they sell, as a specialty
# group's brands do: our group runs an apparel brand (Ours, its 35 products
# unchanged) and an intimates brand (Ours Intimates, new); Premium is a
# premium intimates specialist, its staffing a fitting service; Value leads
# with basics and Fast with trends, landing new styles every two weeks.
# Product names and prices are illustrative, not any company's; each
# existing brand's range was priced to keep its price position (the median
# of its list prices, each against its category's typical price) where it
# was: Value 0.70, Premium 1.60, Fast about 0.85. Each product costs its
# brand's cost share of its list price.

# Four new categories, each with a colour of its own for racks and charts.
INTIMATES <- data.frame(id = c("bras", "briefs", "sleepwear", "loungewear"), name = c("Bras", "Briefs", "Sleepwear", "Loungewear"),
                        key = c("B", "U", "N", "L"), colour = c("#c92a2a", "#ae3ec9", "#1098ad", "#8a5a2e"),
                        try_on = c(TRUE, FALSE, TRUE, TRUE), price = c(48, 12, 45, 50), stringsAsFactors = FALSE)
W$categories <- c(W$categories, lapply(seq_len(nrow(INTIMATES)), function(k) as.list(INTIMATES[k, ])))
# Each segment's taste for them (rows: segments); the apparel tastes stay.
# Intimates take 22% to 26% of a segment's taste for categories.
INTIMATES_TASTE <- rbind(c(1.5, 1.5, 1, 1), c(1.5, 1, 0.5, 1.5), c(2, 1, 1, 1), c(1, 1, 0.5, 1))
for (g in seq_along(W$segments)) {
  W$segments[[g]]$category_taste <- c(W$segments[[g]]$category_taste, named(INTIMATES_TASTE[g, ], INTIMATES$id))
}

# The ranges, category by category: each product's list price and the day
# it lands (Mondays: days 1, 29 and 57 in three drops; Fast every two weeks).
range_table <- function(text) utils::read.table(text = text, header = TRUE, sep = "|", strip.white = TRUE, stringsAsFactors = FALSE)
range_of <- function(tab, cost) lapply(seq_len(nrow(tab)), function(k) {
  price <- as.numeric(tab$price[k])
  list(id = slug(tab$name[k]), name = tab$name[k], category = tab$category[k], price = price, cost = cost * price, day = as.integer(tab$day[k]))
})
RANGES <- list(
  ours_intimates = range_table("
    category   | name                   | price | day
    bras       | Wireless bra           |    42 |   1
    bras       | T-shirt bra            |    46 |   1
    bras       | Full-coverage bra      |    48 |   1
    bras       | Sports bra             |    40 |  29
    bras       | Balconette bra         |    52 |  29
    bras       | Lace plunge bra        |    56 |  57
    briefs     | Cotton brief           |    10 |   1
    briefs     | Seamless hipster       |    12 |   1
    briefs     | Lace thong             |    12 |  29
    briefs     | High-waist brief       |    13 |  29
    briefs     | Lace cheeky            |    14 |  57
    sleepwear  | Modal nightgown        |    40 |   1
    sleepwear  | Cotton pyjama set      |    46 |   1
    sleepwear  | Satin sleep shirt      |    44 |  29
    sleepwear  | Flannel pyjama set     |    54 |  57
    loungewear | Ribbed lounge top      |    42 |   1
    loungewear | Lounge jogger          |    46 |   1
    loungewear | Waffle-knit hoodie     |    54 |  29
    loungewear | Plush robe             |    60 |  57"),
  premium = range_table("
    category   | name                   | price | day
    bras       | Moulded T-shirt bra    |    68 |   1
    bras       | Lace underwire bra     |    76 |   1
    bras       | Silk balconette bra    |    78 |   1
    bras       | Longline lace bralette |    64 |  29
    bras       | Silk plunge bra        |    88 |  57
    briefs     | Lace brief             |    18 |   1
    briefs     | Silk brief             |    20 |   1
    briefs     | Lace thong             |    17 |  29
    briefs     | Silk high-waist brief  |    24 |  57
    sleepwear  | Silk camisole set      |    68 |   1
    sleepwear  | Silk pyjama set        |    88 |  29
    sleepwear  | Silk slip nightdress   |    72 |  57
    loungewear | Merino lounge top      |    72 |   1
    loungewear | Cashmere lounge pants  |    90 |  29
    loungewear | Silk robe              |    98 |  57"),
  value = range_table("
    category    | name                  | price | day
    denim       | Skinny jeans          |    42 |   1
    denim       | Straight-leg jeans    |    42 |   1
    denim       | Jeggings              |    30 |   1
    denim       | Bootcut jeans         |    42 |  29
    denim       | Mom jeans             |    44 |  29
    denim       | Denim jacket          |    48 |  57
    tops        | Basic tee             |    12 |   1
    tops        | V-neck tee            |    13 |   1
    tops        | Long-sleeve tee       |    16 |   1
    tops        | Printed tee           |    21 |   1
    tops        | Polo shirt            |    22 |  29
    tops        | Flannel shirt         |    26 |  29
    tops        | Blouse                |    28 |  29
    tops        | Tunic top             |    24 |  57
    knitwear    | Crew-neck jumper      |    35 |   1
    knitwear    | Cardigan              |    38 |   1
    knitwear    | Fleece hoodie         |    35 |  29
    knitwear    | Roll-neck jumper      |    40 |  57
    outerwear   | Rain jacket           |    65 |   1
    outerwear   | Padded jacket         |    85 |  29
    dresses     | T-shirt dress         |    36 |   1
    dresses     | Skater dress          |    49 |  29
    shoes       | Canvas pumps          |    36 |   1
    shoes       | Trainers              |    56 |   1
    shoes       | Ankle boots           |    60 |  29
    shoes       | Slippers              |    30 |  57
    accessories | Socks 3-pack          |    12 |   1
    accessories | Beanie                |    14 |   1
    accessories | Scarf                 |    18 |  29
    accessories | Tote bag              |    20 |  57"),
  fast = range_table("
    category    | name                  | price | day
    denim       | Baggy jeans           |    52 |   1
    denim       | Flared jeans          |    50 |  15
    denim       | Low-rise jeans        |    51 |  29
    denim       | Cargo jeans           |    55 |  43
    denim       | Denim skirt           |    40 |  57
    tops        | Graphic tee           |    20 |   1
    tops        | Crop top              |    26 |   1
    tops        | Bodysuit              |    26 |  15
    tops        | Mesh top              |    26 |  15
    tops        | Satin cami            |    25 |  29
    tops        | Corset top            |    32 |  29
    tops        | Puff-sleeve blouse    |    30 |  43
    tops        | Ruched top            |    26 |  43
    tops        | Oversized shirt       |    28 |  57
    tops        | Halter top            |    26 |  57
    tops        | Cut-out top           |    26 |  71
    tops        | Sheer shirt           |    30 |  71
    knitwear    | Cropped cardigan      |    43 |  29
    outerwear   | Faux-leather jacket   |   102 |  15
    dresses     | Mini dress            |    45 |   1
    dresses     | Slip dress            |    60 |   1
    dresses     | Bodycon dress         |    48 |  15
    dresses     | Tiered dress          |    58 |  15
    dresses     | Satin midi dress      |    62 |  29
    dresses     | Cut-out dress         |    60 |  29
    dresses     | Maxi dress            |    65 |  43
    dresses     | Smock dress           |    60 |  57
    dresses     | Sequin mini dress     |    68 |  71
    dresses     | Shirt dress           |    58 |  71
    shoes       | Platform trainers     |    65 |   1
    shoes       | Chunky loafers        |    68 |  15
    shoes       | Knee boots            |    85 |  29
    shoes       | Strappy heels         |    55 |  43
    shoes       | Mules                 |    48 |  57
    accessories | Mini bag              |    22 |   1
    accessories | Hoop earrings         |    14 |   1
    accessories | Claw clip set         |    12 |  15
    accessories | Sunglasses            |    18 |  29
    accessories | Chain belt            |    18 |  43
    accessories | Shoulder bag          |    28 |  57"))
brand_at <- function(id) match(id, vapply(W$brands, `[[`, "", "id"))
for (id in c("value", "premium", "fast")) W$brands[[brand_at(id)]]$range <- range_of(RANGES[[id]], BRANDS$cost[BRANDS$id == id])

# Ours Intimates, our group's second brand: set up as Ours is (the same
# taste fit, levers, stock and price rules, loyalty tiers, calendar, and an
# offers programme good at its own stores), so its range is the difference.
oi <- W$brands[[brand_at("ours")]]
oi$id <- "ours_intimates"; oi$name <- "Ours Intimates"; oi$colour <- "#e87ba4"
oi$range <- range_of(RANGES$ours_intimates, 0.40)
W$brands <- append(W$brands, list(oi), after = brand_at("ours"))

# The Intimates floor plan (a bra wall, briefs on tables, sleepwear and
# loungewear racks, four fitting rooms, two tills): Premium's four stores
# move to it, in the same places, and Ours Intimates' three stores open on
# it beside Ours' stores in Old Town, Riverside and Millbrook Mall, staffed
# as Ours' are.
W$layouts[[length(W$layouts) + 1L]] <- list(prefab = "intimates")
for (s in seq_along(W$stores)) if (W$stores[[s]]$brand == "premium") {
  W$stores[[s]]$layout <- "intimates"
  W$stores[[s]]$staff$cashiers <- min(W$stores[[s]]$staff$cashiers, tills[["intimates"]])
  W$stores[[s]]$staff$fitting_rooms <- cubicles[["intimates"]]
}
NEW_STORES <- data.frame(id = c("ours_int_ot", "ours_int_rs", "ours_int_mm"),
                         name = c("Ours Intimates Old Town", "Ours Intimates Riverside", "Ours Intimates Millbrook Mall"),
                         short = c("Ours Int OT", "Ours Int RS", "Ours Int MM"),
                         x = c(2150, 6100, 2340), y = c(4600, 4600, 1800), stringsAsFactors = FALSE)
new_stores <- lapply(seq_len(nrow(NEW_STORES)), function(s) {
  list(id = NEW_STORES$id[s], name = NEW_STORES$name[s], short = NEW_STORES$short[s], brand = "ours_intimates", layout = "intimates",
       x = NEW_STORES$x[s], y = NEW_STORES$y[s],
       staff = list(cashiers = min(LEVER_VALUES$cashiers[1], tills[["intimates"]]), assistants = LEVER_VALUES$assistants[1],
                    fitting_rooms = cubicles[["intimates"]], skill = LEVER_VALUES$skill[1], scan_s = LEVER_VALUES$scan_s[1],
                    try_s = 150, max_fr_q = 8, max_till_q = 10))
})
W$stores <- append(W$stores, new_stores, after = max(which(vapply(W$stores, `[[`, "", "brand") == "ours")))
# Their shops on the map: the tiles around each, painted as the city's
# generator painted shops around every store (over homes and parks, not
# roads or the river). Nothing else on the map changes.
for (s in seq_len(nrow(NEW_STORES))) {
  tiles[abs(X - NEW_STORES$x[s]) < 110 & abs(Y - NEW_STORES$y[s]) < 110 & !road & !wet] <- "s"
}
W$macro$tiles <- rows_of(tiles)

# ---- Offers --------------------------------------------------------------------------------

# Until version 6 our brands ran a next-best-action programme. Now a
# brand's offers are named coupons on its calendar, each sent to a random
# share of the households it reaches with a random share held out. Our
# group's four are illustrative, not any company's: a cheap email to most
# of Ours' households as the season starts, an expensive mailer to its
# loyal tiers only (households who buy anyway: the holdout shows how much
# of their spend the coupon added), an email when Ours Intimates' second
# drop lands, and a family coupon from Ours Intimates also good at Ours,
# whose report shows what it did to each brand. Competitors run none.
offer <- function(id, name, from, to, depth, send_cost, audience, holdout, tiers = list("none", "low", "mid", "high"), also_at = list()) {
  list(id = id, name = name, from = from, to = to, depth = depth, send_cost = send_cost, audience = audience, holdout = holdout,
       tiers = tiers, areas = list(), also_at = also_at)
}
OFFERS_OF <- list(
  ours = list(
    offer("launch_email", "Launch email", 8, 21, 0.15, 0.02, 0.6, 0.1),
    offer("loyalty_mailer", "Loyalty mailer", 50, 63, 0.2, 0.85, 1, 0.15, tiers = list("mid", "high"))),
  ours_intimates = list(
    offer("new_arrivals_email", "New-arrivals email", 29, 42, 0.15, 0.02, 0.5, 0.1),
    offer("family_coupon", "Family coupon", 64, 77, 0.2, 0.02, 0.3, 0.1, also_at = list("ours"))))
for (b in seq_along(W$brands)) W$brands[[b]]$calendar$offers <- OFFERS_OF[[W$brands[[b]]$id]] %||% list()

# ---- Plans, measured ----------------------------------------------------------------------

# A brand's plan (the units a standard store sells a week of each category
# it sells) sets its season's buy and what counts as behind plan. Every
# brand's plan is measured as a merchant plans from last season: the world
# runs a season in which no store is ever short of a size (whatever a
# shopper picks is on the rack) and nothing is marked down; a brand's plan
# for a category is its units sold per standard store (its stores' rack
# space for the category against a standard store's, STORE_SPACE) per week
# the category was in its stores, rounded. Households stay in the loyalty tiers they start in
# (where last season put them). The season runs in the model itself, so
# the builder's own tables make way for the model's.
rm(list = setdiff(ls(), c("root", "W")))
.libPaths(c(file.path(root, "tools", ".cache", "rlib"), .libPaths()))
suppressPackageStartupMessages(library(NetLogoR))
for (f in jsonlite::fromJSON(file.path(root, "model", "index.json"))$files) sys.source(file.path(root, "model", f), envir = globalenv())

M <- world_resolve(world_parse(world_text(W)), file.path(root, "layouts"))        # the world as its file will read
sells <- lapply(M$brands, function(b) unique(vapply(b$range, `[[`, "", "category")))
for (b in seq_along(M$brands)) {
  M$brands[[b]]$calendar$markdowns <- list()
  M$brands[[b]]$stock$plan <- as.list(setNames(rep(0, length(sells[[b]])), sells[[b]]))   # measured below
}
problems <- world_check(M)
if (length(problems)) stop("the world has problems: ", paste(vapply(problems, function(p) paste0(p$path, ": ", p$message), ""), collapse = "; "))
world_install(M)
TIER_SPEND[, -1] <- Inf                                               # no one moves up
model_take <- take
take <- function(where, store, sku, t) rep(TRUE, length(store))        # never short
P$pace <- "season"; setup(M$seed)
while (!season_over) go()

cat("plans measured from a season of", SEASON_DAYS, "days: units a standard store sells a week\n")
for (b in seq_len(N_BRANDS)) {
  rows <- STORES$brand == b
  units <- colSums(stock$sold[rows, , drop = FALSE] %*% SKU_CAT[[b]])
  volume <- colSums(STORE_SPACE[rows, , drop = FALSE])
  weeks <- vapply(seq_len(N_CATS), function(k) {
    live <- vapply(seq_len(SEASON_WEEKS), function(w) any(PROD_OK[b, ] & PROD_CAT[b, ] == k & PROD_WEEK[b, ] <= w), TRUE)
    sum(live * vapply(seq_len(SEASON_WEEKS), week_weight, 0))
  }, 0)
  k <- which(CARRIES[b, ])                                              # its categories, in the world's order
  plan <- round(units[k] / volume[k] / weeks[k])
  W$brands[[b]]$stock$plan <- as.list(setNames(plan, CATEGORY_IDS[k]))
  cat(sprintf("  %-15s price position %.2f  %s\n", BRANDS$name[b], PRICE_POS[b], paste(sprintf("%s %d", CATEGORIES[k], plan), collapse = ", ")))
}

# ---- Loyalty by spend ---------------------------------------------------------------------

# A tier is earned by a season's spend with the brand. A household starts
# in a tier because last season's spend put it there: so the finished
# world runs a season with every household held in its starting tier, and
# a tier's spend is what that many households spend: the spend reached by
# the tier's share and every share above it, counted from the top,
# rounded to $5. A tier that more households start in or above than
# bought from the brand at all can't be where last season's spend put
# them all: those tiers sit evenly below the first that can (for most
# brands only Low; for Ours Intimates and Premium, which few households
# buy from, Mid too).
take <- model_take
M <- world_resolve(world_parse(world_text(W)), file.path(root, "layouts"))
problems <- world_check(M)
if (length(problems)) stop("the world has problems: ", paste(vapply(problems, function(p) paste0(p$path, ": ", p$message), ""), collapse = "; "))
world_install(M)
TIER_SPEND[, -1] <- Inf
setup(M$seed)
while (!season_over) go()
cat("loyalty tiers, spend a season to reach:\n")
for (b in seq_len(N_BRANDS)) {
  K <- TIER_N[b]
  above <- rev(cumsum(rev(TIER_SHARE[b, seq_len(K)])))[-1]            # share starting in each tier above the lowest, or higher
  spend <- 5 * round(stats::quantile(mk$spend[, b], 1 - above, names = FALSE, type = 1) / 5)
  flat <- which(spend <= 0)
  if (length(flat)) {
    first <- if (length(flat) < length(spend)) spend[length(flat) + 1L] else 5 * (length(flat) + 1L)
    spend[flat] <- 5 * round(first * flat / (length(flat) + 1L) / 5)
  }
  for (k in seq_along(spend)) spend[k] <- max(spend[k], if (k > 1) spend[k - 1] + 5 else 5)   # each more than the one below
  for (k in seq_len(K)) W$brands[[b]]$loyalty$tiers[[k]]$spend <- c(0, spend)[k]
  cat(sprintf("  %-15s %s  (%.0f%% of households bought from it)\n", BRANDS$name[b],
              paste(sprintf("%s $%s", TIER_NAMES[[b]], c(0, spend)), collapse = ", "), 100 * mean(mk$spend[, b] > 0)))
}

# ---- Online stores and returns -------------------------------------------------------------

# Since version 7 a brand may have an online store, and takes returns. The
# numbers are illustrative, not any company's: four of the five brands sell
# online (Value doesn't), each with its own delivery days, delivery charge
# and costs an order, planning its online sales as some standard stores'
# worth (added to its season's buy); every brand takes returns, Value for
# 14 days, Premium for 60 and the rest for 30, a parcel posted back costs
# the brand $6, and a tenth of what comes back is written off. Each
# segment has a taste for shopping online: convenience shoppers like it
# most, value seekers least. The plans and tiers above were measured
# without them.
online_store <- function(on, days, charge, fulfilment, shipping, plan) {
  list(on = on, delivery_days = days, delivery_charge = charge, fulfilment_cost = fulfilment, shipping_cost = shipping, plan_stores = plan)
}
ONLINE_OF <- list(
  ours = online_store(TRUE, 3L, 3.95, 3.5, 6, 2),
  ours_intimates = online_store(TRUE, 3L, 2.95, 3, 4.5, 1),
  value = online_store(FALSE, 4L, 4.95, 2.5, 5, 1),
  premium = online_store(TRUE, 2L, 0, 4.5, 7.5, 1.5),
  fast = online_store(TRUE, 4L, 2.95, 2.5, 5, 2))
RETURNS_OF <- list(ours = 30L, ours_intimates = 30L, value = 14L, premium = 60L, fast = 30L)
ONLINE_TASTE <- list(value_seekers = -1.4, trend_followers = -0.2, quality_loyalists = -0.8, convenience = 0.2)
for (b in seq_along(W$brands)) {
  id <- W$brands[[b]]$id
  W$brands[[b]]$online <- ONLINE_OF[[id]]
  W$brands[[b]]$returns <- list(window_days = RETURNS_OF[[id]], post_cost = 6, write_off_rate = 0.1)
}
for (g in seq_along(W$segments)) W$segments[[g]]$online <- ONLINE_TASTE[[W$segments[[g]]$id]]

# ---- Demand events --------------------------------------------------------------------------

# Since version 9 the season may have demand events (Setup > Season). The
# default world has two, illustrative: a lift of 1.3 (demand x1.3) on days
# 3 and 23, and a slump into day 90 at -2 (demand /2), ramped over 7 days
# from -1.4, so it walks -1.4, -1.5 ... -2 on days 84 to 90. The plans and
# tiers above were measured without them.
W$demand_events <- list(
  list(id = "spike_days", name = "Spike days", shape = "solid", days = list(3L, 23L), strength = 1.3, ramp_days = 7L, from = 1),
  list(id = "slump_to_day_90", name = "Slump into day 90", shape = "ramp", days = list(90L), strength = -2, ramp_days = 7L, from = -1.4))

# ---- Write --------------------------------------------------------------------------------

dir.create(file.path(root, "worlds"), showWarnings = FALSE)
writeLines(world_text(W), file.path(root, "worlds", "default.world.json"), sep = "")
cat("wrote worlds/default.world.json\n")
