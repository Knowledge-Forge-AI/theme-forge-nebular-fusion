import { spawn } from "node:child_process";

// One owned process group per build command. A timeout cleans its descendants;
// it never signals an unrelated host process or a name-matched process family.
export function runOwnedBuild(program, args, { cwd, env, timeout = 1_800_000, stdio = "inherit" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, stdio, detached: true });
    let expired = false, forceTimer;
    const signal = name => {
      if (!child.pid) return;
      try { process.kill(-child.pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const timer = setTimeout(() => {
      expired = true; signal("SIGTERM");
      forceTimer = setTimeout(() => signal("SIGKILL"), 2000);
    }, timeout);
    child.once("error", error => { clearTimeout(timer); clearTimeout(forceTimer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer); clearTimeout(forceTimer);
      if (expired) signal("SIGKILL");
      if (expired || code !== 0) reject(new Error("Native candidate build command failed; no production receipt emitted"));
      else resolve();
    });
  });
}
