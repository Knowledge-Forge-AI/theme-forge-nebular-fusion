// Test-only staging of the authenticated maintained source. No GUI/release build.
import {chmod, cp, lstat, mkdir, readdir, realpath, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';

export const TARGET = 'aarch64-unknown-linux-gnu';
const VERSION = '0.6.1';
const KNOWN_PHASES = new Set(['npm-links-app','npm-links-preview','prepare-resources','prepare-frontend']);
export class LinuxSourceStageError extends Error {
  constructor(code,phase=null){super(code);this.name='LinuxSourceStageError';this.code=code;this.phase=phase;}
}
const refuse=(code,phase=null)=>{throw new LinuxSourceStageError(code,phase);};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function absolute(value){
  if(typeof value!=='string'||!isAbsolute(value)||/[\u0000\r\n]/u.test(value))refuse('LINUX_STAGE_PATH');
  return resolve(value);
}
function outside(parent,child){const rel=relative(parent,child);return rel==='..'||rel.startsWith('../')||isAbsolute(rel);}
export function validateAuthority(authority){
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
}
export function stageEnvironment(authority,work,inputsPath){
  validateAuthority(authority);work=absolute(work);inputsPath=absolute(inputsPath);
  const paths=[...Object.values(authority.tools).filter(x=>typeof x==='string').map(dirname),'/usr/bin','/bin'];
  return {PATH:[...new Set(paths)].join(':'),HOME:join(work,'home'),TMPDIR:join(work,'tmp'),
    TMP:join(work,'tmp'),TEMP:join(work,'tmp'),CARGO_HOME:join(work,'cargo-home'),
    CARGO_TARGET_DIR:join(work,'target'),npm_config_cache:join(work,'npm-cache'),
    npm_config_offline:'true',CARGO_NET_OFFLINE:'true',RUSTC:authority.tools.rust,
    CARGO:authority.tools.cargo,CC:authority.tools.compiler,PKG_CONFIG:authority.tools.pkgConfig,
    NEBULAR_BUILD_INPUTS:inputsPath,NEBULAR_BUILD_MODE:'portable-source',
    SOURCE_DATE_EPOCH:'1704067200',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
}
export function preparationCommands(authority,source,environment){
  validateAuthority(authority);source=absolute(source);
  const command=(phase,args,cwd=source)=>({phase,program:authority.tools.node,args,cwd,env:{...environment},capture:'none'});
  const rebuild=[authority.tools.npm,'rebuild','--ignore-scripts','--offline','--no-audit','--no-fund'];
  return [command('npm-links-app',rebuild),command('npm-links-preview',rebuild,join(source,'loom-preview-source')),
    command('prepare-resources',[join(source,'tools/prepare-app-resources.mjs'),'--build-inputs',environment.NEBULAR_BUILD_INPUTS]),
    command('prepare-frontend',[join(source,'tools/source-frontend-build.mjs')])];
}
async function writable(path){
  const info=await lstat(path);
  if(info.isSymbolicLink())refuse('LINUX_STAGE_MEMBER');
  if(!info.isDirectory()&&!info.isFile())refuse('LINUX_STAGE_MEMBER');
  await chmod(path,(info.mode&0o777)|0o200|(info.isDirectory()?0o100:0));
  if(info.isDirectory())for(const name of await readdir(path))await writable(join(path,name));
}
function accepted(result){return record(result)&&result.exitCode===0&&result.failure==null
  &&result.signal==null&&result.cleanup==='leader-close-observed';}

/** Maintained APIs come from the verified capsule; caller owns the fixed run port. */
async function prepareRustSourceInternal({authority,output,maintained,run,mode='actual'}){
  validateAuthority(authority);
  if(!['actual','fixture'].includes(mode)||typeof run!=='function')refuse('LINUX_STAGE_PORT');
  for(const name of ['verifySourceTree','populateNativeCaches','inspectAncestorCargoConfigs']){
    if(typeof maintained?.[name]!=='function')refuse('LINUX_STAGE_MAINTAINED_API');
  }
  const sourceRoot=await realpath(authority.inputs.sourceRoot);
  output=absolute(output);
  if(await realpath(dirname(output))!==dirname(output))refuse('LINUX_STAGE_PARENT');
  const protectedRoots=[sourceRoot,...Object.values(authority.roots),
    ...['frontendModules','previewModules','cargoHome','npmCache'].map(n=>authority.inputs.execution[n])];
  for(const path of protectedRoots){const root=await realpath(path);if(!outside(root,output)||!outside(output,root))refuse('LINUX_STAGE_OVERLAP');}
  await maintained.verifySourceTree(sourceRoot,authority.inputs.source);
  await mkdir(output,{recursive:false,mode:0o700});
  const work=join(output,'work'),source=join(work,'source');
  await mkdir(work,{mode:0o700});
  for(const name of ['home','tmp','cargo-home','npm-cache','target'])await mkdir(join(work,name),{mode:0o700});
  await cp(sourceRoot,source,{recursive:true,force:false,errorOnExist:true});
  await maintained.verifySourceTree(source,authority.inputs.source);
  await writable(source);
  const inputsPath=join(work,'build-inputs.json');
  await writeFile(inputsPath,JSON.stringify(authority.inputs,null,2)+'\n',{flag:'wx',mode:0o600});
  await maintained.populateNativeCaches(work,authority.inputs.execution,authority.inputs.settings?.cargo);
  for(const [name,destination] of [['frontendModules','node_modules'],['previewModules','loom-preview-source/node_modules']]){
    await cp(authority.inputs.execution[name],join(source,destination),{recursive:true,dereference:true,force:false,errorOnExist:true});
    await writable(join(source,destination));
  }
  const environment=stageEnvironment(authority,work,inputsPath);
  await maintained.inspectAncestorCargoConfigs([source,process.cwd()]);
  const phases=[];
  for(const command of preparationCommands(authority,source,environment)){
    if(!KNOWN_PHASES.has(command.phase))refuse('LINUX_STAGE_PHASE');
    let result;
    try{result=await run(command);}catch{refuse('LINUX_STAGE_COMMAND',command.phase);}
    if(!accepted(result))refuse('LINUX_STAGE_COMMAND',command.phase);
    phases.push({phase:command.phase,status:'process-observed'});
  }
  await maintained.verifySourceTree(sourceRoot,authority.inputs.source);
  return {source,environment,receipt:{schema:'nebular-linux-arm64-rust-source-stage-v1',
    status:mode==='fixture'?'source-stage-fixture-only':'source-prepared-for-rust-tests',
    target:TARGET,source:authority.inputs.source.identity,inputIdentity:authority.identity,
    phases,fixtureOnly:mode==='fixture',nativeRustTests:'not-run',guiBuild:false,guiLaunch:false,
    packaging:false,publication:false}};
}
export async function prepareRustSource(options){
  try{return await prepareRustSourceInternal(options);}
  catch(error){
    if(error instanceof LinuxSourceStageError)throw error;
    throw new LinuxSourceStageError('LINUX_STAGE_IO_OR_AUTHORITY');
  }
}
