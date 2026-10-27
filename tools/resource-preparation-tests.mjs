// @ts-check
import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  PREPARED_PREVIEW_INPUT_SCHEMA,
  PREPARED_PREVIEW_LIMITS,
  EXPECTED_PREVIEW_ORIGIN,
  EXPECTED_PREVIEW_SOURCE_DIRS,
  EXPECTED_PREVIEW_SOURCE_MEMBERS,
  EXPECTED_PREVIEW_RECIPE_MEMBERS,
  EXPECTED_PREVIEW_RECIPE_COMMAND,
  EXPECTED_PREVIEW_RECIPE_SCRIPT,
  EXPECTED_PREVIEW_RECIPE_ENV,
  EXPECTED_PREVIEW_NODE,
  EXPECTED_PREVIEW_DEPENDENCY_IDENTITY,
  EXPECTED_PREVIEW_OUTPUT_DIRS,
  EXPECTED_PREVIEW_NORMALIZED_OUTPUT,
  EXPECTED_PREVIEW_ORIGIN_OUTPUT_IDENTITY,
  createPreviewHashBudget,
  inspectBoundedPreviewTree,
  admitPreparedNeutralPreviewInput,
  verifyPreparedNeutralPreviewCustody,
  stagePreparedNeutralPreviewInput,
  verifyPreparedNeutralPreviewPostbuild,
} from "./prepare-app-resources.mjs";

import {
  PREPARED_PREVIEW_HANDOFF_SCHEMA,
  validatePreparedPreviewHandoff,
  produceBuildReceipt,
} from "./build-receipt.mjs";

import { digest, identity, inventoryTree, seal, sourceResourcePlans } from "./candidate-provenance.mjs";
import { TARGETS, CANDIDATE_VERSION } from "./platform-targets.mjs";
import { createBuildSettings } from "./build-settings.mjs";
import { loadBuildInputs, validateBuildInputs } from "./build-inputs.mjs";
import { prepareNativeDependencies, parseNativeBuildArgs } from "./native-candidate-build.mjs";
import { preparePreviewBuild } from "./loom-prepare.mjs";
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
  prepareSceneFromSource,
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
    const stack = [outboxDir];
    while (stack.length > 0) {
      const dir = /** @type {string} */ (stack.pop());
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.includes("solar-sail") && entry.name.includes(EXPECTED_SOLAR_SAIL_VERSION) && entry.name.endsWith(".tgz")) {
          return full;
        }
      }
    }
  }
  throw new Error("No authentic Solar Sail tarball found for test fixture");
}

async function buildDeterministicSceneArchive(targetTarPath) {
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
  const files = [];
  for (const entry of readdirSync(SCENE_PAYLOAD_SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const fullPath = join(entry.parentPath, entry.name);
    const relativePath = fullPath.slice(SCENE_PAYLOAD_SRC.length + 1).split("\\").join("/");
    const fileBytes = readFileSync(fullPath);
    files.push({ path: relativePath, bytes: fileBytes.length, sha256: digest(fileBytes) });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const bytes = await readFile(targetTarPath);
  const sha256 = digest(bytes);
  return { sha256, bytes: bytes.length, binding: { ...sceneBinding, sha256, bytes: bytes.length, files } };
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

    const res = await prepareSolarSail({
      studioRoot: STUDIO_ROOT,
      tarball: authenticTarball,
      payloadRoot: fixturePayload,
      adapterDir: fixtureAdapter,
    });

    assert.equal(res.route, "published-archive");
    assert.equal(res.binding.version, EXPECTED_SOLAR_SAIL_VERSION);
    assert.equal(res.binding.name, EXPECTED_SOLAR_SAIL_NAME);
    assert.equal(res.binding.runtimeMemberCount, res.binding.members.length);
    assert.equal(res.buildPin.binding.memberCount, res.binding.runtimeMemberCount);
    assert.ok(res.binding.runtimeMemberCount >= 42);
    assert.ok(existsSync(join(fixturePayload, "solar-sail-binding.json")));
    assert.ok(existsSync(join(fixturePayload, "dist/index.js")));
    assert.ok(existsSync(join(fixtureDir, "solar-sail-build-pin.json")));
  });

  test("explicit env tarball (TFSS_SOLAR_SAIL_TARBALL) wins over monorepo rebuild", async () => {
    const authenticTarball = findSolarSailTarball();
    const fixturePayload = join(fixtureDir, "solar-sail-payload");
    const fixtureAdapter = join(fixtureDir, "solar-sail-adapter");

    process.env.TFSS_SOLAR_SAIL_TARBALL = authenticTarball;

    const res = await prepareSolarSail({
      studioRoot: STUDIO_ROOT,
      payloadRoot: fixturePayload,
      adapterDir: fixtureAdapter,
    });

    assert.equal(res.route, "published-archive");
    assert.equal(res.binding.runtimeMemberCount, res.binding.members.length);
    assert.ok(res.binding.runtimeMemberCount >= 42);
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
    const { binding } = await buildDeterministicSceneArchive(sceneArchive);

    const fixturePayload = join(fixtureDir, "scene-payload");

    const receipt = await prepareScenePayload({
      archive: sceneArchive,
      node: AUTH_NODE_PATH,
      destination: fixturePayload,
      binding,
    });

    assert.equal(receipt.schema, "tfsb.scene-payload-receipt-v1");
    assert.equal(receipt.inputSha256, binding.sha256);
    assert.equal(receipt.capability, "0.5-development");
    assert.ok(existsSync(join(fixturePayload, "bin/scene-batch.js")));
    assert.ok(existsSync(join(fixturePayload, "package.json")));

    // Verify through verifier
    const verified = await verifyScenePayload(fixturePayload, AUTH_NODE_PATH, binding);
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
    const { binding } = await buildDeterministicSceneArchive(sceneArchive);

    const fakeNode = join(fixtureDir, "fake-node");
    await writeFile(fakeNode, "fake node binary bytes");

    await assert.rejects(
      () => prepareScenePayload({
        archive: sceneArchive,
        node: fakeNode,
        destination: join(fixtureDir, "tampered-node-payload"),
        binding,
      }),
      /Scene Node (identity mismatch|runtime target is unsupported)/
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
    const { binding } = await buildDeterministicSceneArchive(sceneArchive);
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
      sceneBinding: binding,
      node: AUTH_NODE_PATH,
    });

    assert.equal(receipt.schema, "tfsb.prepared-app-resources-v1");
    assert.equal(receipt.status, "partial");
    assert.ok(receipt.receipts.solarSail);
    assert.equal(receipt.receipts.solarSail.version, EXPECTED_SOLAR_SAIL_VERSION);
    assert.ok(receipt.receipts.solarSail.runtimeMemberCount >= 42);
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
      await writeFile(join(p, "package.json"), JSON.stringify({
        name: `@knowledge-forge-ai/theme-forge-${product}`,
        version: product === "solar-sail" ? EXPECTED_SOLAR_SAIL_VERSION : CANDIDATE_VERSION,
      }));
      components[name] = {
        root: p,
        version: product === "solar-sail" ? EXPECTED_SOLAR_SAIL_VERSION : CANDIDATE_VERSION,
        source: h,
        target: target.triple,
        producer: h,
        output: (await inventoryTree(p)).identity,
      };
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

  async function bindPreviewFixture(buildInputs, execution, dependencies) {
    // The general fixture's system library root is fixtureDir. Keep this test's
    // additions outside the finite library authority instead of invalidating it.
    const libraries = join(fixtureDir, "preview-system-libraries");
    await mkdir(libraries);
    return { ...buildInputs, execution, dependencies,
      toolchains: { ...buildInputs.toolchains, systemLibraries: {
        path: libraries, identity: (await inventoryTree(libraries)).identity,
      } },
    };
  }

  test("native dependency setup defers preview to validated source resource orchestration", async () => {
    const { studioRoot, buildInputs, nodeStub } = await createDeclaredFixture();
    const previewModules = join(fixtureDir, "preview-modules");
    const frontendModules = join(fixtureDir, "frontend-modules");
    await mkdir(frontendModules);
    await writeFile(join(frontendModules, "frontend.json"), "{}");
    await mkdir(join(previewModules, "astro/bin"), { recursive: true });
    await writeFile(join(previewModules, "astro/package.json"), JSON.stringify({ name: "astro", version: "7.3.1", bin: { astro: "./bin/astro.mjs" } }));
    await writeFile(join(previewModules, "astro/bin/astro.mjs"), "// fixture CLI, never executed\n");
    const previewRoot = join(studioRoot, "loom-preview-source");
    await mkdir(previewRoot);
    await writeFile(join(previewRoot, "package.json"), JSON.stringify({
      scripts: { "build:neutral": "ASTRO_BASE=/preview TFSL_THEME_CSS=./src/styles/neutral.css ASTRO_OUT_DIR=./dist/neutral astro build" },
      dependencies: { astro: "7.3.1" },
    }));
    const suppliedInputs = await bindPreviewFixture(buildInputs, { frontendModules, previewModules }, {
      frontendModules: (await inventoryTree(frontendModules)).identity,
      previewModules: (await inventoryTree(previewModules)).identity,
    });
    // Mirror native-candidate-build's serialized authority boundary before setup.
    const authorityPath = join(fixtureDir, "native-build-inputs.json");
    await writeFile(authorityPath, JSON.stringify(suppliedInputs));
    const commands = [];
    await prepareNativeDependencies(studioRoot, suppliedInputs.execution, nodeStub, "qualified-npm", async (program, args, cwd) => {
      commands.push({ program, args, cwd });
    });
    assert.deepEqual(commands, [{ program: nodeStub,
      args: ["qualified-npm", "rebuild", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], cwd: studioRoot }]);
    assert.equal(existsSync(join(previewRoot, "node_modules")), false, "native setup must not pre-copy, chmod, rebuild or create preview bins");
    const forwardedInputs = (await loadBuildInputs(authorityPath)).inputs;
    assert.ok(forwardedInputs.execution);
    assert.ok(forwardedInputs.dependencies);
    assert.equal(forwardedInputs.execution.previewModules, previewModules);
    assert.equal(forwardedInputs.dependencies.previewModules, suppliedInputs.dependencies.previewModules);
    const calls = [];
    const reachedLoom = new Error("test reached validated Loom invocation");
    await assert.rejects(
      () => prepareAppResources({ buildInputs: forwardedInputs, studioRoot, _testOverrides: {
        prepareSidecar: async () => { calls.push("sidecar"); return {}; },
        prepareLoom: async options => {
          calls.push("loom");
          assert.equal(options.previewModules, previewModules);
          assert.equal(options.previewModulesIdentity, suppliedInputs.dependencies.previewModules);
          assert.equal(existsSync(join(previewRoot, "node_modules")), false);
          assert.ok(typeof options.previewModules === "string");
          assert.ok(typeof options.previewModulesIdentity === "string");
          assert.ok(typeof options.nodePath === "string");
          const command = await preparePreviewBuild({ previewRoot, previewModules: options.previewModules,
            expectedIdentity: options.previewModulesIdentity, nodePath: options.nodePath });
          assert.equal(command.command, nodeStub);
          assert.deepEqual(command.args, [join(previewRoot, "node_modules/astro/bin/astro.mjs"), "build"]);
          assert.equal((await inventoryTree(join(previewRoot, "node_modules"))).identity, suppliedInputs.dependencies.previewModules);
          assert.equal(existsSync(join(previewRoot, "node_modules/.bin")), false);
          throw reachedLoom;
        },
      } }),
      error => error === reachedLoom,
    );
    assert.deepEqual(calls, ["sidecar", "loom"]);
    assert.equal((await inventoryTree(previewModules)).identity, suppliedInputs.dependencies.previewModules);
  });

  test("native setup never follows preview aliases before authority validation refuses them", async () => {
    const { studioRoot, buildInputs, nodeStub } = await createDeclaredFixture();
    const frontendModules = join(fixtureDir, "frontend-modules");
    const previewModules = join(fixtureDir, "preview-modules");
    await mkdir(frontendModules);
    await writeFile(join(frontendModules, "frontend.json"), "{}");
    await mkdir(previewModules);
    const outside = join(fixtureDir, "unselected-preview-target");
    await mkdir(outside);
    await writeFile(join(outside, "marker"), "do not copy");
    await symlink(outside, join(previewModules, "nested-alias"));
    const suppliedInputs = await bindPreviewFixture(buildInputs, { frontendModules, previewModules }, {
      frontendModules: (await inventoryTree(frontendModules)).identity, previewModules: "0".repeat(64),
    });
    const commands = [];
    await prepareNativeDependencies(studioRoot, suppliedInputs.execution, nodeStub, "qualified-npm", async (program, args, cwd) => {
      commands.push({ program, args, cwd });
    });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].cwd, studioRoot);
    assert.equal(commands[0].args[1], "rebuild");
    assert.equal(existsSync(join(studioRoot, "loom-preview-source/node_modules")), false);
    let resourceCalls = 0;
    const unexpected = async () => { resourceCalls += 1; throw new Error("unvalidated resource step"); };
    await assert.rejects(
      () => prepareAppResources({ buildInputs: suppliedInputs, studioRoot, _testOverrides: { prepareSidecar: unexpected,
        prepareLoom: unexpected, prepareSolarSail: unexpected, prepareSceneFromSource: unexpected,
        generateReleaseNotices: unexpected } }),
      /nonregular inventory member/,
    );
    assert.equal(resourceCalls, 0);
    assert.equal(await readFile(join(outside, "marker"), "utf8"), "do not copy");
    assert.equal(existsSync(join(studioRoot, "loom-preview-source/node_modules")), false);
  });

  test("native dependency setup retains the legacy preview install and rebuild sequence", async () => {
    const stage = join(fixtureDir, "legacy-stage");
    await mkdir(join(stage, "loom-preview-source"), { recursive: true });
    const commands = [];
    await prepareNativeDependencies(stage, {}, "qualified-node", "qualified-npm", async (program, args, cwd) => {
      commands.push({ program, args, cwd });
      assert.ok(typeof cwd === "string");
      if (args[1] === "ci") await mkdir(join(cwd, "node_modules"));
    });
    const install = ["qualified-npm", "ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"];
    const rebuild = ["qualified-npm", "rebuild", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"];
    assert.deepEqual(commands, [
      { program: "qualified-node", args: install, cwd: stage },
      { program: "qualified-node", args: install, cwd: join(stage, "loom-preview-source") },
      { program: "qualified-node", args: rebuild, cwd: stage },
      { program: "qualified-node", args: rebuild, cwd: join(stage, "loom-preview-source") },
    ]);
  });

  test("mismatched or changed preview inventory refuses before every resource step", async () => {
    const { studioRoot, buildInputs } = await createDeclaredFixture();
    const previewModules = join(fixtureDir, "preview-modules");
    await mkdir(previewModules);
    await writeFile(join(previewModules, "fixture-dependency.json"), "{}");
    const validIdentity = (await inventoryTree(previewModules)).identity;
    const suppliedInputs = await bindPreviewFixture(buildInputs, { previewModules }, { previewModules: validIdentity });
    let calls = 0;
    const unexpected = async () => { calls += 1; throw new Error("unvalidated resource step"); };
    const overrides = { prepareSidecar: unexpected, prepareLoom: unexpected, prepareSolarSail: unexpected,
      prepareSceneFromSource: unexpected, generateReleaseNotices: unexpected };
    for (const mutation of [false, true]) {
      suppliedInputs.dependencies = { previewModules: mutation ? validIdentity : "0".repeat(64) };
      if (mutation) await writeFile(join(previewModules, "fixture-dependency.json"), '{"changed":true}');
      await assert.rejects(
        () => prepareAppResources({ buildInputs: suppliedInputs, studioRoot, _testOverrides: overrides }),
        /previewModules dependency inventory mismatch/,
      );
      assert.equal(calls, 0);
    }
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
      const runtimePath = AUTH_NODE_PATH;
      const runtimeBytes = readFileSync(runtimePath);
      const runtimeSha256 = digest(runtimeBytes);

      const loomDir = join(fixtureDir, "loom-payload");
      await mkdir(loomDir, { recursive: true });
      await writeFile(join(loomDir, "test.js"), "content");

      const validSidecarManifest = {
        runtime: { sha256: runtimeSha256, size: runtimeBytes.length },
      };
      const validSceneReceipt = await prepareSceneFromSource({
        studioRoot: STUDIO_ROOT,
        burstRoot: REPO_ROOT,
        node: runtimePath,
        destination: join(fixtureDir, "scene-payload"),
        sourceIdentity: "a".repeat(64),
        xmldomRoot: join(REPO_ROOT, "node_modules/@xmldom/xmldom"),
        tomlRoot: join(REPO_ROOT, "node_modules/smol-toml"),
      });

      // 1. Success case
      const pins = await assembleSourceBuildPins({
        sourceCandidate: "a".repeat(64),
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
          sourceCandidate: "a".repeat(64),
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
          sourceCandidate: "a".repeat(64),
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
          sourceCandidate: "a".repeat(64),
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
          sourceCandidate: "a".repeat(64),
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
      const { studioRoot, buildInputs, nodeStub, embeddedPath } = await createDeclaredFixture(TARGETS[0], "portable-source", AUTH_NODE_PATH);

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
        prepareSolarSail: async (opts) => ({
          route: "structured-source",
          binding: { schema: "tfsb.solar-sail-binding-v1" },
          buildPin: {
            schema: "nebular-solar-sail-build-pin-v1",
            target: opts.sourceAuthority.target,
            package: { name: EXPECTED_SOLAR_SAIL_NAME, version: EXPECTED_SOLAR_SAIL_VERSION, packageJsonSha256: "b".repeat(64) },
            binding: { size: 256, sha256: "a".repeat(64), inventoryDigest: "c".repeat(64), memberCount: 53 },
            provenance: {
              structuredSource: {
                sourceCandidate: opts.sourceAuthority.sourceCandidate,
                componentSource: opts.sourceAuthority.component.source,
                output: opts.sourceAuthority.component.output,
                producer: opts.sourceAuthority.component.producer,
                version: EXPECTED_SOLAR_SAIL_VERSION,
              },
            },
          },
        }),
        generateReleaseNotices: async (opts) => ({ schema: "release-notices-receipt-v1" }),
        prepareSceneFromSource: async (opts) => {
          scenePrepNodeReceived = opts.node;
          return prepareSceneFromSource({
            studioRoot: STUDIO_ROOT,
            burstRoot: REPO_ROOT,
            node: opts.node,
            destination: join(opts.studioRoot, "src-tauri/scene-payload"),
            sourceIdentity: opts.sourceIdentity,
            xmldomRoot: join(REPO_ROOT, "node_modules/@xmldom/xmldom"),
            tomlRoot: join(REPO_ROOT, "node_modules/smol-toml"),
          });
        },
      };

      const result = await prepareAppResources({ buildInputs, studioRoot, _testOverrides: testOverrides });
      assert.equal(result.status, "pass");
      assert.equal(loomBuildNodeReceived, nodeStub, "Loom build step MUST use build-time Node A");
      assert.equal(scenePrepNodeReceived, embeddedPath, "Scene prep MUST use packaged Node B");
      assert.equal(sidecarPrepNodeReceived, embeddedPath, "Sidecar prep MUST use packaged Node B");

      const pinsPath = join(studioRoot, "src-tauri/source-build-pins.json");
      assert.ok(existsSync(pinsPath));
      const pins = JSON.parse(await readFile(pinsPath, "utf8"));
      assert.equal(pins.sidecarManifest.runtime.sha256, nodeShaB, "Sidecar manifest runtime pin MUST be Node B");
      assert.equal(pins.scene.node.sha256, nodeShaB, "Scene source-build pin MUST be Node B");
      assert.equal(pins.loom.node.sha256, nodeShaB, "Loom source-build pin MUST be Node B");
      assert.equal(pins.solar.schema, "nebular-solar-sail-build-pin-v1");
      assert.equal(pins.solar.provenance.structuredSource.sourceCandidate, buildInputs.source.identity);
      assert.notEqual(pins.sidecarManifest.runtime.sha256, nodeShaA, "Sidecar runtime MUST NOT be Node A");
      assert.notEqual(pins.scene.node.sha256, nodeShaA, "Scene pin MUST NOT be Node A");
      assert.notEqual(pins.loom.node.sha256, nodeShaA, "Loom pin MUST NOT be Node A");
    });
  });

  describe("Prepared neutral-preview handoff (DESIGN2)", () => {
    const AUTH_PREVIEW_MODULES = process.env.TFSB_AUTH_PREVIEW_MODULES ?? join(tmpdir(), "tf-preview-modules-unbound");
    const AUTH_ORIGIN_NEUTRAL = process.env.TFSB_AUTH_ORIGIN_NEUTRAL ?? join(tmpdir(), "tf-preview-origin-unbound");

    // The maintained qualification runner supplies authenticated paths; the
    // fallback is intentionally absent so local fixture runs skip external-input cases.

    async function buildProjectedPreviewSourceRoot(baseDir) {
      const sourceRoot = join(baseDir, "projected-source");
      await mkdir(join(sourceRoot, "src-tauri"), { recursive: true });
      await writeFile(join(sourceRoot, "src-tauri/Cargo.lock"), "cargo");
      await writeFile(join(sourceRoot, "package-lock.json"), "frontend");
      // Project exact 11 loom-preview-source files from packages/stellar-loom/fixture
      for (const member of EXPECTED_PREVIEW_SOURCE_MEMBERS) {
        const srcFile = join(REPO_ROOT, "packages/stellar-loom/fixture", member.path);
        const destFile = join(sourceRoot, "loom-preview-source", member.path);
        await mkdir(dirname(destFile), { recursive: true });
        await cp(srcFile, destFile);
        await chmod(destFile, 0o644);
      }
      // Copy exact 5 recipe files into tools/
      await mkdir(join(sourceRoot, "tools"), { recursive: true });
      for (const rec of EXPECTED_PREVIEW_RECIPE_MEMBERS) {
        const srcFile = join(STUDIO_ROOT, "tools", rec.name);
        const destFile = join(sourceRoot, "tools", rec.name);
        await cp(srcFile, destFile);
        await chmod(destFile, 0o644);
      }
      return sourceRoot;
    }

    function createValidManifestObject({ sourceCandidate, nodePath, previewModulesRoot, previewRoot }) {
      const sourceMembers = EXPECTED_PREVIEW_SOURCE_MEMBERS.map(m => ({ ...m }));
      const recipeMembers = EXPECTED_PREVIEW_RECIPE_MEMBERS.map(r => ({
        path: `tools/${r.name}`,
        bytes: r.bytes,
        mode: r.mode,
        sha256: r.sha256,
      }));
      const recipeWithoutId = {
        members: recipeMembers,
        command: EXPECTED_PREVIEW_RECIPE_COMMAND,
        script: EXPECTED_PREVIEW_RECIPE_SCRIPT,
        environment: { ...EXPECTED_PREVIEW_RECIPE_ENV },
      };
      const previewMembers = EXPECTED_PREVIEW_NORMALIZED_OUTPUT.map(m => ({ ...m }));
      return {
        schema: PREPARED_PREVIEW_INPUT_SCHEMA,
        origin: {
          sourceCandidate: EXPECTED_PREVIEW_ORIGIN.sourceCandidate,
          sourceHead: EXPECTED_PREVIEW_ORIGIN.sourceHead,
          recoverySha256: EXPECTED_PREVIEW_ORIGIN.recoverySha256,
          namespaceSha256: EXPECTED_PREVIEW_ORIGIN.namespaceSha256,
          originalProducerResultSha256: EXPECTED_PREVIEW_ORIGIN.originalProducerOuterSha256,
          sourceBuildPinsSha256: EXPECTED_PREVIEW_ORIGIN.sourceBuildPinsSha256,
        },
        current: {
          sourceCandidate,
          target: "aarch64-apple-darwin",
          mode: "portable-source",
        },
        source: {
          members: sourceMembers,
          identity: identity(sourceMembers),
        },
        dependencies: {
          root: previewModulesRoot,
          identity: EXPECTED_PREVIEW_DEPENDENCY_IDENTITY,
        },
        node: {
          path: nodePath,
          identity: EXPECTED_PREVIEW_NODE.sha256,
          version: EXPECTED_PREVIEW_NODE.version,
          platform: EXPECTED_PREVIEW_NODE.platform,
        },
        recipe: {
          ...recipeWithoutId,
          identity: identity(recipeWithoutId),
        },
        preview: {
          root: previewRoot,
          members: previewMembers,
          identity: EXPECTED_PREVIEW_ORIGIN_OUTPUT_IDENTITY,
        },
        limits: structuredClone(PREPARED_PREVIEW_LIMITS),
      };
    }

    async function createPreviewBuildInputs(sourceRoot) {
      const config = JSON.parse(await readFile(join(STUDIO_ROOT, "src-tauri/tauri.conf.json"), "utf8"));
      const h = digest("preview-fixture");
      const source = seal("nebular-source-candidate-v1", {
        version: CANDIDATE_VERSION,
        composition: h,
        locks: { cargo: digest("cargo"), frontend: digest("frontend") },
        components: { burst: h, loom: h, solar: h },
        recipe: h,
        resourcePlans: sourceResourcePlans(config),
      });
      const components = {};
      for (const [name, product] of [["burst", "stellar-burst"], ["loom", "stellar-loom"], ["solar", "solar-sail"]]) {
        const compDir = join(fixtureDir, `comp-${name}`);
        await mkdir(compDir, { recursive: true });
        await writeFile(join(compDir, "package.json"), JSON.stringify({ name: `@knowledge-forge-ai/theme-forge-${product}`, version: CANDIDATE_VERSION }));
        components[name] = {
          root: compDir,
          version: CANDIDATE_VERSION,
          source: h,
          target: TARGETS[0].triple,
          producer: h,
          output: (await inventoryTree(compDir)).identity,
        };
      }
      const toolStub = join(fixtureDir, "tool-stub");
      await writeFile(toolStub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const toolId = digest(await readFile(toolStub));
      const toolchains = {
        node: { path: process.execPath, identity: EXPECTED_PREVIEW_NODE.sha256, npm: { path: toolStub, identity: toolId } },
        rust: { path: toolStub, identity: toolId },
        cargo: { path: toolStub, identity: toolId },
        compiler: { path: toolStub, identity: toolId },
        linker: { path: toolStub, identity: toolId },
        pkgConfig: { path: toolStub, identity: toolId },
        systemLibraries: { path: join(sourceRoot, "tools"), identity: (await inventoryTree(join(sourceRoot, "tools"))).identity },
      };
      const settings = await createBuildSettings({});
      return {
        schema: "nebular-build-inputs-v1",
        mode: "portable-source",
        target: TARGETS[0].triple,
        sourceRoot,
        source,
        components,
        toolchains,
        settings,
        execution: { previewModules: AUTH_PREVIEW_MODULES, environment: {} },
        dependencies: { previewModules: EXPECTED_PREVIEW_DEPENDENCY_IDENTITY },
      };
    }

    test("refuses non-Darwin target, nix-source mode, bad schema/origin/limits/current/source/recipe/node/dependencies, symlinked manifest, and budget exhaustion", async () => {
      const sourceRoot = await buildProjectedPreviewSourceRoot(fixtureDir);
      const buildInputs = await createPreviewBuildInputs(sourceRoot);

      const authority = {
        inputs: buildInputs,
        target: TARGETS[0],
        tools: { node: process.execPath },
        roots: {},
      };
      const baseManifest = createValidManifestObject({
        sourceCandidate: buildInputs.source.identity,
        nodePath: process.execPath,
        previewModulesRoot: AUTH_PREVIEW_MODULES,
        previewRoot: AUTH_ORIGIN_NEUTRAL,
      });

      const writeManifest = async (name, obj) => {
        const p = join(fixtureDir, name);
        await writeFile(p, JSON.stringify(obj, null, 2) + "\n", { mode: 0o644 });
        return p;
      };

      // 1. Verify CLI flag --prepared-preview-inputs parsing and refuse Linux target or nix-source mode
      const linuxAuth = { ...authority, target: TARGETS[1], inputs: { ...buildInputs, target: TARGETS[1].triple } };
      const validManifestPath = await writeManifest("valid.json", baseManifest);
      const parsedCli = parseNativeBuildArgs([
        "--target", "aarch64-apple-darwin",
        "--build-inputs", "/tmp/inputs.json",
        "--output", "/tmp/out",
        "--prepared-preview-inputs", validManifestPath,
      ]);
      assert.equal(parsedCli.preparedPreviewInputs, validManifestPath);
      assert.throws(
        () => parseNativeBuildArgs(["--target", "aarch64-apple-darwin", "--build-inputs", "/tmp/inputs.json", "--output", "/tmp/out", "--prepared-preview-inputs"]),
        /Expected --target, --build-inputs and --output/
      );
      await assert.rejects(admitPreparedNeutralPreviewInput(validManifestPath, linuxAuth), /only admitted for target aarch64-apple-darwin/);
      const nixAuth = { ...authority, inputs: { ...buildInputs, mode: "nix-source" } };
      await assert.rejects(admitPreparedNeutralPreviewInput(validManifestPath, nixAuth), /only admitted for target aarch64-apple-darwin/);

      // 2. Refuse symlinked manifest
      const symManifest = join(fixtureDir, "sym-manifest.json");
      await symlink(validManifestPath, symManifest);
      await assert.rejects(admitPreparedNeutralPreviewInput(symManifest, authority), /Symlink/i);

      // 3. Refuse wrong schema, wrong limits, extra key, wrong origin
      await assert.rejects(
        admitPreparedNeutralPreviewInput(await writeManifest("bad-schema.json", { ...baseManifest, schema: "wrong-v1" }), authority),
        /Unsupported prepared neutral-preview input schema/
      );
      const badLimits = structuredClone(baseManifest);
      badLimits.limits.manifestBytes = 9999999;
      await assert.rejects(
        admitPreparedNeutralPreviewInput(await writeManifest("bad-limits.json", badLimits), authority),
        /limits do not match/
      );
      await assert.rejects(
        admitPreparedNeutralPreviewInput(await writeManifest("extra-key.json", { ...baseManifest, extra: 1 }), authority),
        /keys differ from closed contract/
      );
      const badOrigin = structuredClone(baseManifest);
      badOrigin.origin.sourceCandidate = "0".repeat(64);
      await assert.rejects(
        admitPreparedNeutralPreviewInput(await writeManifest("bad-origin.json", badOrigin), authority),
        /origin does not match/
      );

      // 4. Refuse mismatched current.sourceCandidate or current.target
      const badCurrent = structuredClone(baseManifest);
      badCurrent.current.sourceCandidate = "f".repeat(64);
      await assert.rejects(
        admitPreparedNeutralPreviewInput(await writeManifest("bad-current.json", badCurrent), authority),
        /current block does not match/
      );

      // 5. Refuse modified loom-preview-source member
      const astroCfg = join(sourceRoot, "loom-preview-source/astro.config.mjs");
      const savedAstro = await readFile(astroCfg);
      await writeFile(astroCfg, "// modified\n", { mode: 0o644 });
      await assert.rejects(
        admitPreparedNeutralPreviewInput(validManifestPath, authority),
        /loom-preview-source inventory does not match/
      );
      await writeFile(astroCfg, savedAstro, { mode: 0o644 });

      // 6. Refuse modified recipe file in tools/
      const pagefindFile = join(sourceRoot, "tools/pagefind-index.mjs");
      const savedPagefind = await readFile(pagefindFile);
      await writeFile(pagefindFile, "// modified recipe\n", { mode: 0o644 });
      await assert.rejects(
        admitPreparedNeutralPreviewInput(validManifestPath, authority),
        /recipe file mismatch/
      );
      await writeFile(pagefindFile, savedPagefind, { mode: 0o644 });

      // 7. Refuse disallowed ASTRO_ / NODE_OPTIONS in execution.environment
      const poisonedEnvAuth = {
        ...authority,
        inputs: { ...buildInputs, execution: { ...buildInputs.execution, environment: { ASTRO_TELEMETRY_DISABLED: "1" } } },
      };
      await assert.rejects(
        admitPreparedNeutralPreviewInput(validManifestPath, poisonedEnvAuth),
        /Disallowed execution environment override/
      );

      // 8. Refuse mismatched node.identity or missing execution.previewModules
      const badNode = structuredClone(baseManifest);
      badNode.node.identity = "1".repeat(64);
      await assert.rejects(
        admitPreparedNeutralPreviewInput(await writeManifest("bad-node.json", badNode), authority),
        /node block does not match/
      );
      const noPreviewModulesAuth = {
        ...authority,
        inputs: { ...buildInputs, execution: {}, dependencies: {} },
      };
      await assert.rejects(
        admitPreparedNeutralPreviewInput(validManifestPath, noPreviewModulesAuth),
        /dependencies block does not match/
      );

      // 9. Refuse cumulative hash budget exhaustion
      const tinyBudget = createPreviewHashBudget(100);
      await assert.rejects(
        admitPreparedNeutralPreviewInput(validManifestPath, authority, { budget: tinyBudget }),
        /hash budget exceeded/
      );
    });

    test("end-to-end prepared neutral-preview admission, staging, postbuild verification, and sidecar handoff receipt", async (t) => {
      if (!existsSync(AUTH_PREVIEW_MODULES) || !existsSync(AUTH_ORIGIN_NEUTRAL)) {
        t.skip("NOT_RUN_INPUTS_MISSING: external previewModules or origin dist/neutral directory absent");
        return;
      }
      const sourceRoot = await buildProjectedPreviewSourceRoot(fixtureDir);
      const originNeutralCopy = join(fixtureDir, "origin-neutral-copy");
      await cp(AUTH_ORIGIN_NEUTRAL, originNeutralCopy, { recursive: true });

      const buildInputs = await createPreviewBuildInputs(sourceRoot);

      const authority = {
        inputs: buildInputs,
        target: TARGETS[0],
        tools: { node: process.execPath },
        roots: {},
      };
      const manifestObj = createValidManifestObject({
        sourceCandidate: buildInputs.source.identity,
        nodePath: process.execPath,
        previewModulesRoot: AUTH_PREVIEW_MODULES,
        previewRoot: originNeutralCopy,
      });
      const manifestPath = join(fixtureDir, "prepared-preview-input.json");
      await writeFile(manifestPath, JSON.stringify(manifestObj, null, 2) + "\n", { mode: 0o644 });

      const budget = createPreviewHashBudget();
      const admitted = await admitPreparedNeutralPreviewInput(manifestPath, authority, { budget });
      assert.equal(admitted.originOutputIdentity, EXPECTED_PREVIEW_ORIGIN_OUTPUT_IDENTITY);

      // Prepare clean stage directory
      const stageDir = join(fixtureDir, "stage");
      await cp(sourceRoot, stageDir, { recursive: true });

      // Pre-existing dist/neutral before staging must refuse
      await mkdir(join(stageDir, "loom-preview-source/dist/neutral"), { recursive: true });
      await assert.rejects(
        stagePreparedNeutralPreviewInput(stageDir, admitted, budget),
        /Refusing to adopt or overwrite existing preview directory/
      );
      await rm(join(stageDir, "loom-preview-source/dist"), { recursive: true, force: true });

      // Stage neutral preview into stage/loom-preview-source/dist/neutral
      const stagedObs = await stagePreparedNeutralPreviewInput(stageDir, admitted, budget);
      assert.equal(stagedObs.neutralIdentity, EXPECTED_PREVIEW_ORIGIN_OUTPUT_IDENTITY);
      assert.equal(
        (await inventoryTree(join(stageDir, "loom-preview-source/dist/neutral"))).identity,
        EXPECTED_PREVIEW_ORIGIN_OUTPUT_IDENTITY
      );

      // Populate public/preview and 6-key source-build-pins.json on stageDir
      await cp(join(stageDir, "loom-preview-source/dist/neutral"), join(stageDir, "public/preview"), { recursive: true });
      const runtimeBytes = Buffer.from("packaged-runtime-bytes");
      const runtimeSha = digest(runtimeBytes);
      const validPins = {
        sourceCandidate: buildInputs.source.identity,
        target: "aarch64-apple-darwin",
        sidecarManifest: { runtime: { sha256: runtimeSha, size: runtimeBytes.length } },
        scene: { node: { sha256: runtimeSha, bytes: runtimeBytes.length } },
        loom: { node: { sha256: runtimeSha, bytes: runtimeBytes.length } },
        solar: {
          schema: "nebular-solar-sail-build-pin-v1",
          provenance: { structuredSource: { sourceCandidate: buildInputs.source.identity } },
        },
      };
      await writeFile(join(stageDir, "src-tauri/source-build-pins.json"), JSON.stringify(validPins, null, 2) + "\n", { mode: 0o644 });

      // Post-build drift in public/preview must refuse
      const pubIndex = join(stageDir, "public/preview/index.html");
      const savedPubIndex = await readFile(pubIndex);
      await writeFile(pubIndex, Buffer.alloc(savedPubIndex.length, 0x41), { mode: 0o644 });
      await assert.rejects(
        verifyPreparedNeutralPreviewPostbuild(stageDir, admitted, stagedObs, createPreviewHashBudget()),
        /public\/preview inventory does not equal/
      );
      await writeFile(pubIndex, savedPubIndex, { mode: 0o644 });

      // Post-build verification passes when dist/neutral, public/preview, and 6-key source-build-pins.json match
      await verifyPreparedNeutralPreviewPostbuild(stageDir, admitted, stagedObs, budget);

      // Prepare payloadRoot and studioRoot resources for produceBuildReceipt
      const payloadRoot = join(fixtureDir, "payload-darwin");
      const outputDir = join(fixtureDir, "receipt-out");
      await mkdir(outputDir, { recursive: true });
      const plan = buildInputs.source.resourcePlans[buildInputs.target];
      for (const relRes of plan.resources) {
        await mkdir(join(stageDir, "src-tauri", relRes), { recursive: true });
        await writeFile(join(stageDir, "src-tauri", relRes, "resource"), relRes);
        await mkdir(join(payloadRoot, "Theme Forge Nebular Fusion.app/Contents/Resources", relRes), { recursive: true });
        await writeFile(join(payloadRoot, "Theme Forge Nebular Fusion.app/Contents/Resources", relRes, "resource"), relRes);
      }
      await mkdir(join(stageDir, "src-tauri/binaries"), { recursive: true });
      await writeFile(join(stageDir, "src-tauri", `${plan.externalBin[0]}-${buildInputs.target}`), runtimeBytes);
      const macosBin = join(payloadRoot, "Theme Forge Nebular Fusion.app/Contents/MacOS");
      await mkdir(macosBin, { recursive: true });
      await writeFile(join(macosBin, "tfsb-studio-service"), runtimeBytes);
      const machO = Buffer.alloc(32);
      machO.writeUInt32LE(0xfeedfacf, 0);
      machO.writeUInt32LE(0x0100000c, 4);
      await writeFile(join(macosBin, "theme-forge-nebular-fusion"), machO, { mode: 0o755 });

      const cleanInputsForReceipt = structuredClone(buildInputs);
      delete cleanInputsForReceipt.execution;
      delete cleanInputsForReceipt.dependencies;
      delete cleanInputsForReceipt.embeddedRuntime;
      cleanInputsForReceipt.toolchains.systemLibraries = {
        path: join(sourceRoot, "tools"),
        identity: (await inventoryTree(join(sourceRoot, "tools"))).identity,
      };

      const produced = await produceBuildReceipt({
        inputs: cleanInputsForReceipt,
        studioRoot: stageDir,
        payloadRoot,
        output: outputDir,
        preparedPreview: stagedObs,
        previewHashBudget: budget,
      });

      assert.ok(produced.preparedPreviewHandoff);
      assert.equal(produced.preparedPreviewHandoff.schema, PREPARED_PREVIEW_HANDOFF_SCHEMA);
      assert.equal(produced.preparedPreviewHandoff.neutralIdentity, EXPECTED_PREVIEW_ORIGIN_OUTPUT_IDENTITY);
      assert.equal(produced.preparedPreviewHandoff.publicPreviewIdentity, EXPECTED_PREVIEW_ORIGIN_OUTPUT_IDENTITY);
      assert.equal(produced.preparedPreviewHandoff.buildReceipt, produced.receipt.identity);
      assert.equal(produced.preparedPreviewHandoff.candidateProvenance, produced.provenance.identity);
      assert.equal(produced.preparedPreviewHandoff.nativePayload, produced.payload.identity);
      assert.ok(existsSync(join(outputDir, "prepared-preview-handoff.json")));

      // Verify build-receipt.json and candidate-provenance.json schemas and key sets remain unchanged
      assert.equal(produced.receipt.schema, "nebular-build-receipt-v1");
      assert.equal(produced.provenance.schema, "nebular-candidate-provenance-v1");
      assert.equal("preparedPreviewHandoff" in produced.receipt, false);
      assert.equal("preparedPreviewHandoff" in produced.provenance, false);

      // Negative validatePreparedPreviewHandoff checks: wrong buildReceipt, wrong candidateProvenance, wrong sourceBuildPinsSha256
      const handoff = produced.preparedPreviewHandoff;
      const { schema: _s, identity: _i, ...handoffBody } = handoff;
      const ctx = {
        inputs: cleanInputsForReceipt,
        receipt: produced.receipt,
        provenance: produced.provenance,
        payload: produced.payload,
        preparedPreview: stagedObs,
        sourceBuildPinsSha256: handoff.sourceBuildPinsSha256,
      };
      assert.throws(
        () => validatePreparedPreviewHandoff({ ...handoff, buildReceipt: "0".repeat(64) }, ctx),
        /identity mismatch|does not bind/
      );
      assert.throws(
        () => validatePreparedPreviewHandoff(
          seal(PREPARED_PREVIEW_HANDOFF_SCHEMA, { ...handoffBody, buildReceipt: "0".repeat(64) }),
          ctx
        ),
        /does not bind newly emitted receipt/
      );
      assert.throws(
        () => validatePreparedPreviewHandoff(
          seal(PREPARED_PREVIEW_HANDOFF_SCHEMA, { ...handoffBody, candidateProvenance: "0".repeat(64) }),
          ctx
        ),
        /does not bind newly emitted receipt/
      );
      assert.throws(
        () => validatePreparedPreviewHandoff(
          seal(PREPARED_PREVIEW_HANDOFF_SCHEMA, { ...handoffBody, sourceBuildPinsSha256: "0".repeat(64) }),
          ctx
        ),
        /sourceBuildPinsSha256 mismatch/
      );
    });
  });
});

