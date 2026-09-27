#!/usr/bin/env Rscript
# Build the pre-bundled webR filesystem image that contains NetLogoR.
#
# Downloads NetLogoR and its runtime dependency closure as WebAssembly
# binaries from the webR package repository, swaps in the local shim
# packages from tools/shims/ (see below), drops files that are never used at
# runtime (help pages, vignettes, tests), and packs the resulting library
# into a single gzipped Emscripten filesystem image:
#
#   vfs/netlogor-lib.data.gz       concatenated file contents, gzipped
#   vfs/netlogor-lib.js.metadata   JSON index: [{filename, start, end}, ...]
#
# The engine worker mounts this image at startup, so the browser never runs
# install.packages() or contacts the package repository.
#
#   Rscript tools/build-vfs.R
#
# R_VERSION must match the webR release pinned in js/config.js
# (webR 0.6.x ships R 4.6).
#
# Shims: NetLogoR imports terra and quickPlot, but the webR build of terra
# fails to load (unresolved wasm symbol), and quickPlot drags in ggplot2 and
# ~15 more packages. NetLogoR's matrix worlds only touch a sliver of either,
# so tools/shims/ holds pure-R stand-ins with just that API. They are
# installed from source with the local R, which works because they contain
# no compiled code.

R_VERSION <- "4.6"
REPO <- sprintf("https://repo.r-wasm.org/bin/emscripten/contrib/%s", R_VERSION)
# SpaDES.tools is only Suggested by NetLogoR, but neighbors(), diffuse() and
# torus wrapping refuse to run without it, so it is bundled (as a shim too).
# jsonlite lets a model read the JSON and GeoJSON files people import (base R
# has no JSON parser); it has no dependencies of its own.
ROOT_PACKAGES <- c("NetLogoR", "SpaDES.tools", "jsonlite")
SHIMMED_PACKAGES <- c("terra", "quickPlot", "SpaDES.tools")
IMAGE_NAME <- "netlogor-lib"

# Shipped inside webR itself; never bundled.
BASE_PACKAGES <- c(
  "base", "compiler", "datasets", "graphics", "grDevices", "grid", "methods",
  "parallel", "splines", "stats", "stats4", "tcltk", "tools", "utils"
)

# Package subdirectories and files only needed for documentation or checks.
STRIP_DIRS <- c("help", "html", "doc", "tests", "demo", "po", "examples")
STRIP_FILES <- c("NEWS", "NEWS.md", "NEWS.Rd", "README.md", "ChangeLog")

script_path <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
project_root <- normalizePath(file.path(dirname(script_path), ".."))
shim_dir <- file.path(project_root, "tools", "shims")
cache_dir <- file.path(project_root, "tools", ".cache", paste0("wasm-", R_VERSION))
out_dir <- file.path(project_root, "vfs")
dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE)
dir.create(out_dir, showWarnings = FALSE)

# ---- 1. Resolve the dependency closure --------------------------------

db <- available.packages(contriburl = REPO, filters = "duplicates")
# A shim has no dependencies of its own to follow.
db[intersect(SHIMMED_PACKAGES, rownames(db)), c("Depends", "Imports")] <- NA

deps <- tools::package_dependencies(
  ROOT_PACKAGES, db = db, which = c("Depends", "Imports"), recursive = TRUE
)
packages <- sort(setdiff(unique(c(ROOT_PACKAGES, unlist(deps))), BASE_PACKAGES))
missing <- setdiff(packages, c(rownames(db), SHIMMED_PACKAGES))
if (length(missing)) stop("Not available for webR: ", paste(missing, collapse = ", "))
message(sprintf("Bundling %d packages: %s", length(packages), paste(packages, collapse = ", ")))

# ---- 2. Unpack binaries / install shims into a staging library --------

staging <- file.path(tempdir(), IMAGE_NAME)
unlink(staging, recursive = TRUE)
dir.create(staging)

versions <- character()
for (pkg in packages) {
  if (pkg %in% SHIMMED_PACKAGES) {
    install.packages(file.path(shim_dir, pkg), lib = staging, repos = NULL, type = "source", quiet = TRUE,
                     INSTALL_opts = c("--no-docs", "--no-html", "--no-byte-compile", "--no-staged-install"))
    versions[pkg] <- paste(read.dcf(file.path(staging, pkg, "DESCRIPTION"), "Version"), "(shim)")
  } else {
    version <- db[pkg, "Version"]
    tgz <- file.path(cache_dir, sprintf("%s_%s.tgz", pkg, version))
    if (!file.exists(tgz)) {
      download.file(sprintf("%s/%s_%s.tgz", REPO, pkg, version), tgz, mode = "wb", quiet = TRUE)
    }
    untar(tgz, exdir = staging)
    unlink(file.path(staging, ".vfs-index.json"))  # per-archive mount index; we write our own
    versions[pkg] <- version
  }
  if (!file.exists(file.path(staging, pkg, "DESCRIPTION"))) stop("Failed to stage ", pkg)

  pkg_dir <- file.path(staging, pkg)
  unlink(file.path(pkg_dir, STRIP_DIRS), recursive = TRUE)
  unlink(file.path(pkg_dir, STRIP_FILES))
}

# ---- 3. Pack into one gzipped Emscripten filesystem image -------------

files <- sort(list.files(staging, recursive = TRUE, all.files = TRUE, no.. = TRUE))
sizes <- file.size(file.path(staging, files))
ends <- cumsum(sizes)
index <- data.frame(filename = paste0("/", files), start = ends - sizes, end = ends)

data_path <- file.path(out_dir, paste0(IMAGE_NAME, ".data.gz"))
con <- gzfile(data_path, "wb", compression = 9)
for (f in files) writeBin(readBin(file.path(staging, f), "raw", file.size(file.path(staging, f))), con)
close(con)

metadata <- list(
  files = index,
  gzip = TRUE,
  remote_package_size = sum(sizes),
  packages = as.list(versions),
  webr_r_version = R_VERSION
)
jsonlite::write_json(metadata, file.path(out_dir, paste0(IMAGE_NAME, ".js.metadata")),
                     auto_unbox = TRUE, dataframe = "rows", digits = NA)

mb <- function(x) sprintf("%.1f MB", x / 1024^2)
message(sprintf("Wrote %s (%d files, %s unpacked, %s gzipped)",
                file.path("vfs", basename(data_path)), length(files), mb(sum(sizes)), mb(file.size(data_path))))
