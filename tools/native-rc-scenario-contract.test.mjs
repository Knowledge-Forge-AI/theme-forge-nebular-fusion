import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const proposalNative = path.resolve(here, "..");
const maintainedNative = path.resolve(here, "..", "src-tauri", "src");
const native = fs.existsSync(path.join(proposalNative, "release_smoke", "mod.rs"))
  ? proposalNative
  : maintainedNative;
const source = (relative) => fs.readFileSync(path.join(native, relative), "utf8");
const mod = source("release_smoke/mod.rs");
const io = source("release_smoke/io.rs");
const driver = source("release_smoke/driver.js");
const appTheme = source("commands/app_theme.rs");
const packet = source("commands/theme_packet.rs");
const expectationsSource = source("release_smoke/appearance-role-expectations.v1.json");
const expectations = JSON.parse(expectationsSource);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function test(name, run) {
  run();
  process.stdout.write(`ok - ${name}\n`);
}

test("scenario and platform vocabulary is closed", () => {
  for (const value of ["P-save", "P-restart", "paired-v2"]) assert.match(mod, new RegExp(`\\"${value}\\"`));
  assert.match(mod, /\[\"darwin-arm64\", \"linux-arm64\", \"linux-x64\"\]/);
  assert.match(mod, /TFNF_RELEASE_SMOKE_PREFERENCES_DIR/);
  assert.match(mod, /appearance preference parent requires an appearance pair scenario/);
});

test("fixed pair marker and receipt names stay bounded", () => {
  const pairId = "appearance-pair-v1-lane-a-01";
  const marker = `nebular.appearance-pair-v1\n${pairId}\n`;
  assert.equal(Buffer.byteLength(marker), marker.length);
  assert.match(io, /PAIR_MARKER: &str = "\.nebular-appearance-pair-v1"/);
  assert.match(io, /expected_marker = format!\("nebular\.appearance-pair-v1\\n\{pair_id\}\\n"\)/);
  assert.match(io, /marker_size/);
  assert.match(io, /other_view/);
});

test("generated appearance table is source-bound, ordered and hash-checked", () => {
  assert.equal(
    sha256(expectationsSource),
    "602c8f16c896ee30a4ce34e018c2243dfb892c2bf261d002f9af6b30511023f6",
  );
  assert.equal(expectations.schema, "theme-forge.appearance-role-expectations.v1");
  assert.deepEqual(expectations.roles, [
    "--background",
    "--primary",
    "--tf-appearance-font-ui",
    "--tf-appearance-radius-surface",
    "--tf-appearance-selection",
    "--tf-appearance-selection-text",
  ]);
  const families = ["terminal-nova", "nebular", "developer", "graphic-designer", "anime", "gamer"];
  assert.deepEqual(expectations.rows.map(({ family }) => family), [...families, ...families]);
  assert.deepEqual(expectations.rows.map(({ mode }) => mode), [...families.map(() => "light"), ...families.map(() => "dark")]);
  assert.equal(
    sha256(JSON.stringify(expectations.rows)),
    "4e77ceaf04d092c0f83af37231cc740f578108116efa9c57debe84a41b7efa4f",
  );
  assert.equal(expectations.canonicalRowsSha256, "4e77ceaf04d092c0f83af37231cc740f578108116efa9c57debe84a41b7efa4f");
  assert.match(mod, /include_str!\("appearance-role-expectations\.v1\.json"\)/);
});

test("P-save record bytes and dark-mode observables are fixed", () => {
  const canonical = '{"version":1,"mode":"dark","light":"developer","dark":"developer"}';
  assert.equal(crypto.createHash("sha256").update(canonical).digest("hex"), "11ed5c176d7725adcb7911ceb7a9a11943af63197dbee5d2e4317dc1df8c7540");
  assert.match(driver, /Application display mode/);
  assert.match(driver, /data-theme/);
  assert.match(driver, /#65b4d7/);
  assert.match(driver, /appearance-record-mismatch/);
});

test("paired picker consultation is exact and non-paired keys reject", () => {
  for (const name of ["baseline.theme.json", "candidate-v2.json", "v2-saved.theme.json"]) assert.match(mod, new RegExp(name.replaceAll(".", "\\.")));
  assert.match(mod, /"tf-paired-profile-v2-candidate"/);
  assert.match(appTheme, /paired_path\(&app, "open"\)/);
  assert.match(appTheme, /paired_save_path_key\(request\.save_mode\)/);
  assert.match(appTheme, /paired_path\(&app, key\)/);
  assert.match(appTheme, /reject_nonpaired_path\(&app\)/);
  assert.match(packet, /expected_kind\.as_deref\(\) != Some\("tf-paired-profile-v2-candidate"\)/);
  assert.match(packet, /PairedV2PacketKind::Candidate/);
  assert.match(packet, /reject_nonpaired_path\(&app\)/);
});

test("driver stays DOM-first for compile/save/reset/packet actions", () => {
  for (const command of [
    "studio_app_theme_compile",
    "studio_app_theme_save_profile",
    "studio_app_theme_save_profile_v2",
    "studio_app_theme_reset",
    "studio_theme_packet_import",
    "studio_theme_packet_export",
    "studio_appearance_preferences_save",
  ]) assert.doesNotMatch(driver, new RegExp(`invoke\\(\\\"${command}\\\"`));
  assert.match(driver, /candidateDiscardConfirm/);
  assert.match(driver, /reopenConfirmCalls/);
  assert.match(driver, /activeDocumentId/);
  assert.match(driver, /paired-appearance-dark/);
});

test("pair layout model rejects extras and accepts the exact four root entries", () => {
  const expected = new Set([".nebular-appearance-pair-v1", "shared-prefs", "view-a", "view-b"]);
  const exact = [".nebular-appearance-pair-v1", "shared-prefs", "view-a", "view-b"];
  assert.deepEqual(new Set(exact), expected);
  assert.equal(new Set([...exact, "unexpected"]).size, 5);
  assert.match(io, /exact_children\(\s*&pair_root,\s*&\[PAIR_MARKER,\s*PAIR_SHARED_DIR,\s*"view-a",\s*"view-b"\]\s*,?\s*\)/);
  assert.match(io, /owner_only_file\(&marker, 0o600, 1, expected_uid\)/);
  assert.match(io, /owner_only_file\(&preferences\.join\("appearance\.json"\), 0o600, 1, expected_uid\)/);
});

test("proposal validator has no directory-creation authority", () => {
  const validator = io.slice(io.indexOf("pub(super) fn validated_appearance_preferences"), io.indexOf("fn validated_exchange_directory"));
  assert.doesNotMatch(validator, /create_dir_all|create_dir\(/);
  assert.match(io, /function never\n\/\/\/ creates, repairs, or deletes/);
  assert.match(mod, /validated_appearance_preferences/);
});

test("paired order is present in the actual driver scenario array and keeps reset inside apply", () => {
  const order = [
    "shell", "pairedAppTheme", "pairedOpenDeveloper", "pairedBrief", "pairedThreeEdits",
    "pairedCompileBoth", "pairedPreviewAcks", "pairedCandidateCreate", "pairedReviewAssociation",
    "pairedSelectCandidate", "pairedAppearanceDark", "pairedApplyDetached", "pairedSaveAsFreeze",
    "pairedReopenSaved", "pairedAppearanceMatrix",
  ];
  const planStart = driver.indexOf('    "paired-v2": [');
  const planEnd = driver.indexOf("],", planStart);
  assert.ok(planStart >= 0 && planEnd > planStart, "paired-v2 scenario array must be present");
  const plan = driver.slice(planStart, planEnd);
  let previous = -1;
  for (const step of order) {
    const index = plan.indexOf(step);
    assert.ok(index > previous, `${step} must follow the preceding fixed step`);
    previous = index;
  }
  assert.match(driver, /step\("paired-appearance-matrix"/);
  assert.match(driver, /click\("Reset appearance"\)/);
  assert.ok(driver.indexOf('step("paired-apply-detached"') < driver.indexOf('step("paired-save-as"'));
  assert.match(driver, /window\.confirm = \(message\) =>/);
  assert.match(driver, /if \(calls !== 0\) throw new Error\(`reopenConfirmCalls=/);
});

