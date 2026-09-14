# Theme Lab v2 native authority

The inventory grows from 41 to 42 fixed commands. The exact names and handlers
remain owned by `src/command_inventory.rs`, `src/lib.rs`, command modules,
generated permissions and the main-window capability; this document does not
duplicate that inventory.

| Command | Request / response | Rust owner | Selected resource | Loom operation | Limits / freshness | Side effects | Permission / tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `studio_theme_lab_draft_update` | `{sessionId, uiRevision}` / `{uiRevision}` | commands/theme_lab, state/theme_lab | None | None | Same session, strictly increasing revision; frontend coalesces pending changes | Mark dirty, revoke adopted evidence, invalidate late operations; retain the selected save-file association | Main window only; runner ordering tests, inventory/policy negatives, frontend bridge tests |

Ordinary invalid field edits may never reach compilation. This command makes
those edits visible to native freshness checks before a pending compile, save or
adoption can finish. It provides no file, process, packet or executable selection.
Adoption clears file association separately and produces an unsaved draft.

Compile/open/save reuse their fixed owners with typed v1/v2 documents. V2
compilations require an exact semantic/catalog tuple, ordered style inventory,
concatenated CSS hash and inventory digest. Historical v1 packets retain their
original parser and strict compiler-version behavior.

The three accepted semantic/catalog tuples in `src/theme_lab/validation.rs`
pin exact core, code and component catalog digests. This is an intentional
maintenance coupling: a legitimate catalog rebuild can be rejected with
`SidecarProtocolInvalid` even when compiler package compatibility is unchanged.
A legitimate rebuild requires this complete operational sequence:

1. Explicitly update the authenticated Loom candidate.
2. Update the exact accepted semantic/catalog identity and digest pins.
3. Rebuild the gallery from installed generated packages.
4. Rerun installed-package parity for the represented properties.
5. Requalify packaged Nebular, including its effective preview CSP.

Updating package metadata or payload authentication alone is insufficient.
Matching package SemVer or a similar semantic level does not authorize a changed
catalog identity or digest; negative validation tests must continue to fail
closed. Never loosen digest checks to recover compatibility.

The application-owned adapter lives beside `loom-payload`, outside its `dist/bin`
executable identity. Packaged discovery uses only fixed bundled resource paths;
no checkout fallback is permitted. Adapter authentication compares regular-file
bytes with the compile-time source binding and refuses symlink ancestry before
execution. The source-owned `protocol/theme-lab-v2/payload-binding.json` binds
all 322 installed package members and the Node runtime to accepted archive
bytes. Authentication runs inside the serialized execution slot immediately
before spawn, with cancellation checked again afterwards. It does not require
the Burst scene payload to exist. Packaged qualification remains separate.

V2 review context is `tfsb.theme-review-context-v1`, a Nebular-owned record linked
to the exact candidate digest. It is not a Loom v2 brief or review packet. Local
verification regenerates the package inventory; adoption re-verifies and checks
the session revision before changing the draft. No installation or file save is
performed during adoption.

No local-font picker or generic resource command is added. Logical declarations
are preserved; system fonts are supported. Arbitrary font materialization lacks
a selected-resource lifecycle and remains unavailable with a diagnostic.

## Preview resource policy

Only `/preview/gallery/` responses receive an opaque-frame CORS allowance and
local `tauri://localhost` asset directives for scripts, styles, fonts and offline
Pagefind requests. The preview policy removes IPC endpoints, forbids child
frames, external resources, form actions and base changes, and preserves script
hashes supplied by Tauri. The main-window policy remains unchanged. No local-font
Blob delivery is enabled by this policy; bundled licensed fixture fonts alone are
qualified. Tests own exact preview-policy separation and native command denial.

The gallery manifest's `sandboxSecurity.harnessOnlyCspPolicy` records only the browser
harness/meta policy. The packaged app additionally applies the header policy
constructed by `adjust_preview_csp`, retaining the Tauri-supplied script
directive and any build-supplied hashes. Both policies constrain the document.
Browser-harness observations do not prove the packaged effective policy; that
requires separate packaged bridge/command-denial evidence and policy readback.


The closed gallery coverage and bridge contract is owned by
`src/features/theme-lab/gallery-contract.ts`. Preparation materializes
`gallery/bridge-runtime.mjs` with that contract; its literals are generated data.
The manifest binds coverage source, exact installed input/output, fixture source,
bridge bytes and the common prepared documentation route. Hero pages are separate
axis representatives; their complete prepared content remains in the manifest.
Legacy v1 preview scripts are generated by the existing Loom fixture owner and
are explicitly outside the v2 gallery contract; the sender retains a separate
bounded v1 acknowledgement validator. Neither path accepts a selectable native
command. The v2 denial canary reports reachable native handles as failure without
invoking them; its command identity is always `studio_theme_lab_status`.

The `native-smoke` feature records the actual gallery HTML response after Tauri
policy adjustment. Host receipts bind the served document digest and header;
the runner separately binds the executable digest and launch mode. Opaque-frame
and bridge execution evidence comes from the actual frame, not the header alone.
This instrumentation adds no production command and does not alter capabilities.
