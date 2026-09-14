// Fixed Nebular scene adapter. This file is copied into the authenticated payload.
import { canonicalizeScene, compileScene, sceneImportSvg } from "@knowledge-forge-ai/theme-forge-stellar-burst/scene/v1";
const INPUT_LIMIT=16*1024*1024, SCENE_LIMIT=8*1024*1024, SVG_LIMIT=4*1024*1024;
const diagnostic=(code)=>({code,message:"Scene input did not satisfy the bounded engine contract.",severity:"error"});
const fail=(action,code)=>({status:"error",action,valid:false,diagnostics:[diagnostic(code)]});
const allowed=new Set(["compile","canonicalize","import_svg"]);

function compile(action,scene,importResult) {
  if(Buffer.byteLength(JSON.stringify(scene))>SCENE_LIMIT) return fail(action,"SCENE_INPUT_LIMIT");
  const canonical=canonicalizeScene(scene);
  if(!canonical.ok) return {status:"error",action,valid:false,diagnostics:canonical.diagnostics.slice(0,128).map(d=>diagnostic(d.code))};
  if(Buffer.byteLength(canonical.value)>SCENE_LIMIT) return fail(action,"SCENE_INPUT_LIMIT");
  const result=compileScene(JSON.parse(canonical.value));
  if(!result.ok) return {status:"error",action,valid:false,diagnostics:result.diagnostics.slice(0,128).map(d=>diagnostic(d.code))};
  if(Buffer.byteLength(result.value.svg)>SVG_LIMIT) return fail(action,"SCENE_PREVIEW_LIMIT");
  const {limits,...receipt}=result.value.receipt;
  return {status:"success",action,valid:true,canonicalJson:canonical.value,svg:result.value.svg,
    receipt,metrics:result.value.metrics,diagnostics:[],...(importResult?{classification:importResult.classification,reasonCodes:importResult.reasonCodes.slice(0,128),normalizations:importResult.normalizations.slice(0,128),importedScene:JSON.parse(canonical.value)}:{})};
}

export function dispatchScene(request) {
  const action=request?.action;
  if(!allowed.has(action)||request===null||Array.isArray(request)||Object.keys(request).some(k=>!["action","scene","svgText","dryRun"].includes(k))) return fail("compile","SCENE_REQUEST_INVALID");
  if(request.dryRun !== undefined && typeof request.dryRun !== "boolean") return fail(action,"SCENE_REQUEST_INVALID");
  if(action==="import_svg") {
    if(typeof request.svgText!=="string"||Buffer.byteLength(request.svgText)>SCENE_LIMIT||request.scene!==undefined) return fail(action,"SCENE_REQUEST_INVALID");
    const imported=sceneImportSvg(Buffer.from(request.svgText,"utf8"));
    const {scene,canonicalScene,...summary}=imported;
    if(imported.classification!=="SUPPORTED_IMPORT"||!scene) return {status:"success",action,valid:false,classification:summary.classification,reasonCodes:summary.reasonCodes.slice(0,128),normalizations:summary.normalizations.slice(0,128),diagnostics:imported.reasonCodes.slice(0,128).map(diagnostic)};
    return compile(action,scene,summary);
  }
  if(!request.scene||request.svgText!==undefined) return fail(action,"SCENE_REQUEST_INVALID");
  return compile(action,request.scene);
}

let total=0;const chunks=[];
try {
  for await(const chunk of process.stdin) {
    total+=chunk.length;
    if(total>INPUT_LIMIT) throw new Error("limit");
    chunks.push(chunk);
  }
  const request=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(Buffer.concat(chunks)));
  process.stdout.write(JSON.stringify(dispatchScene(request))+"\n");
} catch {
  process.stdout.write(JSON.stringify(fail("compile","SCENE_REQUEST_INVALID"))+"\n");
  process.exitCode=1;
}
