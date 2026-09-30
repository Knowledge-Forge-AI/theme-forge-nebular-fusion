// @ts-check
import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareAppResources,
  resolveSceneArchive,
  resolveNodeBinary,
  resolveRuntimeNodePaths,
  assembleSourceBuildPins,
  parseArgs,
  PREPARATION_STEPS,
} from "./prepare-app-resources.mjs";

import { digest, inventoryTree, seal, sourceResourcePlans } from "./candidate-provenance.mjs";
import { TARGETS, CANDIDATE_VERSION } from "./platform-targets.mjs";
import { createBuildSettings } from "./build-settings.mjs";
import { validateBuildInputs } from "./build-inputs.mjs";
import { EXPECTED_EXECUTABLE_SHA256, EXPECTED_NODE_VERSION, EXPECTED_V8_VERSION } from "./node-runtime-authority.mjs";

import {
  EXPECTED_SOLAR_SAIL_NAME,
  EXPECTED_SOLAR_SAIL_VERSION,
  EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST,
  prepareSolarSail,
  authenticateSolarSailCandidate,
} from "./solar-sail-prepare.mjs";

import {
  prepareScenePayload,
  verifyScenePayload,
  sceneBinding,
} from "./scene-prepare.mjs";

import { preparationOptions, repositoryRootForStudio } from "./sidecar-common.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STUDIO_ROOT = resolve(__dirname, "..");
const REPO_ROOT = repositoryRootForStudio(STUDIO_ROOT);
const AUTH_NODE_PATH = resolve(STUDIO_ROOT, "src-tauri/binaries/tfsb-studio-service-aarch64-apple-darwin");
const SCENE_PAYLOAD_SRC = resolve(STUDIO_ROOT, "src-tauri/scene-payload");

function findSolarSailTarball() {
  const authDir = join(REPO_ROOT, "authenticated-inputs/solar-sail-tarball");
  if (existsSync(authDir)) {
    const files = readdirSync(authDir).filter((f) => f.endsWith(".tgz"));
    if (files.length > 0) return resolve(authDir, files[0]);
  }
  const outboxDir = join(REPO_ROOT, ".outbox");
  if (existsSync(outboxDir)) {
    const candidate020 = join(outboxDir, "tfsb71p5b-component-binding-checkpoint2/artifacts/knowledge-forge-ai-theme-forge-solar-sail-0.2.0.tgz");
    if (existsSync(candidate020)) return candidate020;
    const candidate = join(outboxDir, "knowledge-forge-ai-theme-forge-solar-sail-0.1.0.tgz");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("No authentic Solar Sail tarball found for test fixture");
}

function buildDeterministicSceneArchive(targetTarPath) {
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
`, SCENE_PAYLOAD_SRC, targetTarPath], { stdio: "pipe", timeout: 15_000 });
}

describe("prepareAppResources prerequisite diagnostics and clean failure without preseed", () => {
  let fixtureDir;
  let savedEnv;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "res-prep-clean-"));
    savedEnv = { ...process.env };
    delete process.env.TFSB_STUDIO_SCENE_ARCHIVE;
    delete process.env.TFSB_STUDIO_SCENE_TARBALL;
    delete process.env.SCENE_ARCHIVE;
    delete process.env.SCENE_TGZ;
    delete process.env.TFSB_STUDIO_NODE_BINARY;
    delete process.env.TFSS_SOLAR_SAIL_TARBALL;
    delete process.env.TFSB_STUDIO_SOLAR_SAIL_TARBALL;
    delete process.env.TFSB_STUDIO_ROOT_TARBALL;
  });

  afterEach(async () => {
    process.env = savedEnv;
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("clean failure without preseed when sidecar inputs are missing", async () => {
    const fixtureStudio = join(fixtureDir, "studio");
    await mkdir(fixtureStudio, { recursive: true });
    assert.equal(existsSync(join(fixtureDir, ".git")), false);

    await assert.rejects(
      () => prepareAppResources({
        studioRoot: fixtureStudio,
        repositoryRoot: fixtureDir,
        skipLoom: true,
        skipSolar: true,
        skipScene: true,
        skipReleaseNotices: true,
      }),
      /Missing authenticated Node runtime/
    );
  });

  test("clean failure without preseed reporting exact missing Scene input", async () => {
    const fixtureStudio = join(fixtureDir, "studio");
    await mkdir(fixtureStudio, { recursive: true });
    assert.equal(existsSync(join(fixtureDir, ".git")), false);

    await assert.rejects(
      () => prepareAppResources({
        studioRoot: fixtureStudio,
        repositoryRoot: fixtureDir,
        skipSidecar: true,
        skipLoom: true,
        skipSolar: true,
        skipReleaseNotices: true,
      }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "[PREPARE_APP_RESOURCES_FAIL] Missing required Scene archive input: resolve via authenticated-inputs/stellar-binding.json or TFSB_STUDIO_SCENE_ARCHIVE"
        );
        return true;
      }
    );
  });

  test("rejects malformed stellar-binding.json without fabricating authority", () => {
    const authDir = join(fixtureDir, "authenticated-inputs");
    execFileSync("mkdir", ["-p", authDir]);
    writeFileSync(join(authDir, "stellar-binding.json"), "{ invalid json ");

    assert.throws(
      () => resolveSceneArchive({}, fixtureDir),
      /\[PREPARE_APP_RESOURCES_FAIL\] Malformed stellar-binding\.json at authenticated-inputs\/stellar-binding\.json/
    );
  });

  test("rejects stellar-binding.json specifying omitted-by-contract for mandatory Scene", async () => {
    const authDir = join(fixtureDir, "authenticated-inputs");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(authDir, "stellar-binding.json"),
      JSON.stringify({ scene: { status: "omitted-by-contract" } })
    );

    assert.throws(
      () => resolveSceneArchive({}, fixtureDir),
      /\[PREPARE_APP_RESOURCES_FAIL\] Scene archive omitted by contract in stellar-binding\.json, but Scene payload is required for app resources/
    );
  });

  test("rejects stellar-binding.json referencing a nonexistent archive file", async () => {
    const authDir = join(fixtureDir, "authenticated-inputs");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(authDir, "stellar-binding.json"),
      JSON.stringify({ scene: { ...sceneBinding, status: "included-authenticated", filename: "nonexistent-scene.tgz" } })
    );

    assert.throws(
      () => resolveSceneArchive({}, fixtureDir),
      /\[PREPARE_APP_RESOURCES_FAIL\] Missing required Scene archive input: resolve via authenticated-inputs\/stellar-binding.json or TFSB_STUDIO_SCENE_ARCHIVE/
    );
  });

  test("rejects nonexistent explicit Scene archive path with sanitized error", () => {
    assert.throws(
      () => resolveSceneArchive({ sceneArchive: "/tmp/custom-missing-scene.tgz" }, fixtureDir),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "[PREPARE_APP_RESOURCES_FAIL] Explicit Scene archive does not exist: custom-missing-scene.tgz"
        );
        // Ensure no absolute path leakage in error message
        assert.ok(!err.message.includes("/tmp/"));
        return true;
      }
    );
  });

  test("rejects when Scene archive is present but Node runtime binary is missing", async () => {
    const fixtureStudio = join(fixtureDir, "studio");
    const fakeArchive = join(fixtureDir, "scene.tgz");
    await writeFile(fakeArchive, "fake archive content");

    await assert.rejects(
      () => prepareAppResources({
        studioRoot: fixtureStudio,
        repositoryRoot: fixtureDir,
        sceneArchive: fakeArchive,
        steps: ["scene"],
      }),
      /\[PREPARE_APP_RESOURCES_FAIL\] Missing required Node runtime input: specify via --node or TFSB_STUDIO_NODE_BINARY/
    );
  });
});

describe("Input selection contracts for Scene and Node", () => {
  let fixtureDir;
  let savedEnv;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "res-prep-select-"));
    savedEnv = { ...process.env };
    delete process.env.TFSB_STUDIO_SCENE_ARCHIVE;
    delete process.env.TFSB_STUDIO_SCENE_TARBALL;
    delete process.env.SCENE_ARCHIVE;
    delete process.env.SCENE_TGZ;
    delete process.env.TFSB_STUDIO_NODE_BINARY;
  });

  afterEach(async () => {
    process.env = savedEnv;
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("resolves archive via explicit option (sceneArchive or sceneTarball)", async () => {
    const archivePath = join(fixtureDir, "explicit-scene.tgz");
    await writeFile(archivePath, "content");

    assert.equal(resolveSceneArchive({ sceneArchive: archivePath }, fixtureDir), archivePath);
    assert.equal(resolveSceneArchive({ sceneTarball: archivePath }, fixtureDir), archivePath);
    assert.equal(resolveSceneArchive({ "scene-archive": archivePath }, fixtureDir), archivePath);
  });

  test("resolves archive via environment variable when option is not provided", async () => {
    const archivePath = join(fixtureDir, "env-scene.tgz");
    await writeFile(archivePath, "content");

    process.env.TFSB_STUDIO_SCENE_ARCHIVE = archivePath;
    assert.equal(resolveSceneArchive({}, fixtureDir), archivePath);

    delete process.env.TFSB_STUDIO_SCENE_ARCHIVE;
    process.env.SCENE_TGZ = archivePath;
    assert.equal(resolveSceneArchive({}, fixtureDir), archivePath);
  });

  test("explicit option wins over environment variable and stellar-binding.json", async () => {
    const optArchive = join(fixtureDir, "opt-scene.tgz");
    const envArchive = join(fixtureDir, "env-scene.tgz");
    const bindingArchive = join(fixtureDir, "binding-scene.tgz");
    await writeFile(optArchive, "opt");
    await writeFile(envArchive, "env");
    await writeFile(bindingArchive, "binding");

    process.env.TFSB_STUDIO_SCENE_ARCHIVE = envArchive;

    const authDir = join(fixtureDir, "authenticated-inputs");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(authDir, "stellar-binding.json"),
      JSON.stringify({ scene: { filename: "binding-scene.tgz" } })
    );
    await cp(bindingArchive, join(authDir, "binding-scene.tgz"));

    // Option wins over env and binding
    assert.equal(resolveSceneArchive({ sceneArchive: optArchive }, fixtureDir), optArchive);

    // Without option, env wins over binding
    assert.equal(resolveSceneArchive({}, fixtureDir), envArchive);
  });

  test("resolves archive from stellar-binding.json in scene-tarball directory", async () => {
    const authDir = join(fixtureDir, "authenticated-inputs");
    const sceneTarballDir = join(authDir, "scene-tarball");
    await mkdir(sceneTarballDir, { recursive: true });

    const targetArchive = join(sceneTarballDir, "bound-scene.tgz");
    await writeFile(targetArchive, "content");
    await writeFile(
      join(authDir, "stellar-binding.json"),
      JSON.stringify({ scene: { ...sceneBinding, status: "included-authenticated", filename: "bound-scene.tgz" } })
    );

    assert.equal(resolveSceneArchive({}, fixtureDir), targetArchive);
  });

  test("resolves explicit Node and rejects checkout-resident preseed fallback", async () => {
    const optNode = join(fixtureDir, "opt-node");
    const envNode = join(fixtureDir, "env-node");
    await writeFile(optNode, "bin");
    await writeFile(envNode, "bin");

    // Option wins
    process.env.TFSB_STUDIO_NODE_BINARY = envNode;
    assert.equal(resolveNodeBinary({ node: optNode }, fixtureDir), optNode);

    // Env wins when option absent
    assert.equal(resolveNodeBinary({}, fixtureDir), envNode);

    // A previous build is not authority for the next build.
    delete process.env.TFSB_STUDIO_NODE_BINARY;
    const studioRoot = join(fixtureDir, "studio");
    const studioBin = join(studioRoot, "src-tauri/binaries/tfsb-studio-service-aarch64-apple-darwin");
    await mkdir(dirname(studioBin), { recursive: true });
    await writeFile(studioBin, "studio-bin");

    assert.equal(resolveNodeBinary({}, studioRoot), null);
  });
});

describe("Solar Sail explicit tarball resolution and single authority", () => {
  let fixtureDir;
  let savedEnv;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "res-prep-solar-"));
    savedEnv = { ...process.env };
    delete process.env.TFSS_SOLAR_SAIL_TARBALL;
    delete process.env.TFSB_STUDIO_SOLAR_SAIL_TARBALL;
  });

  afterEach(async () => {
    process.env = savedEnv;
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("explicit options tarball wins over monorepo rebuild and authenticates against approved digest", async () => {
    const authenticTarball = findSolarSailTarball();
    const fixturePayload = join(fixtureDir, "solar-sail-payload");
    const fixtureAdapter = join(fixtureDir, "solar-sail-adapter");

    const binding = await prepareSolarSail({
      studioRoot: STUDIO_ROOT,
      tarball: authenticTarball,
      payloadRoot: fixturePayload,
      adapterDir: fixtureAdapter,
    });

    assert.equal(binding.inventoryDigest, EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST);
    assert.equal(binding.version, EXPECTED_SOLAR_SAIL_VERSION);
    assert.equal(binding.name, EXPECTED_SOLAR_SAIL_NAME);
    assert.ok(existsSync(join(fixturePayload, "solar-sail-binding.json")));
    assert.ok(existsSync(join(fixturePayload, "dist/index.js")));
  });

  test("explicit env tarball (TFSS_SOLAR_SAIL_TARBALL) wins over monorepo rebuild", async () => {
    const authenticTarball = findSolarSailTarball();
    const fixturePayload = join(fixtureDir, "solar-sail-payload");
    const fixtureAdapter = join(fixtureDir, "solar-sail-adapter");

    process.env.TFSS_SOLAR_SAIL_TARBALL = authenticTarball;

    const binding = await prepareSolarSail({
      studioRoot: STUDIO_ROOT,
      payloadRoot: fixturePayload,
      adapterDir: fixtureAdapter,
    });

    assert.equal(binding.inventoryDigest, EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST);
    assert.ok(existsSync(join(fixturePayload, "solar-sail-binding.json")));
  });

  test("fails closed when explicit tarball does not exist", async () => {
    await assert.rejects(
      () => prepareSolarSail({ tarball: "/tmp/nonexistent-solar-sail.tgz" }),
      /\[SOLAR_SAIL_PREPARE_FAIL\] Explicit tarball not found/
    );
  });

  test("retains approved inventory digest and fails when digest mismatches", async () => {
    const mockPkgDir = join(fixtureDir, "mock-solar-pkg");
    await mkdir(join(mockPkgDir, "dist"), { recursive: true });
    await writeFile(
      join(mockPkgDir, "package.json"),
      JSON.stringify({ name: EXPECTED_SOLAR_SAIL_NAME, version: EXPECTED_SOLAR_SAIL_VERSION })
    );
    await writeFile(join(mockPkgDir, "dist/index.js"), "console.log('mock');");

    await assert.rejects(
      () => authenticateSolarSailCandidate(mockPkgDir, EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST),
      /\[SOLAR_SAIL_BINDING_FAIL\]/
    );
  });

  test("verify-nebular-bundle imports single authority without duplicated digest string", async () => {
    const verifierPath = resolve(REPO_ROOT, "tools/ci/verify-nebular-bundle.mjs");
    const verifierContent = await readFile(verifierPath, "utf8");

    // Single authority must be imported from solar-sail-prepare.mjs
    assert.ok(verifierContent.includes("EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST"));
    assert.ok(verifierContent.includes("solar-sail-prepare.mjs"));

    // The hardcoded literal digest must NOT appear duplicated in verify-nebular-bundle.mjs
    const literalDigestMatches = verifierContent.match(new RegExp(EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST, "g"));
    assert.equal(literalDigestMatches, null, "Literal Solar Sail digest string must not be duplicated in verify-nebular-bundle.mjs");
  });
});

describe("Scene payload preparation contract via maintained binding", () => {
  let fixtureDir;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "res-prep-scene-"));
  });

  afterEach(async () => {
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("prepares and verifies Scene payload using maintained sceneBinding into fixture destination", async () => {
    const sceneArchive = join(fixtureDir, "scene-input.tgz");
    buildDeterministicSceneArchive(sceneArchive);

    const fixturePayload = join(fixtureDir, "scene-payload");

    const receipt = await prepareScenePayload({
      archive: sceneArchive,
      node: AUTH_NODE_PATH,
      destination: fixturePayload,
      binding: sceneBinding,
    });

    assert.equal(receipt.schema, "tfsb.scene-payload-receipt-v1");
    assert.equal(receipt.inputSha256, sceneBinding.sha256);
    assert.equal(receipt.capability, "0.5-development");
    assert.ok(existsSync(join(fixturePayload, "bin/scene-batch.js")));
    assert.ok(existsSync(join(fixturePayload, "package.json")));

    // Verify through verifier
    const verified = await verifyScenePayload(fixturePayload, AUTH_NODE_PATH, sceneBinding);
    assert.equal(verified.schema, "tfsb.scene-payload-receipt-v1");
  });

  test("rejects tampered Scene archive digest or size", async () => {
    const tamperedArchive = join(fixtureDir, "tampered-scene.tgz");
    await writeFile(tamperedArchive, "tampered content");

    await assert.rejects(
      () => prepareScenePayload({
        archive: tamperedArchive,
        node: AUTH_NODE_PATH,
        destination: join(fixtureDir, "tampered-payload"),
        binding: sceneBinding,
      }),
      /Scene archive identity mismatch/
    );
  });

  test("rejects tampered Node binary", async () => {
    const sceneArchive = join(fixtureDir, "scene-input.tgz");
    buildDeterministicSceneArchive(sceneArchive);

    const fakeNode = join(fixtureDir, "fake-node");
    await writeFile(fakeNode, "fake node binary bytes");

    await assert.rejects(
      () => prepareScenePayload({
        archive: sceneArchive,
        node: fakeNode,
        destination: join(fixtureDir, "tampered-node-payload"),
        binding: sceneBinding,
      }),
      /Scene Node identity mismatch/
    );
  });
});

describe("prepareAppResources orchestrator integration and CLI parsing", () => {
  let fixtureDir;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "res-prep-orch-"));
  });

  afterEach(async () => {
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("parses CLI arguments correctly", () => {
    const parsed = parseArgs([
      "--studio-root", "/path/to/studio",
      "--repository-root", "/path/to/repo",
      "--node", "/path/to/node",
      "--root-tarball", "/path/to/root.tgz",
      "--loom-tarball", "/path/to/loom.tgz",
      "--loom-sha256", "abc",
      "--solar-tarball", "/path/to/solar.tgz",
      "--scene-archive", "/path/to/scene.tgz",
      "--scene-sha256", "def",
      "--release-notices-out-dir", "/path/to/notices",
      "--step", "solar",
      "--step", "scene",
      "--release",
    ]);

    assert.equal(parsed.studioRoot, "/path/to/studio");
    assert.equal(parsed.repositoryRoot, "/path/to/repo");
    assert.equal(parsed.nodePath, "/path/to/node");
    assert.equal(parsed.rootTarball, "/path/to/root.tgz");
    assert.equal(parsed.loomTarball, "/path/to/loom.tgz");
    assert.equal(parsed.loomSha256, "abc");
    assert.equal(parsed.solarTarball, "/path/to/solar.tgz");
    assert.equal(parsed.sceneArchive, "/path/to/scene.tgz");
    assert.equal(parsed.sceneSha256, "def");
    assert.equal(parsed.releaseNoticesOutDir, "/path/to/notices");
    assert.deepEqual(parsed.steps, ["solar", "scene"]);
    assert.equal(parsed.release, true);
  });

  test("parseArgs rejects unknown options", () => {
    assert.throws(
      () => parseArgs(["--unknown-flag"]),
      /\[PREPARE_APP_RESOURCES_FAIL\] Unknown option: --unknown-flag/
    );
  });

  test("runs configured steps and returns receipt without touching existing generated payloads", async () => {
    const sceneArchive = join(fixtureDir, "scene.tgz");
    buildDeterministicSceneArchive(sceneArchive);
    const authenticSolarTarball = findSolarSailTarball();

    const fixtureStudio = join(fixtureDir, "studio");
    const fixtureSolarPayload = join(fixtureDir, "fixture-solar-payload");
    const fixtureSolarAdapter = join(fixtureDir, "fixture-solar-adapter");
    const fixtureScenePayload = join(fixtureDir, "fixture-scene-payload");

    const receipt = await prepareAppResources({
      studioRoot: fixtureStudio,
      repositoryRoot: fixtureDir,
      steps: ["solar", "scene"],
      solarTarball: authenticSolarTarball,
      solarSailPayload: fixtureSolarPayload,
      solarSailAdapter: fixtureSolarAdapter,
      sceneArchive: sceneArchive,
      scenePayload: fixtureScenePayload,
      node: AUTH_NODE_PATH,
    });

    assert.equal(receipt.schema, "tfsb.prepared-app-resources-v1");
    assert.equal(receipt.status, "partial");
    assert.ok(receipt.receipts.solarSail);
    assert.equal(receipt.receipts.solarSail.inventoryDigest, EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST);
    assert.ok(receipt.receipts.scene);
    assert.equal(receipt.receipts.scene.schema, "tfsb.scene-payload-receipt-v1");

    assert.ok(existsSync(join(fixtureSolarPayload, "solar-sail-binding.json")));
    assert.ok(existsSync(join(fixtureScenePayload, "bin/scene-batch.js")));
  });
});

describe("Declared build inputs resource preparation and TDZ regression", () => {
  let savedEnv;
  let fixtureDir;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    delete process.env.NEBULAR_BUILD_INPUTS;
    delete process.env.NEBULAR_BUILD_MODE;
    const tempBase = realpathSync(resolve(tmpdir()));
    fixtureDir = await mkdtemp(join(tempBase, "declared-prep-reg-"));
  });

  afterEach(async () => {
    process.env = savedEnv;
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  async function createDeclaredFixture(target = TARGETS[0], mode = "nix-source", embeddedNodePath = null) {
    const studioRoot = join(fixtureDir, "studio");
    await mkdir(join(studioRoot, "legal"), { recursive: true });
    await cp(join(REPO_ROOT, "apps/studio/legal/node-LICENSE.txt"), join(studioRoot, "legal/node-LICENSE.txt"));
    await mkdir(join(studioRoot, "src-tauri"), { recursive: true });
    await writeFile(join(studioRoot, "package.json"), JSON.stringify({ name: "theme-forge-nebular-fusion", version: CANDIDATE_VERSION }));

    const sourceRoot = join(fixtureDir, "source");
    await mkdir(join(sourceRoot, "src-tauri"), { recursive: true });
    await writeFile(join(sourceRoot, "src-tauri/Cargo.lock"), "cargo");
    await writeFile(join(sourceRoot, "package-lock.json"), "frontend");
    const config = JSON.parse(await readFile(join(STUDIO_ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    const h = digest("fixture");
    const source = seal("nebular-source-candidate-v1", {
      version: CANDIDATE_VERSION,
      composition: (await inventoryTree(sourceRoot)).identity,
      locks: { cargo: digest("cargo"), frontend: digest("frontend") },
      components: { burst: h, loom: h, solar: h },
      recipe: h,
      resourcePlans: sourceResourcePlans(config),
    });

    const burstRoot = join(fixtureDir, "burst");
    await mkdir(burstRoot, { recursive: true });
    await writeFile(join(burstRoot, "package.json"), JSON.stringify({ name: "@knowledge-forge-ai/theme-forge-stellar-burst", version: CANDIDATE_VERSION, type: "module" }));
    await mkdir(join(burstRoot, "dist/service-protocol"), { recursive: true });
    await cp(join(REPO_ROOT, "dist/service-protocol/server-cli.js"), join(burstRoot, "dist/service-protocol/server-cli.js"));
    for (const pkg of ["@xmldom/xmldom", "fflate", "smol-toml"]) {
      await cp(join(REPO_ROOT, "node_modules", pkg), join(burstRoot, "node_modules", pkg), { recursive: true });
    }
    await cp(join(REPO_ROOT, "native/directory-snapshot/prebuilds", target.addon), join(burstRoot, "native/directory-snapshot/prebuilds", target.addon), { recursive: true });
    await cp(join(REPO_ROOT, "protocol/tfsb-studio-v1"), join(burstRoot, "protocol/tfsb-studio-v1"), { recursive: true });
    for (const legal of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md"]) {
      await cp(join(REPO_ROOT, legal), join(burstRoot, legal));
    }
    const rasterDest = join(burstRoot, "packages/tfsb-raster-resvg");
    await mkdir(rasterDest, { recursive: true });
    const realRaster = join(REPO_ROOT, "packages/tfsb-raster-resvg");
    for (const file of ["package.json", "index.js", "index.d.ts", "LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "MPL-2.0.txt", "THIRD_PARTY_NOTICES.md"]) {
      await cp(join(realRaster, file), join(rasterDest, file));
    }
    await cp(join(realRaster, "node_modules/@resvg/resvg-wasm"), join(rasterDest, "node_modules/@resvg/resvg-wasm"), { recursive: true });

    const components = {
      burst: { root: burstRoot, version: CANDIDATE_VERSION, source: h, target: target.triple, producer: h, output: (await inventoryTree(burstRoot)).identity },
    };
    for (const [name, product] of [["loom", "stellar-loom"], ["solar", "solar-sail"]]) {
      const p = join(fixtureDir, name);
      await mkdir(p);
      await writeFile(join(p, "package.json"), JSON.stringify({ name: `@knowledge-forge-ai/theme-forge-${product}`, version: CANDIDATE_VERSION }));
      components[name] = { root: p, version: CANDIDATE_VERSION, source: h, target: target.triple, producer: h, output: (await inventoryTree(p)).identity };
    }

    const nodeStub = join(fixtureDir, "node-stub");
    const nodePayload = JSON.stringify({ node: EXPECTED_NODE_VERSION, v8: EXPECTED_V8_VERSION, arch: target.cpu, platform: target.os });
    await writeFile(nodeStub, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo '${nodePayload}'; exit 0; fi\necho 'node stub'\n`, { mode: 0o755 });

    let embeddedPath = embeddedNodePath;
    if (!embeddedPath) {
      embeddedPath = join(fixtureDir, "embedded-node-stub");
      const embeddedPayload = JSON.stringify({ node: EXPECTED_NODE_VERSION, v8: EXPECTED_V8_VERSION, arch: target.cpu, platform: target.os });
      await writeFile(embeddedPath, `#!/bin/sh\n# distinct embedded runtime bytes\nif [ "$1" = "-p" ]; then echo '${embeddedPayload}'; exit 0; fi\necho 'embedded stub'\n`, { mode: 0o755 });
    }

    const toolchains = {
      node: { path: nodeStub, identity: digest(await readFile(nodeStub)) },
      npm: { path: nodeStub, identity: digest(await readFile(nodeStub)) },
      rust: { path: nodeStub, identity: digest(await readFile(nodeStub)) },
      cargo: { path: nodeStub, identity: digest(await readFile(nodeStub)) },
      compiler: { path: nodeStub, identity: digest(await readFile(nodeStub)) },
      linker: { path: nodeStub, identity: digest(await readFile(nodeStub)) },
      pkgConfig: { path: nodeStub, identity: digest(await readFile(nodeStub)) },
      systemLibraries: { path: fixtureDir, identity: (await inventoryTree(fixtureDir)).identity },
    };

    const settings = await createBuildSettings({});
    const buildInputs = {
      schema: "nebular-build-inputs-v1",
      sourceRoot,
      source,
      target: target.triple,
      mode,
      components,
      toolchains,
      embeddedRuntime: { path: embeddedPath, identity: digest(await readFile(embeddedPath)) },
      settings,
    };

    return { studioRoot, buildInputs, nodeStub, embeddedPath };
  }

  test("declared-build-input path initializes receipts and propagates explicit runtime and native authority", async () => {
    const { studioRoot, buildInputs, nodeStub, embeddedPath } = await createDeclaredFixture(TARGETS[0], "nix-source");
    let observed;
    await assert.rejects(prepareAppResources({ buildInputs, studioRoot, _testOverrides: {
      prepareSidecar: async options => { observed = options; return {}; },
      prepareLoom: async () => { throw new Error("Loom reached after sidecar receipt assignment"); },
    } }), /Loom reached/);
    assert.ok(observed);
    assert.notEqual(embeddedPath, nodeStub);
    assert.equal(observed.nodePath, embeddedPath);
    assert.equal(observed.mode, "nix-source");
    assert.equal(observed.buildInputs, buildInputs);
    assert.equal(observed.sourceIdentity, buildInputs.source.identity);
  });

  test("Darwin portable-source declared path enforces explicit embeddedRuntime before sidecar preparation", async () => {
    const { studioRoot, buildInputs } = await createDeclaredFixture(TARGETS[0], "portable-source");
    delete buildInputs.embeddedRuntime;

    await assert.rejects(
      () => prepareAppResources({ buildInputs, studioRoot }),
      /Darwin portable-source preparation requires explicit embeddedRuntime build input/
    );
  });

  test("Darwin portable-source declared path successfully validates authentic embedded Node runtime and advances past sidecar receipt assignment", async () => {
    const authNode = resolve(REPO_ROOT, ".outbox/authenticated-inputs/node");
    if (!existsSync(authNode)) {
      return; // Skip if authentic cached Darwin Node runtime is not present
    }

    const { studioRoot, buildInputs } = await createDeclaredFixture(TARGETS[0], "portable-source", authNode);

    let caughtErr = null;
    try {
      await prepareAppResources({ buildInputs, studioRoot });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "Expected execution to reach downstream Loom step");
    assert.notEqual(caughtErr.name, "ReferenceError");
    assert.ok(!caughtErr.message.includes("Cannot access 'receipts' before initialization"));
    assert.ok(caughtErr.message.includes("LOOM") || caughtErr.message.includes("Loom"));

    const manifestPath = join(studioRoot, "src-tauri/sidecar-payload/manifest.json");
    assert.ok(existsSync(manifestPath), "Sidecar manifest must be produced");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.runtime.sha256, EXPECTED_EXECUTABLE_SHA256);
  });

  test("declared build inputs rejects partial execution flags without running partial plan", async () => {
    const { studioRoot, buildInputs } = await createDeclaredFixture();
    await assert.rejects(
      () => prepareAppResources({ buildInputs, studioRoot, steps: ["sidecar"] }),
      /Source-build preparation requires the complete resource plan/
    );
    await assert.rejects(
      () => prepareAppResources({ buildInputs, studioRoot, skipLoom: true }),
      /Source-build preparation requires the complete resource plan/
    );
  });

  describe("Mandatory distinct-runtime regression and source-build pin invariant", () => {
    test("resolveRuntimeNodePaths correctly differentiates buildTimeNodePath vs packagedRuntimeNodePath across targets and modes", () => {
      // 1. Darwin portable-source with embeddedRuntime
      const darwinPortable = {
        inputs: { mode: "portable-source" },
        target: { os: "darwin", triple: "aarch64-apple-darwin" },
        tools: { node: "/tools/nodeA", embeddedRuntime: "/tools/nodeB" },
      };
      const res1 = resolveRuntimeNodePaths(darwinPortable);
      assert.equal(res1.buildTimeNodePath, "/tools/nodeA");
      assert.equal(res1.packagedRuntimeNodePath, "/tools/nodeB");

      // 2. Darwin portable-source without embeddedRuntime rejects
      const darwinNoEmbedded = {
        inputs: { mode: "portable-source" },
        target: { os: "darwin", triple: "aarch64-apple-darwin" },
        tools: { node: "/tools/nodeA" },
      };
      assert.throws(
        () => resolveRuntimeNodePaths(darwinNoEmbedded),
        /Darwin portable-source preparation requires explicit embeddedRuntime build input/
      );

      // 3. Darwin nix-source without embeddedRuntime
      const darwinNix = {
        inputs: { mode: "nix-source" },
        target: { os: "darwin", triple: "aarch64-apple-darwin" },
        tools: { node: "/tools/nodeA" },
      };
      const res3 = resolveRuntimeNodePaths(darwinNix);
      assert.equal(res3.buildTimeNodePath, "/tools/nodeA");
      assert.equal(res3.packagedRuntimeNodePath, "/tools/nodeA");

      // 4. Linux portable-source with embeddedRuntime
      const linuxPortableWithEmbedded = {
        inputs: { mode: "portable-source" },
        target: { os: "linux", triple: "aarch64-unknown-linux-gnu" },
        tools: { node: "/tools/nodeA", embeddedRuntime: "/tools/nodeB" },
      };
      const res4 = resolveRuntimeNodePaths(linuxPortableWithEmbedded);
      assert.equal(res4.buildTimeNodePath, "/tools/nodeA");
      assert.equal(res4.packagedRuntimeNodePath, "/tools/nodeB");

      // 5. Linux nix-source without embeddedRuntime
      const linuxNix = {
        inputs: { mode: "nix-source" },
        target: { os: "linux", triple: "x86_64-unknown-linux-gnu" },
        tools: { node: "/tools/nodeA" },
      };
      const res5 = resolveRuntimeNodePaths(linuxNix);
      assert.equal(res5.buildTimeNodePath, "/tools/nodeA");
      assert.equal(res5.packagedRuntimeNodePath, "/tools/nodeA");
    });

    test("assembleSourceBuildPins enforces strict pin-to-packaged runtime equality invariant", async () => {
      const fixtureDir = await mkdtemp(join(tmpdir(), "pin-invariant-"));
      const runtimePath = join(fixtureDir, "packaged-runtime");
      await writeFile(runtimePath, "runtime-content-B", { mode: 0o755 });
      const runtimeBytes = readFileSync(runtimePath);
      const runtimeSha256 = digest(runtimeBytes);

      const loomDir = join(fixtureDir, "loom-payload");
      await mkdir(loomDir, { recursive: true });
      await writeFile(join(loomDir, "test.js"), "content");

      const validSidecarManifest = {
        runtime: { sha256: runtimeSha256, size: runtimeBytes.length },
      };
      const validSceneReceipt = {
        node: { sha256: runtimeSha256, bytes: runtimeBytes.length },
        files: [{ path: "bin/scene-batch.js", sha256: "fake-sha", bytes: 100 }],
      };

      // 1. Success case
      const pins = await assembleSourceBuildPins({
        sourceCandidate: "candidate-sha",
        targetTriple: "aarch64-apple-darwin",
        sidecarManifest: validSidecarManifest,
        sceneReceipt: validSceneReceipt,
        packagedRuntimeNodePath: runtimePath,
        loomPayloadDir: loomDir,
      });
      assert.equal(pins.scene.node.sha256, runtimeSha256);
      assert.equal(pins.scene.node.bytes, runtimeBytes.length);
      assert.equal(pins.loom.node.sha256, runtimeSha256);
      assert.equal(pins.loom.node.bytes, runtimeBytes.length);

      // 2. Reject divergent scene.node.sha256
      await assert.rejects(
        () => assembleSourceBuildPins({
          sourceCandidate: "candidate-sha",
          targetTriple: "aarch64-apple-darwin",
          sidecarManifest: validSidecarManifest,
          sceneReceipt: { node: { sha256: "mismatched-sha", bytes: runtimeBytes.length }, files: [] },
          packagedRuntimeNodePath: runtimePath,
          loomPayloadDir: loomDir,
        }),
        /SOURCE_BUILD_PIN_INVARIANT_FAIL.*scene\.node runtime pin.*does not match/
      );

      // 3. Reject divergent scene.node.bytes
      await assert.rejects(
        () => assembleSourceBuildPins({
          sourceCandidate: "candidate-sha",
          targetTriple: "aarch64-apple-darwin",
          sidecarManifest: validSidecarManifest,
          sceneReceipt: { node: { sha256: runtimeSha256, bytes: 999999 }, files: [] },
          packagedRuntimeNodePath: runtimePath,
          loomPayloadDir: loomDir,
        }),
        /SOURCE_BUILD_PIN_INVARIANT_FAIL.*scene\.node runtime pin.*does not match/
      );

      // 4. Reject divergent sidecarManifest.runtime.sha256
      await assert.rejects(
        () => assembleSourceBuildPins({
          sourceCandidate: "candidate-sha",
          targetTriple: "aarch64-apple-darwin",
          sidecarManifest: { runtime: { sha256: "divergent-sidecar-sha", size: runtimeBytes.length } },
          sceneReceipt: validSceneReceipt,
          packagedRuntimeNodePath: runtimePath,
          loomPayloadDir: loomDir,
        }),
        /SOURCE_BUILD_PIN_INVARIANT_FAIL.*sidecarManifest runtime/
      );

      // 5. Reject divergent staged externalBin
      const stagedBinPath = join(fixtureDir, "staged-service");
      await writeFile(stagedBinPath, "divergent-staged-bytes");
      await assert.rejects(
        () => assembleSourceBuildPins({
          sourceCandidate: "candidate-sha",
          targetTriple: "aarch64-apple-darwin",
          sidecarManifest: validSidecarManifest,
          sceneReceipt: validSceneReceipt,
          packagedRuntimeNodePath: runtimePath,
          loomPayloadDir: loomDir,
          stagedExternalBinPath: stagedBinPath,
        }),
        /SOURCE_BUILD_PIN_INVARIANT_FAIL.*staged externalBin.*does not match/
      );

      await rm(fixtureDir, { recursive: true, force: true });
    });

    test("end-to-end Darwin portable-source binds packaged Node B to sidecar, scene, loom (!= A) while loom build step uses A", async () => {
      const { studioRoot, buildInputs, nodeStub, embeddedPath } = await createDeclaredFixture(TARGETS[0], "portable-source");

      const nodeShaA = digest(await readFile(nodeStub));
      const nodeShaB = digest(await readFile(embeddedPath));
      assert.notEqual(nodeShaA, nodeShaB, "Test requires distinct identities for Node A and Node B");

      let loomBuildNodeReceived = null;
      let scenePrepNodeReceived = null;
      let sidecarPrepNodeReceived = null;

      const testOverrides = {
        prepareSidecar: async (opts) => {
          sidecarPrepNodeReceived = opts.nodePath;
          // Create minimal mock sidecar manifest with Node B
          const manifestDir = join(opts.studioRoot, "src-tauri/sidecar-payload");
          await mkdir(manifestDir, { recursive: true });
          const runtimeBytes = readFileSync(opts.nodePath);
          await writeFile(join(manifestDir, "manifest.json"), JSON.stringify({
            runtime: { sha256: digest(runtimeBytes), size: runtimeBytes.length },
          }));
          return { sidecarBinary: "tfsb-studio-service-aarch64-apple-darwin" };
        },
        prepareLoom: async (opts) => {
          loomBuildNodeReceived = opts.nodePath;
          // Create minimal mock loom-payload
          const loomPayload = join(opts.studioRoot, "src-tauri/loom-payload");
          await mkdir(loomPayload, { recursive: true });
          await writeFile(join(loomPayload, "package.json"), "{}");
          return { schema: "tfsb.loom-payload-receipt-v1" };
        },
        prepareSolarSail: async (opts) => ({ schema: "solar-sail-receipt-v1" }),
        generateReleaseNotices: async (opts) => ({ schema: "release-notices-receipt-v1" }),
        prepareSceneFromSource: async (opts) => {
          scenePrepNodeReceived = opts.node;
          const nodeBytes = readFileSync(opts.node);
          return {
            node: { sha256: digest(nodeBytes), bytes: nodeBytes.length },
            files: [{ path: "bin/scene-batch.js", sha256: "fake-scene-sha", bytes: 100 }],
          };
        },
      };

      const result = await prepareAppResources({
        buildInputs,
        studioRoot,
        _testOverrides: testOverrides,
      });

      assert.equal(result.status, "pass");

      // Verify node received by each step
      assert.equal(loomBuildNodeReceived, nodeStub, "Loom build step MUST use build-time Node A");
      assert.equal(scenePrepNodeReceived, embeddedPath, "Scene prep MUST use packaged Node B");
      assert.equal(sidecarPrepNodeReceived, embeddedPath, "Sidecar prep MUST use packaged Node B");

      // Verify written source-build-pins.json
      const pinsPath = join(studioRoot, "src-tauri/source-build-pins.json");
      assert.ok(existsSync(pinsPath));
      const pins = JSON.parse(await readFile(pinsPath, "utf8"));

      assert.equal(pins.sidecarManifest.runtime.sha256, nodeShaB, "Sidecar manifest runtime pin MUST be Node B");
      assert.equal(pins.scene.node.sha256, nodeShaB, "Scene source-build pin MUST be Node B");
      assert.equal(pins.loom.node.sha256, nodeShaB, "Loom source-build pin MUST be Node B");

      assert.notEqual(pins.sidecarManifest.runtime.sha256, nodeShaA, "Sidecar runtime MUST NOT be Node A");
      assert.notEqual(pins.scene.node.sha256, nodeShaA, "Scene pin MUST NOT be Node A");
      assert.notEqual(pins.loom.node.sha256, nodeShaA, "Loom pin MUST NOT be Node A");
    });
  });
});

