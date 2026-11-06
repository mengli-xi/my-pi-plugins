import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

export default function piPackageManager(pi: ExtensionAPI): void {
  pi.registerCommand("plugins", {
    description: "Manage configured Pi packages",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/plugins requires Pi's interactive TUI.", "warning");
        return;
      }

      const [{ PackageCatalog }, { showPackageManager }] = await Promise.all([
        import("./src/catalog.js"),
        import("./src/manager.js"),
      ]);
      const agentDir = getAgentDir();
      const catalog = new PackageCatalog({
        cwd: ctx.cwd,
        agentDir,
        projectTrusted: ctx.isProjectTrusted(),
        managerRoot: PACKAGE_ROOT,
      });
      await showPackageManager(ctx, catalog);
    },
  });
}
