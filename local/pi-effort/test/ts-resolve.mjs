/**
 * pi loads extension TypeScript through jiti, which resolves a `./x.js`
 * specifier to the neighbouring `x.ts`. That is why the sources use `.js`
 * specifiers, matching the other packages here. Plain Node's type stripping
 * does not do that mapping, so the test runner installs it explicitly.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // No sibling .ts - fall through to the specifier as written.
      }
    }
    return nextResolve(specifier, context);
  },
});
