#!/usr/bin/env Rscript
# Checks tools/retail/mixed-logit.R on data simulated from known parameters:
# the analytic gradient matches finite differences, the estimates recover
# the truth, and a model without household differences mistakes them for
# brand loyalty (the confound the retail plan warns about).
#
#   Rscript tools/retail/test-mixed-logit.R

script_path <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
source(file.path(dirname(script_path), "mixed-logit.R"))

failures <- 0L
check <- function(label, ok) {
  cat(if (ok) "ok  " else "FAIL", label, "\n")
  if (!ok) failures <<- failures + 1L
}

set.seed(20260924)
H <- 400; T <- 12; J <- 3
truth <- c(asc1 = 0.5, asc2 = -0.3, price = -2, display = 0.8, sd.asc1 = 1.2, sd.asc2 = 0.8)
household <- rep(seq_len(H), each = T)
n <- H * T
beta <- cbind(asc1 = truth["asc1"] + truth["sd.asc1"] * rnorm(H),
              asc2 = truth["asc2"] + truth["sd.asc2"] * rnorm(H))
price <- matrix(runif(n * J, 1, 3), n, J)
display <- matrix(rbinom(n * J, 1, 0.15), n, J)
X <- array(0, c(n, J, 4), dimnames = list(NULL, NULL, c("asc1", "asc2", "price", "display")))
X[, 1, "asc1"] <- 1; X[, 2, "asc2"] <- 1
X[, , "price"] <- price; X[, , "display"] <- display
V <- X[, , "asc1"] * beta[household, 1] + X[, , "asc2"] * beta[household, 2] +
  truth["price"] * price + truth["display"] * display
P <- exp(V) / rowSums(exp(V))
chosen <- apply(P, 1, function(p) sample.int(J, 1, prob = p))
random <- c(TRUE, TRUE, FALSE, FALSE)

# Gradient: analytic vs central differences, at an arbitrary point.
theta <- c(0.2, -0.1, -1.5, 0.5, 0.7, 0.6)
ll_at <- function(th) mixed_logit(X, chosen, household, random, draws = 50, start = th, maxit = 0)$loglik
num <- vapply(seq_along(theta), function(i) {
  e <- replace(numeric(length(theta)), i, 1e-5)
  (ll_at(theta + e) - ll_at(theta - e)) / 2e-5
}, 0)
# maxit = 0 leaves the fit at its start, so its gradient is the one there.
analytic <- mixed_logit(X, chosen, household, random, draws = 50, start = theta, maxit = 0)$gradient
check(sprintf("gradient matches finite differences (max gap %.2g)", max(abs(num - analytic))),
      max(abs(num - analytic)) < 1e-3 * max(1, abs(num)))

# Recovery.
fit <- mixed_logit(X, chosen, household, random, draws = 200)
est <- fit$coef[names(truth)]
z <- (est - truth) / fit$se[match(names(truth), names(fit$coef))]
print(round(rbind(truth = truth, estimate = est, se = fit$se[match(names(truth), names(fit$coef))]), 3))
check("converged", fit$converged)
check("every estimate within 3 standard errors of the truth", all(abs(z) < 3))

# Taste differences mistaken for loyalty: add a lagged-choice variable (no
# true effect) and fit without household differences, then with them.
lagged <- matrix(0, n, J)
for (t in seq_len(n)) if (t > 1 && household[t] == household[t - 1]) lagged[t, chosen[t - 1]] <- 1
X2 <- array(c(X, lagged), c(n, J, 5), dimnames = list(NULL, NULL, c(dimnames(X)[[3]], "last_choice")))
keep <- rep(c(FALSE, rep(TRUE, T - 1)), H)
X2 <- X2[keep, , , drop = FALSE]
plain <- mixed_logit(X2, chosen[keep], household[keep], rep(FALSE, 5))
mixed <- mixed_logit(X2, chosen[keep], household[keep], c(TRUE, TRUE, FALSE, FALSE, FALSE), draws = 200)
cat(sprintf("last-choice effect (truly 0): plain logit %.2f (se %.2f), mixed logit %.2f (se %.2f)\n",
            plain$coef["last_choice"], plain$se[5], mixed$coef["last_choice"], mixed$se[5]))
check("a plain logit mistakes taste differences for loyalty", plain$coef["last_choice"] / plain$se[5] > 3)
check("the mixed logit doesn't", abs(mixed$coef["last_choice"] / mixed$se[5]) < 3)

if (failures) { cat(failures, "check(s) failed\n"); quit(status = 1) }
cat("All mixed-logit checks passed.\n")
