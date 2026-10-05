# The Strategy tab's forecast of daily net sales, by a seasonal ARIMA model
# with the season's demand events as a regressor.
#
# The series is daily net sales (gross sales less the day's refunds, as
# every report counts them) of our family ("ours"), the whole market
# ("market"), or one brand (its number), over the days finished so far.
# Once FORECAST_MIN_DAYS have finished, a seasonal ARIMA model is fitted
# to them and forecasts every day left in the season:
#
#   the series   log(1 + net sales), net sales floored at 0: the weekday
#                pattern and the demand events act as multiples of sales,
#                and on the log scale as sums
#   the season   weekly (period 7): DOW_TRAFFIC makes every Saturday busy
#   the events   the log of each day's demand multiplier (world.R,
#                demand_multipliers), known for every day of the season,
#                past and to come. If an event has touched a day fitted,
#                the regressor's coefficient is estimated with the model;
#                until then it can't be, and is taken as 1 (sales move with
#                demand, one for one)
#   the orders   as auto.arima chooses them, in base R's stats: seasonal
#                differencing (D) if the weekly pattern's strength (STL) is
#                over 0.64; differencing (d) if the KPSS test rejects a
#                level series at 5% (statistic over 0.463); then the
#                autoregressive and moving-average orders (p + q <= 2, and
#                a seasonal P or Q of at most 1) with the lowest AICc
#
# The forecast for a day is the model's median, back on the scale of sales
# (exp(.) - 1), with 80% and 95% prediction intervals. stats::arima runs
# in webR as in R. A fit is kept until the series it was fitted to changes
# (a day finishes, a new season starts, another series is asked for), so
# a report between days costs nothing. Nothing here draws random numbers
# or changes the simulation.

FORECAST_MIN_DAYS <- 21L          # three weeks: a weekly season needs a few weeks to be seen
FORECAST_PERIOD <- 7L             # a week
SEASONAL_STRENGTH <- 0.64         # STL seasonal strength over which the series is differenced by week (auto.arima's)
KPSS_CRITICAL <- 0.463            # the KPSS level test's 5% critical value
FORECAST_ORDERS <- list(c(0, 0), c(1, 0), c(0, 1), c(2, 0), c(1, 1), c(0, 2))   # (p, q)
FORECAST_SEASONAL <- list(c(0, 0), c(1, 0), c(0, 1))                            # (P, Q)

fc_cache <- NULL

# A series' name: "ours", "market", or a brand's number in the installed
# world; anything else (a brand a new world doesn't have) is "ours".
forecast_key <- function(key) {
  key <- as.character(key)[1]
  if (key %in% c("ours", "market")) return(key)
  b <- suppressWarnings(as.integer(key))
  if (is.na(b) || b < 1L || b > N_BRANDS) "ours" else as.character(b)
}

# Daily net sales, days dd, for a series (forecast_key).
forecast_series <- function(key, dd) {
  if (!length(dd)) return(numeric())
  bd <- net_days(dd)
  if (identical(key, "ours")) return(.rowSums(bd[, OURS_B, drop = FALSE], length(dd), sum(OURS_B)))
  if (identical(key, "market")) return(.rowSums(bd, length(dd), N_BRANDS))
  bd[, as.integer(key)]
}

# The seasonal strength of z by STL (0: none, 1: all of its variation).
seasonal_strength <- function(z) {
  fit <- stats::stl(stats::ts(z, frequency = FORECAST_PERIOD), s.window = "periodic")$time.series
  r <- fit[, "remainder"]; sr <- fit[, "seasonal"] + r
  if (stats::var(sr) <= 0) return(0)
  max(0, 1 - stats::var(r) / stats::var(sr))
}

# The KPSS statistic for a level-stationary series (short lag, as
# tseries::kpss.test's default).
kpss_stat <- function(z) {
  n <- length(z); e <- z - mean(z); S <- cumsum(e)
  lag <- trunc(4 * (n / 100)^0.25)
  s2 <- sum(e^2) / n
  for (k in seq_len(lag)) s2 <- s2 + 2 * (1 - k / (lag + 1)) * sum(e[(k + 1):n] * e[seq_len(n - k)]) / n
  if (s2 <= 0) return(0)
  sum(S^2) / (n^2 * s2)
}

# The orders' differencing for z: D by the weekly pattern's strength, then
# d by KPSS on the series as differenced by week.
forecast_differencing <- function(z) {
  D <- as.integer(length(z) > 2L * FORECAST_PERIOD && seasonal_strength(z) > SEASONAL_STRENGTH)
  w <- if (D) diff(z, lag = FORECAST_PERIOD) else z
  d <- as.integer(length(w) > 3L && stats::var(w) > 0 && kpss_stat(w) > KPSS_CRITICAL)
  c(d = d, D = D)
}

# Every candidate model for z (with the regressor x, or none), the lowest
# AICc first; NULL if none could be fitted.
forecast_fit <- function(z, x) {
  dD <- forecast_differencing(if (is.null(x)) z else z - as.numeric(x))
  n <- length(z)
  best <- NULL
  for (pq in FORECAST_ORDERS) for (PQ in FORECAST_SEASONAL) {
    # Called with the values themselves, so predict() finds the regressor
    # in the fit's call wherever it's called from.
    fit <- tryCatch(suppressWarnings(do.call(stats::arima, list(z, order = c(pq[1], dD[["d"]], pq[2]),
                                                                seasonal = list(order = c(PQ[1], dD[["D"]], PQ[2]), period = FORECAST_PERIOD),
                                                                xreg = x, include.mean = dD[["d"]] + dD[["D"]] == 0, method = "CSS-ML"))),
                    error = function(e) NULL)
    if (is.null(fit) || !is.finite(fit$aic) || any(!is.finite(fit$coef))) next
    k <- length(fit$coef) + 1L
    m <- n - dD[["d"]] - FORECAST_PERIOD * dD[["D"]]
    aicc <- if (m - k - 1 > 0) fit$aic + 2 * k * (k + 1) / (m - k - 1) else Inf
    if (is.null(best) || aicc < best$aicc) best <- list(fit = fit, aicc = aicc, order = c(pq[1], dD[["d"]], pq[2]), seasonal = c(PQ[1], dD[["D"]], PQ[2]))
  }
  best
}

# The forecast for a series: the days so far, and from the next day to the
# season's end the model's median with its 80% and 95% intervals; the
# model, and what it says the season comes to.
forecast_report <- function(key = "ours") {
  key <- forecast_key(key)
  n <- days_complete()
  dd <- seq_len(n)
  y <- forecast_series(key, dd)
  x_all <- log(DEMAND_EVENT[seq_len(SEASON_DAYS)])
  base <- list(key = key, days = SEASON_DAYS, done = n, min_days = FORECAST_MIN_DAYS, actual = I(y),
               events = I(DEMAND_EVENT[seq_len(SEASON_DAYS)]), total_so_far = sum(y))
  if (n < FORECAST_MIN_DAYS) return(c(base, list(status = "waiting")))
  if (n >= SEASON_DAYS) return(c(base, list(status = "over")))
  if (!is.null(fc_cache) && identical(fc_cache$key, key) && identical(fc_cache$y, y) && identical(fc_cache$x, x_all) &&
      identical(fc_cache$days, SEASON_DAYS)) return(fc_cache$report)

  z <- log1p(pmax(y, 0))
  x <- x_all[dd]; ahead <- (n + 1L):SEASON_DAYS; x_ahead <- x_all[ahead]
  estimated <- stats::var(x) > 0
  # With no event among the days fitted, the regressor is an offset (its
  # coefficient 1): the model is fitted to the series without it, and it's
  # added back to the forecast.
  best <- if (estimated) forecast_fit(z, matrix(x, ncol = 1, dimnames = list(NULL, "events"))) else forecast_fit(z - x, NULL)
  report <- if (is.null(best)) c(base, list(status = "failed")) else {
    p <- if (estimated) stats::predict(best$fit, n.ahead = length(ahead), newxreg = matrix(x_ahead, ncol = 1, dimnames = list(NULL, "events")))
         else stats::predict(best$fit, n.ahead = length(ahead))
    mid <- as.numeric(p$pred) + if (estimated) 0 else x_ahead
    se <- as.numeric(p$se)
    back <- function(v) pmax(0, expm1(v))
    coef <- if (estimated) unname(best$fit$coef[["events"]]) else 1
    fc <- back(mid)
    c(base, list(status = "ok", ahead = list(day = I(ahead), mid = I(fc),
                                             lo80 = I(back(mid - stats::qnorm(0.9) * se)), hi80 = I(back(mid + stats::qnorm(0.9) * se)),
                                             lo95 = I(back(mid - stats::qnorm(0.975) * se)), hi95 = I(back(mid + stats::qnorm(0.975) * se))),
                 model = sprintf("ARIMA(%d,%d,%d)(%d,%d,%d)[%d]", best$order[1], best$order[2], best$order[3],
                                 best$seasonal[1], best$seasonal[2], best$seasonal[3], FORECAST_PERIOD),
                 aicc = best$aicc, event_coef = coef, event_estimated = estimated,
                 total_ahead = sum(fc), total_season = sum(y) + sum(fc)))
  }
  fc_cache <<- list(key = key, y = y, x = x_all, days = SEASON_DAYS, report = report)
  report
}
