"""
free-claude-router (multi-provider gateway)
===========================================
A local proxy that lets Claude Code use the best FREE cloud models across
multiple providers, rotating keys and models to dodge rate limits.

Providers (see providers.json):
  - OpenRouter   (anthropic-native)  -- your 4 keys, free :models
  - DeepSeek     (anthropic-native)  -- $5 signup credit, then cheap
  - Kimi/Moonshot (openai-native)    -- paid flagship K2.6
  - SiliconFlow  (openai-native)     -- free Qwen2.5-72B / DeepSeek-V3 / GLM-4
  - Qwen DashScope (openai-native)   -- 70M free signup tokens
  - GLM BigModel (openai-native)     -- 5M free signup tokens

A provider activates automatically once its keys_file has a real key.
OpenAI-native providers get full Anthropic<->OpenAI translation (incl. tool
calls + SSE streaming) so Claude Code's agent mode works everywhere.

Run:  python router.py
Claude Code env:  ANTHROPIC_BASE_URL=http://127.0.0.1:8082
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Tuple

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

import translate as tr

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

PORT = 8083
HERE = Path(__file__).parent
PROVIDERS_FILE = HERE / "providers.json"
DEFAULT_COOLDOWN = 30.0          # per (provider,key,model) backoff after 429
HARD_FAIL_COOLDOWN = 3600.0      # whole-provider skip on insufficient balance / suspended
REQUEST_TIMEOUT = 600.0

# Many Claude Code sessions share this one proxy. Cap in-flight upstream calls
# per key so concurrent chats spread across keys/providers instead of stampeding
# key0 and 429'ing everything.
MAX_INFLIGHT_PER_KEY = int(os.environ.get("ROUTER_MAX_INFLIGHT_PER_KEY", "3"))
MAX_INFLIGHT_TOTAL = int(os.environ.get("ROUTER_MAX_INFLIGHT_TOTAL", "64"))
KEY_ACQUIRE_WAIT_S = float(os.environ.get("ROUTER_KEY_ACQUIRE_WAIT_S", "8"))
HTTP_MAX_CONNECTIONS = int(os.environ.get("ROUTER_HTTP_MAX_CONNECTIONS", "200"))
HTTP_MAX_KEEPALIVE = int(os.environ.get("ROUTER_HTTP_MAX_KEEPALIVE", "100"))
UVICORN_LIMIT_CONCURRENCY = int(os.environ.get("ROUTER_UVICORN_LIMIT_CONCURRENCY", "128"))
UVICORN_BACKLOG = int(os.environ.get("ROUTER_UVICORN_BACKLOG", "2048"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("router")

# --------------------------------------------------------------------------- #
# Provider model
# --------------------------------------------------------------------------- #

class Provider:
    def __init__(self, cfg: dict):
        self.name = cfg["name"]
        self.kind = cfg["kind"]                  # "anthropic" | "openai"
        self.base_url = cfg["base_url"].rstrip("/")
        # OpenAI-compatible root for this provider (used by the /v1/chat/completions
        # passthrough for Cursor). Defaults to base_url for openai-kind providers;
        # anthropic-kind providers declare it explicitly in providers.json.
        self.openai_base_url = (cfg.get("openai_base_url") or self.base_url).rstrip("/")
        self.keys_file = cfg["keys_file"]
        self.free = bool(cfg.get("free", False))
        self.priority = int(cfg.get("priority", 999))
        self.models: List[str] = list(cfg.get("models", []))
        self.keys: List[str] = []

    def load_keys(self) -> None:
        p = HERE / self.keys_file
        if not p.exists():
            return
        self.keys = [
            ln.strip() for ln in p.read_text(encoding="utf-8").splitlines()
            if ln.strip() and not ln.strip().startswith("#")
        ]

    @property
    def active(self) -> bool:
        return bool(self.keys) and bool(self.models)

    def messages_url(self) -> str:
        if self.kind == "anthropic":
            return f"{self.base_url}/v1/messages"
        return f"{self.base_url}/chat/completions"

    def openai_chat_url(self) -> str:
        return f"{self.openai_base_url}/chat/completions"

    def __repr__(self) -> str:
        return f"<Provider {self.name} {self.kind} keys={len(self.keys)} models={len(self.models)}>"


PROVIDERS: List[Provider] = []
_key_cursor = 0
_cursor_lock = asyncio.Lock()

# cooldowns
per_key_model_cd: Dict[Tuple[str, int, str], float] = defaultdict(float)  # (provider,key_idx,model)->expiry
provider_dead: Dict[str, float] = defaultdict(float)                      # provider->hard-fail expiry

# concurrency gates (created lazily; asyncio.Semaphore must bind to running loop)
_key_sems: Dict[Tuple[str, int], asyncio.Semaphore] = {}
_total_sem: Optional[asyncio.Semaphore] = None
_inflight: Dict[Tuple[str, int], int] = defaultdict(int)
_inflight_lock = asyncio.Lock()
_stats = {"accepted": 0, "completed": 0, "failed": 0, "busy_waits": 0}


def load_providers() -> None:
    global PROVIDERS
    cfg = json.loads(PROVIDERS_FILE.read_text(encoding="utf-8"))
    provs = [Provider(c) for c in cfg.get("providers", [])]
    for p in provs:
        p.load_keys()
    PROVIDERS = [p for p in provs if p.active]
    PROVIDERS.sort(key=lambda p: p.priority)
    for p in PROVIDERS:
        log.info("  active provider: %s", p)
    if not PROVIDERS:
        raise SystemExit("No active providers — add at least one API key to a keys_*.txt file.")
    log.info(
        "  concurrency: per_key=%d total=%d wait=%.0fs pool=%d/%d",
        MAX_INFLIGHT_PER_KEY, MAX_INFLIGHT_TOTAL, KEY_ACQUIRE_WAIT_S,
        HTTP_MAX_CONNECTIONS, HTTP_MAX_KEEPALIVE,
    )


async def next_cursor() -> int:
    global _key_cursor
    async with _cursor_lock:
        v = _key_cursor
        _key_cursor = (v + 1) % 1_000_000
        return v


def _key_sem(provider: str, idx: int) -> asyncio.Semaphore:
    slot = (provider, idx)
    sem = _key_sems.get(slot)
    if sem is None:
        sem = asyncio.Semaphore(MAX_INFLIGHT_PER_KEY)
        _key_sems[slot] = sem
    return sem


def _get_total_sem() -> asyncio.Semaphore:
    global _total_sem
    if _total_sem is None:
        _total_sem = asyncio.Semaphore(MAX_INFLIGHT_TOTAL)
    return _total_sem


async def acquire_key_slot(p: Provider, model: str, preferred: List[int]) -> Optional[int]:
    """Pick a cooled-down key with free capacity (least in-flight, round-robin tiebreak).

    Waits briefly when every key is saturated so many Claude sessions queue
    instead of instantly failing with 'all providers rate-limited'.
    """
    if not preferred:
        return None
    deadline = time.monotonic() + KEY_ACQUIRE_WAIT_S
    notified = False
    while True:
        now = time.monotonic()
        start = await next_cursor()
        n = len(preferred)
        cands: List[int] = []
        for off in range(n):
            idx = preferred[(start + off) % n]
            if per_key_model_cd[(p.name, idx, model)] > now:
                continue
            cands.append(idx)
        if not cands:
            if now >= deadline:
                return None
            if not notified:
                _stats["busy_waits"] += 1
                notified = True
            await asyncio.sleep(0.05)
            continue

        async with _inflight_lock:
            cands.sort(key=lambda i: (_inflight[(p.name, i)], i))
        idx = cands[0]
        sem = _key_sem(p.name, idx)
        remaining = max(0.05, deadline - time.monotonic())
        try:
            # Never use timeout=0 — it races and can leak semaphore permits.
            await asyncio.wait_for(sem.acquire(), timeout=remaining)
        except (asyncio.TimeoutError, TimeoutError):
            if not notified:
                _stats["busy_waits"] += 1
                notified = True
            if time.monotonic() >= deadline:
                return None
            continue
        async with _inflight_lock:
            _inflight[(p.name, idx)] += 1
        return idx


async def release_key_slot(provider: str, idx: int) -> None:
    sem = _key_sems.get((provider, idx))
    if sem is not None:
        try:
            sem.release()
        except ValueError:
            # Extra release — ignore rather than crashing a session.
            pass
    async with _inflight_lock:
        cur = _inflight[(provider, idx)]
        _inflight[(provider, idx)] = max(0, cur - 1)


async def _inflight_snapshot() -> Dict[str, int]:
    async with _inflight_lock:
        return {f"{prov}:key{idx}": n for (prov, idx), n in _inflight.items() if n > 0}


class _KeyLease:
    """Holds a key slot until release(); safe under task cancellation."""

    __slots__ = ("provider", "idx", "_released")

    def __init__(self, provider: str, idx: int):
        self.provider = provider
        self.idx = idx
        self._released = False

    async def release(self) -> None:
        if self._released:
            return
        self._released = True
        await release_key_slot(self.provider, self.idx)


async def acquire_key_lease(p: Provider, model: str, preferred: List[int]) -> Optional[_KeyLease]:
    idx = await acquire_key_slot(p, model, preferred)
    if idx is None:
        return None
    return _KeyLease(p.name, idx)


# --------------------------------------------------------------------------- #
# Routing plan
# --------------------------------------------------------------------------- #

# Global "smartest free / cheap" ranking across ALL providers. The router tries
# models in this order (interleaving providers) before falling back to the rest.
# Rationale: OpenRouter free keys are heavily rate-limited, so we interleave
# SiliconFlow's reliable free models (DeepSeek-V3, Qwen3-235B, Qwen2.5-72B)
# near the top instead of burning 12 OpenRouter 429s first.
GLOBAL_PRIORITY: List[str] = [
    "inclusionai/ling-3.0-flash:free",             # Nous — verified usable assistant text
    "deepseek-ai/deepseek-v4-flash",               # NVIDIA NIM — verified usable text
    "poolside/laguna-s-2.1:free",                  # Nous — coding agent
    "glm-4.5-flash",                               # GLM — cheap (reasoning_content fallback)
    "stepfun/step-3.7-flash:free",                 # Nous StepFun free (reasoning fallback)
    "poolside/laguna-xs-2.1:free",                 # Nous / OpenRouter — fast coding
    "nvidia/nemotron-3-super-120b-a12b:free",      # OpenRouter free (often rate-limited)
    "nvidia/nemotron-3-ultra-550b-a55b:free",      # OpenRouter free (often rate-limited)
    "cohere/north-mini-code:free",                 # OpenRouter — coding
    "google/gemma-4-31b-it:free",                  # OpenRouter
    "openai/gpt-oss-20b:free",                     # OpenRouter — small
    "glm-5.2",                                     # GLM — when not rate-limited
    "meta/llama-3.3-70b-instruct",                 # NVIDIA NIM fallback
    "Qwen/Qwen2.5-72B-Instruct",                   # SiliconFlow (needs balance)
    "kimi-k2.6",                                   # Kimi — paid (needs recharge)
    "qwen-turbo",                                  # DashScope (needs valid key)
    "deepseek-v4-flash",                           # DeepSeek direct (needs balance)
]


def _model_to_provider() -> Dict[str, Provider]:
    """Index model id -> the highest-priority provider that serves it."""
    idx: Dict[str, Provider] = {}
    for p in PROVIDERS:  # already sorted by priority (lowest first)
        for m in p.models:
            idx.setdefault(m, p)
    return idx


def resolve_requested(requested: Optional[str]) -> Optional[Tuple[Provider, str]]:
    """Find the (provider, model) that matches the requested model id (tolerant :free)."""
    if not requested:
        return None
    idx = _model_to_provider()
    if requested in idx:
        return (idx[requested], requested)
    cand = requested if requested.endswith(":free") else f"{requested}:free"
    if cand in idx:
        return (idx[cand], cand)
    # prefix match (alias -> any free variant)
    for mid, p in idx.items():
        if mid.startswith(f"{requested}:"):
            return (p, mid)
    return None


def build_attempts(requested: Optional[str]) -> List[Tuple[Provider, str]]:
    """Ordered (provider, model) attempts:
    1) resolved requested model first, then
    2) GLOBAL_PRIORITY (smartest free, interleaved across providers), then
    3) any remaining (provider, model) in provider-priority order.
    """
    idx = _model_to_provider()
    seen = set()
    attempts: List[Tuple[Provider, str]] = []

    resolved = resolve_requested(requested)
    if resolved:
        attempts.append(resolved)
        seen.add((resolved[0].name, resolved[1]))

    for mid in GLOBAL_PRIORITY:
        p = idx.get(mid)
        if not p:
            continue
        key = (p.name, mid)
        if key in seen:
            continue
        seen.add(key)
        attempts.append((p, mid))

    for p in PROVIDERS:
        for m in p.models:
            key = (p.name, m)
            if key in seen:
                continue
            seen.add(key)
            attempts.append((p, m))

    return attempts


def available_keys(p: Provider, model: str) -> List[int]:
    now = time.monotonic()
    order = []
    for i in range(len(p.keys)):
        if per_key_model_cd[(p.name, i, model)] > now:
            continue
        order.append(i)
    return order


def set_cd(p: Provider, idx: int, model: str, seconds: float) -> None:
    per_key_model_cd[(p.name, idx, model)] = time.monotonic() + seconds


def is_hard_failure(status: int, body: str) -> bool:
    if status in (401, 402, 403):
        return True
    low = body.lower()
    return any(s in low for s in (
        "insufficient balance", "insufficient_balance", "suspended due to insufficient",
        "account is suspended", "no enough balance", "余额不足",
        "incorrect api key", "api key is invalid", "invalid api key", "invalid_api_key",
    ))


def parse_retry_after(resp: httpx.Response) -> float:
    ra = resp.headers.get("Retry-After")
    if ra:
        try:
            return min(float(ra), 120.0)
        except ValueError:
            pass
    try:
        b = resp.json()
        meta = (b.get("error") or {}).get("metadata") or {}
        raw = meta.get("retry_after_seconds_raw") or meta.get("retry_after_seconds")
        if raw is not None:
            return min(float(raw), 120.0)
    except Exception:
        pass
    return DEFAULT_COOLDOWN


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

FORWARD_HEADERS = {"content-type", "anthropic-version", "anthropic-beta", "accept", "user-agent"}

client: Optional[httpx.AsyncClient] = None


def _make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(REQUEST_TIMEOUT, connect=15.0),
        limits=httpx.Limits(
            max_connections=HTTP_MAX_CONNECTIONS,
            max_keepalive_connections=HTTP_MAX_KEEPALIVE,
            keepalive_expiry=30.0,
        ),
        http2=False,
    )


def headers_for(p: Provider, idx: int, src: dict) -> dict:
    out: Dict[str, str] = {}
    for k, v in src.items():
        if k.lower() in FORWARD_HEADERS and p.kind == "anthropic":
            out[k] = v
    out["Authorization"] = f"Bearer {p.keys[idx]}"
    out["Content-Type"] = "application/json"
    if p.kind == "anthropic":
        out.setdefault("anthropic-version", "2023-06-01")
        out["HTTP-Referer"] = "https://github.com/free-claude-router"
        out["X-Title"] = "free-claude-router"
    return out


def body_for(p: Provider, model: str, payload: dict) -> bytes:
    if p.kind == "anthropic":
        body = dict(payload)
        body["model"] = model
        return json.dumps(body).encode("utf-8")
    # openai-kind: translate
    oai = tr.anthropic_to_openai(payload)
    oai["model"] = model
    return json.dumps(oai).encode("utf-8")


# --------------------------------------------------------------------------- #
# Strip OpenRouter's fake thinking / redacted_thinking blocks.
# Free reasoning models (gpt-oss, qwen3-coder, nemotron) inject these with
# empty signatures; Claude Code's parser drops the whole message when they're
# present. We remove them and renumber surviving blocks so indices are
# contiguous from 0, which is what Claude Code expects.
# --------------------------------------------------------------------------- #

_STRIP_TYPES = {"thinking", "redacted_thinking"}


def strip_thinking_nonstream(data: dict) -> dict:
    content = data.get("content")
    if isinstance(content, list):
        data["content"] = [b for b in content if b.get("type") not in _STRIP_TYPES]
    return data


async def strip_thinking_stream(aiter: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    state = {"skipped": set(), "remap": {}, "next": 0}
    buf = ""

    def process_event(event_str: str) -> Optional[bytes]:
        if not event_str.strip():
            return None
        event_name = None
        data_lines: List[str] = []
        for ln in event_str.split("\n"):
            if ln.startswith("event:"):
                event_name = ln[6:].strip()
            elif ln.startswith("data:"):
                data_lines.append(ln[5:].lstrip(" "))
        if not data_lines:
            return event_str.encode("utf-8") + b"\n\n"
        data_str = "".join(data_lines)
        try:
            d = json.loads(data_str)
        except json.JSONDecodeError:
            return event_str.encode("utf-8") + b"\n\n"
        t = d.get("type")
        if t == "content_block_start":
            cb = d.get("content_block") or {}
            if cb.get("type") in _STRIP_TYPES:
                state["skipped"].add(d.get("index"))
                return None
            old = d.get("index")
            new = state["next"]; state["next"] += 1
            state["remap"][old] = new
            d["index"] = new
        elif t in ("content_block_delta", "content_block_stop"):
            old = d.get("index")
            if old in state["skipped"]:
                return None
            d["index"] = state["remap"].get(old, old)
        # message_start / message_delta / message_stop / ping / error: pass through
        out = ""
        if event_name:
            out += f"event: {event_name}\n"
        out += f"data: {json.dumps(d, ensure_ascii=False)}\n\n"
        return out.encode("utf-8")

    async for raw in aiter:
        if not raw:
            continue
        buf += raw.decode("utf-8", errors="replace")
        while "\n\n" in buf:
            event_str, buf = buf.split("\n\n", 1)
            ev = process_event(event_str)
            if ev:
                yield ev
    if buf.strip():
        ev = process_event(buf)
        if ev:
            yield ev


app = FastAPI(title="free-claude-router")


@app.on_event("startup")
async def _startup() -> None:
    global client, _total_sem, _key_sems
    load_providers()
    # Create the HTTP client on the running loop (avoids hung requests).
    if client is not None:
        await client.aclose()
    client = _make_client()
    _total_sem = asyncio.Semaphore(MAX_INFLIGHT_TOTAL)
    _key_sems = {}


@app.on_event("shutdown")
async def _shutdown() -> None:
    global client
    if client is not None:
        await client.aclose()
        client = None


@app.get("/")
async def health() -> dict:
    inflight = await _inflight_snapshot()
    return {
        "status": "ok",
        "providers": [{"name": p.name, "kind": p.kind, "keys": len(p.keys),
                       "models": len(p.models), "free": p.free} for p in PROVIDERS],
        "concurrency": {
            "max_inflight_per_key": MAX_INFLIGHT_PER_KEY,
            "max_inflight_total": MAX_INFLIGHT_TOTAL,
            "inflight": inflight,
            "inflight_total": sum(inflight.values()),
            "stats": dict(_stats),
        },
    }


@app.get("/v1/models")
async def list_models(request: Request) -> dict:
    """Return models in Anthropic format if the client sends anthropic-version
    (Claude Code), otherwise OpenAI format (Cursor / OpenAI clients)."""
    is_anthropic = any(k.lower() == "anthropic-version" for k in request.headers.keys())
    ids: List[str] = []
    for p in PROVIDERS:
        ids.extend(p.models)
    if is_anthropic:
        data = [{"type": "model", "id": m, "display_name": f"{m} [{p.name}]",
                 "created_at": "2025-01-01T00:00:00Z"}
                for p in PROVIDERS for m in p.models]
        return {"data": data, "has_more": False, "first_id": data[0]["id"] if data else None,
                "last_id": data[-1]["id"] if data else None}
    # OpenAI format
    data = [{"id": m, "object": "model", "created": 1, "owned_by": p.name}
            for p in PROVIDERS for m in p.models]
    return {"object": "list", "data": data}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Any:
    """OpenAI ChatCompletion passthrough for Cursor / OpenAI clients."""
    raw = await request.body()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return JSONResponse({"error": {"message": "bad json", "type": "invalid_request"}}, 422)

    _stats["accepted"] += 1
    total_sem = _get_total_sem()
    await total_sem.acquire()
    released_total = False
    hold_total_for_stream = False

    def _release_total() -> None:
        nonlocal released_total
        if not released_total:
            total_sem.release()
            released_total = True

    try:
        requested = payload.get("model")
        streaming = bool(payload.get("stream"))
        attempts = build_attempts(requested)
        last_error: Optional[dict] = None
        now = time.monotonic()

        for (p, model) in attempts:
            if provider_dead[p.name] > now:
                continue
            preferred = available_keys(p, model)
            if not preferred:
                continue

            body = dict(payload)
            body["model"] = model
            body_bytes = json.dumps(body).encode("utf-8")
            url = p.openai_chat_url()

            # Keep pulling fresh keys for this model until cooldown/capacity say stop.
            tried: set[int] = set()
            assert client is not None
            while True:
                remaining = [i for i in available_keys(p, model) if i not in tried]
                if not remaining:
                    break
                lease = await acquire_key_lease(p, model, remaining)
                if lease is None:
                    break
                tried.add(lease.idx)
                idx = lease.idx
                transfer_lease = False
                headers = {
                    "Authorization": f"Bearer {p.keys[idx]}",
                    "Content-Type": "application/json",
                }
                if p.name == "openrouter":
                    headers["HTTP-Referer"] = "https://github.com/free-claude-router"
                    headers["X-Title"] = "free-claude-router"
                t0 = time.monotonic()
                try:
                    try:
                        if streaming:
                            req = client.build_request("POST", url, content=body_bytes, headers=headers)
                            resp = await client.send(req, stream=True)
                        else:
                            resp = await client.post(url, content=body_bytes, headers=headers)
                    except Exception as e:
                        log.warning("net err %s/%s key%d: %s", p.name, model, idx, e)
                        set_cd(p, idx, model, DEFAULT_COOLDOWN)
                        last_error = {"status": 502, "message": str(e)}
                        continue

                    status = resp.status_code
                    if status == 200:
                        dur = time.monotonic() - t0
                        log.info("OK  %-12s %-40s key%d %5.2fs oai stream=%s",
                                 p.name, model, idx, dur, streaming)
                        _stats["completed"] += 1
                        if streaming:
                            hold_total_for_stream = True
                            transfer_lease = True
                            return _oai_stream_response(
                                resp,
                                on_done=lease.release,
                                on_total=_release_total,
                            )
                        _release_total()
                        return JSONResponse(json.loads(resp.content), media_type="application/json")

                    if streaming:
                        await resp.aread()
                    err_text = resp.text

                    if is_hard_failure(status, err_text):
                        provider_dead[p.name] = time.monotonic() + HARD_FAIL_COOLDOWN
                        log.warning("HARD FAIL %s (status %d) — dead for %.0fm: %s",
                                    p.name, status, HARD_FAIL_COOLDOWN / 60,
                                    err_text[:160].replace("\n", " "))
                        last_error = {"status": status, "message": err_text[:200]}
                        await resp.aclose()
                        break

                    if status in (429, 503, 529):
                        ra = parse_retry_after(resp)
                        log.info("429 %-12s %-40s key%d cd %.0fs", p.name, model, idx, ra)
                        set_cd(p, idx, model, ra)
                        last_error = {"status": status, "message": err_text[:160]}
                        await resp.aclose()
                        continue

                    log.warning("ERR %-12s %-40s key%d status=%d: %s",
                                p.name, model, idx, status, err_text[:160].replace("\n", " "))
                    last_error = {"status": status, "message": err_text[:300]}
                    if status == 404:
                        for i in range(len(p.keys)):
                            set_cd(p, i, model, max(DEFAULT_COOLDOWN, 120.0))
                    else:
                        set_cd(p, idx, model, DEFAULT_COOLDOWN)
                    await resp.aclose()
                    break
                finally:
                    if not transfer_lease:
                        await lease.release()

        _stats["failed"] += 1
        log.error("OAI route all exhausted. Last: %s", last_error)
        return JSONResponse(
            {"error": {"message": "free-claude-router: all providers rate-limited/errored. "
                                  f"Last: {last_error}", "type": "rate_limit_error"}},
            status_code=(last_error or {}).get("status", 429) or 429,
        )
    finally:
        if not hold_total_for_stream:
            _release_total()


def _oai_stream_response(
    resp: httpx.Response,
    on_done: Optional[Callable[[], Any]] = None,
    on_total: Optional[Callable[[], None]] = None,
) -> StreamingResponse:
    async def gen() -> AsyncIterator[bytes]:
        try:
            async for chunk in resp.aiter_raw():
                if chunk:
                    yield chunk
        finally:
            await resp.aclose()
            if on_done:
                maybe = on_done()
                if asyncio.iscoroutine(maybe):
                    await maybe
            if on_total:
                on_total()
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/v1/messages")
async def messages(request: Request) -> Any:
    raw = await request.body()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return JSONResponse({"error": {"type": "invalid_request", "message": "bad json"}}, 422)

    _stats["accepted"] += 1
    total_sem = _get_total_sem()
    await total_sem.acquire()
    released_total = False
    hold_total_for_stream = False

    def _release_total() -> None:
        nonlocal released_total
        if not released_total:
            total_sem.release()
            released_total = True

    try:
        requested = payload.get("model")
        streaming = bool(payload.get("stream"))
        src_headers = {k: v for k, v in request.headers.items()}
        attempts = build_attempts(requested)
        last_error: Optional[dict] = None
        now = time.monotonic()

        for (p, model) in attempts:
            if provider_dead[p.name] > now:
                continue

            preferred = available_keys(p, model)
            if not preferred:
                continue

            body_bytes = body_for(p, model, payload)
            url = p.messages_url()

            tried: set[int] = set()
            assert client is not None
            while True:
                remaining = [i for i in available_keys(p, model) if i not in tried]
                if not remaining:
                    break
                lease = await acquire_key_lease(p, model, remaining)
                if lease is None:
                    break
                tried.add(lease.idx)
                idx = lease.idx
                transfer_lease = False
                headers = headers_for(p, idx, src_headers)
                t0 = time.monotonic()
                try:
                    try:
                        if streaming:
                            req = client.build_request("POST", url, content=body_bytes, headers=headers)
                            resp = await client.send(req, stream=True)
                        else:
                            resp = await client.post(url, content=body_bytes, headers=headers)
                    except Exception as e:
                        log.warning("net err %s/%s key%d: %s", p.name, model, idx, e)
                        set_cd(p, idx, model, DEFAULT_COOLDOWN)
                        last_error = {"status": 502, "message": str(e)}
                        continue

                    status = resp.status_code

                    if status == 200:
                        dur = time.monotonic() - t0
                        log.info("OK  %-12s %-40s key%d %5.2fs stream=%s",
                                 p.name, model, idx, dur, streaming)
                        _stats["completed"] += 1
                        if streaming:
                            hold_total_for_stream = True
                            transfer_lease = True
                            return _stream_response(
                                resp, p, model,
                                on_done=lease.release,
                                on_total=_release_total,
                            )
                        data = resp.content
                        _release_total()
                        if p.kind == "anthropic":
                            anth = strip_thinking_nonstream(json.loads(data))
                            return JSONResponse(anth, media_type="application/json")
                        anth = tr.openai_to_anthropic(json.loads(data), model_name=model)
                        return JSONResponse(anth, media_type="application/json")

                    if streaming:
                        await resp.aread()
                    err_text = resp.text

                    if is_hard_failure(status, err_text):
                        provider_dead[p.name] = time.monotonic() + HARD_FAIL_COOLDOWN
                        log.warning("HARD FAIL %s (status %d) — dead for %.0fm: %s",
                                    p.name, status, HARD_FAIL_COOLDOWN / 60,
                                    err_text[:160].replace("\n", " "))
                        last_error = {"status": status, "message": err_text[:200]}
                        await resp.aclose()
                        break

                    if status in (429, 503, 529):
                        ra = parse_retry_after(resp)
                        log.info("429 %-12s %-40s key%d cd %.0fs", p.name, model, idx, ra)
                        set_cd(p, idx, model, ra)
                        last_error = {"status": status, "message": err_text[:160]}
                        await resp.aclose()
                        continue

                    log.warning("ERR %-12s %-40s key%d status=%d: %s",
                                p.name, model, idx, status, err_text[:160].replace("\n", " "))
                    last_error = {"status": status, "message": err_text[:300]}
                    if status == 404:
                        for i in range(len(p.keys)):
                            set_cd(p, i, model, max(DEFAULT_COOLDOWN, 120.0))
                    else:
                        set_cd(p, idx, model, DEFAULT_COOLDOWN)
                    await resp.aclose()
                    break
                finally:
                    if not transfer_lease:
                        await lease.release()

        _stats["failed"] += 1
        log.error("All providers/models/keys exhausted. Last: %s", last_error)
        return JSONResponse(
            {"type": "error",
             "error": {"type": "overloaded_error",
                       "message": ("free-claude-router: all providers rate-limited/errored. "
                                   f"Last: {last_error}")}},
            status_code=(last_error or {}).get("status", 529) or 529,
        )
    finally:
        if not hold_total_for_stream:
            _release_total()


def _stream_response(
    resp: httpx.Response,
    p: Provider,
    model: str,
    on_done: Optional[Callable[[], Any]] = None,
    on_total: Optional[Callable[[], None]] = None,
) -> StreamingResponse:
    async def _cleanup() -> None:
        await resp.aclose()
        if on_done:
            maybe = on_done()
            if asyncio.iscoroutine(maybe):
                await maybe
        if on_total:
            on_total()

    async def gen_anthropic() -> AsyncIterator[bytes]:
        try:
            async for chunk in strip_thinking_stream(resp.aiter_raw()):
                yield chunk
        finally:
            await _cleanup()

    async def gen_translated() -> AsyncIterator[bytes]:
        try:
            async for ev in tr.openai_stream_to_anthropic(resp.aiter_raw(), model_name=model):
                yield ev
        finally:
            await _cleanup()

    passthrough_headers = {"cache-control", "content-type", "x-request-id"}
    gen = gen_anthropic if p.kind == "anthropic" else gen_translated
    headers = {k: v for k, v in resp.headers.items() if k.lower() in passthrough_headers}
    return StreamingResponse(gen(), media_type="text/event-stream", headers=headers)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=PORT,
        log_level="warning",
        limit_concurrency=UVICORN_LIMIT_CONCURRENCY,
        backlog=UVICORN_BACKLOG,
        timeout_keep_alive=75,
    )
