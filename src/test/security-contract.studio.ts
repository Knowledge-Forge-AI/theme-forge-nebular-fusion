// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, relative, resolve } from "node:path";

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

describe("Studio package and authority isolation", () => {
  it("keeps exact independent versions and dependency pins", async () => {
    const appPackage = JSON.parse(await text("package.json")) as Record<string, unknown>;
    const rootPackagePath = existsSync(resolve(repositoryRoot, "authenticated-inputs/core/package.json"))
      ? resolve(repositoryRoot, "authenticated-inputs/core/package.json")
      : resolve(repositoryRoot, "package.json");
    const rootPackage = JSON.parse(await readUtf8(rootPackagePath)) as Record<string, unknown>;
    const tauriConfig = JSON.parse(await text("src-tauri/tauri.conf.json")) as { version: string };
    const cargo = await text("src-tauri/Cargo.toml");

    expect(appPackage.version).toBe("0.2.0");
    expect(appPackage.private).toBe(true);
    expect(rootPackage.version).toBe("0.4.0");
    expect(tauriConfig.version).toBe("0.2.0");
    expect(cargo).toContain('version = "0.2.0"');
    for (const group of [appPackage.dependencies, appPackage.devDependencies] as Array<Record<string, string>>) {
      for (const version of Object.values(group)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
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
      "brand_read.rs": await text("src-tauri/src/commands/brand_read.rs"),
      "brand_plan.rs": await text("src-tauri/src/commands/brand_plan.rs"),
      "host.rs": await text("src-tauri/src/commands/host.rs"),
      "selection.rs": await text("src-tauri/src/commands/selection.rs"),
      "design_packet.rs": await text("src-tauri/src/commands/design_packet.rs"),
      "theme_lab.rs": await text("src-tauri/src/commands/theme_lab.rs"),
      "theme_packet.rs": await text("src-tauri/src/commands/theme_packet.rs"),
    };
    const inventory = [...inventorySource.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]);
    const handlers = [...lib.matchAll(/commands::(?:brand_read|brand_plan|host|selection|design_packet|theme_lab|theme_packet)::([a-z][a-z0-9_]*)/g)].map((match) => match[1]);
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
    ];

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
      "features/theme-lab/builtin-themes.ts",
      "features/theme-lab/request-builders.ts",
      "features/theme-lab/theme-lab-bridge.ts",
      "features/theme-lab/types.ts",
      "fixtures/bootstrap-fixture.ts",
      "fixtures/digest-contract.ts",
      "host/studio-host-bridge.ts",
      "main.tsx",
      "protocol/contracts.ts",
    ]);
    const rustFiles = await maintainedFiles(resolve(appRoot, "src-tauri/src"), [".rs"], [
      "command_inventory.rs",
      "commands/brand_plan.rs",
      "commands/brand_read.rs",
      "commands/host.rs",
      "commands/mod.rs",
      "commands/selection.rs",
      "commands/theme_lab.rs",
      "commands/theme_packet.rs",
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
    ]);
    const frontend = await sourceText(frontendFiles);
    const rust = await sourceText(rustFiles);
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
