import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile, cp, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EXPECTED_LOOM_NAME,
  EXPECTED_LOOM_VERSION,
  SUPPORTED_LOOM_VERSIONS,
  FIXED_97_INVENTORY,
  authenticateCatalogEvidence,
  sha256,
} from "../tools/loom-prepare.mjs";

describe("loom-prepare catalog evidence authentication", () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "loom-prepare-test-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  function createMember(relPath, content) {
    const bytes = Buffer.from(content, "utf8");
    return {
      path: relPath,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content: bytes,
    };
  }

  async function setupMockLoomPackage(options = {}) {
    const pkgRoot = join(tempDir, "package");
    await mkdir(join(pkgRoot, "dist"), { recursive: true });
    await mkdir(join(pkgRoot, "bin"), { recursive: true });

    const members = [];
    const inventory = options.inventory ?? FIXED_97_INVENTORY;
    for (const relPath of inventory) {
      const content = `// ${relPath}\nexport const id = ${JSON.stringify(relPath)};\n`;
      const m = createMember(relPath, content);
      members.push(m);
      const fullPath = join(pkgRoot, m.path);
      await mkdir(join(pkgRoot, m.path.substring(0, m.path.lastIndexOf("/"))), { recursive: true });
      await writeFile(fullPath, m.content);
    }

    const manifest = {
      schema: "tfsl.catalog-build-evidence-v1",
      members: members.map((m) => ({
        path: m.path,
        bytes: m.bytes,
        sha256: m.sha256,
      })),
      sources: [],
    };

    if (options.modifyManifest) {
      options.modifyManifest(manifest);
    }

    if (!options.omitEvidence) {
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
      await writeFile(join(pkgRoot, "dist/catalog-build-evidence.json"), manifestBytes);
    }

    await writeFile(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: options.name ?? EXPECTED_LOOM_NAME,
        version: options.version ?? EXPECTED_LOOM_VERSION,
        type: "module",
        exports: { ".": "./dist/index.js" },
        bin: { tfsl: "./bin/tfsl.js", "tfsl-batch": "./bin/tfsl-batch.js" },
      }, null, 2)
    );

    return { pkgRoot, members, manifest };
  }

  it("exports expected current candidate identities and fixed 97 inventory", () => {
    expect(EXPECTED_LOOM_NAME).toBe("@knowledge-forge-ai/theme-forge-stellar-loom");
    expect(EXPECTED_LOOM_VERSION).toBe("0.1.1");
    expect(SUPPORTED_LOOM_VERSIONS).toContain("0.1.1");
    expect(SUPPORTED_LOOM_VERSIONS).toContain("0.1.0");
    expect(FIXED_97_INVENTORY).toHaveLength(97);
  });

  it("successfully authenticates valid catalog build evidence with exact 97 inventory and official digest", async () => {
    const { pkgRoot } = await setupMockLoomPackage();
    const result = await authenticateCatalogEvidence(pkgRoot);
    expect(result.schema).toBe("tfsl.catalog-build-evidence-v1");
    expect(result.memberCount).toBe(97);
    expect(typeof result.sha256).toBe("string");
    expect(result.sha256).toHaveLength(64);
    expect(result.executableIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("verifies expected catalog evidence SHA-256 when provided by binding", async () => {
    const { pkgRoot } = await setupMockLoomPackage();
    const raw = await readFile(join(pkgRoot, "dist/catalog-build-evidence.json"));
    const expectedSha256 = sha256(raw);

    const result = await authenticateCatalogEvidence(pkgRoot, { sha256: expectedSha256 });
    expect(result.sha256).toBe(expectedSha256);

    // Mismatched expected sha256 throws
    await expect(
      authenticateCatalogEvidence(pkgRoot, { sha256: "0".repeat(64) })
    ).rejects.toThrow(/SHA-256 mismatch/);
  });

  it("rejects missing dist/catalog-build-evidence.json", async () => {
    const { pkgRoot } = await setupMockLoomPackage({ omitEvidence: true });
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /missing required catalog build evidence/
    );
  });

  it("rejects invalid schema in catalog build evidence", async () => {
    const { pkgRoot } = await setupMockLoomPackage({
      modifyManifest: (m) => {
        m.schema = "invalid-schema-v1";
      },
    });
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /invalid schema/
    );
  });

  it("rejects empty members array in catalog build evidence", async () => {
    const { pkgRoot } = await setupMockLoomPackage({
      modifyManifest: (m) => {
        m.members = [];
      },
    });
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /contains no members/
    );
  });

  it("rejects altered member content with digest mismatch", async () => {
    const { pkgRoot } = await setupMockLoomPackage();
    const original = await readFile(join(pkgRoot, "dist/index-catalog.js"), "utf8");
    const tampered = original.replace("dist", "tids");
    await writeFile(join(pkgRoot, "dist/index-catalog.js"), tampered);
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /digest mismatch/
    );
  });

  it("rejects altered member size with size mismatch", async () => {
    const { pkgRoot } = await setupMockLoomPackage();
    // Append extra bytes to alter size
    await writeFile(join(pkgRoot, "dist/batch-catalog.js"), "export const batch = 'ok';\n// extra padding\n");
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /size mismatch/
    );
  });

  it("rejects missing member file listed in catalog build evidence", async () => {
    const { pkgRoot } = await setupMockLoomPackage();
    // Delete one of the member files
    await rm(join(pkgRoot, "bin/tfsl.js"));
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /missing/i
    );
  });

  it("verifies expected executable identity digest when provided by binding", async () => {
    const { pkgRoot } = await setupMockLoomPackage();
    const firstAuth = await authenticateCatalogEvidence(pkgRoot);
    const validDigest = firstAuth.executableIdentityDigest;

    const result = await authenticateCatalogEvidence(pkgRoot, { executableIdentityDigest: validDigest });
    expect(result.executableIdentityDigest).toBe(validDigest);

    // Mismatched expected digest throws
    await expect(
      authenticateCatalogEvidence(pkgRoot, { executableIdentityDigest: "sha256:" + "0".repeat(64) })
    ).rejects.toThrow(/executable identity digest mismatch/i);
  });

  // Adversarial suite
  it("rejects duplicate member path in catalog build evidence", async () => {
    const { pkgRoot } = await setupMockLoomPackage({
      modifyManifest: (m) => {
        m.members.push({ ...m.members[0] });
      },
    });
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /duplicate|member count/i
    );
  });

  it("rejects traversal in member path", async () => {
    const { pkgRoot } = await setupMockLoomPackage({
      modifyManifest: (m) => {
        m.members[0].path = "../outside.js";
      },
    });
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /traversal|invalid/i
    );
  });

  it("rejects symlink leaf in member path", async () => {
    const { pkgRoot } = await setupMockLoomPackage();
    const targetPath = join(pkgRoot, "dist/catalog/index.js");
    const realPath = join(pkgRoot, "dist/catalog/index.real.js");
    await cp(targetPath, realPath);
    await rm(targetPath);
    await symlink(realPath, targetPath);
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /symlink/i
    );
  });

  it("rejects unexpected extra executable file in dist or bin", async () => {
    const { pkgRoot } = await setupMockLoomPackage();
    await writeFile(join(pkgRoot, "dist/unexpected-rogue.js"), "export const rogue = true;\n");
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /inventory.*not match|unexpected/i
    );
  });

  it("rejects NaN or non-finite member bytes in catalog build evidence", async () => {
    const { pkgRoot } = await setupMockLoomPackage({
      modifyManifest: (m) => {
        m.members[0].bytes = NaN;
      },
    });
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /bytes/i
    );
  });

  it("rejects forged self-consistent partial inventory (fewer than 97 members)", async () => {
    const { pkgRoot } = await setupMockLoomPackage({
      modifyManifest: (m) => {
        m.members = m.members.slice(0, 10);
      },
    });
    await expect(authenticateCatalogEvidence(pkgRoot)).rejects.toThrow(
      /member count|inventory/i
    );
  });
});
