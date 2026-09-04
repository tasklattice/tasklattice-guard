"""NVIDIA's dedicated classifier protocol (not Chat Completions)."""

from __future__ import annotations

import math
from typing import Any
from urllib.parse import urlsplit, urlunsplit

PROFILE = "tali.nemoguard-jailbreak-detect.v1"
CLOUD_PATH = "/v1/security/nvidia/nemoguard-jailbreak-detect"


def jailbreak_detect_endpoint(base_url: str) -> str:
    url = urlsplit(base_url)
    if url.scheme not in {"http", "https"} or not url.netloc:
        raise ValueError("JailbreakDetect requires an HTTP(S) endpoint.")
    if url.username or url.password or url.query or url.fragment:
        raise ValueError("JailbreakDetect endpoint must not contain credentials, a query, or a fragment.")
    path = url.path.rstrip("/")
    if (
        url.scheme == "https"
        and url.hostname in {"integrate.api.nvidia.com", "ai.api.nvidia.com"}
        and url.port in {None, 443}
        and path in {"", "/v1"}
    ):
        return f"https://ai.api.nvidia.com{CLOUD_PATH}"
    if not (path.endswith("/classify") or path.endswith(CLOUD_PATH)):
        path += "/classify" if path.endswith("/v1") else "/v1/classify"
    return urlunsplit((url.scheme, url.netloc, path, "", ""))


def parse_jailbreak_detect_response(payload: Any) -> tuple[bool, float]:
    if not isinstance(payload, dict) or type(payload.get("jailbreak")) is not bool:
        raise ValueError("JailbreakDetect response must contain a boolean jailbreak field.")
    score = payload.get("score")
    if type(score) not in {int, float} or not math.isfinite(score) or not -1 <= score <= 1:
        raise ValueError("JailbreakDetect response score must be a finite number between -1 and 1.")
    return payload["jailbreak"], float(score)
