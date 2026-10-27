/**
 * apps/studio/tools/release-notices.mjs
 *
 * Standalone application build legal-notices generator.
 *
 * Responsibilities:
 * 1. Collect reachable Cargo runtime and build dependencies (including proc-macros, excluding dev-only).
 * 2. Collect root legal notices (LICENSE, NOTICE, COMMERCIAL-LICENSE.md, node-LICENSE.txt).
 * 3. Collect shipped frontend distributed npm dependency notices (react, react-dom, scheduler, @tauri-apps/api).
 * 4. Copy license and notice materials into package-name-version paths under output directory.
 * 5. Record SPDX license expressions and source checksums from Cargo.lock / package-lock.json.
 * 6. Strictly enforce required license material: matching registry metadata is NOT sufficient if license text is absent.
 * 7. Render deterministic THIRD-PARTY-NOTICES.md and THIRD-PARTY-NOTICES.json with zero machine paths and zero timestamps.
 * 8. Reject unsafe or escaping relative paths.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, lstatSync, constants, openSync, fstatSync, closeSync, opendirSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRegularSnapshot } from "./fs-snapshot.mjs";
import { targetForHost, readCandidateVersion, requireCandidateVersion } from "./platform-targets.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const STUDIO_ROOT = resolve(__dirname, "..");
export const DEFAULT_OUTPUT_DIR = resolve(STUDIO_ROOT, "src-tauri/release-notices");
export const TARGET_PLATFORM = targetForHost().triple;
export const CARGO_METADATA_FORMAT = "1";

const MAX_PATH_BYTES = 512;
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9._@+-]+$/;
const REQUIRED_CURRENT_FRONTEND_IDENTITIES = Object.freeze([
  "@astrojs/starlight@0.42.0",
  "@pagefind/default-ui@1.5.2",
  "astro@7.3.3",
  "pagefind@1.5.2",
]);
const DEFAULT_UI_BUNDLED_DEPENDENCIES = Object.freeze([
  {
    package: "svelte",
    version: "4.2.20",
    license: "MIT",
    lockPackagePath: "node_modules/svelte",
    source: "https://github.com/sveltejs/svelte",
    revision: "svelte@4.2.20",
    licensePath: "LICENSE.md",
    noticeFile: "svelte-4.2.20-LICENSE.md",
  },
  {
    package: "bcp-47",
    version: "2.1.0",
    license: "MIT",
    lockPackagePath: "node_modules/bcp-47",
    source: "https://github.com/wooorm/bcp-47",
    revision: "2.1.0",
    licensePath: "license",
    noticeFile: "bcp-47-2.1.0-license",
  },
  {
    package: "is-alphabetical",
    version: "2.0.1",
    license: "MIT",
    lockPackagePath: "node_modules/is-alphabetical",
    source: "https://github.com/wooorm/is-alphabetical",
    revision: "2.0.1",
    licensePath: "license",
    noticeFile: "is-alphabetical-2.0.1-license",
  },
  {
    package: "is-alphanumerical",
    version: "2.0.1",
    license: "MIT",
    lockPackagePath: "node_modules/is-alphanumerical",
    source: "https://github.com/wooorm/is-alphanumerical",
    revision: "2.0.1",
    licensePath: "license",
    noticeFile: "is-alphanumerical-2.0.1-license",
  },
  {
    package: "is-decimal",
    version: "2.0.1",
    license: "MIT",
    lockPackagePath: "node_modules/is-decimal",
    source: "https://github.com/wooorm/is-decimal",
    revision: "2.0.1",
    licensePath: "license",
    noticeFile: "is-decimal-2.0.1-license",
  },
]);

/** @typedef {{pkg: string, dep_kinds?: Array<{kind: string | null}>}} CargoDependency */
/** @typedef {{id: string, deps: CargoDependency[]}} CargoResolveNode */
/** @typedef {{id: string, name: string, version: string, license?: string | null, license_file?: string | null, manifest_path?: string | null, targets?: Array<{kind?: string[]}>}} CargoPackage */
/** @typedef {{resolve: {root?: string, nodes: CargoResolveNode[]}, packages: CargoPackage[]}} CargoMetadata */
/** @typedef {{id: string, name: string, version: string, license: string | null, license_file: string | null, manifest_path: string | null, isProcMacro: boolean, crateDir: string | null}} ResolvedCrate */
/** @typedef {{licenseFiles: string[], hasLicenseText: boolean, isMissingRequiredMaterial: boolean, failureReason: string | null}} LicenseInventory */
/** @typedef {{name: string, version: string, license: string | null, revision: string, files: Array<{path: string, size: number, sha256: string}>}} SupplementalPackage */
/** @typedef {{package: string, version: string, repository: string, revision: string, path: string, url: string}} SupplementalFrontendUpstream */
/** @typedef {{path: string, size: number, sha256: string, role?: string, upstream?: SupplementalFrontendUpstream}} SupplementalFrontendFile */
/** @typedef {{path: string, size: number, sha256: string}} SupplementalFrontendManifest */
/** @typedef {{path: string, size: number, sha256: string}} SupplementalFrontendProvenanceFile */
/** @typedef {{package: string, version: string, license: string, lockPackagePath: string, source: string, revision: string, licensePath: string, noticeFile: string}} SupplementalFrontendBundledDependency */
/** @typedef {{repository: string, revision: string, path: string}} SupplementalFrontendDependencyLock */
/** @typedef {{kind: string, parentPackage: string, parentManifestSha256: string, sourceFiles: SupplementalFrontendProvenanceFile[], emittedMembers: SupplementalFrontendProvenanceFile[], licenseCoverage: string, dependencyLock?: SupplementalFrontendDependencyLock, bundledDependencies?: SupplementalFrontendBundledDependency[]}} SupplementalFrontendProvenance */
/** @typedef {{name: string, version: string, license: string, role: string, lockPackagePath: string, licenseSourcePackage?: string, embeddedProvenance?: SupplementalFrontendProvenance, packageManifest: SupplementalFrontendManifest, files: SupplementalFrontendFile[]}} SupplementalFrontendPackage */
/** @typedef {{packagePath: string, lockPath: string}} SupplementalFrontendFixtureBinding */
/** @typedef {{sourceBindings: {monorepo: SupplementalFrontendFixtureBinding, publicComposition: SupplementalFrontendFixtureBinding}, packageSize: number, packageSha256: string, lockSize: number, lockSha256: string}} SupplementalFrontendFixture */
/** @typedef {{schema?: string, packages: SupplementalPackage[], frontendFixture?: SupplementalFrontendFixture, frontendPackages?: SupplementalFrontendPackage[]}} SupplementalManifest */
/** @typedef {{fileName: string, sourcePath: string | null, relativePath: string, bytes?: Buffer}} NoticeFile */
/** @typedef {{name: string, sourcePath: string, relativePath: string}} RootNotice */
/** @typedef {{name: string, version: string, license: string | null, dirName: string, files: NoticeFile[], hasLicenseText: boolean}} NpmNoticePackage */
/** @typedef {{name: string, version: string, license: string | null, isProcMacro: boolean, checksum: string | null, dirName: string, files: NoticeFile[], hasLicenseText: boolean}} CrateNoticePackage */
/** @typedef {{name: string, version: string, license: string | null, failureReason: string | null}} MissingMaterial */
/** @typedef {string | {relativePath: string}} ManifestFile */
/** @typedef {{name: string, version: string, license?: string | null, files?: string[]}} MockNpmPackage */
/** @typedef {{rootPackageId?: string, cargoMetadata?: CargoMetadata, cargoLockContent?: string, fileExistenceMap?: Record<string, boolean>, mockNpmPackages?: Record<string, MockNpmPackage>, mockCrateFiles?: Record<string, string[]>, supplementalLicenses?: Record<string, string[]>, repoRoot?: string, studioRoot?: string, outDir?: string, writeFiles?: boolean, failOnMissing?: boolean, allowExternalOutDir?: boolean, frontendSupplemental?: boolean}} NoticeOptions */
/** @typedef {{name: string, version: string, license?: string | null, files?: ManifestFile[], hasLicenseText?: boolean}} ManifestNpmPackage */
/** @typedef {{name: string, version: string, license?: string | null, checksum?: string | null, isProcMacro?: boolean, files?: ManifestFile[], hasLicenseText?: boolean}} ManifestCrate */
/** @typedef {{name?: string, version?: string, license?: string, files?: ManifestFile[]}} ManifestRoot */
/** @typedef {{status?: string, missingRequiredMaterial?: MissingMaterial[]}} ManifestValidation */
/** @typedef {{name: string, version: string, license: string, role: string, files: ManifestFile[], hasLicenseText: boolean, lockPackagePath: string, packageManifestSha256: string, fixtureLockSha256: string, licenseSourcePackage?: string, embeddedProvenance?: SupplementalFrontendProvenance}} ManifestFrontendPackage */
/** @typedef {{root?: ManifestRoot, npm?: ManifestNpmPackage[], frontend?: ManifestFrontendPackage[], crates?: ManifestCrate[], validation?: ManifestValidation}} ManifestData */

/**
 * Validates and normalizes a relative path string.
 * Strictly forbids path traversal ('..'), absolute paths, backslashes,
 * null bytes, or dangerous characters.
 */
/** @param {unknown} pathStr */
export function normalizeSafeRelativePath(pathStr) {
  if (typeof pathStr !== "string" || pathStr.length === 0) {
    throw new Error("Relative path must be a non-empty string");
  }
  if (Buffer.byteLength(pathStr) > MAX_PATH_BYTES) {
    throw new Error(`Relative path exceeds maximum length of ${MAX_PATH_BYTES} bytes: ${pathStr}`);
  }
  if (pathStr.includes("\0")) {
    throw new Error(`Relative path contains null byte: ${pathStr}`);
  }
  if (pathStr.includes("\\")) {
    throw new Error(`Relative path contains backslash: ${pathStr}`);
  }
  if (pathStr.startsWith("/") || /^[A-Za-z]:/.test(pathStr)) {
    throw new Error(`Relative path must not be absolute: ${pathStr}`);
  }

  const normalized = pathStr.split(sep).join("/").normalize("NFC");
  const segments = normalized.split("/");

  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Relative path contains invalid traversal segment: '${segment}' in '${pathStr}'`);
    }
    if (!SAFE_PATH_SEGMENT_RE.test(segment)) {
      throw new Error(`Relative path segment contains invalid characters: '${segment}' in '${pathStr}'`);
    }
  }

  return segments.join("/");
}

/**
 * Safely joins a base directory with a relative path, guaranteeing
 * the result remains strictly within baseDir.
 */
/** @param {string} baseDir @param {unknown} relativePath */
export function joinSafeRelative(baseDir, relativePath) {
  const safeRel = normalizeSafeRelativePath(relativePath);
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(resolvedBase, safeRel);
  const relCheck = relative(resolvedBase, resolvedTarget);

  if (relCheck.startsWith("..") || resolve(resolvedTarget) !== resolvedTarget || !resolvedTarget.startsWith(resolvedBase)) {
    throw new Error(`Path escapes base directory: ${relativePath}`);
  }
  return resolvedTarget;
}

/**
 * Finds the repository root given studioRoot.
 */
/** @param {string} [studioRoot] */
export function findRepositoryRoot(studioRoot = STUDIO_ROOT) {
  const appRoot = resolve(studioRoot);
  if (existsSync(resolve(appRoot, "authenticated-inputs/stellar-binding.json"))) return appRoot;
  return resolve(appRoot, "../..", "apps/studio") === appRoot ? resolve(appRoot, "../..") : appRoot;
}

/**
 * Computes sha256 hex digest of a Buffer or string.
 */
/** @param {Buffer | string} data */
export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Parses Cargo.lock text to extract package checksums.
 * Returns a Map of `${name}@${version}` -> checksum.
 */
/** @param {string | null | undefined} lockContent @returns {Map<string, string>} */
export function parseCargoLockChecksums(lockContent) {
  /** @type {Map<string, string>} */
  const checksumMap = new Map();
  if (!lockContent || typeof lockContent !== "string") return checksumMap;

  const packageBlocks = lockContent.split("[[package]]");
  for (const block of packageBlocks) {
    const nameMatch = block.match(/name\s*=\s*"([^"]+)"/);
    const versionMatch = block.match(/version\s*=\s*"([^"]+)"/);
    const checksumMatch = block.match(/checksum\s*=\s*"([^"]+)"/);

    if (nameMatch && versionMatch && checksumMatch) {
      const name = nameMatch[1];
      const version = versionMatch[1];
      const checksum = checksumMatch[1];
      if (name === undefined || version === undefined || checksum === undefined) continue;
      const key = `${name}@${version}`;
      checksumMap.set(key, checksum);
    }
  }

  return checksumMap;
}

/**
 * Traverses cargo metadata resolve nodes starting from the root crate,
 * collecting reachable normal and build dependencies (including proc macros),
 * strictly excluding development-only dependencies.
 */
/** @param {CargoMetadata} metadata @param {{rootPackageId?: string}} [options] @returns {ResolvedCrate[]} */
export function resolveReachableCrates(metadata, options = {}) {
  if (!metadata || !metadata.resolve || !Array.isArray(metadata.resolve.nodes)) {
    throw new Error("Invalid cargo metadata structure: resolve.nodes missing");
  }
  if (!Array.isArray(metadata.packages)) {
    throw new Error("Invalid cargo metadata structure: packages array missing");
  }

  const rootId = options.rootPackageId || metadata.resolve.root;
  if (!rootId) {
    throw new Error("Cargo metadata resolve root package ID is unavailable");
  }

  /** @type {Map<string, CargoPackage>} */
  const packageMap = new Map();
  for (const pkg of metadata.packages) {
    packageMap.set(pkg.id, pkg);
  }

  /** @type {Map<string, CargoResolveNode>} */
  const nodeMap = new Map();
  for (const node of metadata.resolve.nodes) {
    nodeMap.set(node.id, node);
  }

  const rootNode = nodeMap.get(rootId);
  if (!rootNode) {
    throw new Error(`Root resolve node not found for ID: ${rootId}`);
  }

  // Reachable dependency IDs
  const reachableIds = new Set();
  /** @type {string[]} */
  const queue = [];

  /** @param {CargoDependency} dep */
  function isNormalOrBuild(dep) {
    if (!dep.dep_kinds || dep.dep_kinds.length === 0) return true;
    return dep.dep_kinds.some((dk) => dk.kind === null || dk.kind === "build");
  }

  // From root node
  for (const dep of rootNode.deps) {
    if (isNormalOrBuild(dep)) {
      if (!reachableIds.has(dep.pkg)) {
        reachableIds.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
  }

  // BFS across dependency graph
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (currentId === undefined) continue;
    const currentNode = nodeMap.get(currentId);
    if (!currentNode || !Array.isArray(currentNode.deps)) continue;

    for (const dep of currentNode.deps) {
      if (isNormalOrBuild(dep)) {
        if (!reachableIds.has(dep.pkg)) {
          reachableIds.add(dep.pkg);
          queue.push(dep.pkg);
        }
      }
    }
  }

  /** @type {ResolvedCrate[]} */
  const resolvedCrates = [];
  for (const pkgId of reachableIds) {
    // Exclude the root package itself
    if (pkgId === rootId) continue;

    const pkg = packageMap.get(pkgId);
    if (!pkg) continue;

    const isProcMacro = Array.isArray(pkg.targets) && pkg.targets.some(
      (t) => Array.isArray(t.kind) && t.kind.includes("proc-macro"),
    );

    resolvedCrates.push({
      id: pkg.id,
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || null,
      license_file: pkg.license_file || null,
      manifest_path: pkg.manifest_path || null,
      isProcMacro,
      crateDir: pkg.manifest_path ? dirname(pkg.manifest_path) : null,
    });
  }

  // Deterministic sorting: name ASC (ASCII), then version ASC (ASCII)
  resolvedCrates.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
  });

  return resolvedCrates;
}

/**
 * Checks if a file name represents a legal notice or license file.
 */
/** @param {unknown} fileName */
export function isLicenseOrNoticeFileName(fileName) {
  if (typeof fileName !== "string") return false;
  const base = basename(fileName);

  // Exclude hidden, binary, or source files
  if (base.startsWith(".") || /\.(rs|js|mjs|cjs|ts|tsx|c|h|toml|lock|json|png|jpg|wasm)$/i.test(base)) {
    return false;
  }

  // Match license, licence, notice, copying, copyright, unlicense
  return /^(license|licence|notice|copying|copyright|unlicense)($|[-._])/i.test(base);
}

/**
 * Inventories license files for a crate package.
 * Strictly enforces that matching registry metadata is NOT sufficient if license text is absent.
 */
/** @param {ResolvedCrate} pkg @param {string | null} crateDir @param {{fileList?: string[], supplementalFiles?: string[]}} [options] */
export function inventoryPackageLicenses(pkg, crateDir, options = {}) {
  /** @type {string[]} */
  let fileNames = [];
  if (options.fileList !== undefined) {
    fileNames = options.fileList;
  } else if (crateDir && existsSync(crateDir)) {
    try {
      fileNames = readdirSync(crateDir);
    } catch {
      fileNames = [];
    }
  }

  const matched = new Set();

  for (const file of fileNames) {
    if (isLicenseOrNoticeFileName(file)) {
      matched.add(file);
    }
  }

  // If package metadata specifies a license_file, check if present
  if (pkg.license_file && fileNames.includes(pkg.license_file)) {
    matched.add(pkg.license_file);
  }

  // Check supplemental files if provided for this package
  if (options.supplementalFiles && Array.isArray(options.supplementalFiles)) {
    for (const sf of options.supplementalFiles) {
      matched.add(sf);
    }
  }

  const licenseFiles = [...matched].sort();
  const hasLicenseText = licenseFiles.length > 0;

  // Crucial policy rule: matching registry metadata is NOT sufficient if license text is absent.
  const isMissingRequiredMaterial = !hasLicenseText;
  let failureReason = null;
  if (isMissingRequiredMaterial) {
    failureReason = pkg.license
      ? `Registry metadata '${pkg.license}' is not sufficient: license text file absent in package archive`
      : "Absent required license material: no license text file or metadata found";
  }

  return {
    licenseFiles,
    hasLicenseText,
    isMissingRequiredMaterial,
    failureReason,
  };
}

/**
 * Inventories root first-party and platform notices.
 */
/** @param {string} [studioRoot] @param {NoticeOptions} [options] @returns {RootNotice[]} */
export function collectRootNotices(studioRoot = STUDIO_ROOT, options = {}) {
  const repoRoot = options.repoRoot || findRepositoryRoot(studioRoot);
  /** @type {RootNotice[]} */
  const rootNotices = [];

  const candidates = [
    { targetName: "LICENSE", paths: [resolve(studioRoot, "LICENSE"), resolve(repoRoot, "LICENSE")] },
    { targetName: "NOTICE", paths: [resolve(studioRoot, "NOTICE"), resolve(repoRoot, "NOTICE")] },
    { targetName: "COMMERCIAL-LICENSE.md", paths: [resolve(studioRoot, "COMMERCIAL-LICENSE.md"), resolve(repoRoot, "COMMERCIAL-LICENSE.md")] },
    { targetName: "node-LICENSE.txt", paths: [resolve(studioRoot, "legal/node-LICENSE.txt"), resolve(repoRoot, "legal/node-LICENSE.txt")] },
  ];

  for (const candidate of candidates) {
    let sourcePath = null;
    if (options.fileExistenceMap) {
      for (const p of candidate.paths) {
        if (options.fileExistenceMap[p]) {
          sourcePath = p;
          break;
        }
      }
    } else {
      for (const p of candidate.paths) {
        if (existsSync(p)) {
          sourcePath = p;
          break;
        }
      }
    }

    if (sourcePath) {
      const relTarget = `root/${candidate.targetName}`;
      rootNotices.push({
        name: candidate.targetName,
        sourcePath,
        relativePath: normalizeSafeRelativePath(relTarget),
      });
    }
  }

  rootNotices.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  return rootNotices;
}

/**
 * Normalizes npm package names for directory paths (e.g. '@tauri-apps/api' -> 'tauri-apps-api').
 */
/** @param {string} pkgName @param {string} version */
function sanitizeNpmPackageDirName(pkgName, version) {
  const cleanName = pkgName.replace(/^@/, "").replace("/", "-");
  return `${cleanName}-${version}`;
}

/**
 * Inventories shipped distributed npm frontend dependencies (react, react-dom, scheduler, @tauri-apps/api).
 */
/** @param {string} [studioRoot] @param {NoticeOptions} [options] @returns {NpmNoticePackage[]} */
export function collectNpmDistributedNotices(studioRoot = STUDIO_ROOT, options = {}) {
  const nodeModulesDir = resolve(studioRoot, "node_modules");
  /** @type {NpmNoticePackage[]} */
  const npmPackages = [];

  // Frontend distributed dependencies
  const targetPackages = [
    { name: "@tauri-apps/api", pathSegments: ["@tauri-apps", "api"] },
    { name: "react", pathSegments: ["react"] },
    { name: "react-dom", pathSegments: ["react-dom"] },
    { name: "scheduler", pathSegments: ["scheduler"] },
  ];

  for (const target of targetPackages) {
    const pkgDir = resolve(nodeModulesDir, ...target.pathSegments);
    /** @type {{name: string, version: string, license: string | null | undefined} | null} */
    let pkgJson = null;
    /** @type {string[]} */
    let fileList = [];

    const mock = options.mockNpmPackages?.[target.name];
    if (mock) {
      pkgJson = { name: target.name, version: mock.version, license: mock.license };
      fileList = mock.files || [];
    } else if (existsSync(pkgDir)) {
      const pkgJsonPath = resolve(pkgDir, "package.json");
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      } catch {
        pkgJson = null;
      }
      try {
        fileList = readdirSync(pkgDir);
      } catch {
        fileList = [];
      }
    }

    if (!pkgJson) continue;

    const matchedFiles = fileList.filter((f) => isLicenseOrNoticeFileName(f)).sort();
    const dirName = sanitizeNpmPackageDirName(target.name, pkgJson.version);

    const files = matchedFiles.map((f) => ({
      fileName: f,
      sourcePath: resolve(pkgDir, f),
      relativePath: normalizeSafeRelativePath(`npm/${dirName}/${f}`),
    }));

    npmPackages.push({
      name: target.name,
      version: pkgJson.version,
      license: pkgJson.license || null,
      dirName,
      files,
      hasLicenseText: files.length > 0,
    });
  }

  npmPackages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return npmPackages;
}

/**
 * Renders THIRD-PARTY-NOTICES.json deterministically.
 * Guarantees no timestamps, no private machine paths, deterministic key and entry ordering.
 */
/** @param {ManifestData} manifestData */
export function renderThirdPartyNoticesJson(manifestData) {
  const cleanManifest = {
    schemaVersion: "1.0.0",
    format: "studio-release-notices-v1",
    targetPlatform: TARGET_PLATFORM,
    root: {
      name: manifestData.root?.name || "@knowledge-forge-ai/theme-forge-nebular-fusion",
      version: requireCandidateVersion(manifestData.root?.version),
      license: manifestData.root?.license || "AGPL-3.0-or-later",
      files: (manifestData.root?.files || []).map((f) => normalizeSafeRelativePath(f)).sort(),
    },
    npm: (manifestData.npm || []).map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || null,
      files: (pkg.files || []).map((f) => normalizeSafeRelativePath(typeof f === "string" ? f : f.relativePath)).sort(),
      hasLicenseText: Boolean(pkg.hasLicenseText),
    })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    crates: (manifestData.crates || []).map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || null,
      checksum: pkg.checksum || null,
      isProcMacro: Boolean(pkg.isProcMacro),
      files: (pkg.files || []).map((f) => normalizeSafeRelativePath(typeof f === "string" ? f : f.relativePath)).sort(),
      hasLicenseText: Boolean(pkg.hasLicenseText),
    })).sort((a, b) => {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
    }),
    validation: {
      status: manifestData.validation?.status || "passed",
      totalCrates: manifestData.crates?.length || 0,
      cratesWithLicenseText: (manifestData.crates || []).filter((c) => c.hasLicenseText).length,
      cratesMissingLicenseText: (manifestData.crates || []).filter((c) => !c.hasLicenseText).length,
      missingRequiredMaterial: (manifestData.validation?.missingRequiredMaterial || []).map((m) => ({
        name: m.name,
        version: m.version,
        license: m.license || null,
        failureReason: m.failureReason || "License text absent in package archive",
      })).sort((a, b) => {
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        return a.version < b.version ? -1 : 1;
      }),
    },
  };

  if (manifestData.frontend && manifestData.frontend.length > 0) {
    cleanManifest.frontend = manifestData.frontend.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      role: pkg.role,
      lockPackagePath: pkg.lockPackagePath,
      fixtureLockSha256: pkg.fixtureLockSha256,
      packageManifestSha256: pkg.packageManifestSha256,
      ...(pkg.licenseSourcePackage ? { licenseSourcePackage: pkg.licenseSourcePackage } : {}),
      ...(pkg.embeddedProvenance ? { embeddedProvenance: pkg.embeddedProvenance } : {}),
      files: (pkg.files || []).map((f) => normalizeSafeRelativePath(typeof f === "string" ? f : f.relativePath)).sort(),
      hasLicenseText: Boolean(pkg.hasLicenseText),
    })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  return `${JSON.stringify(cleanManifest, null, 2)}\n`;
}

/**
 * Renders THIRD-PARTY-NOTICES.md deterministically.
 * Guarantees no timestamps, no private machine paths, deterministic formatting.
 */
/** @param {ManifestData} manifestData */
export function renderThirdPartyNoticesMarkdown(manifestData) {
  const lines = [
    "# Third-Party Legal Notices",
    "",
    "## Application",
    "",
    `- **Package:** ${manifestData.root?.name || "@knowledge-forge-ai/theme-forge-nebular-fusion"}`,
    `- **Version:** ${requireCandidateVersion(manifestData.root?.version)}`,
    `- **Primary License:** ${manifestData.root?.license || "AGPL-3.0-or-later"}`,
    `- **Commercial Terms:** Available under separate commercial agreement (see \`root/COMMERCIAL-LICENSE.md\`).`,
    "",
    "This document compiles third-party license and copyright notices for software components",
    `distributed with or utilized in the build of this standalone application for target \`${TARGET_PLATFORM}\`.`,
    "",
    "---",
    "",
    "## First-Party Legal Notices",
    "",
    "The following legal notices apply to first-party code and bundled runtime dependencies:",
    "",
  ];

  const rootFiles = (manifestData.root?.files || []).map((f) => (typeof f === "string" ? f : f.relativePath)).sort();
  for (const rf of rootFiles) {
    lines.push(`- \`${rf}\``);
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Distributed Frontend Components (npm)");
  lines.push("");
  lines.push("| Package | Version | License | Copied Notice Files |");
  lines.push("| :--- | :--- | :--- | :--- |");

  const npmPackages = [...(manifestData.npm || [])].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const pkg of npmPackages) {
    const fileList = (pkg.files || []).map((f) => `\`${typeof f === "string" ? f : f.relativePath}\``).join(", ") || "*(none)*";
    lines.push(`| **${pkg.name}** | ${pkg.version} | ${pkg.license || "*(unspecified)*"} | ${fileList} |`);
  }
  lines.push("");

  const frontendPackages = [...(manifestData.frontend || [])].sort((a, b) => (a.name < b.name ? -1 : 1));
  if (frontendPackages.length > 0) {
    lines.push("## Distributed Preview Frontend Components (npm)");
    lines.push("");
    lines.push("These records cover static runtime code and search assets emitted into the application frontend. Build-only compiler, platform binary, and development packages are not listed here.");
    lines.push("");
    lines.push("| Package | Version | License | Role | Copied Notice Files |");
    lines.push("| :--- | :--- | :--- | :--- | :--- |");
    for (const pkg of frontendPackages) {
      const fileList = (pkg.files || []).map((f) => `\`${typeof f === "string" ? f : f.relativePath}\``).join(", ") || "*(none)*";
      lines.push(`| **${pkg.name}** | ${pkg.version} | ${pkg.license} | ${pkg.role} | ${fileList} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## Native and Build Dependencies (Cargo)");
  lines.push("");
  lines.push("| Crate | Version | License | Proc-Macro | Checksum | Copied Notices |");
  lines.push("| :--- | :--- | :--- | :--- | :--- | :--- |");

  const crates = [...(manifestData.crates || [])].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.version < b.version ? -1 : 1;
  });

  for (const crate of crates) {
    const fileList = (crate.files || []).map((f) => `\`${typeof f === "string" ? f : f.relativePath}\``).join(", ") || "*(none)*";
    const checksumDisplay = crate.checksum ? `\`${crate.checksum.slice(0, 16)}...\`` : "*(local/none)*";
    const procMacro = crate.isProcMacro ? "Yes" : "No";
    lines.push(`| **${crate.name}** | ${crate.version} | ${crate.license || "*(unspecified)*"} | ${procMacro} | ${checksumDisplay} | ${fileList} |`);
  }
  lines.push("");

  // Absent required material section
  const missing = manifestData.validation?.missingRequiredMaterial || [];
  if (missing.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Absent Required License Material");
    lines.push("");
    lines.push("> [!CAUTION]");
    lines.push("> **Registry metadata is not sufficient when license text is absent.**");
    lines.push("> The following upstream crates define SPDX license expressions in their metadata but omit license text files from their published package archives. Under project release policy, absent license text constitutes missing required legal material.");
    lines.push("");
    lines.push("| Crate | Version | Declared SPDX License | Reason |");
    lines.push("| :--- | :--- | :--- | :--- |");

    const sortedMissing = [...missing].sort((a, b) => {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.version < b.version ? -1 : 1;
    });

    for (const m of sortedMissing) {
      lines.push(`| **${m.name}** | ${m.version} | ${m.license || "*(none)*"} | ${m.failureReason} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Executes `cargo metadata` in src-tauri or parses injected metadata.
 */
/** @param {string} [studioRoot] @param {NoticeOptions} [options] @returns {CargoMetadata} */
export function loadCargoMetadata(studioRoot = STUDIO_ROOT, options = {}) {
  if (options.cargoMetadata) {
    return options.cargoMetadata;
  }

  const srcTauriDir = resolve(studioRoot, "src-tauri");
  const stdout = execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--offline",
      "--filter-platform",
      TARGET_PLATFORM,
      "--format-version",
      CARGO_METADATA_FORMAT,
    ],
    {
      cwd: srcTauriDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  return JSON.parse(stdout);
}

/**
 * Loads and parses Cargo.lock checksums.
 */
/** @param {string} [studioRoot] @param {NoticeOptions} [options] @returns {Map<string, string>} */
export function loadCargoLockChecksums(studioRoot = STUDIO_ROOT, options = {}) {
  if (options.cargoLockContent !== undefined) {
    return parseCargoLockChecksums(options.cargoLockContent);
  }

  const lockPath = resolve(studioRoot, "src-tauri/Cargo.lock");
  let content;
  try {
    content = readFileSync(lockPath, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return new Map();
    throw err;
  }
  return parseCargoLockChecksums(content);
}

/**
 * Parses the npm lockfile's package table without resolving or rewriting it.
 * The complete fixture digest is checked by the caller before these entries are used.
 * @param {string} lockContent
 * @returns {Record<string, {version?: string, license?: string, integrity?: string}>}
 */
export function parsePackageLockPackages(lockContent) {
  if (typeof lockContent !== "string") throw new Error("Fixture package-lock content is not text");
  let lock;
  try {
    lock = JSON.parse(lockContent);
  } catch {
    throw new Error("Fixture package-lock content is not valid JSON");
  }
  if (!lock || typeof lock !== "object" || !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new Error("Fixture package-lock has no packages table");
  }
  return /** @type {Record<string, {version?: string, license?: string, integrity?: string}>} */ (lock.packages);
}

/** @param {string} baseDir @param {string} pathStr @param {{label: string, size?: number, sha256?: string, maxBytes?: number}} options */
function readBoundedSupplementalFile(baseDir, pathStr, options) {
  const path = joinSafeRelative(baseDir, pathStr);
  const snapshot = readRegularSnapshot(path, {
    bindPath: true,
    label: options.label,
    maxBytes: options.maxBytes ?? 1024 * 1024,
  });
  if (!snapshot) throw new Error(`${options.label} is missing: ${pathStr}`);
  if (options.size !== undefined && snapshot.size !== options.size) {
    throw new Error(`${options.label} size mismatch: ${pathStr}`);
  }
  if (options.sha256 !== undefined && snapshot.sha256 !== options.sha256) {
    throw new Error(`${options.label} digest mismatch: ${pathStr}`);
  }
  return { path, snapshot };
}

/** @param {string} repoRoot @param {SupplementalFrontendFixture} fixture @returns {{context: "monorepo" | "publicComposition", binding: SupplementalFrontendFixtureBinding}} */
function resolveFrontendFixtureBinding(repoRoot, fixture) {
  if (!fixture || typeof fixture !== "object" || !fixture.sourceBindings || typeof fixture.sourceBindings !== "object") {
    throw new Error("Frontend fixture source bindings are missing");
  }
  const monorepo = fixture.sourceBindings.monorepo;
  const publicComposition = fixture.sourceBindings.publicComposition;
  if (!monorepo || typeof monorepo.packagePath !== "string" || typeof monorepo.lockPath !== "string"
    || !publicComposition || typeof publicComposition.packagePath !== "string" || typeof publicComposition.lockPath !== "string") {
    throw new Error("Frontend fixture source bindings are invalid");
  }
  const monorepoPackage = joinSafeRelative(repoRoot, monorepo.packagePath);
  const monorepoLock = joinSafeRelative(repoRoot, monorepo.lockPath);
  const publicPackage = joinSafeRelative(repoRoot, publicComposition.packagePath);
  const publicLock = joinSafeRelative(repoRoot, publicComposition.lockPath);
  const monorepoLayout = existsSync(join(repoRoot, "apps/studio")) && existsSync(monorepoPackage) && existsSync(monorepoLock);
  const publicLayout = existsSync(join(repoRoot, "loom-preview-source")) && existsSync(publicPackage) && existsSync(publicLock);
  if (monorepoLayout === publicLayout) {
    throw new Error("Frontend fixture source layout is missing or ambiguous");
  }
  return monorepoLayout
    ? { context: "monorepo", binding: monorepo }
    : { context: "publicComposition", binding: publicComposition };
}

/** @param {string} repoRoot @param {SupplementalFrontendFixture} fixture @returns {{context: "monorepo" | "publicComposition", packagePath: string, package: Record<string, unknown>, lockPath: string, lockContent: string, lockPackages: Record<string, {version?: string, license?: string, integrity?: string}>}} */
function readFrontendFixture(repoRoot, fixture) {
  const resolved = resolveFrontendFixtureBinding(repoRoot, fixture);
  const packageFile = readBoundedSupplementalFile(repoRoot, resolved.binding.packagePath, {
    label: "Frontend fixture package manifest",
    size: fixture.packageSize,
    sha256: fixture.packageSha256,
    maxBytes: 1024 * 1024,
  });
  const lockFile = readBoundedSupplementalFile(repoRoot, resolved.binding.lockPath, {
    label: "Frontend fixture package lock",
    size: fixture.lockSize,
    sha256: fixture.lockSha256,
    maxBytes: 16 * 1024 * 1024,
  });
  let packageJson;
  try {
    packageJson = JSON.parse(packageFile.snapshot.bytes.toString("utf8"));
  } catch {
    throw new Error("Frontend fixture package manifest is not valid JSON");
  }
  return {
    context: resolved.context,
    packagePath: packageFile.path,
    package: packageJson,
    lockPath: lockFile.path,
    lockContent: lockFile.snapshot.bytes.toString("utf8"),
    lockPackages: parsePackageLockPackages(lockFile.snapshot.bytes.toString("utf8")),
  };
}

/** @param {unknown} provenance @param {string} identity @param {string} packageManifestSha256 */
function validateFrontendProvenance(provenance, identity, packageManifestSha256) {
  if (provenance === undefined) return;
  if (!provenance || typeof provenance !== "object"
    || provenance.kind !== "svelte-compiled-default-ui"
    || provenance.parentPackage !== identity
    || provenance.parentManifestSha256 !== packageManifestSha256
    || typeof provenance.licenseCoverage !== "string" || provenance.licenseCoverage.length === 0
    || !Array.isArray(provenance.sourceFiles) || provenance.sourceFiles.length === 0
    || !Array.isArray(provenance.emittedMembers) || provenance.emittedMembers.length === 0) {
    throw new Error(`Invalid frontend embedded provenance: ${identity}`);
  }
  const validateFiles = (files, label, pathPattern) => {
    const paths = new Set();
    for (const file of files) {
      if (!file || typeof file.path !== "string" || typeof file.size !== "number" || !Number.isSafeInteger(file.size)
        || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || !pathPattern.test(file.path)) {
        throw new Error(`Invalid frontend embedded provenance ${label}: ${identity}`);
      }
      const safePath = normalizeSafeRelativePath(file.path);
      if (paths.has(safePath)) throw new Error(`Duplicate frontend embedded provenance path: ${safePath}`);
      paths.add(safePath);
    }
  };
  validateFiles(provenance.sourceFiles, "source file", /^@pagefind\/default-ui\/svelte\/[A-Za-z0-9._+-]+\.svelte$/u);
  validateFiles(provenance.emittedMembers, "emitted member", /^(?:_astro\/[A-Za-z0-9._+-]+\.js|pagefind\/pagefind-ui\.(?:js|css))$/u);
  if (identity === "@pagefind/default-ui@1.5.2") {
    if (!provenance.dependencyLock || provenance.dependencyLock.repository !== "https://github.com/Pagefind/pagefind"
      || provenance.dependencyLock.revision !== "v1.5.2"
      || provenance.dependencyLock.path !== "pagefind_ui/default/package-lock.json"
      || !Array.isArray(provenance.bundledDependencies)
      || JSON.stringify(provenance.bundledDependencies) !== JSON.stringify(DEFAULT_UI_BUNDLED_DEPENDENCIES)) {
      throw new Error(`Invalid bundled dependency provenance: ${identity}`);
    }
  }
}

/**
 * Reads the authenticated frontend package/license supplements. These records are optional for
 * legacy synthetic notice fixtures, but when the current tracked manifest is present every record
 * must join to the exact fixture package/lock bytes and every text byte must be descriptor-bound.
 * @param {string} studioRoot
 * @param {string} repoRoot
 * @param {string} supplementalRoot
 * @param {SupplementalManifest} supplements
 * @returns {ManifestFrontendPackage[]}
 */
export function collectFrontendSupplementalNotices(studioRoot, repoRoot, supplementalRoot, supplements) {
  const records = supplements.frontendPackages;
  if (records === undefined) return [];
  if (!Array.isArray(records) || records.length === 0) throw new Error("Frontend supplemental package records are missing");
  if (!supplements.frontendFixture) throw new Error("Frontend supplemental fixture binding is missing");

  const fixture = readFrontendFixture(repoRoot, supplements.frontendFixture);
  const rootPackage = fixture.package;
  if (rootPackage.name !== "@knowledge-forge-ai/tfsl-fixture" || rootPackage.version !== "0.0.0-tfsb53b") {
    throw new Error("Frontend fixture package identity mismatch");
  }

  const declaredIdentities = new Set(records.map((record) => `${record?.name ?? ""}@${record?.version ?? ""}`));
  /** @type {Set<string>} */
  const identities = new Set();
  /** @type {Set<string>} */
  const outputPaths = new Set();
  /** @type {ManifestFrontendPackage[]} */
  const result = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || typeof record.name !== "string" || typeof record.version !== "string" || typeof record.license !== "string") {
      throw new Error("Invalid frontend supplemental package record");
    }
    const identity = `${record.name}@${record.version}`;
    if (identities.has(identity)) throw new Error(`Duplicate frontend supplemental package: ${identity}`);
    identities.add(identity);
    if (record.licenseSourcePackage && !declaredIdentities.has(record.licenseSourcePackage)) {
      throw new Error(`Frontend license source package is not declared: ${record.licenseSourcePackage}`);
    }
    if (!/^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(record.lockPackagePath)) {
      throw new Error(`Invalid frontend lock package path: ${record.lockPackagePath}`);
    }
    const locked = fixture.lockPackages[record.lockPackagePath];
    if (!locked || locked.version !== record.version || locked.license !== record.license) {
      throw new Error(`Frontend package does not match the authenticated fixture lock: ${identity}`);
    }
    if (!record.packageManifest || typeof record.packageManifest.path !== "string") {
      throw new Error(`Frontend package manifest binding is missing: ${identity}`);
    }
    const packageManifest = readBoundedSupplementalFile(supplementalRoot, record.packageManifest.path, {
      label: `Frontend package manifest ${identity}`,
      size: record.packageManifest.size,
      sha256: record.packageManifest.sha256,
      maxBytes: 1024 * 1024,
    });
    let packageJson;
    try {
      packageJson = JSON.parse(packageManifest.snapshot.bytes.toString("utf8"));
    } catch {
      throw new Error(`Frontend package manifest is not valid JSON: ${identity}`);
    }
    if (packageJson.name !== record.name || packageJson.version !== record.version || packageJson.license !== record.license) {
      throw new Error(`Frontend package manifest identity mismatch: ${identity}`);
    }
    validateFrontendProvenance(record.embeddedProvenance, identity, packageManifest.snapshot.sha256);
    if (!Array.isArray(record.files) || record.files.length === 0) {
      throw new Error(`Frontend package has no license material: ${identity}`);
    }
    const dirName = sanitizeNpmPackageDirName(record.name, record.version);
    const files = [];
    const bundledNoticeFiles = new Set(record.embeddedProvenance?.bundledDependencies?.map((dependency) => dependency.noticeFile) || []);
    const bundledNoticeCounts = new Map();
    for (const file of record.files) {
      if (!file || typeof file.path !== "string" || typeof file.size !== "number" || typeof file.sha256 !== "string") {
        throw new Error(`Invalid frontend license file record: ${identity}`);
      }
      if (file.role === "bundled-third-party-license-full") {
        const upstream = file.upstream;
        if (!upstream || upstream.package !== "mark.js" || upstream.version !== "8.11.1"
          || upstream.repository !== "https://github.com/julmot/mark.js"
          || upstream.revision !== "8.11.1" || upstream.path !== "LICENSE"
          || upstream.url !== "https://raw.githubusercontent.com/julmot/mark.js/8.11.1/LICENSE") {
          throw new Error(`Unbound full third-party license provenance: ${identity}`);
        }
      }
      if (bundledNoticeFiles.has(basename(file.path))) {
        if (file.role !== "bundled-third-party-license") {
          throw new Error(`Bundled third-party license role is missing: ${identity}`);
        }
        bundledNoticeCounts.set(basename(file.path), (bundledNoticeCounts.get(basename(file.path)) || 0) + 1);
      } else if (record.embeddedProvenance && file.role === "bundled-third-party-license") {
        throw new Error(`Unbound bundled third-party license provenance: ${identity}`);
      }
      const source = readBoundedSupplementalFile(supplementalRoot, file.path, {
        label: `Frontend license material ${identity}`,
        size: file.size,
        sha256: file.sha256,
        maxBytes: 4 * 1024 * 1024,
      });
      const fileName = basename(file.path);
      const relativePath = normalizeSafeRelativePath(`npm-frontend/${dirName}/${fileName}`);
      if (outputPaths.has(relativePath)) throw new Error(`Duplicate frontend notice output path: ${relativePath}`);
      outputPaths.add(relativePath);
      files.push({ fileName, sourcePath: source.path, relativePath, bytes: source.snapshot.bytes });
    }
    for (const noticeFile of bundledNoticeFiles) {
      if (bundledNoticeCounts.get(noticeFile) !== 1) {
        throw new Error(`Bundled third-party license material is missing: ${identity}`);
      }
    }
    result.push({
      name: record.name,
      version: record.version,
      license: record.license,
      role: record.role,
      files,
      hasLicenseText: true,
      lockPackagePath: record.lockPackagePath,
      packageManifestSha256: record.packageManifest.sha256,
      fixtureLockSha256: supplements.frontendFixture.lockSha256,
      ...(record.licenseSourcePackage ? { licenseSourcePackage: record.licenseSourcePackage } : {}),
      ...(record.embeddedProvenance ? { embeddedProvenance: record.embeddedProvenance } : {}),
    });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Main generator function.
 * Deterministically generates release-notices directory containing:
 * - root/ (copied first-party notices)
 * - npm/ (copied frontend notices)
 * - crates/ (copied crate notices)
 * - THIRD-PARTY-NOTICES.json
 * - THIRD-PARTY-NOTICES.md
 */
/** @param {NoticeOptions} [options] */
export async function generateReleaseNotices(options = {}) {
  const studioRoot = resolve(options.studioRoot || STUDIO_ROOT);
  const repoRoot = resolve(options.repoRoot || findRepositoryRoot(studioRoot));
  const candidateVersion = readCandidateVersion(studioRoot);
  const outDir = resolve(options.outDir || DEFAULT_OUTPUT_DIR);
  const writeFiles = options.writeFiles !== false;
  const failOnMissing = options.failOnMissing !== false; // Default true: strict check

  // Verify safe outDir
  const relOut = relative(studioRoot, outDir);
  if (relOut.startsWith("..") && !options.allowExternalOutDir) {
    if (outDir.includes("\0")) throw new Error("Unsafe output directory");
  }

  // 1. Load cargo metadata and lockfile
  const metadata = loadCargoMetadata(studioRoot, options);
  const checksumMap = loadCargoLockChecksums(studioRoot, options);
  const supplementalRoot = resolve(studioRoot, "legal/supplemental");
  const supplementalManifest = join(supplementalRoot, "manifest.json");
  /** @type {SupplementalManifest} */
  let supplements = { packages: [] };
  const supplementalManifestSnapshot = readRegularSnapshot(supplementalManifest, {
    bindPath: true,
    missingOk: true,
    label: "Supplemental license manifest",
    maxBytes: 16 * 1024 * 1024,
  });
  if (supplementalManifestSnapshot) {
    try {
      supplements = JSON.parse(supplementalManifestSnapshot.bytes.toString("utf8"));
    } catch {
      throw new Error("Supplemental license manifest is not valid JSON");
    }
  }
  if (supplements.schema && supplements.schema !== "tfsb.supplemental-license-material-v1") {
    throw new Error("Invalid supplemental license schema");
  }

  // 2. Resolve reachable crates
  const reachableCrates = resolveReachableCrates(metadata, options);

  // 3. Inventory crate notices & verify license text presence
  /** @type {CrateNoticePackage[]} */
  const crateInventory = [];
  /** @type {MissingMaterial[]} */
  const missingMaterials = [];

  for (const crate of reachableCrates) {
    const key = `${crate.name}@${crate.version}`;
    const checksum = checksumMap.get(key) || null;

    /** @type {{fileList?: string[], supplementalFiles?: string[]}} */
    const inventoryOptions = {};
    const mockCrateFiles = options.mockCrateFiles?.[key];
    const supplementalLicenses = options.supplementalLicenses?.[key];
    if (mockCrateFiles !== undefined) inventoryOptions.fileList = mockCrateFiles;
    if (supplementalLicenses !== undefined) inventoryOptions.supplementalFiles = supplementalLicenses;
    const inventory = inventoryPackageLicenses(crate, crate.crateDir, inventoryOptions);

    const dirName = `${crate.name}-${crate.version}`;
    /** @type {NoticeFile[]} */
    const files = inventory.licenseFiles.map((f) => ({
      fileName: f,
      sourcePath: crate.crateDir ? resolve(crate.crateDir, f) : null,
      relativePath: normalizeSafeRelativePath(`crates/${dirName}/${f}`),
    }));

    const supplemental = supplements.packages.find((entry) => entry.name === crate.name && entry.version === crate.version);
    if (supplemental) {
      if (supplemental.license !== crate.license || !/^[a-f0-9]{40}$/.test(supplemental.revision)) {
        throw new Error(`Supplemental license identity mismatch: ${key}`);
      }
      for (const record of supplemental.files) {
        const sourcePath = joinSafeRelative(supplementalRoot, record.path);
        let fd;
        try {
          fd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch {
          throw new Error(`Supplemental license bytes mismatch: ${key}`);
        }
        let bytes;
        try {
          const st = fstatSync(fd);
          if (!st.isFile() || st.size !== record.size) {
            throw new Error(`Supplemental license bytes mismatch: ${key}`);
          }
          bytes = readFileSync(fd);
          if (bytes.length !== record.size || sha256(bytes) !== record.sha256) {
            throw new Error(`Supplemental license bytes mismatch: ${key}`);
          }
        } finally {
          closeSync(fd);
        }
        files.push({ fileName: basename(record.path), sourcePath,
          relativePath: normalizeSafeRelativePath(`crates/${dirName}/upstream-${basename(record.path)}`) });
      }
      if (supplemental.files.length) {
        inventory.hasLicenseText = true;
        inventory.isMissingRequiredMaterial = false;
      }
    }

    crateInventory.push({
      name: crate.name,
      version: crate.version,
      license: crate.license,
      isProcMacro: crate.isProcMacro,
      checksum,
      dirName,
      files,
      hasLicenseText: inventory.hasLicenseText,
    });

    if (inventory.isMissingRequiredMaterial) {
      missingMaterials.push({
        name: crate.name,
        version: crate.version,
        license: crate.license,
        failureReason: inventory.failureReason,
      });
    }
  }

  // 4. Collect root notices
  const rootNotices = collectRootNotices(studioRoot, options);

  // 5. Collect npm notices
  const npmNotices = collectNpmDistributedNotices(studioRoot, options);
  const useFrontendSupplemental = options.frontendSupplemental === true
    || (options.frontendSupplemental !== false && options.cargoMetadata === undefined);
  const frontendNotices = useFrontendSupplemental && supplements.frontendPackages
    ? collectFrontendSupplementalNotices(studioRoot, repoRoot, supplementalRoot, supplements)
    : [];
  const requiresCurrentFrontendNotices = options.frontendSupplemental === true || options.cargoMetadata === undefined;
  if (!options.cargoMetadata) {
    const requiredRoot = ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "node-LICENSE.txt"];
    if (requiredRoot.some(name => !rootNotices.some(item => item.name === name))) {
      throw new Error("Required first-party or Node license material is absent");
    }
    if (npmNotices.length !== 4 || npmNotices.some(item => !item.hasLicenseText)) {
      throw new Error("Required distributed frontend license material is absent");
    }
  }
  if (requiresCurrentFrontendNotices
    && (frontendNotices.length !== REQUIRED_CURRENT_FRONTEND_IDENTITIES.length
      || frontendNotices.map((item) => `${item.name}@${item.version}`).join("\n") !== REQUIRED_CURRENT_FRONTEND_IDENTITIES.join("\n")
      || frontendNotices.some(item => !item.hasLicenseText))) {
    throw new Error("Required distributed frontend runtime identity material is absent");
  }

  // 6. Build manifest structure
  const validationStatus = missingMaterials.length === 0 ? "passed" : "failed";
  const manifestData = {
    root: {
      name: "@knowledge-forge-ai/theme-forge-nebular-fusion",
      version: candidateVersion,
      license: "AGPL-3.0-or-later",
      files: rootNotices.map((n) => n.relativePath),
    },
    npm: npmNotices.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      files: pkg.files.map((f) => f.relativePath),
      hasLicenseText: pkg.hasLicenseText,
    })),
    ...(frontendNotices.length > 0 ? {
      frontend: frontendNotices.map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        role: pkg.role,
        lockPackagePath: pkg.lockPackagePath,
        packageManifestSha256: pkg.packageManifestSha256,
        fixtureLockSha256: pkg.fixtureLockSha256,
        ...(pkg.licenseSourcePackage ? { licenseSourcePackage: pkg.licenseSourcePackage } : {}),
        ...(pkg.embeddedProvenance ? { embeddedProvenance: pkg.embeddedProvenance } : {}),
        files: pkg.files.map(({ fileName, relativePath }) => ({ fileName, relativePath })),
        hasLicenseText: pkg.hasLicenseText,
      })),
    } : {}),
    crates: crateInventory.map((c) => ({
      name: c.name,
      version: c.version,
      license: c.license,
      isProcMacro: c.isProcMacro,
      checksum: c.checksum,
      files: c.files.map((f) => f.relativePath),
      hasLicenseText: c.hasLicenseText,
    })),
    validation: {
      status: validationStatus,
      missingRequiredMaterial: missingMaterials,
    },
  };

  const renderedJson = renderThirdPartyNoticesJson(manifestData);
  const renderedMd = renderThirdPartyNoticesMarkdown(manifestData);

  // 7. Write files if requested
    /** @type {string[]} */
    const writtenFiles = [];
  if (writeFiles) {
    // A repeated build may replace its declared generated members, but must
    // never silently retain or overwrite unrelated files in the output tree.
    const expectedPaths = new Set([
      ...rootNotices.map(item => item.relativePath),
      ...npmNotices.flatMap(item => item.files.map(file => file.relativePath)),
      ...frontendNotices.flatMap(item => item.files.map(file => file.relativePath)),
      ...crateInventory.flatMap(item => item.files.map(file => file.relativePath)),
      "THIRD-PARTY-NOTICES.json", "THIRD-PARTY-NOTICES.md",
      ...(supplementalManifestSnapshot ? ["supplemental-license-provenance.json"] : []),
    ]);
    /** @param {string} directory @param {string} [prefix] */
    const inspectExisting = (directory, prefix = "") => {
      let dirHandle;
      try {
        dirHandle = opendirSync(directory);
      } catch (err) {
        const fsError = /** @type {NodeJS.ErrnoException} */ (err);
        if (fsError.code === "ENOENT" || fsError.code === "ENOTDIR") return;
        throw err;
      }
      try {
        let entry;
        while ((entry = dirHandle.readSync()) !== null) {
          const relativePath = prefix + entry.name;
          if (entry.isSymbolicLink()) throw new Error("Symlink in notice output");
          if (entry.isDirectory()) inspectExisting(join(directory, entry.name), relativePath + "/");
          else if (!entry.isFile() || !expectedPaths.has(relativePath)) throw new Error("Unowned file in notice output");
        }
      } finally {
        dirHandle.closeSync();
      }
    };
    inspectExisting(outDir);
    await mkdir(outDir, { recursive: true });
    if (supplementalManifestSnapshot) {
      await writeFile(join(outDir, "supplemental-license-provenance.json"), supplementalManifestSnapshot.bytes);
      writtenFiles.push("supplemental-license-provenance.json");
    }

    const rootDir = joinSafeRelative(outDir, "root");
    const npmDir = joinSafeRelative(outDir, "npm");
    const cratesDir = joinSafeRelative(outDir, "crates");

    await mkdir(rootDir, { recursive: true });
    await mkdir(npmDir, { recursive: true });
    await mkdir(cratesDir, { recursive: true });

    // Copy root files
    for (const notice of rootNotices) {
      if (notice.sourcePath && existsSync(notice.sourcePath)) {
        const dest = joinSafeRelative(outDir, notice.relativePath);
        await mkdir(dirname(dest), { recursive: true });
        await cp(notice.sourcePath, dest);
        await chmod(dest, 0o644);
        writtenFiles.push(notice.relativePath);
      }
    }

    // Copy npm files
    for (const pkg of npmNotices) {
      for (const file of pkg.files) {
        if (file.sourcePath && existsSync(file.sourcePath)) {
          const dest = joinSafeRelative(outDir, file.relativePath);
          await mkdir(dirname(dest), { recursive: true });
          await cp(file.sourcePath, dest);
          await chmod(dest, 0o644);
          writtenFiles.push(file.relativePath);
        }
      }
    }

    // Copy authenticated static frontend runtime license material.
    for (const pkg of frontendNotices) {
      for (const file of pkg.files) {
        if (file.bytes) {
          const dest = joinSafeRelative(outDir, file.relativePath);
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, file.bytes);
          await chmod(dest, 0o644);
          writtenFiles.push(file.relativePath);
        }
      }
    }

    // Copy crate files
    for (const crate of crateInventory) {
      for (const file of crate.files) {
        if (file.sourcePath && existsSync(file.sourcePath)) {
          const dest = joinSafeRelative(outDir, file.relativePath);
          await mkdir(dirname(dest), { recursive: true });
          await cp(file.sourcePath, dest);
          await chmod(dest, 0o644);
          writtenFiles.push(file.relativePath);
        }
      }
    }

    // Write manifest JSON and Markdown
    const jsonPath = joinSafeRelative(outDir, "THIRD-PARTY-NOTICES.json");
    const mdPath = joinSafeRelative(outDir, "THIRD-PARTY-NOTICES.md");

    await writeFile(jsonPath, renderedJson, "utf8");
    await writeFile(mdPath, renderedMd, "utf8");

    writtenFiles.push("THIRD-PARTY-NOTICES.json");
    writtenFiles.push("THIRD-PARTY-NOTICES.md");
    writtenFiles.sort();
  }

  // 8. Handle strict missing material check
  if (failOnMissing && missingMaterials.length > 0) {
    const list = missingMaterials.map((m) => `  - ${m.name}@${m.version} (${m.license || "unspecified"}): ${m.failureReason}`).join("\n");
    const err = Object.assign(new Error(
      `Absent required license material for ${missingMaterials.length} package(s).\n` +
      "Matching registry metadata is NOT sufficient when license text is absent:\n" +
      `${list}\n` +
      "Under project release policy, all distributed and build dependencies must have license text.",
    ), { missingMaterials, manifest: manifestData });
    throw err;
  }

  return {
    success: validationStatus === "passed",
    outDir,
    manifest: manifestData,
    missingMaterials,
    writtenFiles,
    renderedJson,
    renderedMd,
  };
}

// CLI Entrypoint
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  let outDir = DEFAULT_OUTPUT_DIR;
  let studioRoot = STUDIO_ROOT;
  let failOnMissing = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out-dir" || arg === "-o") {
      const value = args[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      outDir = resolve(value);
    } else if (arg === "--studio-root") {
      const value = args[++i];
      if (value === undefined) throw new Error("Missing value for --studio-root");
      studioRoot = resolve(value);
    } else if (arg === "--allow-missing" || arg === "--no-fail") {
      failOnMissing = false;
    } else if (arg === "--strict" || arg === "--fail-on-missing") {
      failOnMissing = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node release-notices.mjs [options]");
      console.log("Options:");
      console.log("  --out-dir, -o <path>    Output directory (default: src-tauri/release-notices)");
      console.log("  --studio-root <path>    Studio root directory (default: apps/studio)");
      console.log("  --allow-missing         Do not fail if packages lack license text (report only)");
      console.log("  --strict                Fail if packages lack license text (default)");
      process.exit(0);
    }
  }

  try {
    const result = await generateReleaseNotices({
      studioRoot,
      outDir,
      failOnMissing,
      allowExternalOutDir: true,
    });
    console.log(`Successfully generated release notices at: ${result.outDir}`);
    console.log(`Total crates: ${result.manifest.crates.length}`);
    console.log(`Crates with license text: ${result.manifest.crates.length - result.missingMaterials.length}`);
    if (result.missingMaterials.length > 0) {
      console.warn(`[WARNING] ${result.missingMaterials.length} packages lack license text.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] Release notices generation failed: ${message}`);
    process.exit(1);
  }
}
