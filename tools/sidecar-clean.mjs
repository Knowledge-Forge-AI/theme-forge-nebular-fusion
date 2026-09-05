import { resolve } from "node:path";
import { cleanSidecar, repositoryRootForStudio } from "./sidecar-common.mjs";

const repositoryRoot = repositoryRootForStudio(resolve(import.meta.dirname, ".."));
await cleanSidecar(repositoryRoot);
