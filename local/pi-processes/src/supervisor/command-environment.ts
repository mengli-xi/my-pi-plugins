import { REQUIRED_EXECUTION_ISOLATION_ENV, type ExecutionIsolationV1 } from "../execution-isolation.js";

export function commandEnvironment(env: NodeJS.ProcessEnv, isolation?: ExecutionIsolationV1): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("PI_PROCESSES_SUPERVISOR_")) delete clean[key];
  }
  delete clean.BUN_BE_BUN;
  delete clean[REQUIRED_EXECUTION_ISOLATION_ENV];
  for (const key of isolation?.removeEnv ?? []) delete clean[key];
  return clean;
}
