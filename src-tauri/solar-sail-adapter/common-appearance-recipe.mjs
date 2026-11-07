import { createHash } from "node:crypto";

const codePointCompare = (left, right) => {
  const a = Array.from(left, character => character.codePointAt(0));
  const b = Array.from(right, character => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
};
const byPath = (a, b) => codePointCompare(a.path, b.path);
const json = value => JSON.stringify(value, null, 2) + "\n";

export const sha256 = value => createHash("sha256").update(value).digest("hex");

const record = (path, content) => ({
  path,
  bytes: Buffer.byteLength(content),
  sha256: sha256(content),
});

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function validateFamilyBindings(familyBindings) {
  const bindingKeys = familyBindings && Object.keys(familyBindings).sort();
  assert(JSON.stringify(bindingKeys) === JSON.stringify(["monospace", "system-ui"]), "Unexpected Loom family binding keys");
  assert(familyBindings["system-ui"] === "system-sans" && familyBindings.monospace === "system-mono", "Unexpected Loom family bindings");
}

function validateApplicationBaselineLayer(applicationBaselineLayer) {
  assert(applicationBaselineLayer === "theme-forge-application-baseline", "Unexpected application baseline layer");
}

function validateRelativePath(path) {
  assert(typeof path === "string" && /^[a-z0-9_./-]+$/.test(path), "Invalid generated member path");
  assert(!path.startsWith("/") && !path.split("/").some(part => !part || part === "." || part === ".."), "Invalid generated member path");
}

function validateCatalogSource(sourceCatalog) {
  assert(sourceCatalog && sourceCatalog.schema === "theme-forge.appearance-catalog-source.v1", "Unknown appearance catalog source schema");
  assert(sourceCatalog.status === "source-and-consumer-preparation; no release or visual acceptance", "Unexpected appearance catalog status");
  assert(sourceCatalog.defaultFamily === "nebular", "Unexpected appearance catalog default family");
  assert(JSON.stringify(sourceCatalog.modes) === JSON.stringify(["light", "dark"]), "Appearance catalog modes must be light and dark");
  validateApplicationBaselineLayer(sourceCatalog.applicationBaselineLayer);
  assert(sourceCatalog.sttnTemplate === "../sttn/v0.4/terminal-nova.theme.json", "Unexpected STTN template source path");
  validateFamilyBindings(sourceCatalog.familyBindings);
  assert(Array.isArray(sourceCatalog.profiles) && sourceCatalog.profiles.length > 0, "Appearance catalog needs profiles");
  const ids = sourceCatalog.profiles.map(profile => profile.id);
  assert(JSON.stringify(ids) === JSON.stringify(["terminal-nova", "nebular", "developer", "graphic-designer", "anime", "gamer"]), "Appearance catalog must contain the six admitted family identities in order");
  assert(new Set(ids).size === ids.length && ids.every(id => /^[a-z0-9-]+$/.test(id)), "Appearance catalog profile identities are invalid");
  assert(ids.includes(sourceCatalog.defaultFamily), "Appearance catalog default family is not present");
  for (const profile of sourceCatalog.profiles) {
    assert(typeof profile.label === "string" && typeof profile.review === "string" && typeof profile.source === "string", `Incomplete profile declaration: ${profile.id}`);
    const expectedSource = profile.id === "terminal-nova" ? "../terminal-nova.profile.json" : `${profile.id}.profile.json`;
    assert(profile.source === expectedSource, `Unexpected profile source path: ${profile.id}`);
  }
}

function validateRawJsonSource(label, source, expected) {
  assert(typeof source === "string", `${label} raw source must be text`);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} raw source is not valid JSON: ${error.message}`);
  }
  assert(JSON.stringify(parsed) === JSON.stringify(expected), `${label} raw source does not match its parsed input`);
  return source;
}

function validateTemplate(templateSource) {
  assert(typeof templateSource === "string", "STTN template source must be text");
  const template = JSON.parse(templateSource);
  assert(template.schemaVersion === "tfsl.theme-v2", "Unexpected STTN template schema");
  assert(template.name === "terminal-nova", "Unexpected STTN template identity");
  assert(template.tokenSets && template.accentVariants && template.codePresentation, "Incomplete STTN template");
  return template;
}

function validateLoomOverrides(profile) {
  const selections = profile.targetOverrides?.loom;
  if (selections === undefined) return;
  assert(selections && typeof selections === "object" && !Array.isArray(selections), `Invalid Loom override object: ${profile.name}`);
  const allowed = ["defaultAccent", "primaryFamily", "secondaryFamily", "tokenSetKey"];
  const keys = Object.keys(selections).sort();
  assert(keys.every(key => allowed.includes(key)), `Unexpected Loom override key: ${profile.name}`);
  for (const key of keys) {
    assert(typeof selections[key] === "string" && /^[a-z][a-z0-9-]*$/.test(selections[key]), `Invalid Loom override value: ${profile.name}.${key}`);
  }
}

function assertLayerSafeCss(css, label) {
  assert(typeof css === "string", `${label} CSS must be text`);
  assert(!/@(?:import|charset|namespace)\b/i.test(css), `${label} CSS contains an at-rule forbidden inside an application layer`);
}

// Solar's pinned Tailwind output contains a small, intentionally closed
// preamble.  Tailwind requires these top-level directives to remain outside
// the application layer; the rules which follow are the only part we layer.
// Keep this formatter guard narrow rather than accepting arbitrary CSS.
const SOLAR_TAILWIND_PREAMBLE = /^\/\* Generated by Theme Forge Solar Sail — Tailwind CSS v4 & shadcn\/ui application theme \*\/\n@custom-variant dark \(&:is\(\.dark \*\)\);\n\n@theme inline \{[\s\S]*?\n\}\n\n/;

function splitSolarApplicationCss(css, label) {
  assert(typeof css === "string", `${label} CSS must be text`);
  const match = css.match(SOLAR_TAILWIND_PREAMBLE);
  assert(match?.[0], `${label} has unexpected Tailwind application preamble`);
  const preamble = match[0];
  const body = css.slice(preamble.length);
  assert(body.startsWith(":root"), `${label} has unexpected Tailwind application body`);
  assert(!/@(?:custom-variant|theme)\b/.test(body), `${label} Tailwind directives must remain in the pinned preamble`);
  return { preamble, body };
}

function resolveVariantRole(catalog, variant, mode, role) {
  const variantRecord = catalog.accentVariants?.[variant];
  assert(variantRecord?.[mode] && typeof variantRecord[mode][role] === "string", `Missing STTN role ${variant}.${mode}.${role}`);
  const tokenSet = catalog.tokenSets?.[variantRecord.tokenSet];
  assert(tokenSet && typeof tokenSet[variantRecord[mode][role]] === "string", `Missing STTN token ${variant}.${mode}.${role}`);
  return tokenSet[variantRecord[mode][role]];
}

function sourceVariantForLoom(template, profile, variant) {
  if (Object.hasOwn(template.accentVariants, variant)) return variant;
  const selections = profile.targetOverrides?.loom;
  if (selections?.primaryFamily === variant) return "cyan";
  if (selections?.secondaryFamily === variant) return "orange";
  throw new Error(`Loom variant has no admitted source variant: ${profile.name}.${variant}`);
}

function variantRoleDisposition(template, catalog, profile) {
  const profileDerivedRoles = [];
  const templateRetainedRoles = [];
  for (const variant of Object.keys(catalog.accentVariants).sort(codePointCompare)) {
    const sourceVariant = sourceVariantForLoom(template, profile, variant);
    for (const mode of ["light", "dark"]) {
      const roles = Object.keys(catalog.accentVariants[variant]?.[mode] ?? {}).sort(codePointCompare);
      const derived = [];
      const retained = [];
      for (const role of roles) {
        const targetValue = resolveVariantRole(catalog, variant, mode, role);
        const sourceValue = resolveVariantRole(template, sourceVariant, mode, role);
        (targetValue === sourceValue ? retained : derived).push(role);
      }
      if (derived.length > 0) profileDerivedRoles.push({ variant, sourceVariant, mode, roles: derived });
      if (retained.length > 0) templateRetainedRoles.push({ variant, sourceVariant, mode, roles: retained });
    }
  }
  return { profileDerivedRoles, templateRetainedRoles };
}

function loomNotApplied(report) {
  const entries = (report.entries ?? [])
    .filter(entry => {
      const targetPaths = typeof entry.targetPath === "string" ? entry.targetPath.split(";") : [];
      return entry.sourcePath?.startsWith("code.")
        || targetPaths.some(path => path === "frame" || path === "copy" || path.startsWith("syntax.") || path.startsWith("chrome."));
    })
    .map(entry => ({
      kind: "mapping-entry",
      sourcePath: entry.sourcePath ?? null,
      sourceValue: entry.sourceValue ?? null,
      classification: entry.classification ?? null,
      reason: entry.reason ?? null,
      targetPath: entry.targetPath ?? null,
      targetValue: entry.targetValue ?? null,
      consumerDelivery: "not-applied-to-retained-sttn-code-presentation",
    }));
  const defaults = (report.defaults ?? []).map(entry => ({
    kind: "report-default",
    sourcePath: null,
    sourceValue: null,
    classification: "adapter-default",
    reason: entry.reason ?? null,
    targetPath: entry.targetPath ?? null,
    targetValue: entry.targetValue ?? null,
    consumerDelivery: "not-applied-to-retained-sttn-code-presentation",
  }));
  return [...entries, ...defaults];
}

function validateEngines(engineBundle, declaredEngines) {
  assert(engineBundle && engineBundle.solar && engineBundle.loom && Array.isArray(engineBundle.archives), "Engine bundle is incomplete");
  assert(declaredEngines?.schema === "cttn.engine-archives-v1" && Array.isArray(declaredEngines.engines), "Unknown declared engine archive schema");
  assert(declaredEngines.engines.length === 2 && engineBundle.archives.length === 2, "Exactly Solar and Loom engine archives are required");
  for (const [index, declared] of declaredEngines.engines.entries()) {
    const actual = engineBundle.archives[index];
    assert(actual && actual.package === declared.package && actual.version === declared.version && actual.sha256 === declared.sha256 && actual.integrity === declared.integrity,
      `${declared.role} engine archive identity mismatch`);
  }
  const solar = declaredEngines.engines.find(engine => engine.role === "solar");
  const loom = declaredEngines.engines.find(engine => engine.role === "loom");
  assert(solar && loom, "Declared Solar and Loom engine roles are required");
  assert(engineBundle.solar.COMPILER_NAME === solar.package && engineBundle.solar.COMPILER_VERSION === solar.version, "Solar engine self-identity mismatch");
  assert(engineBundle.loom.COMPILER_PACKAGE === loom.package && engineBundle.loom.COMPILER_VERSION === loom.version, "Loom engine self-identity mismatch");
}

function applicationExtension(profile) {
  const uiFamily = profile.typography?.ui?.family;
  const surfaceRadius = profile.radius?.surface;
  assert(["system-ui", "monospace", "sans-serif", "serif"].includes(uiFamily) && /^\d+(?:\.\d+)?(?:px|rem|em)$/.test(surfaceRadius),
    "Application adapter requires an admitted generic UI font and explicit surface radius");
  const entries = [
    { sourcePath: "typography.ui.family", target: "--tf-appearance-font-ui", value: uiFamily },
    { sourcePath: "radius.surface", target: "--tf-appearance-radius-surface", value: surfaceRadius },
  ];
  let css = `:root { color-scheme: light; --tf-appearance-font-ui: ${uiFamily}; --tf-appearance-radius-surface: ${surfaceRadius}; }\n.dark, :root[data-theme='dark'] { color-scheme: dark; }\n`;
  for (const mode of ["light", "dark"]) {
    const selection = profile.color?.[mode]?.selection;
    const selectionText = profile.color?.[mode]?.selectionText;
    assert(/^#[0-9a-f]{6}$/i.test(selection) && /^#[0-9a-f]{6}$/i.test(selectionText), "Application adapter requires explicit opaque selection colors");
    const selector = mode === "light" ? ":root" : ".dark, :root[data-theme='dark']";
    css += `${selector} { --tf-appearance-selection: ${selection}; --tf-appearance-selection-text: ${selectionText}; }\n`;
    entries.push(
      { sourcePath: `color.${mode}.selection`, target: "--tf-appearance-selection", value: selection },
      { sourcePath: `color.${mode}.selectionText`, target: "--tf-appearance-selection-text", value: selectionText },
    );
  }
  return {
    css,
    report: {
      schema: "theme-forge.application-appearance-extension.v1",
      entries,
      scope: "Explicit application-only roles supplementary to the authentic Solar mapping; not claimed as Solar support",
    },
  };
}

function applyLoomOverrides(template, profile) {
  const catalog = structuredClone(template);
  const selections = profile.targetOverrides?.loom;
  if (!selections) return catalog;
  const originalPrimary = "cyan";
  const originalSecondary = "orange";
  const targetSet = selections.tokenSetKey ?? "forge-console";
  if (!Object.hasOwn(catalog.tokenSets, targetSet)) {
    catalog.tokenSets[targetSet] = structuredClone(catalog.tokenSets["forge-console"]);
  }
  for (const [original, selected] of [[originalPrimary, selections.primaryFamily], [originalSecondary, selections.secondaryFamily]]) {
    if (selected && !Object.hasOwn(catalog.accentVariants, selected)) {
      catalog.accentVariants[selected] = structuredClone(catalog.accentVariants[original]);
      catalog.accentVariants[selected].tokenSet = targetSet;
    }
  }
  if (selections.defaultAccent) catalog.defaultAccent = selections.defaultAccent;
  return catalog;
}

export function compileBoundAppearanceProfile(engineBundle, bound, options) {
  assert(engineBundle && engineBundle.solar && engineBundle.loom, "Appearance profile engines are required");
  assert(bound && typeof bound === "object" && bound.profile && typeof bound.profile === "object", "A bound appearance profile is required");
  assert(options && typeof options === "object", "Appearance profile compile options are required");
  const profile = bound.profile;
  assert(profile.schemaVersion === "tf-paired-profile-v2" && typeof profile.name === "string", "Bound appearance profile identity is invalid");
  assert(bound.provenance?.rawSourceSha256, `Profile mapper did not bind source: ${profile.name}`);
  validateFamilyBindings(options.familyBindings);
  validateApplicationBaselineLayer(options.applicationBaselineLayer);
  validateLoomOverrides(profile);

  const { solar, loom } = engineBundle;
  const template = validateTemplate(options.templateSource);
  const extension = applicationExtension(profile);
  const solarMapping = bound.mapToSolarSail();
  const solarResult = solar.compileTheme(solarMapping.specification);
  assert(!solarResult.diagnostics?.some(item => item.severity === "error"), `Solar compilation refused ${profile.name}`);

  const loomCatalog = applyLoomOverrides(template, profile);
  loomCatalog.name = profile.name;
  loomCatalog.version = profile.version;
  const loomMapping = bound.mapToStellarLoom({ catalog: loomCatalog, familyBindings: options.familyBindings });
  assert(JSON.stringify(loomMapping.catalog.codePresentation) === JSON.stringify(template.codePresentation), `STTN code presentation drift: ${profile.name}`);
  loom.validateThemeCatalog(loomMapping.catalog);
  const loomResult = loom.compileTheme(loomMapping.catalog, { sourceProfileSha256: bound.provenance.rawSourceSha256 });
  assert(!loomResult.diagnostics?.some(item => item.severity === "error"), `Loom compilation refused ${profile.name}`);
  assertLayerSafeCss(solarResult.css, `Solar ${profile.name}`);
  const solarApplication = splitSolarApplicationCss(solarResult.css, `Solar ${profile.name}`);
  assertLayerSafeCss(solarApplication.body, `Solar ${profile.name} layered body`);
  assertLayerSafeCss(extension.css, `Application extension ${profile.name}`);
  const applicationCss = `${solarApplication.preamble}@layer ${options.applicationBaselineLayer} {\n${solarApplication.body}\n${extension.css}\n}\n`;
  const roleDisposition = variantRoleDisposition(template, loomMapping.catalog, profile);

  return {
    profile,
    extension,
    solarMapping,
    solarResult,
    loomMapping,
    loomResult,
    solarApplication,
    applicationCss,
    roleDisposition,
  };
}

/**
 * Compile the bounded paired appearance collection without filesystem, network,
 * package-manager, or runtime discovery. Engines and every source byte
 * are supplied by the caller; the returned Map is safe for a separate writer.
 */
export function compileAppearanceCollection(engineBundle, inputs) {
  assert(inputs && typeof inputs === "object", "Appearance collection inputs are required");
  validateEngines(engineBundle, inputs?.declaredEngines);
  validateCatalogSource(inputs?.catalog);
  const catalogSource = validateRawJsonSource("Appearance catalog", inputs.catalogSource, inputs.catalog);
  assert(Array.isArray(inputs.profiles) && inputs.profiles.length === inputs.catalog.profiles.length, "Profile source set does not match catalog");
  const profileById = new Map(inputs.profiles.map(profile => [profile.id, profile]));
  assert(profileById.size === inputs.profiles.length, "Duplicate appearance profile source");
  for (const declaration of inputs.catalog.profiles) {
    const supplied = profileById.get(declaration.id);
    assert(supplied && supplied.label === declaration.label && supplied.review === declaration.review && (supplied.sourcePath === undefined || supplied.sourcePath === declaration.source), `Missing or mismatched profile source: ${declaration.id}`);
  }

  const { solar, loom } = engineBundle;
  const files = new Map();
  const inventory = [];
  const reports = [];
  const applicationBaselines = {};
  const emit = (path, content) => {
    validateRelativePath(path);
    assert(!files.has(path), `Duplicate generated member path: ${path}`);
    const text = String(content);
    files.set(path, text);
    inventory.push(record(path, text));
  };

  for (const declaration of inputs.catalog.profiles) {
    const supplied = profileById.get(declaration.id);
    assert(typeof supplied.source === "string", `Profile source must be text: ${declaration.id}`);
    const sourceProfile = JSON.parse(supplied.source);
    assert(sourceProfile.name === declaration.id && sourceProfile.schemaVersion === "tf-paired-profile-v2", `Profile identity mismatch: ${declaration.id}`);
    validateLoomOverrides(sourceProfile);
    const bound = solar.bindSourceProfileV2(supplied.source);
    assert(bound?.provenance?.rawSourceSha256, `Profile mapper did not bind source: ${declaration.id}`);
    assert(bound.profile?.name === declaration.id, `Bound profile identity mismatch: ${declaration.id}`);
    const compiled = compileBoundAppearanceProfile(
      { solar, loom },
      bound,
      {
        templateSource: inputs.templateSource,
        familyBindings: inputs.catalog.familyBindings,
        applicationBaselineLayer: inputs.catalog.applicationBaselineLayer,
      },
    );
    const { profile, extension, solarMapping, solarResult, loomMapping, loomResult, applicationCss, roleDisposition } = compiled;

    emit(`${declaration.id}/cttn.css`, solarResult.css);
    emit(`${declaration.id}/appearance-extensions.css`, extension.css);
    emit(`${declaration.id}/application-extension.mapping.json`, json(extension.report));
    applicationBaselines[declaration.id] = applicationCss;
    emit(`${declaration.id}/application.css`, applicationCss);
    emit(`${declaration.id}/sttn.css`, loomResult.css);
    emit(`${declaration.id}/sttn.catalog.json`, json(loomMapping.catalog));
    for (const [path, css] of loomResult.styles) emit(`${declaration.id}/${path}`, css);
    emit(`${declaration.id}/solar.mapping.json`, json(solarMapping.report));
    emit(`${declaration.id}/loom.mapping.json`, json(loomMapping.report));

    reports.push({
      id: declaration.id,
      label: declaration.label,
      review: declaration.review,
      sourceSha256: sha256(supplied.source),
      canonicalDigest: bound.provenance.canonicalDigest,
      solarMapping: solarMapping.report.summary,
      loomMapping: loomMapping.report.summary,
      applicationExtension: extension.report,
      diagnostics: { solar: solarResult.diagnostics, loom: loomResult.diagnostics },
      targetDisposition: {
        solar: solarMapping.report.entries.filter(entry => ["unsupported", "target-specific"].includes(entry.classification)),
        loom: loomMapping.report.entries.filter(entry => ["unsupported", "target-specific"].includes(entry.classification)),
        profileDerivedRoles: roleDisposition.profileDerivedRoles,
        templateRetainedRoles: roleDisposition.templateRetainedRoles,
        roleComparison: {
          method: "resolved-value-comparison-to-declared-template",
          derivedMeaning: "Inferred profile-derived roles are resolved values differing from the admitted source variant; equal values are template-retained",
          causalProvenance: false,
        },
        loomNotApplied: loomNotApplied(loomMapping.report),
        codePresentation: "Existing STTN code presentation retained; the separately returned syntax model is not silently substituted",
        authoredSyntax: profile.code?.syntax === undefined
          ? { status: "not-declared", applied: false, sourcePath: null, disclosure: "No authored syntax palette is declared by this profile" }
          : { status: "unsupported", applied: false, sourcePath: "code.syntax", disclosure: "Authored syntax palette is retained as a candidate but is not applied to the retained STTN code presentation" },
        loomVariants: {
          retainedLegacy: ["cyan", "orange"],
          neededCurrent: [...new Set([profile.targetOverrides?.loom?.primaryFamily ?? "cyan", profile.targetOverrides?.loom?.secondaryFamily ?? "orange"])],
          disclosure: "Legacy cyan/orange Loom variants remain in the catalog; current profile variants are added or selected without removing them",
        },
        hoistDisposition: {
          status: "hoisted",
          preamble: "solar-tailwind-v4-preamble",
          source: "Pinned Solar Sail application CSS",
          layeredBody: "Solar :root/.dark rules plus the explicit application extension",
          disclosure: "The pinned Solar Tailwind preamble is retained byte-for-byte before the neutral application layer; only its rule body and application extension are layered",
        },
      },
    });
  }

  emit("runtime-baselines.ts", `/** Generated from the shared paired profiles; regenerate with the catalog producer. */\nexport const applicationBaselines = /*#__PURE__*/ Object.freeze(${JSON.stringify(applicationBaselines, null, 2)});\n`);
  const outputCatalog = {
    schema: "theme-forge.appearance-catalog-candidate.v1",
    status: inputs.catalog.status,
    defaultFamily: inputs.catalog.defaultFamily,
    modes: [...inputs.catalog.modes],
    engines: inputs.declaredEngines.engines.map(({ role, package: name, version, sha256: digest }) => ({ role, package: name, version, sha256: digest })),
    sttnTemplateSha256: sha256(inputs.templateSource),
    sourceIdentity: {
      schema: "theme-forge.appearance-catalog-source-identity.v1",
      pathBase: "repository-root",
      catalog: {
        path: "tools/source/appearance-catalog/catalog.json",
        bytes: Buffer.byteLength(catalogSource),
        sha256: sha256(catalogSource),
      },
      template: {
        path: "tools/source/sttn/v0.4/terminal-nova.theme.json",
        bytes: Buffer.byteLength(inputs.templateSource),
        sha256: sha256(inputs.templateSource),
      },
      profiles: inputs.catalog.profiles.map(declaration => {
        const supplied = profileById.get(declaration.id);
        return {
          id: declaration.id,
          path: declaration.id === "terminal-nova"
            ? "tools/source/terminal-nova.profile.json"
            : `tools/source/appearance-catalog/${declaration.id}.profile.json`,
          bytes: Buffer.byteLength(supplied.source),
          sha256: sha256(supplied.source),
        };
      }),
      engines: inputs.declaredEngines.engines.map(({ role, package: name, version, sha256: digest, integrity }) => ({
        role,
        package: name,
        version,
        sha256: digest,
        integrity,
        sha512: integrity,
      })),
    },
    families: reports,
  };
  emit("catalog.json", json(outputCatalog));
  inventory.sort(byPath);
  const outputInventory = {
    schema: "theme-forge.generated-appearance-inventory.v1",
    members: [...inventory],
    digest: sha256("theme-forge.generated-appearance-inventory.v1\n" + json(inventory)),
  };
  emit("inventory.json", json(outputInventory));
  return { files, catalog: outputCatalog, inventory: outputInventory, reports, applicationBaselines };
}
