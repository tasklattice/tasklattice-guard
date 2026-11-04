"""Public operational endpoints use one JSON envelope and never cache health."""
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


def readiness_response(ready: bool, reason: str, message: str | None = None, **detail) -> JSONResponse:
    return JSONResponse({
        **detail,
        "component": "guard-runner",
        "status": "ready" if ready else "not_ready",
        "ready": ready,
        "reason": reason,
        "error": None if ready else {"code": reason, "message": message or "Runner is not ready."},
    }, status_code=200 if ready else 503)


class OperationalMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        path = scope.get("path", "")
        operational = any(path == prefix or path.startswith(prefix + "/")
                          for prefix in ("/health", "/healthz", "/version"))
        if scope["type"] != "http" or not operational:
            return await self.app(scope, receive, send)
        if path not in ("/health/live", "/health/ready", "/healthz", "/version") or scope["method"] not in ("GET", "HEAD"):
            return await JSONResponse({"error": {"code": "not_found", "message": "Route not found."}},
                                      status_code=404, headers={"Cache-Control": "no-store"})(scope, receive, send)

        async def send_uncached(message):
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", []), (b"cache-control", b"no-store")]}
            # Starlette does not suppress HEAD bodies for dynamically rendered responses.
            if scope["method"] == "HEAD" and message["type"] == "http.response.body":
                message = {**message, "body": b""}
            await send(message)

        await self.app(scope, receive, send_uncached)
