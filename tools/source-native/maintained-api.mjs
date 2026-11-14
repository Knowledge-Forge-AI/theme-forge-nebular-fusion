import {realpath} from "node:fs/promises";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const temp=await realpath(process.env.RUNNER_TEMP);
const root=join(temp,"nebular-source-native/bootstrap/extracted/studio/tools");
const api={};for(const name of ["candidate-provenance.mjs","create-build-inputs.mjs","build-inputs.mjs","material-profile-admission.mjs"]){
 for(const [key,value] of Object.entries(await import(pathToFileURL(join(root,name))))){
  if(Object.hasOwn(api,key)&&api[key]!==value)throw Error("MAINTAINED_EXPORT_CONFLICT");
  api[key]=value;
 }
}
export const maintained=Object.freeze(api);
export const {loadBuildInputs,validateBuildInputs,verifySourceTree,sourceBuildPathPolicy,sourcePathRemapFlags,verifyBuildInputReceipt,validateBuildReceipt,inventoryTree}=maintained;
export default maintained;
