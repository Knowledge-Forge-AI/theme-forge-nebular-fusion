import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  REQUIRED_ROLES,
  buildExpectations,
  extractRoleSets,
  parseCatalogSource,
  verifyExpectationsArtifact,
} from "../generate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(process.cwd());
const runtimePath = resolve(fixture, "src/features/appearance/generated/runtime-baselines.ts");
const catalogPath = resolve(fixture, "src/features/appearance/generated/catalog-index.json");
const expectationsPath = resolve(fixture, "src-tauri/src/release_smoke/appearance-role-expectations.v1.json");
const runtimeText = readFileSync(runtimePath, "utf8");
const catalogText = readFileSync(catalogPath, "utf8");
const generatorText = readFileSync(resolve(here, "../generate.mjs"), "utf8");
const runtimeSourcePath = "frontend-fixture/src/features/appearance/generated/runtime-baselines.ts";
const catalogSourcePath = "frontend-fixture/src/features/appearance/generated/catalog-index.json";

function buildFixture() {
  return buildExpectations({
    runtimeText,
    catalogText,
    runtimePath: runtimeSourcePath,
    catalogPath: catalogSourcePath,
  });
}

function rolePattern(role) {
  return new RegExp(`(${role}\\s*:\\s*[^;]+;)`, "u");
}

function mutateFirstRoot(source, mutate) {
  const marker = ":root {";
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, "fixture must contain a baseline :root block");
  const prefix = source.slice(0, index);
  const block = source.slice(index);
  return `${prefix}${mutate(block)}`;
}

function removeFirstRole(source, role) {
  const pattern = rolePattern(role);
  return mutateFirstRoot(source, (block) => block.replace(pattern, ""));
}

function duplicateFirstRole(source, role) {
  const pattern = rolePattern(role);
  return mutateFirstRoot(source, (block) => block.replace(pattern, "$1$1"));
}

function makeDynamicFirstRole(source, role) {
  const pattern = rolePattern(role);
  return mutateFirstRoot(source, (block) => block.replace(pattern, `${role}: var(--unsupported);`));
}

test("defaults are checkout-local and do not climb to a private fixture path", () => {
  const legacyFixtureClimb = ["..", "..", "..", "frontend-fixture"].join("/");
  assert.equal(generatorText.includes(legacyFixtureClimb), false);
  assert.match(generatorText, /optionValue\(args, "--checkout-root", process\.cwd\(\)\)/u);
  assert.match(generatorText, /src-tauri\/src\/release_smoke\/appearance-role-expectations\.v1\.json/u);
});

test("generates exactly twelve ordered rows and verifies the committed artifact", () => {
  const artifact = buildFixture();
  assert.deepEqual(artifact.roles, REQUIRED_ROLES);
  assert.equal(artifact.rows.length, 12);
  assert.deepEqual(
    artifact.rows.map(({ family, mode }) => `${family}/${mode}`),
    [
      "terminal-nova/light", "nebular/light", "developer/light",
      "graphic-designer/light", "anime/light", "gamer/light",
      "terminal-nova/dark", "nebular/dark", "developer/dark",
      "graphic-designer/dark", "anime/dark", "gamer/dark",
    ],
  );
  for (const row of artifact.rows) {
    assert.deepEqual(Object.keys(row.roles), REQUIRED_ROLES);
    for (const value of Object.values(row.roles)) assert.ok(value.length > 0);
  }
  assert.equal(verifyExpectationsArtifact(artifact, { runtimeText, catalogText }), true);
  const committed = JSON.parse(readFileSync(expectationsPath, "utf8"));
  assert.deepEqual(committed, artifact);
});

test("applies the ordered dark cascade and keeps root values when dark omits a role", () => {
  const css = `@layer baseline {
    :root {
      --background: light-background;
      --primary: light-primary;
      --tf-appearance-font-ui: light-font;
      --tf-appearance-radius-surface: 8px;
      --tf-appearance-selection: light-selection;
      --tf-appearance-selection-text: light-selection-text;
    }
    .dark, :root[data-theme='dark'] {
      --background: dark-background;
      --primary: dark-primary;
      --tf-appearance-selection: dark-selection;
      --tf-appearance-selection-text: dark-selection-text;
    }
  }`;
  const result = extractRoleSets(css);
  assert.equal(result.light["--background"], "light-background");
  assert.equal(result.dark["--background"], "dark-background");
  assert.equal(result.dark["--primary"], "dark-primary");
  assert.equal(result.dark["--tf-appearance-font-ui"], "light-font");
  assert.equal(result.dark["--tf-appearance-radius-surface"], "8px");
  assert.equal(result.dark["--tf-appearance-selection"], "dark-selection");
});

test("rejects a missing required role instead of silently inheriting an unrelated value", () => {
  const missing = removeFirstRole(runtimeText, "--background");
  assert.throws(
    () => buildExpectations({ runtimeText: missing, catalogText, runtimePath: runtimeSourcePath, catalogPath: catalogSourcePath }),
    (error) => error?.code === "MISSING_REQUIRED_ROLE",
  );
});

test("rejects duplicate declarations in one cascade layer as ambiguous", () => {
  const ambiguous = duplicateFirstRole(runtimeText, "--primary");
  assert.throws(
    () => buildExpectations({ runtimeText: ambiguous, catalogText, runtimePath: runtimeSourcePath, catalogPath: catalogSourcePath }),
    (error) => error?.code === "AMBIGUOUS_REQUIRED_ROLE",
  );
});

test("rejects dynamic custom-property values instead of recording a runtime promise", () => {
  const dynamic = makeDynamicFirstRole(runtimeText, "--background");
  assert.throws(
    () => buildExpectations({ runtimeText: dynamic, catalogText, runtimePath: runtimeSourcePath, catalogPath: catalogSourcePath }),
    (error) => error?.code === "UNSUPPORTED_DYNAMIC_VALUE",
  );
});

test("rejects catalog order drift before producing rows", () => {
  const catalog = JSON.parse(catalogText);
  [catalog.families[0], catalog.families[1]] = [catalog.families[1], catalog.families[0]];
  assert.throws(() => parseCatalogSource(JSON.stringify(catalog)), (error) => error?.code === "INVALID_CATALOG");
});

test("rejects a stale source digest even when the old rows are otherwise valid", () => {
  const artifact = buildFixture();
  assert.throws(
    () => verifyExpectationsArtifact(artifact, { runtimeText: `${runtimeText}\n`, catalogText }),
    (error) => error?.code === "STALE_SOURCE",
  );
});

