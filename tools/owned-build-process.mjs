import { spawn } from "node:child_process";

/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/** @typedef {import("node:child_process").SpawnOptions} SpawnOptions */
/** @typedef {import("node:child_process").StdioOptions} StdioOptions */
/** @typedef {NodeJS.ProcessEnv} BuildEnvironment */
/** @typedef {{ cwd: string, env: BuildEnvironment, timeout?: number, stdio?: StdioOptions }} BuildOptions */

/** @param {unknown} value @returns {value is { code: unknown }} */
function hasErrorCode(value) {
  return value !== null && typeof value === "object" && "code" in value;
}

// One owned process group per build command. A timeout cleans its descendants;
// it never signals an unrelated host process or a name-matched process family.
/**
 * @param {string} program
 * @param {string[]} args
 * @param {BuildOptions} options
 * @returns {Promise<void>}
 */
export function runOwnedBuild(program, args, { cwd, env, timeout = 1_800_000, stdio = "inherit" }) {
  /** @type {Promise<void>} */
  return new Promise((resolve, reject) => {
    /** @type {SpawnOptions} */
    const spawnOptions = { cwd, env, stdio, detached: true };
    /** @type {ChildProcess} */
    const child = spawn(program, args, spawnOptions);
    let expired = false;
    /** @type {NodeJS.Timeout | undefined} */
    let forceTimer;
    /** @param {NodeJS.Signals} name */
    const signal = name => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if (!hasErrorCode(error) || error.code !== "ESRCH") throw error;
      }
    };
    const timer = setTimeout(() => {
      expired = true; signal("SIGTERM");
      forceTimer = setTimeout(() => signal("SIGKILL"), 2000);
    }, timeout);
    child.once("error", error => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer); clearTimeout(forceTimer);
      if (expired) signal("SIGKILL");
      if (expired || code !== 0) reject(new Error("Native candidate build command failed; no production receipt emitted"));
      else resolve();
    });
  });
}
