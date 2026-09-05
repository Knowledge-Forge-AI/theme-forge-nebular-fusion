use std::env;
use std::io::{self, BufRead, Write};
use std::thread;
use std::time::Duration;

use serde_json::json;

fn request_id(line: &str) -> Option<u64> {
    let marker = "\"id\":";
    let start = line.find(marker)? + marker.len();
    let digits: String = line[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

fn success(id: u64) -> String {
    format!("{{\"id\":{id},\"jsonrpc\":\"2.0\",\"result\":{{\"ok\":true}}}}\n")
}

fn derive_plan_ready(id: u64) -> String {
    let digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let response = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "planToken": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "planDigest": digest,
            "expiresInMs": 600000,
            "method": "brand.derive.plan",
            "summary": {
                "selectedRecipes": ["recipe-one"],
                "transitiveRecipes": [],
                "affectedTargets": [],
                "createdCount": 0,
                "updatedCount": 0,
                "unchangedCount": 0,
                "operationSummaries": [],
                "targetStates": [],
                "tokenDigest": digest,
                "recipeDigest": digest,
                "brandSystemDigest": digest,
                "warnings": [],
                "dryRun": true
            }
        }
    });
    format!("{response}\n")
}

fn initialize_response(id: u64, mode: &str) -> String {
    let methods = json!({
        "assetDiff": true, "assetGet": true, "assetList": true, "assetValidate": true,
        "cancellation": true, "mutationPlans": true, "planApply": true,
        "previewStatus": true, "progress": true, "projectList": true,
        "projectOpen": true, "sourceAnalyze": true, "sourceOpen": true,
        "workspaceOpen": true, "workspaceStatus": true
    });
    let brand_methods = json!({
        "consumerLockStatus": true, "consumerProfileList": true, "diff": true,
        "exportCapability": true, "exportStatus": true, "familyList": true,
        "qaProfileGet": true, "qaProfileList": true, "qaResultGet": true, "recipeGraph": true,
        "status": true, "tokenList": true, "visualEvidenceGet": false, "derivePlan": true,
        "qaBaselinePlan": false, "consumerInstallPlan": true,
        "consumerSyncPlan": true, "exportPlan": false
    });
    let mut response = json!({
        "jsonrpc": "2.0", "id": id,
        "result": {
            "protocol": "tfsb.studio", "selectedVersion": "1.2",
            "server": { "name": "tfsb-studio-service", "version": "0.1.0" },
            "sessionNonce": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "capabilities": {
                "methods": methods,
                "limits": {
                    "assetPageSizeDefault": 64, "assetPageSizeMax": 128, "assetPageSizeMin": 1,
                    "maxActivePlans": 4, "maxConcurrentApplies": 1, "maxConcurrentReads": 4,
                    "maxFrameBytes": 16777216, "maxQueuedReads": 4,
                    "maxRetainedNativeSnapshotPlans": 1, "maxRetainedPlanBytes": 201326592,
                    "planTtlMs": 600000, "sourceDetailPageSizeDefault": 64,
                    "sourceDetailPageSizeMax": 128, "sourceDetailPageSizeMin": 1
                },
                "brand": {
                    "schemaVersion": 1, "methods": brand_methods,
                    "sourcePurposes": { "brandBundle": true, "npmInstalledPackage": true },
                    "raster": { "available": false },
                    "visualEvidence": { "available": false },
                    "limits": {
                        "maxDiffResultBytes": 16777216, "maxExportOutputs": 128,
                        "maxQaResultBytes": 16777216, "maxSelectedProfiles": 8,
                        "maxSourcePackages": 8, "pageSizeDefault": 64,
                        "pageSizeMax": 128, "pageSizeMin": 1
                    }
                }
            }
        }
    });
    match mode {
        "lifecycle-wrong-version" => response["result"]["selectedVersion"] = json!("1.0"),
        "lifecycle-wrong-server" => response["result"]["server"]["version"] = json!("0.2.0"),
        "lifecycle-wrong-capability" => {
            response["result"]["capabilities"]["methods"]["privatePathRead"] = json!(true);
        }
        _ => {}
    }
    format!("{response}\n")
}

fn main() -> io::Result<()> {
    let mode = env::var("TFSB_FAKE_MODE").unwrap_or_else(|_| "success".to_owned());
    if mode == "exit-immediate" {
        return Ok(());
    }
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr().lock();
    let Some(first) = lines.next().transpose()? else {
        return Ok(());
    };
    let Some(first_id) = request_id(&first) else {
        return Ok(());
    };
    if first.contains("\"method\":\"initialize\"") && mode.starts_with("lifecycle-") {
        match mode.as_str() {
            "lifecycle-crash-before-initialize" => return Ok(()),
            "lifecycle-startup-timeout" => {
                thread::sleep(Duration::from_secs(5));
                return Ok(());
            }
            "lifecycle-malformed-initialize" => stdout.write_all(b"{\"id\":\n")?,
            _ => stdout.write_all(initialize_response(first_id, &mode).as_bytes())?,
        }
        stdout.flush()?;
        if matches!(
            mode.as_str(),
            "lifecycle-malformed-initialize"
                | "lifecycle-wrong-version"
                | "lifecycle-wrong-server"
                | "lifecycle-wrong-capability"
        ) {
            thread::sleep(Duration::from_secs(5));
            return Ok(());
        }
        let _initialized = lines.next().transpose()?;
        match mode.as_str() {
            "lifecycle-idle-crash" => return Ok(()),
            "lifecycle-idle-flood" => {
                for completed in 0..128 {
                    stdout.write_all(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"$/progress\",\"params\":{{\"completed\":{completed},\"requestId\":{first_id},\"stage\":\"scanning\",\"total\":128}}}}\n").as_bytes())?;
                }
                stdout.flush()?;
                thread::sleep(Duration::from_secs(5));
                return Ok(());
            }
            _ => {}
        }
        while let Some(line) = lines.next().transpose()? {
            let Some(id) = request_id(&line) else {
                if line.contains("\"method\":\"exit\"") {
                    return Ok(());
                }
                continue;
            };
            if line.contains("\"method\":\"shutdown\"") {
                match mode.as_str() {
                    "lifecycle-shutdown-error" => stdout.write_all(format!("{{\"error\":{{\"code\":-32060,\"data\":{{\"code\":\"DOMAIN_OPERATION_FAILED\",\"message\":\"failed\",\"retryable\":false}},\"message\":\"failed\"}},\"id\":{id},\"jsonrpc\":\"2.0\"}}\n").as_bytes())?,
                    "lifecycle-shutdown-hang" => {
                        thread::sleep(Duration::from_secs(5));
                        return Ok(());
                    }
                    _ => {
                        stdout.write_all(format!("{{\"id\":{id},\"jsonrpc\":\"2.0\",\"result\":null}}\n").as_bytes())?;
                        if mode == "lifecycle-terminal-data" {
                            stdout.write_all(success(id + 1).as_bytes())?;
                        }
                    }
                }
                stdout.flush()?;
            } else if line.contains("\"method\":\"brand.derive.plan\"")
                && mode.starts_with("lifecycle-plan-progress-")
            {
                let progress = match mode.as_str() {
                    "lifecycle-plan-progress-unknown" => vec![("unknown", 1, 2)],
                    "lifecycle-plan-progress-repeated-stage" => {
                        vec![("validate", 0, 2), ("validate", 0, 2)]
                    }
                    "lifecycle-plan-progress-regressing-stage" => {
                        vec![("snapshot", 1, 2), ("validate", 2, 2)]
                    }
                    "lifecycle-plan-progress-repeated-completed" => {
                        vec![("validate", 0, 2), ("validate", 0, 2)]
                    }
                    "lifecycle-plan-progress-changed-total" => {
                        vec![("validate", 0, 2), ("validate", 1, 3)]
                    }
                    _ => Vec::new(),
                };
                for (stage, completed, total) in progress {
                    stdout.write_all(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"$/progress\",\"params\":{{\"completed\":{completed},\"requestId\":{id},\"stage\":\"{stage}\",\"total\":{total}}}}}\n").as_bytes())?;
                }
                stdout.write_all(derive_plan_ready(id).as_bytes())?;
                stdout.flush()?;
            } else if line.contains("\"method\":\"brand.derive.plan\"")
                && matches!(
                    mode.as_str(),
                    "lifecycle-plan-timeout-ready" | "lifecycle-plan-never"
                )
            {
                if mode == "lifecycle-plan-timeout-ready" {
                    thread::sleep(Duration::from_millis(120));
                    let _ = stdout.write_all(derive_plan_ready(id).as_bytes());
                    let _ = stdout.flush();
                } else {
                    thread::sleep(Duration::from_secs(5));
                }
                return Ok(());
            } else if line.contains("\"method\":\"brand.derive.plan\"")
                && mode == "lifecycle-plan-cancel-ready"
            {
                let _cancel = lines.next().transpose()?;
                stdout.write_all(derive_plan_ready(id).as_bytes())?;
                stdout.flush()?;
            } else if line.contains("\"method\":\"plan.discard\"") {
                stdout.write_all(
                    format!(
                        "{{\"id\":{id},\"jsonrpc\":\"2.0\",\"result\":{{\"discarded\":true}}}}\n"
                    )
                    .as_bytes(),
                )?;
                stdout.flush()?;
            } else if mode == "lifecycle-request-timeout" {
                thread::sleep(Duration::from_secs(5));
                return Ok(());
            } else {
                stdout.write_all(success(id).as_bytes())?;
                stdout.flush()?;
            }
        }
        return Ok(());
    }
    match mode.as_str() {
        "crash" | "eof" => return Ok(()),
        "hang" => {
            thread::sleep(Duration::from_secs(5));
            return Ok(());
        }
        "malformed" => stdout.write_all(b"{\"id\":\n")?,
        "unknown-id" => stdout.write_all(success(first_id + 1).as_bytes())?,
        "conflict" => stdout.write_all(format!("{{\"error\":{{\"code\":-32030,\"data\":{{\"code\":\"REQUEST_BUSY\",\"message\":\"busy\",\"retryable\":true}},\"message\":\"busy\"}},\"id\":{first_id},\"jsonrpc\":\"2.0\",\"result\":{{\"ok\":true}}}}\n").as_bytes())?,
        "malformed-error" => stdout.write_all(format!("{{\"error\":{{\"code\":-32030,\"data\":{{\"code\":\"REQUEST_BUSY\",\"retryable\":true}},\"message\":\"busy\"}},\"id\":{first_id},\"jsonrpc\":\"2.0\"}}\n").as_bytes())?,
        "remote-busy" => stdout.write_all(format!("{{\"error\":{{\"code\":-32030,\"data\":{{\"code\":\"REQUEST_BUSY\",\"message\":\"busy\",\"retryable\":true}},\"message\":\"busy\"}},\"id\":{first_id},\"jsonrpc\":\"2.0\"}}\n").as_bytes())?,
        "progress" => {
            stdout.write_all(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"$/progress\",\"params\":{{\"completed\":1,\"requestId\":{first_id},\"stage\":\"complete\",\"total\":1}}}}\n").as_bytes())?;
            stdout.write_all(success(first_id).as_bytes())?;
        }
        "flood" => {
            for completed in 0..4 {
                stdout.write_all(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"$/progress\",\"params\":{{\"completed\":{completed},\"requestId\":{first_id},\"stage\":\"scanning\",\"total\":4}}}}\n").as_bytes())?;
                stdout.flush()?;
                thread::sleep(Duration::from_millis(2));
            }
            stdout.write_all(success(first_id).as_bytes())?;
        }
        "continuous-progress" => {
            for completed in 0..1_000 {
                stdout.write_all(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"$/progress\",\"params\":{{\"completed\":{completed},\"requestId\":{first_id},\"stage\":\"scanning\",\"total\":1000}}}}\n").as_bytes())?;
                stdout.flush()?;
                thread::sleep(Duration::from_millis(1));
            }
            stdout.write_all(success(first_id).as_bytes())?;
        }
        "saturation" => {
            for completed in 0..128 {
                stdout.write_all(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"$/progress\",\"params\":{{\"completed\":{completed},\"requestId\":{first_id},\"stage\":\"scanning\",\"total\":128}}}}\n").as_bytes())?;
            }
        }
        "idle-flood" => {
            stdout.write_all(success(first_id).as_bytes())?;
            stdout.flush()?;
            thread::sleep(Duration::from_millis(20));
            for completed in 0..128 {
                stdout.write_all(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"$/progress\",\"params\":{{\"completed\":{completed},\"requestId\":{first_id},\"stage\":\"scanning\",\"total\":128}}}}\n").as_bytes())?;
            }
        }
        "bad-progress" => stdout.write_all(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"$/progress\",\"params\":{{\"completed\":2,\"requestId\":{},\"stage\":\"unknown\",\"total\":1}}}}\n", first_id + 1).as_bytes())?,
        "partial" => {
            let response = success(first_id);
            let middle = response.len() / 2;
            stdout.write_all(&response.as_bytes()[..middle])?;
            stdout.flush()?;
            thread::sleep(Duration::from_millis(5));
            stdout.write_all(&response.as_bytes()[middle..])?;
        }
        "duplicate" => {
            stdout.write_all(success(first_id).as_bytes())?;
            stdout.write_all(success(first_id).as_bytes())?;
            stdout.flush()?;
            if lines.next().transpose()?.is_some() {
                thread::sleep(Duration::from_millis(100));
            }
        }
        "late" => {
            thread::sleep(Duration::from_millis(80));
            stdout.write_all(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"$/progress\",\"params\":{{\"completed\":1,\"requestId\":{first_id},\"stage\":\"complete\",\"total\":1}}}}\n").as_bytes())?;
            stdout.write_all(success(first_id).as_bytes())?;
            stdout.flush()?;
            if let Some(second) = lines.next().transpose()?
                && let Some(second_id) = request_id(&second)
            {
                stdout.write_all(success(second_id).as_bytes())?;
            }
        }
        "stderr-flood" => {
            for _ in 0..512 {
                stderr.write_all(&[b'x'; 4096])?;
            }
            stderr.flush()?;
            stdout.write_all(success(first_id).as_bytes())?;
        }
        _ => stdout.write_all(success(first_id).as_bytes())?,
    }
    stdout.flush()?;
    Ok(())
}
