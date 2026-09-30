#!/usr/bin/env node
import { cp, mkdir, writeFile, realpath, readdir, chmod, stat, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadBuildInputs, verifySourceTree, isBuildEnvironmentKey } from "./build-inputs.mjs";
import { produceBuildReceipt } from "./build-receipt.mjs";
import { targetForHost } from "./platform-targets.mjs";
import { runOwnedBuild } from "./owned-build-process.mjs";
import { scanShippedPaths } from "./scan-shipped-paths.mjs";
import { sourceBuildPathPolicy } from "./build-inputs.mjs";

function outside(parent, child) {
  const rel = relative(parent, child);
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}

async function makeWritable(path) {
  const info = await stat(path);
  await chmod(path, info.mode | 0o200 | (info.isDirectory() ? 0o100 : 0));
  if (info.isDirectory()) for (const entry of await readdir(path)) await makeWritable(join(path, entry));
}

// work and its empty cache directories are owned, freshly created staging.
export async function populateNativeCaches(work, execution, cargoConfig) {
  for (const [name, destination] of [["cargoHome", "cargo-home"], ["npmCache", "npm-cache"]]) {
    if (execution[name]) {
      const selectedCache = await realpath(execution[name]);
      // Exclusive recursive copy must target fresh children, not the existing root.
      for (const member of (await readdir(selectedCache)).sort()) {
        await cp(join(selectedCache, member), join(work, destination, member), { recursive: true, dereference: true, force: false, errorOnExist: true });
      }
      await makeWritable(join(work, destination));
    }
  }
  // Ambient cache configuration must never bypass the bound configuration.
  if (execution.cargoHome) {
    await rm(join(work, "cargo-home/config"), { force: true });
    await rm(join(work, "cargo-home/config.toml"), { force: true });
  }
  if (cargoConfig) await writeFile(join(work, "cargo-home/config.toml"), cargoConfig.content);
}

export async function inspectAncestorCargoConfigs(startDirs) {
  const inspectedDirs = new Set();
  for (const startDir of startDirs) {
    let curr = resolve(startDir);
    while (true) {
      if (inspectedDirs.has(curr)) break;
      inspectedDirs.add(curr);
      for (const name of ["config", "config.toml"]) {
        const configPath = join(curr, ".cargo", name);
        let exists = false;
        try {
          await stat(configPath);
          exists = true;
        } catch {}
        if (exists) throw new Error("Unbound cargo configuration in ancestor; duplicate merging is not admitted");
      }
      const parent = dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
  }
}

export async function buildNativeCandidate({ target, buildInputs, output }) {
  const authority = await loadBuildInputs(buildInputs);
  const aliases = { "darwin-arm64": "aarch64-apple-darwin", "linux-arm64": "aarch64-unknown-linux-gnu", "linux-x64": "x86_64-unknown-linux-gnu" };
  const triple = aliases[target] ?? target;
  if (triple !== authority.target.triple || triple !== targetForHost().triple) throw new Error("Native candidate target must match authority and native host");
  if (!authority.tools.npm) throw new Error("Native candidate requires an explicit qualified npm CLI");
  const sourceRoot = await realpath(authority.inputs.sourceRoot);
  output = resolve(output);
  // Resolve the parent before creating anything so a symlink cannot redirect
  // owned staging into source or one of the immutable component roots.
  output = join(await realpath(dirname(output)), output.split("/").at(-1));
  for (const inputRoot of [sourceRoot, ...Object.values(authority.roots)]) {
    if (!outside(inputRoot, output) || !outside(output, inputRoot)) throw new Error("Build output overlaps input authority");
  }
  await verifySourceTree(sourceRoot, authority.inputs.source);
  await mkdir(output, { recursive: false });
  const work = join(output, "work"), stage = join(work, "source");
  await mkdir(work);
  for (const name of ["home", "tmp", "cargo-home", "npm-cache", "target"]) await mkdir(join(work, name));
  await cp(sourceRoot, stage, { recursive: true, force: false, errorOnExist: true });
  // Recheck the exact copy before installs or generated resources modify it.
  await verifySourceTree(stage, authority.inputs.source);
  await makeWritable(stage);
  const authorityPath = join(work, "build-inputs.json");
  await writeFile(authorityPath, JSON.stringify(authority.inputs, null, 2) + "\n", { flag: "wx" });
  const execution = authority.inputs.execution ?? {};
  await populateNativeCaches(work, execution, authority.inputs.settings.cargo);
  const env = {
    PATH: [...new Set([...Object.values(authority.tools).map(dirname), ...Object.values(authority.inputs.toolchains).map(t => dirname(t.path))]), "/usr/bin", "/bin"].join(":"),
    HOME: join(work, "home"), TMPDIR: join(work, "tmp"), TMP: join(work, "tmp"), TEMP: join(work, "tmp"),
    CARGO_HOME: join(work, "cargo-home"), CARGO_TARGET_DIR: join(work, "target"),
    npm_config_cache: join(work, "npm-cache"), npm_config_offline: "true", CARGO_NET_OFFLINE: "true",
    RUSTC: authority.tools.rust, CARGO: authority.tools.cargo, CC: authority.tools.compiler, PKG_CONFIG: authority.tools.pkgConfig,
    NEBULAR_BUILD_INPUTS: authorityPath, NEBULAR_BUILD_MODE: authority.inputs.mode,
    SOURCE_DATE_EPOCH: "1704067200", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
  };
  // Explicit SDK/build environment only; no ambient NODE_OPTIONS, global
  // compilers, npm config, Git identity, or personal cache/home inheritance.
  for (const [key, value] of Object.entries(execution.environment ?? {})) {
    if (!isBuildEnvironmentKey(key) || typeof value !== "string") throw new Error("Unsupported build execution environment");
    env[key] = value;
  }
  // Nix wrappers use this root for path remapping. The caller cannot select a
  // different remapping root while retaining the same semantic settings.
  if (Object.hasOwn(env, "NIX_BUILD_TOP")) env.NIX_BUILD_TOP = work;
  const run = (program, args, cwd = stage) => runOwnedBuild(program, args, { cwd, env });
  const npm = authority.tools.npm;
  if (execution.frontendModules) await cp(execution.frontendModules, join(stage, "node_modules"), { recursive: true, dereference: true, errorOnExist: true, force: false });
  else await run(authority.tools.node, [npm, "ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"]);
  // Preview dependencies have their own maintained lock and owned source tree.
  if (execution.previewModules) await cp(execution.previewModules, join(stage, "loom-preview-source/node_modules"), { recursive: true, dereference: true, errorOnExist: true, force: false });
  else await run(authority.tools.node, [npm, "ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], join(stage, "loom-preview-source"));
  await makeWritable(join(stage, "node_modules"));
  await makeWritable(join(stage, "loom-preview-source/node_modules"));
  // Dereferenced dependency inputs are relocation-stable inventories. Rebuild
  // their npm bin links only inside owned staging, with lifecycle scripts off.
  for (const cwd of [stage, join(stage, "loom-preview-source")]) {
    await run(authority.tools.node, [npm, "rebuild", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], cwd);
  }
  await inspectAncestorCargoConfigs([stage, process.cwd()], authority.inputs.settings?.cargo);
  await run(authority.tools.node, [join(stage, "tools/build-app.mjs")]);
  const release = join(work, "target", triple, "release");
  const payloadRoot = join(output, "payload");
  await mkdir(payloadRoot);
  if (authority.target.os === "darwin") {
    await cp(join(release, "bundle/macos/Theme Forge Nebular Fusion.app"), join(payloadRoot, "Theme Forge Nebular Fusion.app"), { recursive: true });
  } else await cp(join(release, "bundle/raw"), payloadRoot, { recursive: true });
  // An input mutation must fail even if compilation appeared to succeed.
  await verifySourceTree(sourceRoot, authority.inputs.source);
  const pathPolicy = await sourceBuildPathPolicy(authority.inputs);
  await scanShippedPaths(payloadRoot, [...pathPolicy.forbiddenPrefixes, work, await realpath(work)], { preserveSpellings: true });
  return produceBuildReceipt({ inputs: authority.inputs, studioRoot: stage, payloadRoot, output });
}

export function parseNativeBuildArgs(argv) {
  const result = {};
  const names = { "--target": "target", "--build-inputs": "buildInputs", "--output": "output" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]];
    if (!key || result[key] || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Expected --target, --build-inputs and --output exactly once");
    result[key] = argv[i + 1];
  }
  if (Object.keys(result).length !== 3) throw new Error("Missing native candidate build argument");
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildNativeCandidate(parseNativeBuildArgs(process.argv.slice(2)));
}
