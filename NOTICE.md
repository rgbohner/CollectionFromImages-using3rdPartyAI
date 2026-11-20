<!--
Author: rgbohner (with Codex assistance)
Date: 2026-11-20
Used for: Records project provenance, scope and licensing boundaries.
Why: Explains the adaptation and distinguishes project licensing from third-party dependencies.
-->

# Provenance

The photo recognition, catalog normalization, provider transport, research and usage-accounting logic was adapted from the owner's existing collection-recognition code.

This repository includes only the standalone image-to-spreadsheet workflow and its CLI/MCP interfaces. Application-specific historical-cost reconstruction, desktop settings, storage, canvas and Google integrations are excluded.

This project is released under the [MIT license](LICENSE), copyright (c) 2026 rgbohner. The `private` package flag prevents accidental npm publication and is independent of GitHub repository visibility. Third-party dependencies retain their respective licenses, installed alongside their packages.

`examples/sample.heic` is a generated 64 × 48 solid-color test image. It contains no personal photograph or collection data.
