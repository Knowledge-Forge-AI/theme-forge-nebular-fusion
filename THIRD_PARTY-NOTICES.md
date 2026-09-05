# Studio third-party notices

First-party Studio source is AGPL-3.0-or-later with a separately available
commercial license. Third-party packages retain their own licenses.

Direct runtime dependencies:

- Node.js 22.23.2 — MIT and bundled third-party terms; the complete upstream
  license is retained in `legal/node-LICENSE.txt` and copied into the sidecar.

- React and React DOM 19.2.8 — MIT.
- Tauri JavaScript API 2.11.1 — Apache-2.0 OR MIT.
- Tauri Rust crate 2.11.5 — Apache-2.0 OR MIT.
- Serde 1.0.229 — MIT OR Apache-2.0.
- Serde JSON 1.0.151 — MIT OR Apache-2.0.
- SHA-2 0.10.9 — MIT OR Apache-2.0.
- Tauri dialog plugin 2.7.2 — Apache-2.0 OR MIT. Its native picker graph
  includes `rfd` 0.16.0 and platform bindings; the exact inventory and
  checksums are in `src-tauri/Cargo.lock`.

Direct build and test dependencies:

- Tauri CLI 2.11.4 — Apache-2.0 OR MIT.
- Tauri build crate 2.6.3 — Apache-2.0 OR MIT.
- Vite 8.2.2, Vitest 4.1.11, React Testing Library 16.3.3,
  user-event 14.6.6, jsdom 30.0.1, and React type declarations — MIT.
- TypeScript 7.0.2 — Apache-2.0.

`package-lock.json` and `src-tauri/Cargo.lock` are the exact transitive
inventories for this phase. This file summarizes direct dependencies and does
not replace their license texts or the coordinated release SBOM/notices gate.

The generated sidecar payload separately carries the exact root, Node,
directory-snapshot native, raster companion, and resvg legal records selected
by its closed manifest. Generated payload and runtime bytes are not tracked.
