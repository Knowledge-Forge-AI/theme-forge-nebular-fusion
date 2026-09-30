// @ts-check
import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareLoom,
  FIXED_101_INVENTORY,
  EXPECTED_LOOM_NAME,
  EXPECTED_LOOM_VERSION,
} from "./loom-prepare.mjs";

import {
  prepareSolarSail,
  EXPECTED_SOLAR_SAIL_NAME,
  EXPECTED_SOLAR_SAIL_VERSION,
  EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST,
  SOLAR_SAIL_RUNTIME_MEMBERS,
  SOLAR_SAIL_DECLARATION_MEMBERS,
} from "./solar-sail-prepare.mjs";

import {
  prepareSceneFromSource,
  prepareScenePayload,
  verifyScenePayload,
  sceneBinding,
} from "./scene-prepare.mjs";

import { SCENE_MEMBERS } from "./scene-input-build.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STUDIO_ROOT = resolve(__dirname, "..");
const AUTH_NODE_PATH = resolve(STUDIO_ROOT, "src-tauri/binaries/tfsb-studio-service-aarch64-apple-darwin");
const SCENE_PAYLOAD_SRC = resolve(STUDIO_ROOT, "src-tauri/scene-payload");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Creates a valid source-built Loom package tree in a directory.
 */
async function createMockSourceLoomPackage(targetDir) {
  await mkdir(targetDir, { recursive: true });

  const pkgJson = {
    name: EXPECTED_LOOM_NAME,
    version: EXPECTED_LOOM_VERSION,
    type: "module",
    exports: {
      ".": { types: "./dist/index-catalog.d.ts", import: "./dist/index-catalog.js" },
      "./batch": { types: "./dist/batch-catalog.d.ts", import: "./dist/batch-catalog.js" },
    },
    bin: {
      tfsl: "./bin/tfsl.js",
      "tfsl-batch": "./bin/tfsl-batch.js",
    },
  };
  await writeFile(join(targetDir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

  const members = [];
  for (const relPath of FIXED_101_INVENTORY) {
    const fullPath = join(targetDir, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    const content = `// ${relPath}\nexport const id = "${relPath}";\n`;
    await writeFile(fullPath, content, "utf8");
    const bytes = Buffer.from(content, "utf8");
    members.push({
      path: relPath,
      bytes: bytes.length,
      sha256: digest(bytes),
    });
  }

  // Write catalog-build-evidence.json
  const evidence = {
    schema: "tfsl.catalog-build-evidence-v1",
    semantic: "tfsl.theme-compiler-v2-catalog-1",
    catalog: "tfsl.starlight-component-catalog-v1",
    catalogDigest: "34b1b7c6359a3eb996043d5ce688e1d3740bfeafa462a1b912a08d162638fc73",
    members,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(join(targetDir, "dist/catalog-build-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");

  // Legal files
  for (const legal of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"]) {
    await writeFile(join(targetDir, legal), `Mock ${legal}\n`);
  }
}

/**
 * Creates a valid studio root with studio-owned loom-preview-source.
 */
async function createMockStudioRoot(studioDir) {
  await mkdir(studioDir, { recursive: true });
  const previewSource = join(studioDir, "loom-preview-source");
  await mkdir(join(previewSource, "dist/neutral"), { recursive: true });
  await writeFile(join(previewSource, "package.json"), '{"name":"mock-preview","scripts":{"build:neutral":"echo ok"}}\n');
  await writeFile(join(previewSource, "dist/neutral/index.html"), "<!DOCTYPE html><html><body>Neutral Preview</body></html>\n");
}

/**
 * Creates a valid source-built Solar Sail package tree.
 */
async function createMockSourceSolarSailPackage(targetDir) {
  await mkdir(targetDir, { recursive: true });

  const pkgJson = {
    name: EXPECTED_SOLAR_SAIL_NAME,
    version: EXPECTED_SOLAR_SAIL_VERSION,
    type: "module",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./cli": { types: "./dist/cli.d.ts", import: "./dist/cli.js" },
    },
    bin: { tfss: "./bin/tfss.js" },
  };
  await writeFile(join(targetDir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

  for (const member of SOLAR_SAIL_RUNTIME_MEMBERS) {
    const full = join(targetDir, member);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, `export const name = "${member}";\n`);
  }

  for (const decl of SOLAR_SAIL_DECLARATION_MEMBERS) {
    const full = join(targetDir, decl);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, `export declare const name: string;\n`);
  }

  for (const legal of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"]) {
    await writeFile(join(targetDir, legal), `Mock ${legal}\n`);
  }
}

/**
 * Creates a valid compiled Burst package tree and dependencies.
 */
async function createMockBurstAndDependencies(baseDir) {
  const burstDir = join(baseDir, "burst");
  await mkdir(burstDir, { recursive: true });

  const burstPkg = {
    name: "@knowledge-forge-ai/theme-forge-stellar-burst",
    version: "0.5.0",
    type: "module",
    license: "AGPL-3.0-or-later",
    exports: {
      "./scene/v1": { import: "./dist/scene/index.js" },
    },
  };
  await writeFile(join(burstDir, "package.json"), JSON.stringify(burstPkg, null, 2) + "\n");

  for (const member of SCENE_MEMBERS) {
    const full = join(burstDir, `dist/${member}.js`);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, `export const member = "${member}";\n`);
  }

  // Non-scene member in dist that should NOT be copied into scene payload
  await writeFile(join(burstDir, "dist/unrelated-burst-file.js"), "export const unrelated = true;\n");

  for (const legal of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md"]) {
    await writeFile(join(burstDir, legal), `Mock ${legal}\n`);
  }

  // xmldom dependency
  const xmldomDir = join(baseDir, "xmldom");
  await mkdir(join(xmldomDir, "lib"), { recursive: true });
  await writeFile(join(xmldomDir, "package.json"), JSON.stringify({ name: "@xmldom/xmldom", version: "0.9.12", type: "module" }) + "\n");
  await writeFile(join(xmldomDir, "index.js"), "export default {};\n");
  await writeFile(join(xmldomDir, "LICENSE"), "MIT\n");

  // smol-toml dependency
  const tomlDir = join(baseDir, "smol-toml");
  await mkdir(join(tomlDir, "dist"), { recursive: true });
  await writeFile(join(tomlDir, "package.json"), JSON.stringify({ name: "smol-toml", version: "1.8.0", type: "module" }) + "\n");
  await writeFile(join(tomlDir, "dist/index.js"), "export default {};\n");
  await writeFile(join(tomlDir, "LICENSE"), "MIT\n");

  return { burstDir, xmldomDir, tomlDir };
}

describe("Source-built resource preparation for Loom", () => {
  let testScratch;

  beforeEach(async () => {
    testScratch = await mkdtemp(join(tmpdir(), "source-loom-test-"));
  });

  afterEach(async () => {
    if (testScratch) {
      await rm(testScratch, { recursive: true, force: true });
    }
  });

  test("prepareLoom consumes explicit source-built root with catalog evidence verification", async () => {
    const studioDir = join(testScratch, "studio");
    await createMockStudioRoot(studioDir);

    const loomPackageRoot = join(testScratch, "source-loom");
    await createMockSourceLoomPackage(loomPackageRoot);

    const receipt = await prepareLoom({
      studioRoot: studioDir,
      packageRoot: loomPackageRoot,
      release: true,
    });

    assert.equal(receipt.schema, "tfsb.loom-payload-receipt-v1");
    assert.equal(receipt.sourceType, "source-built");
    assert.equal(receipt.name, EXPECTED_LOOM_NAME);
    assert.equal(receipt.version, EXPECTED_LOOM_VERSION);
    assert.ok(receipt.catalogEvidence);

    // Payload verification
    const payloadDist = join(studioDir, "src-tauri/loom-payload/dist");
    assert.ok(existsSync(join(payloadDist, "batch.js")));
    assert.ok(existsSync(join(payloadDist, "catalog-build-evidence.json")));
    assert.ok(existsSync(join(studioDir, "src-tauri/loom-payload/bin/tfsl-batch.js")));
    assert.ok(existsSync(join(studioDir, "src-tauri/loom-payload/package.json")));

    // Preview verification (uses studio-owned loom-preview-source)
    const previewHtml = join(studioDir, "public/preview/index.html");
    assert.ok(existsSync(previewHtml));
    const content = await readFile(previewHtml, "utf8");
    assert.ok(content.includes("Neutral Preview"));
  });

  test("prepareLoom consumes explicit source-built root in nested Nix layout", async () => {
    const studioDir = join(testScratch, "studio");
    await createMockStudioRoot(studioDir);

    const nixRoot = join(testScratch, "nix-out");
    const nestedPkg = join(nixRoot, "lib/node_modules/@knowledge-forge-ai/theme-forge-stellar-loom");
    await createMockSourceLoomPackage(nestedPkg);

    const receipt = await prepareLoom({
      studioRoot: studioDir,
      packageRoot: nixRoot,
      release: true,
    });

    assert.equal(receipt.sourceType, "source-built");
    assert.equal(receipt.name, EXPECTED_LOOM_NAME);
  });

  test("prepareLoom rejects missing packageRoot", async () => {
    const studioDir = join(testScratch, "studio");
    await createMockStudioRoot(studioDir);

    await assert.rejects(
      () => prepareLoom({
        studioRoot: studioDir,
        packageRoot: join(testScratch, "nonexistent-loom"),
        release: true,
      }),
      /\[LOOM_PREPARE_FAIL\] Missing package\.json in Loom package root/
    );
  });

  test("prepareLoom rejects packageRoot with missing or tampered catalog evidence", async () => {
    const studioDir = join(testScratch, "studio");
    await createMockStudioRoot(studioDir);

    const loomPackageRoot = join(testScratch, "tampered-loom");
    await createMockSourceLoomPackage(loomPackageRoot);

    // Tamper with one member file
    await writeFile(join(loomPackageRoot, "dist/batch.js"), "// corrupted content\n");

    await assert.rejects(
      () => prepareLoom({
        studioRoot: studioDir,
        packageRoot: loomPackageRoot,
        release: true,
      }),
      /Loom package catalog member (?:digest|size) mismatch/
    );
  });

  test("prepareLoom rejects when studio-owned loom-preview-source is missing", async () => {
    const studioDir = join(testScratch, "studio-no-preview");
    await mkdir(studioDir, { recursive: true });

    const loomPackageRoot = join(testScratch, "source-loom");
    await createMockSourceLoomPackage(loomPackageRoot);

    await assert.rejects(
      () => prepareLoom({
        studioRoot: studioDir,
        packageRoot: loomPackageRoot,
        release: true,
      }),
      /\[LOOM_PREPARE_FAIL\] Missing required studio-owned loom-preview-source/
    );
  });
});

describe("Source-built resource preparation for Solar Sail", () => {
  let testScratch;

  beforeEach(async () => {
    testScratch = await mkdtemp(join(tmpdir(), "source-solar-test-"));
  });

  afterEach(async () => {
    if (testScratch) {
      await rm(testScratch, { recursive: true, force: true });
    }
  });

  test("prepareSolarSail consumes explicit source-built root without historical compiled digest expectation", async () => {
    const studioDir = join(testScratch, "studio");
    await mkdir(studioDir, { recursive: true });

    const solarPackageRoot = join(testScratch, "source-solar");
    await createMockSourceSolarSailPackage(solarPackageRoot);

    const binding = await prepareSolarSail({
      studioRoot: studioDir,
      packageRoot: solarPackageRoot,
      release: true,
    });

    assert.equal(binding.schema, "tfsb.solar-sail-binding-v1");
    assert.equal(binding.name, EXPECTED_SOLAR_SAIL_NAME);
    assert.equal(binding.version, EXPECTED_SOLAR_SAIL_VERSION);
    assert.equal(binding.runtimeMemberCount, 8);

    // Verify it did NOT require historical EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST
    assert.notEqual(binding.inventoryDigest, EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST);

    // Payload verification
    const payloadDir = join(studioDir, "src-tauri/solar-sail-payload");
    assert.ok(existsSync(join(payloadDir, "dist/index.js")));
    assert.ok(existsSync(join(payloadDir, "dist/compiler.js")));
    assert.ok(existsSync(join(payloadDir, "package.json")));
    assert.ok(existsSync(join(payloadDir, "solar-sail-binding.json")));
  });

  test("prepareSolarSail consumes explicit source-built root in nested Nix layout", async () => {
    const studioDir = join(testScratch, "studio");
    await mkdir(studioDir, { recursive: true });

    const nixRoot = join(testScratch, "nix-solar");
    const nested = join(nixRoot, "lib/node_modules/@knowledge-forge-ai/theme-forge-solar-sail");
    await createMockSourceSolarSailPackage(nested);

    const binding = await prepareSolarSail({
      studioRoot: studioDir,
      packageRoot: nixRoot,
      release: true,
    });

    assert.equal(binding.name, EXPECTED_SOLAR_SAIL_NAME);
  });

  test("prepareSolarSail rejects missing packageRoot", async () => {
    const studioDir = join(testScratch, "studio");
    await mkdir(studioDir, { recursive: true });

    await assert.rejects(
      () => prepareSolarSail({
        studioRoot: studioDir,
        packageRoot: join(testScratch, "nonexistent-solar"),
        release: true,
      }),
      /\[SOLAR_SAIL_PREPARE_FAIL\] Missing package\.json in Solar Sail package root/
    );
  });

  test("prepareSolarSail rejects source-built root with missing runtime member", async () => {
    const studioDir = join(testScratch, "broken-solar");
    await createMockSourceSolarSailPackage(studioDir);
    await rm(join(studioDir, "dist/compiler.js"));

    await assert.rejects(
      () => prepareSolarSail({
        studioRoot: studioDir,
        packageRoot: studioDir,
        release: true,
      }),
      /\[SOLAR_SAIL_BINDING_FAIL\] Missing required runtime member: dist\/compiler\.js/
    );
  });

  test("prepareSolarSail rejects source-built root with missing declaration member", async () => {
    const studioDir = join(testScratch, "broken-decl-solar");
    await createMockSourceSolarSailPackage(studioDir);
    await rm(join(studioDir, "dist/compiler.d.ts"));

    await assert.rejects(
      () => prepareSolarSail({
        studioRoot: studioDir,
        packageRoot: studioDir,
        release: true,
      }),
      /\[SOLAR_SAIL_BINDING_FAIL\] Missing required declaration member: dist\/compiler\.d\.ts/
    );
  });

  test("prepareSolarSail legacy path still enforces historical inventory digest", async () => {
    const studioDir = join(testScratch, "studio");
    await mkdir(studioDir, { recursive: true });

    const fakeTarball = join(testScratch, "fake.tgz");
    await writeFile(fakeTarball, "corrupted");

    await assert.rejects(
      () => prepareSolarSail({
        studioRoot: studioDir,
        tarball: fakeTarball,
      }),
      /\[SOLAR_SAIL_PREPARE_FAIL\] Failed to inspect tarball/
    );
  });
});

describe("Source-built resource preparation for Scene", () => {
  let testScratch;

  beforeEach(async () => {
    testScratch = await mkdtemp(join(tmpdir(), "source-scene-test-"));
  });

  afterEach(async () => {
    if (testScratch) {
      await rm(testScratch, { recursive: true, force: true });
    }
  });

  test("prepareSceneFromSource derives payload from explicit compiled Burst and dependencies using SCENE_MEMBERS", async () => {
    const { burstDir, xmldomDir, tomlDir } = await createMockBurstAndDependencies(testScratch);
    const destination = join(testScratch, "dest-scene-payload");

    const binding = await prepareSceneFromSource({
      sourceIdentity: "a".repeat(64),
      studioRoot: STUDIO_ROOT,
      burstRoot: burstDir,
      node: AUTH_NODE_PATH,
      destination,
      xmldomRoot: xmldomDir,
      tomlRoot: tomlDir,
    });

    assert.equal(binding.schema, "tfsb.nebular-scene-binding-v1");
    assert.equal(binding.engineSchema, "tfsb.vector-scene-v1");
    assert.equal(binding.capability, "0.5-development");
    assert.equal(binding.sourceIdentity, "a".repeat(64));
    assert.ok(binding.runtime.sha256);
    assert.ok(binding.runtime.bytes > 0);
    assert.ok(Array.isArray(binding.inventory));

    // Destination contents verification
    assert.ok(existsSync(join(destination, "bin/scene-batch.js")));
    assert.ok(existsSync(join(destination, "package.json")));
    assert.ok(existsSync(join(destination, "scene-input.json")));

    const burstTargetDist = join(destination, "node_modules/@knowledge-forge-ai/theme-forge-stellar-burst/dist");
    // Verify all 21 SCENE_MEMBERS exist
    for (const member of SCENE_MEMBERS) {
      assert.ok(existsSync(join(burstTargetDist, `${member}.js`)), `Missing member ${member}`);
    }
    // Verify non-scene member was NOT copied
    assert.equal(existsSync(join(burstTargetDist, "unrelated-burst-file.js")), false);

    // Verify dependencies copied
    assert.ok(existsSync(join(destination, "node_modules/@xmldom/xmldom/package.json")));
    assert.ok(existsSync(join(destination, "node_modules/smol-toml/package.json")));

    // Verify verification passes with returned binding
    const receipt = await verifyScenePayload(destination, AUTH_NODE_PATH, binding);
    assert.equal(receipt.schema, "tfsb.scene-payload-receipt-v1");
    assert.equal(receipt.files, binding.files.length);
    const relocated = join(testScratch, "relocated-burst");
    await cp(burstDir, relocated, { recursive: true });
    const relocatedBinding = await prepareSceneFromSource({
      sourceIdentity: "a".repeat(64), studioRoot: STUDIO_ROOT, burstRoot: relocated,
      node: AUTH_NODE_PATH, destination: join(testScratch, "second-payload"),
      xmldomRoot: xmldomDir, tomlRoot: tomlDir,
    });
    assert.deepEqual(relocatedBinding, binding, "Scene identity must exclude execution paths and timestamps");
    assert.ok(!JSON.stringify(binding).includes(testScratch));
  });

  test("prepareSceneFromSource derives payload from nested Nix Burst layout", async () => {
    const { burstDir, xmldomDir, tomlDir } = await createMockBurstAndDependencies(testScratch);
    const nixRoot = join(testScratch, "nix-burst-root");
    const nested = join(nixRoot, "lib/node_modules/@knowledge-forge-ai/theme-forge-stellar-burst");
    await cp(burstDir, nested, { recursive: true });

    const destination = join(testScratch, "dest-nix-scene");

    const binding = await prepareSceneFromSource({
      sourceIdentity: "a".repeat(64),
      studioRoot: STUDIO_ROOT,
      burstRoot: nixRoot,
      node: AUTH_NODE_PATH,
      destination,
      xmldomRoot: xmldomDir,
      tomlRoot: tomlDir,
    });

    assert.equal(binding.schema, "tfsb.nebular-scene-binding-v1");
    assert.ok(existsSync(join(destination, "node_modules/@knowledge-forge-ai/theme-forge-stellar-burst/dist/scene/index.js")));
  });

  test("prepareSceneFromSource rejects missing burstRoot", async () => {
    await assert.rejects(
      () => prepareSceneFromSource({
      sourceIdentity: "a".repeat(64),
        studioRoot: STUDIO_ROOT,
        burstRoot: join(testScratch, "nonexistent-burst"),
        node: AUTH_NODE_PATH,
      }),
      /\[SCENE_PREPARE_FAIL\] Missing package\.json in Burst root/
    );
  });

  test("prepareSceneFromSource rejects burstRoot missing a SCENE_MEMBERS file", async () => {
    const { burstDir, xmldomDir, tomlDir } = await createMockBurstAndDependencies(testScratch);
    await rm(join(burstDir, "dist/scene/compile.js"));

    await assert.rejects(
      () => prepareSceneFromSource({
      sourceIdentity: "a".repeat(64),
        studioRoot: STUDIO_ROOT,
        burstRoot: burstDir,
        node: AUTH_NODE_PATH,
        destination: join(testScratch, "dest"),
        xmldomRoot: xmldomDir,
        tomlRoot: tomlDir,
      }),
      /\[SCENE_PREPARE_FAIL\] Burst dist missing required scene member: dist\/scene\/compile\.js/
    );
  });

  test("prepareSceneFromSource rejects missing Node binary", async () => {
    const { burstDir, xmldomDir, tomlDir } = await createMockBurstAndDependencies(testScratch);

    await assert.rejects(
      () => prepareSceneFromSource({
      sourceIdentity: "a".repeat(64),
        studioRoot: STUDIO_ROOT,
        burstRoot: burstDir,
        node: join(testScratch, "nonexistent-node"),
        destination: join(testScratch, "dest"),
        xmldomRoot: xmldomDir,
        tomlRoot: tomlDir,
      }),
      /\[SCENE_PREPARE_FAIL\] Explicit Node runtime binary does not exist/
    );
  });

  test("prepareSceneFromSource rejects missing dependencies", async () => {
    const { burstDir } = await createMockBurstAndDependencies(testScratch);

    await assert.rejects(
      () => prepareSceneFromSource({
      sourceIdentity: "a".repeat(64),
        studioRoot: STUDIO_ROOT,
        burstRoot: burstDir,
        node: AUTH_NODE_PATH,
        destination: join(testScratch, "dest"),
        xmldomRoot: join(testScratch, "missing-xmldom"),
        tomlRoot: join(testScratch, "missing-toml"),
      }),
      /\[SCENE_PREPARE_FAIL\] Missing required dependency root/
    );
  });

  test("prepareSceneFromSource rejects closure with forbidden execution facilities", async () => {
    const { burstDir, xmldomDir, tomlDir } = await createMockBurstAndDependencies(testScratch);
    // Inject forbidden facility into a member
    await writeFile(join(burstDir, "dist/scene/index.js"), 'import("node:fs");\n');

    await assert.rejects(
      () => prepareSceneFromSource({
      sourceIdentity: "a".repeat(64),
        studioRoot: STUDIO_ROOT,
        burstRoot: burstDir,
        node: AUTH_NODE_PATH,
        destination: join(testScratch, "dest"),
        xmldomRoot: xmldomDir,
        tomlRoot: tomlDir,
      }),
      /\[SCENE_PREPARE_FAIL\] Scene closure contains unsupported execution facility/
    );
  });

  test("legacy prepareScenePayload and verifyScenePayload interface is preserved", async () => {
    const archivePath = join(testScratch, "legacy-scene.tgz");
    execFileSync("python3", ["-c", String.raw`
import gzip, pathlib, sys, tarfile, shutil, tempfile
src = pathlib.Path(sys.argv[1])
out_path = pathlib.Path(sys.argv[2])
with tempfile.TemporaryDirectory() as tmp:
    staging = pathlib.Path(tmp) / "tree"
    staging.mkdir()
    for f in sorted(x for x in src.rglob("*") if x.is_file()):
        rel = f.relative_to(src).as_posix()
        if rel.startswith("bin/") or rel == "package.json":
            continue
        dest = staging / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dest)
    with open(out_path, "xb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=1704067200) as gz, tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as t:
        for p in sorted(x for x in staging.rglob("*") if x.is_file()):
            i = tarfile.TarInfo(p.relative_to(staging).as_posix())
            i.size = p.stat().st_size
            i.mode = 0o644
            i.mtime = 1704067200
            with p.open("rb") as f:
                t.addfile(i, f)
`, SCENE_PAYLOAD_SRC, archivePath], { stdio: "pipe", timeout: 15_000 });

    const dest = join(testScratch, "legacy-scene-dest");
    const receipt = await prepareScenePayload({
      archive: archivePath,
      node: AUTH_NODE_PATH,
      destination: dest,
    });
    assert.equal(receipt.schema, "tfsb.scene-payload-receipt-v1");
    assert.equal(receipt.capability, "0.5-development");

    const verified = await verifyScenePayload(dest, AUTH_NODE_PATH);
    assert.equal(verified.schema, "tfsb.scene-payload-receipt-v1");
  });
});
