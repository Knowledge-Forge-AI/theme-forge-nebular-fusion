#!/usr/bin/env node

/*
 * Dedicated adapter for the exact release-input-fetch job.
 *
 * The maintained consumer helper owns descriptor validation, admission
 * verification, URL policy, redirect policy, bounded streaming, and exact
 * byte/SHA/SRI checks.  This adapter only supplies an authenticated fetch
 * implementation to those existing APIs.  It is intentionally not a
 * consumer or qualification command.
 */

import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const JSON_LIMIT = 8 * 1024 * 1024;
const FETCH_READBACK_SCHEMA = "nebular.hosted-product-fetch-readback-v2";
const REQUIRED_FLAGS = Object.freeze([
  "--helper",
  "--input",
  "--admission",
  "--checkout",
  "--source-archive",
  "--darwin-source-archive",
  "--linux-source-archive",
  "--darwin-receipt",
  "--output",
]);

function fail(message) {
  throw new Error(`[NEBULAR_EXACT_RELEASE_FETCH] ${message}`);
}

function parseFlags(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!REQUIRED_FLAGS.includes(name)) fail(`unknown flag ${String(name)}`);
    if (values.has(name)) fail(`duplicate flag ${name}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(`${name} requires a non-empty value`);
    }
    values.set(name, value);
    index += 1;
  }
  for (const name of REQUIRED_FLAGS) {
    if (!values.has(name)) fail(`missing required flag ${name}`);
  }
  return Object.freeze(Object.fromEntries(values));
}

async function readJson(path) {
  let bytes;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size < 1 || info.size > JSON_LIMIT) fail(`JSON input is not a bounded regular file: ${path}`);
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[NEBULAR_EXACT_RELEASE_FETCH]")) throw error;
    fail(`JSON input could not be read: ${path}`);
  }
  if (bytes.length > JSON_LIMIT) fail("JSON input exceeded its bounded byte limit");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`JSON input is invalid: ${path}`);
  }
}

async function writeNewJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    fail(`refusing to overwrite output: ${path}`);
  }
}

async function requireNewDirectory(path) {
  try {
    await lstat(path);
    fail(`output directory already exists: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[NEBULAR_EXACT_RELEASE_FETCH]")) throw error;
    if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/**
 * Return a fetch implementation that adds the token only to the exact
 * GitHub GETs already authorized and validated by the maintained helper.
 * The token is never returned, serialized, or logged by this adapter.
 */
export function assertExactAssetApiUrl(url, label = "release asset URL") {
  if (typeof url !== "string") fail(`${label} must be a string`);
  let parsed;
  try { parsed = new URL(url); } catch { fail(`${label} must be a valid URL`); }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "api.github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^\/repos\/Knowledge-Forge-AI\/theme-forge-nebular-fusion\/releases\/assets\/[1-9][0-9]*$/u.test(parsed.pathname) ||
    parsed.toString() !== url
  ) {
    fail(`${label} must be the exact GitHub API asset URL`);
  }
  return url;
}

/**
 * Return a fetch implementation that authenticates only the expected initial
 * GitHub API asset GETs. Redirects are manual and deliberately unauthenticated.
 */
export function createAuthenticatedAssetFetch(initialUrls, token, baseFetch = globalThis.fetch) {
  if (!Array.isArray(initialUrls) || initialUrls.length === 0) fail("exact asset URL sequence is required");
  const sequence = initialUrls.map((url, index) => assertExactAssetApiUrl(url, `asset URL ${index + 1}`));
  if (new Set(sequence).size !== sequence.length) fail("exact asset URL sequence contains duplicates");
  if (typeof token !== "string" || token.length === 0) fail("dedicated fetch requires GITHUB_TOKEN");
  if (typeof baseFetch !== "function") fail("dedicated fetch requires a fetch implementation");
  const initialSet = new Set(sequence);
  let next = 0;
  let awaitingRedirect = false;
  return async (url, init = {}) => {
    if (typeof url !== "string") fail("asset fetch URL must be a string");
    const requestedMethod = init.method ?? "GET";
    if (typeof requestedMethod !== "string" || requestedMethod.toUpperCase() !== "GET") {
      fail("dedicated fetch accepts GET only");
    }
    if (init.redirect !== undefined && init.redirect !== "manual") {
      fail("dedicated fetch requires manual redirects");
    }
    const headers = new Headers(init.headers ?? {});
    headers.delete("authorization");
    headers.delete("Authorization");
    const initialRequest = !awaitingRedirect && url === sequence[next];
    if (initialRequest) {
      next += 1;
      headers.set("authorization", `Bearer ${token}`);
    } else if (awaitingRedirect && initialSet.has(url)) {
      fail("an exact API asset URL was reused or reached as a redirect");
    } else if (!awaitingRedirect) {
      fail("unexpected initial asset URL");
    } else if (!initialRequest) {
      let parsed;
      try { parsed = new URL(url); } catch { fail("asset redirect URL must be valid"); }
      if (parsed.hostname === "api.github.com") fail("redirect may not target an unexpected GitHub API URL");
    }
    const response = await baseFetch(url, { ...init, method: "GET", redirect: "manual", headers });
    awaitingRedirect = [301, 302, 303, 307, 308].includes(response?.status);
    return response;
  };
}

export function buildFetchReadback(normalized, admission, readbacks) {
  if (!Array.isArray(normalized?.assets) || normalized.assets.length !== 6) {
    fail("authenticated release fetch requires exactly six validated assets");
  }
  if (!admission || typeof admission !== "object" || !admission.targetSourceReadbacks) {
    fail("authenticated release fetch requires the matching source admission");
  }
  return {
    schema: FETCH_READBACK_SCHEMA,
    status: "pass",
    source: {
      commit: normalized.source.commit,
      tree: normalized.source.tree,
      manifestSha256: normalized.source.manifestSha256,
      correspondingSourceOfferSha256: normalized.source.correspondingSourceOfferSha256,
      targetSourceReadbacks: admission.targetSourceReadbacks,
    },
    assets: readbacks.map(({ platform, kind, assetId, name, bytes, sha256, sourceCommit, sourceTree, sourceCandidate }) => ({
      platform,
      kind,
      assetId,
      name,
      bytes,
      sha256,
      sourceCommit,
      sourceTree,
      sourceCandidate,
    })),
  };
}

export async function fetchDeclaredAssets({ helper, normalized, admission, output, fetchImpl }) {
  if (!helper || typeof helper.fetchReleaseAsset !== "function") fail("maintained consumer helper is missing fetchReleaseAsset");
  if (typeof fetchImpl !== "function") fail("authenticated fetch implementation is required");
  if (!Array.isArray(normalized?.assets) || normalized.assets.length !== 6) {
    fail("authenticated release fetch requires exactly six validated assets");
  }
  const outputRoot = resolve(output);
  await requireNewDirectory(outputRoot);
  try {
    const readbacks = [];
    for (const asset of normalized.assets) {
      const destination = join(outputRoot, asset.kind === "raw-archive" ? "raw" : "npm", asset.platform, asset.name);
      readbacks.push(await helper.fetchReleaseAsset(asset, destination, fetchImpl));
    }
    await writeNewJson(join(outputRoot, "fetch-readback.json"), buildFetchReadback(normalized, admission, readbacks));
    return readbacks;
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function runReleaseAssetFetch({
  helper,
  input,
  admission,
  checkout,
  sourceArchive,
  darwinSourceArchive,
  linuxSourceArchive,
  darwinReceipt,
  output,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!helper || typeof helper.validateInput !== "function" || typeof helper.verifyAdmissionReceipt !== "function") {
    fail("maintained consumer helper does not expose the required validation APIs");
  }
  const normalized = helper.validateInput(input);
  helper.verifyAdmissionReceipt(admission, normalized, {
    checkout,
    sourceArchivePath: sourceArchive,
    darwinSourceArchivePath: darwinSourceArchive,
    linuxSourceArchivePath: linuxSourceArchive,
    darwinReceiptPath: darwinReceipt,
  });
  return fetchDeclaredAssets({
    helper,
    normalized,
    admission,
    output,
    fetchImpl: createAuthenticatedAssetFetch(
      normalized.assets.map((asset) => assertExactAssetApiUrl(asset.apiUrl, `asset ${asset.name} URL`)),
      token,
      fetchImpl,
    ),
  });
}

async function main(argv) {
  if (process.env.NEBULAR_EXACT_RELEASE_ASSET_FETCH !== "1") {
    fail("dedicated fetch guard is not enabled");
  }
  const flags = parseFlags(argv);
  const token = process.env.GITHUB_TOKEN;
  if (typeof token !== "string" || token.length === 0) fail("dedicated fetch requires GITHUB_TOKEN");
  const checkout = resolve(flags["--checkout"]);
  const helper = await import(pathToFileURL(resolve(flags["--helper"])).href);
  const input = await readJson(flags["--input"]);
  const admission = await readJson(flags["--admission"]);
  const readbacks = await runReleaseAssetFetch({
    helper,
    input,
    admission,
    checkout,
    sourceArchive: flags["--source-archive"],
    darwinSourceArchive: flags["--darwin-source-archive"],
    linuxSourceArchive: flags["--linux-source-archive"],
    darwinReceipt: flags["--darwin-receipt"],
    output: flags["--output"],
    token,
  });
  process.stdout.write(JSON.stringify({ status: "pass", schema: FETCH_READBACK_SCHEMA, assets: readbacks.length }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
