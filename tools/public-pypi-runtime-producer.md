# Public Linux PyPI runtime lane

`.github/workflows/native-pypi-runtime.yml` is the public-hosted Linux lane
for the PyPI intake boundary. It checks out the producer/workflow revision
under `.producer`, then checks out the frozen product source
`cadb40c4972f68f314096ff60fbcfb4da950c161` (tree
`27c643b6375c2aafde314799c4f08e844c14992c`) under `product-source`. It builds
and qualifies the existing Linux
application payload on `ubuntu-24.04-arm` and `ubuntu-24.04`, then emits the
raw archive, npm archive, runtime receipt, native qualification, build receipt,
package records, smoke receipts, and a `public-pypi-runtime-release-v1`
receipt. It does not create a wheel and does not publish to PyPI.

The workflow is manually dispatched with an exact public source commit and the
asset ID, byte size, and SHA-256 of one closed runtime-input manifest. The
producer fetches that manifest and one exact per-target runtime archive named
by it through GitHub's release asset API. URLs are derived from numeric asset
IDs; arbitrary URLs, query
strings, user information, non-GET methods, and token-bearing redirects are
not accepted. Every response is streamed into an exclusive file and checked
against the manifest's size, SHA-256, and SRI before it is used.

The runtime archive is a runtime-only authenticated envelope containing
`native-runtime.json` and `opt/nebular-private`. The checked-in
`tools/public-runtime-input.py` helper performs raw gzip/tar header preflight,
held-file-descriptor hashing, bounded extraction, manifest/member-list checks,
and the maintained runtime authentication API. It then writes a fresh
runner-local descriptor whose `sourceRoot` points at the authenticated
extraction, plus a closed manifest and runtime-only receipt. No product bytes
are included and no native execution is claimed by this input stage. The
frozen product checkout's `tools/native-runtime.mjs` API authenticates that
local descriptor and source snapshot before the product build. The
source-origin receipt records both identities: product commit/tree and
producer/workflow commit/tree. It binds the public commit/tree, workflow/run
identity, closed manifest identity, the selected release archive, its source
custody/release evidence, and the maintained runtime material digest. The
producer and product identities must not be silently collapsed into one source
claim.

The native build and qualification remain the maintained `build-app.mjs`,
`native-rc-qualify.mjs`, `native-rc-package.mjs`, and
`native-rc-evidence.mjs` contracts. ARM runs the existing scenario-B raw/npm
smokes; x64 runs scenario-C raw and scenario-C-signal npm smokes. All output
is uploaded only after the candidate bytes, package manifest, runtime input,
qualification, build source, executable, native-payload/material, and smoke
receipts agree for the same target. The producer reconstructs the maintained
package payload identity, including the Linux runtime-alias projection, before
writing the release receipt; a failed join is a hard failure. A failed lane
may upload bounded diagnostics, but no failed result is a PyPI admission claim.

The workflow's container steps explicitly select Bash. GitHub Actions
container jobs otherwise default to the runner's shell, while these maintained
steps use Bash strict mode and bounded shell pipelines.

The release manifest and per-target archive asset IDs are intentionally
late-bound: they must be supplied from the same public release publication
operation. The closed manifest carries the canonical archive byte/SHA,
member-list SHA, embedded-manifest SHA, material digest, corresponding source
custody SHA, and release-asset SHA; the runner generates the descriptor rather
than trusting an absolute source path from a downloaded file. This workflow
contains no fallback to local private runtime paths, SDK images, private R3B
identities, or an unauthenticated download.
