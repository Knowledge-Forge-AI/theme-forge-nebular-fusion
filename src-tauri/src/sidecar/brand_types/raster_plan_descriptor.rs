use crate::sidecar::protocol::RasterAvailable;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FrozenRasterPlanDescriptor {
    pub(crate) adapter_id: &'static str,
    pub(crate) renderer_version: &'static str,
    pub(crate) qualification_id: &'static str,
    pub(crate) platform_claim: &'static str,
    pub(crate) backend: &'static str,
    pub(crate) renderer_package: &'static str,
    pub(crate) renderer_build_digest: &'static str,
    pub(crate) companion_package: &'static str,
    pub(crate) companion_version: &'static str,
    pub(crate) node_major: u16,
}

pub(crate) const QUALIFIED_RASTER_PLAN: FrozenRasterPlanDescriptor = FrozenRasterPlanDescriptor {
    adapter_id: "resvg-png-v1",
    renderer_version: "2.6.2",
    qualification_id: "sha256:4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11",
    platform_claim: "darwin-arm64",
    backend: "wasm",
    renderer_package: "@resvg/resvg-wasm",
    renderer_build_digest: "sha256:22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70",
    companion_package: "@knowledge-forge-ai/tfsb-raster-resvg",
    companion_version: "0.0.0-tfsb47f",
    node_major: 22,
};

impl FrozenRasterPlanDescriptor {
    pub(crate) fn matches_initialize(self, value: &RasterAvailable) -> bool {
        value.available
            && value.adapter_id == self.adapter_id
            && value.renderer_version == self.renderer_version
            && value.qualification_id == self.qualification_id
            && value.platform_claim == self.platform_claim
    }
}

#[cfg(test)]
mod tests {
    use super::QUALIFIED_RASTER_PLAN;
    use crate::sidecar::protocol::RasterAvailable;

    fn available() -> RasterAvailable {
        RasterAvailable {
            adapter_id: QUALIFIED_RASTER_PLAN.adapter_id.to_owned(),
            available: true,
            platform_claim: QUALIFIED_RASTER_PLAN.platform_claim.to_owned(),
            qualification_id: QUALIFIED_RASTER_PLAN.qualification_id.to_owned(),
            renderer_version: QUALIFIED_RASTER_PLAN.renderer_version.to_owned(),
        }
    }

    #[test]
    fn initialize_binding_rejects_each_capability_field_and_unavailable_state() {
        assert!(QUALIFIED_RASTER_PLAN.matches_initialize(&available()));

        let mut unavailable = available();
        unavailable.available = false;
        assert!(!QUALIFIED_RASTER_PLAN.matches_initialize(&unavailable));

        let mut adapter = available();
        adapter.adapter_id = "other".to_owned();
        assert!(!QUALIFIED_RASTER_PLAN.matches_initialize(&adapter));

        let mut version = available();
        version.renderer_version = "other".to_owned();
        assert!(!QUALIFIED_RASTER_PLAN.matches_initialize(&version));

        let mut qualification = available();
        qualification.qualification_id = "other".to_owned();
        assert!(!QUALIFIED_RASTER_PLAN.matches_initialize(&qualification));

        let mut platform = available();
        platform.platform_claim = "other".to_owned();
        assert!(!QUALIFIED_RASTER_PLAN.matches_initialize(&platform));
    }
}
