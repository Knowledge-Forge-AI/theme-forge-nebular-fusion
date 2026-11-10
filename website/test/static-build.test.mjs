import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_MEMBERS,
  StaticBuildError,
  buildStaticSite,
} from "../tools/build-static-site.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tfnf-static-build-"));
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot);
  for (const relativePath of PUBLIC_MEMBERS) {
    const destination = path.join(sourceRoot, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(siteRoot, ...relativePath.split("/")), destination);
  }
  return { root, sourceRoot };
}

function removeFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function assertBuildError(callback, code) {
  assert.throws(callback, (error) => error instanceof StaticBuildError && error.code === code);
}

function walkFiles(root, relative = "") {
  const directory = path.join(root, relative);
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) return walkFiles(root, child);
      const bytes = fs.readFileSync(path.join(root, ...child.split("/")));
      const mode = (fs.statSync(path.join(root, ...child.split("/"))).mode & 0o777).toString(8).padStart(4, "0");
      return [{ path: child, bytes: bytes.toString("base64"), mode }];
    });
}

function stageNames(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith(".tfnf-static-stage-"));
}

function payloadNames(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith(".tfnf-static-payload-"));
}

function loadInstallContract(versionOverrides = {}, sourceText = fs.readFileSync(path.join(siteRoot, "src", "main.mjs"), "utf8")) {
  const start = sourceText.indexOf("const CANDIDATE_VERSION");
  const end = sourceText.indexOf("const WORKFLOW_TITLES");
  assert.ok(start >= 0 && end > start, "install contract prefix must remain discoverable");
  const prefix = sourceText.slice(start, end);
  const versionDeclaration = /const PUBLISHED_CHANNEL_VERSIONS = Object\.freeze\(\{[\s\S]*?\n\}\);/u;
  assert.match(prefix, versionDeclaration, "source version map must remain discoverable");
  const evaluate = (scriptPrefix, filename) => {
    const script = `${scriptPrefix}\nglobalThis.__tfnfInstallContract = { PUBLISHED_CHANNEL_VERSIONS, CANDIDATE_VERSION, INSTALL_CHANNELS };`;
    const context = {};
    vm.runInNewContext(script, context, { filename });
    return context.__tfnfInstallContract;
  };
  if (Object.keys(versionOverrides).length === 0) {
    return evaluate(prefix, "src/main.mjs#install-contract");
  }
  const sourceContract = evaluate(prefix, "src/main.mjs#install-contract-source");
  const unknown = Object.keys(versionOverrides).filter((channel) => !Object.hasOwn(sourceContract.PUBLISHED_CHANNEL_VERSIONS, channel));
  assert.deepEqual(unknown, [], "version overrides must target existing channels");
  const versions = { ...sourceContract.PUBLISHED_CHANNEL_VERSIONS, ...versionOverrides };
  const replaced = prefix.replace(versionDeclaration, `const PUBLISHED_CHANNEL_VERSIONS = Object.freeze(${JSON.stringify(versions)});`);
  assert.notEqual(replaced, prefix, "version override must replace the source declaration");
  return evaluate(replaced, "src/main.mjs#install-contract-override");
}

test("builds the fixed public allowlist with a deterministic manifest", () => {
  const fixture = createFixture();
  try {
    const outputOne = path.join(fixture.root, "output-one");
    const outputTwo = path.join(fixture.root, "output-two");
    const first = buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: outputOne });
    const second = buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: outputTwo });

    assert.equal(first.memberCount, 29);
    assert.equal(first.outputFileCount, 30);
    assert.deepEqual(first.manifest, second.manifest);
    assert.deepEqual(walkFiles(outputOne), walkFiles(outputTwo));
    assert.deepEqual(
      first.manifest.members.map((member) => member.path),
      [...PUBLIC_MEMBERS].sort(),
    );
    assert.ok(first.manifest.members.every((member) => member.mode === "0644"));
    assert.equal(first.manifest.members.filter((member) => member.path.startsWith("appearances/profiles/")).length, 6);
    assert.ok(first.manifest.members.some((member) => member.path === "appearances/source-profiles.json"));
    assert.ok(first.manifest.members.some((member) => member.path === "screenshots/gamer-dark-shell.jpg"));
    assert.ok(first.manifest.members.some((member) => member.path === "screenshots/screenshot-provenance.json"));
    const browserProof = JSON.parse(fs.readFileSync(path.join(outputOne, "screenshots/screenshot-provenance.json"), "utf8"));
    assert.equal(browserProof.asset.path, "screenshots/gamer-dark-shell.jpg");
    assert.equal(browserProof.asset.bytes, 64908);
    assert.equal(browserProof.asset.sha256, "37bf3f2c2ceb26cd0baeb493f2444707d8cf1e4fc87c2c261359f18f2e6f43ed");
    assert.equal(browserProof.asset.width, 1265);
    assert.equal(browserProof.asset.height, 712);
    assert.equal(browserProof.source.fixtureManifestSha256, "487b69d20ce0f7c800f88c7b4fd0b24ce6bac298099156b00e8fc3bcb469e020");
    assert.match(browserProof.presentation.caption, /native ports mocked/);
    const indexHtml = fs.readFileSync(path.join(outputOne, "index.html"), "utf8");
    assert.match(indexHtml, /0\.8\.0 release/);
    assert.match(indexHtml, /published through GitHub native archives, npm, the Homebrew Apple Silicon formula, PyPI, and Nix/);
    assert.match(indexHtml, /APT, DNF, and pacman also publish 0\.8\.0/);
    assert.match(indexHtml, /automated native checks have passed on all three supported targets/);
    assert.match(indexHtml, /This exact-byte capture comes from the Theme Forge App\/external CSSOM source fixture\. It is a browser-rendered development preview with an explicit mock boundary, not a screenshot of a published Nebular Fusion release interface\./);
    assert.match(indexHtml, /not the published Nebular Fusion 0\.7\.1 interface\./);
    assert.equal(fs.statSync(path.join(outputOne, "manifest.json")).mode & 0o777, 0o644);

    const manifestText = fs.readFileSync(path.join(outputOne, "manifest.json"), "utf8");
    assert.equal(manifestText.includes(fixture.root), false);
    assert.equal(manifestText.includes("timestamp"), false);
    assert.equal(manifestText.includes("username"), false);
    assert.equal(crypto.createHash("sha256").update(manifestText).digest("hex"), crypto.createHash("sha256").update(fs.readFileSync(path.join(outputTwo, "manifest.json"))).digest("hex"));
  } finally {
    removeFixture(fixture);
  }
});

test("keeps every generated install route on its exact published channel version", () => {
  const contract = loadInstallContract();
  assert.equal(contract.CANDIDATE_VERSION, "0.8.0");
  assert.deepStrictEqual({ ...contract.PUBLISHED_CHANNEL_VERSIONS }, {
    npm: "0.8.0",
    pip: "0.8.0",
    homebrew: "0.8.0",
    nix: "0.8.0",
    apt: "0.8.0",
    dnf: "0.8.0",
    pacman: "0.8.0",
    native: "0.8.0",
  });
  for (const version of Object.values(contract.PUBLISHED_CHANNEL_VERSIONS)) assert.match(version, /^\d+\.\d+\.\d+$/);
  const platforms = ["darwin-arm64", "linux-arm64", "linux-x64"];
  const promotedChannels = new Set(["npm", "pip", "homebrew", "nix", "apt", "dnf", "pacman", "native"]);
  const versionedCommandChannels = new Set(["npm", "pip", "native"]);
  let caseCount = 0;

  for (const [channel, info] of Object.entries(contract.INSTALL_CHANNELS)) {
    assert.equal(info.publishedVersion, contract.PUBLISHED_CHANNEL_VERSIONS[channel]);
    assert.match(info.publicationStatus, new RegExp(`^${contract.CANDIDATE_VERSION} `));
    if (promotedChannels.has(channel)) {
      assert.equal(info.publishedVersion, "0.8.0");
      assert.match(info.publicationStatus, channel === "native" ? /0\.8\.0 native archive is published/ : /0\.8\.0 is published/);
    }
    for (const platform of platforms) {
      if (!info.available.includes(platform)) continue;
      caseCount += 1;
      const command = info.command(platform);
      if (promotedChannels.has(channel) && versionedCommandChannels.has(channel)) {
        assert.match(command, new RegExp(info.publishedVersion.replaceAll(".", "\\.")));
      }
      if (channel === "native") {
        assert.match(command, /releases\/download\/v0\.8\.0/);
        assert.match(command, /theme-forge-nebular-fusion-v0\.8\.0-/);
        assert.match(info.source, /releases\/tag\/v0\.8\.0/);
      }
    }
  }
  assert.equal(caseCount, 19);
});

test("binds the static release chip and dynamic install renderer to each channel version", () => {
  const contract = loadInstallContract();
  const indexHtml = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  const chip = indexHtml.match(/<span class="release-chip" data-install-version>([^<]+)<\/span>/u);
  assert.ok(chip, "static install panel must expose a version hook");
  assert.equal(chip[1], contract.PUBLISHED_CHANNEL_VERSIONS.npm);
  assert.match(indexHtml, /npm selects exactly one optional 0\.8\.0 native package for the selected host: Darwin ARM64, Linux ARM64, or Linux x64\./u);
  assert.match(contract.INSTALL_CHANNELS.npm.description, /0\.8\.0 native package/);
  const source = fs.readFileSync(path.join(siteRoot, "src", "main.mjs"), "utf8");
  const start = source.indexOf("function renderInstall()");
  const end = source.indexOf("function tabIsVisible", start);
  assert.ok(start >= 0 && end > start, "renderInstall must remain discoverable");
  const renderSource = source.slice(start, end);
  assert.match(renderSource, /querySelector\("\[data-install-version\]"\)/u);
  assert.match(renderSource, /version\.textContent = info\.publishedVersion/u);
});

test("default contract binds all eight public surfaces to 0.8.0 receipts", () => {
  const contract = loadInstallContract();
  for (const channel of ["npm", "pip", "homebrew", "nix", "apt", "dnf", "pacman", "native"]) {
    assert.equal(contract.PUBLISHED_CHANNEL_VERSIONS[channel], "0.8.0");
    assert.equal(contract.INSTALL_CHANNELS[channel].publishedVersion, "0.8.0");
    assert.match(contract.INSTALL_CHANNELS[channel].publicationStatus, channel === "native" ? /0\.8\.0 native archive is published/ : /0\.8\.0 is published/);
  }
  assert.match(contract.INSTALL_CHANNELS.npm.source, /theme-forge-nebular-fusion\/releases\/tag\/v0\.8\.0/);
  assert.match(contract.INSTALL_CHANNELS.npm.command("darwin-arm64"), /@knowledge-forge-ai\/theme-forge-nebular-fusion@0\.8\.0/);
  assert.match(contract.INSTALL_CHANNELS.homebrew.description, /0\.8\.0/);
  assert.match(contract.INSTALL_CHANNELS.homebrew.description, /Cask remains withheld/);
  assert.match(contract.INSTALL_CHANNELS.native.source, /releases\/tag\/v0\.8\.0/);
  assert.match(contract.INSTALL_CHANNELS.native.command("darwin-arm64"), /releases\/download\/v0\.8\.0/);
  for (const channel of ["apt", "dnf", "pacman"]) {
    assert.match(contract.INSTALL_CHANNELS[channel].source, /packages-current-202611-nebular080$/);
    assert.deepEqual(Array.from(contract.INSTALL_CHANNELS[channel].available).sort(), ["linux-arm64", "linux-x64"]);
  }
});

test("default contract observes a source-only pip version change", () => {
  const sourcePath = path.join(siteRoot, "src", "main.mjs");
  const source = fs.readFileSync(sourcePath, "utf8");
  const changed = source.replace('pip: "0.8.0"', 'pip: "0.8.1"');
  assert.notEqual(changed, source);
  const contract = loadInstallContract({}, changed);
  assert.equal(contract.PUBLISHED_CHANNEL_VERSIONS.pip, "0.8.1");
  assert.match(contract.INSTALL_CHANNELS.pip.command("darwin-arm64"), /theme-forge-nebular-fusion==0\.8\.1/);
  assert.equal(contract.PUBLISHED_CHANNEL_VERSIONS.npm, "0.8.0");
  assert.match(contract.INSTALL_CHANNELS.npm.command("darwin-arm64"), /0\.8\.0/);
});

test("preserves independent held-channel behavior under explicit older OS versions", () => {
  const contract = loadInstallContract({ apt: "0.7.1", dnf: "0.7.1", pacman: "0.7.1" });
  const npm = contract.INSTALL_CHANNELS.npm;
  const native = contract.INSTALL_CHANNELS.native;
  assert.equal(npm.publishedVersion, "0.8.0");
  assert.match(npm.command("darwin-arm64"), /theme-forge-nebular-fusion@0\.8\.0/);
  assert.match(npm.source, /releases\/tag\/v0\.8\.0/);
  assert.match(npm.publicationStatus, /0\.8\.0 is published for this channel/);
  assert.equal(native.publishedVersion, "0.8.0");
  assert.match(native.command("darwin-arm64"), /releases\/download\/v0\.8\.0/);
  assert.match(native.command("darwin-arm64"), /theme-forge-nebular-fusion-v0\.8\.0-aarch64-apple-darwin/);
  assert.match(native.source, /releases\/tag\/v0\.8\.0/);
  assert.match(native.publicationStatus, /0\.8\.0 native archive is published for this channel/);
  assert.equal(contract.INSTALL_CHANNELS.homebrew.publishedVersion, "0.8.0");
  assert.match(contract.INSTALL_CHANNELS.homebrew.publicationStatus, /0\.8\.0 is published/);
  for (const channel of ["apt", "dnf", "pacman"]) {
    const held = contract.INSTALL_CHANNELS[channel];
    assert.equal(held.publishedVersion, "0.7.1");
    assert.match(held.publicationStatus, /0\.8\.0 publication hold/);
    assert.doesNotMatch(held.command(held.available[0]), /0\.8\.0/);
  }
});

test("rejects appearance hash drift and cleans only its owned stage", () => {
  const fixture = createFixture();
  try {
    const drifted = path.join(fixture.sourceRoot, "appearances", "anime.css");
    fs.appendFileSync(drifted, "\n/* fixture-only drift */\n");
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "appearance-hash-mismatch");
    assert.equal(fs.existsSync(path.join(fixture.root, "output")), false);
    assert.deepEqual(stageNames(fixture.root), []);
    assert.deepEqual(payloadNames(fixture.root), []);
  } finally {
    removeFixture(fixture);
  }
});

test("rejects a source profile hash drift through the public source manifest", () => {
  const fixture = createFixture();
  try {
    const drifted = path.join(fixture.sourceRoot, "appearances", "profiles", "developer.profile.json");
    fs.appendFileSync(drifted, "\n");
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "appearance-source-hash-mismatch");
    assert.equal(fs.existsSync(path.join(fixture.root, "output")), false);
    assert.deepEqual(stageNames(fixture.root), []);
    assert.deepEqual(payloadNames(fixture.root), []);
  } finally {
    removeFixture(fixture);
  }
});

test("rejects source profile manifest tampering before staging", () => {
  const fixture = createFixture();
  try {
    const manifestPath = path.join(fixture.sourceRoot, "appearances", "source-profiles.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.members[0].sha256 = "0".repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "appearance-source-hash-mismatch");
    assert.equal(fs.existsSync(path.join(fixture.root, "output")), false);
    assert.deepEqual(stageNames(fixture.root), []);
    assert.deepEqual(payloadNames(fixture.root), []);
  } finally {
    removeFixture(fixture);
  }
});

test("rejects coordinated source profile and manifest tampering before staging", () => {
  const fixture = createFixture();
  try {
    const manifestPath = path.join(fixture.sourceRoot, "appearances", "source-profiles.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const member = manifest.members[0];
    const profilePath = path.join(fixture.sourceRoot, member.path);
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    profile.description = "Coordinated tampering must not replace the admitted producer.";
    const bytes = Buffer.from(JSON.stringify(profile, null, 2) + "\n");
    fs.writeFileSync(profilePath, bytes);
    member.size = bytes.length;
    member.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "appearance-source-hash-mismatch");
    assert.equal(fs.existsSync(path.join(fixture.root, "output")), false);
    assert.deepEqual(stageNames(fixture.root), []);
    assert.deepEqual(payloadNames(fixture.root), []);
  } finally {
    removeFixture(fixture);
  }
});

test("rejects removal of the screenshot release boundary before staging", () => {
  const fixture = createFixture();
  try {
    const htmlPath = path.join(fixture.sourceRoot, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");
    fs.writeFileSync(htmlPath, html.replace("not the published Nebular Fusion 0.7.1 interface.", "current release interface."));
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "browser-proof-presentation-mismatch");
    assert.equal(fs.existsSync(path.join(fixture.root, "output")), false);
    assert.deepEqual(stageNames(fixture.root), []);
    assert.deepEqual(payloadNames(fixture.root), []);
  } finally {
    removeFixture(fixture);
  }
});

test("rejects browser proof image or provenance drift before staging", () => {
  const fixture = createFixture();
  try {
    const imagePath = path.join(fixture.sourceRoot, "screenshots", "gamer-dark-shell.jpg");
    fs.appendFileSync(imagePath, Buffer.from([0]));
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "browser-proof-hash-mismatch");
    assert.equal(fs.existsSync(path.join(fixture.root, "output")), false);
    assert.deepEqual(stageNames(fixture.root), []);

    fs.copyFileSync(path.join(siteRoot, "screenshots", "gamer-dark-shell.jpg"), imagePath);
    const provenancePath = path.join(fixture.sourceRoot, "screenshots", "screenshot-provenance.json");
    const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
    provenance.presentation.label = "unqualified";
    fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output-two") }), "browser-proof-provenance-invalid");
    assert.equal(fs.existsSync(path.join(fixture.root, "output-two")), false);
    assert.deepEqual(stageNames(fixture.root), []);
  } finally {
    removeFixture(fixture);
  }
});

test("rejects symlinked public inputs without following them", () => {
  const fixture = createFixture();
  try {
    const symlinkPath = path.join(fixture.sourceRoot, "appearances", "gamer.css");
    fs.unlinkSync(symlinkPath);
    fs.symlinkSync(path.join(fixture.sourceRoot, "appearances", "nebular.css"), symlinkPath);
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "source-entry-rejected");
    assert.equal(fs.existsSync(path.join(fixture.root, "output")), false);
    assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
  } finally {
    removeFixture(fixture);
  }
});

test("preserves the foreign target when the owned stage marker is replaced by a symlink", () => {
  const fixture = createFixture();
  const markerName = ".tfnf-static-stage-owner";
  const foreignTarget = path.join(fixture.root, "foreign-marker-target");
  const originalChmodSync = fs.chmodSync;
  let replaced = false;
  fs.writeFileSync(foreignTarget, "foreign-marker-content\n");
  fs.chmodSync = function patchedChmodSync(filePath, ...args) {
    const result = originalChmodSync.call(fs, filePath, ...args);
    if (!replaced && path.basename(filePath) === markerName) {
      fs.unlinkSync(filePath);
      fs.symlinkSync(foreignTarget, filePath);
      replaced = true;
    }
    return result;
  };
  try {
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "staging-failed");
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(foreignTarget, "utf8"), "foreign-marker-content\n");
    assert.equal(stageNames(fixture.root).length, 1);
    assert.equal(fs.lstatSync(path.join(fixture.root, stageNames(fixture.root)[0], markerName)).isSymbolicLink(), true);
    assert.deepEqual(payloadNames(fixture.root), []);
  } finally {
    fs.chmodSync = originalChmodSync;
    removeFixture(fixture);
  }
});

test("preserves a non-regular replacement of the owned stage marker", () => {
  const fixture = createFixture();
  const markerName = ".tfnf-static-stage-owner";
  const originalChmodSync = fs.chmodSync;
  let replaced = false;
  fs.chmodSync = function patchedChmodSync(filePath, ...args) {
    const result = originalChmodSync.call(fs, filePath, ...args);
    if (!replaced && path.basename(filePath) === markerName) {
      fs.unlinkSync(filePath);
      fs.mkdirSync(filePath);
      replaced = true;
    }
    return result;
  };
  try {
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "staging-failed");
    assert.equal(replaced, true);
    assert.equal(stageNames(fixture.root).length, 1);
    assert.equal(fs.lstatSync(path.join(fixture.root, stageNames(fixture.root)[0], markerName)).isDirectory(), true);
    assert.deepEqual(payloadNames(fixture.root), []);
  } finally {
    fs.chmodSync = originalChmodSync;
    removeFixture(fixture);
  }
});

test("refuses a marker leaf replaced after descriptor open and keeps both owned states", () => {
  const fixture = createFixture();
  const markerName = ".tfnf-static-stage-owner";
  const originalOpenSync = fs.openSync;
  const originalFstatSync = fs.fstatSync;
  let replaced = false;
  let markerOpenCount = 0;
  let markerFd;
  fs.openSync = function patchedOpenSync(filePath, ...args) {
    const fd = originalOpenSync.call(fs, filePath, ...args);
    const flags = args[0];
    const isMarkerVerifierOpen = typeof flags === "number"
      && (flags & fs.constants.O_NOFOLLOW) !== 0
      && path.basename(filePath) === markerName;
    if (isMarkerVerifierOpen) {
      markerOpenCount += 1;
      markerFd = fd;
    }
    return fd;
  };
  fs.fstatSync = function patchedFstatSync(fd, ...args) {
    const result = originalFstatSync.call(fs, fd, ...args);
    if (fd === markerFd && !replaced) {
      replaced = true;
      const markerPath = path.join(fixture.root, stageNames(fixture.root)[0], markerName);
      fs.renameSync(markerPath, `${markerPath}.original`);
      fs.writeFileSync(markerPath, "foreign-marker-content\n");
    }
    return result;
  };
  try {
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "staging-failed");
    assert.equal(replaced, true);
    assert.equal(markerOpenCount, 2);
    assert.equal(stageNames(fixture.root).length, 1);
    const stageDirectory = path.join(fixture.root, stageNames(fixture.root)[0]);
    assert.equal(fs.readFileSync(path.join(stageDirectory, markerName), "utf8"), "foreign-marker-content\n");
    assert.equal(fs.readFileSync(path.join(stageDirectory, `${markerName}.original`), "utf8").endsWith("\n"), true);
    assert.deepEqual(payloadNames(fixture.root), []);
  } finally {
    fs.openSync = originalOpenSync;
    fs.fstatSync = originalFstatSync;
    removeFixture(fixture);
  }
});

test("refuses a foreign payload directory swap before publication", () => {
  const fixture = createFixture();
  const originalChmodSync = fs.chmodSync;
  let swapped = false;
  let foreignPayloadDirectory;
  let originalPayloadDirectory;
  fs.chmodSync = function patchedChmodSync(filePath, ...args) {
    const result = originalChmodSync.call(fs, filePath, ...args);
    const payloadDirectory = path.dirname(filePath);
    if (!swapped && path.basename(filePath) === "manifest.json" && path.basename(payloadDirectory).startsWith(".tfnf-static-payload-")) {
      swapped = true;
      foreignPayloadDirectory = payloadDirectory;
      originalPayloadDirectory = `${payloadDirectory}.original`;
      fs.renameSync(payloadDirectory, originalPayloadDirectory);
      fs.mkdirSync(payloadDirectory);
      fs.writeFileSync(path.join(payloadDirectory, "foreign-sentinel.txt"), "foreign-payload\n");
    }
    return result;
  };
  try {
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "staging-failed");
    assert.equal(swapped, true);
    assert.equal(fs.existsSync(path.join(fixture.root, "output")), false);
    assert.equal(fs.readFileSync(path.join(foreignPayloadDirectory, "foreign-sentinel.txt"), "utf8"), "foreign-payload\n");
    assert.equal(fs.existsSync(originalPayloadDirectory), true);
    assert.equal(stageNames(fixture.root).length, 0);
  } finally {
    fs.chmodSync = originalChmodSync;
    removeFixture(fixture);
  }
});

test("preserves an owner stage with an unexpected extra entry", () => {
  const fixture = createFixture();
  const markerName = ".tfnf-static-stage-owner";
  const originalChmodSync = fs.chmodSync;
  let injected = false;
  let stageDirectory;
  fs.chmodSync = function patchedChmodSync(filePath, ...args) {
    const result = originalChmodSync.call(fs, filePath, ...args);
    if (!injected && path.basename(filePath) === markerName) {
      injected = true;
      stageDirectory = path.dirname(filePath);
      fs.writeFileSync(path.join(stageDirectory, "unexpected-owner-entry"), "foreign-owner\n");
    }
    return result;
  };
  try {
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }), "staging-failed");
    assert.equal(injected, true);
    assert.equal(fs.existsSync(path.join(fixture.root, "output")), false);
    assert.equal(fs.readFileSync(path.join(stageDirectory, "unexpected-owner-entry"), "utf8"), "foreign-owner\n");
    assert.equal(stageNames(fixture.root).length, 1);
    assert.deepEqual(payloadNames(fixture.root), []);
  } finally {
    fs.chmodSync = originalChmodSync;
    removeFixture(fixture);
  }
});

test("cleans an owned stage after a post-create write failure with an intact marker", () => {
  const fixture = createFixture();
  const originalChmodSync = fs.chmodSync;
  let failed = false;
  fs.chmodSync = function patchedChmodSync(filePath, ...args) {
    if (!failed && path.basename(filePath) === "index.html") {
      failed = true;
      throw new Error("controlled post-create failure");
    }
    return originalChmodSync.call(fs, filePath, ...args);
  };
  try {
    assert.throws(
      () => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: path.join(fixture.root, "output") }),
      (error) => error instanceof StaticBuildError,
    );
    assert.equal(failed, true);
    assert.equal(fs.existsSync(path.join(fixture.root, "output")), false);
    assert.deepEqual(stageNames(fixture.root), []);
    assert.deepEqual(payloadNames(fixture.root), []);
  } finally {
    fs.chmodSync = originalChmodSync;
    removeFixture(fixture);
  }
});

test("preserves a foreign existing output directory", () => {
  const fixture = createFixture();
  try {
    const output = path.join(fixture.root, "output");
    fs.mkdirSync(output);
    const sentinel = path.join(output, "foreign.txt");
    fs.writeFileSync(sentinel, "foreign-owned\n");
    const before = fs.readFileSync(sentinel);
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: output }), "output-exists");
    assert.deepEqual(fs.readFileSync(sentinel), before);
    assert.deepEqual(stageNames(fixture.root), []);
  } finally {
    removeFixture(fixture);
  }
});

test("preserves a foreign output symlink", () => {
  const fixture = createFixture();
  try {
    const target = path.join(fixture.root, "foreign-target");
    const output = path.join(fixture.root, "output");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "foreign.txt"), "foreign-owned\n");
    fs.symlinkSync(target, output);
    assertBuildError(() => buildStaticSite({ sourceRoot: fixture.sourceRoot, outputDir: output }), "output-exists");
    assert.equal(fs.lstatSync(output).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(target, "foreign.txt"), "utf8"), "foreign-owned\n");
    assert.deepEqual(stageNames(fixture.root), []);
  } finally {
    removeFixture(fixture);
  }
});
