#!/usr/bin/env node
import { cp, mkdir, writeFile, realpath, readdir, chmod, stat, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadBuildInputs, verifySourceTree, isBuildEnvironmentKey, sourceBuildPathPolicy } from "./build-inputs.mjs";
import { produceBuildReceipt } from "./build-receipt.mjs";
import { authenticateNativeRuntimeInput, verifyRuntimeSourceSnapshot, writeNativeRuntimeReceipt } from "./native-runtime.mjs";
import {
  admitPreparedNeutralPreviewInput,
  createPreviewHashBudget,
  stagePreparedNeutralPreviewInput,
  verifyPreparedNeutralPreviewCustody,
  verifyPreparedNeutralPreviewPostbuild,
} from "./prepare-app-resources.mjs";
import { targetForHost } from "./platform-targets.mjs";
import { runOwnedBuild } from "./owned-build-process.mjs";
import { scanShippedPaths } from "./scan-shipped-paths.mjs";
import { chooseNativeCargoHome } from "./native-cargo-home-contract.mjs";
import { prepareNativeWorkingCaches } from "./native-cache-preparation.mjs";

/** @typedef {Awaited<ReturnType<typeof loadBuildInputs>>} BuildAuthority */
/** @typedef {NonNullable<BuildAuthority["inputs"]["execution"]>} BuildExecution */
/** @typedef {BuildAuthority["inputs"]["settings"]["cargo"]} CargoSettings */
/** @typedef {{ target: string, buildInputs: string, output: string, nativeRuntime?: string, nativeRuntimeSha256?: string, preparedPreviewInputs?: string, workingCargoHome?: string, workingCargoHomeIdentity?: string }} NativeBuildArgs */
/** @typedef {Awaited<ReturnType<typeof produceBuildReceipt>>} BuildResult */

/** @param {string} parent @param {string} child @returns {boolean} */
function outside(parent, child) {
  const rel = relative(parent, child);
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}

/** @param {string} path @returns {Promise<void>} */
async function makeWritable(path) {
  const info = await stat(path);
  await chmod(path, info.mode | 0o200 | (info.isDirectory() ? 0o100 : 0));
  if (info.isDirectory()) for (const entry of await readdir(path)) await makeWritable(join(path, entry));
}

// Default compatibility wrapper; the integrated preparation seam owns cache destination creation.
/** @param {string} work @param {BuildExecution} execution @param {CargoSettings} [cargoConfig] @returns {Promise<void>} */
export async function populateNativeCaches(work, execution, cargoConfig) {
  await prepareNativeWorkingCaches(work, execution, cargoConfig, { mode: "default-copy", cargoHome: join(work, "cargo-home") });
}

/** @param {string[]} startDirs @param {unknown} [_ignoredCargoConfig] @returns {Promise<void>} */
export async function inspectAncestorCargoConfigs(startDirs, _ignoredCargoConfig) {
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

/**
 * Stage native frontend dependencies. An authenticated preview inventory is
 * consumed later by prepareLoom's identity-bound, bin-free staging route.
 * @param {string} stage
 * @param {BuildExecution} execution
 * @param {string} node
 * @param {string} npm
 * @param {(program: string, args: string[], cwd?: string) => Promise<void>} run
 * @returns {Promise<void>}
 */
export async function prepareNativeDependencies(stage, execution, node, npm, run) {
  if (execution.frontendModules) await cp(execution.frontendModules, join(stage, "node_modules"), { recursive: true, dereference: true, errorOnExist: true, force: false });
  else await run(node, [npm, "ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], stage);
  // Do not pre-copy or rebuild an explicit preview inventory: its original
  // locator and digest remain in the authority passed through build-app.
  if (!execution.previewModules) {
    await run(node, [npm, "ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], join(stage, "loom-preview-source"));
  }
  await makeWritable(join(stage, "node_modules"));
  const rebuildRoots = [stage];
  if (!execution.previewModules) {
    await makeWritable(join(stage, "loom-preview-source/node_modules"));
    rebuildRoots.push(join(stage, "loom-preview-source"));
  }
  for (const cwd of rebuildRoots) {
    await run(node, [npm, "rebuild", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], cwd);
  }
}

/** @param {NativeBuildArgs} options @returns {Promise<BuildResult>} */
export async function buildNativeCandidate({ target, buildInputs, output, nativeRuntime, nativeRuntimeSha256, preparedPreviewInputs, workingCargoHome, workingCargoHomeIdentity }) {
  const hasNativeRuntime = nativeRuntime !== undefined;
  const hasNativeRuntimeSha256 = nativeRuntimeSha256 !== undefined;
  if (hasNativeRuntime !== hasNativeRuntimeSha256) {
    throw new Error("--native-runtime and --native-runtime-sha256 must be supplied together");
  }
  const hasPreparedPreviewInputs = preparedPreviewInputs !== undefined;
  if (hasPreparedPreviewInputs && (hasNativeRuntime || hasNativeRuntimeSha256)) {
    throw new Error("--prepared-preview-inputs and --native-runtime are mutually exclusive");
  }
  if ((workingCargoHome !== undefined) !== (workingCargoHomeIdentity !== undefined)) {
    throw new Error("--working-cargo-home and --working-cargo-home-identity must be supplied together");
  }
  /** @type {BuildAuthority} */
  const authority = await loadBuildInputs(buildInputs);
  /** @type {Record<string, string>} */
  const aliases = { "darwin-arm64": "aarch64-apple-darwin", "linux-arm64": "aarch64-unknown-linux-gnu", "linux-x64": "x86_64-unknown-linux-gnu" };
  const triple = aliases[target] ?? target;
  if (triple !== authority.target.triple || triple !== targetForHost().triple) throw new Error("Native candidate target must match authority and native host");
  if (!authority.tools.npm) throw new Error("Native candidate requires an explicit qualified npm CLI");
  if (hasNativeRuntime && authority.target.os !== "linux") {
    throw new Error("Private nativeRuntime input is only supported for Linux targets");
  }
  if (hasPreparedPreviewInputs) {
    if (typeof preparedPreviewInputs !== "string" || !preparedPreviewInputs) {
      throw new Error("--prepared-preview-inputs must be a non-empty path");
    }
    if (authority.target.triple !== "aarch64-apple-darwin" || authority.target.os !== "darwin" || authority.inputs.mode !== "portable-source") {
      throw new Error("--prepared-preview-inputs is only admitted for Darwin portable-source builds");
    }
  }
  const sourceRoot = await realpath(authority.inputs.sourceRoot);
  output = resolve(output);
  // Resolve the parent before creating anything so a symlink cannot redirect
  // owned staging into source or one of the immutable component roots.
  const outputName = output.split("/").at(-1);
  if (!outputName) throw new Error("Build output path is required");
  output = join(await realpath(dirname(output)), outputName);
  const inputRoots = [sourceRoot, ...Object.values(authority.roots)];
  for (const inputRoot of inputRoots) {
    if (!outside(inputRoot, output) || !outside(output, inputRoot)) throw new Error("Build output overlaps input authority");
  }
  await verifySourceTree(sourceRoot, authority.inputs.source);
  const authenticatedRuntime = hasNativeRuntime && typeof nativeRuntime === "string" && typeof nativeRuntimeSha256 === "string"
    ? await authenticateNativeRuntimeInput(nativeRuntime, nativeRuntimeSha256, {
      expectedTarget: triple,
      outputRoots: [output, ...inputRoots],
    })
    : null;
  const previewBudget = hasPreparedPreviewInputs ? createPreviewHashBudget() : undefined;
  const admittedPreview = hasPreparedPreviewInputs && typeof preparedPreviewInputs === "string"
    ? await admitPreparedNeutralPreviewInput(preparedPreviewInputs, authority, {
      ...(previewBudget ? { budget: previewBudget } : {}),
      outputRoots: [output, ...inputRoots],
    })
    : null;
  await mkdir(output, { recursive: false });
  /** @type {unknown} */
  let primaryError = null;
  try {
    const work = join(output, "work"), stage = join(work, "source");
    await mkdir(work);
    for (const name of ["home", "tmp", "target"]) await mkdir(join(work, name));
    await cp(sourceRoot, stage, { recursive: true, force: false, errorOnExist: true });
    // Recheck the exact copy before installs or generated resources modify it.
    await verifySourceTree(stage, authority.inputs.source);
    await makeWritable(stage);
    const authorityPath = join(work, "build-inputs.json");
    await writeFile(authorityPath, JSON.stringify(authority.inputs, null, 2) + "\n", { flag: "wx" });
    const execution = authority.inputs.execution ?? {};
    const defaultCargoHome = join(work, "cargo-home");
    const selectedCargoHome = await chooseNativeCargoHome({
      workingCargoHome,
      workingCargoHomeIdentity,
      defaultCargoHome,
      outputRoots: [output],
      inputRoots,
      expectedCargoConfig: authority.inputs.settings.cargo?.content,
    });
    await prepareNativeWorkingCaches(work, execution, authority.inputs.settings.cargo, selectedCargoHome);
    const node = authority.tools.node;
    const rust = authority.tools.rust;
    const cargo = authority.tools.cargo;
    const compiler = authority.tools.compiler;
    const pkgConfig = authority.tools.pkgConfig;
    const npm = authority.tools.npm;
    if (typeof node !== "string" || typeof rust !== "string" || typeof cargo !== "string"
        || typeof compiler !== "string" || typeof pkgConfig !== "string" || typeof npm !== "string") {
      throw new Error("Native candidate toolchain paths are incomplete");
    }
    /** @type {Record<string, string>} */
    const env = {
      PATH: [...new Set([...Object.values(authority.tools).map(dirname), ...Object.values(authority.inputs.toolchains).map(t => dirname(t.path))]), "/usr/bin", "/bin"].join(":"),
      HOME: join(work, "home"), TMPDIR: join(work, "tmp"), TMP: join(work, "tmp"), TEMP: join(work, "tmp"),
      CARGO_HOME: selectedCargoHome.cargoHome, CARGO_TARGET_DIR: join(work, "target"),
      npm_config_cache: join(work, "npm-cache"), npm_config_offline: "true", CARGO_NET_OFFLINE: "true",
      RUSTC: rust, CARGO: cargo, CC: compiler, PKG_CONFIG: pkgConfig,
      NEBULAR_BUILD_INPUTS: authorityPath, NEBULAR_BUILD_MODE: authority.inputs.mode,
      SOURCE_DATE_EPOCH: "1704067200", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    };
    if (authenticatedRuntime) {
      env.NEBULAR_NATIVE_RUNTIME_INPUT = authenticatedRuntime.inputPath;
      env.NEBULAR_NATIVE_RUNTIME_INPUT_SHA256 = authenticatedRuntime.inputSha256;
    }
    // Explicit SDK/build environment only; no ambient NODE_OPTIONS, global
    // compilers, npm config, Git identity, or personal cache/home inheritance.
    for (const [key, value] of Object.entries(execution.environment ?? {})) {
      if (!isBuildEnvironmentKey(key) || typeof value !== "string") throw new Error("Unsupported build execution environment");
      env[key] = value;
    }
    // Nix wrappers use this root for path remapping. The caller cannot select a
    // different remapping root while retaining the same semantic settings.
    if (Object.hasOwn(env, "NIX_BUILD_TOP")) env.NIX_BUILD_TOP = work;
    /** @param {string} program @param {string[]} args @param {string} [cwd] @returns {Promise<void>} */
    const run = (program, args, cwd = stage) => runOwnedBuild(program, args, { cwd, env });
    await prepareNativeDependencies(stage, execution, node, npm, run);
    const stagedPreview = admittedPreview
      ? await stagePreparedNeutralPreviewInput(stage, admittedPreview, previewBudget)
      : undefined;
    if (stagedPreview) {
      // Keep the authenticated handoff explicit and child-local. build-app
      // must consume the exact staged root produced by admission and staging;
      // it must not rediscover or rebuild a neutral preview from source.
      env.NEBULAR_PREPARED_PREVIEW_HANDOFF = JSON.stringify({
        schema: "nebular-prepared-preview-build-handoff-v1",
        previewDist: join(stage, "loom-preview-source/dist/neutral"),
        authorityIdentity: authority.identity,
        sourceIdentity: admittedPreview.sourceIdentity,
        manifestSha256: stagedPreview.manifestSha256,
        originSourceCandidate: stagedPreview.originSourceCandidate,
        originOutputIdentity: stagedPreview.originOutputIdentity,
        currentSourceCandidate: stagedPreview.currentSourceCandidate,
        target: stagedPreview.target,
        effectiveInputIdentity: stagedPreview.effectiveInputIdentity,
        neutralIdentity: stagedPreview.neutralIdentity,
      });
    }
    await inspectAncestorCargoConfigs([stage, process.cwd()], authority.inputs.settings?.cargo);
    await run(node, [join(stage, "tools/build-app.mjs")]);
    const release = join(work, "target", triple, "release");
    const payloadRoot = join(output, "payload");
    await mkdir(payloadRoot);
    if (authority.target.os === "darwin") {
      await cp(join(release, "bundle/macos/Theme Forge Nebular Fusion.app"), join(payloadRoot, "Theme Forge Nebular Fusion.app"), { recursive: true });
    } else await cp(join(release, "bundle/raw"), payloadRoot, { recursive: true, verbatimSymlinks: true });
    // An input mutation must fail even if compilation appeared to succeed.
    await verifySourceTree(sourceRoot, authority.inputs.source);
    if (admittedPreview && stagedPreview) {
      await verifyPreparedNeutralPreviewPostbuild(stage, admittedPreview, stagedPreview, previewBudget);
    }
    const pathPolicy = await sourceBuildPathPolicy(authority.inputs);
    await scanShippedPaths(payloadRoot, [...pathPolicy.forbiddenPrefixes, work, await realpath(work)], { preserveSpellings: true });
    const receiptResult = await produceBuildReceipt({
      inputs: authority.inputs,
      studioRoot: stage,
      payloadRoot,
      output,
      ...(stagedPreview ? { preparedPreview: stagedPreview, ...(previewBudget ? { previewHashBudget: previewBudget } : {}) } : {}),
    });
    if (authenticatedRuntime) {
      await writeNativeRuntimeReceipt(output, {
        target: triple,
        material: authenticatedRuntime.material,
        sourceCandidate: authority.inputs.source.identity,
        payloadInventory: receiptResult.payload,
        inputSha256: authenticatedRuntime.inputSha256,
      });
    }
    return receiptResult;
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    if (authenticatedRuntime) {
      try {
        await verifyRuntimeSourceSnapshot(authenticatedRuntime);
      } catch (verifyErr) {
        if (!primaryError) throw verifyErr;
      }
    }
    if (admittedPreview) {
      try {
        await verifyPreparedNeutralPreviewCustody(admittedPreview, previewBudget, { rehashHeavyInputs: false });
      } catch (verifyErr) {
        if (!primaryError) throw verifyErr;
      }
    }
  }
}

/** @param {string[]} argv @returns {NativeBuildArgs} */
export function parseNativeBuildArgs(argv) {
  /** @type {Partial<NativeBuildArgs>} */
  const result = {};
  /** @type {Record<string, keyof NativeBuildArgs>} */
  const names = {
    "--target": "target",
    "--build-inputs": "buildInputs",
    "--output": "output",
    "--native-runtime": "nativeRuntime",
    "--native-runtime-sha256": "nativeRuntimeSha256",
    "--prepared-preview-inputs": "preparedPreviewInputs",
    "--working-cargo-home": "workingCargoHome",
    "--working-cargo-home-identity": "workingCargoHomeIdentity",
  };
  for (let i = 0; i < argv.length; i += 2) {
    const option = argv[i];
    const value = argv[i + 1];
    if (typeof option !== "string" || typeof value !== "string") throw new Error("Expected --target, --build-inputs and --output exactly once");
    const key = names[option];
    if (!key || result[key] || !value || value.startsWith("--")) throw new Error("Expected --target, --build-inputs and --output exactly once");
    result[key] = value;
  }
  if (typeof result.target !== "string" || typeof result.buildInputs !== "string" || typeof result.output !== "string") {
    throw new Error("Missing native candidate build argument");
  }
  if ((result.nativeRuntime !== undefined) !== (result.nativeRuntimeSha256 !== undefined)) {
    throw new Error("--native-runtime and --native-runtime-sha256 must be supplied together");
  }
  if (result.preparedPreviewInputs !== undefined && (result.nativeRuntime !== undefined || result.nativeRuntimeSha256 !== undefined)) {
    throw new Error("--prepared-preview-inputs and --native-runtime are mutually exclusive");
  }
  if ((result.workingCargoHome !== undefined) !== (result.workingCargoHomeIdentity !== undefined)) {
    throw new Error("--working-cargo-home and --working-cargo-home-identity must be supplied together");
  }
  return {
    target: result.target,
    buildInputs: result.buildInputs,
    output: result.output,
    ...(result.nativeRuntime !== undefined ? { nativeRuntime: result.nativeRuntime, nativeRuntimeSha256: result.nativeRuntimeSha256 } : {}),
    ...(result.preparedPreviewInputs !== undefined ? { preparedPreviewInputs: result.preparedPreviewInputs } : {}),
    ...(result.workingCargoHome !== undefined ? { workingCargoHome: result.workingCargoHome, workingCargoHomeIdentity: result.workingCargoHomeIdentity } : {}),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildNativeCandidate(parseNativeBuildArgs(process.argv.slice(2)));
}

