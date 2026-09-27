#!/usr/bin/env Rscript
# How far people drive from home to shop, from the 2017 National Household
# Travel Survey (NHTS), as a calibration target for the retail example's
# distance sensitivity (see PLAN-retail-market.md).
#
# Trips: from home (WHYFROM 01) to buy goods (WHYTO 11: groceries, clothes,
# appliances, gas), by car, SUV, van or pickup (TRPTRANS 03-06), weighted by
# the trip weight WTTRDFIN. The purpose code isn't groceries alone, so this
# describes shopping trips in general.
#
# Groups, each also split by the population density of the home block group
# (suburban households drive further):
#   metro     the market's own metro (HH_CBSA), where the survey names it;
#             too few trips to use alone, kept as a check
#   division  metros of the same size in the same census division
#   national  metros of the same size anywhere: the calibration target, the
#             only group with enough trips in every density band
#
#   Rscript tools/retail/nhts-shopping.R                 # Louisville
#   Rscript tools/retail/nhts-shopping.R 31140 6 04      # CBSA, division, size
#
# Data: https://nhts.ornl.gov/ (2017 NHTS, public use, csv.zip), cached in
# tools/.cache/retail/. Public domain, US Department of Transportation.

suppressMessages(library(data.table))

args <- commandArgs(trailingOnly = TRUE)
target_cbsa <- if (length(args) >= 1) args[1] else "31140"   # Louisville/Jefferson County, KY-IN
target_division <- if (length(args) >= 2) as.integer(args[2]) else 6L   # East South Central
target_size <- if (length(args) >= 3) args[3] else "04"   # MSA of 1 to 3 million

script_path <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
root <- normalizePath(file.path(dirname(script_path), "..", ".."))
cache <- file.path(root, "tools", ".cache", "retail")
zip <- file.path(cache, "nhts2017-csv.zip")
out <- file.path(cache, sprintf("nhts-shopping-%s.rds", target_cbsa))

if (!file.exists(zip)) {
  dir.create(cache, showWarnings = FALSE, recursive = TRUE)
  message("Downloading the 2017 NHTS (84 MB)…")
  status <- system2("curl", c("-sSL", "-A", shQuote("NetLogoR-Workbench build script"),
                             "https://nhts.ornl.gov/assets/2016/download/csv.zip", "-o", shQuote(zip)))
  if (status != 0) stop("NHTS download failed.")
}

trips <- fread(cmd = sprintf("unzip -p %s trippub.csv", shQuote(zip)),
               select = c("HOUSEID", "WHYFROM", "WHYTO", "TRPTRANS", "TRPMILES", "TRVLCMIN",
                          "WTTRDFIN", "HH_CBSA", "CENSUS_D", "MSASIZE"),
               colClasses = list(character = c("HOUSEID", "HH_CBSA", "MSASIZE")))
households <- fread(cmd = sprintf("unzip -p %s hhpub.csv", shQuote(zip)),
                    select = c("HOUSEID", "HBPPOPDN"), colClasses = list(character = "HOUSEID"))
trips <- merge(trips, households, by = "HOUSEID")

shopping <- trips[WHYFROM == 1 & WHYTO == 11 & TRPTRANS %in% 3:6 &
                    TRPMILES > 0 & TRVLCMIN > 0 & HBPPOPDN > 0]

# Home block-group density, persons per square mile, in three bands.
shopping[, density := cut(HBPPOPDN, c(0, 999, 3999, Inf),
                          labels = c("under 1,000/sq mi", "1,000-3,999/sq mi", "4,000+/sq mi"))]

wquantile <- function(x, w, p) {
  o <- order(x); x <- x[o]; cw <- cumsum(w[o]) / sum(w)
  vapply(p, function(q) x[which(cw >= q)[1]], 0)
}
describe <- function(d) {
  p <- c(0.1, 0.25, 0.5, 0.75, 0.9)
  mi <- wquantile(d$TRPMILES, d$WTTRDFIN, p)
  mn <- wquantile(d$TRVLCMIN, d$WTTRDFIN, p)
  data.table(trips = nrow(d), households = uniqueN(d$HOUSEID),
             miles_p10 = mi[1], miles_p25 = mi[2], miles_median = mi[3], miles_p75 = mi[4], miles_p90 = mi[5],
             minutes_p10 = mn[1], minutes_p25 = mn[2], minutes_median = mn[3], minutes_p75 = mn[4], minutes_p90 = mn[5])
}

groups <- list(
  metro = shopping[HH_CBSA == target_cbsa],
  division = shopping[CENSUS_D == target_division & MSASIZE == target_size],
  national = shopping[MSASIZE == target_size]
)
result <- rbindlist(lapply(names(groups), function(g) {
  d <- groups[[g]]
  rbind(cbind(group = g, density = "all", describe(d)),
        rbindlist(lapply(levels(shopping$density), function(b) {
          if (!nrow(d[density == b])) return(NULL)
          cbind(group = g, density = b, describe(d[density == b]))
        })))
}))

attr(result, "source") <- "2017 NHTS public use (US DOT / FHWA), trips from home to buy goods by car"
attr(result, "selection") <- sprintf("metro = HH_CBSA %s; division = CENSUS_D %d and MSASIZE %s; national = MSASIZE %s",
                                     target_cbsa, target_division, target_size, target_size)
saveRDS(result, out)

print(result[, .(group, density, trips, households, miles_median, miles_p25, miles_p75, miles_p90,
                 minutes_median, minutes_p75, minutes_p90)], row.names = FALSE)
message("Wrote ", sub(paste0(root, "/"), "", out))
