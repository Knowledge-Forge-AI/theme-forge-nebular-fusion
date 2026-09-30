// Maintained portable Node.js runtime authority for Darwin ARM64 and Linux arm64/x64.
// Single source of truth for the official Node 22.23.3 embedded sidecar runtime.
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const PROBE_SCRIPT = "JSON.stringify({node:process.versions.node,v8:process.versions.v8,undici:process.versions.undici,arch:process.arch,platform:process.platform})";
const SHASUMS_FILENAME = "SHASUMS256.txt.asc";

// Descriptor-first file access. Every file this authority accepts is opened exactly once without
// following a symbolic link (and without blocking on a FIFO); its type, size and identity come from
// the open descriptor, its bytes are read through that descriptor, and the identity must be unchanged
// afterwards. No pathname is checked first and then re-read.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptorIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs;
}

function openRegular(path, label) {
  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "EMLINK") throw new Error(`${label} must be a regular file, not a symbolic link: ${path}`);
    throw error;
  }
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  return { fd, stat };
}

function readDescriptor(fd, stat, path, label) {
  const bytes = Buffer.allocUnsafe(stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new Error(`${label} was truncated while it was read: ${path}`);
    offset += count;
  }
  if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) throw new Error(`${label} grew while it was read: ${path}`);
  if (!sameIdentity(descriptorIdentity(stat), descriptorIdentity(fstatSync(fd)))) throw new Error(`${label} changed while it was read: ${path}`);
  return bytes;
}

/**
 * Reads one regular file through a single no-follow descriptor.
 * @param {string} path
 * @param {{ label?: string }} [options]
 * @returns {{ bytes: Buffer, identity: { dev: number, ino: number, size: number, mode: number, mtimeMs: number } }}
 */
export function readRegularFile(path, options = {}) {
  const label = options.label ?? "File";
  const { fd, stat } = openRegular(path, label);
  try {
    return { bytes: readDescriptor(fd, stat, path, label), identity: descriptorIdentity(stat) };
  } finally {
    closeSync(fd);
  }
}

function readOptionalRegular(path, label) {
  try {
    return readRegularFile(path, { label });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function writeNewFile(path, bytes, mode) {
  const fd = openSync(path, CREATE_FLAGS, mode);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally {
    closeSync(fd);
  }
}

// After a runtime has been executed or inspected by pathname, the descriptor must still describe the
// same bytes and the pathname must still name the inode that was measured.
function requireUnchangedAfterUse(fd, stat, path, label) {
  const opened = descriptorIdentity(stat);
  const named = lstatSync(path);
  if (!sameIdentity(opened, descriptorIdentity(fstatSync(fd))) || named.isSymbolicLink() || !sameIdentity(opened, descriptorIdentity(named))) {
    throw new Error(`${label} was replaced or modified while it was validated: ${path}`);
  }
}

function probeNode(command, displayPath) {
  const probe = spawnSync(command, ["-p", PROBE_SCRIPT], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
    timeout: 10_000,
  });
  if (probe.status !== 0 || probe.error) {
    throw new Error(`Failed to probe portable Node runtime at ${displayPath}: ${probe.error?.message || probe.stderr}`);
  }
  try {
    return { data: JSON.parse(probe.stdout.trim()), stdout: probe.stdout };
  } catch {
    throw new Error(`Portable Node runtime probe emitted invalid JSON: ${probe.stdout}`);
  }
}

/**
 * Validates that an executable is the exact official portable Node 22.23.3 Darwin ARM64 runtime.
 * @param {string} executablePath
 * @param {object} [options]
 * @param {boolean} [options.validateLinkage=true]
 * @returns {{ valid: boolean, version: string, v8: string, sha256: string, size: number, target: string }}
 */
export function validateDarwinPortableNode(executablePath, options = {}) {
  const label = "Portable Node runtime";
  const { fd, stat } = openRegular(executablePath, label);
  try {
    if (stat.size !== EXPECTED_EXECUTABLE_SIZE) {
      throw new Error(`Portable Node runtime size mismatch: expected ${EXPECTED_EXECUTABLE_SIZE}, got ${stat.size} (${executablePath})`);
    }
    const bytes = readDescriptor(fd, stat, executablePath, label);
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== EXPECTED_EXECUTABLE_SHA256) {
      throw new Error(`Portable Node runtime SHA-256 mismatch: expected ${EXPECTED_EXECUTABLE_SHA256}, got ${actualSha256} (${executablePath})`);
    }

    // Validate Mach-O 64-bit ARM64 header
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) {
      throw new Error(`Portable Node runtime is not a valid 64-bit ARM64 Mach-O binary (${executablePath})`);
    }

    // Darwin cannot execute an open descriptor, so the measured pathname is executed and must
    // still name the measured inode afterwards (a replace-and-restore during the probe is not
    // excluded by this check; the Linux validator executes the descriptor itself).
    const { data: probeData } = probeNode(executablePath, executablePath);
    requireUnchangedAfterUse(fd, stat, executablePath, label);

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
      requireUnchangedAfterUse(fd, stat, executablePath, label);
      if (linkage.status !== "pass") {
        throw new Error(`Portable Node runtime has invalid dynamic linkage (${linkage.violations.length} violations):\n  ${linkage.violations.join("\n  ")}`);
      }
    }
  } finally {
    closeSync(fd);
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
 * The executable is probed only when it can run on the current host platform/architecture; the probe
 * executes the already measured open descriptor through /proc/self/fd rather than the pathname.
 * @param {string} executablePath
 * @param {string} targetTriple
 * @returns {{ valid: boolean, version: string, v8: string, sha256: string, size: number, target: string, probed: boolean }}
 */
export function validateLinuxPortableNode(executablePath, targetTriple) {
  const identity = NODE_RELEASE_IDENTITY.targets?.[targetTriple];
  if (!identity || identity.platform !== "linux") {
    throw new Error(`No authenticated Linux Node runtime identity for target ${targetTriple}`);
  }
  const label = "Portable Node runtime";
  const { fd, stat } = openRegular(executablePath, label);
  let probed = false;
  try {
    if (stat.size !== identity.executableSize) {
      throw new Error(`Portable Node runtime size mismatch for ${targetTriple}: expected ${identity.executableSize}, got ${stat.size} (${executablePath})`);
    }
    const bytes = readDescriptor(fd, stat, executablePath, label);
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== identity.executableSha256) {
      throw new Error(`Portable Node runtime SHA-256 mismatch for ${targetTriple}: expected ${identity.executableSha256}, got ${actualSha256} (${executablePath})`);
    }
    if (bytes.length < 20 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes.readUInt16LE(18) !== ELF_MACHINE[identity.arch]) {
      throw new Error(`Portable Node runtime is not a 64-bit ELF for ${identity.arch} (${executablePath})`);
    }
    if (process.platform === "linux" && process.arch === identity.arch) {
      const { data, stdout } = probeNode(`/proc/self/fd/${fd}`, executablePath);
      requireUnchangedAfterUse(fd, stat, executablePath, label);
      if (data.node !== EXPECTED_NODE_VERSION || data.v8 !== EXPECTED_V8_VERSION || data.undici !== NODE_RELEASE_IDENTITY.undici
          || data.platform !== "linux" || data.arch !== identity.arch) {
        throw new Error(`Portable Node runtime identity mismatch for ${targetTriple}: ${stdout.trim()}`);
      }
      probed = true;
    }
  } finally {
    closeSync(fd);
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
  const { bytes } = readRegularFile(archivePath, { label: "Node archive" });
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== EXPECTED_TARBALL_SHA256) {
    throw new Error(`Node archive SHA-256 mismatch: expected ${EXPECTED_TARBALL_SHA256}, got ${actualSha256} (${archivePath})`);
  }

  return {
    valid: true,
    sha256: EXPECTED_TARBALL_SHA256,
    path: resolve(archivePath),
  };
}

function placeNoClobber(entry) {
  try {
    linkSync(entry.staged, entry.final);
    return "link";
  } catch (error) {
    if (error?.code === "EXDEV") {
      writeNewFile(entry.final, entry.bytes, entry.identity.mode & 0o777);
      return "copy";
    }
    if (error?.code === "EEXIST") return null;
    throw error;
  }
}

function requireAdopted(entry, created) {
  const adopted = readRegularFile(entry.final, { label: entry.label });
  if (sha256(adopted.bytes) !== entry.sha256) {
    throw new Error(created
      ? `[NODE_AUTH_FAIL] ${entry.label} at ${entry.final} changed during adoption.`
      : `[NODE_AUTH_FAIL] Existing ${entry.label} at ${entry.final} differs from the authenticated bytes; it was not replaced.`);
  }
  if (created === "link" && (adopted.identity.dev !== entry.identity.dev || adopted.identity.ino !== entry.identity.ino)) {
    throw new Error(`[NODE_AUTH_FAIL] ${entry.label} at ${entry.final} was replaced during adoption.`);
  }
  if (entry.executable && (adopted.identity.mode & 0o111) === 0) {
    throw new Error(`[NODE_AUTH_FAIL] ${entry.label} at ${entry.final} is not executable.`);
  }
}

/**
 * Adopts authenticated staged files at their final pathnames, all or nothing, without ever replacing
 * an existing file. Every staged file is re-measured through a descriptor before any final name is
 * created; each is then hard-linked into place (or copied into a newly created file across
 * filesystems) and its final pathname is re-measured. An existing final file is accepted only when it
 * is a regular file with exactly the authenticated bytes; otherwise it is left untouched. On any
 * failure every final name created by this call is removed again, so the final paths are unchanged.
 * @param {Array<{ staged: string, final: string, label: string, sha256: string, executable?: boolean }>} entries
 */
function adoptNoClobber(entries) {
  const prepared = entries.map((entry) => {
    const staged = readRegularFile(entry.staged, { label: `Staged ${entry.label}` });
    if (sha256(staged.bytes) !== entry.sha256) {
      throw new Error(`[NODE_AUTH_FAIL] Staged ${entry.label} changed after authentication; ${entry.final} was not adopted.`);
    }
    return { ...entry, bytes: staged.bytes, identity: staged.identity };
  });
  const created = [];
  try {
    for (const entry of prepared) {
      const how = placeNoClobber(entry);
      if (how) created.push(entry.final);
      requireAdopted(entry, how);
    }
  } catch (error) {
    for (const path of created.reverse()) unlinkSync(path);
    throw error;
  }
  return prepared.map((entry) => ({ path: entry.final, sha256: entry.sha256, adopted: created.includes(entry.final) ? "created" : "existing-identical" }));
}

/**
 * Verifies an official Node.js Darwin ARM64 archive against the maintained authority and extracts the portable binary.
 * Extraction reads the already authenticated archive bytes (never the pathname again) into an owned staging
 * directory; an existing output is kept only when it is byte-identical to the authenticated executable.
 * @param {string} archivePath
 * @param {string} outputExecutablePath
 * @param {object} [options]
 * @param {boolean} [options.validateLinkage=true]
 * @returns {{ valid: boolean, path: string, version: string, v8: string, sha256: string, size: number, target: string }}
 */
export function verifyAndExtractDarwinNodeArchive(archivePath, outputExecutablePath, options = {}) {
  const { bytes: archive } = readRegularFile(archivePath, { label: "Node archive" });
  const archiveSha256 = sha256(archive);
  if (archiveSha256 !== EXPECTED_TARBALL_SHA256) {
    throw new Error(`Node archive SHA-256 mismatch: expected ${EXPECTED_TARBALL_SHA256}, got ${archiveSha256} (${archivePath})`);
  }
  const resolvedOut = resolve(outputExecutablePath);
  mkdirSync(dirname(resolvedOut), { recursive: true });
  const staging = mkdtempSync(join(dirname(resolvedOut), ".node-extract-"));
  try {
    const member = `${EXPECTED_TARBALL_NAME.replace(/\.tar\.gz$/, "")}/bin/node`;
    const tarResult = spawnSync("tar", ["-xzf", "-", "-C", staging, member], {
      input: archive,
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C" },
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (tarResult.status !== 0 || tarResult.error) {
      throw new Error(`Failed to extract portable Node runtime from archive: ${tarResult.error?.message || tarResult.stderr}`);
    }
    adoptNoClobber([{ staged: join(staging, member), final: resolvedOut, label: "portable Node runtime", sha256: EXPECTED_EXECUTABLE_SHA256, executable: true }]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { ...validateDarwinPortableNode(resolvedOut, options), path: resolvedOut };
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
    try {
      validateDarwinPortableNode(candidate, { validateLinkage: true });
      return resolve(candidate);
    } catch {
      // Missing or non-matching candidates are skipped.
    }
  }

  return null;
}

async function importSharedVerifier() {
  const verifierUrls = [
    new URL("./ci/verify-node-authenticity.mjs", import.meta.url),              // Composed repo (tools -> tools/ci)
    new URL("../../../tools/ci/verify-node-authenticity.mjs", import.meta.url), // Monorepo
  ];
  for (const url of verifierUrls) {
    try {
      return await import(url.href);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !String(error.message).includes(fileURLToPath(url))) throw error;
    }
  }
  throw new Error("[NODE_AUTH_FAIL] Shared Node authenticity verifier is unavailable.");
}

/**
 * Authenticates the official Darwin ARM64 archive of the embedded runtime and extracts its executable.
 * Signature and SHASUMS parsing use the shared locked verifier (openpgp 6.3.1, active release keyring);
 * this module then requires the embedded identity's signer, archive digest and executable identity.
 * @param {{ shasumsPath?: string, tarballPath?: string, outputNodePath: string, downloadDir?: string, fetchImpl?: typeof fetch }} options
 */
export async function authenticateEmbeddedDarwinNode(options) {
  const { verifyNodeAuthenticity } = await importSharedVerifier();
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

/**
 * Authenticates the embedded Darwin runtime into a download cache and an output executable.
 *
 * Network bytes are only ever written by the shared verifier into a fresh owner-only staging directory
 * inside the download directory. Nothing reaches the stable SHASUMS, archive or executable pathnames
 * until the signed SHASUMS and archive chain and the executable identity have been accepted; the
 * authenticated staged files are then adopted all or nothing without replacing any existing file (see adoptNoClobber).
 * A complete cached pair in the download directory is copied into staging through descriptors and
 * authenticated the same way without network access. Partial, truncated, tampered, symlinked or
 * replaced inputs fail before or during adoption, and the staging directory is always removed.
 *
 * The threat model is untrusted network content and pre-existing or concurrently replaced final
 * paths; a same-user process that can write the owner-only staging directory is out of scope.
 * @param {object} options
 * @param {string} options.downloadDir
 * @param {string} options.outputNodePath
 * @param {typeof fetch} [options.fetchImpl] test transport; production uses the shared verifier's fetch
 * @param {(options: object) => Promise<any>} [options.verify] test seam; defaults to authenticateEmbeddedDarwinNode
 * @param {{ tarballSha256: string, executableSha256: string }} [options.expected] test seam; defaults to the embedded identity
 * @param {(context: { staging: string, staged: Record<string, string> }) => (void | Promise<void>)} [options.beforeAdoption] test seam
 */
export async function authenticateDarwinNodeDownload(options) {
  const { downloadDir, outputNodePath, fetchImpl, beforeAdoption } = options ?? {};
  const verify = options?.verify ?? authenticateEmbeddedDarwinNode;
  const expected = options?.expected ?? { tarballSha256: EXPECTED_TARBALL_SHA256, executableSha256: EXPECTED_EXECUTABLE_SHA256 };
  if (!downloadDir || !outputNodePath) throw new Error("[NODE_AUTH_FAIL] A download directory and an output executable path are required.");
  const directory = resolve(downloadDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = lstatSync(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error(`[NODE_AUTH_FAIL] Node download directory must be a real directory: ${directory}`);
  }
  const finals = { shasums: join(directory, SHASUMS_FILENAME), tarball: join(directory, EXPECTED_TARBALL_NAME), node: resolve(outputNodePath) };
  const nodeName = basename(finals.node);
  if (nodeName === SHASUMS_FILENAME || nodeName === EXPECTED_TARBALL_NAME) {
    throw new Error(`[NODE_AUTH_FAIL] Output executable name ${nodeName} collides with an authenticated download name.`);
  }
  mkdirSync(dirname(finals.node), { recursive: true });

  const staging = mkdtempSync(join(directory, ".staging-"));
  try {
    const staged = { shasums: join(staging, SHASUMS_FILENAME), tarball: join(staging, EXPECTED_TARBALL_NAME), node: join(staging, nodeName) };
    const cachedShasums = readOptionalRegular(finals.shasums, "Cached SHASUMS256.txt.asc");
    const cachedTarball = readOptionalRegular(finals.tarball, `Cached ${EXPECTED_TARBALL_NAME}`);
    let receipt;
    if (cachedShasums && cachedTarball) {
      writeNewFile(staged.shasums, cachedShasums.bytes, 0o600);
      writeNewFile(staged.tarball, cachedTarball.bytes, 0o600);
      receipt = await verify({ shasumsPath: staged.shasums, tarballPath: staged.tarball, outputNodePath: staged.node });
    } else {
      receipt = await verify({ downloadDir: staging, outputNodePath: staged.node, ...(fetchImpl ? { fetchImpl } : {}) });
    }
    const shasumsSha256 = sha256(readRegularFile(staged.shasums, { label: "Staged SHASUMS256.txt.asc" }).bytes);
    await beforeAdoption?.({ staging, staged });
    adoptNoClobber([
      { staged: staged.shasums, final: finals.shasums, label: SHASUMS_FILENAME, sha256: shasumsSha256 },
      { staged: staged.tarball, final: finals.tarball, label: EXPECTED_TARBALL_NAME, sha256: expected.tarballSha256 },
      { staged: staged.node, final: finals.node, label: "authenticated Node runtime", sha256: expected.executableSha256, executable: true },
    ]);
    return receipt;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Returns the signed body of a cleartext-signed SHASUMS256.txt.asc (dash-escaping removed). The caller
 * must parse only bytes whose signature the shared verifier has accepted.
 * @param {Buffer} bytes
 */
export function signedShasumsBody(bytes) {
  const lines = bytes.toString("utf8").split(/\r?\n/u);
  const begin = lines.indexOf("-----BEGIN PGP SIGNED MESSAGE-----");
  const end = lines.indexOf("-----BEGIN PGP SIGNATURE-----");
  if (begin === -1 || end === -1 || end < begin) throw new Error("[NODE_AUTH_FAIL] SHASUMS256.txt.asc is not a cleartext-signed message.");
  const blank = lines.indexOf("", begin);
  if (blank === -1 || blank > end) throw new Error("[NODE_AUTH_FAIL] SHASUMS256.txt.asc armor headers are malformed.");
  return lines.slice(blank + 1, end).map((line) => (line.startsWith("- ") ? line.slice(2) : line));
}

/**
 * Authenticates an official Node.js Linux archive of the embedded runtime and extracts its executable.
 *
 * The SHASUMS and archive files are downloaded by the caller (the hosted lane) and read here once through
 * descriptors. The captured SHASUMS bytes are staged in an owner-only directory and their signature is
 * verified by the shared locked verifier (active release keyring); the Linux archive entry is then read
 * from exactly those verified bytes and must equal both the embedded identity and the captured archive.
 * The executable is extracted from the captured archive bytes (never the pathname again), adopted
 * without replacing an existing different file, and validated -- and probed on a matching host.
 * @param {{ shasumsPath: string, tarballPath: string, targetTriple: string, outputNodePath: string, verify?: Function }} options
 */
export async function authenticateLinuxNodeArchive(options) {
  const { shasumsPath, tarballPath, targetTriple, outputNodePath } = options ?? {};
  const identity = NODE_RELEASE_IDENTITY.targets?.[targetTriple];
  if (!identity || identity.platform !== "linux") throw new Error(`[NODE_AUTH_FAIL] No embedded Linux runtime identity for ${targetTriple}.`);
  if (!shasumsPath || !tarballPath || !outputNodePath) throw new Error("[NODE_AUTH_FAIL] SHASUMS, archive and output executable paths are required.");
  const shasums = readRegularFile(shasumsPath, { label: SHASUMS_FILENAME });
  const archive = readRegularFile(tarballPath, { label: identity.archive });
  const archiveSha256 = sha256(archive.bytes);
  const resolvedOut = resolve(outputNodePath);
  mkdirSync(dirname(resolvedOut), { recursive: true });
  const staging = mkdtempSync(join(dirname(resolvedOut), ".node-linux-"));
  try {
    const stagedShasums = join(staging, SHASUMS_FILENAME);
    writeNewFile(stagedShasums, shasums.bytes, 0o600);
    const verify = options.verify ?? (async (verifyOptions) => (await importSharedVerifier()).verifyNodeAuthenticity(verifyOptions));
    const receipt = await verify({ version: EXPECTED_NODE_VERSION, shasumsPath: stagedShasums });
    if (receipt?.signature?.fingerprint !== PRIMARY_SIGNING_KEY_FINGERPRINT) {
      throw new Error(`[NODE_AUTH_FAIL] SHASUMS signer ${receipt?.signature?.fingerprint} is not the embedded runtime signer ${PRIMARY_SIGNING_KEY_FINGERPRINT}.`);
    }
    const entry = signedShasumsBody(shasums.bytes)
      .map((line) => line.trim().split(/\s+/u))
      .find((fields) => fields.length === 2 && (fields[1] === identity.archive || fields[1] === `*${identity.archive}`));
    if (!entry) throw new Error(`[NODE_AUTH_FAIL] ${identity.archive} is not listed in the verified SHASUMS256.`);
    if (entry[0] !== identity.archiveSha256) throw new Error(`[NODE_AUTH_FAIL] Verified SHASUMS digest for ${identity.archive} does not match the embedded runtime authority.`);
    if (archiveSha256 !== identity.archiveSha256) throw new Error(`[NODE_AUTH_FAIL] ${identity.archive} SHA-256 ${archiveSha256} does not match the verified checksum.`);
    const member = `${identity.archive.replace(/\.tar\.xz$/u, "")}/bin/node`;
    const extracted = spawnSync("tar", ["-xJf", "-", "-C", staging, member], {
      input: archive.bytes, encoding: "utf8", env: { LANG: "C", LC_ALL: "C", PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (extracted.status !== 0 || extracted.error) throw new Error(`[NODE_AUTH_FAIL] Could not extract ${member}: ${extracted.error?.message || extracted.stderr}`);
    adoptNoClobber([{ staged: join(staging, member), final: resolvedOut, label: "authenticated Node runtime", sha256: identity.executableSha256, executable: true }]);
    const runtime = validateLinuxPortableNode(resolvedOut, targetTriple);
    return {
      schema: "nebular.linux-node-authenticity-v1",
      target: targetTriple,
      nodeVersion: EXPECTED_NODE_VERSION,
      undici: NODE_RELEASE_IDENTITY.undici,
      signature: receipt.signature,
      shasums: { sha256: sha256(shasums.bytes), entry: entry[0] },
      archive: { name: identity.archive, sha256: archiveSha256, size: archive.bytes.length },
      executable: { sha256: runtime.sha256, size: runtime.size, probed: runtime.probed },
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
  const downloadDir = value("--authenticate-download");
  const linuxDir = value("--authenticate-linux");
  const outputNodePath = value("--output-node");
  const output = value("--output");
  try {
    if ((!downloadDir && !linuxDir) || !outputNodePath) {
      throw new Error("Usage: node-runtime-authority.mjs (--authenticate-download <dir> | --authenticate-linux <dir> --target <triple>) --output-node <path> [--output <receipt.json>]");
    }
    let receipt;
    if (linuxDir) {
      const targetTriple = value("--target");
      const identity = NODE_RELEASE_IDENTITY.targets?.[targetTriple];
      if (!identity) throw new Error(`Unknown Linux runtime target ${targetTriple}`);
      receipt = await authenticateLinuxNodeArchive({ shasumsPath: join(resolve(linuxDir), SHASUMS_FILENAME), tarballPath: join(resolve(linuxDir), identity.archive), targetTriple, outputNodePath });
    } else {
      receipt = await authenticateDarwinNodeDownload({ downloadDir, outputNodePath });
    }
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    if (output) {
      mkdirSync(dirname(resolve(output)), { recursive: true });
      writeFileSync(resolve(output), text);
    }
    process.stdout.write(text);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
