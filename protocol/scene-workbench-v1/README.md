# Scene workbench v1 — TFSB63A implementation contract

Private unreleased Nebular 0.3 development work; package metadata remains 0.2.0.
Proposal disposition: **amend** the bound 29,802-byte proposal, SHA-256
`e64e2f05b94cfd624896831be4715508fe76a8745b8e27c592a1c90d41a83cee`.
The original TFSB63A scope controls. Review findings amend the implementation
contract; they do not replace that scope. The terminal closeout dispositions the bound producer and cumulative phase delta in the evaluation.

## Fixed native authority plan

Retain the existing 23 commands; add only these 18 commands (41 total).
Every command accepts a closed, path-free request under `request` and returns a
closed typed response. `Expected` binds sessionId, revision, draftInputDigest,
sourceId, tokenSnapshotId and engine identity. Native state owns all paths,
bytes, plans and local verification. Each permission is `allow-` plus the command
name with underscores replaced by hyphens, in main capability/window only.
Native scene smoke, scene state/runner tests and bidirectional command-set equality tests cover this table. Native selection through the actual macOS dialog is producer-attested only; the repository smoke harness does not automate the picker leg.

| Command | Request → response DTO | Rust owner / consumed authority | Fixed engine operation | Ceiling | Stale binding / side effect |
| --- | --- | --- | --- | --- | --- |
| studio_scene_new | SceneNewRequest → SceneDraftResponse | scene session / explicit replacement | canonicalize + compile | engine | Expected + replacement intent; new unsaved draft |
| studio_scene_status | SceneStatusRequest → SceneStatusResponse | scene cached state | none | status | current binding; no I/O or mutation |
| studio_scene_dispose | SceneDisposeRequest → SceneDisposeResponse | application lifetime (bridge exposed; no production UI caller) | cancel/reap | teardown | session tombstone; invalidate all handles |
| studio_scene_open | SceneOpenRequest → SceneSelectionResponse | selected JSON resource + scene session | canonicalize + compile | engine | Expected + replacement intent; selected canonical draft |
| studio_scene_import_svg | SceneImportSvgRequest → SceneImportResponse | selected SVG resource + scene session | sceneImportSvg + canonicalize + compile | engine | Expected + replacement intent; supported-only unsaved adoption |
| studio_scene_edit | SceneEditRequest → SceneDraftResponse | scene typed operations | none | edit | Expected; increment revision and invalidate evidence |
| studio_scene_compile | SceneCompileRequest → SceneCompileResponse | owned scene + serialized runner | canonicalize + compile | engine | Expected; current evidence only |
| studio_scene_save_plan | SceneSavePlanRequest → ScenePlanResponse | selected absent JSON destination | none | publication | Expected + destination identity; retained canonical bytes |
| studio_scene_save_apply | SceneApplyRequest → ScenePublicationResponse | retained one-shot save plan | none | publication | Expected + plan + destination; publish and rebind source |
| studio_scene_export_plan | SceneExportPlanRequest → ScenePlanResponse | selected absent SVG destination | none | publication | Expected + destination identity; retained current SVG |
| studio_scene_export_apply | SceneApplyRequest → ScenePublicationResponse | retained one-shot SVG plan | none | publication | Expected + plan + destination; publish without marking saved |
| studio_scene_bind_tokens | SceneTokenBindRequest → SceneDraftResponse | selected HostState project + token snapshot | fixed status/token-page; explicit subsequent compile | token | Expected + host generation + page identity; explicit snapshot |
| studio_scene_brief_create | SceneBriefRequest → ScenePacketResponse | scene exchange + draft | none | packet | Expected + packet identity; retain brief |
| studio_scene_packet_import | ScenePacketImportRequest → ScenePacketResponse | native selected packet | none | packet | Expected + packet/linkage identities; retain without adoption |
| studio_scene_packet_export | ScenePacketExportRequest → ScenePublicationResponse | retained packet + selected absent target | none | packet | Expected after picker; absent-only export |
| studio_scene_review_create | SceneReviewRequest → ScenePacketResponse | retained brief/candidate + typed review | none | packet | Expected + packet linkage; retain sender claims separately |
| studio_scene_candidate_verify | SceneVerifyRequest → SceneVerificationResponse | retained candidate + fixed runner | canonicalize + compile | engine | Expected + packet identities; local evidence handle |
| studio_scene_candidate_adopt | SceneAdoptRequest → SceneDraftResponse | current local verification | none | packet | Expected + verification; increment revision, unsaved, clear source |

## Ceilings and semantics

Control 64 KiB; edits 64 typed operations/1 MiB and resulting input 8 MiB;
scene/SVG import and canonical JSON 8 MiB; generated SVG preview **4 MiB**;
transport stdin 16 MiB, stdout 32 MiB, stderr 64 KiB; engine deadline 10 seconds.
Status excludes SVG/packet bodies and is bounded to 16 MiB. Terminate/reap deadline
3 seconds; unproven cleanup disables execution. Packet ceiling 16 MiB, text 64 KiB,
four retained packets/32 MiB. Color tokens at most 1,000, pages 128, aggregate
1 MiB, refresh deadline 10 seconds. One save and one export plan, five-minute
expiry. Publication uses synchronous local filesystem operations under the session reservation. The proposal's interruptible ten-second filesystem deadline is not claimed: standard filesystem calls cannot be safely interrupted under the current dependency/FFI boundary. Engine execution retains its enforced deadline.

Every accepted edit increments revision and invalidates compile, exchange and
publication evidence. Invalid drafts remain unsaved; only Burst validates scene
semantics. Edits are serialized and acknowledged. Preview compilation is explicit, avoiding an engine process per keystroke. The UI **flushes and awaits acknowledgement before save/export/brief/verify**.
Ordinary edits do not cancel the active compiler. Stale completion is discarded;
latest pending compile runs next. Dispose tombstones the session before cancellation.
Replacement intents also invalidate earlier open/import picker completions.

Save is **Save As only: every save creates a fresh file**, including an opened
scene. Plans retain exact bytes and selected parent/destination identities.
Absent-only publication uses exclusive same-parent staging and ownership-checked
cleanup; edit/dispose cannot pass the publication linearization reservation.
Success rebinds source identity/digest; no silent overwrite or automatic retry.
Caller-controlled filesystem ancestors remain the explicit threat boundary.

Each engine invocation re-authenticates the complete 62-member payload and hashes
the pinned 112,937,728-byte Node executable. This deliberate integrity cost adds
about 113 MB of logical reads per invocation plus payload reads; filesystem caching
may reduce physical I/O. No per-invocation timing benchmark is claimed. Verification
precedes the engine execution deadline and has no separate interruptible I/O bound.

Candidate verification handles are invalidated on every accepted draft mutation.
A candidate must be explicitly reverified at the current revision before adoption.
Export apply compares the retained plan digest to both the current SVG digest and
the digest of current SVG bytes before absent-only publication.

`studio_scene_dispose` is a terminal application-session action exposed on the
fixed bridge for lifecycle use and qualification. There is intentionally no
production UI caller: switching work areas preserves the session, New replaces
the draft, and Rust-owned application exit performs teardown. Once disposed, the
runner cannot reopen for that application lifetime. No reusable close/reopen UI
is claimed in 63A.

## Review amendments

Separate authenticated scene payload: deterministic package production, source
inventory digest and independent tarball/runtime/adapter pins; no private-checkout
fallback. Public composition transports only explicit authenticated build inputs,
never private evaluations or unrelated engine sources. Resources, ignore/clean,
builder, bundle receipt and composition exclusions must agree.

Prove the packaged executable closure cannot spawn descendants. Evaluate the
pinned Node permission flag as an additional invariant. Direct-child termination
and reaping do not constitute process-group signalling. Descendant capability
without a feasible contained execution contract blocks native integration.

Brand tokens with alpha other than FF are excluded with diagnostics; no silent
alpha removal into six-digit scene HexColor. Add a small host generation counter;
status only compares cached state, never refreshes the sidecar. Explicit rebind
copies values; brand changes never mutate the scene.

Briefs embed bounded canonical scene content for iterative agent handoff. Sender
claims remain separate from local compiled evidence. Import never adopts; verified
adoption never saves, exports or installs.

Persistent work areas are hidden/inert when inactive. Theme session disposal is
application-owned. Native smoke selects active work areas after label changes.
Preview is generated SVG in an image Blob URL; decode replacement before revoking
the last-good URL, and label stale previews without granting current evidence.

Policy production-file, process and filesystem lists receive explicit owners;
no forbidden-token exception or generic RPC/filesystem/process authority is added.
All command sets, handlers, generated permissions and bridge names must agree.
No public Burst exchange API, raster route, version promotion or 63B expansion.

## DTO and exchange schema ownership

The exact closed request/response declarations are in
[`protocol_dto.rs`](../../src-tauri/src/scene/protocol_dto.rs); the scene envelope and
closed edit union are in [`types.rs`](../../src-tauri/src/scene/types.rs). Frontend
readback validators are in
[`vector-graphics-bridge.ts`](../../src/features/vector-graphics/vector-graphics-bridge.ts).
Draft input identity is the SHA-256 of Rust's serialized typed input. Engine canonical
identity is separately carried by the compile receipt and retained canonical bytes.
Save publishes those engine bytes, never a reconstruction of canonical JSON.

[`exchange.rs`](../../src-tauri/src/scene/exchange.rs) owns the three version-one
packet envelopes. Export a brief before authoring a candidate. Copy its brief ID,
packet digest, selected source ID and token snapshot ID. Supply the typed candidate
scene plus scene/schema/compiler/profile/artboard identity and the installed engine's
canonical-scene, SVG, token and glyph-catalog digests. Sender provenance is a claim.
Native verification recompiles the candidate and compares these fields before issuing
an expiring local handle. Importing a packet never issues that handle or adopts a scene.

The fixed engine identity is `tfsb.vector-scene-v1:1:1`, authenticated by the separate
payload binding. Full source/snapshot option values are compared, including absence.
Save As rebinds to a digest of native file identity and invalidates other plans and
verification. Disposed sessions permanently close their runner and cannot restart.

Public composition requires the explicit `--scene-package` archive for a buildable
scene candidate; no published 0.5 package is inferred. The archive is transported under
`authenticated-inputs/scene-tarball/scene-input.tgz`; generated `src-tauri/scene-payload`
is ignored and excluded from source membership. `scene-prepare.mjs` verifies the pin
before extraction, and `scene-clean.mjs` authenticates the exact generated tree before
cleanup. Archive production uses `scene-input-build.mjs` with explicit input tarballs.
