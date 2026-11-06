import type { EventEmitter } from "node:events";

/** Pi 1.2 behavior contract, not a private-name probe. Never delete pre-existing listeners. */
export function captureProcessHandlers() {
  const surfaces: Array<{ emitter: EventEmitter; event: string; label: string }> = [
    ...["SIGTERM", ...(process.platform === "win32" ? [] : ["SIGHUP"]), "uncaughtException"].map(event => ({ emitter: process, event, label: `process:${event}` })),
    ...(["stdin", "stdout", "stderr"] as const).map(name => ({ emitter: process[name], event: "error", label: `${name}:error` })),
  ];
  return surfaces.map(surface => ({ ...surface, before: surface.emitter.listeners(surface.event) }));
}

export function releaseChildProcessHandlers(snapshot: ReturnType<typeof captureProcessHandlers>): void {
  const changes = snapshot.map(surface => {
    const remaining = [...surface.before];
    const added = surface.emitter.listeners(surface.event).filter(listener => {
      const index = remaining.indexOf(listener);
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    });
    return { ...surface, added, missing: remaining.length };
  });
  const unknown = changes.filter(change => change.added.length !== 1 || change.missing !== 0);
  // Validate the whole transaction before removing anything. Concurrent plugin handlers are not ours.
  if (unknown.length) throw new Error(`Unsupported InteractiveMode.init process listeners: ${unknown.map(change => `${change.label} +${change.added.length}/-${change.missing}`).join(", ")}`);
  for (const change of changes) change.emitter.removeListener(change.event, change.added[0]! as (...args: any[]) => void);
}
