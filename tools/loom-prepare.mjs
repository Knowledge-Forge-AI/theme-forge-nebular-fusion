import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { repositoryRootForStudio } from "./sidecar-common.mjs";
import { prepareGallery } from "./gallery-prepare.mjs";

export const EXPECTED_LOOM_NAME = "@knowledge-forge-ai/theme-forge-stellar-loom";
export const EXPECTED_LOOM_VERSION = "0.2.0";
export const SUPPORTED_LOOM_VERSIONS = ["0.2.0", "0.1.1", "0.1.0"];
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export const FIXED_97_INVENTORY = Object.freeze([
  "bin/tfsl-batch.js",
  "bin/tfsl.js",
  "dist/adapters/starlight-v0-42.js",
  "dist/batch-catalog.js",
  "dist/batch.js",
  "dist/catalog/canonical.js",
  "dist/catalog/catalog.js",
  "dist/catalog/compiler.js",
  "dist/catalog/generator.js",
  "dist/catalog/index.js",
  "dist/catalog/parse.js",
  "dist/catalog/qualification.js",
  "dist/catalog/templates/compat-css.js",
  "dist/catalog/templates/hero.js",
  "dist/catalog/templates/loom-orbit.js",
  "dist/catalog/templates/middleware.js",
  "dist/catalog/templates/navigation.js",
  "dist/catalog/templates/page-title.js",
  "dist/catalog/templates/pagination.js",
  "dist/catalog/templates/sidebar.js",
  "dist/catalog/types.js",
  "dist/catalog/validator.js",
  "dist/cli-catalog.js",
  "dist/cli-v2.js",
  "dist/cli.js",
  "dist/code/canonical.js",
  "dist/code/catalog.js",
  "dist/code/compiler.js",
  "dist/code/config.js",
  "dist/code/index.js",
  "dist/code/json.js",
  "dist/code/parse.js",
  "dist/code/types.js",
  "dist/code/validator.js",
  "dist/compiler/canonical.js",
  "dist/compiler/contrast.js",
  "dist/compiler/descriptor.js",
  "dist/compiler/index.js",
  "dist/design-exchange-catalog/executable-members.js",
  "dist/design-exchange-catalog/executable.js",
  "dist/design-exchange-catalog/index.js",
  "dist/design-exchange-code/canonical.js",
  "dist/design-exchange-code/compat.js",
  "dist/design-exchange-code/constants.js",
  "dist/design-exchange-code/create.js",
  "dist/design-exchange-code/index.js",
  "dist/design-exchange-code/package-generator.js",
  "dist/design-exchange-code/serde.js",
  "dist/design-exchange-code/types.js",
  "dist/design-exchange-code/validator.js",
  "dist/design-exchange-code/verify.js",
  "dist/design-exchange-v2/canonical.js",
  "dist/design-exchange-v2/constants.js",
  "dist/design-exchange-v2/create.js",
  "dist/design-exchange-v2/import-v1.js",
  "dist/design-exchange-v2/index.js",
  "dist/design-exchange-v2/serde.js",
  "dist/design-exchange-v2/theme-v2.js",
  "dist/design-exchange-v2/types.js",
  "dist/design-exchange-v2/validator.js",
  "dist/design-exchange-v2/verify.js",
  "dist/design-exchange/canonical.js",
  "dist/design-exchange/constants.js",
  "dist/design-exchange/create.js",
  "dist/design-exchange/index.js",
  "dist/design-exchange/inspect.js",
  "dist/design-exchange/leaf-fields.js",
  "dist/design-exchange/png.js",
  "dist/design-exchange/serde.js",
  "dist/design-exchange/types.js",
  "dist/design-exchange/validator.js",
  "dist/design-exchange/verify.js",
  "dist/examples.js",
  "dist/font-resources.js",
  "dist/generator/code-emitter.js",
  "dist/generator/code-merge.js",
  "dist/generator/dispatch.js",
  "dist/generator/emitter.js",
  "dist/generator/index.js",
  "dist/generator/legal.js",
  "dist/generator/metadata.js",
  "dist/generator/templates/page-title-frame.js",
  "dist/generator/types.js",
  "dist/generator/v2-emitter.js",
  "dist/generator/v2-writer.js",
  "dist/generator/writer.js",
  "dist/index-catalog.js",
  "dist/index.js",
  "dist/public-api.js",
  "dist/schema/validator.js",
  "dist/types.js",
  "dist/v2/canonical.js",
  "dist/v2/catalog.js",
  "dist/v2/compiler.js",
  "dist/v2/index.js",
  "dist/v2/types.js",
  "dist/v2/validator.js",
]);

const order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function canonical(value) {
  const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort(order).map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}

function readMemberSafe(root, relPath, maxBytes = 64 * 1024 * 1024) {
  if (typeof relPath !== "string" || !/^(?:dist|bin)\/[A-Za-z0-9_./-]+$/u.test(relPath)) {
    throw new Error(`Invalid member path format: '${relPath}'`);
  }
  if (relPath.startsWith("/") || relPath.includes("\\")) {
    throw new Error(`Absolute or non-normalized path forbidden: '${relPath}'`);
  }
  const parts = relPath.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) {
    throw new Error(`Path traversal forbidden: '${relPath}'`);
  }

  const rootResolved = resolve(root);
  const rootStat = lstatSync(rootResolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Invalid package root: '${root}'`);
  }

  let current = rootResolved;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) {
      throw new Error(`Loom package missing required path component: '${current}'`);
    }
    const st = lstatSync(current);
    if (st.isSymbolicLink()) {
      throw new Error(`Symlink forbidden in member path or ancestor: '${relPath}'`);
    }
  }

  const leafStat = lstatSync(current);
  if (!leafStat.isFile()) {
    throw new Error(`Non-regular file in member path: '${relPath}'`);
  }
  if (leafStat.size > maxBytes) {
    throw new Error(`Member file exceeds maximum byte bound: '${relPath}' (${leafStat.size} > ${maxBytes})`);
  }

  const bytes = readFileSync(current);
  if (bytes.length === 0) {
    throw new Error(`Empty member file forbidden: '${relPath}'`);
  }
  return bytes;
}

function jsInventory(root, directory) {
  const paths = [];
  const dirPath = join(root, directory);
  if (!existsSync(dirPath)) return paths;
  const dirStat = lstatSync(dirPath);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`Invalid directory in package inventory: '${directory}'`);
  }
  for (const item of readdirSync(dirPath, { withFileTypes: true })) {
    if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) {
      throw new Error(`Invalid non-regular entry in inventory: '${directory}/${item.name}'`);
    }
    const rel = `${directory}/${item.name}`;
    if (item.isDirectory()) {
      paths.push(...jsInventory(root, rel));
    } else if (/\.(?:js|mjs|cjs)$/u.test(rel)) {
      paths.push(rel);
    }
  }
  return paths.sort(order);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function authenticateCatalogEvidence(packageRoot, expectedCatalogEvidence = null) {
  const evidencePath = resolve(packageRoot, "dist/catalog-build-evidence.json");
  if (!existsSync(evidencePath)) {
    throw new Error("Loom package is missing required catalog build evidence: dist/catalog-build-evidence.json");
  }

  const evidenceBytes = readMemberSafe(packageRoot, "dist/catalog-build-evidence.json", 1024 * 1024);
  let evidence;
  try {
    evidence = JSON.parse(evidenceBytes.toString("utf8"));
  } catch {
    throw new Error("Loom package dist/catalog-build-evidence.json is invalid JSON");
  }

  if (evidence.schema !== "tfsl.catalog-build-evidence-v1") {
    throw new Error(`Loom package catalog build evidence has invalid schema: '${evidence.schema}'`);
  }

  if (!Array.isArray(evidence.members) || evidence.members.length === 0) {
    throw new Error("Loom package catalog build evidence contains no members");
  }

  const actualEvidenceSha256 = sha256(evidenceBytes);
  if (expectedCatalogEvidence?.sha256 && actualEvidenceSha256 !== expectedCatalogEvidence.sha256) {
    throw new Error(`Loom package catalog build evidence SHA-256 mismatch. Expected: ${expectedCatalogEvidence.sha256}, Actual: ${actualEvidenceSha256}`);
  }

  // Exact fixed 97 inventory verification
  const expectedSorted = [...FIXED_97_INVENTORY].sort(order);
  if (evidence.members.length !== expectedSorted.length) {
    throw new Error(`Loom package catalog build evidence member count mismatch: expected ${expectedSorted.length}, got ${evidence.members.length}`);
  }

  const seenPaths = new Set();
  const memberHashMap = new Map();
  for (const member of evidence.members) {
    if (!member || typeof member.path !== "string" || typeof member.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(member.sha256)) {
      throw new Error("Loom package catalog build evidence contains malformed member record");
    }
    if (!Number.isSafeInteger(member.bytes) || member.bytes <= 0 || member.bytes > 64 * 1024 * 1024) {
      throw new Error(`Loom package catalog build evidence member bytes invalid for ${member.path}`);
    }
    if (seenPaths.has(member.path)) {
      throw new Error(`Duplicate member in catalog build evidence: ${member.path}`);
    }
    seenPaths.add(member.path);
    memberHashMap.set(member.path, member.sha256);

    const memberBytes = readMemberSafe(packageRoot, member.path);
    if (memberBytes.length !== member.bytes) {
      throw new Error(`Loom package catalog member size mismatch for ${member.path}: expected ${member.bytes}, got ${memberBytes.length}`);
    }
    const actualMemberSha256 = sha256(memberBytes);
    if (actualMemberSha256 !== member.sha256) {
      throw new Error(`Loom package catalog member digest mismatch for ${member.path}: expected ${member.sha256}, got ${actualMemberSha256}`);
    }
  }

  const manifestPathsSorted = evidence.members.map((m) => m.path).sort(order);
  if (canonical(manifestPathsSorted) !== canonical(expectedSorted)) {
    throw new Error("Loom package catalog build evidence members mismatch fixed 97 inventory");
  }

  // Confine executable files: no unexpected extra executable files on disk in dist/ or bin/
  const actualExecutableFiles = [...jsInventory(packageRoot, "dist"), ...jsInventory(packageRoot, "bin")].sort(order);
  if (canonical(actualExecutableFiles) !== canonical(expectedSorted)) {
    throw new Error("Loom package executable file inventory on disk does not match fixed 97 inventory (unexpected extra or missing files)");
  }

  // Recompute official executable identity digest matching Loom source
  const pkgPath = resolve(packageRoot, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error("Loom package missing package.json");
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (!pkg.exports || !pkg.bin || pkg.type !== "module") {
    throw new Error("Malformed entry projection in Loom package.json");
  }

  const identity = {
    schema: "tfsl.catalog-executable-identity-v1",
    semantic: "tfsl.theme-compiler-v2-catalog-1",
    catalog: "tfsl.starlight-component-catalog-v1",
    catalogDigest: "34b1b7c6359a3eb996043d5ce688e1d3740bfeafa462a1b912a08d162638fc73",
    entries: { exports: pkg.exports, bin: pkg.bin, type: pkg.type },
    buildEvidence: actualEvidenceSha256,
    members: expectedSorted.map((path) => ({ path, sha256: memberHashMap.get(path) })),
  };

  const computedExecutableIdentityDigest = `sha256:${sha256(Buffer.from(canonical(identity)))}`;
  if (expectedCatalogEvidence?.executableIdentityDigest && computedExecutableIdentityDigest !== expectedCatalogEvidence.executableIdentityDigest) {
    throw new Error(`Loom package executable identity digest mismatch: expected ${expectedCatalogEvidence.executableIdentityDigest}, got ${computedExecutableIdentityDigest}`);
  }

  return {
    schema: evidence.schema,
    sha256: actualEvidenceSha256,
    memberCount: evidence.members.length,
    executableIdentityDigest: computedExecutableIdentityDigest,
  };
}

function runLocalCommand(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: env || { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`Command ${command} ${args.join(" ")} failed (status: ${result.status})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

async function requireRegular(filePath, maximum = MAX_ARCHIVE_BYTES) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Input is not a regular file: ${basename(filePath)}`);
  }
  if (info.size > maximum) {
    throw new Error(`Input exceeds byte limit: ${basename(filePath)}`);
  }
  return info;
}

async function extractTarballSafely(archivePath, destination) {
  await requireRegular(archivePath, MAX_ARCHIVE_BYTES);
  const listing = runLocalCommand("tar", ["-tzf", archivePath], process.cwd());
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => {
    const normalized = entry.normalize("NFC");
    const components = normalized.split("/").filter(Boolean);
    return !normalized.startsWith("package/") || components.some((c) => c === "." || c === ".." || c.includes("\\"));
  })) {
    throw new Error("Loom archive contains unsafe paths or is missing 'package/' root prefix");
  }

  const verbose = runLocalCommand("tar", ["-tvzf", archivePath], process.cwd());
  if (verbose.split(/\r?\n/u).filter(Boolean).some((line) => !/^[-d]/u.test(line))) {
    throw new Error("Loom archive contains symbolic or hard link entries");
  }

  await mkdir(destination, { recursive: true, mode: 0o755 });
  runLocalCommand("tar", ["-xzf", archivePath, "-C", destination], process.cwd());
  const packageRoot = resolve(destination, "package");
  const packageInfo = await lstat(packageRoot);
  if (packageInfo.isSymbolicLink() || !packageInfo.isDirectory()) {
    throw new Error("Extracted Loom package root is invalid");
  }
  return packageRoot;
}

export function parseLoomPrepareArgs(argv) {
  const options = {
    tarball: undefined,
    sha256: undefined,
    release: false,
    dev: false,
    instrumented: false,
    previewDist: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tarball" || arg === "--loom-tarball") {
      options.tarball = argv[++i];
    } else if (arg === "--sha256" || arg === "--loom-sha256") {
      options.sha256 = argv[++i];
    } else if (arg === "--preview-dist") {
      options.previewDist = argv[++i];
    } else if (arg === "--release") {
      options.release = true;
    } else if (arg === "--dev") {
      options.dev = true;
    } else if (arg === "--instrumented") {
      options.instrumented = true;
    }
  }

  return options;
}

export async function prepareLoom(customOptions = {}) {
  const cliOptions = parseLoomPrepareArgs(process.argv.slice(2));
  const options = { ...cliOptions, ...customOptions };

  const studioRoot = options.studioRoot ? resolve(options.studioRoot) : resolve(import.meta.dirname, "..");
  const repoRoot = repositoryRootForStudio(studioRoot);
  const loomRoot = resolve(repoRoot, "packages/stellar-loom");
  const fixtureRoot = resolve(loomRoot, "fixture");

  const isRelease = options.release || process.env.TFSL_RELEASE === "1" || process.env.NODE_ENV === "production";
  const isInstrumented = options.instrumented || process.argv.includes("--instrumented") || process.env.TFSL_INSTRUMENTED_PREVIEW === "1";
  const isDev = options.dev && !isRelease;

  console.log(`Preparing Theme Forge Stellar Loom payload and preview (release: ${isRelease}, dev: ${isDev}, instrumented: ${isInstrumented})...`);

  // Check authenticated-inputs/loom-binding.json if present
  let authBinding = null;
  const authBindingPath = resolve(repoRoot, "authenticated-inputs/loom-binding.json");
  if (existsSync(authBindingPath)) {
    try {
      const bindingRaw = await readFile(authBindingPath, "utf8");
      authBinding = JSON.parse(bindingRaw);
    } catch {
      throw new Error("authenticated-inputs/loom-binding.json is invalid JSON");
    }
  }

  // Determine exact tarball and expected sha256
  let tarballPath = options.tarball || process.env.TFSL_LOOM_TARBALL || process.env.TFSB_STUDIO_LOOM_TARBALL;
  let expectedSha256 = options.sha256 || process.env.TFSL_LOOM_SHA256 || process.env.TFSB_STUDIO_LOOM_SHA256;

  if (!tarballPath && (authBinding?.filename || authBinding?.tarballName)) {
    const bindingName = authBinding.name || authBinding.packageName;
    const bindingFilename = authBinding.filename || authBinding.tarballName;
    const bindingVersion = authBinding.version || authBinding.packageVersion;
    const isSupportedVersion = SUPPORTED_LOOM_VERSIONS.includes(bindingVersion);
    if (bindingName !== EXPECTED_LOOM_NAME || !isSupportedVersion
        || !bindingFilename || basename(bindingFilename) !== bindingFilename || !/^[a-f0-9]{64}$/.test(authBinding.sha256)) {
      throw new Error("Loom authenticated binding is invalid");
    }
    const authTarball = resolve(repoRoot, "authenticated-inputs/loom-tarball", bindingFilename);
    if (existsSync(authTarball)) {
      tarballPath = authTarball;
      expectedSha256 = expectedSha256 || authBinding.sha256;
    }
  }

  if (!tarballPath && !isDev) {
    const authTarballDir = resolve(repoRoot, "authenticated-inputs/loom-tarball");
    if (existsSync(authTarballDir)) {
      const tgts = readdirSync(authTarballDir).filter((f) => f.endsWith(".tgz"));
      if (tgts.length === 1) {
        tarballPath = resolve(authTarballDir, tgts[0]);
      }
    }
  }

  const payloadRoot = resolve(studioRoot, "src-tauri/loom-payload");

  if (tarballPath) {
    // Exact candidate tarball mode
    tarballPath = resolve(tarballPath);
    console.log(`Consuming explicit Loom tarball: ${tarballPath}`);
    await requireRegular(tarballPath, MAX_ARCHIVE_BYTES);

    const tarballBytes = await readFile(tarballPath);
    const actualSha256 = sha256(tarballBytes);

    if (expectedSha256) {
      if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new Error(`Loom tarball SHA-256 digest mismatch. Expected: ${expectedSha256}, Actual: ${actualSha256}`);
      }
      console.log(`Verified Loom tarball SHA-256: ${actualSha256}`);
    } else {
      throw new Error("Exact tarball preparation requires explicit sha256 verification");
    }

    const scratchRoot = await mkdtemp(join(tmpdir(), "tfsl-loom-extract-"));
    try {
      const packageRoot = await extractTarballSafely(tarballPath, scratchRoot);
      const pkgPath = resolve(packageRoot, "package.json");
      if (!existsSync(pkgPath)) {
        throw new Error("Extracted Loom package is missing package.json");
      }
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      if (pkg.name !== EXPECTED_LOOM_NAME) {
        throw new Error(`Extracted Loom package has invalid name: '${pkg.name}', expected '${EXPECTED_LOOM_NAME}'`);
      }
      if (!SUPPORTED_LOOM_VERSIONS.includes(pkg.version)) {
        throw new Error(`Extracted Loom package has invalid version: '${pkg.version}', expected one of ${SUPPORTED_LOOM_VERSIONS.join(", ")}`);
      }

      // Check required artifacts exist in extracted tarball
      const requiredArtifacts = [
        resolve(packageRoot, "dist/batch.js"),
        resolve(packageRoot, "dist/index.js"),
        resolve(packageRoot, "bin/tfsl-batch.js"),
      ];
      if (pkg.version === "0.2.0" || pkg.version === "0.1.1") {
        requiredArtifacts.push(resolve(packageRoot, "dist/catalog-build-evidence.json"));
      } else {
        requiredArtifacts.push(resolve(packageRoot, "dist/design-exchange/index.js"));
      }
      for (const artifact of requiredArtifacts) {
        if (!existsSync(artifact)) {
          throw new Error(`Extracted Loom package missing required artifact: ${basename(artifact)}`);
        }
      }

      // Authenticate runtime catalog evidence
      if (pkg.version === "0.2.0" || pkg.version === "0.1.1" || existsSync(resolve(packageRoot, "dist/catalog-build-evidence.json"))) {
        await authenticateCatalogEvidence(packageRoot, authBinding?.catalogBuildEvidence);
      }

      // Populate src-tauri/loom-payload
      await rm(payloadRoot, { recursive: true, force: true });
      await mkdir(payloadRoot, { recursive: true, mode: 0o755 });

      await cp(resolve(packageRoot, "dist"), resolve(payloadRoot, "dist"), { recursive: true });
      await cp(resolve(packageRoot, "bin"), resolve(payloadRoot, "bin"), { recursive: true });
      await cp(resolve(packageRoot, "package.json"), resolve(payloadRoot, "package.json"));

      if (existsSync(resolve(packageRoot, "examples"))) {
        await cp(resolve(packageRoot, "examples"), resolve(payloadRoot, "examples"), { recursive: true });
      }

      // Exact packaged schemas & fixtures
      if (existsSync(resolve(packageRoot, "protocol"))) {
        await cp(resolve(packageRoot, "protocol"), resolve(payloadRoot, "protocol"), { recursive: true });
      }

      // Exact packaged legal files
      for (const legalFile of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"]) {
        const src = resolve(packageRoot, legalFile);
        if (existsSync(src)) {
          await cp(src, resolve(payloadRoot, legalFile));
        }
      }

      console.log(`Loom payload populated from verified tarball (${EXPECTED_LOOM_NAME}@${pkg.version}).`);
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  } else if (isRelease) {
    // Release mode forbids ambient private dist
    throw new Error("Release mode requires explicit exact Loom npm tarball and sha256; ambient private dist is forbidden in release mode");
  } else {
    // Integration development mode fallback
    console.log("Using integration development mode from packages/stellar-loom...");

    const requiredInputs = [
      resolve(loomRoot, "package.json"),
      resolve(loomRoot, "src/batch.ts"),
      resolve(loomRoot, "bin/tfsl-batch.js"),
    ];
    for (const input of requiredInputs) {
      if (!existsSync(input)) {
        throw new Error(`Required Loom development source missing: ${input}`);
      }
    }

    console.log("Building stellar-loom...");
    const loomBuild = spawnSync("npm", ["run", "build"], { cwd: loomRoot, stdio: "inherit" });
    if (loomBuild.status !== 0) {
      throw new Error(`Failed to build stellar-loom (exit code: ${loomBuild.status})`);
    }

    const evidenceScript = resolve(loomRoot, "tools/build-catalog-evidence.mjs");
    if (existsSync(evidenceScript)) {
      console.log("Building catalog evidence for stellar-loom...");
      const evidenceBuild = spawnSync("node", [evidenceScript], { cwd: loomRoot, stdio: "inherit" });
      if (evidenceBuild.status !== 0) {
        throw new Error(`Failed to build stellar-loom catalog evidence (exit code: ${evidenceBuild.status})`);
      }
    }

    const loomDist = resolve(loomRoot, "dist");
    if (!existsSync(resolve(loomDist, "batch.js"))) {
      throw new Error("stellar-loom build succeeded but dist/batch.js is missing");
    }

    if (existsSync(resolve(loomDist, "catalog-build-evidence.json"))) {
      await authenticateCatalogEvidence(loomRoot);
    }

    await rm(payloadRoot, { recursive: true, force: true });
    await mkdir(payloadRoot, { recursive: true, mode: 0o755 });

    await cp(loomDist, resolve(payloadRoot, "dist"), { recursive: true });
    await cp(resolve(loomRoot, "bin"), resolve(payloadRoot, "bin"), { recursive: true });
    await cp(resolve(loomRoot, "package.json"), resolve(payloadRoot, "package.json"));

    if (existsSync(resolve(loomRoot, "examples"))) {
      await cp(resolve(loomRoot, "examples"), resolve(payloadRoot, "examples"), { recursive: true });
    }

    // Include exact packaged schemas/legal in dev mode as well
    if (existsSync(resolve(loomRoot, "protocol"))) {
      await cp(resolve(loomRoot, "protocol"), resolve(payloadRoot, "protocol"), { recursive: true });
    }

    for (const legalFile of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"]) {
      const src = resolve(loomRoot, legalFile);
      if (existsSync(src)) {
        await cp(src, resolve(payloadRoot, legalFile));
      }
    }

    console.log("Loom payload populated from development source tree.");
  }

  // Preview resources and standalone projection support
  const publicPreview = resolve(studioRoot, "public/preview");
  const loomPreviewSource = resolve(studioRoot, "loom-preview-source");

  if (options.previewDist && existsSync(resolve(options.previewDist, "index.html"))) {
    console.log(`Copying prebuilt preview from ${options.previewDist}...`);
    await rm(publicPreview, { recursive: true, force: true });
    await mkdir(publicPreview, { recursive: true });
    await cp(resolve(options.previewDist), publicPreview, { recursive: true });
  } else if (existsSync(loomPreviewSource)) {
    // Standalone projection with packaged preview source owned under projection
    console.log("Preparing preview from owned projection path loom-preview-source...");
    if (existsSync(resolve(loomPreviewSource, "package.json"))) {
      console.log(`Building neutral Starlight fixture in loom-preview-source (instrumented: ${isInstrumented})...`);
      const fixtureEnv = {
        ...process.env,
        ...(isInstrumented ? { TFSL_INSTRUMENTED_PREVIEW: "1" } : { TFSL_INSTRUMENTED_PREVIEW: "0" }),
      };
      const buildResult = spawnSync("npm", ["run", "build:neutral"], { cwd: loomPreviewSource, env: fixtureEnv, stdio: "inherit" });
      if (buildResult.status !== 0 || !existsSync(resolve(loomPreviewSource, "dist/neutral/index.html"))) {
        throw new Error(`Failed to build preview from loom-preview-source (exit code: ${buildResult.status})`);
      }
      await rm(publicPreview, { recursive: true, force: true });
      await mkdir(publicPreview, { recursive: true });
      await cp(resolve(loomPreviewSource, "dist/neutral"), publicPreview, { recursive: true });
    } else {
      throw new Error("loom-preview-source directory is missing its owning package.json");
    }
  } else if (existsSync(resolve(fixtureRoot, "package.json"))) {
    // Monorepo development mode
    console.log(`Building neutral Starlight fixture (instrumented: ${isInstrumented})...`);
    const fixtureEnv = {
      ...process.env,
      ...(isInstrumented ? { TFSL_INSTRUMENTED_PREVIEW: "1" } : { TFSL_INSTRUMENTED_PREVIEW: "0" }),
    };
    const fixtureBuild = spawnSync("npm", ["run", "build:neutral"], { cwd: fixtureRoot, env: fixtureEnv, stdio: "inherit" });
    if (fixtureBuild.status !== 0) {
      throw new Error(`Failed to build neutral fixture (exit code: ${fixtureBuild.status})`);
    }

    const fixtureDistNeutral = resolve(fixtureRoot, "dist/neutral");
    if (!existsSync(resolve(fixtureDistNeutral, "index.html"))) {
      throw new Error("neutral Starlight fixture build succeeded but dist/neutral/index.html is missing");
    }

    await rm(publicPreview, { recursive: true, force: true });
    await mkdir(publicPreview, { recursive: true });
    await cp(fixtureDistNeutral, publicPreview, { recursive: true });
  } else if (existsSync(resolve(publicPreview, "index.html"))) {
    console.log("Retaining existing public/preview assets in standalone projection.");
  } else {
    throw new Error("No preview source available (loom-preview-source, packages/stellar-loom/fixture, or prebuilt public/preview)");
  }

  // Prepare structural assets AFTER replacing the neutral preview tree. The
  // application never performs this build or receives the selected archive path.
  if (!tarballPath) throw new Error("Structural gallery preparation requires the authenticated Loom candidate archive (TFSL_LOOM_TARBALL).");
  const galleryScratch = await mkdtemp(join(tmpdir(), "nebular-gallery-build-"));
  try {
    await prepareGallery({ tarball: resolve(tarballPath), scratchRoot: galleryScratch,
      outputRoot: resolve(publicPreview, "gallery"),
      manifestPath: resolve(publicPreview, "gallery/manifest.json"), skipBrowser: true, scenario: null });
  } finally {
    await rm(galleryScratch, { recursive: true, force: true });
  }
  console.log("Loom preparation complete.");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  prepareLoom().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
