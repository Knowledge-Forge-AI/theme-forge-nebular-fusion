import {open,constants} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const REQUIRED_INSTALLED_MODE_TESTS=Object.freeze([
  'sidecar::artifact::tests::installed_modes_allow_only_exact_or_complete_write_bit_removal',
  'sidecar::artifact::tests::installed_modes_accept_exact_and_readonly_verification',
  'sidecar::artifact::tests::installed_modes_reject_other_modes_bytes_and_inventory',
  'sidecar::artifact::tests::installed_modes_revalidate_retained_identity',
]);
const MAX_BYTES=1024*1024;
export const REQUIRED_SOURCE_PIN_TESTS=Object.freeze([
  'sidecar::artifact::tests::source_build_scene_and_loom_pins_use_closed_typed_bindings',
  'sidecar::artifact::tests::source_build_compiled_pins_reject_resealed_native_identity',
]);

/** Fixed Rust1.98 test-list contract; this does not run or accept the tests. */
export function assertInstalledModeTests(text){
  return assertExactTests(text,REQUIRED_INSTALLED_MODE_TESTS);
}
export function assertSourcePinTests(text){
  return assertExactTests(text,REQUIRED_SOURCE_PIN_TESTS);
}
function assertExactTests(text,required){
  if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)throw Error('NATIVE_TEST_LIST_LIMIT');
  const lines=text.split(/\r?\n/).filter(line=>line.length>0);
  if(lines.length!==required.length+1)throw Error('NATIVE_TEST_LIST_SHAPE');
  const summary=lines.at(-1);
  if(summary!==`${required.length} tests, 0 benchmarks`)throw Error('NATIVE_TEST_LIST_COUNT');
  const names=lines.slice(0,-1).map(line=>line.endsWith(': test')?line.slice(0,-6):'');
  if(new Set(names).size!==required.length||required.some(name=>!names.includes(name)))throw Error('NATIVE_REQUIRED_TEST_MISSING');
  return {schema:'nebular.required-native-test-presence.v1',status:'present-not-yet-executed',tests:required.length,names:required};
}

export async function inspectNativeTestList(path,group='installed-modes'){
  if(!['installed-modes','source-pins'].includes(group))throw Error('NATIVE_TEST_LIST_GROUP');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await file.stat();
    if(!before.isFile()||before.size>MAX_BYTES)throw Error('NATIVE_TEST_LIST_LIMIT');
    const bytes=Buffer.alloc(MAX_BYTES+1);
    const {bytesRead}=await file.read(bytes,0,bytes.length,0);
    const after=await file.stat();
    if(bytesRead!==before.size||after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('NATIVE_TEST_LIST_CHANGED');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytesRead));
    return group==='source-pins'?assertSourcePinTests(text):assertInstalledModeTests(text);
  }finally{await file.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2);
    if(args.length===1)console.log(JSON.stringify(await inspectNativeTestList(args[0])));
    else if(args.length===3&&args[0]==='--group')console.log(JSON.stringify(await inspectNativeTestList(args[2],args[1])));
    else throw Error('NATIVE_TEST_LIST_ARGUMENTS');
  }catch(error){
    const code=error instanceof Error&&/^NATIVE_[A-Z_]+$/.test(error.message)?error.message:'NATIVE_TEST_LIST_REFUSED';
    console.error(JSON.stringify({status:'refused',code}));process.exitCode=1;
  }
}
