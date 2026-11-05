import { createBashToolDefinition, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type BashOptions = NonNullable<Parameters<typeof createBashToolDefinition>[1]>;

export function createBashTimeoutTool(getOptions: () => BashOptions) {
  // Pi 1.5 validates the replacement schema with pi-schema. Do not carry a
  // builtin argument preparer across this stricter required-timeout boundary.
  const { renderCall: _renderCall, renderResult: _renderResult, prepareArguments: _prepareArguments, ...builtin } = createBashToolDefinition(process.cwd());
  return {
    ...builtin,
    // Same-name extension overrides must still follow Pi's existing tool selection.
    defaultActive: false,
    description: builtin.description.replace("Optionally provide a timeout in seconds.", "Provide a required timeout in seconds."),
    parameters: Type.Object({
      command: builtin.parameters.properties.command,
      timeout: Type.Number({
        exclusiveMinimum: 0,
        description: "Required timeout in seconds (positive). Use tens of seconds to 2 minutes for ordinary commands; estimate builds, tests, and device operations (e.g. 10–30 minutes). Set an explicit upper bound for network requests or streams that may wait indefinitely. Use process to start long-running commands in the background or inspect progress instead of waiting in bash.",
      }),
    }),
    execute: (...args: Parameters<typeof builtin.execute>) => createBashToolDefinition(args[4].cwd, getOptions()).execute(...args),
  };
}

export function createBashTimeoutChildFactory() {
  return (pi: ExtensionAPI): void => {
    // Stock Pi 1.5 AgentSession._buildRuntime passes exactly these two settings
    // to createBashToolDefinition. Defaults retain local operations, spawn hook
    // and session environment. The public getters normalize shellPath; absent
    // settings stay absent, and an invalid configured shell fails in Pi itself.
    pi.registerTool(createBashTimeoutTool(() => {
      const settings = SettingsManager.inMemory(pi.getSettings());
      return { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() };
    }));
  };
}
