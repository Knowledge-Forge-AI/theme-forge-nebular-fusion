// Maintained portable Node.js runtime authority for Darwin ARM64.
// Single source of truth for official Node 22.23.2 embedded sidecar runtime.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, existsSync, mkdirSync, copyFileSync, chmodSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { validateDarwinLinkage } from "./darwin-linkage-validator.mjs";

// Canonical identity from CI contract
const candidateUrls = [
  new URL("../../../tools/ci/ci-contract.mjs", import.meta.url), // Monorepo (apps/studio/tools -> repo root)
  new URL("./ci/ci-contract.mjs", import.meta.url),              // Composed repo (tools -> tools/ci)
  new URL("../tools/ci/ci-contract.mjs", import.meta.url),       // Composed alternative
];
const ciContractUrl = candidateUrls.find(u => existsSync(u)) || candidateUrls[0];

const { NODE_RELEASE_IDENTITY } = await import(ciContractUrl.href);

export { NODE_RELEASE_IDENTITY };

export const EXPECTED_NODE_VERSION = NODE_RELEASE_IDENTITY.version;
export const EXPECTED_TARBALL_NAME = NODE_RELEASE_IDENTITY.tarballName;
export const EXPECTED_ARCHIVE_URL = NODE_RELEASE_IDENTITY.archiveUrl;
export const EXPECTED_TARBALL_SHA256 = NODE_RELEASE_IDENTITY.darwinArm64TarballSha256;
export const EXPECTED_EXECUTABLE_SHA256 = NODE_RELEASE_IDENTITY.nodeExecutableSha256;
export const EXPECTED_EXECUTABLE_SIZE = NODE_RELEASE_IDENTITY.nodeExecutableSize;
export const EXPECTED_V8_VERSION = NODE_RELEASE_IDENTITY.v8;
export const EXPECTED_TARGET = NODE_RELEASE_IDENTITY.target;

// Primary release signer for official Node.js 22.23.2
export const PRIMARY_SIGNING_KEY_FINGERPRINT = NODE_RELEASE_IDENTITY.signingKeyFingerprint;
export const PRIMARY_SIGNING_RELEASER = NODE_RELEASE_IDENTITY.signingKeyReleaser;

/** @type {Record<string, string>} */
export const OFFICIAL_RELEASERS = Object.freeze({
  "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356": "Antoine du Hamel <duhamelantoine1995@gmail.com>",
  "DD792F5973C6DE52C432CBDAC77ABFA00DDBF2B7": "Juan José Arboleda <soyjuanarbol@gmail.com>",
  "CC68F5A3106FF448322E48ED27F5E38D5B0A215F": "Marco Ippolito <marcoippolito54@gmail.com>",
  "890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4": "Rafael Gonzaga <rafael.nunu@hotmail.com>",
  "C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C": "Richard Lau <richard.lau@ibm.com>",
  "108F52B48DB57BB0CC439B2997B01419BD92F80A": "Ruy Adorno <ruyadorno@hotmail.com>",
  "655F3B5C1FB3FA8D1A0CA6BDE4A7D232B936D2FD": "Stewart X Addison <sxa@ibm.com>",
  "A363A499291CBBC940DD62E41F10027AF002F8B0": "Ulises Gascón <ulisesgascongonzalez@gmail.com>",
});

/**
 * Validates that an executable is the exact official portable Node 22.23.2 Darwin ARM64 runtime.
 * @param {string} executablePath
 * @param {object} [options]
 * @param {boolean} [options.validateLinkage=true]
 * @returns {{ valid: boolean, version: string, v8: string, sha256: string, size: number, target: string }}
 */
export function validateDarwinPortableNode(executablePath, options = {}) {
  const stat = lstatSync(executablePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Portable Node runtime must be a regular file: ${executablePath}`);
  }

  if (stat.size !== EXPECTED_EXECUTABLE_SIZE) {
    throw new Error(`Portable Node runtime size mismatch: expected ${EXPECTED_EXECUTABLE_SIZE}, got ${stat.size} (${executablePath})`);
  }

  const bytes = readFileSync(executablePath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== EXPECTED_EXECUTABLE_SHA256) {
    throw new Error(`Portable Node runtime SHA-256 mismatch: expected ${EXPECTED_EXECUTABLE_SHA256}, got ${actualSha256} (${executablePath})`);
  }

  // Validate Mach-O 64-bit ARM64 header
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) {
    throw new Error(`Portable Node runtime is not a valid 64-bit ARM64 Mach-O binary (${executablePath})`);
  }

  // Probe runtime if executable
  const probe = spawnSync(executablePath, ["-p", "JSON.stringify({node:process.versions.node,v8:process.versions.v8,arch:process.arch,platform:process.platform})"], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
    timeout: 10_000,
  });

  if (probe.status !== 0 || probe.error) {
    throw new Error(`Failed to probe portable Node runtime at ${executablePath}: ${probe.error?.message || probe.stderr}`);
  }

  let probeData;
  try {
    probeData = JSON.parse(probe.stdout.trim());
  } catch {
    throw new Error(`Portable Node runtime probe emitted invalid JSON: ${probe.stdout}`);
  }

  if (probeData.node !== EXPECTED_NODE_VERSION) {
    throw new Error(`Portable Node runtime version mismatch: expected ${EXPECTED_NODE_VERSION}, got ${probeData.node}`);
  }
  if (probeData.v8 !== EXPECTED_V8_VERSION) {
    throw new Error(`Portable Node runtime V8 mismatch: expected ${EXPECTED_V8_VERSION}, got ${probeData.v8}`);
  }
  if (probeData.arch !== "arm64" || probeData.platform !== "darwin") {
    throw new Error(`Portable Node runtime architecture/platform mismatch: expected darwin/arm64, got ${probeData.platform}/${probeData.arch}`);
  }

  if (options.validateLinkage !== false) {
    const linkage = validateDarwinLinkage(executablePath);
    if (linkage.status !== "pass") {
      throw new Error(`Portable Node runtime has invalid dynamic linkage (${linkage.violations.length} violations):\n  ${linkage.violations.join("\n  ")}`);
    }
  }

  return {
    valid: true,
    version: EXPECTED_NODE_VERSION,
    v8: EXPECTED_V8_VERSION,
    sha256: EXPECTED_EXECUTABLE_SHA256,
    size: EXPECTED_EXECUTABLE_SIZE,
    target: EXPECTED_TARGET,
  };
}

/**
 * Validates an official Node.js Darwin ARM64 archive against the maintained authority.
 * @param {string} archivePath
 * @returns {{ valid: boolean, sha256: string, path: string }}
 */
export function validateDarwinNodeArchive(archivePath) {
  const stat = lstatSync(archivePath);
  if (!stat.isFile()) {
    throw new Error(`Node archive must be a regular file: ${archivePath}`);
  }

  const bytes = readFileSync(archivePath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== EXPECTED_TARBALL_SHA256) {
    throw new Error(`Node archive SHA-256 mismatch: expected ${EXPECTED_TARBALL_SHA256}, got ${actualSha256} (${archivePath})`);
  }

  return {
    valid: true,
    sha256: EXPECTED_TARBALL_SHA256,
    path: resolve(archivePath),
  };
}

/**
 * Verifies an official Node.js Darwin ARM64 archive against the maintained authority and extracts the portable binary.
 * @param {string} archivePath
 * @param {string} outputExecutablePath
 * @param {object} [options]
 * @param {boolean} [options.validateLinkage=true]
 * @returns {{ valid: boolean, path: string, version: string, v8: string, sha256: string, size: number, target: string }}
 */
export function verifyAndExtractDarwinNodeArchive(archivePath, outputExecutablePath, options = {}) {
  validateDarwinNodeArchive(archivePath);
  const resolvedOut = resolve(outputExecutablePath);
  const outDir = dirname(resolvedOut);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const prefix = EXPECTED_TARBALL_NAME.replace(/\.tar\.gz$/, "");
  const tarResult = spawnSync("tar", ["-xzf", resolve(archivePath), "-C", outDir], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C" },
    timeout: 30_000,
  });

  const extractedCandidate = join(outDir, `${prefix}/bin/node`);
  if (tarResult.status !== 0 || !existsSync(extractedCandidate)) {
    throw new Error(`Failed to extract portable Node runtime from archive: ${tarResult.error?.message || tarResult.stderr}`);
  }

  copyFileSync(extractedCandidate, resolvedOut);
  chmodSync(resolvedOut, 0o755);
  return validateDarwinPortableNode(resolvedOut, options);
}

/**
 * Locates an authenticated portable Node executable from known cache/outbox paths or options.
 * @param {object} [options]
 * @param {string[]} [options.searchPaths]
 * @returns {string | null}
 */
export function locateCachedPortableNode(options = {}) {
  const candidates = [
    ...(options.searchPaths || []),
    process.env.NEBULAR_PORTABLE_NODE,
    resolve(".outbox/authenticated-inputs/node"),
    resolve("authenticated-inputs/node"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        validateDarwinPortableNode(candidate, { validateLinkage: true });
        return resolve(candidate);
      } catch {
        // Continue searching
      }
    }
  }

  return null;
}
