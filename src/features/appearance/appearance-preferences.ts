import type { AppearanceCatalog, AppearanceFamily } from "./appearance-controller";
import type { AppearanceModePreference, EffectiveAppearanceMode } from "./appearance-session";

export type AppearanceSide = "light" | "dark";

/** Versioned, storage-shaped data. `light` and `dark` are overrides. */
export interface AppearancePreferenceRecordV1 {
  readonly version: 1;
  readonly mode?: AppearanceModePreference;
  readonly light?: string;
  readonly dark?: string;
}

/** Defaults are supplied by the application/catalog owner, not stored here. */
export interface AppearanceFamilyDefaults {
  readonly light: string;
  readonly dark: string;
  readonly mode: AppearanceModePreference;
}

export type AppearancePreferenceDiagnosticCode =
  | "invalid-input"
  | "invalid-version"
  | "unsupported-version"
  | "unknown-key"
  | "invalid-mode"
  | "invalid-override"
  | "missing-family"
  | "invalid-default"
  | "invalid-default-mode"
  | "invalid-system-mode"
  | "empty-catalog";

export interface AppearancePreferenceDiagnostic {
  readonly code: AppearancePreferenceDiagnosticCode;
  readonly side?: AppearanceSide;
  readonly familyId?: string;
  readonly fallbackFamilyId?: string;
}

export interface DecodedAppearancePreferences {
  readonly accepted: boolean;
  readonly record: AppearancePreferenceRecordV1;
  readonly diagnostics: readonly AppearancePreferenceDiagnostic[];
}

export interface ResolvedAppearancePreferences {
  readonly record: AppearancePreferenceRecordV1;
  readonly modePreference: AppearanceModePreference;
  readonly effectiveMode: EffectiveAppearanceMode;
  readonly resolvedFamilies: Readonly<{
    readonly light: AppearanceFamily | null;
    readonly dark: AppearanceFamily | null;
  }>;
  readonly diagnostics: readonly AppearancePreferenceDiagnostic[];
}

const ALLOWED_KEYS = new Set(["version", "mode", "light", "dark"]);
const DEFAULT_MODE: AppearanceModePreference = "system";
const MAX_FAMILY_ID_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModePreference(value: unknown): value is AppearanceModePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isEffectiveAppearanceMode(value: unknown): value is EffectiveAppearanceMode {
  return value === "light" || value === "dark";
}

function isFamilyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FAMILY_ID_LENGTH;
}

function diagnostic(
  code: AppearancePreferenceDiagnosticCode,
  details: Omit<AppearancePreferenceDiagnostic, "code"> = {},
): AppearancePreferenceDiagnostic {
  return Object.freeze({ code, ...details });
}

function makeRecord(
  mode?: AppearanceModePreference,
  light?: string,
  dark?: string,
): AppearancePreferenceRecordV1 {
  return Object.freeze({
    version: 1 as const,
    ...(mode === undefined ? {} : { mode }),
    ...(light === undefined ? {} : { light }),
    ...(dark === undefined ? {} : { dark }),
  });
}

function emptyRecord(): AppearancePreferenceRecordV1 {
  return makeRecord();
}

function rejected(diagnosticValue: AppearancePreferenceDiagnostic): DecodedAppearancePreferences {
  return Object.freeze({
    accepted: false,
    record: emptyRecord(),
    diagnostics: Object.freeze([diagnosticValue]),
  });
}

/**
 * Decode only the bounded version-1 record shape. Invalid input is rejected
 * into a known-good in-memory fallback; nothing is persisted or rewritten.
 */
export function decodeAppearancePreferences(input: unknown): DecodedAppearancePreferences {
  try {
    if (!isRecord(input)) return rejected(diagnostic("invalid-input"));
  } catch {
    return rejected(diagnostic("invalid-input"));
  }

  let keys: readonly string[];
  let symbols: readonly symbol[];
  let version: unknown;
  let mode: unknown;
  let light: unknown;
  let dark: unknown;
  let hasVersion = false;
  let hasMode = false;
  let hasLight = false;
  let hasDark = false;
  try {
    keys = Object.getOwnPropertyNames(input);
    symbols = Object.getOwnPropertySymbols(input);
    version = input.version;
    mode = input.mode;
    const ownKeys = new Set(keys);
    hasVersion = ownKeys.has("version");
    hasMode = ownKeys.has("mode");
    hasLight = ownKeys.has("light");
    hasDark = ownKeys.has("dark");
    light = hasLight ? input.light : undefined;
    dark = hasDark ? input.dark : undefined;
  } catch {
    return rejected(diagnostic("invalid-input"));
  }

  if (symbols.length > 0) return rejected(diagnostic("unknown-key"));
  const unknownKey = keys.find((key) => !ALLOWED_KEYS.has(key));
  if (unknownKey !== undefined) return rejected(diagnostic("unknown-key"));
  if (!hasVersion || typeof version !== "number" || !Number.isInteger(version)) {
    return rejected(diagnostic("invalid-version"));
  }
  if (version !== 1) return rejected(diagnostic("unsupported-version"));
  if (hasMode && !isModePreference(mode)) {
    return rejected(diagnostic("invalid-mode"));
  }
  if (hasLight && !isFamilyId(light)) {
    return rejected(diagnostic("invalid-override", { side: "light" }));
  }
  if (hasDark && !isFamilyId(dark)) {
    return rejected(diagnostic("invalid-override", { side: "dark" }));
  }

  const record = makeRecord(
    hasMode ? (mode as AppearanceModePreference) : undefined,
    hasLight ? (light as string) : undefined,
    hasDark ? (dark as string) : undefined,
  );
  return Object.freeze({
    accepted: true,
    record,
    diagnostics: Object.freeze([]),
  });
}

/** Create a frozen version-1 record without retaining caller-owned objects. */
export function createAppearancePreferenceRecord(
  mode?: AppearanceModePreference,
): AppearancePreferenceRecordV1 {
  return makeRecord(mode === undefined ? undefined : (isModePreference(mode) ? mode : undefined));
}

/** Atomically replace both concrete family overrides, preserving mode. */
export function setAppearancePair(
  record: AppearancePreferenceRecordV1,
  lightFamilyId: string,
  darkFamilyId: string,
): AppearancePreferenceRecordV1 {
  if (!isFamilyId(lightFamilyId) || !isFamilyId(darkFamilyId)) return cloneRecord(record);
  return makeRecord(record.mode, lightFamilyId, darkFamilyId);
}

/** Replace only one side, preserving the other side and mode. */
export function setAppearanceSide(
  record: AppearancePreferenceRecordV1,
  side: AppearanceSide,
  familyId: string,
): AppearancePreferenceRecordV1 {
  if (!isFamilyId(familyId)) return cloneRecord(record);
  if (side === "light") return makeRecord(record.mode, familyId, record.dark);
  if (side === "dark") return makeRecord(record.mode, record.light, familyId);
  return makeRecord(record.mode, record.light, record.dark);
}

/** Change only the mode preference, preserving both side overrides. */
export function setAppearanceMode(
  record: AppearancePreferenceRecordV1,
  mode: AppearanceModePreference,
): AppearancePreferenceRecordV1 {
  return makeRecord(isModePreference(mode) ? mode : record.mode, record.light, record.dark);
}

/** Application default means no concrete family override on either side. */
export function selectApplicationDefault(
  record: AppearancePreferenceRecordV1,
): AppearancePreferenceRecordV1 {
  return makeRecord(record.mode);
}

/** Reset clears explicit overrides so both sides and mode follow product defaults. */
export function resetAppearancePreferences(
  _record: AppearancePreferenceRecordV1,
): AppearancePreferenceRecordV1 {
  return emptyRecord();
}

interface CatalogSnapshot {
  readonly byId: ReadonlyMap<string, AppearanceFamily>;
  readonly fallbackFamilyId: string | null;
}

function snapshotCatalog(input: AppearanceCatalog): CatalogSnapshot {
  const byId = new Map<string, AppearanceFamily>();
  let defaultFamily: unknown;
  let families: unknown;
  try {
    defaultFamily = input.defaultFamily;
    families = input.families;
    if (!Array.isArray(families)) return { byId, fallbackFamilyId: null };
    for (const family of families) {
      if (!isRecord(family)) continue;
      const id = family.id;
      const label = family.label;
      const css = family.css;
      if (typeof id !== "string" || id.length === 0 || byId.has(id)) continue;
      if (typeof label !== "string" || typeof css !== "string") continue;
      byId.set(id, Object.freeze({ id, label, css }));
    }
  } catch {
    return { byId, fallbackFamilyId: null };
  }

  if (typeof defaultFamily === "string" && byId.has(defaultFamily)) {
    return { byId, fallbackFamilyId: defaultFamily };
  }
  return { byId, fallbackFamilyId: byId.keys().next().value ?? null };
}

function defaultFamilyForSide(
  side: AppearanceSide,
  defaults: AppearanceFamilyDefaults,
  catalog: CatalogSnapshot,
  diagnostics: AppearancePreferenceDiagnostic[],
): string | null {
  let requested: unknown;
  try {
    requested = defaults[side];
  } catch {
    requested = undefined;
  }
  if (isFamilyId(requested) && catalog.byId.has(requested)) return requested;
  diagnostics.push(diagnostic("invalid-default", {
    side,
    ...(typeof requested === "string" ? { familyId: requested } : {}),
    ...(catalog.fallbackFamilyId === null ? {} : { fallbackFamilyId: catalog.fallbackFamilyId }),
  }));
  return catalog.fallbackFamilyId;
}

function defaultModeForApplication(
  defaults: AppearanceFamilyDefaults,
  diagnostics: AppearancePreferenceDiagnostic[],
): AppearanceModePreference {
  let requested: unknown;
  try {
    requested = defaults.mode;
  } catch {
    requested = undefined;
  }
  if (isModePreference(requested)) return requested;
  diagnostics.push(diagnostic("invalid-default-mode"));
  return DEFAULT_MODE;
}

function cloneRecord(record: AppearancePreferenceRecordV1): AppearancePreferenceRecordV1 {
  return makeRecord(record.mode, record.light, record.dark);
}

function cloneDiagnostics(
  diagnostics: readonly AppearancePreferenceDiagnostic[],
): AppearancePreferenceDiagnostic[] {
  return diagnostics.map((entry) => Object.freeze({ ...entry }));
}

/**
 * Resolve each side independently against a snapshotted catalog. Missing
 * override IDs remain in `record`; only the resolved family uses its closed,
 * known-good side default and emits a diagnostic.
 */
export function resolveAppearancePreferences(
  decoded: DecodedAppearancePreferences,
  catalogInput: AppearanceCatalog,
  defaultsInput: AppearanceFamilyDefaults,
  systemMode: EffectiveAppearanceMode,
): ResolvedAppearancePreferences {
  const record = cloneRecord(decoded.record);
  const diagnostics = cloneDiagnostics(decoded.diagnostics);
  const catalog = snapshotCatalog(catalogInput);
  if (catalog.fallbackFamilyId === null) diagnostics.push(diagnostic("empty-catalog"));
  const defaultMode = defaultModeForApplication(defaultsInput, diagnostics);

  const resolved: { light: AppearanceFamily | null; dark: AppearanceFamily | null } = {
    light: null,
    dark: null,
  };
  for (const side of ["light", "dark"] as const) {
    const fallbackId = defaultFamilyForSide(side, defaultsInput, catalog, diagnostics);
    const overrideId = record[side];
    const selectedId = overrideId === undefined ? fallbackId : overrideId;
    const selectedFamily = selectedId === null ? undefined : catalog.byId.get(selectedId);
    if (selectedFamily) {
      resolved[side] = selectedFamily;
      continue;
    }
    if (overrideId !== undefined) {
      diagnostics.push(diagnostic("missing-family", {
        side,
        familyId: overrideId,
        ...(fallbackId === null ? {} : { fallbackFamilyId: fallbackId }),
      }));
    }
    resolved[side] = fallbackId === null ? null : (catalog.byId.get(fallbackId) ?? null);
  }

  const safeSystemMode = isEffectiveAppearanceMode(systemMode) ? systemMode : "light";
  if (safeSystemMode !== systemMode) diagnostics.push(diagnostic("invalid-system-mode"));
  const modePreference = record.mode ?? defaultMode;
  const effectiveMode = modePreference === "system" ? safeSystemMode : modePreference;
  return Object.freeze({
    record,
    modePreference,
    effectiveMode,
    resolvedFamilies: Object.freeze(resolved),
    diagnostics: Object.freeze(diagnostics),
  });
}
