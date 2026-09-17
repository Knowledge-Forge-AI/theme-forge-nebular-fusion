import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
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
  sha256Hex,
} from "../tools/solar-sail-prepare.mjs";

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

  it("authenticates the authentic Solar Sail payload in apps/studio/src-tauri against expected digest", async () => {
    const realPayload = resolve(__dirname, "../src-tauri/solar-sail-payload");
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
});
