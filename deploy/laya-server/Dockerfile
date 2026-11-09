# Official release supplies the pinned CPU dependencies; update application
# sources to laya-server v0.1.2 and its pinned SDK without downloading weights.
FROM node:24-bookworm-slim AS frontend-build
WORKDIR /app/frontend
RUN npm install -g pnpm@11.19.0
COPY upstream/frontend/package.json upstream/frontend/pnpm-lock.yaml upstream/frontend/pnpm-workspace.yaml ./
RUN CI=true pnpm install --frozen-lockfile
COPY upstream/frontend/ ./
RUN CI=true pnpm build

FROM 1panel/laya-server@sha256:25a094840da14d4af2b24ef8922a8a286e73da68bed3c0fb4fc105c9a9ac1255
USER root
LABEL org.opencontainers.image.source="https://github.com/1Panel-dev/laya-server" \
      org.opencontainers.image.version="v0.1.2-dual" \
      org.opencontainers.image.revision="434e9b350f29a88afd773aee99ca01ee32fffb24" \
      io.tasklattice.laya-upstream-revision="6d942c92081fbc139e736bbd9ac0023223c29b7f"
RUN rm -rf /opt/laya /app/backend
COPY upstream-laya/pyproject.toml upstream-laya/README.md upstream-laya/LICENSE /opt/laya/
COPY upstream-laya/laya/ /opt/laya/laya/
RUN pip install --no-cache-dir --no-deps /opt/laya
COPY upstream/backend/ /app/backend/
COPY apply-dual-profile.py /opt/apply-dual-profile.py
RUN python /opt/apply-dual-profile.py /app/backend
RUN pip install --no-cache-dir /app/backend && pip check
COPY --from=frontend-build /app/frontend/dist/ /app/frontend/dist/
