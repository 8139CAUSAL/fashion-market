# Choice occasions for the retail example's brand-choice model: one row per
# shopping trip that bought in the category, the brand chosen, and what
# every brand cost and whether it was on display or in the mailer, in that
# store that week. An adapter turns each dataset into the same shape, so
# the estimation (mixed-logit.R, estimate.R) doesn't care where it came from.
#
# The shape, a list:
#   occasions  data.frame, one row per trip, sorted by household then time:
#              household (1..H), basket, day, week, store, chosen (1..J)
#   brands     the J brand names; the last is every other brand pooled
#   price      n x J: dollars for a standard pack at that week's card price
#   display    n x J: 1 if any of the brand's products was on display
#   feature    n x J: 1 if any of the brand's products was in the mailer
#   source     where the data came from
#
# Brand loyalty is added by gl_loyalty(), because it depends on the
# smoothing parameter being estimated.

suppressMessages(library(data.table))

# Ounces in a package size such as "26 OZ", "1.5 LB" or "45 OZ"; NA if it
# isn't a weight.
size_oz <- function(s) {
  s <- toupper(trimws(s))
  n <- suppressWarnings(as.numeric(sub("^([0-9.]+).*$", "\\1", s)))
  ifelse(grepl("OZ$", s), n, ifelse(grepl("LB$", s), n * 16, NA_real_))
}

# The Complete Journey (the completejourney package; transactions and
# promotions cached by estimate.R).
cj_occasions <- function(category, cache, top = 5, pack_oz = 26) {
  products <- as.data.table(completejourney::products)[product_category == category]
  products[, oz := size_oz(package_size)]
  tx <- readRDS(file.path(cache, "cj-transactions.rds"))
  tx <- tx[product_id %in% products$product_id & quantity > 0 & sales_value > 0]
  tx <- merge(tx, products[, .(product_id, manufacturer_id, brand_type = as.character(brand), oz)], by = "product_id")
  tx <- tx[!is.na(oz) & oz > 0]

  # Brands: the biggest manufacturers by units, everyone else pooled.
  units <- tx[, .(units = sum(quantity), private = any(brand_type == "Private")), by = manufacturer_id][order(-units)]
  kept <- units$manufacturer_id[seq_len(min(top, nrow(units)))]
  label <- ifelse(units$private[match(kept, units$manufacturer_id)], "Private label",
                  paste("Manufacturer", kept))
  brands <- c(label, "Other brands")
  tx[, brand := match(manufacturer_id, kept, nomatch = length(brands))]

  # Shelf price before the card discount, and how deep the discount was.
  # The depth is measured against the same item's own shelf price, so it
  # doesn't move with which jar or size was bought.
  tx[, shelf := (sales_value + retail_disc + coupon_match_disc) / quantity]
  tx[, depth := log(sales_value / quantity / shelf)]   # 0 at full price, negative on promotion

  # A trip's choice: the brand with the most units in the basket.
  tx[, time := as.numeric(transaction_timestamp)]
  trips <- tx[, .(units = sum(quantity), time = min(time)), by = .(household_id, basket_id, store_id, week, brand)]
  setorder(trips, basket_id, -units, brand)
  trips <- trips[!duplicated(basket_id)]
  setorder(trips, household_id, time, basket_id)

  # What every brand cost on each trip: its usual shelf price for a
  # standard pack, times that week's average discount across the chain.
  # Purchases are too sparse for store-week prices (most store-weeks have
  # one sauce purchase or none), and a store-week price built from the trip's
  # own purchase would carry the choice into the price. So the week's
  # discount leaves out the trip's own basket, and weeks with no other
  # purchase of a brand count as full price.
  J <- length(brands)
  base <- tx[, .(p = median(shelf / oz * pack_oz)), by = brand][order(brand), p]
  week_sum <- tx[, .(s = sum(depth * quantity), n = sum(quantity)), by = .(week, brand)]
  own <- tx[, .(s = sum(depth * quantity), n = sum(quantity)), by = .(basket_id, brand)]
  price <- matrix(NA_real_, nrow(trips), J)
  for (j in seq_len(J)) {
    wk <- week_sum[brand == j][match(trips$week, week), ]
    mine <- own[brand == j][match(trips$basket_id, basket_id), ]
    s <- ifelse(is.na(wk$s), 0, wk$s) - ifelse(is.na(mine$s), 0, mine$s)
    n <- ifelse(is.na(wk$n), 0, wk$n) - ifelse(is.na(mine$n), 0, mine$n)
    price[, j] <- base[j] * exp(ifelse(n > 0, s / n, 0))
  }

  # Display and mailer, from the promotions table.
  promos <- readRDS(file.path(cache, "cj-promotions-pasta-sauce.rds"))
  if (category != "PASTA SAUCE") stop("cj_occasions: promotions are cached for PASTA SAUCE only")
  promos <- merge(promos, products[, .(product_id, manufacturer_id)], by = "product_id")
  promos[, brand := match(manufacturer_id, kept, nomatch = J)]
  flags <- promos[, .(display = any(display_location != "0"), feature = any(mailer_location != "0")),
                  by = .(store_id, week, brand)]
  display <- feature <- matrix(0, nrow(trips), J)
  for (j in seq_len(J)) {
    f <- flags[brand == j]
    at <- match(paste(trips$store_id, trips$week), paste(f$store_id, f$week))
    display[, j] <- as.numeric(!is.na(at) & f$display[at])
    feature[, j] <- as.numeric(!is.na(at) & f$feature[at])
  }

  list(
    occasions = data.frame(
      household = match(trips$household_id, unique(trips$household_id)),
      basket = trips$basket_id, time = trips$time, week = trips$week, store = trips$store_id,
      chosen = trips$brand
    ),
    brands = brands, price = price, display = display, feature = feature,
    source = sprintf("The Complete Journey (completejourney %s), %s", packageVersion("completejourney"), category)
  )
}

# Guadagni & Little's brand loyalty: an exponentially smoothed history of a
# household's choices. Each household starts at 1/J for every brand; after
# each trip, L <- alpha * L + (1 - alpha) * (chose that brand). Returns the
# n x J loyalty each trip was made WITH (before its own choice).
gl_loyalty <- function(data, alpha) {
  occ <- data$occasions
  J <- length(data$brands)
  L <- matrix(0, nrow(occ), J)
  current <- rep(1 / J, J)
  for (t in seq_len(nrow(occ))) {
    if (t == 1 || occ$household[t] != occ$household[t - 1]) current <- rep(1 / J, J)
    L[t, ] <- current
    current <- alpha * current
    current[occ$chosen[t]] <- current[occ$chosen[t]] + (1 - alpha)
  }
  L
}

# The brand each trip's household bought on its previous trip, n x J of
# 0/1. A household's first trip has none.
last_choice <- function(data) {
  occ <- data$occasions
  out <- matrix(0, nrow(occ), length(data$brands))
  prev <- c(NA, occ$chosen[-nrow(occ)])
  same <- c(FALSE, occ$household[-1] == occ$household[-nrow(occ)])
  out[cbind(which(same), prev[same])] <- 1
  out
}

# Each household's brand shares over its first `trips` trips, repeated on
# every one of its trips (n x J). Choices at the start of the data carry the
# household's lasting tastes; putting them in the model is how a short
# panel keeps those tastes from being mistaken for loyalty that buying built
# (the initial-conditions problem; Wooldridge 2005).
initial_shares <- function(data, trips = 2) {
  occ <- data$occasions
  J <- length(data$brands)
  first <- trip_number(data) <= trips
  shares <- rowsum(diag(J)[occ$chosen[first], , drop = FALSE], occ$household[first], reorder = TRUE)
  shares <- shares / rowSums(shares)
  shares[match(occ$household, as.integer(rownames(shares))), , drop = FALSE]
}

# Which trip of its household each trip is (1, 2, ...).
trip_number <- function(data) {
  h <- data$occasions$household
  ave(seq_along(h), h, FUN = seq_along)
}
