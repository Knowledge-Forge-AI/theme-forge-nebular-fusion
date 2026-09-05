#[path = "src/command_inventory.rs"]
mod command_inventory;

fn main() -> tauri_build::Result<()> {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(command_inventory::STUDIO_COMMAND_NAMES),
    ))
}
