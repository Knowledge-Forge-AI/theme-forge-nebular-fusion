#!/usr/bin/env node

/**
 * Generate the closed appearance role expectation table from the maintained
 * generated catalog. This module deliberately treats runtime-baselines.ts as
 * embedded JSON data; it never evaluates TypeScript or CSS.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTATIONS_SCHEMA = "theme-forge.appearance-role-expectations.v1";
export const FAMILY_ORDER = Object.freeze([
  "terminal-nova",
  "nebular",
  "developer",
  "graphic-designer",
  "anime",
  "gamer",
]);
export const MODES = Object.freeze(["light", "dark"]);
export const REQUIRED_ROLES = Object.freeze([
  "--background",
  "--primary",
  "--tf-appearance-font-ui",
  "--tf-appearance-radius-surface",
  "--tf-appearance-selection",
  "--tf-appearance-selection-text",
]);

const DYNAMIC_VALUE = /\b(?:var|calc|env|attr)\s*\(/iu;
const DARK_SELECTOR = /(?:^|[\s,])\.dark\b|:root\s*\[\s*data-theme\s*=\s*["']dark["']\s*\]/iu;
const ROOT_SELECTOR = /:root\b/iu;

export class AppearanceExpectationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AppearanceExpectationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AppearanceExpectationError(code, message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function skipWhitespaceAndComments(source, start, end) {
  let cursor = start;
  while (cursor < end) {
    if (/\s/u.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "/" && source[cursor + 1] === "*") {
      const close = source.indexOf("*/", cursor + 2);
      if (close < 0 || close + 2 > end) fail("INVALID_CSS", "Unterminated CSS comment.");
      cursor = close + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function findMatchingBrace(source, open, end) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let cursor = open + 1; cursor < end; cursor += 1) {
    const current = source[cursor];
    const next = source[cursor + 1];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === "/" && next === "*") {
      const close = source.indexOf("*/", cursor + 2);
      if (close < 0 || close + 2 > end) fail("INVALID_CSS", "Unterminated CSS comment.");
      cursor = close + 1;
      continue;
    }
    if (current === "\"" || current === "'") {
      quote = current;
    } else if (current === "{") {
      depth += 1;
    } else if (current === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  fail("INVALID_CSS", "Unmatched CSS block.");
}

function findTokenBoundary(source, start, end) {
  let quote = null;
  let escaped = false;
  let parentheses = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    const current = source[cursor];
    const next = source[cursor + 1];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === "/" && next === "*") {
      const close = source.indexOf("*/", cursor + 2);
      if (close < 0 || close + 2 > end) fail("INVALID_CSS", "Unterminated CSS comment.");
      cursor = close + 1;
      continue;
    }
    if (current === "\"" || current === "'") {
      quote = current;
    } else if (current === "(") {
      parentheses += 1;
    } else if (current === ")") {
      if (parentheses === 0) fail("INVALID_CSS", "Unmatched CSS parenthesis.");
      parentheses -= 1;
    } else if (parentheses === 0 && (current === "{" || current === ";" || current === "}")) {
      return { index: cursor, token: current };
    }
  }
  if (quote !== null || parentheses !== 0) fail("INVALID_CSS", "Unterminated CSS prelude.");
  return { index: end, token: "eof" };
}

function splitDeclarations(body) {
  const segments = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let parentheses = 0;
  let cursor = 0;
  while (cursor <= body.length) {
    const current = body[cursor];
    const next = body[cursor + 1];
    if (cursor === body.length || (current === ";" && quote === null && parentheses === 0)) {
      segments.push(body.slice(start, cursor));
      start = cursor + 1;
      cursor += 1;
      continue;
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      cursor += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      const close = body.indexOf("*/", cursor + 2);
      if (close < 0) fail("INVALID_CSS", "Unterminated CSS comment in declaration.");
      cursor = close + 2;
      continue;
    }
    if (current === "\"" || current === "'") quote = current;
    else if (current === "(") parentheses += 1;
    else if (current === ")") {
      if (parentheses === 0) fail("INVALID_CSS", "Unmatched CSS parenthesis in declaration.");
      parentheses -= 1;
    }
    cursor += 1;
  }
  if (quote !== null || parentheses !== 0) fail("INVALID_CSS", "Unterminated CSS declaration.");
  return segments;
}

function declarationColon(segment) {
  let quote = null;
  let escaped = false;
  let parentheses = 0;
  for (let cursor = 0; cursor < segment.length; cursor += 1) {
    const current = segment[cursor];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "\"" || current === "'") quote = current;
    else if (current === "(") parentheses += 1;
    else if (current === ")") parentheses -= 1;
    else if (current === ":" && parentheses === 0) return cursor;
  }
  return -1;
}

function directDeclarations(source, start, end) {
  const declarations = [];
  for (const segment of splitDeclarations(source.slice(start, end))) {
    const colon = declarationColon(segment);
    if (colon < 0) continue;
    const property = segment.slice(0, colon).replace(/\/\*.*?\*\//gs, "").trim();
    if (!property.startsWith("--")) continue;
    const value = segment.slice(colon + 1).replace(/\/\*.*?\*\//gs, "").trim();
    if (!value) fail("INVALID_ROLE_VALUE", `Empty value for ${property}.`);
    declarations.push({ property, value });
  }
  return declarations;
}

function selectorLayer(prelude) {
  const selector = prelude.trim();
  if (DARK_SELECTOR.test(selector)) return "dark";
  if (ROOT_SELECTOR.test(selector)) return "light";
  return null;
}

function collectSelectorRules(source, start, end, rules) {
  let cursor = start;
  while (cursor < end) {
    cursor = skipWhitespaceAndComments(source, cursor, end);
    if (cursor >= end || source[cursor] === "}") return;
    const boundary = findTokenBoundary(source, cursor, end);
    if (boundary.token === "eof" || boundary.token === "}") return;
    const prelude = source.slice(cursor, boundary.index).trim();
    if (boundary.token === ";") {
      cursor = boundary.index + 1;
      continue;
    }
    const close = findMatchingBrace(source, boundary.index, end);
    const layer = selectorLayer(prelude);
    if (layer !== null) {
      const declarations = directDeclarations(source, boundary.index + 1, close);
      rules.push({ layer, selector: prelude, declarations });
    }
    collectSelectorRules(source, boundary.index + 1, close, rules);
    cursor = close + 1;
  }
}

function staticRoleValue(role, value) {
  if (DYNAMIC_VALUE.test(value)) {
    fail("UNSUPPORTED_DYNAMIC_VALUE", `Dynamic value is not supported for ${role}.`);
  }
  if (/[{}]/u.test(value)) fail("INVALID_ROLE_VALUE", `Invalid value for ${role}.`);
  return value;
}

export function extractRoleSets(cssText) {
  if (typeof cssText !== "string" || cssText.length === 0) {
    fail("INVALID_CSS", "Appearance baseline CSS must be a non-empty string.");
  }
  const rules = [];
  collectSelectorRules(cssText, 0, cssText.length, rules);
  const occurrences = { light: new Map(), dark: new Map() };
  for (const rule of rules) {
    const local = new Map();
    for (const declaration of rule.declarations) {
      if (!REQUIRED_ROLES.includes(declaration.property)) continue;
      if (local.has(declaration.property)) {
        fail("AMBIGUOUS_REQUIRED_ROLE", `Duplicate ${declaration.property} in one ${rule.layer} rule.`);
      }
      local.set(declaration.property, staticRoleValue(declaration.property, declaration.value));
    }
    for (const [role, value] of local) {
      const values = occurrences[rule.layer].get(role) ?? [];
      values.push(value);
      occurrences[rule.layer].set(role, values);
    }
  }

  const light = {};
  const dark = {};
  for (const role of REQUIRED_ROLES) {
    const lightValues = occurrences.light.get(role) ?? [];
    const darkValues = occurrences.dark.get(role) ?? [];
    if (lightValues.length === 0) fail("MISSING_REQUIRED_ROLE", `Missing light ${role}.`);
    if (lightValues.length > 1) fail("AMBIGUOUS_REQUIRED_ROLE", `Multiple light declarations for ${role}.`);
    if (darkValues.length > 1) fail("AMBIGUOUS_REQUIRED_ROLE", `Multiple dark declarations for ${role}.`);
    light[role] = lightValues[0];
    dark[role] = darkValues.length === 1 ? darkValues[0] : lightValues[0];
  }
  return Object.freeze({
    light: Object.freeze(light),
    dark: Object.freeze(dark),
  });
}

function embeddedJsonObject(source) {
  const declaration = source.indexOf("export const applicationBaselines");
  if (declaration < 0) fail("INVALID_RUNTIME_SOURCE", "applicationBaselines declaration is missing.");
  const freeze = source.indexOf("Object.freeze(", declaration);
  const objectStart = source.indexOf("{", freeze + "Object.freeze(".length);
  if (freeze < 0 || objectStart < 0) fail("INVALID_RUNTIME_SOURCE", "applicationBaselines JSON object is missing.");
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let cursor = objectStart; cursor < source.length; cursor += 1) {
    const current = source[cursor];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "\"") quote = current;
    else if (current === "{") depth += 1;
    else if (current === "}") {
      depth -= 1;
      if (depth === 0) {
        const literal = source.slice(objectStart, cursor + 1);
        try {
          return JSON.parse(literal);
        } catch {
          fail("INVALID_RUNTIME_SOURCE", "applicationBaselines object is not valid JSON.");
        }
      }
    }
  }
  fail("INVALID_RUNTIME_SOURCE", "applicationBaselines JSON object is unterminated.");
}

export function parseApplicationBaselinesSource(source) {
  if (typeof source !== "string") fail("INVALID_RUNTIME_SOURCE", "runtime-baselines source must be text.");
  const baselines = embeddedJsonObject(source);
  if (!isRecord(baselines)) fail("INVALID_RUNTIME_SOURCE", "applicationBaselines must be an object.");
  const keys = Object.keys(baselines);
  if (keys.length !== FAMILY_ORDER.length || keys.some((key, index) => key !== FAMILY_ORDER[index])) {
    fail("INVALID_RUNTIME_SOURCE", "applicationBaselines family order is not the closed catalog order.");
  }
  for (const family of FAMILY_ORDER) {
    if (typeof baselines[family] !== "string" || baselines[family].length === 0) {
      fail("INVALID_RUNTIME_SOURCE", `Baseline CSS is missing for ${family}.`);
    }
  }
  return baselines;
}

export function parseCatalogSource(source) {
  let catalog;
  try {
    catalog = JSON.parse(source);
  } catch {
    fail("INVALID_CATALOG", "catalog-index.json is not valid JSON.");
  }
  if (!isRecord(catalog) || catalog.schema !== "theme-forge.application-appearance-index.v1") {
    fail("INVALID_CATALOG", "catalog-index schema is not the maintained appearance index.");
  }
  if (typeof catalog.sourceCatalogSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(catalog.sourceCatalogSha256)) {
    fail("INVALID_CATALOG", "catalog source digest is missing or malformed.");
  }
  if (!Array.isArray(catalog.families) || catalog.families.length !== FAMILY_ORDER.length) {
    fail("INVALID_CATALOG", "catalog family count is not six.");
  }
  for (const [index, family] of catalog.families.entries()) {
    if (!isRecord(family) || family.id !== FAMILY_ORDER[index] || typeof family.label !== "string" || family.label.length === 0) {
      fail("INVALID_CATALOG", "catalog family ids/order are not the closed six-family order.");
    }
  }
  return catalog;
}

function canonicalRows(rows) {
  return JSON.stringify(rows);
}

export function buildExpectations({ runtimeText, catalogText, runtimePath, catalogPath }) {
  const baselines = parseApplicationBaselinesSource(runtimeText);
  const catalog = parseCatalogSource(catalogText);
  const rows = [];
  const roleSets = new Map(FAMILY_ORDER.map((family) => [family, extractRoleSets(baselines[family])]));
  for (const mode of MODES) {
    for (const family of FAMILY_ORDER) {
      rows.push({ family, mode, roles: { ...roleSets.get(family)[mode] } });
    }
  }
  const source = {
    runtimeBaselinesPath: runtimePath,
    runtimeBaselinesSha256: sha256Text(runtimeText),
    catalogIndexPath: catalogPath,
    catalogIndexSha256: sha256Text(catalogText),
    declaredSourceCatalogSha256: catalog.sourceCatalogSha256,
  };
  return {
    schema: EXPECTATIONS_SCHEMA,
    source,
    roles: [...REQUIRED_ROLES],
    rows,
    canonicalRowsSha256: sha256Text(canonicalRows(rows)),
  };
}

export function verifyExpectationsArtifact(artifact, { runtimeText, catalogText }) {
  if (!isRecord(artifact) || artifact.schema !== EXPECTATIONS_SCHEMA) {
    fail("STALE_EXPECTATIONS", "Expectations artifact schema is not current.");
  }
  const expected = buildExpectations({
    runtimeText,
    catalogText,
    runtimePath: artifact.source?.runtimeBaselinesPath,
    catalogPath: artifact.source?.catalogIndexPath,
  });
  if (artifact.source?.runtimeBaselinesSha256 !== expected.source.runtimeBaselinesSha256 ||
      artifact.source?.catalogIndexSha256 !== expected.source.catalogIndexSha256 ||
      artifact.source?.declaredSourceCatalogSha256 !== expected.source.declaredSourceCatalogSha256) {
    fail("STALE_SOURCE", "Expectations source digest does not match current inputs.");
  }
  if (artifact.canonicalRowsSha256 !== expected.canonicalRowsSha256 ||
      JSON.stringify(artifact.roles) !== JSON.stringify(expected.roles) ||
      JSON.stringify(artifact.rows) !== JSON.stringify(expected.rows)) {
    fail("STALE_EXPECTATIONS", "Expectations rows or canonical digest are stale.");
  }
  return true;
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail("INVALID_ARGUMENT", `${name} requires a value.`);
  return value;
}

function cli() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write("Usage: generate.mjs [--checkout-root path] [--runtime-baselines path] [--catalog-index path] [--output path]\n");
    return;
  }
  const checkoutRoot = resolve(optionValue(args, "--checkout-root", process.cwd()));
  const runtimePath = resolve(optionValue(args, "--runtime-baselines", resolve(checkoutRoot, "src/features/appearance/generated/runtime-baselines.ts")));
  const catalogPath = resolve(optionValue(args, "--catalog-index", resolve(checkoutRoot, "src/features/appearance/generated/catalog-index.json")));
  const outputPath = resolve(optionValue(args, "--output", resolve(checkoutRoot, "src-tauri/src/release_smoke/appearance-role-expectations.v1.json")));
  const runtimeText = readFileSync(runtimePath, "utf8");
  const catalogText = readFileSync(catalogPath, "utf8");
  const artifact = buildExpectations({
    runtimeText,
    catalogText,
    runtimePath: "frontend-fixture/src/features/appearance/generated/runtime-baselines.ts",
    catalogPath: "frontend-fixture/src/features/appearance/generated/catalog-index.json",
  });
  writeFileSync(outputPath, `${JSON.stringify(artifact)}\n`, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ output: outputPath, rows: artifact.rows.length, canonicalRowsSha256: artifact.canonicalRowsSha256 })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    cli();
  } catch (error) {
    const code = error instanceof AppearanceExpectationError ? error.code : "GENERATION_FAILED";
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

