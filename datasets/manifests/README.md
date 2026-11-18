# Dataset manifests

Commit small version references here. Keep the materialized manifest and five
JSONL partitions in access-controlled storage. A reference records `datasetId`, `version` and `sha256`. Add a storage
URI after publication. The `notebook-v1` reference also records split
statistics, the exact Kaggle Dataset version, and the original fingerprints
for the extracted acceptance cases and authored memory cases. The registered
directory contains `VERSION/manifest.json` and its sibling files.

The preparation job produces the SHA-256 pin and metadata. It never writes raw
records into this directory.
