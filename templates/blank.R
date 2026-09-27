# A blank model. setup() runs when you press setup, go() once per tick.
# Assign with <<- so a value lasts between ticks. The Guide tab explains how.

setup <- function() {
  world <<- createWorld(minPxcor = -16, maxPxcor = 16, minPycor = -16, maxPycor = 16, data = 0)
  patch_colors <<- "#161b22"
}

go <- function() {
}
