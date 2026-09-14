// Fixed application-owned native-smoke scenario; never loaded in ordinary builds.
window.__runThemeV2Smoke = async ({ results, waitFor }) => {
  const click = async (text) => {
    const button = await waitFor(() => Array.from(document.querySelectorAll("button"))
      .find((item) => item.textContent?.trim() === text && !item.disabled), `v2_button_${text}`);
    button.click();
  };
  const input = (element, value) => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  await waitFor(() => document.querySelector("iframe.preview-iframe")?.dataset.computedAccent, "v2_entry_ready");
  await click("New v2 Theme");
  await waitFor(() => document.querySelector('select[aria-label="Gallery scenario"]'), "v2_created");
  await waitFor(() => document.querySelector("iframe.preview-iframe")?.dataset.computedAccent, "v2_gallery_applied", 30000);
  const field = await waitFor(() => document.querySelector('input[aria-label="body Font Size"]'), "v2_visual_field");
  input(field, "18");
  await click("Compile");
  await waitFor(() => document.querySelector(".theme-lab-status-bar")?.textContent?.includes("compiled successfully"), "v2_native_compile", 30000);
  const status = await window.__TAURI_INTERNALS__.invoke("studio_theme_lab_status");
  const specification = JSON.parse(document.querySelector('pre[aria-label="Theme Specification JSON"]').textContent);
  const stale = await window.__TAURI_INTERNALS__.invoke("studio_theme_lab_compile", { request: {
    specification, sessionId: status.sessionId, uiRevision: status.latestRevision - 1,
  } });
  if (stale.valid || stale.error?.code !== "STALE_REVISION") throw new Error("Stale native theme compile was accepted");
  await click("CSS & Descriptor");
  const descriptor = await waitFor(() => {
    const value = document.querySelector('textarea[aria-label="Theme descriptor JSON"]')?.value;
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed.schema === "tfsl.theme-descriptor-v2" ? parsed : null;
  }, "v2_descriptor");
  const css = document.querySelector('textarea[aria-label="Compiled CSS output"]').value;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(css))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== descriptor.outputDigest) throw new Error("V2 native output digest mismatch");
  const selector = document.querySelector('select[aria-label="Gallery scenario"]');
  input(selector, "flexoki-catalog");
  const frame = await waitFor(() => {
    const current = document.querySelector("iframe.preview-iframe");
    return current?.src.includes("flexoki-catalog") && current.dataset.computedAccent ? current : null;
  }, "v2_gallery_scenario_ack", 30000);

  const parseCommandAttempt = (raw) => {
    if (typeof raw !== "string" || raw.length > 1024) return null;
    let value;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!value || Array.isArray(value) || typeof value !== "object") return null;
    const keys = ["type", "command", "directAllowed", "parentAllowed", "reason"];
    if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
      || value.type !== "tfsl:command-attempt-result" || value.command !== "studio_theme_lab_status"
      || typeof value.directAllowed !== "boolean" || typeof value.parentAllowed !== "boolean"
      || typeof value.reason !== "string" || value.reason.length > 256) return null;
    return value;
  };

  frame.contentWindow.postMessage({ type: "tfsl:attempt-command" }, "*");
  const denial = await waitFor(() => parseCommandAttempt(frame.dataset.commandAttempt), "v2_gallery_command_denial");
  if (denial.directAllowed || denial.parentAllowed) throw new Error("Gallery gained native authority");

  const effectiveCspEvidence = await waitFor(() => {
    const ev = window.__TFSB_GALLERY_EFFECTIVE_CSP__;
    if (ev && typeof ev === "object" && ev.effectiveCsp && ev.assetPath === new URL(frame.src).pathname) {
      return ev;
    }
    return null;
  }, "v2_gallery_effective_csp", 15000);
  if (effectiveCspEvidence.browserHarnessOnly !== false
    || effectiveCspEvidence.assetPath !== new URL(frame.src).pathname
    || !/^[a-f0-9]{64}$/.test(effectiveCspEvidence.assetSha256)) {
    throw new Error("Gallery receipt is not bound to the actual Tauri frame document");
  }
  if (frame.getAttribute("sandbox") !== "allow-scripts" || denial.parentAllowed !== false) {
    throw new Error("Gallery opaque scripts-only sandbox was not observed");
  }
  effectiveCspEvidence.opaqueSandboxConfirmed = true;

  if (!effectiveCspEvidence.browserHarnessOnly) {
    if (effectiveCspEvidence.ipcDenied !== true || effectiveCspEvidence.effectiveCsp.includes("ipc:") || effectiveCspEvidence.effectiveCsp.includes("ipc.localhost")) {
      throw new Error("Effective gallery CSP permitted IPC authority");
    }
    if (!effectiveCspEvidence.effectiveCsp.includes("tauri://localhost")) {
      throw new Error("Effective gallery CSP missing required local origin tauri://localhost");
    }
    if (!effectiveCspEvidence.effectiveCsp.includes("frame-ancestors 'self'")) {
      throw new Error("Effective gallery CSP missing frame-ancestors 'self'");
    }
    if (effectiveCspEvidence.accessControlAllowOrigin !== "*") {
      throw new Error("Gallery response missing access-control-allow-origin: *");
    }
  }
  for (const label of ["Light", "Dark", "Mobile (390px)", "Desktop"]) {
    const button = Array.from(document.querySelectorAll(".preview-toolbar button")).find((item) => item.textContent?.trim() === label);
    if (!button) throw new Error(`Missing preview control ${label}`);
    button.click();
  }
  for (const label of ["Brand / System", "Vector / Graphics", "Starlight Theme"]) await click(label);
  if (!document.querySelector(".dirty-indicator")) throw new Error("V2 unsaved draft lost across work areas");
  await click("Save As…");
  await waitFor(() => document.querySelector(".theme-lab-status-bar")?.textContent?.includes("Saved") && !document.querySelector(".dirty-indicator"), "v2_selected_save", 30000);
  await click("Open…");
  await waitFor(() => document.querySelector(".theme-lab-status-bar")?.textContent?.includes("Opened") && document.querySelector('select[aria-label="Gallery scenario"]'), "v2_selected_open", 30000);
  await click("Review context…");
  const action = async (id) => {
    const button = await waitFor(() => {
      const current = document.querySelector(`[data-testid="${id}"]`);
      return current && !current.disabled ? current : null;
    }, `v2_${id}`, 30000);
    button.click();
  };
  await action("import-candidate-btn");
  await waitFor(() => document.querySelector('[data-testid="inspector-candidate-id"]'), "v2_candidate_imported", 30000);
  await action("verify-candidate-btn");
  await action("adopt-candidate-btn");
  await waitFor(() => document.querySelector(".dirty-indicator"), "v2_unsaved_adoption", 30000);
  results.measurements.themeV2 = {
    descriptor,
    digestAgreement: true,
    galleryScenario: "flexoki-catalog",
    commandDenial: denial,
    effectiveCsp: effectiveCspEvidence,
    unsavedDraftPreserved: true,
  };
  results.measurements.effectiveGalleryCsp = effectiveCspEvidence;
  results.steps.push("gallery_effective_csp_verified");
  results.measurements.themeV2.selectedSaveOpen = "deterministic native-smoke picker substitution";
  results.measurements.themeV2.exchange = "candidate imported, locally verified and adopted as an unsaved draft";
  results.measurements.themeV2.staleCompileRejected = true;
  results.steps.push("v2_native_compile_gallery_and_three_area_switching");
  await click("Stellar Cyan");
  const confirm = await waitFor(() => document.querySelector(".modal-backdrop button.danger-button"), "v2_restore_v1_confirmation");
  confirm.click();
  await waitFor(() => !document.querySelector('select[aria-label="Gallery scenario"]') && document.querySelector("iframe.preview-iframe")?.dataset.computedAccent, "v2_restored_v1", 30000);
};
