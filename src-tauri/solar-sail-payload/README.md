# @knowledge-forge-ai/theme-forge-solar-sail

Deterministic theme compiler, library, and `tfss` CLI for Tailwind CSS v4 and shadcn/ui application theming. Sibling engine to Theme Forge Stellar Loom.

This source describes version 0.3.0.

## Overview

Theme Forge Solar Sail translates declarative theme specifications (`tfss.theme-v1`) into:
- **Tailwind CSS v4 `@theme inline` configuration**: Emits clean CSS theme variables directly compatible with Tailwind v4's stylesheet-first engine.
- **shadcn/ui semantic roles**: Maps tokens to standard component roles (`background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, and optional chart tokens).
- **Light and dark theme support**: Emits scoped `:root` and `.dark` / `@custom-variant dark (&:is(.dark *))` styles.
- **Radius progression**: Defines full radius scales from `--radius-sm` through `--radius-4xl`.
- **Actionable diagnostics**: Verifies color contrast ratios against background tokens and reports missing role warnings.
- **Standalone distribution packages**: Generates self-contained packages in TypeScript or zero-build JavaScript that require zero runtime dependencies on Solar Sail or any external service.

## Installation

Install as a development dependency:

```bash
npm install --save-dev @knowledge-forge-ai/theme-forge-solar-sail
```

Or invoke the CLI via `npx`:

```bash
npx tfss --help
```

## CLI Usage

The `tfss` CLI provides three primary subcommands:

### 1. Validate a Theme Specification

Validates theme schema conformance, ensures required color roles are defined, and evaluates contrast diagnostics:

```bash
tfss validate path/to/theme.json
tfss validate path/to/theme.json --json
```

### 2. Compile to CSS

Compiles a theme specification into standalone CSS stylesheets:

```bash
tfss compile path/to/theme.json --out dist/styles
tfss compile path/to/theme.json --json
```

Emits:
- `theme.css`: Complete Tailwind CSS v4 and shadcn/ui custom properties.
- `theme.descriptor.json`: Deterministic SHA-256 digests of inputs and outputs.

### 3. Generate a Standalone Distribution Package

Generates a complete, installable npm package:

```bash
tfss generate path/to/theme.json --package path/to/package-metadata.json --out packages/my-app-theme --language typescript
```

Options:
- `--package <path>`: Path to package metadata JSON (`name`, `version`, `description`, `license`).
- `--out <dir>`: Target directory (must be empty or absent for safety).
- `--language <typescript|javascript>`: Emission language mode (default: `javascript`).
- `--json`: Structured machine-readable output.

## Package Architecture & Modes

Generated theme packages are completely self-contained:
- In **TypeScript mode** (`--language typescript`), emits `src/index.ts`, `tsconfig.json`, and builds compiled distribution files in `dist/`.
- In **JavaScript mode** (`--language javascript`), emits zero-build `index.js` and `index.d.ts` entry points.
- Neither mode requires Solar Sail, Nebular Fusion, or private repository packages at consumer runtime.

## Programmatic API

```typescript
import {
  compileTheme,
  validateThemeSpecification,
  generateThemePackage,
  type ThemeSpecification,
} from "@knowledge-forge-ai/theme-forge-solar-sail";

// Validate
const validation = validateThemeSpecification(themeSpec);
if (!validation.valid) {
  console.error("Diagnostics:", validation.diagnostics);
}

// Compile CSS
const result = compileTheme(themeSpec);
console.log(result.css); // Compiled Tailwind v4 @theme inline block + custom properties

// Generate Package
const pkg = generateThemePackage({
  themeSpec,
  metadata: { name: "my-theme", version: "1.0.0" },
  language: "typescript",
});
```

## Boundaries & Limitations

- **Theme Backend Only**: Solar Sail is a deterministic theme backend and compiler. It generates CSS tokens, radius scales, and package envelopes. It does **not** generate arbitrary React/TSX application code or UI component implementations.
- **Tailwind v4 First**: Output stylesheets are targeted for Tailwind CSS v4 `@theme inline` and standard CSS custom properties.
- **Filesystem Safety**: Package generation requires the target directory to be absent or completely empty to prevent accidental overwrites.

## License

This project is licensed under the GNU Affero General Public License v3.0 or later. See `LICENSE` and `NOTICE`. Commercial licensing terms are available; see `COMMERCIAL-LICENSE.md`.

## v1 validation and compatibility contract

`tfss.theme-v1` is a closed semantic schema. Unknown top-level, palette-mode,
surface, typography and color-role fields fail validation. The supported optional
roles are `chart1`–`chart5` and the canonical `sidebar*` roles in `ColorTokens`;
these must occur in both modes. Arbitrary custom roles, aliases such as
`sidebar-background`, spacing, tracking and shadow fields require an explicit
adapter and are not silently dropped. The former generated declaration index
signature was broader than the source contract and has been corrected.

The supported color subset is hex (3/4/6/8 digits), numeric RGB/HSL/OKLCH functions
and bounded CSS variable references with supported color fallbacks. Declaration
escapes, comments, invalid components and nonfinite numbers fail. RGB channels,
saturation/lightness and alpha are range-checked; finite hue angles and nonnegative
OKLCH chroma have no additional magnitude cap. Gamut conversion and hue
normalization are not performed.
Other CSS color grammars are unsupported. Alpha and non-hex contrast remain
`UNEVALUATED_CONTRAST`; that is not an accessibility pass. Font stacks support
quoted names and ordinary multiword names. Nested color indirection such as
`hsl(var(--x))` / `rgb(var(--x))` and font indirection such as
`var(--font-geist-sans), sans-serif` are unsupported; resolve those references
in an explicit adapter before validation. A standalone color `var(--x)` remains
supported. Radius and border values use the
validator's nonnegative CSS length subset; executable expressions are unsupported.
No new spacing, tracking or typography-scale model is introduced.

`parseThemeJson(bytesOrText)` rejects duplicate decoded keys, malformed UTF-8,
BOM and unsafe JSON within a 1 MiB/depth-20 bound. CLI input uses this boundary.
Library object inputs cannot recover duplicates already lost by another parser.
Library validation rejects accessors without evaluating getters, hidden/symbol
properties, custom prototypes, cycles and nonfinite numbers, and returns owned,
deeply frozen theme data. This is a plain-data contract, not a sandbox for hostile
JavaScript proxies. Use the byte parser for untrusted external documents.

Validated token spelling, including ordinary surrounding spaces, remains
identity-bearing; equal visual appearance does not imply equal digest. CSS token
strings and description/author fields reject C0, DEL and C1 controls before
trimming. Human CLI output escapes terminal controls; JSON preserves their data
meaning using JSON escaping. Generated README descriptions encode Markdown
punctuation and leading whitespace as text.

Security corrections may reject
previously accepted malformed data. Compatible additions must preserve maintained
valid fixtures and declared digest projections. New unsupported intent must produce
an error or a mapping report. A schema version or migration is required for a new
incompatible semantic contract; no v2 migration is implied here. The chart mapping
correction emits `--chart-1` / `--color-chart-1` from `chart1` (and likewise 2–5).
Callers relying on the old accidental `--chart1` spelling must update their CSS.

## Mapping coverage and source provenance

Use the additive report or byte-bound API at orchestration boundaries:

```ts
import { bindSourceProfile, generateThemePackage } from
  "@knowledge-forge-ai/theme-forge-solar-sail";

const bound = bindSourceProfile(profileBytes, { expectedSha256 });
const { specification, report } = bound.mapToSolarSail();
// Present/disposition report.entries before adoption; unsupported != consumed.
const generated = generateThemePackage({
  themeSpec: specification,
  metadata: { name: "@example/application-theme", version: "1.0.0" },
});
```

Reports retain source paths, target paths where mapped, values, and reasons for
`consumed`, `unsupported`, `target-specific`, `overridden`, `normalized` and
`degraded` dispositions. No color conversion is claimed. Solar surface overrides
win over shared values explicitly. Reading width and Loom/syntax intent remain
visible as unsupported or another target's intent. Unknown Solar-specific override
leaves require the report API; the bare mapper rejects them.

`summary.totalLeaves` currently counts report entries, including synthetic defaults;
it is not a unique source-leaf count. An empty description can have both consumed
and normalized entries, and empty override containers can be reported unsupported.
Disposition entries individually. `mapToSyntaxPalette()` remains a legacy value
projection with no coverage report; do not use it to certify cross-target coverage.
These report-shape refinements are deferred to B2.

Library error constructors other than `FilesystemSafetyError` are not exported
from the package root in this candidate. `StaleProvenanceError` identifies itself
by `Error.name` and carries expected/actual hashes, but public `instanceof`
discrimination and a unified library error taxonomy remain deferred. The CLI
JSON taxonomy is separately stable. `writeCssFile` is CLI-internal, not a root
library export.


`bindSourceProfile` verifies SHA-256 against the actual bytes and freezes the
profile deeply. `normalizedSha256` hashes canonical paired JSON; it is a separate
identity from exact source bytes, and is representation-normalized, not a claim
that all CSS-equivalent colors or font strings are semantically equal. `transform`
validates a new profile, binds its canonical serialized bytes, and retains the
prior raw hash as `parentSourceSha256`. A changed profile cannot inherit the old
current source hash. Serializing `canonicalizeJson(transformed.profile)` reproduces
those transformed source bytes.

Bare v1 mappers keep their return shape. Embedded `sha256` or
`sourceProfileSha256` fields are rejected as unknown authority. An explicit legacy
Solar `sourceProfileSha256` option and a direct theme field remain **caller
assertions**, never evidence that bytes were verified. For Loom, pass the companion
`sourceProfileSha256` from `bound.mapToStellarLoom(baseCatalog)` explicitly to
`compileThemeCatalog(catalog, { sourceProfileSha256 })`. Catalog objects carry no
hidden hash; the old bare Loom provenance option is rejected with guidance to
use the explicit compiler option. Bare mappers are not loss-reporting adoption interfaces; consumers
must use the additive report APIs to certify coverage.

## Identity and determinism domains

| Identity | Exact v1 meaning |
| --- | --- |
| Profile source hash | SHA-256 of exact verified source bytes; whitespace matters. |
| Normalized profile hash | SHA-256 of recursively `localeCompare("en")` key-sorted, two-space JSON with one LF. Arrays retain order. |
| Compiler input digest | SHA-256 of that canonical JSON encoding of the validated Solar theme, including any caller-supplied source hash. |
| Compiler output digest | SHA-256 of exact generated CSS bytes. |
| Descriptor inventory digest | SHA-256 of canonical `{ inputDigest, outputDigest, name, version }`. |
| Package inventory digest | SHA-256 of `tfss.package-inventory-v1\n` followed by compact `JSON.stringify` of path/size/hash records sorted with `localeCompare("en")`. |
| Provenance hash | SHA-256 of the emitted `provenance.json` bytes. That file excludes itself from its file inventory to avoid a cycle. |
| Generation invocation digest | Domain-prefixed canonical `tfss.generation-invocation-v1`: validated theme, effective metadata/defaults, language and compiler name/version. |

`describeGenerationInvocation(options)` returns that complete direct-generator
invocation plus every generated file's size/hash, including provenance. It names
the two different inventory domains separately. Destination and overwrite policy
are execution inputs, not generated-content inputs. Package metadata and language
are content inputs. Compiler name/version identifies release code; qualification
must also bind the actual source/build used while a candidate retains the same
version. The maintained qualification receipt records the compiler source inventory
and Node/ICU version. Existing locale ordering is preserved, not replaced with the
Design Director's byte ordering.

Equal complete direct invocations under the qualified compiler/runtime produce
equal emitted source-package bytes. This does not certify subsequent build/npm
archive reproducibility, cross-runtime locale equivalence, or source-to-package
reproducibility from equal paired-profile/delta claims. Profile application,
ordered transformations, defaults and mapping policy must also be bound for that
larger claim. Incidental formatting is not a universal compatibility promise;
changes to an identity-bearing encoding require explicit compatibility disposition.

## Structured CLI failures and filesystem contract

In `--json` mode, each invocation emits one JSON result on stdout. Success fields
remain available; failures have `status: "error"`, `command`, `code`, `message`,
and validation details where relevant, and exit 1. Codes are `ARGUMENT_ERROR`,
`PARSE_ERROR`, `VALIDATION_ERROR`, `UNSUPPORTED_INTENT`, `DIAGNOSTIC_FAILURE`,
`FILESYSTEM_SAFETY_ERROR`, `IO_ERROR`, and `INTERNAL_ERROR`. Error prose is not a
stable parser interface. Warnings/info remain nonfatal by default;
`--fail-on-diagnostics` explicitly fails on contrast warnings or unevaluated
contrast before writing. Human mode retains diagnostic text.

Package generation accepts absent or empty destinations. It rejects traversal,
absolute/member separator ambiguity, case/Unicode collisions, file/directory
prefix conflicts, symlink destinations/ancestors and nonempty destinations even
with the legacy library overwrite option. Use physical paths: system alias
symlinks are also rejected. Package names never determine filesystem destinations.
Cooperating writers reserve an empty directory exclusively; every file uses
exclusive creation. On I/O failure, rollback checks identity and removes only
unchanged entries created by that invocation, preserving prior empty directories.
Cleanup failure is reported, never relabeled success or hidden by recursive removal.

Package files become visible incrementally; this is not crash-atomic publication.
A crash may retain partial files and the reservation marker. Inspect and remove
only the abandoned invocation's owned state before retrying. Portable Node path
APIs cannot prevent a hostile concurrent actor replacing parent directories between
checks; parent directories must remain trusted and stable for the operation.
There is no hostile-same-user confinement claim. CSS `compile --overwrite` stages
and checks a regular-file replacement; without it, existing bytes are preserved.
JSON/TypeScript serialization, CSS grammar checks, constrained package names,
README escaping and independent file-map validation each own their output sink.

## Paired Profile v2 checkpoint

The private B2 [paired protocol](../../protocol/tf-paired-profile-v2/README.md)
defines neutral semantic groups and separately named target adapters. Existing
paired v1 functions and historical identities remain maintained. V2 requires
explicit version migration, source-byte binding and capability reports; it is
not a silent replacement for v1. Unsupported intent remains visible.

Loom pixel geometry does not imply rem/em conversion, and font families require
explicit font-ID bindings. Code/syntax mapping is part of the report. Solar
component/sidebar/chart vocabulary stays in target-only overrides. Complete
invocations additionally bind base inputs, final configuration, generation
options and compiler identity. Report or profile equality alone is insufficient.

See the [B2 evaluation](../../docs/evaluations/tfsb71b2-paired-profile-candidate-set.md)
for qualification and limitations. Current Studio ingestion/adoption is not
qualified for v2. No release or adoption authorization is implied.

The additive v2 root API includes `validatePairedProfileV2`,
`bindSourceProfileV2`, `canonicalizeProfileV2`, `migrateV1ToV2`,
`migrateV2ToV1`, `applyRecipe`, `classifyProfileError`, `ERROR_CODES` and the
schema/adapter constants and associated types listed in the protocol reference.
Migrations and recipes take source bytes, not parsed-object assertions. Bound
profiles expose `mapToSolarSail()` and `mapToStellarLoom(explicitInputs)`; the latter
returns catalog, syntax and one source-leaf capability report. Native generation
still uses the independent target library. V2 does not extend the CLI or Studio
file-open contract. Protocol Markdown remains repository documentation, not a new
npm shipped directory.

V2 report provenance distinguishes `source-bytes`, `transformed` (canonical bytes
created by a bound transformation), and `serialized-profile`. Group applicability
states adapter capability independently of supplied leaves. Generated-default
counts include only defaults surviving source projection and explicit overrides;
source-derived syntax/chrome colors are not defaults. Validation preserves authored
color spelling and returns a detached frozen object without freezing caller data.


## Next-release package distribution

The maintained public source composition includes `DISTRIBUTION.md`,
`release-layout.json`, a locked first-party flake and an installed-package probe.
Use that public source for sibling-free builds. See
[the public distribution guide](DISTRIBUTION.md) in composed releases; in the
private development tree the source is `docs/operations/loom-solar-distribution.md`.
The three required systems are Apple Silicon macOS, Linux ARM64 and Linux AMD64.
Declared packaging coverage and qualified native execution remain separate gates.
