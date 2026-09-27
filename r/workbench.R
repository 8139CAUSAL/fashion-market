# The R side of the NetLogoR Workbench engine.
#
# Model code runs in the global environment and follows one contract:
#
#   setup <- function() { world <<- createWorld(...); turtles <<- createTurtles(...) }
#   go    <- function() { turtles <<- fd(turtles, 1, world, torus = TRUE) }
#
# The engine draws `world` and `turtles` each frame (or whichever objects
# the interface's `view` lines name) and maintains `ticks` itself.
# Everything the engine needs lives in the .wb environment so it cannot
# collide with names the model uses.

.wb <- new.env(parent = emptyenv())
.wb$ticks <- 0L
.wb$stop_requested <- FALSE
.wb$bound <- character()
.wb$monitors <- list()
.wb$monitor_errors <- character()
# Problems already reported in the output log (see .wb_warn_once).
.wb$warned <- character()
# Plots and reports, and what model code has asked of them (see Displays).
.wb$displays <- list()
.wb$display_requests <- character()
.wb$downloads <- list()

# The world views, in the interface's order: which R objects each draws.
# Without a `view` line there is one, drawing `world` and `turtles`.
.wb$views <- list(list(name = "view", world = "world", turtles = "turtles", layer = NULL,
                       colors = NULL, palette = NULL, shape = NULL))
.wb$views_version <- 0L
# Per view: what the main thread has already been sent (see Frames).
.wb$view_state <- list()

# Where data files shipped with the Workbench (templates/data/) are placed.
.WB_DATA_DIR <- "/data"

# Preloaded so the first neighbors()/diffuse()/torus call doesn't interrupt a
# run with R's "Loading required namespace" message.
suppressMessages(requireNamespace("SpaDES.tools", quietly = TRUE))

# ---- JSON ---------------------------------------------------------------

# Results cross into JavaScript as JSON strings: one predictable shape,
# rather than webR's nested representation of R objects.
.wb_json_string <- function(x) {
  x <- enc2utf8(as.character(x))
  x <- gsub("\\", "\\\\", x, fixed = TRUE)
  x <- gsub("\"", "\\\"", x, fixed = TRUE)
  x <- gsub("\n", "\\n", x, fixed = TRUE)
  x <- gsub("\r", "\\r", x, fixed = TRUE)
  x <- gsub("\t", "\\t", x, fixed = TRUE)
  paste0("\"", x, "\"")
}

.wb_json <- function(x) {
  if (is.null(x)) return("null")
  if (is.list(x)) {
    parts <- vapply(x, .wb_json, character(1))
    if (!is.null(names(x))) {
      return(paste0("{", paste0(.wb_json_string(names(x)), ":", parts, collapse = ","), "}"))
    }
    return(paste0("[", paste0(parts, collapse = ","), "]"))
  }
  if (length(x) != 1L) return(paste0("[", paste0(vapply(x, .wb_json, character(1)), collapse = ","), "]"))
  if (is.na(x)) return("null")
  if (is.logical(x)) return(if (x) "true" else "false")
  if (is.numeric(x)) {
    if (!is.finite(x)) return("null")
    return(format(x, digits = 15, scientific = FALSE, trim = TRUE))
  }
  .wb_json_string(x)
}

# ---- Model lifecycle ----------------------------------------------------

.wb_get <- function(name) get0(name, envir = globalenv(), inherits = FALSE)

.wb_require_functions <- function() {
  for (fn in c("setup", "go")) {
    if (!is.function(get0(fn, envir = globalenv(), mode = "function", inherits = FALSE))) {
      stop(sprintf("The model must define a %s() function.", fn), call. = FALSE)
    }
  }
}

# Checks what setup() left behind for the views to draw, so a mistake is
# reported in the model's terms rather than as a failure deep inside a
# NetLogoR call later. `world` is required whenever a view shows it (as the
# default view does). Other world objects may appear later, e.g. from a
# button, so until then their views are simply empty.
.wb_check_state <- function() {
  for (view in .wb$views) {
    world <- .wb_get(view$world)
    if (is.null(world)) {
      if (identical(view$world, "world")) {
        stop("setup() must assign a world, e.g. world <<- createWorld(-20, 20, -20, 20). ",
             "Remember the <<- arrow.", call. = FALSE)
      }
      next
    }
    .wb_check_world(view, world)
    turtles <- if (is.null(view$turtles)) NULL else .wb_get(view$turtles)
    if (!is.null(turtles) && !inherits(turtles, "agentMatrix")) {
      stop(sprintf("`%s` must come from createTurtles(); got %s.", view$turtles, class(turtles)[1]), call. = FALSE)
    }
    # A view that takes its colours from an R object needs it once its world
    # exists.
    colours <- view$colors$object
    if (!is.null(colours)) {
      value <- .wb_get(colours)
      if (is.null(value)) {
        stop(sprintf("View %s takes its colours from `%s`, which doesn't exist. Assign it, e.g. %s <<- c(\"black\", \"white\").",
                     view$name, colours, colours), call. = FALSE)
      }
      if (!is.atomic(value) || !length(value)) {
        stop(sprintf("`%s` must be a vector of colours for view %s; got %s.", colours, view$name, class(value)[1]), call. = FALSE)
      }
    }
  }
  invisible(TRUE)
}

.wb_check_world <- function(view, world) {
  if (!inherits(world, c("worldMatrix", "worldArray"))) {
    stop(sprintf("`%s` must come from createWorld(); got %s.", view$world, class(world)[1]), call. = FALSE)
  }
  if (!is.null(view$layer)) .wb_layer_index(view, world)
  invisible(TRUE)
}

.wb_turtle_count <- function() {
  turtles <- .wb_get("turtles")
  if (is.null(turtles)) 0L else as.integer(NLcount(turtles))
}

.wb_memory_mb <- function() round(sum(gc()[, "(Mb)"]), 1)

# Runs model code, explaining one R trap in the model's terms: `x <<- value`
# assigns to the first `x` it finds, and when the model has no `x` of its
# own yet, that can be R's (history, table, summary, ...), which is locked.
.wb_model_code <- function(expr) {
  withCallingHandlers(expr, error = function(e) {
    pattern <- "cannot change value of locked binding for '([^']+)'"
    name <- regmatches(conditionMessage(e), regexec(pattern, conditionMessage(e)))[[1]][2]
    if (!is.na(name)) {
      stop(sprintf(paste0("`%s <<- ...` tried to change R's own `%s`. Give the model a `%s` of its own first: ",
                          "put `%s <- NULL` at the top of the model code, or use another name."), name, name, name, name),
           call. = FALSE)
    }
  })
}

# Runs a button's code in the model's own environment, so `<<-` reaches the
# same variables setup() and go() use.
.wb_action <- function(code) {
  .wb_model_code(eval(parse(text = code), envir = globalenv()))
  invisible(TRUE)
}

.wb_load_model <- function(path) {
  source(path, local = globalenv(), echo = FALSE, keep.source = TRUE)
  .wb_require_functions()
  list(ok = TRUE, functions = sort(names(which(vapply(
    mget(ls(globalenv()), envir = globalenv()), is.function, logical(1)
  )))))
}

.wb_setup <- function(seed = NULL) {
  .wb_require_functions()
  if (!is.null(seed) && !is.na(seed)) set.seed(as.integer(seed))
  .wb$ticks <- 0L
  .wb$ready <- FALSE
  assign("ticks", 0L, envir = globalenv())
  elapsed <- system.time(.wb_model_code(setup()))[["elapsed"]]
  .wb_check_state()
  .wb$ready <- TRUE
  list(ticks = 0L, elapsedMs = 1000 * elapsed, turtles = .wb_turtle_count(),
       world = .wb_world_info(), memoryMb = .wb_memory_mb())
}

# Runs n ticks back to back. `ticks` is refreshed before each call so model
# code can read it the way NetLogo models do. Stops early if go() called
# stop_run().
.wb_go <- function(n = 1L) {
  .wb_require_functions()
  started <- proc.time()[["elapsed"]]
  .wb$stop_requested <- FALSE
  for (i in seq_len(n)) {
    .wb$ticks <- .wb$ticks + 1L
    assign("ticks", .wb$ticks, envir = globalenv())
    .wb_model_code(go())
    if (.wb$stop_requested) break
  }
  list(ticks = .wb$ticks, elapsedMs = 1000 * (proc.time()[["elapsed"]] - started),
       turtles = .wb_turtle_count(), stopped = .wb$stop_requested)
}

# The run loop's tick: TRUE when the model asked to stop.
.wb_run_tick <- function(n = 1L) isTRUE(.wb_go(n)$stopped)

# ---- Model-facing helpers -----------------------------------------------

# Ends a forever run from inside go(), like NetLogo's `stop`.
#
#   go <- function() {
#     if (NLcount(humans) == 0) return(stop_run())
#     ...
#   }
stop_run <- function() {
  .wb$stop_requested <- TRUE
  invisible(NULL)
}

# Path to a data file shipped with the Workbench in templates/data/.
# The engine fetches every file a model mentions this way before the model
# is loaded, so it can be read like any local file:
#
#   city <- readRDS(workbench_data("gottingen.rds"))
workbench_data <- function(name) {
  path <- file.path(.WB_DATA_DIR, name)
  if (!file.exists(path)) {
    stop(sprintf("Data file \"%s\" isn't available. Files must live in templates/data/ ", name),
         "and be named in the model as workbench_data(\"", name, "\").", call. = FALSE)
  }
  path
}

# The first view's world, for the console summary after setup().
.wb_world_info <- function() {
  world <- .wb_get(.wb$views[[1]]$world)
  if (!inherits(world, c("worldMatrix", "worldArray"))) return(NULL)
  list(
    minPxcor = minPxcor(world), maxPxcor = maxPxcor(world),
    minPycor = minPycor(world), maxPycor = maxPycor(world),
    width = worldWidth(world), height = worldHeight(world),
    layers = if (inherits(world, "worldArray")) dim(world)[3] else 1L
  )
}

# ---- Widget variables ---------------------------------------------------

# Widgets are plain variables in the session: a slider named `population`
# is the variable `population`. The interface pushes its values here before
# setup() runs and whenever a control moves.
.wb_set_vars <- function(values) {
  for (name in names(values)) assign(name, values[[name]], envir = globalenv())
  .wb$bound <- union(.wb$bound, names(values))
  invisible(length(values))
}

# Reads those variables back, so the interface can follow a model that
# changes one itself.
.wb_get_vars <- function(names = NULL) {
  if (is.null(names)) names <- .wb$bound
  values <- list()
  for (name in names) {
    value <- .wb_get(name)
    # Only scalars belong in a widget; anything else is the model's business.
    if (!is.null(value) && length(value) == 1L && is.atomic(value)) values[[name]] <- value
  }
  values
}

# ---- Monitors -----------------------------------------------------------

# Monitor reporters are parsed once, when the interface is built, so a
# running model only pays for evaluating them.
.wb_set_monitors <- function(specs) {
  .wb$monitors <- lapply(specs, function(spec) {
    list(
      expr = tryCatch(parse(text = spec$reporter), error = function(e) NULL),
      digits = spec$digits,  # NULL means "whatever suits the value"
      reporter = spec$reporter
    )
  })
  .wb$monitor_errors <- character()
  invisible(length(.wb$monitors))
}

.wb_format_monitor <- function(value, digits) {
  if (is.null(value) || length(value) == 0L) return("—")
  more <- length(value) > 1L
  value <- value[[1L]]
  text <- if (is.numeric(value)) {
    if (!is.finite(value)) {
      as.character(value)
    } else if (is.null(digits)) {
      # No `digits` in the spec: counts read as counts, everything else
      # gets two decimals.
      if (value == round(value)) format(round(value), scientific = FALSE) else formatC(value, format = "f", digits = 2)
    } else {
      formatC(value, format = "f", digits = digits)
    }
  } else if (is.logical(value)) {
    if (isTRUE(value)) "true" else if (isFALSE(value)) "false" else "NA"
  } else {
    as.character(value)
  }
  if (more) paste0(text, "…") else text
}

# Evaluates every monitor. A reporter that fails shows "error" and explains
# itself once in the output log, rather than every tick.
.wb_read_monitors <- function() {
  # Until setup() has finished there is nothing to report, and evaluating
  # reporters would only complain that the model's objects don't exist.
  if (!isTRUE(.wb$ready) || !length(.wb$monitors)) {
    return(stats::setNames(as.list(rep("—", length(.wb$monitors))), names(.wb$monitors)))
  }

  values <- list()
  for (name in names(.wb$monitors)) {
    monitor <- .wb$monitors[[name]]
    values[[name]] <- if (is.null(monitor$expr)) {
      "error"
    } else {
      tryCatch(
        .wb_format_monitor(eval(monitor$expr, envir = globalenv()), monitor$digits),
        error = function(e) {
          key <- paste(name, conditionMessage(e))
          if (!key %in% .wb$monitor_errors) {
            .wb$monitor_errors <- c(.wb$monitor_errors, key)
            cat(sprintf("monitor %s: %s\n", name, conditionMessage(e)), file = stderr())
          }
          "error"
        }
      )
    }
  }
  values
}

# ---- Displays: plots and reports ----------------------------------------

# The interface's `plot` and `report` widgets. Each runs its R code in an
# environment of its own whose parent is the model's (so it sees the model,
# and `<-` stays local) and shows the result: what a plot draws, or what a
# report prints, exactly as the R console would print it. When they redraw is
# the engine worker's business (their `update`); R only evaluates.
#
#   specs: list(list(name = "...", kind = "plot" | "report", code = "...", update = "..."), ...)
.wb_set_displays <- function(specs) {
  names(specs) <- vapply(specs, function(spec) spec$name, "")
  .wb$displays <- lapply(specs, function(spec) {
    expr <- tryCatch(parse(text = spec$code, keep.source = FALSE), error = function(e) e)
    list(kind = spec$kind, update = spec$update, expr = if (inherits(expr, "error")) NULL else expr,
         problem = if (inherits(expr, "error")) paste("The code doesn't parse:", conditionMessage(expr)) else NULL)
  })
  .wb$display_requests <- character()
  invisible(length(.wb$displays))
}

# Evaluates a display's code. Errors come back as text for the widget to
# show; warnings go to the output log once each, not on every redraw.
.wb_display_eval <- function(name, run) {
  display <- .wb$displays[[name]]
  if (is.null(display)) return(list(error = sprintf("There's no plot or report called \"%s\".", name)))
  if (!is.null(display$problem)) return(list(error = display$problem))
  tryCatch(
    withCallingHandlers(
      run(display$expr, new.env(parent = globalenv())),
      warning = function(w) {
        .wb_warn_once(sprintf("%s %s: %s", display$kind, name, conditionMessage(w)))
        invokeRestart("muffleWarning")
      }
    ),
    error = function(e) {
      # The engine's own eval() is no help to the model's author.
      call <- conditionCall(e)
      where <- if (is.null(call) || identical(call[[1]], quote(eval))) "" else
        sprintf(" in %s", paste(deparse(call, nlines = 1L), collapse = ""))
      list(error = sprintf("Error%s: %s", where, conditionMessage(e)))
    }
  )
}

# Draws a plot onto whatever device is current: in the browser, the canvas
# device webR's captureR() opens at the widget's size. Plots start from a
# compact look suited to small widgets; the code can change anything with
# par(). Returns "" when drawn, else the error to show.
.wb_draw_plot <- function(name) {
  result <- .wb_display_eval(name, function(expr, env) {
    graphics::par(mar = c(3, 3, 1.5, 1), mgp = c(1.8, 0.6, 0), cex = 0.9)
    eval(expr, env)
    list()
  })
  if (is.null(result$error)) "" else result$error
}

# A report's text: whatever its code prints, and its value if visible, as
# the console would show them, wrapped to `columns` characters.
.wb_report_text <- function(name, columns = 80L) {
  old <- options(width = max(20L, min(500L, as.integer(columns))))
  on.exit(options(old))
  .wb_display_eval(name, function(expr, env) {
    lines <- utils::capture.output({
      value <- withVisible(eval(expr, env))
      if (value$visible) print(value$value)
    })
    list(text = paste(lines, collapse = "\n"))
  })
}

# Redraws plots and reports on request: from a button, or from the model
# (an end-of-run summary, say). With no names, every one of them.
#
#   update_display("summary")
update_display <- function(...) {
  names <- c(...)
  if (!length(names)) names <- names(.wb$displays)
  unknown <- setdiff(names, names(.wb$displays))
  if (length(unknown)) {
    stop(sprintf("There's no plot or report called %s.", paste0("\"", unknown, "\"", collapse = ", ")), call. = FALSE)
  }
  .wb$display_requests <- union(.wb$display_requests, names)
  invisible(names)
}

# ---- Downloads ------------------------------------------------------------

# Hands a file R wrote to the browser to download, from any code: a button,
# go() at the end of a run, an import.
#
#   write.csv(results, "results.csv", row.names = FALSE)
#   workbench_download("results.csv")
workbench_download <- function(path, name = basename(path)) {
  if (!is.character(path) || length(path) != 1L || !file.exists(path) || dir.exists(path)) {
    stop(sprintf("workbench_download(): there's no file \"%s\". Write it first, e.g. write.csv(x, \"%s\").",
                 as.character(path)[1], as.character(path)[1]), call. = FALSE)
  }
  .wb$downloads <- c(.wb$downloads, list(list(path = normalizePath(path), name = as.character(name))))
  invisible(path)
}

# What model code asked for since the last call: plots and reports to
# redraw, and files to download. The engine worker collects these after
# running model code.
.wb_take_pending <- function() {
  pending <- list(displays = as.list(.wb$display_requests), downloads = .wb$downloads)
  .wb$display_requests <- character()
  .wb$downloads <- list()
  pending
}

# ---- Views --------------------------------------------------------------

# The interface's `view` lines, in order, each a list naming what it draws
# and how:
#
#   name     the view's name, unique
#   world    the world object to draw
#   turtles  the agentset to draw, or NULL for patches only
#   layer    NULL, or the layer (name or number) of a stacked world
#   colors   NULL, list(values = c(...)) or list(object = "name"): a colour
#            per patch value
#   palette  NULL, or a continuous palette's name (applied on the page)
#   shape    NULL, or "arrow", "dot" or "square"
#
# `version` comes back in every frame, so the page can ignore frames packed
# for an older set of views.
.wb_set_views <- function(views, version) {
  .wb$views <- views
  .wb$views_version <- as.integer(version)
  .wb_reset_frames()
  invisible(isTRUE(.wb$ready))
}

# Which layer of a multi-layer world a view shows: the one named, else
# "pcolor" if the world has one, else the first.
.wb_layer_index <- function(view, world) {
  layers <- dimnames(world)[[3]]
  layer <- view$layer
  if (is.null(layer)) return(if (!is.null(layers) && "pcolor" %in% layers) "pcolor" else 1L)
  if (!inherits(world, "worldArray")) {
    stop(sprintf("`%s` has only one layer, so view %s can't show layer %s.", view$world, view$name, layer), call. = FALSE)
  }
  if (is.numeric(layer)) {
    if (layer > dim(world)[3]) {
      stop(sprintf("`%s` has %d layers, so view %s can't show layer %d.", view$world, dim(world)[3], view$name, as.integer(layer)), call. = FALSE)
    }
    return(as.integer(layer))
  }
  if (!layer %in% layers) {
    stop(sprintf("`%s` has no layer \"%s\" (its layers: %s).", view$world, layer, paste(layers, collapse = ", ")), call. = FALSE)
  }
  layer
}

# How a view colours its patches: a colour per patch value (value 0 takes
# the first), or NULL for a continuous palette, which the page applies.
#
#   colors on the view line   those colours, or the R object named
#   palette on the view line  a palette, whatever the model sets
#   neither                   for views of `world`, the model's
#                             `patch_colors` if it sets one (the model
#                             contract: patch_colors describes `world`);
#                             a palette for every other world
.wb_view_colours <- function(view) {
  if (!is.null(view$palette)) return(NULL)
  colours <- if (!is.null(view$colors$values)) {
    view$colors$values
  } else if (!is.null(view$colors$object)) {
    .wb_get(view$colors$object)
  } else if (identical(view$world, "world")) {
    .wb_get("patch_colors")
  }
  if (is.null(colours) || !length(colours)) NULL else as.character(unlist(colours))
}

# How a view draws turtles: its own `shape`, else the model's
# `turtle_shape`, else arrows.
.WB_SHAPES <- c(arrow = 0L, dot = 1L, square = 2L)

.wb_view_shape <- function(view) {
  shape <- view$shape %||% .wb_get("turtle_shape")
  if (is.null(shape)) return(.WB_SHAPES[["arrow"]])
  shape <- as.character(shape)[1]
  if (!shape %in% names(.WB_SHAPES)) {
    .wb_warn_once(sprintf("turtle_shape \"%s\" isn't a shape: use \"arrow\", \"dot\" or \"square\". Drawing arrows.", shape))
    return(.WB_SHAPES[["arrow"]])
  }
  .WB_SHAPES[[shape]]
}

# Each turtle's own shape, when the agentset has a `shape` variable (as
# NetLogo turtles do): a shape code per turtle, or NULL without one. An empty
# or missing shape draws in the view's shape; a name that isn't a shape does
# too, and says so once.
.wb_turtle_shapes <- function(turtles, default) {
  data <- turtles@.Data
  if (!"shape" %in% colnames(data)) return(NULL)
  levels <- turtles@levels$shape
  names <- if (is.null(levels)) as.character(data[, "shape"]) else levels[data[, "shape"]]
  codes <- unname(.WB_SHAPES[names])
  unknown <- is.na(codes) & !is.na(names) & nzchar(names)
  if (any(unknown)) {
    .wb_warn_once(sprintf("Turtle shape \"%s\" isn't a shape: use \"arrow\", \"dot\" or \"square\". Drawing the view's shape.",
                          names[unknown][1]))
  }
  codes[is.na(codes)] <- default
  codes
}

# A problem worth telling the model's author about, but not worth stopping
# the run for: printed to the output log once, not every frame.
.wb_warn_once <- function(message) {
  if (message %in% .wb$warned) return(invisible(FALSE))
  .wb$warned <- c(.wb$warned, message)
  cat(message, "\n", sep = "", file = stderr())
  invisible(TRUE)
}

# RGB bytes for a set of R colours. A colour R doesn't know is drawn magenta,
# and named in the output log.
.wb_rgb_raw <- function(colours, owner) {
  rgb <- vapply(colours, function(colour) {
    tryCatch(as.integer(grDevices::col2rgb(colour)), error = function(e) {
      .wb_warn_once(sprintf("%s: \"%s\" isn't a colour R knows, so it's drawn magenta.", owner, colour))
      c(255L, 0L, 255L)
    })
  }, integer(3), USE.NAMES = FALSE)
  as.raw(rgb)
}

# ---- Frames -------------------------------------------------------------

# Rendering state crosses to JavaScript as one raw blob of little-endian
# values, so the main thread can read it straight into typed arrays.
#
#   frame header  3 x int32: ticks, nViews, viewsVersion
#   then one section per view, in the interface's order:
#
#   header  10 x int32:  sectionBytes, nTurtles, width, height,
#                        turtleColoursVersion, nTurtleColours, flags,
#                        turtleShape, nPatchColours, patchColoursVersion
#            4 x float32: patch minimum, patch maximum, minPxcor, minPycor
#   body    float32[width * height]  patch values, row-major from the top
#           float32[5 * nTurtles]    x, y, heading, size, colour index
#           float32[nTurtles]        each turtle's shape, if flag bit 5 is set
#           uint8[3 * nTurtleColours]  RGB per turtle colour index
#           uint8[3 * nPatchColours]   RGB per patch category
#           zero bytes up to a multiple of 4, so the next section's numbers
#           stay aligned
#
# flags  bit 0: patch values present      bit 1: turtle colours present
#        bit 2: patch colours present     bit 3: patches are categories
#        bit 4: the view's world doesn't exist (yet); width and height are 0
#        bit 5: turtles have shapes of their own (a `shape` variable);
#               turtleShape is then only for those whose shape is empty
#
# Anything that hasn't changed since a view's last frame stays behind:
# patches only travel when that world changes (a static city map is sent
# once), and the colour tables only when they change. So a second view costs
# only what changes in it. Everything a view is sent is its own, colours and
# shape included (see .wb_view_colours and .wb_view_shape).

.wb_patch_matrix <- function(world, view) {
  if (!inherits(world, "worldArray")) return(world@.Data)
  world@.Data[, , .wb_layer_index(view, world)]
}

# What one view has been sent so far.
.wb_view_state <- function(name) {
  state <- .wb$view_state[[name]]
  if (is.null(state)) {
    state <- new.env(parent = emptyenv())
    state$sent_patches <- NULL
    state$colour_levels <- NULL
    state$colour_version <- 0L
    state$colour_sent <- -1L
    state$patch_colours <- NULL
    state$patch_colour_version <- 0L
    state$patch_colour_sent <- -1L
    .wb$view_state[[name]] <- state
  }
  state
}

# Turtle colours are integer codes into the agentMatrix's level table, so the
# RGB table only has to be rebuilt when that table changes.
.wb_colour_table <- function(turtles, state) {
  levels <- turtles@levels$color
  if (is.null(levels)) {
    # A numeric colour column: values index R's palette.
    levels <- as.character(sort(unique(turtles@.Data[, "color"])))
  }
  if (!identical(levels, state$colour_levels)) {
    state$colour_levels <- levels
    state$colour_version <- state$colour_version + 1L
    state$colour_rgb <- .wb_rgb_raw(levels, "turtle colours")
  }
  invisible(NULL)
}

.wb_colour_index <- function(turtles, state) {
  codes <- turtles@.Data[, "color"]
  if (is.null(turtles@levels$color)) match(as.character(codes), state$colour_levels) else codes
}

# The view's patch colour table, rebuilt only when its colours change.
# Returns whether the view colours patches by category.
.wb_patch_colour_table <- function(view, state) {
  colours <- .wb_view_colours(view)
  if (is.null(colours)) {
    state$patch_colours <- NULL
    return(FALSE)
  }
  if (!identical(colours, state$patch_colours)) {
    state$patch_colours <- colours
    state$patch_colour_version <- state$patch_colour_version + 1L
    state$patch_colour_rgb <- .wb_rgb_raw(colours, sprintf("view %s", view$name))
  }
  TRUE
}

# Forgets what the main thread has already been sent, so the next frame is
# complete (after setup, when the views change, or when the renderers start
# over).
.wb_reset_frames <- function() {
  .wb$view_state <- list()
}

.wb_frame_raw <- function(force = FALSE) {
  if (isTRUE(force)) .wb_reset_frames()
  sections <- lapply(.wb$views, .wb_view_section)
  c(writeBin(as.integer(c(.wb$ticks, length(sections), .wb$views_version)), raw(), size = 4L),
    unlist(sections, use.names = FALSE))
}

# One view's section of the frame (layout above).
.wb_view_section <- function(view) {
  world <- .wb_get(view$world)

  # Nothing to draw yet, e.g. a world a button will make later. The page
  # keeps nothing for this view either, so when the world appears it's sent
  # in full.
  if (is.null(world)) {
    .wb$view_state[[view$name]] <- NULL
    return(c(writeBin(c(56L, 0L, 0L, 0L, 0L, 0L, 16L, 0L, 0L, 0L), raw(), size = 4L),
             writeBin(c(0, 1, 0, 0), raw(), size = 4L)))
  }
  .wb_check_world(view, world)

  state <- .wb_view_state(view$name)
  turtles <- if (is.null(view$turtles)) NULL else .wb_get(view$turtles)

  values <- .wb_patch_matrix(world, view)
  width <- ncol(values)
  height <- nrow(values)
  sendPatches <- !identical(values, state$sent_patches)
  finite <- values[is.finite(values)]
  range <- if (length(finite)) c(min(finite), max(finite)) else c(0, 1)

  shape <- .wb_view_shape(view)
  nTurtles <- 0L
  shapes <- NULL
  if (!is.null(turtles) && NLcount(turtles) > 0L) {
    nTurtles <- as.integer(NLcount(turtles))
    .wb_colour_table(turtles, state)
    shapes <- .wb_turtle_shapes(turtles, shape)
  }
  nColours <- if (nTurtles > 0L) length(state$colour_levels) else 0L
  sendColours <- nTurtles > 0L && !identical(state$colour_version, state$colour_sent)

  categorical <- .wb_patch_colour_table(view, state)
  nCategories <- if (categorical) length(state$patch_colours) else 0L
  sendPatchColours <- categorical && !identical(state$patch_colour_version, state$patch_colour_sent)

  flags <- (if (sendPatches) 1L else 0L) + (if (sendColours) 2L else 0L) +
    (if (sendPatchColours) 4L else 0L) + (if (categorical) 8L else 0L) + (if (!is.null(shapes)) 32L else 0L)
  bytes <- 56L + (if (sendPatches) 4L * width * height else 0L) + 4L * nTurtles * (if (is.null(shapes)) 5L else 6L) +
    (if (sendColours) 3L * nColours else 0L) + (if (sendPatchColours) 3L * nCategories else 0L)
  padding <- (4L - bytes %% 4L) %% 4L

  con <- rawConnection(raw(0), "wb")
  on.exit(close(con))
  writeBin(as.integer(c(bytes + padding, nTurtles, width, height, state$colour_version, nColours, flags,
                        shape, nCategories, state$patch_colour_version)), con, size = 4L)
  writeBin(as.numeric(c(range, minPxcor(world), minPycor(world))), con, size = 4L)

  if (sendPatches) {
    # t() so patches run row-major from the top-left, matching the matrix
    # layout createWorld() fills by row.
    writeBin(as.numeric(t(values)), con, size = 4L)
    state$sent_patches <- values
  }
  if (nTurtles > 0L) {
    data <- turtles@.Data
    size <- if ("size" %in% colnames(data)) data[, "size"] else rep_len(1, nTurtles)
    writeBin(as.numeric(c(data[, "xcor"], data[, "ycor"], data[, "heading"],
                          size, .wb_colour_index(turtles, state) - 1L, shapes)), con, size = 4L)
  }
  if (sendColours) {
    writeBin(state$colour_rgb, con)
    state$colour_sent <- state$colour_version
  }
  if (sendPatchColours) {
    writeBin(state$patch_colour_rgb, con)
    state$patch_colour_sent <- state$patch_colour_version
  }
  if (padding) writeBin(raw(padding), con)

  rawConnectionValue(con)
}

# ---- Imports ------------------------------------------------------------

# Files from the interface's `import` widgets. Each import keeps one file in
# a folder of its own; a new file replaces the old.
.WB_IMPORT_DIR <- "/home/web_user/uploads"

.wb_import_dir <- function(name) {
  dir <- file.path(.WB_IMPORT_DIR, name)
  unlink(dir, recursive = TRUE)
  dir.create(dir, recursive = TRUE, showWarnings = FALSE)
  dir
}

# Runs an import's code with its name standing for the imported file's path.
# The code runs in an environment of its own whose parent is the model's, so
# `<<-` reaches the model's variables while the name itself (and anything
# assigned with `<-`) stays local. The import interprets nothing: what the
# file means is up to the code.
.wb_import <- function(name, path, code) {
  env <- new.env(parent = globalenv())
  assign(name, path, envir = env)
  .wb_model_code(eval(parse(text = code, keep.source = FALSE), envir = env))
  invisible(TRUE)
}

# ---- Benchmark ----------------------------------------------------------

# Used by the headless timing check: setup, then n ticks, reporting the cost
# per tick and R's memory use so a leak shows up as a rising number.
.wb_bench <- function(n = 100L, seed = 42L) {
  before <- .wb_memory_mb()
  .wb_setup(seed)
  run <- .wb_go(n)
  list(
    ticks = run$ticks,
    elapsedMs = run$elapsedMs,
    msPerTick = run$elapsedMs / max(1L, n),
    turtles = run$turtles,
    memoryBeforeMb = before,
    memoryAfterMb = .wb_memory_mb()
  )
}
