use super::*;

fn fifo_named_profile(name: &str) -> PairedProfileDto {
    let mut profile = sample_paired_v1();
    profile.name = name.to_owned();
    profile
}

fn fifo_serialize_profile(
    profile: &PairedProfileDto,
) -> Result<(Vec<u8>, String), Box<dyn std::error::Error>> {
    let mut serialized = serde_json::to_string_pretty(profile)?;
    serialized.push('\n');
    let sha = format!("{:x}", Sha256::digest(serialized.as_bytes()));
    Ok((serialized.into_bytes(), sha))
}

#[inline(never)]
fn fifo_initial_compile_phase(
    state: &Arc<AppThemeState>,
    temp: &TempDirGuard,
    gate_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let path_open = temp.path().join("doc-open.json");
    std::fs::write(&path_open, raw_v2_with_loom_content("704"))?;

    let sc = state.clone();
    let h_compile = thread::spawn(move || {
        sc.paired_compile(AppThemePairedCompileRequest {
            profile: sample_paired_v1(),
            ui_revision: Some(10),
            session_id: None,
        })
    });
    wait_for_path(&gate_dir.join("compile-entered-1"))?;
    let (s_open, po) = (state.clone(), path_open);
    let h_open = thread::spawn(move || s_open.open_profile_path(po));
    wait_for_path(&gate_dir.join("bind-entered-1"))?;
    assert!(!gate_dir.join("compile-release-1").exists());
    std::fs::write(gate_dir.join("compile-release-1"), b"1")?;
    std::fs::write(gate_dir.join("bind-release-1"), b"1")?;
    assert!(h_compile.join().map_err(|_| "h_compile")??.valid);
    assert!(!h_open.join().map_err(|_| "h_open")??.cancelled);
    Ok(())
}

#[inline(never)]
fn fifo_race_phase(
    state: &Arc<AppThemeState>,
    temp: &TempDirGuard,
    gate_dir: &Path,
) -> Result<(String, String, String, PathBuf), Box<dyn std::error::Error>> {
    let profile_a = fifo_named_profile("doc-a");
    let (bytes_a, sha_a) = fifo_serialize_profile(&profile_a)?;
    drop(profile_a);
    let sha_b = fifo_serialize_profile(&fifo_named_profile("doc-b"))?.1;
    let sha_c = fifo_serialize_profile(&fifo_named_profile("doc-c"))?.1;

    let ungated_flag = gate_dir.join("ungated");
    let parent_path = temp.path().join("race2-parent.json");
    let parent_bytes = serde_json::to_vec_pretty(&sample_paired_v1())?;
    let parent_raw_sha = format!("{:x}", Sha256::digest(&parent_bytes));
    std::fs::write(&parent_path, &parent_bytes)?;
    std::fs::write(&ungated_flag, b"1")?;
    let parent_doc = state
        .open_profile_path(parent_path.clone())?
        .document
        .ok_or("expected race2 parent doc")?;
    std::fs::remove_file(&ungated_flag)?;

    std::fs::write(gate_dir.join("compile-release-2"), b"1")?;
    let race2_path = temp.path().join("race2.json");
    let doc_id_r2 = parent_doc.document_id;
    let (st_r2, prof_r2, dst_r2) = (
        state.clone(),
        fifo_named_profile("doc-a"),
        race2_path.clone(),
    );
    let h_save = thread::spawn(move || {
        st_r2.save_profile_path(
            save_req(Some(prof_r2), Some(doc_id_r2), ProfileSaveMode::Edited),
            dst_r2,
        )
    });
    wait_for_path(&gate_dir.join("bind-entered-2"))?;
    state.cancel_active();
    let r_compile2 = state.paired_compile(AppThemePairedCompileRequest {
        profile: sample_paired_v1(),
        ui_revision: Some(20),
        session_id: None,
    })?;
    assert!(r_compile2.valid && r_compile2.solar_sail.compiled_css.is_some());
    assert!(!gate_dir.join("bind-release-2").exists());
    std::fs::write(gate_dir.join("bind-release-2"), b"1")?;
    let race2_doc = h_save
        .join()
        .map_err(|_| "h_save")??
        .document
        .ok_or("expected race2 saved doc")?;
    assert!(race2_doc.semantic == ProfileSemanticStatus::Validated);
    assert_eq!(
        race2_doc.verification_status,
        ProfileVerificationStatus::Transformed
    );
    assert!(race2_doc.is_transformed);
    assert_eq!(
        race2_doc.parent_source_sha256.as_deref(),
        Some(parent_raw_sha.as_str())
    );
    assert_eq!(race2_doc.raw_source_sha256, sha_a);
    assert!(race2_doc.normalized_sha256.is_some());
    assert_ne!(race2_doc.normalized_sha256.as_deref(), Some(sha_a.as_str()));
    assert_eq!(std::fs::read(&race2_path)?, bytes_a);
    assert_eq!(
        race2_doc.owner_binding,
        Some(OwnerBindingRecord {
            input_origin: OwnerBindingInputOrigin::SourceBytes,
            raw_source_sha256: sha_a.clone(),
            verification_status: ProfileVerificationStatus::Verified,
            is_transformed: false,
            byte_length: bytes_a.len() as u64,
            normalized_sha256: race2_doc.normalized_sha256.clone(),
            canonical_digest: None,
            parent_source_sha256: None,
        })
    );
    std::fs::write(&ungated_flag, b"1")?;
    let race2_reopened = state
        .open_profile_path(race2_path)?
        .document
        .ok_or("expected race2 reopened")?;
    std::fs::remove_file(&ungated_flag)?;
    assert!(race2_reopened.semantic == ProfileSemanticStatus::Validated);
    assert_eq!(
        race2_reopened.verification_status,
        ProfileVerificationStatus::Verified
    );
    assert!(!race2_reopened.is_transformed && race2_reopened.parent_source_sha256.is_none());
    assert_eq!(race2_reopened.raw_source_sha256, sha_a);
    assert_eq!(
        race2_reopened.normalized_sha256,
        race2_doc.normalized_sha256
    );
    assert_eq!(race2_reopened.owner_binding, race2_doc.owner_binding);

    Ok((sha_a, sha_b, sha_c, parent_path))
}

#[inline(never)]
fn fifo_serial_lane_phase(
    state: &Arc<AppThemeState>,
    temp: &TempDirGuard,
    gate_dir: &Path,
    sha_a: &str,
    sha_b: &str,
    sha_c: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let spawn_new = |st: Arc<AppThemeState>, prof: PairedProfileDto, dst: PathBuf| {
        thread::spawn(move || {
            st.save_profile_path(
                save_req(Some(prof), None, ProfileSaveMode::NewDocument),
                dst,
            )
        })
    };
    let h_a = spawn_new(
        state.clone(),
        fifo_named_profile("doc-a"),
        temp.path().join("fifo-a.json"),
    );
    wait_for_path(&gate_dir.join("bind-entered-3"))?;
    assert_eq!(
        std::fs::read_to_string(gate_dir.join("bind-entered-3"))?,
        sha_a
    );
    let (_, t_after_a) = state.document_ticket_counts();
    let h_b = spawn_new(
        state.clone(),
        fifo_named_profile("doc-b"),
        temp.path().join("fifo-b.json"),
    );
    wait_for_doc_tickets(state, t_after_a + 1)?;
    let h_c = spawn_new(
        state.clone(),
        fifo_named_profile("doc-c"),
        temp.path().join("fifo-c.json"),
    );
    wait_for_doc_tickets(state, t_after_a + 2)?;
    assert!(!gate_dir.join("bind-entered-4").exists());
    assert!(!gate_dir.join("bind-entered-5").exists());

    std::fs::write(gate_dir.join("bind-release-3"), b"1")?;
    wait_for_path(&gate_dir.join("exited-3"))?;
    wait_for_path(&gate_dir.join("bind-entered-4"))?;
    assert_eq!(
        std::fs::read_to_string(gate_dir.join("bind-entered-4"))?,
        sha_b
    );
    assert!(!gate_dir.join("bind-entered-5").exists());
    std::fs::write(gate_dir.join("bind-release-4"), b"1")?;
    wait_for_path(&gate_dir.join("exited-4"))?;
    wait_for_path(&gate_dir.join("bind-entered-5"))?;
    assert_eq!(
        std::fs::read_to_string(gate_dir.join("bind-entered-5"))?,
        sha_c
    );
    std::fs::write(gate_dir.join("bind-release-5"), b"1")?;
    wait_for_path(&gate_dir.join("exited-5"))?;

    let mut last_fifo_doc_id = String::new();
    for h in [h_a, h_b, h_c] {
        let doc = h
            .join()
            .map_err(|_| "fifo join")??
            .document
            .ok_or("expected fifo doc")?;
        assert!(doc.semantic == ProfileSemanticStatus::Validated);
        assert_eq!(doc.verification_status, ProfileVerificationStatus::Verified);
        assert!(!doc.is_transformed && doc.parent_source_sha256.is_none());
        assert!(doc.owner_binding.is_some());
        last_fifo_doc_id = doc.document_id;
    }
    assert!(!gate_dir.join("overlap-detected").exists());
    assert!(!gate_dir.join("gate-timeout").exists());
    Ok(last_fifo_doc_id)
}

#[inline(never)]
fn fifo_reset_and_shutdown_phase(
    state: &Arc<AppThemeState>,
    temp: &TempDirGuard,
    gate_dir: &Path,
    parent_path: &Path,
    last_fifo_doc_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let spawn_new = |st: Arc<AppThemeState>, prof: PairedProfileDto, dst: PathBuf| {
        thread::spawn(move || {
            st.save_profile_path(
                save_req(Some(prof), None, ProfileSaveMode::NewDocument),
                dst,
            )
        })
    };
    let dst_c2 = temp.path().join("cancel-c2.json");
    let dst_d2 = temp.path().join("cancel-d2.json");
    let dst_shut = temp.path().join("cancel-shut.json");
    let dst_shut_new = temp.path().join("cancel-shut-new.json");
    std::fs::write(&dst_c2, b"SENTINEL_RESET")?;
    let doc_id_c2 = last_fifo_doc_id.to_owned();
    let (st_c2, dst_c2_cl) = (state.clone(), dst_c2.clone());
    let h_c2 = thread::spawn(move || {
        st_c2.save_profile_path(
            save_req(
                Some(fifo_named_profile("doc-a")),
                Some(doc_id_c2),
                ProfileSaveMode::Edited,
            ),
            dst_c2_cl,
        )
    });
    wait_for_path(&gate_dir.join("bind-entered-6"))?;
    let (_, t_after_c2) = state.document_ticket_counts();
    let h_d2 = spawn_new(state.clone(), fifo_named_profile("doc-b"), dst_d2.clone());
    wait_for_doc_tickets(state, t_after_c2 + 1)?;
    assert!(!gate_dir.join("bind-entered-7").exists());
    state.reset()?;
    let (res_c2, res_d2) = (
        h_c2.join().map_err(|_| "h_c2")??,
        h_d2.join().map_err(|_| "h_d2")??,
    );
    assert!(res_c2.cancelled && !res_c2.saved && res_c2.error.is_none());
    assert!(res_d2.cancelled && !res_d2.saved && res_d2.error.is_none());
    assert_eq!(std::fs::read(&dst_c2)?, b"SENTINEL_RESET");
    assert!(!dst_d2.exists() && !gate_dir.join("bind-entered-7").exists());

    let ungated_flag = gate_dir.join("ungated");
    std::fs::write(&ungated_flag, b"1")?;
    let shut_active = state
        .open_profile_path(parent_path.to_path_buf())?
        .document
        .ok_or("expected shut active doc")?;
    std::fs::remove_file(&ungated_flag)?;
    let gen_before = state.current_custody_ticket()?;
    std::fs::write(&dst_shut, b"SENTINEL_SHUT")?;
    let (st_sh, id_sh, dst_sh_cl) = (
        state.clone(),
        shut_active.document_id.clone(),
        dst_shut.clone(),
    );
    let h_shut = thread::spawn(move || {
        st_sh.save_profile_path(
            save_req(
                Some(fifo_named_profile("doc-a")),
                Some(id_sh),
                ProfileSaveMode::Edited,
            ),
            dst_sh_cl,
        )
    });
    wait_for_path(&gate_dir.join("bind-entered-7"))?;
    let (_, t_after_sh) = state.document_ticket_counts();
    let h_shut_new = spawn_new(
        state.clone(),
        fifo_named_profile("doc-b"),
        dst_shut_new.clone(),
    );
    wait_for_doc_tickets(state, t_after_sh + 1)?;
    state.shutdown();
    let (res_shut, res_shut_new) = (
        h_shut.join().map_err(|_| "h_shut")??,
        h_shut_new.join().map_err(|_| "h_shut_new")??,
    );
    assert!(res_shut.cancelled && !res_shut.saved && res_shut.error.is_none());
    assert!(res_shut_new.cancelled && !res_shut_new.saved && res_shut_new.error.is_none());
    assert_eq!(std::fs::read(&dst_shut)?, b"SENTINEL_SHUT");
    assert!(!dst_shut_new.exists() && !gate_dir.join("bind-entered-8").exists());
    assert_eq!(state.current_custody_ticket()?, gen_before);
    assert_eq!(
        state.status().active_document_id.as_deref(),
        Some(shut_active.document_id.as_str())
    );
    Ok(())
}

pub(crate) fn run_tfnc13_fifo_document_lane_and_compile_isolation()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDirGuard::new("tfsb-tfnc13-lanes");
    let gate_dir = temp.path().join("gate");
    std::fs::create_dir_all(&gate_dir)?;
    let gated_adapter = temp.path().join("gated-adapter.mjs");
    let gate_str = serde_json::to_string(&gate_dir.to_string_lossy().into_owned())?;
    let real_str = serde_json::to_string(&find_real_adapter()?.to_string_lossy().into_owned())?;
    std::fs::write(
        &gated_adapter,
        format!(
            r#"import {{ readFileSync, writeFileSync, existsSync, unlinkSync }} from "node:fs";
import {{ createHash }} from "node:crypto";
import {{ spawnSync }} from "node:child_process";
const input = readFileSync(0, "utf8"), req = JSON.parse(input), gateDir = {gate_str}, kind = req.action === "bind_document" ? "bind" : "compile";
if (existsSync(`${{gateDir}}/ungated`)) {{
  const r = spawnSync(process.execPath, [{real_str}], {{ input, encoding: "utf8" }});
  if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); process.exit(r.status ?? 1);
}}
const seqPath = `${{gateDir}}/${{kind}}-seq`, seq = (existsSync(seqPath) ? Number(readFileSync(seqPath, "utf8")) : 0) + 1;
writeFileSync(seqPath, String(seq));
if (kind === "bind") {{
  if (existsSync(`${{gateDir}}/bind-active`)) writeFileSync(`${{gateDir}}/overlap-detected`, String(seq));
  writeFileSync(`${{gateDir}}/bind-active`, String(seq));
  writeFileSync(`${{gateDir}}/bind-entered-${{seq}}`, createHash("sha256").update(Buffer.from(req.rawBytesBase64, "base64")).digest("hex"));
}} else writeFileSync(`${{gateDir}}/compile-entered-${{seq}}`, String(seq));
const deadline = Date.now() + 2500;
while (!existsSync(`${{gateDir}}/${{kind}}-release-${{seq}}`)) {{
  if (Date.now() >= deadline) {{ writeFileSync(`${{gateDir}}/gate-timeout`, `${{kind}}-${{seq}}`); process.exit(99); }}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}}
const res = spawnSync(process.execPath, [{real_str}], {{ input, encoding: "utf8" }});
if (kind === "bind") {{ try {{ unlinkSync(`${{gateDir}}/bind-active`); }} catch {{}} writeFileSync(`${{gateDir}}/exited-${{seq}}`, String(Date.now())); }}
if (res.stdout) process.stdout.write(res.stdout); if (res.stderr) process.stderr.write(res.stderr); process.exit(res.status ?? 1);
"#
        ),
    )?;
    let state = Arc::new(AppThemeState::new(AppThemeRunner::new(
        find_node()?,
        gated_adapter,
    )));

    fifo_initial_compile_phase(&state, &temp, &gate_dir)?;
    let (sha_a, sha_b, sha_c, parent_path) = fifo_race_phase(&state, &temp, &gate_dir)?;
    let last_fifo_doc_id =
        fifo_serial_lane_phase(&state, &temp, &gate_dir, &sha_a, &sha_b, &sha_c)?;
    fifo_reset_and_shutdown_phase(&state, &temp, &gate_dir, &parent_path, &last_fifo_doc_id)
}
