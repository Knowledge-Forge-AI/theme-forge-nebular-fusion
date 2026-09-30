// @vitest-environment node
// Regression coverage for the descriptor-first runtime validators and the staged, authenticated,
// no-clobber adoption of the official Node download (CodeQL js/file-system-race and
// js/http-to-file-access repairs). Genuine-archive cases need the retained official darwin-arm64
// archive (NEBULAR_NODE_DIST_DIR); with NEBULAR_NODE_AUTH_QUALIFICATION=1 its absence is a failure.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NODE_RELEASE_IDENTITY,
  EXPECTED_TARBALL_NAME,
  authenticateDarwinNodeDownload,
  authenticateLinuxNodeArchive,
  readRegularFile,
  signedShasumsBody,
  validateDarwinNodeArchive,
  validateDarwinPortableNode,
  validateLinuxPortableNode,
} from "../tools/node-runtime-authority.mjs";

const FIXTURE_SHASUMS = fileURLToPath(new URL("./fixtures/node-v22.23.3/SHASUMS256.txt.asc", import.meta.url));
const FIXTURE_SHASUMS_SHA256 = "e82087fe2cf383fce187b0789eb5ea50fd92f9b68afb4f4e174d65ec59acba4a";
const DIST_DIR = process.env.NEBULAR_NODE_DIST_DIR;
const QUALIFICATION = process.env.NEBULAR_NODE_AUTH_QUALIFICATION === "1";
const LINUX_EXECUTABLES = process.env.NEBULAR_NODE_LINUX_EXECUTABLES; // "<triple>=<path>[,<triple>=<path>]"

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (path) => readFileSync(path);
const openDescriptorCount = () => readdirSync("/dev/fd").length;

function absent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function stagingLeftovers(directory) {
  return readdirSync(directory).filter((name) => name.startsWith(".staging-"));
}

function genuineArchivePath() {
  const path = DIST_DIR ? join(DIST_DIR, EXPECTED_TARBALL_NAME) : null;
  if (path && !absent(path)) return path;
  if (QUALIFICATION) throw new Error(`qualification requires the retained official ${EXPECTED_TARBALL_NAME} in NEBULAR_NODE_DIST_DIR`);
  return null;
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nebular-node-authority-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("embedded Node runtime identity", () => {
  it("keeps the accepted Node 22.23.3 / Undici 6.28.1 authority unchanged", () => {
    expect(JSON.parse(JSON.stringify(NODE_RELEASE_IDENTITY))).toEqual({
      version: "22.23.3",
      darwinArm64TarballSha256: "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
      nodeExecutableSha256: "68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b",
      nodeExecutableSize: 112925600,
      v8: "12.4.254.21-node.57",
      undici: "6.28.1",
      target: "aarch64-apple-darwin",
      tarballName: "node-v22.23.3-darwin-arm64.tar.gz",
      archiveUrl: "https://nodejs.org/download/release/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz",
      shasumsSha256: "4fe99a2ba9d552a6f51c13ed68fb11104cfa5df601aec616be689253a8139e7a",
      signingKeyFingerprint: "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356", // betterleaks:allow -- public Node.js release signing-key fingerprint
      signingKeyReleaser: "Antoine du Hamel <duhamelantoine1995@gmail.com>",
      targets: {
        "aarch64-apple-darwin": { archive: "node-v22.23.3-darwin-arm64.tar.gz", archiveSha256: "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53", executableSha256: "68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b", executableSize: 112925600, platform: "darwin", arch: "arm64" },
        "aarch64-unknown-linux-gnu": { archive: "node-v22.23.3-linux-arm64.tar.xz", archiveSha256: "a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f", executableSha256: "d09e299258c24f7cdf6f5d5ec185e3a56512b27a697113735dac909f1cac7b8d", executableSize: 122179336, platform: "linux", arch: "arm64" },
        "x86_64-unknown-linux-gnu": { archive: "node-v22.23.3-linux-x64.tar.xz", archiveSha256: "df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de", executableSha256: "fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48", executableSize: 124827920, platform: "linux", arch: "x64" },
      },
    });
    expect(sha256(bytesOf(FIXTURE_SHASUMS))).toBe(FIXTURE_SHASUMS_SHA256);
  });
});

describe("descriptor-first validation", () => {
  it("reads regular files once and rejects symbolic links, FIFOs and directories without leaking descriptors", () => {
    const regular = join(root, "regular");
    writeFileSync(regular, "bytes");
    const link = join(root, "link");
    symlinkSync(regular, link);
    const fifo = join(root, "fifo");
    execFileSync("mkfifo", [fifo]);
    const directory = join(root, "directory");
    mkdirSync(directory);

    const before = openDescriptorCount();
    expect(readRegularFile(regular).bytes.toString()).toBe("bytes");
    expect(() => readRegularFile(link, { label: "Input" })).toThrow(/Input must be a regular file, not a symbolic link/);
    expect(() => readRegularFile(fifo, { label: "Input" })).toThrow(/Input must be a regular file/);
    expect(() => readRegularFile(directory, { label: "Input" })).toThrow(/Input must be a regular file/);
    expect(() => readRegularFile(join(root, "missing"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(openDescriptorCount()).toBe(before);
  });

  it("fails every runtime and archive validator closed on non-regular or wrong-size inputs", () => {
    const wrongSize = join(root, "node");
    writeFileSync(wrongSize, "not node");
    const link = join(root, "node-link");
    symlinkSync(wrongSize, link);
    const fifo = join(root, "node-fifo");
    execFileSync("mkfifo", [fifo]);

    const before = openDescriptorCount();
    for (const validate of [
      (path) => validateDarwinPortableNode(path, { validateLinkage: false }),
      (path) => validateLinuxPortableNode(path, "aarch64-unknown-linux-gnu"),
      (path) => validateLinuxPortableNode(path, "x86_64-unknown-linux-gnu"),
    ]) {
      expect(() => validate(wrongSize)).toThrow(/size mismatch/);
      expect(() => validate(link)).toThrow(/not a symbolic link/);
      expect(() => validate(fifo)).toThrow(/must be a regular file/);
    }
    expect(() => validateDarwinNodeArchive(wrongSize)).toThrow(/Node archive SHA-256 mismatch/);
    expect(() => validateDarwinNodeArchive(link)).toThrow(/not a symbolic link/);
    expect(() => validateLinuxPortableNode(wrongSize, "aarch64-apple-darwin")).toThrow(/No authenticated Linux Node runtime identity/);
    expect(openDescriptorCount()).toBe(before);
  });

  it("probes a genuine Linux runtime only on a matching host, through the measured descriptor", () => {
    const entries = (LINUX_EXECUTABLES ?? "").split(",").filter(Boolean).map((entry) => entry.split("="));
    if (entries.length === 0) {
      if (QUALIFICATION && process.platform === "linux") throw new Error("qualification on Linux requires NEBULAR_NODE_LINUX_EXECUTABLES");
      return;
    }
    for (const [triple, path] of entries) {
      const identity = NODE_RELEASE_IDENTITY.targets[triple];
      const result = validateLinuxPortableNode(path, triple);
      expect(result).toMatchObject({ valid: true, sha256: identity.executableSha256, target: triple });
      expect(result.probed).toBe(process.platform === "linux" && process.arch === identity.arch);
    }
  });
});

// A stand-in for the shared verifier that stages known bytes exactly as the real verifier does.
function fakeVerifier(files, { fail } = {}) {
  const calls = [];
  const verify = async (options) => {
    calls.push(Object.keys(options).sort().join(","));
    if (options.downloadDir) {
      writeFileSync(join(options.downloadDir, "SHASUMS256.txt.asc"), files.shasums);
      writeFileSync(join(options.downloadDir, EXPECTED_TARBALL_NAME), files.tarball);
    }
    if (fail) throw new Error(fail);
    writeFileSync(options.outputNodePath, files.node, { mode: 0o755 });
    return { status: "pass", staged: options };
  };
  return { verify, calls };
}

describe("staged no-clobber adoption of the authenticated download", () => {
  const files = { shasums: Buffer.from("signed sums\n"), tarball: Buffer.from("archive bytes"), node: Buffer.from("runtime bytes") };
  const expected = { tarballSha256: sha256(files.tarball), executableSha256: sha256(files.node) };
  const paths = () => ({ dir: join(root, "dl"), shasums: join(root, "dl", "SHASUMS256.txt.asc"), tarball: join(root, "dl", EXPECTED_TARBALL_NAME), node: join(root, "out", "node-authenticated") });

  it("adopts a fresh download only after authentication and removes staging", async () => {
    const p = paths();
    const { verify, calls } = fakeVerifier(files);
    const receipt = await authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, verify, expected });
    expect(receipt.status).toBe("pass");
    expect(receipt.staged.downloadDir).toMatch(/\/\.staging-[^/]+$/);
    expect(calls).toEqual(["downloadDir,outputNodePath"]);
    expect(bytesOf(p.shasums)).toEqual(files.shasums);
    expect(bytesOf(p.tarball)).toEqual(files.tarball);
    expect(bytesOf(p.node)).toEqual(files.node);
    expect(lstatSync(p.node).mode & 0o111).not.toBe(0);
    expect(stagingLeftovers(p.dir)).toEqual([]);
  });

  it("re-authenticates a complete cached pair without network and accepts identical existing outputs", async () => {
    const p = paths();
    await authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, verify: fakeVerifier(files).verify, expected });
    const { verify, calls } = fakeVerifier(files);
    await authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, verify, expected });
    expect(calls).toEqual(["outputNodePath,shasumsPath,tarballPath"]);
    expect(bytesOf(p.tarball)).toEqual(files.tarball);
    expect(stagingLeftovers(p.dir)).toEqual([]);
  });

  it("never replaces a different existing file and leaves every final path unchanged", async () => {
    const p = paths();
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.shasums, "other sums");
    await expect(authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, verify: fakeVerifier(files).verify, expected }))
      .rejects.toThrow(/Existing SHASUMS256\.txt\.asc .* differs from the authenticated bytes; it was not replaced/);
    expect(bytesOf(p.shasums).toString()).toBe("other sums");
    expect(absent(p.tarball)).toBe(true);
    expect(absent(p.node)).toBe(true);
    expect(stagingLeftovers(p.dir)).toEqual([]);
  });

  it("refuses symbolic links at final paths and for the download directory", async () => {
    const p = paths();
    mkdirSync(p.dir, { recursive: true });
    const victim = join(root, "victim");
    writeFileSync(victim, "victim bytes");
    symlinkSync(victim, p.tarball);
    await expect(authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, verify: fakeVerifier(files).verify, expected }))
      .rejects.toThrow(/not a symbolic link/);
    expect(readlinkSync(p.tarball)).toBe(victim);
    expect(bytesOf(victim).toString()).toBe("victim bytes");
    expect(absent(p.shasums)).toBe(true);
    expect(absent(p.node)).toBe(true);

    const linkedDir = join(root, "linked-dl");
    symlinkSync(p.dir, linkedDir);
    await expect(authenticateDarwinNodeDownload({ downloadDir: linkedDir, outputNodePath: p.node, verify: fakeVerifier(files).verify, expected }))
      .rejects.toThrow(/Node download directory must be a real directory/);
  });

  it("leaves no final path behind when authentication fails", async () => {
    const p = paths();
    await expect(authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, verify: fakeVerifier(files, { fail: "[NODE_AUTH_FAIL] tampered" }).verify, expected }))
      .rejects.toThrow(/tampered/);
    for (const path of [p.shasums, p.tarball, p.node]) expect(absent(path)).toBe(true);
    expect(stagingLeftovers(p.dir)).toEqual([]);
  });

  it("detects replacement of staged bytes between authentication and adoption", async () => {
    const p = paths();
    const beforeAdoption = ({ staged }) => writeFileSync(staged.tarball, "replaced archive");
    await expect(authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, verify: fakeVerifier(files).verify, expected, beforeAdoption }))
      .rejects.toThrow(/Staged node-v22\.23\.3-darwin-arm64\.tar\.gz changed after authentication/);
    for (const path of [p.shasums, p.tarball, p.node]) expect(absent(path)).toBe(true);
  });

  it("rolls back names it created when a later adoption fails", async () => {
    const p = paths();
    mkdirSync(join(root, "out"), { recursive: true });
    writeFileSync(p.node, "different runtime");
    await expect(authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, verify: fakeVerifier(files).verify, expected }))
      .rejects.toThrow(/Existing authenticated Node runtime .* differs/);
    expect(absent(p.shasums)).toBe(true);
    expect(absent(p.tarball)).toBe(true);
    expect(bytesOf(p.node).toString()).toBe("different runtime");
  });

  it("requires an executable runtime and a non-colliding output name", async () => {
    const p = paths();
    const verify = async (options) => {
      writeFileSync(join(options.downloadDir, "SHASUMS256.txt.asc"), files.shasums);
      writeFileSync(join(options.downloadDir, EXPECTED_TARBALL_NAME), files.tarball);
      writeFileSync(options.outputNodePath, files.node, { mode: 0o644 });
      return {};
    };
    await expect(authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, verify, expected })).rejects.toThrow(/is not executable/);
    for (const path of [p.shasums, p.tarball, p.node]) expect(absent(path)).toBe(true);
    await expect(authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: join(root, "out", EXPECTED_TARBALL_NAME), verify, expected }))
      .rejects.toThrow(/collides with an authenticated download name/);
  });
});

describe("maintained authenticity chain (shared verifier, signed SHASUMS)", () => {
  const signedSums = () => bytesOf(FIXTURE_SHASUMS);
  const serve = (responses) => async (url, init) => {
    expect(init).toEqual({ redirect: "error" });
    const name = url.split("/").pop();
    const body = responses[name];
    return typeof body === "number" ? new Response(null, { status: body }) : new Response(body);
  };
  const paths = () => ({ dir: join(root, "dl"), shasums: join(root, "dl", "SHASUMS256.txt.asc"), tarball: join(root, "dl", EXPECTED_TARBALL_NAME), node: join(root, "out", "node-authenticated") });
  const expectNothingAdopted = (p) => {
    for (const path of [p.shasums, p.tarball, p.node]) expect(absent(path)).toBe(true);
    expect(stagingLeftovers(p.dir)).toEqual([]);
  };

  it("rejects a tampered signed SHASUMS manifest before anything is adopted", async () => {
    const p = paths();
    const tampered = signedSums().toString("utf8").replace("23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53", "0".repeat(64));
    await expect(authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, fetchImpl: serve({ "SHASUMS256.txt.asc": tampered, [EXPECTED_TARBALL_NAME]: "archive" }) }))
      .rejects.toThrow(/\[NODE_AUTH_FAIL\] PGP signature verification failed/);
    expectNothingAdopted(p);
  }, 60_000);

  it("rejects a tampered or truncated archive against the genuine signed entry", async () => {
    for (const archive of [Buffer.from("not the official archive"), Buffer.alloc(0)]) {
      const p = paths();
      await expect(authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, fetchImpl: serve({ "SHASUMS256.txt.asc": signedSums(), [EXPECTED_TARBALL_NAME]: archive }) }))
        .rejects.toThrow(/\[NODE_AUTH_FAIL\] Tarball 'node-v22\.23\.3-darwin-arm64\.tar\.gz' SHA-256 '[0-9a-f]{64}' does not match verified checksum '23b25245/);
      expectNothingAdopted(p);
      rmSync(p.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects a tampered cached archive without replacing the cached files", async () => {
    const p = paths();
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.shasums, signedSums());
    writeFileSync(p.tarball, "tampered cached archive");
    await expect(authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node }))
      .rejects.toThrow(/does not match verified checksum/);
    expect(sha256(bytesOf(p.shasums))).toBe(FIXTURE_SHASUMS_SHA256);
    expect(bytesOf(p.tarball).toString()).toBe("tampered cached archive");
    expect(absent(p.node)).toBe(true);
    expect(stagingLeftovers(p.dir)).toEqual([]);
  }, 60_000);

  it("fails closed on an unsuccessful official download", async () => {
    const p = paths();
    await expect(authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, fetchImpl: serve({ "SHASUMS256.txt.asc": signedSums(), [EXPECTED_TARBALL_NAME]: 404 }) }))
      .rejects.toThrow(/\[NODE_AUTH_FAIL\] Official Node release download failed: manifest=200, tarball=404/);
    expectNothingAdopted(p);
  }, 60_000);

  it("accepts the genuine official archive through the download and cached paths", async () => {
    const archivePath = genuineArchivePath();
    if (!archivePath || process.platform !== "darwin" || process.arch !== "arm64") {
      if (QUALIFICATION && process.platform === "darwin") throw new Error("genuine qualification requires a darwin-arm64 host");
      return;
    }
    const archive = bytesOf(archivePath);
    expect(sha256(archive)).toBe(NODE_RELEASE_IDENTITY.darwinArm64TarballSha256);
    const p = paths();
    const downloaded = await authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, fetchImpl: serve({ "SHASUMS256.txt.asc": signedSums(), [EXPECTED_TARBALL_NAME]: archive }) });
    expect(downloaded.signature.fingerprint).toBe(NODE_RELEASE_IDENTITY.signingKeyFingerprint);
    expect(downloaded.tarball).toEqual({ filename: EXPECTED_TARBALL_NAME, sha256: NODE_RELEASE_IDENTITY.darwinArm64TarballSha256, verifiedAgainstShasums: true });
    expect(downloaded.executable).toEqual({ filename: "node-authenticated", sha256: NODE_RELEASE_IDENTITY.nodeExecutableSha256, size: NODE_RELEASE_IDENTITY.nodeExecutableSize });
    expect(downloaded.embeddedRuntime.undici).toBe("6.28.1");
    expect(sha256(bytesOf(p.node))).toBe(NODE_RELEASE_IDENTITY.nodeExecutableSha256);
    expect(sha256(bytesOf(p.shasums))).toBe(FIXTURE_SHASUMS_SHA256);

    const cached = await authenticateDarwinNodeDownload({ downloadDir: p.dir, outputNodePath: p.node, fetchImpl: () => { throw new Error("network used for a complete cached pair"); } });
    expect(cached.executable.sha256).toBe(NODE_RELEASE_IDENTITY.nodeExecutableSha256);
    expect(stagingLeftovers(p.dir)).toEqual([]);
  }, 120_000);
});

describe("Linux runtime archive authentication (hosted Linux release-candidate lanes)", () => {
  const LINUX = ["aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"];
  const stage = (archiveBytes, shasumsBytes = bytesOf(FIXTURE_SHASUMS), target = LINUX[0]) => {
    const dir = join(root, `linux-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SHASUMS256.txt.asc"), shasumsBytes);
    writeFileSync(join(dir, NODE_RELEASE_IDENTITY.targets[target].archive), archiveBytes);
    return { dir, shasumsPath: join(dir, "SHASUMS256.txt.asc"), tarballPath: join(dir, NODE_RELEASE_IDENTITY.targets[target].archive), outputNodePath: join(dir, "out", "node"), targetTriple: target };
  };

  it("reads the Linux archive digests from the signed body of the genuine SHASUMS", () => {
    const body = signedShasumsBody(bytesOf(FIXTURE_SHASUMS));
    for (const triple of LINUX) {
      const identity = NODE_RELEASE_IDENTITY.targets[triple];
      expect(body).toContain(`${identity.archiveSha256}  ${identity.archive}`);
    }
    expect(() => signedShasumsBody(Buffer.from("unsigned text"))).toThrow(/cleartext-signed/);
  });

  it("verifies the signature through the shared verifier and then rejects an archive that is not the verified one", async () => {
    const staged = stage(Buffer.from("not the official archive"));
    await expect(authenticateLinuxNodeArchive(staged)).rejects.toThrow(/\[NODE_AUTH_FAIL\] node-v22\.23\.3-linux-arm64\.tar\.xz SHA-256 [0-9a-f]{64} does not match the verified checksum/);
    expect(absent(staged.outputNodePath)).toBe(true);
    expect(readdirSync(join(staged.dir, "out")).filter((name) => name.startsWith(".node-linux-"))).toEqual([]);
  }, 60_000);

  it("rejects a tampered signed SHASUMS and a foreign signer before anything is adopted", async () => {
    const identity = NODE_RELEASE_IDENTITY.targets[LINUX[1]];
    const tampered = bytesOf(FIXTURE_SHASUMS).toString("utf8").replace(identity.archiveSha256, "0".repeat(64));
    const staged = stage(Buffer.from("archive"), Buffer.from(tampered), LINUX[1]);
    await expect(authenticateLinuxNodeArchive(staged)).rejects.toThrow(/PGP signature verification failed/);
    expect(absent(staged.outputNodePath)).toBe(true);
    const foreign = stage(Buffer.from("archive"));
    await expect(authenticateLinuxNodeArchive({ ...foreign, verify: async () => ({ signature: { fingerprint: "0".repeat(40) } }) })).rejects.toThrow(/is not the embedded runtime signer/);
    await expect(authenticateLinuxNodeArchive({ ...foreign, targetTriple: "aarch64-apple-darwin" })).rejects.toThrow(/No embedded Linux runtime identity/);
  }, 60_000);

  it("adopts the genuine official Linux runtimes (qualification with the retained archives)", async () => {
    const available = DIST_DIR && LINUX.every((triple) => { try { lstatSync(join(DIST_DIR, NODE_RELEASE_IDENTITY.targets[triple].archive)); return true; } catch { return false; } });
    if (!available) {
      if (QUALIFICATION) throw new Error("qualification requires the retained official Linux archives in NEBULAR_NODE_DIST_DIR");
      return;
    }
    for (const triple of LINUX) {
      const identity = NODE_RELEASE_IDENTITY.targets[triple];
      const staged = stage(bytesOf(join(DIST_DIR, identity.archive)), bytesOf(FIXTURE_SHASUMS), triple);
      const receipt = await authenticateLinuxNodeArchive(staged);
      expect(receipt).toMatchObject({ schema: "nebular.linux-node-authenticity-v1", target: triple, nodeVersion: "22.23.3", undici: "6.28.1",
        archive: { name: identity.archive, sha256: identity.archiveSha256 }, executable: { sha256: identity.executableSha256, size: identity.executableSize } });
      expect(receipt.signature.fingerprint).toBe(NODE_RELEASE_IDENTITY.signingKeyFingerprint);
      expect(sha256(bytesOf(staged.outputNodePath))).toBe(identity.executableSha256);
      writeFileSync(join(staged.dir, "other"), "x");
      const again = stage(bytesOf(join(DIST_DIR, identity.archive)), bytesOf(FIXTURE_SHASUMS), triple);
      mkdirSync(join(again.dir, "out"), { recursive: true });
      writeFileSync(again.outputNodePath, "different existing runtime");
      await expect(authenticateLinuxNodeArchive(again)).rejects.toThrow(/differs from the authenticated bytes; it was not replaced/);
      expect(bytesOf(again.outputNodePath).toString()).toBe("different existing runtime");
    }
  }, 180_000);
});
