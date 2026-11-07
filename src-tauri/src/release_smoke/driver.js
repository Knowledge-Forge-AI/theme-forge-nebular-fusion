// Nebular release smoke driver. Compiled into the release binary (release_smoke/mod.rs) and evaluated
// in the real window only when the release smoke mode is active. It drives the packaged frontend
// through its DOM (accessible names and visible status text) and confirms effects through the same
// read-only status commands the frontend uses. It adds no command and needs no capability beyond the
// main window's. Results are published on window.__NEBULAR_RELEASE_SMOKE__ for the Rust host.
function classifyPlanAnnouncement(announcement, outcomes) {
  if (!announcement) return null;
  if (outcomes.includes(announcement)) return { kind: "outcome", message: announcement };
  return { kind: "failure", message: announcement };
}

function classifyPlanGate(cancelButton, announcement, outcomes) {
  const current = classifyPlanAnnouncement(announcement, outcomes);
  if (current) return current;
  if (cancelButton) return { kind: "cancel", button: cancelButton };
  return null;
}

function classifyPlanOutcome(announcement, body, outcomes) {
  const current = classifyPlanAnnouncement(announcement, outcomes);
  if (current) return current;
  const fallback = outcomes.find((message) => body.includes(message));
  return fallback ? { kind: "outcome", message: fallback } : null;
}

function formatPlanObservation(announcement, progress) {
  return `announcement="${String(announcement).slice(0, 240)}" progress="${String(progress).slice(0, 240)}"`;
}

(function nebularReleaseSmoke() {
  "use strict";
  if (window.__NEBULAR_RELEASE_SMOKE_STARTED__) return;
  window.__NEBULAR_RELEASE_SMOKE_STARTED__ = true;
  const config = window.__NEBULAR_RELEASE_SMOKE_CONFIG__ || {};
  const scenario = String(config.scenario || "");
  const steps = [];
  const facts = [];
  const internals = () => window.__TAURI_INTERNALS__;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => (node && node.textContent ? node.textContent.replace(/\s+/g, " ").trim() : "");

  // Waits for a truthy check; on timeout the error carries the last observation so a failed hosted run
  // explains itself without a screenshot.
  async function waitFor(check, label, timeout = 30000, observe) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await check();
        if (last) return last;
      } catch (error) {
        last = error;
      }
      await sleep(100);
    }
    let seen = "";
    try { seen = observe ? String(await observe()) : last instanceof Error ? last.message : String(last ?? ""); } catch (error) { seen = String(error); }
    throw new Error(`timed out waiting for ${label}; last observed: ${seen.slice(0, 300)}`);
  }

  function publish(current) {
    window.__NEBULAR_RELEASE_SMOKE_PROGRESS__ = {
      status: "running", scenario, facts,
      steps: current ? [...steps, { id: current, ok: false, via: "running", ms: 0, detail: "in progress" }] : [...steps],
    };
  }

  function buttons(root = document) {
    return Array.from(root.querySelectorAll("button"));
  }

  function button(name, root = document) {
    return buttons(root).find((candidate) => text(candidate) === name && !candidate.disabled && !candidate.closest("[hidden],[inert]"));
  }

  async function click(name, { root, timeout = 30000 } = {}) {
    const target = await waitFor(() => button(name, root), `enabled button "${name}"`, timeout);
    target.click();
    return target;
  }

  function described(label) {
    const term = Array.from(document.querySelectorAll("dt")).find((candidate) => text(candidate) === label);
    return term && term.nextElementSibling ? text(term.nextElementSibling) : "";
  }

  // Preserve the original derive failure while recording only the coarse public lifecycle state.
  // This observer is deliberately best-effort: a DOM/state read must never mask the driver error.
  function appendPlanLifecycleFact() {
    let lifecycle = "other";
    try {
      const state = described("Sidecar state");
      lifecycle = state === "ready" ? "ready" : state === "failed" ? "failed" : "other";
    } catch {
      lifecycle = "other";
    }
    try { facts.push(["deriveCancelLifecycle", lifecycle]); } catch { /* preserve the original failure */ }
  }

  const withPlanLifecycleFact = async (run) => {
    try {
      return await run();
    } catch (error) {
      appendPlanLifecycleFact();
      throw error;
    }
  };

  function bodyIncludes(value) {
    return text(document.body).includes(value);
  }

  async function invoke(command, args) {
    return internals().invoke(command, args || {});
  }

  // After a failed step: the brand workbench's Overview view loads through the same status read the plan
  // reconciliation uses and shows the public error, so the receipt carries the UI's own explanation.
  async function brandStatusProbe() {
    const nav = document.querySelector('nav[aria-label="Brand workbench views"]');
    if (!nav) return "no brand workbench";
    await click("Overview", { root: nav });
    const panel = () => document.querySelector(".read-panel");
    const seen = await waitFor(() => { const alert = panel() && panel().querySelector('[role="alert"]'); if (alert) return `alert: ${text(alert)}`; const loading = panel() && panel().querySelector('[role="status"]'); return loading ? "" : `loaded: ${text(panel()).slice(0, 600)}`; }, "overview after apply", 30000);
    return `overview ${seen}`;
  }

  async function step(id, via, run) {
    const started = Date.now();
    publish(id);
    try {
      const detail = await run();
      steps.push({ id, ok: true, via, ms: Date.now() - started, detail: String(detail ?? "").slice(0, 400) });
      publish();
      return true;
    } catch (error) {
      const message = error && typeof error === "object" && "reasonCode" in error ? `reasonCode=${error.reasonCode}` : String(error && error.message ? error.message : error);
      steps.push({ id, ok: false, via, ms: Date.now() - started, detail: message.slice(0, 400) });
      publish();
      return false;
    }
  }

  // ---- shared flows -------------------------------------------------------------------------

  const shell = () => step("app-shell", "dom", async () => {
    await waitFor(() => text(document.querySelector("h1")) === "Theme Forge Nebular Fusion", "application heading", 60000);
    await waitFor(() => described("Sidecar state"), "host diagnostics", 60000);
    if (!internals() || typeof internals().invoke !== "function") throw new Error("Tauri command bridge unavailable");
    return text(document.querySelector("footer"));
  });

  const hostStart = (id = "host-start") => step(id, "dom", async () => {
    const before = described("Latest event");
    await click(button("Restart sidecar") ? "Restart sidecar" : "Start sidecar", { timeout: 60000 });
    await waitFor(() => described("Sidecar state") === "ready" && described("Latest event") !== before, "sidecar ready", 90000,
      () => `state="${described("Sidecar state")}" event="${described("Latest event")}" alert="${text(document.querySelector('[role="alert"]'))}"`);
    return `${described("Sidecar state")} · ${described("Latest event")}`;
  });

  // The supervisor keeps a healthy session: a start request ("Restart sidecar") while the host is ready
  // returns the current status without a lifecycle event. The real restart is stop, then start.
  const hostStartIdempotent = () => step("host-start-idempotent", "dom", async () => {
    const before = described("Latest event");
    const previous = await invoke("studio_host_status");
    await click("Restart sidecar");
    await sleep(1500);
    const status = await invoke("studio_host_status");
    if (described("Sidecar state") !== "ready" || described("Latest event") !== before || status.state !== "ready" || status.manifestDigest !== previous.manifestDigest) {
      throw new Error(`start on a ready host changed the session: state="${described("Sidecar state")}" event "${before}" -> "${described("Latest event")}"`);
    }
    return `ready session kept · ${before}`;
  });

  const hostStatus = (id = "host-status") => step(id, "invoke", async () => {
    const status = await invoke("studio_host_status");
    if (status.state !== "ready" || !status.manifestDigest || !Array.isArray(status.methods) || status.methods.length === 0) {
      throw new Error(`host not ready: ${JSON.stringify({ state: status.state, manifest: Boolean(status.manifestDigest) })}`);
    }
    facts.push(["sidecarProtocol", String(status.selectedProtocolVersion)], ["sidecarManifestDigest", String(status.manifestDigest)]);
    return `${status.state} protocol ${status.selectedProtocolVersion} · ${status.methods.length} methods · raster ${status.raster && status.raster.available}`;
  });

  const hostStop = () => step("host-stop", "dom", async () => {
    await click("Stop sidecar");
    await waitFor(() => described("Sidecar state") === "stopped", "sidecar stopped", 60000);
    const status = await invoke("studio_host_status");
    if (status.state !== "stopped") throw new Error(`sidecar state after stop: ${status.state}`);
    return status.state;
  });

  const selectionStatus = () => Array.from(document.querySelectorAll('p[role="status"]')).map(text)
    .find((value) => value.startsWith("Project opened:") || value.startsWith("Project selection") || value.startsWith("No project")) ?? "";

  // The result line persists between selections, so wait for exactly this project's result.
  const projectOpen = (id, expectedName) => step(id, "dom", async () => {
    const expected = `Project opened: ${expectedName}.`;
    await click("Open existing project");
    await waitFor(() => selectionStatus() === expected || selectionStatus() === "Project selection cancelled.", `result ${expected}`, 60000,
      () => `status="${selectionStatus()}" alert="${text(document.querySelector('[role="alert"]'))}"`);
    if (selectionStatus() !== expected) throw new Error(`unexpected project result: ${selectionStatus()}`);
    const status = await invoke("studio_host_status");
    if (status.projectOpenCount < 1) throw new Error("the host reports no open project");
    return `${expected} · ${status.projectOpenCount} open`;
  });

  const familyNames = () => Array.from(document.querySelectorAll(".families-view h4")).map(text);
  const families = (id, expectedFamily) => step(id, "dom", async () => {
    const nav = document.querySelector('nav[aria-label="Brand workbench views"]');
    await click("Families", { root: nav });
    const shown = () => familyNames().includes(expectedFamily);
    try {
      await waitFor(shown, `family ${expectedFamily}`, 5000);
    } catch {
      // The view may still show the previous project's page; reload it for the open project.
      await click("Refresh Families");
      await waitFor(shown, `family ${expectedFamily}`, 60000, () => `families="${familyNames().join(", ")}"`);
    }
    return familyNames().join(", ");
  });

  const themeLab = () => step("theme-lab-compile", "dom", async () => {
    await click("Starlight Theme");
    const statusBar = () => text(document.querySelector('[data-destination="starlight-theme"] .theme-lab-status-bar'));
    // The lab loads its stellar-cyan example on mount; a compile requested while that load is in flight
    // is superseded by it, so compile only once the example has loaded.
    await waitFor(() => statusBar().includes("Loaded stellar-cyan") || statusBar().includes("compiled successfully"), "the example to load", 60000, statusBar);
    const before = await invoke("studio_theme_lab_status");
    if (!before.available) throw new Error(`Theme Lab unavailable: ${before.message || ""}`);
    const compile = await waitFor(() => {
      const candidate = document.querySelector('[data-destination="starlight-theme"] button.compile-button');
      return candidate && !candidate.disabled ? candidate : null;
    }, "Theme Lab compile button", 60000);
    compile.click();
    await waitFor(() => statusBar().includes("compiled successfully"), "Theme Lab compile success", 90000,
      () => `status="${statusBar()}" alert="${text(document.querySelector('[data-destination="starlight-theme"] [role="alert"]'))}"`);
    const after = await invoke("studio_theme_lab_status");
    if (!(after.latestRevision > before.latestRevision)) throw new Error("Theme Lab revision did not advance");
    return `revision ${before.latestRevision} -> ${after.latestRevision} · ${after.compilerVersion || ""}`;
  });

  const appTheme = () => step("app-theme-compile", "dom", async () => {
    await click("Application Theme");
    const before = await invoke("studio_app_theme_status");
    if (!before.available) throw new Error(`App Theme unavailable: ${before.message || ""}`);
    const area = await waitFor(() => document.querySelector('[data-destination="application-theme"]:not([hidden])'), "Application Theme area", 30000);
    const banner = () => text(area.querySelector('.action-banner[role="status"]'));
    // The view compiles once on mount; a repeated compile without an edit keeps the same revision. Edit
    // the profile through the UI first, so the compile below is provably a fresh one.
    await waitFor(() => button("Compile Theme", area), "the mount compile to finish", 90000, banner);
    await click("Load Forge Console", { root: area });
    await waitFor(() => banner() === "Loaded built-in Forge Console profile.", "profile edit", 30000, banner);
    await click("Compile Theme", { root: area, timeout: 60000 });
    let observed = "";
    await waitFor(async () => {
      const status = await invoke("studio_app_theme_status");
      const button = buttons(area).find((candidate) => ["Compile Theme", "Compiling…"].includes(text(candidate)));
      observed = `banner="${banner()}" revision=${before.latestRevision}->${status.latestRevision} button="${text(button)}"`;
      return status.latestRevision > before.latestRevision && banner().includes("Paired theme compilation succeeded.");
    }, "paired compile success", 90000, () => observed);
    const after = await invoke("studio_app_theme_status");
    const applied = area.querySelector("[data-applied-state]");
    facts.push(["appThemePreviewState", applied ? String(applied.getAttribute("data-applied-state")) : "absent"]);
    return `revision ${before.latestRevision} -> ${after.latestRevision} · ${banner()}`;
  });

  const appThemeStatus = () => step("app-theme-status", "invoke", async () => {
    const status = await invoke("studio_app_theme_status");
    if (!status.available) throw new Error(`App Theme unavailable: ${status.message || ""}`);
    return `${status.compilerVersion || "compiler"} · revision ${status.latestRevision}`;
  });

  // ---- fixed appearance restart pair -------------------------------------------------------

  const APPEARANCE_RECORD = Object.freeze({ version: 1, mode: "dark", light: "developer", dark: "developer" });
  const APPEARANCE_RECORD_SHA256 = "11ed5c176d7725adcb7911ceb7a9a11943af63197dbee5d2e4317dc1df8c7540";
  const APPEARANCE_FAILURE_CATEGORIES = Object.freeze([
    "pair-root-missing", "pair-marker-missing", "pair-marker-invalid", "pair-layout-mismatch",
    "preferences-root-symlink", "preferences-root-not-owner-only", "preferences-root-equals-smoke-root",
    "receipt-collision", "pair-leaf-inventory-mismatch", "appearance-startup-backend-unsupported",
    "appearance-startup-load-rejected", "appearance-load-rejected", "appearance-save-failed",
    "appearance-saved-status-timeout", "appearance-selection-mismatch", "appearance-computed-mismatch",
    "appearance-record-mismatch", "restart-not-persisted", "process-orphan",
    "persistent-user-state-changed", "pair-cleanup-unowned",
  ]);

  function setControlledValue(control, value) {
    const prototype = Object.getPrototypeOf(control);
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (typeof setter !== "function") throw new Error("controlled input setter unavailable");
    setter.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function appearanceSection() {
    return document.querySelector('section[aria-label="Application appearance"]');
  }

  async function chooseAppearance(label, value, deadline) {
    const remaining = () => deadline === undefined ? 30000 : Math.max(0, deadline - Date.now());
    const control = await waitFor(() => {
      const section = appearanceSection();
      return section && section.querySelector(`select[aria-label="${label}"]`);
    }, `${label} appearance select`, remaining());
    setControlledValue(control, value);
    await waitFor(() => control.value === value, `${label} selection ${value}`, remaining());
    return control.value;
  }

  function appearanceValues() {
    const section = appearanceSection();
    const family = section?.querySelector('select[aria-label="Application appearance"]');
    const mode = section?.querySelector('select[aria-label="Application display mode"]');
    const computed = getComputedStyle(document.documentElement);
    return {
      family: family ? family.value : "",
      mode: mode ? mode.value : "",
      theme: document.documentElement.getAttribute("data-theme") || "",
      background: computed.getPropertyValue("--background").trim(),
      primary: computed.getPropertyValue("--primary").trim(),
      fontUi: computed.getPropertyValue("--tf-appearance-font-ui").trim(),
      radius: computed.getPropertyValue("--tf-appearance-radius-surface").trim(),
      selection: computed.getPropertyValue("--tf-appearance-selection").trim(),
      selectionText: computed.getPropertyValue("--tf-appearance-selection-text").trim(),
    };
  }

  function exactAppearanceRecord(record) {
    return record && record.version === APPEARANCE_RECORD.version
      && record.mode === APPEARANCE_RECORD.mode
      && record.light === APPEARANCE_RECORD.light
      && record.dark === APPEARANCE_RECORD.dark
      && Object.keys(record).length === 4;
  }

  async function readAppearanceRecord() {
    const reply = await invoke("studio_appearance_preferences_load");
    if (reply.status === "rejected") throw new Error(`appearance-startup-load-rejected:${reply.reason}`);
    return reply;
  }

  const appearanceShell = (id) => step(id, "dom", async () => {
    await waitFor(() => text(document.querySelector("h1")) === "Theme Forge Nebular Fusion", "application heading", 60000);
    await waitFor(() => described("Sidecar state"), "host diagnostics", 60000);
    if (!internals() || typeof internals().invoke !== "function") throw new Error("Tauri command bridge unavailable");
    facts.push(["appearanceFailureCategories", APPEARANCE_FAILURE_CATEGORIES.join(",")]);
    return text(document.querySelector("footer"));
  });

  const pSaveLoadMissing = () => step("p-save-load-missing", "invoke-read-only", async () => {
    const reply = await readAppearanceRecord();
    if (reply.status !== "missing") throw new Error(`appearance-load-rejected:${reply.status}`);
    return "missing before selection";
  });

  const pSaveSelectFamily = () => step("p-save-select-family", "dom", async () => chooseAppearance("Application appearance", "developer"));
  const pSaveSelectMode = () => step("p-save-select-mode", "dom", async () => chooseAppearance("Application display mode", "dark"));

  const pSaveApply = () => step("p-save-apply", "dom+status", async () => {
    await waitFor(() => Array.from(document.querySelectorAll('[role="status"]')).some((node) => text(node) === "Appearance saved on this device."), "appearance saved status", 60000,
      () => `status="${text(document.querySelector('section[aria-label="Application appearance"]'))}"`);
    if (document.querySelector('[role="alert"]')) throw new Error("appearance-save-failed");
    const reply = await readAppearanceRecord();
    if (reply.status !== "loaded" || !exactAppearanceRecord(reply.preferences)) throw new Error("appearance-record-mismatch");
    return "saved through controlled appearance UI";
  });

  const pSaveLoadSaved = () => step("p-save-load-saved", "invoke-read-only+computed", async () => {
    const reply = await readAppearanceRecord();
    const values = appearanceValues();
    if (reply.status !== "loaded" || !exactAppearanceRecord(reply.preferences)) throw new Error("appearance-record-mismatch");
    if (values.family !== "developer" || values.mode !== "dark" || values.primary !== "#65b4d7") {
      throw new Error(`appearance-computed-mismatch:${JSON.stringify(values)}`);
    }
    facts.push(["appearanceRecordSha256", APPEARANCE_RECORD_SHA256], ["appearanceMode", values.mode], ["appearanceFamily", values.family]);
    return `${values.family}/${values.mode} · ${values.primary}`;
  });

  const pRestartStartup = () => step("p-restart-startup", "dom+computed", async () => {
    const values = await waitFor(() => {
      const current = appearanceValues();
      return current.family === "developer" && current.mode === "dark" && current.theme === "dark" && current.primary === "#65b4d7" ? current : null;
    }, "appearance preference startup state", 60000, () => JSON.stringify(appearanceValues()));
    return `${values.family}/${values.mode} · ${values.primary}`;
  });

  const pRestartLoadExact = () => step("p-restart-load-exact", "invoke-read-only+computed", async () => {
    const reply = await readAppearanceRecord();
    const values = appearanceValues();
    if (reply.status !== "loaded" || !exactAppearanceRecord(reply.preferences)) throw new Error("restart-not-persisted");
    if (values.family !== reply.preferences.light || values.mode !== reply.preferences.mode || values.primary !== "#65b4d7") {
      throw new Error("appearance-selection-mismatch");
    }
    return "byte-identical V1 record observed after fresh startup";
  });

  // ---- fixed paired-v2 WebKit branch -------------------------------------------------------

  const pairedPanel = () => document.querySelector('[data-testid="paired-v2-authoring-panel"]');
  const pairedSurface = () => document.querySelector('[data-testid="paired-v2-lab-surface"]');
  const applicationThemeArea = () => document.querySelector('[data-destination="application-theme"]:not([hidden])');
  const setLabelled = async (labelPrefix, value) => {
    const control = await waitFor(() => Array.from(document.querySelectorAll("label"))
      .find((candidate) => text(candidate).startsWith(labelPrefix))?.querySelector("input,textarea"), `${labelPrefix} field`);
    setControlledValue(control, value);
    await waitFor(() => control.value === value, `${labelPrefix} value`);
  };

  const setSelectLabelled = async (labelPrefix, value) => {
    const control = await waitFor(() => Array.from(document.querySelectorAll("label"))
      .find((candidate) => text(candidate).startsWith(labelPrefix))?.querySelector("select"), `${labelPrefix} select`);
    setControlledValue(control, value);
    await waitFor(() => control.value === value, `${labelPrefix} selection ${value}`);
  };

  const pairedAppTheme = () => step("paired-app-theme", "dom+status", async () => {
    await click("Application Theme");
    const area = await waitFor(() => applicationThemeArea(), "Application Theme area", 60000);
    const status = await invoke("studio_app_theme_status");
    const capability = status.pairedV2Authoring;
    if (!status.available || !capability || capability.supported !== true || !capability.sessionId) throw new Error("paired-v2-status-unavailable");
    // The real Lab creates the paired surface only after its existing Open
    // Profile… control establishes the v2 input. Keep this first UI action in
    // the fixed app-theme step; the following step observes the opened result.
    await click("Open Profile…", { root: area });
    await waitFor(() => pairedSurface() && pairedPanel(), "paired-v2 surface after profile open", 90000);
    return `session ${capability.sessionId}`;
  });

  const pairedOpenDeveloper = () => step("paired-open-developer", "dom+status", async () => {
    await waitFor(() => bodyIncludes("Read-Only Profile Inspection (tf-paired-profile-v2)"), "verified Developer profile", 90000);
    if (!bodyIncludes("Studio history: original source")) throw new Error("source-profile-identity-mismatch");
    return "baseline.theme.json · developer@0.1.0";
  });

  const pairedBrief = () => step("paired-brief", "dom", async () => {
    // These values match the deterministic proof4 packet creator. The native
    // campaign may replace them only with an independently sealed packet
    // fixture; it must not silently invent another candidate identity.
    await setLabelled("Brief ID", "brief-1");
    await setLabelled("Title", "Developer application appearance");
    await setLabelled("Goal", "Apply three approved v2 focused edits to the Developer profile.");
    await setLabelled("Acceptance criteria", "The dark primary action is #7a4fa3\nThe surface radius is 10px\nThe interface family is system-ui");
    await setLabelled("Prohibited changes", "No native qualification or release adoption.");
    await click("Create brief", { root: document });
    await waitFor(() => bodyIncludes("Retained canonical JSON"), "retained brief", 60000);
    return "brief self-integrity verified";
  });

  const pairedThreeEdits = () => step("paired-three-edits", "dom", async () => {
    await setLabelled("Primary action color", "#7a4fa3");
    await setLabelled("Interface font family", "system-ui");
    await setLabelled("Surface radius", "10px");
    if (!pairedPanel() || !bodyIncludes("#7a4fa3") || !bodyIncludes("system-ui") || !bodyIncludes("10px")) throw new Error("paired-selection-mismatch");
    return "color.dark.primaryAction=#7a4fa3 · typography.ui.family=system-ui · radius.surface=10px";
  });

  const compilePairedCurrentSource = async () => {
    await click("Compile", { root: pairedPanel() || document, timeout: 60000 });
    await waitFor(() => {
      const apply = button("Apply to application", pairedPanel() || document);
      return apply && apply.disabled === false ? apply : null;
    }, "paired compile and preview ACK", 120000);
    if (!bodyIncludes("Solar Sail") || !bodyIncludes("Stellar Loom")) throw new Error("paired-compile-response-mismatch");
    return "both target sections acknowledged";
  };

  const observePairedPreviewAcks = () => {
    const root = pairedPanel() || document;
    const frameFor = (title) => Array.from(root.querySelectorAll("iframe"))
      .find((frame) => frame.getAttribute("title") === title);
    const previewFor = (frame) => frame?.closest(".preview-container");
    const hasStatus = (preview, expected) => Boolean(preview
      && Array.from(preview.querySelectorAll('[role="status"]'), text).some((value) => value === expected));
    const revisionFor = (preview) => {
      const value = Array.from(preview?.querySelectorAll(".preview-meta") || [], text)
        .find((candidate) => /^Rev:\s*\d+$/.test(candidate));
      const match = value?.match(/^Rev:\s*(\d+)$/);
      return match ? Number(match[1]) : null;
    };
    const acceptedValue = text(root.querySelector(".paired-v2-review-identity"));
    const acceptedMatch = acceptedValue.match(/^Revision\s+(\d+)$/);
    const applicationFrame = frameFor("Application Theme Live Preview");
    const starlightFrame = frameFor("Starlight Theme Preview");
    const applicationPreview = previewFor(applicationFrame);
    const starlightPreview = previewFor(starlightFrame);
    const apply = button("Apply to application", root);
    return {
      applicationFrame,
      starlightFrame,
      applicationAck: hasStatus(applicationPreview, "Live CSS applied to shadcn-style component adaptations"),
      starlightAck: hasStatus(starlightPreview, "Exact current CSS preview"),
      applicationRevision: revisionFor(applicationPreview),
      starlightRevision: revisionFor(starlightPreview),
      acceptedRevision: acceptedMatch ? Number(acceptedMatch[1]) : null,
      apply: apply && apply.disabled === false ? apply : null,
      applyEnabled: apply !== undefined && apply.disabled === false,
    };
  };

  const waitPairedPreviewAcks = async ({ recordFacts = false, expectedRevision = null } = {}) => {
    const observed = await waitFor(() => {
      const current = observePairedPreviewAcks();
      const revisionsMatch = current.applicationRevision !== null
        && current.applicationRevision === current.starlightRevision
        && current.applicationRevision === current.acceptedRevision
        && (expectedRevision === null || current.applicationRevision === expectedRevision);
      return current.applicationFrame && current.starlightFrame && current.applicationAck
        && current.starlightAck && revisionsMatch && current.apply && current.applyEnabled ? current : null;
    }, "paired preview ACKs and current revision", 60000, () => {
      const current = observePairedPreviewAcks();
      return JSON.stringify({
        applicationAck: current.applicationAck,
        starlightAck: current.starlightAck,
        applicationRevision: current.applicationRevision,
        starlightRevision: current.starlightRevision,
        acceptedRevision: current.acceptedRevision,
        applyEnabled: current.applyEnabled,
      });
    });
    if (recordFacts) facts.push(["previewApplication", "applied"], ["previewStarlight", "applied"]);
    return observed;
  };

  const pairedCompileBoth = () => step("paired-compile-both", "dom+status", compilePairedCurrentSource);

  const pairedPreviewAcks = () => step("paired-preview-acks", "frame-ack", async () => {
    const observed = await waitPairedPreviewAcks({ recordFacts: true });
    return `Application Theme Live Preview and Starlight Theme Preview ACKs correlated at revision ${observed.applicationRevision}`;
  });

  const pairedCandidateCreate = () => step("paired-create-candidate", "dom", async () => {
    await setLabelled("Candidate ID", "candidate-4");
    await setLabelled("Rationale", "Three focused edits are precomputed from the verified Developer root.");
    await click("Create candidate");
    await waitFor(() => bodyIncludes("packet self-integrity: verified"), "candidate packet", 60000);
    return "candidate packet self-integrity verified";
  });

  const pairedReviewAssociation = () => step("paired-review-association", "dom+picker", async () => {
    await click("Export candidate");
    await waitFor(() => bodyIncludes("Candidate exported without adopting or saving the current source."), "candidate export", 60000);
    await click("Import candidate");
    await waitFor(() => bodyIncludes("Candidate imported for inspection; source verification remains parent-controlled."), "candidate import", 60000);
    // The candidate is staged automatically by the closed packet bridge. Make
    // the review association explicit through the existing UI fields and the
    // same deterministic proof4 review input; no generic picker or command is
    // introduced by this driver.
    await setSelectLabelled("Disposition", "approve");
    await setLabelled("Review ID", "review-4");
    await setSelectLabelled("Overall disposition", "approve");
    await setLabelled("Summary", "The scripted candidate matches all three requested edits.");
    await click("Create review");
    await waitFor(() => bodyIncludes("Review created with explicit human dispositions"), "review packet", 60000);
    await click("Export review");
    await waitFor(() => bodyIncludes("Review exported without adopting or saving the current source."), "review export", 60000);
    await click("Import review");
    await waitFor(() => bodyIncludes("Review imported for inspection; associations and disposition remain separate.")
      && bodyIncludes("Imported review references the exact staged brief and candidate subset."), "review association", 60000);
    return "candidate-v2.json and review-v2.json export/import association verified";
  });

  const pairedSelectCandidate = () => step("paired-select-candidate", "dom+status+confirm", async () => {
    const expected = "Discard the current unsaved editor or appearance draft and verify this candidate?";
    const original = window.confirm;
    let calls = 0;
    window.confirm = (message) => {
      calls += 1;
      if (message !== expected) throw new Error(`unexpected candidate confirmation: ${message}`);
      return true;
    };
    try {
      const candidates = buttons(document).filter((candidate) => text(candidate) === "Select candidate");
      const select = candidates[candidates.length - 1];
      if (!select) throw new Error("candidate-select-button-missing");
      select.click();
      await waitFor(() => text(document.querySelector('[data-testid="paired-v2-editor-revision"]')).includes("Editor revision 0"), "detached revision zero", 90000);
    } finally {
      window.confirm = original;
    }
    if (calls !== 1) throw new Error(`candidateDiscardConfirm=${calls}`);
    facts.push(["candidateDiscardConfirm", "accepted"], ["detachedRevision", "0"]);
    return "candidate-v2.json · detached verified session";
  });

  const pairedAppearanceDark = () => step("paired-appearance-dark", "dom+appearance", async () => {
    await chooseAppearance("Application display mode", "dark");
    await waitFor(() => document.documentElement.getAttribute("data-theme") === "dark", "dark appearance mode", 60000);
    facts.push(["appearanceMode", "dark"]);
    return "controlled display mode dark";
  });

  const pairedApplyDetached = () => step("paired-apply-detached", "dom+computed", async () => {
    await click("Apply to application", { root: pairedPanel() || document });
    await waitFor(() => appearanceValues().primary === "#7a4fa3", "detached application primary", 60000, () => JSON.stringify(appearanceValues()));
    if (!bodyIncludes("Unsaved theme draft is active.")) throw new Error("appearance-draft-not-active");
    const before = Array.from((pairedPanel() || document).querySelectorAll("input"), (input) => [input.getAttribute("aria-label"), input.value]);
    await click("Reset appearance");
    await waitFor(() => !bodyIncludes("Unsaved theme draft is active."), "application draft release", 60000);
    const after = Array.from((pairedPanel() || document).querySelectorAll("input"), (input) => [input.getAttribute("aria-label"), input.value]);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("editor-changed-on-appearance-reset");
    facts.push(["appearanceResetPreferenceWrite", "recorded"]);
    return "application --primary #7a4fa3; application draft released; editor unchanged";
  });

  const pairedSaveAsFreeze = () => step("paired-save-as", "dom+picker", async () => {
    await click("Save as…", { root: pairedPanel() || document });
    await waitFor(() => bodyIncludes("This saved source is held unchanged."), "saved source freeze", 90000);
    return "v2-saved.theme.json · saved and frozen";
  });

  const pairedReopenSaved = () => step("paired-reopen", "dom+status+confirm", async () => {
    const panel = () => pairedPanel() || document;
    const beforeStatus = await invoke("studio_app_theme_status");
    const beforeSession = beforeStatus.pairedV2Authoring?.sessionId;
    if (typeof beforeSession !== "string" || beforeSession.length === 0) throw new Error("reopen-before-session-unavailable");
    const expected = "Discard the current unsaved editor or application draft and reopen the source?";
    const original = window.confirm;
    let calls = 0;
    window.confirm = (message) => {
      calls += 1;
      if (message !== expected) throw new Error(`unexpected reopen confirmation: ${message}`);
      return false;
    };
    try {
      await click("Reopen", { root: panel() });
      await waitFor(async () => {
        if (calls !== 0) return { confirmationRefused: true };
        const status = await invoke("studio_app_theme_status");
        const currentSession = status.pairedV2Authoring?.sessionId;
        const sourceName = text(panel().querySelector(".paired-v2-source-name"));
        const revision = text(document.querySelector('[data-testid="paired-v2-editor-revision"]'));
        const sourceSummary = text(panel().querySelector(".paired-v2-source-summary"));
        const frozen = text(panel()).includes("This saved source is held unchanged.");
        if (typeof currentSession === "string"
          && currentSession.length > 0
          && currentSession !== beforeSession
          && sourceName === "v2-saved.theme.json"
          && /^Editor revision 0$/.test(revision)
          && sourceSummary.includes("Verified source bytes")
          && !sourceSummary.includes("Detached verified bytes")
          && !frozen) {
          return true;
        }
        return null;
      }, "reopened saved source with new session", 90000, () => {
        const sourceName = text(panel().querySelector(".paired-v2-source-name"));
        const revision = text(document.querySelector('[data-testid="paired-v2-editor-revision"]'));
        const sourceSummary = text(panel().querySelector(".paired-v2-source-summary"));
        return JSON.stringify({
          sourceName,
          revision,
          custody: sourceSummary.includes("Verified source bytes") ? "attached" : sourceSummary.includes("Detached verified bytes") ? "detached" : "unknown",
          frozen: text(panel()).includes("This saved source is held unchanged."),
        });
      });
      if (calls !== 0) throw new Error(`reopenConfirmCalls=${calls}`);
      if (!bodyIncludes("Studio history: original source")) throw new Error("reopened-history-mismatch");
      facts.push(["reopenConfirmCalls", "0"]);
      return "v2-saved.theme.json · reopened attached editor · new session · zero confirm calls";
    } finally {
      window.confirm = original;
    }
  });

  const APPEARANCE_MATRIX_ROLES = Object.freeze([
    "--background", "--primary", "--tf-appearance-font-ui", "--tf-appearance-radius-surface",
    "--tf-appearance-selection", "--tf-appearance-selection-text",
  ]);
  const APPEARANCE_MATRIX_FAMILIES = Object.freeze([
    "terminal-nova", "nebular", "developer", "graphic-designer", "anime", "gamer",
  ]);
  const APPEARANCE_MATRIX_MODES = Object.freeze(["light", "dark"]);

  function closedAppearanceExpectations() {
    const expectations = config.appearanceExpectations;
    if (!expectations || typeof expectations !== "object" || Array.isArray(expectations)) {
      throw new Error("appearance-matrix-expectations-missing");
    }
    if (expectations.schema !== "theme-forge.appearance-role-expectations.v1") {
      throw new Error("appearance-matrix-schema-mismatch");
    }
    if (!Array.isArray(expectations.roles) || expectations.roles.length !== APPEARANCE_MATRIX_ROLES.length
      || expectations.roles.some((role, index) => role !== APPEARANCE_MATRIX_ROLES[index])) {
      throw new Error("appearance-matrix-roles-mismatch");
    }
    if (!Array.isArray(expectations.rows) || expectations.rows.length !== APPEARANCE_MATRIX_FAMILIES.length * APPEARANCE_MATRIX_MODES.length) {
      throw new Error("appearance-matrix-row-count-mismatch");
    }
    const rows = expectations.rows.map((row, index) => {
      const expectedMode = index < APPEARANCE_MATRIX_FAMILIES.length ? "light" : "dark";
      const expectedFamily = APPEARANCE_MATRIX_FAMILIES[index % APPEARANCE_MATRIX_FAMILIES.length];
      if (!row || typeof row !== "object" || Array.isArray(row)
        || row.family !== expectedFamily
        || row.mode !== expectedMode
        || !row.roles || typeof row.roles !== "object" || Array.isArray(row.roles)) {
        throw new Error("appearance-matrix-row-order-mismatch");
      }
      const roleKeys = Object.keys(row.roles);
      if (roleKeys.length !== APPEARANCE_MATRIX_ROLES.length
        || APPEARANCE_MATRIX_ROLES.some((role) => !roleKeys.includes(role))
        || APPEARANCE_MATRIX_ROLES.some((role) => typeof row.roles[role] !== "string" || row.roles[role].length === 0)) {
        throw new Error("appearance-matrix-row-roles-mismatch");
      }
      return row;
    });
    return rows;
  }

  function appearanceRoleMatch(values, expectedRoles) {
    return APPEARANCE_MATRIX_ROLES.every((role) => {
      const valueKey = role === "--background" ? "background"
        : role === "--primary" ? "primary"
          : role === "--tf-appearance-font-ui" ? "fontUi"
            : role === "--tf-appearance-radius-surface" ? "radius"
              : role === "--tf-appearance-selection" ? "selection"
                : "selectionText";
      return values[valueKey] === expectedRoles[role];
    });
  }

  async function readReopenedSavedSource() {
    const panel = pairedPanel();
    if (!panel) throw new Error("paired-editor-not-preserved");
    const status = await invoke("studio_app_theme_status");
    const sessionId = status.pairedV2Authoring?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("paired-v2-status-unavailable");
    const sourceName = text(panel.querySelector(".paired-v2-source-name"));
    const sourceSummary = text(panel.querySelector(".paired-v2-source-summary"));
    const revision = text(document.querySelector('[data-testid="paired-v2-editor-revision"]'));
    const frozen = text(panel).includes("This saved source is held unchanged.");
    if (
      sourceName !== "v2-saved.theme.json"
      || !/^Editor revision 0$/.test(revision)
      || !sourceSummary.includes("Verified source bytes")
      || sourceSummary.includes("Detached verified bytes")
      || frozen
      || !bodyIncludes("Studio history: original source")
    ) throw new Error("paired-editor-not-preserved");
    return { sessionId, sourceName, sourceSummary, revision };
  }

  const pairedAppearanceMatrix = () => step("paired-appearance-matrix", "dom+computed", async () => {
    const rows = closedAppearanceExpectations();
    if (!pairedSurface() || !pairedPanel()) throw new Error("paired-editor-not-open");
    const reopenedBefore = await readReopenedSavedSource();
    await compilePairedCurrentSource();
    await waitPairedPreviewAcks({ expectedRevision: 0 });
    const reopenedAfter = await readReopenedSavedSource();
    if (reopenedAfter.sessionId !== reopenedBefore.sessionId) throw new Error("paired-editor-not-preserved");
    const frameIdentity = () => {
      const panel = pairedPanel();
      if (!panel) throw new Error("paired-editor-not-open");
      const read = (title, expectedSrc) => {
        const frame = Array.from(panel.querySelectorAll("iframe")).find((candidate) => candidate.getAttribute("title") === title);
        const src = frame?.getAttribute("src");
        if (!frame || src !== expectedSrc || frame.hasAttribute("srcdoc")) throw new Error(`paired-preview-frame-mismatch:${title}`);
        return { frame, src };
      };
      return {
        application: read("Application Theme Live Preview", "/preview/app/index.html"),
        starlight: read("Starlight Theme Preview", "/preview/index.html"),
      };
    };
    const beforeFrames = frameIdentity();
    const editorSnapshot = () => {
      const panel = pairedPanel();
      if (!panel) throw new Error("paired-editor-not-open");
      const controls = Array.from(panel.querySelectorAll("input,textarea,select"));
      if (controls.length > 64 || controls.some((control) => control.value.length > 65536)) {
        throw new Error("paired-editor-snapshot-exceeds-bound");
      }
      return JSON.stringify({
        revision: text(document.querySelector('[data-testid="paired-v2-editor-revision"]')),
        fields: controls.map((control) => [control.tagName, control.getAttribute("aria-label"), control.value, Boolean(control.checked)]),
      });
    };
    const beforeEditor = editorSnapshot();
    const beforeStatus = await invoke("studio_app_theme_status");
    const beforeSession = beforeStatus.pairedV2Authoring?.sessionId;
    if (typeof beforeSession !== "string" || !beforeSession) throw new Error("paired-v2-status-unavailable");
    for (const row of rows) {
      const deadline = Date.now() + 10000;
      await chooseAppearance("Application appearance", row.family, deadline);
      await chooseAppearance("Application display mode", row.mode, deadline);
      const values = await waitFor(() => {
        const current = appearanceValues();
        return current.family === row.family && current.mode === row.mode && appearanceRoleMatch(current, row.roles)
          && pairedSurface() && pairedPanel()
          ? current
          : null;
      }, `${row.family}/${row.mode} appearance roles`, Math.max(0, deadline - Date.now()), () => JSON.stringify(appearanceValues()));
      const rolesMatch = appearanceRoleMatch(values, row.roles);
      if (!rolesMatch) throw new Error(`appearance-matrix-role-mismatch:${row.family}/${row.mode}`);
      const currentFrames = frameIdentity();
      if (currentFrames.application.frame !== beforeFrames.application.frame
        || currentFrames.application.src !== beforeFrames.application.src
        || currentFrames.starlight.frame !== beforeFrames.starlight.frame
        || currentFrames.starlight.src !== beforeFrames.starlight.src) {
        throw new Error(`paired-preview-frame-identity-changed:${row.family}/${row.mode}`);
      }
      facts.push(["appearanceMatrixCell", JSON.stringify({
        family: row.family,
        mode: values.mode,
        background: values.background,
        primary: values.primary,
        fontUi: values.fontUi,
        radius: values.radius,
        selection: values.selection,
        selectionText: values.selectionText,
        rolesMatch: true,
      })]);
    }
    const afterStatus = await invoke("studio_app_theme_status");
    if (!pairedSurface() || !pairedPanel() || editorSnapshot() !== beforeEditor
      || afterStatus.pairedV2Authoring?.sessionId !== beforeSession
      || !text(document.querySelector('[data-testid="paired-v2-editor-revision"]')).includes("Editor revision 0")) {
      throw new Error("paired-editor-not-preserved");
    }
    facts.push(["appearanceMatrixEditorPreserved", "true"]);
    return "12 generated appearance matrix cells matched; paired preview iframe src and DOM identity preserved; editor session preserved";
  });

  const brandSystem = () => step("brand-system-view", "dom", async () => {
    await click("Brand / System");
    await waitFor(() => document.querySelector('[data-destination="brand-system"]:not([hidden])'), "Brand / System area");
    return "visible";
  });

  // Scenario C: plan cancellation, then a derive plan applied to the case-exact project.
  const planObservation = () => {
    const announcement = text(document.querySelector('.plan-workspace p[role="status"]'));
    const progress = text(document.querySelector("[aria-label='Plan operation progress']"));
    return formatPlanObservation(announcement, progress);
  };

  const deriveCancel = () => step("derive-plan-cancel", "dom", () => withPlanLifecycleFact(async () => {
    const nav = document.querySelector('nav[aria-label="Brand workbench views"]');
    await click("Recipes", { root: nav });
    await click("Review derive plan", { timeout: 60000 });
    const outcomes = ["The operation was cancelled.", "Plan ready for review.", "The operation was already complete or did not belong to this session."];
    // Cancel as soon as the operation exposes its handle; a small plan may finish first, which is recorded.
    const gate = await waitFor(() => {
      const cancelButton = button("Cancel operation");
      const announcement = text(document.querySelector('.plan-workspace p[role="status"]'));
      return classifyPlanGate(cancelButton, announcement, outcomes);
    }, "cancellable operation or outcome", 10000, planObservation);
    if (gate.kind === "failure") throw new Error(`plan operation failed: ${gate.message}`);
    const cancelRequested = gate.kind === "cancel";
    if (cancelRequested) gate.button.click();
    const outcomeGate = gate.kind === "outcome" ? gate : await waitFor(() => classifyPlanOutcome(
      text(document.querySelector('.plan-workspace p[role="status"]')),
      text(document.body),
      outcomes,
    ), "plan outcome after cancel", 90000, planObservation);
    if (outcomeGate.kind === "failure") throw new Error(`plan operation failed: ${outcomeGate.message}`);
    const outcome = outcomeGate.message;
    facts.push(["deriveCancel", cancelRequested ? `requested: ${outcome}` : `finished first: ${outcome}`]);
    if (outcome === "Plan ready for review." || button("Discard plan")) {
      await click("Discard plan");
      await waitFor(() => bodyIncludes("The plan was discarded."), "plan discarded", 60000);
    }
    return `${cancelRequested ? "cancel requested" : "operation finished before cancel"} · ${outcome}`;
  }));

  const deriveApply = () => step("derive-plan-apply", "dom", async () => {
    await click("Review derive plan", { timeout: 60000 });
    await waitFor(() => bodyIncludes("Confirm this exact retained plan"), "plan confirmation", 90000);
    const acknowledge = await waitFor(() => Array.from(document.querySelectorAll(".plan-confirmation input[type=checkbox]")).find((box) => !box.disabled), "acknowledgement");
    if (!acknowledge.checked) acknowledge.click();
    await click("Apply this exact plan");
    // Wait for the workspace's terminal announcement, whatever it is, so a failed apply reports the UI's own words.
    const announcement = () => text(document.querySelector('.plan-workspace p[role="status"]'));
    const terminal = ["The exact plan was applied", "The apply outcome is indeterminate", "failed", "invalid", "stale", "mismatch", "unavailable", "cancelled", "busy"];
    const outcome = await waitFor(() => { const value = announcement(); return terminal.some((word) => value.includes(word)) ? value : ""; }, "plan apply outcome", 120000,
      () => `announcement="${announcement()}" progress="${text(document.querySelector("[aria-label='Plan operation progress']"))}"`);
    if (outcome !== "The exact plan was applied and canonical reads refreshed.") {
      facts.push(["deriveApplyStatusProbe", await brandStatusProbe()]);
      throw new Error(`apply outcome: ${outcome}`);
    }
    return "applied";
  });

  const scenarios = {
    // A (macOS arm64): host first, then project, brand read, Theme Lab and App Theme.
    A: [shell, () => hostStart(), () => hostStatus(), () => projectOpen("project-open", "core-fixture"), () => families("brand-read", "Core Fixture Brand"),
      themeLab, appThemeStatus, appTheme, brandSystem, () => hostStatus("host-status-final")],
    // B (Linux arm64): App Theme compile before the host, then Unicode/space and case-distinct projects.
    B: [shell, appThemeStatus, appTheme, themeLab, brandSystem, () => hostStart(), () => hostStatus(),
      () => projectOpen("project-open-upper", "nebular-smoke-upper"), () => families("brand-read-upper", "Core Fixture Brand"),
      () => projectOpen("project-open-lower", "nebular-smoke-lower"), () => families("brand-read-lower", "Nebular Smoke Lower Brand"),
      () => hostStatus("host-status-final")],
    // C (Linux x64): start, a start request on the ready host (session kept), then the real restart (stop
    // and start again), then cancel and apply derive plans on the case-exact project; normal quit.
    C: [shell, () => hostStart(), hostStartIdempotent, hostStop, () => hostStart("host-start-again"), () => hostStatus(),
      () => projectOpen("project-open-case", "nebular-derive-upper"), deriveCancel, deriveApply, () => hostStatus("host-status-final")],
    "P-save": [() => appearanceShell("p-save-shell"), pSaveLoadMissing, pSaveSelectFamily, pSaveSelectMode, pSaveApply, pSaveLoadSaved],
    "P-restart": [() => appearanceShell("p-restart-shell"), pRestartStartup, pRestartLoadExact],
    "paired-v2": [shell, pairedAppTheme, pairedOpenDeveloper, pairedBrief, pairedThreeEdits, pairedCompileBoth,
      pairedPreviewAcks, pairedCandidateCreate, pairedReviewAssociation, pairedSelectCandidate,
      pairedAppearanceDark, pairedApplyDetached, pairedSaveAsFreeze, pairedReopenSaved, pairedAppearanceMatrix],
  };
  // C-signal leaves the sidecar running so the harness can prove it exits when the application is killed.
  scenarios["C-signal"] = scenarios.C;

  async function main() {
    const plan = scenarios[scenario];
    if (!plan) {
      steps.push({ id: "scenario", ok: false, via: "config", ms: 0, detail: `unknown scenario ${scenario}` });
    } else {
      for (const run of plan) {
        if (!(await run())) break;
      }
    }
    const status = plan && steps.length >= plan.length && steps.every((entry) => entry.ok) ? "pass" : "fail";
    window.__NEBULAR_RELEASE_SMOKE__ = { status, scenario, steps, facts };
  }

  main().catch((error) => {
    steps.push({ id: "driver", ok: false, via: "driver", ms: 0, detail: String(error && error.message ? error.message : error).slice(0, 400) });
    window.__NEBULAR_RELEASE_SMOKE__ = { status: "fail", scenario, steps, facts };
  });
})();

