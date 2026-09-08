import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const studioRoot = resolve(import.meta.dirname, "..");
await rm(resolve(studioRoot, "src-tauri/loom-payload"), { recursive: true, force: true });
await rm(resolve(studioRoot, "public/preview"), { recursive: true, force: true });
console.log("Loom payload and preview cleaned.");
