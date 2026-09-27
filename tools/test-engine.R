#!/usr/bin/env Rscript
# Checks the R side of the engine (r/workbench.R): the frame packer (one
# section per view, each sending only what changed), imports, plots and
# reports, update_display() and workbench_download().
#
#   Rscript tools/test-engine.R
#
# Needs NetLogoR installed against the shims in tools/.cache/rlib (see
# tools/check-templates.R).

script_path <- normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1]))
root <- normalizePath(file.path(dirname(script_path), ".."))
.libPaths(c(file.path(root, "tools", ".cache", "rlib"), .libPaths()))
suppressPackageStartupMessages(library(NetLogoR))
source(file.path(root, "r", "workbench.R"), local = globalenv())

failures <- 0L
check <- function(label, ok) {
  cat(sprintf("%s %s\n", if (isTRUE(ok)) "ok  " else "FAIL", label))
  if (!isTRUE(ok)) failures <<- failures + 1L
}

# Reads a packed frame back into a list, following the documented layout.
read_frame <- function(bytes) {
  ints <- function(at, n) readBin(bytes[at + seq_len(4L * n)], "integer", n = n, size = 4L)
  head <- ints(0L, 3L)
  offset <- 12L
  views <- list()
  for (i in seq_len(head[2])) {
    h <- ints(offset, 10L)
    v <- list(bytes = h[1], turtles = h[2], width = h[3], height = h[4],
              colours = h[6], flags = h[7], shape = h[8], categories = h[9])
    # Each turtle's own shape, when sent, is the sixth turtle column.
    columns <- if (bitwAnd(v$flags, 32L)) 6L else 5L
    if (columns == 6L) {
      at <- offset + 56L + (if (bitwAnd(v$flags, 1L)) 4L * v$width * v$height else 0L) + 20L * v$turtles
      v$shapes <- readBin(bytes[at + seq_len(4L * v$turtles)], "numeric", n = v$turtles, size = 4L)
    }
    # The category colours come last, after patches, turtles and turtle
    # colours (whichever were sent).
    if (bitwAnd(v$flags, 4L)) {
      at <- offset + 56L + (if (bitwAnd(v$flags, 1L)) 4L * v$width * v$height else 0L) + 4L * columns * v$turtles +
        (if (bitwAnd(v$flags, 2L)) 3L * v$colours else 0L)
      v$rgb <- matrix(as.integer(bytes[at + seq_len(3L * v$categories)]), nrow = 3)
    }
    views[[i]] <- v
    offset <- offset + h[1]
  }
  list(ticks = head[1], count = head[2], version = head[3], views = views, length = offset, total = length(bytes))
}

view <- function(name, world = "world", turtles = "turtles", layer = NULL, colors = NULL, palette = NULL, shape = NULL) {
  list(name = name, world = world, turtles = turtles, layer = layer, colors = colors, palette = palette, shape = shape)
}

# What R prints to the output log while running expr.
log_of <- function(expr) paste(capture.output(expr, type = "message"), collapse = "\n")

set.seed(1)
world <- createWorld(0, 9, 0, 4, data = runif(50))
heat <- createWorld(0, 2, 0, 2, data = 1:9)
turtles <- createTurtles(n = 3, coords = randomXYcor(world, n = 3), color = c("red", "blue", "red"))
landscape <- stackWorlds(createWorld(0, 3, 0, 3, data = 1:16), createWorld(0, 3, 0, 3, data = 16:1))
dimnames(landscape@.Data)[[3]] <- c("elevation", "water")
.wb$ready <- TRUE

# ---- One view: the default, as before ------------------------------------

f <- read_frame(.wb_frame_raw(TRUE))
check("default: one section, drawing world and turtles", f$count == 1L &&
        f$views[[1]]$width == 10L && f$views[[1]]$height == 5L && f$views[[1]]$turtles == 3L)
check("default: sections add up to the whole frame", f$length == f$total)
check("default: first frame has patches and colours", bitwAnd(f$views[[1]]$flags, 3L) == 3L)
f <- read_frame(.wb_frame_raw())
check("default: unchanged patches and colours stay behind", f$views[[1]]$flags == 0L &&
        f$total == 12L + 56L + 20L * 3L)

# ---- Several views --------------------------------------------------------

.wb_set_views(list(
  view("main"),
  view("heat", world = "heat", turtles = NULL),
  view("land", world = "landscape", turtles = NULL, layer = "water"),
  view("later", world = "not_made_yet")
), 7L)
f <- read_frame(.wb_frame_raw())
check("views: four sections, and the version they were packed for", f$count == 4L && f$version == 7L)
check("views: a complete frame after the views change", all(vapply(f$views[1:3], function(v) bitwAnd(v$flags, 1L) == 1L, logical(1))))
check("views: turtles none draws patches only", f$views[[2]]$turtles == 0L && f$views[[2]]$width == 3L)
check("views: a layer of a stacked world", f$views[[3]]$width == 4L)
check("views: a world that doesn't exist yet is an empty section", f$views[[4]]$flags == 16L &&
        f$views[[4]]$width == 0L && f$views[[4]]$bytes == 56L)
check("views: every section keeps 4-byte alignment", all(vapply(f$views, function(v) v$bytes %% 4L == 0L, logical(1))))
check("views: sections add up to the whole frame", f$length == f$total)

heat <- NLset(world = heat, agents = cbind(pxcor = 0, pycor = 0), val = 100)
f <- read_frame(.wb_frame_raw())
check("views: only the changed world's patches travel", f$views[[2]]$flags == 1L &&
        f$views[[1]]$flags == 0L && f$views[[3]]$flags == 0L)
check("views: the frame grows only by what changed", f$total == 12L + (56L + 20L * 3L) + (56L + 4L * 9L) + 56L + 56L)

not_made_yet <- createWorld(0, 1, 0, 1, data = 0)
f <- read_frame(.wb_frame_raw())
check("views: a world made later shows up", f$views[[4]]$width == 2L && bitwAnd(f$views[[4]]$flags, 1L) == 1L)

rm(not_made_yet)
invisible(.wb_frame_raw())
not_made_yet <- createWorld(0, 1, 0, 1, data = 0)
f <- read_frame(.wb_frame_raw())
check("views: a world that vanishes and comes back unchanged is sent in full", bitwAnd(f$views[[4]]$flags, 1L) == 1L)

# ---- Each view's colours and shape are its own ---------------------------

patch_colors <- c("black", "white", "red")
heat_colours <- c("navy", "orange")
.wb_set_views(list(
  view("a"),
  view("b", world = "heat", turtles = NULL),
  view("c", world = "heat", turtles = NULL, colors = list(values = c("black", "gold"))),
  view("d", world = "heat", turtles = NULL, colors = list(object = "heat_colours")),
  view("e", palette = "heat"),
  view("f", shape = "square")
), 8L)
f <- read_frame(.wb_frame_raw())
check("colours: patch_colors colours views of `world`, padded to 4 bytes",
      f$views[[1]]$categories == 3L && f$views[[1]]$bytes %% 4L == 0L && f$length == f$total)
check("colours: patch_colors doesn't reach other worlds", f$views[[2]]$categories == 0L &&
        bitwAnd(f$views[[2]]$flags, 8L) == 0L)
check("colours: a view's own list", f$views[[3]]$categories == 2L &&
        identical(f$views[[3]]$rgb[, 2], as.integer(grDevices::col2rgb("gold"))))
check("colours: a view's own R object", f$views[[4]]$categories == 2L &&
        identical(f$views[[4]]$rgb[, 1], as.integer(grDevices::col2rgb("navy"))))
check("colours: palette on the line wins over patch_colors", f$views[[5]]$categories == 0L)

f <- read_frame(.wb_frame_raw())
check("colours: unchanged tables stay behind", all(vapply(f$views, function(v) bitwAnd(v$flags, 4L) == 0L, logical(1))) &&
        f$views[[1]]$categories == 3L)
heat_colours <- c("navy", "orange", "white")
f <- read_frame(.wb_frame_raw())
check("colours: a changed object sends only that view's table", bitwAnd(f$views[[4]]$flags, 4L) == 4L &&
        f$views[[4]]$categories == 3L && bitwAnd(f$views[[1]]$flags, 4L) == 0L && bitwAnd(f$views[[3]]$flags, 4L) == 0L)

turtle_shape <- "dot"
f <- read_frame(.wb_frame_raw())
check("shape: turtle_shape is the default, a view's own shape wins",
      f$views[[1]]$shape == 1L && f$views[[6]]$shape == 2L)
turtle_shape <- "star"
logged <- log_of(f <- read_frame(.wb_frame_raw()))
again <- log_of(invisible(.wb_frame_raw()))
check("shape: an unknown turtle_shape draws arrows and says so once",
      f$views[[1]]$shape == 0L && grepl('turtle_shape "star"', logged) && again == "")
rm(turtle_shape)

f <- read_frame(.wb_frame_raw())
check("shape: turtles without a shape variable send no shape column", bitwAnd(f$views[[1]]$flags, 32L) == 0L)
turtles <- turtlesOwn(turtles = turtles, tVar = "shape", tVal = c("square", "", "dot"))
f <- read_frame(.wb_frame_raw())
check("shape: a turtle's own shape wins; an empty one draws in the view's shape",
      bitwAnd(f$views[[1]]$flags, 32L) == 32L && identical(f$views[[1]]$shapes, c(2, 0, 1)) &&
        identical(f$views[[6]]$shapes, c(2, 2, 1)) && f$length == f$total)
turtles <- NLset(turtles = turtles, agents = turtle(turtles, who = 1), var = "shape", val = "star")
logged <- log_of(f <- read_frame(.wb_frame_raw()))
check("shape: an unknown turtle shape draws in the view's shape and says so once",
      identical(f$views[[1]]$shapes, c(2, 0, 1)) && grepl('Turtle shape "star"', logged) &&
        log_of(invisible(.wb_frame_raw())) == "")
turtles <- createTurtles(n = 3, coords = randomXYcor(world, n = 3), color = c("red", "blue", "red"))

patch_colors <- c("black", "no such colour", "red")
logged <- log_of(f <- read_frame(.wb_frame_raw()))
check("colours: an unknown colour is magenta, its neighbours unharmed, and named in the log",
      identical(f$views[[1]]$rgb[, 2], c(255L, 0L, 255L)) && identical(f$views[[1]]$rgb[, 3], c(255L, 0L, 0L)) &&
        grepl('view a: "no such colour" isn\'t a colour', logged))
rm(patch_colors, heat_colours)

# ---- Checks after setup ---------------------------------------------------

err <- function(expr) tryCatch({ expr; "" }, error = conditionMessage)
.wb_set_views(list(view("a", world = "heat"), view("b", world = "landscape", layer = "sand")), 9L)
check("setup check: an unknown layer is named", grepl('no layer "sand" \\(its layers: elevation, water\\)', err(.wb_check_state())))
.wb_set_views(list(view("a", world = "heat", layer = 2)), 10L)
check("setup check: a one-layer world has no layer 2", grepl("has only one layer", err(.wb_check_state())))
.wb_set_views(list(view("a", world = "maybe_later")), 11L)
check("setup check: other world objects may come later", err(.wb_check_state()) == "")
rm(world)
.wb_set_views(list(view("a")), 12L)
check("setup check: `world` is still required when a view shows it", grepl("setup\\(\\) must assign a world", err(.wb_check_state())))
not_a_world <- 1:3
.wb_set_views(list(view("a", world = "not_a_world")), 13L)
check("setup check: a view's world must be a world", grepl("`not_a_world` must come from createWorld", err(.wb_check_state())))
.wb_set_views(list(view("a", world = "heat", colors = list(object = "no_colours"))), 14L)
check("setup check: a view's colour object must exist", grepl("takes its colours from `no_colours`, which doesn't exist", err(.wb_check_state())))
no_colours <- list(a = 1)
check("setup check: and be a vector of colours", grepl("`no_colours` must be a vector of colours", err(.wb_check_state())))

# ---- Imports ------------------------------------------------------------

.WB_IMPORT_DIR <- file.path(tempdir(), "uploads")
dir <- .wb_import_dir("revenue")
path <- file.path(dir, "revenue.csv")
writeLines(c("group,revenue", "treatment,10", "treatment,14", "control,9"), path)
.wb_import("revenue", path, "rev <- read.csv(revenue); treatment <<- rev$revenue[rev$group == 'treatment']")
check("import: the code reads the file through its name", identical(treatment, c(10L, 14L)))
check("import: the name and local variables stay out of the model", !exists("revenue", envir = globalenv(), inherits = FALSE) &&
        !exists("rev", envir = globalenv(), inherits = FALSE))
dir <- .wb_import_dir("revenue")
check("import: a new file replaces the old one", !file.exists(path) && dir.exists(dir))
check("import: the code sees the model's functions", {
  double_it <- function(x) 2 * x
  assign("double_it", double_it, envir = globalenv())
  .wb_import("n", "unused", "doubled <<- double_it(21)")
  identical(get("doubled", envir = globalenv()), 42)
})
check("import: an error in the code reaches the caller", grepl("boom", err(.wb_import("x", "p", "stop('boom')"))))

# ---- Model code: R's own names ---------------------------------------------

rm(list = intersect(c("history", "f"), ls(globalenv())), envir = globalenv())
check("<<- onto one of R's own names says what to do", grepl(
  "`history <<- ...` tried to change R's own `history`. Give the model a `history` of its own first: put `history <- NULL`",
  err(.wb_action("f <- function() history <<- 1; f()")), fixed = TRUE))
check("with a variable of its own, <<- works", {
  assign("history", NULL, envir = globalenv())
  .wb_action("f <- function() history <<- 1; f()")
  identical(get("history", envir = globalenv()), 1)
})

# ---- Plots and reports ----------------------------------------------------

history <- data.frame(t = 1:3, infected = c(1, 4, 9))
.wb_set_displays(list(
  epidemic = list(name = "epidemic", kind = "plot", code = "plot(history$t, history$infected, type = 'l')", update = "ticks"),
  broken = list(name = "broken", kind = "plot", code = "plot(no_such_thing)", update = "ticks"),
  bad_axis = list(name = "bad_axis", kind = "plot", code = "plot(1:3, xlim = 'wide')", update = "ticks"),
  table = list(name = "table", kind = "report", code = "cat('Infected so far\n'); history", update = "monitor"),
  noisy = list(name = "noisy", kind = "report", code = "warning('careful'); 42", update = "monitor"),
  quiet = list(name = "quiet", kind = "report", code = "invisible(1); local_only <- 5", update = "manual"),
  bad = list(name = "bad", kind = "report", code = "1 +", update = "manual")
))
grDevices::pdf(NULL)
check("plot: draws, returning no error", .wb_draw_plot("epidemic") == "")
check("plot: a failing plot says why", .wb_draw_plot("broken") == "Error: object 'no_such_thing' not found")
check("plot: and where, when it was a function it called", grepl("^Error in plot.window\\(.*invalid 'xlim' value", .wb_draw_plot("bad_axis")))
invisible(grDevices::dev.off())
r <- .wb_report_text("table")
check("report: what the code prints, then its value, as the console shows them",
      is.null(r$error) && grepl("^Infected so far\n  t infected\n1 1        1", r$text))
logged <- log_of(r <- .wb_report_text("noisy"))
again <- log_of(invisible(.wb_report_text("noisy")))
check("report: a warning goes to the log once, and the value still shows", r$text == "[1] 42" &&
        grepl("report noisy: careful", logged) && again == "")
check("report: an invisible value shows nothing; locals stay local", .wb_report_text("quiet")$text == "" &&
        !exists("local_only", envir = globalenv(), inherits = FALSE))
check("report: code that doesn't parse says so", grepl("doesn't parse", .wb_report_text("bad")$error))
check("report: wraps to the widget's width", {
  wide <- list(name = "wide", kind = "report", code = "1:40", update = "monitor")
  .wb_set_displays(list(wide = wide))
  narrow <- strsplit(.wb_report_text("wide", columns = 30)$text, "\n")[[1]]
  all(nchar(narrow) <= 30) && length(narrow) > 1
})

# ---- update_display() and workbench_download() ----------------------------

.wb_set_displays(list(list(name = "a", kind = "report", code = "1", update = "manual"),
                      list(name = "b", kind = "plot", code = "plot(1)", update = "manual")))
update_display("a")
update_display("a", "b")
p <- .wb_take_pending()
check("update_display: asks for named displays, once each", identical(unlist(p$displays), c("a", "b")))
check("update_display: requests are taken once", length(.wb_take_pending()$displays) == 0L)
update_display()
check("update_display: with no names, every display", identical(unlist(.wb_take_pending()$displays), c("a", "b")))
check("update_display: an unknown name is an error", grepl('no plot or report called "z"', err(update_display("z"))))

out_file <- file.path(tempdir(), "results.csv")
write.csv(history, out_file, row.names = FALSE)
workbench_download(out_file)
workbench_download(out_file, name = "run-1.csv")
p <- .wb_take_pending()
check("download: files are queued with their names", length(p$downloads) == 2L &&
        p$downloads[[1]]$name == "results.csv" && p$downloads[[2]]$name == "run-1.csv" &&
        file.exists(p$downloads[[1]]$path))
check("download: a missing file is an error", grepl('there\'s no file "nope.csv"', err(workbench_download("nope.csv"))))
check("download: the queue empties once taken", length(.wb_take_pending()$downloads) == 0L)

cat(sprintf("\n%s\n", if (failures) sprintf("%d check(s) failed.", failures) else "All engine checks passed."))
quit(status = if (failures) 1L else 0L)
