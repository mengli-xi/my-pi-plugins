export type HandleError =
  | "stale-handle"
  | "already-settled"
  | "capacity"
  | "invalid-input"
  | "consumer-replaced";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: HandleError;
      readonly message: string;
    };

export function ok<T>(value: T): Result<T> {
  return Object.freeze({ ok: true as const, value });
}

export function fail<T>(
  error: HandleError,
  message: string,
): Result<T> {
  return Object.freeze({ ok: false as const, error, message });
}

export function invariant(code: string, message: string): never {
  throw new Error(`[runtime-contracts/${code}] ${message}`);
}
