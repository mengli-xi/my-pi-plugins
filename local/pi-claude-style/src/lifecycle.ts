export interface Disposable {
	dispose(): void | Promise<void>;
}

/** Invocation-local aggregation for timers, listeners, widgets and patches. */
export class DisposableStack implements Disposable {
	private readonly entries: Disposable[] = [];
	private disposed = false;

	add<T extends Disposable>(entry: T): T {
		if (this.disposed) {
			// A resource registered after teardown must not leak. `add` is
			// intentionally synchronous, so there is nowhere useful to return an
			// asynchronous teardown failure; observe and contain it instead of
			// creating an unhandled rejection during shutdown.
			try {
				const result = entry.dispose();
				if (result && typeof result.then === "function") {
					void result.catch(() => {});
				}
			} catch {
				// The stack is already closed. The resource was given its one cleanup
				// attempt, and a late registration cannot reopen the lifecycle.
			}
			return entry;
		}
		this.entries.push(entry);
		return entry;
	}

	defer(dispose: () => void | Promise<void>): Disposable {
		return this.add({ dispose });
	}

	timer(timer: NodeJS.Timeout): NodeJS.Timeout {
		timer.unref?.();
		this.defer(() => clearTimeout(timer));
		return timer;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		let firstError: unknown;
		for (const entry of this.entries.splice(0).reverse()) {
			try {
				await entry.dispose();
			} catch (error) {
				firstError ??= error;
			}
		}
		if (firstError !== undefined) throw firstError;
	}
}

export interface FeatureHealth {
	status: "ok" | "degraded" | "failed" | "inactive";
	detail?: string;
}

export type ApplyResult =
	| { kind: "applied" }
	| { kind: "pending"; apply: "reload" | "restart"; detail?: string }
	| { kind: "failed"; detail: string };

export interface Feature<Context = unknown, Config = unknown> {
	id: string;
	install(ctx: Context): Disposable;
	onConfigChange?(next: Config, previous: Config): ApplyResult;
	health(): FeatureHealth;
}

interface ActiveFeature {
	feature: Feature<unknown, unknown>;
	disposable: Disposable;
}

/** Owns invocation-local resources and tears them down in reverse order. */
export class LifecycleManager {
	private readonly active = new Map<string, ActiveFeature>();
	private readonly order: string[] = [];
	private readonly failures = new Map<string, string>();
	private readonly pending = new Map<string, ApplyResult>();
	private closed = false;

	install<Context, Config>(feature: Feature<Context, Config>, context: Context): boolean {
		if (this.active.has(feature.id)) return false;
		if (this.closed) {
			// A shutdown can win while an async bootstrap step is awaiting. If its
			// continuation still attempts installation, give the returned resource
			// one cleanup attempt but never reactivate the closed lifecycle.
			try {
				const disposable = feature.install(context);
				const result = disposable.dispose();
				if (result && typeof result.then === "function") void result.catch(() => {});
			} catch (error) {
				this.failures.set(feature.id, error instanceof Error ? error.message : String(error));
			}
			return false;
		}
		try {
			const disposable = feature.install(context);
			this.active.set(feature.id, {
				feature: feature as Feature<unknown, unknown>,
				disposable,
			});
			this.order.push(feature.id);
			this.failures.delete(feature.id);
			return true;
		} catch (error) {
			this.failures.set(feature.id, error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	apply<Config>(id: string, next: Config, previous: Config): ApplyResult {
		const active = this.active.get(id);
		if (!active?.feature.onConfigChange) {
			const result: ApplyResult = { kind: "pending", apply: "restart" };
			this.pending.set(id, result);
			return result;
		}
		try {
			const result = active.feature.onConfigChange(next, previous);
			if (result.kind === "pending") this.pending.set(id, result);
			else this.pending.delete(id);
			return result;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.failures.set(id, detail);
			return { kind: "failed", detail };
		}
	}

	trackTimer(id: string, timer: NodeJS.Timeout): Disposable {
		timer.unref?.();
		const feature: Feature = {
			id,
			install: () => ({ dispose: () => clearTimeout(timer) }),
			health: () => ({ status: "ok" }),
		};
		this.install(feature, undefined);
		return { dispose: () => this.teardown(id) };
	}

	async teardown(id: string): Promise<void> {
		const active = this.active.get(id);
		if (!active) return;
		this.active.delete(id);
		const index = this.order.lastIndexOf(id);
		if (index >= 0) this.order.splice(index, 1);
		try {
			await active.disposable.dispose();
		} catch (error) {
			this.failures.set(id, error instanceof Error ? error.message : String(error));
		}
	}

	async teardownAll(): Promise<void> {
		this.closed = true;
		for (const id of [...this.order].reverse()) await this.teardown(id);
	}

	health(): Record<string, FeatureHealth> {
		const result: Record<string, FeatureHealth> = {};
		for (const [id, active] of this.active) {
			try { result[id] = active.feature.health(); }
			catch (error) { result[id] = { status: "failed", detail: error instanceof Error ? error.message : String(error) }; }
		}
		for (const [id, detail] of this.failures) result[id] = { status: "failed", detail };
		return result;
	}

	get activeIds(): readonly string[] {
		return [...this.order];
	}

	get isClosed(): boolean {
		return this.closed;
	}
}
