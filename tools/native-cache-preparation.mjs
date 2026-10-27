import { cp, chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function makeWritable(path) {
  const info = await stat(path);
  await chmod(path, info.mode | 0o200 | (info.isDirectory() ? 0o100 : 0));
  if (info.isDirectory()) for (const entry of await readdir(path)) await makeWritable(join(path, entry));
}

async function copyCache(requestedCache, destination, name) {
  if (requestedCache === undefined) return;
  if (typeof requestedCache !== "string") throw new Error(`${name} cache locator must be a path`);
  const selectedCache = await realpath(requestedCache);
  for (const member of (await readdir(selectedCache)).sort()) {
    if (typeof member !== "string") throw new Error(`${name} cache member is invalid`);
    await cp(join(selectedCache, member), join(destination, member), {
      recursive: true, dereference: true, force: false, errorOnExist: true,
    });
  }
  await makeWritable(destination);
}

async function requireAbsent(path) {
  try {
    const info = await lstat(path);
    throw new Error(`fresh Cargo destination already exists: ${path} (${info.isSymbolicLink() ? "symlink" : "entry"})`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function ensureOwnedDirectory(path, name) {
  try {
    await mkdir(path, { recursive: false });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${name} destination must be a real directory`);
    }
  }
}

/**
 * Prepare the fresh per-build cache namespace or select an already
 * authenticated owner-controlled Cargo home.  The explicit branch never
 * opens or mutates the existing Cargo home.
 * @param {string} work
 * @param {Record<string, unknown>} execution
 * @param {{content?: string}|null|undefined} cargoConfig
 * @param {{mode: "default-copy"|"direct-existing", cargoHome: string}} selectedCargoHome
 * @returns {Promise<{npmCache: string, cargoHome: string}>}
 */
export async function prepareNativeWorkingCaches(work, execution, cargoConfig, selectedCargoHome) {
  if (!selectedCargoHome || !["default-copy", "direct-existing"].includes(selectedCargoHome.mode)) {
    throw new Error("Unsupported Cargo home selection");
  }
  const npmCache = join(work, "npm-cache");
  await ensureOwnedDirectory(npmCache, "npm-cache");
  await copyCache(execution.npmCache, npmCache, "npmCache");

  const freshCargoHome = join(work, "cargo-home");
  if (selectedCargoHome.mode === "direct-existing") {
    await requireAbsent(freshCargoHome);
    return { npmCache, cargoHome: selectedCargoHome.cargoHome };
  }

  const cargoHome = join(work, "cargo-home");
  await ensureOwnedDirectory(cargoHome, "Cargo home");
  await copyCache(execution.cargoHome, cargoHome, "cargoHome");
  if (execution.cargoHome) {
    await rm(join(cargoHome, "config"), { force: true });
    await rm(join(cargoHome, "config.toml"), { force: true });
  }
  if (cargoConfig?.content !== undefined) await writeFile(join(cargoHome, "config.toml"), cargoConfig.content);
  return { npmCache, cargoHome };
}

