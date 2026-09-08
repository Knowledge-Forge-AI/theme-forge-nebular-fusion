use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const EXPECTED_PRODUCTION_FILES: &[&str] = &[
    "src/command_inventory.rs",
    "src/commands/brand_plan.rs",
    "src/commands/brand_read.rs",
    "src/commands/design_packet.rs",
    "src/commands/host.rs",
    "src/commands/mod.rs",
    "src/commands/selection.rs",
    "src/commands/theme_lab.rs",
    "src/commands/theme_packet.rs",
    "src/errors.rs",
    "src/design_evidence/io.rs",
    "src/design_evidence/mod.rs",
    "src/design_evidence/types.rs",
    "src/design_evidence/validate.rs",
    "src/lib.rs",
    "src/main.rs",
    "src/sidecar/artifact.rs",
    "src/sidecar/brand_protocol.rs",
    "src/sidecar/brand_types/common.rs",
    "src/sidecar/brand_types/consumer_export.rs",
    "src/sidecar/brand_types/diff.rs",
    "src/sidecar/brand_types/family.rs",
    "src/sidecar/brand_types/mod.rs",
    "src/sidecar/brand_types/plan_summaries.rs",
    "src/sidecar/brand_types/qa.rs",
    "src/sidecar/brand_types/raster_plan_descriptor.rs",
    "src/sidecar/brand_types/status.rs",
    "src/sidecar/brand_types/token_recipe.rs",
    "src/sidecar/coordinator.rs",
    "src/sidecar/error_registry.rs",
    "src/sidecar/framing.rs",
    "src/sidecar/mod.rs",
    "src/sidecar/plan_protocol.rs",
    "src/sidecar/plan_transport.rs",
    "src/sidecar/process.rs",
    "src/sidecar/protocol.rs",
    "src/sidecar/supervisor.rs",
    "src/sidecar/supervisor/plan.rs",
    "src/sidecar/supervisor/plan_tests.rs",
    "src/sidecar/supervisor/tests.rs",
    "src/sidecar/visual_evidence.rs",
    "src/sidecar/json_decoder.rs",
    "src/state/host.rs",
    "src/state/mod.rs",
    "src/state/plan_coordinator.rs",
    "src/state/plan_coordinator_tests.rs",
    "src/state/theme_lab.rs",
    "src/theme_lab/mod.rs",
    "src/theme_lab/runner.rs",
    "src/theme_lab/smoke_selection.rs",
    "src/theme_lab/types.rs",
];
const EXCLUDED_DIRECTORIES: &[&str] = &["generated", "target", "tests", "vendor", "vendored"];
const FORBIDDEN_PRODUCTION_TOKENS: &[&str] = &[
    "unsafe ",
    "extern \"C\"",
    "serde_json::Value",
    "Arc<Mutex",
    ".unwrap(",
    ".expect(",
    "panic!(",
    "todo!(",
    "unimplemented!(",
    "unreachable!(",
];
const RAW_JSON_DECODER_ALLOWLIST: &[&str] = &[
    "src/sidecar/brand_protocol.rs",
    "src/sidecar/brand_types/common.rs",
    "src/sidecar/brand_types/diff.rs",
    "src/sidecar/brand_types/mod.rs",
    "src/sidecar/brand_types/plan_summaries.rs",
    "src/sidecar/plan_protocol.rs",
    "src/sidecar/visual_evidence.rs",
    "src/sidecar/json_decoder.rs",
];
const FORBIDDEN_BUILD_TOKENS: &[&str] = &[
    "std::fs",
    "std::process::Command",
    "reqwest",
    "plugin(",
    ".unwrap(",
    ".expect(",
    "panic!(",
];

fn visit_rust_files(directory: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_symlink() {
            return Err(io::Error::other(format!(
                "symlink is not maintained source: {}",
                path.display()
            )));
        }
        if file_type.is_dir() {
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| io::Error::other("non-UTF-8 directory name"))?;
            if !EXCLUDED_DIRECTORIES.contains(&name) {
                visit_rust_files(&path, files)?;
            }
        } else if file_type.is_file() && path.extension().is_some_and(|extension| extension == "rs")
        {
            files.push(path);
        }
    }
    Ok(())
}

fn maintained_rust_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let source_root = root.join("src");
    let mut files = Vec::new();
    visit_rust_files(&source_root, &mut files)?;
    files.sort();
    for expected in EXPECTED_PRODUCTION_FILES {
        let expected_path = root.join(expected);
        if !files.contains(&expected_path) {
            return Err(io::Error::other(format!(
                "missing expected source: {expected}"
            )));
        }
    }
    Ok(files)
}

fn scan_files(files: &[PathBuf], forbidden: &[&str]) -> io::Result<()> {
    for path in files {
        let source = fs::read_to_string(path)?;
        for token in forbidden {
            if source.contains(token) {
                return Err(io::Error::other(format!(
                    "forbidden source token {token} in {}",
                    path.display()
                )));
            }
        }
    }
    Ok(())
}

fn scan_production(root: &Path) -> io::Result<()> {
    let files = maintained_rust_files(root)?;
    for path in files {
        let source = fs::read_to_string(&path)?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| io::Error::other("source path escaped root"))?;
        let test_file = relative
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "tests.rs" || name.ends_with("_tests.rs"));
        let production = if test_file {
            ""
        } else {
            source.split("#[cfg(test)]").next().unwrap_or(&source)
        };
        for token in FORBIDDEN_PRODUCTION_TOKENS {
            if *token == "serde_json::Value"
                && RAW_JSON_DECODER_ALLOWLIST.contains(&relative.to_string_lossy().as_ref())
            {
                continue;
            }
            if production.contains(token) {
                return Err(io::Error::other(format!(
                    "forbidden production token {token} in {}",
                    relative.display()
                )));
            }
        }
        let has_raw_json = production.contains("serde_json::Value")
            || production.contains("serde_json::value::Value")
            || (production.contains("use serde_json") && production.contains("Value as JsonNode"));
        if has_raw_json
            && !RAW_JSON_DECODER_ALLOWLIST.contains(&relative.to_string_lossy().as_ref())
        {
            return Err(io::Error::other(format!(
                "raw JSON outside private decoder allowlist: {}",
                relative.display()
            )));
        }
        if production.contains("Command::new")
            && relative != Path::new("src/sidecar/process.rs")
            && relative != Path::new("src/theme_lab/runner.rs")
        {
            return Err(io::Error::other(
                "process spawn outside sidecar process owner",
            ));
        }
        if production.contains("std::fs")
            && !(relative == Path::new("src/theme_lab/smoke_selection.rs")
                && fs::read_to_string(root.join("src/theme_lab/mod.rs"))?.contains(
                    "#[cfg(feature = \"native-smoke\")]\npub(crate) mod smoke_selection;",
                ))
            && ![
                Path::new("src/commands/design_packet.rs"),
                Path::new("src/commands/theme_packet.rs"),
                Path::new("src/design_evidence/io.rs"),
                Path::new("src/sidecar/artifact.rs"),
                Path::new("src/sidecar/process.rs"),
                Path::new("src/sidecar/supervisor.rs"),
                Path::new("src/sidecar/supervisor/tests.rs"),
                Path::new("src/state/theme_lab.rs"),
            ]
            .contains(&relative)
        {
            return Err(io::Error::other(
                "filesystem authority outside sidecar owners",
            ));
        }
    }
    Ok(())
}

#[test]
fn smoke_selector_requires_explicit_feature_gate() -> io::Result<()> {
    let root = fixture_root("ungated-smoke");
    write_fixture(&root, None, false)?;
    fs::write(
        root.join("src/theme_lab/smoke_selection.rs"),
        "use std::fs;\n",
    )?;
    assert!(scan_production(&root).is_err());
    fs::write(
        root.join("src/theme_lab/mod.rs"),
        "#[cfg(feature = \"native-smoke\")]\npub(crate) mod smoke_selection;\n",
    )?;
    assert!(scan_production(&root).is_ok());
    fs::remove_dir_all(root)?;
    Ok(())
}

fn scan_build_script(root: &Path) -> io::Result<()> {
    let build_script = root.join("build.rs");
    if !build_script.is_file() {
        return Err(io::Error::other("missing expected source: build.rs"));
    }
    scan_files(&[build_script], FORBIDDEN_BUILD_TOKENS)
}

fn fixture_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("tfsb-studio-policy-{}-{name}", std::process::id()))
}

fn write_fixture(root: &Path, omitted: Option<&str>, forbidden_extra: bool) -> io::Result<()> {
    if root.exists() {
        fs::remove_dir_all(root)?;
    }
    for relative in EXPECTED_PRODUCTION_FILES {
        if omitted == Some(*relative) {
            continue;
        }
        let path = root.join(relative);
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("fixture path has no parent"))?;
        fs::create_dir_all(parent)?;
        fs::write(path, "pub(crate) fn bounded() {}\n")?;
    }
    fs::write(root.join("build.rs"), "fn main() {}\n")?;
    if forbidden_extra {
        let path = root.join("src/nested/unreviewed.rs");
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("fixture path has no parent"))?;
        fs::create_dir_all(parent)?;
        fs::write(
            path,
            "pub fn escape() { let _ = std::process::Command::new(\"sh\"); }\n",
        )?;
    }
    Ok(())
}

#[test]
fn production_source_has_no_broad_native_authority() -> io::Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    scan_production(root)?;
    scan_build_script(root)
}

#[test]
fn recursive_scanner_detects_a_synthetic_forbidden_module() -> io::Result<()> {
    let root = fixture_root("forbidden");
    write_fixture(&root, None, true)?;
    let result = scan_production(&root);
    fs::remove_dir_all(&root)?;
    assert!(result.is_err());
    Ok(())
}

#[test]
fn recursive_scanner_detects_a_missing_expected_file() -> io::Result<()> {
    let root = fixture_root("missing");
    write_fixture(&root, Some("src/sidecar/protocol.rs"), false)?;
    let result = scan_production(&root);
    fs::remove_dir_all(&root)?;
    assert!(result.is_err());
    Ok(())
}

#[test]
fn launcher_remains_trivial() -> io::Result<()> {
    let source = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"))?;
    assert_eq!(source.lines().count(), 3);
    assert!(source.contains("tfsb_studio_lib::run();"));
    Ok(())
}
