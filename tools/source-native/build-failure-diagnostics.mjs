import {isAbsolute,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SOURCE_FILES} from './build-failure-source-files.mjs';

export {SOURCE_FILES};
export const INPUT_ARCHIVE_SHA256='cf4a0c2d275bcb3173d0c085bc1ada065e2e981f74a682739532ee7b3d58ba11';
export const MAX_DIAGNOSTIC_BYTES=256*1024;
export const DIAGNOSTIC_SCHEMA='nebular-build-failure-hints-v1';
// build-app.mjs maps its staged workspace to this fixed virtual prefix.
export const SOURCE_DIAGNOSTIC_ALIASES=Object.freeze(['/nebular-source']);
const systemCodes=new Set(['ENOENT','EACCES','ENOSPC','ERR_MODULE_NOT_FOUND','ERR_DLOPEN_FAILED','EBADENGINE','ERESOLVE','EINTEGRITY','E404']);
const systemPatterns=[...systemCodes].map(code=>[code,new RegExp(`\\b${code}\\b`)]);
const markerPairs=[
 ['NATIVE_COMMAND_FAILED','Native candidate build command failed; no production receipt emitted'],
 ['APP_STEP_FAILED','Application build step failed'],
 ['PATH_LEAK','local build path'],
 ['UNBOUND_CARGO_CONFIG','Unbound cargo configuration in ancestor'],
 ['TARGET_MISMATCH','target mismatch'],
 ['LINK_FAILED','linking with'],
 ['SOURCE_AUTHORITY','source authority'],
];
const extraMarkers=['BUILD_SCRIPT_FAILED','COMPILE_FAILED','OFFLINE_DEPENDENCY','BUNDLE_FAILED','PANIC','FRONTEND_BUILD_FAILED','NPM_ERROR'];
const markers=new Set([...markerPairs.map(x=>x[0]),...extraMarkers,'UNCLASSIFIED','DIAGNOSTIC_INPUT_REFUSED']);
const nativeOsCodes=new Map([['2','ENOENT'],['13','EACCES'],['28','ENOSPC']]);

const sourceIds=new Map(SOURCE_FILES.map((name,index)=>[name,index]));
const exactKeys=(record,keys)=>record&&Object.getPrototypeOf(record)===Object.prototype&&JSON.stringify(Object.keys(record).sort())===JSON.stringify([...keys].sort());

export function decodeBuildStream(bytes,{partial=false}={}){
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_DIAGNOSTIC_BYTES)return {text:'',refused:true,trimmed:false};
 const decode=value=>new TextDecoder('utf-8',{fatal:true}).decode(value);
 try{return {text:decode(bytes),refused:false,trimmed:false};}catch{}
 if(partial){
  for(let start=Math.max(0,bytes.length-3);start<bytes.length;start++){
   const lead=bytes[start],needed=lead>=0xc2&&lead<=0xdf?2:lead>=0xe0&&lead<=0xef?3:lead>=0xf0&&lead<=0xf4?4:0;
   const tail=bytes.subarray(start);
   if(!needed||tail.length>=needed||[...tail.subarray(1)].some(x=>x<0x80||x>0xbf))continue;
   if(tail.length>1&&((lead===0xe0&&tail[1]<0xa0)||(lead===0xed&&tail[1]>0x9f)||(lead===0xf0&&tail[1]<0x90)||(lead===0xf4&&tail[1]>0x8f)))continue;
   try{return {text:decode(bytes.subarray(0,start)),refused:false,trimmed:true};}catch{}
  }
 }
 return {text:'',refused:true,trimmed:false};
}

export function classifyBuildOutput({stdout,stderr,roots,partial=false}){
 const out=decodeBuildStream(stdout,{partial}),err=decodeBuildStream(stderr,{partial});
 const result=classifyBuildFailure({stdout:out.text,stderr:err.text,roots,partial});
 if(out.refused||err.refused){
  result.markers=result.markers.filter(x=>x!=='UNCLASSIFIED');
  if(!result.markers.includes('DIAGNOSTIC_INPUT_REFUSED'))result.markers.push('DIAGNOSTIC_INPUT_REFUSED');
  result.markers.sort();
 }
 return result;
}

export function validateBuildDiagnostic(value){
 try{
  if(!exactKeys(value,['schema','markers','rustCodes','systemCodes','sites','flags'])||value.schema!==DIAGNOSTIC_SCHEMA)return null;
  for(const [key,allowed] of [['markers',markers],['systemCodes',systemCodes]]){
   if(!Array.isArray(value[key])||value[key].length>16||new Set(value[key]).size!==value[key].length||value[key].some(x=>!allowed.has(x)))return null;
  }
  if(!Array.isArray(value.rustCodes)||value.rustCodes.length>16||new Set(value.rustCodes).size!==value.rustCodes.length||value.rustCodes.some(x=>typeof x!=='string'||!/^E[0-9]{4}$/.test(x)))return null;
  if(!Array.isArray(value.sites)||value.sites.length>16)return null;
  const sites=[];
  for(const site of value.sites){
   if(!exactKeys(site,['file','line','column'])||!Number.isInteger(site.file)||site.file<0||site.file>=SOURCE_FILES.length||![site.line,site.column].every(x=>Number.isInteger(x)&&x>=1&&x<=999999))return null;
   sites.push({file:site.file,line:site.line,column:site.column});
  }
  if(!exactKeys(value.flags,['longLine','unmappedSite','partial'])||Object.values(value.flags).some(x=>typeof x!=='boolean'))return null;
  return {schema:DIAGNOSTIC_SCHEMA,markers:[...value.markers],rustCodes:[...value.rustCodes],systemCodes:[...value.systemCodes],sites,flags:{...value.flags}};
 }catch{return null;}
}

/** Untrusted diagnostic hints only. No message, identifier or path is returned. */
export function classifyBuildFailure({stdout,stderr,roots,partial=false}){
 const result={schema:DIAGNOSTIC_SCHEMA,markers:[],rustCodes:[],systemCodes:[],sites:[],flags:{longLine:false,unmappedSite:false,partial:Boolean(partial)}};
 if(![stdout,stderr].every(x=>typeof x==='string'&&Buffer.byteLength(x)<=MAX_DIAGNOSTIC_BYTES)||!Array.isArray(roots)||roots.length!==2||roots.some(x=>typeof x!=='string'||!isAbsolute(x)||x.includes('\0'))){result.markers.push('DIAGNOSTIC_INPUT_REFUSED');return result;}
 const foundMarkers=new Set(),rust=new Set(),system=new Set(),sites=new Map();
 const stripAnsi=s=>s.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
 for(const stream of [stdout,stderr]){
 let rustErrorContext=false;
 for(const rawLine of stream.split(/\r?\n/)){
  if(!rawLine)continue;
  if(rawLine.length>4096){result.flags.longLine=true;continue;}
  const line=stripAnsi(rawLine);
  const trimmed=line.trim();
  if(/^error(?:\[E[0-9]{4}\])?:/.test(trimmed))rustErrorContext=true;
  else if(/^warning(?:\[[^\]]+\])?:/.test(trimmed))rustErrorContext=false;
  if(line.includes('failed to run custom build command'))foundMarkers.add('BUILD_SCRIPT_FAILED');
  if(/^error: could not compile\b/.test(trimmed))foundMarkers.add('COMPILE_FAILED');
  if(line.includes('offline mode (via'))foundMarkers.add('OFFLINE_DEPENDENCY');
  if(/failed to bundle(?: project| app)?\b/i.test(line))foundMarkers.add('BUNDLE_FAILED');
  if(/^thread .+ panicked at\b/.test(trimmed))foundMarkers.add('PANIC');
  if(line.includes('beforeBuildCommand')&&/\b(?:failed|failure|error)\b/i.test(line))foundMarkers.add('FRONTEND_BUILD_FAILED');
  if(/^npm (?:error|ERR!)(?:\s|$)/.test(trimmed))foundMarkers.add('NPM_ERROR');
  for(const match of line.matchAll(/\(os error (2|13|28)\)/g))system.add(nativeOsCodes.get(match[1]));
  for(const [name,text] of markerPairs)if(line.includes(text))foundMarkers.add(name);
  for(const match of line.matchAll(/\berror\[(E[0-9]{4})\]/g))if(rust.size<16)rust.add(match[1]);
  for(const [code,pattern] of systemPatterns)if(pattern.test(line)&&system.size<16)system.add(code);
  let location;
  if(trimmed.startsWith('at node:')||trimmed.startsWith('node:')||trimmed.includes('(node:'))continue;
  if(trimmed.startsWith('-->')){if(!rustErrorContext)continue;location=trimmed.slice(3).trim();}
  else if(trimmed.startsWith('at ')){
   const start=trimmed.indexOf('file:///')>=0?trimmed.indexOf('file:///'):trimmed.indexOf('/');
   if(start>=0)location=trimmed.slice(start).replace(/\)\s*$/,'');
  }else if(trimmed.startsWith('file:///')||trimmed.startsWith('/'))location=trimmed;
  if(!location)continue;
  const last=location.lastIndexOf(':'),penultimate=location.lastIndexOf(':',last-1);
  if(penultimate<1)continue;
  const lineNumber=location.slice(penultimate+1,last),columnNumber=location.slice(last+1);
  if(![lineNumber,columnNumber].every(x=>/^[1-9][0-9]{0,5}$/.test(x)))continue;
  let path=location.slice(0,penultimate);
  try{if(path.startsWith('file:'))path=fileURLToPath(path);}catch{result.flags.unmappedSite=true;continue;}
  let id;
  for(const root of [...roots,...SOURCE_DIAGNOSTIC_ALIASES]){
   const candidates=isAbsolute(path)?[resolve(path)]:[resolve(root,path),resolve(root,'src-tauri',path)];
   for(const absolute of candidates){const name=relative(root,absolute).split('\\').join('/');if(sourceIds.has(name)){id=sourceIds.get(name);break;}}
   if(id!==undefined)break;
  }
  if(id===undefined){result.flags.unmappedSite=true;continue;}
  const site={file:id,line:Number(lineNumber),column:Number(columnNumber)};
  if(sites.size<16)sites.set(`${id}:${site.line}:${site.column}`,site);
 }
 }
 result.markers=[...foundMarkers].sort();result.rustCodes=[...rust].sort();result.systemCodes=[...system].sort();result.sites=[...sites.values()].sort((a,b)=>a.file-b.file||a.line-b.line||a.column-b.column);
 if(!result.markers.length&&!result.rustCodes.length&&!result.systemCodes.length&&!result.sites.length)result.markers=['UNCLASSIFIED'];
 return result;
}
