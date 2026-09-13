# Source Code Pro qualification fixture

Unmodified regular 400 WOFF2, family `Source Code Pro`, selected solely for
first-party offline browser qualification. This is a font resource fixture, not
a runtime dependency or provider interface.

The font and full copyright/license notice were independently byte-compared
with the immutable Rust source revision
`1159e78c4747b02ef996e55082b704c09b970588` (Rust 1.90.0).
[Upstream font](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/src/librustdoc/html/static/fonts/SourceCodePro-Regular.ttf.woff2)
and [upstream notice](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/src/librustdoc/html/static/fonts/SourceCodePro-LICENSE.txt).
`provenance.json` binds member paths, byte counts and SHA-256 hashes.

Redistribution follows the included SIL Open Font License 1.1: retain the full
copyright and license text, keep the font under that license, do not sell the
font by itself, and respect the reserved name for modifications. The fixture
contains unchanged upstream bytes; no conversion, subsetting or renaming of the
font family is performed. The font is not relicensed under Loom's AGPL license.

Generation consumes only explicitly selected materialized bytes. The catalog
must emit the full license text with the font and bind both in its generated
inventory and exchange evidence. No provider executes and no remote runtime
request is needed. Hash and WOFF2-header checks alone do not qualify rendering;
the installed-browser scenario must additionally prove actual decoded glyph use.
