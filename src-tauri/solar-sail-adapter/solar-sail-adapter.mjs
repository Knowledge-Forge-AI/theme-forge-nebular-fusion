#!/usr/bin/env node
// Theme Forge Solar Sail Studio Adapter
// Provides sandboxed compilation, paired mapping, and package export over stdin/stdout.

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  const failure = {
    status: "error",
    valid: false,
    error: err.message,
    diagnostics: [{ severity: "error", code: "ADAPTER_FATAL", message: err.message }],
  };
  process.stdout.write(JSON.stringify(failure));
  process.exit(0);
});
