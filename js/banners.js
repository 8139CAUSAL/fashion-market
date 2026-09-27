// Dismissible notification banners.
//
// Anything that goes wrong — a spec that doesn't parse, a circular layout, R
// code that fails — is reported here instead of only in the console, and
// never by throwing away the interface. Banners are keyed, so a repeated
// problem updates its banner rather than stacking up copies.

const banners = new Map();

export function showBanner(container, { key, kind = "error", title, detail, action }) {
  dismissBanner(key);

  const banner = document.createElement("div");
  banner.className = `banner banner-${kind}`;
  banner.setAttribute("role", kind === "error" ? "alert" : "status");

  const body = document.createElement("div");
  body.className = "banner-body";
  body.append(Object.assign(document.createElement("strong"), { textContent: title }));
  if (detail) {
    body.append(Object.assign(document.createElement("pre"), { className: "banner-detail", textContent: detail }));
  }

  const buttons = document.createElement("div");
  buttons.className = "banner-actions";
  if (action) {
    const button = Object.assign(document.createElement("button"), {
      type: "button",
      className: "btn",
      textContent: action.label,
    });
    button.addEventListener("click", () => {
      dismissBanner(key);
      action.run();
    });
    buttons.append(button);
  }

  const close = Object.assign(document.createElement("button"), {
    type: "button",
    className: "btn btn-ghost",
    textContent: "✕",
  });
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => dismissBanner(key));
  buttons.append(close);

  banner.append(body, buttons);
  container.append(banner);
  banners.set(key, banner);
  return banner;
}

export function dismissBanner(key) {
  banners.get(key)?.remove();
  banners.delete(key);
}

export function clearBanners() {
  for (const key of [...banners.keys()]) dismissBanner(key);
}

export function hasBanner(key) {
  return banners.has(key);
}
