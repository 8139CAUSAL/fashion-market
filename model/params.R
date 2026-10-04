# Fashion market: the model's constants, and the range of every setting a
# world can hold.
#
# The world itself (the map, the stores, the brands and their ranges and
# calendars, the categories, the shoppers, the floor plans) is a world
# file (world.R reads it; worlds/default.world.json is the one the app
# opens with). What stays here is the model: how people behave. Everything
# is illustrative; each behaviour is either a setting or a named constant
# saying what it stands for.

# ---- Time -------------------------------------------------------------------

OPEN_HOUR <- 10
DAY_S <- 10 * 3600                 # a store's day, 10:00 to 20:00, in seconds
LAST_ENTRY_S <- DAY_S - 1800       # no one comes in during the last half hour
STEP_S <- 60                       # one simulation step: a minute of store time
MIN_BROWSE_S <- 60                 # the shortest stop at a rack (>= STEP_S keeps decisions in time order)
SEASON_DAYS <- 91L                 # the season's length: the world's (world_install sets it)
SEASON_WEEKS <- 13L                # ... and its weeks, the last one maybe short
MAX_SEASON_DAYS <- 182
DAYS <- c("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
HOURLY <- c(4, 7, 10, 12, 12, 11, 11, 11, 12, 10)        # % of a day's visits arriving in each hour from 10:00
DOW_TRAFFIC <- c(0.8, 0.8, 0.85, 0.9, 1.1, 1.6, 1.15)   # Monday to Sunday
WATCH_SPEEDS <- c(1, 30, 120, 600, 3600)                 # store seconds per second of screen, at watch pace

# ---- Catalogue --------------------------------------------------------------

# The categories are the world's, and each brand's range its own (world.R
# installs them into the tables the model reads: CATEGORIES, TRY_ON,
# TYPICAL_PRICE, and the brand x product tables LIST_PRICE, PROD_CAT, ...).
SIZES <- c("XS", "S", "M", "L", "XL")
N_SIZES <- length(SIZES)
CATEGORY_KEYS <- setdiff(LETTERS, c("F", "Q", "W", "X"))   # a category's racks on a floor plan: a capital the plan's other tiles don't use
MAX_CATEGORIES <- 20
MAX_PRODUCTS <- 200                                     # in one brand's range

# ---- In the store -------------------------------------------------------------

WALK_MPS <- c(0.9, 1.3)         # walking speeds, m/s
PICK_W <- 1.5                   # price weight when choosing a product off the rack
PICK_BAR <- 1.8                 # how much a product must appeal before a shopper takes it
MARKDOWN_W <- 1.2               # pull of a marked-down price against the full price
FETCH_HANDLE_S <- 135           # an assistant finding a size in the stockroom (plus the walk from the rack to its door and back)
STAFF_MPS <- 1.2                # staff walking, m/s
ADVISE_S <- 90                  # an assistant advising a shopper at a rack
ADVISE_P <- 0.35                # chance a shopper at a rack asks a free assistant for advice
ADVISE_KEEP <- 0.18             # extra chance of keeping a tried item, times assistant skill
TRY_BASE_S <- 60                # getting in and out of a fitting room (plus each store's try_s per item)
KEEP_P <- 0.55                  # chance a tried item is kept
PAY_BASE_S <- 75                # paying, folding, bagging (plus scan_s per item)
RACK_UNITS <- 3                 # units of each product a store puts out on the floor, per size step
WAGE <- c(cashier = 18, assistant = 20)   # $ per hour
MAX_ITEMS <- 4

# ---- Promotions, marketing, word of mouth -------------------------------------------

PROMO_W <- 0.55                 # awareness of a promotion, in utility
AD_W <- 0.9                     # marketing reach, in utility
AD_COST <- 450                  # $ per day at full reach, across the city
AD_SHOP <- 0.25                 # full reach raises the chance of being in the market by this share
PROMO_SHOP <- 0.35              # ... and a promotion one hears of, by this share (times segment response)

# ---- How big a world can be ---------------------------------------------------------

MAX_BRANDS <- 24
MAX_STORES <- 80
MAX_SEGMENTS <- 12
MAX_TIERS <- 6
MAX_LEAD_DAYS <- 14
MAX_OFFERS <- 40                # on one brand's calendar

# ---- Settings: the range of each ---------------------------------------------------

# One setting: its label on the page, its range and step, whether it's a
# whole number, and how the page shows it (num1, num2, int, pct, pct1, money).
setting <- function(label, min, max, step, format = "num2", kind = if (format == "int") "int" else "num") {
  list(label = label, min = min, max = max, step = step, format = format, kind = kind)
}

# Brand levers, one value per brand (from the world). Staffing levers set
# every store of the brand; one store can then be changed on its own.
LEVERS <- list(
  price       = setting("Price change (x list prices)", 0.5, 2, 0.05, "num2"),
  ad          = setting("Marketing reach", 0, 1, 0.05, "pct"),
  cashiers    = setting("Cashiers per store", 1, 5, 1, "int"),
  assistants  = setting("Assistants per store", 0, 4, 1, "int"),
  skill       = setting("Assistant skill", 0.5, 1.5, 0.1, "num1"),
  scan_s      = setting("Scan time (s per item)", 4, 30, 1, "int")
)
ALLOCATIONS <- c("flat", "learned")
REPLENISH_RULES <- c("top_up", "replace")   # top up to cover (with a reorder point), or replace what sold
MARKDOWN_WHICH <- c("all", "behind")        # every product an entry is on, or only those behind plan
MARKDOWN_MODES <- c("to", "deeper")         # to a depth off full price, or deeper by a step

FIELDS <- list(
  market = list(
    taste_w = setting("Weight of personal taste", 0, 3, 0.1, "num1"),
    price_w = setting("Weight of price", 0, 3, 0.1, "num1"),
    range_w = setting("Weight of the range", 0, 3, 0.1, "num1"),
    km_w = setting("Dislike of travel (per km)", 0, 0.8, 0.02, "num2"),
    memory = setting("Memory of bad visits (kept per day)", 0.8, 0.995, 0.005, "pct1"),
    grudge_w = setting("Weight of a bad visit", 0, 3, 0.1, "num1"),
    wom = setting("Word of mouth", 0, 1.5, 0.05, "num2"),
    outside = setting("Appeal of staying home", 0, 5, 0.1, "num1")),
  season = list(days = setting("Season length (days)", 7, MAX_SEASON_DAYS, 1, "int")),
  category = list(price = setting("Typical price ($)", 1, 1e5, 1, "money")),
  product = list(
    price = setting("List price ($)", 0.01, 1e5, 0.01, "money"),
    cost = setting("Cost ($)", 0, 1e5, 0.01, "money"),
    day = setting("Lands on day", 1, MAX_SEASON_DAYS, 1, "int")),
  promotion = list(depth = setting("Discount", 0.01, 0.9, 0.01, "pct")),
  markdown = list(
    depth = setting("Off full price (to), or the step (deeper)", 0.01, 0.9, 0.01, "pct"),
    max = setting("Deeper: no deeper than", 0.01, 0.9, 0.01, "pct"),
    by = setting("Behind plan by more than (points)", 0, 0.5, 0.01, "pct"),
    min_days = setting("In the stores at least (days)", 0, MAX_SEASON_DAYS, 1, "int"),
    rest_days = setting("Skip a product marked down in the last (days)", 0, MAX_SEASON_DAYS, 1, "int")),
  replenishment = list(
    cover = setting("Order up to (weeks of demand beyond the lead time)", 0, 12, 0.05, "num2"),
    reorder = setting("Reorder a size below (weeks beyond the lead time)", 0, 12, 0.05, "num2")),
  stock = list(
    season_buy = setting("Season's buy against plan (at Setup)", 0.5, 1.6, 0.05, "pct"),
    lead_days = setting("Replenishment lead time (days)", 1, MAX_LEAD_DAYS, 1, "int"),
    opening_weeks = setting("Opening allocation (weeks of planned sales)", 0, 8, 0.25, "num2"),
    delivery_fee = setting("Fee per store delivery ($)", 0, 2000, 5, "money"),
    unit_fee = setting("Fee per unit shipped ($)", 0, 10, 0.05, "money"),
    salvage = setting("Stock left at the season's end: recovered, of cost", 0, 1, 0.05, "pct")),
  pricing = list(
    md_target = setting("Sell-through target by season end", 0.5, 0.98, 0.02, "pct")),
  plan = setting("Planned units a week, standard store", 0, 5000, 1, "int"),
  staff = list(
    cashiers = setting("Cashiers on the tills", 1, 12, 1, "int"),
    assistants = setting("Sales assistants on the floor", 0, 4, 1, "int"),
    fitting_rooms = setting("Fitting rooms open", 1, 12, 1, "int"),
    skill = setting("Assistant skill", 0.5, 1.5, 0.1, "num1"),
    scan_s = setting("Scan time (seconds per item)", 3, 30, 1, "int"),
    try_s = setting("Try-on time (seconds per item)", 30, 300, 10, "int"),
    max_fr_q = setting("Longest fitting-room queue allowed", 1, 20, 1, "int"),
    max_till_q = setting("Longest till queue allowed", 1, 20, 1, "int")),
  offer = list(
    depth = setting("Coupon discount", 0.01, 0.9, 0.01, "pct"),
    send_cost = setting("Cost to send, per household ($)", 0, 50, 0.01, "money"),
    audience = setting("Audience: households it reaches, drawn at random", 0.01, 1, 0.01, "pct"),
    holdout = setting("Held out: of the audience, sent nothing", 0, 0.9, 0.01, "pct")),
  tier = list(
    share = setting("Share", 0, 1, 0.01, "pct"),
    spend = setting("Season spend to reach ($)", 0, 1e5, 1, "money"),
    pull = setting("Pull", -2, 3, 0.1, "num1"),
    price = setting("Price sensitivity", 0, 2, 0.05, "num2"),
    memory = setting("Memory of bad visits", 0, 2, 0.05, "num2"),
    radius = setting("Radius", 0.5, 3, 0.05, "num2"),
    offers = setting("Response to offers", 0, 3, 0.05, "num2")),
  segment = list(
    shop = setting("Daily chance of shopping", 0, 0.5, 0.01, "pct"),
    price = setting("Price sensitivity", 0, 4, 0.1, "num1"),
    promo = setting("Response to promotions", 0, 3, 0.1, "num1"),
    km = setting("Dislike of travel", 0, 4, 0.1, "num1"),
    radius_km = setting("Radius (km)", 0.5, 1000, 0.5, "num1"),
    zones = setting("Racks browsed", 1, 5, 0.1, "num1"),
    browse = setting("Seconds at a rack", 60, 900, 10, "int"),
    patience = setting("Patience in a queue (s)", 30, 1800, 10, "int"),
    max_ahead = setting("Longest queue joined", 1, 20, 1, "int"),
    budget = setting("Budget (times the area's)", 0.2, 4, 0.05, "num2")),
  taste = setting("Taste", 0, 5, 0.5, "num1"),
  macro = list(
    patch_m = setting("Metres per tile", 5, 5000, 5, "int"),
    households = setting("Households", 0, 60000, 500, "int"),
    road_mps = setting("Road speed (m/s)", 1, 40, 0.5, "num1"),
    local_mps = setting("Speed off roads (m/s)", 0.5, 20, 0.5, "num1"),
    park_s = setting("Parking, each trip (s)", 0, 1800, 10, "int"),
    wom_m = setting("Word of mouth reaches (m)", 50, 50000, 50, "int")),
  area = list(budget = setting("Season budget ($, average)", 50, 5000, 10, "int")),
  response = list(shop = setting("Lift in shopping", -0.9, 3, 0.05, "num2"), appeal = setting("Pull", -2, 3, 0.05, "num2")),
  layout = list(draw = setting("Draw", 0, 2, 0.05, "num2"))
)

# The page's settings that aren't the world's: how fast the store clock runs.
DEFAULTS <- list(pace = "watch", watch_speed = 600)   # watch pace at this speed, or season pace (a day per tick)
