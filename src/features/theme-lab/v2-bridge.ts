import type {
  ContrastDiagnostic,
  ThemeDescriptor,
  ThemeLabError,
  ThemeSpecification,
} from "./types";
import {
  ThemeLabValidationError,
  validateDiagnostics,
  validateError,
  validateDescriptor as validateDescriptorV1,
} from "./theme-lab-bridge";
import type {
  ThemeSpecificationV2,
  AccentVariantDefinition,
  TypographyV2,
  SurfacesV2,
  ComponentsV2,
  CodePresentationV2,
  CodePresentationConfig,
  FontDeclarationV2,
  ThemeCatalogConfig,
  TokenDefinition,
} from "./v2-model";
import { COLOR_ROLES } from "./v2-model";

export type { ThemeSpecificationV2 };

// ---------------------------------------------------------------------------
// Pinned Loom v2 Catalog Constants (Live Public Contracts)
// ---------------------------------------------------------------------------

export const CORE_CATALOG_IDENTITY = "tfsl.starlight-core-catalog-v1" as const;
export const CORE_CATALOG_DIGEST = "d45f945d3323244c5b6d2908799c968d5d1d223e945b8aed0a0ce96b76f32953" as const;
export const CORE_COMPILER_SEMANTIC = "tfsl.theme-compiler-v2-core-1" as const;

export const CODE_CATALOG_IDENTITY = "tfsl.starlight-code-catalog-v1" as const;
export const CODE_CATALOG_DIGEST = "a56cd99c26ce6e015854338eee63fd850121cf2c86af7cbe992cf39b4b58f34b" as const;
export const CODE_COMPILER_SEMANTIC = "tfsl.theme-compiler-v2-code-1" as const;

export const COMPONENT_CATALOG_IDENTITY = "tfsl.starlight-component-catalog-v1" as const;
export const COMPONENT_CATALOG_DIGEST = "34b1b7c6359a3eb996043d5ce688e1d3740bfeafa462a1b912a08d162638fc73" as const;
export const COMPONENT_COMPILER_SEMANTIC = "tfsl.theme-compiler-v2-catalog-1" as const;

export const APPROVED_CATALOG_IDENTITIES = [
  CORE_CATALOG_IDENTITY,
  CODE_CATALOG_IDENTITY,
  COMPONENT_CATALOG_IDENTITY,
] as const;

export type CatalogIdentityV2 = (typeof APPROVED_CATALOG_IDENTITIES)[number];

export const CORE_STYLE_FILES = [
  "styles/layers.css",
  "styles/tokens.css",
  "styles/base.css",
  "styles/accent.css",
  "styles/overrides.css",
] as const;

export const CODE_STYLE_FILES = [
  "styles/layers.css",
  "styles/tokens.css",
  "styles/base.css",
  "styles/accent.css",
  "styles/overrides.css",
  "styles/code.css",
] as const;

export const CATALOG_STYLE_FILES_NO_CODE = [
  "styles/layers.css",
  "styles/tokens.css",
  "styles/base.css",
  "styles/accent.css",
  "styles/overrides.css",
  "styles/compat.css",
] as const;

export const CATALOG_STYLE_FILES_WITH_CODE = [
  "styles/layers.css",
  "styles/tokens.css",
  "styles/base.css",
  "styles/accent.css",
  "styles/overrides.css",
  "styles/code.css",
  "styles/compat.css",
] as const;

export type ProvenanceCategory =
  | "user-authored-data"
  | "generated-syntax"
  | "first-party-expression";

export const PROVENANCE_CATEGORIES: readonly ProvenanceCategory[] = [
  "user-authored-data",
  "generated-syntax",
  "first-party-expression",
];

// ---------------------------------------------------------------------------
// V2 Descriptor Types
// ---------------------------------------------------------------------------

export interface ThemeDescriptorBaseV2 {
  readonly schema: "tfsl.theme-descriptor-v2";
  readonly schemaVersion: 2;
  readonly themeSchemaVersion: "tfsl.theme-v2";
  readonly themeName: string;
  readonly themeVersion: string;
  readonly adapter: "starlight-v0.42";
  readonly selectedAccent: string;
  readonly accent?: string | undefined;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly inventoryDigest: string;
}

export interface ThemeDescriptorCoreV2 extends ThemeDescriptorBaseV2 {
  readonly catalogIdentity: typeof CORE_CATALOG_IDENTITY;
  readonly catalogDigest: string;
  readonly catalog: {
    readonly identity: typeof CORE_CATALOG_IDENTITY;
    readonly digest: string;
  };
  readonly compilerSemantic: typeof CORE_COMPILER_SEMANTIC;
  readonly provenance: {
    readonly categories: readonly ProvenanceCategory[];
    readonly semantic: typeof CORE_COMPILER_SEMANTIC;
    readonly compiler: string;
    readonly compilerVersion: string;
  };
}

export interface ThemeDescriptorCodeV2 extends ThemeDescriptorBaseV2 {
  readonly catalogIdentity: typeof CODE_CATALOG_IDENTITY;
  readonly catalogDigest: string;
  readonly catalog: {
    readonly identity: typeof CODE_CATALOG_IDENTITY;
    readonly digest: string;
  };
  readonly compilerSemantic: typeof CODE_COMPILER_SEMANTIC;
  readonly provenance: {
    readonly categories: readonly ProvenanceCategory[];
    readonly semantic: typeof CODE_COMPILER_SEMANTIC;
    readonly compiler: string;
    readonly compilerVersion: string;
  };
}

export interface ThemeDescriptorCatalogV2 extends ThemeDescriptorBaseV2 {
  readonly catalogIdentity: typeof COMPONENT_CATALOG_IDENTITY;
  readonly catalogDigest: string;
  readonly catalog: {
    readonly identity: typeof COMPONENT_CATALOG_IDENTITY;
    readonly digest: string;
  };
  readonly compilerSemantic: typeof COMPONENT_COMPILER_SEMANTIC;
  readonly provenance: {
    readonly categories: readonly ProvenanceCategory[];
    readonly semantic: typeof COMPONENT_COMPILER_SEMANTIC;
    readonly compiler: string;
    readonly compilerVersion: string;
  };
}

export type ThemeDescriptorV2 =
  | ThemeDescriptorCoreV2
  | ThemeDescriptorCodeV2
  | ThemeDescriptorCatalogV2;

// ---------------------------------------------------------------------------
// Wire Models & Requests / Responses
// ---------------------------------------------------------------------------

export interface ThemeV2StyleFile {
  readonly path: string;
  readonly css: string;
}

export interface ThemeV2CompileRequest {
  specification: ThemeSpecificationV2;
  uiRevision: number;
  sessionId?: string | undefined;
  options?: {
    accent?: string | undefined;
    strictContrast?: boolean | undefined;
  } | undefined;
}

export interface ThemeV2CompileResponse {
  uiRevision: number;
  valid: boolean;
  compiledCss?: string | undefined;
  descriptor?: ThemeDescriptorV2 | undefined;
  styles?: readonly ThemeV2StyleFile[] | undefined;
  diagnostics: readonly ContrastDiagnostic[];
  error?: ThemeLabError | string | undefined;
}

export interface ThemeDocumentOpenRequest {
  uiRevision?: number | undefined;
  sessionId?: string | undefined;
}

export interface ThemeDocumentOpenResponse {
  cancelled: boolean;
  displayName?: string | undefined;
  specification?: ThemeSpecification | ThemeSpecificationV2 | undefined;
  compiledCss?: string | undefined;
  descriptor?: ThemeDescriptor | ThemeDescriptorV2 | undefined;
  styles?: readonly ThemeV2StyleFile[] | undefined;
  diagnostics: readonly ContrastDiagnostic[];
  error?: ThemeLabError | string | undefined;
}

export interface ThemeDocumentSaveRequest {
  saveAs: boolean;
  specification: ThemeSpecification | ThemeSpecificationV2;
  uiRevision: number;
  sessionId?: string | undefined;
}

export interface ThemeDraftUpdateRequest {
  sessionId: string;
  uiRevision: number;
}

export interface ThemeDraftUpdateResponse {
  uiRevision: number;
}

// ---------------------------------------------------------------------------
// Helpers & Strict Runtime Decoders
// ---------------------------------------------------------------------------

function expectObject(value: unknown, context = "value"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ThemeLabValidationError(`Expected object for ${context}`);
  }
  return value as Record<string, unknown>;
}

export function validateSafeRevision(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ThemeLabValidationError(`Expected safe non-negative integer for ${name}`);
  }
  return value;
}

const HEX_64_REGEX = /^[0-9a-f]{64}$/;

export function validateHexDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX_64_REGEX.test(value)) {
    throw new ThemeLabValidationError(`Expected 64-character lowercase hex digest for ${name}`);
  }
  return value;
}

export async function computeSha256Hex(content: string | Uint8Array): Promise<string> {
  const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const subtle =
    globalThis.crypto?.subtle ??
    (typeof window !== "undefined" ? window.crypto?.subtle : undefined);
  if (subtle?.digest) {
    const hashBuffer = await subtle.digest("SHA-256", data as unknown as BufferSource);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  throw new ThemeLabValidationError("Web Crypto API (crypto.subtle) is unavailable in current runtime");
}

export function isV2Specification(value: unknown): value is ThemeSpecificationV2 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).schemaVersion === "tfsl.theme-v2"
  );
}

export function isV2Descriptor(value: unknown): value is ThemeDescriptorV2 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).schema === "tfsl.theme-descriptor-v2"
  );
}

export function validateThemeSpecificationV2(value: unknown): ThemeSpecificationV2 {
  const obj = expectObject(value, "ThemeSpecificationV2");

  if (typeof obj.name !== "string" || !obj.name.trim()) {
    throw new ThemeLabValidationError("Specification missing valid 'name' string");
  }
  if (typeof obj.version !== "string" || !obj.version.trim()) {
    throw new ThemeLabValidationError("Specification missing valid 'version' string");
  }
  if (obj.schemaVersion !== "tfsl.theme-v2") {
    throw new ThemeLabValidationError(
      `Specification schemaVersion must be 'tfsl.theme-v2', received '${String(obj.schemaVersion)}'`
    );
  }
  if (obj.adapter !== "starlight-v0.42") {
    throw new ThemeLabValidationError(
      `Specification adapter must be 'starlight-v0.42', received '${String(obj.adapter)}'`
    );
  }
  if (typeof obj.defaultAccent !== "string" || !obj.defaultAccent.trim()) {
    throw new ThemeLabValidationError("Specification missing valid 'defaultAccent' string");
  }

  // Token Sets
  const tokenSetsObj = expectObject(obj.tokenSets, "tokenSets");
  for (const [setName, setVal] of Object.entries(tokenSetsObj)) {
    const setDict = expectObject(setVal, `tokenSets[${setName}]`);
    for (const [tokKey, tokVal] of Object.entries(setDict)) {
      if (typeof tokVal === "string") {
        continue;
      }
      if (typeof tokVal === "object" && tokVal !== null) {
        const tObj = tokVal as Record<string, unknown>;
        if (typeof tObj.value === "string" || typeof tObj.alias === "string") {
          continue;
        }
      }
      throw new ThemeLabValidationError(`Invalid token definition at tokenSets[${setName}][${tokKey}]`);
    }
  }

  // Accent Variants
  const variantsObj = expectObject(obj.accentVariants, "accentVariants");
  for (const [varName, varVal] of Object.entries(variantsObj)) {
    const vObj = expectObject(varVal, `accentVariants[${varName}]`);
    if (typeof vObj.tokenSet !== "string") {
      throw new ThemeLabValidationError(`accentVariants[${varName}] missing 'tokenSet' string`);
    }
    const light = expectObject(vObj.light, `accentVariants[${varName}].light`);
    const dark = expectObject(vObj.dark, `accentVariants[${varName}].dark`);
    for (const role of COLOR_ROLES) {
      if (typeof light[role] !== "string") {
        throw new ThemeLabValidationError(`accentVariants[${varName}].light missing role '${role}'`);
      }
      if (typeof dark[role] !== "string") {
        throw new ThemeLabValidationError(`accentVariants[${varName}].dark missing role '${role}'`);
      }
    }
  }

  // Typography
  const typoObj = expectObject(obj.typography, "typography");
  for (const role of ["body", "heading", "ui", "code"] as const) {
    const roleObj = expectObject(typoObj[role], `typography.${role}`);
    if (typeof roleObj.font !== "string") {
      throw new ThemeLabValidationError(`typography.${role}.font must be string`);
    }
    if (typeof roleObj.size !== "number" || !Number.isFinite(roleObj.size) || roleObj.size <= 0) {
      throw new ThemeLabValidationError(`typography.${role}.size must be positive finite number`);
    }
    if (
      typeof roleObj.lineHeight !== "number" ||
      !Number.isFinite(roleObj.lineHeight) ||
      roleObj.lineHeight <= 0
    ) {
      throw new ThemeLabValidationError(`typography.${role}.lineHeight must be positive finite number`);
    }
  }

  // Surfaces
  const surfObj = expectObject(obj.surfaces, "surfaces");
  for (const field of ["spacing", "radii", "border", "focus", "content", "sidebar"] as const) {
    if (typeof surfObj[field] !== "number" || !Number.isFinite(surfObj[field])) {
      throw new ThemeLabValidationError(`surfaces.${field} must be finite number`);
    }
  }
  if (surfObj.borderStyle !== undefined && !["solid", "dashed", "dotted"].includes(surfObj.borderStyle as string)) {
    throw new ThemeLabValidationError("surfaces.borderStyle must be 'solid' | 'dashed' | 'dotted'");
  }
  if (surfObj.focusOffset !== undefined && (typeof surfObj.focusOffset !== "number" || !Number.isFinite(surfObj.focusOffset))) {
    throw new ThemeLabValidationError("surfaces.focusOffset must be finite number");
  }

  // Layout Preset
  if (!["standard", "compact", "wide"].includes(obj.layoutPreset as string)) {
    throw new ThemeLabValidationError("layoutPreset must be 'standard' | 'compact' | 'wide'");
  }

  // Components
  const compObj = expectObject(obj.components, "components");
  if (!["consumer-default", "page-title-frame"].includes(compObj.pageTitle as string)) {
    throw new ThemeLabValidationError("components.pageTitle must be 'consumer-default' | 'page-title-frame'");
  }

  // Code Presentation
  if (obj.codePresentation !== "consumer-default") {
    const cpObj = expectObject(obj.codePresentation, "codePresentation");
    if (cpObj.mode !== "expressive-code") {
      throw new ThemeLabValidationError("codePresentation.mode must be 'expressive-code'");
    }
  }

  // Fonts
  if (!Array.isArray(obj.fonts)) {
    throw new ThemeLabValidationError("fonts must be an array");
  }

  // Preserve extra top-level fields losslessly
  return { ...obj } as unknown as ThemeSpecificationV2;
}

const ALLOWED_DESCRIPTOR_KEYS = new Set([
  "schema",
  "schemaVersion",
  "themeSchemaVersion",
  "themeName",
  "themeVersion",
  "adapter",
  "selectedAccent",
  "accent",
  "inputDigest",
  "outputDigest",
  "inventoryDigest",
  "catalogIdentity",
  "catalogDigest",
  "catalog",
  "compilerSemantic",
  "provenance",
]);

const ALLOWED_CATALOG_KEYS = new Set(["identity", "digest"]);
const ALLOWED_PROVENANCE_KEYS = new Set(["categories", "semantic", "compiler", "compilerVersion"]);

export function validateThemeDescriptorV2(value: unknown): ThemeDescriptorV2 {
  const obj = expectObject(value, "ThemeDescriptorV2");

  // Reject malformed unknown fields on descriptor
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_DESCRIPTOR_KEYS.has(key)) {
      throw new ThemeLabValidationError(`ThemeDescriptorV2 contains unexpected unknown field '${key}'`);
    }
  }

  if (obj.schema !== "tfsl.theme-descriptor-v2") {
    throw new ThemeLabValidationError(`Descriptor schema must be 'tfsl.theme-descriptor-v2', got '${String(obj.schema)}'`);
  }
  if (obj.schemaVersion !== 2) {
    throw new ThemeLabValidationError(`Descriptor schemaVersion must be 2, got '${String(obj.schemaVersion)}'`);
  }
  if (obj.themeSchemaVersion !== "tfsl.theme-v2") {
    throw new ThemeLabValidationError(`Descriptor themeSchemaVersion must be 'tfsl.theme-v2', got '${String(obj.themeSchemaVersion)}'`);
  }
  if (typeof obj.themeName !== "string" || !obj.themeName.trim()) {
    throw new ThemeLabValidationError("Descriptor missing valid 'themeName' string");
  }
  if (typeof obj.themeVersion !== "string" || !obj.themeVersion.trim()) {
    throw new ThemeLabValidationError("Descriptor missing valid 'themeVersion' string");
  }
  if (obj.adapter !== "starlight-v0.42") {
    throw new ThemeLabValidationError(`Descriptor adapter must be 'starlight-v0.42', got '${String(obj.adapter)}'`);
  }
  if (typeof obj.selectedAccent !== "string" || !obj.selectedAccent.trim()) {
    throw new ThemeLabValidationError("Descriptor missing valid 'selectedAccent' string");
  }
  if (obj.accent !== undefined && obj.accent !== obj.selectedAccent) {
    throw new ThemeLabValidationError("Descriptor accent does not match selectedAccent");
  }

  const inputDigest = validateHexDigest(obj.inputDigest, "inputDigest");
  const outputDigest = validateHexDigest(obj.outputDigest, "outputDigest");
  const inventoryDigest = validateHexDigest(obj.inventoryDigest, "inventoryDigest");
  const catalogDigest = validateHexDigest(obj.catalogDigest, "catalogDigest");

  const catalogIdentity = obj.catalogIdentity as string;
  if (!APPROVED_CATALOG_IDENTITIES.includes(catalogIdentity as CatalogIdentityV2)) {
    throw new ThemeLabValidationError(`Descriptor contains unrecognized or invalid catalogIdentity '${catalogIdentity}'`);
  }

  // Catalog object
  const catObj = expectObject(obj.catalog, "descriptor.catalog");
  for (const key of Object.keys(catObj)) {
    if (!ALLOWED_CATALOG_KEYS.has(key)) {
      throw new ThemeLabValidationError(`descriptor.catalog contains unexpected unknown field '${key}'`);
    }
  }
  if (catObj.identity !== catalogIdentity) {
    throw new ThemeLabValidationError("descriptor.catalog.identity does not match descriptor catalogIdentity");
  }
  if (catObj.digest !== catalogDigest) {
    throw new ThemeLabValidationError("descriptor.catalog.digest does not match descriptor catalogDigest");
  }

  // Compiler semantic pair
  let expectedSemantic: string;
  if (catalogIdentity === CORE_CATALOG_IDENTITY) {
    expectedSemantic = CORE_COMPILER_SEMANTIC;
  } else if (catalogIdentity === CODE_CATALOG_IDENTITY) {
    expectedSemantic = CODE_COMPILER_SEMANTIC;
  } else if (catalogIdentity === COMPONENT_CATALOG_IDENTITY) {
    expectedSemantic = COMPONENT_COMPILER_SEMANTIC;
  } else {
    throw new ThemeLabValidationError(`Unknown descriptor family for catalogIdentity '${catalogIdentity}'`);
  }

  if (obj.compilerSemantic !== expectedSemantic) {
    throw new ThemeLabValidationError(
      `Descriptor compilerSemantic '${String(obj.compilerSemantic)}' does not match catalog family expected '${expectedSemantic}'`
    );
  }

  // Provenance
  const provObj = expectObject(obj.provenance, "descriptor.provenance");
  for (const key of Object.keys(provObj)) {
    if (!ALLOWED_PROVENANCE_KEYS.has(key)) {
      throw new ThemeLabValidationError(`descriptor.provenance contains unexpected unknown field '${key}'`);
    }
  }
  if (provObj.semantic !== expectedSemantic) {
    throw new ThemeLabValidationError("descriptor.provenance.semantic does not match descriptor compilerSemantic");
  }
  if (!Array.isArray(provObj.categories) || provObj.categories.length === 0) {
    throw new ThemeLabValidationError("descriptor.provenance.categories must be non-empty array");
  }
  for (const cat of provObj.categories) {
    if (!PROVENANCE_CATEGORIES.includes(cat as ProvenanceCategory)) {
      throw new ThemeLabValidationError(`descriptor.provenance contains unknown category '${String(cat)}'`);
    }
  }
  if (typeof provObj.compiler !== "string" || !provObj.compiler.trim()) {
    throw new ThemeLabValidationError("descriptor.provenance.compiler must be non-empty string");
  }
  if (typeof provObj.compilerVersion !== "string" || !provObj.compilerVersion.trim()) {
    throw new ThemeLabValidationError("descriptor.provenance.compilerVersion must be non-empty string");
  }

  return {
    schema: "tfsl.theme-descriptor-v2",
    schemaVersion: 2,
    themeSchemaVersion: "tfsl.theme-v2",
    themeName: obj.themeName as string,
    themeVersion: obj.themeVersion as string,
    adapter: "starlight-v0.42",
    selectedAccent: obj.selectedAccent as string,
    ...(obj.accent !== undefined ? { accent: obj.accent as string } : {}),
    inputDigest,
    outputDigest,
    inventoryDigest,
    catalogIdentity: catalogIdentity as CatalogIdentityV2,
    catalogDigest,
    catalog: {
      identity: catalogIdentity as CatalogIdentityV2,
      digest: catalogDigest,
    },
    compilerSemantic: expectedSemantic as any,
    provenance: {
      categories: provObj.categories as ProvenanceCategory[],
      semantic: expectedSemantic as any,
      compiler: provObj.compiler as string,
      compilerVersion: provObj.compilerVersion as string,
    },
  } as ThemeDescriptorV2;
}

const ALLOWED_STYLE_KEYS = new Set(["path", "css"]);

export function validateThemeV2Styles(
  styles: unknown,
  descriptor?: ThemeDescriptorV2
): ThemeV2StyleFile[] {
  if (!Array.isArray(styles)) {
    throw new ThemeLabValidationError("styles must be an array");
  }

  const result: ThemeV2StyleFile[] = [];
  const seenPaths = new Set<string>();

  for (let i = 0; i < styles.length; i++) {
    const item = expectObject(styles[i], `styles[${i}]`);
    for (const key of Object.keys(item)) {
      if (!ALLOWED_STYLE_KEYS.has(key)) {
        throw new ThemeLabValidationError(`Style entry styles[${i}] contains unexpected unknown field '${key}'`);
      }
    }
    if (typeof item.path !== "string" || !item.path.trim()) {
      throw new ThemeLabValidationError(`styles[${i}].path must be non-empty string`);
    }
    if (typeof item.css !== "string") {
      throw new ThemeLabValidationError(`styles[${i}].css must be string`);
    }
    if (seenPaths.has(item.path)) {
      throw new ThemeLabValidationError(`Duplicate style file path: '${item.path}'`);
    }
    seenPaths.add(item.path);
    result.push({ path: item.path, css: item.css });
  }

  if (descriptor) {
    const actualPaths = result.map((s) => s.path);
    if (descriptor.catalogIdentity === CORE_CATALOG_IDENTITY) {
      if (
        actualPaths.length !== CORE_STYLE_FILES.length ||
        !CORE_STYLE_FILES.every((p, idx) => actualPaths[idx] === p)
      ) {
        throw new ThemeLabValidationError(
          `Styles order/contents mismatch for core catalog. Expected [${CORE_STYLE_FILES.join(
            ", "
          )}], got [${actualPaths.join(", ")}]`
        );
      }
    } else if (descriptor.catalogIdentity === CODE_CATALOG_IDENTITY) {
      if (
        actualPaths.length !== CODE_STYLE_FILES.length ||
        !CODE_STYLE_FILES.every((p, idx) => actualPaths[idx] === p)
      ) {
        throw new ThemeLabValidationError(
          `Styles order/contents mismatch for code catalog. Expected [${CODE_STYLE_FILES.join(
            ", "
          )}], got [${actualPaths.join(", ")}]`
        );
      }
    } else if (descriptor.catalogIdentity === COMPONENT_CATALOG_IDENTITY) {
      const matchesNoCode =
        actualPaths.length === CATALOG_STYLE_FILES_NO_CODE.length &&
        CATALOG_STYLE_FILES_NO_CODE.every((p, idx) => actualPaths[idx] === p);
      const matchesWithCode =
        actualPaths.length === CATALOG_STYLE_FILES_WITH_CODE.length &&
        CATALOG_STYLE_FILES_WITH_CODE.every((p, idx) => actualPaths[idx] === p);
      if (!matchesNoCode && !matchesWithCode) {
        throw new ThemeLabValidationError(
          `Styles order/contents mismatch for component catalog. Received [${actualPaths.join(", ")}]`
        );
      }
    }
  }

  return result;
}

export async function verifyThemeV2CompiledCssAndInventory(
  styles: readonly ThemeV2StyleFile[],
  descriptor: ThemeDescriptorV2,
  compiledCss?: string
): Promise<void> {
  const concatenatedCss = styles.map((s) => s.css).join("\n\n") + "\n";
  if (compiledCss !== undefined && compiledCss !== concatenatedCss) {
    throw new ThemeLabValidationError("compiledCss does not match ordered concatenated styles");
  }

  const computedOutputDigest = await computeSha256Hex(concatenatedCss);
  if (computedOutputDigest !== descriptor.outputDigest) {
    throw new ThemeLabValidationError(
      `Computed outputDigest '${computedOutputDigest}' does not match descriptor outputDigest '${descriptor.outputDigest}'`
    );
  }

  const inventoryItems = await Promise.all(
    styles.map(async (s) => ({
      path: s.path,
      sha256: await computeSha256Hex(s.css),
      size: new TextEncoder().encode(s.css).byteLength,
    }))
  );

  const inventoryPayload = "tfsl.styles-inventory-v2\n" + JSON.stringify(inventoryItems);
  const computedInventoryDigest = await computeSha256Hex(inventoryPayload);
  if (computedInventoryDigest !== descriptor.inventoryDigest) {
    throw new ThemeLabValidationError(
      `Computed inventoryDigest '${computedInventoryDigest}' does not match descriptor inventoryDigest '${descriptor.inventoryDigest}'`
    );
  }
}

export async function validateThemeV2CompileResponse(value: unknown): Promise<ThemeV2CompileResponse> {
  const obj = expectObject(value, "ThemeV2CompileResponse");
  const uiRevision = validateSafeRevision(obj.uiRevision, "compileV2 uiRevision");
  if (typeof obj.valid !== "boolean") {
    throw new ThemeLabValidationError("Expected boolean for compileV2 valid");
  }

  const diagnostics = validateDiagnostics(obj.diagnostics);
  const error = validateError(obj.error);

  if (!obj.valid) {
    return {
      uiRevision,
      valid: false,
      diagnostics,
      error,
    };
  }

  if (!obj.descriptor) {
    throw new ThemeLabValidationError("Valid v2 compilation response must include a descriptor");
  }

  const descriptor = validateThemeDescriptorV2(obj.descriptor);
  const styles = validateThemeV2Styles(obj.styles, descriptor);
  let compiledCss = typeof obj.compiledCss === "string" ? obj.compiledCss : undefined;

  if (styles) {
    await verifyThemeV2CompiledCssAndInventory(styles, descriptor, compiledCss);
    compiledCss = compiledCss ?? styles.map((s) => s.css).join("\n\n") + "\n";
  }

  return {
    uiRevision,
    valid: true,
    compiledCss,
    descriptor,
    styles,
    diagnostics,
    error,
  };
}

export async function validateThemeDocumentOpenResponse(value: unknown): Promise<ThemeDocumentOpenResponse> {
  const obj = expectObject(value, "ThemeDocumentOpenResponse");
  if (typeof obj.cancelled !== "boolean") {
    throw new ThemeLabValidationError("Expected boolean for openDocument cancelled");
  }

  const displayName = typeof obj.displayName === "string" ? obj.displayName : undefined;
  const diagnostics = validateDiagnostics(obj.diagnostics);
  const error = validateError(obj.error);

  if (obj.cancelled) {
    return {
      cancelled: true,
      displayName,
      diagnostics,
      error,
    };
  }

  let specification: ThemeSpecification | ThemeSpecificationV2 | undefined;
  let descriptor: ThemeDescriptor | ThemeDescriptorV2 | undefined;
  let styles: readonly ThemeV2StyleFile[] | undefined;
  let compiledCss = typeof obj.compiledCss === "string" ? obj.compiledCss : undefined;

  if (obj.specification) {
    if (isV2Specification(obj.specification)) {
      specification = validateThemeSpecificationV2(obj.specification);
      descriptor = validateThemeDescriptorV2(obj.descriptor);
      styles = validateThemeV2Styles(obj.styles, descriptor);
      if (styles && descriptor) {
        await verifyThemeV2CompiledCssAndInventory(styles, descriptor as ThemeDescriptorV2, compiledCss);
        compiledCss = compiledCss ?? styles.map((s) => s.css).join("\n\n") + "\n";
      }
    } else {
      specification = expectObject(obj.specification) as unknown as ThemeSpecification;
      descriptor = validateDescriptorV1(obj.descriptor);
    }
  }

  return {
    cancelled: false,
    displayName,
    specification,
    compiledCss,
    descriptor,
    styles,
    diagnostics,
    error,
  };
}

export function validateDraftUpdateResponse(value: unknown): ThemeDraftUpdateResponse {
  const obj = expectObject(value, "ThemeDraftUpdateResponse");
  return {
    uiRevision: validateSafeRevision(obj.uiRevision, "draftUpdate uiRevision"),
  };
}
