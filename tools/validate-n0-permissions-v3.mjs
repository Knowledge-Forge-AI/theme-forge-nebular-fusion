import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  N0_BOOTSTRAP_CONFIG_JSON,
  N0_BOOTSTRAP_CONFIG_SHA256,
  validateN0BootstrapConfig,
} from "./n0-permission-bootstrap-config.mjs";

const EXPECTED_COMMAND_COUNT = 54;
const EXPECTED_NODE_VERSION = "22.23.4";
const EXPECTED_RUST_VERSION = /^rustc 1\.98\.0(?:\s|$)/u;
const EXPECTED_CARGO_VERSION = /^cargo 1\.98\.0(?:\s|$)/u;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_CAPABILITY_BYTES = 256 * 1024;
const MAX_PERMISSION_BYTES = 64 * 1024;
const COMMAND_NAME = /^studio_[a-z0-9_]+$/u;
const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
const ORIGINAL_TAURI_CONFIG = "src-tauri/tauri.conf.json";
const BOOTSTRAP_CONFIG_MODULE = "tools/n0-permission-bootstrap-config.mjs";

const SOURCE_FILES = Object.freeze([
  "src-tauri/src/command_inventory.rs",
  "src-tauri/src/lib.rs",
  "src-tauri/capabilities/main.json",
  "src-tauri/build.rs",
  "rust-toolchain.toml",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  ORIGINAL_TAURI_CONFIG,
  BOOTSTRAP_CONFIG_MODULE,
]);

function fail(code) {
  throw new Error(`N0_${code}`);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegular(root, relativePath, maxBytes, code) {
  const absolutePath = resolve(root, relativePath);
  let stat;
  try {
    stat = await lstat(absolutePath);
  } catch {
    fail(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) fail(code);
  const bytes = await readFile(absolutePath);
  if (bytes.length !== stat.size || bytes.length > maxBytes) fail(code);
  return bytes;
}

function parseInventory(bytes) {
  const text = bytes.toString("utf8");
  const match = /STUDIO_COMMAND_NAMES\s*:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/u.exec(text);
  if (!match) fail("INVENTORY_SHAPE");
  const commands = [...match[1].matchAll(/"([^"\\]+)"/gu)].map((entry) => entry[1]);
  if (commands.length !== EXPECTED_COMMAND_COUNT || commands.some((command) => !COMMAND_NAME.test(command))) {
    fail("COMMAND_SET_MISMATCH");
  }
  if (new Set(commands).size !== commands.length) fail("COMMAND_SET_DUPLICATE");
  return commands;
}

function parseHandlers(bytes) {
  const text = bytes.toString("utf8");
  const marker = ".invoke_handler(tauri::generate_handler![";
  const start = text.indexOf(marker);
  if (start < 0) fail("HANDLER_SHAPE");
  const end = text.indexOf("])\n", start);
  if (end < 0) fail("HANDLER_SHAPE");
  const body = text.slice(start + marker.length, end);
  const lines = body.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const commands = [];
  for (const line of lines) {
    if (!/^[a-zA-Z0-9_:]+,$/u.test(line)) fail("HANDLER_SHAPE");
    const command = /(?<command>studio_[a-z0-9_]+),$/u.exec(line)?.groups?.command;
    if (!command || !COMMAND_NAME.test(command)) fail("HANDLER_SHAPE");
    commands.push(command);
  }
  if (new Set(commands).size !== commands.length) fail("HANDLER_SET_DUPLICATE");
  return commands;
}

function parseCapability(bytes, commands) {
  let capability;
  try {
    capability = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CAPABILITY_JSON");
  }
  if (!exactKeys(capability, ["$schema", "identifier", "description", "local", "windows", "permissions"])) {
    fail("CAPABILITY_SHAPE");
  }
  if (
    typeof capability.$schema !== "string" ||
    capability.identifier !== "main" ||
    typeof capability.description !== "string" ||
    capability.local !== true ||
    JSON.stringify(capability.windows) !== JSON.stringify(["main"])
  ) {
    fail("CAPABILITY_SHAPE");
  }
  const expected = commands.map((command) => `allow-${command.replaceAll("_", "-")}`);
  if (
    !Array.isArray(capability.permissions) ||
    capability.permissions.length !== expected.length ||
    capability.permissions.some((permission, index) => permission !== expected[index])
  ) {
    fail("CAPABILITY_COMMAND_SET_MISMATCH");
  }
}

function parseOriginalTauriConfig(bytes) {
  let config;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("ORIGINAL_CONFIG_JSON");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) fail("ORIGINAL_CONFIG_SHAPE");
  if (!config.build || typeof config.build !== "object" || Array.isArray(config.build)) fail("ORIGINAL_CONFIG_BUILD");
  if (!config.bundle || typeof config.bundle !== "object" || Array.isArray(config.bundle)) fail("ORIGINAL_CONFIG_BUNDLE");
  if (config.build.frontendDist === null || config.build.frontendDist === undefined) fail("ORIGINAL_CONFIG_FRONTEND_DIST");
  if (!Array.isArray(config.bundle.externalBin) || config.bundle.externalBin.length === 0) fail("ORIGINAL_CONFIG_EXTERNAL_BIN");
  if (!Array.isArray(config.bundle.resources) || config.bundle.resources.length === 0) fail("ORIGINAL_CONFIG_RESOURCES");
  return config;
}

function validateBootstrapConfigIdentity(bytes) {
  let moduleText = bytes.toString("utf8");
  if (!moduleText.includes("N0_BOOTSTRAP_CONFIG")) fail("BOOTSTRAP_MODULE_SHAPE");
  let parsed;
  try {
    parsed = JSON.parse(N0_BOOTSTRAP_CONFIG_JSON);
  } catch {
    fail("BOOTSTRAP_JSON");
  }
  validateN0BootstrapConfig(parsed);
  if (sha256(Buffer.from(N0_BOOTSTRAP_CONFIG_JSON)) !== N0_BOOTSTRAP_CONFIG_SHA256) fail("BOOTSTRAP_DIGEST");
  return {
    sourceBytes: bytes.length,
    sourceSha256: sha256(bytes),
    configBytes: Buffer.byteLength(N0_BOOTSTRAP_CONFIG_JSON),
    configSha256: N0_BOOTSTRAP_CONFIG_SHA256,
    devUrl: parsed.build.devUrl,
    frontendDist: parsed.build.frontendDist,
    externalBin: parsed.bundle.externalBin,
    resources: parsed.bundle.resources,
  };
}

function permissionText(command) {
  const identifier = `studio-${command.slice("studio_".length).replaceAll("_", "-")}`;
  return `# Automatically generated - DO NOT EDIT!\n\n[[permission]]\nidentifier = "allow-${identifier}"\ndescription = "Enables the ${command} command without any pre-configured scope."\ncommands.allow = ["${command}"]\n\n[[permission]]\nidentifier = "deny-${identifier}"\ndescription = "Denies the ${command} command without any pre-configured scope."\ncommands.deny = ["${command}"]\n`;
}

async function validateGeneratedPermissions(root, commands) {
  const relativeDirectory = "src-tauri/permissions/autogenerated";
  const directory = resolve(root, relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail("GENERATED_DIRECTORY");
  }
  const expectedNames = commands.map((command) => `${command}.toml`);
  const actualNames = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== [...expectedNames].sort()[index])
  ) {
    fail("GENERATED_FILE_SET_MISMATCH");
  }
  const files = [];
  for (const command of commands) {
    const name = `${command}.toml`;
    const bytes = await readRegular(root, join(relativeDirectory, name), MAX_PERMISSION_BYTES, "GENERATED_PERMISSION_READ");
    if (bytes.toString("utf8") !== permissionText(command)) fail("GENERATED_PERMISSION_CONTENT");
    files.push({ path: join(relativeDirectory, name), bytes: bytes.length, sha256: sha256(bytes) });
  }
  return files;
}

export async function validateN0({ root, sourceCommit, sourceTree, nodeVersion, rustVersion, cargoVersion, bootstrapCheckSucceeded, expectedOriginalConfigSha256, expectedConfigSha256 }) {
  if (typeof root !== "string" || !isAbsolute(root)) fail("ROOT");
  if (typeof sourceCommit !== "string" || !HEX40.test(sourceCommit)) fail("SOURCE_COMMIT");
  if (typeof sourceTree !== "string" || !HEX40.test(sourceTree)) fail("SOURCE_TREE");
  if (!HEX64.test(expectedOriginalConfigSha256) || !HEX64.test(expectedConfigSha256)) fail("EXPECTED_DIGEST_ARGUMENTS");
  if (nodeVersion !== EXPECTED_NODE_VERSION || !EXPECTED_RUST_VERSION.test(rustVersion) || !EXPECTED_CARGO_VERSION.test(cargoVersion)) {
    fail("TOOLCHAIN");
  }
  if (bootstrapCheckSucceeded !== true && bootstrapCheckSucceeded !== "true") fail("BOOTSTRAP_CHECK_NOT_CONFIRMED");

  const sourceBytes = {};
  for (const relativePath of SOURCE_FILES) {
    const bytes = await readRegular(root, relativePath, relativePath.endsWith("Cargo.lock") ? 4 * MAX_SOURCE_BYTES : MAX_SOURCE_BYTES, "SOURCE_READ");
    sourceBytes[relativePath] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  parseOriginalTauriConfig(await readRegular(root, ORIGINAL_TAURI_CONFIG, MAX_CAPABILITY_BYTES, "ORIGINAL_CONFIG_READ"));
  if (sourceBytes[ORIGINAL_TAURI_CONFIG].sha256 !== expectedOriginalConfigSha256) fail("ORIGINAL_CONFIG_DIGEST");
  const bootstrap = validateBootstrapConfigIdentity(
    await readRegular(root, BOOTSTRAP_CONFIG_MODULE, MAX_SOURCE_BYTES, "BOOTSTRAP_MODULE_READ"),
  );
  if (bootstrap.configSha256 !== expectedConfigSha256) fail("BOOTSTRAP_CONFIG_DIGEST");
  const commands = parseInventory(await readRegular(root, SOURCE_FILES[0], MAX_SOURCE_BYTES, "INVENTORY_READ"));
  const handlers = parseHandlers(await readRegular(root, SOURCE_FILES[1], MAX_SOURCE_BYTES, "HANDLER_READ"));
  if (JSON.stringify(handlers) !== JSON.stringify(commands)) fail("HANDLER_SET_MISMATCH");
  parseCapability(await readRegular(root, SOURCE_FILES[2], MAX_CAPABILITY_BYTES, "CAPABILITY_READ"), commands);
  const generatedFiles = await validateGeneratedPermissions(root, commands);
  const generatedDirectorySha256 = sha256(Buffer.from(JSON.stringify(generatedFiles)));
  return {
    schema: "theme-forge.native-n0-permission-receipt.v2",
    source: {
      commit: sourceCommit,
      tree: sourceTree,
      files: sourceBytes,
    },
    toolchain: {
      node: nodeVersion,
      rustc: rustVersion,
      cargo: cargoVersion,
    },
    bootstrap: {
      checkSucceededBeforeValidation: true,
      configModule: BOOTSTRAP_CONFIG_MODULE,
      moduleBytes: bootstrap.sourceBytes,
      moduleSha256: bootstrap.sourceSha256,
      configSha256: bootstrap.configSha256,
      configBytes: bootstrap.configBytes,
      devUrl: bootstrap.devUrl,
      frontendDist: bootstrap.frontendDist,
      externalBin: bootstrap.externalBin,
      resources: bootstrap.resources,
      originalTauriConfig: {
        path: ORIGINAL_TAURI_CONFIG,
        bytes: sourceBytes[ORIGINAL_TAURI_CONFIG].bytes,
        sha256: sourceBytes[ORIGINAL_TAURI_CONFIG].sha256,
      },
    },
    commands: {
      count: commands.length,
      names: commands,
      generatedDirectory: "src-tauri/permissions/autogenerated",
      generatedDirectorySha256,
      files: generatedFiles,
    },
    boundary: {
      generatedBy: "src-tauri/build.rs -> tauri_build::AppManifest::new().commands",
      mode: "step-local TAURI_CONFIG merge override only",
      defaultProductCompile: false,
      originalConfigBuild: false,
      nativeBuild: false,
      publication: false,
      secrets: false,
    },
  };
}

function parseArgs(argv) {
  const values = new Map();
  const optionNames = Object.freeze({
    "--root": "root",
    "--source-commit": "sourceCommit",
    "--source-tree": "sourceTree",
    "--node-version": "nodeVersion",
    "--rust-version": "rustVersion",
    "--cargo-version": "cargoVersion",
    "--bootstrap-check-succeeded": "bootstrapCheckSucceeded",
    "--expect-original-config-sha256": "expectedOriginalConfigSha256",
    "--expect-config-sha256": "expectedConfigSha256",
    "--receipt": "receipt",
  });
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    const optionName = optionNames[key];
    if (optionName === undefined || value === undefined || values.has(optionName)) fail("CLI_ARGUMENTS");
    values.set(optionName, value);
  }
  const required = ["--root", "--source-commit", "--source-tree", "--node-version", "--rust-version", "--cargo-version", "--bootstrap-check-succeeded", "--expect-original-config-sha256", "--expect-config-sha256", "--receipt"];
  const requiredNames = Object.freeze(["root", "sourceCommit", "sourceTree", "nodeVersion", "rustVersion", "cargoVersion", "bootstrapCheckSucceeded", "expectedOriginalConfigSha256", "expectedConfigSha256", "receipt"]);
  if (required.some((key) => optionNames[key] === undefined || !values.has(optionNames[key])) || values.size !== requiredNames.length) {
    fail("CLI_ARGUMENTS");
  }
  return Object.fromEntries(values);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const receipt = await validateN0(args);
  await writeFile(args.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

