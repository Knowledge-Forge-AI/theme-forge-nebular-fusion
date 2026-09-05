use tauri::State;

use crate::errors::StudioResult;
use crate::sidecar::brand_protocol::{StudioBrandReadRequest, StudioBrandReadResponse};
use crate::state::host::HostState;

#[tauri::command(async)]
pub(crate) fn studio_brand_read(
    request: StudioBrandReadRequest,
    state: State<'_, HostState>,
) -> StudioResult<StudioBrandReadResponse> {
    state.lock()?.brand_read(request)
}
