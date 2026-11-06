import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { createEditorOverlayMount } from "pi-li-uikit/editor-overlay";

import { MissingSnapshotError, PackageCatalog } from "./catalog.js";
import type { ManagedPackage, ManagerAction, PackageViewState } from "./types.js";
import { PackageManagerView } from "./ui.js";

type TaskResult<T> = { ok: true; value: T } | { ok: false; error: Error };

async function runTask<T>(
  ctx: ExtensionCommandContext,
  message: string,
  task: () => Promise<T>,
): Promise<T> {
  const result = await ctx.ui.custom<TaskResult<T>>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable: false });
    void task().then(
      (value) => done({ ok: true, value }),
      (error: unknown) => done({
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    );
    return loader;
  });
  if (!result.ok) throw result.error;
  return result.value;
}

async function reloadIfConfirmed(
  ctx: ExtensionCommandContext,
  message: string,
): Promise<boolean> {
  if (!(await ctx.ui.confirm("Reload Pi?", message))) return false;
  await ctx.reload();
  return true;
}

export async function showPackageManager(
  ctx: ExtensionCommandContext,
  catalog: PackageCatalog,
): Promise<void> {
  let packages: ManagedPackage[];
  try {
    packages = await runTask(ctx, "Loading configured packages...", () => catalog.list());
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }

  let updates = new Set<string>();
  let updatesChecked = false;
  let reloadRequired = false;
  let viewState: PackageViewState | undefined;

  while (true) {
    let nextViewState = viewState;
    const overlay = createEditorOverlayMount();
    const action = await ctx.ui.custom<ManagerAction>((tui, theme, keybindings, done) => {
      let view!: PackageManagerView;
      const complete = (value: ManagerAction): void => {
        nextViewState = view.getViewState();
        done(value);
      };
      view = new PackageManagerView(
        tui,
        theme,
        keybindings,
        packages,
        updates,
        updatesChecked,
        reloadRequired,
        viewState,
        complete,
      );
      return overlay.mount(tui, view);
    }, overlay.customOptions);
    viewState = nextViewState;

    if (action.type === "close") {
      if (reloadRequired) {
        await reloadIfConfirmed(ctx, "Package changes take effect after reload.");
      }
      return;
    }

    if (action.type === "reload") {
      if (!reloadRequired) {
        ctx.ui.notify("No package changes require a reload.", "info");
        continue;
      }
      await ctx.reload();
      return;
    }

    if (action.type === "toggle") {
      const selected = packages.find((pkg) => pkg.id === action.packageId);
      if (!selected) continue;
      if (selected.protected && selected.enabled) {
        ctx.ui.notify(
          "pi-package-manager cannot disable itself here. Use pi config if this is intentional.",
          "warning",
        );
        continue;
      }

      const nextEnabled = !selected.enabled;
      try {
        try {
          await runTask(
            ctx,
            `${nextEnabled ? "Enabling" : "Disabling"} ${selected.displayName}...`,
            () => catalog.setEnabled(selected.id, nextEnabled),
          );
        } catch (error) {
          if (!nextEnabled || !(error instanceof MissingSnapshotError)) throw error;
          if (!(await ctx.ui.confirm(
            "Enable without saved filters?",
            `Some saved filters for ${selected.displayName} are missing. Enable those entries with all resources allowed by the package? Existing backups will still be restored.`,
          ))) continue;
          await runTask(ctx, `Enabling ${selected.displayName}...`, () =>
            catalog.setEnabled(selected.id, true, { allowWithoutSnapshot: true }));
        }
        packages = await catalog.list();
        reloadRequired = true;
        ctx.ui.notify(`${selected.displayName} ${nextEnabled ? "enabled" : "disabled"}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
      continue;
    }

    if (action.type === "check") {
      try {
        updates = await runTask(ctx, "Checking package updates...", () => catalog.checkForUpdates());
        updatesChecked = true;
        ctx.ui.notify(
          updates.size === 0
            ? "No updates detected. Offline, skipped, or unavailable checks do not establish that packages are current."
            : `${updates.size} package update${updates.size === 1 ? "" : "s"} available.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Update check failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      continue;
    }

    const selected = packages.find((pkg) => pkg.id === action.packageId);
    if (!selected) continue;
    if (selected.kind === "local") {
      ctx.ui.notify("Local path packages are not updateable; update their working tree directly.", "warning");
      continue;
    }
    if (selected.missing) {
      ctx.ui.notify(`${selected.displayName} is configured but not installed.`, "warning");
      continue;
    }

    try {
      updates = await runTask(ctx, `Checking ${selected.displayName}...`, () => catalog.checkForUpdates());
      updatesChecked = true;
      if (!updates.has(selected.id)) {
        ctx.ui.notify(
          `No update detected for ${selected.displayName}; it may be pinned, skipped, offline, or unavailable for checking.`,
          "info",
        );
        continue;
      }

      const confirmed = await ctx.ui.confirm(
        "Update package?",
        `Update ${selected.displayName} through Pi's package manager?`,
      );
      if (!confirmed) continue;

      await runTask(ctx, `Updating ${selected.displayName}...`, () => catalog.update(selected));
      packages = await catalog.list();
      updates.delete(selected.id);
      reloadRequired = true;
      ctx.ui.notify(`${selected.displayName} updated.`, "info");
      if (await reloadIfConfirmed(ctx, "The updated package takes effect after reload.")) return;
    } catch (error) {
      ctx.ui.notify(`Update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}

export const managerInternals = { runTask };
