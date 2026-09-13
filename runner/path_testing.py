"""Authenticated Playground probes of the Runner's loaded routing and runtime."""
from dataclasses import asdict
import hmac
import time
import uuid
from typing import Literal

from fastapi import Header, HTTPException
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, ConfigDict, Field

from .routing import RoutingError
from .toolkit.runtime.contracts import ProtectionRequest, RequestContext


class RouterPathRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(gt=0)
    endpoint_id: str = Field(min_length=1, max_length=128)
    action: Literal["simulate", "execute"]
    call_id: str = Field(min_length=1, max_length=256)
    fields: dict[str, str | list[str]] = Field(default_factory=dict)
    business_request: dict[str, list[str]]
    endpoint_request: dict[str, list[str]] | None = None
    text: str = Field(max_length=65536)


def register_path_testing(api):
    @api.router.post("/internal/v1/playground/routers/{router_id}/test")
    async def test_router(router_id: str, payload: RouterPathRequest, authorization: str | None = Header(default=None)):
        if authorization is None or not hmac.compare_digest(authorization, f"Bearer {api._controller_token}"):
            raise HTTPException(status_code=401, detail="Controller authentication failed.")
        from .api import _source_pairs, _scoped_call_id
        fields = tuple((k, v) for k, raw in payload.fields.items() for v in (raw if isinstance(raw, list) else [raw]))
        call_id = _scoped_call_id(payload.endpoint_id, payload.call_id)
        context = RequestContext(protocol=str(payload.fields.get("protocol", "http")), endpoint_id=payload.endpoint_id,
                                 call_id=call_id, fields=fields, business_request=_source_pairs(payload.business_request),
                                 endpoint_request=_source_pairs(payload.endpoint_request))
        try:
            preview = api._store.preview_router(router_id, payload.revision, context)
            decision = None
            if payload.action == "execute":
                started = time.perf_counter()
                with api._metrics.request("controller", "playground", "input", endpoint_id=payload.endpoint_id) as observation:
                    def verify_resolution(resolution):
                        assignment = resolution.route_assignment or {}
                        if resolution.router_id != router_id or assignment.get("routerRevision") != payload.revision:
                            raise RoutingError("router_revision_changed: use a new Call ID and retry")
                        observation.resolve(resolution)
                    try:
                        decision = await api._runtime.evaluate(
                            ProtectionRequest(phase="input", texts=(payload.text,), context=context, call_id=call_id, mode="enforce"),
                            on_resolved=verify_resolution,
                        )
                        observation.complete(decision)
                        if (decision.route_assignment or {}).get("routeId") != preview["assignment"].get("routeId"):
                            preview["rules"] = []
                            preview["pinned"] = True
                        preview["assignment"] = decision.route_assignment
                    except Exception:
                        observation.fail("runtime", "path_test_failed")
                        raise
                    finally:
                        await api._emit_telemetry(request_id=str(uuid.uuid4()), call_id=call_id,
                            endpoint_id=payload.endpoint_id, phase="input", protocol="playground", mode="enforce",
                            started=started, decision=decision, content_before=(payload.text,), observation=observation)
            return jsonable_encoder({**preview, "runnerId": api._runner_id, "simulation": payload.action == "simulate",
                                     "decision": asdict(decision) if decision is not None else None})
        except RoutingError as error:
            raise HTTPException(status_code=409, detail={"reason": error.reason, "assignment": getattr(error, "assignment", None),
                                                       "runnerId": api._runner_id}) from error
