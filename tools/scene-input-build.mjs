// Build-time only. Produces a separate, deterministic scene executable closure.
// All input archives are explicit; application startup never invokes this tool.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, cp, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCENE_MEMBERS = [
  "diagnostics", "digests", "primitives", "schema2-toml", "schema2-validation", "toml-writer",
  "scene/canonical", "scene/compile", "scene/constants", "scene/emit", "scene/geometry",
  "scene/glyphs/catalog", "scene/glyphs/labels", "scene/guard", "scene/import-svg-guard",
  "scene/import-svg", "scene/index", "scene/layout", "scene/path-canonical",
  "scene/transforms", "scene/validate",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function extract(archive, destination) {
  // Review all archive members before extracting any; no links or special files.
  execFileSync("python3", ["-c", String.raw`
import pathlib,sys,tarfile
p=pathlib.Path(sys.argv[2]);p.mkdir(parents=True,exist_ok=False)
with tarfile.open(sys.argv[1],'r:gz') as t:
 members=t.getmembers();seen=set();total=0
 for m in members:
  parts=m.name.split('/')
  if parts[0]!='package' or any(x in ('','.','..') for x in parts) or '\\' in m.name or not m.isfile(): raise ValueError('invalid package archive')
  key=m.name.casefold()
  if key in seen: raise ValueError('duplicate package member')
  seen.add(key);total+=m.size
  if total>32*1024*1024 or len(seen)>2000: raise ValueError('package archive exceeds limit')
 for m in members:
  target=p.joinpath(*m.name.split('/')[1:]);target.parent.mkdir(parents=True,exist_ok=True)
  with t.extractfile(m) as source,target.open('xb') as out: out.write(source.read())
`, archive, destination], { stdio: "pipe", timeout: 10_000 });
}

export async function buildSceneInput({ core, xmldom, toml, output, work, sourceTreeDigest }) {
  if (!/^[a-f0-9]{64}$/.test(sourceTreeDigest)) throw new Error("Explicit scene source inventory digest required");
  await mkdir(work, { recursive: false });
  const archives = [[core,"core"],[xmldom,"xmldom"],[toml,"toml"]];
  const inputs = [];
  for (const [path,name] of archives) {
    const bytes = await readFile(path);
    if (bytes.length > 16 * 1024 * 1024) throw new Error("Input archive exceeds limit");
    inputs.push({ name, sha256:hash(bytes), bytes:bytes.length });
    await extract(path, join(work,name));
  }
  const corePackage = JSON.parse(await readFile(join(work,"core/package.json"),"utf8"));
  if (corePackage.name !== "@knowledge-forge-ai/theme-forge-stellar-burst" || corePackage.version !== "0.4.0"
      || corePackage.exports?.["./scene/v1"]?.import !== "./dist/scene/index.js") throw new Error("Scene package identity mismatch");
  const tree = join(work,"tree");
  const target = join(tree,"node_modules/@knowledge-forge-ai/theme-forge-stellar-burst");
  await mkdir(target,{recursive:true});
  for (const member of SCENE_MEMBERS) {
    const dest = join(target,`dist/${member}.js`);
    await mkdir(resolve(dest,".."),{recursive:true});
    await cp(join(work,`core/dist/${member}.js`),dest,{errorOnExist:true,force:false});
  }
  for (const name of ["LICENSE","NOTICE","COMMERCIAL-LICENSE.md"]) await cp(join(work,"core",name),join(target,name));
  await writeFile(join(target,"package.json"),JSON.stringify({name:corePackage.name,version:corePackage.version,type:"module",license:corePackage.license,exports:{"./scene/v1":"./dist/scene/index.js"}})+"\n");
  for (const [name,packageName,version] of [["xmldom","@xmldom/xmldom","0.9.12"],["toml","smol-toml","1.8.0"]]) {
    const pkg=JSON.parse(await readFile(join(work,name,"package.json"),"utf8"));
    if(pkg.name!==packageName||pkg.version!==version) throw new Error("Dependency identity mismatch");
    await cp(join(work,name),join(tree,"node_modules",packageName),{recursive:true,errorOnExist:true,force:false});
  }
  const executableFiles=[];
  async function inspect(dir,prefix="") {
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const relative=prefix+entry.name, path=join(dir,entry.name);
      if(entry.isDirectory()) await inspect(path,relative+"/");
      else if(entry.isFile() && /\.(?:c?js|mjs)$/.test(entry.name)) {
        const bytes=await readFile(path), text=bytes.toString("utf8");
        if(/child_process|worker_threads|node:vm|process\s*\.\s*(?:dlopen|binding)|\bimport\s*\(|\beval\s*\(|\bnew\s+Function\b|resvg|\.node["']/.test(text)) throw new Error("Scene closure contains unsupported execution facility");
        executableFiles.push({path:relative,sha256:hash(bytes),bytes:bytes.length});
      } else if(!entry.isFile()) throw new Error("Scene input contains nonregular member");
    }
  }
  await inspect(tree);
  executableFiles.sort((a,b)=>a.path<b.path?-1:1);
  const provenance={schema:"tfsb.scene-input-v1",developmentCapability:"0.5-development",metadataVersion:"0.4.0",sourceTreeDigest,inputs,executableFiles};
  await writeFile(join(tree,"scene-input.json"),JSON.stringify(provenance,null,2)+"\n");
  execFileSync("python3",["-c",String.raw`
import gzip,pathlib,sys,tarfile
r=pathlib.Path(sys.argv[1])
with open(sys.argv[2],'xb') as raw,gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=1704067200) as gz,tarfile.open(fileobj=gz,mode='w',format=tarfile.PAX_FORMAT) as t:
 for p in sorted(x for x in r.rglob('*') if x.is_file()):
  i=tarfile.TarInfo(p.relative_to(r).as_posix());i.size=p.stat().st_size;i.mode=0o644;i.mtime=1704067200
  with p.open('rb') as f:t.addfile(i,f)
`,tree,output],{stdio:"pipe",timeout:10_000});
  const bytes=await readFile(output);
  return {sha256:hash(bytes),bytes:bytes.length,sourceTreeDigest,executableFiles:executableFiles.length};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const values=process.argv.slice(2);
  if(values.length!==7) throw new Error("Expected core archive, xmldom archive, toml archive, output archive, fresh work directory, source digest, receipt");
  const [core,xmldom,toml,output,work,sourceTreeDigest,receipt]=values;
  const result=await buildSceneInput({core,xmldom,toml,output,work,sourceTreeDigest});
  await writeFile(receipt,JSON.stringify(result,null,2)+"\n",{flag:"wx"});
  console.log(JSON.stringify(result));
}
