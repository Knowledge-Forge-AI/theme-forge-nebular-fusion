# Appearance matrix expectations preparation

Status: **isolated source preparation only**. This directory provides a
stdlib Node generator, its compact generated 12-row role table, and focused
generator tests. The proposal release-smoke Rust source now includes this
fixed JSON projection only for `PairedV2`; receipt DTOs, budgets, ordinary
scenarios, the browser driver, harness, command inventory, dependencies,
provider, host, and campaign state remain unchanged.

## Inputs and closed output

The generator reads these maintained public inputs:

- `frontend-fixture/src/features/appearance/generated/runtime-baselines.ts`;
- `frontend-fixture/src/features/appearance/generated/catalog-index.json`.

`runtime-baselines.ts` is treated as an embedded `Object.freeze(JSON)` object.
The generator extracts that object and parses it with `JSON.parse`; it never
evaluates TypeScript or executes CSS. The catalog index is required to contain
the exact six-family order:

```text
terminal-nova, nebular, developer, graphic-designer, anime, gamer
```

For every family and both `light`/`dark` modes, the generator follows the
ordered stylesheet cascade and emits these six owned roles:

```text
--background
--primary
--tf-appearance-font-ui
--tf-appearance-radius-surface
--tf-appearance-selection
--tf-appearance-selection-text
```

Light values come from the closed `:root` declarations. Dark values use the
matching `.dark, :root[data-theme='dark']` declaration when present and the
light root value when the generated CSS intentionally leaves that role
unchanged. Duplicate declarations within a cascade layer, missing required
light values, and unsupported dynamic values (`var`, `calc`, `env`, or `attr`)
are rejected.

The generated JSON freezes the runtime and catalog source SHA-256 values,
the declared catalog source digest, the role order, all 12 ordered rows, and a
canonical-row digest. It is compact JSON so a future closed source projection
can include it without a runtime filesystem read.

## Local source checks

From the maintained checkout root, the existing pinned Node executable may run:

```text
node tools/appearance-matrix-prep1/generate.mjs --checkout-root .
node --test tools/appearance-matrix-prep1/test/generate.test.mjs
```

The generator defaults are checkout-local (`process.cwd()` or the explicit
`--checkout-root`), and all three paths remain overrideable for a bounded
projection check. It does not climb to a private proposal fixture. The
maintained runtime include is written to
`src-tauri/src/release_smoke/appearance-role-expectations.v1.json` by default.

The tests exercise actual parsing and cascade behavior, not a regex mirror:

- twelve rows and catalog order, including verification of the committed
  generated artifact;
- dark override plus root fallback for roles omitted by a dark block;
- missing required role rejection;
- ambiguous duplicate declaration rejection;
- dynamic value rejection;
- catalog order drift rejection;
- stale source digest rejection.

## Future integration seam

The proposal integration is the equivalent fixed JSON include at
`native/release_smoke/appearance-role-expectations.v1.json`, referenced with
Rust `include_str!` by `native/release_smoke/mod.rs`. The existing smoke config
adds the closed `appearanceExpectations` key only for `PairedV2`; ordinary
scenarios keep their prior `{ scenario }` config. The source is parsed and
validated before webview evaluation, with no runtime filesystem read, new
native command, or new scenario input. The projection remains generated
source output rather than a hand-maintained color table.

## Verification boundary

The generator syntax check and its eight Node tests were run with the existing
stdlib toolchain. No Cargo/Rust, browser, native, provider, hosted, dependency,
metadata, lockfile, or cache operation was performed.

