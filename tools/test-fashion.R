#!/usr/bin/env Rscript
# The fashion market, run headless in local R: the checks that must always
# hold, the one that proves the store view is the real simulation, the
# world engine's (a world file survives export and import, each prefab
# layout reads back identical, a many-brand world on a drawn map with a
# drawn layout runs), the range and calendar's (a version 1 world
# upgraded runs the season the version 1 model ran, a brand with its own
# range runs, a segment never goes to a brand that sells nothing it likes,
# a calendar that breaks the promotion rule is refused, a
# product's price on a day follows the rules, and every visit event is
# told), and replenishment and markdowns on the calendar: orders go out on
# their entry's days only, "replace what sold" ships what sold, a Thursday
# order sees Monday to Wednesday, clashing entries are refused, a markdown
# behind plan takes only the products behind plan and never raises a
# price, the logistics charged match what was shipped, and version 1 and 2
# files upgrade and run; and loyalty and offers: a household's tier is the
# highest its season's spend has reached (never below where it started),
# an offer's audience and holdout are the shares asked for, no household
# held out gets a coupon, a coupon is used once, sending is charged on the
# day it goes, broken offers and tiers are refused, and a version 5 file
# (tiers by visits, an offers programme) upgrades and runs; a version 6
# file (a promotion depth and length for the Market tab's old promotion
# buttons, no online stores, no returns) upgrades and runs the season the
# version 6 model ran, with no online orders and no returns; online stores
# and returns: every unit sold has one ledger line, the ledger reconciles
# (every unit is where its line says, every return came once, after
# delivery and within its window, to a store of the selling brand or by
# post, refunds are what was paid, net sales are gross sales less refunds
# by day and outlet, budgets and loyalty spend follow from the lines), a
# cashier's refunds never overlap their other work, a trip to return items
# runs from the home to the store, an offer's lift is net of returns made
# after it ended, a brand with no stores sells online and takes returns by
# post, and broken online and return settings are refused; and drawn
# floors: a fetch walks to the stockroom door and back, a shopper tries on
# in the cubicle, a cubicle is never a corridor, every door is a way in and
# out, every block of racks has a place to stand, and rack space is the
# faces a shopper can reach.
#
#   Rscript tools/test-fashion.R            # 14 season days, 3 watched days
#   Rscript tools/test-fashion.R 91 5       # a whole season, 5 watched days
#
# Needs R with jsonlite, and NetLogoR 1.0.6 installed against the shims in
# tools/shims/, into tools/.cache/rlib:
#   for p in terra quickPlot SpaDES.tools; do R CMD INSTALL -l tools/.cache/rlib tools/shims/$p; done
#   R CMD INSTALL -l tools/.cache/rlib NetLogoR_1.0.6.tar.gz   # the CRAN source tarball

args <- as.integer(commandArgs(trailingOnly = TRUE))
n_season <- if (length(args) >= 1) args[1] else 14L
n_watch <- if (length(args) >= 2) args[2] else 3L

script_path <- normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1]))
root <- normalizePath(file.path(dirname(script_path), ".."))
.libPaths(c(file.path(root, "tools", ".cache", "rlib"), .libPaths()))
suppressPackageStartupMessages(library(NetLogoR))

for (f in jsonlite::fromJSON(file.path(root, "model", "index.json"))$files) sys.source(file.path(root, "model", f), envir = globalenv())
load_default_world(root)

failures <- 0L
check <- function(ok, what) {
  cat(if (isTRUE(ok)) "  ok   " else "  FAIL ", what, "\n", sep = "")
  if (!isTRUE(ok)) failures <<- failures + 1L
}

# What each day must satisfy, checked straight after it ends.
check_day <- function() {
  shop <- !d$ret
  ok_outcome <- all(d$outcome[shop & !d$online] >= 1 & d$outcome[shop & !d$online] <= N_OUTCOMES) &&
    all(d$outcome[d$online] >= 1 & d$outcome[d$online] <= 4) && all(d$outcome[d$ret] == OUT_RETURNED)
  m <- legs$m[seq_len(legs$n), , drop = FALSE]
  ok_legs <- all(m[, "t1"] >= m[, "t0"] - 1e-9)
  # No server serves two shoppers at once: a till's or a cubicle's service
  # legs (selling, or taking returns back) never overlap, and neither do
  # an assistant's jobs, or a cashier's refunds.
  serve <- m[m[, "kind"] %in% c(TRY, PAY, REFUND), , drop = FALSE]
  key <- serve[, "store"] * 1e4 + serve[, "a"]
  o <- order(key, serve[, "t0"])
  serve <- serve[o, , drop = FALSE]; key <- key[o]
  same <- key[-1] == key[-length(key)]
  ok_servers <- all(serve[-1, "t0"][same] >= serve[-nrow(serve), "t1"][same] - 1e-6)
  sm <- staff$m[seq_len(staff$n), , drop = FALSE]
  sk <- sm[, "store"] * 100 + sm[, "server"] + 1e4 * (sm[, "job"] == JOB_REFUND); o <- order(sk, sm[, "t0"]); sm <- sm[o, , drop = FALSE]; sk <- sk[o]
  same <- sk[-1] == sk[-length(sk)]
  ok_staff <- all(sm[-1, "t0"][same] >= sm[-nrow(sm), "t1"][same] - 1e-6) && all(sm[, "server"] >= 1)
  # Each refund job is a cashier at their till for the whole of the refund leg.
  rj <- sm[sm[, "job"] == JOB_REFUND, , drop = FALSE]
  rl <- m[m[, "kind"] == REFUND, , drop = FALSE]
  ok_refund_jobs <- nrow(rj) == nrow(rl) && nrow(rj) == sum(d$ret) &&
    all(paste(rj[, "visit"], rj[, "t0"], rj[, "t1"], fl$till_first[STORES$format[rj[, "store"]]] + rj[, "server"] - 1) %in%
        paste(rl[, "visit"], rl[, "t0"], rl[, "t1"], rl[, "a"]))
  paid <- d$outcome == 1L
  today_lines <- if (ledger$today > ledger$today_was) seq.int(ledger$today_was, ledger$today - 1L) else integer()
  ok_sales <- abs(sum(tally$sales[day, , ]) - sum(d$sales[paid])) < 1e-6 && all(d$sales[!paid] == 0) &&
    length(today_lines) == sum(d$units[paid]) && abs(sum(ledger$m[today_lines, "paid"]) - sum(d$sales[paid])) < 1e-6
  # Today's returns: each line once, refunded what was paid for it, booked
  # against the outlet that sold it.
  r <- today$returned
  ro <- ifelse_int(ledger$i[r, "store"] == 0L, N_STORES + ledger$i[r, "brand"], ledger$i[r, "store"])
  ok_refunds <- !anyDuplicated(r) && all(ledger$i[r, "ret_day"] == day) &&
    max(abs(tally$refunds[day, ] - bin_sum(ro, ledger$m[r, "paid"], N_OUTLETS))) < 1e-6 &&
    all(tally$ret_units[day, ] == tabulate(ro, N_OUTLETS))
  ok_stock <- all(stock_balance(TRUE) == 0) && all(stock$rack >= 0) && all(stock$room >= 0) && all(stock$dc >= 0)
  ok_tiers <- all(mk$tier >= 1L & mk$tier <= matrix(TIER_N, mk$hh$n, N_BRANDS, byrow = TRUE))
  s <- shop & !d$online
  ok_reach <- all(mk$km[cbind(d$hh[s], d$store[s])] <= SEGMENTS$radius_km[d$seg[s]] * TIER_RADIUS[cbind(d$brand[s], d$tier[s])] + 1e-9) &&
    all(STORES$brand[d$store[d$ret]] == d$brand[d$ret])
  c(outcome = ok_outcome, legs = ok_legs, servers = ok_servers, staff = ok_staff, refund_jobs = ok_refund_jobs, sales = ok_sales,
    refunds = ok_refunds, stock = ok_stock, tiers = ok_tiers, reach = ok_reach)
}

# The ledger against everything that adds up from it, at the end of a day:
# every unit sold has one line, and every unit is where its line says;
# every return came once, after delivery and within its window, to a store
# of the selling brand (or by post, only where none was in reach); net
# sales are gross sales less refunds, by day, outlet, brand and channel;
# and each household's budget and loyalty spend follow from its lines.
check_ledger <- function() {
  L <- ledger_view()
  dd <- seq_len(day)
  units <- sum(tally$units[dd, , ])
  window <- RETURNS$window_days[L$brand]
  r <- L$returned
  ok_lines <- ledger$n == units && abs(sum(L$paid) - sum(tally$sales[dd, , ])) < 1e-6
  ok_when <- all(L$ret_day[r] >= L$in_hand[r] + 1L & L$ret_day[r] <= L$in_hand[r] + window[r]) && all(L$ret_day[!r] == 0L)
  rs <- L$ret_store[r]
  near <- mk$near_store[cbind(L$hh[r], L$brand[r])]
  ok_where <- all(rs == 0L | STORES$brand[pmax(rs, 1L)] == L$brand[r]) && all(rs > 0L | near == 0L |
    mk$km[cbind(L$hh[r], pmax(near, 1L))] > SEGMENTS$radius_km[mk$hh$segment[L$hh[r]]] * TIER_RADIUS[cbind(L$brand[r], mk$tier[cbind(L$hh[r], L$brand[r])])])
  # Net = gross - refunds, by day and outlet: the tallies against the lines.
  gross <- apply(tally$sales[dd, , , drop = FALSE], c(1, 3), sum)
  lg <- matrix(bin_sum((L$outlet - 1L) * day + L$day, L$paid, day * N_OUTLETS), day)
  lr <- matrix(bin_sum((L$outlet[r] - 1L) * day + L$ret_day[r], L$paid[r], day * N_OUTLETS), day)
  ok_net <- max(abs(gross - lg)) < 1e-6 && max(abs(tally$refunds[dd, , drop = FALSE] - lr)) < 1e-6
  # Every unit sold is somewhere: with a household, back in stock, or written off.
  sku <- (L$brand - 1L) * N_SKU + L$sku
  per <- function(sel) matrix(tabulate(sku[sel], N_BRANDS * N_SKU), N_BRANDS, N_SKU, byrow = TRUE)
  same <- function(a, b) max(abs(a - b)) == 0
  ok_units <- same(per(!L$online), stores_to_brands(stock$sold)) && same(per(L$online), stock$online) &&
    same(per(r & L$fate == FATE_RESTOCK & L$ret_store > 0L), stores_to_brands(stock$restocked)) &&
    same(per(r & L$fate == FATE_RESTOCK & L$ret_store == 0L), stock$restocked_dc) && same(per(r & L$fate == FATE_WRITE_OFF), stock$written_off)
  # Households: budget left = budget - paid - delivery charges + refunds;
  # loyalty spend = paid - refunds, with each brand.
  hb <- (L$hh - 1L) * N_BRANDS + L$brand
  net <- matrix(bin_sum(hb, L$paid - L$refund, mk$hh$n * N_BRANDS), mk$hh$n, byrow = TRUE)
  orders <- !duplicated(cbind(L$hh, L$day)) & L$online
  charges <- bin_sum(L$hh[orders], ONLINE$delivery_charge[L$brand[orders]], mk$hh$n)
  ok_budget <- max(abs(mk$hh$budget - .rowSums(net, mk$hh$n, N_BRANDS) - charges - mk$budget_left)) < 1e-6
  ok_spend <- max(abs(net - mk$spend)) < 1e-6 && all(mk$spend_max >= mk$spend - 1e-9)
  c(lines = ok_lines, when = ok_when, where = ok_where, net = ok_net, units = ok_units, budget = ok_budget, spend = ok_spend)
}

# Offer k's lift, worked out from its log and the ledger: each purchase
# less the refunds (and the margin taken back) of what came back of it,
# whenever it came back. Returns what offer_results() should say, and how
# many items came back after the offer ended.
offer_net <- function(k) {
  Lg <- ledger_view()
  sent <- ofr$sent[[k]]; m <- length(sent)
  L <- ofr$buys[seq_len(ofr$n_buys), , drop = FALSE]; L <- L[L[, "offer"] == k, , drop = FALSE]
  line_of <- purchase_key(Lg$hh, Lg$day); key <- purchase_key(ofr$members[[k]][L[, "member"]], L[, "day"])
  mi <- match(line_of, key); hit <- !is.na(mi)
  cost <- PROD_COST[cbind(Lg$brand, Lg$product)] * (Lg$fate == FATE_RESTOCK)
  refund <- bin_sum(mi[hit], Lg$refund[hit], nrow(L))
  took <- bin_sum(mi[hit], ifelse(Lg$returned, Lg$paid - cost, 0)[hit], nrow(L))
  own <- OFFER_GOOD[k, ][L[, "brand"]]
  list(spend = diff_ci(bin_sum(L[own, "member"], L[own, "sales"] - refund[own], m), sent, !sent),
       margin = diff_ci(bin_sum(L[own, "member"], L[own, "margin"] - took[own], m), sent, !sent),
       gross = diff_ci(bin_sum(L[own, "member"], L[own, "sales"], m), sent, !sent),
       refunds = sum(refund[own]), late = sum(hit & Lg$returned & Lg$ret_day > OFFERS$to[k]))
}

run_season_days <- function(n, ledger_days = 0L) {
  ok <- TRUE; ok_ledger <- TRUE; times <- numeric()
  for (i in seq_len(n)) {
    s0 <- proc.time()[["elapsed"]]
    ledger$today_was <<- ledger$today
    advance(Inf); end_day()
    res <- check_day()
    t_ledger <- proc.time()[["elapsed"]]
    if (i %in% ledger_days) {
      rl <- check_ledger()
      if (!all(rl)) { ok_ledger <- FALSE; cat("    day", day, "ledger failed:", names(rl)[!rl], "\n") }
    }
    t_ledger <- proc.time()[["elapsed"]] - t_ledger
    if (!all(res)) { ok <- FALSE; cat("    day", day, "failed:", names(res)[!res], "\n") }
    prev <<- list(d = d, legs = legs, staff = staff, today = today, vlog = vlog, day = day)
    homes_version <<- homes_version + 1L
    if (day >= SEASON_DAYS) { season_over <<- TRUE; break }
    start_day()
    times <- c(times, proc.time()[["elapsed"]] - s0 - t_ledger)      # the day and its daily checks (as before the ledger)
  }
  list(ok = ok, ok_ledger = ok_ledger, times = times)
}

# ---- Season pace ------------------------------------------------------------

cat(sprintf("Season pace: %d days\n", n_season))
P$pace <- "season"
setup(7)
r <- run_season_days(n_season, ledger_days = unique(c(seq_len(n_season %/% 7) * 7L, n_season)))
check(r$ok, "every day: each visit ends in one outcome, no negative waits, no server, assistant or cashier serves two at once (a refund included), sales = receipts, every unit sold has one ledger line, today's refunds are what was paid, every unit accounted for, tiers on their ladders, every visit within reach")
check(r$ok_ledger, sprintf("every week: the ledger reconciles: every unit sold is where its line says (with a shopper, back in stock, or written off), every return came once, after delivery and within its window, to a store of the selling brand (or by post), net sales = gross sales - refunds by day and outlet, and each household's budget and loyalty spend follow from its lines (%s lines, %s returned)",
                    format(ledger$n, big.mark = ","), format(sum(ledger$i[seq_len(ledger$n), "ret_day"] > 0), big.mark = ",")))
check(sum(tally$late) == 0, "every decision taken in time order")
check(abs(sum(season_log$sales[seq_len(season_log$n)]) - sum(tally$sales)) < 1e-6, "the season's visit log adds up to the season's sales (gross, in the stores and online)")
Lg <- ledger_view()
on_share <- sum(Lg$paid[Lg$online]) / sum(Lg$paid)
cat(sprintf("    online: %.0f%% of gross sales; returned: %.1f%% of units bought online, %.1f%% in the stores (%.1f%% of those tried on); %s return trips, %s parcels\n",
            100 * on_share, 100 * mean(Lg$returned[Lg$online]), 100 * mean(Lg$returned[!Lg$online]), 100 * mean(Lg$returned[Lg$kind == KIND_TRIED]),
            format(sum(tally$trips), big.mark = ","), format(sum(tally$post_parcels), big.mark = ",")))
cat(sprintf("    %.0f ms per market day (median), %d visits a day\n", 1000 * median(r$times), round(sum(tally$visits) / max(1, days_complete()))))

# Every report builds and serialises.
for (tab in c("header", "setup", "market", "strategy", "scorecard")) {
  j <- tryCatch(to_json(get(paste0("report_", tab))()), error = function(e) e)
  check(!inherits(j, "error"), paste("report", tab, if (inherits(j, "error")) conditionMessage(j) else sprintf("(%s bytes)", nchar(j))))
}
check(!inherits(tryCatch(to_json(world_schema()), error = identity), "error"), "the settings' schema")
for (b in seq_len(N_BRANDS)) {
  check(!inherits(tryCatch(to_json(report_assortment(b)), error = identity), "error"), paste("assortment report, brand", b))
  j <- tryCatch(to_json(report_offers(b)), error = identity)
  check(!inherits(j, "error"), paste("offers report, brand", b, if (inherits(j, "error")) conditionMessage(j) else ""))
}
for (flt in list(c(0, 0, 0), c(1, 0, 0), c(0, 2, 0), c(0, 0, 5), c(0, N_AREAS + 1, 0))) for (scope in c("season", "day")) for (ch in c("store", "online")) {
  if (ch == "online" && flt[3] > 0) next
  j <- tryCatch(report_funnel(flt[1], flt[2], flt[3], scope, ch), error = identity)
  ok_f <- !inherits(j, "error") && all(diff(vapply(j$stages, function(s) s$n, 0)) <= 1e-9) &&
    j$returns$items == sum(vapply(j$returns$returned, `[[`, 0, "n")) + j$returns$on_the_way + j$returns$returnable + j$returns$kept
  check(ok_f, sprintf("funnel (brand %d, area %d, store %d, %s, %s): each stage no bigger than the last; after paying, every item bought is returned, on its way, returnable or kept",
                      flt[1], flt[2], flt[3], scope, ch))
}
# Net sales in the reports are gross sales less refunds, by brand and channel.
rm_ <- report_market(); rs_ <- report_strategy(); csv <- utils::read.csv(text = export_csv())
by_brand_net <- function(online) vapply(seq_len(N_BRANDS), function(b) sum(Lg$paid[Lg$brand == b & Lg$online %in% online]) - sum(Lg$refund[Lg$brand == b & Lg$online %in% online]), 0)
contrib <- report_scorecard()$contribution
check(max(abs(rm_$revenue - by_brand_net(c(TRUE, FALSE)))) < 1e-6 && max(abs(rm_$revenue_online - by_brand_net(TRUE))) < 1e-6 &&
      max(abs(rs_$revenue$by_brand - rm_$revenue)) < 1e-6 && max(abs(csv$net_sales - (csv$gross_sales - csv$returns_value))) < 0.011 &&
      abs(sum(csv$net_sales) - sum(by_brand_net(c(TRUE, FALSE)))) < 1 &&
      max(abs(vapply(contrib, function(x) x$sales - (x$gross - x$refunds), 0))) < 1e-6,
      "net sales on every tab (Market, Strategy, Scorecard, the CSV export) are gross sales less refunds, matching the ledger, by brand and channel")
pick_household(); check(!is.null(report_market()$shopper), "a random shopper's panel")
follow_visit(1); check(!inherits(tryCatch(to_json(report_store(1, heat = TRUE)), error = identity), "error"), "store report with heat map and a followed shopper")
# Loyalty by spend: every household stands in the highest tier its spend
# this season has reached, or the one it started in if that's higher.
reached <- vapply(seq_len(N_BRANDS), function(b) spend_tier(mk$spend_max[, b], b), integer(mk$hh$n))
fell <- sum(vapply(seq_len(N_BRANDS), function(b) sum(spend_tier(mk$spend[, b], b) < mk$tier[, b] & mk$tier[, b] > mk$tier0[, b]), 0))
check(identical(mk$tier, pmax(mk$tier0, matrix(reached, mk$hh$n))) && sum(mk$tier > mk$tier0) > 0,
      sprintf("a household's tier is the highest its season's net spend has reached, never below where it started (%s moves up in %d days; %s kept a tier their refunds have taken them back below)",
              format(sum(mk$tier > mk$tier0), big.mark = ","), days_complete(), format(fell, big.mark = ",")))
# An offer: its audience and holdout are the shares asked for, no one held
# out gets a coupon, a coupon comes off one purchase, and sending is charged
# the day it goes.
k <- which(OFFERS$from <= days_complete())[1]
if (!is.na(k)) {
  b <- OFFERS$brand[k]
  m <- length(ofr$members[[k]]); sent <- ofr$sent[[k]]
  eligible <- sum(OFFER_TIERS[k, ][mk$tier[, b]] & ofr$bins[k, ][mk$hh$bin])   # the households it reaches (tiers have moved up since the draw)
  buys <- ofr$buys[seq_len(ofr$n_buys), , drop = FALSE]
  used <- buys[buys[, "offer"] == k & buys[, "coupon"] > 0, , drop = FALSE]
  check(abs(m - OFFERS$audience[k] * eligible) <= max(1, 0.02 * eligible) && sum(!sent) == round(OFFERS$holdout[k] * m) &&
        all(sent[used[, "member"]]) && !anyDuplicated(used[, "member"]) && sum(ofr$used[[k]] > 0) == nrow(used) &&
        abs(tally$offer_cost[OFFERS$from[k], b] - OFFERS$send_cost[k] * sum(sent)) < 1e-9,
        sprintf("%s: %s households drawn (%s held out), no coupon for anyone held out, each coupon used once (%d so far), sending charged on day %d",
                OFFERS$name[k], format(m, big.mark = ","), format(sum(!sent), big.mark = ","), nrow(used), OFFERS$from[k]))
  r <- offer_results(k, detail = TRUE)
  check(r$sent == sum(sent) && length(r$sources$rows) == N_BRANDS && is.finite(r$spend$diff) && length(r$sent_curve) == length(r$days),
        sprintf("%s measured against its holdout: %s more per household sent (%s to %s)", OFFERS$name[k],
                sprintf("$%.2f", r$spend$diff), sprintf("$%.2f", r$spend$lo), sprintf("$%.2f", r$spend$hi)))
  # Its lift is net: spend per household and margin, each purchase less the
  # refunds and margin of what came back of it, whenever it came back.
  if (days_complete() > OFFERS$to[k]) {
    want <- offer_net(k)
    check(want$late > 0 && abs(r$spend$diff - want$spend$diff) < 1e-9 && abs(r$margin$diff - want$margin$diff) < 1e-9 && abs(r$refunds - want$refunds) < 1e-6,
          sprintf("%s's lift is net of returns: %s of refunds on its purchases come off spend and margin, %d items returned after it ended among them (net lift %s per household, gross %s)",
                  OFFERS$name[k], sprintf("$%.0f", want$refunds), want$late, sprintf("$%.2f", r$spend$diff), sprintf("$%.2f", want$gross$diff)))
  }
} else check(FALSE, "an offer has gone out in the season run")
check(nchar(export_csv()) > 100, "CSV export")

# Every visit event is told: each logged event of a day has its line and
# its thought, and each tone reads as it should (an impulse buy as one).
L <- prev$vlog$m[seq_len(prev$vlog$n), , drop = FALSE]
known <- all(as.character(unique(L[, 3])) %in% names(EVENT_OF))
sample_rows <- unlist(lapply(split(seq_len(nrow(L)), L[, 3]), function(r) utils::head(r, 40)))
told <- all(vapply(sample_rows, function(i) {
  b <- prev$d$brand[L[i, 1]]
  nzchar(event_lines(L[i, , drop = FALSE], b)[[1]]) && nzchar(event_thoughts(L[i, , drop = FALSE], b)[[1]]$text)
}, TRUE))
picks <- L[L[, 3] == EV_PICKED, , drop = FALSE]
check(known && told, sprintf("every event logged on day %d has its line and thought (%d kinds of event, %d events; %.0f%% of %d picks were impulse buys)",
                             prev$day, length(unique(L[, 3])), nrow(L), 100 * mean(picks[, 7] < IMPULSE_CHANCE), nrow(picks)))
ev_row <- function(code, a1 = 1, a2 = 0, a3 = 0, a4 = 0, a5 = 0) matrix(c(1, 0, code, a1, a2, a3, a4, a5), 1)
tone_of <- function(row) event_thoughts(row, 1L)[[1]]$tone
tones <- c(
  clear = tone_of(ev_row(EV_PICKED, 1, 40, 2, 0.8, 40)), close = tone_of(ev_row(EV_PICKED, 1, 40, 0.3, 0.8, 40)),
  impulse = tone_of(ev_row(EV_PICKED, 1, 40, 2, 0.05, 50)),
  close = tone_of(ev_row(EV_TOO_DEAR, 1, 60, 55, 1)), clear = tone_of(ev_row(EV_TOO_DEAR, 1, 160, 40, 1)),
  close = tone_of(ev_row(EV_NOTHING, 1, 2, -0.2)), clear = tone_of(ev_row(EV_NOTHING, 1, 2, -2)),
  close = tone_of(ev_row(EV_FR_JOINED, 5, 6)), clear = tone_of(ev_row(EV_FR_JOINED, 2, 6)),
  close = tone_of(ev_row(EV_TILL_BALKED, 6, 6)), clear = tone_of(ev_row(EV_TILL_BALKED, 11, 6)),
  close = tone_of(ev_row(EV_TILL_GAVE_UP, 300, 330)), clear = tone_of(ev_row(EV_TILL_GAVE_UP, 300, 900)))
every <- all(vapply(EVENTS, function(ev) is.function(ev$log) && is.function(ev$think), TRUE))
check(every && identical(unname(tones), names(tones)),
      sprintf("each of the %d events has a line and a thought, and the tone follows the decision: %s", length(EVENTS),
              paste(unique(names(tones)), collapse = ", ")))
impulse <- event_thoughts(ev_row(EV_PICKED, 1, 40, 2, 0.05, 50), 1L)[[1]]
cat(sprintf("    an impulse buy: \"%s\" (%s)\n", impulse$text, impulse$detail))

# ---- Watch pace gives the same season -------------------------------------------

cat(sprintf("Watch pace: the same seed, %d days, drawn every tick\n", n_watch))
run_days <- function(pace, n) {
  setup(11)
  P$pace <<- pace; P$watch_speed <<- 600
  frames <- 0L
  while (day <= n && !season_over) {
    if (pace == "season") { go() } else {
      go(); frame_pack(map = TRUE, store = 1L + day %% N_STORES); frames <- frames + 1L
      if (frames %% 97 == 0) {
        report_market(); report_store(3, heat = TRUE); report_funnel(0, 0, 0, "day")
        inspect_at(3, 20, 10); report_store(3)
      }
    }
  }
  list(visits = tally$visits, sales = tally$sales, stock = tally$stock, offers = ofr$buys[seq_len(ofr$n_buys), ],
       rack = stock$rack, tier = mk$tier, frames = frames, refunds = tally$refunds,
       ledger = list(ledger$i[seq_len(ledger$n), ], ledger$m[seq_len(ledger$n), ]))
}
a <- run_days("season", n_watch)
b <- run_days("watch", n_watch)
same <- identical(a$visits, b$visits) && identical(a$sales, b$sales) && identical(a$stock, b$stock) &&
  identical(a$offers, b$offers) && identical(a$rack, b$rack) && identical(a$tier, b$tier) &&
  identical(a$refunds, b$refunds) && identical(a$ledger, b$ledger)
check(same && b$frames > 100 && sum(a$ledger[[1]][, "store"] == 0L) > 0 && sum(a$ledger[[1]][, "ret_day"] > 0L) > 0,
      sprintf("season pace and watch pace (%d frames drawn) give identical days, with online orders and returns on (%d online units, %d returned): visits, sales, refunds, stock and the ledger, line by line",
              b$frames, sum(a$ledger[[1]][, "store"] == 0L), sum(a$ledger[[1]][, "ret_day"] > 0L)))

# Drivers on the map follow their routes: out of the home, into the store,
# on a sixth day (with returns due).
setup(5); P$pace <- "season"
for (i in 1:5) { advance(Inf); finish_day() }
P$pace <- "watch"
advance(3 * 3600)
tr <- travellers_at(clock)
check(length(tr$x) > 0 && all(tr$x >= 0 & tr$x <= MACRO$width_m & tr$y >= 0 & tr$y <= MACRO$height_m),
      sprintf("shoppers on the road stay on the map (%d now)", length(tr$x)))
build_trips()
drive <- which(d$store > 0L)                                        # visits to a store, to shop or return items; online ones make no trip
check(max(abs(route_of(drive, rep(0, length(drive))) - cbind(mk$hh$x[d$hh[drive]], mk$hh$y[d$hh[drive]]))) < 1e-6 &&
      max(abs(route_of(drive, rep(Inf, length(drive))) - cbind(STORES$x[d$store[drive]], STORES$y[d$store[drive]]))) < 1e-6 &&
      sum(d$ret) > 0 && all(!d$online[tr$visit]),
      sprintf("every trip starts at the home and ends at the store, trips to return items too (%d today); online shoppers make none", sum(d$ret)))

# A change made mid-day acts from that moment: a cashier added at 14:00
# shortens the till queue from 14:00, and not before.
setup(3); P$pace <- "watch"; P$watch_speed <- 600
for (i in 1:4) { advance(Inf); finish_day() }                       # to a Friday
advance(4 * 3600)
set_store(STORES$id[1], "cashiers", S$cashiers[1] + 2)
advance(Inf)
m <- legs$m[seq_len(legs$n), , drop = FALSE]
new_tills <- m[m[, "store"] == 1 & m[, "kind"] == PAY & m[, "a"] >= fl$till_first[STORES$format[1]] + S$cashiers[1] - 2, "t0"]
check(length(new_tills) > 0 && min(new_tills) >= 4 * 3600, "cashiers added at 14:00 serve from 14:00 on, not before")

# ---- Drawn floors -------------------------------------------------------------------------

# What a painted floor means to the agents: cubicles are dead ends, every
# door is a way in and out, every block of racks has a place to stand,
# rack space is the faces a shopper can reach, and a fetch walks to the
# stockroom door and back.
cat("Drawn floors\n")
# A fetch takes the handling time and the walk from the rack to the
# nearest stockroom door and back; mid-fetch, the assistant is at that door.
sm <- staff$m[seq_len(staff$n), , drop = FALSE]
fx <- sm[sm[, "job"] == JOB_FETCH, , drop = FALSE]
mid <- fx[which.max(fl$fetch_m[fx[, "anchor"]]), ]
fa <- floor_agents(mid[["store"]], (mid[["t0"]] + mid[["t1"]]) / 2)
k <- which(fa$staff_role == 2L & fa$staff_id == mid[["server"]])
check(nrow(fx) > 0 && isTRUE(all.equal(unname(fx[, "t1"] - fx[, "t0"]), unname(fetch_time(fx[, "anchor"])))) &&
      max(abs(c(fa$staff_x[k], fa$staff_y[k]) - fl$anchor_xy[fl$fetch_to[mid[["anchor"]]], ])) < 1e-6,
      sprintf("each of today's %d fetches takes %d s plus the walk to the stockroom door and back (%.0f to %.0f s); mid-fetch the assistant is at the door",
              nrow(fx), FETCH_HANDLE_S, min(fx[, "t1"] - fx[, "t0"]), max(fx[, "t1"] - fx[, "t0"])))
# Trying on happens in the cubicle, reached from the floor at its opening.
m <- legs$m[seq_len(legs$n), , drop = FALSE]
tries <- m[m[, "kind"] == TRY, , drop = FALSE]
tr <- tries[1, ]; f <- STORES$format[tr[["store"]]]; plan <- fl$plans[[f]]
fa <- floor_agents(tr[["store"]], (tr[["t0"]] + tr[["t1"]]) / 2)
box <- plan$cubicle_boxes[tr[["a"]] - fl$cubicle_first[f] + 1L, ]
opening <- fl$anchor_xy[tr[["a"]], ]
in_box <- any(fa$x >= box[1] & fa$x < box[1] + box[3] & fa$y >= box[2] & fa$y < box[2] + box[4])
check(in_box && plan$chars[plan$H - opening[2], opening[1] + 1] != "F", "a shopper trying on stands in the cubicle, which they reach from the floor at its opening")

TEST_PLAN <- c(
  "####################",
  "#XXX#DDDDDD#FF#FF###",
  "#XXX#......#FF#FF###",
  "##x##......#....W..#",
  "#..........#.www...#",
  "#..................#",
  "#TTTT......$$$.....#",
  "#..........:c:.....#",
  "#..........:::.Qqq.#",
  "#..................#",
  "#########==#########")
keys <- c("D", "T"); names2 <- c("Denim", "Tops")
check(!length(layout_problems(TEST_PLAN, keys, names2)), "a small drawn floor reads with no problems")
# A cubicle can't be a corridor: the denim room walled off, its only way
# out through a fitting cubicle.
corridor <- TEST_PLAN; substr(corridor[5], 6, 11) <- "######"; substr(corridor[3], 12, 12) <- "F"
pb <- layout_problems(corridor, keys, names2)
old_open <- OPEN_CHARS; OPEN_CHARS <- c(OPEN_CHARS, "F")                       # as cubicles were read before
walked_through <- !length(layout_problems(corridor, keys, names2))
OPEN_CHARS <- old_open
check(walked_through && length(pb) == 1L && grepl("can't be walked to", pb[[1]]$message) && all(pb[[1]]$tiles[, 1] == 2),
      "a room reached only through a fitting cubicle is refused: its racks can't be walked to (read as walkable, it passed)")
# Every door is a way in and out: in by one in proportion to its width,
# out by the nearest; a door inside the plan is refused.
two <- TEST_PLAN; substr(two[9], 1, 1) <- "="; substr(two[10], 1, 1) <- "="
p2 <- build_plan(two, keys, names2)
west <- p2$doors[p2$anchor_xy[p2$doors, "x"] == 0]; south <- setdiff(p2$doors, west)
nearest <- all(p2$walk_m[cbind(seq_len(p2$nA), p2$exit)] == apply(p2$walk_m[, p2$doors], 1, min))
inside <- TEST_PLAN; substr(inside[6], 10, 11) <- "=="
pb <- layout_problems(inside, keys, names2)
fl_kept <- fl
fl <- list(entrance = 1L, n_doors = 2L, doors = list(c(1L, 2L)), door_w = list(c(3, 1)))
came <- with_seed(1, door_in(rep(1L, 4000)))
fl <- fl_kept
check(length(p2$doors) == 2L && identical(p2$door_w, c(2L, 2L)) && nearest && any(p2$exit == west) && any(p2$exit == south) &&
      abs(mean(came == 1L) - 0.75) < 0.03 && any(grepl("door \\(=\\) inside the plan", vapply(pb, `[[`, "", "message"))),
      sprintf("two doors: shoppers come in by each in proportion to its width (%.0f%% by one three times as wide) and leave by the nearest; a door inside the plan is refused",
              100 * mean(came == 1L)))
# Every block of racks has a place to stand, in every prefab.
spotless <- character()
for (f in seq_along(PLANS)) {
  p <- layout_scan(PLANS[[f]])$parts
  for (k in which(p$tiles > 0)) for (b in cell_blocks(p$chars == FIXTURES[k])) {
    m <- matrix(FALSE, p$H, p$W); m[b] <- TRUE
    if (!any(near4(m)[p$zone_cells[[k]]])) spotless <- c(spotless, sprintf("%s %s", FORMATS[f], CATEGORIES[k]))
  }
}
check(!length(spotless), "every block of racks in every prefab has a place to stand beside it (the Flagship's third Dresses row, Intimates' fourth Sleepwear block)")
# Rack space is faces: the Flagship's 14 rack tiles with no floor beside
# them don't count, and a category's racks on the floor are its share.
fp <- layout_scan(PLANS[["flagship"]])$parts
hidden <- layout_uses(fp)$hidden
s1 <- which(FORMATS[STORES$format] == "flagship")[1]
cap <- rack_capacity()
p_d <- which(PROD_CAT[STORES$brand[s1], ] == match("D", FIXTURES))[1]; p_t <- which(PROD_CAT[STORES$brand[s1], ] == match("T", FIXTURES))[1]
ratio <- cap[s1, (p_d - 1) * N_SIZES + 3] / cap[s1, (p_t - 1) * N_SIZES + 3]
f_ratio <- fp$faces[match("D", FIXTURES)] / fp$faces[match("T", FIXTURES)]
check(nrow(hidden) == 14L && sum(fp$faces) == sum(fp$tiles) - 14 && abs(ratio - f_ratio) < 1e-9 &&
      all(STORE_SPACE[!CARRIES[STORES$brand, , drop = FALSE]] == 0) && isTRUE(all.equal(unname(rowSums(STORE_SPACE) / N_CARRIED[STORES$brand]), STORE_SIZE)),
      sprintf("rack space is faces: the Flagship's %d hidden rack tiles don't count, its denim racks hold %.2f times its tops (their faces), and racks of what a brand doesn't sell hold nothing",
              nrow(hidden), ratio))

# ---- The world file ------------------------------------------------------------------

cat("World files\n")
W <- world_read(file.path(root, "worlds", "default.world.json"))
text <- world_text(W)
W2 <- world_parse(text)
check(identical(world_text(W2), text) && !length(world_check(W2)), "the default world, exported and imported again, is the same world")
for (f in jsonlite::fromJSON(file.path(root, "layouts", "index.json"))$prefabs) {
  path <- file.path(root, "layouts", paste0(f, ".layout.json"))
  L <- layout_from_file(world_parse(paste(readLines(path), collapse = "\n")))
  again <- world_text(c(list(kind = LAYOUT_KIND, version = LAYOUT_VERSION), L))
  check(identical(again, paste0(paste(readLines(path), collapse = "\n"), "\n")) && !length(layout_problems(L$rows)),
        sprintf("prefab %s reads back identical, with no problems", f))
}
bad <- W; bad$stores[[7]]$layout <- "kiosk"; bad$brands[[2]]$family <- "nobody"
substr(bad$macro$tiles[[3]], 5, 5) <- "Z"
orphan <- length(bad$brands) + 1L
bad$brands[[orphan]] <- bad$brands[[3]]; bad$brands[[orphan]]$id <- "orphan"
bad$stores[[4]]$staff$cashiers <- 9; bad$brands[[1]]$stock$allocation <- "magic"; bad$brands[[1]]$calendar$replenishment[[1]]$rule <- "magic"
msgs <- vapply(world_check(bad), function(p) paste0(p$path, ": ", p$message), "")
check(any(startsWith(msgs, "stores[7].layout: no layout called \"kiosk\"")) && any(startsWith(msgs, "brands[2].family")) &&
      any(startsWith(msgs, "macro.tiles: 1 tiles")) && any(startsWith(msgs, sprintf("brands[%d]: ", orphan))) &&
      any(grepl("^stores\\[4\\]\\.staff\\.cashiers: Small has [0-9]+ tills$", msgs)) &&
      any(startsWith(msgs, "brands[1].stock.allocation: ")) && any(startsWith(msgs, "brands[1].calendar.replenishment[1].rule: ")),
      sprintf("a broken world lists every problem where it is (%d found)", length(msgs)))
# A store made in the micro world has no place until it's put on the map:
# the map's preview goes on (it reaches no one), and Setup says where it's missing.
unplaced <- W; unplaced$stores[[3]]$x <- NULL; unplaced$stores[[3]]$y <- NULL
msgs <- vapply(world_check(unplaced), function(p) paste0(p$path, ": ", p$message), "")
pv <- macro_preview(unplaced)
check(identical(msgs, "stores[3]: not on the map yet: place it on the Macro world's Stores layer") && !length(pv$problems) && is.na(pv$reach[3]) && all(pv$reach[-3] > 0),
      "a store not on the map yet is the one problem Setup names, and the map's preview goes on without it")

# ---- A bigger world: 16 brands on a drawn map, with a drawn layout -------------------------

cat("A 16-brand world on a drawn map, with online stores\n")
big_world <- function(W) {
  # The map: 120 x 90 tiles of 60 m, a road every 8 tiles, a lake crossed
  # by bridges, homes denser towards two town centres, three areas.
  nx <- 120; ny <- 90
  tile <- matrix(".", ny, nx)
  X <- matrix(seq_len(nx), ny, nx, byrow = TRUE); Y <- matrix(seq_len(ny), ny, nx)
  dens <- pmax(exp(-((X - 35)^2 + (Y - 40)^2) / 600), exp(-((X - 90)^2 + (Y - 55)^2) / 450))
  home <- dens > 0.12
  tile[home] <- as.character(pmin(9, pmax(1, round(9 * dens[home]))))
  lake <- (X - 62)^2 / 90 + (Y - 20)^2 / 40 < 1
  tile[lake] <- "~"
  road <- matrix(FALSE, ny, nx); road[, seq(4, nx, 8)] <- TRUE; road[seq(4, ny, 8), ] <- TRUE
  tile[road & lake] <- "+"; tile[road & !lake] <- "="
  area <- matrix(".", ny, nx)
  area[home & X < 60] <- "w"; area[home & X >= 60 & Y < 55] <- "n"; area[home & X >= 60 & Y >= 55] <- "s"
  rows <- function(m) as.list(apply(m, 1, paste, collapse = ""))
  a0 <- W$macro$areas[[1]]
  W$macro <- list(patch_m = 60, width = nx, height = ny, households = 30000, road_mps = 12, local_mps = 4, park_s = 180, wom_m = 600,
                  tiles = rows(tile),
                  areas = lapply(c("w", "n", "s"), function(k) modifyList(a0, list(key = k, id = paste0("area_", k), name = paste("Area", toupper(k))))),
                  area_tiles = rows(area), default_makeup = W$macro$default_makeup)
  # A drawn layout: a corner shop of 40 x 20 half-metres with everything a
  # floor needs.
  pic <- c(
    "########################################",
    "#XXXX#DDDDDDTTTTTTKKKKKK..#FF#FF#FF#####",
    "#XXXX#....................#FF#FF#FF#####",
    "#XXXX#....................#FF#FF#FF#####",
    "##x###....................#............#",
    "#.........................#............#",
    "#O....................wwwwW............#",
    "#O.....................................#",
    "#O.....RRRRRR.........................A#",
    "#O....................................A#",
    "#O.....SSSSSS.........................A#",
    "#O.....................................#",
    "#......TTTT....DDDD.........qqqqqQ.....#",
    "#......................................#",
    "#...........................$$$$$$.....#",
    "#...........................::c:c:.....#",
    "#...........................::::::.....#",
    "#......................................#",
    "#......................................#",
    "#################==#####################")
  W$layouts[[length(W$layouts) + 1L]] <- list(id = "corner", name = "Corner shop", draw = 0.05, rows = as.list(pic))
  # Sixteen brands in five families (ours has three), two stores each but
  # the last, which sells only online: the default world's brands over and
  # over, each on the layouts that have racks for what it sells. Every
  # other brand has an online store too, and every brand takes returns.
  fams <- c("ours", "value_co", "premium_co", "fast_co", "indie_co")
  W$families <- lapply(seq_along(fams), function(k) list(id = fams[k], name = paste("Family", k), ours = k == 1))
  base <- W$brands
  set.seed(99)
  W$brands <- lapply(seq_len(16), function(k) {
    b <- base[[(k - 1) %% length(base) + 1]]
    b$id <- sprintf("brand_%02d", k); b$name <- sprintf("Brand %d", k)
    b$family <- if (k <= 3) "ours" else fams[(k %% 4) + 2]
    b$colour <- sprintf("#%02x%02x%02x", sample(40:220, 1), sample(40:220, 1), sample(40:220, 1))
    b$levers$price <- round(runif(1, 0.6, 1.6), 2)
    b$calendar$offers <- if (k <= 5) list(list(id = "email", name = "Email", from = 2L, to = 6L, depth = 0.15, send_cost = 0.02, audience = 0.3, holdout = 0.1,
                                              tiers = lapply(b$loyalty$tiers, `[[`, "id"), areas = list(), also_at = if (k == 1) list("brand_02") else list())) else list()
    b$online$on <- k %% 2 == 1 || k == 16
    if (k == 16) b$online$plan_stores <- 4
    b$returns$window_days <- 14L + 2L * k
    b
  })
  keys <- vapply(W$categories, `[[`, "", "key")
  on_intimates <- unlist(strsplit(unlist(W$layouts[[match("intimates", vapply(W$layouts, `[[`, "", "id"))]]$rows), ""))
  intimates <- vapply(W$categories, `[[`, "", "id")[keys %in% on_intimates]       # the categories the Intimates plan has racks for
  W$stores <- lapply(seq_len(30), function(s) {
    k <- (s - 1) %/% 2 + 1
    st <- W$stores[[1]]
    st$id <- sprintf("store_%02d", s); st$name <- sprintf("Brand %d store %d", k, (s - 1) %% 2 + 1); st$short <- sprintf("B%d-%d", k, (s - 1) %% 2 + 1)
    sold <- vapply(W$brands[[k]]$range, `[[`, "", "category")
    st$brand <- sprintf("brand_%02d", k)
    st$layout <- if (all(sold %in% intimates)) "intimates" else c("flagship", "standard", "small", "corner")[s %% 4 + 1]
    repeat {                          # somewhere on a home tile, not the lake
      cx <- sample(nx, 1); cy <- sample(ny, 1)
      if (home[cy, cx] && !lake[cy, cx]) break
    }
    st$x <- (cx - 0.5) * 60; st$y <- (ny - cy + 0.5) * 60
    st$staff$cashiers <- min(st$staff$cashiers, 2); st$staff$fitting_rooms <- min(st$staff$fitting_rooms, 2)
    st
  })
  W
}
B16 <- big_world(W)
problems <- world_check(B16)
check(!length(problems), paste("the 16-brand world checks clean", if (length(problems)) paste(vapply(problems[1:min(5, length(problems))], function(p) paste0(p$path, ": ", p$message), ""), collapse = "; ") else ""))
if (!length(problems)) {
  t0 <- proc.time()[["elapsed"]]
  world_install(B16); P$pace <- "season"; setup(2)
  t_setup <- proc.time()[["elapsed"]] - t0
  r <- run_season_days(7)
  t_week <- sum(r$times)
  posted <- ledger$i[seq_len(ledger$n), , drop = FALSE]
  posted <- posted[posted[, "ret_day"] > 0L & posted[, "brand"] == 16L, , drop = FALSE]
  check(r$ok && sum(tally$late) == 0 && sum(stock$online[16, ]) > 0 && nrow(posted) > 0 && all(posted[, "ret_store"] == 0L) && sum(tally$post_parcels[, 16]) > 0,
        sprintf("the 16-brand world runs a week, 9 brands selling online, one with no stores (setup %.1f s, a week %.1f s, %d visits a day, %d online orders a day, 30 stores, 30,000 households); the brand with no stores takes its returns by post (%d items in %d parcels)",
                t_setup, t_week, round(sum(tally$visits) / 7), round(sum(tally$orders) / 7), nrow(posted), sum(tally$post_parcels[, 16])))
  j <- tryCatch({ for (b in c(1, 2, 16)) to_json(report_offers(b)); to_json(report_market()); to_json(report_strategy()); TRUE }, error = function(e) conditionMessage(e))
  check(isTRUE(j), paste("its reports build", if (!isTRUE(j)) j else ""))
  src <- offer_results(1, detail = TRUE)$sources
  check(length(src$rows) == 16 && src$rows[[2]]$relation == "sister" && isTRUE(src$rows[[2]]$good), "its offers report where the extra spend came from, sister brands marked")
}


# ---- Ranges and calendars ---------------------------------------------------------------

cat("Ranges and calendars\n")
default_world <- function() world_read(file.path(root, "worlds", "default.world.json"))
problem_text <- function(W) vapply(world_check(W), function(p) paste0(p$path, ": ", p$message), "")
brand_no <- function(W, id) match(id, vapply(W$brands, `[[`, "", "id"))
product <- function(id, name, category, price, cost, day) list(id = id, name = name, category = category, price = price, cost = cost, day = day)

# A brand with its own range: Fast sells tops, dresses, shoes and a new
# category, swimwear, with its own products and prices, some landing
# mid-season (one on a Wednesday).
W <- default_world()
W$categories[[length(W$categories) + 1L]] <- list(id = "swimwear", name = "Swimwear", key = "M", colour = "#0ca678", try_on = TRUE, price = 45)
for (i in seq_along(W$segments)) W$segments[[i]]$category_taste$swimwear <- 2
fast <- brand_no(W, "fast")
W$brands[[fast]]$range <- list(
  product("boxy_tee", "Boxy tee", "tops", 12, 4, 1), product("crop_top", "Crop top", "tops", 15, 5, 3),
  product("mesh_top", "Mesh top", "tops", 19, 6, 10), product("mini_dress", "Mini dress", "dresses", 24, 8, 1),
  product("slip_dress", "Slip dress", "dresses", 29, 9, 1), product("maxi_dress", "Maxi dress", "dresses", 45, 14, 17),
  product("platform_trainers", "Platform trainers", "shoes", 55, 20, 1), product("slides", "Slides", "shoes", 18, 5, 1),
  product("bikini", "Bikini", "swimwear", 28, 8, 1), product("swimsuit", "Swimsuit", "swimwear", 35, 11, 3),
  product("board_shorts", "Board shorts", "swimwear", 30, 9, 1), product("sarong", "Sarong", "swimwear", 16, 4, 24))
# A brand's plan covers the categories it sells, and no other: Fast's
# still lists denim (which it no longer sells), and lacks swimwear.
msgs <- problem_text(W)
p <- sprintf("brands[%d].stock.plan", fast)
check(sprintf("%s.denim: Fast sells no Denim: only the categories it sells have a plan", p) %in% msgs &&
      sprintf("%s.swimwear: missing: Fast sells Swimwear, so its plan needs the units a standard store sells a week", p) %in% msgs,
      "a plan for a category the brand doesn't sell, or none for one it does, is refused, and says so")
W$brands[[fast]]$stock$plan <- c(W$brands[[fast]]$stock$plan[c("tops", "dresses", "shoes")], list(swimwear = 150))
msgs <- problem_text(W)
fast_stores <- which(vapply(W$stores, `[[`, "", "brand") == "fast")
check(any(grepl(sprintf("^stores\\[%d\\]: Fast sells Swimwear, but its layout .* has no Swimwear racks", fast_stores[1]), msgs)),
      "a store whose layout has no racks for something its brand sells is refused, and says so")
swim <- W$layouts[[match("standard", vapply(W$layouts, `[[`, "", "id"))]]
swim$id <- "swim"; swim$name <- "Standard with swimwear"
swim$rows <- as.list(chartr("A", "M", unlist(swim$rows)))
W$layouts[[length(W$layouts) + 1L]] <- swim
for (s in fast_stores) W$stores[[s]]$layout <- "swim"
msgs <- problem_text(W)
check(!length(msgs), paste("the world with Fast's own range checks clean", paste(utils::head(msgs, 3), collapse = "; ")))
if (!length(msgs)) {
  world_install(W); P$pace <- "season"; setup(8)
  zones_ok <- TRUE
  for (i in 1:7) {
    f <- which(d$brand == fast)
    z <- d$zone[cbind(rep(f, 5), rep(1:5, each = length(f)))]
    used <- rep(1:5, each = length(f)) <= rep(d$n_zones[f], 5)
    zones_ok <- zones_ok && all(CARRIES[fast, z[used]])
    advance(Inf); finish_day()
  }
  rows <- STORES$brand == fast
  sold <- prod_totals(stock$sold)[fast, ]
  swim_sold <- sum(sold[PROD_CAT[fast, ] == match("swimwear", CATEGORY_IDS)])
  check(zones_ok && swim_sold > 0 && sold[match("maxi_dress", PROD_ID[fast, ])] == 0 && sold[match("crop_top", PROD_ID[fast, ])] > 0 &&
        all(stock_balance() == 0) && N_PROD == max(lengths(lapply(W$brands, `[[`, "range"))) && sum(PROD_OK[fast, ]) == 12,
        sprintf("Fast's own range runs a week: its shoppers browse only what it sells, %d swimwear sold, the crop top (day 3) sells, the maxi dress (day 17) waits", swim_sold))
}

# A segment never goes to a brand that sells nothing it likes: with no
# taste for intimates, value seekers never visit the intimates brands,
# while the other segments still do.
W <- default_world()
seg <- 1L
intimates <- c("bras", "briefs", "sleepwear", "loungewear")
for (k in intimates) W$segments[[seg]]$category_taste[[k]] <- 0
msgs <- problem_text(W)
if (!length(msgs)) {
  world_install(W); P$pace <- "season"; setup(6)
  none <- which(RANGE_SHARE[seg, ] == 0)
  theirs <- 0L; others <- 0L
  for (i in 1:5) {
    theirs <- theirs + sum(d$seg == seg & d$brand %in% none); others <- others + sum(d$seg != seg & d$brand %in% none)
    advance(Inf); finish_day()
  }
  check(identical(sort(BRANDS$id[none]), c("ours_intimates", "premium")) && theirs == 0L && others > 0L,
        sprintf("%s never visit %s, which sell nothing they like (other segments made %s visits there in five days)",
                SEGMENTS$name[seg], paste(BRANDS$name[none], collapse = " or "), format(others, big.mark = ",")))
} else check(FALSE, paste("the world without a taste for intimates checks clean:", msgs[1]))

# The promotion rule: two promotions on one product on one day, for the
# same households, are refused, naming both, the product and the days.
W <- default_world()
all_tiers <- list("none", "low", "mid", "high")
denim_days <- list(id = "denim_days", name = "Denim days", on = "categories", items = list("denim"), from = 20, to = 26, depth = 0.25, tiers = all_tiers, areas = list())
jeans_week <- list(id = "jeans_week", name = "Jeans week", on = "products", items = list("slim_jeans"), from = 24, to = 30, depth = 0.2, tiers = list("mid", "high"), areas = list())
W$brands[[1]]$calendar$promotions <- list(denim_days, jeans_week)
msgs <- problem_text(W)
clash <- "brands[1].calendar.promotions[2]: Jeans week and Denim days (promotions[1]) are both on Slim jeans on days 24 to 26"
check(any(startsWith(msgs, clash)), sprintf("overlapping promotions are refused: %s", msgs[startsWith(msgs, "brands[1].calendar")][1]))
denim_days$areas <- list("old_town"); jeans_week$areas <- list("riverside")
W$brands[[1]]$calendar$promotions <- list(denim_days, jeans_week)
check(!length(problem_text(W)), "the same promotions in different areas are allowed (no household sees both)")

# A product's price on a day: list price x price change, less its markdown,
# less the promotion reaching the shopper (on a marked-down product only if
# the brand says so), less a coupon.
W <- default_world()
W$brands[[1]]$levers$price <- 1.1
W$brands[[1]]$calendar$markdowns <- list(markdown_entry("slim_md", "Slim jeans markdown", 2, 2, depth = 0.3, on = "products", items = list("slim_jeans")))
on_sale <- denim_days; on_sale$from <- 2; on_sale$to <- 5; on_sale$depth <- 0.2; on_sale$areas <- list()
W$brands[[1]]$calendar$promotions <- list(on_sale)
msgs <- problem_text(W)
if (!length(msgs)) {
  world_install(W); P$pace <- "season"; setup(4); advance(Inf); finish_day()
  p_md <- match("slim_jeans", PROD_ID[1, ]); p_full <- match("straight_leg_jeans", PROD_ID[1, ])
  everyone <- all(d$reached[d$brand == 1, 1])          # every tier, everywhere
  v <- which(d$brand == 1 & d$coupon == 0 & d$reached[, 1])[1]
  price <- function() rack_price(v, matrix(c(p_md, p_full), 1))$price
  a <- price()
  lp <- LIST_PRICE[1, c(p_md, p_full)]
  stacked <- max(abs(a - lp * 1.1 * c(0.7 * 0.8, 0.8))) < 1e-9
  set_pricing("promos_on_markdowns", "ours", FALSE)
  b <- price()
  unstacked <- max(abs(b - lp * 1.1 * c(0.7, 0.8))) < 1e-9
  vc <- which(d$brand == 1 & d$coupon > 0 & d$reached[, 1])
  coupon <- !length(vc) || abs(rack_price(vc[1], matrix(p_full, 1))$price - lp[2] * 1.1 * 0.8 * (1 - d$coupon[vc[1]])) < 1e-9
  check(everyone && !is.na(v) && stacked && unstacked && coupon, sprintf("a product's price on day 2 follows the rules: $%.2f and $%.2f with the promotion on marked-down products, $%.2f and $%.2f without",
                                                            a[1], a[2], b[1], b[2]))
} else check(FALSE, paste("the price-rules world checks clean:", msgs[1]))

# ---- Replenishment and markdowns on the calendar ----------------------------------------------

cat("Replenishment and markdowns\n")
replenishment_entry <- function(id, name, from, to, weekdays, rule = "top_up", cover = 1.25, reorder = 1.25, on = "range", items = list()) {
  list(id = id, name = name, on = on, items = items, from = from, to = to, weekdays = weekdays, rule = rule, cover = cover, reorder = reorder)
}
one_day <- function() { advance(Inf); finish_day() }
brand_rows <- function(b) which(STORES$brand == b)

# Orders go out on their entry's days only: Ours orders on Mondays and
# Thursdays. A Thursday order sees the demand up to Wednesday night: its
# estimate is the seven days to then, blended with the Thursday estimate a
# week before. Value replaces what sold: each Monday it ships every store
# exactly what it sold of each size since the last order.
W <- default_world()
W$brands[[1]]$calendar$replenishment <- list(replenishment_entry("twice", "Twice a week", 1, 91, list("Mon", "Thu")))
W$brands[[2]]$calendar$replenishment <- list(replenishment_entry("replace", "Replace what sold", 1, 91, list("Mon"), rule = "replace"))
msgs <- problem_text(W)
check(!length(msgs), paste("the replenishment world checks clean", paste(utils::head(msgs, 3), collapse = "; ")))
if (!length(msgs)) {
  world_install(W); P$pace <- "season"; setup(9)
  asked <- list(); replaced <- TRUE; n_replace <- 0L; last_order <- stock$sold
  est <- list()
  while (day < 18) {
    asked[[day]] <- stock$sold + stock$missed                  # by the end of each day (the last taken below)
    one_day()
    asked[[day - 1L]] <- stock$sold + stock$missed
    if (dow_of(day) == 4L) est[[day]] <- stock$estimate[[4]]
    if (dow_of(day) == 1L) {                                  # Value's order this morning: what sold since the last
      r <- brand_rows(2)
      due <- stock$transit$day == day + P_STOCK$lead_days[2] & stock$transit$store %in% r
      sent <- matrix(0, N_STORES, N_SKU)
      sent[cbind(stock$transit$store[due], stock$transit$sku[due])] <- stock$transit$n[due]
      replaced <- replaced && identical(sent[r, ], stock$sold[r, ] - last_order[r, ])
      n_replace <- n_replace + sum(sent[r, ])
      last_order <- stock$sold
    }
  }
  ours <- vapply(CAL_PLAN$replenishment, function(x) x$brand == 1L, TRUE)
  days_ours <- cal$orders$day[ours[cal$orders$entry]]
  window <- function(d) asked[[d - 1L]] - asked[[d - 8L]]        # the seven days to the night before day d
  thu <- identical(est[[11]], window(11)) && identical(est[[18]], 0.5 * est[[11]] + 0.5 * window(18))
  check(identical(days_ours, c(1L, 4L, 8L, 11L, 15L, 18L)), sprintf("Ours orders on Mondays and Thursdays only: days %s", paste(days_ours, collapse = ", ")))
  check(thu && any(window(18) != asked[[14]] - asked[[7]]), "a Thursday order's estimate runs to Wednesday night: the seven days to then, blended with the Thursday before")
  check(replaced && n_replace > 0, sprintf("replace what sold ships each store exactly what it sold since the last order (%s units in two orders)", format(n_replace, big.mark = ",")))
  # The logistics charged are the deliveries and units that left the DC:
  # every unit shipped is charged, and each store pays once for each day
  # stock arrives, whatever it carries.
  advance(Inf); end_day()                                       # day 18 tallied
  shipped <- sum(stock$bought) - sum(stock$dc) - sum(stock$online) + sum(stock$restocked_dc)   # to the stores (online orders leave the DC too)
  stops <- sum(tally$deliveries)
  fees <- sum(tally$deliveries %*% diag(P_STOCK$delivery_fee[STORES$brand]) + tally$shipped %*% diag(P_STOCK$unit_fee[STORES$brand]))
  ours_orders <- sum(cal$orders$units[ours[cal$orders$entry]] > 0)
  check(abs(sum(tally$shipped) - shipped) < 1e-9 && abs(sum(tally$logistics) - fees) < 1e-6 && stops == sum(stock$booked) &&
        sum(tally$deliveries[, brand_rows(1)]) == length(brand_rows(1)) * (1 + ours_orders),
        sprintf("logistics charged ($%s) are the fees for the %s store deliveries and %s units that left the DC; Ours' stores had a delivery for their opening stock and for each of its %d orders",
                format(round(sum(tally$logistics)), big.mark = ","), stops, format(shipped, big.mark = ","), ours_orders))
}

# Clashing entries are refused, naming both, the product and the day: a
# weekly review on Mondays and a denim markdown on a Monday; two weekly
# replenishment entries on the same range.
W <- default_world()
review <- markdown_entry("weekly_review", "Weekly review", 8, 91, list("Mon"), "behind", "deeper", 0.2)
denim <- markdown_entry("denim_clear", "Denim clearance", 50, 50, depth = 0.5, on = "categories", items = list("denim"))
W$brands[[1]]$calendar$markdowns <- list(review, denim)
W$brands[[1]]$calendar$replenishment <- list(replenishment_entry("weekly", "Weekly", 1, 91, list("Mon")),
                                               replenishment_entry("basics", "Basics", 1, 91, list("Mon", "Thu"), on = "categories", items = list("tops")))
msgs <- problem_text(W)
md_clash <- "brands[1].calendar.markdowns[2]: Denim clearance and Weekly review (markdowns[1]) both act on Straight-leg jeans and 4 other products on day 50: a product takes at most one markdown entry a day"
rp_clash <- "brands[1].calendar.replenishment[2]: Basics and Weekly (replenishment[1]) both act on Cotton tee and 4 other products on day 1 (and 12 other days): a product takes at most one replenishment entry a day"
check(md_clash %in% msgs && rp_clash %in% msgs, sprintf("clashing entries are refused: %s", paste(msgs[startsWith(msgs, "brands[1].calendar")], collapse = " | ")))
denim$from <- denim$to <- 51
W$brands[[1]]$calendar$markdowns <- list(review, denim)
W$brands[[1]]$calendar$replenishment[[2]]$weekdays <- list("Thu")
check(!length(problem_text(W)), "on different days (a Tuesday markdown, basics on Thursdays too), the same entries are allowed")

# A markdown behind plan takes only the products behind plan, and a
# markdown never raises a price: Ours marks the products behind plan to 30%
# on day 29, everything to 40% on day 36, then everything to 20% on day
# 43, and 10 points deeper to at most 35% on day 50 (neither changes a
# price).
W <- default_world()
W$brands[[1]]$calendar$markdowns <- list(
  markdown_entry("behind", "Behind plan", 29, 29, which = "behind", depth = 0.3),
  markdown_entry("deep", "Deep", 36, 36, depth = 0.4),
  markdown_entry("shallow", "Shallow", 43, 43, depth = 0.2),
  markdown_entry("nudge", "Nudge", 50, 50, mode = "deeper", depth = 0.1, max = 0.35))
msgs <- problem_text(W)
if (!length(msgs)) {
  world_install(W); P$pace <- "season"; setup(12)
  while (day < 28) one_day()
  advance(Inf); end_day()
  st <- net_sold()[1, ] / pmax(prod_totals(stock$bought, by_brand = TRUE)[1, ], 1)          # sold, net of returns
  judged <- launched[1, ] & 29 - PROD_DAY[1, ] >= 14
  behind <- judged & st < P_PRICE$md_target[1] * planned_by(28)[1, ] - 0.05
  prev <- list(d = d, legs = legs, staff = staff, today = today, vlog = vlog, day = day); start_day()
  took <- all((markdown[1, ] == 0.3) == behind) && all(markdown[1, !behind] == 0) && sum(behind) > 0 && sum(judged & !behind) > 0
  r <- length(cal$taken$day)
  told <- cal$taken$took[r] == sum(behind) && cal$taken$on_plan[r] == sum(judged & !behind) && cal$taken$too_new[r] == sum(launched[1, ] & !judged)
  n_of <- function(n, what) sprintf("%d %s%s", n, what, if (n == 1) "" else "s")
  check(took && told, sprintf("a markdown behind plan on day 29 takes the %s behind plan to 30%%, and leaves the %d on plan and the %d too new to judge",
                              n_of(sum(behind), "product"), sum(judged & !behind), sum(launched[1, ] & !judged)))
  while (day < 50) one_day()
  on_40 <- all(markdown[1, launched[1, ]] == 0.4)
  rec <- cal$taken; mine <- vapply(CAL_PLAN$markdowns, function(x) x$brand == 1L, TRUE)[rec$entry]
  on <- function(d) mine & rec$day == d
  kept <- rec$took[on(43)] == 0 && rec$deeper[on(43)] == sum(launched[1, ]) && rec$took[on(50)] == 0
  check(on_40 && kept, "a markdown never raises a price: after 40% on day 36, a 20% markdown and a 35% cap leave every product at 40% (and say so)")
} else check(FALSE, paste("the markdown world checks clean:", msgs[1]))

# Version 1 and version 2 files upgrade and run: version 2's weekly
# replenishment and its automatic markdowns become calendar entries.
W2 <- world_read(file.path(root, "tools", "fixtures", "v2-default.world.json"), file.path(root, "layouts"))
cal2 <- W2$brands[[1]]$calendar
ids <- vapply(cal2$markdowns, `[[`, "", "id")
check(identical(W2$version, WORLD_VERSION) && !length(world_check(W2)) && identical(ids, c("weekly_review", "final_markdown", "clearance_review")) &&
      identical(cal2$markdowns[[2]]$from, 78L) && identical(cal2$replenishment[[1]]$weekdays, list("Mon")) && is.null(W2$brands[[1]]$pricing$auto_markdowns),
      "a version 2 world upgrades: a weekly replenishment entry, and its automatic markdowns as a Monday review, a final markdown on day 78 and the review after it")
# A brand that stopped selling a category kept a plan for it; upgraded, it
# has a plan only for what it sells.
V2 <- world_parse(paste(readLines(file.path(root, "tools", "fixtures", "v2-default.world.json")), collapse = "\n"))
V2$brands[[2]]$range <- Filter(function(x) x$category != "shoes", V2$brands[[2]]$range)
U <- world_upgrade(V2)
check(identical(sort(names(U$brands[[2]]$stock$plan)), sort(setdiff(vapply(V2$categories, `[[`, "", "id"), "shoes"))) && length(U$brands[[1]]$stock$plan) == 7,
      "upgraded, a brand that sells no shoes has no plan for shoes")
world_install(W2); P$pace <- "season"; setup(3)
r <- run_season_days(7)
check(r$ok && sum(tally$late) == 0 && sum(tally$visits) > 0, "the upgraded version 2 world runs a week")

# ---- Loyalty and offers ------------------------------------------------------------------

cat("Loyalty and offers\n")
# Broken offers and tiers are refused, each where it is.
W <- default_world()
o <- W$brands[[1]]$calendar$offers[[1]]
o$to <- o$from - 1L; o$holdout <- 0.95; o$tiers <- list("none", "gold"); o$also_at <- list("ours")
W$brands[[1]]$calendar$offers[[1]] <- o
W$brands[[1]]$loyalty$tiers[[1]]$spend <- 10
W$brands[[1]]$loyalty$tiers[[4]]$spend <- W$brands[[1]]$loyalty$tiers[[3]]$spend
msgs <- problem_text(W)
p <- "brands[1].calendar.offers[1]"
want <- c(sprintf("%s.to: day %d is before its first day, %d", p, o$to, o$from), sprintf("%s.holdout: 0.95 is outside 0 to 0.9", p),
          sprintf("%s.tiers[2]: no tier called \"gold\"", p), sprintf("%s.also_at[1]: no other brand called \"ours\"", p),
          "brands[1].loyalty.tiers[1].spend: the lowest tier is where a household with no spend stands: its spend must be 0")
check(all(want %in% msgs) && any(startsWith(msgs, "brands[1].loyalty.tiers[4].spend: ")),
      sprintf("broken offers and tiers are refused, each where it is (%d problems)", length(msgs)))

# A version 5 world upgrades: tiers earned by visits get spends (the old
# climb, at the brand's typical price), and a brand's offers programme
# becomes one offer on its calendar; it runs.
V5 <- world_parse(paste(readLines(file.path(root, "tools", "fixtures", "v5-default.world.json")), collapse = "\n"))
U <- world_resolve(world_upgrade(V5), file.path(root, "layouts"))
typical <- stats::median(vapply(V5$brands[[1]]$range, `[[`, 0, "price"))
spends <- vapply(U$brands[[1]]$loyalty$tiers, `[[`, 0, "spend")
offers <- lapply(U$brands, function(b) vapply(b$calendar$offers, `[[`, "", "name"))
check(identical(U$version, WORLD_VERSION) && !length(world_check(U)) && identical(spends, 5 * round((0:3) * 3 * typical / 5)) &&
      is.null(U$brands[[1]]$offers) && is.null(U$brands[[1]]$loyalty$up_after) &&
      identical(lengths(offers), c(1L, 1L, 0L, 0L, 0L)) && identical(U$brands[[1]]$calendar$offers[[1]]$audience, 0.09) &&
      identical(names(U$segments[[1]]$offer_response), c("shop", "appeal")),
      sprintf("a version 5 world upgrades: tiers need $%s, and each brand that ran an offers programme has one offer, all season", paste(spends, collapse = "/")))
world_install(U); P$pace <- "season"; setup(3)
r <- run_season_days(7)
check(r$ok && sum(tally$visits) > 0 && sum(tally$offer_cost) > 0, "the upgraded version 5 world runs a week, its offers sent")

# ---- Online stores and returns ----------------------------------------------------------------

cat("Online stores and returns\n")
# Broken online and return settings are refused, each where it is.
W <- default_world()
W$brands[[1]]$online$delivery_days <- 0
W$brands[[1]]$online$on <- "yes"
W$brands[[2]]$online$shipping_cost <- -1
W$brands[[2]]$returns$window_days <- 400
W$brands[[3]]$returns$post_cost <- "free"
W$brands[[4]]$online <- NULL
W$brands[[5]]$returns$extra <- 1
W$segments[[1]]$online <- 5
msgs <- problem_text(W)
want <- c("brands[1].online.delivery_days: 0 is outside 1 to 14", "brands[1].online.on: must be true or false",
          "brands[2].online.shipping_cost: -1 is outside 0 to 50", "brands[2].returns.window_days: 400 is outside 0 to 365",
          "brands[3].returns.post_cost: must be a number", "brands[4].online: missing", "brands[5].returns.extra: not a setting the world file has",
          "segments[1].online: 5 is outside -3 to 3")
check(all(want %in% msgs), sprintf("broken online and return settings are refused, each where it is (%d problems)%s", length(msgs),
                                   if (all(want %in% msgs)) "" else paste(": missing", paste(setdiff(want, msgs), collapse = "; "))))
# A brand with no stores needs an online store that plans to sell something.
W <- default_world()
fast <- brand_no(W, "fast")
W$stores <- Filter(function(st) st$brand != "fast", W$stores)
W$brands[[fast]]$online$on <- FALSE
msgs <- problem_text(W)
W$brands[[fast]]$online$on <- TRUE; W$brands[[fast]]$online$plan_stores <- 0
msgs2 <- problem_text(W)
check(sprintf("brands[%d]: Fast runs no stores and has no online store: it needs one or the other", fast) %in% msgs &&
      sprintf("brands[%d].online.plan_stores: Fast runs no stores, and its online store plans to sell nothing, so it buys nothing to sell", fast) %in% msgs2,
      "a brand with no stores and no online store is refused, and so is one with no stores whose online store plans to sell nothing")

# An offer's lift is measured net of returns, a return counted against the
# purchase it reverses even when it comes after the offer has ended: a
# three-day email from Ours, measured nine days after it ends.
W <- default_world()
W$brands[[1]]$calendar$offers <- list(list(id = "flash", name = "Flash email", from = 2L, to = 4L, depth = 0.2, send_cost = 0.02, audience = 0.8,
                                          holdout = 0.2, tiers = list("none", "low", "mid", "high"), areas = list(), also_at = list()))
msgs <- problem_text(W)
if (!length(msgs)) {
  world_install(W); P$pace <- "season"; setup(5)
  for (i in 1:13) { advance(Inf); finish_day() }
  k <- which(OFFERS$id == "flash")
  r <- offer_results(k, detail = TRUE); want <- offer_net(k)
  check(want$late > 0 && abs(r$spend$diff - want$spend$diff) < 1e-9 && abs(r$margin$diff - want$margin$diff) < 1e-9 &&
        abs(r$refunds - want$refunds) < 1e-6,
        sprintf("an offer's lift is net of returns, including those made after it ended: the Flash email (days 2 to 4) %s per household sent, net (%s gross), %s refunded on its purchases, %d items of them returned after day 4",
                sprintf("$%.2f", r$spend$diff), sprintf("$%.2f", want$gross$diff), sprintf("$%.0f", want$refunds), want$late))
} else check(FALSE, paste("the flash-offer world checks clean:", msgs[1]))

# ---- A version 6 world ------------------------------------------------------------------

# A version 6 world upgrades: the settings of the Market tab's old promotion
# buttons (each brand's promotion depth, the market's promotion length) go.
# It then runs the season the version 6 model ran, recorded in
# tools/fixtures/v6-season.json: the same visits by outcome, and the same
# sales and units by brand, day by day.
cat("A version 6 world\n")
V6 <- world_parse(paste(readLines(file.path(root, "tools", "fixtures", "v6-default.world.json")), collapse = "\n"))
U <- world_resolve(world_upgrade(V6), file.path(root, "layouts"))
check(identical(U$version, WORLD_VERSION) && !length(world_check(U)) && is.null(U$market$promo_days) &&
      !any(vapply(U$brands, function(b) "promo_depth" %in% names(b$levers), TRUE)),
      "a version 6 world upgrades: its promotion depth and promotion length (for the Market tab's old buttons) go")
rec <- jsonlite::fromJSON(file.path(root, "tools", "fixtures", "v6-season.json"))
world_install(U); P$pace <- "season"; setup(rec$seed)
n6 <- min(n_season, rec$days)
r <- run_season_days(n6)
by_brand <- function(what) t(vapply(seq_len(n6), function(i) brand_of_stores(colSums(tally[[what]][i, , ])), numeric(N_BRANDS)))
visits6 <- t(vapply(seq_len(n6), function(i) as.integer(apply(tally$visits[i, , , , drop = FALSE], 4, sum)), integer(N_OUTCOMES)))
same6 <- identical(visits6, rec$visits[seq_len(n6), , drop = FALSE]) && max(abs(by_brand("sales") - rec$sales[seq_len(n6), , drop = FALSE])) < 0.006 &&
  identical(round(by_brand("units")), rec$units[seq_len(n6), , drop = FALSE] + 0)
none6 <- !any(ONLINE$on) && all(RETURNS$window_days == 0) && sum(stock$online) == 0 && sum(tally$refunds) == 0 && sum(tally$trips) == 0 &&
  all(ledger$i[seq_len(ledger$n), "store"] > 0L) && all(ledger$i[seq_len(ledger$n), "due"] == 0L)
check(r$ok && same6 && none6, sprintf("the upgraded version 6 world runs the season the version 6 model ran, with no online orders and no returns: %d days, %s visits, identical by day and outcome, and sales and units by brand",
                                      n6, format(sum(visits6), big.mark = ",")))

# ---- A version 1 world ------------------------------------------------------------------

# A version 1 world (before ranges and calendars, tiers by visits and an
# offers programme) upgrades and runs. The season the version 1 model ran,
# recorded in tools/fixtures/v1-world/season.json, was run again exactly
# until version 6: tiers earned by spend and offers as named coupons change
# it on purpose.
cat("A version 1 world\n")
fx <- file.path(root, "tools", "fixtures", "v1-world")
problems <- world_load(paste(readLines(file.path(fx, "default.world.json")), collapse = "\n"), file.path(root, "layouts"))   # its prefabs as they are now
ran <- FALSE
if (!length(problems)) { P$pace <- "season"; setup(1); r <- run_season_days(7); ran <- r$ok && sum(tally$visits) > 0 }
check(!length(problems) && ran, paste("the version 1 default world upgrades and runs a week", if (length(problems)) problems[[1]]$message else ""))

cat(if (failures) sprintf("\n%d check(s) failed.\n", failures) else "\nAll checks passed.\n")
quit(status = if (failures) 1L else 0L)
