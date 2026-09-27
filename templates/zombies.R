# Zombie outbreak on the real streets of central Göttingen.
#
# A port of "Constructing the End of Days" (Julia Agents.jl + LightOSM) from
# the NetLogoR notebook. People walk shortest routes along real streets at
# 2–7 km/h; a zombie infects anyone within the infection radius. When someone
# reaches their destination they may set off for another. One tick is one
# minute.
#
# The street network comes from OpenStreetMap, baked into a data file by
# tools/build-gottingen.R: junctions, each street's real geometry, and
# precomputed shortest paths to 120 destinations across the city, so routing
# is a lookup rather than a search. Patches are 5 m.
# Map data © OpenStreetMap contributors (ODbL).

setup <- function() {
  city <<- readRDS(workbench_data("gottingen.rds"))

  bounds <- city$world
  world <<- createWorld(
    minPxcor = bounds[["minPxcor"]], maxPxcor = bounds[["maxPxcor"]],
    minPycor = bounds[["minPycor"]], maxPycor = bounds[["maxPycor"]],
    data = as.vector(t(city$street_tiers))   # 0 none, 1 path, 2 street, 3 main road
  )
  patch_colors <<- c("#0b0f14", "#1d242d", "#2f3a48", "#55647a")
  turtle_shape <<- "dot"

  # Every street once in each direction, to find the geometry joining two
  # junctions on a route.
  street_keys <<- c(paste(city$street_from, city$street_to),
                    paste(city$street_to, city$street_from))

  n <- population + 1
  start <- c(sample(nrow(city$junctions), population, replace = TRUE),
             city$patient_zero[["start"]])

  turtles <<- createTurtles(
    n = n,
    coords = cbind(xcor = city$junctions[start, 1], ycor = city$junctions[start, 2]),
    breed = c(rep("human", population), "zombie"),
    color = c(rep(HUMAN, population), ZOMBIE)
  )
  metres_per_minute <- runif(n, 2, 7) * 1000 / 60
  turtles <<- turtlesOwn(turtles = turtles, tVar = "pace", tVal = metres_per_minute / city$patch_metres)
  turtles <<- turtlesOwn(turtles = turtles, tVar = "infected", tVal = c(rep(0, population), 1))
  turtles <<- turtlesOwn(turtles = turtles, tVar = "size", tVal = person_size)

  # Patient zero heads for the same corner of town as in the original; the
  # first destination in the data file is theirs.
  goals <- c(sample(length(city$destinations), population, replace = TRUE), 1L)
  routes <<- Map(plan_route, start, goals)

  half_turned_at <<- NA
}

go <- function() {
  xy <- of(agents = turtles, var = c("xcor", "ycor"))
  pace <- of(agents = turtles, var = "pace")

  plans <- routes
  for (i in seq_along(plans)) {
    moved <- walk(xy[i, ], plans[[i]]$points, pace[i])
    xy[i, ] <- moved$position
    plans[[i]]$points <- moved$remaining

    # Arrived: now and then, set off somewhere new.
    if (nrow(moved$remaining) == 1 && runif(1) < wander_chance) {
      plans[[i]] <- plan_route(plans[[i]]$end, sample(length(city$destinations), 1))
    }
  }
  routes <<- plans
  turtles <<- setXY(turtles = turtles, xcor = xy[, 1], ycor = xy[, 2], world = world, torus = FALSE)

  # Anyone within reach of a zombie turns.
  infected <- of(agents = turtles, var = "infected")
  zombies <- which(infected == 1)
  humans <- which(infected == 0)
  if (length(humans) && length(zombies)) {
    reach <- infection_radius / city$patch_metres
    dx <- outer(xy[humans, 1], xy[zombies, 1], "-")
    dy <- outer(xy[humans, 2], xy[zombies, 2], "-")
    caught <- humans[rowSums(dx^2 + dy^2 <= reach^2) > 0]
    if (length(caught)) {
      infected[caught] <- 1
      turtles <<- NLset(turtles = turtles, agents = turtles, var = "infected", val = infected)
      turtles <<- NLset(turtles = turtles, agents = turtles, var = "color",
                        val = ifelse(infected == 1, ZOMBIE, HUMAN))
    }
  }

  share <- mean(infected)
  if (is.na(half_turned_at) && share >= 0.5) {
    half_turned_at <<- ticks
    cat(sprintf("Minute %d: half of the city has turned.\n", ticks))
  }
  if (share == 1) {
    cat(sprintf("Minute %d: the fall of humanity is complete.\n", ticks))
    stop_run()
  }
}

HUMAN <- "#e9ecef"
ZOMBIE <- "#51cf66"

# A route to destination k: follow the precomputed shortest-path tree from
# junction to junction, then expand that into the streets' real geometry.
plan_route <- function(from, k) {
  target <- city$destinations[k]
  path <- from
  while (path[length(path)] != target) {
    path <- c(path, city$next_hop[path[length(path)], k])
  }

  points <- list(city$junctions[from, , drop = FALSE])
  if (length(path) > 1) {
    n_streets <- length(city$street_from)
    hits <- match(paste(path[-length(path)], path[-1]), street_keys)
    for (s in seq_along(hits)) {
      reversed <- hits[s] > n_streets
      geometry <- city$streets[[if (reversed) hits[s] - n_streets else hits[s]]]
      if (reversed) geometry <- geometry[nrow(geometry):1, , drop = FALSE]
      points[[s + 1]] <- geometry[-1, , drop = FALSE]
    }
  }
  list(points = do.call(rbind, points), end = target)
}

# Moves along a route's waypoints by up to `budget` patches. The first row of
# `points` is the waypoint just passed; the rest are still ahead.
walk <- function(position, points, budget) {
  while (budget > 0 && nrow(points) > 1) {
    step <- points[2, ] - position
    gap <- sqrt(sum(step^2))
    if (budget >= gap) {
      position <- points[2, ]
      budget <- budget - gap
      points <- points[-1, , drop = FALSE]
    } else {
      position <- position + step * (budget / gap)
      budget <- 0
    }
  }
  points[1, ] <- position
  list(position = position, remaining = points)
}
