// @ts-check

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { STUDIO_ACL_TEN_COMMANDS } from "./ci-contract.mjs";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STUDIO_ROOT = existsSync(join(REPO_ROOT, "apps/studio/src-tauri/tauri.conf.json")) ? join(REPO_ROOT, "apps/studio") : REPO_ROOT;

/** @param {Uint8Array} bytes */
function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
/** @param {string} root @param {string} dir @returns {Promise<Array<{path: string, size: number, sha256: string}>>} */
async function inventory(root, dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await inventory(root, full));
    else if (entry.isFile()) { const bytes = await readFile(full); output.push({ path: relative(root, full).replace(/\\/gu, "/"), size: bytes.byteLength, sha256: sha256Hex(bytes) }); }
    else throw new Error(`Bundle contains non-regular entry: ${entry.name}`);
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}
/** @param {string} executable */
async function launchAndTerminate(executable) {
  const child = spawn(executable, [], { env: { HOME: process.env.RUNNER_TEMP ?? tmpdir(), TMPDIR: process.env.RUNNER_TEMP ?? tmpdir(), LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdio: "ignore" });
  await new Promise((done) => setTimeout(done, 3_000));
  if (child.exitCode !== null || child.signalCode !== null) throw new Error("Nebular app exited before the launch observation completed.");
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const result = await Promise.race([
    new Promise((done) => child.once("close", (code, signal) => done({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Nebular app did not terminate within ten seconds.")), 10_000)),
  ]);
  return result;
}

/** @param {{appPath: string, sourceNodePath: string, sourcePayloadPath: string, outputPath: string, launch?: boolean}} options */
export async function verifyNebularBundle(options) {
  const appPath = resolve(options.appPath), contents = join(appPath, "Contents"), macos = join(contents, "MacOS"), resources = join(contents, "Resources");
  const identifier = execFileSync("plutil", ["-extract", "CFBundleIdentifier", "raw", join(contents, "Info.plist")], { encoding: "utf8" }).trim();
  const executableName = execFileSync("plutil", ["-extract", "CFBundleExecutable", "raw", join(contents, "Info.plist")], { encoding: "utf8" }).trim();
  if (identifier !== "ai.knowledgeforge.themeforge.nebularfusion") throw new Error(`Bundle identifier mismatch: ${identifier}`);
  const executablePath = join(macos, executableName), sidecarPath = join(macos, "tfsb-studio-service"), payloadPath = join(resources, "sidecar-payload");
  if (!execFileSync("file", ["-b", executablePath], { encoding: "utf8" }).includes("arm64")) throw new Error("Nebular executable is not arm64.");
  const [sourceNode, packedNode] = await Promise.all([readFile(options.sourceNodePath), readFile(sidecarPath)]);
  if (sha256Hex(sourceNode) !== sha256Hex(packedNode)) throw new Error("Packed sidecar runtime differs from the authenticated Node executable.");
  const [sourcePayload, packedPayload] = await Promise.all([inventory(resolve(options.sourcePayloadPath), resolve(options.sourcePayloadPath)), inventory(payloadPath, payloadPath)]);
  if (JSON.stringify(sourcePayload) !== JSON.stringify(packedPayload)) throw new Error("Packed sidecar payload differs from the prepared payload.");
  const tauri = JSON.parse(await readFile(join(STUDIO_ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  const capability = JSON.parse(await readFile(join(STUDIO_ROOT, "src-tauri/capabilities/main.json"), "utf8"));
  if (typeof tauri.app?.security?.csp !== "string" || !tauri.app.security.csp.includes("object-src 'none'") || !tauri.app.security.csp.includes("frame-ancestors 'none'")) throw new Error("Strict CSP is missing from the bundle source configuration.");
  if (!Array.isArray(capability.permissions) || !capability.permissions.every((/** @type {unknown} */ value) => typeof value === "string")) throw new Error("Bundle capability permissions are invalid.");
  const permissions = capability.permissions.map((/** @type {string} */ value) => value.replace(/^allow-/u, "").replace(/-/gu, "_"));
  if (JSON.stringify(permissions) !== JSON.stringify(STUDIO_ACL_TEN_COMMANDS)) throw new Error("Bundle capability ACL is not the exact ten-command contract.");
  const signingInspection = spawnSync("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" });
  const signingOutput = `${signingInspection.stdout ?? ""}\n${signingInspection.stderr ?? ""}`;
  if (signingInspection.status !== 0) throw new Error("Bundle signing identity could not be inspected.");
  let signatureValid = true;
  try { execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" }); } catch { signatureValid = false; }
  if (!signatureValid) throw new Error("Ad-hoc/local bundle signature verification failed.");
  const launches = options.launch ? [await launchAndTerminate(executablePath), await launchAndTerminate(executablePath)] : [];
  const lingering = options.launch && spawnSync("pgrep", ["-f", sidecarPath], { encoding: "utf8" }).status === 0;
  if (lingering) throw new Error("Packed sidecar remained after the app launch/exit cycles.");
  const receipt = { schema: "tfsb.nebular-bundle-identity", schemaVersion: 1, status: "pass", app: basename(appPath), identifier, executable: { name: executableName, architecture: "arm64", size: (await stat(executablePath)).size, sha256: sha256Hex(await readFile(executablePath)) }, sidecar: { filename: basename(sidecarPath), size: packedNode.byteLength, sha256: sha256Hex(packedNode), payloadFiles: packedPayload.length, payloadEqual: true, reapedAfterLaunches: options.launch ? true : null }, csp: tauri.app.security.csp, acl: STUDIO_ACL_TEN_COMMANDS, signing: { kind: signingOutput.includes("Authority=Apple Development") || signingOutput.includes("Authority=Developer ID") ? "credentialed" : signingOutput.includes("Signature=adhoc") ? "ad-hoc" : "local-unsigned-identity", verified: true }, launches };
  await writeFile(resolve(options.outputPath), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  /** @type {Record<string, string | boolean>} */ const parsed = {};
  for (let index = 0; index < args.length; index += 1) { const flag = args[index], value = args[index + 1]; if (flag === "--launch") parsed.launch = true; else if (flag?.startsWith("--") && value) { parsed[flag.slice(2)] = value; index += 1; } else throw new Error(`Unsupported bundle verification argument: ${flag}`); }
  if (typeof parsed.app !== "string" || typeof parsed.node !== "string" || typeof parsed.payload !== "string" || typeof parsed.output !== "string") throw new Error("--app, --node, --payload, and --output are required.");
  verifyNebularBundle({ appPath: parsed.app, sourceNodePath: parsed.node, sourcePayloadPath: parsed.payload, outputPath: parsed.output, launch: parsed.launch === true })
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
