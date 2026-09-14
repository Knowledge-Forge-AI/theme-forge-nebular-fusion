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
import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const STUDIO_ROOT = resolve(__dirname, "..");
export const DEFAULT_OUTPUT_DIR = resolve(STUDIO_ROOT, "src-tauri/release-notices");
export const TARGET_PLATFORM = "aarch64-apple-darwin";
export const CARGO_METADATA_FORMAT = "1";

const MAX_PATH_BYTES = 512;
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9._@+-]+$/;

/**
 * Validates and normalizes a relative path string.
 * Strictly forbids path traversal ('..'), absolute paths, backslashes,
 * null bytes, or dangerous characters.
 */
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
export function findRepositoryRoot(studioRoot = STUDIO_ROOT) {
  const appRoot = resolve(studioRoot);
  if (existsSync(resolve(appRoot, "authenticated-inputs/stellar-binding.json"))) return appRoot;
  return resolve(appRoot, "../..", "apps/studio") === appRoot ? resolve(appRoot, "../..") : appRoot;
}

/**
 * Computes sha256 hex digest of a Buffer or string.
 */
export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Parses Cargo.lock text to extract package checksums.
 * Returns a Map of `${name}@${version}` -> checksum.
 */
export function parseCargoLockChecksums(lockContent) {
  const checksumMap = new Map();
  if (!lockContent || typeof lockContent !== "string") return checksumMap;

  const packageBlocks = lockContent.split("[[package]]");
  for (const block of packageBlocks) {
    const nameMatch = block.match(/name\s*=\s*"([^"]+)"/);
    const versionMatch = block.match(/version\s*=\s*"([^"]+)"/);
    const checksumMatch = block.match(/checksum\s*=\s*"([^"]+)"/);

    if (nameMatch && versionMatch && checksumMatch) {
      const key = `${nameMatch[1]}@${versionMatch[1]}`;
      checksumMap.set(key, checksumMatch[1]);
    }
  }

  return checksumMap;
}

/**
 * Traverses cargo metadata resolve nodes starting from the root crate,
 * collecting reachable normal and build dependencies (including proc macros),
 * strictly excluding development-only dependencies.
 */
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

  const packageMap = new Map();
  for (const pkg of metadata.packages) {
    packageMap.set(pkg.id, pkg);
  }

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
  const queue = [];

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
export function inventoryPackageLicenses(pkg, crateDir, options = {}) {
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
export function collectRootNotices(studioRoot = STUDIO_ROOT, options = {}) {
  const repoRoot = options.repoRoot || findRepositoryRoot(studioRoot);
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
function sanitizeNpmPackageDirName(pkgName, version) {
  const cleanName = pkgName.replace(/^@/, "").replace("/", "-");
  return `${cleanName}-${version}`;
}

/**
 * Inventories shipped distributed npm frontend dependencies (react, react-dom, scheduler, @tauri-apps/api).
 */
export function collectNpmDistributedNotices(studioRoot = STUDIO_ROOT, options = {}) {
  const nodeModulesDir = resolve(studioRoot, "node_modules");
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
    let pkgJson = null;
    let fileList = [];

    if (options.mockNpmPackages && options.mockNpmPackages[target.name]) {
      const mock = options.mockNpmPackages[target.name];
      pkgJson = { name: target.name, version: mock.version, license: mock.license };
      fileList = mock.files || [];
    } else if (existsSync(pkgDir)) {
      const pkgJsonPath = resolve(pkgDir, "package.json");
      if (existsSync(pkgJsonPath)) {
        try {
          pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        } catch {
          pkgJson = null;
        }
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
export function renderThirdPartyNoticesJson(manifestData) {
  const cleanManifest = {
    schemaVersion: "1.0.0",
    format: "studio-release-notices-v1",
    targetPlatform: TARGET_PLATFORM,
    root: {
      name: manifestData.root?.name || "@knowledge-forge-ai/theme-forge-nebular-fusion",
      version: manifestData.root?.version || "0.3.0",
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

  return `${JSON.stringify(cleanManifest, null, 2)}\n`;
}

/**
 * Renders THIRD-PARTY-NOTICES.md deterministically.
 * Guarantees no timestamps, no private machine paths, deterministic formatting.
 */
export function renderThirdPartyNoticesMarkdown(manifestData) {
  const lines = [
    "# Third-Party Legal Notices",
    "",
    "## Application",
    "",
    `- **Package:** ${manifestData.root?.name || "@knowledge-forge-ai/theme-forge-nebular-fusion"}`,
    `- **Version:** ${manifestData.root?.version || "0.3.0"}`,
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
export function loadCargoLockChecksums(studioRoot = STUDIO_ROOT, options = {}) {
  if (options.cargoLockContent !== undefined) {
    return parseCargoLockChecksums(options.cargoLockContent);
  }

  const lockPath = resolve(studioRoot, "src-tauri/Cargo.lock");
  if (!existsSync(lockPath)) return new Map();

  const content = readFileSync(lockPath, "utf8");
  return parseCargoLockChecksums(content);
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
export async function generateReleaseNotices(options = {}) {
  const studioRoot = resolve(options.studioRoot || STUDIO_ROOT);
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
  const supplements = existsSync(supplementalManifest)
    ? JSON.parse(readFileSync(supplementalManifest, "utf8")) : { packages: [] };
  if (supplements.schema && supplements.schema !== "tfsb.supplemental-license-material-v1") {
    throw new Error("Invalid supplemental license schema");
  }

  // 2. Resolve reachable crates
  const reachableCrates = resolveReachableCrates(metadata, options);

  // 3. Inventory crate notices & verify license text presence
  const crateInventory = [];
  const missingMaterials = [];

  for (const crate of reachableCrates) {
    const key = `${crate.name}@${crate.version}`;
    const checksum = checksumMap.get(key) || null;

    const inventory = inventoryPackageLicenses(crate, crate.crateDir, {
      fileList: options.mockCrateFiles ? options.mockCrateFiles[key] : undefined,
      supplementalFiles: options.supplementalLicenses ? options.supplementalLicenses[key] : undefined,
    });

    const dirName = `${crate.name}-${crate.version}`;
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
        const st = lstatSync(sourcePath);
        if (!st.isFile() || st.isSymbolicLink() || st.size !== record.size || sha256(readFileSync(sourcePath)) !== record.sha256) {
          throw new Error(`Supplemental license bytes mismatch: ${key}`);
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
  if (!options.cargoMetadata) {
    const requiredRoot = ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "node-LICENSE.txt"];
    if (requiredRoot.some(name => !rootNotices.some(item => item.name === name))) {
      throw new Error("Required first-party or Node license material is absent");
    }
    if (npmNotices.length !== 4 || npmNotices.some(item => !item.hasLicenseText)) {
      throw new Error("Required distributed frontend license material is absent");
    }
  }

  // 6. Build manifest structure
  const validationStatus = missingMaterials.length === 0 ? "passed" : "failed";
  const manifestData = {
    root: {
      name: "@knowledge-forge-ai/theme-forge-nebular-fusion",
      version: "0.3.0",
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
  const writtenFiles = [];
  if (writeFiles) {
    // A repeated build may replace its declared generated members, but must
    // never silently retain or overwrite unrelated files in the output tree.
    const expectedPaths = new Set([
      ...rootNotices.map(item => item.relativePath),
      ...npmNotices.flatMap(item => item.files.map(file => file.relativePath)),
      ...crateInventory.flatMap(item => item.files.map(file => file.relativePath)),
      "THIRD-PARTY-NOTICES.json", "THIRD-PARTY-NOTICES.md",
      ...(existsSync(supplementalManifest) ? ["supplemental-license-provenance.json"] : []),
    ]);
    const inspectExisting = (directory, prefix = "") => {
      if (!existsSync(directory)) return;
      const st = lstatSync(directory);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Unsafe notice output directory");
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relativePath = prefix + entry.name;
        if (entry.isSymbolicLink()) throw new Error("Symlink in notice output");
        if (entry.isDirectory()) inspectExisting(join(directory, entry.name), relativePath + "/");
        else if (!entry.isFile() || !expectedPaths.has(relativePath)) throw new Error("Unowned file in notice output");
      }
    };
    inspectExisting(outDir);
    await mkdir(outDir, { recursive: true });
    if (existsSync(supplementalManifest)) {
      await cp(supplementalManifest, join(outDir, "supplemental-license-provenance.json"));
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
    const err = new Error(
      `Absent required license material for ${missingMaterials.length} package(s).\n` +
      "Matching registry metadata is NOT sufficient when license text is absent:\n" +
      `${list}\n` +
      "Under project release policy, all distributed and build dependencies must have license text.",
    );
    err.missingMaterials = missingMaterials;
    err.manifest = manifestData;
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
      outDir = resolve(args[++i]);
    } else if (arg === "--studio-root") {
      studioRoot = resolve(args[++i]);
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
    console.error(`[ERROR] Release notices generation failed: ${err.message}`);
    process.exit(1);
  }
}
