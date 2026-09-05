import { resolve } from "node:path";
import { preparationOptions, prepareSidecar, repositoryRootForStudio } from "./sidecar-common.mjs";

const repositoryRoot = repositoryRootForStudio(resolve(import.meta.dirname, ".."));
try {
  console.log(JSON.stringify(await prepareSidecar(preparationOptions(process.argv.slice(2), repositoryRoot))));
} catch {
  console.error("TFSB Studio sidecar preparation failed");
  process.exitCode = 1;
}
