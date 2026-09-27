# The micro world: store floor plans. Each layout is a text picture, one
# character per half-metre, read into a NetLogoR world, the places shoppers
# and staff go (anchors), and the walking routes between them (grid.R),
# worked out once so walking is a lookup.
#
#   #  wall            .  floor            =  door (on the plan's outer edge;
#                                             each run of = is an entrance)
#   X  stockroom       x  stockroom door (staff fetch sizes through it)
#   a category's key   its racks (the world's categories: D for denim, T for
#                      tops, ... in the default world)
#   F  fitting cubicle (each block of F is one cubicle)
#   W  fitting-room queue head, w its line     Q  till queue head, q its line
#   $  till counter    c  a cashier's place    :  behind the counter
#
# How a picture is read:
#   - shoppers come in by one of the doors, in proportion to its width, and
#     leave by the one nearest where they finish
#   - shoppers stand on floor beside a category's racks: a place at each
#     block of its racks, and more spread out (SPOTS_PER_ZONE at least); a
#     layout needs racks, and a store needs racks for every category its
#     brand sells (world.R checks that)
#   - a rack tile with floor beside it is a face; a category's faces are its
#     rack space (a tile deep in a block, with no floor beside it, holds
#     nothing a shopper can reach)
#   - a cubicle is a dead end: its shopper walks to the floor at its opening
#     and steps in (no one walks through one)
#   - a till's customer stands on the open tile nearest the cashier across
#     the counter, in any direction
#   - a queue's line runs from its head, ordered by walking distance along it
#   - an assistant fetching a size walks from the rack to the nearest
#     stockroom door and back
# layout_problems() says, in words, everything that stops a picture being
# read; what it accepts, build_plan() reads.

CELL_M <- 0.5
SPOTS_PER_ZONE <- 4                 # places to stand at each category's racks, at least
MAX_SPOTS_PER_ZONE <- 12            # ... and blocks of its racks, at most (the walk table grows with the square of the places)
MAX_LAYOUT_W <- 120                 # tiles (60 m)
MAX_LAYOUT_H <- 80                  # tiles (40 m)
STANDARD_RACK_FACES <- 124          # rack faces of a standard store (the Standard prefab)

# What each tile is on the plan: the code the page colours it by (see
# FLOOR_KEY). A category's racks are RACK_CODE + the category's number.
FLOOR_CODES <- c("." = 0, "#" = 1, "=" = 2, F = 12, "$" = 13, ":" = 14, c = 14, X = 15, x = 15,
                 w = 16, W = 16, q = 16, Q = 16)
RACK_CODE <- 100
FLOOR_KEY <- c("floor", "wall", "door", rep("", 9), "fitting room", "till", "counter", "stockroom", "queue")
OPEN_CHARS <- c(".", "=", "w", "W", "q", "Q")      # where shoppers and staff walk

# The codes of a picture's tiles, racks by the world's categories (keys).
floor_codes <- function(chars, keys = FIXTURES) {
  out <- unname(FLOOR_CODES[chars])
  k <- match(chars, keys)
  out[!is.na(k)] <- RACK_CODE + k[!is.na(k)]
  out
}

# Cells beside (sharing a side with) a cell of `mask`.
near4 <- function(mask) {
  H <- dim(mask)[1L]; W <- dim(mask)[2L]
  mask[c(2:H, H), , drop = FALSE] | mask[c(1, 1:(H - 1)), , drop = FALSE] | mask[, c(2:W, W), drop = FALSE] | mask[, c(1, 1:(W - 1)), drop = FALSE]
}

# Rack faces by category (keys): rack tiles with floor beside them.
rack_faces <- function(chars, keys = FIXTURES) {
  beside <- near4(chars == ".")
  vapply(keys, function(k) sum(chars == k & beside), 0, USE.NAMES = FALSE)
}

# ---- Reading a picture ------------------------------------------------------------------

# Everything the picture says, and every problem with it: list(problems,
# parts). Racks are read by the categories' keys (`keys`, named `names`).
# Problems are list(message, tiles), tiles as 0-based rows and columns from
# the top left.
layout_scan <- function(rows, keys = FIXTURES, names = CATEGORIES) {
  pb <- list()
  bad <- function(message, cells = NULL, H = NULL) {
    tiles <- if (length(cells)) cbind((cells - 1L) %% H, (cells - 1L) %/% H) else NULL
    pb[[length(pb) + 1L]] <<- list(message = message, tiles = tiles)
  }
  if (!is.list(rows) && !is.character(rows)) return(list(problems = list(list(message = "must be a list of text rows", tiles = NULL))))
  rows <- unlist(rows)
  if (!is.character(rows) || !length(rows)) return(list(problems = list(list(message = "must be a list of text rows", tiles = NULL))))
  w <- nchar(rows)
  if (any(w != w[1])) {
    r <- which(w != w[1])[1]
    return(list(problems = list(list(message = sprintf("row %d is %d wide; row 1 is %d", r, w[r], w[1]), tiles = NULL))))
  }
  H <- length(rows); W <- w[1]
  if (W < 5 || H < 5 || W > MAX_LAYOUT_W || H > MAX_LAYOUT_H) {
    return(list(problems = list(list(message = sprintf("%d x %d tiles; a floor is 5 x 5 to %d x %d", W, H, MAX_LAYOUT_W, MAX_LAYOUT_H), tiles = NULL))))
  }
  chars <- do.call(rbind, strsplit(rows, ""))
  unknown <- which(!(chars %in% c(names(FLOOR_CODES), keys)))
  if (length(unknown)) bad(sprintf("%d tiles aren't a known kind (\"%s\" is the first): racks are painted with a category's key", length(unknown), chars[unknown[1]]), unknown, H)
  open <- matrix(chars %in% OPEN_CHARS, H)
  floor <- chars == "."
  at <- function(r, c) ifelse(r >= 1 & r <= H & c >= 1 & c <= W, (c - 1L) * H + r, NA_integer_)
  rc <- function(i) list(r = (i - 1L) %% H + 1L, c = (i - 1L) %/% H + 1L)
  one <- function(cells) { m <- matrix(FALSE, H, W); m[cells] <- TRUE; m }
  # A block's way in: its tile beside open floor (the lowest, then the
  # leftmost) and the open tile it opens onto (below, above, left, right).
  opening <- function(b) {
    inside <- b[near4(open)[b]]
    if (!length(inside)) return(NULL)
    p <- rc(inside); i <- inside[order(-p$r, p$c)][1]; q <- rc(i)
    for (dir in list(c(1L, 0L), c(-1L, 0L), c(0L, -1L), c(0L, 1L))) {
      j <- at(q$r + dir[1], q$c + dir[2])
      if (!is.na(j) && open[j]) return(c(inside = i, opening = j))
    }
  }

  # Doors: each block of = is an entrance, on the plan's outer edge; its
  # shoppers come in and go out at the middle of its tiles on the edge, and
  # its width is how many of them there are.
  edge <- row(chars) %in% c(1L, H) | col(chars) %in% c(1L, W)
  doors <- cell_blocks(chars == "=")
  if (!length(doors)) bad("no door (=)")
  entrances <- integer(); door_w <- integer()
  for (b in doors) {
    e <- b[edge[b]]
    if (!length(e)) { bad("a door (=) inside the plan: doors go on its outer edge, where shoppers come in", b, H); next }
    entrances <- c(entrances, e[ceiling(length(e) / 2)]); door_w <- c(door_w, length(e))
  }

  # Stockroom doors: each block of x; an assistant fetching a size walks to
  # the floor at its opening.
  stock_doors <- cell_blocks(chars == "x")
  if (!length(stock_doors)) bad("no stockroom door (x)")
  stock_open <- integer()
  for (b in stock_doors) {
    o <- opening(b)
    if (is.null(o)) bad("a stockroom door (x) that doesn't open onto the floor", b, H) else stock_open <- c(stock_open, o[["opening"]])
  }

  # Racks, their faces, and places to stand at them: one at each block of a
  # category's racks (the floor beside it nearest its middle), then more,
  # each as far as can be from those chosen.
  zone_cells <- vector("list", length(keys))
  faces <- rack_faces(chars, keys)
  tiles <- vapply(keys, function(k) sum(chars == k), 0L, USE.NAMES = FALSE)
  for (k in which(tiles > 0)) {
    blocks <- cell_blocks(chars == keys[k])
    if (length(blocks) > MAX_SPOTS_PER_ZONE) {
      bad(sprintf("%s racks in %d separate blocks; at most %d (join some up)", names[k], length(blocks), MAX_SPOTS_PER_ZONE), which(chars == keys[k]), H)
      next
    }
    seeds <- integer(); spots <- integer()
    for (b in blocks) {
      s <- which(near4(one(b)) & floor)
      if (!length(s)) { bad(sprintf("%s racks with no floor beside them: no one can reach them", names[k]), b, H); next }
      p <- rc(s); m <- rc(b)
      seeds <- c(seeds, s[which.min((p$r - mean(m$r))^2 + (p$c - mean(m$c))^2)])
      spots <- c(spots, s)
    }
    if (!length(seeds)) next
    spots <- unique(spots); seeds <- unique(seeds)
    zone_cells[[k]] <- spread_cells(spots, max(SPOTS_PER_ZONE, length(seeds)), H, chosen = match(seeds, spots))
  }
  if (!any(tiles > 0)) bad(sprintf("no racks: paint them with a category's key (%s)", paste(sprintf("%s %s", keys, names)[seq_len(min(3, length(keys)))], collapse = ", ")))

  # Fitting cubicles: each 4-connected block of F, numbered left to right;
  # its shopper steps in from the floor at its opening.
  blocks <- cell_blocks(chars == "F")
  if (!length(blocks)) bad("no fitting cubicle (F)")
  inside <- integer(); fronts <- integer(); cubicles <- list()
  for (b in blocks) {
    o <- opening(b)
    if (is.null(o)) { bad("a fitting cubicle with no way in from the floor", b, H); next }
    inside <- c(inside, o[["inside"]]); fronts <- c(fronts, o[["opening"]]); cubicles[[length(cubicles) + 1L]] <- b
  }
  o <- order(rc(inside)$c, rc(inside)$r)
  inside <- inside[o]; fronts <- fronts[o]; cubicles <- cubicles[o]

  # Queues: one head each, the line joined to it.
  queue <- function(head, line, what) {
    h <- which(chars == head)
    if (length(h) != 1L) { bad(sprintf("the %s queue needs one head (%s); there %s %d", what, head, if (length(h) == 1) "is" else "are", length(h)), h, H); return(NULL) }
    cells <- which(chars %in% c(head, line))
    d <- line_steps(chars %in% c(head, line), h, H, W, moves = 8L, corners = TRUE)
    if (any(!is.finite(d[cells]))) bad(sprintf("%s queue tiles (%s) not joined to its head", what, line), cells[!is.finite(d[cells])], H)
    cells <- cells[is.finite(d[cells])]
    cells[order(d[cells])]
  }
  fr_line <- queue("W", "w", "fitting-room")
  till_line <- queue("Q", "q", "till")

  # Tills: a cashier's place behind a counter, and where their customer stands.
  cashiers <- which(chars == "c")
  if (!length(cashiers)) bad("no till: a cashier's place (c) behind a counter ($)")
  cashiers <- cashiers[order(rc(cashiers)$r, rc(cashiers)$c)]      # top to bottom
  till_spot <- integer(length(cashiers))
  for (j in seq_along(cashiers)) {
    p <- rc(cashiers[j]); best <- NA_integer_; best_d <- Inf
    for (dir in list(c(0L, -1L), c(0L, 1L), c(-1L, 0L), c(1L, 0L))) {
      r <- p$r; c <- p$c; k <- 0L; counter <- FALSE
      repeat {
        r <- r + dir[1]; c <- c + dir[2]; k <- k + 1L
        i <- at(r, c)
        if (is.na(i)) break
        ch <- chars[i]
        if (!counter && ch %in% c(":", "c")) next
        if (ch == "$") { counter <- TRUE; next }
        if (counter && open[i] && k < best_d) { best <- i; best_d <- k }
        break
      }
    }
    if (is.na(best)) bad("a cashier's place with no counter ($) between it and the floor", cashiers[j], H)
    till_spot[j] <- best
  }

  parts <- list(H = H, W = W, chars = chars, open = open, entrances = entrances, door_w = door_w,
                stock_open = stock_open, zone_cells = zone_cells, faces = faces, tiles = tiles,
                blocks = cubicles, inside = inside, fronts = fronts, fr_line = fr_line, till_line = till_line,
                cashiers = cashiers, till_spot = till_spot)
  if (length(pb)) return(list(problems = pb, parts = parts))

  # Every place a shopper or an assistant goes must be walkable from every door.
  anchors <- layout_anchors(parts)
  lost <- integer()
  for (e in entrances) {
    reach <- line_steps(open, e, H, W, moves = 8L)
    lost <- c(lost, anchors[!is.finite(reach[anchors])])
  }
  if (length(lost)) bad(sprintf("places shoppers or staff go that can't be walked to from %s", if (length(entrances) > 1L) "every door" else "the door"), unique(lost), H)
  list(problems = pb, parts = parts)
}

# The anchors, in the order the model numbers them: rack places by
# category, the entrances, the two queue heads, cubicles' openings, till
# spots, and the stockroom doors' openings.
layout_anchors <- function(parts) {
  c(unlist(parts$zone_cells), parts$entrances, parts$fr_line[1], parts$till_line[1],
    parts$fronts, parts$till_spot, parts$stock_open)
}

# Steps from cell `from` to every cell of `mask`, moving to 4 neighbours
# or 8 (cutting corners only if `corners`).
line_steps <- function(mask, from, H, W, moves = 4L, corners = FALSE) {
  d <- rep(Inf, H * W)
  if (!length(from) || !mask[from]) return(d)
  d[from] <- 0; front <- from; s <- 0
  moves <- rbind(c(-1, 0), c(1, 0), c(0, -1), c(0, 1), c(-1, -1), c(-1, 1), c(1, -1), c(1, 1))[seq_len(moves), , drop = FALSE]
  while (length(front)) {
    s <- s + 1
    r <- (front - 1L) %% H + 1L; c <- (front - 1L) %/% H + 1L
    nxt <- integer()
    for (m in seq_len(nrow(moves))) {
      rr <- r + moves[m, 1]; cc <- c + moves[m, 2]
      ok <- rr >= 1 & rr <= H & cc >= 1 & cc <= W
      if (m > 4 && !corners) ok <- ok & mask[pmax(1, pmin(H * W, (c - 1) * H + rr))] & mask[pmax(1, pmin(H * W, (cc - 1) * H + r))]
      i <- ((cc - 1) * H + rr)[ok]
      i <- i[mask[i] & !is.finite(d[i])]
      d[i] <- s; nxt <- c(nxt, i)
    }
    front <- unique(nxt)
  }
  d
}

# 4-connected blocks of `mask`, as lists of cells, in order of first cell.
cell_blocks <- function(mask) {
  H <- nrow(mask); label <- matrix(0L, H, ncol(mask)); k <- 0L
  for (i in which(mask)) {
    if (label[i]) next
    k <- k + 1L; stack <- i
    while (length(stack)) {
      j <- stack[1]; stack <- stack[-1]
      if (label[j]) next
      label[j] <- k
      r <- (j - 1) %% H + 1; cc <- (j - 1) %/% H + 1
      nb <- c(if (r > 1) j - 1, if (r < H) j + 1, if (cc > 1) j - H, if (cc < ncol(mask)) j + H)
      stack <- c(stack, nb[mask[nb] & !label[nb]])
    }
  }
  lapply(seq_len(k), function(g) which(label == g))
}

# Up to k of `cells`, spread out: those `chosen` (positions in `cells`),
# then each the farthest from those chosen so far.
spread_cells <- function(cells, k, H, chosen = 1L) {
  p <- cbind((cells - 1) %/% H, H - 1 - (cells - 1) %% H)
  while (length(chosen) < min(k, length(cells))) {
    d <- apply(p[chosen, , drop = FALSE], 1, function(q) (p[, 1] - q[1])^2 + (p[, 2] - q[2])^2)
    chosen <- c(chosen, which.max(apply(matrix(d, nrow(p)), 1, min)))
  }
  cells[chosen]
}

layout_problems <- function(rows, keys = FIXTURES, names = CATEGORIES) layout_scan(rows, keys, names)$problems

# ---- Building a plan ------------------------------------------------------------------------

# Reads one floor plan (one layout_problems() accepts): the map, the anchors
# (places shoppers and staff stand), their walking distances and the paths
# between them, and from each anchor the way out (the nearest door) and the
# walk to the nearest stockroom door.
build_plan <- function(rows, keys = FIXTURES, names = CATEGORIES) {
  s <- layout_scan(rows, keys, names)
  if (length(s$problems)) stop("the floor plan has problems: ", s$problems[[1]]$message)
  p <- s$parts; H <- p$H; W <- p$W; chars <- p$chars
  xy <- function(i) cbind(x = (i - 1) %/% H, y = H - 1 - (i - 1) %% H)  # matrix index to patch
  anchors <- layout_anchors(p)
  zone_n <- lengths(p$zone_cells)
  zone_first <- cumsum(c(0, zone_n[-length(zone_n)])) + 1
  n_zone <- sum(zone_n); n_door <- length(p$entrances)
  queues <- n_zone + n_door
  codes <- matrix(floor_codes(chars, keys), H)
  world <- createWorld(0, W - 1, 0, H - 1, data = as.vector(t(codes)))   # the floor as a NetLogoR world
  helpers <- utils::head(order(-p$faces)[p$faces[order(-p$faces)] > 0 & zone_n[order(-p$faces)] > 0], 4)
  plan <- list(
    H = H, W = W, chars = chars, open = p$open, codes = codes, world = world,
    anchors = anchors, anchor_xy = xy(anchors), nA = length(anchors),
    zone_first = zone_first, zone_n = zone_n,
    entrance = n_zone + 1L, doors = n_zone + seq_len(n_door), door_w = p$door_w,
    fr_head = queues + 1L, till_head = queues + 2L,
    cubicle = queues + 2L + seq_along(p$fronts),
    till = queues + 2L + length(p$fronts) + seq_along(p$till_spot),
    stock = queues + 2L + length(p$fronts) + length(p$till_spot) + seq_along(p$stock_open),
    cashier_xy = xy(p$cashiers),
    fr_slots = xy(p$fr_line), till_slots = xy(p$till_line),
    helper_xy = xy(unlist(p$zone_cells)[zone_first[helpers]]) + 1,   # idle assistants wait by the biggest racks
    cubicle_in = xy(p$inside),                                         # where a shopper trying on stands, in the cubicle
    cubicle_boxes = t(vapply(p$blocks, function(b) {                   # each cubicle's block: x, y (bottom left), width, height
      q <- xy(b)
      c(min(q[, 1]), min(q[, 2]), diff(range(q[, 1])) + 1, diff(range(q[, 2])) + 1)
    }, numeric(4))),
    faces = p$faces,
    labels = zone_labels(chars, xy, keys, names)
  )
  fields <- grid_fields(p$open * 1, 1, anchors)
  plan$walk_m <- fields$length[anchors, , drop = FALSE] * CELL_M     # anchor to anchor, metres
  nA <- length(anchors)
  nearest <- function(to) to[max.col(-plan$walk_m[, to, drop = FALSE], ties.method = "first")]
  plan$exit <- nearest(plan$doors)
  plan$fetch <- nearest(plan$stock)
  plan$fetch_m <- plan$walk_m[cbind(seq_len(nA), plan$fetch)]
  from <- rep(seq_len(nA), times = nA); to <- rep(seq_len(nA), each = nA)
  r <- grid_routes(fields, anchors[from], to)
  plan$path_pair <- r$owner; plan$path_xy <- xy(r$cells)
  plan
}

# Where to write each category's name: the middle of each of its racks
# (a block of its tiles) of 6 tiles or more, or of its largest.
zone_labels <- function(chars, xy, keys, names) {
  out <- list()
  for (k in seq_along(keys)) {
    blocks <- cell_blocks(chars == keys[k])
    if (!length(blocks)) next
    size <- lengths(blocks)
    for (b in blocks[if (any(size >= 6)) size >= 6 else which.max(size)]) {
      p <- xy(b)
      out[[length(out) + 1]] <- list(text = names[k], category = k, x = mean(p[, 1]), y = mean(p[, 2]),
                                     vertical = diff(range(p[, 2])) > diff(range(p[, 1])))
    }
  }
  extra <- list(c("X", "Stockroom"), c("$", "Tills"))
  for (e in extra) {
    p <- xy(which(chars == e[1]))
    if (nrow(p)) out[[length(out) + 1]] <- list(text = e[2], x = mean(p[, 1]), y = mean(p[, 2]), vertical = FALSE)
  }
  p <- xy(which(chars == "F"))
  out[[length(out) + 1]] <- list(text = "Fitting rooms", x = mean(p[, 1]), y = min(p[, 2]) - 1.2, vertical = FALSE)
  out
}

# Every layout's plan, and one table of anchors across them all, so the
# simulation can look up any store's walk in one indexing step: layout f's
# anchors are numbered off[f] + 1, ..., off[f] + nA.
build_floors <- function() {
  plans <- lapply(PLANS, build_plan)
  nA <- vapply(plans, function(p) p$nA, 0L)
  off <- cumsum(c(0L, nA[-length(nA)]))
  NA_all <- sum(nA)
  walk_m <- matrix(Inf, NA_all, NA_all)
  pair <- numeric(); px <- numeric(); py <- numeric()
  for (f in seq_along(plans)) {
    p <- plans[[f]]; ids <- off[f] + seq_len(p$nA)
    walk_m[ids, ids] <- p$walk_m
    a <- (p$path_pair - 1L) %% p$nA + 1L; b <- (p$path_pair - 1L) %/% p$nA + 1L
    pair <- c(pair, (off[f] + b - 1) * NA_all + off[f] + a)
    px <- c(px, p$path_xy[, 1]); py <- c(py, p$path_xy[, 2])
  }
  o <- order(pair)                      # stable: each pair's cells stay in order
  pair <- pair[o]; px <- px[o]; py <- py[o]
  first <- match(seq_len(NA_all * NA_all), pair)
  last <- first + tabulate(pair, NA_all * NA_all) - 1L
  seg <- c(0, sqrt(diff(px)^2 + diff(py)^2) * CELL_M)
  starts <- first[!is.na(first)]
  seg[starts] <- 0
  along <- cumsum(seg); along <- along - along[first[pair]]
  zone_first <- t(vapply(seq_along(plans), function(f) off[f] + plans[[f]]$zone_first, numeric(N_CATS)))
  zone_n <- t(vapply(plans, function(p) as.numeric(p$zone_n), numeric(N_CATS)))
  n_cubicles <- vapply(plans, function(p) length(p$cubicle), 0L)
  n_tills <- vapply(plans, function(p) length(p$till), 0L)
  global <- function(field) unlist(lapply(seq_along(plans), function(f) off[f] + plans[[f]][[field]]), use.names = FALSE)
  list(
    plans = plans, off = off, nA = nA, NA_all = NA_all, walk_m = walk_m,
    zone_first = zone_first, zone_n = zone_n,
    entrance = off + vapply(plans, `[[`, 0L, "entrance"),
    n_doors = vapply(plans, function(p) length(p$doors), 0L),
    doors = lapply(seq_along(plans), function(f) off[f] + plans[[f]]$doors),
    door_w = lapply(plans, `[[`, "door_w"),
    exit_to = global("exit"),                     # each anchor's nearest door
    fetch_to = global("fetch"),                   # ... and nearest stockroom door
    fetch_m = unlist(lapply(plans, `[[`, "fetch_m"), use.names = FALSE),   # ... and the walk to it, metres
    fr_head = off + vapply(plans, `[[`, 0L, "fr_head"),
    till_head = off + vapply(plans, `[[`, 0L, "till_head"),
    cubicle_first = off + vapply(plans, function(p) p$cubicle[1], 0L),
    till_first = off + vapply(plans, function(p) p$till[1], 0L),
    n_cubicles = n_cubicles, n_tills = n_tills,
    max_servers = max(4L, n_cubicles, n_tills, FIELDS$staff$assistants$max),
    anchor_xy = do.call(rbind, lapply(plans, `[[`, "anchor_xy")),
    path_x = px, path_y = py, path_pair = pair, path_along = along,
    path_key = pair * 1e4 + along, path_first = first, path_last = last
  )
}

# The door each shopper arriving at a store of layout f comes in by: one of
# its doors, in proportion to its width.
door_in <- function(f) {
  out <- fl$entrance[f]
  for (k in unique(f[fl$n_doors[f] > 1L])) {
    i <- which(f == k)
    out[i] <- fl$doors[[k]][sample.int(fl$n_doors[k], length(i), replace = TRUE, prob = fl$door_w[[k]])]
  }
  out
}

# How long an assistant takes to fetch a size for a shopper at anchor a:
# finding it, and the walk to the nearest stockroom door and back.
fetch_time <- function(a) FETCH_HANDLE_S + 2 * fl$fetch_m[a] / STAFF_MPS

# Where walkers are, `m` metres along the path from anchor a to anchor b
# (global anchor numbers).
path_xy <- function(a, b, m) {
  pair <- (b - 1) * fl$NA_all + a
  i <- pmax(findInterval(pair * 1e4 + m, fl$path_key), fl$path_first[pair])
  j <- pmin(i + 1L, fl$path_last[pair])
  f <- pmin(1, pmax(0, (m - fl$path_along[i]) / pmax(fl$path_along[j] - fl$path_along[i], 1e-9)))
  cbind(fl$path_x[i] + (fl$path_x[j] - fl$path_x[i]) * f, fl$path_y[i] + (fl$path_y[j] - fl$path_y[i]) * f)
}

# A plan for the page: its grid of codes and what's written on it.
plan_geometry <- function(f) {
  p <- fl$plans[[f]]
  list(format = FORMATS[f], name = LAYOUT_NAMES[f], width = p$W, height = p$H, cell_m = CELL_M,
       codes = as.integer(t(p$codes)), key = FLOOR_KEY, labels = p$labels,
       cubicles = p$anchor_xy[p$cubicle, , drop = FALSE], cubicle_boxes = p$cubicle_boxes, tills = p$cashier_xy,
       doors = p$anchor_xy[p$doors, , drop = FALSE], fr_head = p$anchor_xy[p$fr_head, ], till_head = p$anchor_xy[p$till_head, ],
       helpers = p$helper_xy)
}

# ---- For the layout editor -------------------------------------------------------------------

# What the editor shows beside a picture, read by the categories of the
# world being edited (keys and names): its problems; what shoppers and
# staff use on it, as far as it can be read (see layout_uses); and, when it
# has no problems, a summary from the model: floor area, doors, cubicles,
# tills, queue places, rack tiles, faces and places to stand per category,
# the longest walk from a door, and a fetch from the stockroom.
layout_report <- function(rows, keys = FIXTURES, names = CATEGORIES) {
  s <- layout_scan(rows, keys, names)
  out <- list(problems = s$problems, uses = if (!is.null(s$parts)) layout_uses(s$parts, keys), summary = NULL)
  if (length(s$problems) || is.null(s$parts)) return(out)
  p <- s$parts
  plan <- build_plan(rows, keys, names)
  racks <- seq_len(sum(plan$zone_n))
  shoppers <- setdiff(seq_len(plan$nA), plan$stock)
  fetch_m <- mean(plan$fetch_m[racks])
  out$summary <- list(
    width_m = p$W * CELL_M, height_m = p$H * CELL_M, floor_m2 = sum(p$open | p$chars == "F") * CELL_M^2,
    doors = length(p$entrances), cubicles = length(p$blocks), tills = length(p$cashiers),
    fr_places = length(p$fr_line), till_places = length(p$till_line),
    racks = p$tiles, faces = p$faces, places = lengths(p$zone_cells),
    categories = names, space = sum(p$faces) / STANDARD_RACK_FACES,
    longest_walk_m = max(apply(plan$walk_m[plan$doors, shoppers, drop = FALSE], 2, min)),
    fetch_m = fetch_m, fetch_s = FETCH_HANDLE_S + 2 * fetch_m / STAFF_MPS)
  out
}

# What shoppers and staff use on a picture, as tiles (0-based row and
# column, like a problem's): the entrances; each category's places to
# stand (row, column, category); the cubicles in the order staff open them
# (the tile a shopper tries on in) and the floor at each one's opening; the
# tills in order (cashier's place) and where each one's customer stands;
# each queue's places in order from its head; the stockroom doors'
# openings; and rack tiles with no floor beside them (not faces: they hold
# nothing a shopper reaches).
layout_uses <- function(p, keys = FIXTURES) {
  pos <- function(i) { i <- i[!is.na(i)]; if (length(i)) cbind((i - 1L) %% p$H, (i - 1L) %/% p$H) else NULL }
  k <- rep(seq_along(p$zone_cells), lengths(p$zone_cells))
  spots <- pos(unlist(p$zone_cells))
  list(entrances = pos(p$entrances),
       spots = if (length(k)) cbind(spots, k) else NULL,
       cubicles = pos(p$inside), openings = pos(p$fronts),
       tills = pos(p$cashiers), till_spots = pos(p$till_spot),
       fr_line = pos(p$fr_line), till_line = pos(p$till_line),
       stock = pos(p$stock_open),
       hidden = pos(which(p$chars %in% keys & !near4(p$chars == "."))))
}
