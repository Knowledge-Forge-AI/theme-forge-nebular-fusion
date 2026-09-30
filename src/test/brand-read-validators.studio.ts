import { readFileSync } from "node:fs";
import {
  validateBrandStatus, validateConsumerLockStatus, validateConsumerProfilePage,
  validateExportCapability, validateExportStatusPage, validateFamilyPage,
  validateQaProfile, validateQaProfilePage, validateQaResult, validateRecipeGraph,
  validateSemanticDiff, validateTokenPage,
} from "../brand-read/validators";

const examples = JSON.parse(readFileSync("protocol/tfsb-studio-v1/examples/1.2/results.json", "utf8")) as Record<string, unknown>;
const vectors = [
  ["brand.status", "status", validateBrandStatus],
  ["brand.family.list", "family-page", validateFamilyPage],
  ["brand.token.list", "token-page", validateTokenPage],
  ["brand.recipe.graph", "recipe-graph", validateRecipeGraph],
  ["brand.qa.profile.list", "qa-profile-page", validateQaProfilePage],
  ["brand.qa.profile.get", "qa-profile", validateQaProfile],
  ["brand.qa.result.get", "qa-result", validateQaResult],
  ["brand.diff", "semantic-diff", validateSemanticDiff],
  ["brand.consumer.profile.list", "consumer-profile-page", validateConsumerProfilePage],
  ["brand.consumer.lock.status", "consumer-lock-status", validateConsumerLockStatus],
  ["brand.export.capability", "export-capability", validateExportCapability],
  ["brand.export.status", "export-status-page", validateExportStatusPage],
] as const;

describe("method-specific brand read validators", () => {
  it.each(vectors)("accepts the canonical %s result", (method, kind, validate) => {
    expect(validate({ kind, data: structuredClone(examples[method]) })).toBeTruthy();
  });

  it.each(vectors)("rejects an extra top-level field for %s", (method, kind, validate) => {
    const data = structuredClone(examples[method]) as Record<string, unknown>; data.requestId = "private";
    expect(() => validate({ kind, data })).toThrow();
  });

  it.each(vectors)("rejects a missing top-level field for %s", (method, kind, validate) => {
    const data = structuredClone(examples[method]) as Record<string, unknown>; delete data[Object.keys(data)[0] as string];
    expect(() => validate({ kind, data })).toThrow();
  });

  it.each(vectors)("rejects the wrong tagged result for %s", (method, _kind, validate) => {
    expect(() => validate({ kind: "wrong-kind", data: structuredClone(examples[method]) })).toThrow();
  });

  it.each(vectors)("rejects a wrong top-level field type for %s", (method, kind, validate) => {
    const data = structuredClone(examples[method]) as Record<string, unknown>;
    data[Object.keys(data)[0] as string] = null;
    expect(() => validate({ kind, data })).toThrow();
  });

  it.each([
    ["brand.family.list", "family-page", validateFamilyPage],
    ["brand.token.list", "token-page", validateTokenPage],
    ["brand.qa.profile.list", "qa-profile-page", validateQaProfilePage],
    ["brand.consumer.profile.list", "consumer-profile-page", validateConsumerProfilePage],
    ["brand.export.status", "export-status-page", validateExportStatusPage],
  ] as const)("rejects an out-of-bound page for %s", (method, kind, validate) => {
    const data = structuredClone(examples[method]) as { page: { size: number } };
    data.page.size = 0;
    expect(() => validate({ kind, data })).toThrow();
  });
});

describe("brand status as the maintained sidecar returns it", () => {
  // Captured from the Burst 0.6.1 sidecar (brand.status on the derive-ready core fixture after a derive apply).
  // The sidecar lists "brand" ahead of the declared domains, which include "brand" again: eight entries, the
  // bound the Rust host (sidecar/brand_types/status.rs) accepts. The release smoke found the frontend at seven.
  const sidecarStatus = JSON.parse("{\"present\":true,\"schemaVersion\":1,\"brandDigest\":\"sha256:600da1d3da33bf9eb302b4e0b654705c8f82ff45a84cc648111a436e8129ad75\",\"brandSystemDigest\":\"sha256:b137cee7c3758dc6ac7decc696404f1d226897f6c8c317e0f08d53222b57cfc2\",\"domains\":[{\"domain\":\"brand\",\"state\":\"available\",\"digest\":\"sha256:600da1d3da33bf9eb302b4e0b654705c8f82ff45a84cc648111a436e8129ad75\"},{\"domain\":\"brand\",\"state\":\"available\",\"digest\":\"sha256:600da1d3da33bf9eb302b4e0b654705c8f82ff45a84cc648111a436e8129ad75\"},{\"domain\":\"consumer_profiles\",\"state\":\"disabled\",\"digest\":null},{\"domain\":\"exports\",\"state\":\"disabled\",\"digest\":null},{\"domain\":\"package\",\"state\":\"disabled\",\"digest\":null},{\"domain\":\"qa\",\"state\":\"disabled\",\"digest\":null},{\"domain\":\"recipes\",\"state\":\"available\",\"digest\":\"sha256:b0608dddf7e63966f87bed3658538c1c23bc5f6046a99787b59f8ecefbf635e1\"},{\"domain\":\"tokens\",\"state\":\"available\",\"digest\":\"sha256:9bb6e859b7ae297d128e30f8504fdbd655ef463fc711c5147c14ede4163e3eb4\"}],\"counts\":{\"families\":1,\"roles\":1,\"variants\":2,\"bindings\":2,\"requirements\":0,\"tokens\":1,\"recipes\":1,\"qaProfiles\":0,\"qaCases\":0,\"qaBaselines\":0,\"consumerProfiles\":0,\"exportProfiles\":0},\"completeness\":{\"satisfied\":true,\"familyCount\":1,\"variantCount\":2,\"bindingCount\":2,\"requirementCount\":0},\"derived\":{\"unchanged\":1,\"stale-authority\":0,\"missing-target\":0,\"human-owned\":0,\"target-drift\":0,\"invalid-receipt\":0,\"ownership-conflict\":0},\"consumerLock\":{\"present\":false,\"status\":\"ok\",\"packages\":0,\"profiles\":0,\"mappings\":0},\"export\":{\"outputs\":0,\"receipts\":0},\"raster\":{\"available\":false}}") as Record<string, unknown>;

  it("accepts the eight-entry domain list of a project with every domain declared", () => {
    expect((sidecarStatus.domains as unknown[]).length).toBe(8);
    const status = validateBrandStatus({ kind: "status", data: structuredClone(sidecarStatus) });
    expect(status).toMatchObject({ present: true, derived: { unchanged: 1 } });
    expect(status.present && status.domains.map((entry) => entry.domain)).toEqual(["brand", "consumer_profiles", "exports", "package", "qa", "recipes", "tokens"]);
  });

  it("rejects a repeated domain whose state or digest differs", () => {
    const data = structuredClone(sidecarStatus) as { domains: { state: string }[] };
    data.domains[1]!.state = "invalid";
    expect(() => validateBrandStatus({ kind: "status", data })).toThrow();
  });

  it("still rejects more domains than the host accepts", () => {
    const data = structuredClone(sidecarStatus) as { domains: unknown[] };
    data.domains.push({ domain: "extra", state: "available", digest: null });
    expect(() => validateBrandStatus({ kind: "status", data })).toThrow();
  });
});
