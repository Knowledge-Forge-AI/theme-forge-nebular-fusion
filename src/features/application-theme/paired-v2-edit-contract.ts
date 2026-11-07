import {
  PAIRED_V2_COLOR_MODES,
  PAIRED_V2_COLOR_ROLES,
  PAIRED_V2_RADIUS_ROLES,
  PAIRED_V2_TYPOGRAPHY_ROLES,
  type PairedV2ColorEditPath,
} from "./paired-v2-authoring-types";

export const PAIRED_V2_APPLICATION_UI_FAMILIES = Object.freeze([
  "system-ui",
  "monospace",
  "sans-serif",
  "serif",
] as const);

const PAIRED_V2_MAX_EXPLICIT_LENGTH_BYTES = 64;
const PAIRED_V2_MAX_FONT_STACK_BYTES = 500;
const PAIRED_V2_MAX_FONT_FAMILY_ITEM_BYTES = 100;
const PAIRED_V2_MAX_LINE_HEIGHT = 10;
const PAIRED_V2_MAX_HEX_VALUE_BYTES = 9;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  return Object.keys(value).every((key) => allowed.has(key)) &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function containsForbiddenControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function containsForbiddenCssDelimiters(value: string): boolean {
  return /[{};]/.test(value);
}

function hasBoundedUntrustedText(value: string, maxBytes: number, rejectCssDelimiters: boolean): boolean {
  return value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maxBytes &&
    !containsForbiddenControlCharacters(value) &&
    (!rejectCssDelimiters || !containsForbiddenCssDelimiters(value));
}

export function isPairedV2ColorPath(path: string): path is PairedV2ColorEditPath {
  const parts = path.split(".");
  return (
    parts.length === 3 &&
    parts[0] === "color" &&
    (PAIRED_V2_COLOR_MODES as readonly string[]).includes(parts[1] ?? "") &&
    (PAIRED_V2_COLOR_ROLES as readonly string[]).includes(parts[2] ?? "")
  );
}

export function isPairedV2TypographyPath(path: string): boolean {
  const parts = path.split(".");
  return (
    parts.length === 3 &&
    parts[0] === "typography" &&
    (PAIRED_V2_TYPOGRAPHY_ROLES as readonly string[]).includes(parts[1] ?? "") &&
    ["family", "size", "lineHeight"].includes(parts[2] ?? "")
  );
}

export function isPairedV2RadiusPath(path: string): boolean {
  const parts = path.split(".");
  return (
    parts.length === 2 &&
    parts[0] === "radius" &&
    (PAIRED_V2_RADIUS_ROLES as readonly string[]).includes(parts[1] ?? "")
  );
}

export function isPairedV2ClearOptionalPath(path: string): boolean {
  const parts = path.split(".");
  if (parts[0] === "color") {
    return (
      parts.length === 3 &&
      (PAIRED_V2_COLOR_MODES as readonly string[]).includes(parts[1] ?? "") &&
      ["hover", "active"].includes(parts[2] ?? "")
    );
  }
  if (parts.length === 2 && parts[0] === "radius") {
    return ["control", "overlay"].includes(parts[1] ?? "");
  }
  return (
    parts.length === 3 &&
    parts[0] === "typography" &&
    (PAIRED_V2_TYPOGRAPHY_ROLES as readonly string[]).includes(parts[1] ?? "") &&
    ["size", "lineHeight"].includes(parts[2] ?? "")
  );
}

export function isPairedV2ApplicationColorValue(path: string, value: string): boolean {
  return hasBoundedUntrustedText(value, PAIRED_V2_MAX_HEX_VALUE_BYTES, true) &&
    ((!path.endsWith(".selection") && !path.endsWith(".selectionText")) || /^#[0-9a-f]{6}$/i.test(value));
}

export function isPairedV2ApplicationTypographyValue(path: string, value: string | number): boolean {
  if (path.endsWith(".family")) {
    if (typeof value !== "string") return false;
    if (path === "typography.ui.family" &&
        !(PAIRED_V2_APPLICATION_UI_FAMILIES as readonly string[]).includes(value)) {
      return false;
    }
    if (!hasBoundedUntrustedText(value, PAIRED_V2_MAX_FONT_STACK_BYTES, true)) return false;
    return value.split(",").every((item) =>
      new TextEncoder().encode(item).byteLength <= PAIRED_V2_MAX_FONT_FAMILY_ITEM_BYTES);
  }
  if (path.endsWith(".size")) {
    return typeof value === "string" &&
      hasBoundedUntrustedText(value, PAIRED_V2_MAX_EXPLICIT_LENGTH_BYTES, true);
  }
  if (path.endsWith(".lineHeight")) {
    return typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= PAIRED_V2_MAX_LINE_HEIGHT;
  }
  return false;
}

export function isPairedV2ApplicationRadiusValue(path: string, value: string): boolean {
  return hasBoundedUntrustedText(value, PAIRED_V2_MAX_EXPLICIT_LENGTH_BYTES, true) &&
    (path !== "radius.surface" || /^\d+(?:\.\d+)?(?:px|rem|em)$/.test(value));
}

/**
 * Closed, side-effect-free validator for cross-language edit-contract fixtures.
 * It validates only the transport grammar and recipe-required value shapes;
 * it does not normalize, hash, or map a profile.
 */
export function isPairedV2EditContractCaseAllowed(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const edit = value as Record<string, unknown>;
  if (typeof edit.kind !== "string" || typeof edit.path !== "string") return false;
  if (containsForbiddenControlCharacters(edit.path)) return false;
  if (edit.kind === "clear-optional") {
    return exactKeys(edit, ["kind", "path"]) && isPairedV2ClearOptionalPath(edit.path);
  }
  if (!exactKeys(edit, ["kind", "path", "value"]) ||
      (typeof edit.value !== "string" && typeof edit.value !== "number")) return false;
  if (typeof edit.value === "string" &&
      (edit.value.length === 0 || containsForbiddenControlCharacters(edit.value))) return false;
  if (typeof edit.value === "number" && (!Number.isFinite(edit.value) || Math.abs(edit.value) > 100_000)) return false;
  if (edit.kind === "set-color") {
    return typeof edit.value === "string" && isPairedV2ColorPath(edit.path) &&
      isPairedV2ApplicationColorValue(edit.path, edit.value);
  }
  if (edit.kind === "set-typography") {
    return isPairedV2TypographyPath(edit.path) &&
      isPairedV2ApplicationTypographyValue(edit.path, edit.value);
  }
  if (edit.kind === "set-radius") {
    return typeof edit.value === "string" && isPairedV2RadiusPath(edit.path) &&
      isPairedV2ApplicationRadiusValue(edit.path, edit.value);
  }
  return false;
}
