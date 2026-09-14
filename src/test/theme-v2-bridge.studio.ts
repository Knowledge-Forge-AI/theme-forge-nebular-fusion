import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  THEME_LAB_COMMANDS,
  TauriThemeLabBridge,
  ThemeLabValidationError,
  validateCompileResponse,
  validateExampleResponse,
  validateOpenResponse,
  validateSaveResponse,
  validateStatusResponse,
} from "../features/theme-lab/theme-lab-bridge";
import {
  CODE_CATALOG_DIGEST,
  CODE_CATALOG_IDENTITY,
  CODE_COMPILER_SEMANTIC,
  COMPONENT_CATALOG_DIGEST,
  COMPONENT_CATALOG_IDENTITY,
  COMPONENT_COMPILER_SEMANTIC,
  CORE_CATALOG_DIGEST,
  CORE_CATALOG_IDENTITY,
  CORE_COMPILER_SEMANTIC,
  computeSha256Hex,
  isV2Descriptor,
  isV2Specification,
  validateDraftUpdateResponse,
  validateSafeRevision,
  validateThemeDescriptorV2,
  validateThemeDocumentOpenResponse,
  validateThemeSpecificationV2,
  validateThemeV2CompileResponse,
  validateThemeV2Styles,
  verifyThemeV2CompiledCssAndInventory,
  type ThemeDescriptorCatalogV2,
  type ThemeDescriptorCodeV2,
  type ThemeDescriptorCoreV2,
  type ThemeDescriptorV2,
  type ThemeSpecificationV2,
  type ThemeV2StyleFile,
} from "../features/theme-lab/v2-bridge";
import { SAMPLE_THEME_V2 } from "../features/theme-lab/v2-model";
import type { ThemeSpecification } from "../features/theme-lab/types";

// ---------------------------------------------------------------------------
// Cryptographically verified test fixtures
// ---------------------------------------------------------------------------

const CORE_STYLES: ThemeV2StyleFile[] = [
  { path: "styles/layers.css", css: "@layer tfsl.layers;" },
  { path: "styles/tokens.css", css: ":root { --test: 1; }" },
  { path: "styles/base.css", css: "body { margin: 0; }" },
  { path: "styles/accent.css", css: ".accent { color: red; }" },
  { path: "styles/overrides.css", css: "/* overrides */" },
];
const CORE_CONCAT_CSS = "@layer tfsl.layers;\n\n:root { --test: 1; }\n\nbody { margin: 0; }\n\n.accent { color: red; }\n\n/* overrides */\n";
const CORE_OUTPUT_DIGEST = "09f914def0912ae6870d84da1048a504f65c076203eb27cdde83e855969cd74f";
const CORE_INVENTORY_DIGEST = "b1ed171c636bfcc708ed42fd0365fa7262a170db3ae62b934eb96939539a7305";

const CODE_STYLES: ThemeV2StyleFile[] = [
  ...CORE_STYLES,
  { path: "styles/code.css", css: "pre { color: blue; }" },
];
const CODE_CONCAT_CSS = `${CORE_CONCAT_CSS.slice(0, -1)}\n\npre { color: blue; }\n`;
const CODE_OUTPUT_DIGEST = "b2ee0b0344c90dd3256ba1a7a566936f8dc23bbad1787c4c795298ea92e35c84";
const CODE_INVENTORY_DIGEST = "3c732d1dfc757f6d9a41192298a5424a59879ba8735478c2dad47485b505ac5e";

const CATALOG_STYLES_NO_CODE: ThemeV2StyleFile[] = [
  ...CORE_STYLES,
  { path: "styles/compat.css", css: "/* compat */" },
];
const CATALOG_CONCAT_CSS = `${CORE_CONCAT_CSS.slice(0, -1)}\n\n/* compat */\n`;
const CATALOG_OUTPUT_DIGEST = "def9d5611c43749e7c705b76aff229b9afed08bb33be4d71fff5529efef72ce1";
const CATALOG_INVENTORY_DIGEST = "a9dcfc016c1197e221310e92811d23307c8e620a3a319117e8c94f7512da2312";

const INPUT_DIGEST_SAMPLE = "a".repeat(64);

const CORE_DESCRIPTOR_VALID: ThemeDescriptorCoreV2 = {
  schema: "tfsl.theme-descriptor-v2",
  schemaVersion: 2,
  themeSchemaVersion: "tfsl.theme-v2",
  themeName: "loom-celestia-code",
  themeVersion: "1.0.0",
  adapter: "starlight-v0.42",
  selectedAccent: "default",
  accent: "default",
  inputDigest: INPUT_DIGEST_SAMPLE,
  outputDigest: CORE_OUTPUT_DIGEST,
  inventoryDigest: CORE_INVENTORY_DIGEST,
  catalogIdentity: CORE_CATALOG_IDENTITY,
  catalogDigest: CORE_CATALOG_DIGEST,
  catalog: {
    identity: CORE_CATALOG_IDENTITY,
    digest: CORE_CATALOG_DIGEST,
  },
  compilerSemantic: CORE_COMPILER_SEMANTIC,
  provenance: {
    categories: ["user-authored-data", "generated-syntax", "first-party-expression"],
    semantic: CORE_COMPILER_SEMANTIC,
    compiler: "@knowledge-forge-ai/theme-forge-stellar-loom",
    compilerVersion: "0.2.0",
  },
};

const CODE_DESCRIPTOR_VALID: ThemeDescriptorCodeV2 = {
  ...CORE_DESCRIPTOR_VALID,
  outputDigest: CODE_OUTPUT_DIGEST,
  inventoryDigest: CODE_INVENTORY_DIGEST,
  catalogIdentity: CODE_CATALOG_IDENTITY,
  catalogDigest: CODE_CATALOG_DIGEST,
  catalog: {
    identity: CODE_CATALOG_IDENTITY,
    digest: CODE_CATALOG_DIGEST,
  },
  compilerSemantic: CODE_COMPILER_SEMANTIC,
  provenance: {
    ...CORE_DESCRIPTOR_VALID.provenance,
    semantic: CODE_COMPILER_SEMANTIC,
  },
};

const CATALOG_DESCRIPTOR_VALID: ThemeDescriptorCatalogV2 = {
  ...CORE_DESCRIPTOR_VALID,
  outputDigest: CATALOG_OUTPUT_DIGEST,
  inventoryDigest: CATALOG_INVENTORY_DIGEST,
  catalogIdentity: COMPONENT_CATALOG_IDENTITY,
  catalogDigest: COMPONENT_CATALOG_DIGEST,
  catalog: {
    identity: COMPONENT_CATALOG_IDENTITY,
    digest: COMPONENT_CATALOG_DIGEST,
  },
  compilerSemantic: COMPONENT_COMPILER_SEMANTIC,
  provenance: {
    ...CORE_DESCRIPTOR_VALID.provenance,
    semantic: COMPONENT_COMPILER_SEMANTIC,
  },
};

const SAMPLE_V1_SPEC: ThemeSpecification = {
  name: "v1-theme",
  version: "1.0.0",
  schemaVersion: "tfsl.theme-v1",
  adapter: "starlight-v0.42",
  colors: {
    dark: {
      accent: { base: "#000", low: "#000", high: "#000" },
      neutrals: {
        bg: "#000",
        bgNav: "#000",
        bgSidebar: "#000",
        bgInlineCode: "#000",
        bgAccent: "#000",
        text: "#000",
        textAccent: "#000",
        textInvert: "#000",
        hairline: "#000",
        hairlineLight: "#000",
        hairlineShade: "#000",
      },
      grays: {
        gray1: "#000",
        gray2: "#000",
        gray3: "#000",
        gray4: "#000",
        gray5: "#000",
        gray6: "#000",
        gray7: "#000",
      },
    },
    light: {
      accent: { base: "#fff", low: "#fff", high: "#fff" },
      neutrals: {
        bg: "#fff",
        bgNav: "#fff",
        bgSidebar: "#fff",
        bgInlineCode: "#fff",
        bgAccent: "#fff",
        text: "#fff",
        textAccent: "#fff",
        textInvert: "#fff",
        hairline: "#fff",
        hairlineLight: "#fff",
        hairlineShade: "#fff",
      },
      grays: {
        gray1: "#fff",
        gray2: "#fff",
        gray3: "#fff",
        gray4: "#fff",
        gray5: "#fff",
        gray6: "#fff",
        gray7: "#fff",
      },
    },
  },
  typography: { bodyFont: "sans-serif", codeFont: "monospace" },
  layout: { contentWidth: "60rem", sidebarWidth: "18rem" },
};

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Theme Lab v2 Native Bridge Integration (TFSB63B)", () => {
  let bridge: TauriThemeLabBridge;

  beforeEach(() => {
    invokeMock.mockReset();
    bridge = new TauriThemeLabBridge();
  });

  describe("TauriThemeLabBridge fixed command routing and parameter contracts", () => {
    it("calls compileV2 via fixed studio_theme_lab_compile without file paths", async () => {
      const compilePayload = {
        uiRevision: 5,
        valid: true,
        compiledCss: CORE_CONCAT_CSS,
        descriptor: CORE_DESCRIPTOR_VALID,
        styles: CORE_STYLES,
        diagnostics: [],
      };
      invokeMock.mockResolvedValueOnce(compilePayload);

      const request = {
        specification: SAMPLE_THEME_V2,
        uiRevision: 5,
        sessionId: "sess-123",
        options: { accent: "default", strictContrast: false },
      };

      const res = await bridge.compileV2(request);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      const [command, args] = invokeMock.mock.calls[0]!;
      expect(command).toBe(THEME_LAB_COMMANDS.compile);
      expect(command).toBe("studio_theme_lab_compile");
      expect(args).toEqual({ request });
      expect(res.valid).toBe(true);
      expect(res.uiRevision).toBe(5);
      expect(res.descriptor?.catalogIdentity).toBe(CORE_CATALOG_IDENTITY);

      // Verify NO file path authority leaked into args
      const serialized = JSON.stringify(args);
      expect(serialized).not.toContain("filePath");
      expect(serialized).not.toContain("active_file_path");
    });

    it("calls openDocument via fixed studio_theme_lab_open without file paths", async () => {
      const openPayload = {
        cancelled: false,
        displayName: "loom-celestia-code.theme.json",
        specification: SAMPLE_THEME_V2,
        compiledCss: CORE_CONCAT_CSS,
        descriptor: CORE_DESCRIPTOR_VALID,
        styles: CORE_STYLES,
        diagnostics: [],
      };
      invokeMock.mockResolvedValueOnce(openPayload);

      const request = { uiRevision: 10, sessionId: "sess-open-1" };
      const res = await bridge.openDocument(request);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      const [command, args] = invokeMock.mock.calls[0]!;
      expect(command).toBe(THEME_LAB_COMMANDS.open);
      expect(command).toBe("studio_theme_lab_open");
      expect(args).toEqual({ request });
      expect(res.cancelled).toBe(false);
      expect(res.displayName).toBe("loom-celestia-code.theme.json");
      expect(res.specification?.name).toBe("loom-celestia-code");

      // Verify no file paths passed from bridge
      expect(JSON.stringify(args)).not.toContain("path");
    });

    it("calls openDocument without request parameters when omitted", async () => {
      invokeMock.mockResolvedValueOnce({ cancelled: true, diagnostics: [] });
      const res = await bridge.openDocument();
      expect(invokeMock).toHaveBeenCalledWith(THEME_LAB_COMMANDS.open, {});
      expect(res.cancelled).toBe(true);
    });

    it("calls saveDocument via fixed studio_theme_lab_save without file paths", async () => {
      invokeMock.mockResolvedValueOnce({ cancelled: false, displayName: "saved-v2.theme.json" });

      const request = {
        saveAs: false,
        specification: SAMPLE_THEME_V2,
        uiRevision: 15,
        sessionId: "sess-save-1",
      };

      const res = await bridge.saveDocument(request);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      const [command, args] = invokeMock.mock.calls[0]!;
      expect(command).toBe(THEME_LAB_COMMANDS.save);
      expect(command).toBe("studio_theme_lab_save");
      expect(args).toEqual({ request });
      expect(res.cancelled).toBe(false);
      expect(res.displayName).toBe("saved-v2.theme.json");

      expect(JSON.stringify(args)).not.toContain("target_path");
    });

    it("calls updateDraft via fixed studio_theme_lab_draft_update with revision and sessionId", async () => {
      invokeMock.mockResolvedValueOnce({ uiRevision: 22 });

      const request = { sessionId: "sess-draft-update", uiRevision: 22 };
      const res = await bridge.updateDraft(request);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      const [command, args] = invokeMock.mock.calls[0]!;
      expect(command).toBe(THEME_LAB_COMMANDS.draftUpdate);
      expect(command).toBe("studio_theme_lab_draft_update");
      expect(args).toEqual({ request });
      expect(res.uiRevision).toBe(22);
    });

    it("enforces safe integer revisions on all bridge request methods", async () => {
      for (const badRev of [-1, NaN, Infinity, 3.14, "5" as any]) {
        await expect(bridge.compileV2({ specification: SAMPLE_THEME_V2, uiRevision: badRev })).rejects.toThrow(
          ThemeLabValidationError
        );
        await expect(bridge.openDocument({ uiRevision: badRev })).rejects.toThrow(ThemeLabValidationError);
        await expect(
          bridge.saveDocument({ saveAs: true, specification: SAMPLE_THEME_V2, uiRevision: badRev })
        ).rejects.toThrow(ThemeLabValidationError);
        await expect(bridge.updateDraft({ sessionId: "sess", uiRevision: badRev })).rejects.toThrow(
          ThemeLabValidationError
        );
      }
    });

    it("rejects empty or missing sessionId on updateDraft", async () => {
      await expect(bridge.updateDraft({ sessionId: "", uiRevision: 1 })).rejects.toThrow(ThemeLabValidationError);
      await expect(bridge.updateDraft({ sessionId: undefined as any, uiRevision: 1 })).rejects.toThrow(
        ThemeLabValidationError
      );
    });
  });

  describe("ThemeSpecificationV2 structural runtime decoding", () => {
    it("decodes valid v2 specification cleanly", () => {
      const decoded = validateThemeSpecificationV2(SAMPLE_THEME_V2);
      expect(decoded.name).toBe("loom-celestia-code");
      expect(decoded.schemaVersion).toBe("tfsl.theme-v2");
      expect(decoded.adapter).toBe("starlight-v0.42");
      expect(isV2Specification(decoded)).toBe(true);
    });

    it("preserves extra / unknown top-level specification fields losslessly", () => {
      const withExtra: ThemeSpecificationV2 = {
        ...SAMPLE_THEME_V2,
        _customVendorMetadata: { id: "nebular-cluster", flags: [1, 2] },
        $schema: "https://example.com/theme.schema.json",
      };
      const decoded = validateThemeSpecificationV2(withExtra);
      expect(decoded["_customVendorMetadata"]).toEqual({ id: "nebular-cluster", flags: [1, 2] });
      expect(decoded["$schema"]).toBe("https://example.com/theme.schema.json");
    });

    it("rejects specification with missing or empty name / version", () => {
      expect(() => validateThemeSpecificationV2({ ...SAMPLE_THEME_V2, name: "" })).toThrow(
        ThemeLabValidationError
      );
      expect(() => validateThemeSpecificationV2({ ...SAMPLE_THEME_V2, version: "  " })).toThrow(
        ThemeLabValidationError
      );
    });

    it("rejects specification with wrong schemaVersion or adapter", () => {
      expect(() => validateThemeSpecificationV2({ ...SAMPLE_THEME_V2, schemaVersion: "tfsl.theme-v1" })).toThrow(
        ThemeLabValidationError
      );
      expect(() => validateThemeSpecificationV2({ ...SAMPLE_THEME_V2, adapter: "bootstrap-v5" })).toThrow(
        ThemeLabValidationError
      );
    });

    it("rejects specification with missing accent variant color roles", () => {
      const invalid = JSON.parse(JSON.stringify(SAMPLE_THEME_V2));
      delete invalid.accentVariants.default.light.page;
      expect(() => validateThemeSpecificationV2(invalid)).toThrow(ThemeLabValidationError);
    });

    it("rejects specification with non-finite typography or surfaces", () => {
      const badTypo = JSON.parse(JSON.stringify(SAMPLE_THEME_V2));
      badTypo.typography.body.size = NaN;
      expect(() => validateThemeSpecificationV2(badTypo)).toThrow(ThemeLabValidationError);

      const badSurfaces = JSON.parse(JSON.stringify(SAMPLE_THEME_V2));
      badSurfaces.surfaces.spacing = Infinity;
      expect(() => validateThemeSpecificationV2(badSurfaces)).toThrow(ThemeLabValidationError);
    });

    it("rejects specification with invalid layoutPreset or components", () => {
      expect(() => validateThemeSpecificationV2({ ...SAMPLE_THEME_V2, layoutPreset: "invalid" as any })).toThrow(
        ThemeLabValidationError
      );
      expect(() =>
        validateThemeSpecificationV2({ ...SAMPLE_THEME_V2, components: { pageTitle: "bad" as any } })
      ).toThrow(ThemeLabValidationError);
    });
  });

  describe("ThemeDescriptorV2 strict discriminated decoding and tuple verification", () => {
    it("successfully decodes Core, Code, and Catalog descriptors", () => {
      const core = validateThemeDescriptorV2(CORE_DESCRIPTOR_VALID);
      expect(core.catalogIdentity).toBe(CORE_CATALOG_IDENTITY);
      expect(core.compilerSemantic).toBe(CORE_COMPILER_SEMANTIC);
      expect(isV2Descriptor(core)).toBe(true);

      const code = validateThemeDescriptorV2(CODE_DESCRIPTOR_VALID);
      expect(code.catalogIdentity).toBe(CODE_CATALOG_IDENTITY);
      expect(code.compilerSemantic).toBe(CODE_COMPILER_SEMANTIC);

      const catalog = validateThemeDescriptorV2(CATALOG_DESCRIPTOR_VALID);
      expect(catalog.catalogIdentity).toBe(COMPONENT_CATALOG_IDENTITY);
      expect(catalog.compilerSemantic).toBe(COMPONENT_COMPILER_SEMANTIC);
    });

    it("rejects unknown / wrong descriptor family catalogIdentity", () => {
      const invalid = {
        ...CORE_DESCRIPTOR_VALID,
        catalogIdentity: "tfsl.starlight-unknown-catalog-v99",
      };
      expect(() => validateThemeDescriptorV2(invalid)).toThrow(/unrecognized or invalid catalogIdentity/i);
    });

    it("rejects descriptor with catalog.identity mismatch", () => {
      const invalid = {
        ...CORE_DESCRIPTOR_VALID,
        catalog: {
          identity: CODE_CATALOG_IDENTITY,
          digest: CORE_CATALOG_DIGEST,
        },
      };
      expect(() => validateThemeDescriptorV2(invalid)).toThrow(/catalog\.identity does not match/i);
    });

    it("rejects descriptor with catalog.digest mismatch", () => {
      const invalid = {
        ...CORE_DESCRIPTOR_VALID,
        catalog: {
          identity: CORE_CATALOG_IDENTITY,
          digest: "f".repeat(64),
        },
      };
      expect(() => validateThemeDescriptorV2(invalid)).toThrow(/catalog\.digest does not match/i);
    });

    it("rejects compilerSemantic that mismatches the catalog family tuple", () => {
      // Core catalog with Code compiler semantic
      const invalid = {
        ...CORE_DESCRIPTOR_VALID,
        compilerSemantic: CODE_COMPILER_SEMANTIC,
      };
      expect(() => validateThemeDescriptorV2(invalid)).toThrow(/does not match catalog family/i);
    });

    it("rejects provenance.semantic that mismatches compilerSemantic", () => {
      const invalid = {
        ...CORE_DESCRIPTOR_VALID,
        provenance: {
          ...CORE_DESCRIPTOR_VALID.provenance,
          semantic: CODE_COMPILER_SEMANTIC,
        },
      };
      expect(() => validateThemeDescriptorV2(invalid)).toThrow(/provenance\.semantic does not match/i);
    });

    it("rejects malformed unknown fields on descriptor", () => {
      const withUnknown = {
        ...CORE_DESCRIPTOR_VALID,
        arbitraryUnrecognizedField: "forbidden",
      };
      expect(() => validateThemeDescriptorV2(withUnknown)).toThrow(/unexpected unknown field/i);
    });

    it("rejects unknown fields on catalog or provenance sub-objects", () => {
      const badCatalog = {
        ...CORE_DESCRIPTOR_VALID,
        catalog: {
          ...CORE_DESCRIPTOR_VALID.catalog,
          extraKey: 123,
        },
      };
      expect(() => validateThemeDescriptorV2(badCatalog)).toThrow(/unexpected unknown field/i);

      const badProv = {
        ...CORE_DESCRIPTOR_VALID,
        provenance: {
          ...CORE_DESCRIPTOR_VALID.provenance,
          extraProp: "nope",
        },
      };
      expect(() => validateThemeDescriptorV2(badProv)).toThrow(/unexpected unknown field/i);
    });

    it("rejects non-64 lowercase hex digests", () => {
      for (const badDigest of ["ABCDEF", "g".repeat(64), "A".repeat(64), "123", ""]) {
        expect(() =>
          validateThemeDescriptorV2({ ...CORE_DESCRIPTOR_VALID, outputDigest: badDigest })
        ).toThrow(ThemeLabValidationError);
        expect(() =>
          validateThemeDescriptorV2({ ...CORE_DESCRIPTOR_VALID, inventoryDigest: badDigest })
        ).toThrow(ThemeLabValidationError);
        expect(() =>
          validateThemeDescriptorV2({ ...CORE_DESCRIPTOR_VALID, inputDigest: badDigest })
        ).toThrow(ThemeLabValidationError);
      }
    });

    it("rejects descriptor if optional accent does not match selectedAccent", () => {
      const invalid = {
        ...CORE_DESCRIPTOR_VALID,
        selectedAccent: "cyan",
        accent: "magenta",
      };
      expect(() => validateThemeDescriptorV2(invalid)).toThrow(/accent does not match selectedAccent/i);
    });

    it("rejects invalid schema or schemaVersion or adapter", () => {
      expect(() => validateThemeDescriptorV2({ ...CORE_DESCRIPTOR_VALID, schema: "tfsl.theme-descriptor-v1" })).toThrow(
        ThemeLabValidationError
      );
      expect(() => validateThemeDescriptorV2({ ...CORE_DESCRIPTOR_VALID, schemaVersion: 1 })).toThrow(
        ThemeLabValidationError
      );
      expect(() => validateThemeDescriptorV2({ ...CORE_DESCRIPTOR_VALID, adapter: "unsupported" })).toThrow(
        ThemeLabValidationError
      );
    });
  });

  describe("Ordered styles validation and cryptographic verification", () => {
    it("validates exact ordered styles for Core catalog", () => {
      const result = validateThemeV2Styles(CORE_STYLES, CORE_DESCRIPTOR_VALID);
      expect(result).toHaveLength(5);
      expect(result.map((s) => s.path)).toEqual([
        "styles/layers.css",
        "styles/tokens.css",
        "styles/base.css",
        "styles/accent.css",
        "styles/overrides.css",
      ]);
    });

    it("validates exact ordered styles for Code catalog", () => {
      const result = validateThemeV2Styles(CODE_STYLES, CODE_DESCRIPTOR_VALID);
      expect(result).toHaveLength(6);
      expect(result.map((s) => s.path)).toEqual([
        "styles/layers.css",
        "styles/tokens.css",
        "styles/base.css",
        "styles/accent.css",
        "styles/overrides.css",
        "styles/code.css",
      ]);
    });

    it("validates exact ordered styles for Component catalog", () => {
      const result = validateThemeV2Styles(CATALOG_STYLES_NO_CODE, CATALOG_DESCRIPTOR_VALID);
      expect(result).toHaveLength(6);
      expect(result.map((s) => s.path)).toEqual([
        "styles/layers.css",
        "styles/tokens.css",
        "styles/base.css",
        "styles/accent.css",
        "styles/overrides.css",
        "styles/compat.css",
      ]);
    });

    it("rejects missing styles file", () => {
      const missingAccent = CORE_STYLES.filter((s) => s.path !== "styles/accent.css");
      expect(() => validateThemeV2Styles(missingAccent, CORE_DESCRIPTOR_VALID)).toThrow(
        /mismatch for core catalog/i
      );
    });

    it("rejects duplicate styles file", () => {
      const duplicateTokens = [...CORE_STYLES, { path: "styles/tokens.css", css: "/* dup */" }];
      expect(() => validateThemeV2Styles(duplicateTokens, CORE_DESCRIPTOR_VALID)).toThrow(
        /duplicate style file path/i
      );
    });

    it("rejects wrong-order styles file", () => {
      const wrongOrder = [
        CORE_STYLES[1]!, // tokens first
        CORE_STYLES[0]!, // layers second
        ...CORE_STYLES.slice(2),
      ];
      expect(() => validateThemeV2Styles(wrongOrder, CORE_DESCRIPTOR_VALID)).toThrow(
        /mismatch for core catalog/i
      );
    });

    it("rejects unexpected extra style file", () => {
      const extra = [...CORE_STYLES, { path: "styles/malicious.css", css: "/* inject */" }];
      expect(() => validateThemeV2Styles(extra, CORE_DESCRIPTOR_VALID)).toThrow(/mismatch for core catalog/i);
    });

    it("verifies cryptographic compiledCss and inventory hash checks", async () => {
      await expect(
        verifyThemeV2CompiledCssAndInventory(CORE_STYLES, CORE_DESCRIPTOR_VALID, CORE_CONCAT_CSS)
      ).resolves.toBeUndefined();
    });

    it("rejects compiledCss that does not match ordered concatenated styles", async () => {
      await expect(
        verifyThemeV2CompiledCssAndInventory(CORE_STYLES, CORE_DESCRIPTOR_VALID, "body { color: blue; }")
      ).rejects.toThrow(/compiledCss does not match/i);
    });

    it("rejects descriptor outputDigest that does not match computed compiled CSS hash", async () => {
      const badOutput = { ...CORE_DESCRIPTOR_VALID, outputDigest: "0".repeat(64) };
      await expect(
        verifyThemeV2CompiledCssAndInventory(CORE_STYLES, badOutput, CORE_CONCAT_CSS)
      ).rejects.toThrow(/outputDigest.*does not match/i);
    });

    it("rejects descriptor inventoryDigest that does not match computed inventory hash", async () => {
      const badInv = { ...CORE_DESCRIPTOR_VALID, inventoryDigest: "1".repeat(64) };
      await expect(
        verifyThemeV2CompiledCssAndInventory(CORE_STYLES, badInv, CORE_CONCAT_CSS)
      ).rejects.toThrow(/inventoryDigest.*does not match/i);
    });
  });

  describe("ThemeV2CompileResponse runtime decoding", () => {
    it("decodes valid successful compile response", async () => {
      const payload = {
        uiRevision: 10,
        valid: true,
        compiledCss: CORE_CONCAT_CSS,
        descriptor: CORE_DESCRIPTOR_VALID,
        styles: CORE_STYLES,
        diagnostics: [],
      };
      const res = await validateThemeV2CompileResponse(payload);
      expect(res.uiRevision).toBe(10);
      expect(res.valid).toBe(true);
      expect(res.compiledCss).toBe(CORE_CONCAT_CSS);
      expect(res.descriptor?.outputDigest).toBe(CORE_OUTPUT_DIGEST);
    });

    it("decodes failed compile response with error", async () => {
      const payload = {
        uiRevision: 11,
        valid: false,
        diagnostics: [],
        error: { code: "STALE_REVISION", message: "Superseded" },
      };
      const res = await validateThemeV2CompileResponse(payload);
      expect(res.uiRevision).toBe(11);
      expect(res.valid).toBe(false);
      expect(res.error).toEqual({ code: "STALE_REVISION", message: "Superseded" });
    });

    it("rejects compile response with invalid revision", async () => {
      const payload = {
        uiRevision: -1,
        valid: false,
        diagnostics: [],
      };
      await expect(validateThemeV2CompileResponse(payload)).rejects.toThrow(ThemeLabValidationError);
    });
  });

  describe("ThemeDocumentOpenResponse v1/v2 discrimination", () => {
    it("decodes cancelled open response", async () => {
      const payload = { cancelled: true, displayName: undefined, diagnostics: [] };
      const res = await validateThemeDocumentOpenResponse(payload);
      expect(res.cancelled).toBe(true);
      expect(res.specification).toBeUndefined();
    });

    it("decodes v2 opened document with full validation", async () => {
      const payload = {
        cancelled: false,
        displayName: "nebular.theme.json",
        specification: SAMPLE_THEME_V2,
        compiledCss: CORE_CONCAT_CSS,
        descriptor: CORE_DESCRIPTOR_VALID,
        styles: CORE_STYLES,
        diagnostics: [],
      };
      const res = await validateThemeDocumentOpenResponse(payload);
      expect(res.cancelled).toBe(false);
      expect(res.displayName).toBe("nebular.theme.json");
      expect(isV2Specification(res.specification)).toBe(true);
      expect(isV2Descriptor(res.descriptor)).toBe(true);
    });

    it("decodes v1 opened document without regression", async () => {
      const payload = {
        cancelled: false,
        displayName: "v1-legacy.theme.json",
        specification: SAMPLE_V1_SPEC,
        compiledCss: "/* v1 css */",
        descriptor: {
          schema: "tfsl.theme-descriptor-v1",
          schemaVersion: 1,
          themeSchemaVersion: "tfsl.theme-v1",
          themeName: "v1-theme",
          themeVersion: "1.0.0",
          adapter: "starlight-v0.42",
          inputDigest: "0".repeat(64),
          outputDigest: "1".repeat(64),
          cssFile: "theme.css",
          provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" },
        },
        diagnostics: [],
      };
      const res = await validateThemeDocumentOpenResponse(payload);
      expect(res.cancelled).toBe(false);
      expect(res.displayName).toBe("v1-legacy.theme.json");
      expect(res.specification?.name).toBe("v1-theme");
      expect(res.descriptor?.schema).toBe("tfsl.theme-descriptor-v1");
      expect(isV2Specification(res.specification)).toBe(false);
      expect(isV2Descriptor(res.descriptor)).toBe(false);
    });
  });

  describe("Draft update response decoding", () => {
    it("decodes valid draft update response", () => {
      const res = validateDraftUpdateResponse({ uiRevision: 42 });
      expect(res.uiRevision).toBe(42);
    });

    it("rejects draft update response with non-safe-integer revision", () => {
      expect(() => validateDraftUpdateResponse({ uiRevision: -5 })).toThrow(ThemeLabValidationError);
      expect(() => validateDraftUpdateResponse({ uiRevision: 3.14 })).toThrow(ThemeLabValidationError);
      expect(() => validateDraftUpdateResponse({ uiRevision: "42" })).toThrow(ThemeLabValidationError);
    });
  });

  describe("v1 backward compatibility regressions", () => {
    it("preserves v1 validateCompileResponse decoder", () => {
      const v1Compile = {
        uiRevision: 1,
        valid: true,
        compiledCss: "/* css */",
        descriptor: {
          schema: "tfsl.theme-descriptor-v1",
          schemaVersion: 1,
          themeSchemaVersion: "tfsl.theme-v1",
          themeName: "cyan",
          themeVersion: "1.0.0",
          adapter: "starlight-v0.42",
          inputDigest: "0",
          outputDigest: "1",
          cssFile: "theme.css",
          provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" },
        },
        diagnostics: [],
      };
      const res = validateCompileResponse(v1Compile);
      expect(res.valid).toBe(true);
      expect(res.descriptor?.schema).toBe("tfsl.theme-descriptor-v1");
    });

    it("preserves v1 validateOpenResponse decoder", () => {
      const v1Open = {
        cancelled: false,
        displayName: "open.json",
        specification: SAMPLE_V1_SPEC,
        compiledCss: "/* css */",
        descriptor: {
          schema: "tfsl.theme-descriptor-v1",
          schemaVersion: 1,
          themeSchemaVersion: "tfsl.theme-v1",
          themeName: "cyan",
          themeVersion: "1.0.0",
          adapter: "starlight-v0.42",
          inputDigest: "0",
          outputDigest: "1",
          cssFile: "theme.css",
          provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" },
        },
        diagnostics: [],
      };
      const res = validateOpenResponse(v1Open);
      expect(res.cancelled).toBe(false);
      expect(res.specification?.name).toBe("v1-theme");
    });

    it("preserves v1 validateSaveResponse decoder", () => {
      const res = validateSaveResponse({ cancelled: false, displayName: "saved.json" });
      expect(res.cancelled).toBe(false);
      expect(res.displayName).toBe("saved.json");
    });

    it("preserves v1 validateExampleResponse decoder", () => {
      const res = validateExampleResponse({
        uiRevision: 2,
        valid: true,
        exampleName: "stellar-cyan",
        diagnostics: [],
      });
      expect(res.exampleName).toBe("stellar-cyan");
    });

    it("preserves v1 validateStatusResponse decoder", () => {
      const res = validateStatusResponse({
        available: true,
        compilerVersion: "0.2.0",
        sessionId: "sess-1",
        latestRevision: 3,
      });
      expect(res.available).toBe(true);
      expect(res.compilerVersion).toBe("0.2.0");
    });
  });

  describe("v2 exchange honesty", () => {
    it("exposes fixed candidate operations without inventing Loom v2 brief methods", () => {
      expect((bridge as any).createBriefV2).toBeUndefined();
      expect(typeof bridge.adoptCandidateV2).toBe("function");
      expect(typeof bridge.verifyCandidateV2).toBe("function");
      expect((bridge as any).verifyThemeCandidateV2).toBeUndefined();
    });
  });
});
