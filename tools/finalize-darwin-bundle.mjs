import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nativeLauncher } from "./native-launcher.mjs";

/**
 * Finalize and seal the Darwin application bundle.
 * Installs launcher, LICENSE, and NOTICE before inspecting and sealing the bundle.
 *
 * Requirements:
 * - Launcher: Contents/Resources/bin/tfnf (mode 0o755)
 * - Legal notices: Contents/Resources/LICENSE and Contents/Resources/NOTICE (regular files, non-symlinks, mode 0o644)
 * - Source legal notices must exist and match destination bytes exactly
 * - Outer ad-hoc re-sign (if Signature=adhoc)
 * - Outer codesign verification gate: codesign --verify --deep --strict <app>
 */
export async function finalizeDarwinAppBundle({
  app,
  productTarget,
  studioRoot,
  licensePath = null,
  noticePath = null,
  runner = (cmd, args) => {
    const res = spawnSync(cmd, args, { stdio: "inherit" });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`${cmd} exited with status ${res.status}`);
  },
  inspector = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 }),
  skipSigning = false,
}) {
  if (productTarget.os !== "darwin") {
    throw new Error(`finalizeDarwinAppBundle called for non-darwin target: ${productTarget.os}`);
  }

  // 1. Install launcher
  const launcherDir = join(app, "Contents/Resources/bin");
  mkdirSync(launcherDir, { recursive: true, mode: 0o755 });
  const launcherPath = join(launcherDir, "tfnf");
  writeFileSync(launcherPath, nativeLauncher(productTarget), { mode: 0o755 });
  chmodSync(launcherPath, 0o755);
  const launcherStat = lstatSync(launcherPath);
  if (!launcherStat.isFile() || launcherStat.isSymbolicLink() || (launcherStat.mode & 0o777) !== 0o755) {
    throw new Error("Launcher was not installed as an executable regular file with mode 0755");
  }

  // 2. Resolve source legal files
  // Fail closed if required legal files are missing; never traverse unbound host paths.
  const licenseSrc = licensePath || join(studioRoot, "LICENSE");
  if (!existsSync(licenseSrc)) {
    throw new Error(`Required LICENSE file missing at ${licenseSrc}`);
  }

  const noticeSrc = noticePath || join(studioRoot, "NOTICE");
  if (!existsSync(noticeSrc)) {
    throw new Error(`Required NOTICE file missing at ${noticeSrc}`);
  }

  // Verify source files are regular files (not symlinks)
  const licSrcStat = lstatSync(licenseSrc);
  if (!licSrcStat.isFile() || licSrcStat.isSymbolicLink()) {
    throw new Error(`Source LICENSE at ${licenseSrc} must be a regular non-symlink file`);
  }
  const notSrcStat = lstatSync(noticeSrc);
  if (!notSrcStat.isFile() || notSrcStat.isSymbolicLink()) {
    throw new Error(`Source NOTICE at ${noticeSrc} must be a regular non-symlink file`);
  }

  // 3. Copy legal files into Contents/Resources/ with deterministic modes
  const resDir = join(app, "Contents/Resources");
  mkdirSync(resDir, { recursive: true, mode: 0o755 });

  const licenseDst = join(resDir, "LICENSE");
  const noticeDst = join(resDir, "NOTICE");

  copyFileSync(licenseSrc, licenseDst);
  chmodSync(licenseDst, 0o644);
  const licenseContent = readFileSync(licenseSrc);

  copyFileSync(noticeSrc, noticeDst);
  chmodSync(noticeDst, 0o644);
  const noticeContent = readFileSync(noticeSrc);

  // Verify destination files and modes
  const licDstStat = lstatSync(licenseDst);
  if (!licDstStat.isFile() || licDstStat.isSymbolicLink() || (licDstStat.mode & 0o777) !== 0o644) {
    throw new Error("Destination LICENSE is not a regular file with mode 0644");
  }
  const notDstStat = lstatSync(noticeDst);
  if (!notDstStat.isFile() || notDstStat.isSymbolicLink() || (notDstStat.mode & 0o777) !== 0o644) {
    throw new Error("Destination NOTICE is not a regular file with mode 0644");
  }
  if (!readFileSync(licenseDst).equals(licenseContent)) {
    throw new Error("Destination LICENSE bytes do not match source LICENSE bytes");
  }
  if (!readFileSync(noticeDst).equals(noticeContent)) {
    throw new Error("Destination NOTICE bytes do not match source NOTICE bytes");
  }

  if (skipSigning) {
    return { launcherPath, licenseDst, noticeDst, signed: false };
  }

  // 4. Inspect signing state
  const signing = inspector("codesign", ["-dv", "--verbose=4", app]);
  if (signing.status !== 0) throw new Error("Application signing state could not be inspected");
  if (signing.stderr.includes("Signature=adhoc")) {
    runner("codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
  }

  // 5. Mandatory outer codesign verification gate
  runner("codesign", ["--verify", "--deep", "--strict", app]);

  return { launcherPath, licenseDst, noticeDst, signed: true };
}
