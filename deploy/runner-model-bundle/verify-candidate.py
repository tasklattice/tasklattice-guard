"""Verify the digest-pinned Models OCI payload during image construction."""

import sys
from pathlib import Path

from model_bundle_contract import load_lock, verify_bundle


def main() -> None:
    lock = load_lock(Path(sys.argv[1]))
    bundle = verify_bundle(Path(sys.argv[2]), manifest_sha256=lock["manifestSha256"],
                           model_version=lock["modelVersion"])
    if bundle.manifest["artifactSha256"] != lock["artifactSha256"]:
        raise ValueError("Candidate model artifact SHA-256 differs from the lock.")
    print(f"Verified candidate {lock['modelVersion']} at SHA-256 {lock['artifactSha256']}")


if __name__ == "__main__":
    main()
