#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, assertGlibcRuntime, resolveTarget, sanitizeEnvironment, verifyPayload } from "./payload.mjs";

const require = createRequire(import.meta.url);

/** @param {{ os?: string } | null | undefined} target @param {{ nativeRuntime?: boolean, launcher?: string | null, executable?: string }} payload @returns {string} */
export function selectLaunchPath(target, payload) {
  if (target?.os === "linux" && payload?.nativeRuntime === true) {
    if (typeof payload.launcher !== "string" || payload.launcher.length === 0 || !payload.launcher.startsWith("/")) {
      throw new Error("Authenticated private native launcher unavailable");
    }
    return payload.launcher;
  }
  if (typeof payload?.executable !== "string" || payload.executable.length === 0 || !payload.executable.startsWith("/")) {
    throw new Error("Authenticated payload executable unavailable");
  }
  return payload.executable;
}

/** @param {{ os?: string } | null | undefined} target @param {{ nativeRuntime?: boolean }} payload @param {NodeJS.ProcessEnv} [baseEnv] @returns {NodeJS.ProcessEnv} */
export function createLaunchEnvironment(target, payload, baseEnv = process.env) {
  const env = sanitizeEnvironment(baseEnv);
  if (target?.os === "linux" && payload?.nativeRuntime === true) {
    for (const name of Object.keys(env)) {
      if (name.startsWith("LD_") || name === "GLIBC_TUNABLES") delete env[name];
    }
  }
  return env;
}

/** @param {string[]} [args] */
export function main(args = process.argv.slice(2)) {
  const currentPlatform = process.platform;
  const currentArch = process.arch;
  const { key, target } = resolveTarget(currentPlatform, currentArch);
  assertGlibcRuntime(currentPlatform);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(`Theme Forge Nebular Fusion ${VERSION}\nUsage: tfnf [--version|--help|--path]\nNormal invocation launches the installed GUI.`);
    return;
  }
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
    console.log(`theme-forge-nebular-fusion ${VERSION} (${key})`);
    return;
  }

  let root;
  try {
    root = dirname(require.resolve(`${target.package}/package.json`));
  } catch {
    throw new Error(`Missing optional platform package ${target.package}; install optional dependencies. No first-launch download is performed.`);
  }
  const bindingsPath = new URL("../payload-bindings.json", import.meta.url);
  const bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
  if (bindings.schema !== "tfsb.nebular-wrapper-bindings-v1" || bindings.version !== VERSION) throw new Error("Invalid wrapper input binding");
  // Verify immediately before pathname-based output or spawn; a concurrent rename race remains.
  const payload = verifyPayload(root, target, bindings.targets[key]);
  if (args.length === 1 && args[0] === "--path") {
    console.log(payload.executable);
    return;
  }
  const env = createLaunchEnvironment(target, payload);
  const child = spawn(selectLaunchPath(target, payload), args, { stdio: "inherit", env });
  let terminationTimer;
  const killTimeout = 5000;
  const forward = signal => () => {
    try { child.kill(signal); } catch {}
    terminationTimer ??= setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, killTimeout);
    terminationTimer?.unref?.();
  };
  const term = forward("SIGTERM");
  const interrupt = forward("SIGINT");
  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);
  child.once("error", () => {
    clearTimeout(terminationTimer);
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
    console.error("Nebular GUI could not be started");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    clearTimeout(terminationTimer);
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
    if (signal) {
      try { process.kill(process.pid, signal); }
      catch { process.exitCode = 128 + 15; }
    } else {
      process.exitCode = code ?? 1;
    }
  });
}

const currentModulePath = fileURLToPath(import.meta.url);

/** @param {string | undefined} [entryPath] @param {boolean | undefined} [metaMain] @returns {boolean} */
export function isCliEntry(entryPath = process.argv[1], metaMain = import.meta.main) {
  if (metaMain === true) return true;
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(currentModulePath);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  try {
    main();
  } catch (error) {
    // System and parse errors may embed private paths or payload text.
    // Keep their diagnostic generic; contract errors retain their safe message.
    console.error((error?.code || error instanceof SyntaxError)
      ? "Nebular installed payload could not be read or validated"
      : error instanceof Error ? error.message : "Nebular launch failed");
    process.exitCode = 1;
  }
}
