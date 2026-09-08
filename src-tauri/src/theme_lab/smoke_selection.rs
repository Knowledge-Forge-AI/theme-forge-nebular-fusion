//! Finite file selections owned by the native-smoke launcher, absent in normal builds.
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
static ROOT: OnceLock<PathBuf> = OnceLock::new();
static IMPORT: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn initialize() -> StudioResult<()> {
    let Ok(input) = std::env::var("TFSB_NATIVE_EXCHANGE_DIR") else {
        return Ok(());
    };
    let path = PathBuf::from(input);
    let reject = || StudioCommandError::new(StudioReasonCode::SelectionRejected);
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| reject())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("tfsl-native-exchange-"))
    {
        return Err(reject());
    }
    let canonical = std::fs::canonicalize(&path).map_err(|_| reject())?;
    let temporary = std::fs::canonicalize(std::env::temp_dir()).map_err(|_| reject())?;
    if canonical.parent() != Some(temporary.as_path()) {
        return Err(reject());
    }
    ROOT.set(canonical).map_err(|_| reject())
}

pub(crate) fn select(operation: &str) -> Option<StudioResult<Option<PathBuf>>> {
    let root = ROOT.get()?;
    let name = match operation {
        "import" => match IMPORT.fetch_add(1, Ordering::SeqCst) {
            0 => "candidate-a.json",
            1 => "candidate-b.json",
            2 => "review.json",
            _ => {
                return Some(Err(StudioCommandError::new(
                    StudioReasonCode::SelectionRejected,
                )));
            }
        },
        "brief" => "brief.json",
        "review" => "review.json",
        "save" => "adopted.theme.json",
        "open" => "baseline.theme.json",
        _ => {
            return Some(Err(StudioCommandError::new(
                StudioReasonCode::SelectionRejected,
            )));
        }
    };
    Some(Ok(Some(root.join(name))))
}

/// Closed, path-free data for the two-candidate instrumented workflow.
#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExchangeScenario {
    brief_id: String,
    title: String,
    goal: String,
    allowed_fields: String,
    acceptance: String,
    prohibited: String,
    candidate_ids: [String; 2],
    accents: [String; 2],
    link_colors: [String; 2],
    preferred_index: usize,
}

pub(crate) fn scenario_script() -> StudioResult<String> {
    let Some(root) = ROOT.get() else {
        return Ok(String::new());
    };
    let path = root.join("scenario.json");
    if !path.exists() {
        return Ok(String::new());
    }
    let reject = || StudioCommandError::new(StudioReasonCode::SelectionRejected);
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| reject())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16_384 {
        return Err(reject());
    }
    let text = std::fs::read_to_string(path).map_err(|_| reject())?;
    scenario_from_text(&text)
}

fn scenario_from_text(text: &str) -> StudioResult<String> {
    let reject = || StudioCommandError::new(StudioReasonCode::SelectionRejected);
    if text.len() > 16_384 {
        return Err(reject());
    }
    let scenario: ExchangeScenario = serde_json::from_str(text).map_err(|_| reject())?;
    if scenario.preferred_index > 1 || scenario.allowed_fields.len() > 8192 {
        return Err(reject());
    }
    let json = serde_json::to_string(&scenario).map_err(|_| reject())?;
    Ok(format!("window.__TFSB_EXCHANGE_SCENARIO__ = {json};"))
}

pub(crate) fn alternatives_ready() -> bool {
    ROOT.get()
        .is_some_and(|root| root.join("alternatives.ready").is_file())
}

#[cfg(test)]
mod tests {
    use super::scenario_from_text;

    const SCENARIO: &str = r##"{"briefId":"nova","title":"Nova","goal":"Read","allowedFields":"typography.bodyFont","acceptance":"Readable","prohibited":"No scripts","candidateIds":["forge-console","nova-observatory"],"accents":["#ff8a3d","#bb9bff"],"linkColors":["#ffac75","#cbb4ff"],"preferredIndex":0}"##;

    #[test]
    fn scenario_rejects_path_authority_and_invalid_selection() {
        assert!(
            scenario_from_text(&SCENARIO.replace("\"preferredIndex\":0", "\"preferredIndex\":2"))
                .is_err()
        );
        assert!(
            scenario_from_text(&SCENARIO.replace(
                "\"goal\":\"Read\"",
                "\"goal\":\"Read\",\"path\":\"/untrusted\""
            ))
            .is_err()
        );
        assert!(scenario_from_text(&" ".repeat(16_385)).is_err());
    }

    #[test]
    fn scenario_transports_data_as_json_not_script_source() -> Result<(), Box<dyn std::error::Error>>
    {
        let output = scenario_from_text(SCENARIO)?;
        let payload = output
            .strip_prefix("window.__TFSB_EXCHANGE_SCENARIO__ = ")
            .ok_or("missing assignment")?
            .strip_suffix(';')
            .ok_or("missing terminator")?;
        let parsed: super::ExchangeScenario = serde_json::from_str(payload)?;
        assert_eq!(parsed.candidate_ids, ["forge-console", "nova-observatory"]);
        assert_eq!(parsed.preferred_index, 0);
        Ok(())
    }
}
