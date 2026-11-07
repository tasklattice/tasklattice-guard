"""Both control-channel endpoints must use the same finite wire budget."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess

from runner.control_transport import CONTROL_CHANNEL_OPTIONS, CONTROL_MESSAGE_MAX_BYTES


def test_control_transport_budgets_agree() -> None:
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", """
          import { CONTROL_MESSAGE_MAX_BYTES, controlChannelOptions } from './server/control-channel/transport.ts';
          console.log(JSON.stringify({ limit: CONTROL_MESSAGE_MAX_BYTES, options: controlChannelOptions }));
        """],
        cwd=root / "controller", text=True, capture_output=True, check=True,
    )
    controller = json.loads(result.stdout)
    assert controller == {
        "limit": CONTROL_MESSAGE_MAX_BYTES, "options": dict(CONTROL_CHANNEL_OPTIONS),
    }
    assert CONTROL_MESSAGE_MAX_BYTES == 128 * 1024 * 1024  # never unlimited (-1)
