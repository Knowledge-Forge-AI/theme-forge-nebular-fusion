import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalizeDarwinAppBundle } from "./finalize-darwin-bundle.mjs";

test("finalizeDarwinAppBundle installs launcher and legal notices before signing gate with strict ordering", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "finalize-bundle-test-"));
  try {
    const studioRoot = join(tempDir, "studio");
    const appDir = join(tempDir, "Theme Forge Nebular Fusion.app");
    await mkdir(studioRoot, { recursive: true });
    await mkdir(join(appDir, "Contents/MacOS"), { recursive: true });

    const licenseContent = Buffer.from("GNU AFFERO GENERAL PUBLIC LICENSE v3\n");
    const noticeContent = Buffer.from("Theme Forge Nebular Fusion Notice\n");
    const licSrc = join(studioRoot, "LICENSE");
    const notSrc = join(studioRoot, "NOTICE");
    await writeFile(licSrc, licenseContent);
    await writeFile(notSrc, noticeContent);
    // Explicitly set source files to non-0644 mode to verify chmodSync deterministic behavior
    await chmod(licSrc, 0o600);
    await chmod(notSrc, 0o600);

    const callOrder = [];
    const launcherExpected = join(appDir, "Contents/Resources/bin/tfnf");
    const licenseExpected = join(appDir, "Contents/Resources/LICENSE");
    const noticeExpected = join(appDir, "Contents/Resources/NOTICE");

    const inspector = (cmd, args) => {
      assert.equal(cmd, "codesign");
      assert.deepEqual(args, ["-dv", "--verbose=4", appDir]);
      return { status: 0, stdout: "", stderr: "Signature=adhoc\n" };
    };

    const runner = (cmd, args) => {
      assert.equal(cmd, "codesign");
      if (args.includes("--sign")) {
        // At the moment codesign is invoked, verify launcher, LICENSE, and NOTICE exist synchronously on disk with exact modes!
        const lStat = lstatSync(launcherExpected);
        assert.ok(lStat.isFile() && !lStat.isSymbolicLink(), "Launcher must be regular file before signing");
        assert.equal(lStat.mode & 0o777, 0o755, "Launcher must have mode 0755 before signing");

        const licStat = lstatSync(licenseExpected);
        assert.ok(licStat.isFile() && !licStat.isSymbolicLink(), "LICENSE must be regular file before signing");
        assert.equal(licStat.mode & 0o777, 0o644, "LICENSE must have deterministic mode 0644 before signing");
        assert.deepEqual(readFileSync(licenseExpected), licenseContent, "LICENSE bytes must match source before signing");

        const notStat = lstatSync(noticeExpected);
        assert.ok(notStat.isFile() && !notStat.isSymbolicLink(), "NOTICE must be regular file before signing");
        assert.equal(notStat.mode & 0o777, 0o644, "NOTICE must have deterministic mode 0644 before signing");
        assert.deepEqual(readFileSync(noticeExpected), noticeContent, "NOTICE bytes must match source before signing");
      } else if (args.includes("--verify")) {
        // Verify that --sign was invoked prior to --verify
        assert.ok(callOrder.some(c => c.args.includes("--sign")), "--verify must be called after --sign");
      }
      callOrder.push({ cmd, args: [...args] });
    };

    const productTarget = {
      os: "darwin",
      cpu: "arm64",
      triple: "aarch64-apple-darwin",
      system: "aarch64-darwin",
    };

    const result = await finalizeDarwinAppBundle({
      app: appDir,
      productTarget,
      studioRoot,
      runner,
      inspector,
      skipSigning: false,
    });

    assert.equal(result.signed, true);
    assert.equal(result.launcherPath, launcherExpected);
    assert.equal(result.licenseDst, licenseExpected);
    assert.equal(result.noticeDst, noticeExpected);

    // Verify calls made
    assert.equal(callOrder.length, 2, "Must execute both re-sign and verification gate");
    assert.deepEqual(callOrder[0], {
      cmd: "codesign",
      args: ["--force", "--sign", "-", "--timestamp=none", appDir],
    });
    assert.deepEqual(callOrder[1], {
      cmd: "codesign",
      args: ["--verify", "--deep", "--strict", appDir],
    });

    // Check final file properties
    const launcherSt = await stat(result.launcherPath);
    assert.equal(launcherSt.mode & 0o777, 0o755, "Launcher must be mode 0755");

    const licenseSt = await stat(result.licenseDst);
    assert.equal(licenseSt.mode & 0o777, 0o644, "LICENSE must be mode 0644");
    assert.deepEqual(await readFile(result.licenseDst), licenseContent);

    const noticeSt = await stat(result.noticeDst);
    assert.equal(noticeSt.mode & 0o777, 0o644, "NOTICE must be mode 0644");
    assert.deepEqual(await readFile(result.noticeDst), noticeContent);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("finalizeDarwinAppBundle fails closed when LICENSE is missing (no unbound traversal)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "finalize-bundle-fail-lic-"));
  try {
    const studioRoot = join(tempDir, "studio");
    const appDir = join(tempDir, "Theme Forge Nebular Fusion.app");
    await mkdir(studioRoot, { recursive: true });
    await mkdir(join(appDir, "Contents/MacOS"), { recursive: true });

    await writeFile(join(studioRoot, "NOTICE"), "Notice content\n");

    const productTarget = {
      os: "darwin",
      cpu: "arm64",
      triple: "aarch64-apple-darwin",
      system: "aarch64-darwin",
    };

    await assert.rejects(
      finalizeDarwinAppBundle({
        app: appDir,
        productTarget,
        studioRoot,
        skipSigning: true,
      }),
      /Required LICENSE file missing/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("finalizeDarwinAppBundle fails closed when NOTICE is missing (no unbound traversal)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "finalize-bundle-fail-not-"));
  try {
    const studioRoot = join(tempDir, "studio");
    const appDir = join(tempDir, "Theme Forge Nebular Fusion.app");
    await mkdir(studioRoot, { recursive: true });
    await mkdir(join(appDir, "Contents/MacOS"), { recursive: true });

    await writeFile(join(studioRoot, "LICENSE"), "License content\n");

    const productTarget = {
      os: "darwin",
      cpu: "arm64",
      triple: "aarch64-apple-darwin",
      system: "aarch64-darwin",
    };

    await assert.rejects(
      finalizeDarwinAppBundle({
        app: appDir,
        productTarget,
        studioRoot,
        skipSigning: true,
      }),
      /Required NOTICE file missing/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("finalizeDarwinAppBundle rejects symlinked legal notice", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "finalize-bundle-symlink-"));
  try {
    const studioRoot = join(tempDir, "studio");
    const appDir = join(tempDir, "Theme Forge Nebular Fusion.app");
    await mkdir(studioRoot, { recursive: true });
    await mkdir(join(appDir, "Contents/MacOS"), { recursive: true });

    const targetLic = join(tempDir, "real_license.txt");
    await writeFile(targetLic, "License\n");
    await symlink(targetLic, join(studioRoot, "LICENSE"));
    await writeFile(join(studioRoot, "NOTICE"), "Notice\n");

    const productTarget = {
      os: "darwin",
      cpu: "arm64",
      triple: "aarch64-apple-darwin",
      system: "aarch64-darwin",
    };

    await assert.rejects(
      finalizeDarwinAppBundle({
        app: appDir,
        productTarget,
        studioRoot,
        skipSigning: true,
      }),
      /must be a regular non-symlink file/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
