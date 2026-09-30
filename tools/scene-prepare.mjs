import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, lstat, readdir, copyFile, open, cp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE_MEMBERS } from "./scene-input-build.mjs";
import { NODE_RELEASE_IDENTITY } from "./node-runtime-authority.mjs";

const studio=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
export const sceneBinding=JSON.parse(await readFile(join(studio,"protocol/scene-workbench-v1/payload-binding.json"),"utf8"));

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

// Target of a Node executable from its own header (no execution).
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
export function sceneRuntimeIdentity(runtime, binding = sceneBinding) {
  const target = runtimeTriple(runtime);
  const authority = NODE_RELEASE_IDENTITY.targets[target];
  if (!authority || binding.node?.version !== NODE_RELEASE_IDENTITY.version) throw new Error("Scene Node identity mismatch");
  if (binding.node.target === target) {
    if (binding.node.sha256 !== authority.executableSha256 || binding.node.bytes !== authority.executableSize) throw new Error("Scene binding disagrees with the Node runtime authority");
    return { target, sha256: binding.node.sha256, bytes: binding.node.bytes };
  }
  return { target, sha256: authority.executableSha256, bytes: authority.executableSize };
}

export async function verifyScenePayload(payload,node,binding=sceneBinding) {
  if(binding.capability!=="0.5-development") throw new Error("Scene binding capability must be 0.5-development");
  if(binding.engineSchema!=="tfsb.vector-scene-v1") throw new Error("Scene binding must be SVG-only vector scene");
  const runtime=await readRegular(node,128*1024*1024);
  const expected=sceneRuntimeIdentity(runtime,binding);
  if(runtime.length!==expected.bytes||digest(runtime)!==expected.sha256) throw new Error("Scene Node identity mismatch");
  const names=[];
  async function visit(dir,prefix="") {
    for(const e of await readdir(dir,{withFileTypes:true})) {
      if(e.isDirectory()) await visit(join(dir,e.name),prefix+e.name+"/");
      else if(e.isFile()) names.push(prefix+e.name);
      else throw new Error("Scene payload contains link or special member");
    }
  }
  await visit(payload);
  if(JSON.stringify(names.sort())!==JSON.stringify(binding.files.map(f=>f.path).sort())) throw new Error("Scene payload inventory mismatch");
  for(const file of binding.files) {
    const bytes=await readRegular(join(payload,file.path),8*1024*1024);
    if(bytes.length!==file.bytes||digest(bytes)!==file.sha256) throw new Error("Scene payload digest mismatch");
  }
  return {schema:"tfsb.scene-payload-receipt-v1",inputSha256:binding.sha256,adapterSha256:binding.adapterSha256,nodeSha256:expected.sha256,nodeTarget:expected.target,files:names.length,capability:binding.capability};
}

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
  catch(error) { if(error.code!=="ENOENT") throw error; }
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
  if (existsSync(resolve(nestedBurst, "package.json"))) {
    effectiveBurstRoot = nestedBurst;
  }
  const pkgPath = resolve(effectiveBurstRoot, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`[SCENE_PREPARE_FAIL] Missing package.json in Burst root: ${effectiveBurstRoot}`);
  }
  let burstPkg;
  try {
    burstPkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch (err) {
    throw new Error(`[SCENE_PREPARE_FAIL] Malformed package.json in Burst root: ${pkgPath}`);
  }
  if (burstPkg.name !== "@knowledge-forge-ai/theme-forge-stellar-burst") {
    throw new Error(`[SCENE_PREPARE_FAIL] Burst package name mismatch: expected '@knowledge-forge-ai/theme-forge-stellar-burst', got '${burstPkg.name}'`);
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

  // Validate all SCENE_MEMBERS exist in compiled burst
  for (const member of SCENE_MEMBERS) {
    const memberPath = resolve(effectiveBurstRoot, `dist/${member}.js`);
    if (!existsSync(memberPath)) {
      throw new Error(`[SCENE_PREPARE_FAIL] Burst dist missing required scene member: dist/${member}.js`);
    }
  }

  // Find and validate dependency roots (@xmldom/xmldom and smol-toml)
  const findDep = (candidates, expectedName) => {
    for (const c of candidates) {
      if (c && existsSync(resolve(c, "package.json"))) {
        try {
          const pkg = JSON.parse(readFileSync(resolve(c, "package.json"), "utf8"));
          if (pkg.name === expectedName) return resolve(c);
        } catch {}
      }
    }
    return null;
  };

  const xmldomCandidates = [
    xmldomRoot,
    resolve(effectiveBurstRoot, "node_modules/@xmldom/xmldom"),
    resolve(burstRoot, "node_modules/@xmldom/xmldom"),
    resolve(burstRoot, "lib/node_modules/@xmldom/xmldom"),
  ];
  const resolvedXmldom = findDep(xmldomCandidates, "@xmldom/xmldom");
  if (!resolvedXmldom) {
    throw new Error("[SCENE_PREPARE_FAIL] Missing required dependency root: @xmldom/xmldom");
  }

  const tomlCandidates = [
    tomlRoot,
    resolve(effectiveBurstRoot, "node_modules/smol-toml"),
    resolve(burstRoot, "node_modules/smol-toml"),
    resolve(burstRoot, "lib/node_modules/smol-toml"),
  ];
  const resolvedToml = findDep(tomlCandidates, "smol-toml");
  if (!resolvedToml) {
    throw new Error("[SCENE_PREPARE_FAIL] Missing required dependency root: smol-toml");
  }

  // Validate adapter
  const adapterPath = join(currentStudio, "tools/scene-batch.js");
  if (!existsSync(adapterPath)) {
    throw new Error(`[SCENE_PREPARE_FAIL] Missing required scene adapter at ${adapterPath}`);
  }
  const adapterBytes = await readRegular(adapterPath, 64 * 1024);
  const adapterSha256 = digest(adapterBytes);

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
    { name: "xmldom", packageJsonSha256: digest(await readFile(join(resolvedXmldom, "package.json"))) },
    { name: "toml", packageJsonSha256: digest(await readFile(join(resolvedToml, "package.json"))) },
  ];

  const provenance = {
    schema: "tfsb.scene-input-v1",
    developmentCapability: "0.5-development",
    metadataVersion: burstPkg.version || "0.5.0",
    sourceTreeDigest,
    inputs,
  };
  await writeFile(join(destDir, "scene-input.json"), JSON.stringify(provenance, null, 2) + "\n");

  // 6. Inventory and verify closure (no unsupported facilities)
  const files = [];
  async function collectInventory(dir, prefix = "") {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectInventory(full, rel);
      } else if (entry.isFile()) {
        const fileBytes = await readFile(full);
        if (/\.(?:c?js|mjs)$/.test(entry.name)) {
          const text = fileBytes.toString("utf8");
          if (/child_process|worker_threads|node:vm|process\s*\.\s*(?:dlopen|binding)|\bimport\s*\(|\beval\s*\(|\bnew\s+Function\b|resvg|\.node["']/.test(text)) {
            throw new Error(`[SCENE_PREPARE_FAIL] Scene closure contains unsupported execution facility in ${rel}`);
          }
        }
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
  files.sort((a, b) => a.path.localeCompare(b.path));

  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  const inventoryDigest = digest(files.map(f => `${f.path}:${f.sha256}`).join("\n"));

  const actualBinding = {
    schema: "tfsb.nebular-scene-binding-v1",
    engineSchema: "tfsb.vector-scene-v1",
    capability: "0.5-development",
    compatibility: 1,
    compilerLevel: 1,
    metadataVersion: burstPkg.version || "0.5.0",
    sha256: inventoryDigest,
    bytes: totalBytes,
    sourceTreeDigest,
    sourceIdentity,
    runtime: {
      sha256: nodeSha256,
      bytes: runtimeBytes.length,
    },
    node: {
      sha256: nodeSha256,
      bytes: runtimeBytes.length,
    },
    adapterSha256,
    files,
    inventory: files,
    fileCount: files.length,
  };

  return actualBinding;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const [mode,first,second,third,fourth]=process.argv.slice(2);
  if(mode==="verify"&&first&&second) console.log(JSON.stringify(await verifyScenePayload(resolve(first),resolve(second))));
  else if(mode==="prepare"&&first&&second) console.log(JSON.stringify(await prepareScenePayload({archive:resolve(first),node:resolve(second),expectedSha256:third})));
  else if(mode==="prepare-from-source"&&first&&second) console.log(JSON.stringify(await prepareSceneFromSource({burstRoot:resolve(first),node:resolve(second),destination:third?resolve(third):undefined,sourceIdentity:fourth})));
  else throw new Error("Expected prepare <authenticated-scene-archive> <authenticated-node> [expected-sha256], prepare-from-source <burstRoot> <node> [destination] [sourceIdentity], or verify <payload> <node>");
}
