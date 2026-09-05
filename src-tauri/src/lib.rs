#![forbid(unsafe_code)]

mod commands;
mod design_evidence;
mod errors;
mod sidecar;
mod state;

#[cfg(test)]
mod command_inventory;

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
            commands::design_packet::studio_design_packet_export
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
            let state = handle.state::<state::host::HostState>();
            let _ = state.shutdown_host();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::command_inventory;

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
                "studio_design_packet_export"
            ]
        );
    }
}
