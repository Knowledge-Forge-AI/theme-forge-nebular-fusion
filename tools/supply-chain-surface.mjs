// Nebular Fusion supply-chain scan surface.
//
// The public supply-chain job runs as a peer of the frontend and macOS jobs, so it cannot consume
// their artifacts. It rebuilds the shipped inputs itself with the same maintained preparation steps
// (frontend build, authenticated Node runtime, sidecar/Loom/scene/Solar Sail payloads) and this helper
// lays them out as the release surface that Syft and Grype scan:
//
//   frontend/frontend-dist.tar.gz, frontend/install/**        the built frontend distributable
//   runtime/node-runtime, runtime/catalog/node                 the authenticated embedded Node runtime
//   runtime/node-authenticity/{receipt.json,SHASUMS256.txt.asc}
//   sidecar/sidecar-payload.tar.gz, sidecar/extracted/**       the sidecar payload archive and its members
//   resources/<name>/**                                        every Tauri bundle resource directory
//
// release-surface.json records every file (size, SHA-256) and the declared omissions: the Tauri main
// executable, Info.plist and code-signing metadata (not package inputs; Rust dependencies are scanned
// from the Cargo.lock inventory) and the release-notices license texts (no package manifests).
//
// `cross-check` runs in the evidence aggregate after every producer succeeded and proves, per run, that
// the scanned runtime, sidecar payload, bundle resources and frontend distributable are byte-identical
// to the macOS application bundle and the frontend artifact that the same run produced.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SURFACE_SCHEMA = "tfsb.nebular-supply-chain-surface-v1";
export const CROSS_CHECK_SCHEMA = "tfsb.nebular-supply-chain-surface-cross-check-v1";
export const OMITTED_RESOURCES = Object.freeze({
  "release-notices": "License and notice texts generated from the locked Cargo registry and npm metadata; they contain no package manifests. Rust dependencies are scanned from the Cargo.lock inventory.",
});
export const DECLARED_OMISSIONS = Object.freeze([
  Object.freeze({ path: "Contents/MacOS/theme-forge-nebular-fusion", reason: "Tauri main executable; not cargo-auditable, so Syft cannot catalog it. Its Rust dependencies are scanned from src-tauri/Cargo.lock (rust-lock inventory) and by cargo audit." }),
  Object.freeze({ path: "Contents/MacOS/tfsb-studio-service", reason: "Bundled copy of the authenticated Node runtime; scanned as runtime/node-runtime and runtime/catalog/node, which the cross-check binds to the producer node-runtime." }),
  Object.freeze({ path: "Contents/Info.plist, Contents/_CodeSignature/**, bundle-identity.json, signing-facts.json", reason: "Bundle identity and signing metadata; not package inputs." }),
  Object.freeze({ path: "sidecar-transcript.json", reason: "Protocol transcript test output; not a shipped package input." }),
  Object.freeze({ path: "resources/release-notices/**", reason: OMITTED_RESOURCES["release-notices"] }),
]);

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function portable(path) {
  return path.split(sep).join("/");
}

async function readRegular(path) {
  const handle = await open(path, READ_FLAGS);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`surface input must be a regular file: ${path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      throw new Error(`surface input changed while it was read: ${path}`);
    }
    return { bytes, mode: before.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function writeNew(path, bytes, mode) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, CREATE_FLAGS, mode);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

/** Lists every regular file below a directory; symbolic links and special files are rejected. */
export async function treeFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`surface trees cannot contain symbolic links: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`surface trees cannot contain special files: ${path}`);
    }
  }
  await visit(root);
  return files;
}

// macOS tar stores extended attributes as AppleDouble "._<name>" members; extracted elsewhere they
// become metadata files that are not shipped content, so comparisons exclude (and count) them.
const isAppleDouble = (path) => path.split("/").pop().startsWith("._");

/** Maps each file below root to its SHA-256, keyed by portable relative path. */
export async function treeInventory(root) {
  const inventory = new Map();
  for (const path of await treeFiles(root)) inventory.set(portable(relative(root, path)), sha256((await readRegular(path)).bytes));
  return inventory;
}

function withoutAppleDouble(inventory) {
  const kept = new Map([...inventory].filter(([path]) => !isAppleDouble(path)));
  return { kept, ignored: inventory.size - kept.size };
}

async function copyFile(source, destination) {
  const { bytes, mode } = await readRegular(source);
  await writeNew(destination, bytes, mode);
}

async function copyTree(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`surface source must be a real directory: ${source}`);
  for (const path of await treeFiles(source)) await copyFile(path, join(destination, relative(source, path)));
}

/** Resource directory names bundled by tauri.conf.json (patterns of the form "<name>/**\/*"). */
export function bundleResourceNames(tauriConfig) {
  const resources = tauriConfig?.bundle?.resources;
  if (!Array.isArray(resources) || resources.length === 0) throw new Error("tauri.conf.json must declare bundle resources");
  return resources.map((pattern) => {
    const match = /^([A-Za-z0-9._-]+)\/\*\*\/\*$/u.exec(pattern);
    if (!match) throw new Error(`unsupported bundle resource pattern: ${pattern}`);
    return match[1];
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0 || result.error) throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  return result;
}

// The shared release-archive extractor validates every member before writing into empty scratch.
async function extractArchive(archivePath, destination, expectedSha256) {
  const candidates = [
    new URL("./ci/artifact-manifest.mjs", import.meta.url),              // Composed repo (tools -> tools/ci)
    new URL("../../../tools/ci/artifact-manifest.mjs", import.meta.url), // Monorepo
  ];
  for (const url of candidates) {
    let shared;
    try {
      shared = await import(url.href);
    } catch (error) {
      if (error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes(fileURLToPath(url))) continue;
      throw error;
    }
    await shared.extractReleaseArchive({ archivePath, destination, expectedSha256 });
    return;
  }
  throw new Error("the shared release-archive extractor is unavailable");
}

const omitted = (name) => Object.hasOwn(OMITTED_RESOURCES, name);

/**
 * Materializes the release surface from a prepared checkout.
 * @param {{ root: string, releaseDir: string, inventoryDir: string, reportDir: string, manifestPath: string }} options
 */
export async function materializeSurface(options) {
  const root = resolve(options.root);
  const release = resolve(options.releaseDir);
  const inventory = resolve(options.inventoryDir);
  const report = resolve(root, options.reportDir);
  for (const directory of [release, inventory]) {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
  }

  await copyTree(join(root, "dist"), join(release, "frontend/install"));
  await mkdir(join(release, "frontend"), { recursive: true });
  run("tar", ["-czf", join(release, "frontend/frontend-dist.tar.gz"), "-C", join(root, "dist"), "."]);

  await copyFile(join(report, "node-runtime"), join(release, "runtime/node-runtime"));
  await copyFile(join(report, "node-runtime"), join(release, "runtime/catalog/node"));
  for (const name of ["receipt.json", "SHASUMS256.txt.asc"]) {
    await copyFile(join(report, "node-authenticity", name), join(release, "runtime/node-authenticity", name));
  }

  const sidecarArchive = await readRegular(join(report, "sidecar-payload.tar.gz"));
  await writeNew(join(release, "sidecar/sidecar-payload.tar.gz"), sidecarArchive.bytes, sidecarArchive.mode);
  await extractArchive(join(release, "sidecar/sidecar-payload.tar.gz"), join(release, "sidecar/extracted"), sha256(sidecarArchive.bytes));

  const tauriConfig = JSON.parse((await readRegular(join(root, "src-tauri/tauri.conf.json"))).bytes.toString("utf8"));
  const resources = bundleResourceNames(tauriConfig).filter((name) => !omitted(name));
  for (const name of resources) await copyTree(join(root, "src-tauri", name), join(release, "resources", name));

  for (const [group, files] of Object.entries({
    frontend: ["package.json", "package-lock.json"],
    rust: ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"],
    core: ["authenticated-inputs/core/package.json", "authenticated-inputs/core/package-lock.json"],
    loom: ["loom-preview-source/package.json", "loom-preview-source/package-lock.json"],
  })) {
    for (const file of files) await copyFile(join(root, file), join(inventory, group, file.split("/").pop()));
  }

  const describe = async (base) => (await Promise.all((await treeFiles(base)).map(async (path) => {
    const { bytes } = await readRegular(path);
    return { path: portable(relative(base, path)), size: bytes.length, sha256: sha256(bytes) };
  })));
  const manifest = {
    schema: SURFACE_SCHEMA,
    schemaVersion: 1,
    resources,
    omissions: DECLARED_OMISSIONS,
    files: await describe(release),
    inventory: await describe(inventory),
  };
  await rm(resolve(options.manifestPath), { force: true });
  await writeNew(resolve(options.manifestPath), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o644);
  return manifest;
}

function compareInventories(label, shippedInventory, scannedInventory) {
  const shipped = withoutAppleDouble(shippedInventory);
  const scanned = withoutAppleDouble(scannedInventory);
  const expected = shipped.kept;
  const actual = scanned.kept;
  const missing = [...expected.keys()].filter((path) => !actual.has(path));
  const extra = [...actual.keys()].filter((path) => !expected.has(path));
  const different = [...expected.keys()].filter((path) => actual.has(path) && actual.get(path) !== expected.get(path));
  return { group: label, files: expected.size, equal: missing.length === 0 && extra.length === 0 && different.length === 0,
    ignoredAppleDouble: { shipped: shipped.ignored, scanned: scanned.ignored }, missingFromSurface: missing.slice(0, 20), extraInSurface: extra.slice(0, 20), different: different.slice(0, 20) };
}

function surfaceGroup(manifest, prefix) {
  const group = new Map();
  for (const file of manifest.files) if (file.path.startsWith(prefix)) group.set(file.path.slice(prefix.length), file.sha256);
  return group;
}

async function producerFile(downloadDir, artifact, path) {
  const directory = join(downloadDir, artifact);
  const manifest = JSON.parse((await readRegular(join(directory, "artifact-manifest.json"))).bytes.toString("utf8"));
  const member = manifest.artifacts?.find((entry) => entry.path === path);
  if (manifest.schema !== "tfsb.ci-job-artifact-manifest" || manifest.status !== "pass" || !member) throw new Error(`${artifact}/${path} is absent from its producer manifest`);
  const { bytes } = await readRegular(join(directory, path));
  if (sha256(bytes) !== member.sha256) throw new Error(`${artifact}/${path} does not match its producer manifest`);
  return { path: join(directory, path), sha256: member.sha256 };
}

/**
 * Proves that the independently materialized scan surface equals the same run's shipped producer bytes.
 * @param {{ downloadDir: string }} options
 */
export async function crossCheckSurface(options) {
  const downloadDir = resolve(options.downloadDir);
  const surfaceFile = await producerFile(downloadDir, "supply-chain-artifacts", "release-surface.json");
  const manifest = JSON.parse((await readRegular(surfaceFile.path)).bytes.toString("utf8"));
  if (manifest.schema !== SURFACE_SCHEMA) throw new Error("release-surface.json has an unexpected schema");
  const scratch = await mkdtemp(join(tmpdir(), "nebular-surface-"));
  try {
    const groups = [];
    const runtime = await producerFile(downloadDir, "nebular-macos-arm64-artifacts", "node-runtime");
    groups.push(compareInventories("runtime", new Map([["node-runtime", runtime.sha256], ["catalog/node", runtime.sha256]]),
      new Map([...surfaceGroup(manifest, "runtime/")].filter(([path]) => path === "node-runtime" || path === "catalog/node"))));

    const sidecar = await producerFile(downloadDir, "nebular-macos-arm64-artifacts", "sidecar-payload.tar.gz");
    await extractArchive(sidecar.path, join(scratch, "sidecar"), sidecar.sha256);
    groups.push(compareInventories("sidecar", await treeInventory(join(scratch, "sidecar")), surfaceGroup(manifest, "sidecar/extracted/")));

    const app = await producerFile(downloadDir, "nebular-macos-arm64-artifacts", "nebular-fusion.app.tar.gz");
    await extractArchive(app.path, join(scratch, "app"), app.sha256);
    const bundles = (await readdir(join(scratch, "app"))).filter((name) => name.endsWith(".app") && !isAppleDouble(name));
    if (bundles.length !== 1) throw new Error("the producer application archive must contain exactly one .app bundle");
    const resourcesRoot = join(scratch, "app", bundles[0], "Contents/Resources");
    const shipped = (await readdir(resourcesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !isAppleDouble(entry.name)).map((entry) => entry.name).sort();
    const scanned = [...manifest.resources].sort();
    const unscanned = shipped.filter((name) => !scanned.includes(name) && !omitted(name));
    groups.push({ group: "resource-set", equal: unscanned.length === 0 && scanned.every((name) => shipped.includes(name)), shipped, scanned, unscanned });
    for (const name of scanned) {
      groups.push(compareInventories(`resources/${name}`, await treeInventory(join(resourcesRoot, name)), surfaceGroup(manifest, `resources/${name}/`)));
    }

    const frontend = await producerFile(downloadDir, "frontend-artifacts", "frontend-dist.tar.gz");
    await extractArchive(frontend.path, join(scratch, "frontend"), frontend.sha256);
    groups.push(compareInventories("frontend", await treeInventory(join(scratch, "frontend")), surfaceGroup(manifest, "frontend/install/")));

    return { schema: CROSS_CHECK_SCHEMA, schemaVersion: 1, status: groups.every((group) => group.equal) ? "pass" : "fail",
      surfaceManifestSha256: surfaceFile.sha256, producers: { runtime: runtime.sha256, sidecar: sidecar.sha256, app: app.sha256, frontend: frontend.sha256 }, groups };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; };
  const required = (flag) => { const found = value(flag); if (!found) throw new Error(`${command} requires ${flag}`); return found; };
  try {
    if (command === "materialize") {
      const manifest = await materializeSurface({ root: process.cwd(), releaseDir: required("--release-dir"), inventoryDir: required("--inventory-dir"),
        reportDir: required("--report-dir"), manifestPath: required("--manifest") });
      process.stdout.write(`${JSON.stringify({ schema: manifest.schema, files: manifest.files.length, resources: manifest.resources })}\n`);
    } else if (command === "cross-check") {
      const result = await crossCheckSurface({ downloadDir: required("--download-dir") });
      const output = resolve(required("--output"));
      await rm(output, { force: true });
      await writeNew(output, Buffer.from(`${JSON.stringify(result, null, 2)}\n`), 0o644);
      process.stdout.write(`${JSON.stringify({ status: result.status, groups: result.groups.map((group) => [group.group, group.equal]) })}\n`);
      if (result.status !== "pass") process.exitCode = 1;
    } else {
      throw new Error("Usage: supply-chain-surface.mjs materialize --release-dir <dir> --inventory-dir <dir> --report-dir <dir> --manifest <file> | cross-check --download-dir <dir> --output <file>");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
