# Two views of one model (see two-views.ui). The terrain never changes, so
# after the first frame only the walkers and the heat map cross to the page.

setup <- function() {
  world <<- createWorld(-20, 20, -20, 20, data = runif(41 * 41))
  visits <<- createWorld(-20, 20, -20, 20, data = 0)
  turtles <<- createTurtles(
    n = population,
    coords = randomXYcor(world, n = population),
    color = "white"
  )
}

go <- function() {
  turtles <<- right(turtles, angle = runif(NLcount(turtles), -wiggle, wiggle))
  turtles <<- fd(turtles, dist = 1, world = world, torus = TRUE)
  here <- patchHere(world = visits, turtles = turtles)
  visits <<- NLset(world = visits, agents = here, val = of(world = visits, agents = here) + 1)
}
