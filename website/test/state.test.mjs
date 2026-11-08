import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDemoState,
  resolveSiteTheme,
  selectFamily,
  setInstallChannel,
  setInstallPlatform,
  setMockRadius,
  setMockRoleValue,
  setPreviewMode,
  setSiteTheme,
  setWorkflowStep,
} from "../src/state.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((channel) => Number.parseInt(channel, 16) / 255);
  return channels
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test("the demonstration starts in a system-aware paired state", () => {
  const state = createDemoState();
  assert.equal(state.siteTheme, "system");
  assert.equal(state.activeFamily, "nebular");
  assert.equal(state.previewMode, "paired");
  assert.equal(state.workflowStep, "brief");
  assert.equal(resolveSiteTheme("system", "light"), "light");
  assert.equal(resolveSiteTheme("system", "dark"), "dark");
});

test("family, preview, and workflow transitions are bounded", () => {
  const state = createDemoState();
  assert.equal(selectFamily(state, "gamer").activeFamily, "gamer");
  assert.equal(selectFamily(state, "not-a-family"), state);
  assert.equal(setPreviewMode(state, "dark").previewMode, "dark");
  assert.equal(setWorkflowStep(state, "export").workflowStep, "export");
  assert.equal(setPreviewMode(state, "split"), state);
  assert.equal(setWorkflowStep(state, "ship"), state);
});

test("site mode and install selectors do not mutate the prior state", () => {
  const state = createDemoState();
  const next = setInstallChannel(setInstallPlatform(setSiteTheme(state, "light"), "linux-x64"), "dnf");
  assert.equal(state.siteTheme, "system");
  assert.equal(state.installPlatform, "darwin-arm64");
  assert.equal(state.installChannel, "npm");
  assert.deepEqual(
    { siteTheme: next.siteTheme, installPlatform: next.installPlatform, installChannel: next.installChannel },
    { siteTheme: "light", installPlatform: "linux-x64", installChannel: "dnf" },
  );
  const channelDisabledByPlatform = setInstallPlatform(setInstallChannel(state, "homebrew"), "linux-x64");
  assert.deepEqual(
    {
      installPlatform: channelDisabledByPlatform.installPlatform,
      installChannel: channelDisabledByPlatform.installChannel,
    },
    { installPlatform: "linux-x64", installChannel: "npm" },
  );
  assert.equal(setSiteTheme(state, "sepia"), state);
  assert.equal(setInstallPlatform(state, "windows-x64"), state);
  assert.equal(setInstallChannel(state, "curl"), state);
  assert.equal(setInstallChannel(state, "apt"), state);
});

test("mock color and radius controls reject unsafe values and clamp radius", () => {
  const state = createDemoState();
  assert.equal(setMockRoleValue(state, "accent", "#D4A95F").roleValues.accent, "#d4a95f");
  assert.equal(setMockRoleValue(state, "accent", "red"), state);
  assert.equal(setMockRoleValue(state, "unknown", "#ffffff"), state);
  assert.equal(setMockRadius(state, 3).mockRadius, 8);
  assert.equal(setMockRadius(state, 40).mockRadius, 24);
  assert.equal(setMockRadius(state, "16").mockRadius, 16);
  assert.equal(setMockRadius(state, "not-a-number"), state);
});

test("the catalog uses isolated iframe consumers for all six families", () => {
  const index = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  const specimen = fs.readFileSync(path.join(siteRoot, "appearances", "specimen.html"), "utf8");
  assert.equal((index.match(/appearances\/specimen\.html\?family=/g) ?? []).length, 12);
  assert.equal(index.includes("srcdoc="), false);
  for (const family of ["terminal-nova", "nebular", "developer", "graphic-designer", "anime", "gamer"]) {
    assert.match(index, new RegExp(`family=${family}&amp;mode=(?:light|dark)`));
    assert.ok(specimen.includes(family), `specimen must include the ${family} family id`);
  }
  assert.match(specimen, /sheet\.href = `\.\/\$\{family\}\.css`/);
});

test("the light mock preview separates readable foreground, accent, and border roles", () => {
  const styles = fs.readFileSync(path.join(siteRoot, "styles.css"), "utf8");
  assert.match(styles, /--mini-light-foreground:\s*#2e2433/);
  assert.match(styles, /--mini-light-accent:\s*#7a4c0c/);
  assert.match(styles, /--mini-light-border:\s*#8a7684/);
  assert.match(styles, /\.mini-preview-light \.mini-action[\s\S]*?border-color:\s*var\(--mini-light-accent\)/);
  assert.match(styles, /\.mini-preview-light \.mini-preview-content p[\s\S]*?color:\s*var\(--mini-light-muted\)/);
  assert.ok(contrastRatio("#2e2433", "#f4ede4") >= 4.5);
  assert.ok(contrastRatio("#4f4558", "#f4ede4") >= 4.5);
  assert.ok(contrastRatio("#7a4c0c", "#f4ede4") >= 4.5);
  assert.ok(contrastRatio("#8a7684", "#f4ede4") >= 3);
});
