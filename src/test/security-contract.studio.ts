// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, relative, resolve } from "node:path";

// @ts-expect-error - JavaScript tool imported into TypeScript suite
import * as candidateVersion from "../../tools/candidate-version.mjs";
// @ts-expect-error - JavaScript tool imported into TypeScript suite
import * as platformTargets from "../../tools/platform-targets.mjs";

const { discoverApplicationSurfaces } = candidateVersion as {
  discoverApplicationSurfaces: (studioRoot: string) => Array<{ id: string; version: string | undefined }>;
};
const { readCandidateVersion } = platformTargets as { readCandidateVersion: (studioRoot: string) => string };

const appRoot = resolve(import.meta.dirname, "../..");
const repositoryRoot = existsSync(resolve(appRoot, "authenticated-inputs/stellar-binding.json")) ? appRoot
  : resolve(appRoot, "../..", "apps/studio") === appRoot ? resolve(appRoot, "../..") : appRoot;
const excludedDirectories = new Set(["generated", "node_modules", "target", "test", "tests", "vendor", "vendored"]);

async function readUtf8(path: string) {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
}

async function text(path: string) {
  return readUtf8(resolve(appRoot, path));
}

async function visitMaintainedFiles(root: string, extensions: ReadonlySet<string>, files: string[]): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`maintained source cannot be a symlink: ${path}`);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) await visitMaintainedFiles(path, extensions, files);
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
}

async function maintainedFiles(root: string, extensions: readonly string[], expected: readonly string[]) {
  const files: string[] = [];
  await visitMaintainedFiles(root, new Set(extensions), files);
  files.sort();
  const relativeFiles = files.map((path) => relative(root, path));
  for (const path of expected) {
    if (!relativeFiles.includes(path)) throw new Error(`missing expected maintained source: ${path}`);
  }
  return files;
}

async function sourceText(files: readonly string[]) {
  return (await Promise.all(files.map(readUtf8))).join("\n");
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readOptional(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// The Nebular application version has one release authority, the studio package.json; every
// application projection (lock, Tauri, Cargo manifest and lock) is discovered by the maintained
// candidate-version surface parser and must agree with it.
function applicationVersionDrift(studioRoot: string) {
  const authority = readCandidateVersion(studioRoot);
  const drift = discoverApplicationSurfaces(studioRoot)
    .filter((surface) => surface.version !== authority)
    .map((surface) => `${surface.id}=${String(surface.version)}`);
  return { authority, drift };
}

// The embedded Stellar Burst core is versioned independently. In the public projection its
// authority is the authenticated binding (package digest and exact package filename); in the
// private workspace it is the Burst root package and its lock.
async function embeddedCoreVersionDrift(root: string) {
  const bindingBytes = await readOptional(resolve(root, "authenticated-inputs/stellar-binding.json"));
  const drift: string[] = [];
  if (bindingBytes) {
    const binding = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bindingBytes)) as {
      input: { packageJsonSha256: string; packageLockSha256: string };
      package: { filename: string };
    };
    const packageBytes = await readFile(resolve(root, "authenticated-inputs/core/package.json"));
    const lockBytes = await readFile(resolve(root, "authenticated-inputs/core/package-lock.json"));
    const core = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packageBytes)) as { name: string; version: string };
    const lock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes)) as { version: string; packages: Record<string, { version?: string }> };
    if (sha256(packageBytes) !== binding.input.packageJsonSha256) drift.push("core/package.json digest");
    if (sha256(lockBytes) !== binding.input.packageLockSha256) drift.push("core/package-lock.json digest");
    if (binding.package.filename !== `knowledge-forge-ai-theme-forge-stellar-burst-${core.version}.tgz`) drift.push(`binding.package.filename=${binding.package.filename}`);
    if (lock.version !== core.version) drift.push(`core/package-lock.json=${lock.version}`);
    if (lock.packages[""]?.version !== core.version) drift.push(`core/package-lock.json#root-package=${String(lock.packages[""]?.version)}`);
    return { name: core.name, version: core.version, drift };
  }
  const core = JSON.parse(await readUtf8(resolve(root, "package.json"))) as { name: string; version: string };
  const lock = JSON.parse(await readUtf8(resolve(root, "package-lock.json"))) as { version: string; packages: Record<string, { version?: string }> };
  if (lock.version !== core.version) drift.push(`package-lock.json=${lock.version}`);
  if (lock.packages[""]?.version !== core.version) drift.push(`package-lock.json#root-package=${String(lock.packages[""]?.version)}`);
  return { name: core.name, version: core.version, drift };
}

async function writeTree(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(resolve(root, path, ".."), { recursive: true });
    await writeFile(resolve(root, path), content);
  }
}

function applicationProjection(version: { app: string; tauri?: string; cargo?: string; cargoLock?: string }) {
  return {
    "package.json": JSON.stringify({ name: "@knowledge-forge-ai/theme-forge-nebular-fusion", version: version.app, private: true }),
    "package-lock.json": JSON.stringify({ version: version.app, packages: { "": { version: version.app } } }),
    "src-tauri/tauri.conf.json": JSON.stringify({ version: version.tauri ?? version.app }),
    "src-tauri/Cargo.toml": `[package]\nname = "theme-forge-nebular-fusion"\nversion = "${version.cargo ?? version.app}"\n\n[dependencies]\nserde = { version = "1.0.0" }\n`,
    "src-tauri/Cargo.lock": `[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "theme-forge-nebular-fusion"\nversion = "${version.cargoLock ?? version.app}"\n`,
  };
}

describe("Studio package and authority isolation", () => {
  it("keeps exact independent versions and dependency pins", async () => {
    const appPackage = JSON.parse(await text("package.json")) as Record<string, unknown>;
    const application = applicationVersionDrift(appRoot);
    const core = await embeddedCoreVersionDrift(repositoryRoot);

    expect(application.drift).toEqual([]);
    expect(application.authority).toMatch(EXACT_VERSION);
    expect(appPackage.version).toBe(application.authority);
    expect(appPackage.private).toBe(true);
    expect(core.name).toBe("@knowledge-forge-ai/theme-forge-stellar-burst");
    expect(core.drift).toEqual([]);
    expect(core.version).toMatch(EXACT_VERSION);
    for (const group of [appPackage.dependencies, appPackage.devDependencies] as Array<Record<string, string>>) {
      for (const version of Object.values(group)) expect(version).toMatch(EXACT_VERSION);
    }
  });

  it("derives version agreement from the maintained authorities instead of copied literals", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "tfsb-version-authority-"));
    try {
      const consistent = resolve(root, "consistent");
      await writeTree(consistent, applicationProjection({ app: "9.9.9" }));
      expect(applicationVersionDrift(consistent)).toEqual({ authority: "9.9.9", drift: [] });

      const tauriDrift = resolve(root, "tauri-drift");
      await writeTree(tauriDrift, applicationProjection({ app: "9.9.9", tauri: "9.9.8" }));
      expect(applicationVersionDrift(tauriDrift).drift).toEqual(["studio-tauri.conf.json=9.9.8"]);

      const cargoDrift = resolve(root, "cargo-drift");
      await writeTree(cargoDrift, applicationProjection({ app: "9.9.9", cargo: "9.9.8", cargoLock: "9.9.7" }));
      expect(applicationVersionDrift(cargoDrift).drift).toEqual(["studio-Cargo.toml=9.9.8", "studio-Cargo.lock=9.9.7"]);

      const corePackage = JSON.stringify({ name: "@knowledge-forge-ai/theme-forge-stellar-burst", version: "4.5.6" });
      const coreLock = JSON.stringify({ version: "4.5.6", packages: { "": { version: "4.5.6" } } });
      const binding = (filename: string) => JSON.stringify({
        input: { packageJsonSha256: sha256(new TextEncoder().encode(corePackage)), packageLockSha256: sha256(new TextEncoder().encode(coreLock)) },
        package: { filename },
      });
      const boundCore = resolve(root, "bound-core");
      await writeTree(boundCore, {
        "authenticated-inputs/stellar-binding.json": binding("knowledge-forge-ai-theme-forge-stellar-burst-4.5.6.tgz"),
        "authenticated-inputs/core/package.json": corePackage,
        "authenticated-inputs/core/package-lock.json": coreLock,
      });
      expect(await embeddedCoreVersionDrift(boundCore)).toEqual({ name: "@knowledge-forge-ai/theme-forge-stellar-burst", version: "4.5.6", drift: [] });

      const unboundCore = resolve(root, "unbound-core");
      await writeTree(unboundCore, {
        "authenticated-inputs/stellar-binding.json": binding("knowledge-forge-ai-theme-forge-stellar-burst-4.5.5.tgz"),
        "authenticated-inputs/core/package.json": corePackage.replace("4.5.6", "4.5.7"),
        "authenticated-inputs/core/package-lock.json": coreLock,
      });
      expect((await embeddedCoreVersionDrift(unboundCore)).drift).toEqual([
        "core/package.json digest",
        "binding.package.filename=knowledge-forge-ai-theme-forge-stellar-burst-4.5.5.tgz",
        "core/package-lock.json=4.5.6",
        "core/package-lock.json#root-package=4.5.6",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds fixtures to the canonical protocol inventories", async () => {
    const fixtureSource = await text("src/fixtures/bootstrap-fixture.ts");
    for (const [name, expected] of [
      ["inventory.json", "96fdbcf0c56c1890d44363c34c80d8dacfccb37196de8050ab2d1afc7a3e0f70"],
      ["inventory-1.1.json", "9d58e954e62169e87648814372a381653e9e69df5a0ce722251e6e46951dfe8a"],
    ] as const) {
      const bytes = await readFile(resolve(repositoryRoot, "protocol/tfsb-studio-v1", name));
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(digest).toBe(expected);
      expect(fixtureSource).toContain(`sha256:${expected}`);
    }
  });

  it("binds invoke handler, app manifest, generated permissions, and main capability to one inventory", async () => {
    const config = JSON.parse(await text("src-tauri/tauri.conf.json")) as {
      app: { windows: Array<{ label?: string; url?: string }>; withGlobalTauri: boolean; security: { csp: string } };
      plugins?: unknown;
    };
    const capability = JSON.parse(await text("src-tauri/capabilities/main.json")) as {
      local: boolean;
      windows: string[];
      webviews?: string[];
      permissions: string[];
    };
    const inventorySource = await text("src-tauri/src/command_inventory.rs");
    const buildScript = await text("src-tauri/build.rs");
    const lib = await text("src-tauri/src/lib.rs");
    const rustCommandSources: Record<string, string> = {
      "scene.rs": await text("src-tauri/src/commands/scene.rs"),
      "scene_packet.rs": await text("src-tauri/src/commands/scene_packet.rs"),
      "brand_read.rs": await text("src-tauri/src/commands/brand_read.rs"),
      "brand_plan.rs": await text("src-tauri/src/commands/brand_plan.rs"),
      "host.rs": await text("src-tauri/src/commands/host.rs"),
      "selection.rs": await text("src-tauri/src/commands/selection.rs"),
      "design_packet.rs": await text("src-tauri/src/commands/design_packet.rs"),
      "theme_lab.rs": await text("src-tauri/src/commands/theme_lab.rs"),
      "theme_packet.rs": await text("src-tauri/src/commands/theme_packet.rs"),
      "app_theme.rs": await text("src-tauri/src/commands/app_theme.rs"),
    };
    const inventory = [...inventorySource.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]);
    const handlers = [...lib.matchAll(/commands::(?:brand_read|brand_plan|host|selection|design_packet|theme_lab|theme_packet|scene|scene_packet|app_theme)::([a-z][a-z0-9_]*)/g)].map((match) => match[1]);
    const expectedPermissions = inventory.map((command) => `allow-${command?.replaceAll("_", "-")}`);
    const generatedDirectory = resolve(appRoot, "src-tauri/permissions/autogenerated");
    const generatedFiles = (await readdir(generatedDirectory)).filter((path) => path.endsWith(".toml")).sort();
    const generated = await Promise.all(generatedFiles.map((path) => readUtf8(resolve(generatedDirectory, path))));

    const baseCommands = [
      "studio_brand_read",
      "studio_brand_plan_start",
      "studio_brand_plan_cancel",
      "studio_host_start",
      "studio_host_status",
      "studio_select_project",
      "studio_select_source",
      "studio_host_shutdown",
      "studio_design_packet_import",
      "studio_design_packet_export",
      "studio_theme_lab_status",
      "studio_theme_lab_compile",
      "studio_theme_lab_example",
      "studio_theme_lab_open",
      "studio_theme_lab_save",
      "studio_theme_lab_dispose",
      "studio_theme_lab_draft_update",
      "studio_theme_brief_create",
      "studio_theme_packet_import",
      "studio_theme_packet_export",
      "studio_theme_review_create",
      "studio_theme_candidate_adopt",
    ];
    const expectedInventory = [
      ...baseCommands,
      "studio_theme_candidate_verify",
      "studio_theme_review_validate",
      "studio_scene_new",
      "studio_scene_status",
      "studio_scene_dispose",
      "studio_scene_open",
      "studio_scene_import_svg",
      "studio_scene_edit",
      "studio_scene_compile",
      "studio_scene_save_plan",
      "studio_scene_save_apply",
      "studio_scene_export_plan",
      "studio_scene_export_apply",
      "studio_scene_bind_tokens",
      "studio_scene_brief_create",
      "studio_scene_packet_import",
      "studio_scene_packet_export",
      "studio_scene_review_create",
      "studio_scene_candidate_verify",
      "studio_scene_candidate_adopt",
      "studio_app_theme_status",
      "studio_app_theme_compile",
      "studio_app_theme_paired_compile",
      "studio_app_theme_open_profile",
      "studio_app_theme_save_profile",
      "studio_app_theme_export_package",
      "studio_app_theme_reset",
    ];

    expect(new Set(inventory).size).toBe(inventory.length);
    const sceneBridge = await text("src/features/vector-graphics/vector-graphics-bridge.ts");
    const sceneNames = [...sceneBridge.matchAll(/"(studio_scene_[a-z_]+)"/g)].map(match => match[1]);
    expect([...sceneNames].sort()).toEqual(inventory.filter(name => name?.startsWith("studio_scene_")).sort());
    expect(inventory).toEqual(expectedInventory);
    expect(handlers).toEqual(inventory);
    for (const command of inventory) expect(Object.values(rustCommandSources).join("\n")).toContain(`fn ${command}(`);
    expect(buildScript).toContain("tauri_build::try_build");
    expect(buildScript).toContain("AppManifest::new().commands(command_inventory::STUDIO_COMMAND_NAMES)");
    expect(capability.permissions).toEqual(expectedPermissions);
    expect(generated).toHaveLength(inventory.length);
    for (const [index, command] of inventory.entries()) {
      expect(generated.join("\n")).toContain(`identifier = "allow-${command?.replaceAll("_", "-")}"`);
      expect(generated.join("\n")).toContain(`allow = ["${command}"]`);
      expect(generatedFiles.some((path) => basename(path, ".toml") === command)).toBe(true);
      expect(expectedPermissions[index]).not.toContain(":default");
    }
    expect(config.app.windows).toEqual([expect.objectContaining({ label: "main" })]);
    expect(config.app.windows[0]?.url).toBeUndefined();
    expect(config.app.withGlobalTauri).toBe(false);
    expect(config.plugins).toBeUndefined();
    expect(capability).toEqual(expect.objectContaining({ local: true, windows: ["main"] }));
    expect(capability.webviews).toBeUndefined();
    expect(capability.permissions).not.toContain("default");
    expect(capability.permissions.join("\n")).not.toMatch(/:|plugin|\*/);
  });

  it("uses the exact base CSP and no global or remote navigation authority", async () => {
    // The /preview/ response adjustment is exercised by the Rust preview_csp
    // tests against this config; this assertion pins the unmodified base policy.
    const config = JSON.parse(await text("src-tauri/tauri.conf.json")) as {
      app: { windows: Array<{ label: string; url?: string }>; withGlobalTauri: boolean; security: { csp: string } };
    };
    expect(config.app.security.csp).toBe("default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    expect(config.app.security.csp).not.toMatch(/data:|'unsafe-inline'|'unsafe-eval'|https:|\*/);
    expect(config.app.windows).toHaveLength(1);
    expect(config.app.windows[0]?.url).toBeUndefined();
    expect(config.app.withGlobalTauri).toBe(false);
  });

  it("keeps the live Studio architecture on the accepted same-repository phase sequence", async () => {
    const architecture = await readUtf8(resolve(repositoryRoot, "docs/architecture/v0.4-studio-tauri-integration.md"));
    const brandArchitecture = await readUtf8(resolve(repositoryRoot, "docs/architecture/v0.4-brand-systems.md"));
    expect(architecture).toContain("Current in-repository architecture under ADR 0018");
    expect(architecture).toContain("TFSB47H bootstrap hardening");
    expect(architecture).toMatch(/TFSB51 attended\s+publication/);
    expect(architecture).not.toMatch(/future, separate TFSB Studio|TFSB40 supplies no Tauri/);
    expect(brandArchitecture).not.toContain("Studio app code in this repository");
  });

  it("recursively scans maintained frontend and Rust source with closed exclusions", async () => {
    const frontendFiles = await maintainedFiles(resolve(appRoot, "src"), [".ts", ".tsx"], [
      "app/App.tsx",
      "brand-plans/StudioBrandPlanClient.ts",
      "brand-plans/contracts.ts",
      "brand-plans/validators.ts",
      "brand-read/StudioBrandReadClient.ts",
      "brand-read/blob-manager.ts",
      "brand-read/tauri-brand-read-client.ts",
      "brand-read/validators.ts",
      "features/brand-plans/ConsumerPlanForm.tsx",
      "features/brand-plans/ConsumerPlanReview.tsx",
      "features/brand-plans/DerivePlanForm.tsx",
      "features/brand-plans/DerivePlanReview.tsx",
      "features/brand-plans/ExportPlanForm.tsx",
      "features/brand-plans/ExportPlanReview.tsx",
      "features/brand-plans/PlanConfirmation.tsx",
      "features/brand-plans/PlanProgress.tsx",
      "features/brand-plans/PlanWorkspace.tsx",
      "features/brand-plans/QaBaselinePlanReview.tsx",
      "features/brand-plans/plan-state.ts",
      "features/brand-plans/plan-effect.ts",
      "features/brand-workbench/BrandWorkbench.tsx",
      "features/brand-workbench/ConsumerView.tsx",
      "features/brand-workbench/ExportView.tsx",
      "features/brand-workbench/FamiliesView.tsx",
      "features/brand-workbench/OverviewView.tsx",
      "features/brand-workbench/QaView.tsx",
      "features/brand-workbench/RecipesView.tsx",
      "features/brand-workbench/SemanticDiffView.tsx",
      "features/brand-workbench/TokensView.tsx",
      "features/brand-workbench/VisualEvidencePanel.tsx",
      "features/brand-workbench/workbench-state.ts",
      "features/candidate-review/CandidateReview.tsx",
      "features/diagnostics/Diagnostics.tsx",
      "features/theme-lab/SenderEvidenceImage.tsx",
      "features/theme-lab/StarlightPreview.tsx",
      "features/theme-lab/ThemeLab.tsx",
      "features/theme-lab/ThemeV2Controls.tsx",
      "features/theme-lab/ThemeV2Exchange.tsx",
      "features/theme-lab/gallery-contract.ts",
      "features/theme-lab/v2-bridge.ts",
      "features/theme-lab/v2-exchange.ts",
      "features/theme-lab/v2-model.ts",
      "features/theme-lab/builtin-themes.ts",
      "features/theme-lab/request-builders.ts",
      "features/theme-lab/theme-lab-bridge.ts",
      "features/theme-lab/types.ts",
      "features/application-theme/ApplicationPreview.tsx",
      "features/application-theme/ApplicationThemeLab.tsx",
      "features/application-theme/app-theme-bridge.ts",
      "features/application-theme/builtin-profiles.ts",
      "features/application-theme/index.ts",
      "features/application-theme/types.ts",
      "features/vector-graphics/blob-preview.ts",
      "features/vector-graphics/components/ActionToolbar.tsx",
      "features/vector-graphics/components/ArtboardControls.tsx",
      "features/vector-graphics/components/CanvasPreview.tsx",
      "features/vector-graphics/components/ExchangePanel.tsx",
      "features/vector-graphics/components/LayerList.tsx",
      "features/vector-graphics/components/LayoutEditor.tsx",
      "features/vector-graphics/components/PresentationEditor.tsx",
      "features/vector-graphics/components/ShapeInspector.tsx",
      "features/vector-graphics/components/TransformEditor.tsx",
      "features/vector-graphics/components/VectorGraphicsLab.tsx",
      "features/vector-graphics/edit-queue.ts",
      "features/vector-graphics/index.ts",
      "features/vector-graphics/mock-bridge.ts",
      "features/vector-graphics/request-builders.ts",
      "features/vector-graphics/types.ts",
      "features/vector-graphics/vector-graphics-bridge.ts",
      "fixtures/bootstrap-fixture.ts",
      "fixtures/digest-contract.ts",
      "host/studio-host-bridge.ts",
      "main.tsx",
      "protocol/contracts.ts",
    ]);
    const nativeInventory = JSON.parse(await text("native-source-inventory.json")) as { files: string[] };
    expect(nativeInventory.files).toHaveLength(71);
    const rustFiles = await maintainedFiles(resolve(appRoot, "src-tauri/src"), [".rs"], nativeInventory.files);
    const galleryFiles = await maintainedFiles(resolve(appRoot, "gallery"), [".mjs"], ["bridge-runtime.mjs"]);
    const galleryRuntime = await sourceText(galleryFiles);
    expect(galleryRuntime).not.toMatch(/child_process|node:fs|fetch\s*\(|new Function|eval\s*\(/);
    expect(await text("gallery/fixtures/consumer/src/content/docs/catalog/preview.mdx")).toContain('title="preview.ts"');
    const frontend = await sourceText(frontendFiles);
    // Match the Rust policy owner: test-only modules are not production authority.
    const rust = (await Promise.all(rustFiles.filter(path => !/(?:^|\/)(?:tests|[^/]*_tests)\.rs$/.test(path)).map(async path => (await readUtf8(path)).split(path.includes("/scene/") || path.endsWith("/state/scene.rs") ? "\n#[cfg(test)]\nmod " : "#[cfg(test)]")[0]))).join("\n");
    const buildScript = await text("src-tauri/build.rs");

    expect(frontend).not.toMatch(/src\/brand|child_process|node:fs|@tauri-apps\/plugin|openai|anthropic|provider|model SDK/i);
    expect(frontend).not.toMatch(/window\.__TAURI__|dangerouslySetInnerHTML|invoke\s*\(\s*commandName/);
    expect(frontend).not.toMatch(/SafeReadValue|ReadDocument|findString|findTaggedId/);
    expect(rust).not.toMatch(/\bunsafe\b|\bextern\s+"C"|serde_json::Value|Arc\s*<\s*Mutex|\.unwrap\(|\.expect\(|panic!|todo!|unimplemented!/);
    expect(await text("src-tauri/src/sidecar/process.rs")).toContain("Command::new(&verified.binary)");
    expect(await text("src-tauri/src/sidecar/process.rs")).toContain(".env_clear()");
    expect(await text("src-tauri/src/sidecar/artifact.rs")).toContain("fs::symlink_metadata");
    expect(await text("src-tauri/src/commands/brand_read.rs")).not.toMatch(/serde_json::Value|JsonNode/);
    expect(buildScript).not.toMatch(/std::fs|Command::new|reqwest|plugin\(|\.unwrap\(|\.expect\(|panic!/);
    expect(await text("native/macos/README.md")).toContain("documentation-only escape seam");
  });

  it("fails closed for a synthetic forbidden file, missing expected file, and invalid UTF-8", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "tfsb-studio-policy-"));
    const sourceRoot = resolve(root, "src");
    await mkdir(resolve(sourceRoot, "nested"), { recursive: true });
    await writeFile(resolve(sourceRoot, "app.ts"), "export const safe = true;\n");
    await writeFile(resolve(sourceRoot, "nested/escape.ts"), "import { readFile } from 'node:fs';\n");
    const files = await maintainedFiles(sourceRoot, [".ts"], ["app.ts"]);
    expect(await sourceText(files)).toContain("node:fs");
    await expect(maintainedFiles(sourceRoot, [".ts"], ["missing.ts"])).rejects.toThrow("missing expected");
    await writeFile(resolve(sourceRoot, "nested/invalid.ts"), new Uint8Array([0xff]));
    const filesWithInvalid = await maintainedFiles(sourceRoot, [".ts"], ["app.ts"]);
    await expect(sourceText(filesWithInvalid)).rejects.toThrow();
    await rm(root, { recursive: true });
  });

  it("proves mechanical set difference between unified native inventory and historical frontend list", async () => {
    const historicalFrontendExpected = [
      "command_inventory.rs",
      "commands/brand_plan.rs",
      "commands/brand_read.rs",
      "commands/host.rs",
      "commands/mod.rs",
      "commands/selection.rs",
      "commands/theme_lab.rs",
      "commands/theme_packet.rs",
      "commands/scene.rs",
      "commands/scene_packet.rs",
      "scene/exchange.rs",
      "scene/io.rs",
      "scene/mod.rs",
      "scene/protocol_dto.rs",
      "scene/runner.rs",
      "scene/session.rs",
      "scene/tests.rs",
      "scene/types.rs",
      "sidecar/scene_artifact.rs",
      "state/scene.rs",
      "state/scene_tokens.rs",
      "errors.rs",
      "lib.rs",
      "main.rs",
      "sidecar/artifact.rs",
      "sidecar/brand_protocol.rs",
      "sidecar/brand_types/common.rs",
      "sidecar/brand_types/consumer_export.rs",
      "sidecar/brand_types/diff.rs",
      "sidecar/brand_types/family.rs",
      "sidecar/brand_types/mod.rs",
      "sidecar/brand_types/plan_summaries.rs",
      "sidecar/brand_types/qa.rs",
      "sidecar/brand_types/raster_plan_descriptor.rs",
      "sidecar/brand_types/status.rs",
      "sidecar/brand_types/token_recipe.rs",
      "sidecar/coordinator.rs",
      "sidecar/error_registry.rs",
      "sidecar/framing.rs",
      "sidecar/mod.rs",
      "sidecar/plan_protocol.rs",
      "sidecar/plan_transport.rs",
      "sidecar/process.rs",
      "sidecar/protocol.rs",
      "sidecar/supervisor.rs",
      "sidecar/supervisor/plan.rs",
      "sidecar/supervisor/plan_tests.rs",
      "sidecar/supervisor/tests.rs",
      "sidecar/visual_evidence.rs",
      "state/host.rs",
      "state/mod.rs",
      "state/plan_coordinator.rs",
      "state/plan_coordinator_tests.rs",
      "state/theme_lab.rs",
      "theme_lab/mod.rs",
      "theme_lab/runner.rs",
      "theme_lab/types.rs",
      "theme_lab/v2_types.rs",
      "theme_lab/validation.rs",
    ];
    const inventory = JSON.parse(await text("native-source-inventory.json")) as { files: string[] };
    const historicalSet = new Set(historicalFrontendExpected);
    const unifiedSet = new Set(inventory.files);

    // Reconciles the historical asymmetry: includes theme_lab/smoke_selection.rs AND sidecar/json_decoder.rs
    const added = [...unifiedSet].filter((f) => !historicalSet.has(f)).sort();
    expect(added).toEqual([
      "app_theme/mod.rs",
      "app_theme/runner.rs",
      "app_theme/types.rs",
      "commands/app_theme.rs",
      "commands/design_packet.rs",
      "design_evidence/io.rs",
      "design_evidence/mod.rs",
      "design_evidence/types.rs",
      "design_evidence/validate.rs",
      "sidecar/json_decoder.rs",
      "state/app_theme.rs",
      "theme_lab/smoke_selection.rs",
    ]);

    const removed = [...historicalSet].filter((f) => !unifiedSet.has(f));
    expect(removed).toEqual([]);

    expect(historicalSet.size).toBe(59);
    expect(unifiedSet.size).toBe(71);
    expect(added).toHaveLength(12);
  });

  it("keeps generated application output excluded from Git and root packaging", async () => {
    const ignore = await readUtf8(resolve(repositoryRoot, ".gitignore"));
    const studioIgnore = await text(".gitignore");
    const rootPackage = await readUtf8(resolve(repositoryRoot, "package.json"));
    expect(ignore).toContain("dist/");
    expect(ignore).toContain("target/");
    expect(studioIgnore).toContain("src-tauri/gen/");
    expect(rootPackage).not.toContain("apps/studio");
    expect(rootPackage).not.toContain("workspaces");
  });
});
