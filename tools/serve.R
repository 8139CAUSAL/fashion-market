#!/usr/bin/env Rscript
# Local development server for the NetLogoR Workbench.
#
# Serves the project root with the COOP/COEP headers that make the page
# cross-origin isolated (needed for webR's SharedArrayBuffer channel). On
# GitHub Pages, which can't send headers, coi-serviceworker.js adds them.
#
#   Rscript tools/serve.R                 # http://localhost:8123
#   Rscript tools/serve.R --port=9000
#   Rscript tools/serve.R --no-coi        # omit headers to exercise coi-serviceworker.js
#
# Requires the httpuv package: install.packages("httpuv")

args <- commandArgs(trailingOnly = TRUE)
port <- as.integer(sub("^--port=", "", grep("^--port=", args, value = TRUE)[1]))
if (is.na(port)) port <- 8123L
send_coi <- !("--no-coi" %in% args)

file_arg <- grep("^--file=", commandArgs(), value = TRUE)
root <- normalizePath(file.path(dirname(sub("^--file=", "", file_arg)), ".."))

headers <- list("Cache-Control" = "no-cache")
if (send_coi) {
  headers[["Cross-Origin-Opener-Policy"]] <- "same-origin"
  headers[["Cross-Origin-Embedder-Policy"]] <- "require-corp"
}

server <- httpuv::startServer("127.0.0.1", port, list(
  staticPaths = list("/" = httpuv::staticPath(root, indexhtml = TRUE, headers = headers)),
  staticPathOptions = httpuv::staticPathOptions(headers = headers)
))

mode <- if (send_coi) "with COOP/COEP" else "without COOP/COEP (service-worker path)"
message(sprintf("Serving %s at http://localhost:%d/ %s", root, port, mode))

on.exit(httpuv::stopServer(server))
httpuv::service(Inf)
