#![forbid(unsafe_code)]

pub mod commands;
mod design_evidence;
pub mod errors;
pub mod scene;
mod sidecar;
pub mod state;
pub mod theme_lab;

#[cfg(feature = "native-smoke")]
#[path = "smoke_tests.rs"]
mod smoke;

#[cfg(test)]
mod command_inventory;

fn adjust_preview_csp(path: &str, headers: &mut tauri::http::HeaderMap) {
    if path.starts_with("/preview/gallery/") {
        // Only bundled gallery assets are readable from the scripts-only opaque frame.
        // This origin has no IPC permission and never gains same-origin sandbox authority.
        headers.insert(
            "access-control-allow-origin",
            tauri::http::HeaderValue::from_static("*"),
        );
        if let Some(value) = headers.get("content-security-policy")
            && let Ok(policy) = value.to_str()
        {
            let script = policy
                .split(';')
                .map(str::trim)
                .find(|part| part.starts_with("script-src "))
                .unwrap_or("script-src 'self'");
            let gallery = format!(
                "default-src 'none'; {script} tauri://localhost 'wasm-unsafe-eval'; style-src 'self' tauri://localhost 'unsafe-inline'; font-src 'self' tauri://localhost; img-src 'self' tauri://localhost data:; connect-src tauri://localhost; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'"
            );
            if let Ok(value) = tauri::http::HeaderValue::from_str(&gallery) {
                headers.insert("content-security-policy", value);
            }
        }
        return;
    }
    if path.starts_with("/preview/")
        && let Some(csp_val) = headers.get_mut("content-security-policy")
        && let Ok(csp_str) = csp_val.to_str()
    {
        // The scripts-only iframe has an opaque origin. Its bundled Starlight
        // styles need the exact local asset origin. Keep script and IPC
        // authority unchanged; never grant allow-same-origin.
        let modified = csp_str
            .replace("frame-ancestors 'none'", "frame-ancestors 'self'")
            .replace("style-src 'self'", "style-src 'self' tauri://localhost");
        if let Ok(new_val) = tauri::http::HeaderValue::from_str(&modified) {
            *csp_val = new_val;
        }
    }
}

pub fn run() {
    use tauri::Manager;

    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let binary = executable
                .parent()
                .ok_or_else(|| "application executable has no parent".to_owned())?
                .join("tfsb-studio-service");
            let resource = app
                .path()
                .resource_dir()
                .map_err(|error| error.to_string())?;
            let temp = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?
                .join("sidecar-temp");
            let host = state::host::HostState::new(sidecar::supervisor::SidecarSupervisor::new(
                binary,
                resource.join("sidecar-payload"),
                temp,
            ))
            .map_err(|_| "plan coordinator unavailable".to_owned())?;
            app.manage(host);

            #[cfg(feature = "native-smoke")]
            theme_lab::smoke_selection::initialize().map_err(|_| "invalid smoke selections")?;

            let theme_lab_runner =
                theme_lab::runner::ThemeLabRunner::discover(&resource, &executable);
            let theme_lab_state = state::theme_lab::ThemeLabState::new(theme_lab_runner);
            app.manage(theme_lab_state);
            app.manage(state::scene::SceneState::new(
                scene::runner::SceneRunner::discover(&resource, &executable),
            ));

            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or_else(|| "main window config not found".to_owned())?;

            let mut window_builder = tauri::WebviewWindowBuilder::from_config(app, &window_config)
                .map_err(|e| e.to_string())?;

            window_builder = window_builder.on_web_resource_request(|request, response| {
                adjust_preview_csp(request.uri().path(), response.headers_mut());
                #[cfg(feature = "native-smoke")]
                smoke::record_gallery_response(
                    request.uri().path(),
                    response.headers(),
                    response.body().as_ref(),
                );
            });

            let _main_window = window_builder.build().map_err(|e| e.to_string())?;

            #[cfg(feature = "native-smoke")]
            if let Ok(smoke_output) = std::env::var("TFSB_STUDIO_SMOKE_OUTPUT") {
                smoke::start_native_smoke_harness(
                    &_main_window,
                    app.handle().clone(),
                    smoke_output,
                );
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::brand_read::studio_brand_read,
            commands::brand_plan::studio_brand_plan_start,
            commands::brand_plan::studio_brand_plan_cancel,
            commands::host::studio_host_start,
            commands::host::studio_host_status,
            commands::selection::studio_select_project,
            commands::selection::studio_select_source,
            commands::host::studio_host_shutdown,
            commands::design_packet::studio_design_packet_import,
            commands::design_packet::studio_design_packet_export,
            commands::theme_lab::studio_theme_lab_status,
            commands::theme_lab::studio_theme_lab_compile,
            commands::theme_lab::studio_theme_lab_example,
            commands::theme_lab::studio_theme_lab_open,
            commands::theme_lab::studio_theme_lab_save,
            commands::theme_lab::studio_theme_lab_dispose,
            commands::theme_lab::studio_theme_lab_draft_update,
            commands::theme_packet::studio_theme_brief_create,
            commands::theme_packet::studio_theme_packet_import,
            commands::theme_packet::studio_theme_packet_export,
            commands::theme_packet::studio_theme_review_create,
            commands::theme_packet::studio_theme_candidate_adopt,
            commands::theme_packet::studio_theme_candidate_verify,
            commands::theme_packet::studio_theme_review_validate,
            commands::scene::studio_scene_new,
            commands::scene::studio_scene_status,
            commands::scene::studio_scene_dispose,
            commands::scene::studio_scene_open,
            commands::scene::studio_scene_import_svg,
            commands::scene::studio_scene_edit,
            commands::scene::studio_scene_compile,
            commands::scene::studio_scene_save_plan,
            commands::scene::studio_scene_save_apply,
            commands::scene::studio_scene_export_plan,
            commands::scene::studio_scene_export_apply,
            commands::scene::studio_scene_bind_tokens,
            commands::scene_packet::studio_scene_brief_create,
            commands::scene_packet::studio_scene_packet_import,
            commands::scene_packet::studio_scene_packet_export,
            commands::scene_packet::studio_scene_review_create,
            commands::scene_packet::studio_scene_candidate_verify,
            commands::scene_packet::studio_scene_candidate_adopt,
        ])
        .build(tauri::generate_context!());

    let Ok(application) = application else {
        eprintln!("TFSB Studio failed to start");
        std::process::exit(1);
    };

    application.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            let host_state = handle.state::<state::host::HostState>();
            let _ = host_state.shutdown_host();
            let theme_lab_state = handle.state::<state::theme_lab::ThemeLabState>();
            theme_lab_state.shutdown();
            handle.state::<state::scene::SceneState>().shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::command_inventory;

    #[test]
    fn preview_csp_changes_only_the_two_required_directives()
    -> Result<(), Box<dyn std::error::Error>> {
        #[derive(serde::Deserialize)]
        struct Config {
            app: App,
        }
        #[derive(serde::Deserialize)]
        struct App {
            security: Security,
        }
        #[derive(serde::Deserialize)]
        struct Security {
            csp: String,
        }
        let config: Config = serde_json::from_str(include_str!("../tauri.conf.json"))?;
        let policy = config.app.security.csp.as_str();
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert("content-security-policy", policy.parse()?);
        headers.insert("x-content-type-options", "nosniff".parse()?);
        super::adjust_preview_csp("/preview/index.html", &mut headers);
        let actual = headers["content-security-policy"].to_str()?;
        let before: Vec<_> = policy.split(';').map(str::trim).collect();
        let after: Vec<_> = actual.split(';').map(str::trim).collect();
        assert_eq!(before.len(), after.len());
        for (original, modified) in before.iter().zip(after.iter()) {
            match *original {
                "frame-ancestors 'none'" => assert_eq!(*modified, "frame-ancestors 'self'"),
                "style-src 'self'" => {
                    assert_eq!(*modified, "style-src 'self' tauri://localhost");
                }
                _ => assert_eq!(original, modified),
            }
        }
        assert!(actual.contains("frame-ancestors 'self'"));
        assert!(actual.contains("style-src 'self' tauri://localhost"));
        assert_eq!(headers["x-content-type-options"], "nosniff");
        Ok(())
    }

    #[test]
    fn preview_csp_preserves_other_paths_and_unreadable_or_missing_headers()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert(
            "content-security-policy",
            "frame-ancestors 'none'; style-src 'self'".parse()?,
        );
        let original = headers.clone();
        for path in ["/", "/index.html", "/preview", "/preview-other/index.html"] {
            super::adjust_preview_csp(path, &mut headers);
            assert_eq!(headers, original);
        }
        headers.clear();
        super::adjust_preview_csp("/preview/index.html", &mut headers);
        assert!(headers.is_empty());
        headers.insert(
            "content-security-policy",
            tauri::http::HeaderValue::from_bytes(b"\xff")?,
        );
        let original = headers.clone();
        super::adjust_preview_csp("/preview/index.html", &mut headers);
        assert_eq!(headers, original);
        Ok(())
    }

    #[test]
    fn gallery_policy_allows_only_bundled_assets_and_removes_ipc()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert("content-security-policy", "default-src 'self'; script-src 'self' 'sha256-test'; connect-src ipc: http://ipc.localhost".parse()?);
        super::adjust_preview_csp("/preview/gallery/black-catalog/index.html", &mut headers);
        let policy = headers["content-security-policy"].to_str()?;
        assert!(!policy.contains("ipc:"));
        assert!(!policy.contains("ipc.localhost"));
        assert!(policy.contains("connect-src tauri://localhost;"));
        assert!(policy.contains("'sha256-test'"));
        assert!(policy.contains("font-src 'self' tauri://localhost;"));
        assert_eq!(headers["access-control-allow-origin"], "*");
        Ok(())
    }

    #[test]
    fn gallery_effective_csp_meets_f7_contract() -> Result<(), Box<dyn std::error::Error>> {
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert(
            "content-security-policy",
            "default-src 'self'; script-src 'self' 'sha256-test123'; connect-src ipc: http://ipc.localhost".parse()?
        );
        super::adjust_preview_csp(
            "/preview/gallery/flexoki-catalog/catalog/index.html",
            &mut headers,
        );
        let policy = headers["content-security-policy"].to_str()?;
        assert!(!policy.contains("ipc:"));
        assert!(!policy.contains("ipc.localhost"));
        assert!(policy.contains("default-src 'none';"));
        assert!(policy.contains("connect-src tauri://localhost;"));
        assert!(policy.contains("'sha256-test123'"));
        assert!(policy.contains("tauri://localhost 'wasm-unsafe-eval'"));
        assert!(policy.contains("style-src 'self' tauri://localhost 'unsafe-inline';"));
        assert!(policy.contains("font-src 'self' tauri://localhost;"));
        assert!(policy.contains("img-src 'self' tauri://localhost data:;"));
        assert!(policy.contains("frame-src 'none';"));
        assert!(policy.contains("object-src 'none';"));
        assert!(policy.contains("base-uri 'none';"));
        assert!(policy.contains("frame-ancestors 'self';"));
        assert!(policy.contains("form-action 'none'"));
        assert_eq!(headers["access-control-allow-origin"], "*");
        Ok(())
    }

    #[test]
    fn command_inventory_is_exact() {
        assert_eq!(
            command_inventory::STUDIO_COMMAND_NAMES,
            [
                "studio_brand_read",
                "studio_brand_plan_start",
                "studio_brand_plan_cancel",
                "studio_host_start",
                "studio_host_status",
                "studio_select_project",
                "studio_select_source",
                "studio_host_shutdown",
                "studio_design_packet_import",
                "studio_design_packet_export",
                "studio_theme_lab_status",
                "studio_theme_lab_compile",
                "studio_theme_lab_example",
                "studio_theme_lab_open",
                "studio_theme_lab_save",
                "studio_theme_lab_dispose",
                "studio_theme_lab_draft_update",
                "studio_theme_brief_create",
                "studio_theme_packet_import",
                "studio_theme_packet_export",
                "studio_theme_review_create",
                "studio_theme_candidate_adopt",
                "studio_theme_candidate_verify",
                "studio_theme_review_validate",
                "studio_scene_new",
                "studio_scene_status",
                "studio_scene_dispose",
                "studio_scene_open",
                "studio_scene_import_svg",
                "studio_scene_edit",
                "studio_scene_compile",
                "studio_scene_save_plan",
                "studio_scene_save_apply",
                "studio_scene_export_plan",
                "studio_scene_export_apply",
                "studio_scene_bind_tokens",
                "studio_scene_brief_create",
                "studio_scene_packet_import",
                "studio_scene_packet_export",
                "studio_scene_review_create",
                "studio_scene_candidate_verify",
                "studio_scene_candidate_adopt",
            ]
        );
    }
}
