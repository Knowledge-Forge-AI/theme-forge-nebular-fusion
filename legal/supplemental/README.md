# Supplemental dependency license material

These files supplement published crate archives that omit license text. Each
record binds the crate name/version, the source revision recorded in its
published `.cargo_vcs_info.json`, and the URL, byte count and SHA-256 of each
retained notice. The generator verifies these digests before packaging.

Upstream objc2 supplies a license-selection and Apple SDK disclosure in
`LICENSE.md`. Its linked MIT terms are also retained from the versioned SPDX
license text collection. Those standard terms do not assert a new copyright
holder or year; the upstream declaration remains controlling. Upstream Apple
SDK disclosures are preserved verbatim and are not an independent legal opinion.

Selectors is MPL-2.0. The Mozilla license text is retained, and its unmodified
source is available as the published selectors 0.36.1 crate and the exact upstream
revision recorded in the manifest. No dependency source is modified here.

## Distributed preview frontend runtime

The `frontendPackages` records cover only code and search assets that are emitted
into the distributed Astro preview: `astro@7.3.3`, `@astrojs/starlight@0.42.0`,
`pagefind@1.5.2`, and `@pagefind/default-ui@1.5.2`. Each record joins a held,
hashed package manifest and the exact current Stellar Loom fixture package lock;
each retained license file is size- and SHA-256-bound before generation. The
fixture binding has one explicit source context for the monorepo
(`packages/stellar-loom/fixture`) and one for the composed public tree
(`loom-preview-source`); the generator rejects missing or ambiguous layouts.

The Pagefind default UI record retains the Pagefind MIT text because its
published package has no standalone license file; the source package identity is
recorded explicitly. Pagefind's generated `pagefind-highlight.js` also carries a
verbatim mark.js v8.11.1 MIT banner; that exact banner is retained as
provenance alongside the complete authenticated mark.js MIT text. The full
record is bound to the `julmot/mark.js` repository, revision/tag `8.11.1`, and
its `LICENSE` source URL in the manifest; the text digest is checked before
generation.

The generated Pagefind UI JavaScript/CSS and the `_astro/ui-core` member contain
compiled Svelte output traced to the five `@pagefind/default-ui@1.5.2` Svelte
source files. The emitted JavaScript also contains the Svelte 4.2.20 runtime and
the BCP 47 parser with its `is-alphabetical`, `is-alphanumerical`, and `is-decimal`
helpers. Their exact MIT texts and copyright notices are retained under the
default-UI notice directory. The manifest binds these versions to Pagefind
v1.5.2's `pagefind_ui/default/package-lock.json`, while the source and emitted
member hashes remain recorded under `embeddedProvenance`. `esbuild-svelte` is a
build-only input and is intentionally not classified as a shipped runtime
component. Astro compiler bindings, Pagefind platform binaries, MDX/Prism/
Sitemap tooling, and other compiler/build inputs are likewise excluded.
