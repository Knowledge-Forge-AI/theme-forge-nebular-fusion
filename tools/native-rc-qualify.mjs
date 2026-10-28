#!/usr/bin/env node
// Machine qualification of one compiled native payload before it is packaged.
//
// Common: target executable header; the maintained launcher bytes; the bundled sidecar is exactly the
// authenticated embedded Node runtime for the target; every Tauri resource directory equals the
// prepared directory it was built from.
// Linux: 0755 executables; 64-bit little-endian ELF of the target machine; every needed shared library
// resolves (ldd); the glibc floor is the highest GLIBC_ symbol version the executables require, and it
// must not exceed the floor of the pinned build environment.
// Darwin: arm64 Mach-O; the finalized legal notices and launcher; strict deep codesign verification.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, identity, inventoryTree } from "./candidate-provenance.mjs";
import { readRegularSnapshot } from "./fs-snapshot.mjs";
import { nativeLauncher } from "./native-launcher.mjs";
import {
  authenticateNativeRuntimeInput,
  classifyAndValidateRuntimeClosure,
  createPrivateRuntimeEnvironment,
  inventoryNativePayload,
  parseElfMetadata,
  parseLddProviders,
  readRegularDescriptorChecked,
  selectPayloadNativeRuntime,
  validatePrivateGraphicsPayload,
  verifyRuntimeSourceSnapshot,
} from "./native-runtime.mjs";
import { buildElfPortabilityObservation, ELF_PORTABILITY_READELF_ARGS } from "./elf-portability.mjs";
import { NODE_RELEASE_IDENTITY } from "./node-runtime-authority.mjs";
import { PLATFORMS, verifyNativeExecutableHeader } from "./native-rc-package.mjs";
import { resourceDirectories } from "./platform-targets.mjs";

export const GLIBC_CEILING = "2.36"; // Debian 12 (bookworm), the pinned Linux build environment
export const OBSERVATION_EXPORT_SCHEMA = "nebular.native-rc-observation-export-v1";
const HEX64_RE = /^[a-f0-9]{64}$/u;

export function compareVersions(left, right) {
  const [a, b] = [left, right].map((value) => value.split(".").map(Number));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

/** Highest GLIBC_x.y listed in the version-needs sections of `readelf --version-info` output. */
export function glibcFloor(readelfOutput) {
  const versions = [...readelfOutput.matchAll(/Name:\s+GLIBC_(\d+\.\d+(?:\.\d+)?)/g)].map((match) => match[1]);
  if (versions.length === 0) throw new Error("No GLIBC version requirements found");
  return versions.sort(compareVersions).at(-1);
}

/**
 * Authenticate an ordinary payload inventory when an explicit digest was supplied.
 * Linux emits the inventory in its qualification receipt; Darwin performs the same
 * identity check but keeps its existing explicit-null payload field contract.
 */
export function selectPayloadInventoryForQualification(platform, {
  hasExpectedPayload,
  ordinaryInventory,
  expectedNativePayloadSha256,
}) {
  if (hasExpectedPayload && ordinaryInventory.identity !== expectedNativePayloadSha256) {
    throw new Error(
      `Payload native inventory identity ${ordinaryInventory.identity} does not match expected ${expectedNativePayloadSha256}`,
    );
  }
  return platform.os === "linux" ? ordinaryInventory : null;
}

function observationPathInside(child, root) {
  const resolvedChild = resolve(child);
  const resolvedRoot = resolve(root);
  return resolvedChild === resolvedRoot || resolvedChild.startsWith(`${resolvedRoot}${sep}`);
}

function observationBytes(value) {
  return Buffer.from(`${canonical(value)}\n`);
}

function validateObservationOutputPath(outputDir, payloadRoot) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("Observation export requires a non-empty observationOutputDir path");
  }
  const resolvedOutput = resolve(outputDir);
  const resolvedPayload = resolve(payloadRoot);
  let realPayload = resolvedPayload;
  try {
    realPayload = realpathSync(resolvedPayload);
  } catch {
    // Keep resolvedPayload when the payload root has not been materialized yet.
  }
  if (observationPathInside(resolvedOutput, resolvedPayload) || observationPathInside(resolvedOutput, realPayload)) {
    throw new Error("Observation export directory must be outside the payload");
  }
  const parent = dirname(resolvedOutput);
  const parentStat = lstatSync(parent, { bigint: true });
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("Observation export parent must be a real directory");
  }
  const realParent = realpathSync(parent);
  if (observationPathInside(realParent, resolvedPayload) || observationPathInside(realParent, realPayload)) {
    throw new Error("Observation export parent resolves inside the payload");
  }
  return resolvedOutput;
}

function writeObservationExport({ outputDir, payloadRoot, platform, sourceCandidate, result, floorObservation, portabilityObservation, runtimeInputSha256 }) {
  if (platform.os !== "linux") throw new Error("Observation export is supported only for Linux qualification");
  if (typeof sourceCandidate !== "string" || !HEX64_RE.test(sourceCandidate)) {
    throw new Error("Observation export requires a lowercase 64-hex sourceCandidate identity");
  }
  const resolvedOutput = validateObservationOutputPath(outputDir, payloadRoot);
  if (!floorObservation || floorObservation.schema !== "nebular-native-runtime-consumer-floor-observation-v1") {
    throw new Error("Observation export is missing the complete runtime floor observation");
  }
  if (!portabilityObservation || portabilityObservation.schema !== "nebular-native-elf-portability-observation-set-v1") {
    throw new Error("Observation export is missing the complete ELF portability observation");
  }
  const floorUnsigned = { ...floorObservation };
  delete floorUnsigned.observationIdentity;
  if (identity(floorUnsigned) !== floorObservation.observationIdentity) throw new Error("Runtime floor observation identity is not canonical");
  const portabilityUnsigned = { ...portabilityObservation };
  delete portabilityUnsigned.identity;
  if (identity(portabilityUnsigned) !== portabilityObservation.identity) throw new Error("ELF portability observation identity is not canonical");
  if (!result.nativePayload || !HEX64_RE.test(result.nativePayload.identity)) throw new Error("Observation export requires an admitted native payload identity");
  const floorBytes = observationBytes(floorObservation);
  const portabilityBytes = observationBytes(portabilityObservation);
  const manifestUnsigned = {
    schema: OBSERVATION_EXPORT_SCHEMA,
    platform: result.platform,
    target: platform.triple,
    sourceCandidate,
    qualification: {
      schema: result.schema,
      identity: identity(result),
      status: result.status,
      executableSha256: result.executableSha256,
      glibcMinimum: result.glibcMinimum,
      nativePayload: result.nativePayload,
      materialDigest: result.materialDigest,
    },
    runtimeInputSha256: runtimeInputSha256 ?? null,
    observations: {
      runtimeFloor: { file: "runtime-floor-observation.json", identity: floorObservation.observationIdentity, sha256: createHash("sha256").update(floorBytes).digest("hex") },
      elfPortability: { file: "elf-portability-observation.json", identity: portabilityObservation.identity, sha256: createHash("sha256").update(portabilityBytes).digest("hex") },
    },
  };
  const manifest = { ...manifestUnsigned, identity: identity(manifestUnsigned) };
  mkdirSync(resolvedOutput, { mode: 0o700 });
  writeFileSync(join(resolvedOutput, "runtime-floor-observation.json"), floorBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(join(resolvedOutput, "elf-portability-observation.json"), portabilityBytes, { flag: "wx", mode: 0o600 });
  // The manifest is written last; without it no partial observation set is admitted.
  writeFileSync(join(resolvedOutput, "identity-manifest.json"), observationBytes(manifest), { flag: "wx", mode: 0o600 });
  return manifest;
}

export const PRIVATE_PROBE_TIMEOUT_MS = 30_000;
export const PRIVATE_PROBE_AGGREGATE_TIMEOUT_MS = 120_000;
export const PRIVATE_PROBE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function killProcessGroup(pid, signal) {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function processGroupGone(pid) {
  if (!pid) return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

const PRIVATE_PROBE_TERMINATION_GRACE_MS = 500;
const PRIVATE_PROBE_POLL_MS = 20;
const PRIVATE_PROBE_STREAM_DRAIN_GRACE_MS = 500;
const PRIVATE_PROBE_STREAM_DESTROY_GRACE_MS = 50;

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForGroupGone(pid, timeoutMs = PRIVATE_PROBE_TERMINATION_GRACE_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!processGroupGone(pid) && Date.now() < deadline) {
    await delay(PRIVATE_PROBE_POLL_MS);
  }
  return processGroupGone(pid);
}

/**
 * Run one private probe in its own process group. The caller may pass an
 * aggregate deadline and AbortSignal; the returned lifecycle flags are
 * explicit because callers must not infer cleanup or complete output from a
 * zero exit status alone.
 */
export function run(
  command,
  args,
  env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  { deadline = null, signal = undefined } = {},
) {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(command, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolveResult({
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
        timedOut: false,
        outputLimitExceeded: false,
        cleanupKnown: true,
        outputComplete: true,
        forcedCleanup: false,
        bounded: true,
        durationMs: 0,
      });
      return;
    }
    const stdout = [];
    const stderr = [];
    let totalOutputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let streamError = null;
    let childError = null;
    let forcedCleanup = false;
    let terminationReason = null;
    let cleanupKnown = false;
    let stdoutClosed = false;
    let stderrClosed = false;
    let streamDrainTimedOut = false;
    let finalized = false;
    let finalizing = false;
    let cleanupPromise = null;
    let timer;
    const started = Date.now();
    const append = (chunks, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = PRIVATE_PROBE_MAX_OUTPUT_BYTES - totalOutputBytes;
      if (remaining <= 0) return true;
      const accepted = buffer.subarray(0, remaining);
      chunks.push(accepted);
      totalOutputBytes += accepted.length;
      return accepted.length !== buffer.length;
    };
    const stopGroup = (signalName) => {
      return killProcessGroup(child?.pid, signalName);
    };
    const cleanupFamily = () => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        if (!child?.pid) {
          cleanupKnown = true;
          return true;
        }
        const hadSurvivingGroup = !processGroupGone(child.pid);
        if (hadSurvivingGroup) {
          // A normal leader exit with a live descendant is still forced
          // cleanup. The result must not look like an ordinary successful
          // probe merely because the descendant later accepted SIGTERM.
          forcedCleanup = true;
          stopGroup("SIGTERM");
          let gone = await waitForGroupGone(child.pid);
          if (!gone) {
            // Do not short-circuit on the earlier TERM signal: a stubborn
            // descendant requires an actual SIGKILL attempt before reaping.
            stopGroup("SIGKILL");
            gone = await waitForGroupGone(child.pid);
          }
          if (!gone) forcedCleanup = true;
        }
        cleanupKnown = processGroupGone(child.pid);
        if (!cleanupKnown) forcedCleanup = true;
        return cleanupKnown;
      })();
      return cleanupPromise;
    };
    const requestTermination = (reason, timedOutReason = false) => {
      forcedCleanup = true;
      terminationReason ||= reason;
      timedOut ||= timedOutReason;
      void cleanupFamily();
    };
    const waitForOutputDrain = async () => {
      const deadlineAt = Date.now() + PRIVATE_PROBE_STREAM_DRAIN_GRACE_MS;
      while ((!stdoutClosed || !stderrClosed) && Date.now() < deadlineAt) {
        await delay(Math.min(PRIVATE_PROBE_POLL_MS, Math.max(1, deadlineAt - Date.now())));
      }
      if (stdoutClosed && stderrClosed) return true;
      streamDrainTimedOut = true;
      streamError ||= "private-probe output streams did not close after leader exit";
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      const destroyDeadline = Date.now() + PRIVATE_PROBE_STREAM_DESTROY_GRACE_MS;
      while ((!stdoutClosed || !stderrClosed) && Date.now() < destroyDeadline) {
        await delay(Math.min(PRIVATE_PROBE_POLL_MS, Math.max(1, destroyDeadline - Date.now())));
      }
      return stdoutClosed && stderrClosed;
    };
    const finish = async (status, signalName, error) => {
      if (finalized || finalizing) return;
      finalizing = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      await cleanupFamily();
      const drained = await waitForOutputDrain();
      finalized = true;
      const finalError = error ?? streamError ?? (forcedCleanup ? terminationReason : null);
      resolveResult({
        status,
        signal: signalName,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        error: finalError || undefined,
        timedOut,
        outputLimitExceeded,
        cleanupKnown,
        outputComplete: drained && !outputLimitExceeded && !streamError && !streamDrainTimedOut,
        forcedCleanup,
        bounded: true,
        durationMs: Date.now() - started,
      });
    };
    const onAbort = () => requestTermination("aggregate private-probe deadline exceeded", true);
    child.stdout.on("data", (chunk) => {
      if (append(stdout, chunk)) {
        outputLimitExceeded = true;
        requestTermination("combined private-probe output limit exceeded");
      }
    });
    child.stderr.on("data", (chunk) => {
      if (append(stderr, chunk)) {
        outputLimitExceeded = true;
        requestTermination("combined private-probe output limit exceeded");
      }
    });
    child.stdout.on("error", (error) => {
      streamError ||= error instanceof Error ? error.message : String(error);
      requestTermination("private-probe stdout stream failed");
    });
    child.stderr.on("error", (error) => {
      streamError ||= error instanceof Error ? error.message : String(error);
      requestTermination("private-probe stderr stream failed");
    });
    child.stdout.once("close", () => { stdoutClosed = true; });
    child.stderr.once("close", () => { stderrClosed = true; });
    const timeoutMs = Math.max(1, Math.min(PRIVATE_PROBE_TIMEOUT_MS, deadline === null ? PRIVATE_PROBE_TIMEOUT_MS : deadline - Date.now()));
    timer = setTimeout(() => requestTermination("private-probe command deadline exceeded", true), timeoutMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.once("error", (error) => {
      childError = error instanceof Error ? error.message : String(error);
      void finish(null, null, childError);
    });
    child.once("exit", (status, signalName) => {
      void finish(status, signalName, childError || streamError);
    });
    child.once("close", (status, signalName) => {
      void finish(status, signalName, childError || streamError);
    });
  });
}

/**
 * Invoke a command runner without abandoning an in-flight child. Runners must
 * honor the fourth argument's deadline/signal and return the complete bounded
 * lifecycle record consumed below.
 */
export async function invokeBounded(commandRunner, command, args, env, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`private probe aggregate deadline exceeded before ${command}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  let result;
  try {
    result = await Promise.resolve(commandRunner(command, args, env, { deadline, signal: controller.signal }));
  } catch (error) {
    throw new Error(`private probe command ${command} failed to return a bounded result: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!result || typeof result !== "object") throw new Error(`private probe command ${command} returned no result`);
  if ((!Number.isInteger(result.status) && result.status !== null) || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw new Error(`private probe command ${command} returned an invalid result shape`);
  }
  if (result.bounded !== true) throw new Error(`private probe command ${command} did not declare bounded execution`);
  for (const field of ["timedOut", "outputLimitExceeded", "cleanupKnown", "outputComplete", "forcedCleanup"]) {
    if (typeof result[field] !== "boolean") throw new Error(`private probe command ${command} omitted explicit ${field} result`);
  }
  if (result.status !== 0 || result.error || result.timedOut || result.outputLimitExceeded || !result.outputComplete || !result.cleanupKnown || result.forcedCleanup) {
    throw new Error(`private probe command ${command} did not complete safely: ${result.error || "timeout, truncation, or uncertain cleanup"}`);
  }
  return result;
}

function full9FromStat(stat) {
  return [
    String(stat.dev),
    String(stat.ino),
    Number(stat.size),
    Number(stat.mode),
    String(stat.mtimeNs),
    String(stat.ctimeNs),
    Number(stat.uid),
    Number(stat.gid),
    Number(stat.nlink),
  ];
}

function sameFull9(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function observeProviderPath(startPath) {
  const requestedPath = resolve(startPath);
  const aliasChain = [];
  const visited = new Set();
  let currentPath = requestedPath;
  for (let depth = 0; depth < 32; depth += 1) {
    if (visited.has(currentPath)) throw new Error(`provider alias cycle at ${currentPath}`);
    visited.add(currentPath);
    const before = lstatSync(currentPath, { bigint: true });
    if (!before.isSymbolicLink()) {
      if (!before.isFile()) throw new Error(`provider terminal is not a regular file: ${currentPath}`);
      return {
        requestedPath,
        terminalPath: currentPath,
        aliasChain,
        terminalFull9: full9FromStat(before),
      };
    }
    const beforeFull9 = full9FromStat(before);
    const rawTarget = readlinkSync(currentPath, "utf8");
    if (!rawTarget || rawTarget.includes("\0") || rawTarget.includes("\\") || rawTarget.length > 512) {
      throw new Error(`provider alias target is invalid at ${currentPath}`);
    }
    const after = lstatSync(currentPath, { bigint: true });
    if (!sameFull9(beforeFull9, full9FromStat(after))) {
      throw new Error(`provider alias changed during readlink: ${currentPath}`);
    }
    aliasChain.push({ path: currentPath, rawTarget, full9: beforeFull9 });
    currentPath = rawTarget.startsWith("/")
      ? resolve(rawTarget)
      : resolve(dirname(currentPath), rawTarget);
  }
  throw new Error(`provider alias depth exceeded at ${requestedPath}`);
}

function providerClassification(row, payloadRoot, target) {
  if (row.status === "interpreter") return "interpreter";
  // The observation contract keeps the role portable. Private-versus-floor
  // ownership is authenticated from the terminal path; the row role remains
  // external-floor for every non-interpreter provider.
  return "external-floor";
}

/**
 * Canonicalize the loader's spelling before using a provider resolution as a
 * map key. `ldd` can retain `$ORIGIN`-derived `../` segments while
 * observeProviderPath resolves them before authenticating the provider; the
 * key must use the same canonical namespace or one provider can be inserted
 * twice under different spellings.
 * @param {string} classification
 * @param {string} soname
 * @param {string} resolvedPath
 * @returns {string}
 */
export function canonicalProviderObservationKey(classification, soname, resolvedPath) {
  return `${classification}\0${soname}\0${resolve(resolvedPath)}`;
}

async function collectFloorObservation({ target, payloadRoot, material, expectedNativePayload, elfRecords, lddRecords, commandRunner, commandDeadline, runtimeEnv }) {
  const observedProviderRows = [];
  const providerByKey = new Map();
  const boundedResults = [];
  for (const row of lddRecords) {
    if (row.status === "missing" || !row.resolvedPath) continue;
    const classification = providerClassification(row, payloadRoot, target);
    const key = canonicalProviderObservationKey(classification, row.soname, row.resolvedPath);
    if (providerByKey.has(key)) continue;
    const pathTable = observeProviderPath(row.resolvedPath);
    // The descriptor reader authenticates the bytes/hash through the held FD;
    // the complete terminal frame is independently checked before and after
    // that body read.
    const snapshot = readRegularSnapshot(pathTable.terminalPath, {
      follow: false,
      bindPath: true,
      label: `resolved provider ${row.soname}`,
      maxBytes: 512 * 1024 * 1024,
    });
    const terminalAfter = full9FromStat(lstatSync(pathTable.terminalPath, { bigint: true }));
    if (!sameFull9(pathTable.terminalFull9, terminalAfter)) {
      throw new Error(`resolved provider ${row.soname} changed during observation`);
    }
    const readelf = await invokeBounded(commandRunner, "readelf", ["-h", "-V", "--wide", pathTable.terminalPath], undefined, commandDeadline);
    if (readelf.status !== 0) throw new Error(`readelf failed for resolved provider ${row.soname}: ${readelf.stderr || readelf.error || "nonzero status"}`);
    const parsed = parseElfMetadata(readelf.stdout, target);
    const provider = {
      soname: row.soname,
      classification,
      requestedPath: pathTable.requestedPath,
      terminalPath: pathTable.terminalPath,
      aliasChain: pathTable.aliasChain,
      terminalFull9: pathTable.terminalFull9,
      bytes: snapshot.size,
      sha256: snapshot.sha256,
      elfMachine: parsed.machine,
      elfClass: parsed.class,
      versionDefinitions: parsed.versionDefinitions,
      readelfEvidenceSha256: createHash("sha256").update(readelf.stdout).update(readelf.stderr).digest("hex"),
    };
    const providerId = identity(provider);
    providerByKey.set(key, { provider, providerId });
    observedProviderRows.push(provider);
    boundedResults.push({ role: "provider-readelf", command: "readelf", args: ["-h", "-V", "--wide"], status: readelf.status, stdoutBytes: readelf.stdout.length, stderrBytes: readelf.stderr.length, cleanupKnown: readelf.cleanupKnown ?? true });
  }
  const subjectResolutionRows = [];
  for (const row of lddRecords) {
    if (row.status === "missing" || !row.resolvedPath) continue;
    const subjectRelativePath = row.subjectRelativePath;
    const meta = typeof subjectRelativePath === "string" ? elfRecords[subjectRelativePath] : undefined;
    if (!meta) throw new Error(`ldd provider row is missing an authenticated subject: ${row.soname}`);
    if (!(meta.needed ?? []).includes(row.soname)) continue;
    const classification = providerClassification(row, payloadRoot, target);
    const found = providerByKey.get(canonicalProviderObservationKey(classification, row.soname, row.resolvedPath));
    if (found) {
      subjectResolutionRows.push({
        subjectRelativePath,
        neededSoname: row.soname,
        resolvedPath: found.provider.terminalPath,
        providerObservationIdentity: found.providerId,
      });
    }
  }
  const unsigned = {
    schema: "nebular-native-runtime-consumer-floor-observation-v1",
    target,
    materialDigest: material.materialDigest,
    expectedNativePayload,
    observedProviderRows,
    subjectResolutionRows,
    toolEvidence: {
      readelfRole: "actual-provider-terminal-readelf",
      resolutionToolRole: "actual-consumer-ldd",
      boundedResults,
      cleanupFacts: { allCommandsBounded: true, noSurvivingProcessFamily: boundedResults.every((row) => row.cleanupKnown) },
    },
  };
  return { ...unsigned, observationIdentity: identity(unsigned) };
}

export function paths(platform, payload) {
  if (platform.os === "darwin") {
    const app = join(payload, "Theme Forge Nebular Fusion.app");
    return { app, executable: join(app, "Contents/MacOS/theme-forge-nebular-fusion"), sidecar: join(app, "Contents/MacOS/tfsb-studio-service"),
      launcher: join(app, "Contents/Resources/bin/tfnf"), resources: join(app, "Contents/Resources") };
  }
  return { executable: join(payload, "bin/theme-forge-nebular-fusion"), sidecar: join(payload, "bin/tfsb-studio-service"),
    launcher: join(payload, "bin/tfnf"), resources: join(payload, "lib/theme-forge-nebular-fusion") };
}

/**
 * Authenticate the two files that the Linux raw archive carries beside its payload.
 * The native payload identity intentionally covers only the payload tree; any other
 * archive-root entry remains visible to inventory and therefore fails closed.
 * @param {string} payloadRoot
 * @param {string} checkout
 * @returns {Promise<Record<string, { bytes: number, mode: number, sha256: string, full9: (string|number)[] }> | null>}
 */
export async function readLinuxArchiveLegalEnvelope(payloadRoot, checkout) {
  const names = ["LICENSE", "NOTICE"];
  const present = names.map((name) => {
    try {
      lstatSync(join(payloadRoot, name), { bigint: true });
      return name;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return null;
      throw error;
    }
  });
  const presentCount = present.filter(Boolean).length;
  if (presentCount === 0) return null;
  if (presentCount !== names.length) {
    throw new Error("Linux raw archive legal envelope must contain both LICENSE and NOTICE");
  }
  /** @type {Record<string, { bytes: number, mode: number, sha256: string, full9: (string|number)[] }>} */
  const envelope = {};
  for (const name of names) {
    const shipped = await readRegularDescriptorChecked(join(payloadRoot, name), 4 * 1024 * 1024);
    if (shipped.mode !== 0o644) throw new Error(`Archive ${name} must have mode 0644`);
    const source = readRegularSnapshot(join(checkout, name), {
      label: `Source ${name}`,
      bindPath: true,
      maxBytes: 4 * 1024 * 1024,
    });
    if (!source || !shipped.buffer.equals(source.bytes)) throw new Error(`${name} differs from the source legal envelope`);
    envelope[name] = { bytes: shipped.bytes, mode: shipped.mode, sha256: shipped.sha256, full9: shipped.full9 };
  }
  return envelope;
}

/**
 * @param {{
 *   platform: string,
 *   payload: string,
 *   checkout: string,
 *   nativeRuntime?: string,
 *   nativeRuntimeSha256?: string,
 *   expectedNativePayloadSha256?: string,
 *   observationOutputDir?: string,
 *   sourceCandidate?: string,
 *   archiveLegalEnvelope?: boolean,
 *   commandRunner?: (command: string, args: string[], env?: Record<string, string>, options?: { deadline: number, signal: AbortSignal }) => Promise<{ status: number | null, stdout: string, stderr: string, error?: string, bounded: true, timedOut: boolean, outputLimitExceeded: boolean, cleanupKnown: boolean, outputComplete: boolean, forcedCleanup: boolean }> | { status: number | null, stdout: string, stderr: string, error?: string, bounded: true, timedOut: boolean, outputLimitExceeded: boolean, cleanupKnown: boolean, outputComplete: boolean, forcedCleanup: boolean }
 * }} options
 */
export async function qualifyPayload({
  platform: key,
  payload,
  checkout,
  nativeRuntime,
  nativeRuntimeSha256,
  expectedNativePayloadSha256,
  observationOutputDir,
  sourceCandidate,
  archiveLegalEnvelope = false,
  commandRunner = run,
}) {
  const platform = PLATFORMS[key];
  if (!platform) throw new Error(`Unsupported platform ${key}`);
  if (typeof archiveLegalEnvelope !== "boolean") {
    throw new Error("archiveLegalEnvelope must be a boolean");
  }
  if (archiveLegalEnvelope && platform.os !== "linux") {
    throw new Error("Archive legal envelope normalization is supported only for Linux qualification");
  }
  if (sourceCandidate !== undefined && observationOutputDir === undefined) {
    throw new Error("sourceCandidate requires observationOutputDir");
  }
  if (observationOutputDir !== undefined) {
    if (platform.os !== "linux") {
      throw new Error("Observation export is supported only for Linux qualification");
    }
    if (typeof sourceCandidate !== "string" || !HEX64_RE.test(sourceCandidate)) {
      throw new Error("Observation export requires a lowercase 64-hex sourceCandidate identity");
    }
    validateObservationOutputPath(observationOutputDir, payload);
  }
  const resolvedPayload = resolve(payload);
  // Naked producer/R3B/npm qualification remains the ordinary inventory path.
  // Only the hosted raw-archive caller may opt into the two archive-root legal
  // files that are outside the native payload identity.
  const rootEnvelope = archiveLegalEnvelope ? await readLinuxArchiveLegalEnvelope(resolvedPayload, checkout) : null;
  const hasRuntimeInput = nativeRuntime !== undefined || nativeRuntimeSha256 !== undefined;
  const hasExpectedPayload = expectedNativePayloadSha256 !== undefined;
  if (hasRuntimeInput && (typeof nativeRuntime !== "string" || !nativeRuntime || typeof nativeRuntimeSha256 !== "string" || !nativeRuntimeSha256)) {
    throw new Error("--native-runtime and --native-runtime-sha256 must be supplied together");
  }
  if (hasRuntimeInput && hasExpectedPayload) {
    throw new Error("Supply either paired (--native-runtime, --native-runtime-sha256) or --expected-native-payload-sha256, not both");
  }
  if (hasRuntimeInput && platform.os !== "linux") {
    throw new Error(`Private native runtime is not supported on ${platform.os}`);
  }
  if (hasExpectedPayload && (typeof expectedNativePayloadSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(expectedNativePayloadSha256))) {
    throw new Error("expectedNativePayloadSha256 must be a lowercase 64-hex SHA-256 string");
  }

  const authenticatedRuntime = hasRuntimeInput
    ? await authenticateNativeRuntimeInput(nativeRuntime, nativeRuntimeSha256, {
        expectedTarget: platform.triple,
        outputRoots: [resolvedPayload],
      })
    : null;

  let primaryError = null;
  let capturedObservations = null;
  let runtimeSnapshotVerified = false;
  try {
    const runtimeSelection = await selectPayloadNativeRuntime(
      resolvedPayload,
      platform.os === "linux" ? platform.triple : null,
      { rootEnvelope },
    );
    let payloadInventory = null;
    if (runtimeSelection.nativeRuntime) {
      if (!authenticatedRuntime && !hasExpectedPayload) {
        throw new Error(
          "Private native runtime payload qualification requires either paired (--native-runtime, --native-runtime-sha256) or --expected-native-payload-sha256 authority",
        );
      }
      if (
        authenticatedRuntime &&
        runtimeSelection.material.materialDigest !== authenticatedRuntime.material.materialDigest
      ) {
        throw new Error(
          `Payload runtime materialDigest ${runtimeSelection.material.materialDigest} does not match authenticated runtime input ${authenticatedRuntime.material.materialDigest}`,
        );
      }
      if (hasExpectedPayload && runtimeSelection.inventory.identity !== expectedNativePayloadSha256) {
        throw new Error(
          `Payload native inventory identity ${runtimeSelection.inventory.identity} does not match expected ${expectedNativePayloadSha256}`,
        );
      }
      payloadInventory = runtimeSelection.inventory;
    } else {
      if (authenticatedRuntime) {
        throw new Error("Authenticated native runtime input was supplied, but payload does not contain a private runtime");
      }
      if (observationOutputDir !== undefined) {
        throw new Error("Observation export requires a passing private-runtime closure");
      }
      if (platform.os === "linux" || hasExpectedPayload) {
        const ordinaryInventory = await inventoryNativePayload(resolvedPayload, { rootEnvelope });
        payloadInventory = selectPayloadInventoryForQualification(platform, {
          hasExpectedPayload,
          ordinaryInventory,
          expectedNativePayloadSha256,
        });
      }
    }

    const located = paths(platform, resolvedPayload);
    const checks = [];
    const check = async (id, fn) => {
      try { checks.push({ id, ok: true, detail: (await fn()) ?? "" }); } catch (error) { checks.push({ id, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
    };
    const executable = readRegularSnapshot(located.executable, { label: "GUI executable", maxBytes: 1024 * 1024 * 1024 });
    await check("executable-header", () => { verifyNativeExecutableHeader(executable.bytes, platform); if (!executable.executable) throw new Error("GUI executable is not executable"); return executable.sha256; });
    await check("launcher", () => {
      const launcher = readRegularSnapshot(located.launcher, { label: "Launcher" });
      const expectedLauncher = nativeLauncher(platform.target, { nativeRuntime: runtimeSelection.nativeRuntime });
      if (!launcher.bytes.equals(Buffer.from(expectedLauncher)) || !launcher.executable) throw new Error("launcher differs from the maintained launcher or is not executable");
      return launcher.sha256;
    });
    await check("sidecar-runtime", () => {
      const expected = NODE_RELEASE_IDENTITY.targets[platform.triple];
      const sidecar = readRegularSnapshot(located.sidecar, { label: "Sidecar runtime", maxBytes: 512 * 1024 * 1024 });
      if (sidecar.sha256 !== expected.executableSha256 || sidecar.size !== expected.executableSize || !sidecar.executable) {
        throw new Error(`bundled sidecar ${sidecar.sha256} is not the authenticated Node ${NODE_RELEASE_IDENTITY.version} runtime`);
      }
      return `node ${NODE_RELEASE_IDENTITY.version} ${sidecar.sha256}`;
    });
    const config = JSON.parse(readFileSync(join(checkout, "src-tauri/tauri.conf.json"), "utf8"));
    for (const directory of resourceDirectories(config)) {
      await check(`resource:${directory}`, async () => {
        const shipped = (await inventoryTree(join(located.resources, directory))).identity;
        const prepared = (await inventoryTree(join(checkout, "src-tauri", directory))).identity;
        if (shipped !== prepared) throw new Error("shipped resource differs from the prepared resource");
        return shipped;
      });
    }
    let glibcMinimum = null;
    if (platform.os === "linux") {
      const commandDeadline = Date.now() + PRIVATE_PROBE_AGGREGATE_TIMEOUT_MS;
      let runtimeEnv;
      if (runtimeSelection.nativeRuntime) {
        await check("private-graphics-provider-material", async () => {
          const graphics = await validatePrivateGraphicsPayload(resolvedPayload, runtimeSelection.material);
          runtimeEnv = await createPrivateRuntimeEnvironment(resolvedPayload, {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            LANG: "C",
            LC_ALL: "C",
          }, runtimeSelection.material);
          return graphics;
        });
      }
      for (const [id, path] of [["mode:gui", located.executable], ["mode:sidecar", located.sidecar], ["mode:launcher", located.launcher]]) {
        await check(id, () => { const file = readRegularSnapshot(path, { label: id, maxBytes: 512 * 1024 * 1024 }); if ((file.mode & 0o777) !== 0o755) throw new Error(`mode ${(file.mode & 0o777).toString(8)}`); return "0755"; });
      }
      const floors = [];
      for (const [id, path] of [["glibc:gui", located.executable], ["glibc:sidecar", located.sidecar]]) {
        await check(id, async () => {
          const result = await invokeBounded(commandRunner, "readelf", ["--version-info", "--wide", path], undefined, commandDeadline);
          if (result.status !== 0) throw new Error(`readelf failed: ${result.stderr || result.error}`);
          const floor = glibcFloor(result.stdout);
          floors.push(floor);
          return floor;
        });
      }
      await check("glibc-floor", () => {
        if (floors.length !== 2) throw new Error("glibc requirements were not measured");
        glibcMinimum = floors.sort(compareVersions).at(-1).split(".").slice(0, 2).join(".");
        if (compareVersions(glibcMinimum, GLIBC_CEILING) > 0) throw new Error(`glibc floor ${glibcMinimum} exceeds the ${GLIBC_CEILING} build environment`);
        return glibcMinimum;
      });
      await check("linkage", async () => {
        const result = await invokeBounded(commandRunner, "ldd", [located.executable], runtimeEnv, commandDeadline);
        if (result.status !== 0) throw new Error(`ldd failed: ${result.stderr || result.error}`);
        if (/not found/.test(result.stdout)) throw new Error(`unresolved libraries: ${result.stdout.split("\n").filter((line) => line.includes("not found")).join("; ")}`);
        const readelf = await invokeBounded(commandRunner, "readelf", ["-d", "--wide", located.executable], undefined, commandDeadline);
        const needed = readelf.stdout.match(/\(NEEDED\).*\[(.*)\]/g) ?? [];
        return needed.map((line) => line.replace(/.*\[(.*)\].*/, "$1")).sort().join(",");
      });
      if (runtimeSelection.nativeRuntime) {
        await check("private-runtime-closure", async () => {
          if (!runtimeEnv) throw new Error("Private graphics provider environment was not admitted");
          const elfRecords = {};
          const allLddRows = [];
          /** @type {Array<Record<string, any>>} */
          const portabilityRecords = [];
          /** @type {Map<string, { relativePath: string, absolutePath: string, snapshot: { size: number, sha256: string, header: Buffer }, aliases: string[] }>} */
          const elfTargetByPath = new Map();
          /** @type {Map<string, { path: string, bytes: number, sha256: string }>} */
          const inventoryFilesByPath = new Map(runtimeSelection.inventory.files.map((file) => [file.path, file]));
          /** @type {Map<string, { size: number, sha256: string, header: Buffer }>} */
          const snapshotsByPath = new Map();
          /** @type {Map<string, string[]>} */
          const aliasesByCanonical = new Map();
          for (const alias of runtimeSelection.inventory.aliases) {
            const rows = aliasesByCanonical.get(alias.canonical) ?? [];
            rows.push(alias.path);
            aliasesByCanonical.set(alias.canonical, rows);
          }
          for (const rows of aliasesByCanonical.values()) rows.sort();
          /**
           * Read only authenticated inventory members. The inventory was already
           * admitted as a complete payload; this pass names those rows directly
           * and binds each held snapshot back to its authenticated bytes/hash.
           * @param {string} relativePath
           * @param {{ size: number, sha256: string, bytes: Buffer } | undefined} [suppliedSnapshot]
           */
          const readInventoryRegular = (relativePath, suppliedSnapshot = undefined) => {
            const inventoryFile = inventoryFilesByPath.get(relativePath);
            if (!inventoryFile) throw new Error(`Authenticated payload inventory is missing regular ${relativePath}`);
            const existing = snapshotsByPath.get(relativePath);
            if (existing) return existing;
            const fullSnapshot = suppliedSnapshot ?? readRegularSnapshot(join(resolvedPayload, relativePath), {
              label: relativePath,
              maxBytes: 512 * 1024 * 1024,
            });
            if (fullSnapshot.size !== inventoryFile.bytes || fullSnapshot.sha256 !== inventoryFile.sha256) {
              throw new Error(`Authenticated payload inventory mismatch at ${relativePath}`);
            }
            // Keep only the authenticated identity and an owned header copy;
            // Buffer.subarray() would retain the complete backing payload.
            const compactSnapshot = {
              size: fullSnapshot.size,
              sha256: fullSnapshot.sha256,
              header: Buffer.from(fullSnapshot.bytes.subarray(0, 64)),
            };
            snapshotsByPath.set(relativePath, compactSnapshot);
            return compactSnapshot;
          };
          /**
           * @param {string} relativePath
           * @param {string} absolutePath
           * @param {{ size: number, sha256: string, header: Buffer }} snapshot
           * @param {string[]} [aliases]
           */
          const addElfTarget = (relativePath, absolutePath, snapshot, aliases = []) => {
            const existing = elfTargetByPath.get(absolutePath);
            if (existing) {
              existing.aliases = [...new Set([...existing.aliases, ...aliases])].sort();
              return;
            }
            elfTargetByPath.set(absolutePath, { relativePath, absolutePath, snapshot, aliases: [...aliases].sort() });
          };
          const executableInventory = readInventoryRegular("bin/theme-forge-nebular-fusion", executable);
          addElfTarget(
            "bin/theme-forge-nebular-fusion",
            located.executable,
            executableInventory,
            aliasesByCanonical.get("bin/theme-forge-nebular-fusion") ?? [],
          );
          const sidecarSnapshot = readRegularSnapshot(located.sidecar, { label: "sidecar runtime", maxBytes: 512 * 1024 * 1024 });
          const sidecarInventory = readInventoryRegular("bin/tfsb-studio-service", sidecarSnapshot);
          addElfTarget(
            "bin/tfsb-studio-service",
            located.sidecar,
            sidecarInventory,
            aliasesByCanonical.get("bin/tfsb-studio-service") ?? [],
          );
          for (const reg of runtimeSelection.material.regulars) {
            const absReg = join(resolvedPayload, reg.path);
            const snap = readInventoryRegular(reg.path);
            const isElf = snap.header.length >= 4 && snap.header[0] === 0x7f && snap.header[1] === 0x45 && snap.header[2] === 0x4c && snap.header[3] === 0x46;
            if (reg.role || isElf) {
              verifyNativeExecutableHeader(snap.header, platform);
              addElfTarget(reg.path, absReg, snap, aliasesByCanonical.get(reg.path) ?? []);
            }
          }
          // Observe every additional ELF regular named by the authenticated
          // payload inventory, including resources or sidecars outside the
          // private-runtime material roles. No second filesystem walk occurs.
          for (const file of runtimeSelection.inventory.files) {
            const snap = readInventoryRegular(file.path);
            const isElf = snap.header.length >= 4 && snap.header[0] === 0x7f && snap.header[1] === 0x45 && snap.header[2] === 0x4c && snap.header[3] === 0x46;
            if (!isElf) continue;
            const absFile = join(resolvedPayload, file.path);
            if (elfTargetByPath.has(absFile)) continue;
            verifyNativeExecutableHeader(snap.header, platform);
            addElfTarget(file.path, absFile, snap, aliasesByCanonical.get(file.path) ?? []);
          }
          for (const { relativePath: relPath, absolutePath: absPath, snapshot, aliases } of elfTargetByPath.values()) {
            const readelfRes = await invokeBounded(commandRunner, "readelf", [...ELF_PORTABILITY_READELF_ARGS, absPath], undefined, commandDeadline);
            if (readelfRes.status !== 0) throw new Error(`readelf failed for ${relPath}: ${readelfRes.stderr || readelfRes.error}`);
            elfRecords[relPath] = parseElfMetadata(readelfRes.stdout, platform.triple);
            portabilityRecords.push(buildElfPortabilityObservation({
              relativePath: relPath,
              aliases,
              target: platform.triple,
              bytes: snapshot.size,
              sha256: snapshot.sha256,
              stdout: readelfRes.stdout,
              stderr: readelfRes.stderr,
            }));
            const lddRes = await invokeBounded(commandRunner, "ldd", [absPath], runtimeEnv, commandDeadline);
            if (lddRes.status !== 0) throw new Error(`ldd failed for ${relPath}: ${lddRes.stderr || lddRes.error}`);
            allLddRows.push(...parseLddProviders(lddRes.stdout).map((row) => ({ ...row, subjectRelativePath: relPath })));
          }
          const floorObservation = await collectFloorObservation({
            target: platform.triple,
            payloadRoot: resolvedPayload,
            material: runtimeSelection.material,
            expectedNativePayload: runtimeSelection.inventory.identity,
            elfRecords,
            lddRecords: allLddRows,
            commandRunner,
            commandDeadline,
            runtimeEnv,
          });
          const closure = classifyAndValidateRuntimeClosure({
            target: platform.triple,
            payloadRoot: resolvedPayload,
            material: runtimeSelection.material,
            elfRecords,
            lddRecords: allLddRows,
            floorObservation,
            expectedNativePayload: runtimeSelection.inventory.identity,
          });
          if (!closure.ok) throw new Error(closure.problems.join("; "));
          if (closure.maxGlibcObserved) {
            const normalizedFloor = closure.maxGlibcObserved.split(".").slice(0, 2).join(".");
            if (!glibcMinimum || compareVersions(normalizedFloor, glibcMinimum) > 0) {
              glibcMinimum = normalizedFloor;
            }
            if (compareVersions(closure.maxGlibcObserved, GLIBC_CEILING) > 0) {
              throw new Error(`glibc floor ${closure.maxGlibcObserved} exceeds the ${GLIBC_CEILING} build environment`);
            }
          }
          const portabilityUnsigned = {
            schema: "nebular-native-elf-portability-observation-set-v1",
            target: platform.triple,
            expectedNativePayload: runtimeSelection.inventory.identity,
            readelfArgs: [...ELF_PORTABILITY_READELF_ARGS],
            records: portabilityRecords.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)),
            admission: "not-claimed",
          };
          const portabilityObservation = {
            ...portabilityUnsigned,
            identity: identity(portabilityUnsigned),
          };
          capturedObservations = { floorObservation, portabilityObservation };
          return {
            materialDigest: runtimeSelection.material.materialDigest,
            observationIdentity: floorObservation.observationIdentity,
            observedProviderRows: floorObservation.observedProviderRows,
            subjectResolutionRows: floorObservation.subjectResolutionRows,
            toolEvidence: floorObservation.toolEvidence,
            classifications: closure.classifications,
            portabilityObservation,
          };
        });
      }
    } else {
      await check("legal-notices", () => {
        for (const name of ["LICENSE", "NOTICE"]) {
          const shipped = readRegularSnapshot(join(located.resources, name), { label: name });
          const source = readRegularSnapshot(join(checkout, name), { label: `Source ${name}` });
          if (!shipped.bytes.equals(source.bytes)) throw new Error(`${name} differs from the source notice`);
        }
        return "LICENSE, NOTICE";
      });
      await check("codesign", async () => {
        const deadline = Date.now() + PRIVATE_PROBE_TIMEOUT_MS;
        const verify = await invokeBounded(commandRunner, "codesign", ["--verify", "--deep", "--strict", "--verbose=2", located.app], undefined, deadline);
        if (verify.status !== 0) throw new Error(`codesign verification failed: ${verify.stderr || verify.error}`);
        const described = await invokeBounded(commandRunner, "codesign", ["-dv", "--verbose=4", located.app], undefined, deadline);
        const signature = /Signature=(\S+)/.exec(described.stderr)?.[1] ?? "unknown";
        return `valid · Signature=${signature}`;
      });
    }
    const passed = checks.every((entry) => entry.ok);
    const nativePayload = payloadInventory
      ? { identity: payloadInventory.identity, files: payloadInventory.files.length }
      : null;
    const materialDigest = runtimeSelection.nativeRuntime ? runtimeSelection.material.materialDigest : null;
    const result = {
      schema: "nebular.native-rc-qualification-v1",
      platform: key,
      status: passed ? "pass" : "fail",
      executableSha256: executable.sha256,
      glibcMinimum,
      nativePayload,
      materialDigest,
      checks,
    };
    if (authenticatedRuntime) {
      runtimeSnapshotVerified = true;
      await verifyRuntimeSourceSnapshot(authenticatedRuntime);
    }
    if (passed && observationOutputDir !== undefined) {
      if (!capturedObservations) throw new Error("Observation export requires a passing private-runtime closure");
      writeObservationExport({
        outputDir: observationOutputDir,
        payloadRoot: resolvedPayload,
        platform,
        sourceCandidate,
        result,
        floorObservation: capturedObservations.floorObservation,
        portabilityObservation: capturedObservations.portabilityObservation,
        runtimeInputSha256: authenticatedRuntime?.inputSha256,
      });
    }
    return result;
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    if (authenticatedRuntime && !runtimeSnapshotVerified) {
      try {
        await verifyRuntimeSourceSnapshot(authenticatedRuntime);
      } catch (postErr) {
        if (!primaryError) throw postErr;
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return next;
  };
  try {
    const result = await qualifyPayload({
      platform: value("--platform"),
      payload: value("--payload"),
      checkout: value("--checkout") ?? ".",
      nativeRuntime: value("--native-runtime"),
      nativeRuntimeSha256: value("--native-runtime-sha256"),
      expectedNativePayloadSha256: value("--expected-native-payload-sha256"),
      observationOutputDir: value("--observation-output-dir"),
      sourceCandidate: value("--source-candidate"),
      archiveLegalEnvelope: args.includes("--archive-legal-envelope"),
    });
    if (value("--output")) writeFileSync(resolve(value("--output")), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ status: result.status, glibcMinimum: result.glibcMinimum, failed: result.checks.filter((entry) => !entry.ok) })}\n`);
    if (result.status !== "pass") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
