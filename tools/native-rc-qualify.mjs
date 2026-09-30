#!/usr/bin/env node
// Machine qualification of one compiled native payload before it is packaged.
//
// Common: target executable header; the maintained launcher bytes; the bundled sidecar is exactly the
// authenticated embedded Node runtime for the target; every Tauri resource directory equals the
// prepared directory it was built from.
// Linux: 0755 executables; 64-bit little-endian ELF of the target machine; every needed shared library
// resolves (ldd); the glibc floor is the highest GLIBC_ symbol version the executables require, and it
// must not exceed the floor of the pinned build environment.
// Darwin: arm64 Mach-O; the finalized legal notices and launcher; strict deep codesign verification.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryTree } from "./candidate-provenance.mjs";
import { readRegularSnapshot } from "./fs-snapshot.mjs";
import { nativeLauncher } from "./native-launcher.mjs";
import { NODE_RELEASE_IDENTITY } from "./node-runtime-authority.mjs";
import { PLATFORMS, verifyNativeExecutableHeader } from "./native-rc-package.mjs";
import { resourceDirectories } from "./platform-targets.mjs";

export const GLIBC_CEILING = "2.36"; // Debian 12 (bookworm), the pinned Linux build environment

export function compareVersions(left, right) {
  const [a, b] = [left, right].map((value) => value.split(".").map(Number));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

/** Highest GLIBC_x.y listed in the version-needs sections of `readelf --version-info` output. */
export function glibcFloor(readelfOutput) {
  const versions = [...readelfOutput.matchAll(/Name:\s+GLIBC_(\d+\.\d+(?:\.\d+)?)/g)].map((match) => match[1]);
  if (versions.length === 0) throw new Error("No GLIBC version requirements found");
  return versions.sort(compareVersions).at(-1);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message };
}

export function paths(platform, payload) {
  if (platform.os === "darwin") {
    const app = join(payload, "Theme Forge Nebular Fusion.app");
    return { app, executable: join(app, "Contents/MacOS/theme-forge-nebular-fusion"), sidecar: join(app, "Contents/MacOS/tfsb-studio-service"),
      launcher: join(app, "Contents/Resources/bin/tfnf"), resources: join(app, "Contents/Resources") };
  }
  return { executable: join(payload, "bin/theme-forge-nebular-fusion"), sidecar: join(payload, "bin/tfsb-studio-service"),
    launcher: join(payload, "bin/tfnf"), resources: join(payload, "lib/theme-forge-nebular-fusion") };
}

/**
 * @param {{ platform: string, payload: string, checkout: string }} options
 */
export async function qualifyPayload({ platform: key, payload, checkout }) {
  const platform = PLATFORMS[key];
  if (!platform) throw new Error(`Unsupported platform ${key}`);
  const located = paths(platform, resolve(payload));
  const checks = [];
  const check = async (id, run) => {
    try { checks.push({ id, ok: true, detail: (await run()) ?? "" }); } catch (error) { checks.push({ id, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  };
  const executable = readRegularSnapshot(located.executable, { label: "GUI executable", maxBytes: 1024 * 1024 * 1024 });
  await check("executable-header", () => { verifyNativeExecutableHeader(executable.bytes, platform); if (!executable.executable) throw new Error("GUI executable is not executable"); return executable.sha256; });
  await check("launcher", () => {
    const launcher = readRegularSnapshot(located.launcher, { label: "Launcher" });
    if (!launcher.bytes.equals(Buffer.from(nativeLauncher(platform.target))) || !launcher.executable) throw new Error("launcher differs from the maintained launcher or is not executable");
    return launcher.sha256;
  });
  await check("sidecar-runtime", () => {
    const expected = NODE_RELEASE_IDENTITY.targets[platform.triple];
    const sidecar = readRegularSnapshot(located.sidecar, { label: "Sidecar runtime", maxBytes: 512 * 1024 * 1024 });
    if (sidecar.sha256 !== expected.executableSha256 || sidecar.size !== expected.executableSize || !sidecar.executable) {
      throw new Error(`bundled sidecar ${sidecar.sha256} is not the authenticated Node ${NODE_RELEASE_IDENTITY.version} runtime`);
    }
    return `node ${NODE_RELEASE_IDENTITY.version} ${sidecar.sha256}`;
  });
  const config = JSON.parse(readFileSync(join(checkout, "src-tauri/tauri.conf.json"), "utf8"));
  for (const directory of resourceDirectories(config)) {
    await check(`resource:${directory}`, async () => {
      const shipped = (await inventoryTree(join(located.resources, directory))).identity;
      const prepared = (await inventoryTree(join(checkout, "src-tauri", directory))).identity;
      if (shipped !== prepared) throw new Error("shipped resource differs from the prepared resource");
      return shipped;
    });
  }
  let glibcMinimum = null;
  if (platform.os === "linux") {
    for (const [id, path] of [["mode:gui", located.executable], ["mode:sidecar", located.sidecar], ["mode:launcher", located.launcher]]) {
      await check(id, () => { const file = readRegularSnapshot(path, { label: id, maxBytes: 512 * 1024 * 1024 }); if ((file.mode & 0o777) !== 0o755) throw new Error(`mode ${(file.mode & 0o777).toString(8)}`); return "0755"; });
    }
    const floors = [];
    for (const [id, path] of [["glibc:gui", located.executable], ["glibc:sidecar", located.sidecar]]) {
      await check(id, () => {
        const result = run("readelf", ["--version-info", "--wide", path]);
        if (result.status !== 0) throw new Error(`readelf failed: ${result.stderr || result.error}`);
        const floor = glibcFloor(result.stdout);
        floors.push(floor);
        return floor;
      });
    }
    await check("glibc-floor", () => {
      if (floors.length !== 2) throw new Error("glibc requirements were not measured");
      glibcMinimum = floors.sort(compareVersions).at(-1).split(".").slice(0, 2).join(".");
      if (compareVersions(glibcMinimum, GLIBC_CEILING) > 0) throw new Error(`glibc floor ${glibcMinimum} exceeds the ${GLIBC_CEILING} build environment`);
      return glibcMinimum;
    });
    await check("linkage", () => {
      const result = run("ldd", [located.executable]);
      if (result.status !== 0) throw new Error(`ldd failed: ${result.stderr || result.error}`);
      if (/not found/.test(result.stdout)) throw new Error(`unresolved libraries: ${result.stdout.split("\n").filter((line) => line.includes("not found")).join("; ")}`);
      const needed = run("readelf", ["-d", "--wide", located.executable]).stdout.match(/\(NEEDED\).*\[(.*)\]/g) ?? [];
      return needed.map((line) => line.replace(/.*\[(.*)\].*/, "$1")).sort().join(",");
    });
  } else {
    await check("legal-notices", () => {
      for (const name of ["LICENSE", "NOTICE"]) {
        const shipped = readRegularSnapshot(join(located.resources, name), { label: name });
        const source = readRegularSnapshot(join(checkout, name), { label: `Source ${name}` });
        if (!shipped.bytes.equals(source.bytes)) throw new Error(`${name} differs from the source notice`);
      }
      return "LICENSE, NOTICE";
    });
    await check("codesign", () => {
      const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", located.app]);
      if (verify.status !== 0) throw new Error(`codesign verification failed: ${verify.stderr || verify.error}`);
      const described = run("codesign", ["-dv", "--verbose=4", located.app]);
      const signature = /Signature=(\S+)/.exec(described.stderr)?.[1] ?? "unknown";
      return `valid · Signature=${signature}`;
    });
  }
  const passed = checks.every((entry) => entry.ok);
  return { schema: "nebular.native-rc-qualification-v1", platform: key, status: passed ? "pass" : "fail", executableSha256: executable.sha256, glibcMinimum, checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; };
  try {
    const result = await qualifyPayload({ platform: value("--platform"), payload: value("--payload"), checkout: value("--checkout") ?? "." });
    if (value("--output")) writeFileSync(resolve(value("--output")), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ status: result.status, glibcMinimum: result.glibcMinimum, failed: result.checks.filter((entry) => !entry.ok) })}\n`);
    if (result.status !== "pass") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
