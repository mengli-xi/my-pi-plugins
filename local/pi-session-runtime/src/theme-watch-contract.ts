const capability = "pi.theme-watch.file-version.v1";
const remedy = "Install/rebuild the Pi 1.5.0 theme-watch patch for both the Main CLI and canonical SDK peers (host-patches/pi/v1.5.0), then restart Pi; patching only the CLI is not sufficient.";

/**
 * Pi 1.5 theme-watch patch public contract; source/evidence: host-patches/pi/v1.5.0.
 * Managed terminal handoff alone requires watcher reuse and SDK-owned file-version reload
 * in both native Main UI and canonical child SDK. Missing/changed contracts fail closed;
 * headless assembly and idle Main bindings do not require this capability. No private probe.
 */
export function requireThemeWatchContract(mainUi: object, sdkRoot: object): void {
  let main: unknown, sdk: unknown;
  try { main = (mainUi as { readonly themeWatchCapability?: unknown }).themeWatchCapability; }
  catch (cause) { throw new Error(`Cannot read Main UI themeWatchCapability before child terminal handoff. ${remedy}`, { cause }); }
  try { sdk = (sdkRoot as { readonly THEME_WATCH_CAPABILITY?: unknown }).THEME_WATCH_CAPABILITY; }
  catch (cause) { throw new Error(`Cannot read canonical SDK THEME_WATCH_CAPABILITY before child terminal handoff. ${remedy}`, { cause }); }
  if (main !== capability || sdk !== capability) {
    const describe = (value: unknown) => value === undefined ? "missing" : typeof value === "string" ? JSON.stringify(value) : `invalid ${typeof value}`;
    throw new Error(`Child terminal handoff requires theme-watch capability ${capability}; Main UI: ${describe(main)}, canonical SDK: ${describe(sdk)}. ${remedy}`);
  }
}
