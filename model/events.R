# What happens in a visit, defined once. The model logs a visit's story as
# it happens (vlog_add in store.R): each event with the numbers that
# decided it. Everything said about a visit comes from that log and this
# table: its line in the follow-a-shopper log, the shopper's thought in the
# inspector (with those numbers when you hover it), and, for how the visit
# ended, the funnel stage it's lost at. Every sentence names the brand's
# own products and the world's categories.
#
# A thought's tone comes from how close the decision was: a product that
# cleared the bar easily or only just, a price just out of reach or far
# above it, a queue left at the limit of their patience or long before.
# One kind of pick has a tone of its own: the impulse buy, where the chance
# of taking anything from the rack (every product in the stores they could
# afford, at today's price, before their taste on the day) was low, and
# something appealed anyway.

# How visits end, and the funnel stage each is lost at (report_funnel).
OUTCOMES <- c("paid", "nothing appealed", "too expensive", "not in my size",
              "left the fitting-room queue", "didn't fit or like it", "walked out of the till queue")
N_OUTCOMES <- length(OUTCOMES)
FUNNEL_STAGES <- c("In market", "Visited", "Picked items", "Past fitting rooms", "Kept", "Paid")
OUTCOME_STAGE <- c(NA, 2L, 2L, 2L, 3L, 4L, 5L)

# The events, by the code the log gives them.
EV_CAME <- 1L; EV_PICKED <- 3L; EV_NO_SIZE <- 4L; EV_FETCHED <- 5L; EV_TOO_DEAR <- 6L; EV_NOTHING <- 7L
EV_ADVISED <- 8L; EV_FR_JOINED <- 9L; EV_FR_BALKED <- 10L; EV_FR_GAVE_UP <- 11L; EV_TRIED <- 12L
EV_TILL_JOINED <- 13L; EV_TILL_BALKED <- 14L; EV_TILL_GAVE_UP <- 15L; EV_PAID <- 16L; EV_LEFT <- 17L

# Where a decision counts as close.
CLEAR_MARGIN <- 1       # appeal this far past the bar, or more: a clear pick
IMPULSE_CHANCE <- 0.2   # a pick where the chance of taking anything from the rack was below this: an impulse buy
NEAR_MISS <- 0.5        # the best product this close under the bar: nearly taken
NEAR_PRICE <- 1.25      # the cheapest liked price within this many times the budget left: just out of reach
NEAR_WAIT <- 1.25       # a wait they gave up on, within this many times their patience: gave up at their limit

# Each event: what it carries (a1..a5 in the log), its line in the log, and
# the thought, as function(e) of the event as event_view() reads it.
EVENTS <- list(
  came_in = list(code = EV_CAME, carries = "",
    log = function(e) "came in",
    think = function(e) "In we go."),
  picked = list(code = EV_PICKED, carries = "the SKU, the price paid, how far past the bar it appealed, the chance of taking anything from the rack, its full price",
    log = function(e) sprintf("picked %s (%s%s)%s", e$item, money(e$a2), if (nzchar(e$was)) paste(",", e$was) else "", if (e$impulse) ", on impulse" else ""),
    think = function(e) {
      was <- if (nzchar(e$was)) sprintf(" (%s)", e$was) else ""
      if (e$impulse) return(tone("impulse", sprintf("Didn't think I'd find anything here. %s at %s%s? Go on then.", e$product, money(e$a2), was)))
      if (e$a3 >= CLEAR_MARGIN) tone("clear", sprintf("%s, %s%s. Love it.", e$product, money(e$a2), was))
      else tone("close", sprintf("%s, %s%s. It'll do.", e$product, money(e$a2), was))
    },
    detail = function(e) sprintf("appeal %.1f against a bar of %.1f; a %s chance of taking anything from this rack", e$a3 + PICK_BAR, PICK_BAR, pct(e$a4))),
  not_in_size = list(code = EV_NO_SIZE, carries = "the SKU",
    log = function(e) sprintf("%s: none on the rack", e$item),
    think = function(e) sprintf("No %s left in the %s.", e$size, tolower_first(e$product))),
  fetched = list(code = EV_FETCHED, carries = "the SKU, the assistant",
    log = function(e) sprintf("assistant %d fetched %s from the stockroom", e$a2, e$item),
    think = function(e) sprintf("An assistant fetched my %s in the %s from the back.", e$size, tolower_first(e$product))),
  too_expensive = list(code = EV_TOO_DEAR, carries = "the category, the cheapest price liked, the budget left, that product",
    log = function(e) sprintf("%s: liked the %s (%s), with %s left", e$category, tolower_first(e$product), money(e$a2), money(e$a3)),
    think = function(e) {
      if (e$a2 <= NEAR_PRICE * e$a3) tone("close", sprintf("The %s is %s, and I've %s left. So close.", tolower_first(e$product), money(e$a2), money(e$a3)))
      else tone("clear", sprintf("Love the %s, but %s? Way past what I've got left.", tolower_first(e$product), money(e$a2)))
    },
    detail = function(e) sprintf("%s against %s left of their budget", money(e$a2), money(e$a3))),
  nothing_appealed = list(code = EV_NOTHING, carries = "the category, the product that came closest, how far under the bar",
    log = function(e) sprintf("%s: nothing appealed%s", e$category, if (nzchar(e$product)) sprintf(" (the %s came closest)", tolower_first(e$product)) else ""),
    think = function(e) {
      if (!nzchar(e$product)) return(tone("clear", sprintf("Nothing on the %s racks yet.", tolower(e$category))))
      if (e$a3 > -NEAR_MISS) tone("close", sprintf("Nearly went for the %s. Not quite.", tolower_first(e$product)))
      else tone("clear", sprintf("Nothing in %s for me.", tolower(e$category)))
    },
    detail = function(e) if (nzchar(e$product)) sprintf("the %s: appeal %.1f against a bar of %.1f", tolower_first(e$product), e$a3 + PICK_BAR, PICK_BAR) else ""),
  advised = list(code = EV_ADVISED, carries = "the assistant",
    log = function(e) sprintf("assistant %d gave advice", e$a1),
    think = function(e) "An assistant gave me some advice."),
  fr_joined = list(code = EV_FR_JOINED, carries = "how many ahead, the longest queue they'd join",
    log = function(e) sprintf("joined the fitting-room queue (%d ahead)", e$a1),
    think = function(e) queue_joined(e, "for the fitting rooms", "Straight into a fitting room."),
    detail = function(e) queue_limit(e)),
  fr_balked = list(code = EV_FR_BALKED, carries = "how many ahead, the longest queue they'd join",
    log = function(e) sprintf("saw %d waiting for the fitting rooms and didn't join", e$a1),
    think = function(e) queue_balked(e, "waiting for the fitting rooms"),
    detail = function(e) queue_limit(e)),
  fr_gave_up = list(code = EV_FR_GAVE_UP, carries = "their patience, the wait they'd have had",
    log = function(e) sprintf("gave up on the fitting-room queue after %s", mins_text(e$a1)),
    think = function(e) queue_gave_up(e, "for a fitting room"),
    detail = function(e) queue_wait(e)),
  tried_on = list(code = EV_TRIED, carries = "how many tried on, how many kept",
    log = function(e) sprintf("tried on %d, kept %d", e$a1, e$a2),
    think = function(e) {
      if (e$a2 == e$a1) sprintf("Tried on %d. %s", e$a1, if (e$a1 == 1) "It works." else "They all work.")
      else if (e$a2 == 0) sprintf("Tried on %d. None of it works.", e$a1)
      else sprintf("Tried on %d, keeping %d.", e$a1, e$a2)
    }),
  till_joined = list(code = EV_TILL_JOINED, carries = "how many ahead, the longest queue they'd join",
    log = function(e) sprintf("joined the till queue (%d ahead)", e$a1),
    think = function(e) queue_joined(e, "at the tills", "No queue at the tills."),
    detail = function(e) queue_limit(e)),
  till_balked = list(code = EV_TILL_BALKED, carries = "how many ahead, the longest queue they'd join",
    log = function(e) sprintf("saw %d waiting at the tills and walked out", e$a1),
    think = function(e) queue_balked(e, "waiting at the tills"),
    detail = function(e) queue_limit(e)),
  till_gave_up = list(code = EV_TILL_GAVE_UP, carries = "their patience, the wait they'd have had",
    log = function(e) sprintf("gave up waiting at the tills after %s", mins_text(e$a1)),
    think = function(e) queue_gave_up(e, "at the tills"),
    detail = function(e) queue_wait(e)),
  paid = list(code = EV_PAID, carries = "items, amount, saved on markdowns, on promotions, with a coupon",
    log = function(e) sprintf("paid %s for %d item%s%s", money(e$a2), e$a1, if (e$a1 == 1) "" else "s",
                              if (e$saved > 0) sprintf(", saving %s", money(e$saved)) else ""),
    think = function(e) sprintf("Paid %s for %d item%s.%s", money(e$a2), e$a1, if (e$a1 == 1) "" else "s",
                                if (e$saved > 0) sprintf(" Saved %s.", money(e$saved)) else ""),
    detail = function(e) if (e$saved > 0) sprintf("saved %s on markdowns, %s on promotions, %s with a coupon", money(e$a3), money(e$a4), money(e$a5)) else ""),
  left = list(code = EV_LEFT, carries = "how the visit ended",
    log = function(e) sprintf("left: %s", OUTCOMES[e$a1]),
    think = function(e) if (e$a1 == 1L) "Done. Home." else "Leaving with nothing.")
)
EVENT_OF <- setNames(names(EVENTS), vapply(EVENTS, `[[`, 0L, "code"))

# The shared sentences of the queues. The longest queue they'd join is
# a2 - 1: they join while fewer than a2 are ahead.
queue_joined <- function(e, where, none) {
  if (e$a1 == 0) return(tone("clear", none))
  if (e$a1 >= e$a2 - 1) tone("close", sprintf("%d ahead %s. Any more and I'd have gone.", e$a1, where))
  else tone("clear", sprintf("%d ahead of me %s. I'll wait.", e$a1, where))
}
queue_balked <- function(e, where) {
  if (e$a1 <= e$a2) tone("close", sprintf("%d %s. Just one too many.", e$a1, where))
  else tone("clear", sprintf("%d %s? Not a chance.", e$a1, where))
}
queue_gave_up <- function(e, where) {
  if (e$a2 <= NEAR_WAIT * e$a1) tone("close", sprintf("%s I've waited %s. That's my limit.", capital(mins_text(e$a1)), where))
  else tone("clear", sprintf("%s %s, and it's barely moved. I'm going.", capital(mins_text(e$a1)), where))
}
queue_limit <- function(e) sprintf("%d ahead; they join while fewer than %d are", e$a1, e$a2)
queue_wait <- function(e) sprintf("patience %s; the wait would have been %s", mins_text(e$a1), mins_text(e$a2))

tone <- function(t, text) list(tone = t, text = text)
money <- function(x) if (abs(x) >= 100 || abs(x - round(x)) < 0.005) sprintf("$%.0f", x) else sprintf("$%.2f", x)
pct <- function(x) sprintf("%.0f%%", 100 * x)
capital <- function(s) paste0(toupper(substr(s, 1, 1)), substr(s, 2, nchar(s)))
tolower_first <- function(s) paste0(tolower(substr(s, 1, 1)), substr(s, 2, nchar(s)))
mins_text <- function(s) if (s < 90) sprintf("%.0f s", s) else sprintf("%.0f min", s / 60)

# One logged event (a row of the visit log: visit, time, code, a1..a5) as
# the sentences read it, for a visit to brand b.
event_view <- function(row, b) {
  e <- list(code = row[3], a1 = row[4], a2 = row[5], a3 = row[6], a4 = row[7], a5 = row[8],
            product = "", item = "", size = "", category = "", was = "", impulse = FALSE, saved = 0)
  code <- e$code
  if (code %in% c(EV_PICKED, EV_NO_SIZE, EV_FETCHED)) {
    p <- product_of(e$a1)
    e$product <- PROD_NAME[b, p]; e$size <- SIZES[size_of(e$a1)]; e$item <- sprintf("%s in %s", e$product, e$size)
  }
  if (code == EV_PICKED) {
    e$impulse <- e$a4 < IMPULSE_CHANCE
    if (e$a5 > e$a2 + 0.005) e$was <- sprintf("was %s", money(e$a5))
  }
  if (code %in% c(EV_TOO_DEAR, EV_NOTHING)) {
    e$category <- CATEGORIES[e$a1]
    k <- if (code == EV_TOO_DEAR) e$a4 else e$a2
    if (k > 0) e$product <- PROD_NAME[b, k]
  }
  if (code == EV_PAID) e$saved <- e$a3 + e$a4 + e$a5
  e
}

# The follow-a-shopper log and the thoughts of one visit's events (rows of
# the visit log), for a visit to brand b.
event_lines <- function(L, b) {
  lapply(seq_len(nrow(L)), function(i) {
    ev <- EVENTS[[EVENT_OF[[as.character(L[i, 3])]]]]
    ev$log(event_view(L[i, ], b))
  })
}

event_thoughts <- function(L, b) {
  lapply(seq_len(nrow(L)), function(i) {
    ev <- EVENTS[[EVENT_OF[[as.character(L[i, 3])]]]]
    e <- event_view(L[i, ], b)
    th <- ev$think(e)
    if (is.character(th)) th <- tone("", th)
    list(text = th$text, tone = th$tone, detail = if (is.null(ev$detail)) "" else ev$detail(e))
  })
}
