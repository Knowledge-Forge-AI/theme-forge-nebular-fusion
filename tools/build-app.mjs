import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 2) throw new Error("This command builds the default-feature application without extra arguments");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Application build step failed");
};
for (const [tool, version] of [["rustc", "1.98.0"], ["cargo", "1.98.0"]]) {
  const result = spawnSync(tool, ["--version"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.startsWith(`${tool} ${version} `)) {
    throw new Error(`Enter the locked product-local environment: ${tool} ${version} is required`);
  }
}
if (process.env.RUSTFLAGS && !process.env.CARGO_ENCODED_RUSTFLAGS) {
  throw new Error("Use CARGO_ENCODED_RUSTFLAGS for additional application build flags");
}
const flags = (process.env.CARGO_ENCODED_RUSTFLAGS ?? "").split("\u001f").filter(Boolean);
for (const [source, replacement] of [
  [homedir(), "/build-user"],
  [process.env.CARGO_HOME ? resolve(process.env.CARGO_HOME) : join(homedir(), ".cargo"), "/cargo-home"],
  [root, "/nebular-source"],
  [process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, "src-tauri/target"), "/nebular-target"],
]) flags.push(`--remap-path-prefix=${source}=${replacement}`);
const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\u001f") };
run(process.execPath, [join(root, "tools/release-notices.mjs")], env);
run(process.execPath, [join(root, "node_modules/@tauri-apps/cli/tauri.js"), "build", "--bundles", "app", "--target", "aarch64-apple-darwin"], env);

const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, "src-tauri/target");
const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const app = join(target, "aarch64-apple-darwin/release/bundle/macos", config.productName + ".app");
const executable = join(app, "Contents/MacOS/theme-forge-nebular-fusion");
const bytes = readFileSync(executable);
for (const path of [homedir(), root, target, process.env.CARGO_HOME].filter(Boolean)) {
  if (bytes.includes(Buffer.from(path))) throw new Error("Application executable retains a local build path");
}
// A linker ad-hoc signature does not seal an application's resource envelope.
// Seal only the outer developer bundle; authenticated nested runtimes retain their bytes.
const signing = spawnSync("codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
if (signing.status !== 0) throw new Error("Application signing state could not be inspected");
if (signing.stderr.includes("Signature=adhoc")) {
  run("codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
}
run("codesign", ["--verify", "--deep", "--strict", app]);
console.log("Default-feature app built; local build-path checks passed");
