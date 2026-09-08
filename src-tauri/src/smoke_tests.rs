use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, WebviewWindow};

pub fn start_native_smoke_harness(window: &WebviewWindow, app: AppHandle, output_path: String) {
    let window = window.clone();
    let app = app.clone();

    thread::spawn(move || {
        // Initial delay for webview to start navigation and mount DOM
        thread::sleep(Duration::from_secs(2));

        match crate::theme_lab::smoke_selection::scenario_script() {
            Ok(script) => {
                if window.eval(&script).is_err() {
                    app.exit(1);
                    return;
                }
            }
            Err(_) => {
                eprintln!("[smoke] invalid bounded exchange scenario");
                app.exit(1);
                return;
            }
        }

        if let Err(error) = window.eval(include_str!("../../tools/ci/native-theme-exchange.js")) {
            eprintln!("[smoke] exchange script injection failed: {error}");
            app.exit(1);
            return;
        }
        let runner_script = r##"
(function() {
    if (window.__TFSB_SMOKE_STARTED__) return;
    window.__TFSB_SMOKE_STARTED__ = true;

    async function runSmoke() {
        const results = {
            schema: "tfsb.native-theme-lab-smoke",
            schemaVersion: 1,
            timestamp: new Date().toISOString(),
            runtime: "macOS-WKWebView",
            status: "in-progress",
            currentStep: "init",
            measurements: {},
            steps: [],
            errors: []
        };

        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const waitFor = async (predicate, stepName, timeoutMs = 25000, intervalMs = 150) => {
            results.currentStep = stepName;
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                try {
                    const res = await predicate();
                    if (res) return res;
                } catch (_) {}
                await sleep(intervalMs);
            }
            throw new Error(`Timeout at step '${stepName}' after ${timeoutMs}ms`);
        };

        try {
            // 1. Wait for destination nav tabs to mount
            results.steps.push("wait_app_mount");
            await waitFor(() => {
                const tabs = Array.from(document.querySelectorAll("nav.destination-nav button"));
                return tabs.some(t => t.textContent && t.textContent.includes("Theme Lab"));
            }, "wait_for_tabs");

            // 2. Switch to Theme Lab (retry click until container appears)
            results.steps.push("switched_to_theme_lab");
            await waitFor(() => {
                if (document.querySelector(".theme-lab-workspace")) return true;
                const tabs = Array.from(document.querySelectorAll("nav.destination-nav button"));
                const tab = tabs.find(t => t.textContent && t.textContent.includes("Theme Lab"));
                if (tab) {
                    tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                    tab.click();
                }
                return document.querySelector(".theme-lab-workspace");
            }, "switch_to_theme_lab_container", 15000);

            // 3. Wait for initial compile and preview iframe (Stellar Cyan default)
            const t0 = Date.now();
            const iframe = await waitFor(() => {
                const el = document.querySelector("iframe.preview-iframe");
                if (el && el.dataset && el.dataset.computedAccent) return el;
                return null;
            }, "wait_initial_preview_accent", 30000);

            const initialAccent = iframe.dataset.computedAccent;
            const initialRev = parseInt(document.querySelector(".preview-meta")?.textContent?.replace(/\D/g, "") || "0", 10);
            results.measurements.initial = {
                durationMs: Date.now() - t0,
                revision: initialRev,
                computedAccent: initialAccent
            };
            results.steps.push("initial_preview_applied");

            // 4. CSS/descriptor digest agreement verification
            const outputTab = await waitFor(() => {
                const tabBtns = Array.from(document.querySelectorAll('button[role="tab"], .editor-tabs button'));
                return tabBtns.find(b => b.textContent && (b.textContent.includes("CSS & Descriptor") || b.textContent.includes("Output")));
            }, "find_output_tab");
            outputTab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            outputTab.click();

            const cssTextArea = await waitFor(() => document.querySelector('textarea[aria-label="Compiled CSS output"]'), "wait_css_output");
            const descTextArea = await waitFor(() => document.querySelector('textarea[aria-label="Theme descriptor JSON"]'), "wait_desc_output");
            const digestTag = await waitFor(() => document.querySelector(".digest-tag"), "wait_digest_tag");

            const cssText = cssTextArea.value;
            const desc = JSON.parse(descTextArea.value);
            const tagText = digestTag.textContent || "";

            const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cssText));
            const computedCssSha = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

            if (desc.outputDigest !== computedCssSha) {
                throw new Error(`CSS digest mismatch: computed=${computedCssSha}, descriptor=${desc.outputDigest}`);
            }
            if (!tagText.includes(computedCssSha)) {
                throw new Error(`Digest tag does not contain computed SHA: ${tagText}`);
            }
            if (desc.schema !== "tfsl.theme-descriptor-v1" || desc.adapter !== "starlight-v0.42") {
                throw new Error(`Unexpected descriptor contract: schema=${desc.schema}, adapter=${desc.adapter}`);
            }

            results.measurements.digestAgreement = {
                schema: desc.schema,
                schemaVersion: desc.schemaVersion,
                adapter: desc.adapter,
                outputDigest: desc.outputDigest,
                recomputedSha256: computedCssSha,
                agreement: true
            };
            results.steps.push("digest_agreement_verified");

            // Switch back to Palette tab
            const paletteTab = await waitFor(() => {
                const tabBtns = Array.from(document.querySelectorAll('button[role="tab"], .editor-tabs button'));
                return tabBtns.find(b => b.textContent && b.textContent.includes("Palette"));
            }, "find_palette_tab");
            paletteTab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            paletteTab.click();

            // 5. Main editor style isolation verification (before edit)
            const mainEditorBgBefore = window.getComputedStyle(document.body).backgroundColor;
            const mainEditorAccentBefore = window.getComputedStyle(document.body).getPropertyValue("--sl-color-accent");

            // 6. Edit accent color and manual compile
            const tCompileStart = Date.now();
            const accentInput = await waitFor(() => document.querySelector('input[aria-label="Accent base hex code"]'), "find_accent_input");
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (nativeSetter) {
                nativeSetter.call(accentInput, "#ff4488");
            } else {
                accentInput.value = "#ff4488";
            }
            accentInput.dispatchEvent(new Event("input", { bubbles: true }));
            accentInput.dispatchEvent(new Event("change", { bubbles: true }));

            const compileBtn = await waitFor(() => {
                return document.querySelector("button.compile-button") || Array.from(document.querySelectorAll("button")).find(b => b.textContent && b.textContent.includes("Compile"));
            }, "find_compile_button");
            compileBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            compileBtn.click();

            await waitFor(() => {
                const acc = iframe.dataset.computedAccent;
                const rev = parseInt(document.querySelector(".preview-meta")?.textContent?.replace(/\D/g, "") || "0", 10);
                return rev > initialRev && acc && (acc.includes("ff4488") || acc.includes("255, 68, 136"));
            }, "wait_compiled_preview_accent", 20000);

            results.measurements.editAndCompile = {
                durationMs: Date.now() - tCompileStart,
                updatedRevision: parseInt(document.querySelector(".preview-meta")?.textContent?.replace(/\D/g, "") || "0", 10),
                updatedComputedAccent: iframe.dataset.computedAccent
            };
            results.steps.push("edit_and_compile_applied");

            // Verify main editor style isolation after preview update
            const mainEditorBgAfter = window.getComputedStyle(document.body).backgroundColor;
            const mainEditorAccentAfter = window.getComputedStyle(document.body).getPropertyValue("--sl-color-accent");
            if (mainEditorBgBefore !== mainEditorBgAfter || mainEditorAccentAfter !== "") {
                throw new Error(`Style isolation failure: bg before=${mainEditorBgBefore}, after=${mainEditorBgAfter}, accent after=${mainEditorAccentAfter}`);
            }
            results.measurements.styleIsolation = {
                mainEditorBgBefore,
                mainEditorBgAfter,
                mainEditorAccentBefore,
                mainEditorAccentAfter,
                styleIsolated: true
            };
            results.steps.push("style_isolation_verified");

            // 7. Preview Command Denial Test
            // Harmless real registered command succeeds from main window
            const mainCommandResult = await window.__TAURI_INTERNALS__.invoke("studio_theme_lab_status");
            if (!mainCommandResult || typeof mainCommandResult.available !== "boolean") {
                throw new Error("Main window failed to invoke studio_theme_lab_status");
            }

            // Attempt harmless real registered command from preview subframe
            iframe.contentWindow.postMessage({ type: "tfsl:attempt-command", command: "studio_theme_lab_status" }, "*");
            const denialResult = await waitFor(() => {
                if (iframe.dataset.commandAttempt) {
                    try { return JSON.parse(iframe.dataset.commandAttempt); } catch (_) {}
                }
                return null;
            }, "wait_command_denial", 10000);

            if (denialResult.directAllowed !== false || denialResult.parentAllowed !== false) {
                throw new Error(`Preview command denial failed: directAllowed=${denialResult.directAllowed}, parentAllowed=${denialResult.parentAllowed}`);
            }
            results.measurements.commandDenial = {
                mainCommandSucceeded: true,
                previewDirectAllowed: denialResult.directAllowed,
                previewParentAllowed: denialResult.parentAllowed,
                reason: denialResult.reason
            };
            results.steps.push("preview_command_denial_verified");

            // 8. Discard modal cancelled preserves draft
            const amberBtn = await waitFor(() => {
                const btns = Array.from(document.querySelectorAll("button"));
                return btns.find(b => b.textContent && b.textContent.includes("Amber Forge"));
            }, "find_amber_forge_button");
            amberBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            amberBtn.click();

            const discardModal = await waitFor(() => document.querySelector(".modal-backdrop"), "wait_discard_modal");
            const modalCancelBtn = discardModal.querySelector(".modal-actions button:not(.danger-button)");
            if (!modalCancelBtn) throw new Error("Missing cancel button in discard modal");
            modalCancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            modalCancelBtn.click();

            await waitFor(() => !document.querySelector(".modal-backdrop"), "wait_discard_modal_close");
            if (!document.querySelector(".dirty-indicator")) {
                throw new Error("Draft dirty state was not preserved after discard modal cancel");
            }
            results.steps.push("discard_modal_cancelled_draft_preserved");

            // 9. Load Amber Forge example after confirming discard
            const amberBtn2 = await waitFor(() => {
                const btns = Array.from(document.querySelectorAll("button"));
                return btns.find(b => b.textContent && b.textContent.includes("Amber Forge"));
            }, "find_amber_forge_button_2");
            amberBtn2.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            amberBtn2.click();

            const discardModal2 = await waitFor(() => document.querySelector(".modal-backdrop"), "wait_discard_modal_2");
            const confirmBtn = discardModal2.querySelector("button.danger-button");
            if (!confirmBtn) throw new Error("Missing confirm button in discard modal");
            confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            confirmBtn.click();

            await waitFor(() => !document.querySelector(".modal-backdrop"), "wait_discard_modal_close_2");

            await waitFor(() => {
                const acc = iframe.dataset.computedAccent;
                return acc && (acc.includes("f59e0b") || acc.includes("245, 158, 11"));
            }, "wait_amber_forge_accent", 20000);

            results.measurements.amberForge = {
                computedAccent: iframe.dataset.computedAccent,
                revision: parseInt(document.querySelector(".preview-meta")?.textContent?.replace(/\D/g, "") || "0", 10)
            };
            results.steps.push("amber_forge_example_loaded");

            // 10. Viewport (Desktop/Mobile) and Color Scheme (Light/Dark) Mode Toggles
            const lightBtn = await waitFor(() => {
                const btns = Array.from(document.querySelectorAll(".segmented-control button"));
                return btns.find(b => b.textContent && b.textContent.includes("Light"));
            }, "find_light_button");
            lightBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            lightBtn.click();
            await sleep(250);

            const mobileBtn = await waitFor(() => {
                const btns = Array.from(document.querySelectorAll(".segmented-control button"));
                return btns.find(b => b.textContent && b.textContent.includes("Mobile"));
            }, "find_mobile_button");
            mobileBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            mobileBtn.click();
            await waitFor(() => document.querySelector(".preview-frame-wrapper.mobile"), "wait_mobile_wrapper");

            const desktopBtn = await waitFor(() => {
                const btns = Array.from(document.querySelectorAll(".segmented-control button"));
                return btns.find(b => b.textContent && b.textContent.includes("Desktop"));
            }, "find_desktop_button");
            desktopBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            desktopBtn.click();
            await waitFor(() => document.querySelector(".preview-frame-wrapper.desktop"), "wait_desktop_wrapper");

            const darkBtn = await waitFor(() => {
                const btns = Array.from(document.querySelectorAll(".segmented-control button"));
                return btns.find(b => b.textContent && b.textContent.includes("Dark"));
            }, "find_dark_button");
            darkBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            darkBtn.click();
            await sleep(250);

            results.measurements.viewToggles = {
                lightModeToggled: true,
                mobileViewportToggled: true,
                desktopViewportToggled: true,
                darkModeToggled: true
            };
            results.steps.push("preview_viewport_and_mode_toggled");

            // 11. Invalid edit -> useful diagnostic -> visibly last-good preview
            const amberAccentInput = await waitFor(() => document.querySelector('input[aria-label="Accent base hex code"]'), "find_amber_accent_input");
            const lastGoodAccent = iframe.dataset.computedAccent;
            if (nativeSetter) {
                nativeSetter.call(amberAccentInput, "#invalid");
            } else {
                amberAccentInput.value = "#invalid";
            }
            amberAccentInput.dispatchEvent(new Event("input", { bubbles: true }));
            amberAccentInput.dispatchEvent(new Event("change", { bubbles: true }));

            const compileBtn2 = await waitFor(() => {
                return document.querySelector("button.compile-button") || Array.from(document.querySelectorAll("button")).find(b => b.textContent && b.textContent.includes("Compile"));
            }, "find_compile_button_2");
            compileBtn2.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            compileBtn2.click();

            await waitFor(() => {
                const status = document.querySelector(".theme-lab-status-bar")?.textContent || "";
                const badge = document.querySelector(".preview-badge.warning")?.textContent || "";
                return status.includes("Compilation error") || badge.includes("last valid");
            }, "wait_invalid_edit_rejection", 15000);

            // Preview must visibly retain last-good Amber Forge accent
            if (iframe.dataset.computedAccent !== lastGoodAccent) {
                throw new Error(`Preview did not retain last-good accent: current=${iframe.dataset.computedAccent}, expected=${lastGoodAccent}`);
            }
            results.measurements.invalidEditDiagnostic = {
                retainedLastGoodAccent: lastGoodAccent,
                diagnosticRendered: true
            };
            results.steps.push("invalid_edit_retains_last_good_preview");

            // 12. Reset confirmed and default theme restored
            const resetBtn = await waitFor(() => {
                const btns = Array.from(document.querySelectorAll(".theme-lab-header-actions button, .button-group button"));
                return btns.find(b => b.textContent && b.textContent.includes("Reset"));
            }, "find_reset_button");
            resetBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            resetBtn.click();

            const modal = await waitFor(() => document.querySelector(".modal-backdrop"), "wait_discard_modal_reset");
            const confirmResetBtn = modal.querySelector("button.danger-button");
            if (!confirmResetBtn) throw new Error("Missing confirm reset button");
            confirmResetBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            confirmResetBtn.click();

            await waitFor(() => !document.querySelector(".modal-backdrop"), "wait_reset_modal_close");

            await waitFor(() => {
                const acc = iframe.dataset.computedAccent;
                return acc && (acc.includes("f59e0b") || acc.includes("245, 158, 11"));
            }, "wait_restored_amber_accent", 20000);

            // Switch back to default Stellar Cyan example
            const cyanBtn = await waitFor(() => {
                const btns = Array.from(document.querySelectorAll("button"));
                return btns.find(b => b.textContent && b.textContent.includes("Stellar Cyan"));
            }, "find_cyan_button");
            cyanBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            cyanBtn.click();

            await waitFor(() => {
                const acc = iframe.dataset.computedAccent;
                return acc && (acc.includes("00d2ff") || acc.includes("0, 210, 255"));
            }, "wait_restored_default_accent", 20000);

            results.steps.push("reset_confirmed_and_restored");

            // 13. Leave Theme Lab (View Switching to Brand Workbench)
            await waitFor(() => {
                if (!document.querySelector(".theme-lab-workspace")) return true;
                const tabs = Array.from(document.querySelectorAll("nav.destination-nav button"));
                const brandTab = tabs.find(t => t.textContent && t.textContent.includes("Brand Workbench"));
                if (brandTab) {
                    brandTab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                    brandTab.click();
                }
                return !document.querySelector(".theme-lab-workspace");
            }, "switch_to_brand_workbench", 15000);
            results.steps.push("left_theme_lab_to_brand_workbench");

            // 14. Re-enter Theme Lab
            await waitFor(() => {
                if (document.querySelector(".theme-lab-workspace")) return true;
                const tabs = Array.from(document.querySelectorAll("nav.destination-nav button"));
                const themeTab = tabs.find(t => t.textContent && t.textContent.includes("Theme Lab"));
                if (themeTab) {
                    themeTab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                    themeTab.click();
                }
                return document.querySelector(".theme-lab-workspace");
            }, "reenter_theme_lab", 15000);

            const reenteredIframe = await waitFor(() => {
                const el = document.querySelector("iframe.preview-iframe");
                if (el && el.dataset && el.dataset.computedAccent) return el;
                return null;
            }, "wait_reentered_preview_accent", 30000);

            results.measurements.reentry = {
                reenteredRevision: parseInt(document.querySelector(".preview-meta")?.textContent?.replace(/\D/g, "") || "0", 10),
                computedAccent: reenteredIframe.dataset.computedAccent
            };
            results.steps.push("reentered_theme_lab_successfully");

            // 15. Re-entry edit & compile
            const reentryRevBefore = results.measurements.reentry.reenteredRevision;
            const tReentryCompileStart = Date.now();
            const reentryAccentInput = await waitFor(() => document.querySelector('input[aria-label="Accent base hex code"]'), "find_reentry_accent_input");
            if (nativeSetter) {
                nativeSetter.call(reentryAccentInput, "#38bdf8");
            } else {
                reentryAccentInput.value = "#38bdf8";
            }
            reentryAccentInput.dispatchEvent(new Event("input", { bubbles: true }));
            reentryAccentInput.dispatchEvent(new Event("change", { bubbles: true }));

            const compileBtn3 = await waitFor(() => {
                return document.querySelector("button.compile-button") || Array.from(document.querySelectorAll("button")).find(b => b.textContent && b.textContent.includes("Compile"));
            }, "find_compile_button_3");
            compileBtn3.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            compileBtn3.click();

            await waitFor(() => {
                const acc = reenteredIframe.dataset.computedAccent;
                const rev = parseInt(document.querySelector(".preview-meta")?.textContent?.replace(/\D/g, "") || "0", 10);
                return rev > reentryRevBefore && acc && (acc.includes("38bdf8") || acc.includes("56, 189, 248"));
            }, "wait_reentry_compiled_accent", 20000);

            results.measurements.reentryEditAndCompile = {
                durationMs: Date.now() - tReentryCompileStart,
                updatedRevision: parseInt(document.querySelector(".preview-meta")?.textContent?.replace(/\D/g, "") || "0", 10),
                updatedComputedAccent: reenteredIframe.dataset.computedAccent
            };
            results.steps.push("reentry_edit_and_compile_applied");

            await window.__runThemeExchangeSmoke({ results, waitFor, sleep });
            results.status = "pass";
        } catch (err) {
            results.status = "fail";
            results.errors.push(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
            results.debug = {
                currentStep: results.currentStep,
                activeTab: document.querySelector(".destination-tab.active")?.textContent,
                buttons: Array.from(document.querySelectorAll("button")).map(b => b.textContent?.trim()).filter(Boolean),
                hasThemeLabContainer: !!document.querySelector(".theme-lab-workspace"),
                hasIframe: !!document.querySelector("iframe.preview-iframe"),
                iframeAccent: document.querySelector("iframe.preview-iframe")?.dataset?.computedAccent
            };
        }

        window.__TFSB_SMOKE_RESULT__ = JSON.stringify(results);
    }

    runSmoke();
})();
"##;

        if let Err(e) = window.eval(runner_script) {
            eprintln!("[smoke] failed to inject runner script: {e}");
        }

        let completed = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_secs(90);

        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(250));

            let completed_flag = completed.clone();
            let output_path_clone = output_path.clone();
            let app_exit = app.clone();

            if crate::theme_lab::smoke_selection::alternatives_ready() {
                let _ = window.eval("window.__TFSB_EXCHANGE_READY__ = true;");
            }
            let _ = window.eval_with_callback(
                "window.__TFSB_SMOKE_RESULT__ || ''",
                move |raw_result| {
                    if raw_result.is_empty() || raw_result == "\"\"" || raw_result == "null" {
                        return;
                    }

                    if completed_flag.swap(true, Ordering::SeqCst) {
                        return; // already handled
                    }

                    let json_text = match serde_json::from_str::<String>(&raw_result) {
                        Ok(unquoted) => unquoted,
                        Err(_) => raw_result,
                    };

                    #[derive(serde::Deserialize)]
                    struct SmokePayload {
                        #[serde(default)]
                        status: String,
                    }

                    let status = match serde_json::from_str::<SmokePayload>(&json_text) {
                        Ok(payload) => payload.status,
                        Err(_) => "fail".to_string(),
                    };

                    if let Some(parent) = PathBuf::from(&output_path_clone).parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Err(e) = std::fs::write(&output_path_clone, &json_text) {
                        eprintln!("[smoke] failed to write output: {e}");
                    } else {
                        println!("[smoke] results written to {}", output_path_clone);
                    }

                    println!("[smoke] native smoke verdict: {}", status);
                    let exit_code = if status == "pass" { 0 } else { 1 };
                    app_exit.exit(exit_code);
                },
            );

            if completed.load(Ordering::SeqCst) {
                return;
            }
        }

        // Timeout watchdog
        eprintln!("[smoke] watchdog timeout reached");
        let timeout_str = "{\n  \"schema\": \"tfsb.native-theme-lab-smoke\",\n  \"schemaVersion\": 1,\n  \"status\": \"fail\",\n  \"error\": \"watchdog timeout after 90s waiting for smoke completion\"\n}\n";
        if let Some(parent) = PathBuf::from(&output_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&output_path, timeout_str);
        app.exit(1);
    });
}
