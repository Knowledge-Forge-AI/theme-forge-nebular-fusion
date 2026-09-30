// Canonical receipt contracts. Validation is not producer authentication: the
// assembly caller must separately supply the identities accepted from its build.
import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { CANDIDATE_VERSION, TARGETS, resourcePreparationPlan } from "./platform-targets.mjs";

export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported candidate identity value");
}
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const identity = value => digest(canonical(value));
const fail = message => { throw new Error(`Candidate provenance: ${message}`); };
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => canonical(a) === canonical(b);
function keys(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !same(Object.keys(value).sort(), [...names].sort())) fail("record fields differ");
}
function digests(value, names) {
  keys(value, names);
  for (const key of names) if (!sha(value[key])) fail(`invalid ${key} identity`);
}
function envelope(value, schema, fields) {
  keys(value, ["schema", "identity", ...fields]);
  const { identity: declared, ...body } = value;
  if (body.schema !== schema || !sha(declared) || identity(body) !== declared) fail("envelope identity mismatch");
}
export function seal(schema, fields) {
  if (Object.hasOwn(fields, "schema") || Object.hasOwn(fields, "identity")) fail("reserved envelope field");
  const body = { schema, ...fields };
  return { ...body, identity: identity(body) };
}

// No symlinks, implicit omissions, timestamps or absolute paths in identities.
// Callers inventory an already materialized public composition, not a checkout.
export async function inventoryTree(root) {
  const files = [];
  let total = 0;
  async function visit(directory, prefix = "") {
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) fail("non-directory inventory root");
    const entries = await readdir(directory, { withFileTypes: true });
    const names = new Set();
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!/^[A-Za-z0-9._@+ -]+$/.test(entry.name) || names.has(entry.name.toLowerCase())) fail("unsafe or colliding member");
      names.add(entry.name.toLowerCase());
      const path = join(directory, entry.name), relative = prefix + entry.name;
      if (relative.length > 1024) fail("member path limit");
      if (entry.isDirectory()) await visit(path, relative + "/");
      else {
        if (!entry.isFile()) fail("nonregular inventory member");
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 256 * 1024 * 1024 || files.length >= 100000) fail("member type or size limit");
          total += info.size;
          if (total > 2 * 1024 * 1024 * 1024) fail("inventory byte limit");
          const bytes = await handle.readFile();
          const after = await handle.stat(), named = await lstat(path);
          if ([after, named].some(s => s.dev !== info.dev || s.ino !== info.ino || s.size !== info.size || s.mtimeMs !== info.mtimeMs || s.mode !== info.mode)) fail("member changed during inventory");
          files.push({ path: relative, bytes: bytes.length, mode: info.mode & 0o111 ? 0o755 : 0o644, sha256: digest(bytes) });
        } finally { await handle.close(); }
      }
    }
    const after = await lstat(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) fail("directory changed during inventory");
  }
  await visit(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, identity: identity(files) };
}

function validateResourcePlans(plans) {
  keys(plans, TARGETS.map(target => target.triple));
  for (const plan of Object.values(plans)) {
    keys(plan, ["resources", "externalBin"]);
    for (const paths of [plan.resources, plan.externalBin]) {
      if (!Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length
          || paths.some(path => typeof path !== "string" || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path))) fail("source resource plan invalid");
    }
  }
}

// Called by the source producer with the materialized composition's config.
// Consumers use the sealed result, never their own checkout's Tauri config.
export function sourceResourcePlans(config) {
  const plans = Object.fromEntries(TARGETS.map(target => [target.triple, {
    resources: resourcePreparationPlan(config, target).map(entry => entry.directory).sort(),
    externalBin: [...config.bundle.externalBin].sort(),
  }]));
  validateResourcePlans(plans);
  return plans;
}

export function validateSourceCandidate(source) {
  envelope(source, "nebular-source-candidate-v1", ["version", "composition", "locks", "components", "recipe", "resourcePlans"]);
  if (source.version !== CANDIDATE_VERSION || !sha(source.composition) || !sha(source.recipe)) fail("source candidate mismatch");
  digests(source.locks, ["cargo", "frontend"]);
  digests(source.components, ["burst", "loom", "solar"]);
  validateResourcePlans(source.resourcePlans);
  return source;
}

export function validateBuildReceipt(receipt, source) {
  validateSourceCandidate(source);
  envelope(receipt, "nebular-build-receipt-v1", [
    "sourceCandidate", "version", "target", "mode", "toolchains", "components", "settings", "preparation", "nativePayload"
  ]);
  if (receipt.sourceCandidate !== source.identity || receipt.version !== source.version || !TARGETS.some(t => t.triple === receipt.target)
      || !["nix-source", "portable-source"].includes(receipt.mode)) fail("build candidate, mode or target mismatch");
  digests(receipt.toolchains, ["node", "rust", "cargo", "compiler", "linker", "systemLibraries"]);
  if (!sha(receipt.settings)) fail("settings identity required");
  keys(receipt.components, ["burst", "loom", "solar"]);
  for (const name of ["burst", "loom", "solar"]) {
    const component = receipt.components[name];
    keys(component, ["source", "output", "producer"]);
    if (component.source !== source.components[name] || !sha(component.output) || !sha(component.producer)) fail("component source or producer mismatch");
  }
  keys(receipt.preparation, ["identity", "resources", "externalBin"]);
  if (!sha(receipt.preparation.identity) || !sha(receipt.nativePayload)) fail("output identity missing");
  const preparation = { resources: receipt.preparation.resources, externalBin: receipt.preparation.externalBin };
  if (identity(preparation) !== receipt.preparation.identity) fail("preparation identity mismatch");
  for (const records of [preparation.resources, preparation.externalBin]) {
    if (!Array.isArray(records) || !records.length) fail("resource inventory missing");
    const names = new Set();
    for (const entry of records) {
      keys(entry, ["path", "identity"]);
      if (typeof entry.path !== "string" || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(entry.path) || names.has(entry.path) || !sha(entry.identity)) fail("resource inventory invalid");
      names.add(entry.path);
    }
  }
  validateResourceCoverage(receipt, source);
  return receipt;
}

export function validateResourceCoverage(receipt, source) {
  validateSourceCandidate(source);
  const plan = source.resourcePlans[receipt.target];
  if (!plan || receipt.sourceCandidate !== source.identity) fail("resource plan candidate or target mismatch");
  const expected = [...plan.resources].sort();
  const actual = receipt.preparation.resources.map(x => x.path).sort();
  if (!same(expected, actual) || !same([...plan.externalBin].sort(), receipt.preparation.externalBin.map(x => x.path).sort())) fail("required Tauri resource coverage mismatch");
}

export function candidateProvenance(source, receipt) {
  validateBuildReceipt(receipt, source);
  return seal("nebular-candidate-provenance-v1", { source, receipt });
}

export function verifyCandidateProvenance(record, authority) {
  envelope(record, "nebular-candidate-provenance-v1", ["source", "receipt"]);
  validateBuildReceipt(record.receipt, record.source);
  // These anchors must come from the owner's successful producer, never from
  // the untrusted artifact or its accompanying path/hash request itself.
  if (!authority || record.source.identity !== authority.sourceCandidate
      || authority.buildReceipts?.[record.receipt.target] !== record.receipt.identity) fail("unaccepted producer identity");
  if (authority.settings) {
    let expected;
    if (typeof authority.settings === "string") {
      expected = authority.settings;
    } else if (typeof authority.settings === "object" && authority.settings !== null && !Array.isArray(authority.settings)) {
      if (!Object.hasOwn(authority.settings, record.receipt.target) || !authority.settings[record.receipt.target]) {
        fail(`missing target settings authority for ${record.receipt.target}`);
      }
      expected = authority.settings[record.receipt.target];
    } else {
      fail("invalid authority settings format");
    }
    if (!sha(expected) || record.receipt.settings !== expected) fail("settings identity mismatch");
  }
  return record;
}

export function verifyArtifactBinding(binding, provenance, authority, artifact) {
  verifyCandidateProvenance(provenance, authority);
  envelope(binding, "nebular-artifact-binding-v1", ["candidateProvenance", "sourceCandidate", "target", "nativePayload", "artifact"]);
  if (binding.candidateProvenance !== provenance.identity || binding.sourceCandidate !== provenance.source.identity
      || binding.target !== provenance.receipt.target || binding.nativePayload !== provenance.receipt.nativePayload
      || !sha(binding.artifact) || binding.artifact !== artifact) fail("mixed candidate artifact");
  if (!Array.isArray(authority.artifactBindings?.[binding.target])
      || !authority.artifactBindings[binding.target].includes(binding.identity)) fail("unaccepted artifact producer identity");
  return binding;
}
