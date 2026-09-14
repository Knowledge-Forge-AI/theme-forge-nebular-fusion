/**
 * apps/studio/tools/rc-payloads.mjs
 *
 * TFSB65 Release-Candidate (RC) Payload Generation and Maintained Binding Owner.
 *
 * Responsibilities:
 * 1. Consumes exact, authenticated Burst 0.5.0 and Loom 0.2.0 RC tarball artifacts.
 * 2. Deterministically produces the closed Scene payload archive (bit-identical across runs).
 * 3. Maintains Scene Workbench v1 payload-binding.json (62 files, capability 0.5-development, metadataVersion 0.5.0).
 * 4. Maintains Theme Lab v2 payload-binding.json (322 files, exact Loom 0.2.0 archive digest and members).
 * 5. Updates gallery-contract.ts EXPECTED_ARCHIVE_SHA256 while strictly preserving the 37-field structural inventory.
 * 6. Emits heavy archives and execution receipt to designated output directory.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { prepareScenePayload, verifyScenePayload } from "./scene-prepare.mjs";
import { authenticateCatalogEvidence } from "./loom-prepare.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STUDIO_ROOT = resolve(__dirname, "..");

export const EXPECTED_BURST_NAME = "@knowledge-forge-ai/theme-forge-stellar-burst";
export const EXPECTED_BURST_VERSION = "0.5.0";
export const EXPECTED_BURST_SHA256 =
  "1222b613b119f785061ac61e25eccf3af9810f2b118a4669481c23cd390c661e";

export const EXPECTED_LOOM_NAME = "@knowledge-forge-ai/theme-forge-stellar-loom";
export const EXPECTED_LOOM_VERSION = "0.2.0";
export const EXPECTED_LOOM_SHA256 =
  "cdfb1ada33fb146a89622f32e3d676f581e4972b0b5654171ba0a6f08264cd0f";

export const EXPECTED_NODE_VERSION = "22.23.2";
export const EXPECTED_NODE_TARGET = "aarch64-apple-darwin";
export const EXPECTED_NODE_SHA256 =
  "18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572";
export const EXPECTED_NODE_BYTES = 112937728;

export const SCENE_BURST_MEMBERS = Object.freeze([
  "diagnostics",
  "digests",
  "primitives",
  "schema2-toml",
  "schema2-validation",
  "toml-writer",
  "scene/canonical",
  "scene/compile",
  "scene/constants",
  "scene/emit",
  "scene/geometry",
  "scene/glyphs/catalog",
  "scene/glyphs/labels",
  "scene/guard",
  "scene/import-svg-guard",
  "scene/import-svg",
  "scene/index",
  "scene/layout",
  "scene/path-canonical",
  "scene/transforms",
  "scene/validate",
]);

export const SCENE_BURST_LEGAL_FILES = Object.freeze([
  "COMMERCIAL-LICENSE.md",
  "LICENSE",
  "NOTICE",
]);

export const FIXED_TAR_TIMESTAMP = 1704067200; // 2024-01-01T00:00:00Z
export const FIXED_TAR_MODE = 0o644;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Safely validates and extracts a tarball into destination without path traversal or symlinks.
 */
export async function extractTarballSafely(archivePath, destination) {
  const st = await lstat(archivePath);
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new Error(`Archive is not a regular file: ${archivePath}`);
  }

  // Validate archive listing with tar -tzf
  const listing = execFileSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`Archive is empty: ${archivePath}`);
  }

  for (const entry of entries) {
    const normalized = entry.normalize("NFC");
    const components = normalized.split("/").filter(Boolean);
    if (
      !normalized.startsWith("package/") ||
      components.some((c) => c === "." || c === ".." || c.includes("\\"))
    ) {
      throw new Error(`Archive contains unsafe path: '${entry}'`);
    }
  }

  // Check no symlinks in tarball
  const verbose = execFileSync("tar", ["-tvzf", archivePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const line of verbose.split(/\r?\n/u).filter(Boolean)) {
    if (!/^[-d]/u.test(line)) {
      throw new Error(`Archive contains symbolic or hard links: ${line}`);
    }
  }

  await mkdir(destination, { recursive: true, mode: 0o755 });
  execFileSync("tar", ["-xzf", archivePath, "-C", destination], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const packageRoot = resolve(destination, "package");
  const pkgStat = await lstat(packageRoot);
  if (!pkgStat.isDirectory() || pkgStat.isSymbolicLink()) {
    throw new Error("Extracted package root is invalid");
  }
  return packageRoot;
}

/**
 * Computes canonical git-like tree digest for directory matching composition policy.
 */
export async function computeTreeDigest(rootDir) {
  const files = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = fullPath
        .slice(rootDir.length + 1)
        .split("\\")
        .join("/")
        .normalize("NFC");
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink at ${relPath}`);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const fileStat = await lstat(fullPath);
        const bytes = await readFile(fullPath);
        const digest = sha256Hex(bytes);
        const mode = fileStat.mode & 0o777;
        files.push({
          path: relPath,
          size: fileStat.size,
          mode,
          sha256: digest,
        });
      }
    }
  }
  await walk(rootDir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Hex(Buffer.from(JSON.stringify(files)));
}


/**
 * Builds deterministic scene payload archive tar.gz from prepared tree.
 */
export function packSceneArchive(treeDir, outputArchive) {
  execFileSync(
    "python3",
    [
      "-c",
      String.raw`
import gzip, pathlib, sys, tarfile
r = pathlib.Path(sys.argv[1])
with open(sys.argv[2], "xb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=1704067200) as gz, tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as t:
    for p in sorted(x for x in r.rglob("*") if x.is_file()):
        i = tarfile.TarInfo(p.relative_to(r).as_posix())
        i.size = p.stat().st_size
        i.mode = 0o644
        i.mtime = 1704067200
        with p.open("rb") as f:
            t.addfile(i, f)
`,
      treeDir,
      outputArchive,
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }
  );
}

/**
 * Locates dependency packages (@xmldom/xmldom and smol-toml).
 */
export function locateDependencyDirectories(options = {}) {
  const searchCandidates = [
    options.dependenciesDir,
    options.consumerBurstDir ? join(options.consumerBurstDir, "node_modules") : null,
  ].filter(Boolean);

  for (const base of searchCandidates) {
    const xmldomDir = join(base, "@xmldom/xmldom");
    const tomlDir = join(base, "smol-toml");
    if (existsSync(join(xmldomDir, "package.json")) && existsSync(join(tomlDir, "package.json"))) {
      const xPkg = JSON.parse(readFileSync(join(xmldomDir, "package.json"), "utf8"));
      const tPkg = JSON.parse(readFileSync(join(tomlDir, "package.json"), "utf8"));
      if (xPkg.name === "@xmldom/xmldom" && xPkg.version === "0.9.12" &&
          tPkg.name === "smol-toml" && tPkg.version === "1.8.0") {
        return { xmldomDir, tomlDir };
      }
    }
  }
  throw new Error("Could not locate required dependencies @xmldom/xmldom@0.9.12 and smol-toml@1.8.0");
}

/**
 * Constructs the scene payload tree (60 members) and returns tree directory and provenance.
 */
export async function constructScenePayloadTree(scratchDir, burstPackageRoot, dependencies) {
  const treeDir = join(scratchDir, "tree");
  await mkdir(treeDir, { recursive: true });

  const burstTarget = join(treeDir, "node_modules/@knowledge-forge-ai/theme-forge-stellar-burst");
  await mkdir(join(burstTarget, "dist/scene/glyphs"), { recursive: true });

  // 1. Verify Burst package identity first
  const burstPkgPath = join(burstPackageRoot, "package.json");
  if (!existsSync(burstPkgPath)) {
    throw new Error("Burst package is missing package.json");
  }
  const burstPkgRaw = await readFile(burstPkgPath, "utf8");
  const burstPkg = JSON.parse(burstPkgRaw);
  if (burstPkg.name !== EXPECTED_BURST_NAME || burstPkg.version !== EXPECTED_BURST_VERSION) {
    throw new Error(`Burst package identity mismatch: expected ${EXPECTED_BURST_NAME}@${EXPECTED_BURST_VERSION}, got ${burstPkg.name}@${burstPkg.version}`);
  }

  // 2. Copy 21 scene members
  for (const member of SCENE_BURST_MEMBERS) {
    const src = join(burstPackageRoot, `dist/${member}.js`);
    const dst = join(burstTarget, `dist/${member}.js`);
    await mkdir(dirname(dst), { recursive: true });
    await cp(src, dst);
  }

  // 3. Copy 3 legal files
  for (const legal of SCENE_BURST_LEGAL_FILES) {
    await cp(join(burstPackageRoot, legal), join(burstTarget, legal));
  }

  // 4. Trimmed package.json
  const trimmedPkg = JSON.stringify({
    name: burstPkg.name,
    version: burstPkg.version,
    type: "module",
    license: "AGPL-3.0-or-later",
    exports: { "./scene/v1": "./dist/scene/index.js" },
  }) + "\n";
  await writeFile(join(burstTarget, "package.json"), trimmedPkg);

  // 4. Dependencies
  await cp(dependencies.xmldomDir, join(treeDir, "node_modules/@xmldom/xmldom"), { recursive: true });
  await cp(dependencies.tomlDir, join(treeDir, "node_modules/smol-toml"), { recursive: true });

  // Dependency work is outside release versioning: require the exact maintained
  // dependency inventory rather than trusting names or an ambient node_modules.
  const prior = JSON.parse(await readFile(join(STUDIO_ROOT, "protocol/scene-workbench-v1/payload-binding.json"), "utf8"));
  const dependencyMembers = prior.files.filter(file => /^(?:node_modules\/@xmldom\/xmldom|node_modules\/smol-toml)\//.test(file.path));
  const actualDependencyMembers = [];
  async function authenticateDependencies(directory, prefix) {
    for (const entry of await readdir(directory, {withFileTypes:true})) {
      const name = prefix + "/" + entry.name;
      if (entry.isDirectory()) await authenticateDependencies(join(directory,entry.name),name);
      else if (entry.isFile()) {
        const bytes = await readFile(join(directory,entry.name));
        actualDependencyMembers.push({path:name,bytes:bytes.length,sha256:sha256Hex(bytes)});
      } else throw new Error("Dependency member must be a regular file");
    }
  }
  await authenticateDependencies(join(treeDir,"node_modules/@xmldom/xmldom"),"node_modules/@xmldom/xmldom");
  await authenticateDependencies(join(treeDir,"node_modules/smol-toml"),"node_modules/smol-toml");
  const ordered = values => JSON.stringify(values.sort((a,b)=>a.path.localeCompare(b.path)));
  if (ordered(actualDependencyMembers) !== ordered(dependencyMembers)) throw new Error("Dependency inventory differs from maintained pins");

  // 5. Compute executableFiles list (exactly 39 files: 21 burst + 8 xmldom + 10 toml)
  const executableFiles = [];
  async function collectExecutables(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectExecutables(full, rel);
      } else if (entry.isFile() && /\.(?:c?js|mjs)$/u.test(entry.name)) {
        const bytes = await readFile(full);
        const text = bytes.toString("utf8");
        if (/child_process|worker_threads|node:vm|process\s*\.\s*(?:dlopen|binding)|\bimport\s*\(|\beval\s*\(|\bnew\s+Function\b|resvg|\.node["']/u.test(text)) {
          throw new Error(`Scene closure contains unsupported execution facility in ${rel}`);
        }
        executableFiles.push({
          path: rel,
          sha256: sha256Hex(bytes),
          bytes: bytes.length,
        });
      }
    }
  }
  await collectExecutables(treeDir);
  executableFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (executableFiles.length !== 39) {
    throw new Error(`Expected exactly 39 executable files in scene payload, got ${executableFiles.length}`);
  }

  // 6. Source tree digest of the Burst 0.5.0 package
  const sourceTreeDigest = await computeTreeDigest(burstPackageRoot);

  // 7. Write scene-input.json
  const burstTarballBytes = await readFile(join(scratchDir, "burst-package.tgz"));
  const provenance = {
    schema: "tfsb.scene-input-v1",
    developmentCapability: "0.5-development",
    metadataVersion: EXPECTED_BURST_VERSION,
    sourceTreeDigest,
    inputs: [
      {
        name: "core",
        sha256: sha256Hex(burstTarballBytes),
        bytes: burstTarballBytes.length,
      },
      {
        name: "xmldom",
        sha256: "d0c47ddd331830cb8c8b144dfa344140365cf4f6b8a96c3054f824ba5702f4b6",
        bytes: 109414,
      },
      {
        name: "toml",
        sha256: "391ce6c5bae76614997d4628c50395884a969a7b1e70144c40f3fb5107cf2a31",
        bytes: 22853,
      },
    ],
    executableFiles,
  };

  await writeFile(join(treeDir, "scene-input.json"), JSON.stringify(provenance, null, 2) + "\n");

  return { treeDir, provenance, sourceTreeDigest };
}

/**
 * Builds the deterministic Scene payload archive and verifies determinism.
 */
export async function buildDeterministicSceneArchive(options) {
  const burstTarball = resolve(options.burstTarball);
  const expectedBurstSha256 = options.burstSha256 || EXPECTED_BURST_SHA256;

  const burstBytes = await readFile(burstTarball);
  const actualBurstSha256 = sha256Hex(burstBytes);
  if (actualBurstSha256 !== expectedBurstSha256) {
    throw new Error(`Burst RC tarball SHA-256 mismatch. Expected: ${expectedBurstSha256}, Actual: ${actualBurstSha256}`);
  }

  const dependencies = locateDependencyDirectories(options);

  const tempBase = options.tempRoot || tmpdir();
  const scratch1 = await mkdtemp(join(tempBase, "scene-det-1-"));
  const scratch2 = await mkdtemp(join(tempBase, "scene-det-2-"));

  try {
    // Copy tarball to scratch for provenance tracking
    await writeFile(join(scratch1, "burst-package.tgz"), burstBytes);
    await writeFile(join(scratch2, "burst-package.tgz"), burstBytes);

    const pkgRoot1 = await extractTarballSafely(burstTarball, join(scratch1, "extracted"));
    const pkgRoot2 = await extractTarballSafely(burstTarball, join(scratch2, "extracted"));

    const build1 = await constructScenePayloadTree(scratch1, pkgRoot1, dependencies);
    const build2 = await constructScenePayloadTree(scratch2, pkgRoot2, dependencies);

    const archive1 = join(scratch1, "scene-payload.tar.gz");
    const archive2 = join(scratch2, "scene-payload.tar.gz");

    packSceneArchive(build1.treeDir, archive1);
    packSceneArchive(build2.treeDir, archive2);

    const bytes1 = await readFile(archive1);
    const bytes2 = await readFile(archive2);

    if (bytes1.length !== bytes2.length || Buffer.compare(bytes1, bytes2) !== 0) {
      throw new Error("Fatal: Non-deterministic scene archive generation detected across identical builds");
    }

    const archiveSha256 = sha256Hex(bytes1);

    // Collect tree files for payload binding
    const files = [];
    async function collectBindingFiles(dir, prefix = "") {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await collectBindingFiles(full, rel);
        } else if (entry.isFile()) {
          const fb = await readFile(full);
          files.push({
            path: rel,
            bytes: fb.length,
            sha256: sha256Hex(fb),
          });
        }
      }
    }
    await collectBindingFiles(build1.treeDir);

    // Read existing adapter and root package.json hashes for the 62-member binding
    const existingBinding = JSON.parse(
      await readFile(join(STUDIO_ROOT, "protocol/scene-workbench-v1/payload-binding.json"), "utf8")
    );

    const batchMember = existingBinding.files.find((f) => f.path === "bin/scene-batch.js");
    const rootPkgMember = existingBinding.files.find((f) => f.path === "package.json");

    if (!batchMember || !rootPkgMember) {
      throw new Error("Existing scene binding is missing bin/scene-batch.js or package.json");
    }

    files.push(batchMember);
    files.push(rootPkgMember);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    if (files.length !== 62) {
      throw new Error(`Expected exactly 62 files in scene payload binding inventory, got ${files.length}`);
    }

    const sceneBinding = {
      sha256: archiveSha256,
      bytes: bytes1.length,
      sourceTreeDigest: build1.sourceTreeDigest,
      executableFiles: 39,
      schema: "tfsb.nebular-scene-binding-v1",
      engineSchema: "tfsb.vector-scene-v1",
      compatibility: 1,
      compilerLevel: 1,
      metadataVersion: EXPECTED_BURST_VERSION,
      capability: "0.5-development",
      node: existingBinding.node,
      adapterSha256: existingBinding.adapterSha256,
      files,
    };

    return {
      archiveBytes: bytes1,
      archiveSha256,
      archiveSize: bytes1.length,
      provenance: build1.provenance,
      sourceTreeDigest: build1.sourceTreeDigest,
      sceneBinding,
    };
  } finally {
    await rm(scratch1, { recursive: true, force: true });
    await rm(scratch2, { recursive: true, force: true });
  }
}

/**
 * Extracts and inspects Loom 0.2.0 RC artifact, verifying catalog evidence and 322 members.
 */
export async function inspectLoomRcArtifact(options) {
  const loomTarball = resolve(options.loomTarball);
  const expectedLoomSha256 = options.loomSha256 || EXPECTED_LOOM_SHA256;

  const loomBytes = await readFile(loomTarball);
  const actualLoomSha256 = sha256Hex(loomBytes);
  if (actualLoomSha256 !== expectedLoomSha256) {
    throw new Error(`Loom RC tarball SHA-256 mismatch. Expected: ${expectedLoomSha256}, Actual: ${actualLoomSha256}`);
  }

  const tempBase = options.tempRoot || tmpdir();
  const scratch = await mkdtemp(join(tempBase, "loom-inspect-"));
  try {
    const pkgRoot = await extractTarballSafely(loomTarball, scratch);

    const pkg = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
    if (pkg.name !== EXPECTED_LOOM_NAME || pkg.version !== EXPECTED_LOOM_VERSION) {
      throw new Error(`Loom package identity mismatch: expected ${EXPECTED_LOOM_NAME}@${EXPECTED_LOOM_VERSION}, got ${pkg.name}@${pkg.version}`);
    }

    // Authenticate catalog build evidence
    const catalogEvidence = await authenticateCatalogEvidence(pkgRoot);

    const files = [];
    async function walk(dir, prefix = "") {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, rel);
        } else if (entry.isFile()) {
          const fb = await readFile(full);
          files.push({
            path: rel,
            bytes: fb.length,
            sha256: sha256Hex(fb),
          });
        }
      }
    }
    await walk(pkgRoot);

    if (files.length !== 322) {
      throw new Error(`Expected exactly 322 files in Loom 0.2.0 payload binding inventory, got ${files.length}`);
    }

    const existingThemeLabBinding = JSON.parse(
      await readFile(join(STUDIO_ROOT, "protocol/theme-lab-v2/payload-binding.json"), "utf8")
    );

    const themeLabBinding = {
      schema: "tfsb.theme-lab-payload-binding-v1",
      packageArchiveSha256: actualLoomSha256,
      node: existingThemeLabBinding.node,
      files,
    };

    return {
      archiveSha256: actualLoomSha256,
      archiveSize: loomBytes.length,
      pkg,
      catalogEvidence,
      themeLabBinding,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * End-to-end execution of RC payload generation and binding update.
 */
export async function executeRcPayloadGeneration(options = {}) {
  const burstTarball = options.burstTarball;
  const burstSha256 = options.burstSha256;
  const loomTarball = options.loomTarball;
  const loomSha256 = options.loomSha256;
  const outputDir = options.outputDir;
  const nodeBinary = options.nodeBinary;
  if (!burstTarball || !loomTarball || !outputDir || !nodeBinary || !options.dependenciesDir ||
      !/^[a-f0-9]{64}$/.test(burstSha256 ?? "") || !/^[a-f0-9]{64}$/.test(loomSha256 ?? "")) {
    throw new Error("Explicit RC archives, SHA-256 values, dependencies, Node and fresh output directory are required");
  }
  if (!existsSync(nodeBinary)) throw new Error("Authenticated Node is required");
  if (existsSync(outputDir)) throw new Error("Fresh output directory is required");
  await mkdir(outputDir, {recursive:false});

  console.log("=== TFSB65 RC Payload Generation Owner ===");
  console.log(`Burst Tarball: ${burstTarball}`);
  console.log(`Loom Tarball:  ${loomTarball}`);
  console.log(`Output Dir:    ${outputDir}`);

  // 1. Build deterministic scene payload archive
  console.log("\nBuilding deterministic Scene payload archive...");
  const sceneResult = await buildDeterministicSceneArchive({
    burstTarball,
    burstSha256,
    ...options,
  });
  console.log(`Scene Archive generated: size=${sceneResult.archiveSize} bytes, sha256=${sceneResult.archiveSha256}`);

  // 2. Validate scene payload with prepareScenePayload / verifyScenePayload
  if (existsSync(nodeBinary)) {
    console.log("\nValidating Scene payload with authenticated Node binary...");
    const tempBase = options.tempRoot || tmpdir();
    const prepScratch = await mkdtemp(join(tempBase, "scene-verify-prep-"));
    try {
      const tempArchive = join(prepScratch, "scene-payload.tar.gz");
      await writeFile(tempArchive, sceneResult.archiveBytes);

      const prepDest = join(prepScratch, "prepared");
      const prepReceipt = await prepareScenePayload({
        archive: tempArchive,
        node: nodeBinary,
        destination: prepDest,
        binding: sceneResult.sceneBinding,
        expectedSha256: sceneResult.archiveSha256,
      });
      console.log("prepareScenePayload verified:", prepReceipt);

      const verifyReceipt = await verifyScenePayload(prepDest, nodeBinary, sceneResult.sceneBinding);
      console.log("verifyScenePayload verified:", verifyReceipt);
    } finally {
      await rm(prepScratch, { recursive: true, force: true });
    }
  }

  // 3. Inspect Loom 0.2.0 artifact
  console.log("\nInspecting Loom 0.2.0 RC artifact...");
  const loomResult = await inspectLoomRcArtifact({
    loomTarball,
    loomSha256,
    ...options,
  });
  console.log(`Loom Archive verified: size=${loomResult.archiveSize} bytes, sha256=${loomResult.archiveSha256}`);

  // 4. Update maintained bindings if requested
  if (options.updateBindings) {
    console.log("\nUpdating maintained repository bindings...");

    // Scene workbench binding
    const sceneBindingPath = join(STUDIO_ROOT, "protocol/scene-workbench-v1/payload-binding.json");
    await writeFile(
      sceneBindingPath,
      JSON.stringify(sceneResult.sceneBinding, null, 2) + "\n",
      "utf8"
    );
    console.log(`Updated ${sceneBindingPath}`);

    // Theme Lab v2 binding
    const themeLabBindingPath = join(STUDIO_ROOT, "protocol/theme-lab-v2/payload-binding.json");
    await writeFile(
      themeLabBindingPath,
      JSON.stringify(loomResult.themeLabBinding, null, 2) + "\n",
      "utf8"
    );
    console.log(`Updated ${themeLabBindingPath}`);

    // Gallery contract EXPECTED_ARCHIVE_SHA256
    const galleryContractPath = join(
      STUDIO_ROOT,
      "src/features/theme-lab/gallery-contract.ts"
    );
    const contractSource = await readFile(galleryContractPath, "utf8");
    if (contractSource.includes(`export const EXPECTED_ARCHIVE_SHA256 =\n  "${loomResult.archiveSha256}" as const;`)) {
      console.log(`gallery-contract.ts already has expected SHA-256 ${loomResult.archiveSha256}`);
    } else {
      const updatedContract = contractSource.replace(
        /export const EXPECTED_ARCHIVE_SHA256 =\s*"[a-f0-9]{64}" as const;/u,
        `export const EXPECTED_ARCHIVE_SHA256 =\n  "${loomResult.archiveSha256}" as const;`
      );
      if (contractSource === updatedContract) {
        throw new Error("Failed to update EXPECTED_ARCHIVE_SHA256 in gallery-contract.ts");
      }
      await writeFile(galleryContractPath, updatedContract, "utf8");
      console.log(`Updated ${galleryContractPath}`);
    }
  }

  // 5. Emit heavy archive and execution receipt to output directory
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    const archiveOutPath = join(outputDir, "scene-payload.tar.gz");
    await writeFile(archiveOutPath, sceneResult.archiveBytes);
    console.log(`Emitted heavy archive to ${archiveOutPath}`);

    const receipt = {
      schema: "tfsb.rc-payloads-receipt-v1",
      generatedAt: new Date().toISOString(),
      burst: {
        name: EXPECTED_BURST_NAME,
        version: EXPECTED_BURST_VERSION,
        tarball: basename(burstTarball),
        sha256: burstSha256,
        bytes: sceneResult.provenance.inputs[0].bytes,
        sourceTreeDigest: sceneResult.sourceTreeDigest,
      },
      loom: {
        name: EXPECTED_LOOM_NAME,
        version: EXPECTED_LOOM_VERSION,
        tarball: basename(loomTarball),
        sha256: loomSha256,
        bytes: loomResult.archiveSize,
        membersCount: loomResult.themeLabBinding.files.length,
        catalogBuildEvidenceSha256: loomResult.catalogEvidence.sha256,
      },
      sceneArchive: {
        filename: "scene-payload.tar.gz",
        sha256: sceneResult.archiveSha256,
        bytes: sceneResult.archiveSize,
        membersCount: 60,
        preparedFilesCount: 62,
        metadataVersion: EXPECTED_BURST_VERSION,
        capability: "0.5-development",
        deterministic: true,
      },
      node: sceneResult.sceneBinding.node,
    };

    const receiptPath = join(outputDir, "rc-payloads-receipt.json");
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
    console.log(`Emitted receipt to ${receiptPath}`);
  }

  // Clean up build scratch
  if (sceneResult.scratchDir) {
    await rm(sceneResult.scratchDir, { recursive: true, force: true });
  }

  return {
    sceneArchiveSha256: sceneResult.archiveSha256,
    sceneArchiveSize: sceneResult.archiveSize,
    sceneBinding: sceneResult.sceneBinding,
    loomArchiveSha256: loomResult.archiveSha256,
    loomArchiveSize: loomResult.archiveSize,
    themeLabBinding: loomResult.themeLabBinding,
  };
}

export function parseCliArgs(argv) {
  const options = {
    burstTarball: undefined,
    burstSha256: undefined,
    loomTarball: undefined,
    loomSha256: undefined,
    outputDir: undefined,
    nodeBinary: undefined,
    updateBindings: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--burst-tarball") options.burstTarball = argv[++i];
    else if (arg === "--burst-sha256") options.burstSha256 = argv[++i];
    else if (arg === "--loom-tarball") options.loomTarball = argv[++i];
    else if (arg === "--loom-sha256") options.loomSha256 = argv[++i];
    else if (arg === "--dependencies-dir") options.dependenciesDir = argv[++i];
    else if (arg === "--output-dir") options.outputDir = argv[++i];
    else if (arg === "--node" || arg === "--node-binary") options.nodeBinary = argv[++i];
    else if (arg === "--update-bindings") options.updateBindings = true;
  }
  return options;
}

if (process.argv[1] === __filename) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
  executeRcPayloadGeneration(cliOpts).catch((err) => {
    console.error("RC Payload generation failed:", err);
    process.exit(1);
  });
}
