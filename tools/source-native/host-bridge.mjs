import {spawnSync} from "node:child_process";
import {readFile,realpath} from "node:fs/promises";
import {join,dirname,basename} from "node:path";
import {fileURLToPath} from "node:url";
import {createChildProcessPort} from "./host-inputs.mjs";
export {maintained} from "./maintained-api.mjs";
const tools=dirname(fileURLToPath(import.meta.url));
const temp=await realpath(process.env.RUNNER_TEMP);
const spec=JSON.parse(await readFile(join(temp,"nebular-source-native/spec.json"),"utf8"));
if (!/^python(?:3(?:\.13)?)?$/.test(basename(spec.tools.python)))throw Error("HOST_ARCHIVE_PYTHON_REFUSED");
const port=createChildProcessPort({timeoutMs:600_000,killGraceMs:2_000});
export const ports={run:port.run,archive:{extractVerified:async({archivePath,archiveSha256,destination})=>{
 const result=spawnSync(spec.tools.python,["-B",join(tools,"unpack-native-inputs.py"),"--archive",archivePath,"--sha256",archiveSha256,"--output",destination],
  {env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"},encoding:"utf8",timeout:30000,maxBuffer:1024*1024});
 if(result.status!==0||result.error)throw Error("HOST_ARCHIVE_EXTRACTION_REFUSED");
 return JSON.parse(result.stdout);
}}};
