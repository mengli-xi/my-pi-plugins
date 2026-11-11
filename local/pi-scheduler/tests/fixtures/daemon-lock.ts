import { spawn } from "node:child_process";

/** Process exit can precede the advisory helper's EOF/exit. Wait on the kernel
 * lock itself before a test restarts a daemon; never guess with a fixed sleep. */
export async function waitForDaemonLockRelease(lockPath: string): Promise<void> {
  const [file, args] = process.platform === "darwin"
    ? ["/usr/bin/lockf", ["-k", "-t", "15", lockPath, "true"]] as const
    : ["flock", ["-w", "15", lockPath, "true"]] as const;
  const child = spawn(file, [...args], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`daemon lock release failed: ${code}`)));
  });
}
