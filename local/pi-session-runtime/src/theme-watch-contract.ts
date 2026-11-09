const capability = "pi.theme-watch.file-version.v1";
const remedy = "Install/rebuild the Pi 1.5.0 theme-watch patch for both the Main CLI and canonical SDK peers (host-patches/pi/v1.5.0), then restart Pi; patching only the CLI is not sufficient.";

/**
 * Pi 1.5 theme-watch patch public contract; source/evidence: host-patches/pi/v1.5.0.
 * Both markers absent selects stock palette-only handoff. Partial/unknown contracts
 * fail closed; only matching known markers authorize SDK-owned file-version reload.
 * Headless assembly and idle Main bindings need no capability. No private probe.
 */
export function requireThemeWatchContract(mainUi: object, sdkRoot: object): "stock" | "patched" {
  let main: unknown, sdk: unknown;
  try { main = (mainUi as { readonly themeWatchCapability?: unknown }).themeWatchCapability; }
  catch (cause) { throw new Error(`Cannot read Main UI themeWatchCapability before child terminal handoff. ${remedy}`, { cause }); }
  try { sdk = (sdkRoot as { readonly THEME_WATCH_CAPABILITY?: unknown }).THEME_WATCH_CAPABILITY; }
  catch (cause) { throw new Error(`Cannot read canonical SDK THEME_WATCH_CAPABILITY before child terminal handoff. ${remedy}`, { cause }); }
  if (main === undefined && sdk === undefined) return "stock";
  if (main !== capability || sdk !== capability) {
    const describe = (value: unknown) => value === undefined ? "missing" : typeof value === "string" ? JSON.stringify(value) : `invalid ${typeof value}`;
    throw new Error(`Child terminal handoff requires theme-watch capability ${capability}; Main UI: ${describe(main)}, canonical SDK: ${describe(sdk)}. ${remedy}`);
  }
  return "patched";
}
