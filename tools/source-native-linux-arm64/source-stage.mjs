// Test-only staging of the authenticated maintained source. No GUI/release build.
import {chmod, cp, lstat, mkdir, readdir, realpath, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';

export const TARGET = 'aarch64-unknown-linux-gnu';
const VERSION = '0.6.1';
const KNOWN_PHASES = new Set(['npm-links-app','npm-links-preview','prepare-resources','prepare-frontend']);
const KNOWN_CODES = [
  'LINUX_STAGE_PATH','LINUX_STAGE_AUTHORITY','LINUX_STAGE_ENVIRONMENT','LINUX_STAGE_ROOTS',
  'LINUX_STAGE_PORT','LINUX_STAGE_MAINTAINED_API','LINUX_STAGE_PARENT','LINUX_STAGE_OVERLAP',
  'LINUX_STAGE_MEMBER','LINUX_STAGE_PHASE','LINUX_STAGE_COMMAND','LINUX_STAGE_IO_OR_AUTHORITY',
  'LINUX_STAGE_UNKNOWN',
];
export const SOURCE_STAGE_CODES = Object.freeze(KNOWN_CODES);
export const SOURCE_STAGE_OPERATIONS = Object.freeze([
  'validate','resolve-roots','check-overlap','verify-source','create-work','copy-source',
  'write-inputs','populate-caches','copy-app-modules','copy-preview-modules','environment',
  'inspect-cargo-config','npm-links-app','npm-links-preview','prepare-resources','prepare-frontend',
  'verify-original','unknown',
]);
export const SOURCE_STAGE_PROCESS_REASONS = Object.freeze([
  'THREW','INVALID_RESULT','TIMEOUT','OUTPUT_LIMIT','SPAWN','ERROR','SIGNAL','EXIT','CLEANUP',
]);
export const SOURCE_STAGE_STDERR_CODES = Object.freeze([
  'ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED','ERR_UNSUPPORTED_DIR_IMPORT','ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_INVALID_PACKAGE_CONFIG','ERR_DLOPEN_FAILED','ERR_INVALID_ARG_TYPE','ENOENT','EEXIST',
  'EACCES','EPERM','ENOTCACHED','ERESOLVE','EINTEGRITY','EJSONPARSE','EBADENGINE','NONE',
  'UNKNOWN','MULTIPLE',
]);
const KNOWN_CODE_SET = new Set(SOURCE_STAGE_CODES);
const KNOWN_OPERATION_SET = new Set(SOURCE_STAGE_OPERATIONS);
const KNOWN_PROCESS_REASON_SET = new Set(SOURCE_STAGE_PROCESS_REASONS);
const KNOWN_STDERR_CODE_SET = new Set(SOURCE_STAGE_STDERR_CODES);
const RECOGNIZED_STDERR_CODES = Object.freeze(SOURCE_STAGE_STDERR_CODES.filter(code=>!['NONE','UNKNOWN','MULTIPLE'].includes(code)));
const PROCESS_FAILURE_REASONS = new Map([
  ['TIMEOUT','TIMEOUT'],['OUTPUT_LIMIT','OUTPUT_LIMIT'],['SPAWN','SPAWN'],['ERROR','ERROR'],
]);
const MISSING = Symbol('missing');
const ACCESSOR = Symbol('accessor');
const MAX_STDERR_BYTES = 256*1024;
const MAX_HORIZONTAL_SPACE = 32;
const MAX_STDERR_TOKEN_LENGTH = 64;
const NODE_ERROR_PREFIXES = Object.freeze([
  'AggregateError','ReferenceError','SyntaxError','TypeError','URIError','RangeError','EvalError',
  'NodeError','Error',
]);

export class LinuxSourceStageError extends Error {
  constructor(code,phase=null,operation='unknown',processReason=null,processExitCode=null,stderrCode='NONE'){
    const safeCode=KNOWN_CODE_SET.has(code)?code:'LINUX_STAGE_UNKNOWN';
    const safePhase=phase===null||KNOWN_PHASES.has(phase)?phase:null;
    const safeOperation=KNOWN_OPERATION_SET.has(operation)?operation:'unknown';
    const safeReason=KNOWN_PROCESS_REASON_SET.has(processReason)?processReason:null;
    const safeExit=Number.isInteger(processExitCode)&&processExitCode>=0&&processExitCode<=255
      ?processExitCode:null;
    const safeStderr=stderrCode===null||stderrCode===undefined?'NONE'
      :(KNOWN_STDERR_CODE_SET.has(stderrCode)?stderrCode:'UNKNOWN');
    super(safeCode);this.name='LinuxSourceStageError';this.code=safeCode;this.phase=safePhase;
    this.operation=safeOperation;this.processReason=safeReason;this.processExitCode=safeExit;
    this.stderrCode=safeStderr;
  }
}
const refuse=(code,phase=null,operation='unknown',processReason=null,processExitCode=null,stderrCode='NONE')=>{
  throw new LinuxSourceStageError(code,phase,operation,processReason,processExitCode,stderrCode);
};
function record(value){
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  try{return [Object.prototype,null].includes(Object.getPrototypeOf(value));}catch{return false;}
}
function ownData(value,key){
  if(value===null||typeof value!=='object')return MISSING;
  try{
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor)return MISSING;
    return Object.hasOwn(descriptor,'value')?descriptor.value:ACCESSOR;
  }catch{return ACCESSOR;}
}
function isStageError(value){
  try{return value instanceof LinuxSourceStageError;}catch{return false;}
}
function boundedExit(value){
  return Number.isInteger(value)&&value>=0&&value<=255?value:null;
}
function boundedStderrCode(value){
  if(value===MISSING)return 'NONE';
  if(value===ACCESSOR)return 'UNKNOWN';
  if(value===null||value===undefined)return 'NONE';
  return KNOWN_STDERR_CODE_SET.has(value)?value:'UNKNOWN';
}
function annotate(error,operation='unknown',processReason=MISSING,processExitCode=MISSING,stderrCode=MISSING){
  const code=ownData(error,'code');
  const phase=ownData(error,'phase');
  const currentOperation=ownData(error,'operation');
  const currentReason=ownData(error,'processReason');
  const currentExit=ownData(error,'processExitCode');
  const currentStderr=ownData(error,'stderrCode');
  const safeOperation=KNOWN_OPERATION_SET.has(currentOperation)&&currentOperation!=='unknown'
    ?currentOperation:(KNOWN_OPERATION_SET.has(operation)?operation:'unknown');
  const safeReason=processReason===MISSING
    ?(KNOWN_PROCESS_REASON_SET.has(currentReason)?currentReason:null)
    :(KNOWN_PROCESS_REASON_SET.has(processReason)?processReason:null);
  const safeExit=processExitCode===MISSING?boundedExit(currentExit):boundedExit(processExitCode);
  const safeStderr=stderrCode===MISSING?boundedStderrCode(currentStderr):boundedStderrCode(stderrCode);
  return new LinuxSourceStageError(
    KNOWN_CODE_SET.has(code)?code:'LINUX_STAGE_UNKNOWN',
    phase===null||KNOWN_PHASES.has(phase)?phase:null,
    safeOperation,safeReason,safeExit,safeStderr,
  );
}
function operation(operationName,callback){
  try{return callback();}
  catch(error){
    if(isStageError(error))throw annotate(error,operationName);
    throw new LinuxSourceStageError('LINUX_STAGE_IO_OR_AUTHORITY',null,operationName);
  }
}
async function asyncOperation(operationName,callback){
  try{return await callback();}
  catch(error){
    if(isStageError(error))throw annotate(error,operationName);
    throw new LinuxSourceStageError('LINUX_STAGE_IO_OR_AUTHORITY',null,operationName);
  }
}
function absolute(value){
  if(typeof value!=='string'||!isAbsolute(value)||/[\u0000\r\n]/u.test(value))refuse('LINUX_STAGE_PATH');
  return resolve(value);
}
function outside(parent,child){const rel=relative(parent,child);return rel==='..'||rel.startsWith('../')||isAbsolute(rel);}
export function validateAuthority(authority){
  return operation('validate',()=>{
    if(!record(authority)||authority.target?.triple!==TARGET||authority.target?.os!=='linux'
        ||authority.inputs?.schema!=='nebular-build-inputs-v1'||authority.inputs.target!==TARGET
        ||authority.inputs.mode!=='portable-source'||authority.inputs.source?.version!==VERSION
        ||!(/^[a-f0-9]{64}$/u.test(authority.identity))
        ||!(/^[a-f0-9]{64}$/u.test(authority.inputs.source?.identity))
        ||authority.inputs.materialRoute?.materialProfile!=='paired-material-v1'
        ||authority.inputs.materialRoute.target!==TARGET
        ||authority.inputs.materialRoute.wholeSourceCandidate!==authority.inputs.source?.identity)refuse('LINUX_STAGE_AUTHORITY');
    if(!record(authority.inputs.execution)||!record(authority.inputs.execution.environment)
        ||Object.keys(authority.inputs.execution.environment).length!==0)refuse('LINUX_STAGE_ENVIRONMENT');
    for(const name of ['node','npm','rust','cargo','compiler','pkgConfig'])absolute(authority.tools?.[name]);
    for(const name of ['frontendModules','previewModules','cargoHome','npmCache'])absolute(authority.inputs.execution[name]);
    absolute(authority.inputs.sourceRoot);
    if(!record(authority.roots)||!Object.values(authority.roots).every(x=>typeof x==='string'&&isAbsolute(x)))refuse('LINUX_STAGE_ROOTS');
    return authority;
  });
}
export function stageEnvironment(authority,work,inputsPath){
  return operation('environment',()=>{
    validateAuthority(authority);work=absolute(work);inputsPath=absolute(inputsPath);
    const paths=[...Object.values(authority.tools).filter(x=>typeof x==='string').map(dirname),'/usr/bin','/bin'];
    return {PATH:[...new Set(paths)].join(':'),HOME:join(work,'home'),TMPDIR:join(work,'tmp'),
      TMP:join(work,'tmp'),TEMP:join(work,'tmp'),CARGO_HOME:join(work,'cargo-home'),
      CARGO_TARGET_DIR:join(work,'target'),npm_config_cache:join(work,'npm-cache'),
      npm_config_offline:'true',CARGO_NET_OFFLINE:'true',RUSTC:authority.tools.rust,
      CARGO:authority.tools.cargo,CC:authority.tools.compiler,PKG_CONFIG:authority.tools.pkgConfig,
      NEBULAR_BUILD_INPUTS:inputsPath,NEBULAR_BUILD_MODE:'portable-source',
      SOURCE_DATE_EPOCH:'1704067200',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
  });
}
export const RESOURCE_API_PROGRAM = String.raw`(async () => {
  const { pathToFileURL } = require("node:url");
  const modulePath = process.argv[2];
  const inputsPath = process.argv[3];
  process.execArgv.splice(0, process.execArgv.length);
  process.argv.splice(2, 2, "--build-inputs", inputsPath);
  const resource = await import(pathToFileURL(modulePath).href);
  const options = resource.parseArgs(process.argv.slice(2));
  try {
    await resource.prepareAppResources(options);
  } catch (err) {
    console.error("FATAL:", err.message);
    process.exit(1);
  }
})();
`;
export function preparationCommands(authority,source,environment){
  return operation('environment',()=>{
    validateAuthority(authority);source=absolute(source);
    const command=(phase,args,cwd=source)=>({phase,program:authority.tools.node,args,cwd,env:{...environment},capture:'none'});
    const rebuild=[authority.tools.npm,'rebuild','--ignore-scripts','--offline','--no-audit','--no-fund'];
    return [command('npm-links-app',rebuild),command('npm-links-preview',rebuild,join(source,'loom-preview-source')),
      command('prepare-resources',['--eval',RESOURCE_API_PROGRAM,'nebular-resource-api',join(source,'tools/prepare-app-resources.mjs'),environment.NEBULAR_BUILD_INPUTS]),
      command('prepare-frontend',[join(source,'tools/source-frontend-build.mjs')])];
  });
}
async function writable(path){
  const info=await lstat(path);
  if(info.isSymbolicLink())refuse('LINUX_STAGE_MEMBER');
  if(!info.isDirectory()&&!info.isFile())refuse('LINUX_STAGE_MEMBER');
  await chmod(path,(info.mode&0o777)|0o200|(info.isDirectory()?0o100:0));
  if(info.isDirectory())for(const name of await readdir(path))await writable(join(path,name));
}
function processFailure(result){
  if(!record(result))return {reason:'INVALID_RESULT',exit:null};
  const exit=ownData(result,'exitCode');
  const failure=ownData(result,'failure');
  const signal=ownData(result,'signal');
  const cleanup=ownData(result,'cleanup');
  const exitCode=boundedExit(exit);
  if([exit,failure,signal,cleanup].includes(ACCESSOR))return {reason:'INVALID_RESULT',exit:exitCode};
  if(exit===MISSING)return {reason:'INVALID_RESULT',exit:exitCode};
  if(failure!==MISSING&&failure!==null&&failure!==undefined){
    return {reason:PROCESS_FAILURE_REASONS.get(failure)||'INVALID_RESULT',exit:exitCode};
  }
  if(signal!==MISSING&&signal!==null&&signal!==undefined)return {reason:'SIGNAL',exit:exitCode};
  if(exit!==0){
    if(typeof exit!=='number'||!Number.isInteger(exit))return {reason:'INVALID_RESULT',exit:exitCode};
    return {reason:'EXIT',exit:exitCode};
  }
  if(cleanup!=='leader-close-observed')return {reason:'CLEANUP',exit:exitCode};
  return null;
}
function accepted(result){return processFailure(result)===null;}
function codeCharacter(code){
  const value=code.charCodeAt(0);
  return value>=65&&value<=90||value>=48&&value<=57||value===95;
}
function skipHorizontal(text,index,end){
  let cursor=index,count=0;
  while(cursor<end&&(text.charCodeAt(cursor)===32||text.charCodeAt(cursor)===9)){
    cursor++;count++;
    if(count>MAX_HORIZONTAL_SPACE)return null;
  }
  return cursor;
}
function tokenAt(text,index,end){
  for(const code of RECOGNIZED_STDERR_CODES){
    const finish=index+code.length;
    if(finish<=end&&text.startsWith(code,index)
        &&(finish===end||!codeCharacter(text[finish])))return code;
  }
  return null;
}
function quotedTokenAt(text,index,end,quote){
  const limit=Math.min(end,index+MAX_STDERR_TOKEN_LENGTH+1);
  let cursor=index;
  while(cursor<limit&&text[cursor]!==quote)cursor++;
  if(cursor>=end||cursor>=limit)return null;
  const code=tokenAt(text,index,cursor);
  return code===null||index+code.length!==cursor?null:{code,next:cursor+1};
}
function prefixBoundary(text,index,end){
  return index>=end||!codeCharacter(text[index]);
}
function bracketErrorCode(text,start,end){
  let cursor=skipHorizontal(text,start,end);
  if(cursor===null)return null;
  for(const prefix of NODE_ERROR_PREFIXES){
    if(!text.startsWith(prefix,cursor))continue;
    const afterPrefix=cursor+prefix.length;
    if(!prefixBoundary(text,afterPrefix,end))continue;
    let next=skipHorizontal(text,afterPrefix,end);
    if(next===null||next>=end||text[next]!=='[')continue;
    next=skipHorizontal(text,next+1,end);
    if(next===null)continue;
    const code=tokenAt(text,next,end);
    if(code===null)continue;
    const finish=next+code.length;
    next=skipHorizontal(text,finish,end);
    if(next!==null&&next<end&&text[next]===']'){
      const afterClose=next+1;
      if(afterClose===end||text[afterClose]===':'||text[afterClose]===' '||text[afterClose]==='\t')return code;
    }
  }
  return null;
}
function errorFilesystemCode(text,start,end){
  let cursor=skipHorizontal(text,start,end);
  if(cursor===null)return null;
  for(const prefix of NODE_ERROR_PREFIXES){
    if(!text.startsWith(prefix,cursor))continue;
    const afterPrefix=cursor+prefix.length;
    if(!prefixBoundary(text,afterPrefix,end))continue;
    const next=skipHorizontal(text,afterPrefix,end);
    if(next===null||next>=end||text[next]!==':')continue;
    const codeStart=skipHorizontal(text,next+1,end);
    if(codeStart===null)return null;
    const code=tokenAt(text,codeStart,end);
    if(code===null||!['ENOENT','EEXIST','EACCES','EPERM'].includes(code))continue;
    const finish=codeStart+code.length;
    if(finish===end||text[finish]===':')return code;
  }
  return null;
}
function propertyCode(text,start,end){
  let cursor=skipHorizontal(text,start,end);
  if(cursor===null||!text.startsWith('code',cursor))return null;
  const afterCode=cursor+4;
  if(!prefixBoundary(text,afterCode,end))return null;
  cursor=skipHorizontal(text,afterCode,end);
  if(cursor===null||cursor>=end||text[cursor]!==':')return null;
  cursor=skipHorizontal(text,cursor+1,end);
  if(cursor===null||cursor>=end||!['\'', '"'].includes(text[cursor]))return null;
  const parsed=quotedTokenAt(text,cursor+1,end,text[cursor]);
  if(parsed===null)return null;
  const afterQuote=skipHorizontal(text,parsed.next,end);
  if(afterQuote===null||afterQuote<end&&text[afterQuote]!==','&&text[afterQuote]!==';')return null;
  return parsed;
}
function npmCode(text,start,end){
  const line=text.slice(start,end);
  const match=/^[ \t]{0,32}npm[ \t]{1,32}(?:ERR!|error)[ \t]{1,32}code[ \t]{1,32}([A-Z_]{1,64})[ \t]{0,32}$/.exec(line);
  return match&&RECOGNIZED_STDERR_CODES.includes(match[1])?match[1]:null;
}
function filesystemPrefix(text,start,end){
  let cursor=skipHorizontal(text,start,end);
  if(cursor===null)return null;
  for(const code of ['ENOENT','EEXIST','EACCES','EPERM']){
    const finish=cursor+code.length;
    if(finish<=end&&text.startsWith(code,cursor)&&prefixBoundary(text,finish,end)
        &&finish<end&&text[finish]===':')return code;
  }
  return null;
}
function stderrLineCodes(text,start,end){
  const codes=[];
  const add=value=>{if(value!==null&&!codes.includes(value))codes.push(value);};
  add(bracketErrorCode(text,start,end));
  add(propertyCode(text,start,end)?.code??null);
  add(npmCode(text,start,end));
  add(errorFilesystemCode(text,start,end));
  add(filesystemPrefix(text,start,end));
  return codes;
}
function classifyStderrText(text){
  if(text.length===0)return 'NONE';
  const found=[];
  let start=0;
  while(start<=text.length){
    let lineEnd=text.indexOf('\n',start);
    if(lineEnd===-1)lineEnd=text.length;
    let contentEnd=lineEnd;
    if(contentEnd>start&&text.charCodeAt(contentEnd-1)===13)contentEnd--;
    for(const code of stderrLineCodes(text,start,contentEnd)){
      if(!found.includes(code))found.push(code);
      if(found.length>1)return 'MULTIPLE';
    }
    if(lineEnd===text.length)break;
    start=lineEnd+1;
  }
  return found[0]??'UNKNOWN';
}
function classifyStderr(result){
  try{
    const value=ownData(result,'stderr');
    if(value===MISSING)return 'NONE';
    if(value===ACCESSOR)return 'UNKNOWN';
    if(Buffer.isBuffer(value)){
      if(value.byteLength>MAX_STDERR_BYTES)return 'UNKNOWN';
      let text;
      try{text=new TextDecoder('utf-8',{fatal:true}).decode(value);}catch{return 'UNKNOWN';}
      return classifyStderrText(text);
    }
    if(typeof value!=='string'||value.length>MAX_STDERR_BYTES)return 'UNKNOWN';
    if(Buffer.byteLength(value,'utf8')>MAX_STDERR_BYTES)return 'UNKNOWN';
    return classifyStderrText(value);
  }catch{
    return 'UNKNOWN';
  }
}

/** Maintained APIs come from the verified capsule; caller owns the fixed run port. */
async function prepareRustSourceInternal({authority,output,maintained,run,mode='actual'}){
  await asyncOperation('validate',async()=>{
    validateAuthority(authority);
    if(!['actual','fixture'].includes(mode)||typeof run!=='function')refuse('LINUX_STAGE_PORT');
    for(const name of ['verifySourceTree','populateNativeCaches','inspectAncestorCargoConfigs']){
      if(typeof maintained?.[name]!=='function')refuse('LINUX_STAGE_MAINTAINED_API');
    }
  });
  const sourceRoot=await asyncOperation('resolve-roots',()=>realpath(authority.inputs.sourceRoot));
  output=await asyncOperation('resolve-roots',()=>absolute(output));
  if(await asyncOperation('resolve-roots',()=>realpath(dirname(output)))!==dirname(output)){
    await asyncOperation('resolve-roots',()=>{refuse('LINUX_STAGE_PARENT');});
  }
  const protectedRoots=await asyncOperation('resolve-roots',()=>[
    sourceRoot,...Object.values(authority.roots),
    ...['frontendModules','previewModules','cargoHome','npmCache'].map(n=>authority.inputs.execution[n]),
  ]);
  for(const path of protectedRoots){
    const root=await asyncOperation('resolve-roots',()=>realpath(path));
    await asyncOperation('check-overlap',async()=>{
      if(!outside(root,output)||!outside(output,root))refuse('LINUX_STAGE_OVERLAP');
    });
  }
  await asyncOperation('verify-source',()=>maintained.verifySourceTree(sourceRoot,authority.inputs.source));
  const work=join(output,'work'),source=join(work,'source');
  await asyncOperation('create-work',async()=>{
    await mkdir(output,{recursive:false,mode:0o700});
    await mkdir(work,{mode:0o700});
    for(const name of ['home','tmp','cargo-home','npm-cache','target'])await mkdir(join(work,name),{mode:0o700});
  });
  await asyncOperation('copy-source',()=>cp(sourceRoot,source,{recursive:true,force:false,errorOnExist:true}));
  await asyncOperation('copy-source',async()=>{
    await maintained.verifySourceTree(source,authority.inputs.source);
    await writable(source);
  });
  const inputsPath=join(work,'build-inputs.json');
  await asyncOperation('write-inputs',()=>writeFile(inputsPath,JSON.stringify(authority.inputs,null,2)+'\n',{flag:'wx',mode:0o600}));
  await asyncOperation('populate-caches',()=>maintained.populateNativeCaches(work,authority.inputs.execution,authority.inputs.settings?.cargo));
  await asyncOperation('copy-app-modules',async()=>{
    await cp(authority.inputs.execution.frontendModules,join(source,'node_modules'),{recursive:true,dereference:true,force:false,errorOnExist:true});
    await writable(join(source,'node_modules'));
  });
  await asyncOperation('copy-preview-modules',async()=>{
    await cp(authority.inputs.execution.previewModules,join(source,'loom-preview-source/node_modules'),{recursive:true,dereference:true,force:false,errorOnExist:true});
    await writable(join(source,'loom-preview-source/node_modules'));
  });
  const environment=stageEnvironment(authority,work,inputsPath);
  await asyncOperation('inspect-cargo-config',()=>maintained.inspectAncestorCargoConfigs([source,process.cwd()]));
  const commands=preparationCommands(authority,source,environment);
  const phases=[];
  for(const command of commands){
    const operationName=KNOWN_PHASES.has(command.phase)?command.phase:'unknown';
    if(!KNOWN_PHASES.has(command.phase)){
      await asyncOperation('unknown',()=>{refuse('LINUX_STAGE_PHASE');});
    }
    let result;
    try{result=await run(command);}
    catch{refuse('LINUX_STAGE_COMMAND',command.phase,operationName,'THREW',null,'NONE');}
    const failure=processFailure(result);
    if(failure!==null){
      const stderrCode=classifyStderr(result);
      refuse('LINUX_STAGE_COMMAND',command.phase,operationName,failure.reason,failure.exit,stderrCode);
    }
    phases.push({phase:command.phase,status:'process-observed'});
  }
  await asyncOperation('verify-original',()=>maintained.verifySourceTree(sourceRoot,authority.inputs.source));
  return {source,environment,receipt:{schema:'nebular-linux-arm64-rust-source-stage-v1',
    status:mode==='fixture'?'source-stage-fixture-only':'source-prepared-for-rust-tests',
    target:TARGET,source:authority.inputs.source.identity,inputIdentity:authority.identity,
    phases,fixtureOnly:mode==='fixture',nativeRustTests:'not-run',guiBuild:false,guiLaunch:false,
    packaging:false,publication:false}};
}
export async function prepareRustSource(options){
  try{return await prepareRustSourceInternal(options);}
  catch(error){
    if(isStageError(error))throw annotate(error);
    throw new LinuxSourceStageError('LINUX_STAGE_IO_OR_AUTHORITY',null,'unknown');
  }
}
