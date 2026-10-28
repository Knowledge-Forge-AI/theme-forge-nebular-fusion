#!/usr/bin/env node
// Theme Forge Solar Sail Studio Adapter
// Provides sandboxed compilation, paired mapping, and package export over stdin/stdout.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as solarSail from "../solar-sail-payload/dist/index.js";
import {
  COMPILER_NAME,
  COMPILER_VERSION,
  THEME_SCHEMA_VERSION,
  compileTheme,
  validateThemeSpecification,
  generateThemePackage,
  writePackageFiles,
  mapProfileToSolarSail,
  mapProfileToStellarLoom,
} from "../solar-sail-payload/dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MAX_INPUT = 32 * 1024 * 1024;
const MAX_PROFILE_DOCUMENT_BYTES = 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil((MAX_PROFILE_DOCUMENT_BYTES * 4) / 3) + 4;
const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;

function sanitizeText(value, maxChars = 512) {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const withoutAnsi = raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, " ")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, " ");
  let cleaned = "";
  for (let i = 0; i < withoutAnsi.length; i++) {
    const code = withoutAnsi.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < withoutAnsi.length) {
        const next = withoutAnsi.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          cleaned += withoutAnsi[i] + withoutAnsi[i + 1];
          i += 1;
        }
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      continue;
    }
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      cleaned += " ";
      continue;
    }
    cleaned += withoutAnsi[i];
  }
  const collapsed = cleaned.replace(/\s+/gu, " ").trim();
  if (collapsed.length > maxChars) {
    return collapsed.slice(0, maxChars);
  }
  return collapsed;
}

function sanitizeErrorCode(code, fallback = "SCHEMA_VALIDATION") {
  if (typeof code === "string") {
    const trimmed = code.trim();
    if (ERROR_CODE_RE.test(trimmed)) {
      return trimmed;
    }
  }
  return fallback;
}

function sanitizeDetails(details, fallbackMessage) {
  if (Array.isArray(details) && details.length > 0) {
    const items = details
      .slice(0, 16)
      .map((item) => sanitizeText(typeof item === "string" ? item : item?.message ?? String(item), 512))
      .filter(Boolean);
    if (items.length > 0) {
      return items;
    }
  }
  const fallback = sanitizeText(fallbackMessage, 512);
  return fallback ? [fallback] : ["Validation failed"];
}

function decodeBase64Strict(b64) {
  if (typeof b64 !== "string") {
    throw new Error("INVALID_BASE64_ENVELOPE");
  }
  if (b64.length > MAX_BASE64_CHARS || b64.length % 4 !== 0 || !STRICT_BASE64_RE.test(b64)) {
    throw new Error("INVALID_BASE64_ENVELOPE");
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.byteLength > MAX_PROFILE_DOCUMENT_BYTES || buf.toString("base64") !== b64) {
    throw new Error("INVALID_BASE64_ENVELOPE");
  }
  return buf;
}

const COLOR_TOKEN_KEYS = [
  "background", "foreground", "card", "cardForeground", "popover", "popoverForeground",
  "primary", "primaryForeground", "secondary", "secondaryForeground", "muted", "mutedForeground",
  "accent", "accentForeground", "destructive", "destructiveForeground", "border", "input", "ring",
  "chart1", "chart2", "chart3", "chart4", "chart5", "sidebar", "sidebarForeground",
  "sidebarPrimary", "sidebarPrimaryForeground", "sidebarAccent", "sidebarAccentForeground",
  "sidebarBorder", "sidebarRing",
];
const SYNTAX_PALETTE_KEYS = [
  "background", "foreground", "comment", "string", "number", "constant", "keyword",
  "function", "type", "variable", "punctuation", "tag", "attribute", "operator",
];
const CHROME_ROLE_KEYS = [
  "background", "foreground", "border", "focus", "tabBarBackground", "tabBarBorder",
  "activeTabBackground", "activeTabForeground", "activeTabBorder", "terminalTitlebarBackground",
  "terminalTitlebarForeground", "copyButtonForeground", "copyButtonBorder",
  "tooltipSuccessBackground", "tooltipSuccessForeground",
];
const DIFF_ROLE_KEYS = [
  "inserted", "deleted", "marked", "insertedBackground", "deletedBackground", "markedBackground",
];
const LOOM_TYPOGRAPHY_KEYS = [
  "fontSans", "fontHeading", "fontMono", "primaryFamily", "secondaryFamily",
];

function pickStringMap(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  const out = {};
  for (const key of keys) {
    if (typeof obj[key] === "string") {
      out[key] = obj[key];
    }
  }
  return out;
}

function isU32(val) {
  return typeof val === "number" && Number.isInteger(val) && val >= 0 && val <= 0xffffffff;
}

function projectSurfacesDto(surfaces) {
  if (!surfaces || typeof surfaces !== "object") return undefined;
  const out = {};
  if (typeof surfaces.radius === "string") out.radius = surfaces.radius;
  if (typeof surfaces.borderWidth === "string") out.borderWidth = surfaces.borderWidth;
  if (isU32(surfaces.content)) out.content = surfaces.content;
  return out;
}

function projectPaletteOverridesDto(palette) {
  if (!palette || typeof palette !== "object") return undefined;
  const out = {};
  if (palette.light && typeof palette.light === "object") {
    out.light = pickStringMap(palette.light, COLOR_TOKEN_KEYS);
  }
  if (palette.dark && typeof palette.dark === "object") {
    out.dark = pickStringMap(palette.dark, COLOR_TOKEN_KEYS);
  }
  return out;
}

function projectSyntaxOverridesDto(syntax) {
  if (!syntax || typeof syntax !== "object") return undefined;
  const out = {};
  if (syntax.light && typeof syntax.light === "object") {
    out.light = pickStringMap(syntax.light, SYNTAX_PALETTE_KEYS);
  }
  if (syntax.dark && typeof syntax.dark === "object") {
    out.dark = pickStringMap(syntax.dark, SYNTAX_PALETTE_KEYS);
  }
  return out;
}

function projectV1ProfileToStudioDto(profile) {
  if (!profile || typeof profile !== "object") return null;
  const out = {
    schemaVersion: "tf-paired-profile-v1",
    name: String(profile.name ?? ""),
    version: String(profile.version ?? ""),
    palette: {
      light: pickStringMap(profile.palette?.light, COLOR_TOKEN_KEYS) ?? {},
      dark: pickStringMap(profile.palette?.dark, COLOR_TOKEN_KEYS) ?? {},
    },
    surfaces: projectSurfacesDto(profile.surfaces) ?? { radius: "0.5rem" },
    typography: pickStringMap(profile.typography, ["fontSans", "fontHeading", "fontMono"]) ?? {
      fontSans: "sans-serif",
    },
  };
  if (typeof profile.description === "string") {
    out.description = profile.description;
  }
  const to = profile.targetOverrides;
  if (to && typeof to === "object") {
    const projectedTo = {};
    if (to.loom && typeof to.loom === "object") {
      const loom = {};
      if (isU32(to.loom.content)) loom.content = to.loom.content;
      if (typeof to.loom.defaultAccent === "string") loom.defaultAccent = to.loom.defaultAccent;
      if (typeof to.loom.primaryFamily === "string") loom.primaryFamily = to.loom.primaryFamily;
      if (typeof to.loom.secondaryFamily === "string") loom.secondaryFamily = to.loom.secondaryFamily;
      if (to.loom.palette && typeof to.loom.palette === "object") {
        loom.palette = projectPaletteOverridesDto(to.loom.palette);
      }
      if (to.loom.surfaces && typeof to.loom.surfaces === "object") {
        loom.surfaces = projectSurfacesDto(to.loom.surfaces);
      }
      if (to.loom.typography && typeof to.loom.typography === "object") {
        loom.typography = pickStringMap(to.loom.typography, LOOM_TYPOGRAPHY_KEYS);
      }
      if (to.loom.syntax && typeof to.loom.syntax === "object") {
        loom.syntax = projectSyntaxOverridesDto(to.loom.syntax);
      }
      projectedTo.loom = loom;
    }
    if (to.solarSail && typeof to.solarSail === "object") {
      const ss = {};
      if (to.solarSail.surfaces && typeof to.solarSail.surfaces === "object") {
        ss.surfaces = projectSurfacesDto(to.solarSail.surfaces);
      }
      if (to.solarSail.palette && typeof to.solarSail.palette === "object") {
        ss.palette = projectPaletteOverridesDto(to.solarSail.palette);
      }
      projectedTo.solarSail = ss;
    }
    if (to.syntax && typeof to.syntax === "object") {
      const syn = {};
      if (to.syntax.syntax && typeof to.syntax.syntax === "object") {
        syn.syntax = projectSyntaxOverridesDto(to.syntax.syntax);
      }
      if (to.syntax.chrome && typeof to.syntax.chrome === "object") {
        const chrome = {};
        if (to.syntax.chrome.light && typeof to.syntax.chrome.light === "object") {
          chrome.light = pickStringMap(to.syntax.chrome.light, CHROME_ROLE_KEYS);
        }
        if (to.syntax.chrome.dark && typeof to.syntax.chrome.dark === "object") {
          chrome.dark = pickStringMap(to.syntax.chrome.dark, CHROME_ROLE_KEYS);
        }
        syn.chrome = chrome;
      }
      if (to.syntax.diffs && typeof to.syntax.diffs === "object") {
        const diffs = {};
        if (to.syntax.diffs.light && typeof to.syntax.diffs.light === "object") {
          diffs.light = pickStringMap(to.syntax.diffs.light, DIFF_ROLE_KEYS);
        }
        if (to.syntax.diffs.dark && typeof to.syntax.diffs.dark === "object") {
          diffs.dark = pickStringMap(to.syntax.diffs.dark, DIFF_ROLE_KEYS);
        }
        syn.diffs = diffs;
      }
      if (typeof to.syntax.copy === "string") syn.copy = to.syntax.copy;
      if (typeof to.syntax.frame === "string") syn.frame = to.syntax.frame;
      if (to.syntax.tabs && typeof to.syntax.tabs === "object") {
        const tabs = {};
        if (typeof to.syntax.tabs.activeIndicator === "string") {
          tabs.activeIndicator = to.syntax.tabs.activeIndicator;
        }
        syn.tabs = tabs;
      }
      if (to.syntax.light && typeof to.syntax.light === "object") {
        syn.light = pickStringMap(to.syntax.light, SYNTAX_PALETTE_KEYS);
      }
      if (to.syntax.dark && typeof to.syntax.dark === "object") {
        syn.dark = pickStringMap(to.syntax.dark, SYNTAX_PALETTE_KEYS);
      }
      projectedTo.syntax = syn;
    }
    out.targetOverrides = projectedTo;
  }
  return out;
}

function makeBindError(uiRevision, rawSourceSha256, schemaVersion, aliasResolved, verificationStatus, errorCode, error, details) {
  return {
    status: "error",
    valid: false,
    uiRevision,
    schemaVersion,
    aliasResolved,
    verificationStatus,
    rawSourceSha256,
    normalizedSha256: null,
    canonicalDigest: null,
    ownerBinding: null,
    profile: null,
    v2Profile: null,
    errorCode,
    error,
    details,
  };
}

function ownerBindingRecord(inputOrigin, provenance) {
  if (!provenance || typeof provenance !== "object") {
    throw new Error("MISSING_OWNER_PROVENANCE");
  }
  return {
    inputOrigin,
    rawSourceSha256: provenance.rawSourceSha256,
    verificationStatus: provenance.verificationStatus,
    isTransformed: Boolean(provenance.isTransformed),
    byteLength: provenance.byteLength,
    ...(provenance.normalizedSha256 !== undefined ? { normalizedSha256: provenance.normalizedSha256 } : {}),
    ...(provenance.canonicalDigest !== undefined ? { canonicalDigest: provenance.canonicalDigest } : {}),
    ...(provenance.parentSourceSha256 !== undefined ? { parentSourceSha256: provenance.parentSourceSha256 } : {}),
  };
}

function bindDocumentRequest(request, uiRevision) {
  if (request.parentSourceSha256 !== undefined && request.parentSourceSha256 !== null) {
    throw new Error("UNSUPPORTED_PARENT_BINDING");
  }
  const rawBytes = decodeBase64Strict(request.rawBytesBase64);
  const rawSourceSha256 = createHash("sha256").update(rawBytes).digest("hex");

  let utf8Text;
  try {
    utf8Text = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    return makeBindError(
      uiRevision,
      rawSourceSha256,
      "corrupt",
      false,
      "corrupt",
      "INVALID_UTF8",
      "Profile document is not valid UTF-8",
      ["Profile document contains invalid UTF-8 byte sequences"]
    );
  }

  let rawParsed;
  try {
    if (typeof solarSail.parseThemeJson === "function") {
      rawParsed = solarSail.parseThemeJson(rawBytes);
    } else {
      rawParsed = JSON.parse(utf8Text);
    }
  } catch (err) {
    const msg = sanitizeText(err?.message || "Malformed or unsafe JSON document");
    return makeBindError(
      uiRevision,
      rawSourceSha256,
      "corrupt",
      false,
      "corrupt",
      "CANONICAL_ERROR",
      msg,
      sanitizeDetails(err?.details, msg)
    );
  }

  if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) {
    const msg = "Profile document root must be a JSON object";
    return makeBindError(uiRevision, rawSourceSha256, "corrupt", false, "corrupt", "CANONICAL_ERROR", msg, [msg]);
  }

  const hasSchemaVersion = Object.prototype.hasOwnProperty.call(rawParsed, "schemaVersion");
  const hasSchemaAlias = Object.prototype.hasOwnProperty.call(rawParsed, "schema");

  if (hasSchemaVersion && hasSchemaAlias) {
    const msg = "Invalid profile schema: document cannot declare both 'schemaVersion' and 'schema'";
    return makeBindError(
      uiRevision,
      rawSourceSha256,
      "corrupt",
      false,
      "corrupt",
      "CONFLICTING_SCHEMA_DISCRIMINATORS",
      msg,
      [msg]
    );
  }

  if (!hasSchemaVersion && !hasSchemaAlias) {
    const msg = "Invalid profile schema: missing 'schemaVersion' discriminator";
    return makeBindError(uiRevision, rawSourceSha256, "corrupt", false, "corrupt", "MISSING_VERSION", msg, [msg]);
  }

  if (hasSchemaAlias) {
    const aliasValue = rawParsed.schema;
    if (aliasValue === "tf-paired-profile-v2") {
      const msg =
        "Invalid profile schema: 'tf-paired-profile-v2' requires 'schemaVersion' and forbids the legacy 'schema' alias";
      return makeBindError(uiRevision, rawSourceSha256, "corrupt", false, "corrupt", "V2_ALIAS_FORBIDDEN", msg, [msg]);
    }
    if (aliasValue !== "tf-paired-profile-v1") {
      const msg = sanitizeText(
        `Invalid profile schema: expected 'tf-paired-profile-v1' or 'tf-paired-profile-v2', got '${String(aliasValue)}'`
      );
      return makeBindError(uiRevision, rawSourceSha256, "corrupt", false, "corrupt", "UNKNOWN_VERSION", msg, [msg]);
    }

    const resolvedObj = { schemaVersion: "tf-paired-profile-v1" };
    for (const [key, val] of Object.entries(rawParsed)) {
      if (key !== "schema") {
        resolvedObj[key] = val;
      }
    }
    try {
      const bound = solarSail.bindSourceProfile(JSON.stringify(resolvedObj));
      return {
        status: "bound",
        valid: true,
        uiRevision,
        schemaVersion: "tf-paired-profile-v1",
        aliasResolved: true,
        verificationStatus: bound.provenance.verificationStatus,
        rawSourceSha256,
        normalizedSha256: bound.provenance.normalizedSha256,
        canonicalDigest: null,
        ownerBinding: ownerBindingRecord("resolved-legacy-alias", bound.provenance),
        profile: projectV1ProfileToStudioDto(bound.profile),
        v2Profile: null,
        errorCode: null,
        error: null,
        details: [],
      };
    } catch (err) {
      const msg = sanitizeText(err?.message || "Profile validation failed");
      return makeBindError(
        uiRevision,
        rawSourceSha256,
        "tf-paired-profile-v1",
        true,
        "unverified-assertion",
        sanitizeErrorCode(err?.code, "SCHEMA_VALIDATION"),
        msg,
        sanitizeDetails(err?.details, msg)
      );
    }
  }

  const versionValue = rawParsed.schemaVersion;
  if (versionValue === "tf-paired-profile-v1") {
    try {
      const bound = solarSail.bindSourceProfile(rawBytes);
      return {
        status: "bound",
        valid: true,
        uiRevision,
        schemaVersion: "tf-paired-profile-v1",
        aliasResolved: false,
        verificationStatus: bound.provenance.verificationStatus,
        rawSourceSha256: bound.provenance.rawSourceSha256,
        normalizedSha256: bound.provenance.normalizedSha256,
        canonicalDigest: null,
        ownerBinding: ownerBindingRecord("source-bytes", bound.provenance),
        profile: projectV1ProfileToStudioDto(bound.profile),
        v2Profile: null,
        errorCode: null,
        error: null,
        details: [],
      };
    } catch (err) {
      const msg = sanitizeText(err?.message || "Profile validation failed");
      return makeBindError(
        uiRevision,
        rawSourceSha256,
        "tf-paired-profile-v1",
        false,
        "unverified-assertion",
        sanitizeErrorCode(err?.code, "SCHEMA_VALIDATION"),
        msg,
        sanitizeDetails(err?.details, msg)
      );
    }
  }

  if (versionValue === "tf-paired-profile-v2") {
    if (typeof solarSail.bindSourceProfileV2 !== "function") {
      throw new Error("MISSING_V2_BINDER");
    }
    try {
      const boundV2 = solarSail.bindSourceProfileV2(rawBytes);
      return {
        status: "bound",
        valid: true,
        uiRevision,
        schemaVersion: "tf-paired-profile-v2",
        aliasResolved: false,
        verificationStatus: boundV2.provenance.verificationStatus,
        rawSourceSha256: boundV2.provenance.rawSourceSha256,
        normalizedSha256: null,
        canonicalDigest: boundV2.provenance.canonicalDigest,
        ownerBinding: ownerBindingRecord("source-bytes", boundV2.provenance),
        profile: null,
        v2Profile: boundV2.profile,
        errorCode: null,
        error: null,
        details: [],
      };
    } catch (err) {
      const msg = sanitizeText(err?.message || "Paired profile v2 validation failed");
      return makeBindError(
        uiRevision,
        rawSourceSha256,
        "corrupt",
        false,
        "corrupt",
        sanitizeErrorCode(err?.code, "SCHEMA_VALIDATION"),
        msg,
        sanitizeDetails(err?.details, msg)
      );
    }
  }

  const msg = sanitizeText(
    `Invalid profile schema: expected 'tf-paired-profile-v1' or 'tf-paired-profile-v2', got '${String(versionValue)}'`
  );
  return makeBindError(uiRevision, rawSourceSha256, "corrupt", false, "corrupt", "UNKNOWN_VERSION", msg, [msg]);
}

async function handle(request) {
  if (!request || typeof request !== "object") {
    throw new Error("INVALID_REQUEST");
  }

  const action = request.action;
  const uiRevision = typeof request.uiRevision === "number" ? request.uiRevision : 0;

  switch (action) {
    case "status": {
      return {
        status: "success",
        valid: true,
        available: true,
        compilerName: COMPILER_NAME,
        compilerVersion: COMPILER_VERSION,
        schemaVersion: THEME_SCHEMA_VERSION,
        uiRevision,
      };
    }

    case "bind_document": {
      return bindDocumentRequest(request, uiRevision);
    }

    case "compile": {
      let spec = request.specification;
      if (!spec) {
        return {
          status: "error",
          valid: false,
          uiRevision,
          compiledCss: null,
          descriptor: null,
          diagnostics: [{ severity: "error", code: "MISSING_SPEC", message: "Theme specification missing" }],
          error: "Theme specification missing",
        };
      }

      if (spec.schemaVersion === "tf-paired-profile-v1") {
        try {
          spec = mapProfileToSolarSail(spec);
        } catch (err) {
          return {
            status: "error",
            valid: false,
            uiRevision,
            compiledCss: null,
            descriptor: null,
            diagnostics: [{ severity: "error", code: "MAPPING_ERROR", message: err.message }],
            error: `Failed to map profile: ${err.message}`,
          };
        }
      }

      const validation = validateThemeSpecification(spec);
      if (!validation.valid) {
        const diagnostics =
          validation.diagnostics && validation.diagnostics.length > 0
            ? validation.diagnostics
            : validation.errors.map((e) => ({
                severity: "error",
                code: "VALIDATION_ERROR",
                message: typeof e === "string" ? e : e.message || String(e),
              }));
        return {
          status: "success",
          valid: false,
          uiRevision,
          compiledCss: null,
          descriptor: null,
          diagnostics,
          error: diagnostics[0]?.message || validation.errors[0] || "Validation failed",
        };
      }

      try {
        const result = compileTheme(spec);
        return {
          status: "success",
          valid: true,
          uiRevision,
          compiledCss: result.css,
          descriptor: result.descriptor,
          diagnostics: result.diagnostics,
          error: null,
        };
      } catch (err) {
        return {
          status: "error",
          valid: false,
          uiRevision,
          compiledCss: null,
          descriptor: null,
          diagnostics: [{ severity: "error", code: "COMPILE_ERROR", message: err.message }],
          error: err.message,
        };
      }
    }

    case "paired_compile": {
      const profile = request.profile;
      if (!profile) {
        return {
          status: "error",
          valid: false,
          uiRevision,
          solarSail: {
            status: "error",
            valid: false,
            uiRevision,
            compiledCss: null,
            descriptor: null,
            diagnostics: [{ severity: "error", code: "MISSING_PROFILE", message: "Profile missing for paired compilation" }],
            error: "Profile missing for paired compilation",
          },
          stellarLoom: null,
          sharedTokens: [],
          error: "Profile missing for paired compilation",
        };
      }

      // 1. Solar Sail compilation
      let ssSpec;
      try {
        ssSpec = mapProfileToSolarSail(profile);
      } catch (err) {
        return {
          status: "error",
          valid: false,
          uiRevision,
          solarSail: {
            status: "error",
            valid: false,
            uiRevision,
            compiledCss: null,
            descriptor: null,
            diagnostics: [{ severity: "error", code: "MAPPING_ERROR", message: err.message }],
            error: `Failed to map profile to Solar Sail: ${err.message}`,
          },
          stellarLoom: null,
          sharedTokens: [],
          error: `Failed to map profile to Solar Sail: ${err.message}`,
        };
      }

      let ssResult;
      const ssValidation = validateThemeSpecification(ssSpec);
      if (!ssValidation.valid) {
        const diagnostics =
          ssValidation.diagnostics && ssValidation.diagnostics.length > 0
            ? ssValidation.diagnostics
            : ssValidation.errors.map((e) => ({
                severity: "error",
                code: "VALIDATION_ERROR",
                message: typeof e === "string" ? e : e.message || String(e),
              }));
        ssResult = {
          status: "success",
          valid: false,
          uiRevision,
          compiledCss: null,
          descriptor: null,
          diagnostics,
          error: diagnostics[0]?.message || ssValidation.errors[0] || "Validation failed",
        };
      } else {
        try {
          const comp = compileTheme(ssSpec);
          ssResult = {
            status: "success",
            valid: true,
            uiRevision,
            compiledCss: comp.css,
            descriptor: comp.descriptor,
            diagnostics: comp.diagnostics,
            error: null,
          };
        } catch (err) {
          ssResult = {
            status: "error",
            valid: false,
            uiRevision,
            compiledCss: null,
            descriptor: null,
            diagnostics: [{ severity: "error", code: "SS_ERROR", message: err.message }],
            error: err.message,
          };
        }
      }

      // 2. Stellar Loom compilation (optional graceful integration)
      let slResult = null;
      const loomDist = resolve(__dirname, "../loom-payload/dist/index-catalog.js");
      const baseCatalogPath = resolve(__dirname, "../loom-payload/examples/forge-console-reading-catalog.json");
      if (existsSync(loomDist) && existsSync(baseCatalogPath)) {
        try {
          const { compileThemeCatalog } = await import(loomDist);
          const { readFile } = await import("node:fs/promises");
          const baseCatalog = JSON.parse(await readFile(baseCatalogPath, "utf8"));
          const mappedSL = mapProfileToStellarLoom(profile, baseCatalog);
          const slComp = compileThemeCatalog(mappedSL, { accent: mappedSL.defaultAccent || "cyan" });
          const loomCss = Array.from(slComp.styles.values()).join("\n");
          slResult = {
            valid: true,
            compiledCss: loomCss,
            diagnostics: slComp.diagnostics || [],
            error: null,
          };
        } catch (err) {
          slResult = {
            valid: false,
            compiledCss: null,
            diagnostics: [],
            error: `Loom compilation failed: ${err.message}`,
          };
        }
      } else {
        slResult = {
          valid: false,
          compiledCss: null,
          diagnostics: [],
          error: "Stellar Loom payload not available for paired preview",
        };
      }

      const sharedTokens = [
        "primary",
        "accent",
        "background",
        "foreground",
        "card",
        "muted",
        "border",
        "ring",
        "radius",
      ];

      return {
        status: "success",
        valid: ssResult.valid,
        uiRevision,
        solarSail: ssResult,
        stellarLoom: slResult,
        sharedTokens,
        error: ssResult.error,
      };
    }

    case "export_package": {
      let spec = request.specification;
      const destination = request.destination;
      const language = request.language === "javascript" ? "javascript" : "typescript";

      if (!spec || !destination) {
        return {
          status: "error",
          valid: false,
          cancelled: false,
          destination: null,
          fileCount: null,
          error: "Missing specification or destination for package export",
        };
      }

      if (spec.schemaVersion === "tf-paired-profile-v1") {
        try {
          spec = mapProfileToSolarSail(spec);
        } catch (err) {
          return {
            status: "error",
            valid: false,
            cancelled: false,
            destination: null,
            fileCount: null,
            error: `Failed to map profile for export: ${err.message}`,
          };
        }
      }

      const validation = validateThemeSpecification(spec);
      if (!validation.valid) {
        return {
          status: "error",
          valid: false,
          cancelled: false,
          destination: null,
          fileCount: null,
          error: validation.errors?.[0] || "Validation failed",
        };
      }

      try {
        const metadata = {
          name: `@knowledge-forge-ai/app-theme-${spec.name}`,
          version: spec.version || "0.1.0",
          description: spec.description || `${spec.name} application theme`,
        };
        const pkgResult = generateThemePackage({
          themeSpec: spec,
          metadata,
          language,
        });
        const writtenFiles = await writePackageFiles(pkgResult.files, destination);

        return {
          status: "success",
          valid: true,
          cancelled: false,
          destination,
          fileCount: writtenFiles.length,
          error: null,
        };
      } catch (err) {
        return {
          status: "error",
          valid: false,
          cancelled: false,
          destination: null,
          fileCount: null,
          error: `Export failed: ${err.message}`,
        };
      }
    }

    default:
      throw new Error(`UNSUPPORTED_ACTION: ${action}`);
  }
}

async function run() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) throw new Error("INPUT_TOO_LARGE");
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const request = JSON.parse(raw);
  const response = await handle(request);
  process.stdout.write(JSON.stringify(response));
}

run().catch((err) => {
  const safeMsg = sanitizeText(err?.message || "Adapter failure", 512);
  const failure = {
    status: "error",
    valid: false,
    error: safeMsg,
    diagnostics: [{ severity: "error", code: "ADAPTER_FATAL", message: safeMsg }],
  };
  process.stdout.write(JSON.stringify(failure));
  process.exit(0);
});
