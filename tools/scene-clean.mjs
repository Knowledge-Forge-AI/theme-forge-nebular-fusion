// Removes only the fixed, fully authenticated generated scene payload.
import { rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyScenePayload } from "./scene-prepare.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../src-tauri");
await verifyScenePayload(join(root,"scene-payload"),join(root,"binaries/tfsb-studio-service-aarch64-apple-darwin"));
await rm(join(root,"scene-payload"),{recursive:true});
