import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const SITE_ROOT = path.resolve(TOOL_DIRECTORY, "..");

export const PUBLIC_MEMBERS = Object.freeze([
  "404.html",
  "brand/BRAND-ASSETS.md",
  "brand/README-BRAND.md",
  "favicon.svg",
  "index.html",
  "orihime.webp",
  "robots.txt",
  "social-preview.png",
  "social-preview.svg",
  "src/main.mjs",
  "src/state.mjs",
  "styles.css",
  "screenshots/gamer-dark-shell.jpg",
  "screenshots/screenshot-provenance.json",
  "appearances/anime.css",
  "appearances/catalog.json",
  "appearances/developer.css",
  "appearances/gamer.css",
  "appearances/graphic-designer.css",
  "appearances/nebular.css",
  "appearances/provenance.json",
  "appearances/profiles/anime.profile.json",
  "appearances/profiles/developer.profile.json",
  "appearances/profiles/gamer.profile.json",
  "appearances/profiles/graphic-designer.profile.json",
  "appearances/profiles/nebular.profile.json",
  "appearances/profiles/terminal-nova.profile.json",
  "appearances/specimen.html",
  "appearances/source-profiles.json",
  "appearances/terminal-nova.css",
]);

const EXPECTED_PROVENANCE = Object.freeze({
  schema: "theme-forge.site-appearance-projection.v1",
  inventoryDigest: "d9f94a7f5ce0730098d840e409ca588caefc2e05c45fbec02d749d25f418fb51",
  sourceCatalogSha256: "0e635f5efc8d0df6867601530c26a919e992f9dc5170666b39fbbb0847a39351",
  members: Object.freeze([
    Object.freeze({
      output: "catalog.json",
      producerMember: "catalog.json#site-index-v1",
      bytes: 794,
      sha256: "617979da9045eca6864e974b797a387a0bf324eeb12904360152639b3a68f6a5",
    }),
    Object.freeze({
      output: "terminal-nova.css",
      producerMember: "terminal-nova/application.css",
      bytes: 4227,
      sha256: "e4f8327022953c78996bf799385feae0ad7caff850eeaf9b198a7a6c5eb5ff7f",
    }),
    Object.freeze({
      output: "nebular.css",
      producerMember: "nebular/application.css",
      bytes: 4228,
      sha256: "616ffa3e0001cf146d552fcb5cca18b177febabf9ca406151578db53fd3d84cb",
    }),
    Object.freeze({
      output: "developer.css",
      producerMember: "developer/application.css",
      bytes: 4250,
      sha256: "6952118016681724443152d5a27c3bbe231e1ad804c33076432dd62b7379f88d",
    }),
    Object.freeze({
      output: "graphic-designer.css",
      producerMember: "graphic-designer/application.css",
      bytes: 4246,
      sha256: "5bd1f7de357259b389bfcdeab25044b5b8044ef4ad9a54388a762b4227001d12",
    }),
    Object.freeze({
      output: "anime.css",
      producerMember: "anime/application.css",
      bytes: 4247,
      sha256: "3e6bcb1635261da524f66eace082d7878c548db832f8e7816ac2c26fd55a6cbb",
    }),
    Object.freeze({
      output: "gamer.css",
      producerMember: "gamer/application.css",
      bytes: 4250,
      sha256: "c89d11e1c225127c4288a7a6b3f2a5f096d3cb8ee96225e47fea7897643919d6",
    }),
  ]),
});

const EXPECTED_SOURCE_PROFILE_MANIFEST = Object.freeze({
  schema: "theme-forge.appearance-source-manifest.v1",
  inventoryDigest: EXPECTED_PROVENANCE.inventoryDigest,
  members: Object.freeze([
    {
        "path": "appearances/profiles/anime.profile.json",
        "size": 4731,
        "sha256": "af5a25686b15935226937209e2e4d020a3a5db229bd087dcc82637128ec6edda",
        "name": "anime"
    },
    {
        "path": "appearances/profiles/developer.profile.json",
        "size": 4734,
        "sha256": "7b873b36bf4f0d141e70b72a11dbc6dac7f8250de0b2479b84fe014d629597a8",
        "name": "developer"
    },
    {
        "path": "appearances/profiles/gamer.profile.json",
        "size": 4724,
        "sha256": "f5880e7d49d6f8f3550c7ad2f338b0fc6036c7b70f053534da1947428cd4a303",
        "name": "gamer"
    },
    {
        "path": "appearances/profiles/graphic-designer.profile.json",
        "size": 4742,
        "sha256": "a8e06be7ebda519fcc2181d7daa8f4dbb86ca473cc3245ea710af27ba0c56232",
        "name": "graphic-designer"
    },
    {
        "path": "appearances/profiles/nebular.profile.json",
        "size": 3134,
        "sha256": "fbe0dd3e46ca587f15e3ff221cf24b23e16321b7cca32c28bd1a7d31c20f9c88",
        "name": "nebular"
    },
    {
        "path": "appearances/profiles/terminal-nova.profile.json",
        "size": 3123,
        "sha256": "fe3c5e92ef17171bb018356e72d31e825291d81bb225a167885adea5dcf330bf",
        "name": "terminal-nova"
    }
]),
});

const EXPECTED_BROWSER_PROOF = Object.freeze({
  schema: "theme-forge.site-browser-proof-provenance.v1",
  asset: Object.freeze({
    path: "screenshots/gamer-dark-shell.jpg",
    bytes: 64908,
    sha256: "37bf3f2c2ceb26cd0baeb493f2444707d8cf1e4fc87c2c261359f18f2e6f43ed",
    mediaType: "image/jpeg",
    width: 1265,
    height: 712,
  }),
  source: Object.freeze({
    fixtureSchema: "theme-forge.actual-app-browser-fixture.v1",
    fixtureManifestSha256: "487b69d20ce0f7c800f88c7b4fd0b24ce6bac298099156b00e8fc3bcb469e020",
    actualApp: "Theme Forge App preview",
    externalSlotAsset: "/appearance-owned-slot.css",
    captureBoundary: "Browser-rendered source fixture with an explicit mock boundary banner; native ports remain mocked.",
  }),
  presentation: Object.freeze({
    label: "Browser-rendered next-cycle preview",
    caption: "Actual App/external CSSOM fixture capture; browser-only, native ports mocked, development preview, not the published Nebular Fusion 0.7.1 interface.",
    qualificationBoundary: "This source projection does not establish native, hosted, deployment, rights, release, or final visual acceptance.",
  }),
});

const MANIFEST_NAME = "manifest.json";
const MANIFEST_SCHEMA = "theme-forge.static-site-build.v1";
const STAGE_PREFIX = ".tfnf-static-stage-";
const PAYLOAD_PREFIX = ".tfnf-static-payload-";
const STAGE_MARKER = ".tfnf-static-stage-owner";
const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const NONBLOCK = fs.constants.O_NONBLOCK;
const STAGE_MARKER_MAX_BYTES = 128;

export class StaticBuildError extends Error {
  constructor(code) {
    super(`TFNF_STATIC_BUILD_${code}`);
    this.name = "StaticBuildError";
    this.code = code;
  }
}

function fail(code) {
  throw new StaticBuildError(code);
}

function isSafeRelativePath(relativePath) {
  return typeof relativePath === "string"
    && relativePath.length > 0
    && !path.isAbsolute(relativePath)
    && relativePath.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function lstatOrFail(filePath, code) {
  try {
    return fs.lstatSync(filePath);
  } catch {
    fail(code);
  }
}

function assertDirectory(directoryPath, code) {
  const stat = lstatOrFail(directoryPath, code);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(code);
}

function assertSourceRoot(sourceRoot) {
  assertDirectory(sourceRoot, "source-root-rejected");
  const stat = lstatOrFail(sourceRoot, "source-root-rejected");
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("source-root-rejected");
}

function assertSourceParentDirectories(sourceRoot, relativePath) {
  const parts = relativePath.split("/");
  let current = sourceRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = lstatOrFail(current, "source-entry-rejected");
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("source-entry-rejected");
  }
}

function readSourceFile(sourceRoot, relativePath) {
  if (!isSafeRelativePath(relativePath)) fail("source-entry-rejected");
  assertSourceParentDirectories(sourceRoot, relativePath);
  const filePath = path.join(sourceRoot, ...relativePath.split("/"));
  const stat = lstatOrFail(filePath, "source-entry-rejected");
  if (stat.isSymbolicLink() || !stat.isFile()) fail("source-entry-rejected");
  if (!Number.isInteger(NOFOLLOW)) fail("source-platform-unsupported");

  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW);
    const opened = fs.fstatSync(fileDescriptor);
    if (opened.isSymbolicLink() || !opened.isFile()) fail("source-entry-rejected");
    return fs.readFileSync(fileDescriptor);
  } catch (error) {
    if (error instanceof StaticBuildError) throw error;
    fail("source-read-failed");
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code);
  }
}

function sameKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateProvenance(sourceBytes) {
  const provenance = parseJson(sourceBytes.get("appearances/provenance.json"), "provenance-invalid");
  if (!sameKeys(provenance, ["schema", "inventoryDigest", "sourceCatalogSha256", "members", "inputCatalogKind", "qualification"])) fail("provenance-invalid");
  if (provenance.schema !== EXPECTED_PROVENANCE.schema
    || provenance.inventoryDigest !== EXPECTED_PROVENANCE.inventoryDigest
    || provenance.sourceCatalogSha256 !== EXPECTED_PROVENANCE.sourceCatalogSha256
    || typeof provenance.inputCatalogKind !== "string"
    || typeof provenance.qualification !== "string"
    || !Array.isArray(provenance.members)
    || provenance.members.length !== EXPECTED_PROVENANCE.members.length) fail("provenance-invalid");

  const actualByOutput = new Map();
  for (const member of provenance.members) {
    if (!sameKeys(member, ["output", "producerMember", "bytes", "sha256"])) fail("provenance-invalid");
    if (actualByOutput.has(member.output)) fail("provenance-invalid");
    actualByOutput.set(member.output, member);
  }

  for (const expected of EXPECTED_PROVENANCE.members) {
    const actual = actualByOutput.get(expected.output);
    if (!actual
      || actual.output !== expected.output
      || actual.producerMember !== expected.producerMember
      || actual.bytes !== expected.bytes
      || actual.sha256 !== expected.sha256) fail("provenance-invalid");
    const bytes = sourceBytes.get(`appearances/${expected.output}`);
    if (!bytes || bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) fail("appearance-hash-mismatch");
  }

  const catalog = parseJson(sourceBytes.get("appearances/catalog.json"), "provenance-invalid");
  if (!catalog || catalog.schema !== "theme-forge.site-appearance-index.v1"
    || catalog.sourceCatalogSha256 !== EXPECTED_PROVENANCE.sourceCatalogSha256
    || !Array.isArray(catalog.families)
    || catalog.families.length !== 6) fail("provenance-invalid");
}

function validateSourceProfiles(sourceBytes) {
  const manifest = parseJson(sourceBytes.get("appearances/source-profiles.json"), "appearance-source-manifest-invalid");
  if (!sameKeys(manifest, ["schema", "inventoryDigest", "members"])
    || manifest.schema !== EXPECTED_SOURCE_PROFILE_MANIFEST.schema
    || manifest.inventoryDigest !== EXPECTED_SOURCE_PROFILE_MANIFEST.inventoryDigest
    || !Array.isArray(manifest.members)
    || manifest.members.length !== 6) fail("appearance-source-manifest-invalid");

  const actualByPath = new Map();
  for (const member of manifest.members) {
    if (!sameKeys(member, ["path", "size", "sha256", "schema", "name", "version"]) || actualByPath.has(member.path)) {
      fail("appearance-source-manifest-invalid");
    }
    actualByPath.set(member.path, member);
  }

  for (const expected of EXPECTED_SOURCE_PROFILE_MANIFEST.members) {
    const name = expected.name;
    const expectedPath = expected.path;
    const actual = actualByPath.get(expectedPath);
    if (!actual
      || actual.path !== expectedPath
      || !Number.isInteger(actual.size)
      || actual.size < 1
      || typeof actual.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(actual.sha256)
      || actual.schema !== "tf-paired-profile-v2"
      || actual.name !== name
      || actual.version !== "0.1.0") fail("appearance-source-manifest-invalid");
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) fail("appearance-source-hash-mismatch");
    const bytes = sourceBytes.get(expectedPath);
    if (!bytes || bytes.length !== actual.size || sha256(bytes) !== actual.sha256) fail("appearance-source-hash-mismatch");
    const profile = parseJson(bytes, "appearance-source-manifest-invalid");
    if (!profile || profile.schemaVersion !== actual.schema || profile.name !== actual.name || profile.version !== actual.version) {
      fail("appearance-source-manifest-invalid");
    }
  }
}

function validateBrowserProof(sourceBytes) {
  const provenance = parseJson(sourceBytes.get("screenshots/screenshot-provenance.json"), "browser-proof-provenance-invalid");
  if (!sameKeys(provenance, ["schema", "asset", "source", "presentation"])
    || provenance.schema !== EXPECTED_BROWSER_PROOF.schema
    || !sameKeys(provenance.asset, Object.keys(EXPECTED_BROWSER_PROOF.asset))
    || !sameKeys(provenance.source, Object.keys(EXPECTED_BROWSER_PROOF.source))
    || !sameKeys(provenance.presentation, Object.keys(EXPECTED_BROWSER_PROOF.presentation))) {
    fail("browser-proof-provenance-invalid");
  }

  for (const [key, expected] of Object.entries(EXPECTED_BROWSER_PROOF.asset)) {
    if (provenance.asset[key] !== expected) fail("browser-proof-provenance-invalid");
  }
  for (const [key, expected] of Object.entries(EXPECTED_BROWSER_PROOF.source)) {
    if (provenance.source[key] !== expected) fail("browser-proof-provenance-invalid");
  }
  for (const [key, expected] of Object.entries(EXPECTED_BROWSER_PROOF.presentation)) {
    if (provenance.presentation[key] !== expected) fail("browser-proof-provenance-invalid");
  }

  const html = sourceBytes.get("index.html")?.toString("utf8") ?? "";
  if (!html.includes("<figcaption>" + EXPECTED_BROWSER_PROOF.presentation.caption + "</figcaption>")
    || !html.includes("the in-app version label is the fixture source, not a release screenshot.")) {
    fail("browser-proof-presentation-mismatch");
  }

  const imageBytes = sourceBytes.get(EXPECTED_BROWSER_PROOF.asset.path);
  if (!imageBytes
    || imageBytes.length !== EXPECTED_BROWSER_PROOF.asset.bytes
    || sha256(imageBytes) !== EXPECTED_BROWSER_PROOF.asset.sha256) {
    fail("browser-proof-hash-mismatch");
  }
}

function validateSourceSnapshot(sourceRoot) {
  assertSourceRoot(sourceRoot);
  const sourceBytes = new Map();
  for (const relativePath of PUBLIC_MEMBERS) {
    sourceBytes.set(relativePath, readSourceFile(sourceRoot, relativePath));
  }
  validateProvenance(sourceBytes);
  validateSourceProfiles(sourceBytes);
  validateBrowserProof(sourceBytes);
  return sourceBytes;
}

function assertOutputParent(outputDirectory) {
  const outputParent = path.dirname(outputDirectory);
  assertDirectory(outputParent, "output-parent-rejected");
  const parentStat = lstatOrFail(outputParent, "output-parent-rejected");
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail("output-parent-rejected");
}

function assertOutputAbsent(outputDirectory) {
  try {
    fs.lstatSync(outputDirectory);
    fail("output-exists");
  } catch (error) {
    if (error instanceof StaticBuildError) throw error;
    if (error?.code !== "ENOENT") fail("output-rejected");
  }
}

function writeOwnedFile(filePath, bytes) {
  try {
    fs.writeFileSync(filePath, bytes, { flag: "wx", mode: FILE_MODE });
    fs.chmodSync(filePath, FILE_MODE);
  } catch {
    fail("staging-failed");
  }
}

function createManifest(sourceBytes) {
  const members = [...PUBLIC_MEMBERS]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((relativePath) => {
      const bytes = sourceBytes.get(relativePath);
      return {
        path: relativePath,
        bytes: bytes.length,
        sha256: sha256(bytes),
        mode: "0644",
      };
    });
  return {
    schema: MANIFEST_SCHEMA,
    manifest: MANIFEST_NAME,
    artifactCount: members.length,
    members,
  };
}

function writeStage(payloadDirectory, sourceBytes) {
  for (const relativePath of PUBLIC_MEMBERS) {
    const destination = path.join(payloadDirectory, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: DIRECTORY_MODE });
    writeOwnedFile(destination, sourceBytes.get(relativePath));
  }
  const manifest = `${JSON.stringify(createManifest(sourceBytes), null, 2)}\n`;
  writeOwnedFile(path.join(payloadDirectory, MANIFEST_NAME), Buffer.from(manifest, "utf8"));
}

function createStage(outputParent) {
  let stageDirectory;
  let stageStat;
  let payloadDirectory;
  let payloadStat;
  try {
    stageDirectory = fs.mkdtempSync(path.join(outputParent, STAGE_PREFIX));
    stageStat = fs.lstatSync(stageDirectory);
    if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) fail("staging-failed");
    fs.chmodSync(stageDirectory, DIRECTORY_MODE);
    const chmodStageStat = fs.lstatSync(stageDirectory);
    if (!sameDirectoryLocation(stageStat, chmodStageStat)) fail("staging-failed");
    stageStat = chmodStageStat;
    const marker = path.join(stageDirectory, STAGE_MARKER);
    const token = crypto.randomUUID();
    fs.writeFileSync(marker, `${token}\n`, { flag: "wx", mode: 0o600 });
    fs.chmodSync(marker, 0o600);
    payloadDirectory = fs.mkdtempSync(path.join(outputParent, PAYLOAD_PREFIX));
    payloadStat = fs.lstatSync(payloadDirectory);
    if (payloadStat.isSymbolicLink() || !payloadStat.isDirectory()) fail("staging-failed");
    fs.chmodSync(payloadDirectory, DIRECTORY_MODE);
    const chmodPayloadStat = fs.lstatSync(payloadDirectory);
    if (!sameDirectoryLocation(payloadStat, chmodPayloadStat)) fail("staging-failed");
    payloadStat = chmodPayloadStat;
    return { stageDirectory, payloadDirectory, payloadStat, token };
  } catch {
    if (payloadDirectory && payloadStat && payloadStat.isDirectory() && !payloadStat.isSymbolicLink()) {
      try {
        const currentPayloadStat = fs.lstatSync(payloadDirectory);
        if (sameDirectoryIdentity(payloadStat, currentPayloadStat)) fs.rmSync(payloadDirectory, { recursive: true, force: true });
      } catch { /* preserve an unverified or foreign payload */ }
    }
    if (stageDirectory && stageStat && stageStat.isDirectory() && !stageStat.isSymbolicLink()) {
      try {
        const currentStageStat = fs.lstatSync(stageDirectory);
        if (sameDirectoryIdentity(stageStat, currentStageStat)) fs.rmSync(stageDirectory, { recursive: true, force: true });
      } catch { /* preserve an unverified or foreign owner stage */ }
    }
    fail("staging-failed");
  }
}

function sameRegularFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode;
}

function sameDirectoryLocation(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeDescriptor(fd) {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // The descriptor is already unusable; the caller is still failing closed.
  }
}

function readBoundedMarker(fd, expectedBytes) {
  const bytes = Buffer.alloc(expectedBytes.length);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) fail("staging-failed");
    offset += count;
  }
  if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) fail("staging-failed");
  return bytes;
}

function openVerifiedStageMarker(stageDirectory, token) {
  if (typeof token !== "string") fail("staging-failed");
  if (!Number.isInteger(NOFOLLOW) || NOFOLLOW <= 0 || !Number.isInteger(NONBLOCK) || NONBLOCK <= 0) {
    fail("source-platform-unsupported");
  }

  const marker = path.join(stageDirectory, STAGE_MARKER);
  const expectedBytes = Buffer.from(`${token}\n`, "utf8");
  if (expectedBytes.length === 0 || expectedBytes.length > STAGE_MARKER_MAX_BYTES) fail("staging-failed");

  let fd;
  let retainDescriptor = false;
  try {
    fd = fs.openSync(marker, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (opened.isSymbolicLink() || !opened.isFile() || opened.size !== expectedBytes.length || opened.size > STAGE_MARKER_MAX_BYTES) {
      fail("staging-failed");
    }

    const bytes = readBoundedMarker(fd, expectedBytes);
    const afterRead = fs.fstatSync(fd);
    if (!sameRegularFileIdentity(opened, afterRead) || !afterRead.isFile() || afterRead.size !== expectedBytes.length || !bytes.equals(expectedBytes)) {
      fail("staging-failed");
    }

    // Re-stat the pathname without following it and require the same inode before
    // the owning stage directory is removed. Node does not expose unlinkat(2), so
    // a replacement after this check remains a bounded namespace-race limitation.
    const pathStat = fs.lstatSync(marker);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !sameRegularFileIdentity(pathStat, afterRead)) fail("staging-failed");

    retainDescriptor = true;
    return { fd, marker, stat: afterRead };
  } catch (error) {
    if (error instanceof StaticBuildError) throw error;
    fail("staging-failed");
  } finally {
    if (!retainDescriptor) closeDescriptor(fd);
  }
}

function withVerifiedStageMarker(stageDirectory, token, callback) {
  const descriptor = openVerifiedStageMarker(stageDirectory, token);
  try {
    return callback(descriptor);
  } finally {
    closeDescriptor(descriptor.fd);
  }
}

function assertOwnerStageContents(stageDirectory) {
  const entries = fs.readdirSync(stageDirectory, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== STAGE_MARKER || !entries[0].isFile()) fail("staging-failed");
}

function removeOwnedStage(stageDirectory, token) {
  try {
    const stageStat = fs.lstatSync(stageDirectory);
    if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) fail("staging-failed");
    withVerifiedStageMarker(stageDirectory, token, () => {
      const currentStageStat = fs.lstatSync(stageDirectory);
      if (currentStageStat.isSymbolicLink() || !currentStageStat.isDirectory() || !sameDirectoryIdentity(stageStat, currentStageStat)) {
        fail("staging-failed");
      }
      assertOwnerStageContents(stageDirectory);
      fs.rmSync(stageDirectory, { recursive: true, force: true });
    });
    try {
      fs.lstatSync(stageDirectory);
      fail("staging-failed");
    } catch (error) {
      if (error instanceof StaticBuildError) throw error;
      if (error?.code !== "ENOENT") fail("staging-failed");
    }
  } catch (error) {
    if (error instanceof StaticBuildError) throw error;
    fail("staging-failed");
  }
}

function cleanupStage(stageDirectory, token) {
  if (!stageDirectory) return;
  try {
    removeOwnedStage(stageDirectory, token);
  } catch {
    // Never turn cleanup into a recursive delete of an unverified path.
  }
}

function cleanupPayload(payloadDirectory, payloadStat) {
  if (!payloadDirectory || !payloadStat) return;
  try {
    const currentPayloadStat = fs.lstatSync(payloadDirectory);
    if (currentPayloadStat.isSymbolicLink() || !currentPayloadStat.isDirectory() || !sameDirectoryIdentity(payloadStat, currentPayloadStat)) return;
    fs.rmSync(payloadDirectory, { recursive: true, force: true });
  } catch {
    // Never turn cleanup into a recursive delete of an unverified path.
  }
}

function assertPayloadDirectoryOwned(payloadDirectory, payloadStat) {
  const currentPayloadStat = fs.lstatSync(payloadDirectory);
  if (currentPayloadStat.isSymbolicLink() || !currentPayloadStat.isDirectory() || !sameDirectoryIdentity(payloadStat, currentPayloadStat)) {
    fail("staging-failed");
  }
}

function outputDirectoryIsPresent(outputDirectory) {
  try {
    fs.lstatSync(outputDirectory);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("output-rejected");
  }
}

export function buildStaticSite({ sourceRoot = SITE_ROOT, outputDir } = {}) {
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const absoluteOutputDirectory = path.resolve(outputDir ?? path.join(absoluteSourceRoot, "dist"));
  if (absoluteOutputDirectory === absoluteSourceRoot) fail("output-rejected");

  const sourceBytes = validateSourceSnapshot(absoluteSourceRoot);
  assertOutputParent(absoluteOutputDirectory);
  assertOutputAbsent(absoluteOutputDirectory);

  const outputParent = path.dirname(absoluteOutputDirectory);
  const { stageDirectory, payloadDirectory, payloadStat, token } = createStage(outputParent);
  let ownerStageRemoved = false;
  let payloadPublished = false;
  try {
    writeStage(payloadDirectory, sourceBytes);
    if (outputDirectoryIsPresent(absoluteOutputDirectory)) fail("output-exists");
    removeOwnedStage(stageDirectory, token);
    ownerStageRemoved = true;
    assertPayloadDirectoryOwned(payloadDirectory, payloadStat);
    try {
      fs.renameSync(payloadDirectory, absoluteOutputDirectory);
      payloadPublished = true;
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY" || error?.code === "EISDIR") fail("output-exists");
      fail("publish-failed");
    }
    return {
      outputDir: absoluteOutputDirectory,
      memberCount: PUBLIC_MEMBERS.length,
      outputFileCount: PUBLIC_MEMBERS.length + 1,
      manifest: createManifest(sourceBytes),
    };
  } catch (error) {
    if (error instanceof StaticBuildError) throw error;
    fail("build-failed");
  } finally {
    if (!ownerStageRemoved) cleanupStage(stageDirectory, token);
    if (!payloadPublished) cleanupPayload(payloadDirectory, payloadStat);
  }
}

function parseOutputArgument(argumentsList) {
  if (argumentsList.length === 0) return path.join(SITE_ROOT, "dist");
  if (argumentsList.length === 2 && argumentsList[0] === "--output" && argumentsList[1]) {
    return path.resolve(argumentsList[1]);
  }
  fail("usage");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outputDir = parseOutputArgument(process.argv.slice(2));
    const result = buildStaticSite({ outputDir });
    console.log(`TFNF_STATIC_BUILD_OK ${result.outputFileCount} files`);
  } catch (error) {
    if (error instanceof StaticBuildError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      console.error("TFNF_STATIC_BUILD_build-failed");
      process.exitCode = 1;
    }
  }
}
