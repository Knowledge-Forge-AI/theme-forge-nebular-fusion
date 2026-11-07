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

function reopenHarness({
  afterStatus,
  sourceName = "v2-saved.theme.json",
  revision = "Editor revision 0",
  sourceSummary = "Verified source bytes",
  frozen = false,
  history = true,
  confirm = false,
} = {}) {
  const expectedConfirmation = "Discard the current unsaved editor or application draft and reopen the source?";
  let statusCalls = 0;
  let clock = 0;
  const beforeStatus = {
    available: true,
    pairedV2Authoring: { sessionId: "before-session", supported: true },
  };
  const nodeText = (value) => makeNode(() => value);
  const reopenButton = makeNode(() => "Reopen", {
    onClick: () => {
      if (confirm) context.window.confirm(expectedConfirmation);
    },
  });
  const panel = {
    get textContent() {
      return [sourceName, sourceSummary, frozen ? "This saved source is held unchanged." : ""].filter(Boolean).join(" ");
    },
    closest: () => null,
    querySelector(selector) {
      if (selector === ".paired-v2-source-name") return nodeText(sourceName);
      if (selector === ".paired-v2-source-summary") return nodeText(sourceSummary);
      return null;
    },
    querySelectorAll(selector) {
      return selector === "button" ? [reopenButton] : [];
    },
  };
  const document = {
    body: { get textContent() { return history ? "Studio history: original source" : ""; } },
    querySelector(selector) {
      if (selector === '[data-testid="paired-v2-authoring-panel"]') return panel;
      if (selector === '[data-testid="paired-v2-editor-revision"]') return nodeText(revision);
      return null;
    },
    querySelectorAll: () => [],
  };
  const originalConfirm = () => false;
  const context = {
    clearTimeout: () => {},
    Date: { now: () => clock },
    document,
    setTimeout: (callback) => {
      clock += 90_000;
      callback();
      return 1;
    },
    window: {
      __NEBULAR_RELEASE_SMOKE_CONFIG__: { scenario: "__connected-driver-test__" },
      __TAURI_INTERNALS__: {
        invoke: async (command) => {
          assert.equal(command, "studio_app_theme_status");
          statusCalls += 1;
          return statusCalls === 1 ? beforeStatus : afterStatus;
        },
      },
      confirm: originalConfirm,
    },
  };
  const marker = "  main().catch((error) => {";
  assert.equal(driverSource.includes(marker), true);
  const instrumented = driverSource.replace(marker, `  window.__driverTest = { pairedReopenSaved };\n${marker}`);
  vm.runInNewContext(instrumented, context, { timeout: 1_000 });
  return { context, originalConfirm, statusCalls: () => statusCalls, pairedReopenSaved: context.window.__driverTest.pairedReopenSaved };
}

async function runReopen(options) {
  const fixture = reopenHarness(options);
  const result = await fixture.pairedReopenSaved();
  return { ...fixture, result, progress: fixture.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__ };
}

test("paired reopen accepts the optional legacy root handle without an omission rule", async () => {
  const run = await runReopen({
    afterStatus: {
      available: true,
      activeDocumentId: "opaque-document-handle",
      pairedV2Authoring: { sessionId: "after-session", supported: true },
    },
  });
  assert.equal(run.result, true);
  assert.equal(run.statusCalls(), 2);
  assert.equal(run.progress.steps.at(-1).ok, true);
  assert.equal(run.context.window.confirm, run.originalConfirm);
  assert.deepEqual(Array.from(run.progress.facts.at(-1)), ["reopenConfirmCalls", "0"]);
});

test("paired reopen refuses a missing or empty nested v2 session", async () => {
  for (const pairedV2Authoring of [{ supported: true }, { sessionId: "", supported: true }]) {
    const run = await runReopen({ afterStatus: { available: true, pairedV2Authoring } });
    assert.equal(run.result, false);
    assert.equal(run.statusCalls(), 2);
    assert.equal(run.context.window.confirm, run.originalConfirm);
    assert.match(run.progress.steps.at(-1).detail, /timed out waiting for reopened saved source/);
  }
});

test("paired reopen refuses an unchanged nested v2 session", async () => {
  const run = await runReopen({
    afterStatus: { available: true, pairedV2Authoring: { sessionId: "before-session", supported: true } },
  });
  assert.equal(run.result, false);
  assert.equal(run.statusCalls(), 2);
  assert.equal(run.context.window.confirm, run.originalConfirm);
  assert.match(run.progress.steps.at(-1).detail, /timed out waiting for reopened saved source/);
});

test("paired reopen keeps source identity and confirmation guards fail closed", async () => {
  const wrongSource = await runReopen({
    afterStatus: { available: true, pairedV2Authoring: { sessionId: "after-session", supported: true } },
    sourceName: "unexpected.theme.json",
  });
  assert.equal(wrongSource.result, false);
  assert.equal(wrongSource.statusCalls(), 2);
  assert.equal(wrongSource.context.window.confirm, wrongSource.originalConfirm);
  assert.match(wrongSource.progress.steps.at(-1).detail, /timed out waiting for reopened saved source/);

  const confirmed = await runReopen({
    afterStatus: { available: true, pairedV2Authoring: { sessionId: "after-session", supported: true } },
    confirm: true,
  });
  assert.equal(confirmed.result, false);
  assert.equal(confirmed.statusCalls(), 1);
  assert.equal(confirmed.context.window.confirm, confirmed.originalConfirm);
  assert.match(confirmed.progress.steps.at(-1).detail, /reopenConfirmCalls=1/);
});

test("paired reopen refuses a nonzero revision", async () => {
  const run = await runReopen({
    afterStatus: { available: true, pairedV2Authoring: { sessionId: "after-session", supported: true } },
    revision: "Editor revision 1",
  });
  assert.equal(run.result, false);
  assert.equal(run.statusCalls(), 2);
  assert.equal(run.context.window.confirm, run.originalConfirm);
  assert.match(run.progress.steps.at(-1).detail, /timed out waiting for reopened saved source/);
});

test("paired reopen refuses detached-only and mixed custody summaries", async () => {
  for (const sourceSummary of ["Detached verified bytes", "Verified source bytes; Detached verified bytes"]) {
    const run = await runReopen({
      afterStatus: { available: true, pairedV2Authoring: { sessionId: "after-session", supported: true } },
      sourceSummary,
    });
    assert.equal(run.result, false);
    assert.equal(run.statusCalls(), 2);
    assert.equal(run.context.window.confirm, run.originalConfirm);
    assert.match(run.progress.steps.at(-1).detail, /timed out waiting for reopened saved source/);
  }
});

test("paired reopen refuses a frozen saved source", async () => {
  const run = await runReopen({
    afterStatus: { available: true, pairedV2Authoring: { sessionId: "after-session", supported: true } },
    frozen: true,
  });
  assert.equal(run.result, false);
  assert.equal(run.statusCalls(), 2);
  assert.equal(run.context.window.confirm, run.originalConfirm);
  assert.match(run.progress.steps.at(-1).detail, /timed out waiting for reopened saved source/);
});

test("paired reopen refuses a missing original-source history", async () => {
  const run = await runReopen({
    afterStatus: { available: true, pairedV2Authoring: { sessionId: "after-session", supported: true } },
    history: false,
  });
  assert.equal(run.result, false);
  assert.equal(run.statusCalls(), 2);
  assert.equal(run.context.window.confirm, run.originalConfirm);
  assert.match(run.progress.steps.at(-1).detail, /reopened-history-mismatch/);
});

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

// Paired-v2 matrix correction coverage. These helpers intentionally use unique
// names because the existing driver-observability fixtures above remain the
// maintained 14-case baseline.
const matrixFamilies = ["terminal-nova", "nebular", "developer", "graphic-designer", "anime", "gamer"];
const matrixModes = ["light", "dark"];
const matrixDriverMarker = "  main().catch((error) => {";
const matrixRoles = [
  "--background", "--primary", "--tf-appearance-font-ui", "--tf-appearance-radius-surface",
  "--tf-appearance-selection", "--tf-appearance-selection-text",
];

function matrixNode(getText, { disabled = false, onClick = () => {}, attributes = {}, value = "" } = {}) {
  return {
    get textContent() { return getText(); },
    value,
    disabled,
    getAttribute(name) { return attributes[name] ?? null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attributes, name); },
    closest: () => null,
    click: onClick,
  };
}

class MatrixValueControl {
  constructor(state, label, value) {
    this.state = state;
    this.label = label;
    this.current = value;
  }

  get value() { return this.current; }

  set value(value) {
    this.current = String(value);
    if (this.label === "Application appearance") this.state.family = this.current;
    if (this.label === "Application display mode") this.state.mode = this.current;
    if (this.label === "Application appearance" && this.state.onFamilyChanged) this.state.onFamilyChanged();
  }

  getAttribute(name) { return name === "aria-label" ? this.label : null; }

  dispatchEvent() {}
}

function matrixExpectations() {
  const rows = [];
  for (const mode of matrixModes) {
    for (const family of matrixFamilies) {
      rows.push({
        family,
        mode,
        roles: Object.fromEntries(matrixRoles.map((role) => [role, `${family}-${mode}-${role.slice(2)}`])),
      });
    }
  }
  return { schema: "theme-forge.appearance-role-expectations.v1", roles: matrixRoles, rows };
}

function matrixPreviewFrame(state, title, src, { srcdoc = false } = {}) {
  const previewStatus = title === "Application Theme Live Preview"
    ? "Live CSS applied to shadcn-style component adaptations"
    : "Exact current CSS preview";
  const preview = {
    querySelectorAll(selector) {
      if (selector === '[role="status"]') {
        const status = state.ackMode === "missing" && title === "Application Theme Live Preview" ? "" : previewStatus;
        return status ? [matrixNode(() => status)] : [];
      }
      if (selector === ".preview-meta") return [matrixNode(() => `Rev: ${state.previewRevision}`)];
      return [];
    },
  };
  return {
    getAttribute(name) {
      if (name === "title") return title;
      if (name === "src") return src;
      return null;
    },
    hasAttribute(name) { return name === "srcdoc" && srcdoc; },
    closest(selector) { return selector === ".preview-container" ? preview : null; },
  };
}

function matrixHarness(options = {}) {
  const state = {
    family: "developer",
    mode: "dark",
    response: false,
    compileClicks: 0,
    ackMode: options.ackMode ?? "valid",
    previewRevision: options.previewRevision ?? 0,
    acceptedRevision: options.acceptedRevision ?? 0,
    badSrc: options.badSrc ?? false,
    srcdoc: options.srcdoc ?? false,
    noCompile: options.noCompile ?? false,
    replaceOnSelection: options.replaceOnSelection ?? false,
    editorMutateOnSelection: options.editorMutateOnSelection ?? false,
    sourceChangeAfterCompile: options.sourceChangeAfterCompile ?? false,
    sessionChangeAfterCompile: options.sessionChangeAfterCompile ?? false,
    editorChangeAfterCompile: options.editorChangeAfterCompile ?? false,
    clock: 0,
    statusCalls: 0,
  };
  const expectations = matrixExpectations();
  const familyControl = new MatrixValueControl(state, "Application appearance", state.family);
  const modeControl = new MatrixValueControl(state, "Application display mode", state.mode);
  const editorControls = [
    matrixNode(() => "#7a4fa3", { value: "#7a4fa3", attributes: { "aria-label": "Primary action color" } }),
    matrixNode(() => "system-ui", { value: "system-ui", attributes: { "aria-label": "Interface font family" } }),
    matrixNode(() => "10px", { value: "10px", attributes: { "aria-label": "Surface radius" } }),
  ];
  const appearanceSection = {
    querySelector(selector) {
      if (selector === 'select[aria-label="Application appearance"]') return familyControl;
      if (selector === 'select[aria-label="Application display mode"]') return modeControl;
      return null;
    },
  };
  const materializeFrames = () => {
    if (!state.response) return [];
    if (state.frameRefs === undefined) {
      const appSrc = state.badSrc ? "/preview/app/custom.html" : "/preview/app/index.html";
      state.frameRefs = [
        matrixPreviewFrame(state, "Application Theme Live Preview", appSrc, { srcdoc: state.srcdoc }),
        matrixPreviewFrame(state, "Starlight Theme Preview", "/preview/index.html"),
      ];
    }
    return state.frameRefs;
  };
  state.onFamilyChanged = () => {
    if (state.editorMutateOnSelection) editorControls[0].value = "#000000";
    if (state.replaceOnSelection) {
      state.frameRefs = [
        matrixPreviewFrame(state, "Application Theme Live Preview", "/preview/app/index.html"),
        matrixPreviewFrame(state, "Starlight Theme Preview", "/preview/index.html"),
      ];
    }
  };
  const compileButton = matrixNode(() => "Compile", {
    disabled: state.noCompile,
    onClick: () => {
      state.compileClicks += 1;
      state.response = true;
      state.frameRefs = undefined;
    },
  });
  const applyButton = matrixNode(() => "Apply to application", { disabled: false });
  const panel = {
    get textContent() {
      return [
        state.sourceChangeAfterCompile && state.response ? "unexpected.theme.json" : "v2-saved.theme.json",
        "Verified source bytes",
        state.response ? "Solar Sail Stellar Loom Review the compiled result" : "Compile to open the Solar Sail and Starlight previews",
        "Studio history: original source",
      ].join(" ");
    },
    closest: () => null,
    querySelector(selector) {
      if (selector === ".paired-v2-source-name") return matrixNode(() => state.sourceChangeAfterCompile && state.response ? "unexpected.theme.json" : "v2-saved.theme.json");
      if (selector === ".paired-v2-source-summary") return matrixNode(() => "Verified source bytes");
      if (selector === ".paired-v2-review-identity") return matrixNode(() => `Revision ${state.acceptedRevision}`);
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "button") return [compileButton, applyButton];
      if (selector === "iframe") return materializeFrames();
      if (selector === "input,textarea,select") return editorControls;
      return [];
    },
  };
  const document = {
    documentElement: { getAttribute(name) { return name === "data-theme" ? state.mode : null; } },
    body: {
      get textContent() {
        return [
          "Studio history: original source",
          state.response ? "Solar Sail Stellar Loom" : "Compile to open the Solar Sail and Starlight previews",
        ].join(" ");
      },
    },
    querySelector(selector) {
      if (selector === '[data-testid="paired-v2-authoring-panel"]') return panel;
      if (selector === '[data-testid="paired-v2-lab-surface"]') return { querySelector: () => null };
      if (selector === '[data-testid="paired-v2-editor-revision"]') {
        return matrixNode(() => state.editorChangeAfterCompile && state.response ? "Editor revision 1" : "Editor revision 0");
      }
      if (selector === 'section[aria-label="Application appearance"]') return appearanceSection;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "button") return [compileButton, applyButton];
      return [];
    },
  };
  const context = {
    clearTimeout: () => {},
    Date: { now: () => state.clock },
    document,
    Event: class Event {},
    getComputedStyle: () => ({
      getPropertyValue(name) {
        const row = expectations.rows.find((candidate) => candidate.family === state.family && candidate.mode === state.mode);
        return row?.roles[name] ?? "";
      },
    }),
    setTimeout(callback) {
      state.clock += 100_000;
      callback();
      return 1;
    },
    window: {
      __NEBULAR_RELEASE_SMOKE_CONFIG__: { scenario: "__connected-driver-test__", appearanceExpectations: expectations },
      __TAURI_INTERNALS__: {
        invoke: async (command) => {
          assert.equal(command, "studio_app_theme_status");
          state.statusCalls += 1;
          const changed = state.sessionChangeAfterCompile && state.compileClicks > 0;
          return { pairedV2Authoring: { sessionId: changed ? "changed-session" : "reopened-session", supported: true } };
        },
      },
      confirm: () => false,
    },
  };
  const instrumented = driverSource.replace(matrixDriverMarker, `  window.__driverTest = { pairedAppearanceMatrix };\n${matrixDriverMarker}`);
  assert.notEqual(instrumented, driverSource);
  vm.runInNewContext(instrumented, context, { timeout: 2_000 });
  return { context, state, pairedAppearanceMatrix: context.window.__driverTest.pairedAppearanceMatrix };
}

async function runAppearanceMatrixCandidate(options) {
  const fixture = matrixHarness(options);
  const result = await fixture.pairedAppearanceMatrix();
  return { ...fixture, result, progress: fixture.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__ };
}

test("reopened saved source regenerates previews before preserving the full matrix", async () => {
  const run = await runAppearanceMatrixCandidate();
  assert.equal(run.result, true);
  assert.equal(run.state.compileClicks, 1);
  assert.equal(run.state.statusCalls, 4);
  assert.equal(run.progress.steps.at(-1).ok, true);
  assert.equal(run.progress.facts.filter(([key]) => key === "appearanceMatrixCell").length, 12);
  assert.equal(run.progress.facts.some(([key]) => key === "previewApplication"), false);
});

test("matrix refuses no compile, missing ACK, and stale equal ACK revisions", async () => {
  const noCompile = await runAppearanceMatrixCandidate({ noCompile: true });
  assert.equal(noCompile.result, false);
  assert.match(noCompile.progress.steps.at(-1).detail, /enabled button "Compile"/);

  const missing = await runAppearanceMatrixCandidate({ ackMode: "missing" });
  assert.equal(missing.result, false);
  assert.match(missing.progress.steps.at(-1).detail, /paired preview ACKs and current revision/);

  const stale = await runAppearanceMatrixCandidate({ previewRevision: 1, acceptedRevision: 1 });
  assert.equal(stale.result, false);
  assert.match(stale.progress.steps.at(-1).detail, /paired preview ACKs and current revision/);
});

test("matrix preserves reopened source/session/revision and editor guards", async () => {
  const changedSession = await runAppearanceMatrixCandidate({ sessionChangeAfterCompile: true });
  assert.equal(changedSession.result, false);
  assert.match(changedSession.progress.steps.at(-1).detail, /paired-editor-not-preserved/);

  const changedSource = await runAppearanceMatrixCandidate({ sourceChangeAfterCompile: true });
  assert.equal(changedSource.result, false);
  assert.match(changedSource.progress.steps.at(-1).detail, /paired-editor-not-preserved/);

  const changedEditor = await runAppearanceMatrixCandidate({ editorChangeAfterCompile: true });
  assert.equal(changedEditor.result, false);
  assert.match(changedEditor.progress.steps.at(-1).detail, /paired-editor-not-preserved/);

  const editorPreservation = await runAppearanceMatrixCandidate({ editorMutateOnSelection: true });
  assert.equal(editorPreservation.result, false);
  assert.match(editorPreservation.progress.steps.at(-1).detail, /paired-editor-not-preserved/);
});

test("matrix retains exact trusted frame source and rejects srcdoc or replacement", async () => {
  const badSrc = await runAppearanceMatrixCandidate({ badSrc: true });
  assert.equal(badSrc.result, false);
  assert.match(badSrc.progress.steps.at(-1).detail, /paired-preview-frame-mismatch:Application Theme Live Preview/);

  const srcdoc = await runAppearanceMatrixCandidate({ srcdoc: true });
  assert.equal(srcdoc.result, false);
  assert.match(srcdoc.progress.steps.at(-1).detail, /paired-preview-frame-mismatch:Application Theme Live Preview/);

  const replacement = await runAppearanceMatrixCandidate({ replaceOnSelection: true });
  assert.equal(replacement.result, false);
  assert.match(replacement.progress.steps.at(-1).detail, /paired-preview-frame-identity-changed/);
});

function originalAckNode(getText, { disabled = false, attributes = {} } = {}) {
  return {
    get textContent() { return getText(); },
    disabled,
    getAttribute(name) { return attributes[name] ?? null; },
    hasAttribute: () => false,
    closest: () => null,
  };
}

function originalAckFrame(title, revision) {
  const status = title === "Application Theme Live Preview"
    ? "Live CSS applied to shadcn-style component adaptations"
    : "Exact current CSS preview";
  const preview = {
    querySelectorAll(selector) {
      if (selector === '[role="status"]') return [originalAckNode(() => status)];
      if (selector === ".preview-meta") return [originalAckNode(() => `Rev: ${revision}`)];
      return [];
    },
  };
  return {
    getAttribute(name) {
      if (name === "title") return title;
      return null;
    },
    closest(selector) { return selector === ".preview-container" ? preview : null; },
  };
}

function originalAckHarness({ applicationRevision, starlightRevision, acceptedRevision }) {
  let clock = 0;
  const appFrame = originalAckFrame("Application Theme Live Preview", applicationRevision);
  const starlightFrame = originalAckFrame("Starlight Theme Preview", starlightRevision);
  const applyButton = originalAckNode(() => "Apply to application");
  const panel = {
    querySelector(selector) {
      if (selector === ".paired-v2-review-identity") return originalAckNode(() => `Revision ${acceptedRevision}`);
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "iframe") return [appFrame, starlightFrame];
      if (selector === "button") return [applyButton];
      return [];
    },
  };
  const context = {
    clearTimeout: () => {},
    Date: { now: () => clock },
    document: {
      body: { textContent: "" },
      querySelector(selector) {
        return selector === '[data-testid="paired-v2-authoring-panel"]' ? panel : null;
      },
      querySelectorAll: () => [],
    },
    setTimeout: (callback) => { clock += 100_000; callback(); return 1; },
    window: {
      __NEBULAR_RELEASE_SMOKE_CONFIG__: { scenario: "__connected-driver-test__" },
    },
  };
  const ackMarker = "  main().catch((error) => {";
  const instrumented = driverSource.replace(ackMarker, `  window.__driverTest = { pairedPreviewAcks };\n${ackMarker}`);
  assert.notEqual(instrumented, driverSource);
  vm.runInNewContext(instrumented, context, { timeout: 2_000 });
  return { context, pairedPreviewAcks: context.window.__driverTest.pairedPreviewAcks };
}

test("original paired preview ACK wrapper accepts a matching nonzero revision once", async () => {
  const fixture = originalAckHarness({ applicationRevision: 3, starlightRevision: 3, acceptedRevision: 3 });
  const result = await fixture.pairedPreviewAcks();
  assert.equal(result, true);
  assert.equal(fixture.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.steps.at(-1).ok, true);
  assert.equal(JSON.stringify(fixture.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.facts), JSON.stringify([
    ["previewApplication", "applied"],
    ["previewStarlight", "applied"],
  ]));
});

test("original paired preview ACK wrapper rejects mismatched current revisions", async () => {
  const fixture = originalAckHarness({ applicationRevision: 3, starlightRevision: 3, acceptedRevision: 2 });
  const result = await fixture.pairedPreviewAcks();
  assert.equal(result, false);
  assert.match(fixture.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.steps.at(-1).detail, /paired preview ACKs and current revision/);
  assert.equal(JSON.stringify(fixture.context.window.__NEBULAR_RELEASE_SMOKE_PROGRESS__.facts), "[]");
});
