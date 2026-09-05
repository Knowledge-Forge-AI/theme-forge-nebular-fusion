use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::design_evidence::{
    DesignEvidencePacket, ExpectedPacketKind, PacketKind, export_packet, import_packet,
    validate_packet,
};
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesignPacketImportResult {
    cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    packet: Option<DesignEvidencePacket>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<PacketKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    byte_count: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesignPacketExportResult {
    cancelled: bool,
    kind: PacketKind,
    digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    byte_count: Option<usize>,
}

fn extension(kind: PacketKind) -> &'static str {
    match kind {
        PacketKind::Brief => "tfsb-brief.json",
        PacketKind::Candidate => "tfsb-candidate.json",
        PacketKind::Review => "tfsb-review.json",
    }
}

fn suggested_name(packet: &DesignEvidencePacket) -> String {
    let public: String = packet
        .public_id()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .take(128)
        .collect();
    format!("{public}.{}", extension(packet.kind()))
}

fn import_selected_path(
    selected: Option<PathBuf>,
    expected_kind: ExpectedPacketKind,
) -> StudioResult<DesignPacketImportResult> {
    let Some(path) = selected else {
        return Ok(DesignPacketImportResult {
            cancelled: true,
            packet: None,
            kind: None,
            digest: None,
            byte_count: None,
        });
    };
    let imported = import_packet(&path, expected_kind)?;
    let packet = imported.packet;
    Ok(DesignPacketImportResult {
        cancelled: false,
        kind: Some(packet.kind()),
        digest: Some(packet.digest().to_owned()),
        byte_count: Some(imported.byte_count),
        packet: Some(packet),
    })
}

#[tauri::command(async)]
pub(crate) fn studio_design_packet_import(
    expected_kind: ExpectedPacketKind,
    app: AppHandle,
) -> StudioResult<DesignPacketImportResult> {
    let selected = app
        .dialog()
        .file()
        .set_title("Import TFSB design evidence")
        .add_filter(
            "TFSB design evidence",
            &["tfsb-brief.json", "tfsb-candidate.json", "tfsb-review.json"],
        )
        .blocking_pick_file();
    let selected = selected
        .map(|selected| {
            selected
                .into_path()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        })
        .transpose()?;
    import_selected_path(selected, expected_kind)
}

#[tauri::command(async)]
pub(crate) fn studio_design_packet_export(
    packet: DesignEvidencePacket,
    app: AppHandle,
) -> StudioResult<DesignPacketExportResult> {
    validate_packet(&packet)?;
    let kind = packet.kind();
    let digest = packet.digest().to_owned();
    let selected = app
        .dialog()
        .file()
        .set_title("Export TFSB design evidence")
        .set_file_name(suggested_name(&packet))
        .add_filter("TFSB design evidence", &[extension(kind)])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(DesignPacketExportResult {
            cancelled: true,
            kind,
            digest,
            byte_count: None,
        });
    };
    let path = selected
        .into_path()
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if !path.to_string_lossy().ends_with(extension(kind)) {
        return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
    }
    let byte_count = export_packet(&path, &packet)?;
    Ok(DesignPacketExportResult {
        cancelled: false,
        kind,
        digest,
        byte_count: Some(byte_count),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn fixture_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tfsb-design-packet-command-{}-{name}",
            std::process::id()
        ))
    }

    #[test]
    fn fixed_extensions_and_public_names_are_kind_bound() {
        let parsed: Result<DesignEvidencePacket, _> = serde_json::from_slice(include_bytes!(
            "../../../protocol/tfsb-design-evidence-v1/examples/review.json"
        ));
        assert!(parsed.is_ok());
        if let Ok(packet) = parsed {
            assert!(suggested_name(&packet).ends_with(".tfsb-review.json"));
            assert!(!suggested_name(&packet).contains('/'));
        }
    }

    #[test]
    fn selected_path_imports_bounded_brief_fixture_without_returning_path() {
        let directory = fixture_path("success");
        let _ = fs::remove_dir_all(&directory);
        assert!(fs::create_dir(&directory).is_ok());
        let path = directory.join("brief.tfsb-brief.json");
        let bytes = include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/brief.json");
        assert!(fs::write(&path, bytes).is_ok());

        let result = import_selected_path(Some(path), ExpectedPacketKind::Brief);
        assert!(result.is_ok());
        if let Ok(result) = result {
            assert!(!result.cancelled);
            assert_eq!(result.kind, Some(PacketKind::Brief));
            assert_eq!(
                result.digest.as_deref(),
                Some("sha256:9ffa909b428e21dd78db8730780cebaa006707828c47e888a715cb5249d16af4")
            );
            assert_eq!(result.byte_count, Some(bytes.len()));
            assert!(matches!(
                result.packet.as_ref(),
                Some(DesignEvidencePacket::Brief(_))
            ));
            if let Ok(serialized) = serde_json::to_string(&result) {
                assert!(!serialized.contains(directory.to_string_lossy().as_ref()));
            }
        }
        assert!(fs::remove_dir_all(directory).is_ok());
    }

    #[test]
    fn selected_path_import_rejects_invalid_and_wrong_kind_fixtures() {
        let directory = fixture_path("rejection");
        let _ = fs::remove_dir_all(&directory);
        assert!(fs::create_dir(&directory).is_ok());

        let wrong_kind_path = directory.join("candidate.tfsb-candidate.json");
        assert!(
            fs::write(
                &wrong_kind_path,
                include_bytes!(
                    "../../../protocol/tfsb-design-evidence-v1/examples/candidate-a.json"
                )
            )
            .is_ok()
        );
        let wrong_kind = import_selected_path(Some(wrong_kind_path), ExpectedPacketKind::Brief);
        assert!(matches!(
            wrong_kind,
            Err(error) if error.reason_code() == StudioReasonCode::ProtocolInvalid
        ));

        let invalid_path = directory.join("invalid.tfsb-brief.json");
        let mut invalid_bytes =
            include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/brief.json")
                .to_vec();
        invalid_bytes[0] = b'[';
        assert!(fs::write(&invalid_path, invalid_bytes).is_ok());
        let invalid = import_selected_path(Some(invalid_path), ExpectedPacketKind::Brief);
        assert!(matches!(
            invalid,
            Err(error) if error.reason_code() == StudioReasonCode::ProtocolInvalid
        ));

        assert!(fs::remove_dir_all(directory).is_ok());
    }

    #[test]
    fn cancelled_dialog_returns_empty_typed_result_without_path() {
        let result = import_selected_path(None, ExpectedPacketKind::Brief);
        assert!(result.is_ok());
        if let Ok(result) = result {
            assert!(result.cancelled);
            assert!(result.packet.is_none());
            assert!(result.kind.is_none());
            assert!(result.digest.is_none());
            assert!(result.byte_count.is_none());
            if let Ok(serialized) = serde_json::to_string(&result) {
                assert!(!serialized.contains("path"));
            }
        }
    }
}
