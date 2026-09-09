"""The UI/controller and Runner derive identical facts from the same assets."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess

from runner.toolkit.policy_library.catalog import policy_catalog
from runner.toolkit.policy_library.protection import protection_contracts


def test_controller_runner_protection_metadata_agree() -> None:
    root = Path(__file__).resolve().parents[2]
    script = """
      import { PolicyCatalog } from './server/policy-catalog/catalog.ts';
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list();
      console.log(JSON.stringify(Object.fromEntries(policies.map(p => [p.id, { rails: p.rails, protection: p.protection }]))));
    """
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", script],
        cwd=root / "controller", text=True, capture_output=True, check=True,
    )
    controller = json.loads(result.stdout)
    runner = {p["id"]: {"rails": list(p["rails"]), "protection": p["protection"]} for p in policy_catalog()}
    assert controller == runner


def test_native_contracts_have_explicit_supported_surfaces() -> None:
    contract = protection_contracts()
    assert len(set(contract["directories"])) == 8
    for native in contract["nativePolicies"].values():
        assert set(native["rails"]) <= {"input", "output"}
        assert native["rails"]
        assert (native["outputStreaming"] == "not_applicable") == ("output" not in native["rails"])
        if native["execution"] == "local":
            assert native["modelCapabilities"] == []
