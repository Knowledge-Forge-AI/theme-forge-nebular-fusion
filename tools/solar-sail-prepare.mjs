#!/usr/bin/env node
// @ts-check
import { createHash } from "node:crypto";
import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const studioRoot = resolve(__dirname, "..");
const repoRoot = resolve(studioRoot, "../..");
const solarSailRoot = resolve(repoRoot, "packages/solar-sail");
const srcTauriRoot = resolve(studioRoot, "src-tauri");
const payloadRoot = resolve(srcTauriRoot, "solar-sail-payload");
const adapterDir = resolve(srcTauriRoot, "solar-sail-adapter");

export const EXPECTED_SOLAR_SAIL_NAME = "@knowledge-forge-ai/theme-forge-solar-sail";
export const EXPECTED_SOLAR_SAIL_VERSION = "0.1.0";
export const SUPPORTED_SOLAR_SAIL_VERSIONS = Object.freeze(["0.1.0"]);
export const EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST = "f5cecdcea0a1c6a58d29b2276dba61c94d06655cdb71f7cc3f04b843da1026f0";

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
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Missing package.json at ${pkgJsonPath}`);
  }
  const pkgContent = await readFile(pkgJsonPath, "utf8");
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
    if (!existsSync(fullPath)) {
      throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Missing required runtime member: ${relPath}`);
    }
    const bytes = await readFile(fullPath);
    members.push({
      path: relPath,
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
  }

  for (const relPath of SOLAR_SAIL_DECLARATION_MEMBERS) {
    const fullPath = resolve(packageRoot, relPath);
    if (!existsSync(fullPath)) {
      throw new Error(`[SOLAR_SAIL_BINDING_FAIL] Missing required declaration member: ${relPath}`);
    }
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

export async function prepareSolarSail() {
  console.log("Validating and building packages/solar-sail...");
  if (existsSync(solarSailRoot)) {
    const buildResult = spawnSync("npm", ["run", "build"], {
      cwd: solarSailRoot,
      stdio: "inherit",
    });
    if (buildResult.status !== 0) {
      throw new Error(`Failed to build packages/solar-sail (exit code: ${buildResult.status})`);
    }
  }

  const distSrc = resolve(solarSailRoot, "dist");
  if (!existsSync(distSrc)) {
    throw new Error(`packages/solar-sail/dist missing at ${distSrc}`);
  }

  console.log("Authenticating candidate Solar Sail source against approved binding digest...");
  const candidateBinding = await authenticateSolarSailCandidate(solarSailRoot, EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST);

  console.log("Preparing solar-sail-payload in src-tauri...");
  await rm(payloadRoot, { recursive: true, force: true });
  await mkdir(payloadRoot, { recursive: true, mode: 0o755 });

  await cp(distSrc, resolve(payloadRoot, "dist"), { recursive: true });
  await cp(resolve(solarSailRoot, "package.json"), resolve(payloadRoot, "package.json"));

  for (const doc of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"]) {
    const docPath = resolve(solarSailRoot, doc);
    if (existsSync(docPath)) {
      await cp(docPath, resolve(payloadRoot, doc));
    }
  }

  // Write cryptographic binding manifest
  const bindingPath = resolve(payloadRoot, "solar-sail-binding.json");
  await writeFile(bindingPath, JSON.stringify(candidateBinding, null, 2) + "\n", "utf8");

  // Verify the newly prepared payload
  const verifiedBinding = await authenticateSolarSailCandidate(payloadRoot, EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST);
  if (verifiedBinding.inventoryDigest !== candidateBinding.inventoryDigest) {
    throw new Error("[SOLAR_SAIL_BINDING_FAIL] Prepared payload digest does not match source candidate digest.");
  }

  console.log("Ensuring solar-sail-adapter directory...");
  await mkdir(adapterDir, { recursive: true, mode: 0o755 });
  console.log(`Solar Sail payload preparation complete: inventoryDigest=${candidateBinding.inventoryDigest}`);
  return candidateBinding;
}

if (process.argv[1] === __filename) {
  prepareSolarSail().catch((err) => {
    console.error("FATAL:", err.message);
    process.exit(1);
  });
}

