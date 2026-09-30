// Nebular release smoke driver. Compiled into the release binary (release_smoke/mod.rs) and evaluated
// in the real window only when the release smoke mode is active. It drives the packaged frontend
// through its DOM (accessible names and visible status text) and confirms effects through the same
// read-only status commands the frontend uses. It adds no command and needs no capability beyond the
// main window's. Results are published on window.__NEBULAR_RELEASE_SMOKE__ for the Rust host.
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

  const brandSystem = () => step("brand-system-view", "dom", async () => {
    await click("Brand / System");
    await waitFor(() => document.querySelector('[data-destination="brand-system"]:not([hidden])'), "Brand / System area");
    return "visible";
  });

  // Scenario C: plan cancellation, then a derive plan applied to the case-exact project.
  const planMessage = () => text(document.querySelector(".plan-workspace, [aria-label='Plan operation progress']")) + " " + text(document.body);

  const deriveCancel = () => step("derive-plan-cancel", "dom", async () => {
    const nav = document.querySelector('nav[aria-label="Brand workbench views"]');
    await click("Recipes", { root: nav });
    await click("Review derive plan", { timeout: 60000 });
    const outcomes = ["The operation was cancelled.", "Plan ready for review.", "The operation was already complete or did not belong to this session."];
    // Cancel as soon as the operation exposes its handle; a small plan may finish first, which is recorded.
    const cancel = await waitFor(() => button("Cancel operation") || outcomes.find((message) => bodyIncludes(message)), "cancellable operation or outcome", 10000);
    const cancelRequested = typeof cancel !== "string";
    if (cancelRequested) cancel.click();
    const outcome = await waitFor(() => outcomes.find((message) => bodyIncludes(message)), "plan outcome after cancel", 90000,
      () => text(document.querySelector("[aria-label='Plan operation progress']")) || "no progress");
    facts.push(["deriveCancel", cancelRequested ? `requested: ${outcome}` : `finished first: ${outcome}`]);
    if (outcome === "Plan ready for review." || button("Discard plan")) {
      await click("Discard plan");
      await waitFor(() => bodyIncludes("The plan was discarded."), "plan discarded", 60000);
    }
    return `${cancelRequested ? "cancel requested" : "operation finished before cancel"} · ${outcome}`;
  });

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
