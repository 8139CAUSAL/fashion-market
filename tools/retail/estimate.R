#!/usr/bin/env Rscript
# Estimates the retail example's brand-choice model (see
# PLAN-retail-market.md, "Loyalty is an estimated state") and tests it on
# weeks it never saw.
#
# For now the data is The Complete Journey's pasta sauce, from CRAN; the
# same code runs on Carbo-Loading once its adapter is written
# (choice-data.R). Five models:
#
#   logit            brand constants, price, display, mailer
#   logit+loyalty    ... plus Guadagni-Little loyalty
#   mixed            households differ in brand taste and price sensitivity
#   mixed+loyalty    both
#   mixed+last       households differ, plus the brand bought last time and
#                    the household's first choices (initial conditions)
#
# The last model is the test of loyalty that buying builds (state
# dependence). Smoothed loyalty is built from the household's own past
# choices, so in a short panel it also stands in for lasting taste, and
# mixed+loyalty can't tell the two apart. With the first choices in the
# model, what the last purchase adds is the carry-over a promotion could
# create.
#
# Loyalty's smoothing parameter alpha is chosen by profile likelihood. Each
# household's first two trips only set its starting point. Weeks 1-40 are
# for estimation; weeks 41-53 are held out and predicted one trip ahead.
#
#   Rscript tools/retail/estimate.R
#
# Writes tools/.cache/retail/estimates-cj-pasta-sauce.rds (not shipped: it
# holds per-household estimates).

suppressMessages({ library(data.table); library(completejourney) })

script_path <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
here <- dirname(script_path)
root <- normalizePath(file.path(here, "..", ".."))
source(file.path(here, "choice-data.R"))
source(file.path(here, "mixed-logit.R"))
cache <- file.path(root, "tools", ".cache", "retail")
dir.create(cache, showWarnings = FALSE, recursive = TRUE)

LAST_ESTIMATION_WEEK <- 40
BURN_IN_TRIPS <- 2
ALPHAS <- c(0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95)
DRAWS <- 200

# ---- Data -----------------------------------------------------------------

if (!file.exists(file.path(cache, "cj-transactions.rds"))) {
  message("Downloading The Complete Journey transactions…")
  saveRDS(as.data.table(get_transactions(verbose = FALSE)), file.path(cache, "cj-transactions.rds"))
}
if (!file.exists(file.path(cache, "cj-promotions-pasta-sauce.rds"))) {
  message("Downloading The Complete Journey promotions…")
  sauce <- products$product_id[products$product_category %in% "PASTA SAUCE"]
  promos <- as.data.table(get_promotions(verbose = FALSE))
  saveRDS(promos[product_id %in% sauce], file.path(cache, "cj-promotions-pasta-sauce.rds"))
  rm(promos)
}

data <- cj_occasions("PASTA SAUCE", cache)
occ <- data$occasions
J <- length(data$brands)
trip <- trip_number(data)
fit_rows <- occ$week <= LAST_ESTIMATION_WEEK & trip > BURN_IN_TRIPS
fit_households <- unique(occ$household[fit_rows])
test_rows <- occ$week > LAST_ESTIMATION_WEEK & trip > BURN_IN_TRIPS & occ$household %in% fit_households
h_index <- match(occ$household, fit_households)   # 1..H for households in the fit

cat(sprintf("%s\n%d trips by %d households; brands: %s\n", data$source, nrow(occ),
            length(unique(occ$household)), paste(data$brands, collapse = ", ")))
cat(sprintf("Estimation: %d trips by %d households (weeks 1-%d). Holdout: %d trips (weeks %d-53).\n\n",
            sum(fit_rows), length(fit_households), LAST_ESTIMATION_WEEK, sum(test_rows), LAST_ESTIMATION_WEEK + 1))

# Variables: brand constants (the pooled "other" is the base), price,
# display, mailer, then any extra n x J variables by name (loyalty, ...).
design <- function(rows, extra = list()) {
  n <- sum(rows)
  names <- c(paste0("brand:", data$brands[-J]), "price", "display", "mailer", names(extra))
  X <- array(0, c(n, J, length(names)), dimnames = list(NULL, data$brands, names))
  for (j in seq_len(J - 1)) X[, j, j] <- 1
  X[, , "price"] <- data$price[rows, ]
  X[, , "display"] <- data$display[rows, ]
  X[, , "mailer"] <- data$feature[rows, ]
  for (v in names(extra)) X[, , v] <- extra[[v]][rows, ]
  X
}
random_for <- function(X, mixed) {
  v <- dimnames(X)[[3]]
  if (mixed) grepl("^brand:", v) | v == "price" else rep(FALSE, length(v))
}
fit_model <- function(mixed, extra = list(), alpha = NULL) {
  X <- design(fit_rows, extra)
  fit <- mixed_logit(X, occ$chosen[fit_rows], h_index[fit_rows], random_for(X, mixed), draws = DRAWS)
  fit$alpha <- alpha
  fit$holdout <- local({
    P <- predict_mixed_logit(fit, design(test_rows, extra), h_index[test_rows])
    y <- occ$chosen[test_rows]
    list(loglik_per_trip = mean(log(P[cbind(seq_along(y), y)])),
         hit_rate = mean(max.col(P, ties.method = "first") == y),
         predicted_share = colMeans(P), actual_share = tabulate(y, J) / length(y))
  })
  fit
}
profile_alpha <- function(mixed) {
  ll <- vapply(ALPHAS, function(a) {
    X <- design(fit_rows, list(loyalty = gl_loyalty(data, a)))
    mixed_logit(X, occ$chosen[fit_rows], h_index[fit_rows], random_for(X, mixed), draws = DRAWS)$loglik
  }, 0)
  cat(sprintf("  %s: alpha profile %s\n", if (mixed) "mixed" else "logit",
              paste(sprintf("%.2f→%.1f", ALPHAS, ll), collapse = "  ")))
  ALPHAS[which.max(ll)]
}

# ---- Fit ------------------------------------------------------------------

discount <- 1 - data$price / matrix(apply(data$price, 2, max), nrow(data$price), J, byrow = TRUE)
cat(sprintf("Price: a brand is below its usual price on %.0f%% of trips, by %.0f%% on average when it is.\n\n",
            100 * mean(discount > 0.005), 100 * mean(discount[discount > 0.005])))

started <- Sys.time()
cat("Choosing loyalty's smoothing (alpha) by profile likelihood:\n")
alpha_logit <- profile_alpha(FALSE)
alpha_mixed <- profile_alpha(TRUE)
fits <- list(
  "logit" = fit_model(FALSE),
  "logit+loyalty" = fit_model(FALSE, list(loyalty = gl_loyalty(data, alpha_logit)), alpha_logit),
  "mixed" = fit_model(TRUE),
  "mixed+loyalty" = fit_model(TRUE, list(loyalty = gl_loyalty(data, alpha_mixed)), alpha_mixed),
  "mixed+last" = fit_model(TRUE, list(last_choice = last_choice(data),
                                      initial_share = initial_shares(data, BURN_IN_TRIPS)))
)
cat(sprintf("\nFitted in %.0f s\n", as.numeric(Sys.time() - started, units = "secs")))

for (name in names(fits)) {
  cat(sprintf("\n== %s%s\n", name, if (is.null(fits[[name]]$alpha)) "" else sprintf(" (alpha %.2f)", fits[[name]]$alpha)))
  print(fits[[name]])
}

coef_text <- function(f, v) {
  if (!v %in% names(f$coef)) return("")
  sprintf("%.2f (%.2f)", f$coef[v], f$se[names(f$coef) == v])
}
summary_table <- do.call(rbind, lapply(names(fits), function(name) {
  f <- fits[[name]]
  k <- length(f$coef) + !is.null(f$alpha)
  data.frame(model = name, parameters = k, loglik = round(f$loglik, 1), BIC = round(-2 * f$loglik + k * log(f$n), 1),
             price = coef_text(f, "price"),
             loyalty = coef_text(f, "loyalty"), last_choice = coef_text(f, "last_choice"),
             holdout_loglik_per_trip = round(f$holdout$loglik_per_trip, 3),
             holdout_hit_rate = round(f$holdout$hit_rate, 3))
}))
cat("\n== Comparison (holdout: weeks 41-53, one trip ahead)\n")
print(summary_table, row.names = FALSE)
cat(sprintf("Guessing by overall shares scores %.3f per trip.\n",
            local({ s <- tabulate(occ$chosen[fit_rows], J) / sum(fit_rows); y <- occ$chosen[test_rows]; mean(log(s[y])) })))

saveRDS(list(source = data$source, brands = data$brands, fits = fits, summary = summary_table,
             last_estimation_week = LAST_ESTIMATION_WEEK, burn_in_trips = BURN_IN_TRIPS),
        file.path(cache, "estimates-cj-pasta-sauce.rds"))
message("Wrote tools/.cache/retail/estimates-cj-pasta-sauce.rds")
