import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { verifyScenePayload } from "./scene-prepare.mjs";

const studio=resolve(new URL("..",import.meta.url).pathname);
const payload=join(studio,"src-tauri/scene-payload");
const node=join(studio,"src-tauri/binaries/tfsb-studio-service-aarch64-apple-darwin");
const hash=s=>"sha256:"+createHash("sha256").update(s).digest("hex");
const scene={schema:"tfsb.vector-scene-v1",compatibility:1,compilerLevel:1,profile:"diagram",artboard:{width:400,height:200,viewBox:[0,0,400,200]},accessibility:{mode:"labelled",title:"Scene test"},elements:[{type:"rect",id:"box",x:12,y:12,width:100,height:70,rx:8,presentation:{fill:{type:"solid",color:"#5533cc"}}}]};
function invoke(request) {
  const result=spawnSync(node,["--permission","--allow-fs-read="+payload,join(payload,"bin/scene-batch.js")],{input:JSON.stringify(request),encoding:"utf8",timeout:12_000,maxBuffer:32*1024*1024,env:{LANG:"C",LC_ALL:"C"}});
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}
test("authenticated scene payload compiles installed scene API deterministically",async()=>{
  await verifyScenePayload(payload,node);
  const first=invoke({action:"compile",scene}),second=invoke({action:"compile",scene});
  assert.equal(first.valid,true);assert.deepEqual(first,second);
  assert.equal(first.receipt.sourceDigest,hash(first.canonicalJson));
  assert.equal(first.receipt.svgDigest,hash(first.svg));
  assert.equal(first.receipt.sceneSchema,"tfsb.vector-scene-v1");
});
test("safe import adopts canonical engine output and reports unsupported import",()=>{
  const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="20" height="20" fill="#112233"/></svg>';
  const good=invoke({action:"import_svg",svgText:svg});
  assert.equal(good.valid,true);assert.equal(good.classification,"SUPPORTED_IMPORT");
  assert.ok(good.canonicalJson);assert.ok(good.svg);
  const bad=invoke({action:"import_svg",svgText:svg.replace('<rect width="20" height="20" fill="#112233"/>','<image href="remote.png"/>')});
  assert.equal(bad.valid,false);assert.equal(bad.svg,undefined);assert.ok(bad.reasonCodes.includes("OUT_OF_SCOPE_IMAGE"));
});
test("adapter rejects generic operations and unknown request authority",()=>{
  assert.equal(invoke({action:"run",scene}).valid,false);
  assert.equal(invoke({action:"compile",scene,path:"not-authority"}).valid,false);
  assert.equal(invoke({action:"compile",scene:{...scene,script:"forbidden"}}).valid,false);
});
test("pinned Node permission model denies descendant spawning",()=>{
  const code='for(const n of ["child_process","worker_threads"]){try{if(n==="child_process")require(n).spawnSync(process.execPath,["-e",""]);else new(require(n).Worker)("",{eval:true});process.exitCode=1;}catch(e){if(e.code!=="ERR_ACCESS_DENIED")process.exitCode=2;}}';
  const result=spawnSync(node,["--permission","-e",code],{timeout:5000,encoding:"utf8",env:{LANG:"C"}});
  assert.equal(result.status,0);assert.equal(result.error,undefined);
});
test("payload verification rejects mutated, missing and unexpected files",async()=>{
  for(const mutation of ["changed","missing","extra"]){
    const root=await mkdtemp(join(tmpdir(),"scene-payload-test-"));
    const copy=join(root,"payload");
    try{
      await cp(payload,copy,{recursive:true});
      if(mutation==="changed")await writeFile(join(copy,"bin/scene-batch.js"),"changed");
      if(mutation==="missing")await rm(join(copy,"bin/scene-batch.js"));
      if(mutation==="extra")await writeFile(join(copy,"extra.js"),"");
      await assert.rejects(verifyScenePayload(copy,node));
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
