import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nativeLauncher } from "./native-launcher.mjs";
import { defaultSnapshotReader } from "./fs-snapshot.mjs";

/**
 * The members finalization adds to Contents/Resources, with the exact bytes and modes it installs.
 * This is the shared layout contract: the supply-chain scan surface materializes the same members, so
 * the shipped resource set and the scanned resource set cannot drift apart.
 * @returns {{ path: string, bytes: Buffer, mode: number, label: string, messages: object }[]}
 */
export function finalizedResourceMembers({ productTarget, studioRoot, licensePath = null, noticePath = null, reader = defaultSnapshotReader }) {
  if (productTarget.os !== "darwin") throw new Error(`Darwin finalization members requested for ${productTarget.os}`);
  const members = [{
    path: "bin/tfnf",
    bytes: Buffer.from(nativeLauncher(productTarget)),
    mode: 0o755,
    label: "Launcher",
    messages: { mode: "Launcher was not installed as an executable regular file with mode 0755" },
  }];
  // Fail closed if required legal files are missing; never traverse unbound host paths.
  for (const [name, source] of [["LICENSE", licensePath || join(studioRoot, "LICENSE")], ["NOTICE", noticePath || join(studioRoot, "NOTICE")]]) {
    const captured = reader.readRegular(source, {
      label: `Source ${name}`,
      maxBytes: 16 * 1024 * 1024,
      messages: {
        missing: `Required ${name} file missing at ${source}`,
        symlink: `Source ${name} at ${source} must be a regular non-symlink file`,
        notRegular: `Source ${name} at ${source} must be a regular non-symlink file`,
      },
    });
    members.push({ path: name, bytes: captured.bytes, mode: 0o644, label: `Destination ${name}`,
      messages: { mode: `Destination ${name} is not a regular file with mode 0644`, bytes: `Destination ${name} bytes do not match source ${name} bytes` } });
  }
  return members;
}

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
 *
 * Every member is installed from bytes captured through one descriptor: the
 * source notices are opened once without following links and read through that
 * descriptor, and the installed LICENSE and NOTICE are written from exactly those
 * captured bytes and then re-read and compared. No source pathname is checked and
 * later reread or copied.
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
  reader = defaultSnapshotReader,
}) {
  if (productTarget.os !== "darwin") {
    throw new Error(`finalizeDarwinAppBundle called for non-darwin target: ${productTarget.os}`);
  }

  // 1. Capture every finalized member before anything is installed: the generated launcher and the
  // source legal files, each read through one descriptor.
  const members = finalizedResourceMembers({ productTarget, studioRoot, licensePath, noticePath, reader });

  // 2. Install the captured bytes into Contents/Resources/ with deterministic modes; each installed
  // member is re-read and must equal the captured bytes and mode.
  const resDir = join(app, "Contents/Resources");
  mkdirSync(join(resDir, "bin"), { recursive: true, mode: 0o755 });
  const installed = {};
  for (const member of members) {
    installed[member.path] = join(resDir, member.path);
    reader.writeRegular(installed[member.path], member.bytes, member.mode, { label: member.label, messages: member.messages });
  }
  const launcherPath = installed["bin/tfnf"];
  const licenseDst = installed.LICENSE;
  const noticeDst = installed.NOTICE;

  if (skipSigning) {
    return { launcherPath, licenseDst, noticeDst, signed: false };
  }

  // 3. Inspect signing state
  const signing = inspector("codesign", ["-dv", "--verbose=4", app]);
  if (signing.status !== 0) throw new Error("Application signing state could not be inspected");
  if (signing.stderr.includes("Signature=adhoc")) {
    runner("codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
  }

  // 4. Mandatory outer codesign verification gate
  runner("codesign", ["--verify", "--deep", "--strict", app]);

  return { launcherPath, licenseDst, noticeDst, signed: true };
}
