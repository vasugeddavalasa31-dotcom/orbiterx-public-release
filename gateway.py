import os
import json
import time
import asyncio
import uvicorn
import httpx
from collections import defaultdict, deque
from dataclasses import dataclass, field
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# ------------------------------------------------------------------------------
# ENVIRONMENT CONFIGURATION
# ------------------------------------------------------------------------------
# Target OGX Server URL (defaults to OGX standard port 8321)
env_ogx = os.getenv("OGX_URL", "").strip()
if not env_ogx or env_ogx in ("http://127.0.0.1:8321", "http://localhost:8321"):
    OGX_URL = "https://ogxraiwy-production.up.railway.app"
else:
    OGX_URL = env_ogx

# Admin dashboard / Cloudflare Worker endpoint for models listing fallback
ADMIN_MODELS_URL     = os.getenv("ADMIN_MODELS_URL", "https://ox-handler-prod.vasugeddavalasa31.workers.dev/v1/models")
ADMIN_MODELS_API_KEY = os.getenv("ADMIN_MODELS_API_KEY", "")

# --- Security / Limits (tunable via env) ---
GATEWAY_SECRET       = os.getenv("GATEWAY_SECRET", "")           # empty = auth disabled
MAX_BODY_BYTES       = int(os.getenv("MAX_BODY_BYTES", 524288))   # 512 KB
MAX_TURNS_PER_MIN    = int(os.getenv("MAX_TURNS_PER_MIN", 60))    # per IP per minute
GLOBAL_TURNS_PER_MIN = int(os.getenv("GLOBAL_TURNS_PER_MIN", 200))
MAX_CONCURRENT_IP    = int(os.getenv("MAX_CONCURRENT_IP", 5))     # concurrent streams per IP
TURN_TIMEOUT_SECS    = int(os.getenv("TURN_TIMEOUT_SECS", 120))   # max stream duration

# ------------------------------------------------------------------------------
# IN-MEMORY RATE LIMITER (sliding-window)
# ------------------------------------------------------------------------------
_ip_turn_times: dict[str, deque] = defaultdict(lambda: deque())
_global_turn_times: deque = deque()
_ip_concurrent: dict[str, int] = defaultdict(int)
_rate_lock = asyncio.Lock()

def _purge_old(dq: deque, window: float = 60.0):
    cutoff = time.monotonic() - window
    while dq and dq[0] < cutoff:
        dq.popleft()

async def check_rate_limit(ip: str) -> tuple[bool, str]:
    async with _rate_lock:
        if _ip_concurrent[ip] >= MAX_CONCURRENT_IP:
            return False, f"Too many concurrent requests from your IP (max {MAX_CONCURRENT_IP})"

        _purge_old(_ip_turn_times[ip])
        if len(_ip_turn_times[ip]) >= MAX_TURNS_PER_MIN:
            return False, f"Rate limit exceeded: max {MAX_TURNS_PER_MIN} agent turns per minute per IP"

        _purge_old(_global_turn_times)
        if len(_global_turn_times) >= GLOBAL_TURNS_PER_MIN:
            return False, f"Gateway is busy: global rate limit of {GLOBAL_TURNS_PER_MIN} turns/min reached"

        return True, ""

async def record_turn(ip: str):
    async with _rate_lock:
        now = time.monotonic()
        _ip_turn_times[ip].append(now)
        _global_turn_times.append(now)
        _ip_concurrent[ip] += 1

async def release_turn(ip: str):
    async with _rate_lock:
        if _ip_concurrent[ip] > 0:
            _ip_concurrent[ip] -= 1

# ------------------------------------------------------------------------------
# LIVE METRICS TRACKER
# ------------------------------------------------------------------------------
_GATEWAY_START = time.time()

@dataclass
class _GatewayStats:
    turns_total: int = 0
    turns_ok: int = 0
    turns_error: int = 0
    turns_timeout: int = 0
    turns_rate_limited: int = 0
    total_duration_ms: int = 0
    _recent_turns: deque = field(default_factory=deque)
    last_request_ts: float = 0.0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def record(self, *, ok: bool, timeout: bool = False,
                     rate_limited: bool = False, duration_ms: int = 0):
        async with self.lock:
            now = time.monotonic()
            self.turns_total += 1
            self.total_duration_ms += duration_ms
            self.last_request_ts = now
            self._recent_turns.append(now)
            cutoff = now - 60.0
            while self._recent_turns and self._recent_turns[0] < cutoff:
                self._recent_turns.popleft()
            if rate_limited:
                self.turns_rate_limited += 1
            elif timeout:
                self.turns_timeout += 1
            elif ok:
                self.turns_ok += 1
            else:
                self.turns_error += 1

    async def snapshot(self) -> dict:
        async with self.lock:
            now = time.monotonic()
            wall = time.time()
            uptime_s = int(wall - _GATEWAY_START)
            cutoff = now - 60.0
            while self._recent_turns and self._recent_turns[0] < cutoff:
                self._recent_turns.popleft()
            recent = len(self._recent_turns)
            active = sum(_ip_concurrent.values())
            idle_s = int(now - self.last_request_ts) if self.last_request_ts else None
            avg_ms = (
                self.total_duration_ms // self.turns_total
                if self.turns_total else 0
            )
            return {
                "uptime_seconds": uptime_s,
                "active_streams": active,
                "idle_seconds": idle_s,
                "turns": {
                    "total": self.turns_total,
                    "ok": self.turns_ok,
                    "error": self.turns_error,
                    "timeout": self.turns_timeout,
                    "rate_limited": self.turns_rate_limited,
                    "per_minute_recent": recent,
                },
                "avg_turn_duration_ms": avg_ms,
                "rate_limits": {
                    "max_turns_per_min_per_ip": MAX_TURNS_PER_MIN,
                    "global_turns_per_min": GLOBAL_TURNS_PER_MIN,
                    "max_concurrent_per_ip": MAX_CONCURRENT_IP,
                },
                "autoscale_signal": {
                    "scale_up": active >= max(1, MAX_CONCURRENT_IP * 2),
                    "scale_down": active == 0 and (idle_s or 0) > 600,
                },
                "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }

_stats = _GatewayStats()

# ------------------------------------------------------------------------------
# AUDIT LOGGING & ERROR SANITIZATION
# ------------------------------------------------------------------------------
def audit_log(ip: str, path: str, duration_ms: int, status: str = "ok", error: str = ""):
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    parts = [
        f"[AUDIT] {ts}",
        f"ip={ip}",
        f"path={path}",
        f"duration={duration_ms}ms",
        f"status={status}",
    ]
    if error:
        parts.append(f"error={error!r}")
    print(" | ".join(parts), flush=True)

def sanitize_error(raw: str) -> str:
    msg = raw.replace(OGX_URL, "[OGX_URL]")
    lines = msg.splitlines()
    safe = [l for l in lines if not l.strip().startswith("File \"")]
    return " ".join(safe[:3])

# ------------------------------------------------------------------------------
# APP & MIDDLEWARE
# ------------------------------------------------------------------------------
app = FastAPI(title="OrbiterX Lean High-Performance Gateway")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def body_size_limit(request: Request, call_next):
    cl = request.headers.get("content-length")
    if cl and int(cl) > MAX_BODY_BYTES:
        return JSONResponse(
            status_code=413,
            content={"error": f"Request body too large (max {MAX_BODY_BYTES // 1024} KB)"},
        )
    return await call_next(request)

_OPEN_PATHS = {"/", "/health", "/v1/models", "/metrics"}

@app.middleware("http")
async def bearer_auth(request: Request, call_next):
    if not GATEWAY_SECRET:
        return await call_next(request)
    if request.url.path in _OPEN_PATHS or request.method == "OPTIONS":
        return await call_next(request)

    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    if token != GATEWAY_SECRET:
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})
    return await call_next(request)

def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

# ------------------------------------------------------------------------------
# REVERSE PROXY ROUTING (/v1/responses -> OGX /v1/responses)
# ------------------------------------------------------------------------------
@app.post("/v1/responses")
async def http_responses_proxy(request: Request):
    ip = _client_ip(request)

    allowed, reason = await check_rate_limit(ip)
    if not allowed:
        await _stats.record(ok=False, rate_limited=True)
        return JSONResponse(
            status_code=429,
            content={"type": "error", "error": {"message": reason}},
        )

    await record_turn(ip)
    start = time.monotonic()
    error_msg = ""
    target_url = f"{OGX_URL.rstrip('/')}/v1/responses"

    try:
        body = await request.body()
        req_headers = dict(request.headers)
        req_headers.pop("host", None)
        req_headers.pop("content-length", None)

        async def stream_generator():
            nonlocal error_msg
            try:
                async with httpx.AsyncClient(timeout=TURN_TIMEOUT_SECS) as client:
                    async with client.stream("POST", target_url, content=body, headers=req_headers) as resp:
                        async for chunk in resp.aiter_bytes():
                            yield chunk
            except httpx.TimeoutException:
                error_msg = "Gateway timeout waiting for OGX response"
                yield json.dumps({"type": "error", "error": {"message": error_msg}}).encode() + b"\n\n"
            except Exception as exc:
                error_msg = sanitize_error(str(exc))
                yield json.dumps({"type": "error", "error": {"message": error_msg}}).encode() + b"\n\n"

        return StreamingResponse(stream_generator(), media_type="text/event-stream")

    finally:
        duration_ms = int((time.monotonic() - start) * 1000)
        audit_log(ip=ip, path="/v1/responses", duration_ms=duration_ms, status="error" if error_msg else "ok", error=error_msg)
        await _stats.record(ok=not error_msg, timeout="timeout" in error_msg.lower(), duration_ms=duration_ms)
        await release_turn(ip)

# ------------------------------------------------------------------------------
# WEBSOCKET REVERSE PROXY (/v1/responses)
# ------------------------------------------------------------------------------
@app.websocket("/v1/responses")
async def websocket_responses_proxy(websocket: WebSocket):
    await websocket.accept()
    ip = websocket.client.host if websocket.client else "unknown"

    allowed, reason = await check_rate_limit(ip)
    if not allowed:
        await websocket.send_text(json.dumps({"type": "error", "error": {"message": reason}}))
        await websocket.close()
        return

    await record_turn(ip)
    start = time.monotonic()
    error_msg = ""

    try:
        ws_target = OGX_URL.replace("http://", "ws://").replace("https://", "wss://").rstrip("/") + "/v1/responses"

        import websockets
        async with websockets.connect(ws_target) as ogx_ws:
            async def forward_client_to_ogx():
                while True:
                    data = await websocket.receive_text()
                    await ogx_ws.send(data)

            async def forward_ogx_to_client():
                while True:
                    data = await ogx_ws.recv()
                    await websocket.send_text(data)

            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(forward_client_to_ogx()),
                    asyncio.create_task(forward_ogx_to_client()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        error_msg = sanitize_error(str(exc))
    finally:
        duration_ms = int((time.monotonic() - start) * 1000)
        audit_log(ip=ip, path="WS /v1/responses", duration_ms=duration_ms, status="error" if error_msg else "ok", error=error_msg)
        await _stats.record(ok=not error_msg, duration_ms=duration_ms)
        await release_turn(ip)

# ------------------------------------------------------------------------------
# HEALTH, METRICS & MODELS ENDPOINTS
# ------------------------------------------------------------------------------
@app.get("/")
@app.get("/health")
async def health():
    ogx_ok = False
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            res = await client.get(f"{OGX_URL.rstrip('/')}/health")
            ogx_ok = res.status_code in (200, 401, 403)
    except Exception:
        ogx_ok = False

    return {
        "status": "ok",
        "ogx_url": OGX_URL,
        "ogx_connected": ogx_ok,
        "mode": "reverse_proxy",
        "limits": {
            "max_body_kb": MAX_BODY_BYTES // 1024,
            "max_turns_per_min_per_ip": MAX_TURNS_PER_MIN,
            "global_turns_per_min": GLOBAL_TURNS_PER_MIN,
            "max_concurrent_per_ip": MAX_CONCURRENT_IP,
            "turn_timeout_secs": TURN_TIMEOUT_SECS,
            "auth_enabled": bool(GATEWAY_SECRET),
        },
    }

@app.get("/v1/models")
async def models_proxy():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.get(f"{OGX_URL.rstrip('/')}/v1/models")
            if res.status_code == 200:
                return JSONResponse(status_code=200, content=res.json())
    except Exception:
        pass

    if ADMIN_MODELS_URL:
        try:
            headers = {"Accept": "application/json"}
            if ADMIN_MODELS_API_KEY:
                headers["Authorization"] = f"Bearer {ADMIN_MODELS_API_KEY}"
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(ADMIN_MODELS_URL, headers=headers)
                if res.status_code == 200:
                    return JSONResponse(status_code=200, content=res.json())
        except Exception:
            pass

    return JSONResponse(status_code=500, content={"error": "Models endpoint unavailable"})

@app.get("/metrics")
async def metrics(format: str = "json"):
    data = await _stats.snapshot()
    if format == "prometheus":
        t = data["turns"]
        lines = [
            "# HELP orbiterx_uptime_seconds Gateway uptime in seconds",
            "# TYPE orbiterx_uptime_seconds gauge",
            f"orbiterx_uptime_seconds {data['uptime_seconds']}",
            "",
            "# HELP orbiterx_active_streams Current active LLM streaming sessions",
            "# TYPE orbiterx_active_streams gauge",
            f"orbiterx_active_streams {data['active_streams']}",
            "",
            "# HELP orbiterx_turns_total Total agent turns processed",
            "# TYPE orbiterx_turns_total counter",
            f"orbiterx_turns_total {t['total']}",
            f"orbiterx_turns_ok_total {t['ok']}",
            f"orbiterx_turns_error_total {t['error']}",
            f"orbiterx_turns_timeout_total {t['timeout']}",
            f"orbiterx_turns_rate_limited_total {t['rate_limited']}",
            "",
            "# HELP orbiterx_avg_turn_duration_ms Average turn duration in milliseconds",
            "# TYPE orbiterx_avg_turn_duration_ms gauge",
            f"orbiterx_avg_turn_duration_ms {data['avg_turn_duration_ms']}",
            "",
            "# HELP orbiterx_scale_up 1 if auto-scaler should add GPU capacity",
            "# TYPE orbiterx_scale_up gauge",
            f"orbiterx_scale_up {1 if data['autoscale_signal']['scale_up'] else 0}",
        ]
        return StreamingResponse(iter(["\n".join(lines) + "\n"]), media_type="text/plain")

    return data
