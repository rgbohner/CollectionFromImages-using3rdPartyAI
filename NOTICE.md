# Provenance

The photo recognition, catalog normalization, provider transport, research and usage-accounting logic was adapted from the owner's existing collection-recognition code.

This repository includes only the standalone image-to-spreadsheet workflow and its CLI/MCP interfaces. Application-specific historical-cost reconstruction, desktop settings, storage, canvas and Google integrations are excluded.

No open-source license has been selected for this project; its package is marked `UNLICENSED`. The `private` package flag prevents accidental npm publication and is independent of GitHub repository visibility. Third-party dependencies retain their respective licenses, installed alongside their packages.

`examples/sample.heic` is a generated 64 × 48 solid-color test image. It contains no personal photograph or collection data.
