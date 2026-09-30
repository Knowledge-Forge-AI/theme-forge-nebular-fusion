#!/usr/bin/env node
// Native release-candidate smoke harness.
//
// Launches the exact extracted candidate executable in its compiled-in release smoke mode
// (src-tauri/src/release_smoke), which opens the real window and packaged frontend, drives the real
// JS-to-Rust command bridge and embedded sidecar, writes a receipt and quits. This harness only
// prepares scratch state and fixtures from maintained public fixtures, launches, and judges:
//
//   * the receipt: schema, scenario, every required step, and the SHA-256 of the running executable,
//     which must equal the candidate executable measured before launch (no other binary ran);
//   * no orphan: after exit no process whose executable lies inside the candidate remains;
//   * no persistent user state: HOME, XDG and TMPDIR point into scratch, and the real user's
//     application directories for this identifier are unchanged;
//   * fixture effects: the case-exact derived output (scenario C) and untouched siblings.
//
// Scenario C-signal instead leaves the sidecar running, then sends SIGTERM to the application process
// only; the sidecar must exit on its own (stdin EOF) within a bound.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularSnapshot } from "./fs-snapshot.mjs";

export const APPLICATION_IDENTIFIER = "ai.knowledgeforge.themeforge.nebularfusion";
export const RECEIPT_SCHEMA = "nebular.release-smoke-receipt-v1";
export const RUN_SCHEMA = "nebular.native-rc-smoke-run-v1";
export const SCENARIOS = Object.freeze({
  A: Object.freeze({ platforms: ["darwin-arm64"], steps: ["app-shell", "host-start", "host-status", "project-open", "brand-read", "theme-lab-compile", "app-theme-status", "app-theme-compile", "brand-system-view", "host-status-final"] }),
  B: Object.freeze({ platforms: ["linux-arm64"], caseSensitive: true, steps: ["app-shell", "app-theme-status", "app-theme-compile", "theme-lab-compile", "brand-system-view", "host-start", "host-status", "project-open-upper", "brand-read-upper", "project-open-lower", "brand-read-lower", "host-status-final"] }),
  C: Object.freeze({ platforms: ["linux-x64"], caseSensitive: true, steps: ["app-shell", "host-start", "host-start-idempotent", "host-stop", "host-start-again", "host-status", "project-open-case", "derive-plan-cancel", "derive-plan-apply", "host-status-final"] }),
  "C-signal": Object.freeze({ platforms: ["linux-x64"], caseSensitive: true, signal: true, steps: ["app-shell", "host-start", "host-start-idempotent", "host-stop", "host-start-again", "host-status", "project-open-case", "derive-plan-cancel", "derive-plan-apply", "host-status-final"] }),
});
export const PLATFORM_SCENARIOS = Object.freeze({ "darwin-arm64": ["A"], "linux-arm64": ["B"], "linux-x64": ["C", "C-signal"] });
const CORE_FIXTURE = "docs/examples/v0.4/brand-system/core-minimal";
const DEFAULT_TIMEOUT_MS = 420_000;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function executablePath(launchRoot, platform) {
  return platform.startsWith("darwin")
    ? join(launchRoot, "Theme Forge Nebular Fusion.app/Contents/MacOS/theme-forge-nebular-fusion")
    : join(launchRoot, "bin/theme-forge-nebular-fusion");
}

function ownerOnlyDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function inventory(root) {
  const files = {};
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path);
      const key = relative(root, path).split(sep).join("/");
      if (info.isSymbolicLink()) files[key] = `link:${readlinkSync(path)}`;
      else if (info.isDirectory()) { files[`${key}/`] = "dir"; visit(path); }
      else files[key] = readRegularSnapshot(path, { label: "Observed member", maxBytes: 256 * 1024 * 1024 }).sha256;
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function diffInventories(before, after) {
  const added = Object.keys(after).filter((key) => !(key in before)).sort();
  const removed = Object.keys(before).filter((key) => !(key in after)).sort();
  const changed = Object.keys(after).filter((key) => key in before && before[key] !== after[key]).sort();
  return { added, removed, changed, unchanged: added.length + removed.length + changed.length === 0 };
}

export function caseSensitive(dir) {
  const probe = mkdtempSync(join(dir, "case-probe-"));
  try {
    mkdirSync(join(probe, "Probe"));
    try { mkdirSync(join(probe, "probe")); } catch { return false; }
    return readdirSync(probe).length === 2;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

function copyProject(checkout, destination, name) {
  cpSync(join(checkout, CORE_FIXTURE), destination, { recursive: true, errorOnExist: true, force: false });
  const projectToml = join(destination, ".tfsb/project.toml");
  const original = readFileSync(projectToml, "utf8");
  if (!original.includes('name = "core-fixture"')) throw new Error("maintained core fixture project name changed");
  writeFileSync(projectToml, original.replace('name = "core-fixture"', `name = "${name}"`));
}

// Derive-ready variant of the maintained core fixture (as tools/sidecar-transcript.mjs prepares it):
// tokens and recipes enabled, one recipe deriving a dark mark from the light source mark.
function deriveProject(checkout, destination, name) {
  copyProject(checkout, destination, name);
  rmSync(join(destination, ".tfsb/brand-package.toml"), { force: true });
  writeFileSync(join(destination, ".tfsb/brand.toml"), `schema = "tfsb.brand"\nschema_version = 1\nenabled_domains = { tokens = true, recipes = true, qa = false, consumer_profiles = false, package = false, exports = false }\n\n[[families]]\nid = "fixture-fam"\nname = "Fixture Family"\nrequired_roles = []\noptional_roles = ["mark"]\n\n[[variants]]\nfamily = "fixture-fam"\nid = "light"\nbackgrounds = ["light"]\ncolor_mode = "full-color"\nscale = "standard"\nstatus = "primary"\n\n[[variants]]\nfamily = "fixture-fam"\nid = "derived-dark"\nbackgrounds = ["dark"]\ncolor_mode = "reversed"\nscale = "standard"\nstatus = "primary"\n\n[[bindings]]\nfamily = "fixture-fam"\nrole = "mark"\nvariant = "light"\nasset = "fixture-mark-on-light"\nauthority = "source"\n\n[[bindings]]\nfamily = "fixture-fam"\nrole = "mark"\nvariant = "derived-dark"\nasset = "fixture-mark-derived-dark"\nauthority = "derived"\n`);
  writeFileSync(join(destination, ".tfsb/brand-tokens.toml"), `schema = "tfsb.brand-tokens"\nschema_version = 1\n\n[[colors]]\nid = "brand-blue"\nvalue = "#0066CCFF"\n`);
  writeFileSync(join(destination, ".tfsb/brand-recipes.toml"), `schema = "tfsb.brand-recipes"\nschema_version = 1\n\n[[recipes]]\nid = "recipe-derived-dark"\ntarget_asset = "fixture-mark-derived-dark"\nsource_asset = "fixture-mark-on-light"\n\n[[recipes.operations]]\noperation = "replace-paint"\nchannel = "fill"\nsource_color = "#000000FF"\nreplacement_token = "brand-blue"\nexpected_occurrences = 1\n\n[[recipes.operations]]\noperation = "copy-accessibility"\npolicy = "preserve"\n`);
}

/** Prepares the scenario fixtures inside the smoke directory; returns the fixture roots to observe. */
export function prepareFixtures(scenario, checkout, smokeDir) {
  const fixtures = join(smokeDir, "fixtures");
  mkdirSync(fixtures, { mode: 0o700 });
  if (SCENARIOS[scenario].caseSensitive && !caseSensitive(fixtures)) {
    throw new Error(`scenario ${scenario} requires a case-sensitive filesystem`);
  }
  if (scenario === "A") {
    copyProject(checkout, join(fixtures, "core-minimal"), "core-fixture");
    return { observed: { "core-minimal": join(fixtures, "core-minimal") } };
  }
  if (scenario === "B") {
    const parent = join(fixtures, "Nebular Smoke Ünïcode");
    mkdirSync(parent);
    copyProject(checkout, join(parent, "Project Ω"), "nebular-smoke-upper");
    copyProject(checkout, join(parent, "project Ω"), "nebular-smoke-lower");
    // The case-distinct sibling carries its own family name (package domain off, as the derive fixture),
    // so each brand read proves which project the sidecar opened.
    const lowerBrand = join(parent, "project Ω", ".tfsb/brand.toml");
    const brand = readFileSync(lowerBrand, "utf8");
    if (!brand.includes('name = "Core Fixture Brand"') || !brand.includes("package = true")) throw new Error("maintained core fixture brand changed");
    writeFileSync(lowerBrand, brand.replace('name = "Core Fixture Brand"', 'name = "Nebular Smoke Lower Brand"').replace("package = true", "package = false"));
    rmSync(join(parent, "project Ω", ".tfsb/brand-package.toml"), { force: true });
    return { observed: { upper: join(parent, "Project Ω"), lower: join(parent, "project Ω") } };
  }
  const parent = join(fixtures, "Derive Target");
  mkdirSync(parent);
  deriveProject(checkout, join(parent, "Case"), "nebular-derive-upper");
  deriveProject(checkout, join(parent, "case"), "nebular-derive-lower");
  return { observed: { upper: join(parent, "Case"), lower: join(parent, "case") } };
}

/** The real user's application state locations for this identifier (outside the scratch HOME). */
export function persistentStateLocations(platform, home = homedir()) {
  const names = [APPLICATION_IDENTIFIER, "Theme Forge Nebular Fusion", "theme-forge-nebular-fusion"];
  const bases = platform.startsWith("darwin")
    ? ["Library/Caches", "Library/Application Support", "Library/WebKit", "Library/Logs", "Library/HTTPStorages", "Library/Saved Application State", "Library/Preferences"]
    : [".cache", ".local/share", ".config", ".local/state"];
  return bases.flatMap((base) => names.flatMap((name) => [join(home, base, name), join(home, base, `${name}.plist`), join(home, base, `${name}.savedState`)]));
}

function snapshotLocations(locations) {
  return Object.fromEntries(locations.map((path) => [path, existsSync(path) ? inventory(lstatSync(path).isDirectory() ? path : dirname(path)) : null]));
}

// Processes whose executable lies inside the candidate: the GUI, its sidecar and runner children.
export function candidateProcesses(launchRoot) {
  const root = realpathSync(launchRoot);
  const found = [];
  if (process.platform === "linux") {
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const exe = readlinkSync(`/proc/${pid}/exe`);
        if (exe === root || exe.startsWith(root + sep)) found.push({ pid: Number(pid), exe });
      } catch { /* exited or not ours */ }
    }
  } else {
    const listing = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
    for (const line of listing.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match && (match[2].startsWith(root + sep) || match[2].includes(` ${root}${sep}`))) found.push({ pid: Number(match[1]), exe: match[2] });
    }
  }
  return found.filter((entry) => entry.pid !== process.pid);
}

/** Resolves with the promise's value, or null once `ms` elapse; the timer is always cleared so it never holds the process open. */
export async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((done) => { timer = setTimeout(() => done(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(check, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  return check();
}

function readReceipt(smokeDir) {
  const path = join(smokeDir, "receipt.json");
  const snapshot = readRegularSnapshot(path, { missingOk: true, label: "Smoke receipt", maxBytes: 4 * 1024 * 1024 });
  return snapshot ? { receipt: JSON.parse(snapshot.bytes.toString("utf8")), sha256: snapshot.sha256, mode: snapshot.mode & 0o777 } : null;
}

export function judgeReceipt(record, { scenario, platform, executableSha256, pid }) {
  const problems = [];
  if (!record) return ["no receipt was written"];
  const { receipt, mode } = record;
  if (mode !== 0o600) problems.push(`receipt mode ${mode.toString(8)}`);
  if (receipt.schema !== RECEIPT_SCHEMA) problems.push("receipt schema");
  if (receipt.scenario !== scenario) problems.push(`receipt scenario ${receipt.scenario}`);
  if (receipt.status !== "pass") problems.push(`receipt status ${receipt.status}: ${receipt.failure ?? ""}`);
  if (pid !== undefined && receipt.pid !== pid) problems.push(`receipt pid ${receipt.pid} is not the launched process ${pid}`);
  const triple = { "darwin-arm64": "aarch64-apple-darwin", "linux-arm64": "aarch64-unknown-linux-gnu", "linux-x64": "x86_64-unknown-linux-gnu" }[platform];
  if (receipt.target !== triple) problems.push(`receipt target ${receipt.target}`);
  if (receipt.executable?.sha256 !== executableSha256) problems.push("the running executable is not the candidate executable");
  const steps = receipt.driver?.steps ?? [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const id of SCENARIOS[scenario].steps) {
    if (!byId.get(id)?.ok) problems.push(`required step ${id} ${byId.has(id) ? "failed" : "missing"}: ${byId.get(id)?.detail ?? ""}`);
  }
  if (Boolean(receipt.awaitingSignal) !== Boolean(SCENARIOS[scenario].signal)) problems.push("receipt signal expectation");
  return problems;
}

/**
 * Runs one scenario against one extracted candidate.
 * @param {{ platform: string, scenario: string, launchRoot: string, checkout: string, evidenceDir: string, source?: "raw-archive"|"npm-package", label?: string, timeoutMs?: number, keep?: boolean }} options
 */
export async function runSmoke(options) {
  const { platform, scenario } = options;
  if (!SCENARIOS[scenario] || !SCENARIOS[scenario].platforms.includes(platform)) throw new Error(`scenario ${scenario} is not defined for ${platform}`);
  const launchRoot = realpathSync(resolve(options.launchRoot));
  const checkout = resolve(options.checkout);
  const evidenceDir = resolve(options.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });
  const label = options.label ?? `${platform}-${scenario}`;
  const executable = executablePath(launchRoot, platform);
  const measured = readRegularSnapshot(executable, { label: "Candidate executable", maxBytes: 1024 * 1024 * 1024 });
  if (!measured.executable) throw new Error("candidate executable is not executable");

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "nebular-rc-smoke-")));
  const home = ownerOnlyDir(join(scratch, "home"));
  const temp = ownerOnlyDir(join(scratch, "tmp"));
  const smokeDir = ownerOnlyDir(join(temp, "nebular-release-smoke"));
  const xdg = Object.fromEntries(["config", "cache", "data", "state", "runtime"].map((name) => [name, ownerOnlyDir(join(scratch, "xdg", name))]));
  const result = { schema: RUN_SCHEMA, label, platform, scenario, source: options.source ?? null, executable: { path: relative(launchRoot, executable), sha256: measured.sha256, size: measured.size }, checks: {}, problems: [] };
  const started = Date.now();
  try {
    const fixtures = prepareFixtures(scenario, checkout, smokeDir);
    const fixturesBefore = Object.fromEntries(Object.entries(fixtures.observed).map(([name, path]) => [name, inventory(path)]));
    const locations = persistentStateLocations(platform);
    const persistentBefore = snapshotLocations(locations);
    const preexisting = candidateProcesses(launchRoot);
    if (preexisting.length) throw new Error(`candidate processes already running: ${JSON.stringify(preexisting)}`);

    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home, TMPDIR: temp, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC",
      XDG_CONFIG_HOME: xdg.config, XDG_CACHE_HOME: xdg.cache, XDG_DATA_HOME: xdg.data, XDG_STATE_HOME: xdg.state, XDG_RUNTIME_DIR: xdg.runtime,
      TFNF_RELEASE_SMOKE_DIR: smokeDir,
    };
    for (const key of ["DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY", "XAUTHORITY", "WEBKIT_DISABLE_COMPOSITING_MODE", "WEBKIT_DISABLE_DMABUF_RENDERER", "LIBGL_ALWAYS_SOFTWARE", "GDK_BACKEND"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const log = { stdout: [], stderr: [] };
    const child = spawn(executable, [`--nebular-release-smoke=${scenario}`], { cwd: home, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => log.stdout.push(chunk));
    child.stderr.on("data", (chunk) => log.stderr.push(chunk));
    const exited = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
    let exit;
    let signalSent = null;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (SCENARIOS[scenario].signal) {
      const awaiting = await waitUntil(() => readReceipt(smokeDir)?.receipt?.awaitingSignal === true || child.exitCode !== null, timeout, 250);
      const live = candidateProcesses(launchRoot);
      result.checks.processesBeforeSignal = live.map((entry) => ({ pid: entry.pid, exe: entry.exe }));
      result.checks.sidecarRunningBeforeSignal = live.some((entry) => entry.pid !== child.pid && entry.exe.includes("tfsb-studio-service"));
      if (awaiting && child.exitCode === null) {
        process.kill(child.pid, "SIGTERM"); // the application process only, never its group
        signalSent = { signal: "SIGTERM", at: Date.now() - started };
      }
      exit = await within(exited, 30_000);
    } else {
      exit = await within(exited, timeout);
    }
    if (!exit) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      exit = await exited;
      result.problems.push("the application did not exit within its bound and was killed");
    }
    result.exit = { ...exit, signalSent, durationMs: Date.now() - started };
    writeFileSync(join(evidenceDir, `${label}.stdout.log`), Buffer.concat(log.stdout));
    writeFileSync(join(evidenceDir, `${label}.stderr.log`), Buffer.concat(log.stderr));

    const orphans = await waitUntil(() => { const live = candidateProcesses(launchRoot); return live.length === 0 ? [] : null; }, 15_000, 250) ?? candidateProcesses(launchRoot);
    result.checks.orphans = orphans.map((entry) => ({ pid: entry.pid, exe: entry.exe }));
    if (orphans.length) {
      result.problems.push(`orphan candidate processes remained: ${orphans.map((entry) => entry.pid).join(", ")}`);
      for (const entry of orphans) { try { process.kill(entry.pid, "SIGKILL"); } catch { /* gone */ } }
    }
    if (SCENARIOS[scenario].signal) {
      if (!signalSent) result.problems.push("the signal scenario never reached its signal point");
      if (!result.checks.sidecarRunningBeforeSignal) result.problems.push("no sidecar was running when the application was terminated");
      if (exit.signal !== "SIGTERM") result.problems.push(`application ended by ${exit.signal ?? `exit ${exit.code}`} instead of SIGTERM`);
    } else if (exit.code !== 0) {
      result.problems.push(`application exit code ${exit.code} signal ${exit.signal}`);
    }

    const record = readReceipt(smokeDir);
    if (record) writeFileSync(join(evidenceDir, `${label}.receipt.json`), `${JSON.stringify(record.receipt, null, 2)}\n`);
    result.receipt = record ? { sha256: record.sha256, status: record.receipt.status, steps: (record.receipt.driver?.steps ?? []).map((step) => ({ id: step.id, ok: step.ok, via: step.via, ms: step.ms })) } : null;
    result.problems.push(...judgeReceipt(record, { scenario, platform, executableSha256: measured.sha256, pid: child.pid }));

    const fixturesAfter = Object.fromEntries(Object.entries(fixtures.observed).map(([name, path]) => [name, inventory(path)]));
    result.checks.fixtureEffects = Object.fromEntries(Object.keys(fixturesBefore).map((name) => [name, diffInventories(fixturesBefore[name], fixturesAfter[name])]));
    if (scenario.startsWith("C")) {
      const upper = result.checks.fixtureEffects.upper;
      if (upper.unchanged || !upper.added.some((path) => path.includes("fixture-mark-derived-dark"))) result.problems.push("the derived asset was not written to the case-exact project");
      if (!result.checks.fixtureEffects.lower.unchanged) result.problems.push("the case-distinct sibling project was modified");
    } else {
      for (const [name, effect] of Object.entries(result.checks.fixtureEffects)) if (!effect.unchanged) result.problems.push(`read-only fixture ${name} was modified`);
    }

    const persistentAfter = snapshotLocations(locations);
    const persistentChanges = locations.filter((path) => JSON.stringify(persistentBefore[path]) !== JSON.stringify(persistentAfter[path]));
    result.checks.persistentUserState = { locations: locations.length, changed: persistentChanges };
    if (persistentChanges.length) result.problems.push(`persistent user state changed: ${persistentChanges.join(", ")}`);
    result.checks.scratchHomeWrites = Object.keys(inventory(home)).length;

    const after = readRegularSnapshot(executable, { label: "Candidate executable", maxBytes: 1024 * 1024 * 1024 });
    if (after.sha256 !== measured.sha256) result.problems.push("the candidate executable changed during the smoke run");
  } catch (error) {
    result.problems.push(`harness error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!options.keep) rmSync(scratch, { recursive: true, force: true });
  }
  result.status = result.problems.length === 0 ? "pass" : "fail";
  writeFileSync(join(evidenceDir, `${label}.run.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--keep") { options.keep = true; continue; }
    const key = { "--platform": "platform", "--scenario": "scenario", "--launch-root": "launchRoot", "--checkout": "checkout", "--evidence": "evidenceDir", "--label": "label", "--timeout-ms": "timeoutMs", "--source": "source" }[flag];
    if (!key || value === undefined) throw new Error(`Usage: native-rc-smoke.mjs --platform <p> --scenario <s> --launch-root <dir> --checkout <dir> --evidence <dir> [--label l] [--timeout-ms n] [--keep]`);
    options[key] = key === "timeoutMs" ? Number(value) : value;
    index += 1;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSmoke(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ label: result.label, status: result.status, problems: result.problems })}\n`);
    if (result.status !== "pass") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

