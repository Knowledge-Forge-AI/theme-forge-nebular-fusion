import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { HOST_INPUT_SCHEMA, createCargoConfig } from "./host-inputs.mjs";
import { CampaignError, hostPreparationFailureCode, hostPreparationBoundary, requirePhaseResult, formatCampaignFailure, runFixedCommand } from "./controller.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const candidate = join(root, "host-inputs.mjs");
const owned = [];
test.after(async () => { for (const path of owned) await rm(path, { recursive: true }); });

async function fixture() {
  const path = await mkdtemp(join(root, "env-fixture-")); owned.push(path);
  const tools = Object.fromEntries(["node", "npm", "rust", "cargo", "compiler", "linker", "pkgConfig", "systemLibraries"].map(k => [k, join(path, k)]));
  tools.rustTargetLibDir = join(path, "target-lib");
  const spec = {
    schema: HOST_INPUT_SCHEMA, mode: "actual",
    bundle: { archiveSha256: "a".repeat(64), manifestRelativePath: "bundle-manifest.json" },
    toolchains: tools, rustupRoot: join(path, "rustup"), rustupHome: join(path, "rustup"),
    observedToolchains: {node:"22.23.4",rustc:"1.98.0",cargo:"1.98.0",source:"fixed-workflow-observation"},
    cargoConfig: {content:createCargoConfig({linker:tools.linker,rustupRoot:join(path,"rustup"),rustTargetLibDir:tools.rustTargetLibDir})},
    environment: {SDKROOT:join(path,"sdk"),MACOSX_DEPLOYMENT_TARGET:"13.0"},
  };
  const specPath = join(path, "spec.json"); await writeFile(specPath, JSON.stringify(spec));
  const bridge = join(path, "bridge.mjs");
  await writeFile(bridge, 'export const maintained=Object.fromEntries(["createBuildInputs","validateBuildInputs","inventoryTree","identity","digest","verifySolarSailMaterialSourceAuthority","prepareSolarSailMaterialPayload","verifyPreparedSolarSailMaterialPayload","sourceBuildPathPolicy"].map(k=>[k,()=>{throw Error("fixture must stop before operations")} ])); export const ports={};\n');
  const env = {PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",GITHUB_ACTIONS:"true",RUNNER_OS:"macOS",RUNNER_ARCH:"ARM64",GITHUB_REPOSITORY:"Knowledge-Forge-AI/theme-forge-nebular-fusion",RUNNER_TEMP:path,GITHUB_WORKSPACE:path};
  return {path,specPath,bridge,env};
}

test("real CLI default environment reaches the inert port guard without preparing state",async()=>{
  const f=await fixture();
  for(const [file,wanted] of [[candidate,"HOST_INPUT_ARCHIVE_PORT"]]){
    const r=spawnSync(process.execPath,[file,"--spec",f.specPath,"--bridge",f.bridge,"--receipt",join(f.path,"receipt.json"),"--locator",join(f.path,"locator.json")],{env:f.env,encoding:"utf8",timeout:5000,maxBuffer:16384});
    assert.equal(r.status,1);assert.deepEqual(JSON.parse(r.stdout),{status:"refused",code:wanted});assert.equal(r.stderr,"");
  }
});

test("default direct API accepts the real Node environment but explicit exotic objects remain refused",async()=>{
  const f=await fixture();
  const probe=join(f.path,"probe.mjs");
  await writeFile(probe,`import {readFile} from "node:fs/promises"; import {pathToFileURL} from "node:url";
const mod=await import(pathToFileURL(process.argv[2]).href); const bridge=await import(pathToFileURL(process.argv[4]).href); const spec=JSON.parse(await readFile(process.argv[3],"utf8"));
const explicit=Object.create({inherited:true}); Object.assign(explicit,process.env);
const codes=[]; for(const extra of [{},{env:explicit},{env:{...process.env,GITHUB_REPOSITORY:"wrong/repository"}}]){try{await mod.prepareHostInputs(spec,{ports:bridge.ports,maintained:bridge.maintained,...extra});codes.push("unexpected-success")}catch(e){codes.push(e.code)}}
console.log(JSON.stringify({node:process.versions.node,plainEnvironmentPrototype:Object.getPrototypeOf(process.env)===Object.prototype,codes}));\n`);
  const r=spawnSync(process.execPath,[probe,candidate,f.specPath,f.bridge],{env:f.env,encoding:"utf8",timeout:5000,maxBuffer:16384});assert.equal(r.status,0);const record=JSON.parse(r.stdout);assert.equal(record.node,"22.23.4");assert.equal(typeof record.plainEnvironmentPrototype,"boolean");assert.deepEqual(record.codes,["HOST_INPUT_ARCHIVE_PORT","HOST_INPUT_RUNNER_GUARD","HOST_INPUT_RUNNER_GUARD"]);
  // The inert port guard runs before any preparation directory or external tool.
  for(const name of ["nebular-host-input-preparation","receipt.json","locator.json"]) await assert.rejects(lstat(join(f.path,name)),{code:"ENOENT"});
});


test("public refusal contract covers all frozen literal and dynamic names",async()=>{
 const source=await readFile(join(root,"host-inputs.mjs"),"utf8");const controller=await readFile(join(root,"controller.mjs"),"utf8");
 const reachable=new Set([...source.matchAll(/"(HOST_INPUT_[A-Z0-9_]+)"/g)].map(m=>m[1]));
 const keys=source.match(/const TOOLCHAIN_KEYS = Object\.freeze\(\[([\s\S]*?)\]\);/)[1];
 for(const match of keys.matchAll(/"([A-Za-z]+)"/g))reachable.add(`HOST_INPUT_TOOLCHAIN_${match[1].toUpperCase()}`);
 for(const match of source.matchAll(/runPhase\(ports, "([A-Z_]+)"/g))for(const suffix of ["COMMAND","TIMEOUT","OUTPUT_LIMIT","FAILED"])reachable.add(`HOST_INPUT_${match[1]}_${suffix}`);
 for(const match of source.matchAll(/requireFunction\(ports(?:\.[A-Za-z_][A-Za-z0-9_]*)+, "([A-Z_]+)"\)/g))reachable.add(`HOST_INPUT_API_${match[1]}`);
 const kinds=[...new Set([...source.matchAll(/`(HOST_INPUT_[^`]+)`/g)].map(m=>m[1]))].sort();
 assert.deepEqual(kinds,["HOST_INPUT_API_${name}","HOST_INPUT_TOOLCHAIN_${key.toUpperCase()}","HOST_INPUT_${phase}_COMMAND","HOST_INPUT_${phase}_FAILED","HOST_INPUT_${phase}_OUTPUT_LIMIT","HOST_INPUT_${phase}_TIMEOUT"].sort());
 const names=JSON.parse(controller.match(/const HOST_PREPARATION_REFUSALS = new Set\((\[[\s\S]*?\])\);/)[1]);assert.equal(reachable.size,74);assert.deepEqual([...reachable].sort(),names);
 for(const code of names){const exitCode=code==="HOST_INPUT_USAGE"?2:code==="HOST_INPUT_INTERNAL"?3:1;const result={exitCode,failure:null,cleanup:"leader-close-observed",json:{status:"refused",code}};assert.equal(hostPreparationFailureCode(result),`PREPARE_HOST_INPUTS_${code}`);assert.equal(hostPreparationFailureCode({...result,cleanup:"unconfirmed"}),"PREPARE_HOST_INPUTS_FAILED");}
 assert.equal(hostPreparationFailureCode({exitCode:1,failure:null,cleanup:"leader-close-observed",json:{status:"refused",code:"private unknown value"}}),"PREPARE_HOST_INPUTS_FAILED");
});

test("real subprocess parsing preserves clean success and classifies only the bounded refusal",async()=>{
 const options={program:process.execPath,cwd:root,env:{PATH:"/usr/bin:/bin"},capture:"json",phase:"prepare-host-inputs",timeoutMs:5000};
 const success=await runFixedCommand({...options,args:["-e",'console.log("fixture non-JSON success")']});assert.equal(success.exitCode,0);assert.equal(success.failure,null);
 const strict=await runFixedCommand({...options,phase:"bootstrap-extract",args:["-e",'console.log("fixture non-JSON success")']});assert.equal(strict.failure,"INVALID_RESULT");
 const usage=await runFixedCommand({...options,args:[candidate]});assert.equal(usage.exitCode,2);assert.equal(hostPreparationFailureCode(usage),"PREPARE_HOST_INPUTS_HOST_INPUT_USAGE");assert.equal(Object.hasOwn(usage,"text"),false);assert.equal(Object.hasOwn(usage,"stderr"),false);
});

test("closed process categories have explicit cleanup-first precedence",()=>{
 const base={failure:null,exitCode:1,signal:null,cleanup:"leader-close-observed"};
 const cases=[
  [null,"INCOHERENT_RESULT"],
  [{...base,cleanup:"unconfirmed",failure:"TIMEOUT"},"UNCONFIRMED_CLEANUP"],
  ...[["LIMIT","PORT_LIMIT"],["SPAWN","SPAWN_FAILURE"],["ERROR","CHILD_ERROR"],["TIMEOUT","TIMEOUT"],["OUTPUT_LIMIT","OUTPUT_LIMIT"],["INVALID_RESULT","INVALID_RESULT"]].map(([failure,label])=>[{...base,failure},label]),
  [{...base,failure:"untrusted-private-value"},"UNKNOWN_PROCESS_FAILURE"],
  [{...base,json:{status:"refused",code:"HOST_INPUT_USAGE"},exitCode:2},"ACCEPTED_INNER_REFUSAL"],
  [{...base,exitCode:0},"COMPLETED"],
  [{...base,exitCode:null,signal:"untrusted-signal-text"},"SIGNALED"],
  [{...base,exitCode:null,signal:"SIGTERM",failure:"INVALID_RESULT"},"SIGNALED"],
  [base,"UNACCEPTED_NONZERO"],
  [{...base,exitCode:null},"INCOHERENT_RESULT"],
 ];
 for(const [result,label] of cases){
  assert.equal(hostPreparationBoundary(result),label);
  if(label==="COMPLETED")assert.equal(requirePhaseResult(result,"prepare-host-inputs"),result);
  else assert.throws(()=>requirePhaseResult(result,"prepare-host-inputs"),error=>{
   assert.ok(error instanceof CampaignError);assert.equal(error.preparationBoundary,label);
   const prior=hostPreparationFailureCode(result);assert.equal(error.code,prior);
   assert.equal(formatCampaignFailure(error),`SOURCE_NATIVE_${prior}\nSOURCE_NATIVE_PREPARATION_BOUNDARY_${label}`);
   return true;
  });
 }
});

test("new category is prep-only and rejects untrusted annotation values",()=>{
 const result={failure:"TIMEOUT",exitCode:null,cleanup:"unconfirmed",stdout:"private text",stderr:"private text"};
 assert.throws(()=>requirePhaseResult(result,"bootstrap-extract"),error=>{
  assert.equal(Object.hasOwn(error,"preparationBoundary"),false);
  assert.equal(formatCampaignFailure(error),"SOURCE_NATIVE_BOOTSTRAP_EXTRACT_FAILED");return true;
 });
 const error=new CampaignError("PREPARE_HOST_INPUTS_FAILED");error.preparationBoundary="private text";
 assert.equal(formatCampaignFailure(error),"SOURCE_NATIVE_PREPARE_HOST_INPUTS_FAILED");
 assert.equal(formatCampaignFailure(new Error("private text")),"SOURCE_NATIVE_INTERNAL");
});

test("actual child boundary classifies clean success, refusal, malformed output and unknown code",async()=>{
 const options={program:process.execPath,cwd:root,env:{PATH:"/usr/bin:/bin"},capture:"json",phase:"prepare-host-inputs",timeoutMs:5000};
 const cases=[
  ["",0,"COMPLETED"],
  ['console.log("untrusted extra success text")',0,"COMPLETED"],
  ['console.log(JSON.stringify({status:"refused",code:"HOST_INPUT_USAGE"}));process.exitCode=2',2,"ACCEPTED_INNER_REFUSAL"],
  ['console.log("untrusted malformed text");process.exitCode=1',1,"INVALID_RESULT"],
  ['console.log(JSON.stringify({status:"refused",code:"untrusted unknown text"}));process.exitCode=1',1,"UNACCEPTED_NONZERO"],
 ];
 for(const [script,exit,label] of cases){
  const result=await runFixedCommand({...options,args:["-e",script]});
  assert.equal(result.exitCode,exit);assert.equal(hostPreparationBoundary(result),label);
  if(exit===0)assert.equal(requirePhaseResult(result,"prepare-host-inputs"),result);
  else assert.throws(()=>requirePhaseResult(result,"prepare-host-inputs"),error=>{
   const rendered=formatCampaignFailure(error);assert.ok(rendered.endsWith(label));assert.equal(rendered.includes("untrusted"),false);return true;
  });
 }
});

test("actual self-signal and missing executable remain failed without raw diagnostics",async()=>{
 const options={program:process.execPath,cwd:root,env:{PATH:"/usr/bin:/bin"},capture:"json",phase:"prepare-host-inputs",timeoutMs:5000};
 const signaled=await runFixedCommand({...options,args:["-e",'process.kill(process.pid,"SIGTERM")']});
 assert.equal(hostPreparationBoundary(signaled),"SIGNALED");
 const f=await fixture();
 const missing=await runFixedCommand({...options,program:join(f.path,"node-authenticated"),args:[]});
 assert.equal(missing.failure,"ERROR");assert.equal(missing.cleanup,"unconfirmed");
 assert.equal(hostPreparationBoundary(missing),"UNCONFIRMED_CLEANUP");
 for(const result of [signaled,missing])assert.throws(()=>requirePhaseResult(result,"prepare-host-inputs"),error=>{
  assert.equal(error.code,"PREPARE_HOST_INPUTS_FAILED");const rendered=formatCampaignFailure(error);assert.equal(rendered.includes(root),false);assert.equal(rendered.includes("ENOENT"),false);return true;
 });
});
