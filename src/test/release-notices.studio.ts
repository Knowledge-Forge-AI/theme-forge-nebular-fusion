// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error - JavaScript tool imported into TypeScript suite
import * as releaseNotices from "../../tools/release-notices.mjs";

const {
  STUDIO_ROOT,
  DEFAULT_OUTPUT_DIR,
  TARGET_PLATFORM,
  normalizeSafeRelativePath,
  joinSafeRelative,
  parseCargoLockChecksums,
  resolveReachableCrates,
  isLicenseOrNoticeFileName,
  inventoryPackageLicenses,
  collectRootNotices,
  collectNpmDistributedNotices,
  renderThirdPartyNoticesJson,
  renderThirdPartyNoticesMarkdown,
  generateReleaseNotices,
} = releaseNotices as any;

interface ResolvedCrate {
  id: string;
  name: string;
  version: string;
  license: string | null;
  isProcMacro: boolean;
}

describe("release-notices standalone legal notices generator", () => {
  describe("path safety and escaping path rejection", () => {
    it("accepts valid, normalized relative paths", () => {
      expect(normalizeSafeRelativePath("crates/base64-0.22.1/LICENSE-MIT")).toBe(
        "crates/base64-0.22.1/LICENSE-MIT",
      );
      expect(normalizeSafeRelativePath("npm/react-19.2.8/LICENSE")).toBe(
        "npm/react-19.2.8/LICENSE",
      );
      expect(normalizeSafeRelativePath("root/COMMERCIAL-LICENSE.md")).toBe(
        "root/COMMERCIAL-LICENSE.md",
      );
      expect(normalizeSafeRelativePath("THIRD-PARTY-NOTICES.json")).toBe(
        "THIRD-PARTY-NOTICES.json",
      );
    });

    it("rejects path traversal attempts with '..'", () => {
      expect(() => normalizeSafeRelativePath("../secret.txt")).toThrow(/traversal/i);
      expect(() => normalizeSafeRelativePath("crates/../../etc/passwd")).toThrow(/traversal/i);
      expect(() => normalizeSafeRelativePath("..")).toThrow(/traversal/i);
      expect(() => normalizeSafeRelativePath("a/b/../c")).toThrow(/traversal/i);
    });

    it("rejects absolute paths", () => {
      expect(() => normalizeSafeRelativePath("/etc/passwd")).toThrow(/absolute/i);
      expect(() => normalizeSafeRelativePath("/fixture-absolute/secret")).toThrow(/absolute/i);
      expect(() => normalizeSafeRelativePath("C:/Windows/System32")).toThrow(/absolute/i);
    });

    it("rejects backslashes and null bytes", () => {
      expect(() => normalizeSafeRelativePath("crates\\bad\\path")).toThrow(/backslash/i);
      expect(() => normalizeSafeRelativePath("crates/bad\0path")).toThrow(/null byte/i);
    });

    it("rejects empty paths or segments with dangerous characters", () => {
      expect(() => normalizeSafeRelativePath("")).toThrow(/non-empty/i);
      expect(() => normalizeSafeRelativePath("crates/bad$name")).toThrow(/invalid characters/i);
      expect(() => normalizeSafeRelativePath("crates/bad;name")).toThrow(/invalid characters/i);
      expect(() => normalizeSafeRelativePath("crates/bad name")).toThrow(/invalid characters/i);
    });

    it("joinSafeRelative strictly keeps paths within base directory", () => {
      const base = "/virtual/base/directory";
      const resolved = joinSafeRelative(base, "crates/tokio-1.43.0/LICENSE");
      expect(resolved).toBe(resolve(base, "crates/tokio-1.43.0/LICENSE"));
      expect(resolved.startsWith(base)).toBe(true);

      expect(() => joinSafeRelative(base, "../escaped")).toThrow();
    });
  });

  describe("Cargo.lock checksum parser", () => {
    it("extracts checksums for declared packages", () => {
      const sampleLock = [
        "version = 4",
        "",
        "[[package]]",
        'name = "base64"',
        'version = "0.22.1"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "72b3254f16251a8381aa12e40e3c4d2f0199f8c6508fbecb9d91f575e0fbb8c6"',
        "",
        "[[package]]",
        'name = "serde"',
        'version = "1.0.218"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "e8dfc9d2b13a21e7d088463f9153e65860b36349349eeb170772e1b0d2350fb5"',
        "",
        "[[package]]",
        'name = "local-crate"',
        'version = "0.1.0"',
      ].join("\n");

      const map = parseCargoLockChecksums(sampleLock) as Map<string, string>;
      expect(map.get("base64@0.22.1")).toBe("72b3254f16251a8381aa12e40e3c4d2f0199f8c6508fbecb9d91f575e0fbb8c6");
      expect(map.get("serde@1.0.218")).toBe("e8dfc9d2b13a21e7d088463f9153e65860b36349349eeb170772e1b0d2350fb5");
      expect(map.has("local-crate@0.1.0")).toBe(false);
    });

    it("handles empty or invalid lock text gracefully", () => {
      expect((parseCargoLockChecksums("") as Map<string, string>).size).toBe(0);
      expect((parseCargoLockChecksums(undefined as unknown as string) as Map<string, string>).size).toBe(0);
    });
  });

  describe("cargo metadata reachable dependencies traversal", () => {
    const mockMetadata = {
      resolve: {
        root: "app-root@0.3.0",
        nodes: [
          {
            id: "app-root@0.3.0",
            deps: [
              { name: "crate-normal", pkg: "crate-normal@1.0.0", dep_kinds: [{ kind: null }] },
              { name: "crate-build", pkg: "crate-build@2.0.0", dep_kinds: [{ kind: "build" }] },
              { name: "crate-proc-macro", pkg: "crate-proc-macro@0.5.0", dep_kinds: [{ kind: "build" }] },
              { name: "crate-dev-only", pkg: "crate-dev-only@9.9.9", dep_kinds: [{ kind: "dev" }] },
            ],
          },
          {
            id: "crate-normal@1.0.0",
            deps: [
              { name: "transitive-normal", pkg: "transitive-normal@1.1.0", dep_kinds: [{ kind: null }] },
              { name: "transitive-dev", pkg: "transitive-dev@3.0.0", dep_kinds: [{ kind: "dev" }] },
            ],
          },
          {
            id: "crate-build@2.0.0",
            deps: [],
          },
          {
            id: "crate-proc-macro@0.5.0",
            deps: [],
          },
          {
            id: "crate-dev-only@9.9.9",
            deps: [
              { name: "unreachable-child", pkg: "unreachable-child@4.0.0", dep_kinds: [{ kind: null }] },
            ],
          },
          {
            id: "transitive-normal@1.1.0",
            deps: [],
          },
        ],
      },
      packages: [
        { id: "app-root@0.3.0", name: "theme-forge-nebular-fusion", version: "0.3.0", license: "AGPL-3.0-or-later" },
        { id: "crate-normal@1.0.0", name: "crate-normal", version: "1.0.0", license: "MIT", manifest_path: "/crates/crate-normal/Cargo.toml" },
        { id: "crate-build@2.0.0", name: "crate-build", version: "2.0.0", license: "Apache-2.0", manifest_path: "/crates/crate-build/Cargo.toml" },
        {
          id: "crate-proc-macro@0.5.0",
          name: "crate-proc-macro",
          version: "0.5.0",
          license: "MIT OR Apache-2.0",
          manifest_path: "/crates/crate-proc-macro/Cargo.toml",
          targets: [{ name: "crate-proc-macro", kind: ["proc-macro"] }],
        },
        { id: "crate-dev-only@9.9.9", name: "crate-dev-only", version: "9.9.9", license: "MIT", manifest_path: "/crates/crate-dev-only/Cargo.toml" },
        { id: "transitive-dev@3.0.0", name: "transitive-dev", version: "3.0.0", license: "MIT", manifest_path: "/crates/transitive-dev/Cargo.toml" },
        { id: "transitive-normal@1.1.0", name: "transitive-normal", version: "1.1.0", license: "BSD-3-Clause", manifest_path: "/crates/transitive-normal/Cargo.toml" },
      ],
    };

    it("includes reachable normal and build deps including proc macros, strictly excluding dev-only", () => {
      const resolved = resolveReachableCrates(mockMetadata) as ResolvedCrate[];
      const names = resolved.map((c: ResolvedCrate) => c.name);

      expect(names).toContain("crate-normal");
      expect(names).toContain("crate-build");
      expect(names).toContain("crate-proc-macro");
      expect(names).toContain("transitive-normal");

      expect(names).not.toContain("crate-dev-only");
      expect(names).not.toContain("transitive-dev");
      expect(names).not.toContain("unreachable-child");
      expect(names).not.toContain("theme-forge-nebular-fusion");
    });

    it("identifies proc macro crates correctly", () => {
      const resolved = resolveReachableCrates(mockMetadata) as ResolvedCrate[];
      const procMacro = resolved.find((c: ResolvedCrate) => c.name === "crate-proc-macro");
      expect(procMacro?.isProcMacro).toBe(true);

      const normal = resolved.find((c: ResolvedCrate) => c.name === "crate-normal");
      expect(normal?.isProcMacro).toBe(false);
    });

    it("sorts resolved crates deterministically by ASCII name and version", () => {
      const resolved = resolveReachableCrates(mockMetadata) as ResolvedCrate[];
      for (let i = 1; i < resolved.length; i++) {
        const prev = resolved[i - 1]!;
        const curr = resolved[i]!;
        const cmp = prev.name.localeCompare(curr.name);
        expect(cmp <= 0).toBe(true);
      }
    });
  });

  describe("license and notice file detection", () => {
    it("recognizes standard and variant license file names", () => {
      expect(isLicenseOrNoticeFileName("LICENSE")).toBe(true);
      expect(isLicenseOrNoticeFileName("LICENCE")).toBe(true);
      expect(isLicenseOrNoticeFileName("LICENSE-MIT")).toBe(true);
      expect(isLicenseOrNoticeFileName("LICENSE-APACHE")).toBe(true);
      expect(isLicenseOrNoticeFileName("LICENSE_APACHE-2.0")).toBe(true);
      expect(isLicenseOrNoticeFileName("LICENSE.md")).toBe(true);
      expect(isLicenseOrNoticeFileName("LICENSE.txt")).toBe(true);
      expect(isLicenseOrNoticeFileName("LICENSE.spdx")).toBe(true);
      expect(isLicenseOrNoticeFileName("NOTICE")).toBe(true);
      expect(isLicenseOrNoticeFileName("NOTICE.md")).toBe(true);
      expect(isLicenseOrNoticeFileName("COPYING")).toBe(true);
      expect(isLicenseOrNoticeFileName("UNLICENSE")).toBe(true);
      expect(isLicenseOrNoticeFileName("COPYRIGHT")).toBe(true);
    });

    it("rejects non-license files, source code, and binaries", () => {
      expect(isLicenseOrNoticeFileName("lib.rs")).toBe(false);
      expect(isLicenseOrNoticeFileName("Cargo.toml")).toBe(false);
      expect(isLicenseOrNoticeFileName("README.md")).toBe(false);
      expect(isLicenseOrNoticeFileName(".cargo-ok")).toBe(false);
      expect(isLicenseOrNoticeFileName("index.js")).toBe(false);
      expect(isLicenseOrNoticeFileName("main.ts")).toBe(false);
      expect(isLicenseOrNoticeFileName("notice.rs")).toBe(false);
    });
  });

  describe("required license file inventory and registry metadata insufficiency rule", () => {
    it("considers matching registry metadata INSUFFICIENT when license text file is absent", () => {
      const pkg = { name: "test-crate", version: "1.0.0", license: "MIT" };
      const inventory = inventoryPackageLicenses(pkg, null, {
        fileList: ["Cargo.toml", "README.md", "src/lib.rs"],
      });

      expect(inventory.hasLicenseText).toBe(false);
      expect(inventory.isMissingRequiredMaterial).toBe(true);
      expect(inventory.failureReason).toContain("is not sufficient");
      expect(inventory.failureReason).toContain("MIT");
    });

    it("passes validation when license text file is present in archive", () => {
      const pkg = { name: "test-crate", version: "1.0.0", license: "MIT" };
      const inventory = inventoryPackageLicenses(pkg, null, {
        fileList: ["Cargo.toml", "LICENSE", "src/lib.rs"],
      });

      expect(inventory.hasLicenseText).toBe(true);
      expect(inventory.isMissingRequiredMaterial).toBe(false);
      expect(inventory.licenseFiles).toEqual(["LICENSE"]);
      expect(inventory.failureReason).toBeNull();
    });

    it("includes supplemental license files when provided", () => {
      const pkg = { name: "test-crate", version: "1.0.0", license: "MIT" };
      const inventory = inventoryPackageLicenses(pkg, null, {
        fileList: ["Cargo.toml", "src/lib.rs"],
        supplementalFiles: ["LICENSE-SUPPLEMENTAL"],
      });

      expect(inventory.hasLicenseText).toBe(true);
      expect(inventory.isMissingRequiredMaterial).toBe(false);
      expect(inventory.licenseFiles).toContain("LICENSE-SUPPLEMENTAL");
    });
  });

  describe("deterministic rendering and projection safety", () => {
    const sampleManifest = {
      root: {
        name: "@knowledge-forge-ai/theme-forge-nebular-fusion",
        version: "0.3.0",
        license: "AGPL-3.0-or-later",
        files: ["root/COMMERCIAL-LICENSE.md", "root/LICENSE", "root/NOTICE"],
      },
      npm: [
        {
          name: "react",
          version: "19.2.8",
          license: "MIT",
          files: ["npm/react-19.2.8/LICENSE"],
          hasLicenseText: true,
        },
      ],
      crates: [
        {
          name: "serde",
          version: "1.0.218",
          license: "MIT OR Apache-2.0",
          checksum: "e8dfc9d2b13a21e7d088463f9153e65860b36349349eeb170772e1b0d2350fb5",
          isProcMacro: false,
          files: ["crates/serde-1.0.218/LICENSE-APACHE", "crates/serde-1.0.218/LICENSE-MIT"],
          hasLicenseText: true,
        },
        {
          name: "missing-license-crate",
          version: "0.1.0",
          license: "MIT",
          checksum: "abcdef1234567890",
          isProcMacro: false,
          files: [],
          hasLicenseText: false,
        },
      ],
      validation: {
        status: "failed",
        missingRequiredMaterial: [
          {
            name: "missing-license-crate",
            version: "0.1.0",
            license: "MIT",
            failureReason: "Registry metadata 'MIT' is not sufficient: license text file absent in package archive",
          },
        ],
      },
    };

    it("renders bit-identical JSON across multiple calls", () => {
      const json1 = renderThirdPartyNoticesJson(sampleManifest);
      const json2 = renderThirdPartyNoticesJson(sampleManifest);
      expect(json1).toBe(json2);
    });

    it("renders bit-identical Markdown across multiple calls", () => {
      const md1 = renderThirdPartyNoticesMarkdown(sampleManifest);
      const md2 = renderThirdPartyNoticesMarkdown(sampleManifest);
      expect(md1).toBe(md2);
    });

    it("contains zero timestamps in JSON and Markdown", () => {
      const json = renderThirdPartyNoticesJson(sampleManifest);
      const md = renderThirdPartyNoticesMarkdown(sampleManifest);

      expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("contains zero private machine paths in JSON and Markdown", () => {
      const json = renderThirdPartyNoticesJson(sampleManifest);
      const md = renderThirdPartyNoticesMarkdown(sampleManifest);

      expect(json).not.toMatch(/\/Users\//);
      expect(json).not.toMatch(/\/home\//);
      expect(json).not.toMatch(/\/private\//);

      expect(md).not.toMatch(/\/Users\//);
      expect(md).not.toMatch(/\/home\//);
      expect(md).not.toMatch(/\/private\//);
    });

    it("renders Absent Required License Material section with prominent caution when materials are missing", () => {
      const md = renderThirdPartyNoticesMarkdown(sampleManifest);
      expect(md).toContain("## Absent Required License Material");
      expect(md).toContain("Registry metadata is not sufficient when license text is absent");
      expect(md).toContain("missing-license-crate");
    });
  });

  describe("end-to-end generateReleaseNotices with mock fixtures", () => {
    it("fails when failOnMissing is true and a package lacks license text", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "test-release-notices-"));
      try {
        const mockMetadata = {
          resolve: {
            root: "app@0.3.0",
            nodes: [
              {
                id: "app@0.3.0",
                deps: [
                  { name: "good-crate", pkg: "good-crate@1.0.0", dep_kinds: [{ kind: null }] },
                  { name: "bad-crate", pkg: "bad-crate@1.0.0", dep_kinds: [{ kind: null }] },
                ],
              },
              { id: "good-crate@1.0.0", deps: [] },
              { id: "bad-crate@1.0.0", deps: [] },
            ],
          },
          packages: [
            { id: "app@0.3.0", name: "app", version: "0.3.0" },
            { id: "good-crate@1.0.0", name: "good-crate", version: "1.0.0", license: "MIT" },
            { id: "bad-crate@1.0.0", name: "bad-crate", version: "1.0.0", license: "Apache-2.0" },
          ],
        };

        await expect(
          generateReleaseNotices({
            outDir: tmp,
            cargoMetadata: mockMetadata,
            cargoLockContent: "",
            mockCrateFiles: {
              "good-crate@1.0.0": ["LICENSE"],
              "bad-crate@1.0.0": ["README.md"],
            },
            mockNpmPackages: {},
            failOnMissing: true,
            allowExternalOutDir: true,
          }),
        ).rejects.toThrow(/Absent required license material/);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("succeeds and records missing material when failOnMissing is false", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "test-release-notices-"));
      try {
        const mockMetadata = {
          resolve: {
            root: "app@0.3.0",
            nodes: [
              {
                id: "app@0.3.0",
                deps: [
                  { name: "good-crate", pkg: "good-crate@1.0.0", dep_kinds: [{ kind: null }] },
                  { name: "bad-crate", pkg: "bad-crate@1.0.0", dep_kinds: [{ kind: null }] },
                ],
              },
              { id: "good-crate@1.0.0", deps: [] },
              { id: "bad-crate@1.0.0", deps: [] },
            ],
          },
          packages: [
            { id: "app@0.3.0", name: "app", version: "0.3.0" },
            { id: "good-crate@1.0.0", name: "good-crate", version: "1.0.0", license: "MIT" },
            { id: "bad-crate@1.0.0", name: "bad-crate", version: "1.0.0", license: "Apache-2.0" },
          ],
        };

        const sampleLock = [
          "[[package]]",
          'name = "good-crate"',
          'version = "1.0.0"',
          'checksum = "1111"',
        ].join("\n");

        const result = await generateReleaseNotices({
          outDir: tmp,
          cargoMetadata: mockMetadata,
          cargoLockContent: sampleLock,
          mockCrateFiles: {
            "good-crate@1.0.0": ["LICENSE"],
            "bad-crate@1.0.0": ["README.md"],
          },
          mockNpmPackages: {},
          failOnMissing: false,
          allowExternalOutDir: true,
        });

        expect(result.success).toBe(false);
        expect(result.missingMaterials.length).toBe(1);
        expect(result.missingMaterials[0].name).toBe("bad-crate");
        expect(result.manifest.crates.length).toBe(2);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
