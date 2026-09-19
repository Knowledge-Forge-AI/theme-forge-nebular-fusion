// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile, cp } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  EXPECTED_SOLAR_SAIL_NAME,
  EXPECTED_SOLAR_SAIL_VERSION,
  SUPPORTED_SOLAR_SAIL_VERSIONS,
  EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST,
  SOLAR_SAIL_RUNTIME_MEMBERS,
  SOLAR_SAIL_DECLARATION_MEMBERS,
  authenticateSolarSailCandidate,
  prepareSolarSail,
  extractTarballSafely,
  sha256Hex,
} from "../tools/solar-sail-prepare.mjs";
import { repositoryRootForStudio } from "../tools/sidecar-common.mjs";
import { existsSync, readdirSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("solar-sail-prepare candidate authentication and cryptographic binding", () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "solar-sail-prepare-test-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function setupMockSolarSailPackage(options = {}) {
    const pkgRoot = join(tempDir, "package");
    await mkdir(join(pkgRoot, "dist"), { recursive: true });

    const runtimeMembers = options.runtimeMembers ?? SOLAR_SAIL_RUNTIME_MEMBERS;
    for (const relPath of runtimeMembers) {
      const content = `// mock ${relPath}\nexport const id = ${JSON.stringify(relPath)};\n`;
      const fullPath = join(pkgRoot, relPath);
      await mkdir(fullPath.substring(0, fullPath.lastIndexOf("/")), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }

    const declarationMembers = options.declarationMembers ?? SOLAR_SAIL_DECLARATION_MEMBERS;
    for (const relPath of declarationMembers) {
      const content = `export declare const id: string;\n`;
      const fullPath = join(pkgRoot, relPath);
      await mkdir(fullPath.substring(0, fullPath.lastIndexOf("/")), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }

    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify(
        {
          name: options.name ?? EXPECTED_SOLAR_SAIL_NAME,
          version: options.version ?? EXPECTED_SOLAR_SAIL_VERSION,
          type: "module",
          exports: { ".": "./dist/index.js" },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    for (const doc of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"]) {
      await writeFile(join(pkgRoot, doc), `mock ${doc}\n`, "utf8");
    }

    return { pkgRoot };
  }

  it("exports expected candidate constants and runtime members", () => {
    expect(EXPECTED_SOLAR_SAIL_NAME).toBe("@knowledge-forge-ai/theme-forge-solar-sail");
    expect(EXPECTED_SOLAR_SAIL_VERSION).toBe("0.1.0");
    expect(SUPPORTED_SOLAR_SAIL_VERSIONS).toContain("0.1.0");
    expect(SOLAR_SAIL_RUNTIME_MEMBERS).toHaveLength(8);
    expect(SOLAR_SAIL_DECLARATION_MEMBERS).toHaveLength(8);
  });

  it("authenticates valid mock Solar Sail package with 8 runtime members", async () => {
    const { pkgRoot } = await setupMockSolarSailPackage();
    const binding = await authenticateSolarSailCandidate(pkgRoot);

    expect(binding.schema).toBe("tfsb.solar-sail-binding-v1");
    expect(binding.name).toBe(EXPECTED_SOLAR_SAIL_NAME);
    expect(binding.version).toBe("0.1.0");
    expect(binding.runtimeMemberCount).toBe(8);
    expect(binding.members).toHaveLength(8);
    expect(binding.inventoryDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(binding.packageJsonSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when package name is mismatched", async () => {
    const { pkgRoot } = await setupMockSolarSailPackage({ name: "@other/package" });
    await expect(authenticateSolarSailCandidate(pkgRoot)).rejects.toThrow(/Package name mismatch/);
  });

  it("fails closed when package version is unsupported", async () => {
    const { pkgRoot } = await setupMockSolarSailPackage({ version: "0.2.0" });
    await expect(authenticateSolarSailCandidate(pkgRoot)).rejects.toThrow(/Unsupported Solar Sail version/);
  });

  it("fails closed when a runtime member is missing", async () => {
    const { pkgRoot } = await setupMockSolarSailPackage();
    await rm(join(pkgRoot, "dist/compiler.js"));
    await expect(authenticateSolarSailCandidate(pkgRoot)).rejects.toThrow(/Missing required runtime member: dist\/compiler\.js/);
  });

  it("fails closed when a declaration member is missing", async () => {
    const { pkgRoot } = await setupMockSolarSailPackage();
    await rm(join(pkgRoot, "dist/compiler.d.ts"));
    await expect(authenticateSolarSailCandidate(pkgRoot)).rejects.toThrow(/Missing required declaration member: dist\/compiler\.d\.ts/);
  });

  it("detects tampered runtime member and produces different inventory digest", async () => {
    const { pkgRoot: root1 } = await setupMockSolarSailPackage();
    const { pkgRoot: root2 } = await setupMockSolarSailPackage();

    const binding1 = await authenticateSolarSailCandidate(root1);

    // Tamper with one file
    await writeFile(join(root2, "dist/compiler.js"), "// tampered\n", "utf8");
    const binding2 = await authenticateSolarSailCandidate(root2);

    expect(binding1.inventoryDigest).not.toBe(binding2.inventoryDigest);
  });

  function findCandidateTarball() {
    const currentStudioRoot = resolve(__dirname, "..");
    const currentRepoRoot = repositoryRootForStudio(currentStudioRoot);

    // 1. Check authenticated-inputs in composed tree or monorepo
    const authDir = join(currentRepoRoot, "authenticated-inputs/solar-sail-tarball");
    if (existsSync(authDir)) {
      const files = readdirSync(authDir).filter((f) => f.endsWith(".tgz"));
      if (files.length > 0) {
        return resolve(authDir, files[0]);
      }
    }

    // 2. Check .outbox in monorepo
    const outboxDir = join(currentRepoRoot, ".outbox");
    if (existsSync(outboxDir)) {
      const files = readdirSync(outboxDir).filter((f) => f.includes("solar-sail") && f.endsWith(".tgz"));
      if (files.length > 0) {
        return resolve(outboxDir, files[0]);
      }
    }

    throw new Error(`[SOLAR_SAIL_TEST_FAIL] No Solar Sail candidate tarball found in ${authDir} or ${outboxDir}`);
  }

  it("authenticates the authentic Solar Sail payload in apps/studio/src-tauri against expected digest", async () => {
    let realPayload = resolve(__dirname, "../src-tauri/solar-sail-payload");
    if (!existsSync(join(realPayload, "package.json"))) {
      const candidateTarball = findCandidateTarball();
      const fixturePayload = join(tempDir, "fixture-solar-sail-payload");
      const fixtureAdapter = join(tempDir, "fixture-solar-sail-adapter");
      await prepareSolarSail({
        studioRoot: resolve(__dirname, ".."),
        tarball: candidateTarball,
        payloadRoot: fixturePayload,
        adapterDir: fixtureAdapter,
      });
      realPayload = fixturePayload;
    }
    const binding = await authenticateSolarSailCandidate(realPayload, EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST);

    expect(binding.schema).toBe("tfsb.solar-sail-binding-v1");
    expect(binding.version).toBe("0.1.0");
    expect(binding.runtimeMemberCount).toBe(8);
    expect(binding.inventoryDigest).toBe(EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST);

    // Matches the binding file
    const storedBinding = JSON.parse(await readFile(join(realPayload, "solar-sail-binding.json"), "utf8"));
    expect(binding.inventoryDigest).toBe(storedBinding.inventoryDigest);
    expect(binding.packageJsonSha256).toBe(storedBinding.packageJsonSha256);
  });

  it("fails closed when candidate inventory digest does not match expected digest", async () => {
    const { pkgRoot } = await setupMockSolarSailPackage();
    const wrongDigest = "0".repeat(64);
    await expect(authenticateSolarSailCandidate(pkgRoot, wrongDigest)).rejects.toThrow(
      /Solar Sail candidate inventory digest mismatch/
    );
  });

  it("fails closed when extracting a non-tarball or missing archive", () => {
    const bogus = join(tempDir, "bogus.tgz");
    expect(() => extractTarballSafely(bogus, join(tempDir, "dest"))).toThrow(
      /\[SOLAR_SAIL_PREPARE_FAIL\]/
    );
  });

  it("extracts and authenticates candidate tarball from .outbox or staged package", async () => {
    const targetTarball = findCandidateTarball();
    const scratch = join(tempDir, "candidate-unpack");
    await mkdir(scratch, { recursive: true });
    const pkgRoot = extractTarballSafely(targetTarball, scratch);
    expect(existsSync(join(pkgRoot, "package.json"))).toBe(true);

    const binding = await authenticateSolarSailCandidate(pkgRoot, EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST);
    expect(binding.inventoryDigest).toBe(EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST);
    expect(binding.version).toBe(EXPECTED_SOLAR_SAIL_VERSION);
    expect(binding.name).toBe(EXPECTED_SOLAR_SAIL_NAME);
  });

  it("fails closed in prepareSolarSail when tarball path is explicitly invalid", async () => {
    await expect(prepareSolarSail({ tarball: join(tempDir, "nonexistent.tgz") })).rejects.toThrow(
      /\[SOLAR_SAIL_PREPARE_FAIL\]/
    );
  });

  it("fails closed in prepareSolarSail when candidate root is missing or unresolvable", async () => {
    const unanchoredDir = join(tempDir, "isolated-studio");
    await mkdir(unanchoredDir, { recursive: true });
    await expect(prepareSolarSail({ studioRoot: unanchoredDir })).rejects.toThrow(
      /\[SOLAR_SAIL_PREPARE_FAIL\] No Solar Sail candidate source available in monorepo packages\/solar-sail or authenticated-inputs\/solar-sail-tarball/
    );
  });

  it("prepares Solar Sail successfully in composed public layout from authenticated tarball", async () => {
    const composedDir = join(tempDir, "composed-studio");
    const authInputsDir = join(composedDir, "authenticated-inputs/solar-sail-tarball");
    const testPayloadDir = join(tempDir, "test-payload");
    const testAdapterDir = join(tempDir, "test-adapter");
    await mkdir(authInputsDir, { recursive: true });
    await writeFile(join(composedDir, "authenticated-inputs/stellar-binding.json"), "{}");

    const realTarball = findCandidateTarball();
    await cp(realTarball, join(authInputsDir, "solar-sail.tgz"));

    const binding = await prepareSolarSail({
      studioRoot: composedDir,
      payloadRoot: testPayloadDir,
      adapterDir: testAdapterDir,
    });

    expect(binding.inventoryDigest).toBe(EXPECTED_SOLAR_SAIL_INVENTORY_DIGEST);
    expect(existsSync(join(testPayloadDir, "solar-sail-binding.json"))).toBe(true);
    expect(existsSync(join(testPayloadDir, "dist/index.js"))).toBe(true);
    expect(existsSync(join(testAdapterDir))).toBe(true);
  });
});
