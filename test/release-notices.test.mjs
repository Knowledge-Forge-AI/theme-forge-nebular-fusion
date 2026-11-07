// @vitest-environment node
import { describe, expect, it, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectFrontendSupplementalNotices,
  collectPairedV2SourceNotices,
  generateReleaseNotices,
  renderThirdPartyNoticesJson,
} from "../tools/release-notices.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function resolveNoticeSourceLayout() {
  const candidates = [
    {
      kind: "monorepo",
      root: resolve(TEST_DIR, "../../.."),
      studio: resolve(TEST_DIR, "../../..", "apps/studio"),
      supplemental: resolve(TEST_DIR, "../../..", "apps/studio/legal/supplemental"),
      fixture: resolve(TEST_DIR, "../../..", "packages/stellar-loom/fixture"),
    },
    {
      kind: "publicComposition",
      root: resolve(TEST_DIR, ".."),
      studio: resolve(TEST_DIR, ".."),
      supplemental: resolve(TEST_DIR, "..", "legal/supplemental"),
      fixture: resolve(TEST_DIR, "..", "loom-preview-source"),
    },
  ];
  const matches = candidates.filter((candidate) => (
    existsSync(candidate.studio)
    && existsSync(join(candidate.studio, "package.json"))
    && existsSync(join(candidate.supplemental, "manifest.json"))
    && existsSync(join(candidate.fixture, "package.json"))
    && existsSync(join(candidate.fixture, "package-lock.json"))
    && (candidate.kind === "monorepo"
      ? existsSync(resolve(candidate.root, "apps/studio"))
      : !existsSync(resolve(candidate.root, "apps/studio")))
  ));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one supported notice source layout, found ${matches.length}`);
  }
  return matches[0];
}

const SOURCE_LAYOUT = resolveNoticeSourceLayout();
const SOURCE_STUDIO = SOURCE_LAYOUT.studio;
const SOURCE_SUPPLEMENTAL = SOURCE_LAYOUT.supplemental;
const SOURCE_FIXTURE = SOURCE_LAYOUT.fixture;
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nebular-release-notices-"));
  roots.push(root);
  const studio = SOURCE_LAYOUT.kind === "monorepo" ? join(root, "apps/studio") : root;
  const supplemental = SOURCE_LAYOUT.kind === "monorepo"
    ? join(studio, "legal/supplemental")
    : join(root, "legal/supplemental");
  const fixture = SOURCE_LAYOUT.kind === "monorepo"
    ? join(root, "packages/stellar-loom/fixture")
    : join(root, "loom-preview-source");
  mkdirSync(join(studio, "legal"), { recursive: true });
  cpSync(SOURCE_SUPPLEMENTAL, supplemental, { recursive: true });
  mkdirSync(studio, { recursive: true });
  cpSync(join(SOURCE_STUDIO, "package.json"), join(studio, "package.json"));
  mkdirSync(fixture, { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) cpSync(join(SOURCE_FIXTURE, name), join(fixture, name));
  return { root, studio, supplemental, fixture, manifestPath: join(supplemental, "manifest.json") };
}

function setupPairedV2(fixture) {
  cpSync(join(SOURCE_STUDIO, "legal/paired-v2-sources"), join(fixture.studio, "legal/paired-v2-sources"), { recursive: true });
  const adapter = join(fixture.studio, "src-tauri/solar-sail-adapter");
  mkdirSync(adapter, { recursive: true });
  for (const path of ["common-appearance-recipe.mjs", "common-sttn-template.json"]) {
    cpSync(join(SOURCE_STUDIO, "src-tauri/solar-sail-adapter", path), join(adapter, path));
  }
  return { ...fixture, adapter, paired: join(fixture.studio, "legal/paired-v2-sources") };
}

function mockCargo() {
  return {
    resolve: { root: "root", nodes: [{ id: "root", deps: [] }] },
    packages: [{ id: "root", name: "theme-forge-nebular-fusion", version: "0.7.0" }],
  };
}

function manifestAt(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeManifest(path, manifest) {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("authenticated distributed frontend legal supplements", () => {
  it("joins the current fixture package and lock and renders the four runtime records", () => {
    const { root, studio, supplemental, manifestPath } = setup();
    const manifest = manifestAt(manifestPath);
    const records = collectFrontendSupplementalNotices(studio, root, supplemental, manifest);
    expect(records.map(({ name, version }) => `${name}@${version}`)).toEqual([
      "@astrojs/starlight@0.42.0",
      "@pagefind/default-ui@1.5.2",
      "astro@7.3.3",
      "pagefind@1.5.2",
    ]);
    expect(records.find(({ name }) => name === "@pagefind/default-ui").licenseSourcePackage).toBe("pagefind@1.5.2");
    expect(records.find(({ name }) => name === "@pagefind/default-ui").embeddedProvenance.sourceFiles).toHaveLength(5);
    expect(records.find(({ name }) => name === "@pagefind/default-ui").embeddedProvenance.bundledDependencies.map(({ package: name, version }) => `${name}@${version}`)).toEqual([
      "svelte@4.2.20",
      "bcp-47@2.1.0",
      "is-alphabetical@2.0.1",
      "is-alphanumerical@2.0.1",
      "is-decimal@2.0.1",
    ]);
    const rendered = JSON.parse(renderThirdPartyNoticesJson({ root: { version: "0.7.0" }, frontend: records }));
    expect(rendered.frontend.map(({ name }) => name)).toEqual(["@astrojs/starlight", "@pagefind/default-ui", "astro", "pagefind"]);
    expect(rendered.frontend.every(({ files, hasLicenseText }) => files.length >= 1 && hasLicenseText)).toBe(true);
    expect(rendered.frontend.find(({ name }) => name === "pagefind").files).toContain("npm-frontend/pagefind-1.5.2/mark.js-LICENSE.txt");
    expect(rendered.frontend.find(({ name }) => name === "pagefind").files).toContain("npm-frontend/pagefind-1.5.2/mark.js-MIT.txt");
    expect(rendered.frontend.find(({ name }) => name === "@pagefind/default-ui").files).toEqual(expect.arrayContaining([
      "npm-frontend/pagefind-default-ui-1.5.2/svelte-4.2.20-LICENSE.md",
      "npm-frontend/pagefind-default-ui-1.5.2/bcp-47-2.1.0-license",
      "npm-frontend/pagefind-default-ui-1.5.2/is-alphabetical-2.0.1-license",
      "npm-frontend/pagefind-default-ui-1.5.2/is-alphanumerical-2.0.1-license",
      "npm-frontend/pagefind-default-ui-1.5.2/is-decimal-2.0.1-license",
    ]));
    const markFull = manifest.frontendPackages.find(({ name }) => name === "pagefind").files.find(({ path }) => path.endsWith("mark.js-MIT.txt"));
    expect(markFull.upstream).toEqual({
      package: "mark.js",
      version: "8.11.1",
      repository: "https://github.com/julmot/mark.js",
      revision: "8.11.1",
      path: "LICENSE",
      url: "https://raw.githubusercontent.com/julmot/mark.js/8.11.1/LICENSE",
    });
  });

  it("generates current-product notices from the tracked supplement without installed frontend dependencies", async () => {
    const { studio, root } = setup();
    const output = join(root, "release-notices");
    const cargoMetadata = { resolve: { root: "root", nodes: [{ id: "root", deps: [] }] }, packages: [{ id: "root", name: "theme-forge-nebular-fusion", version: "0.7.0" }] };
    const result = await generateReleaseNotices({
      studioRoot: studio,
      repoRoot: root,
      outDir: output,
      cargoMetadata,
      cargoLockContent: "",
      frontendSupplemental: true,
      allowExternalOutDir: true,
    });
    expect(result.success).toBe(true);
    expect(result.manifest.frontend.map(({ name }) => name)).toEqual(["@astrojs/starlight", "@pagefind/default-ui", "astro", "pagefind"]);
    expect(JSON.parse(readFileSync(join(output, "THIRD-PARTY-NOTICES.json"), "utf8")).frontend).toHaveLength(4);
  });

  it("refuses the current route when the four distributed frontend identities are absent", async () => {
    const { studio, root, manifestPath } = setup();
    const manifest = manifestAt(manifestPath);
    delete manifest.frontendPackages;
    writeManifest(manifestPath, manifest);
    const cargoMetadata = { resolve: { root: "root", nodes: [{ id: "root", deps: [] }] }, packages: [{ id: "root", name: "theme-forge-nebular-fusion", version: "0.7.0" }] };
    await expect(generateReleaseNotices({
      studioRoot: studio,
      repoRoot: root,
      outDir: join(root, "release-notices"),
      cargoMetadata,
      cargoLockContent: "",
      frontendSupplemental: true,
      allowExternalOutDir: true,
    })).rejects.toThrow(/Required distributed frontend runtime identity material is absent/);
  });

  it.each([
    ["missing license bytes", (fixture) => rmSync(join(fixture.supplemental, "frontend/astro-7.3.3/LICENSE")), /is missing/],
    ["missing bundled UI license bytes", (fixture) => rmSync(join(fixture.supplemental, "frontend/pagefind-default-ui-1.5.2/svelte-4.2.20-LICENSE.md")), /is missing/],
    ["tampered license bytes", (fixture) => { const bytes = readFileSync(join(fixture.supplemental, "frontend/astro-7.3.3/LICENSE")); bytes[0] ^= 1; writeFileSync(join(fixture.supplemental, "frontend/astro-7.3.3/LICENSE"), bytes); }, /digest mismatch/],
    ["symlinked license bytes", (fixture) => { rmSync(join(fixture.supplemental, "frontend/astro-7.3.3/LICENSE")); symlinkSync("/etc/hosts", join(fixture.supplemental, "frontend/astro-7.3.3/LICENSE")); }, /symbolic link/],
    ["unknown lock package", (fixture) => { const manifest = manifestAt(fixture.manifestPath); manifest.frontendPackages.push({ ...manifest.frontendPackages[0], name: "unknown-runtime", lockPackagePath: "node_modules/unknown-runtime" }); writeManifest(fixture.manifestPath, manifest); }, /authenticated fixture lock/],
    ["wrong lock identity", (fixture) => { const lock = JSON.parse(readFileSync(join(fixture.fixture, "package-lock.json"), "utf8")); lock.packages["node_modules/astro"].version = "7.3.2"; writeFileSync(join(fixture.fixture, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`); const manifest = manifestAt(fixture.manifestPath); manifest.frontendFixture.lockSha256 = sha256(readFileSync(join(fixture.fixture, "package-lock.json"))); manifest.frontendFixture.lockSize = readFileSync(join(fixture.fixture, "package-lock.json")).length; writeManifest(fixture.manifestPath, manifest); }, /authenticated fixture lock/],
  ])("refuses %s", async (_label, mutate, expected) => {
    const fixture = setup();
    mutate(fixture);
    expect(() => collectFrontendSupplementalNotices(fixture.studio, fixture.root, fixture.supplemental, manifestAt(fixture.manifestPath))).toThrow(expected);
  });
});

describe("first-party paired-v2 source legal attribution", () => {
  it("authenticates the closed source projection and preserves both notice groups", async () => {
    const fixture = setupPairedV2(setup());
    const collected = collectPairedV2SourceNotices(fixture.studio);
    expect(collected.status).toBe("firstparty-unreleased-source-projection");
    expect(collected.groups.map(({ id }) => id)).toEqual(["cttn", "sttn"]);
    expect(collected.groups.find(({ id }) => id === "cttn").projectedFiles).toEqual([
      {
        sourcePath: "tools/appearance-catalog-lib.mjs",
        outputPath: "src-tauri/solar-sail-adapter/common-appearance-recipe.mjs",
        sha256: "4dbd64a4bf1739e3f809c9d5a27e0334d2344140e55e4af25272b5ef9c752f06",
        present: true,
      },
      {
        sourcePath: "tools/source/sttn/v0.4/terminal-nova.theme.json",
        outputPath: "src-tauri/solar-sail-adapter/common-sttn-template.json",
        sha256: "436e278cdbe3a37e06048504df3897d65230318f17b7ebd754060c2866703324",
        present: true,
      },
    ]);
    const output = join(fixture.root, "release-notices");
    const result = await generateReleaseNotices({
      studioRoot: fixture.studio,
      repoRoot: fixture.root,
      outDir: output,
      cargoMetadata: mockCargo(),
      cargoLockContent: "",
      allowExternalOutDir: true,
    });
    const rendered = JSON.parse(readFileSync(join(output, "THIRD-PARTY-NOTICES.json"), "utf8"));
    const renderedMarkdown = readFileSync(join(output, "THIRD-PARTY-NOTICES.md"), "utf8");
    expect(JSON.stringify(rendered)).not.toMatch(/\/Users\/|\/home\/|\/private\//);
    expect(rendered.pairedV2Sources.status).toBe("firstparty-unreleased-source-projection");
    expect(rendered.pairedV2Sources.groups.map(({ id }) => id)).toEqual(["cttn", "sttn"]);
    expect(renderedMarkdown).toContain("## First-Party Paired v2 Source Attribution");
    expect(renderedMarkdown).toContain("https://github.com/Knowledge-Forge-AI/shadcn-theme-terminal-nova");
    expect(renderedMarkdown).not.toMatch(/\/Users\/|\/home\/|\/private\//);
    expect(result.writtenFiles).toEqual(expect.arrayContaining([
      "first-party/paired-v2-sources/manifest.json",
      "first-party/paired-v2-sources/cttn/LICENSE",
      "first-party/paired-v2-sources/cttn/NOTICE",
      "first-party/paired-v2-sources/cttn/COMMERCIAL-LICENSE.md",
      "first-party/paired-v2-sources/sttn/LICENSE",
      "first-party/paired-v2-sources/sttn/NOTICE",
      "first-party/paired-v2-sources/sttn/COMMERCIAL-LICENSE.md",
    ]));
    for (const group of ["cttn", "sttn"]) {
      for (const name of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md"]) {
        expect(readFileSync(join(output, `first-party/paired-v2-sources/${group}/${name}`))).toEqual(
          readFileSync(join(fixture.paired, group, name)),
        );
      }
    }
  });

  it.each([
    ["missing notice", (fixture) => rmSync(join(fixture.paired, "cttn/NOTICE")), /Paired-v2 cttn\/NOTICE/],
    ["tampered notice", (fixture) => writeFileSync(join(fixture.paired, "sttn/LICENSE"), "tampered\n"), /Paired-v2 cttn|sttn\/LICENSE/],
    ["tampered projected source", (fixture) => writeFileSync(join(fixture.adapter, "common-sttn-template.json"), "{}\n"), /projected source digest mismatch/],
    ["tampered source path binding", (fixture) => { const manifest = manifestAt(join(fixture.paired, "manifest.json")); manifest.groups[0].projectedFiles[0].sourcePath = "tools/other.mjs"; writeManifest(join(fixture.paired, "manifest.json"), manifest); }, /projected source path is not the admitted path/],
  ])("refuses %s", (_label, mutate, expected) => {
    const fixture = setupPairedV2(setup());
    mutate(fixture);
    expect(() => collectPairedV2SourceNotices(fixture.studio)).toThrow(expected);
  });

  it("fails closed when a projected source member appears without the manifest", () => {
    const fixture = setup();
    const adapter = join(fixture.studio, "src-tauri/solar-sail-adapter");
    mkdirSync(adapter, { recursive: true });
    cpSync(join(SOURCE_STUDIO, "src-tauri/solar-sail-adapter/common-appearance-recipe.mjs"), join(adapter, "common-appearance-recipe.mjs"));
    expect(() => collectPairedV2SourceNotices(fixture.studio)).toThrow(/manifest is absent/);
  });

  it("keeps legacy fixtures without the source projection unchanged", () => {
    const fixture = setup();
    expect(collectPairedV2SourceNotices(fixture.studio)).toBeNull();
  });
});
