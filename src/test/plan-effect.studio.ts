import { describe, expect, it } from "vitest";

import type { BrandDerivePlanSummary, BrandRasterExportPlanSummary, ConsumerPlanSummary } from "../brand-plans/contracts";
import { classifyPlanEffect } from "../features/brand-plans/plan-effect";

const digest: `sha256:${string}` = `sha256:${"a".repeat(64)}`;

describe("method-specific plan effects", () => {
  it("distinguishes verified no-op, external output, required, and possible lock-only changes", () => {
    const derive = { createdCount: 0, updatedCount: 0 } as BrandDerivePlanSummary;
    expect(classifyPlanEffect("brand.derive.plan", derive)).toBe("verified-no-op");
    expect(classifyPlanEffect("brand.derive.plan", { ...derive, updatedCount: 1 })).toBe("external-output-changes");

    const raster = { counts: { create: 0, update: 0, unchanged: 2 } } as BrandRasterExportPlanSummary;
    expect(classifyPlanEffect("brand.export.plan", raster)).toBe("verified-no-op");
    expect(classifyPlanEffect("brand.export.plan", { ...raster, counts: { create: 1, update: 0, unchanged: 1 } })).toBe("external-output-changes");
    expect(classifyPlanEffect("brand.qa.baseline.plan", {} as never)).toBe("change-required");
  });

  it.each([
    ["brand.consumer.install.plan", [], [], digest],
    ["brand.consumer.install.plan", [], ["optional/asset"], `sha256:${"b".repeat(64)}`],
    ["brand.consumer.sync.plan", [], [], `sha256:${"c".repeat(64)}`],
  ] as const)("never calls zero consumer outputs a semantic no-op for %s", (method, outputs, omittedOptional, lockDigest) => {
    const summary = { operation: method.includes("install") ? "install" : "sync", packages: ["package-one"], profiles: [], outputs, omittedOptional, lockDigest } as ConsumerPlanSummary;
    expect(classifyPlanEffect(method, summary)).toBe("canonical-or-lock-only-change-possible");
  });

  it("classifies nonzero consumer outputs as external output changes", () => {
    const summary = { operation: "sync", packages: ["package-one"], profiles: [], outputs: [{ kind: "asset", packageId: "package-one", sourceId: "asset-one", destination: "public/asset.svg", byteDigest: digest }], omittedOptional: [], lockDigest: digest } as ConsumerPlanSummary;
    expect(classifyPlanEffect("brand.consumer.sync.plan", summary)).toBe("external-output-changes");
  });
});
