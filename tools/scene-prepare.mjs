import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { readFile, writeFile, mkdir, lstat, readdir, copyFile, open, cp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE_MEMBERS } from "./scene-input-build.mjs";
import { NODE_RELEASE_IDENTITY } from "./node-runtime-authority.mjs";

/** @typedef {{ path: string, bytes: number, sha256: string }} SceneFile */
/** @typedef {{ version: string, target: string, sha256: string, bytes: number }} SceneRuntimeBinding */
/** @typedef {{
 *   schema: string,
 *   engineSchema: string,
 *   capability: string,
 *   compatibility: number,
 *   compilerLevel: number,
 *   metadataVersion: string,
 *   sha256: string,
 *   bytes: number,
 *   sourceTreeDigest: string,
 *   sourceIdentity: string,
 *   runtime: SceneRuntimeBinding,
 *   node: SceneRuntimeBinding,
 *   adapterSha256: string,
 *   files: SceneFile[],
 *   inventory: SceneFile[],
 *   fileCount: number,
 * }} SceneBinding */
/** @typedef {{sha256: string, size?: number, bytes?: number, target?: string, version?: string}} SceneRuntimeInput */
/**
 * Scene receipts are intentionally open to the persisted fields emitted by
 * scene-prepare while the aggregate boundary names every field it reads.
 *
 * @typedef {Record<string, unknown> & {
 *   schema?: string,
 *   engineSchema?: string,
 *   capability?: string,
 *   compatibility?: number,
 *   compilerLevel?: number,
 *   metadataVersion?: string,
 *   sha256?: string,
 *   bytes?: number,
 *   sourceTreeDigest?: string,
 *   sourceIdentity?: string,
 *   runtime?: SceneRuntimeInput,
 *   node?: SceneRuntimeInput,
 *   adapterSha256?: string,
 *   files?: SceneFile[],
 *   inventory?: SceneFile[],
 *   fileCount?: number
 * }} SceneBindingInput
 */

/** @typedef {{ sourceCandidate?: string }} SceneBindingValidationOptions */
/** @typedef {{
 *   archive: string,
 *   node: string,
 *   destination?: string,
 *   binding?: SceneBindingInput,
 *   expectedSha256?: string,
 * }} ScenePayloadOptions */
/** @typedef {{
 *   studioRoot?: string,
 *   burstRoot?: string,
 *   node?: string,
 *   destination?: string,
 *   sourceIdentity?: string,
 *   xmldomRoot?: string,
 *   tomlRoot?: string,
 * }} SceneFromSourceOptions */

const studio=resolve(dirname(fileURLToPath(import.meta.url)),"..");
/** @param {string | Buffer} bytes @returns {string} */
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
export const SCENE_ROOT_PACKAGE_TEXT='{"private":true,"type":"module"}\n';
/** @type {SceneBinding} */
export const sceneBinding=JSON.parse(await readFile(join(studio,"protocol/scene-workbench-v1/payload-binding.json"),"utf8"));
const SCENE_BURST_PREFIX="node_modules/@knowledge-forge-ai/theme-forge-stellar-burst/";
const SCENE_XMLDOM_PREFIX="node_modules/@xmldom/xmldom/";
const SCENE_TOML_PREFIX="node_modules/smol-toml/";
const SCENE_LEGAL_PATHS=new Set([
  `${SCENE_BURST_PREFIX}LICENSE`,
  `${SCENE_BURST_PREFIX}NOTICE`,
  `${SCENE_BURST_PREFIX}COMMERCIAL-LICENSE.md`,
]);
const FORBIDDEN_SCENE_FACILITY_PATTERN=/child_process|worker_threads|node:vm|process\s*\.\s*(?:dlopen|binding)|\bimport\s*\(|\beval\s*\(|\bnew\s+Function\b|resvg|\.node["']/u;

/** @param {string} path @returns {boolean} */
function isSafeScenePath(path) {
  return typeof path==="string" && path.length>0 && !path.startsWith("/") && !path.includes("\\")
    && !path.includes("\0") && path.split("/").every(segment=>segment.length>0 && segment!=="." && segment!=="..");
}

/** @param {string} path @returns {boolean} */
function isAllowedStructuredScenePath(path) {
  if(!isSafeScenePath(path)) return false;
  if(path==="package.json" || path==="scene-input.json" || path==="bin/scene-batch.js" || SCENE_LEGAL_PATHS.has(path)) return true;
  if(path===`${SCENE_BURST_PREFIX}package.json` || path===`${SCENE_XMLDOM_PREFIX}package.json` || path===`${SCENE_TOML_PREFIX}package.json`) return true;
  if(SCENE_MEMBERS.some(member=>path===`${SCENE_BURST_PREFIX}dist/${member}.js`)) return true;
  return path.startsWith(SCENE_XMLDOM_PREFIX) || path.startsWith(SCENE_TOML_PREFIX);
}

/** @param {string} path @param {Buffer} bytes @returns {void} */
function assertSafeSceneSourceMember(path,bytes) {
  if(/\.(?:c?js|mjs)$/u.test(path) && FORBIDDEN_SCENE_FACILITY_PATTERN.test(bytes.toString("utf8"))) {
    throw new Error(`Scene closure contains unsupported execution facility in ${path}`);
  }
}

/** @param {string} left @param {string} right @returns {number} */
function codeUnitCompare(left,right) {
  const limit=Math.min(left.length,right.length);
  for(let index=0;index<limit;index+=1) {
    const difference=left.charCodeAt(index)-right.charCodeAt(index);
    if(difference!==0) return difference;
  }
  return left.length-right.length;
}

/** @param {SceneFile[]} files @returns {SceneFile[]} */
function canonicalSceneFiles(files) {
  return [...files].sort((left,right)=>codeUnitCompare(left.path,right.path));
}

/**
 * @template {string} K
 * @param {unknown} value
 * @param {readonly K[]} keys
 * @returns {value is Record<K, unknown>}
 */
function hasExactKeys(value,keys) {
  return value!==null && typeof value==="object" && !Array.isArray(value)
    && Object.keys(value).length===keys.length && keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}

/** @param {unknown} value @returns {value is number} */
function isPositiveInteger(value) {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

/** @param {SceneBindingInput} binding @param {SceneBindingValidationOptions} [options] @returns {SceneBindingInput} */
export function validateStructuredSceneBinding(binding,{sourceCandidate}={}) {
  if(!hasExactKeys(binding,["schema","engineSchema","capability","compatibility","compilerLevel","metadataVersion","sha256","bytes","sourceTreeDigest","sourceIdentity","runtime","node","adapterSha256","files","inventory","fileCount"])) {
    throw new Error("Scene structured-source binding contains unexpected fields");
  }
  if(typeof binding?.sourceIdentity!=="string" || !/^[a-f0-9]{64}$/.test(binding.sourceIdentity)
    || binding.sourceTreeDigest!==binding.sourceIdentity) {
    throw new Error("Scene structured-source binding source identity is invalid");
  }
  if(sourceCandidate!==undefined && binding.sourceIdentity!==sourceCandidate) {
    throw new Error("Scene structured-source binding source candidate mismatch");
  }
  if(binding.schema!=="tfsb.nebular-scene-binding-v1" || binding.engineSchema!=="tfsb.vector-scene-v1"
    || binding.capability!=="0.5-development" || typeof binding.metadataVersion!=="string" || binding.metadataVersion.length===0
    || binding.compatibility!==1 || binding.compilerLevel!==1
    || typeof binding.adapterSha256!=="string" || !/^[a-f0-9]{64}$/.test(binding.adapterSha256)) {
    throw new Error("Scene structured-source binding schema or capability is invalid");
  }
  if(binding.adapterSha256!==sceneBinding.adapterSha256) {
    throw new Error("Scene structured-source binding adapter authority is invalid");
  }
  if(!Array.isArray(binding.files) || !Array.isArray(binding.inventory)
    || binding.fileCount!==binding.files.length || binding.inventory.length!==binding.files.length
    || binding.files.length===0) {
    throw new Error("Scene structured-source binding inventory is inconsistent");
  }
  const canonical=canonicalSceneFiles(binding.files);
  if(JSON.stringify(canonical)!==JSON.stringify(binding.files)) {
    throw new Error("Scene structured-source binding inventory is not in canonical order");
  }
  const seen=new Set();
  for(const [index,file] of binding.files.entries()) {
    if(!hasExactKeys(file,["path","bytes","sha256"]) || !isAllowedStructuredScenePath(file?.path) || seen.has(file.path)
      || !Number.isInteger(file.bytes) || file.bytes<0
      || typeof file.sha256!=="string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("Scene structured-source binding inventory is inconsistent");
    }
    seen.add(file.path);
    const inventoryFile=binding.inventory[index];
    if(!inventoryFile || !hasExactKeys(inventoryFile,["path","bytes","sha256"])
      || file.path!==inventoryFile.path || file.bytes!==inventoryFile.bytes || file.sha256!==inventoryFile.sha256) {
      throw new Error("Scene structured-source binding inventory is inconsistent");
    }
  }
  const inventoryBytes=binding.files.reduce((sum,file)=>sum+file.bytes,0);
  const inventoryDigest=digest(binding.files.map(file=>`${file.path}:${file.sha256}`).join("\n"));
  if(binding.bytes!==inventoryBytes || binding.sha256!==inventoryDigest) {
    throw new Error("Scene structured-source binding digest is inconsistent");
  }
  if(!hasExactKeys(binding.runtime,["version","target","sha256","bytes"]) || !hasExactKeys(binding.node,["version","target","sha256","bytes"])
    || typeof binding.runtime.version!=="string" || typeof binding.runtime.target!=="string"
    || typeof binding.runtime.sha256!=="string" || !/^[a-f0-9]{64}$/.test(binding.runtime.sha256)
    || !isPositiveInteger(binding.runtime.bytes)
    || typeof binding.node.version!=="string" || typeof binding.node.target!=="string"
    || typeof binding.node.sha256!=="string" || !/^[a-f0-9]{64}$/.test(binding.node.sha256)
    || !isPositiveInteger(binding.node.bytes)
    || binding.runtime.version!==binding.node.version || binding.runtime.target!==binding.node.target
    || binding.runtime.sha256!==binding.node.sha256 || binding.runtime.bytes!==binding.node.bytes) {
    throw new Error("Scene structured-source runtime receipt is inconsistent");
  }
  const nodeAuthority=NODE_RELEASE_IDENTITY.targets[binding.node.target];
  if(!nodeAuthority || binding.node.version!==NODE_RELEASE_IDENTITY.version
    || binding.node.sha256!==nodeAuthority.executableSha256 || binding.node.bytes!==nodeAuthority.executableSize) {
    throw new Error("Scene structured-source runtime receipt does not match the maintained Node authority");
  }
  const required=new Map(binding.files.map(file=>[file.path,file]));
  const requiredPaths=["package.json","scene-input.json","bin/scene-batch.js",
    `${SCENE_BURST_PREFIX}package.json`,
    ...SCENE_MEMBERS.map(member=>`${SCENE_BURST_PREFIX}dist/${member}.js`),
    `${SCENE_XMLDOM_PREFIX}package.json`, `${SCENE_TOML_PREFIX}package.json`];
  if(requiredPaths.some(path=>!required.has(path))) {
    throw new Error("Scene structured-source binding is missing mandatory closure members");
  }
  const packageFile=required.get("package.json");
  const inputFile=required.get("scene-input.json");
  const adapterFile=required.get("bin/scene-batch.js");
  if(!packageFile || packageFile.bytes!==Buffer.byteLength(SCENE_ROOT_PACKAGE_TEXT)
    || packageFile.sha256!==digest(Buffer.from(SCENE_ROOT_PACKAGE_TEXT))
    || !inputFile || !adapterFile || adapterFile.sha256!==binding.adapterSha256) {
    throw new Error("Scene structured-source binding generated members are invalid");
  }
  return binding;
}

/** @param {string} path @param {number} limit @returns {Promise<Buffer>} */
async function readRegular(path,limit) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error("Invalid scene payload member");
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > limit) throw new Error("Invalid scene payload member");
    const bytes = await handle.readFile();
    if (bytes.length !== st.size) throw new Error("Scene payload member changed");
    return bytes;
  } finally {
    await handle.close();
  }
}

const PACKAGE_METADATA_LIMIT = 1024 * 1024;

// Package metadata is decided by the descriptor that is read: absence is the open result itself,
// and the captured bytes are the only bytes parsed. Non-regular, linked and unreadable entries refuse.
/** @param {string} path @returns {Promise<Buffer | null>} */
async function readPackageMetadata(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new Error("Package metadata is unreadable");
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > PACKAGE_METADATA_LIMIT) throw new Error("Package metadata is not a bounded regular file");
    const initialSize = st.size;
    const bytes = Buffer.allocUnsafe(initialSize + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count !== initialSize) throw new Error("Package metadata changed");
    return bytes.subarray(0, initialSize);
  } finally {
    await handle.close();
  }
}

// Target of a Node executable from its own header (no execution).
/** @param {Buffer} bytes @returns {string} */
function runtimeTriple(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c) return "aarch64-apple-darwin";
  if (bytes.length >= 20 && bytes.readUInt32BE(0) === 0x7f454c46 && bytes[4] === 2) {
    const machine = bytes.readUInt16LE(18);
    if (machine === 183) return "aarch64-unknown-linux-gnu";
    if (machine === 62) return "x86_64-unknown-linux-gnu";
  }
  throw new Error("Scene Node runtime target is unsupported");
}

// The scene payload is platform-independent JavaScript run by the authenticated embedded Node of the
// build target. The binding pins that runtime for its own target; every other target runs the same Node
// release, whose executable identity comes from the maintained runtime authority. A binding that
// disagrees with the authority for its own target fails.
/** @param {Buffer} runtime @param {SceneBindingInput} [binding] @returns {{ target: string, sha256: string, bytes: number }} */
export function sceneRuntimeIdentity(runtime, binding = sceneBinding) {
  const target = runtimeTriple(runtime);
  const authority = NODE_RELEASE_IDENTITY.targets[target];
  if (!authority || binding.node?.version !== NODE_RELEASE_IDENTITY.version) throw new Error("Scene Node identity mismatch");
  if (typeof binding.sourceIdentity === "string" && binding.node?.target !== target) {
    throw new Error("Scene structured-source runtime target does not match the authenticated Node");
  }
  if (binding.node.target === target) {
    if (binding.node.sha256 !== authority.executableSha256 || binding.node.bytes !== authority.executableSize) throw new Error("Scene binding disagrees with the Node runtime authority");
    return { target, sha256: binding.node.sha256, bytes: binding.node.bytes };
  }
  return { target, sha256: authority.executableSha256, bytes: authority.executableSize };
}

/** @param {string} payload @param {string} node @param {SceneBindingInput} [binding] @returns {Promise<{ schema: string, inputSha256: string | undefined, adapterSha256: string | undefined, nodeSha256: string, nodeTarget: string, files: number, capability: string }>} */
export async function verifyScenePayload(payload,node,binding=sceneBinding) {
  if(binding.capability!=="0.5-development") throw new Error("Scene binding capability must be 0.5-development");
  if(binding.engineSchema!=="tfsb.vector-scene-v1") throw new Error("Scene binding must be SVG-only vector scene");
  const isStructuredSource = Array.isArray(binding.inventory) || typeof binding.sourceIdentity === "string";
  if (isStructuredSource) {
    validateStructuredSceneBinding(binding);
  }
  const runtime=await readRegular(node,128*1024*1024);
  const expected=sceneRuntimeIdentity(runtime,binding);
  if(runtime.length!==expected.bytes||digest(runtime)!==expected.sha256) throw new Error("Scene Node identity mismatch");
  /** @type {string[]} */
  const names=[];
  /** @param {string} dir @param {string} [prefix] @returns {Promise<void>} */
  async function visit(dir,prefix="") {
    for(const e of await readdir(dir,{withFileTypes:true})) {
      if(e.isDirectory()) await visit(join(dir,e.name),prefix+e.name+"/");
      else if(e.isFile()) names.push(prefix+e.name);
      else throw new Error("Scene payload contains link or special member");
    }
  }
  await visit(payload);
  if(!binding.files || JSON.stringify(names.sort(codeUnitCompare))!==JSON.stringify(binding.files.map(f=>f.path).sort(codeUnitCompare))) throw new Error("Scene payload inventory mismatch");
  for(const file of binding.files) {
    const bytes=await readRegular(join(payload,file.path),8*1024*1024);
    if(bytes.length!==file.bytes||digest(bytes)!==file.sha256) throw new Error("Scene payload digest mismatch");
    if(isStructuredSource) assertSafeSceneSourceMember(file.path,bytes);
  }
  if (isStructuredSource) {
    const adapter=await readRegular(join(payload,"bin/scene-batch.js"),64*1024);
    const maintainedAdapter=await readRegular(join(studio,"tools/scene-batch.js"),64*1024);
    if(digest(adapter)!==binding.adapterSha256 || digest(maintainedAdapter)!==binding.adapterSha256
      || !adapter.equals(maintainedAdapter)) {
      throw new Error("Scene structured-source adapter identity mismatch");
    }
    const packageBytes=await readRegular(join(payload,"package.json"),64*1024);
    if(!packageBytes.equals(Buffer.from(SCENE_ROOT_PACKAGE_TEXT))) {
      throw new Error("Scene structured-source root package identity mismatch");
    }
    let provenance;
    try { provenance=JSON.parse((await readRegular(join(payload,"scene-input.json"),64*1024)).toString("utf8")); }
    catch { throw new Error("Scene structured-source scene-input provenance is malformed"); }
    if(provenance?.schema!=="tfsb.scene-input-v1"
      || provenance.sourceIdentity!==binding.sourceIdentity
      || provenance.sourceTreeDigest!==binding.sourceTreeDigest
      || provenance.developmentCapability!==binding.capability
      || provenance.metadataVersion!==binding.metadataVersion) {
      throw new Error("Scene structured-source scene-input provenance is inconsistent");
    }
  }
  return {schema:"tfsb.scene-payload-receipt-v1",inputSha256:binding.sha256,adapterSha256:binding.adapterSha256,nodeSha256:expected.sha256,nodeTarget:expected.target,files:names.length,capability:binding.capability};
}

/** @param {ScenePayloadOptions} options @returns {Promise<{ schema: string, inputSha256: string | undefined, adapterSha256: string | undefined, nodeSha256: string, nodeTarget: string, files: number, capability: string }>} */
export async function prepareScenePayload({archive,node,destination=join(studio,"src-tauri/scene-payload"),binding=sceneBinding,expectedSha256}) {
  const bytes=await readRegular(archive,2*1024*1024);
  const actualSha256=digest(bytes);
  if(expectedSha256&&actualSha256!==expectedSha256) throw new Error("Scene archive digest mismatch");
  if(bytes.length!==binding.bytes||actualSha256!==binding.sha256) throw new Error("Scene archive identity mismatch");
  const adapter=await readRegular(join(studio,"tools/scene-batch.js"),64*1024);
  if(digest(adapter)!==binding.adapterSha256) throw new Error("Scene adapter identity mismatch");
  const runtime=await readRegular(node,128*1024*1024);
  const expectedRuntime=sceneRuntimeIdentity(runtime,binding);
  if(runtime.length!==expectedRuntime.bytes||digest(runtime)!==expectedRuntime.sha256) throw new Error("Scene Node identity mismatch");
  // Existing payloads must already authenticate. Preparation never refreshes pins
  // or silently replaces an unexpected generated tree.
  try { await lstat(destination); return await verifyScenePayload(destination,node,binding); }
  catch(error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if(code!=="ENOENT") throw error;
  }
  await mkdir(destination,{recursive:false});
  execFileSync("python3",["-c",String.raw`
import io,pathlib,sys,tarfile
r=pathlib.Path(sys.argv[1])
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as t:
 members=t.getmembers();seen=set();total=0
 for m in members:
  parts=m.name.split('/')
  if m.name.startswith('/') or '\\' in m.name or any(p in ('','.','..') for p in parts) or not m.isfile() or m.name.casefold() in seen: raise ValueError('invalid scene archive')
  seen.add(m.name.casefold());total+=m.size
  if len(seen)>256 or total>8*1024*1024: raise ValueError('scene archive ceiling')
 for m in members:
  p=r.joinpath(*m.name.split('/'));p.parent.mkdir(parents=True,exist_ok=True)
  with t.extractfile(m) as s,p.open('xb') as d:d.write(s.read())
`,destination],{input:bytes,stdio:["pipe","pipe","pipe"],timeout:10_000});
  await mkdir(join(destination,"bin"));
  await copyFile(join(studio,"tools/scene-batch.js"),join(destination,"bin/scene-batch.js"));
  await writeFile(join(destination,"package.json"),'{"private":true,"type":"module"}\n',{flag:"wx"});
  return verifyScenePayload(destination,node,binding);
}

/** @param {SceneFromSourceOptions} options @returns {Promise<SceneBinding>} */
export async function prepareSceneFromSource({
  studioRoot,
  burstRoot,
  node,
  destination,
  sourceIdentity,
  xmldomRoot,
  tomlRoot,
}) {
  const currentStudio = studioRoot ? resolve(studioRoot) : studio;
  if (!burstRoot) {
    throw new Error("[SCENE_PREPARE_FAIL] Missing required burstRoot for source-built Scene preparation");
  }
  if (typeof sourceIdentity !== "string" || !/^[a-f0-9]{64}$/.test(sourceIdentity)) {
    throw new Error("[SCENE_PREPARE_FAIL] Explicit source inventory identity required");
  }
  let effectiveBurstRoot = resolve(burstRoot);
  const nestedBurst = resolve(effectiveBurstRoot, "lib/node_modules/@knowledge-forge-ai/theme-forge-stellar-burst");
  let pkgPath = resolve(nestedBurst, "package.json");
  let burstPkgBytes;
  try { burstPkgBytes = await readPackageMetadata(pkgPath); }
  catch { throw new Error(`[SCENE_PREPARE_FAIL] Malformed package.json in Burst root: ${pkgPath}`); }
  if (burstPkgBytes) {
    effectiveBurstRoot = nestedBurst;
  } else {
    pkgPath = resolve(effectiveBurstRoot, "package.json");
    try { burstPkgBytes = await readPackageMetadata(pkgPath); }
    catch { throw new Error(`[SCENE_PREPARE_FAIL] Malformed package.json in Burst root: ${pkgPath}`); }
    if (!burstPkgBytes) {
      throw new Error(`[SCENE_PREPARE_FAIL] Missing package.json in Burst root: ${effectiveBurstRoot}`);
    }
  }
  let burstPkg;
  try {
    burstPkg = JSON.parse(burstPkgBytes.toString("utf8"));
  } catch (err) {
    throw new Error(`[SCENE_PREPARE_FAIL] Malformed package.json in Burst root: ${pkgPath}`);
  }
  if (burstPkg.name !== "@knowledge-forge-ai/theme-forge-stellar-burst"
    || typeof burstPkg.version !== "string" || burstPkg.version.length === 0) {
    throw new Error(`[SCENE_PREPARE_FAIL] Burst package name or version is invalid: expected '@knowledge-forge-ai/theme-forge-stellar-burst' with a non-empty version, got '${burstPkg.name}'/'${burstPkg.version}'`);
  }

  // Validate Node runtime binary
  if (!node) {
    throw new Error("[SCENE_PREPARE_FAIL] Missing required node runtime binary path");
  }
  const nodePath = resolve(node);
  if (!existsSync(nodePath)) {
    throw new Error(`[SCENE_PREPARE_FAIL] Explicit Node runtime binary does not exist: ${basename(nodePath)}`);
  }
  const runtimeBytes = await readRegular(nodePath, 128 * 1024 * 1024);
  const nodeSha256 = digest(runtimeBytes);
  const nodeTarget = runtimeTriple(runtimeBytes);
  const nodeAuthority = NODE_RELEASE_IDENTITY.targets[nodeTarget];
  if (!nodeAuthority || nodeSha256 !== nodeAuthority.executableSha256 || runtimeBytes.length !== nodeAuthority.executableSize) {
    throw new Error("[SCENE_PREPARE_FAIL] Node runtime does not match maintained Scene runtime authority");
  }

  // Validate all SCENE_MEMBERS exist in compiled burst
  for (const member of SCENE_MEMBERS) {
    const memberPath = resolve(effectiveBurstRoot, `dist/${member}.js`);
    if (!existsSync(memberPath)) {
      throw new Error(`[SCENE_PREPARE_FAIL] Burst dist missing required scene member: dist/${member}.js`);
    }
  }

  // Find and validate dependency roots (@xmldom/xmldom and smol-toml)
  /** @param {(string | undefined)[]} candidates @param {string} expectedName @returns {Promise<{ root: string, packageJsonBytes: Buffer } | null>} */
  const findDep = async (candidates, expectedName) => {
    for (const c of candidates) {
      if (!c) continue;
      let bytes;
      try { bytes = await readPackageMetadata(resolve(c, "package.json")); } catch { continue; }
      if (!bytes) continue;
      try {
        const pkg = JSON.parse(bytes.toString("utf8"));
        if (pkg.name === expectedName) return { root: resolve(c), packageJsonBytes: bytes };
      } catch {}
    }
    return null;
  };

  const xmldomCandidates = [
    xmldomRoot,
    resolve(effectiveBurstRoot, "node_modules/@xmldom/xmldom"),
    resolve(burstRoot, "node_modules/@xmldom/xmldom"),
    resolve(burstRoot, "lib/node_modules/@xmldom/xmldom"),
  ];
  const xmldom = await findDep(xmldomCandidates, "@xmldom/xmldom");
  if (!xmldom) {
    throw new Error("[SCENE_PREPARE_FAIL] Missing required dependency root: @xmldom/xmldom");
  }
  const resolvedXmldom = xmldom.root;

  const tomlCandidates = [
    tomlRoot,
    resolve(effectiveBurstRoot, "node_modules/smol-toml"),
    resolve(burstRoot, "node_modules/smol-toml"),
    resolve(burstRoot, "lib/node_modules/smol-toml"),
  ];
  const toml = await findDep(tomlCandidates, "smol-toml");
  if (!toml) {
    throw new Error("[SCENE_PREPARE_FAIL] Missing required dependency root: smol-toml");
  }
  const resolvedToml = toml.root;

  // Validate adapter
  const adapterPath = join(currentStudio, "tools/scene-batch.js");
  if (!existsSync(adapterPath)) {
    throw new Error(`[SCENE_PREPARE_FAIL] Missing required scene adapter at ${adapterPath}`);
  }
  const adapterBytes = await readRegular(adapterPath, 64 * 1024);
  const maintainedAdapterBytes = await readRegular(join(studio, "tools/scene-batch.js"), 64 * 1024);
  if (!adapterBytes.equals(maintainedAdapterBytes)) {
    throw new Error("[SCENE_PREPARE_FAIL] Scene adapter does not match the maintained adapter authority");
  }
  const adapterSha256 = digest(maintainedAdapterBytes);

  // Setup destination
  const destDir = destination ? resolve(destination) : join(currentStudio, "src-tauri/scene-payload");
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true, mode: 0o755 });

  // 1. Adapter in bin
  await mkdir(join(destDir, "bin"), { recursive: true, mode: 0o755 });
  await copyFile(adapterPath, join(destDir, "bin/scene-batch.js"));

  // 2. Destination root package.json
  await writeFile(join(destDir, "package.json"), '{"private":true,"type":"module"}\n');

  // 3. Node modules for burst
  const targetBurstDir = join(destDir, "node_modules/@knowledge-forge-ai/theme-forge-stellar-burst");
  await mkdir(targetBurstDir, { recursive: true, mode: 0o755 });

  for (const doc of ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md"]) {
    const docSrc = resolve(effectiveBurstRoot, doc);
    if (existsSync(docSrc)) {
      await copyFile(docSrc, join(targetBurstDir, doc));
    }
  }

  await writeFile(
    join(targetBurstDir, "package.json"),
    JSON.stringify({
      name: burstPkg.name,
      version: burstPkg.version,
      type: "module",
      license: burstPkg.license || "AGPL-3.0-or-later",
      exports: {
        "./scene/v1": "./dist/scene/index.js",
      },
    }, null, 2) + "\n"
  );

  for (const member of SCENE_MEMBERS) {
    const src = resolve(effectiveBurstRoot, `dist/${member}.js`);
    const dest = join(targetBurstDir, `dist/${member}.js`);
    await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
    await copyFile(src, dest);
  }

  // 4. Node modules dependencies
  await cp(resolvedXmldom, join(destDir, "node_modules/@xmldom/xmldom"), { recursive: true });
  await cp(resolvedToml, join(destDir, "node_modules/smol-toml"), { recursive: true });

  // 5. Build scene-input.json provenance
  const sourceTreeDigest = sourceIdentity;

  const inputs = [
    { name: "core", version: burstPkg.version },
    { name: "xmldom", packageJsonSha256: digest(xmldom.packageJsonBytes) },
    { name: "toml", packageJsonSha256: digest(toml.packageJsonBytes) },
  ];

  const provenance = {
    schema: "tfsb.scene-input-v1",
    developmentCapability: "0.5-development",
    metadataVersion: burstPkg.version,
    sourceIdentity,
    sourceTreeDigest,
    inputs,
  };
  await writeFile(join(destDir, "scene-input.json"), JSON.stringify(provenance, null, 2) + "\n");

  // 6. Inventory and verify closure (no unsupported facilities)
  /** @type {SceneFile[]} */
  const files = [];
  /** @param {string} dir @param {string} [prefix] @returns {Promise<void>} */
  async function collectInventory(dir, prefix = "") {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectInventory(full, rel);
      } else if (entry.isFile()) {
        const fileBytes = await readFile(full);
        try { assertSafeSceneSourceMember(rel, fileBytes); }
        catch (error) { throw new Error(`[SCENE_PREPARE_FAIL] ${error instanceof Error ? error.message : String(error)}`); }
        files.push({
          path: rel,
          bytes: fileBytes.length,
          sha256: digest(fileBytes),
        });
      } else {
        throw new Error(`[SCENE_PREPARE_FAIL] Scene payload contains link or non-regular member: ${rel}`);
      }
    }
  }
  await collectInventory(destDir);
  files.sort((a, b) => codeUnitCompare(a.path, b.path));

  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  const inventoryDigest = digest(files.map(f => `${f.path}:${f.sha256}`).join("\n"));

  const actualBinding = {
    schema: "tfsb.nebular-scene-binding-v1",
    engineSchema: "tfsb.vector-scene-v1",
    capability: "0.5-development",
    compatibility: 1,
    compilerLevel: 1,
    metadataVersion: burstPkg.version,
    sha256: inventoryDigest,
    bytes: totalBytes,
    sourceTreeDigest,
    sourceIdentity,
    runtime: {
      version: NODE_RELEASE_IDENTITY.version,
      target: nodeTarget,
      sha256: nodeSha256,
      bytes: runtimeBytes.length,
    },
    node: {
      version: NODE_RELEASE_IDENTITY.version,
      target: nodeTarget,
      sha256: nodeSha256,
      bytes: runtimeBytes.length,
    },
    adapterSha256,
    files,
    inventory: files,
    fileCount: files.length,
  };

  validateStructuredSceneBinding(actualBinding, { sourceCandidate: sourceIdentity });
  return actualBinding;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const [mode,first,second,third,fourth]=process.argv.slice(2);
  if(mode==="verify"&&first&&second) console.log(JSON.stringify(await verifyScenePayload(resolve(first),resolve(second))));
  else if(mode==="prepare"&&first&&second) {
    /** @type {ScenePayloadOptions} */
    const options = { archive: resolve(first), node: resolve(second) };
    if(third!==undefined) options.expectedSha256=third;
    console.log(JSON.stringify(await prepareScenePayload(options)));
  }
  else if(mode==="prepare-from-source"&&first&&second) {
    /** @type {SceneFromSourceOptions} */
    const options = { burstRoot: resolve(first), node: resolve(second) };
    if(third!==undefined) options.destination=resolve(third);
    if(fourth!==undefined) options.sourceIdentity=fourth;
    console.log(JSON.stringify(await prepareSceneFromSource(options)));
  }
  else throw new Error("Expected prepare <authenticated-scene-archive> <authenticated-node> [expected-sha256], prepare-from-source <burstRoot> <node> [destination] [sourceIdentity], or verify <payload> <node>");
}
