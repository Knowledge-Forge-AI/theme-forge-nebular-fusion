import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INVENTORY_SCHEMA = "theme-forge.generated-appearance-inventory.v1";
const RECEIPT_SCHEMA = "theme-forge.application-appearance-projection.v1";
const GENERATED_RELATIVE_PATH = "src/features/appearance/generated";
const RECEIPT_SOURCE_TRUST = "Input must be produced from the reviewed CTTN source and authenticated engine archives; this receipt alone is not publisher authentication";
const RECEIPT_NON_DEFAULT = "Verification projections; runtime selection imports the generated baseline object";
const APPEARANCE_FAMILY_IDS = ["terminal-nova", "nebular", "developer", "graphic-designer", "anime", "gamer"];
const RUNTIME_BASELINES_PREFIX = "/** Generated from the shared paired profiles; regenerate with the catalog producer. */\nexport const applicationBaselines = ";
const RUNTIME_BASELINES_SUFFIX = ";\n";
const RUNTIME_BASELINES_PURE_PREFIX = "/*#__PURE__*/ ";
const COMMITTED_CLEANUP_FAILED = "committed-cleanup-failed";
const MAX_MEMBER_BYTES = 8 * 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

class AppearanceCommittedCleanupError extends Error {
  constructor() {
    super("Generated output is installed; rollback backup cleanup failed.");
    this.name = "AppearanceCommittedCleanupError";
  }
}

/** Closed CLI categories never include paths, source values or filesystem messages. */
export function appearanceSyncFailureDisposition(error) {
  return error instanceof AppearanceCommittedCleanupError
    ? { label: COMMITTED_CLEANUP_FAILED, exitCode: 2 }
    : { label: "synchronization-failed", exitCode: 1 };
}

const sha256 = value => createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isHexDigest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const codePointCompare = (left, right) => {
  const a = Array.from(left, character => character.codePointAt(0));
  const b = Array.from(right, character => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
};
const safe = path => typeof path === "string" && /^[a-z0-9_./-]+$/.test(path) &&
  !path.startsWith("/") && !path.split("/").some(part => !part || part === "." || part === "..");
const exactKeys = (value, keys, label) => {
  assert(isRecord(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(codePointCompare);
  const expected = [...keys].sort(codePointCompare);
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} has unexpected fields`);
};

function descriptorIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameDescriptorIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function readRegularFile(path, label) {
  assert(Number.isInteger(constants.O_NOFOLLOW) && constants.O_NOFOLLOW > 0, `${label} descriptor no-follow reads are unavailable`);
  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch (error) {
    if (errorCode(error) === "ELOOP" || errorCode(error) === "EMLINK") throw new Error(`${label} must be a regular file`);
    throw new Error(`${label} is unavailable: ${errorMessage(error)}`);
  }
  try {
    let stat;
    try {
      stat = fstatSync(fd);
    } catch (error) {
      throw new Error(`${label} is unavailable: ${errorMessage(error)}`);
    }
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file`);
    assert(Number.isSafeInteger(stat.size) && stat.size >= 0, `${label} has an invalid size`);
    assert(stat.size <= MAX_MEMBER_BYTES, `${label} exceeds ${MAX_MEMBER_BYTES} bytes`);
    const opened = descriptorIdentity(stat);
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      let count;
      try {
        count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      } catch (error) {
        throw new Error(`${label} is unavailable: ${errorMessage(error)}`);
      }
      assert(count > 0, `${label} changed while it was read`);
      offset += count;
    }
    let extraCount;
    try {
      extraCount = readSync(fd, Buffer.alloc(1), 0, 1, bytes.length);
    } catch (error) {
      throw new Error(`${label} is unavailable: ${errorMessage(error)}`);
    }
    assert(extraCount === 0, `${label} changed while it was read`);
    let after;
    try {
      after = fstatSync(fd);
    } catch (error) {
      throw new Error(`${label} changed while it was read`);
    }
    assert(sameDescriptorIdentity(opened, descriptorIdentity(after)), `${label} changed while it was read`);
    return { stat, bytes };
  } finally {
    closeSync(fd);
  }
}

function readDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${error.message}`);
  }
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `${label} must be a regular directory`);
  return stat;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(String(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function parseRuntimeBaselines(bytes) {
  const text = String(bytes);
  assert(text.startsWith(RUNTIME_BASELINES_PREFIX) && text.endsWith(RUNTIME_BASELINES_SUFFIX), "Runtime baselines has unexpected generated wrapper");
  let initializer = text.slice(RUNTIME_BASELINES_PREFIX.length, -RUNTIME_BASELINES_SUFFIX.length);
  if (initializer.startsWith(RUNTIME_BASELINES_PURE_PREFIX)) initializer = initializer.slice(RUNTIME_BASELINES_PURE_PREFIX.length);
  assert(initializer.startsWith("Object.freeze(") && initializer.endsWith(")"), "Runtime baselines must use the canonical Object.freeze initializer");
  const literal = initializer.slice("Object.freeze(".length, -1);
  const baselines = parseJson(Buffer.from(literal), "Runtime baselines literal");
  exactKeys(baselines, APPEARANCE_FAMILY_IDS, "Runtime baselines");
  assert(JSON.stringify(Object.keys(baselines)) === JSON.stringify(APPEARANCE_FAMILY_IDS), "Runtime baselines family order mismatch");
  for (const id of APPEARANCE_FAMILY_IDS) assert(typeof baselines[id] === "string", `Runtime baseline must be text: ${id}`);
  return baselines;
}

function validateInventoryDocument(bytes, label) {
  const inventory = parseJson(bytes, label);
  exactKeys(inventory, ["schema", "members", "digest"], label);
  assert(inventory.schema === INVENTORY_SCHEMA && Array.isArray(inventory.members), `Invalid ${label}`);
  assert(isHexDigest(inventory.digest), `Invalid ${label} digest`);
  const paths = [];
  const declared = new Map();
  for (const member of inventory.members) {
    exactKeys(member, ["path", "bytes", "sha256"], `${label} member`);
    assert(safe(member.path) && member.path !== "inventory.json", `Invalid ${label} member path`);
    assert(Number.isSafeInteger(member.bytes) && member.bytes >= 0, `Invalid ${label} member size`);
    assert(isHexDigest(member.sha256), `Invalid ${label} member digest`);
    assert(!declared.has(member.path), `Duplicate ${label} member`);
    declared.set(member.path, member);
    paths.push(member.path);
  }
  assert(JSON.stringify(paths) === JSON.stringify([...paths].sort(codePointCompare)), `${label} members are not in code-point order`);
  assert(inventory.digest === sha256(`${INVENTORY_SCHEMA}\n` + json(inventory.members)), `${label} digest mismatch`);
  return { inventory, declared };
}

function inputMemberPath(inputRoot, memberPath) {
  const root = resolve(inputRoot);
  const candidate = resolve(root, memberPath);
  const relation = relative(root, candidate);
  assert(relation === memberPath && !relation.startsWith("../") && !isAbsolute(relation), "Appearance member escaped input root");
  return candidate;
}

function loadInput(inputRoot) {
  assert(typeof inputRoot === "string" && isAbsolute(inputRoot), "Absolute generated catalog input required");
  readDirectory(inputRoot, "Appearance input root");
  const inventoryPath = inputMemberPath(inputRoot, "inventory.json");
  const inventoryFile = readRegularFile(inventoryPath, "Appearance inventory");
  const { inventory, declared } = validateInventoryDocument(inventoryFile.bytes, "Appearance inventory");
  const sourceBytes = new Map();
  for (const member of inventory.members) {
    const file = readRegularFile(inputMemberPath(inputRoot, member.path), `Appearance member ${member.path}`);
    assert(file.bytes.length === member.bytes && sha256(file.bytes) === member.sha256, `Appearance member mismatch: ${member.path}`);
    sourceBytes.set(member.path, file.bytes);
  }
  return { inventoryBytes: inventoryFile.bytes, inventory, declared, sourceBytes };
}

function targetIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function fileSnapshot(name, file) {
  return { name, dev: file.stat.dev, ino: file.stat.ino, mode: file.stat.mode, bytes: file.bytes.length, sha256: sha256(file.bytes), data: file.bytes };
}

function inspectTarget(directory, expectedNames) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, identity: null, entries: new Map() };
    throw new Error(`Generated output is unavailable: ${error.message}`);
  }
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "Generated output must be an owned directory");
  const names = readdirSync(directory);
  for (const name of names) assert(expectedNames.has(name), `Generated output contains stale or unknown member: ${name}`);
  const entries = new Map();
  for (const name of names) {
    const file = readRegularFile(join(directory, name), `Generated destination ${name}`);
    entries.set(name, fileSnapshot(name, file));
  }
  return { exists: true, identity: targetIdentity(stat), entries };
}

function validateOwnedReceipt(state) {
  if (!state.exists || state.entries.size === 0) return;
  const provenance = state.entries.get("provenance.json");
  assert(provenance, "Generated destination has no ownership receipt");
  const receipt = parseJson(provenance.data, "Generated provenance");
  exactKeys(receipt, ["schema", "inventoryDigest", "catalogSha256", "defaultFamily", "members", "derivedMembers", "nonDefaultCssFiles", "sourceTrust"], "Generated provenance");
  assert(receipt.schema === RECEIPT_SCHEMA && isHexDigest(receipt.inventoryDigest) && isHexDigest(receipt.catalogSha256), "Invalid generated provenance");
  assert(safe(receipt.defaultFamily), "Invalid generated provenance default");
  assert(receipt.nonDefaultCssFiles === RECEIPT_NON_DEFAULT && receipt.sourceTrust === RECEIPT_SOURCE_TRUST, "Generated provenance policy mismatch");
  assert(Array.isArray(receipt.members) && Array.isArray(receipt.derivedMembers), "Invalid generated provenance members");

  const oldInventory = state.entries.get("source-inventory.json");
  assert(oldInventory, "Generated destination has no source inventory");
  const oldInventoryDocument = validateInventoryDocument(oldInventory.data, "Generated source inventory");
  assert(oldInventoryDocument.inventory.digest === receipt.inventoryDigest, "Generated provenance/source inventory mismatch");
  const oldCatalog = state.entries.get("source-catalog.json");
  assert(oldCatalog && sha256(oldCatalog.data) === receipt.catalogSha256, "Generated provenance/catalog mismatch");

  const owned = new Map();
  for (const member of receipt.members) {
    exactKeys(member, ["producerMember", "output", "bytes", "sha256"], "Generated provenance member");
    assert(safe(member.producerMember) && safe(member.output) && Number.isSafeInteger(member.bytes) && member.bytes >= 0 && isHexDigest(member.sha256), "Invalid generated provenance member");
    assert(!owned.has(member.output), "Duplicate generated provenance output");
    owned.set(member.output, member);
  }
  for (const member of receipt.derivedMembers) {
    exactKeys(member, ["producerMember", "sourceSha256", "output", "transform", "bytes", "sha256"], "Generated provenance derived member");
    assert(safe(member.producerMember) && safe(member.output) && isHexDigest(member.sourceSha256) && typeof member.transform === "string" && Number.isSafeInteger(member.bytes) && member.bytes >= 0 && isHexDigest(member.sha256), "Invalid generated provenance derived member");
    assert(!owned.has(member.output), "Duplicate generated provenance output");
    owned.set(member.output, member);
  }
  for (const [name, entry] of state.entries) {
    if (name === "provenance.json" || name === "source-inventory.json") continue;
    const expected = owned.get(name);
    assert(expected && expected.bytes === entry.bytes && expected.sha256 === entry.sha256, `Generated destination is modified or foreign: ${name}`);
  }
}

function sameFile(before, after) {
  return before && after && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
    before.bytes === after.bytes && before.sha256 === after.sha256;
}

function assertTargetUnchanged(directory, before, expectedNames) {
  const after = inspectTarget(directory, expectedNames);
  assert(after.exists === before.exists, "Generated output changed during staging");
  if (!before.exists) return;
  assert(JSON.stringify(after.identity) === JSON.stringify(before.identity), "Generated output directory changed during staging");
  const names = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const name of names) assert(sameFile(before.entries.get(name), after.entries.get(name)), `Generated destination changed during staging: ${name}`);
}

function removeOwnedDirectory(directory, label) {
  readDirectory(directory, label);
  for (const name of readdirSync(directory)) {
    const child = lstatSync(join(directory, name));
    assert(child.isFile() && !child.isSymbolicLink(), `${label} contains an unexpected entry`);
  }
  rmSync(directory, { recursive: true, force: false });
}

function stageOutputs(parent, files, mode) {
  const stage = mkdtempSync(join(parent, ".generated-appearance-stage-"));
  try {
    readDirectory(stage, "Appearance staging directory");
    for (const [name, content] of files) {
      assert(safe(name) && !name.includes("/"), "Invalid staged output name");
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const path = join(stage, name);
      writeFileSync(path, bytes, { flag: "wx", mode: 0o644 });
      const written = readRegularFile(path, `Staged output ${name}`);
      assert(written.bytes.length === bytes.length && sha256(written.bytes) === sha256(bytes), `Staged output mismatch: ${name}`);
    }
    chmodSync(stage, mode);
    const stagedNames = readdirSync(stage).sort(codePointCompare);
    const expectedNames = [...files.keys()].sort(codePointCompare);
    assert(JSON.stringify(stagedNames) === JSON.stringify(expectedNames), "Staged output set mismatch");
    return stage;
  } catch (error) {
    try { removeOwnedDirectory(stage, "Appearance staging directory"); } catch (cleanupError) {
      throw new Error(`${error.message}; staging cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }
}

function commitStage(stage, directory, before, expectedNames) {
  let backup = null;
  let moved = false;
  let installed = false;
  try {
    assertTargetUnchanged(directory, before, expectedNames);
    backup = before.exists ? join(dirname(directory), `.generated-appearance-backup-${randomUUID()}`) : null;
    if (backup) {
      try { lstatSync(backup); throw new Error("Generated backup path already exists"); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      renameSync(directory, backup);
      moved = true;
    }
    renameSync(stage, directory);
    installed = true;
  } catch (error) {
    let rollbackError;
    if (moved && !installed) {
      try {
        try { lstatSync(directory); throw new Error("Generated output appeared during rollback"); } catch (targetError) {
          if (targetError.code !== "ENOENT") throw targetError;
        }
        renameSync(backup, directory);
        moved = false;
      } catch (restoreError) {
        rollbackError = restoreError;
      }
    }
    if (!installed) {
      try { removeOwnedDirectory(stage, "Appearance staging directory"); } catch (cleanupError) {
        rollbackError ??= cleanupError;
      }
    }
    if (rollbackError) throw new Error(`${error.message}; rollback failed: ${rollbackError.message}`);
    throw error;
  }
  if (backup) {
    try {
      removeOwnedDirectory(backup, "Appearance rollback backup");
    } catch (error) {
      throw new AppearanceCommittedCleanupError();
    }
  }
}

/** Build-owned projection only; neither the runtime nor this adapter compiles profiles. */
export function syncAppearanceAssets(inputRoot, studioRoot) {
  assert(typeof studioRoot === "string" && isAbsolute(studioRoot), "Absolute studio root required");
  const { inventoryBytes, inventory, declared, sourceBytes } = loadInput(inputRoot);
  const catalogBytes = sourceBytes.get("catalog.json");
  assert(catalogBytes, "Undeclared appearance member: catalog.json");
  const catalog = parseJson(catalogBytes, "Appearance catalog");
  exactKeys(catalog, ["schema", "status", "defaultFamily", "modes", "engines", "sttnTemplateSha256", "sourceIdentity", "families"], "Appearance catalog");
  assert(catalog.schema === "theme-forge.appearance-catalog-candidate.v1" && Array.isArray(catalog.families), "Invalid appearance catalog");
  assert(catalog.families.some(family => isRecord(family) && family.id === catalog.defaultFamily), "Missing default appearance");
  assert(catalog.defaultFamily === "nebular", "Application default must match the reviewed product configuration");
  assert(new Set(catalog.families.map(family => family.id)).size === catalog.families.length, "Duplicate appearance family");
  const familyIds = catalog.families.map(family => family.id);
  assert(JSON.stringify(familyIds) === JSON.stringify(APPEARANCE_FAMILY_IDS), "Appearance catalog must retain the exact six-family set");
  const baselines = parseRuntimeBaselines(sourceBytes.get("runtime-baselines.ts"));
  for (const id of APPEARANCE_FAMILY_IDS) {
    const projected = sourceBytes.get(`${id}/application.css`);
    assert(projected && Buffer.from(baselines[id]).equals(projected), `Runtime baseline does not match projected application CSS: ${id}`);
  }

  const outputs = [
    { producerMember: "runtime-baselines.ts", output: "runtime-baselines.ts" },
    { producerMember: "catalog.json", output: "source-catalog.json" },
    ...catalog.families.map(family => {
      assert(isRecord(family) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(family.id), "Invalid appearance family");
      return { producerMember: `${family.id}/application.css`, output: `${family.id}.css` };
    }),
  ];
  const outputNames = outputs.map(value => value.output);
  const expectedNames = new Set([...outputNames, "catalog-index.json", "source-inventory.json", "provenance.json"]);
  assert(expectedNames.size === outputNames.length + 3, "Duplicate generated output name");
  const projected = outputs.map(value => {
    const data = sourceBytes.get(value.producerMember);
    assert(data && declared.has(value.producerMember), `Undeclared appearance member: ${value.producerMember}`);
    return { ...value, data };
  });
  const catalogIndex = {
    schema: "theme-forge.application-appearance-index.v1",
    sourceCatalogSha256: sha256(catalogBytes),
    families: catalog.families.map(({ id, label }) => {
      assert(typeof label === "string" && label.length > 0 && label.length <= 128, "Invalid appearance label");
      return { id, label };
    }),
  };
  const indexBytes = Buffer.from(json(catalogIndex));
  const receipt = {
    schema: RECEIPT_SCHEMA,
    inventoryDigest: inventory.digest,
    catalogSha256: sha256(catalogBytes),
    defaultFamily: catalog.defaultFamily,
    members: projected.map(({ producerMember, output, data }) => ({ producerMember, output, bytes: data.length, sha256: sha256(data) })),
    derivedMembers: [{ producerMember: "catalog.json", sourceSha256: sha256(catalogBytes), output: "catalog-index.json",
      transform: "family-index-v1", bytes: indexBytes.length, sha256: sha256(indexBytes) }],
    nonDefaultCssFiles: RECEIPT_NON_DEFAULT,
    sourceTrust: RECEIPT_SOURCE_TRUST,
  };
  const files = new Map([
    ...projected.map(value => [value.output, value.data]),
    ["catalog-index.json", indexBytes],
    ["source-inventory.json", inventoryBytes],
    ["provenance.json", Buffer.from(json(receipt))],
  ]);
  const directory = join(studioRoot, GENERATED_RELATIVE_PATH);
  const before = inspectTarget(directory, expectedNames);
  validateOwnedReceipt(before);
  const parent = dirname(directory);
  mkdirSync(parent, { recursive: true });
  readDirectory(parent, "Generated output parent");
  const targetMode = before.exists ? before.identity.mode & 0o7777 : 0o755;
  const stage = stageOutputs(parent, files, targetMode);
  try {
    commitStage(stage, directory, before, expectedNames);
  } catch (error) {
    if (error instanceof AppearanceCommittedCleanupError) throw error;
    throw new Error(`Appearance asset synchronization failed: ${error.message}`);
  }
  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 3 && isAbsolute(process.argv[2]), "Absolute generated catalog input required");
    const studio = resolve(fileURLToPath(new URL("../", import.meta.url)));
    const result = syncAppearanceAssets(process.argv[2], studio);
    console.log(json({ inventoryDigest: result.inventoryDigest, projectedMembers: result.members.length }));
  } catch (error) {
    const failure = appearanceSyncFailureDisposition(error);
    console.error("Appearance asset synchronization: " + failure.label + "; build must stop.");
    process.exitCode = failure.exitCode;
  }
}
