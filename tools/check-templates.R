#!/usr/bin/env Rscript
# Runs every preset in templates/index.json, and every test model in
# tools/fixtures/ (a name.ui with its name.R), headlessly in local R:
# imports, setup(), N ticks, a packed frame, every monitor, plot and report,
# and any files the model asked to download — the same
# calls the browser makes, minus the browser. The interface is read by the
# Workbench's own parser (tools/spec-json.mjs, so this needs Node). Each
# runs in its own R process, so one model can't leak variables into the next.
#
#   Rscript tools/check-templates.R            # all presets, 200 ticks
#   Rscript tools/check-templates.R zombies 500
#
# Needs NetLogoR installed against the shims in tools/.cache/rlib:
#   for p in terra quickPlot SpaDES.tools; do R CMD INSTALL -l tools/.cache/rlib tools/shims/$p; done
#   R CMD INSTALL -l tools/.cache/rlib NetLogoR_1.0.6.tar.gz   # CRAN source

args <- commandArgs(trailingOnly = TRUE)
script_path <- normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1]))
root <- normalizePath(file.path(dirname(script_path), ".."))
index <- jsonlite::fromJSON(file.path(root, "templates", "index.json"))$templates
index$dir <- "templates"
fixtures <- sub("\\.ui$", "", list.files(file.path(root, "tools", "fixtures"), pattern = "\\.ui$"))
fixtures <- fixtures[file.exists(file.path(root, "tools", "fixtures", paste0(fixtures, ".R")))]
if (length(fixtures)) {
  index <- rbind(index[c("id", "spec", "model", "dir")], data.frame(
    id = fixtures, spec = paste0(fixtures, ".ui"), model = paste0(fixtures, ".R"), dir = file.path("tools", "fixtures")
  ))
}
n_ticks <- if (length(args) >= 2 && args[1] != "--one") as.integer(args[2]) else 200L

# ---- Driver: one child process per template -----------------------------

if (!length(args) || args[1] != "--one") {
  ids <- if (length(args)) args[1] else index$id
  failed <- 0L
  for (id in ids) {
    status <- system2("Rscript", c(shQuote(script_path), "--one", id, n_ticks))
    if (status != 0) failed <- failed + 1L
  }
  cat(sprintf("\n%d of %d templates passed.\n", length(ids) - failed, length(ids)))
  quit(status = if (failed) 1L else 0L)
}

# ---- Child: run one template ----------------------------------------------

id <- args[2]
n_ticks <- as.integer(args[3])  # not `ticks`: the model owns that name
template <- index[index$id == id, ]
if (!nrow(template)) stop("No template with id ", id)

.libPaths(c(file.path(root, "tools", ".cache", "rlib"), .libPaths()))
suppressPackageStartupMessages(library(NetLogoR))
source(file.path(root, "r", "workbench.R"), local = globalenv())
.WB_DATA_DIR <- file.path(root, "templates", "data")
.WB_IMPORT_DIR <- file.path(tempdir(), "uploads")
# Models write files (for workbench_download()) where they stand: here, a
# scratch folder rather than the project.
setwd(tempdir())

# What the interface asks of R, from the Workbench's own parser: widget
# values, monitors, views and imports.
spec_file <- file.path(root, template$dir, template$spec)
spec <- jsonlite::fromJSON(system2("node", c(shQuote(file.path(root, "tools", "spec-json.mjs")), shQuote(spec_file)),
                                   stdout = TRUE), simplifyVector = FALSE)
fail <- function(message) {
  cat(sprintf("FAIL  %-14s %s\n", id, message))
  quit(status = 1L)
}
if (length(spec$errors)) {
  fail(paste(vapply(spec$errors, function(e) sprintf("line %d: %s", e$line, e$message), ""), collapse = "; "))
}

# A test model's imports come from tools/fixtures/<id>.files/, one file per
# import, named after it (revenue.csv for `import revenue`).
import_file <- function(name) {
  files <- list.files(file.path(root, template$dir, paste0(id, ".files")), full.names = TRUE)
  files[tools::file_path_sans_ext(basename(files)) == name][1]
}

result <- tryCatch({
  # The page's order: model, widget values, views, imports, then setup().
  .wb_load_model(file.path(root, template$dir, template$model))
  .wb_set_vars(spec$values)
  .wb_set_views(spec$views, 1L)
  .wb_set_displays(spec$displays)
  imported <- character()
  for (imp in spec$imports) {
    source_file <- import_file(imp$name)
    if (is.na(source_file)) next
    dir <- .wb_import_dir(imp$name)
    file.copy(source_file, dir)
    .wb_import(imp$name, file.path(dir, basename(source_file)), imp$code)
    imported <- c(imported, basename(source_file))
  }
  setup_info <- .wb_setup(42L)
  frame <- .wb_frame_raw(TRUE)
  run <- .wb_go(n_ticks)
  frame2 <- .wb_frame_raw(FALSE)
  values <- vapply(spec$monitors, function(m) {
    .wb_format_monitor(eval(parse(text = m$reporter), envir = globalenv()), m$digits)
  }, character(1))
  names(values) <- vapply(spec$monitors, `[[`, "", "name")

  # Plots draw onto a device that discards the picture: what's checked is
  # that their code runs. Reports show their first line.
  shown <- character()
  for (d in spec$displays) {
    problem <- if (d$kind == "plot") {
      grDevices::pdf(NULL)
      drawn <- .wb_draw_plot(d$name)
      grDevices::dev.off()
      if (nzchar(drawn)) drawn else NULL
    } else {
      report <- .wb_report_text(d$name)
      if (is.null(report$error)) {
        shown <- c(shown, sprintf("%s: %s", d$name, strsplit(report$text, "\n")[[1]][1] %||% ""))
      }
      report$error
    }
    if (!is.null(problem)) stop(sprintf("%s %s: %s", d$kind, d$name, problem), call. = FALSE)
  }
  pending <- .wb_take_pending()
  downloads <- vapply(pending$downloads, function(d) {
    if (!file.exists(d$path)) stop("download ", d$name, " doesn't exist", call. = FALSE)
    d$name
  }, "")
  list(ok = TRUE, setup = setup_info, run = run, frame = length(frame), frame2 = length(frame2),
       monitors = values, imported = imported, displays = length(spec$displays), reports = shown, downloads = downloads)
}, error = function(e) list(ok = FALSE, message = conditionMessage(e)))

if (!result$ok) fail(result$message)
views <- length(spec$views)
cat(sprintf("ok    %-14s setup %5.0f ms · %d ticks in %6.0f ms (%.2f ms/tick) · %d turtles · %s%sfirst frame %s kB, next %s kB%s\n",
            id, result$setup$elapsedMs, result$run$ticks, result$run$elapsedMs,
            result$run$elapsedMs / max(1, result$run$ticks), result$run$turtles,
            if (views > 1L) sprintf("%d views · ", views) else "",
            if (length(result$imported)) sprintf("imported %s · ", paste(result$imported, collapse = ", ")) else "",
            format(round(result$frame / 1024, 1)), format(round(result$frame2 / 1024, 1)),
            if (isTRUE(result$run$stopped)) " · stopped itself" else ""))
cat(sprintf("      %s\n", paste(names(result$monitors), result$monitors, sep = " = ", collapse = " | ")))
if (result$displays) {
  cat(sprintf("      %d plots and reports drew%s%s\n", result$displays,
              if (length(result$reports)) paste0(" · ", paste(result$reports, collapse = " · ")) else "",
              if (length(result$downloads)) paste0(" · downloads ", paste(result$downloads, collapse = ", ")) else ""))
}
