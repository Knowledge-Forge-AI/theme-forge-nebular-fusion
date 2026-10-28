import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import vm from "node:vm";

const driverPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/release_smoke/driver.js");
const driverSource = readFileSync(driverPath, "utf8");
const genericFailure = "The typed plan operation failed without exposing private sidecar details.";
const outcomes = [
  "The operation was cancelled.",
  "Plan ready for review.",
  "The operation was already complete or did not belong to this session.",
];

function makeNode(getText, { disabled = false, onClick = () => {} } = {}) {
  return {
    get textContent() { return getText(); },
    disabled,
    closest: () => null,
    click: onClick,
  };
}

function harness(mode) {
  const state = {
    phase: "initial",
    announcement: "",
    progress: "",
    bodyExtra: "",
    sidecarState: "ready",
    cancelEnabled: false,
    cancelClicked: false,
    discardAvailable: false,
    timerCalls: 0,
    clock: 0,
  };

  const onReview = () => {
    state.phase = "planning";
    if (mode === "ready") {
      state.announcement = "Plan ready for review.";
      state.discardAvailable = true;
    } else if (mode === "cancelled") {
      state.announcement = "The operation was cancelled.";
    } else if (mode === "prehandle-failure" || mode === "failure-with-cancel") {
      state.announcement = genericFailure;
      state.sidecarState = "failed";
      state.cancelEnabled = mode === "failure-with-cancel";
    } else if (mode === "postcancel-failure") {
      state.cancelEnabled = true;
      state.bodyExtra = "Plan ready for review.";
    } else if (mode === "prehandle") {
      state.progress = "Planning · waiting for operation handle";
    } else if (mode === "timeout") {
      state.progress = "Planning · ".concat("x".repeat(500));
      state.sidecarState = "starting";
    }
  };

  const onCancel = () => {
    state.cancelClicked = true;
    state.cancelEnabled = false;
    if (mode === "prehandle" || mode === "postcancel-success") state.announcement = "The operation was cancelled.";
    if (mode === "postcancel-failure") {
      state.announcement = genericFailure;
      state.sidecarState = "failed";
    }
  };

  const buttonsFor = () => {
    if (state.phase === "initial") return [makeNode(() => "Recipes", { onClick: () => { state.phase = "recipes"; } })];
    if (state.phase === "recipes") return [makeNode(() => "Review derive plan", { onClick: onReview })];
    const buttons = [];
    if (state.cancelEnabled || mode === "prehandle" || mode === "postcancel-failure") {
      buttons.push(makeNode(() => "Cancel operation", { disabled: !state.cancelEnabled, onClick: onCancel }));
    }
    if (state.discardAvailable) {
      buttons.push(makeNode(() => "Discard plan", { onClick: () => {
        state.discardAvailable = false;
        state.announcement = "";
        state.bodyExtra = "The plan was discarded.";
      } }));
    }
    return buttons;
  };

  const nav = { querySelectorAll: (selector) => selector === "button" ? buttonsFor() : [] };
  const statusNode = makeNode(() => state.announcement);
  const sidecarStateNode = makeNode(() => state.sidecarState);
  const sidecarStateLabel = { textContent: "Sidecar state", nextElementSibling: sidecarStateNode };
  const progressNode = makeNode(() => state.progress);
  const document = {
    body: { get textContent() { return [state.announcement, state.progress, state.bodyExtra].filter(Boolean).join(" "); } },
    querySelector(selector) {
      if (selector === 'nav[aria-label="Brand workbench views"]') return nav;
      if (selector === '.plan-workspace p[role="status"]') return statusNode;
      if (selector === "[aria-label='Plan operation progress']") return progressNode;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "button") return buttonsFor();
      if (selector === "dt") return [sidecarStateLabel];
      return [];
    },
  };

  const setTimeout = (callback) => {
    state.timerCalls += 1;
    if (mode === "prehandle" && state.timerCalls === 1) state.cancelEnabled = true;
    if (mode === "timeout" && state.timerCalls === 1) state.clock = 10_001;
    callback();
    return state.timerCalls;
  };
  const context = {
    clearTimeout: () => {},
    Date: { now: () => state.clock },
    document,
    setTimeout,
    window: {
      __NEBULAR_RELEASE_SMOKE_CONFIG__: { scenario: "__connected-driver-test__" },
    },
  };
  const marker = "  main().catch((error) => {";
  assert.equal(driverSource.includes(marker), true);
  const instrumented = driverSource.replace(marker, `  window.__driverTest = { deriveCancel };\n${marker}`);
  vm.runInNewContext(instrumented, context, { timeout: 1_000 });
  return { context, state, deriveCancel: context.window.__driverTest.deriveCancel };
}

async function runConnected(mode) {
  const fixture = harness(mode);
  const result = await fixture.deriveCancel();
  return { ...fixture, result, progress: fixture.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__ };
}

test("connected flow gives a public failure precedence over an enabled cancel button", async () => {
  const run = await runConnected("failure-with-cancel");
  assert.equal(run.result, false);
  assert.equal(run.state.cancelClicked, false);
  assert.match(run.progress.steps.at(-1).detail, /plan operation failed/);
  assert.match(run.progress.steps.at(-1).detail, /typed plan operation failed/);
  assert.equal(run.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.facts.at(-1)[0], "deriveCancelLifecycle");
  assert.equal(run.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.facts.at(-1)[1], "failed");
});

test("connected flow waits through pre-handle planning and then cancels the enabled handle", async () => {
  const run = await runConnected("prehandle");
  assert.equal(run.result, true);
  assert.equal(run.state.cancelClicked, true);
  assert.equal(run.state.timerCalls, 1);
  assert.match(run.progress.steps.at(-1).detail, /cancel requested/);
});

test("connected flow preserves fast ready and cancellation terminal text", async () => {
  const ready = await runConnected("ready");
  assert.equal(ready.result, true);
  assert.match(ready.progress.steps.at(-1).detail, /finished before cancel/);
  const cancelled = await runConnected("cancelled");
  assert.equal(cancelled.result, true);
  assert.match(cancelled.progress.steps.at(-1).detail, /The operation was cancelled/);
});

test("connected flow rejects a pre-handle public failure", async () => {
  const run = await runConnected("prehandle-failure");
  assert.equal(run.result, false);
  assert.equal(run.state.cancelClicked, false);
  assert.match(run.progress.steps.at(-1).detail, /typed plan operation failed/);
  assert.equal(run.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.facts.at(-1)[0], "deriveCancelLifecycle");
  assert.equal(run.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.facts.at(-1)[1], "failed");
});

test("connected post-cancel wait prefers current failure over stale ready body text", async () => {
  const run = await runConnected("postcancel-failure");
  assert.equal(run.result, false);
  assert.equal(run.state.cancelClicked, true);
  assert.equal(run.state.timerCalls, 0);
  assert.match(run.context.document.body.textContent, /Plan ready for review/);
  assert.match(run.progress.steps.at(-1).detail, /typed plan operation failed/);
  assert.equal(run.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.facts.at(-1)[0], "deriveCancelLifecycle");
  assert.equal(run.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.facts.at(-1)[1], "failed");
});

test("connected timeout reports bounded public progress and retains both deadlines", async () => {
  const run = await runConnected("timeout");
  assert.equal(run.result, false);
  assert.equal(run.state.timerCalls, 1);
  assert.match(run.progress.steps.at(-1).detail, /progress="Planning/);
  assert.equal(run.progress.steps.at(-1).detail.includes("x".repeat(241)), false);
  assert.equal(run.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.facts.at(-1)[0], "deriveCancelLifecycle");
  assert.equal(run.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.facts.at(-1)[1], "other");
  assert.match(driverSource, /cancellable operation or outcome", 10000/);
  assert.match(driverSource, /plan outcome after cancel", 90000/);
  assert.match(driverSource, /The exact plan was applied and canonical reads refreshed\./);
});
