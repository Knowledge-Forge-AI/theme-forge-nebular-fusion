import { applicationBaselines } from "./generated/runtime-baselines";
import catalogIndex from "./generated/catalog-index.json";
import type { AppearanceCatalog } from "./appearance-controller";

/** Bundled build output; selection reads only these installed assets. */
export const bundledAppearanceCatalog: AppearanceCatalog = Object.freeze({
  defaultFamily: "nebular",
  defaults: Object.freeze({ light: "nebular", dark: "nebular", mode: "system" }),
  families: Object.freeze(catalogIndex.families.map(({ id, label }) => {
    const css = (applicationBaselines as Readonly<Record<string, string>>)[id];
    if (!css) throw new Error("Bundled appearance baseline is unavailable");
    return Object.freeze({ id, label, css });
  })),
});
