# syntax=docker/dockerfile:1.14

ARG NODE_VERSION=24
ARG PYTHON_VERSION=3.12

FROM node:${NODE_VERSION}-bookworm-slim AS ui-build

WORKDIR /build/web

COPY --link web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund

COPY --link web ./
RUN npm run build


FROM python:${PYTHON_VERSION}-slim-bookworm AS python-dependencies

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /bin/

ENV UV_LINK_MODE=copy \
    UV_NO_DEV=1 \
    UV_PROJECT_ENVIRONMENT=/opt/tasklattice/venv \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /build

# This layer changes only when the dependency contract changes. Application
# source is intentionally copied later so normal code edits reuse the venv.
COPY --link pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    uv sync --locked --no-install-project


FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime

ENV PATH="/opt/tasklattice/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODEL_GUARDRAILS_DATABASE_PATH=/var/lib/tasklattice/model-guardrails/tasklattice-guard-policy-schema-v3.db \
    MODEL_GUARDRAILS_HELM_CHART=/opt/tasklattice/helm/tasklattice-guard.tgz \
    MODEL_GUARDRAILS_UI_DIST_PATH=/opt/tasklattice/model-guardrails/web/dist

WORKDIR /opt/tasklattice/model-guardrails

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install --yes --no-install-recommends antiword \
    && useradd --system --uid 65532 --no-create-home tasklattice \
    && mkdir -p /var/lib/tasklattice/model-guardrails \
    && chown -R 65532:65532 /var/lib/tasklattice/model-guardrails

COPY --link --from=python-dependencies /opt/tasklattice/venv /opt/tasklattice/venv
COPY --link README.md THIRD_PARTY_NOTICES.md ./
COPY --link dist/runtime-chart/tasklattice-guard.tgz /opt/tasklattice/helm/tasklattice-guard.tgz
COPY --link app ./app
COPY --link --from=ui-build /build/web/dist ./web/dist

USER 65532:65532
EXPOSE 8091
VOLUME ["/var/lib/tasklattice/model-guardrails"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8091"]
