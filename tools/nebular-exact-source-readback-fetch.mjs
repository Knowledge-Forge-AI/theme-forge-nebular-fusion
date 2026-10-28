#!/usr/bin/env node

/*
 * Source-first adapter for dedicated readback materialization. The
 * maintained consumer helper remains the validator and bounded writer; this
 * module only supplies the dedicated authenticated initial-GET sequence.
 */

import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  assertExactAssetApiUrl,
  createAuthenticatedAssetFetch,
} from "./nebular-exact-release-asset-fetch.mjs";
import { readRegularSnapshot } from "./fs-snapshot.mjs";

const JSON_LIMIT = 8 * 1024 * 1024;
const REQUIRED_FLAGS = Object.freeze(["--helper", "--input", "--manifest", "--output"]);
const SOURCE_ROLES = Object.freeze([
  "corresponding-source-offer",
  "darwin-app-source",
  "linux-app-source",
]);

function fail(message) {
  throw new Error(`[NEBULAR_EXACT_SOURCE_FETCH] ${message}`);
}

function parseFlags(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!REQUIRED_FLAGS.includes(name)) fail(`unknown flag ${String(name)}`);
    if (values.has(name)) fail(`duplicate flag ${name}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) fail(`${name} requires a non-empty value`);
    values.set(name, value);
    index += 1;
  }
  for (const name of REQUIRED_FLAGS) if (!values.has(name)) fail(`missing required flag ${name}`);
  return Object.freeze(Object.fromEntries(values));
}

async function readJson(path) {
  try {
    const snapshot = readRegularSnapshot(path, {
      bindPath: true,
      label: "JSON input",
      maxBytes: JSON_LIMIT,
      messages: {
        missing: `JSON input could not be read: ${path}`,
        symlink: `JSON input is not a bounded regular file: ${path}`,
        notRegular: `JSON input is not a bounded regular file: ${path}`,
        tooLarge: `JSON input is not a bounded regular file: ${path}`,
        truncated: `JSON input changed while being read: ${path}`,
        grew: "JSON input exceeded its bounded byte limit",
        changed: `JSON input changed while being read: ${path}`,
        replaced: `JSON input changed while being read: ${path}`,
      },
    });
    if (!snapshot || snapshot.bytes.length < 1) fail(`JSON input is not a bounded regular file: ${path}`);
    try {
      return JSON.parse(snapshot.bytes.toString("utf8"));
    } catch {
      fail(`JSON input is invalid or unreadable: ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[NEBULAR_EXACT_SOURCE_FETCH]")) throw error;
    if (error instanceof Error && error.message.startsWith("JSON input ")) fail(error.message);
    fail(`JSON input is invalid or unreadable: ${path}`);
  }
}

export function sourceInitialAssetUrls(manifest) {
  if (!manifest || typeof manifest !== "object") fail("source readback manifest must be an object");
  const sourceAssets = manifest.sourceAssets;
  if (!sourceAssets || typeof sourceAssets !== "object") fail("source readback manifest.sourceAssets is required");
  const urls = SOURCE_ROLES.map((role) => assertExactAssetApiUrl(sourceAssets[role]?.url, `source asset ${role} URL`));
  urls.push(assertExactAssetApiUrl(manifest.darwinQualificationReceipt?.url, "Darwin receipt URL"));
  return Object.freeze(urls);
}

export async function runSourceReadbackFetch({ helper, input, manifest, output, token, fetchImpl = globalThis.fetch }) {
  if (!helper || typeof helper.validateInput !== "function" || typeof helper.fetchSourceReadbacks !== "function") {
    fail("maintained consumer helper does not expose source readback APIs");
  }
  const normalized = helper.validateInput(input);
  const initialUrls = sourceInitialAssetUrls(manifest);
  return helper.fetchSourceReadbacks(
    manifest,
    output,
    createAuthenticatedAssetFetch(initialUrls, token, fetchImpl),
    normalized.source,
  );
}

async function main(argv) {
  if (process.env.NEBULAR_EXACT_SOURCE_READBACK_FETCH !== "1") fail("dedicated source fetch guard is not enabled");
  const flags = parseFlags(argv);
  const token = process.env.GITHUB_TOKEN;
  if (typeof token !== "string" || token.length === 0) fail("dedicated source fetch requires GITHUB_TOKEN");
  const helper = await import(pathToFileURL(resolve(flags["--helper"])).href);
  const input = await readJson(flags["--input"]);
  const manifest = await readJson(flags["--manifest"]);
  const result = await runSourceReadbackFetch({
    helper,
    input,
    manifest,
    output: flags["--output"],
    token,
  });
  process.stdout.write(JSON.stringify({ status: result.status, schema: result.schema, sourceAssets: Object.keys(result.sourceAssets).length }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
