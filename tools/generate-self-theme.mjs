#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repositoryRootForStudio } from "./sidecar-common.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const studioRoot = resolve(__dirname, "..");
const repoRoot = repositoryRootForStudio(studioRoot);
const builtinJsonPath = resolve(studioRoot, "src/features/application-theme/builtin-forge-console.profile.json");
const outputPath = resolve(studioRoot, "src/styles/self-theme.css");

export function loadBuiltinProfile() {
  const content = readFileSync(builtinJsonPath, "utf-8");
  return JSON.parse(content);
}

export async function generateSelfThemeCss(profile) {
  const payloadPath = resolve(studioRoot, "src-tauri/solar-sail-payload/dist/index.js");
  const pkgDistPath = resolve(repoRoot, "packages/solar-sail/dist/index.js");
  const enginePath = existsSync(payloadPath) ? payloadPath : pkgDistPath;

  if (!existsSync(enginePath)) {
    throw new Error(`Solar Sail engine not found at ${payloadPath} or ${pkgDistPath}. Run npm run solar-sail:prepare first.`);
  }

  const { mapProfileToSolarSail, compileTheme } = await import(pathToFileURL(enginePath).href);
  const spec = mapProfileToSolarSail(profile);
  const result = compileTheme(spec);
  return result.css || result.compiledCss;
}

export async function run() {
  console.log("Loading built-in Forge Console profile JSON...");
  const profile = loadBuiltinProfile();
  console.log(`Compiling authentic self-theme CSS via Solar Sail for profile '${profile.name}' (${profile.version})...`);
  const css = await generateSelfThemeCss(profile);
  writeFileSync(outputPath, css, "utf-8");
  console.log(`Successfully compiled and wrote self-theme CSS to ${outputPath}`);
}

if (process.argv[1] === __filename) {
  run().catch((err) => {
    console.error("FATAL:", err.message);
    process.exit(1);
  });
}
