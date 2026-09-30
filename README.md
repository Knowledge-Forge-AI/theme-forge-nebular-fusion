# Theme Forge Nebular Fusion

Candidate version: 0.6.1.

Nebular is a Tauri desktop workbench for Theme Forge. The maintained candidate
version authority is package.json; Cargo and Tauri metadata are checked against it.
The source-build targets are aarch64-darwin, aarch64-linux and x86_64-linux.

The R3A source-build architecture is under qualification. Materializing source
does not establish a successful native build or installed GUI qualification.
Toolchains are explicit environment/Nix inputs. Burst, Loom and Solar are
declared component inputs; Scene and application resources are build outputs.
The tfnf --path contract identifies the absolute native GUI executable selected
by normal launch. No publication is performed by source or native preparation.

See LICENSE, NOTICE and COMMERCIAL-LICENSE.md for licensing terms.
