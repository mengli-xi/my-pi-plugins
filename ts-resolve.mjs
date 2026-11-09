// Match Pi/Jiti's relative .js-to-.ts resolution for Node's offline tests.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // No sibling TypeScript source; use normal resolution below.
      }
    }
    return nextResolve(specifier, context);
  },
});
