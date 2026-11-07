import { createHash } from "node:crypto";

const EXPECTED_DEV_URL = "http://127.0.0.1:1420";
const EXPECTED_KEYS = Object.freeze({
  root: Object.freeze(["build", "bundle"]),
  build: Object.freeze(["devUrl", "frontendDist"]),
  bundle: Object.freeze(["externalBin", "resources"]),
});

export const N0_BOOTSTRAP_CONFIG = Object.freeze({
  build: Object.freeze({
    devUrl: EXPECTED_DEV_URL,
    frontendDist: null,
  }),
  bundle: Object.freeze({
    externalBin: null,
    resources: null,
  }),
});

export const N0_BOOTSTRAP_CONFIG_JSON = JSON.stringify(N0_BOOTSTRAP_CONFIG);
export const N0_BOOTSTRAP_CONFIG_SHA256 = createHash("sha256")
  .update(N0_BOOTSTRAP_CONFIG_JSON)
  .digest("hex");

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function fail(code) {
  throw new Error(`N0_BOOTSTRAP_${code}`);
}

export function validateN0BootstrapConfig(value) {
  if (!exactKeys(value, EXPECTED_KEYS.root)) fail("ROOT_KEYS");
  if (!exactKeys(value.build, EXPECTED_KEYS.build) || !exactKeys(value.bundle, EXPECTED_KEYS.bundle)) {
    fail("SECTION_KEYS");
  }
  if (value.build.devUrl !== EXPECTED_DEV_URL || value.build.frontendDist !== null) fail("BUILD_VALUES");
  if (value.bundle.externalBin !== null) fail("EXTERNAL_BIN");
  if (value.bundle.resources !== null) fail("RESOURCES");
  return true;
}

validateN0BootstrapConfig(N0_BOOTSTRAP_CONFIG);

function parseArgs(argv) {
  if (argv.length !== 1 || !["--print-json", "--print-sha256"].includes(argv[0])) fail("CLI_ARGUMENTS");
  return argv[0];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = parseArgs(process.argv.slice(2));
  process.stdout.write(`${mode === "--print-json" ? N0_BOOTSTRAP_CONFIG_JSON : N0_BOOTSTRAP_CONFIG_SHA256}\n`);
}
