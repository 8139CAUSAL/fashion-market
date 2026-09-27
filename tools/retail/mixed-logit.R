# A panel mixed logit, estimated by simulated maximum likelihood, in base R.
#
# Household i on trip t chooses brand j with utility
#   U_itj = x_itj' beta_i + e_itj,   e ~ Gumbel,
#   beta_i = mu + s * xi_i  for the random coefficients (xi ~ N(0, 1),
#            independent), beta_i = mu for the fixed ones.
# A household keeps its beta across all its trips, which is what separates
# lasting taste differences from brand loyalty that is built by buying.
#
# The likelihood of a household's trips is simulated with R Halton draws
# per household; the gradient is analytic, so BFGS converges in seconds.
# Standard errors come from the outer product of each household's score
# (BHHH). Each household's own coefficients are its conditional mean given
# its choices (Revelt & Train 2000).
#
#   fit <- mixed_logit(X, chosen, household, random = c(TRUE, FALSE, ...))
#
# X is an n x J x K array (trips x brands x variables), chosen is 1..J,
# household is 1..H with every household present. With no random
# coefficients it is a plain conditional logit.

halton <- function(n, base) {
  k <- seq_len(n); r <- numeric(n); f <- 1
  while (any(k > 0)) { f <- f / base; r <- r + f * (k %% base); k <- k %/% base }
  r
}

# H x R x D standard normal Halton draws, R consecutive points per household.
halton_normal <- function(H, R, D, skip = 20) {
  primes <- c(2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53)
  if (D > length(primes)) stop("halton_normal: too many random coefficients")
  draws <- array(0, c(H, R, D))
  for (d in seq_len(D)) draws[, , d] <- matrix(qnorm(halton(H * R + skip, primes[d])[-seq_len(skip)]), H, R, byrow = TRUE)
  draws
}

mixed_logit <- function(X, chosen, household, random, draws = 200, start = NULL,
                        xi = NULL, maxit = 1000) {
  n <- dim(X)[1]; J <- dim(X)[2]; K <- dim(X)[3]
  vars <- dimnames(X)[[3]]
  H <- max(household)
  stopifnot(length(random) == K, all(tabulate(household, H) > 0))
  kr <- which(random); D <- length(kr)
  R <- if (D) draws else 1L
  if (D && is.null(xi)) xi <- halton_normal(H, R, D)
  Xc <- vapply(seq_len(K), function(k) X[, , k][cbind(seq_len(n), chosen)], numeric(n))
  Xc <- matrix(Xc, n, K)

  # Log-likelihood of each household under each draw, and each household's
  # summed score under each draw.
  evaluate <- function(theta) {
    mu <- theta[seq_len(K)]; s <- theta[K + seq_len(D)]
    logL <- matrix(0, H, R)
    score <- array(0, c(H, R, K))
    for (r in seq_len(R)) {
      B <- matrix(mu, H, K, byrow = TRUE)
      if (D) B[, kr] <- B[, kr] + xi[, r, , drop = TRUE] * rep(s, each = H)
      Bt <- B[household, , drop = FALSE]
      V <- matrix(0, n, J)
      for (k in seq_len(K)) V <- V + X[, , k] * Bt[, k]
      top <- V[, 1]; for (j in seq_len(J)[-1]) top <- pmax(top, V[, j])
      E <- exp(V - top); S <- rowSums(E); P <- E / S
      logL[, r] <- rowsum(V[cbind(seq_len(n), chosen)] - top - log(S), household, reorder = TRUE)
      G <- Xc
      for (k in seq_len(K)) G[, k] <- G[, k] - rowSums(P * X[, , k])
      score[, r, ] <- rowsum(G, household, reorder = TRUE)
    }
    top <- apply(logL, 1, max)
    Lr <- exp(logL - top)
    w <- Lr / rowSums(Lr)                     # each draw's weight for each household
    ll <- sum(log(rowMeans(Lr)) + top)
    # Per-household scores: mu, then s.
    per_h <- matrix(0, H, K + D)
    for (k in seq_len(K)) per_h[, k] <- rowSums(w * score[, , k])
    for (d in seq_len(D)) per_h[, K + d] <- rowSums(w * score[, , kr[d]] * xi[, , d])
    list(ll = ll, grad = colSums(per_h), per_h = per_h, w = w)
  }

  last <- NULL
  cached <- function(theta) {
    if (is.null(last) || !identical(last$theta, theta)) last <<- c(list(theta = theta), evaluate(theta))
    last
  }
  theta0 <- if (is.null(start)) c(rep(0, K), rep(0.5, D)) else start
  opt <- optim(theta0, function(th) -cached(th)$ll, function(th) -cached(th)$grad,
               method = "BFGS", control = list(maxit = maxit, reltol = 1e-12))
  at <- cached(opt$par)

  theta <- opt$par
  names(theta) <- c(vars, if (D) paste0("sd.", vars[kr]))
  vcov <- tryCatch(solve(crossprod(at$per_h)), error = function(e) matrix(NA, length(theta), length(theta)))
  se <- sqrt(pmax(diag(vcov), 0))
  # A standard deviation's sign means nothing; report it positive.
  if (D) theta[K + seq_len(D)] <- abs(theta[K + seq_len(D)])

  # Each household's own coefficients: the draw-weighted mean.
  individual <- matrix(theta[seq_len(K)], H, K, byrow = TRUE, dimnames = list(NULL, vars))
  if (D) for (d in seq_len(D)) {
    individual[, kr[d]] <- theta[kr[d]] + theta[K + d] * rowSums(at$w * xi[, , d] * sign(opt$par[K + d]))
  }

  structure(list(
    coef = theta, se = se, vcov = vcov, loglik = at$ll, gradient = at$grad, n = n, households = H,
    converged = opt$convergence == 0, iterations = opt$counts[["gradient"]],
    random = random, draws = R, xi = xi, weights = at$w, individual = individual,
    sd_sign = if (D) sign(opt$par[K + seq_len(D)]) else numeric(0)
  ), class = "mixed_logit")
}

# Choice probabilities for new trips by known households, averaged over each
# household's posterior draw weights (w from the estimation period).
predict_mixed_logit <- function(fit, X, household) {
  n <- dim(X)[1]; J <- dim(X)[2]; K <- dim(X)[3]
  kr <- which(fit$random); D <- length(kr)
  mu <- fit$coef[seq_len(K)]; s <- fit$coef[K + seq_len(D)] * fit$sd_sign
  P <- matrix(0, n, J)
  for (r in seq_len(fit$draws)) {
    B <- matrix(mu, fit$households, K, byrow = TRUE)
    if (D) B[, kr] <- B[, kr] + fit$xi[, r, , drop = TRUE] * rep(s, each = fit$households)
    Bt <- B[household, , drop = FALSE]
    V <- matrix(0, n, J)
    for (k in seq_len(K)) V <- V + X[, , k] * Bt[, k]
    E <- exp(V - apply(V, 1, max))
    P <- P + fit$weights[household, r] * E / rowSums(E)
  }
  P
}

print.mixed_logit <- function(x, ...) {
  z <- x$coef / x$se
  tab <- data.frame(estimate = round(x$coef, 3), se = round(x$se, 3), z = round(z, 1))
  cat(sprintf("Mixed logit: %d trips, %d households, %d draws, log-likelihood %.1f%s\n",
              x$n, x$households, x$draws, x$loglik, if (x$converged) "" else " (NOT converged)"))
  print(tab)
  invisible(x)
}
