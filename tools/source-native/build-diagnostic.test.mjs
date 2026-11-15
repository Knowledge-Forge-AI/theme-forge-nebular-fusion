import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {constants as osConstants} from 'node:os';
import {fileURLToPath} from 'node:url';
import {classifyBuildFailure,classifyBuildOutput,decodeBuildStream,validateBuildDiagnostic,SOURCE_FILES,DIAGNOSTIC_SCHEMA,MAX_DIAGNOSTIC_BYTES,INPUT_ARCHIVE_SHA256} from './build-failure-diagnostics.mjs';
import {CampaignError,formatCampaignFailure,requirePhaseResult,runFixedCommand,buildDiagnosticOptions,requireTestListCommandResult} from './controller.mjs';

const roots=['/fixture/canonical','/fixture/candidate/work/source'];
const rustFile=SOURCE_FILES.find(x=>x.startsWith('src-tauri/src/')&&x.endsWith('.rs'));
const rustId=SOURCE_FILES.indexOf(rustFile);
const tool='tools/native-candidate-build.mjs';
const toolId=SOURCE_FILES.indexOf(tool);
const classify=(stderr,extra={})=>classifyBuildFailure({stdout:'',stderr,roots,...extra});

test('source IDs are fixed unique relative paths',()=>{
 assert.equal(SOURCE_FILES.length,155);assert.ok(toolId>=0&&rustId>=0);
 assert.deepEqual([...SOURCE_FILES].sort(),SOURCE_FILES);
 assert.equal(new Set(SOURCE_FILES).size,SOURCE_FILES.length);
 assert.ok(SOURCE_FILES.every(x=>!x.startsWith('/')&&!x.split('/').includes('..')));
});

test('Rust codes and source positions are separate untrusted hint sets',()=>{
 const d=classify(`error[E0432]: never-display-this\n --> ${roots[1]}/${rustFile}:12:9\n`);
 assert.deepEqual(d.rustCodes,['E0432']);assert.deepEqual(d.sites,[{file:rustId,line:12,column:9}]);
 assert.equal(JSON.stringify(d).includes('never-display-this'),false);
 assert.equal(JSON.stringify(d).includes('/fixture/'),false);assert.ok(validateBuildDiagnostic(d));
});

test('relative Rust locations use only the declared source bases',()=>{
 const path=rustFile.slice('src-tauri/'.length);const d=classify(`error: toy\n --> ${path}:4:2\n`);
 assert.deepEqual(d.sites,[{file:rustId,line:4,column:2}]);
 const outside=classify('error: toy\n --> /outside/private-name.rs:4:2\n --> ../../outside.rs:4:2\n');
 assert.deepEqual(outside.sites,[]);assert.equal(outside.flags.unmappedSite,true);
});

test('Node stack positions map to fixed IDs without emitting URLs',()=>{
 const d=classify(`Error: never-display-this\n at buildNativeCandidate (file://${roots[0]}/${tool}:85:5)\n`);
 assert.deepEqual(d.sites,[{file:toolId,line:85,column:5}]);assert.equal(JSON.stringify(d).includes('file:'),false);
});

test('fixed messages and system codes are labels only',()=>{
 const d=classify('Application build step failed\nError: ENOENT /private-value\nerror: linking with cc failed\n');
 assert.deepEqual(d.markers,['APP_STEP_FAILED','LINK_FAILED']);assert.deepEqual(d.systemCodes,['ENOENT']);
 assert.equal(JSON.stringify(d).includes('private-value'),false);
 assert.deepEqual(classify('prefixENOENTsuffix private-value').systemCodes,[]);
});

test('ANSI, malformed locations, unknown errors and long lines retain bounded hints',()=>{
 const d=classify(`\u001b[31merror[E0308]: private\u001b[0m\n --> ${roots[0]}/${rustFile}:0:2\n${'q'.repeat(4097)}\n`);
 assert.deepEqual(d.rustCodes,['E0308']);assert.deepEqual(d.sites,[]);assert.equal(d.flags.longLine,true);
 assert.deepEqual(classify('unclassified private-value').markers,['UNCLASSIFIED']);
 for(const bad of [null,{},'x'.repeat(MAX_DIAGNOSTIC_BYTES+1)]){
  const r=classifyBuildFailure({stdout:'',stderr:bad,roots});assert.deepEqual(r.markers,['DIAGNOSTIC_INPUT_REFUSED']);
 }
});

test('classification is capped and deduplicated',()=>{
 const input=Array.from({length:40},(_,i)=>`error[E${String(i).padStart(4,'0')}]: x\n --> ${roots[0]}/${rustFile}:${i+1}:1`).join('\n');
 const d=classify(input);assert.equal(d.rustCodes.length,16);assert.equal(d.sites.length,16);assert.ok(JSON.stringify(d).length<4096);
 const duplicate=classify(`error[E0001]: x\nerror[E0001]: x\n --> ${roots[0]}/${rustFile}:1:1\n --> ${roots[0]}/${rustFile}:1:1`);
 assert.equal(duplicate.rustCodes.length,1);assert.equal(duplicate.sites.length,1);
});

test('formatter rejects extra keys, unknown labels, paths and invalid numbers',()=>{
 const good=classify(`error[E0432]: private\n --> ${roots[0]}/${rustFile}:1:1`);
 const variants=[{...good,raw:'private-value'},{...good,markers:['private-value']},{...good,rustCodes:['private-value']},{...good,systemCodes:['private-value']},{...good,sites:[{file:155,line:1,column:1}]},{...good,sites:[{file:0,line:0,column:1}]},{...good,sites:[{file:0,line:1,column:Infinity}]},{...good,flags:{...good.flags,raw:'private-value'}},{...good,flags:{...good.flags,partial:'private-value'}}];
 for(const bad of variants){
  assert.equal(validateBuildDiagnostic(bad),null);const error=new CampaignError('BUILD_CANDIDATE_FAILED');error.buildDiagnostic=bad;
  assert.equal(formatCampaignFailure(error),'SOURCE_NATIVE_BUILD_CANDIDATE_FAILED');
 }
});

test('hints never change failure gates or non-build phase output',()=>{
 const d=classify('Application build step failed');const result={exitCode:1,failure:null,cleanup:'leader-close-observed',buildDiagnostic:d};
 assert.throws(()=>requirePhaseResult(result,'build-candidate'),error=>{
  const out=formatCampaignFailure(error);assert.ok(out.startsWith('SOURCE_NATIVE_BUILD_CANDIDATE_FAILED\nSOURCE_NATIVE_BUILD_BOUNDARY_UNACCEPTED_NONZERO\nSOURCE_NATIVE_BUILD_DIAGNOSTIC '));
  assert.equal(error.code,'BUILD_CANDIDATE_FAILED');return true;
 });
 assert.throws(()=>requirePhaseResult(result,'qualify'),error=>{assert.equal(Object.hasOwn(error,'buildDiagnostic'),false);assert.equal(formatCampaignFailure(error),'SOURCE_NATIVE_QUALIFY_FAILED');return true;});
 for(const cleanup of ['unconfirmed',undefined])assert.throws(()=>requirePhaseResult({...result,cleanup},'build-candidate'));
 assert.throws(()=>requirePhaseResult({...result,exitCode:0,failure:'OUTPUT_LIMIT'},'build-candidate'));
});

const cwd=dirname(fileURLToPath(import.meta.url));
const liveRoots=[join(cwd,'unshipped-source'),join(cwd,'candidate/work/source')];
const options={program:process.execPath,cwd,env:{PATH:'/usr/bin:/bin'},phase:'build-candidate',timeoutMs:5000,buildDiagnosticRoots:liveRoots};

test('actual failed child yields bounded hints and no retained streams',async()=>{
 const text=`error[E0432]: never-display-this\n --> ${liveRoots[1]}/${rustFile}:12:9\n`;
 const result=await runFixedCommand({...options,args:['-e',`process.stderr.write(${JSON.stringify(text)});process.exitCode=1;`]});
 assert.equal(result.exitCode,1);assert.deepEqual(result.buildDiagnostic.rustCodes,['E0432']);assert.equal(Object.hasOwn(result,'text'),false);assert.equal(Object.hasOwn(result,'stderr'),false);
 assert.throws(()=>requirePhaseResult(result,'build-candidate'),error=>{const text=formatCampaignFailure(error);assert.equal(text.includes('never-display-this'),false);assert.equal(text.includes(cwd),false);return true;});
});

test('success and other phases do not emit build diagnostics',async()=>{
 const success=await runFixedCommand({...options,args:['-e','process.stderr.write("never-display-this");']});
 assert.equal(success.exitCode,0);assert.equal(Object.hasOwn(success,'buildDiagnostic'),false);assert.equal(requirePhaseResult(success,'build-candidate'),success);
 const other=await runFixedCommand({...options,phase:'qualify',args:['-e','process.stderr.write("never-display-this");process.exitCode=1;']});
 assert.equal(Object.hasOwn(other,'buildDiagnostic'),false);
});

test('output overflow remains failed with partial hints',async()=>{
 const r=await runFixedCommand({...options,args:['-e',`process.stderr.write("x".repeat(${MAX_DIAGNOSTIC_BYTES+1}));setInterval(()=>{},1000);`]});
 assert.equal(r.failure,'OUTPUT_LIMIT');assert.equal(r.buildDiagnostic.flags.partial,true);assert.throws(()=>requirePhaseResult(r,'build-candidate'),error=>{assert.ok(formatCampaignFailure(error).includes('SOURCE_NATIVE_BUILD_BOUNDARY_OUTPUT_LIMIT'));return true;});
 assert.ok(JSON.stringify(r.buildDiagnostic).length<4096);
});

test('invalid UTF-8 becomes a fixed refusal marker, never raw bytes',async()=>{
 const r=await runFixedCommand({...options,args:['-e','process.stderr.write(Buffer.from([255]));process.exitCode=1;']});
 assert.deepEqual(r.buildDiagnostic.markers,['DIAGNOSTIC_INPUT_REFUSED']);assert.equal(r.exitCode,1);assert.throws(()=>requirePhaseResult(r,'build-candidate'));
});

test('build boundary distinguishes process failure categories without stream hints',()=>{
 const base={exitCode:1,failure:null,cleanup:'leader-close-observed'};
 for(const [delta,label] of [[{failure:'TIMEOUT'},'TIMEOUT'],[{failure:'OUTPUT_LIMIT'},'OUTPUT_LIMIT'],[{failure:'SPAWN'},'SPAWN_FAILURE'],[{failure:'ERROR'},'CHILD_ERROR'],[{exitCode:null,signal:'SIGTERM'},'SIGNALED'],[{cleanup:'unconfirmed'},'UNACCEPTED_NONZERO'],[{},'UNACCEPTED_NONZERO']]){
  assert.throws(()=>requirePhaseResult({...base,...delta},'build-candidate'),error=>{assert.equal(error.code,'BUILD_CANDIDATE_FAILED');assert.ok(formatCampaignFailure(error).includes('SOURCE_NATIVE_BUILD_BOUNDARY_'+label));assert.equal(formatCampaignFailure(error).includes('SOURCE_NATIVE_BUILD_CLEANUP_UNCONFIRMED'),delta.cleanup==='unconfirmed');return true;});
 }
 const error=new CampaignError('BUILD_CANDIDATE_FAILED');error.buildBoundary='never-display-this';assert.equal(formatCampaignFailure(error),'SOURCE_NATIVE_BUILD_CANDIDATE_FAILED');
});

test('partial UTF-8 trims only an incomplete final character',()=>{
 for(const text of ['é','€','😀']){
  const bytes=Buffer.from(text);
  for(let length=1;length<bytes.length;length++){
   const input=Buffer.concat([Buffer.from('error[E0432]: x\n'),bytes.subarray(0,length)]);
   const good=decodeBuildStream(input,{partial:true});assert.equal(good.refused,false);assert.equal(good.trimmed,true);assert.equal(good.text,'error[E0432]: x\n');
   assert.equal(decodeBuildStream(input,{partial:false}).refused,true);
  }
 }
 for(const invalid of [[255],[0xc0],[0xe0,0x80],[0xed,0xa0],[0xf4,0x90],[0x80],[255,0xe2,0x82]])assert.equal(decodeBuildStream(Buffer.from(invalid),{partial:true}).refused,true);
});

test('valid hints survive corruption or truncation in the other stream',()=>{
 const valid=Buffer.from('error[E0308]: x\n');
 const invalid=Buffer.from([255]);
 const d=classifyBuildOutput({stdout:invalid,stderr:valid,roots,partial:true});assert.deepEqual(d.rustCodes,['E0308']);assert.ok(d.markers.includes('DIAGNOSTIC_INPUT_REFUSED'));
 const truncated=Buffer.concat([Buffer.from('error[E0432]: x\n'),Buffer.from([0xe2,0x82])]);
 const kept=classifyBuildOutput({stdout:valid,stderr:truncated,roots,partial:true});assert.deepEqual(kept.rustCodes,['E0308','E0432']);assert.equal(kept.markers.includes('DIAGNOSTIC_INPUT_REFUSED'),false);
});

test('build phase wiring helper binds exactly two declared roots',()=>{
 assert.deepEqual(buildDiagnosticOptions('build-candidate',INPUT_ARCHIVE_SHA256,'/fixture/canonical','/fixture/candidate'),{buildDiagnosticRoots:['/fixture/canonical','/fixture/candidate/work/source']});
 for(const phase of [undefined,'prepare-host-inputs','qualify','native-tests'])assert.deepEqual(buildDiagnosticOptions(phase,INPUT_ARCHIVE_SHA256,'/fixture/canonical','/fixture/candidate'),{});
 assert.deepEqual(buildDiagnosticOptions('build-candidate','a'.repeat(64),'/fixture/canonical','/fixture/candidate'),{});
 assert.deepEqual(buildDiagnosticOptions('build-candidate',INPUT_ARCHIVE_SHA256,null,'/fixture/candidate'),{});
});

test('known workspace remap maps while target-library and Node internal frames do not',()=>{
 const mapped=classify(`error: toy\n --> /nebular-source/${rustFile}:1:1\n`);assert.deepEqual(mapped.sites,[{file:rustId,line:1,column:1}]);
 const internal=classify(' at run (node:internal/fs/promises:123:4)\n at node:internal/process/task_queues:105:5\n');assert.deepEqual(internal.sites,[]);assert.equal(internal.flags.unmappedSite,false);
 const library=classify('error: toy\n --> /cargo-input/target/library/core/src/lib.rs:1:1\n');assert.deepEqual(library.sites,[]);assert.equal(library.flags.unmappedSite,true);
});

test('overflow preserves the bounded prefix and trims a split multibyte tail',async()=>{
 const head=Buffer.from('error[E0432]: x\n');
 const script=`const head=Buffer.from('error[E0432]: x\\n');process.stderr.write(Buffer.concat([head,Buffer.alloc(${MAX_DIAGNOSTIC_BYTES}-head.length-1,10),Buffer.from('€')]));setInterval(()=>{},1000);`;
 const r=await runFixedCommand({...options,args:['-e',script]});
 assert.equal(r.failure,'OUTPUT_LIMIT');assert.equal(r.buildDiagnostic.flags.partial,true);
 assert.deepEqual(r.buildDiagnostic.rustCodes,['E0432']);assert.equal(r.buildDiagnostic.markers.includes('DIAGNOSTIC_INPUT_REFUSED'),false);
 assert.throws(()=>requirePhaseResult(r,'build-candidate'));
});

test('known build stop causes survive unconfirmed cleanup without changing prep ordering',()=>{
 for(const failure of ['TIMEOUT','OUTPUT_LIMIT']){
  const result={exitCode:null,signal:'SIGKILL',failure,cleanup:'unconfirmed'};
  assert.throws(()=>requirePhaseResult(result,'build-candidate'),error=>{
   const text=formatCampaignFailure(error);assert.equal(error.code,'BUILD_CANDIDATE_FAILED');
   assert.ok(text.includes('SOURCE_NATIVE_BUILD_BOUNDARY_'+failure));assert.ok(text.includes('SOURCE_NATIVE_BUILD_CLEANUP_UNCONFIRMED'));return true;
  });
  assert.throws(()=>requirePhaseResult(result,'prepare-host-inputs'),error=>{
   const text=formatCampaignFailure(error);assert.ok(text.includes('SOURCE_NATIVE_PREPARATION_BOUNDARY_UNCONFIRMED_CLEANUP'));assert.equal(text.includes('SOURCE_NATIVE_BUILD_'),false);return true;
  });
 }
 const error=new CampaignError('BUILD_CANDIDATE_FAILED');error.buildCleanupUnconfirmed='never-display-this';assert.equal(formatCampaignFailure(error),'SOURCE_NATIVE_BUILD_CANDIDATE_FAILED');
});

test('unexpected hint-parser exception preserves the original failed process result',async()=>{
 const poisoned=[...liveRoots];Object.defineProperty(poisoned,0,{get(){throw new Error('never-display-this')}});
 const result=await runFixedCommand({...options,buildDiagnosticRoots:poisoned,args:['-e','process.exitCode=1']});
 assert.equal(result.exitCode,1);assert.equal(result.failure,null);assert.deepEqual(result.buildDiagnostic.markers,['DIAGNOSTIC_INPUT_REFUSED']);
 assert.throws(()=>requirePhaseResult(result,'build-candidate'),error=>{assert.equal(error.code,'BUILD_CANDIDATE_FAILED');assert.equal(formatCampaignFailure(error).includes('never-display-this'),false);return true;});
});

test('native Darwin OS errors map to the three existing system labels only',()=>{
 assert.deepEqual([osConstants.errno.ENOENT,osConstants.errno.EACCES,osConstants.errno.ENOSPC],[2,13,28]);
 const d=classify('No such file (os error 2)\nPermission denied (os error 13)\nDisk full (os error 28)\nunknown (os error 999)');
 assert.deepEqual(d.systemCodes,['EACCES','ENOENT','ENOSPC']);assert.equal(JSON.stringify(d).includes('Disk full'),false);
});

test('warning locations cannot exhaust error sites and notes preserve parent context',()=>{
 const warnings=Array.from({length:20},(_,i)=>`warning: toy\n --> ${roots[0]}/${rustFile}:${i+1}:1`).join('\n');
 const d=classify(warnings+`\nerror[E0432]: toy\n --> ${roots[0]}/${rustFile}:42:1\nnote: toy\n --> ${roots[0]}/${rustFile}:43:1\nhelp: toy\n --> ${roots[0]}/${rustFile}:44:1`);
 assert.deepEqual(d.sites,[{file:rustId,line:42,column:1},{file:rustId,line:43,column:1},{file:rustId,line:44,column:1}]);
 const mixed=classifyBuildFailure({stdout:'error: toy',stderr:` --> ${roots[0]}/${rustFile}:99:1`,roots});assert.deepEqual(mixed.sites,[]);
});

test('best-effort compiler and package phrases yield closed markers without raw text',()=>{
 const d=classify("error: failed to run custom build command for toy\nerror: could not compile toy\nnote: offline mode (via --offline)\nfailed to bundle project\nthread 'main' panicked at toy\nbeforeBuildCommand failed\nnpm error code 1");
 for(const marker of ['BUILD_SCRIPT_FAILED','COMPILE_FAILED','OFFLINE_DEPENDENCY','BUNDLE_FAILED','PANIC','FRONTEND_BUILD_FAILED','NPM_ERROR'])assert.ok(d.markers.includes(marker));
 assert.ok(validateBuildDiagnostic(d));assert.equal(JSON.stringify(d).includes('toy'),false);
 for(const line of ['Running beforeBuildCommand','beforeBuildCommand succeeded','npm notice ok'])assert.equal(classify(line).markers.includes('FRONTEND_BUILD_FAILED'),false);
});

const listPhases=[['test-list-installed-modes','installed-modes','INSTALLED_MODES'],['test-list-source-pins','source-pins','SOURCE_PINS']];

test('test-list diagnostics bind only the two exact listing phases and frozen roots',()=>{
 for(const [phase] of listPhases){
  assert.deepEqual(buildDiagnosticOptions(phase,INPUT_ARCHIVE_SHA256,'/fixture/canonical','/fixture/candidate'),{buildDiagnosticRoots:roots});
  assert.deepEqual(buildDiagnosticOptions(phase,'b'.repeat(64),'/fixture/canonical','/fixture/candidate'),{});
  assert.deepEqual(buildDiagnosticOptions(phase,INPUT_ARCHIVE_SHA256,'relative','/fixture/candidate'),{});
 }
 for(const phase of ['native-tests','test-list-installed-modes-extra','test-list-source-pins-extra',null])assert.deepEqual(buildDiagnosticOptions(phase,INPUT_ARCHIVE_SHA256,'/fixture/canonical','/fixture/candidate'),{});
});

test('both actual failed listing children retain only bounded public hints',async()=>{
 for(const [phase,stage,label] of listPhases){
  const secret='never-display-test-list';
  const diagnostic=`error[E0308]: ${secret}\n --> ${liveRoots[1]}/${rustFile}:17:3\n`;
  const result=await runFixedCommand({...options,phase,capture:'text',args:['-e',`process.stdout.write(${JSON.stringify(secret)});process.stderr.write(${JSON.stringify(diagnostic)});process.exitCode=7;`]});
  assert.equal(result.exitCode,7);assert.equal(result.failure,null);assert.equal(result.text,secret);
  assert.deepEqual(result.buildDiagnostic.rustCodes,['E0308']);
  assert.throws(()=>requireTestListCommandResult(result,stage),error=>{
   const output=formatCampaignFailure(error);
   assert.equal(error.code,'TEST_LIST_GUARD');
   assert.ok(output.includes('SOURCE_NATIVE_TEST_LIST_STAGE_'+label));
   assert.ok(output.includes('SOURCE_NATIVE_TEST_LIST_BOUNDARY_UNACCEPTED_NONZERO'));
   assert.ok(output.includes('SOURCE_NATIVE_TEST_LIST_DIAGNOSTIC '));
   assert.equal(output.includes(secret),false);assert.equal(output.includes(cwd),false);
   return true;
  });
 }
});

test('listing success preserves exact capture and result identity without new hints',async()=>{
 for(const [phase,stage] of listPhases){
  const result=await runFixedCommand({...options,phase,capture:'text',args:['-e','process.stdout.write("frozen list\\n");process.stderr.write("never-display-test-list");']});
  assert.equal(result.text,'frozen list\n');assert.equal(result.exitCode,0);
  assert.equal(Object.hasOwn(result,'buildDiagnostic'),false);
  assert.equal(requireTestListCommandResult(result,stage),result);
 }
});

test('test-list gates preserve every failed-result disposition and closed boundary labels',()=>{
 const base={exitCode:0,failure:null,cleanup:'leader-close-observed'};
 const cases=[
  [null,'INCOHERENT_RESULT'],[{},'INCOHERENT_RESULT'],
  [{...base,exitCode:101},'UNACCEPTED_NONZERO'],
  [{...base,exitCode:null,signal:'SIGKILL'},'SIGNALED'],
  [{...base,failure:'TIMEOUT'},'TIMEOUT'],
  [{...base,failure:'OUTPUT_LIMIT'},'OUTPUT_LIMIT'],
  [{...base,failure:'SPAWN'},'SPAWN_FAILURE'],
  [{...base,failure:'ERROR'},'CHILD_ERROR'],
  [{...base,failure:'LIMIT'},'PORT_LIMIT'],
  [{...base,failure:'INVALID_RESULT'},'INVALID_RESULT'],
  [{...base,failure:'never-display-test-list'},'UNKNOWN_PROCESS_FAILURE'],
  [{...base,cleanup:'unconfirmed'},'COMPLETED'],
 ];
 for(const [,stage,label] of listPhases){
  for(const [result,boundary] of cases)assert.throws(()=>requireTestListCommandResult(result,stage),error=>{
   const output=formatCampaignFailure(error);
   assert.equal(error.code,'TEST_LIST_GUARD');
   assert.ok(output.includes('SOURCE_NATIVE_TEST_LIST_STAGE_'+label));
   assert.ok(output.includes('SOURCE_NATIVE_TEST_LIST_BOUNDARY_'+boundary));
   assert.equal(output.includes('SOURCE_NATIVE_TEST_LIST_CLEANUP_UNCONFIRMED'),result?.cleanup!=='leader-close-observed');
   assert.equal(output.includes('never-display-test-list'),false);
   return true;
  });
  assert.equal(requireTestListCommandResult(base,stage),base);
 }
});

test('test-list formatting refuses unknown stages, forged fields and unrelated error kinds',()=>{
 const secret='never-display-test-list';
 const hint=classify(`error[E0432]: ${secret}\n --> ${roots[0]}/${rustFile}:8:2\n`);
 const unknown=new CampaignError('TEST_LIST_GUARD');unknown.testListStage=secret;unknown.testListDiagnostic=hint;
 assert.equal(formatCampaignFailure(unknown),'SOURCE_NATIVE_TEST_LIST_GUARD');
 const unrelated=new CampaignError('QUALIFY_FAILED');unrelated.testListStage='SOURCE_PINS';unrelated.testListDiagnostic=hint;
 assert.equal(formatCampaignFailure(unrelated),'SOURCE_NATIVE_QUALIFY_FAILED');
 const bad=new CampaignError('TEST_LIST_GUARD');bad.testListStage='SOURCE_PINS';bad.testListBoundary=secret;bad.testListCleanupUnconfirmed=secret;bad.testListDiagnostic={...hint,raw:secret};
 assert.equal(formatCampaignFailure(bad),'SOURCE_NATIVE_TEST_LIST_GUARD\nSOURCE_NATIVE_TEST_LIST_STAGE_SOURCE_PINS');
 assert.throws(()=>requireTestListCommandResult({exitCode:1,cleanup:'leader-close-observed'},secret),error=>{
  assert.equal(formatCampaignFailure(error),'SOURCE_NATIVE_TEST_LIST_GUARD');return true;
 });
});

test('invalid listing UTF-8 retains the existing INVALID_RESULT failure',async()=>{
 const [phase,stage]=listPhases[0];
 const result=await runFixedCommand({...options,phase,capture:'text',args:['-e','process.stdout.write(Buffer.from([255]));process.stderr.write("error[E0308]: never-display-test-list\\n");']});
 assert.equal(result.failure,'INVALID_RESULT');assert.equal(result.exitCode,0);
 assert.equal(Object.hasOwn(result,'buildDiagnostic'),false);
 assert.throws(()=>requireTestListCommandResult(result,stage),error=>{
  const output=formatCampaignFailure(error);assert.ok(output.includes('SOURCE_NATIVE_TEST_LIST_BOUNDARY_INVALID_RESULT'));
  assert.equal(output.includes('never-display-test-list'),false);return true;
 });
 const nonzero=await runFixedCommand({...options,phase,capture:'text',args:['-e','process.stdout.write(Buffer.from([255]));process.stderr.write("error[E0308]: never-display-test-list\\n");process.exitCode=1;']});
 assert.equal(nonzero.failure,'INVALID_RESULT');assert.equal(nonzero.exitCode,1);
 assert.deepEqual(nonzero.buildDiagnostic.rustCodes,['E0308']);
 assert.ok(nonzero.buildDiagnostic.markers.includes('DIAGNOSTIC_INPUT_REFUSED'));
});

test('listing timeout and output overflow remain failed with bounded partial diagnostics',async()=>{
 const [phase,stage]=listPhases[0];
 const timeout=await runFixedCommand({...options,phase,timeoutMs:50,capture:'text',args:['-e','setInterval(()=>{},1000);']});
 assert.equal(timeout.failure,'TIMEOUT');assert.equal(timeout.buildDiagnostic.flags.partial,true);
 assert.throws(()=>requireTestListCommandResult(timeout,stage),error=>{assert.ok(formatCampaignFailure(error).includes('SOURCE_NATIVE_TEST_LIST_BOUNDARY_TIMEOUT'));return true;});
 const overflow=await runFixedCommand({...options,phase,capture:'text',args:['-e',`process.stderr.write("x".repeat(${MAX_DIAGNOSTIC_BYTES+1}));setInterval(()=>{},1000);`]});
 assert.equal(overflow.failure,'OUTPUT_LIMIT');assert.equal(overflow.buildDiagnostic.flags.partial,true);
 assert.ok(JSON.stringify(overflow.buildDiagnostic).length<4096);
 assert.throws(()=>requireTestListCommandResult(overflow,stage),error=>{assert.ok(formatCampaignFailure(error).includes('SOURCE_NATIVE_TEST_LIST_BOUNDARY_OUTPUT_LIMIT'));return true;});
});

test('listing diagnostic-parser failure cannot alter the command refusal',async()=>{
 const [phase,stage]=listPhases[1];const poisoned=[...liveRoots];
 Object.defineProperty(poisoned,0,{get(){throw new Error('never-display-test-list')}});
 const result=await runFixedCommand({...options,phase,capture:'text',buildDiagnosticRoots:poisoned,args:['-e','process.exitCode=1;']});
 assert.equal(result.exitCode,1);assert.equal(result.failure,null);
 assert.deepEqual(result.buildDiagnostic.markers,['DIAGNOSTIC_INPUT_REFUSED']);
 assert.throws(()=>requireTestListCommandResult(result,stage),error=>{
  assert.equal(error.code,'TEST_LIST_GUARD');assert.equal(formatCampaignFailure(error).includes('never-display-test-list'),false);return true;
 });
});
