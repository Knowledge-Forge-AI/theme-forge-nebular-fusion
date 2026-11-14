// Rebind passed extraction to actual saved inputs and the bridge's member map.
// This does not parse TAR; unpack-native-inputs.py owns that boundary.
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function deriveBridgeMembers({archive,extractedRoot,extractionReceipt,maintained}){
  if(extractionReceipt?.schema!=='nebular.native-input-extraction.v1'||extractionReceipt.status!=='passed-inputs-only'||extractionReceipt.executedMembers!==false||extractionReceipt.nativeBuild!==false)throw Error('EXTRACTION_PROOF_REQUIRED');
  const archiveRead=maintained.readRegularSnapshot(archive,{maxBytes:64*1024*1024});
  if(archiveRead.sha256!==extractionReceipt.archiveSha256)throw Error('EXTRACTION_ARCHIVE_MISMATCH');
  const record=maintained.readRegularSnapshot(join(extractedRoot,'bundle-manifest.json'),{maxBytes:2*1024*1024});
  if(record.sha256!==extractionReceipt.manifestSha256)throw Error('EXTRACTION_MANIFEST_MISMATCH');
  const manifest=maintained.parseStrictJsonRecord(record.bytes);
  if(manifest.schema!=='nebular.native-material-input-bundle.v1'||!Array.isArray(manifest.files)||manifest.studio?.root!=='studio'
      ||Object.keys(manifest.components??{}).sort().join(',')!=='burst,loom,solar'
      ||Object.entries(manifest.components).some(([name,row])=>row.sourceRoot!==`component-sources/${name}`||row.outputRoot!==`component-outputs/${name}`))throw Error('EXTRACTION_MANIFEST_SCHEMA');
  const observed=await maintained.inventoryTree(extractedRoot);
  if(observed.files.length!==extractionReceipt.members||observed.files.length!==manifest.files.length+1)throw Error('EXTRACTION_MEMBER_COUNT');
  const files=new Map(observed.files.map(file=>[file.path,file]));
  const declared=new Set();
  let declaredBytes=0;
  for(const row of manifest.files){
    const actual=files.get(row.path);
    if(row.path==='bundle-manifest.json'||typeof row.mode!=='string'||!['100644','100755'].includes(row.mode)||declared.has(row.path)||!actual||actual.sha256!==row.sha256||actual.bytes!==row.bytes||actual.mode!==parseInt(row.mode.slice(-3),8))throw Error('EXTRACTION_MEMBER_MISMATCH');
    declared.add(row.path);
    declaredBytes+=row.bytes;
  }
  if(declaredBytes!==extractionReceipt.bytes)throw Error('EXTRACTION_BYTE_TOTAL');
  if(!files.has('bundle-manifest.json'))throw Error('EXTRACTION_MANIFEST_MISSING');
  const studio=await maintained.inventoryTree(join(extractedRoot,manifest.studio.root));
  if(studio.identity!==manifest.studio.composition)throw Error('EXTRACTION_STUDIO_IDENTITY');
  for(const component of Object.values(manifest.components)){
    if((await maintained.inventoryTree(join(extractedRoot,component.sourceRoot))).identity!==component.source
      ||(await maintained.inventoryTree(join(extractedRoot,component.outputRoot))).identity!==component.output)throw Error('EXTRACTION_COMPONENT_IDENTITY');
  }
  const members=observed.files.map(({path,bytes,sha256})=>({path,bytes,sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const body={schema:'nebular.source-input-archive-members-v1',members,totalBytes:members.reduce((n,file)=>n+file.bytes,0)};
  return {...body,identity:maintained.identity(body)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const [archive,extractedRoot,proof,toolsRoot,output,...extra]=process.argv.slice(2);
    if(!output||extra.length)throw Error('EXTRACTION_ARGUMENTS');
    const provenance=await import(pathToFileURL(join(toolsRoot,'candidate-provenance.mjs')));
    const snapshot=await import(pathToFileURL(join(toolsRoot,'fs-snapshot.mjs')));
    const material=await import(pathToFileURL(join(toolsRoot,'material-profile-admission.mjs')));
    const record=await deriveBridgeMembers({archive,extractedRoot,extractionReceipt:JSON.parse(await readFile(proof,'utf8')),
      maintained:{...provenance,parseStrictJsonRecord:material.parseStrictJsonRecord,readRegularSnapshot:snapshot.readRegularSnapshot}});
    await writeFile(output,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({status:'passed-saved-input-members-only',members:record.members.length,identity:record.identity,nativeBuild:false}));
  }catch(error){
    const code=error instanceof Error&&/^EXTRACTION_[A-Z_]+$/.test(error.message)?error.message:'EXTRACTION_REBINDING_REFUSED';
    console.error(JSON.stringify({status:'refused',code}));process.exitCode=1;
  }
}
