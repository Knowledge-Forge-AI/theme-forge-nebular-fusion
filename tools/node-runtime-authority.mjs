// Maintained portable Node.js runtime authority for Darwin ARM64 and Linux arm64/x64.
// Single source of truth for the official Node 22.23.3 embedded sidecar runtime.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, existsSync, mkdirSync, copyFileSync, chmodSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { validateDarwinLinkage } from "./darwin-linkage-validator.mjs";

// The shared tools/ci/ci-contract.mjs NODE_RELEASE_IDENTITY is also a member of the published standalone
// Stellar Burst, Loom, Solar Sail and Terminal Nova trees and keeps describing their CI runtime. The
// Nebular embedded sidecar runtime is owned here so that it can move independently of those trees.
//
// Official Node.js 22.23.3 (Jod LTS, 2026-09-23). Its bundled Undici 6.28.1 is outside the 6.x affected
// range of GHSA-3wwx-pv8p-q78v (>=6.25.0 <6.28.1). SHASUMS256.txt, .asc and .sig were verified against the
// release-key list in nodejs/node README.md at v22.23.3 with key material from nodejs/release-keys; every
// archive digest matched the signed manifest and each executable was measured (docs ADR 0030 amendment).
export const NODE_RELEASE_IDENTITY = Object.freeze({
  version: "22.23.3",
  darwinArm64TarballSha256: "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
  nodeExecutableSha256: "68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b",
  nodeExecutableSize: 112_925_600,
  v8: "12.4.254.21-node.57",
  undici: "6.28.1",
  target: "aarch64-apple-darwin",
  tarballName: "node-v22.23.3-darwin-arm64.tar.gz",
  archiveUrl: "https://nodejs.org/download/release/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz",
  shasumsSha256: "4fe99a2ba9d552a6f51c13ed68fb11104cfa5df601aec616be689253a8139e7a",
  signingKeyFingerprint: "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356", // betterleaks:allow -- public Node.js release signing-key fingerprint
  signingKeyReleaser: "Antoine du Hamel <duhamelantoine1995@gmail.com>",
  targets: Object.freeze({
    "aarch64-apple-darwin": Object.freeze({
      archive: "node-v22.23.3-darwin-arm64.tar.gz",
      archiveSha256: "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
      executableSha256: "68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b",
      executableSize: 112_925_600,
      platform: "darwin",
      arch: "arm64",
    }),
    "aarch64-unknown-linux-gnu": Object.freeze({
      archive: "node-v22.23.3-linux-arm64.tar.xz",
      archiveSha256: "a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f",
      executableSha256: "d09e299258c24f7cdf6f5d5ec185e3a56512b27a697113735dac909f1cac7b8d",
      executableSize: 122_179_336,
      platform: "linux",
      arch: "arm64",
    }),
    "x86_64-unknown-linux-gnu": Object.freeze({
      archive: "node-v22.23.3-linux-x64.tar.xz",
      archiveSha256: "df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de",
      executableSha256: "fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48",
      executableSize: 124_827_920,
      platform: "linux",
      arch: "x64",
    }),
  }),
});

export const EXPECTED_NODE_VERSION = NODE_RELEASE_IDENTITY.version;
export const EXPECTED_TARBALL_NAME = NODE_RELEASE_IDENTITY.tarballName;
export const EXPECTED_ARCHIVE_URL = NODE_RELEASE_IDENTITY.archiveUrl;
export const EXPECTED_TARBALL_SHA256 = NODE_RELEASE_IDENTITY.darwinArm64TarballSha256;
export const EXPECTED_EXECUTABLE_SHA256 = NODE_RELEASE_IDENTITY.nodeExecutableSha256;
export const EXPECTED_EXECUTABLE_SIZE = NODE_RELEASE_IDENTITY.nodeExecutableSize;
export const EXPECTED_V8_VERSION = NODE_RELEASE_IDENTITY.v8;
export const EXPECTED_TARGET = NODE_RELEASE_IDENTITY.target;

// Primary release signer for official Node.js 22.23.3
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
 * Validates that an executable is the exact official portable Node 22.23.3 Darwin ARM64 runtime.
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
  const probe = spawnSync(executablePath, ["-p", "JSON.stringify({node:process.versions.node,v8:process.versions.v8,undici:process.versions.undici,arch:process.arch,platform:process.platform})"], {
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
  if (probeData.undici !== NODE_RELEASE_IDENTITY.undici) {
    throw new Error(`Portable Node runtime Undici mismatch: expected ${NODE_RELEASE_IDENTITY.undici}, got ${probeData.undici}`);
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

const ELF_MACHINE = Object.freeze({ arm64: 183, x64: 62 });

/**
 * Validates that an executable is the exact authenticated official Node runtime for a Linux target.
 * The executable is probed only when it can run on the current host platform/architecture.
 * @param {string} executablePath
 * @param {string} targetTriple
 * @returns {{ valid: boolean, version: string, v8: string, sha256: string, size: number, target: string, probed: boolean }}
 */
export function validateLinuxPortableNode(executablePath, targetTriple) {
  const identity = NODE_RELEASE_IDENTITY.targets?.[targetTriple];
  if (!identity || identity.platform !== "linux") {
    throw new Error(`No authenticated Linux Node runtime identity for target ${targetTriple}`);
  }
  const stat = lstatSync(executablePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Portable Node runtime must be a regular file: ${executablePath}`);
  }
  if (stat.size !== identity.executableSize) {
    throw new Error(`Portable Node runtime size mismatch for ${targetTriple}: expected ${identity.executableSize}, got ${stat.size} (${executablePath})`);
  }
  const bytes = readFileSync(executablePath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== identity.executableSha256) {
    throw new Error(`Portable Node runtime SHA-256 mismatch for ${targetTriple}: expected ${identity.executableSha256}, got ${actualSha256} (${executablePath})`);
  }
  if (bytes.length < 20 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes.readUInt16LE(18) !== ELF_MACHINE[identity.arch]) {
    throw new Error(`Portable Node runtime is not a 64-bit ELF for ${identity.arch} (${executablePath})`);
  }
  let probed = false;
  if (process.platform === "linux" && process.arch === identity.arch) {
    const probe = spawnSync(executablePath, ["-p", "JSON.stringify({node:process.versions.node,v8:process.versions.v8,undici:process.versions.undici,arch:process.arch,platform:process.platform})"], {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      timeout: 10_000,
    });
    if (probe.status !== 0 || probe.error) {
      throw new Error(`Failed to probe portable Node runtime at ${executablePath}: ${probe.error?.message || probe.stderr}`);
    }
    const data = JSON.parse(probe.stdout.trim());
    if (data.node !== EXPECTED_NODE_VERSION || data.v8 !== EXPECTED_V8_VERSION || data.undici !== NODE_RELEASE_IDENTITY.undici
        || data.platform !== "linux" || data.arch !== identity.arch) {
      throw new Error(`Portable Node runtime identity mismatch for ${targetTriple}: ${probe.stdout.trim()}`);
    }
    probed = true;
  }
  return {
    valid: true,
    version: EXPECTED_NODE_VERSION,
    v8: EXPECTED_V8_VERSION,
    sha256: identity.executableSha256,
    size: identity.executableSize,
    target: targetTriple,
    probed,
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

/**
 * Authenticates the official Darwin ARM64 archive of the embedded runtime and extracts its executable.
 * Signature and SHASUMS parsing use the shared locked verifier (openpgp 6.3.1, active release keyring);
 * this module then requires the embedded identity's signer, archive digest and executable identity.
 * @param {{ shasumsPath: string, tarballPath: string, outputNodePath: string }} options
 */
export async function authenticateEmbeddedDarwinNode(options) {
  const verifierUrls = [
    new URL("../../../tools/ci/verify-node-authenticity.mjs", import.meta.url), // Monorepo
    new URL("./ci/verify-node-authenticity.mjs", import.meta.url),              // Composed repo (tools -> tools/ci)
  ];
  const verifierUrl = verifierUrls.find(u => existsSync(u));
  if (!verifierUrl) throw new Error("[NODE_AUTH_FAIL] Shared Node authenticity verifier is unavailable.");
  const { verifyNodeAuthenticity } = await import(verifierUrl.href);
  const receipt = await verifyNodeAuthenticity({ version: EXPECTED_NODE_VERSION, ...options });
  if (receipt.signature.fingerprint !== PRIMARY_SIGNING_KEY_FINGERPRINT) {
    throw new Error(`[NODE_AUTH_FAIL] SHASUMS signer ${receipt.signature.fingerprint} is not the embedded runtime signer ${PRIMARY_SIGNING_KEY_FINGERPRINT}.`);
  }
  if (receipt.shasums.tarballEntrySha256 !== EXPECTED_TARBALL_SHA256 || receipt.tarball?.sha256 !== EXPECTED_TARBALL_SHA256) {
    throw new Error(`[NODE_AUTH_FAIL] ${EXPECTED_TARBALL_NAME} digest does not match the embedded runtime authority ${EXPECTED_TARBALL_SHA256}.`);
  }
  const runtime = validateDarwinPortableNode(options.outputNodePath, { validateLinkage: true });
  return { ...receipt, embeddedRuntime: { ...runtime, undici: NODE_RELEASE_IDENTITY.undici } };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
  const downloadDir = value("--authenticate-download");
  const outputNodePath = value("--output-node");
  const output = value("--output");
  try {
    if (!downloadDir || !outputNodePath) throw new Error("Usage: node-runtime-authority.mjs --authenticate-download <dir> --output-node <path> [--output <receipt.json>]");
    mkdirSync(downloadDir, { recursive: true });
    const shasumsPath = join(downloadDir, "SHASUMS256.txt.asc");
    const tarballPath = join(downloadDir, EXPECTED_TARBALL_NAME);
    if (!existsSync(shasumsPath) || !existsSync(tarballPath)) {
      const base = `https://nodejs.org/dist/v${EXPECTED_NODE_VERSION}`;
      for (const [url, path] of [[`${base}/SHASUMS256.txt.asc`, shasumsPath], [`${base}/${EXPECTED_TARBALL_NAME}`, tarballPath]]) {
        const response = await fetch(url, { redirect: "error" });
        if (!response.ok) throw new Error(`[NODE_AUTH_FAIL] Official Node release download failed: ${url} ${response.status}`);
        const { writeFileSync } = await import("node:fs");
        writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
      }
    }
    const receipt = await authenticateEmbeddedDarwinNode({ shasumsPath, tarballPath, outputNodePath });
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    if (output) {
      mkdirSync(dirname(resolve(output)), { recursive: true });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(resolve(output), text);
    }
    process.stdout.write(text);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
