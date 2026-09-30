// Product targets, deliberately narrower than Burst's historical target set.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function requireCandidateVersion(version) {
  const number = "(?:0|[1-9][0-9]*)";
  const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
  const semver = new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  if (typeof version !== "string" || !semver.test(version)) throw new Error("Valid studio candidate version is required");
  return version;
}

export function readCandidateVersion(studioRoot = fileURLToPath(new URL("../", import.meta.url))) {
  return requireCandidateVersion(JSON.parse(readFileSync(join(studioRoot, "package.json"), "utf8")).version);
}

export const CANDIDATE_VERSION = readCandidateVersion();
export const APPLICATION_NAME = "theme-forge-nebular-fusion";

// Raw Linux staging uses the same declaration as Tauri's macOS bundler.
// Reject new resource shapes until their raw-layout semantics are implemented.
export function resourceDirectories(config) {
  const resources = config.bundle?.resources;
  if (!Array.isArray(resources) || !resources.length
      || resources.some(path => typeof path !== "string" || !/^[a-zA-Z0-9_-]+\/\*\*\/\*$/.test(path))
      || new Set(resources).size !== resources.length) {
    throw new Error("Unsupported Tauri resource declaration for raw staging");
  }
  return resources.map(path => path.slice(0, -5));
}

// Preparation ownership is keyed by Tauri's resource membership. Every current
// resource applies to all product targets; an omission is never implicit.
export const RESOURCE_PREPARERS = Object.freeze({
  "sidecar-payload": "sidecar",
  "loom-payload": "loom",
  "loom-adapter": "source",
  "solar-sail-payload": "solar",
  "solar-sail-adapter": "source",
  "scene-payload": "scene",
  "release-notices": "notices",
});

export function resourcePreparationPlan(config, target) {
  if (!TARGETS.includes(target)) throw new Error("Unknown preparation target");
  const directories = resourceDirectories(config);
  if (JSON.stringify([...directories].sort()) !== JSON.stringify(Object.keys(RESOURCE_PREPARERS).sort())) {
    throw new Error("Tauri resource membership and preparation ownership disagree");
  }
  return directories.map(directory => ({ directory, preparer: RESOURCE_PREPARERS[directory], applicable: true, target: target.triple }));
}
export const TARGETS = Object.freeze([
  Object.freeze({ system: "aarch64-darwin", triple: "aarch64-apple-darwin", os: "darwin", cpu: "arm64", addon: "darwin-arm64", format: "app.tar.gz" }),
  Object.freeze({ system: "aarch64-linux", triple: "aarch64-unknown-linux-gnu", os: "linux", cpu: "arm64", addon: "linux-arm64-gnu", format: "tar.gz" }),
  Object.freeze({ system: "x86_64-linux", triple: "x86_64-unknown-linux-gnu", os: "linux", cpu: "x64", addon: "linux-x64-gnu", format: "tar.gz" }),
]);

export function targetForHost(os = process.platform, cpu = process.arch) {
  const target = TARGETS.find(target => target.os === os && target.cpu === cpu);
  if (!target) throw new Error(`Unsupported Nebular target: ${os}/${cpu}`);
  if (os === "linux" && os === process.platform && cpu === process.arch
      && !process.report.getReport().header.glibcVersionRuntime) {
    throw new Error("Nebular requires GNU/glibc Linux");
  }
  return target;
}

export function targetForTriple(triple) {
  const target = TARGETS.find(target => target.triple === triple);
  if (!target) throw new Error("Unsupported Nebular Rust target");
  return target;
}

export function payloadLayout(target) {
  if (!TARGETS.includes(target)) throw new Error("Unknown product target");
  return target.os === "darwin"
    ? { executable: `Theme Forge Nebular Fusion.app/Contents/MacOS/${APPLICATION_NAME}`, resources: "Theme Forge Nebular Fusion.app/Contents/Resources" }
    : { executable: `bin/${APPLICATION_NAME}`, resources: `lib/${APPLICATION_NAME}` };
}


export function parseRustcHostTriple(verbose) {
  if (typeof verbose !== "string") throw new Error("rustc -vV output is required");
  const matches = [...verbose.matchAll(/^host:\s*(\S+)\s*$/gm)];
  if (matches.length !== 1) throw new Error("rustc -vV must expose exactly one host triple");
  return matches[0][1];
}

export function tauriRustTargetPlan({ sourceMode, productTriple, rustcVerbose }) {
  if (typeof productTriple !== "string" || !productTriple) {
    throw new Error("Product Rust target triple is required");
  }

  if (sourceMode !== "nix-source" && sourceMode !== "portable-source") {
    return Object.freeze({
      hostTriple: null,
      tauriArgs: Object.freeze(["--target", productTriple]),
      nestedCargoTargetDir: false,
      mode: "explicit-target",
    });
  }

  const hostTriple = parseRustcHostTriple(rustcVerbose);
  if (hostTriple === productTriple) {
    return Object.freeze({
      hostTriple,
      tauriArgs: Object.freeze([]),
      nestedCargoTargetDir: true,
      mode: sourceMode === "nix-source" ? "nix-native-host" : "portable-native-host",
    });
  }

  return Object.freeze({
    hostTriple,
    tauriArgs: Object.freeze(["--target", productTriple]),
    nestedCargoTargetDir: false,
    mode: sourceMode === "nix-source" ? "nix-explicit-cross-target" : "portable-explicit-cross-target",
  });
}
