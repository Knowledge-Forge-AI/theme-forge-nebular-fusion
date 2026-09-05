use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::sidecar::protocol::{PublicProjectResult, PublicSourceResult};
use crate::state::host::HostState;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProjectOpenMode {
    Existing,
    ImportTarget,
}

impl ProjectOpenMode {
    fn protocol(self) -> &'static str {
        match self {
            Self::Existing => "existing",
            Self::ImportTarget => "import-target",
        }
    }

    fn picker(self) -> PickerRequest {
        PickerRequest {
            directory: true,
            extensions: &[],
            title: "Choose a TFSB project",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SourceSelectKind {
    ContentDirectory,
    ContentArchive,
    SourceMap,
    NormalizationMap,
    ShardManifest,
    BrandBundle,
    NpmInstalledPackage,
}

impl SourceSelectKind {
    fn purpose(self) -> &'static str {
        match self {
            Self::ContentDirectory | Self::ContentArchive => "content",
            Self::SourceMap => "source-map",
            Self::NormalizationMap => "normalization-map",
            Self::ShardManifest => "shard-manifest",
            Self::BrandBundle => "brand-bundle",
            Self::NpmInstalledPackage => "npm-installed-package",
        }
    }

    fn directory(self) -> bool {
        matches!(self, Self::ContentDirectory | Self::NpmInstalledPackage)
    }

    fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::ContentArchive => &["zip"],
            Self::SourceMap | Self::NormalizationMap | Self::ShardManifest => &["toml"],
            Self::BrandBundle => &["zip"],
            Self::ContentDirectory | Self::NpmInstalledPackage => &[],
        }
    }

    fn picker(self) -> PickerRequest {
        PickerRequest {
            directory: self.directory(),
            extensions: self.extensions(),
            title: "Choose a TFSB source",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PickerRequest {
    directory: bool,
    extensions: &'static [&'static str],
    title: &'static str,
}

trait NativePicker {
    fn pick(&self, request: PickerRequest) -> StudioResult<Option<PathBuf>>;
}

struct TauriNativePicker<'a> {
    app: &'a AppHandle,
}

impl NativePicker for TauriNativePicker<'_> {
    fn pick(&self, request: PickerRequest) -> StudioResult<Option<PathBuf>> {
        let mut picker = self.app.dialog().file().set_title(request.title);
        if !request.extensions.is_empty() {
            picker = picker.add_filter("Supported source", request.extensions);
        }
        let selected = if request.directory {
            picker.blocking_pick_folder()
        } else {
            picker.blocking_pick_file()
        };
        selected
            .map(|value| {
                value
                    .into_path()
                    .map_err(|_| StudioCommandError::new(StudioReasonCode::DialogUnavailable))
            })
            .transpose()
    }
}

fn selected_text(
    picker: &impl NativePicker,
    request: PickerRequest,
) -> StudioResult<Option<String>> {
    picker.pick(request)?.map_or(Ok(None), |path| {
        path.into_os_string()
            .into_string()
            .map(Some)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
    })
}

fn select_and_open<T>(
    picker: &impl NativePicker,
    request: PickerRequest,
    open: impl FnOnce(&str) -> StudioResult<T>,
) -> StudioResult<Option<T>> {
    selected_text(picker, request)?
        .map(|path| open(&path))
        .transpose()
}

#[tauri::command(async)]
pub(crate) fn studio_select_project(
    mode: ProjectOpenMode,
    app: AppHandle,
    state: State<'_, HostState>,
) -> StudioResult<PublicProjectResult> {
    let picker = TauriNativePicker { app: &app };
    let selected = select_and_open(&picker, mode.picker(), |text| {
        let _identity_change = state.begin_identity_change()?;
        state.lock()?.open_project(text, mode.protocol())
    })?;
    let Some(project) = selected else {
        return Ok(PublicProjectResult {
            cancelled: true,
            project: None,
        });
    };
    Ok(PublicProjectResult {
        cancelled: false,
        project: Some(project),
    })
}

#[tauri::command(async)]
pub(crate) fn studio_select_source(
    kind: SourceSelectKind,
    app: AppHandle,
    state: State<'_, HostState>,
) -> StudioResult<PublicSourceResult> {
    let picker = TauriNativePicker { app: &app };
    let selected = select_and_open(&picker, kind.picker(), |text| {
        let _identity_change = state.begin_identity_change()?;
        state.lock()?.open_source(text, kind.purpose())
    })?;
    let Some(source) = selected else {
        return Ok(PublicSourceResult {
            cancelled: true,
            source: None,
        });
    };
    Ok(PublicSourceResult {
        cancelled: false,
        source: Some(source),
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        NativePicker, PickerRequest, ProjectOpenMode, SourceSelectKind, select_and_open,
        selected_text,
    };
    use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

    enum FakeResponse {
        Cancel,
        Path(&'static str),
        Unavailable,
    }

    struct FakePicker(FakeResponse);

    impl NativePicker for FakePicker {
        fn pick(&self, _request: PickerRequest) -> StudioResult<Option<PathBuf>> {
            match self.0 {
                FakeResponse::Cancel => Ok(None),
                FakeResponse::Path(value) => Ok(Some(PathBuf::from(value))),
                FakeResponse::Unavailable => {
                    Err(StudioCommandError::new(StudioReasonCode::DialogUnavailable))
                }
            }
        }
    }

    #[test]
    fn project_modes_map_exactly() {
        assert_eq!(ProjectOpenMode::Existing.protocol(), "existing");
        assert_eq!(ProjectOpenMode::ImportTarget.protocol(), "import-target");
    }

    #[test]
    fn source_kinds_map_to_closed_picker_and_protocol_contracts() {
        let cases = [
            (SourceSelectKind::ContentDirectory, "content", true, &[][..]),
            (
                SourceSelectKind::ContentArchive,
                "content",
                false,
                &["zip"][..],
            ),
            (
                SourceSelectKind::SourceMap,
                "source-map",
                false,
                &["toml"][..],
            ),
            (
                SourceSelectKind::NormalizationMap,
                "normalization-map",
                false,
                &["toml"][..],
            ),
            (
                SourceSelectKind::ShardManifest,
                "shard-manifest",
                false,
                &["toml"][..],
            ),
            (
                SourceSelectKind::BrandBundle,
                "brand-bundle",
                false,
                &["zip"][..],
            ),
            (
                SourceSelectKind::NpmInstalledPackage,
                "npm-installed-package",
                true,
                &[][..],
            ),
        ];
        for (kind, purpose, directory, extensions) in cases {
            assert_eq!(kind.purpose(), purpose);
            assert_eq!(kind.directory(), directory);
            assert_eq!(kind.extensions(), extensions);
            assert_eq!(kind.picker().directory, directory);
            assert_eq!(kind.picker().extensions, extensions);
        }
    }

    #[test]
    fn injected_picker_distinguishes_cancel_unavailable_and_protocol_rejection() {
        let request = ProjectOpenMode::Existing.picker();
        assert!(matches!(
            selected_text(&FakePicker(FakeResponse::Cancel), request),
            Ok(None)
        ));
        assert!(selected_text(&FakePicker(FakeResponse::Unavailable), request).is_err());
        let private = "/private/selected/project";
        let rejected: StudioResult<Option<()>> =
            select_and_open(&FakePicker(FakeResponse::Path(private)), request, |_| {
                Err(StudioCommandError::new(StudioReasonCode::SelectionRejected))
            });
        let serialized = rejected
            .err()
            .and_then(|error| serde_json::to_string(&error).ok())
            .unwrap_or_default();
        assert!(!serialized.is_empty());
        assert!(!serialized.contains(private));
    }
}
