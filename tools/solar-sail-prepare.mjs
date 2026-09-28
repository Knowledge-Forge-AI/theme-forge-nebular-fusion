#!/usr/bin/env node
// @ts-check
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, open, rm, writeFile, readFile } from "node:fs/promises";
import { constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { repositoryRootForStudio } from "./sidecar-common.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const studioRoot = resolve(__dirname, "..");
const srcTauriRoot = resolve(studioRoot, "src-tauri");
const payloadRoot = resolve(srcTauriRoot, "solar-sail-payload");
const adapterDir = resolve(srcTauriRoot, "solar-sail-adapter");

export const EXPECTED_SOLAR_SAIL_NAME = "@knowledge-forge-ai/theme-forge-solar-sail";
export const EXPECTED_SOLAR_SAIL_VERSION = "0.2.0";
export const SUPPORTED_SOLAR_SAIL_VERSIONS = Object.freeze(["0.2.0", "0.1.0"]);
export const EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST = "18a9eab48578c47439597c5e68f6d5e9f6db6ca6aa2647a70649e0b85f8e38b5";

export const SOLAR_SAIL_RUNTIME_MEMBERS = Object.freeze([
  "dist/cli.js",
  "dist/compiler.js",
  "dist/emitter.js",
  "dist/index.js",
  "dist/legal.js",
  "dist/profile.js",
  "dist/types.js",
  "dist/validator.js",
]);

export const SOLAR_SAIL_DECLARATION_MEMBERS = Object.freeze([
  "dist/cli.d.ts",
  "dist/compiler.d.ts",
  "dist/emitter.d.ts",
  "dist/index.d.ts",
  "dist/legal.d.ts",
  "dist/profile.d.ts",
  "dist/types.d.ts",
  "dist/validator.d.ts",
]);

/**
 * Computes SHA-256 hexadecimal digest of buffer or string.
 * @param {Buffer | Uint8Array | string} content
 * @returns {string}
 */
export function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Authenticates candidate package as a valid, untampered Solar Sail distribution.
 * Fails closed if name, version, or runtime member digests do not match.
 *
 * @param {string} packageRoot
 * @param {string | null} [expectedInventoryDigest]
 * @returns {Promise<{
 *   schema: string,
 *   name: string,
 *   version: string,
 *   packageJsonSha256: string,
 *   inventoryDigest: string,
 *   runtimeMemberCount: number,
 *   members: Array<{path: string, size: number, sha256: string}>,
 *   generatedAt: string
 * }>}
 */
export async function authenticateSolarSailCandidate(packageRoot, expectedInventoryDigest = null) {
  const pkgJsonPath = resolve(packageRoot, "package.json");
  let pkgContent;
  try {
    const handle = await open(pkgJsonPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      pkgContent = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Missing package.json at ${pkgJsonPath}`);
  }
  let pkg;
  try {
    pkg = JSON.parse(pkgContent);
  } catch (err) {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Malformed package.json at ${pkgJsonPath}`);
  }

  if (pkg.name !== EXPECTED_SOLAR_SAIL_NAME) {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Package name mismatch: expected ${EXPECTED_SOLAR_SAIL_NAME}, got ${pkg.name}`);
  }
  if (!SUPPORTED_SOLAR_SAIL_VERSIONS.includes(pkg.version)) {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Unsupported Solar Sail version ${pkg.version}; expected one of ${SUPPORTED_SOLAR_SAIL_VERSIONS.join(", ")}`);
  }

  const packageJsonSha256 = sha256Hex(pkgContent);

  /** @type {Array<{path: string, size: number, sha256: string}>} */
  const members = [];

  for (const relPath of SOLAR_SAIL_RUNTIME_MEMBERS) {
    const fullPath = resolve(packageRoot, relPath);
    let handle;
    try {
      handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Missing required runtime member: ${relPath}`);
    }
    let bytes;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    members.push({
      path: relPath,
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
  }

  for (const relPath of SOLAR_SAIL_DECLARATION_MEMBERS) {
    const fullPath = resolve(packageRoot, relPath);
    let handle;
    try {
      handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Missing required declaration member: ${relPath}`);
    }
    await handle.close();
  }

  // Sort members deterministically
  members.sort((a, b) => a.path.localeCompare(b.path));

  const inventorySummary = members.map((m) => `${m.path}:${m.sha256}`).join("\n");
  const inventoryDigest = sha256Hex(inventorySummary);

  if (expectedInventoryDigest && inventoryDigest !== expectedInventoryDigest) {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Solar Sail candidate inventory digest mismatch: expected ${expectedInventoryDigest}, got ${inventoryDigest}`);
  }

  return {
    schema: "tfsb.solar-sail-binding-v1",
    name: pkg.name,
    version: pkg.version,
    packageJsonSha256,
    inventoryDigest,
    runtimeMemberCount: members.length,
    members,
    generatedAt: new Date().toISOString(),
  };
}

export function extractTarballSafely(archivePath, destination) {
  const listing = spawnSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (listing.status !== 0 || !listing.stdout) {
    throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Failed to inspect tarball: ${archivePath}`);
  }
  const entries = listing.stdout.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Archive is empty: ${archivePath}`);
  }
  for (const entry of entries) {
    const normalized = entry.normalize("NFC");
    const components = normalized.split("/").filter(Boolean);
    if (!normalized.startsWith("package/") || components.some((c) => c === "." || c === ".." || c.includes("\\"))) {
      throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Archive contains unsafe path: '${entry}'`);
    }
  }
  const extract = spawnSync("tar", ["-xzf", archivePath, "-C", destination], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (extract.status !== 0) {
    throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Failed to extract tarball: ${archivePath}`);
  }
  const pkgRoot = resolve(destination, "package");
  if (!existsSync(pkgRoot)) {
    throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Extracted package root missing: ${pkgRoot}`);
  }
  return pkgRoot;
}

export async function prepareSolarSail(options = {}) {
  const currentStudioRoot = options.studioRoot ? resolve(options.studioRoot) : studioRoot;
  const currentRepoRoot = repositoryRootForStudio(currentStudioRoot);
  const monorepoCandidate = resolve(currentRepoRoot, "packages/solar-sail");
  const authTarballDir = resolve(currentRepoRoot, "authenticated-inputs/solar-sail-tarball");
  const targetPayloadRoot = options.payloadRoot ? resolve(options.payloadRoot) : resolve(currentStudioRoot, "src-tauri/solar-sail-payload");
  const targetAdapterDir = options.adapterDir ? resolve(options.adapterDir) : resolve(currentStudioRoot, "src-tauri/solar-sail-adapter");

  let candidateDir = null;
  let scratchRoot = null;

  const explicitPackageRoot = options.packageRoot || options["package-root"] || null;
  const isSourceBuild = Boolean(explicitPackageRoot);

  if (explicitPackageRoot) {
    let packageRoot = resolve(explicitPackageRoot);
    const nestedNix = resolve(packageRoot, "lib/node_modules/@knowledge-forge-ai/theme-forge-solar-sail");
    if (existsSync(resolve(nestedNix, "package.json"))) {
      packageRoot = nestedNix;
    }
    if (!existsSync(resolve(packageRoot, "package.json"))) {
      throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Missing package.json in Solar Sail package root: ${packageRoot}`);
    }
    candidateDir = packageRoot;
  } else {
    const explicitTarball = options.tarball || process.env.TFSS_SOLAR_SAIL_TARBALL || process.env.TFSB_STUDIO_SOLAR_SAIL_TARBALL || null;

    if (explicitTarball) {
      if (!existsSync(explicitTarball)) {
        throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Explicit tarball not found: ${explicitTarball}`);
      }
      scratchRoot = await mkdtemp(join(tmpdir(), "solar-sail-extract-"));
      candidateDir = extractTarballSafely(explicitTarball, scratchRoot);
    } else if (existsSync(resolve(monorepoCandidate, "package.json"))) {
      // Monorepo source layout
      console.log("Validating and building packages/solar-sail from monorepo source...");
      const buildResult = spawnSync("npm", ["run", "build"], {
        cwd: monorepoCandidate,
        stdio: "inherit",
      });
      if (buildResult.status !== 0) {
        throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Failed to build packages/solar-sail (exit code: ${buildResult.status})`);
      }
      candidateDir = monorepoCandidate;
    } else {
      // Check for staged authenticated tarball
      let tarballPath = null;
      if (existsSync(authTarballDir)) {
        const candidates = readdirSync(authTarballDir).filter((f) => f.endsWith(".tgz"));
        if (candidates.length === 1) {
          tarballPath = resolve(authTarballDir, candidates[0]);
        }
      }

      if (!tarballPath || !existsSync(tarballPath)) {
        throw new Error("[SOLAR_SAIL_PREPARE_FAIL] No Solar Sail candidate source available in monorepo packages/solar-sail or authenticated-inputs/solar-sail-tarball");
      }

      console.log(`Extracting authenticated Solar Sail tarball: ${tarballPath}`);
      scratchRoot = await mkdtemp(join(tmpdir(), "solar-sail-extract-"));
      candidateDir = extractTarballSafely(tarballPath, scratchRoot);
    }
  }

  try {
    const distSrc = resolve(candidateDir, "dist");
    if (!existsSync(distSrc)) {
      throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] packages/solar-sail/dist missing at ${distSrc}`);
    }

    console.log("Authenticating candidate Solar Sail source against approved binding digest...");
    const expectedDigest = isSourceBuild
      ? (options.expectedInventoryDigest || null)
      : EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST;

    const candidateBinding = await authenticateSolarSailCandidate(candidateDir, expectedDigest);
    delete candidateBinding.generatedAt;

    console.log("Preparing solar-sail-payload in src-tauri...");
    await rm(targetPayloadRoot, { recursive: true, force: true });
    await mkdir(targetPayloadRoot, { recursive: true, mode: 0o755 });

    await cp(distSrc, resolve(targetPayloadRoot, "dist"), { recursive: true });
    await cp(resolve(candidateDir, "package.json"), resolve(targetPayloadRoot, "package.json"));

    for (const doc of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"]) {
      const docPath = resolve(candidateDir, doc);
      if (existsSync(docPath)) {
        await cp(docPath, resolve(targetPayloadRoot, doc));
      } else if (doc !== "README.md") {
        throw new Error(`[SOLAR_SAIL_PREPARE_FAIL] Required legal document missing in candidate: ${doc}`);
      }
    }

    // Write cryptographic binding manifest
    const bindingPath = resolve(targetPayloadRoot, "solar-sail-binding.json");
    await writeFile(bindingPath, JSON.stringify(candidateBinding, null, 2) + "\n", "utf8");

    // Verify the newly prepared payload
    const verifiedBinding = await authenticateSolarSailCandidate(targetPayloadRoot, expectedDigest);
    if (verifiedBinding.inventoryDigest !== candidateBinding.inventoryDigest) {
      throw new Error("[SOLAR_SAIL_BINDING_FAIL] Prepared payload digest does not match source candidate digest.");
    }

    console.log("Ensuring solar-sail-adapter directory...");
    await mkdir(targetAdapterDir, { recursive: true, mode: 0o755 });
    console.log(`Solar Sail payload preparation complete: inventoryDigest=${candidateBinding.inventoryDigest}`);
    return candidateBinding;
  } finally {
    if (scratchRoot) {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  }
}

export function parseSolarSailArgs(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tarball" && i + 1 < argv.length) {
      options.tarball = argv[++i];
    } else if ((arg === "--package-root" || arg === "--solar-package-root") && i + 1 < argv.length) {
      options.packageRoot = argv[++i];
    } else if (arg === "--studio-root" && i + 1 < argv.length) {
      options.studioRoot = argv[++i];
    } else if (arg === "--payload-root" && i + 1 < argv.length) {
      options.payloadRoot = argv[++i];
    } else if (arg === "--adapter-dir" && i + 1 < argv.length) {
      options.adapterDir = argv[++i];
    } else if (!arg.startsWith("--") && !options.tarball) {
      options.tarball = arg;
    }
  }
  return options;
}

if (process.argv[1] === __filename) {
  prepareSolarSail(parseSolarSailArgs(process.argv.slice(2))).catch((err) => {
    console.error("FATAL:", err.message);
    process.exit(1);
  });
}
