# The generics and class NetLogoR imports from quickPlot, with the same
# signatures as quickPlot 1.0.4. NetLogoR supplies all the methods it needs.

setClass(".quickPlotGrob", slots = list(
  plotName = "character", objName = "character", envir = "environment",
  layerName = "character", objClass = "character",
  isSpatialObjects = "logical", plotArgs = "list"
))

setGeneric(".identifyGrobToPlot", function(toPlot, sGrob, takeFromPlotObj) {
  standardGeneric(".identifyGrobToPlot")
})

setGeneric("layerNames", function(object) standardGeneric("layerNames"))
setGeneric("extent", function(x, ...) standardGeneric("extent"))
setGeneric("coordinates", function(obj, ...) standardGeneric("coordinates"))

numLayers <- function(x) UseMethod("numLayers")
numLayers.default <- function(x) 1L

Plot <- function(...) {
  stop("quickPlot::Plot() is not available in the NetLogoR Workbench; ",
       "the world is drawn on the canvas automatically.", call. = FALSE)
}
