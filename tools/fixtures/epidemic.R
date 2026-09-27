# An epidemic among walkers (see epidemic.ui): susceptible walkers on the
# same patch as an infected one may catch it; the infected recover after a
# while. The model keeps its own history, which the plots, reports and the
# exported file all read.

state_colours <- c("#8fa3b8", "#e03131", "#2f9e44")  # susceptible, infected, recovered

# The model's own history (R also has a history() function, which <<- would
# otherwise try to change), and the end-of-run summary.
history <- NULL
summary_table <- NULL

setup <- function() {
  world <<- createWorld(-20, 20, -20, 20, data = 0)
  turtles <<- createTurtles(n = population, coords = randomXYcor(world, n = population), color = state_colours[1])
  turtles <<- turtlesOwn(turtles = turtles, tVar = "state", tVal = 0)
  turtles <<- NLset(turtles = turtles, agents = turtle(turtles, who = seq_len(initial_infected) - 1),
                    var = "state", val = 1)
  recolour()
  history <<- record(0)
  summary_table <<- NULL
}

go <- function() {
  turtles <<- right(turtles, angle = runif(NLcount(turtles), -40, 40))
  turtles <<- fd(turtles, dist = 1, world = world, torus = TRUE)

  state <- of(agents = turtles, var = "state")
  here <- patchHere(world = world, turtles = turtles)
  patch <- here[, 1] * 1000 + here[, 2]
  catches <- state == 0 & patch %in% patch[state == 1] & runif(length(state)) < infection_chance / 100
  recovers <- state == 1 & runif(length(state)) < 1 / illness_ticks
  state[catches] <- 1
  state[recovers] <- 2
  turtles <<- NLset(turtles = turtles, agents = turtles, var = "state", val = state)
  recolour()

  history <<- rbind(history, record(ticks))
  if (!any(state == 1)) finish()
}

record <- function(tick) {
  state <- of(agents = turtles, var = "state")
  data.frame(tick = tick, susceptible = sum(state == 0), infected = sum(state == 1), recovered = sum(state == 2))
}

recolour <- function() {
  turtles <<- NLset(turtles = turtles, agents = turtles, var = "color",
                    val = state_colours[of(agents = turtles, var = "state") + 1])
}

# The end of the run: a summary for the report, and the whole history as a
# file to save.
finish <- function() {
  peak <- which.max(history$infected)
  summary_table <<- data.frame(
    measure = c("ticks", "peak infected", "peak at tick", "ever infected", "never infected"),
    value = c(ticks, history$infected[peak], history$tick[peak],
              population - tail(history$susceptible, 1), tail(history$susceptible, 1))
  )
  write.csv(history, "epidemic.csv", row.names = FALSE)
  workbench_download("epidemic.csv")
  update_display("summary")
  stop_run()
}
