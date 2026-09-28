import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { TARGETS, targetForHost, targetForTriple, payloadLayout, resourceDirectories, resourcePreparationPlan } from "./platform-targets.mjs";

test("raw staging consumes the Tauri resource declaration and rejects unsupported shapes", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.deepEqual(resourceDirectories(config).map(path => `${path}/**/*`), config.bundle.resources);
  const extended = structuredClone(config);
  extended.bundle.resources.push("new-resource/**/*");
  assert.ok(resourceDirectories(extended).includes("new-resource"));
  for (const resources of [["../escape/**/*"], ["assets/file.json"], ["assets/**/*", "assets/**/*"], {}, []]) {
    assert.throws(() => resourceDirectories({ bundle: { resources } }), /resource/);
  }
});

test("product selectors map exactly three platforms without foreign fallback", () => {
  assert.equal(TARGETS.length, 3);
  for (const target of TARGETS) {
    assert.equal(targetForTriple(target.triple), target);
    assert.equal(targetForHost(target.os, target.cpu), target);
  }
  for (const [os, cpu] of [["darwin", "x64"], ["win32", "x64"], ["linux", "ia32"]]) {
    assert.throws(() => targetForHost(os, cpu), /Unsupported/);
  }
  assert.throws(() => targetForTriple("x86_64-unknown-linux-musl"), /Unsupported/);
});

test("Linux resources use the product executable-relative slug layout", () => {
  for (const target of TARGETS.filter(target => target.os === "linux")) {
    assert.deepEqual(payloadLayout(target), {
      executable: "bin/theme-forge-nebular-fusion",
      resources: "lib/theme-forge-nebular-fusion",
    });
    assert.ok(!JSON.stringify(payloadLayout(target)).includes(".app"));
  }
  assert.throws(() => payloadLayout({ os: "linux" }), /Unknown/);
});


test("preparation and every target staging cover exactly Tauri resources", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  for (const target of TARGETS) {
    const plan = resourcePreparationPlan(config, target);
    assert.deepEqual(plan.map(entry => `${entry.directory}/**/*`), config.bundle.resources);
    assert.ok(plan.every(entry => entry.applicable === true && entry.target === target.triple));
    for (const resources of [config.bundle.resources.filter(path => !path.startsWith("scene-")), [...config.bundle.resources, "unowned/**/*"]]) {
      assert.throws(() => resourcePreparationPlan({ bundle: { resources } }, target), /ownership disagree/);
    }
  }
});
