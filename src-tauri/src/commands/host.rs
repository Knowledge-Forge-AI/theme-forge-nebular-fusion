use tauri::State;
use tauri::ipc::Channel;

use crate::errors::StudioResult;
use crate::sidecar::protocol::{StudioHostStateEvent, StudioHostStatus};
use crate::state::host::HostState;

#[tauri::command(async)]
pub(crate) fn studio_host_start(
    events: Channel<StudioHostStateEvent>,
    state: State<'_, HostState>,
) -> StudioResult<StudioHostStatus> {
    state.start_host(events)
}

#[tauri::command(async)]
pub(crate) fn studio_host_status(state: State<'_, HostState>) -> StudioResult<StudioHostStatus> {
    state.status()
}

#[tauri::command(async)]
pub(crate) fn studio_host_shutdown(state: State<'_, HostState>) -> StudioResult<()> {
    state.shutdown_host()
}
