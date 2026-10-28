// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile, cp, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inventoryTree } from "../tools/candidate-provenance.mjs";
import {
  EXPECTED_LOOM_NAME,
  EXPECTED_LOOM_VERSION,
  SUPPORTED_LOOM_VERSIONS,
  FIXED_97_INVENTORY,
  FIXED_101_INVENTORY,
  authenticateCatalogEvidence,
  prepareLoom,
  preparePreviewBuild,
  readMemberSafe,
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
    const inventory = options.inventory ?? (options.version === "0.2.0" ? FIXED_97_INVENTORY : FIXED_101_INVENTORY);
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

  it("exports expected current candidate identities and inventories", () => {
    expect(EXPECTED_LOOM_NAME).toBe("@knowledge-forge-ai/theme-forge-stellar-loom");
    expect(EXPECTED_LOOM_VERSION).toBe("0.5.0");
    expect(SUPPORTED_LOOM_VERSIONS).toContain("0.5.0");
    expect(SUPPORTED_LOOM_VERSIONS).toContain("0.4.0");
    expect(SUPPORTED_LOOM_VERSIONS).toContain("0.3.0");
    expect(SUPPORTED_LOOM_VERSIONS).toContain("0.2.0");
    expect(SUPPORTED_LOOM_VERSIONS).toContain("0.1.1");
    expect(SUPPORTED_LOOM_VERSIONS).toContain("0.1.0");
    expect(FIXED_97_INVENTORY).toHaveLength(97);
    expect(FIXED_101_INVENTORY).toHaveLength(101);
  });

  it("treats an empty tarball environment as absent across release, fallback, and gallery routes", async () => {
    const studioRoot = await mkdtemp(join(tmpdir(), "loom-prepare-route-test-"));
    const envNames = [
      "TFSL_LOOM_TARBALL",
      "TFSL_LOOM_SHA256",
      "TFSB_STUDIO_LOOM_TARBALL",
      "TFSB_STUDIO_LOOM_SHA256",
      "TFSL_RELEASE",
      "NODE_ENV",
    ];
    const previousEnvironment = new Map(envNames.map((name) => [name, process.env[name]]));
    try {
      process.env.TFSL_LOOM_TARBALL = "";
      process.env.TFSB_STUDIO_LOOM_TARBALL = "";
      process.env.TFSL_LOOM_SHA256 = "";
      process.env.TFSB_STUDIO_LOOM_SHA256 = "";
      delete process.env.TFSL_RELEASE;
      process.env.NODE_ENV = "test";

      await expect(prepareLoom({ studioRoot, release: true })).rejects.toThrow(
        /Release mode requires explicit exact Loom npm tarball/
      );
      await expect(prepareLoom({ studioRoot, dev: true })).rejects.toThrow(
        /Required Loom development source missing/
      );

      const toolSource = await readFile(fileURLToPath(new URL("../tools/loom-prepare.mjs", import.meta.url)), "utf8");
      expect(toolSource).toContain("if (tarballPath) {");
      expect(toolSource).toContain("if (!tarballPath) {");
      expect(toolSource).not.toContain("galleryTarballPath");
    } finally {
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(studioRoot, { recursive: true, force: true });
    }
  });

  it("successfully authenticates a 0.5.0 catalog with exact 101 inventory and official digest", async () => {
    const { pkgRoot } = await setupMockLoomPackage({ version: "0.5.0" });
    const result = await authenticateCatalogEvidence(pkgRoot);
    expect(result.schema).toBe("tfsl.catalog-build-evidence-v1");
    expect(result.memberCount).toBe(101);
    expect(typeof result.sha256).toBe("string");
    expect(result.sha256).toHaveLength(64);
    expect(result.executableIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects an unsupported package-root version before payload admission", async () => {
    const { pkgRoot } = await setupMockLoomPackage({ version: "0.6.0" });
    const studioRoot = join(tempDir, "unsupported-version-studio");
    await expect(prepareLoom({ studioRoot, packageRoot: pkgRoot, release: true })).rejects.toThrow(
      /Unsupported Loom version '0.6.0'/
    );
  });

  it("successfully authenticates valid catalog build evidence with exact 97 inventory for 0.2.0", async () => {
    const { pkgRoot } = await setupMockLoomPackage({ version: "0.2.0" });
    const result = await authenticateCatalogEvidence(pkgRoot);
    expect(result.schema).toBe("tfsl.catalog-build-evidence-v1");
    expect(result.memberCount).toBe(97);
    expect(typeof result.sha256).toBe("string");
    expect(result.sha256).toHaveLength(64);
    expect(result.executableIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("verifies a 0.5.0 catalog evidence SHA-256 when provided by binding", async () => {
    const { pkgRoot } = await setupMockLoomPackage({ version: "0.5.0" });
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

  it("safely reads authentic member bytes through readMemberSafe", async () => {
    const { pkgRoot } = await setupMockLoomPackage();
    const content = readMemberSafe(pkgRoot, "dist/index-catalog.js");
    expect(content).toBeInstanceOf(Buffer);
    expect(content.toString("utf8")).toContain("dist/index-catalog.js");
  });

  it("structurally eliminates TOCTOU file system race in readMemberSafe", async () => {
    const toolSource = await readFile(fileURLToPath(new URL("../tools/loom-prepare.mjs", import.meta.url)), "utf8");
    const funcMatch = toolSource.match(/export function readMemberSafe[\s\S]*?\n\}/);
    expect(funcMatch).not.toBeNull();
    const funcBody = funcMatch[0];

    // Must use handle-based open with O_NOFOLLOW
    expect(funcBody).toContain("constants.O_RDONLY | constants.O_NOFOLLOW");
    expect(funcBody).toContain("openSync(targetFilePath, constants.O_RDONLY | constants.O_NOFOLLOW)");

    // Must inspect via file descriptor, not re-stat path
    expect(funcBody).toContain("fstatSync(fd)");
    expect(funcBody).toContain("readFileSync(fd)");

    // Must NOT existence-check or lstat the target leaf file before openSync
    expect(funcBody).not.toMatch(/existsSync\s*\(\s*targetFilePath\s*\)/);
    expect(funcBody).not.toMatch(/existsSync\s*\(\s*ancestorPath\s*\)/);
    expect(funcBody).not.toMatch(/lstatSync\s*\(\s*targetFilePath\s*\)/);
    expect(funcBody).not.toMatch(/statSync\s*\(\s*targetFilePath\s*\)/);

    // Loop over parts must only inspect ancestors (parts.length - 1)
    expect(funcBody).toContain("parts.length - 1");
  });
});


describe("source preview authenticated dependency wiring", () => {
  let root;
  let previewRoot;
  let previewModules;
  let expectedIdentity;
  const recipe = "ASTRO_BASE=/preview TFSL_THEME_CSS=./src/styles/neutral.css ASTRO_OUT_DIR=./dist/neutral astro build";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "loom-preview-dependencies-"));
    previewRoot = join(root, "loom-preview-source");
    previewModules = join(root, "dependencies");
    await mkdir(previewRoot);
    await mkdir(join(previewModules, "astro/bin"), { recursive: true });
    await writeFile(join(previewRoot, "package.json"), JSON.stringify({
      scripts: { "build:neutral": recipe }, dependencies: { astro: "7.3.1" },
    }));
    await writeFile(join(previewModules, "astro/package.json"), JSON.stringify({
      name: "astro", version: "7.3.1", bin: { astro: "./bin/astro.mjs" },
    }));
    await writeFile(join(previewModules, "astro/bin/astro.mjs"), "// declared fixture CLI\n");
    expectedIdentity = (await inventoryTree(previewModules)).identity;
  });

  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("stages bin-free dependencies and selects explicit Node/CLI with the exact neutral recipe", async () => {
    const source = await readFile(join(previewModules, "astro/bin/astro.mjs"));
    const result = await preparePreviewBuild({ previewRoot, previewModules, expectedIdentity, nodePath: "/qualified/node" });
    expect(result.command).toBe("/qualified/node");
    expect(result.args).toEqual([join(previewRoot, "node_modules/astro/bin/astro.mjs"), "build"]);
    expect(result.env).toEqual({ ASTRO_BASE: "/preview", TFSL_THEME_CSS: "./src/styles/neutral.css", ASTRO_OUT_DIR: "./dist/neutral" });
    expect(await readFile(result.args[0])).toEqual(source);
    expect(await readFile(join(previewModules, "astro/bin/astro.mjs"))).toEqual(source);
    await expect(readFile(join(previewRoot, "node_modules/.bin/astro"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a product context without the fixture Astro dependency", async () => {
    await rm(join(previewModules, "astro"), { recursive: true });
    expectedIdentity = (await inventoryTree(previewModules)).identity;
    await expect(preparePreviewBuild({ previewRoot, previewModules, expectedIdentity, nodePath: "/qualified/node" })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(previewRoot, "node_modules/astro/package.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a mismatched Astro version before copying", async () => {
    await writeFile(join(previewModules, "astro/package.json"), JSON.stringify({ name: "astro", version: "7.3.0", bin: { astro: "./bin/astro.mjs" } }));
    expectedIdentity = (await inventoryTree(previewModules)).identity;
    await expect(preparePreviewBuild({ previewRoot, previewModules, expectedIdentity, nodePath: "/qualified/node" })).rejects.toThrow(/does not match/);
  });

  it("refuses a changed recipe or lifecycle hook instead of silently skipping it", async () => {
    for (const scripts of [{ "build:neutral": "astro build" }, { "build:neutral": recipe, "prebuild:neutral": "echo hook" }, { "build:neutral": recipe, "postbuild:neutral": "echo hook" }]) {
      await writeFile(join(previewRoot, "package.json"), JSON.stringify({ scripts, dependencies: { astro: "7.3.1" } }));
      await expect(preparePreviewBuild({ previewRoot, previewModules, expectedIdentity, nodePath: "/qualified/node" })).rejects.toThrow(/Unsupported neutral preview recipe/);
    }
  });

  it("refuses an existing destination without replacing its content", async () => {
    await mkdir(join(previewRoot, "node_modules"));
    await writeFile(join(previewRoot, "node_modules/marker"), "preserve");
    await expect(preparePreviewBuild({ previewRoot, previewModules, expectedIdentity, nodePath: "/qualified/node" })).rejects.toThrow(/already exists/);
    expect(await readFile(join(previewRoot, "node_modules/marker"), "utf8")).toBe("preserve");
  });

  it("refuses an alias for the declared Astro entry", async () => {
    await rm(join(previewModules, "astro/bin/astro.mjs"));
    await writeFile(join(root, "outside.mjs"), "// not selected\n");
    await symlink(join(root, "outside.mjs"), join(previewModules, "astro/bin/astro.mjs"));
    await expect(preparePreviewBuild({ previewRoot, previewModules, expectedIdentity, nodePath: "/qualified/node" })).rejects.toThrow(/nonregular inventory member/);
  });

  it("refuses authenticated .bin and .cache content instead of copying it", async () => {
    for (const forbidden of [".bin", ".cache"]) {
      await mkdir(join(previewModules, forbidden));
      await writeFile(join(previewModules, forbidden, "unselected"), "not an executable input");
      expectedIdentity = (await inventoryTree(previewModules)).identity;
      await expect(preparePreviewBuild({ previewRoot, previewModules, expectedIdentity, nodePath: "/qualified/node" })).rejects.toThrow(/bin-free and cache-free/);
      await rm(join(previewModules, forbidden), { recursive: true });
    }
    await expect(readFile(join(previewRoot, "node_modules/astro/package.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a nested directory alias without following its unselected content", async () => {
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "private-marker"), "unselected");
    await symlink(join(root, "outside"), join(previewModules, "nested"));
    await expect(preparePreviewBuild({ previewRoot, previewModules, expectedIdentity, nodePath: "/qualified/node" })).rejects.toThrow(/nonregular inventory member/);
    await expect(readFile(join(previewRoot, "node_modules/nested/private-marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a dependency mutation after authority validation and before staging", async () => {
    await writeFile(join(previewModules, "astro/bin/astro.mjs"), "// changed since authority validation\n");
    await expect(preparePreviewBuild({ previewRoot, previewModules, expectedIdentity, nodePath: "/qualified/node" })).rejects.toThrow(/inventory mismatch/);
    await expect(readFile(join(previewRoot, "node_modules/astro/package.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

});
