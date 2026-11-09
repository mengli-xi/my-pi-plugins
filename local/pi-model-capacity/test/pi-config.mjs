import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      // The adapter tests supply an isolated Pi config root; never use personal configuration.
      return {
        url: "data:text/javascript," + encodeURIComponent(`export function getAgentDir() {
          const dir = process.env.PI_CODING_AGENT_DIR;
          if (!dir) throw new Error("test Pi config root is required");
          return dir;
        }`),
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
