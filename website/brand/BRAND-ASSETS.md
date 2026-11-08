# Nebular Fusion public asset inventory

This inventory covers the static public identity assets served with the TFNF site. Paths are site-relative and hashes are SHA-256 over the exact checked-in bytes. The inventory is intentionally separate from software licensing guidance.

## Identity and static-site assets

| Path | Role | Dimensions / format | SHA-256 | Notes |
| --- | --- | --- | --- | --- |
| `./favicon.svg` | Accessible compact mark | 64×64 SVG, 737 bytes | `551a960269778552b719d355596f9b681a95f5ff85171d23885fa1476b648ece` | Original Nebular Fusion text/glyph asset; no NovaIngot or external resource. |
| `./social-preview.svg` | Editable social metadata preview source | 1200×630 SVG, 1,563 bytes | `1d1c3305cb2de2cea38ad97cf8b30d159401706f30d1da7837def60c760b97c0` | Text and geometric layout only; not artwork and does not claim that appearance families shipped in 0.7.1. |
| `./social-preview.png` | Social metadata delivery asset | 1200×630 PNG, 40,711 bytes | `9c22cbe146453142cc3f03b2f2693f564916e1cb710cefa9f871e2290c78ea9d` | Deterministic raster of the editable SVG; the appearance boundary remains unchanged. |
| `./index.html` | Product page metadata/wordmark/footer | HTML, 34,078 bytes | `7eedbf76e311e917e3662efeceacd0ea027b678fde3dd8f4cd1fddf657dc405f` | Canonical URL, description, Open Graph/Twitter metadata, separate brand links, and the clearly bounded browser-proof figure. |
| `./styles.css` | Site palette and typography tokens | CSS, 38,567 bytes | `5a45e258b278b5a3286bfe63f821f1113bd537671650c27f8e34e782510288ec` | Site implementation tokens, hidden-state rule, and responsive browser-proof card; software terms apply. |
| `./404.html` | Missing-page boundary | HTML, 1,662 bytes | `ad2b25f3470c1a337c46c6b2363411d020e5bb74c88a7687511dc197aa0527ff` | Root-safe links, noindex, source/product/install recovery links. |
| `./robots.txt` | Crawler policy | text, 23 bytes | `16ceb5ee3e0dc13aa9adf31a3ebbe45a1d965b8c2b9f72eaf84e5911e140ed95` | Allows public site crawling; no private paths or sitemap claim. |
| `./screenshots/gamer-dark-shell.jpg` | Next-cycle browser-rendered source preview | 1265×712 JPEG, 64,908 bytes | `37bf3f2c2ceb26cd0baeb493f2444707d8cf1e4fc87c2c261359f18f2e6f43ed` | Exact capture bytes from the Theme Forge App/external CSSOM fixture; native ports are mocked and the visible boundary banner is retained. |
| `./screenshots/screenshot-provenance.json` | Browser-proof source receipt | JSON, 1,094 bytes | `cf567cb7b32bde647190b30e4ac280978ae5049aafb31465d6ca56dc328130f2` | Binds the public asset path, size, SHA-256, dimensions, and source-app manifest digest without private paths, timestamps, or usernames. |

Refresh these byte counts and hashes when the corresponding source changes. This document is not self-hashed to avoid a circular inventory.

## Existing appearance projection

These are generated development candidates, not final visual or release acceptance. Their provenance remains `./appearances/provenance.json`.

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `./appearances/catalog.json` | 794 | `617979da9045eca6864e974b797a387a0bf324eeb12904360152639b3a68f6a5` |
| `./appearances/terminal-nova.css` | 4,227 | `e4f8327022953c78996bf799385feae0ad7caff850eeaf9b198a7a6c5eb5ff7f` |
| `./appearances/nebular.css` | 4,228 | `616ffa3e0001cf146d552fcb5cca18b177febabf9ca406151578db53fd3d84cb` |
| `./appearances/developer.css` | 4,250 | `6952118016681724443152d5a27c3bbe231e1ad804c33076432dd62b7379f88d` |
| `./appearances/graphic-designer.css` | 4,246 | `5bd1f7de357259b389bfcdeab25044b5b8044ef4ad9a54388a762b4227001d12` |
| `./appearances/anime.css` | 4,247 | `3e6bcb1635261da524f66eace082d7878c548db832f8e7816ac2c26fd55a6cbb` |
| `./appearances/gamer.css` | 4,250 | `c89d11e1c225127c4288a7a6b3f2a5f096d3cb8ee96225e47fea7897643919d6` |
| `./appearances/provenance.json` | 1,899 | `3862bbb204b99c7534eb2bccb7b45572840921ee185b42bbb876bc62e0af8805` |

The source catalog and provenance digest are the producer's existing admission record; they do not establish native, final visual, or release acceptance.

## Terms boundary

Software in the upstream project is covered by [AGPL-3.0-or-later](https://github.com/Knowledge-Forge-AI/theme-forge-nebular-fusion/blob/main/LICENSE), with separate [commercial terms](https://github.com/Knowledge-Forge-AI/theme-forge-nebular-fusion/blob/main/COMMERCIAL-LICENSE.md) and [NOTICE](https://github.com/Knowledge-Forge-AI/theme-forge-nebular-fusion/blob/main/NOTICE). The Nebular Fusion name, wordmark, `✦` glyph, and identity artwork are governed separately by the project identity policy; no blanket artwork or trademark license is asserted here.
