import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, lstat, readdir, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const studio=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
export const sceneBinding=JSON.parse(await readFile(join(studio,"protocol/scene-workbench-v1/payload-binding.json"),"utf8"));

async function readRegular(path,limit) {
  const before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink()||before.size>limit) throw new Error("Invalid scene payload member");
  const bytes=await readFile(path),after=await lstat(path);
  if(before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs||bytes.length!==before.size) throw new Error("Scene payload member changed");
  return bytes;
}

export async function verifyScenePayload(payload,node,binding=sceneBinding) {
  if(binding.capability!=="0.5-development") throw new Error("Scene binding capability must be 0.5-development");
  if(binding.engineSchema!=="tfsb.vector-scene-v1") throw new Error("Scene binding must be SVG-only vector scene");
  const runtime=await readRegular(node,128*1024*1024);
  if(runtime.length!==binding.node.bytes||digest(runtime)!==binding.node.sha256) throw new Error("Scene Node identity mismatch");
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
  return {schema:"tfsb.scene-payload-receipt-v1",inputSha256:binding.sha256,adapterSha256:binding.adapterSha256,nodeSha256:binding.node.sha256,files:names.length,capability:binding.capability};
}

export async function prepareScenePayload({archive,node,destination=join(studio,"src-tauri/scene-payload"),binding=sceneBinding,expectedSha256}) {
  const bytes=await readRegular(archive,2*1024*1024);
  const actualSha256=digest(bytes);
  if(expectedSha256&&actualSha256!==expectedSha256) throw new Error("Scene archive digest mismatch");
  if(bytes.length!==binding.bytes||actualSha256!==binding.sha256) throw new Error("Scene archive identity mismatch");
  const adapter=await readRegular(join(studio,"tools/scene-batch.js"),64*1024);
  if(digest(adapter)!==binding.adapterSha256) throw new Error("Scene adapter identity mismatch");
  const runtime=await readRegular(node,128*1024*1024);
  if(digest(runtime)!==binding.node.sha256) throw new Error("Scene Node identity mismatch");
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

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const [mode,first,second,third]=process.argv.slice(2);
  if(mode==="verify"&&first&&second) console.log(JSON.stringify(await verifyScenePayload(resolve(first),resolve(second))));
  else if(mode==="prepare"&&first&&second) console.log(JSON.stringify(await prepareScenePayload({archive:resolve(first),node:resolve(second),expectedSha256:third})));
  else throw new Error("Expected prepare <authenticated-scene-archive> <authenticated-node> [expected-sha256] or verify <payload> <node>");
}
