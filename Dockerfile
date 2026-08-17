# ── OrbiterX Gateway — Production Dockerfile ──────────────────────────────────
# Multi-stage build: keeps the final image small by not including build tools.
# Target: Railway / any OCI-compatible container registry.
# ──────────────────────────────────────────────────────────────────────────────

# ── Stage 1: dependency builder ───────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build

# Install build deps (needed for asyncpg C extension)
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy gateway source only (no Rust/frontend/node_modules)
COPY gateway.py               ./gateway.py
COPY orbiterx_gateway/        ./orbiterx_gateway/

# Railway injects $PORT; default to 8000 for local docker run
ENV PORT=8000

# Non-root user for security
RUN useradd -m -u 1001 orbiterx
USER orbiterx

EXPOSE 8000

# Uvicorn in production mode:
#   --workers 1  → Railway auto-scales replicas, not in-process workers
#   --ws websockets → enable WS via python-websockets
CMD ["sh", "-c", "uvicorn gateway:app --host 0.0.0.0 --port $PORT --workers 1 --ws websockets --log-level info"]
