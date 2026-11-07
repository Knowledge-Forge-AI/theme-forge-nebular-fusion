import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const cleanupFault = { failBackupCleanup: false, failStageCreation: false };
let syncAppearanceAssets: (inputRoot: string, studioRoot: string) => unknown;
let originalRmSync: typeof rmSync;
let originalMkdtempSync: typeof mkdtempSync;
let appearanceSyncFailureDisposition: (error: unknown) => {label: string; exitCode: number};

beforeAll(async () => {
  const fs = (await import("node:fs")).default;
  originalRmSync = fs.rmSync;
  originalMkdtempSync = fs.mkdtempSync;
  fs.mkdtempSync = ((prefix: Parameters<typeof mkdtempSync>[0], options?: Parameters<typeof mkdtempSync>[1]) => {
    if (cleanupFault.failStageCreation && String(prefix).includes(".generated-appearance-stage-")) {
      throw new Error("fault-injected staging unavailable");
    }
    return originalMkdtempSync(prefix, options as never);
  }) as typeof mkdtempSync;
  fs.rmSync = ((path: Parameters<typeof rmSync>[0], options?: Parameters<typeof rmSync>[1]) => {
    if (cleanupFault.failBackupCleanup && String(path).includes(".generated-appearance-backup-")) {
      throw new Error("fault-injected backup cleanup failure");
    }
    return originalRmSync(path, options);
  }) as typeof rmSync;
  syncBuiltinESMExports();
  // @ts-expect-error The focused fixture intentionally consumes the build-owned ESM helper directly.
  ({ syncAppearanceAssets, appearanceSyncFailureDisposition } = await import("../../../../tools/sync-appearance-assets.mjs?appearance-sync-test"));
});

afterAll(async () => {
  const fs = (await import("node:fs")).default;
  fs.rmSync = originalRmSync;
  fs.mkdtempSync = originalMkdtempSync;
  syncBuiltinESMExports();
});

// npm runs this package's tests from its root; the DOM test URL is HTTP.
const root = "src/features/appearance/generated/";
const expectedInventory = "d9f94a7f5ce0730098d840e409ca588caefc2e05c45fbec02d749d25f418fb51";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const temporaryDirectories: string[] = [];
const makeTemporaryDirectory = (prefix: string) => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const writeFixtureMember = (rootDirectory: string, path: string, bytes: Buffer) => {
  const target = join(rootDirectory, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
};

const makeSyncInput = () => {
  const inputRoot = makeTemporaryDirectory("appearance-sync-input-");
  const sourceMembers = new Map<string, Buffer>([
    ["catalog.json", readFileSync(root + "source-catalog.json")],
    ["runtime-baselines.ts", readFileSync(root + "runtime-baselines.ts")],
    ...["terminal-nova", "nebular", "developer", "graphic-designer", "anime", "gamer"].map(id => [id + "/application.css", readFileSync(root + id + ".css")] as const),
    ["unused/extra.css", Buffer.from("unselected source member\n")],
  ]);
  const members = [...sourceMembers].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const inventory = {
    schema: "theme-forge.generated-appearance-inventory.v1",
    members,
    digest: digest("theme-forge.generated-appearance-inventory.v1\n" + JSON.stringify(members, null, 2) + "\n"),
  };
  for (const [path, bytes] of sourceMembers) writeFixtureMember(inputRoot, path, bytes);
  writeFileSync(join(inputRoot, "inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
  return { inputRoot, extraPath: join(inputRoot, "unused/extra.css") };
};

const outputDirectory = (studioRoot: string) => join(studioRoot, "src/features/appearance/generated");
const outputSnapshot = (studioRoot: string) => new Map(readdirSync(outputDirectory(studioRoot)).sort()
  .map(name => [name, readFileSync(join(outputDirectory(studioRoot), name))] as const));
const outputMode = (studioRoot: string) => lstatSync(outputDirectory(studioRoot)).mode & 0o777;

afterEach(() => {
  cleanupFault.failBackupCleanup = false;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bundled appearance provenance", () => {
  it("binds the producer inventory to the reviewed collection", () => {
    const source = JSON.parse(readFileSync(root + "source-inventory.json", "utf8"));
    expect(source.schema).toBe("theme-forge.generated-appearance-inventory.v1");
    expect(source.digest).toBe(expectedInventory);
    expect(digest("theme-forge.generated-appearance-inventory.v1\n" + JSON.stringify(source.members, null, 2) + "\n")).toBe(expectedInventory);
  });

  it("keeps every generated runtime/static input identical to its producer member", () => {
    const source = JSON.parse(readFileSync(root + "source-inventory.json", "utf8"));
    const receipt = JSON.parse(readFileSync(root + "provenance.json", "utf8"));
    expect(receipt.inventoryDigest).toBe(expectedInventory);
    const declared = new Map<string, { bytes: number; sha256: string }>(source.members.map((member: { path: string; bytes: number; sha256: string }) => [member.path, member]));
    expect(receipt.members.some((member: { output: string }) => member.output === "runtime-baselines.ts")).toBe(true);
    expect(receipt.members.some((member: { output: string }) => member.output === receipt.defaultFamily + ".css")).toBe(true);
    for (const member of receipt.members) {
      expect(member.output).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.(css|ts|json)$/);
      expect(lstatSync(root + member.output).isSymbolicLink()).toBe(false);
      const bytes = readFileSync(root + member.output);
      const expected = declared.get(member.producerMember);
      expect(expected).toBeDefined();
      expect(bytes.length).toBe(expected!.bytes);
      expect(digest(bytes)).toBe(expected!.sha256);
      expect(member.sha256).toBe(expected!.sha256);
    }
    const catalogBytes = readFileSync(root + "source-catalog.json");
    const catalog = JSON.parse(String(catalogBytes));
    const index = readFileSync(root + "catalog-index.json");
    const derived = receipt.derivedMembers;
    expect(derived).toEqual([{ producerMember: "catalog.json", sourceSha256: digest(catalogBytes), output: "catalog-index.json",
      transform: "family-index-v1", bytes: index.length, sha256: digest(index) }]);
    expect(JSON.parse(String(index))).toEqual({ schema: "theme-forge.application-appearance-index.v1",
      sourceCatalogSha256: digest(catalogBytes), families: catalog.families.map(({ id, label }: { id: string; label: string }) => ({ id, label })) });
    expect(catalog.families.map((family: { id: string }) => family.id)).toEqual(["terminal-nova", "nebular", "developer", "graphic-designer", "anime", "gamer"]);
  });

  it("validates an unselected inventory member before mutating the target", () => {
    const { inputRoot, extraPath } = makeSyncInput();
    const studioRoot = makeTemporaryDirectory("appearance-sync-studio-");
    syncAppearanceAssets(inputRoot, studioRoot);
    const before = outputSnapshot(studioRoot);
    writeFileSync(extraPath, "corrupt unselected source member\n");

    expect(() => syncAppearanceAssets(inputRoot, studioRoot)).toThrow(/Appearance member mismatch: unused\/extra\.css/);
    expect(outputSnapshot(studioRoot)).toEqual(before);
  });

  it("rejects a runtime baseline mismatch even when its inventory digest is repaired", () => {
    const { inputRoot } = makeSyncInput();
    const studioRoot = makeTemporaryDirectory("appearance-sync-studio-");
    syncAppearanceAssets(inputRoot, studioRoot);
    const before = outputSnapshot(studioRoot);
    const runtimePath = join(inputRoot, "runtime-baselines.ts");
    const runtimeBytes = Buffer.from(String(readFileSync(runtimePath)).replace("#fff8f0", "#000000"));
    writeFileSync(runtimePath, runtimeBytes);
    const inventoryPath = join(inputRoot, "inventory.json");
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const runtimeMember = inventory.members.find((member: { path: string }) => member.path === "runtime-baselines.ts");
    runtimeMember.bytes = runtimeBytes.length;
    runtimeMember.sha256 = digest(runtimeBytes);
    inventory.digest = digest("theme-forge.generated-appearance-inventory.v1\n" + JSON.stringify(inventory.members, null, 2) + "\n");
    writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + "\n");

    expect(() => syncAppearanceAssets(inputRoot, studioRoot)).toThrow(/Runtime baseline does not match projected application CSS/);
    expect(outputSnapshot(studioRoot)).toEqual(before);
  });

  it("refuses stale generated output and preserves existing bytes", () => {
    const { inputRoot } = makeSyncInput();
    const studioRoot = makeTemporaryDirectory("appearance-sync-studio-");
    syncAppearanceAssets(inputRoot, studioRoot);
    const before = outputSnapshot(studioRoot);
    const stalePath = join(outputDirectory(studioRoot), "stale.css");
    writeFileSync(stalePath, "stale output\n");

    expect(() => syncAppearanceAssets(inputRoot, studioRoot)).toThrow(/stale or unknown member: stale\.css/);
    expect(outputSnapshot(studioRoot)).toEqual(new Map([...before, ["stale.css", Buffer.from("stale output\n")]]));
  });

  it("refuses linked and special generated outputs", () => {
    for (const [name, mutate] of [
      ["anime.css", (path: string) => symlinkSync("runtime-baselines.ts", path)] as const,
      ["gamer.css", (path: string) => mkdirSync(path)] as const,
    ]) {
      const { inputRoot } = makeSyncInput();
      const studioRoot = makeTemporaryDirectory("appearance-sync-studio-");
      syncAppearanceAssets(inputRoot, studioRoot);
      const target = join(outputDirectory(studioRoot), name);
      rmSync(target);
      mutate(target);
      expect(() => syncAppearanceAssets(inputRoot, studioRoot)).toThrow(/must be a regular file/);
      expect(lstatSync(target).isSymbolicLink() || lstatSync(target).isDirectory()).toBe(true);
    }
  });

  it("preserves the prior tree when staging cannot start", () => {
    const { inputRoot } = makeSyncInput();
    const studioRoot = makeTemporaryDirectory("appearance-sync-studio-");
    syncAppearanceAssets(inputRoot, studioRoot);
    const before = outputSnapshot(studioRoot);
    cleanupFault.failStageCreation = true;
    try {
      expect(() => syncAppearanceAssets(inputRoot, studioRoot)).toThrow(/staging unavailable/);
    } finally {
      cleanupFault.failStageCreation = false;
    }
    expect(outputSnapshot(studioRoot)).toEqual(before);
  });

  it("preserves an existing target mode and uses 0755 for a new target", () => {
    const { inputRoot } = makeSyncInput();
    const studioRoot = makeTemporaryDirectory("appearance-sync-studio-");
    syncAppearanceAssets(inputRoot, studioRoot);
    expect(outputMode(studioRoot)).toBe(0o755);

    chmodSync(outputDirectory(studioRoot), 0o751);
    syncAppearanceAssets(inputRoot, studioRoot);
    expect(outputMode(studioRoot)).toBe(0o751);
  });

  it("reports committed cleanup failure after installing the replacement", () => {
    const { inputRoot } = makeSyncInput();
    const studioRoot = makeTemporaryDirectory("appearance-sync-studio-");
    syncAppearanceAssets(inputRoot, studioRoot);
    const previousIdentity = lstatSync(outputDirectory(studioRoot)).ino;
    cleanupFault.failBackupCleanup = true;

    let failure: unknown;
    try {
      syncAppearanceAssets(inputRoot, studioRoot);
    } catch (error) {
      failure = error;
    } finally {
      cleanupFault.failBackupCleanup = false;
    }
    expect(appearanceSyncFailureDisposition(failure)).toEqual({ label: "committed-cleanup-failed", exitCode: 2 });
    expect(appearanceSyncFailureDisposition(new Error("withheld private diagnostic"))).toEqual({ label: "synchronization-failed", exitCode: 1 });
    expect(String(failure)).not.toMatch(/prior state preserved/i);
    expect(lstatSync(outputDirectory(studioRoot)).ino).not.toBe(previousIdentity);
  });

  it("refuses family retirement without deleting the existing target", () => {
    const { inputRoot } = makeSyncInput();
    const studioRoot = makeTemporaryDirectory("appearance-sync-studio-");
    syncAppearanceAssets(inputRoot, studioRoot);
    const before = outputSnapshot(studioRoot);
    const catalogPath = join(inputRoot, "catalog.json");
    const catalogBytes = JSON.parse(readFileSync(catalogPath, "utf8"));
    catalogBytes.families = catalogBytes.families.slice(0, -1);
    const replacement = Buffer.from(JSON.stringify(catalogBytes, null, 2) + "\n");
    writeFileSync(catalogPath, replacement);
    const inventoryPath = join(inputRoot, "inventory.json");
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const catalogMember = inventory.members.find((member: { path: string }) => member.path === "catalog.json");
    catalogMember.bytes = replacement.length;
    catalogMember.sha256 = digest(replacement);
    inventory.digest = digest("theme-forge.generated-appearance-inventory.v1\n" + JSON.stringify(inventory.members, null, 2) + "\n");
    writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + "\n");

    expect(() => syncAppearanceAssets(inputRoot, studioRoot)).toThrow(/exact six-family set/);
    expect(outputSnapshot(studioRoot)).toEqual(before);
  });

  it("keeps repeated synchronization deterministic with the exact eleven-file target set", () => {
    const { inputRoot } = makeSyncInput();
    const studioRoot = makeTemporaryDirectory("appearance-sync-studio-");
    const first = syncAppearanceAssets(inputRoot, studioRoot);
    const firstSnapshot = outputSnapshot(studioRoot);
    const second = syncAppearanceAssets(inputRoot, studioRoot);

    expect(second).toEqual(first);
    expect(outputSnapshot(studioRoot)).toEqual(firstSnapshot);
    expect(readdirSync(outputDirectory(studioRoot)).sort()).toEqual([
      "anime.css", "catalog-index.json", "developer.css", "gamer.css", "graphic-designer.css",
      "nebular.css", "provenance.json", "runtime-baselines.ts", "source-catalog.json", "source-inventory.json", "terminal-nova.css",
    ]);
  });
});
