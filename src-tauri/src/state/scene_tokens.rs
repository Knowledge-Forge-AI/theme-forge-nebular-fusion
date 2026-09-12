//! Explicit color snapshot through the already-selected project authority.
use super::host::HostState;
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::sidecar::brand_protocol::{
    PageRequest, StudioBrandReadRequest, StudioBrandReadResponse,
};
use crate::sidecar::brand_types::BrandToken;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

pub(crate) struct TokenSnapshot {
    pub generation: u64,
    pub identity: String,
    pub bindings: BTreeMap<String, String>,
    pub excluded: usize,
}

pub(crate) fn read(host: &HostState, project: &str) -> StudioResult<TokenSnapshot> {
    let invalid = || StudioCommandError::new(StudioReasonCode::ContextStale);
    if project.is_empty() || project.len() > 256 {
        return Err(invalid());
    }
    let generation = host.scene_generation();
    let mut supervisor = host.lock()?;
    let start = Instant::now();
    let status = supervisor.brand_read(StudioBrandReadRequest::Status {
        project_handle: project.to_owned(),
    })?;
    let before = serde_json::to_vec(&status).map_err(|_| invalid())?;
    let mut cursor = None;
    let mut view = None;
    let mut bindings = BTreeMap::new();
    let mut excluded = 0;
    let mut total = 0;
    loop {
        if start.elapsed() > Duration::from_secs(10) {
            return Err(invalid());
        }
        let response = supervisor.brand_read(StudioBrandReadRequest::TokenPage(PageRequest {
            project_handle: project.to_owned(),
            page_size: 128,
            cursor,
        }))?;
        let StudioBrandReadResponse::TokenPage(page) = response else {
            return Err(invalid());
        };
        if view
            .as_ref()
            .is_some_and(|v| v != page.view_digest.as_str())
        {
            return Err(invalid());
        }
        view = Some(page.view_digest.as_str().to_owned());
        total += page.page.items.len();
        if total > 1000 {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        for token in page.page.items {
            if let BrandToken::Color { id, value, .. } = token {
                if value.len() == 9 && value.ends_with("FF") {
                    bindings.insert(id, value[..7].to_owned());
                } else {
                    excluded += 1;
                }
            } else {
                excluded += 1;
            }
        }
        cursor = page.page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    let after = supervisor.brand_read(StudioBrandReadRequest::Status {
        project_handle: project.to_owned(),
    })?;
    if before != serde_json::to_vec(&after).map_err(|_| invalid())?
        || generation != host.scene_generation()
    {
        return Err(invalid());
    }
    let bytes = serde_json::to_vec(&(project, generation, before, view, &bindings))
        .map_err(|_| invalid())?;
    if bytes.len() > 1024 * 1024 {
        return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
    }
    Ok(TokenSnapshot {
        generation,
        identity: format!("sha256:{:x}", Sha256::digest(bytes)),
        bindings,
        excluded,
    })
}
