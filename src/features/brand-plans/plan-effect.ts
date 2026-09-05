import type {
  BrandDerivePlanSummary,
  BrandPlanMethod,
  BrandRasterExportPlanSummary,
  ConsumerPlanSummary,
  StudioPlanSummary,
} from "../../brand-plans/contracts";

export type PlanEffect =
  | "verified-no-op"
  | "external-output-changes"
  | "canonical-or-lock-only-change-possible"
  | "change-required";

export function classifyPlanEffect(method: BrandPlanMethod, summary: StudioPlanSummary): PlanEffect {
  if (method === "brand.derive.plan") {
    const value = summary as BrandDerivePlanSummary;
    return value.createdCount + value.updatedCount === 0 ? "verified-no-op" : "external-output-changes";
  }
  if (method === "brand.export.plan") {
    const value = summary as BrandRasterExportPlanSummary;
    return value.counts.create + value.counts.update === 0 ? "verified-no-op" : "external-output-changes";
  }
  if (method === "brand.qa.baseline.plan") return "change-required";
  const value = summary as ConsumerPlanSummary;
  return value.outputs.length === 0 ? "canonical-or-lock-only-change-possible" : "external-output-changes";
}
