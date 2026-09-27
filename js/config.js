// Pinned runtime versions and asset locations, shared by the main thread and
// the engine worker.

export const WEBR_VERSION = "0.6.0";
export const WEBR_BASE_URL = `https://webr.r-wasm.org/v${WEBR_VERSION}/`;

// Pre-bundled NetLogoR library image built by tools/build-vfs.R. The R
// version it targets must match the webR release above.
export const VFS_IMAGE_URL = new URL("../vfs/netlogor-lib", import.meta.url).href;
export const VFS_MOUNT_POINT = "/netlogor-lib";

// Data files models can load with workbench_data("name").
export const DATA_BASE_URL = new URL("../templates/data/", import.meta.url).href;

// Preset gallery: spec + model pairs listed in templates/index.json.
export const TEMPLATES_URL = new URL("../templates/", import.meta.url).href;

// The engine's own R code, sourced into the session once NetLogoR is loaded.
export const WORKBENCH_R_URL = new URL("../r/workbench.R", import.meta.url).href;
