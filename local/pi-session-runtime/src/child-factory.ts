import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateChildFactoryProofV1, type ChildFactoryProofV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { loadApprovedFactoryModule } from "pi-session-runtime/factory-loader";

/** Ordinary, already-loaded owners use declarations, not a consumer brand catalog. */
export async function loadChildFactoryV1(input: {
  proof: ChildFactoryProofV1;
  publicModules: Readonly<Record<string, object>>;
  options: Readonly<Record<string, unknown>>;
  required?: boolean;
  diagnostic?: (message: string) => void;
  onCancel?: (cancel: () => Promise<void>) => void;
  checkTool?: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => void;
}): Promise<ExtensionFactory | undefined> {
  const report = (error: unknown): void => {
    const message = `child factory ${input.proof.manifest.owner_id}: ${error instanceof Error ? error.message : String(error)}`;
    (input.diagnostic ?? console.warn)(message);
    if (input.required) throw new Error(message);
  };
  try {
    const proof = validateChildFactoryProofV1(input.proof, true);
    const target = proof.manifest.targets[proof.target_id]!;
    const declaration = target.child_factory!;
    const module = await loadApprovedFactoryModule({ path: declaration.files[0]!.canonical_path, exports: [declaration.export],
      publicModules: input.publicModules, codeDescriptors: [declaration.package_manifest, ...declaration.files] });
    validateChildFactoryProofV1(proof, true);
    const factory = await (module[declaration.export] as (options: unknown) => ExtensionFactory)({ ...input.options, context: proof.context });
    if (typeof factory !== "function") throw new Error("declared export returned no extension factory");
    if (target.hooks.includes("execution/cancel-pending-v1") && typeof (factory as ExtensionFactory & { cancelPending?: unknown }).cancelPending !== "function") throw new Error("child factory lacks declared durable cancellation port");
    return pi => {
      // Delay registrations until installation succeeds, so a broken optional owner
      // cannot leave half its tools/hooks in the child. No execution authority is added.
      const pending: Array<() => void> = [];
      let committed = false, failed = false;
      const schedule = (action: () => void) => committed ? action() : pending.push(action);
      const guarded = new Proxy(pi, { get(object, key) {
        if (key === "events") return { ...object.events, emit: object.events.emit.bind(object.events), on: (channel: string, handler: (data: unknown) => void) => {
          let released = false, unsubscribe: (() => void) | undefined;
          schedule(() => { if (!released) unsubscribe = object.events.on(channel, handler); });
          return () => { released = true; unsubscribe?.(); };
        } };
        if (key === "registerTool") return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
          if (!target.tools.includes(tool.name)) throw new Error(`undeclared child tool: ${tool.name}`);
          if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) throw new Error(`child tool ${tool.name} must define an object parameter schema`);
          input.checkTool?.(tool);
          schedule(() => object.registerTool(tool));
        };
        if (key === "registerProvider") return () => { throw new Error("ordinary child factory cannot register providers; use SDK provider grants"); };
        if (key === "registerCommand") return (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
          if (!target.commands.includes(name)) throw new Error(`undeclared child command: ${name}`);
          if (typeof command?.handler !== "function") throw new Error(`child command ${name} must define handler()`);
          schedule(() => object.registerCommand(name, command));
        };
        if (key === "on") return (name: string, handler: (...args: unknown[]) => unknown) => {
          const guardedHandler = (...args: unknown[]) => {
            if (failed && name !== "session_shutdown") return;
            const fail = (error: unknown) => { if (!input.required) failed = true; report(error); };
            try { const result = handler(...args); return result && typeof (result as Promise<unknown>).then === "function" ? Promise.resolve(result).catch(fail) : result; }
            catch (error) { fail(error); }
          };
          let released = false, unsubscribe: (() => void) | undefined;
          schedule(() => { if (!released) unsubscribe = (object.on as (name: string, handler: (...args: unknown[]) => unknown) => () => void)(name, guardedHandler); });
          return () => { released = true; unsubscribe?.(); };
        };
        if (key === "registerFlag") return (name: string, options: Parameters<ExtensionAPI["registerFlag"]>[1]) => {
          if (options.default !== undefined && typeof options.default !== options.type) throw new Error(`invalid child flag default: ${name}`);
          schedule(() => object.registerFlag(name, options));
        };
        if (["registerMessageRenderer", "registerEntryRenderer", "registerMarkdownTransformer", "registerToolRenderer", "registerShortcut"].includes(String(key))) return (...args: unknown[]) => {
          schedule(() => (object[key as keyof ExtensionAPI] as (...args: unknown[]) => void)(...args));
        };
        return Reflect.get(object, key);
      } });
      try {
        validateChildFactoryProofV1(proof, true);
        const result = factory(guarded);
        // Pi supports async extensions; preserve both failure isolation and registration order.
        const finish = () => { for (const action of pending) action(); committed = true;
          const cancel = (factory as ExtensionFactory & { cancelPending?: () => Promise<void> }).cancelPending;
          if (cancel) input.onCancel?.(async () => { try { await cancel.call(factory); } catch (error) { report(error); } });
        };
        if (result && typeof (result as Promise<void>).then === "function") return Promise.resolve(result).then(finish, report);
        finish();
      } catch (error) { report(error); }
    };
  } catch (error) { report(error); return undefined; }
}
