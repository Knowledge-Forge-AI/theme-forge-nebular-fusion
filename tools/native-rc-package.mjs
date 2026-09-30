#!/usr/bin/env node
// Native release-candidate packaging for one platform lane.
//
// From the exact payload the lane compiled (the finalized macOS .app, or the Linux raw layout that
// tools/build-app.mjs writes), this produces the exact candidate bytes:
//
//   * the npm platform package directory and its `npm pack` tarball
//     (@knowledge-forge-ai/theme-forge-nebular-fusion-<platform>), whose package-manifest.json
//     inventories every payload member (the wrapper later binds that manifest's SHA-256);
//   * the raw native archive theme-forge-nebular-fusion-v<version>-<triple>.<format>, written by a
//     deterministic tar writer (sorted members, fixed time, root ownership, normalized modes, gzip
//     without a timestamp or platform byte), so the archive bytes depend only on its contents.
//
// Every payload file is read through one descriptor (fs-snapshot.mjs). The package layout and
// templates are the public projection of the private packages/nebular-fusion-<platform> templates.
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, createWriteStream, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, realpathSync, rmSync, writeSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { CANDIDATE_VERSION, targetForTriple } from "./platform-targets.mjs";
import { nativeLauncher } from "./native-launcher.mjs";
import { defaultSnapshotReader, readRegularSnapshot, sha256 } from "./fs-snapshot.mjs";

export const FIXED_ARCHIVE_TIME = 1704067200; // 2024-01-01T00:00:00Z, as rc-payloads.mjs
export const PACKAGE_MANIFEST_SCHEMA = "tfsb.nebular-package-manifest-v1";

export const PLATFORMS = Object.freeze(Object.fromEntries([
  ["darwin-arm64", "aarch64-apple-darwin", "macOS Apple Silicon"],
  ["linux-arm64", "aarch64-unknown-linux-gnu", "Linux ARM64"],
  ["linux-x64", "x86_64-unknown-linux-gnu", "Linux AMD64/x64"],
].map(([key, triple, description]) => {
  const [os, cpu] = key.split("-");
  const target = targetForTriple(triple);
  return [key, Object.freeze({
    key, triple, os, cpu, description, target,
    package: `@knowledge-forge-ai/theme-forge-nebular-fusion-${key}`,
    payloadType: os === "darwin" ? "app-bundle" : "linux-executable-resources",
    payloadRoot: os === "darwin" ? "payload/Theme Forge Nebular Fusion.app" : "payload",
    executable: os === "darwin" ? "payload/Theme Forge Nebular Fusion.app/Contents/MacOS/theme-forge-nebular-fusion" : "payload/bin/theme-forge-nebular-fusion",
    rawName: (version) => `theme-forge-nebular-fusion-v${version}-${triple}.${target.format}`,
    rawRoot: os === "darwin" ? "Theme Forge Nebular Fusion.app" : "theme-forge-nebular-fusion",
  })];
})));

export function platformPackageJson(key, version = CANDIDATE_VERSION) {
  const platform = PLATFORMS[key];
  return {
    name: platform.package,
    version,
    description: `${platform.description} native binary launcher and payload for Theme Forge Nebular Fusion`,
    os: [platform.os],
    cpu: [platform.cpu],
    files: ["payload", "package-manifest.json", "README.md", "LICENSE", "NOTICE"],
    license: "AGPL-3.0-or-later OR Commercial",
    repository: { type: "git", url: "https://github.com/Knowledge-Forge-AI/theme-forge-nebular-fusion.git" },
  };
}

export function platformReadme(key, version = CANDIDATE_VERSION) {
  const platform = PLATFORMS[key];
  const layout = platform.os === "darwin" ? "`payload/Theme Forge Nebular Fusion.app`" : "`payload/bin/theme-forge-nebular-fusion and payload/lib/theme-forge-nebular-fusion`";
  return `# Nebular ${key} platform candidate

Version: ${version} (unreleased source checkpoint). Native payload assembly is pending; this source directory
is not an installable GUI artifact and has not been published.

Intended layout: ${layout}.
Install through \`@knowledge-forge-ai/theme-forge-nebular-fusion\`, whose wrapper
owns \`tfnf\` and authenticates the complete selected platform payload. This
optional package intentionally exposes no competing npm bin.

No download or private-checkout fallback runs at installation or first launch.
Native GUI and channel qualification must be recorded independently.
`;
}

export function verifyNativeExecutableHeader(bytes, platform) {
  if (platform.os === "darwin") {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c || bytes.readUInt32LE(12) !== 2) {
      throw new Error("Expected ARM64 Mach-O executable");
    }
  } else if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70])) || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1
      || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== (platform.cpu === "arm64" ? 183 : 62)) {
    throw new Error("Expected target-matching ELF64 executable");
  }
}

// A sorted pre-order walk: every directory precedes its members. Regular files are read through one
// descriptor; links must be relative and stay inside the tree; anything else fails.
export function walkTree(root, { maxMembers = 20000, maxBytes = 2 * 1024 * 1024 * 1024 } = {}) {
  const base = realpathSync(root);
  const members = [];
  let bytes = 0;
  const visit = (directory) => {
    const names = readdirSync(directory).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const path = join(directory, name);
      const rel = relative(base, path).split(sep).join("/");
      if (members.length >= maxMembers || rel.length > 1024) throw new Error("Payload member count or path limit exceeded");
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (!target || target.startsWith("/") || target.includes("\\") || target.includes("\0")) throw new Error(`Unsafe link in payload: ${rel}`);
        const resolved = resolve(directory, target);
        if (resolved !== base && !resolved.startsWith(base + sep)) throw new Error(`Link escapes the payload: ${rel}`);
        members.push({ path: rel, type: "symlink", target });
      } else if (info.isDirectory()) {
        members.push({ path: rel, type: "directory", mode: 0o755 });
        visit(path);
      } else if (info.isFile()) {
        const file = readRegularSnapshot(path, { label: "Payload member", maxBytes: 512 * 1024 * 1024 });
        bytes += file.size;
        if (bytes > maxBytes) throw new Error("Payload byte limit exceeded");
        members.push({ path: rel, type: "file", mode: file.executable ? 0o755 : 0o644, size: file.size, sha256: file.sha256, bytes: file.bytes });
      } else {
        throw new Error(`Unsupported payload member: ${rel}`);
      }
    }
  };
  visit(base);
  return members;
}

// Directory modes are set explicitly: the installed-package verifier requires exactly 0755.
function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o755 });
  chmodSync(path, 0o755);
}

function writeTree(members, destination) {
  directory(destination);
  for (const member of members) {
    const path = join(destination, member.path);
    if (member.type === "directory") directory(path);
    else if (member.type === "symlink") spawnSyncChecked("ln", ["-s", member.target, path]);
    else defaultSnapshotReader.writeRegular(path, member.bytes, member.mode, { label: `Package member ${member.path}` });
  }
}

function spawnSyncChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  return result;
}

function captureLegal(checkout) {
  const read = (name) => readRegularSnapshot(join(checkout, name), { label: name, maxBytes: 16 * 1024 * 1024,
    messages: { missing: `Required ${name} missing at ${join(checkout, name)}` } }).bytes;
  return { LICENSE: read("LICENSE"), NOTICE: read("NOTICE") };
}

export const BUNDLE_NAME = "Theme Forge Nebular Fusion.app";

/**
 * The directory whose contents a platform ships: the application bundle on Darwin, the raw layout
 * (bin/, lib/) on Linux. Lanes pass the directory that contains the platform layout.
 */
export function layoutRoot(key, payload) {
  return PLATFORMS[key].os === "darwin" ? join(payload, BUNDLE_NAME) : payload;
}

/** Payload members as the platform package installs them below payload/ (from the layout root). */
export function payloadMembers(key, layout) {
  const platform = PLATFORMS[key];
  const tree = walkTree(layout);
  if (platform.os === "darwin") {
    if (!tree.some((member) => member.path === "Contents/MacOS/theme-forge-nebular-fusion")) throw new Error("Payload is not the application bundle");
    return tree.map((member) => ({ ...member, path: `payload/Theme Forge Nebular Fusion.app/${member.path}` }));
  }
  if (!tree.some((member) => member.path === "bin/theme-forge-nebular-fusion")) throw new Error("Payload is not the Linux raw layout");
  return tree.map((member) => ({ ...member, path: `payload/${member.path}` }));
}

/**
 * Assembles the npm platform package directory from the exact payload.
 * @returns {{ packageDir: string, manifest: object, manifestSha256: string }}
 */
export function assemblePlatformPackage({ platform: key, payload, checkout, output, version = CANDIDATE_VERSION, glibcMinimum }) {
  const platform = PLATFORMS[key];
  if (!platform) throw new Error(`Unsupported platform ${key}`);
  if (platform.os === "linux" && !/^\d+\.\d+$/.test(glibcMinimum ?? "")) throw new Error(`A qualified glibc minimum is required for ${key}`);
  const members = payloadMembers(key, layoutRoot(key, payload));
  const executable = members.find((member) => member.path === platform.executable);
  if (!executable || executable.type !== "file" || executable.mode !== 0o755) throw new Error("Native executable missing or not executable");
  verifyNativeExecutableHeader(executable.bytes, platform);
  rmSync(output, { recursive: true, force: true });
  directory(output);
  const inventory = [...(platform.os === "darwin" ? [{ path: platform.payloadRoot, type: "directory", mode: 0o755 }] : []), ...members.map(({ bytes, ...member }) => member)]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = {
    schema: PACKAGE_MANIFEST_SCHEMA,
    package: platform.package,
    version,
    target: { os: platform.os, cpu: platform.cpu },
    payloadType: platform.payloadType,
    payloadRoot: platform.payloadRoot,
    executable: platform.executable,
    ...(platform.os === "linux" ? { glibcMinimum } : {}),
    payloadStatus: "complete",
    fileCount: inventory.length,
    members: inventory,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeTree(members.map((member) => ({ ...member, path: member.path.slice("payload/".length) })), join(output, "payload"));
  const legal = captureLegal(checkout);
  const files = {
    "package-manifest.json": manifestBytes,
    "package.json": Buffer.from(`${JSON.stringify(platformPackageJson(key, version), null, 2)}\n`),
    "README.md": Buffer.from(platformReadme(key, version)),
    LICENSE: legal.LICENSE,
    NOTICE: legal.NOTICE,
  };
  for (const [name, bytes] of Object.entries(files)) defaultSnapshotReader.writeRegular(join(output, name), bytes, 0o644, { label: name });
  const manifestSha256 = sha256(manifestBytes);
  verifyPlatformPackage(output, key, manifestSha256, version);
  return { packageDir: output, manifest, manifestSha256 };
}

/** Verifies an assembled or installed platform package against its authenticated manifest digest. */
export function verifyPlatformPackage(root, key, manifestSha256, version = CANDIDATE_VERSION) {
  const platform = PLATFORMS[key];
  const pkg = JSON.parse(readRegularSnapshot(join(root, "package.json"), { label: "package.json", maxBytes: 1024 * 1024 }).bytes.toString("utf8"));
  if (pkg.name !== platform.package || pkg.version !== version || JSON.stringify(pkg.os) !== JSON.stringify([platform.os]) || JSON.stringify(pkg.cpu) !== JSON.stringify([platform.cpu])) {
    throw new Error("Platform package identity mismatch");
  }
  const manifestFile = readRegularSnapshot(join(root, "package-manifest.json"), { label: "package-manifest.json", maxBytes: 4 * 1024 * 1024 });
  if (manifestFile.sha256 !== manifestSha256) throw new Error("Payload manifest authentication failed");
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  if (manifest.schema !== PACKAGE_MANIFEST_SCHEMA || manifest.package !== platform.package || manifest.version !== version
      || manifest.payloadRoot !== platform.payloadRoot || manifest.executable !== platform.executable || manifest.payloadStatus !== "complete"
      || manifest.fileCount !== manifest.members.length) {
    throw new Error("Invalid payload manifest identity or inventory");
  }
  const expected = new Map(manifest.members.map((member) => [member.path, member]));
  const actual = new Map([...(platform.os === "darwin" ? [{ path: platform.payloadRoot, type: "directory", mode: 0o755 }] : []),
    ...payloadMembers(key, join(root, platform.payloadRoot))].map((member) => [member.path, member]));
  for (const [path, member] of expected) {
    const found = actual.get(path);
    if (!found || found.type !== member.type || (member.type === "file" && (found.sha256 !== member.sha256 || found.size !== member.size || found.mode !== member.mode))
        || (member.type === "symlink" && found.target !== member.target)) {
      throw new Error(`Payload member mismatch: ${path}`);
    }
  }
  for (const path of actual.keys()) if (!expected.has(path)) throw new Error(`Unexpected payload member: ${path}`);
  return { manifest, executable: join(root, platform.executable) };
}

/** Packs the platform package with the lane's authenticated npm, isolated from any user npm state. */
export function packPlatformPackage(packageDir, destination, { node = process.execPath, npmCli, scratch }) {
  mkdirSync(destination, { recursive: true });
  const home = join(scratch, "npm-home");
  mkdirSync(home, { recursive: true });
  const result = spawnSyncChecked(node, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
    cwd: packageDir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, npm_config_cache: join(scratch, "npm-cache"), npm_config_userconfig: join(home, ".npmrc"),
      npm_config_globalconfig: join(home, "global-npmrc"), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
  });
  const [packed] = JSON.parse(result.stdout);
  const file = join(destination, packed.filename);
  const snapshot = readRegularSnapshot(file, { label: "npm tarball", maxBytes: 1024 * 1024 * 1024 });
  const npmVersion = spawnSyncChecked(node, [npmCli, "--version"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } }).stdout.trim();
  return { file, filename: packed.filename, sha256: snapshot.sha256, size: snapshot.size, integrity: packed.integrity, npmVersion, entryCount: packed.entryCount };
}

// ---- deterministic tar ---------------------------------------------------------------------------

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(name, { type, mode, size = 0, linkname = "" }) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write(octal(mode, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(FIXED_ARCHIVE_TIME, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(type, 156, 1, "ascii");
  block.write(linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  return `${length}${body}`;
}

const pad = (size) => Buffer.alloc((512 - (size % 512)) % 512);

/** Emits the tar records of one member: a PAX header when the name or link does not fit ustar. */
export function tarRecords(member) {
  const name = member.type === "directory" ? `${member.path}/` : member.path;
  const ascii = (value) => /^[\x20-\x7e]*$/.test(value);
  const fits = Buffer.byteLength(name) <= 100 && ascii(name) && (!member.target || (Buffer.byteLength(member.target) <= 100 && ascii(member.target)));
  const records = [];
  if (!fits) {
    const pax = Buffer.from(paxRecord("path", name) + (member.target ? paxRecord("linkpath", member.target) : ""));
    records.push(header("PaxHeader", { type: "x", mode: 0o644, size: pax.length }), pax, pad(pax.length));
  }
  const shortName = fits ? name : name.split("/").filter(Boolean).pop().slice(0, 99);
  if (member.type === "directory") records.push(header(shortName, { type: "5", mode: 0o755 }));
  else if (member.type === "symlink") records.push(header(shortName, { type: "2", mode: 0o777, linkname: fits ? member.target : "" }));
  else records.push(header(shortName, { type: "0", mode: member.mode, size: member.bytes.length }), member.bytes, pad(member.bytes.length));
  return records;
}

/** Writes a deterministic .tar.gz of the given members (already in sorted pre-order). */
export async function writeDeterministicArchive(members, file) {
  const gzip = createGzip({ level: 9 });
  const out = createWriteStream(file, { flags: "wx", mode: 0o644 });
  gzip.pipe(out);
  for (const member of members) for (const record of tarRecords(member)) if (!gzip.write(record)) await once(gzip, "drain");
  gzip.end(Buffer.alloc(1024));
  await once(out, "finish");
  // zlib records the build platform in the gzip header; normalize it to "unknown" (255).
  const fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try { writeSync(fd, Buffer.from([255]), 0, 1, 9); } finally { closeSync(fd); }
  return readRegularSnapshot(file, { label: "Raw archive", maxBytes: 2 * 1024 * 1024 * 1024 });
}

/** Assembles the raw native archive from the exact payload. */
export async function assembleRawArchive({ platform: key, payload, checkout, output, version = CANDIDATE_VERSION }) {
  const platform = PLATFORMS[key];
  const tree = walkTree(layoutRoot(key, payload));
  const legal = captureLegal(checkout);
  const launcher = Buffer.from(nativeLauncher(platform.target));
  let members;
  if (platform.os === "darwin") {
    // The finalized bundle already carries the launcher and legal notices; they must be exact.
    for (const [path, bytes] of [["Contents/Resources/bin/tfnf", launcher], ["Contents/Resources/LICENSE", legal.LICENSE], ["Contents/Resources/NOTICE", legal.NOTICE]]) {
      const found = tree.find((member) => member.path === path);
      if (!found || found.type !== "file" || !found.bytes.equals(bytes)) throw new Error(`Finalized bundle member ${path} is missing or differs`);
    }
    if (!tree.some((member) => member.path === "Contents/_CodeSignature/CodeResources")) throw new Error("Bundle is not sealed");
    members = [{ path: platform.rawRoot, type: "directory", mode: 0o755 }, ...tree.map((member) => ({ ...member, path: `${platform.rawRoot}/${member.path}` }))];
  } else {
    const existingLauncher = tree.find((member) => member.path === "bin/tfnf");
    if (!existingLauncher || !existingLauncher.bytes.equals(launcher)) throw new Error("Linux payload launcher is missing or differs from the maintained launcher");
    const extra = [
      { path: "LICENSE", type: "file", mode: 0o644, bytes: legal.LICENSE, size: legal.LICENSE.length },
      { path: "NOTICE", type: "file", mode: 0o644, bytes: legal.NOTICE, size: legal.NOTICE.length },
    ];
    members = [{ path: platform.rawRoot, type: "directory", mode: 0o755 }, ...[...tree, ...extra]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((member) => ({ ...member, path: `${platform.rawRoot}/${member.path}` }))];
  }
  const executable = members.find((member) => member.path === `${platform.rawRoot}/${platform.os === "darwin" ? "Contents/MacOS/theme-forge-nebular-fusion" : "bin/theme-forge-nebular-fusion"}`);
  if (!executable || executable.mode !== 0o755) throw new Error("Raw archive executable missing or not executable");
  verifyNativeExecutableHeader(executable.bytes, platform);
  mkdirSync(output, { recursive: true });
  const file = join(output, platform.rawName(version));
  rmSync(file, { force: true });
  const archive = await writeDeterministicArchive(members, file);
  return { file, filename: platform.rawName(version), sha256: archive.sha256, size: archive.size, members: members.length,
    executableSha256: executable.sha256 ?? sha256(executable.bytes) };
}

function verifyCommand(argv) {
  const value = (flag) => { const index = argv.indexOf(flag); return index === -1 ? undefined : argv[index + 1]; };
  const root = resolve(value("--package-root"));
  const verified = verifyPlatformPackage(root, value("--platform"), value("--manifest-sha256"));
  process.stdout.write(`${JSON.stringify({ status: "pass", executable: verified.executable, members: verified.manifest.fileCount })}\n`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = { "--platform": "platform", "--payload": "payload", "--checkout": "checkout", "--output": "output", "--glibc-minimum": "glibcMinimum", "--npm-cli": "npmCli" }[argv[index]];
    if (!key || argv[index + 1] === undefined) throw new Error("Usage: native-rc-package.mjs --platform <key> --payload <dir> --checkout <dir> --output <dir> --npm-cli <npm-cli.js> [--glibc-minimum x.y]");
    options[key] = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "verify") {
      verifyCommand(process.argv.slice(3));
      process.exit(0);
    }
    const options = parseArgs(process.argv.slice(2));
    const output = resolve(options.output);
    const scratch = join(output, ".scratch");
    const assembled = assemblePlatformPackage({ ...options, output: join(scratch, "package") });
    const npm = packPlatformPackage(assembled.packageDir, join(output, "candidate"), { npmCli: resolve(options.npmCli), scratch });
    const raw = await assembleRawArchive({ ...options, output: join(output, "candidate") });
    const record = { schema: "nebular.native-rc-package-v1", platform: options.platform, version: assembled.manifest.version,
      packageManifestSha256: assembled.manifestSha256, glibcMinimum: assembled.manifest.glibcMinimum ?? null,
      npm: { filename: npm.filename, sha256: npm.sha256, size: npm.size, integrity: npm.integrity, npmVersion: npm.npmVersion, entryCount: npm.entryCount },
      raw: { filename: raw.filename, sha256: raw.sha256, size: raw.size, members: raw.members, executableSha256: raw.executableSha256 } };
    defaultSnapshotReader.writeRegular(join(output, "package-record.json"), Buffer.from(`${JSON.stringify(record, null, 2)}\n`), 0o644);
    defaultSnapshotReader.writeRegular(join(output, "package-manifest.json"), readRegularSnapshot(join(assembled.packageDir, "package-manifest.json")).bytes, 0o644);
    rmSync(scratch, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
