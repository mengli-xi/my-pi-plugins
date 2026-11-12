/**
 * Process-external startup boundary passed by the lightweight `pi` launcher.
 *
 * The value is epoch microseconds captured immediately before exec. Converting
 * it through `performance.timeOrigin` lets the first-observed-frame probe stay on the
 * same monotonic clock as every other UI metric.
 */
export const PI_PERF_LAUNCH_EPOCH_US = "PI_PERF_LAUNCH_EPOCH_US";

const MAX_LAUNCH_AGE_MS = 10 * 60_000;
const MAX_FUTURE_SKEW_MS = 1_000;

export interface StartupBoundaries {
  processStartedAt: number;
  launcherStartedAt?: number;
}

export function resolveStartupBoundaries(
  env: NodeJS.ProcessEnv = process.env,
  timeOrigin = performance.timeOrigin,
  nowEpochMs = Date.now(),
): StartupBoundaries {
  const result: StartupBoundaries = { processStartedAt: 0 };
  const raw = env[PI_PERF_LAUNCH_EPOCH_US];
  if (!raw || !/^\d{13,17}$/.test(raw)) return result;

  const launchEpochMs = Number(raw) / 1_000;
  const ageMs = nowEpochMs - launchEpochMs;
  if (!Number.isFinite(launchEpochMs) || ageMs < -MAX_FUTURE_SKEW_MS || ageMs > MAX_LAUNCH_AGE_MS) {
    return result;
  }

  result.launcherStartedAt = launchEpochMs - timeOrigin;
  return result;
}
