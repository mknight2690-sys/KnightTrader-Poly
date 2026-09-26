"""
translate.py — Anthropic Messages API <-> OpenAI ChatCompletion API conversion.

Used by free-claude-router for OpenAI-native providers (SiliconFlow, Qwen
DashScope, GLM BigModel) so Claude Code's Anthropic-format requests, including
tool_use / tool_result agent loops and SSE streaming, work against those
providers unchanged.

Three public functions:
  * anthropic_to_openai(payload) -> dict            request body conversion
  * openai_to_anthropic(json)    -> dict            non-stream response conversion
  * openai_stream_to_anthropic(aiter) -> AsyncIterator[bytes]   SSE stream conversion
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict, List, Optional


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

def _text_from_blocks(blocks: Any) -> str:
    """Concatenate all text from an Anthropic system/content array (drops thinking/cache)."""
    if isinstance(blocks, str):
        return blocks
    out: List[str] = []
    if isinstance(blocks, list):
        for b in blocks:
            if isinstance(b, dict) and b.get("type") == "text":
                out.append(b.get("text", ""))
    return "".join(out)


def _image_block_to_openai(b: dict) -> Optional[dict]:
    src = b.get("source") or {}
    if src.get("type") == "base64":
        media = src.get("media_type", "image/png")
        return {"type": "image_url", "image_url": {"url": f"data:{media};base64,{src.get('data','')}"}}
    if src.get("type") == "url":
        return {"type": "image_url", "image_url": {"url": src.get("url", "")}}
    return None


def _stringify_content(content: Any) -> str:
    """tool_result.content can be a string or an array of text blocks -> flatten to a string."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    parts.append(b.get("text", ""))
                elif b.get("type") == "image":
                    parts.append("[image omitted]")
                else:
                    parts.append(json.dumps(b, ensure_ascii=False))
            else:
                parts.append(str(b))
        return "".join(parts)
    if content is None:
        return ""
    return json.dumps(content, ensure_ascii=False)


# --------------------------------------------------------------------------- #
# Request: Anthropic -> OpenAI
# --------------------------------------------------------------------------- #

def anthropic_to_openai(payload: dict) -> dict:
    """Convert an Anthropic Messages request body into an OpenAI ChatCompletion body."""
    out: Dict[str, Any] = {"model": payload.get("model")}

    messages: List[dict] = []

    # system -> system message
    system = payload.get("system")
    if system:
        sys_text = _text_from_blocks(system)
        if sys_text:
            messages.append({"role": "system", "content": sys_text})

    for msg in payload.get("messages", []):
        role = msg.get("role", "user")
        content = msg.get("content")

        # Plain string content
        if isinstance(content, str):
            messages.append({"role": role, "content": content})
            continue

        # Array content
        if isinstance(content, list):
            if role == "assistant":
                text_parts: List[str] = []
                tool_calls: List[dict] = []
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    t = b.get("type")
                    if t == "text":
                        text_parts.append(b.get("text", ""))
                    elif t == "tool_use":
                        tool_calls.append({
                            "id": b.get("id", ""),
                            "type": "function",
                            "function": {
                                "name": b.get("name", ""),
                                "arguments": json.dumps(b.get("input", {}), ensure_ascii=False),
                            },
                        })
                    # "thinking" / "redacted_thinking" blocks are dropped
                am: dict = {"role": "assistant"}
                joined = "".join(text_parts)
                am["content"] = joined if joined else None
                if tool_calls:
                    am["tool_calls"] = tool_calls
                messages.append(am)
            else:  # user (or tool-bearing user message)
                # Split out tool_result blocks -> separate OpenAI "tool" messages.
                # Remaining text/image blocks become one user message.
                user_parts: List[dict] = []
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    t = b.get("type")
                    if t == "tool_result":
                        messages.append({
                            "role": "tool",
                            "tool_call_id": b.get("tool_use_id", ""),
                            "content": _stringify_content(b.get("content")),
                        })
                    elif t == "text":
                        user_parts.append({"type": "text", "text": b.get("text", "")})
                    elif t == "image":
                        img = _image_block_to_openai(b)
                        if img:
                            user_parts.append(img)
                if user_parts:
                    messages.append({"role": "user", "content": user_parts})
            continue

        # Fallback: unknown content shape
        messages.append({"role": role, "content": ""})

    out["messages"] = messages

    # Tools
    tools = payload.get("tools")
    if tools:
        out["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema", {"type": "object", "properties": {}}),
                },
            }
            for t in tools
            if isinstance(t, dict)
        ]

    # tool_choice
    tc = payload.get("tool_choice")
    if tc is not None:
        if isinstance(tc, dict):
            tt = tc.get("type")
            if tt == "auto":
                out["tool_choice"] = "auto"
            elif tt == "any":
                out["tool_choice"] = "required"
            elif tt == "tool":
                out["tool_choice"] = {"type": "function", "function": {"name": tc.get("name", "")}}
            elif tt == "none":
                out["tool_choice"] = "none"
        elif isinstance(tc, str):
            out["tool_choice"] = tc

    # Sampling / misc params
    if "max_tokens" in payload:
        out["max_tokens"] = payload["max_tokens"]
    if "temperature" in payload:
        out["temperature"] = payload["temperature"]
    if "top_p" in payload:
        out["top_p"] = payload["top_p"]
    if payload.get("stop_sequences"):
        out["stop"] = payload["stop_sequences"]
    if payload.get("stream"):
        out["stream"] = True
        out["stream_options"] = {"include_usage": True}

    return out


# --------------------------------------------------------------------------- #
# Response: OpenAI -> Anthropic (non-streaming)
# --------------------------------------------------------------------------- #

_FINISH_TO_STOP = {
    "stop": "end_turn",
    "tool_calls": "tool_use",
    "function_call": "tool_use",
    "length": "max_tokens",
    "content_filter": "end_turn",
    "insufficient_system_resources": "end_turn",
}


def openai_to_anthropic(resp: dict, model_name: Optional[str] = None) -> dict:
    choice = (resp.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content: List[dict] = []

    text = msg.get("content")
    # Some providers (GLM, StepFun) put the answer in reasoning_* and leave content empty.
    if not text:
        text = msg.get("reasoning_content") or msg.get("reasoning") or ""
        if isinstance(text, list):
            text = "".join(
                (b.get("text") or b.get("content") or "") if isinstance(b, dict) else str(b)
                for b in text
            )
    if text:
        content.append({"type": "text", "text": text})

    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        raw_args = fn.get("arguments", "{}")
        try:
            inp = json.loads(raw_args) if raw_args else {}
        except json.JSONDecodeError:
            inp = {"_raw": raw_args}
        content.append({
            "type": "tool_use",
            "id": tc.get("id", ""),
            "name": fn.get("name", ""),
            "input": inp,
        })

    usage = resp.get("usage") or {}
    finish = choice.get("finish_reason")
    return {
        "id": resp.get("id", "msg_openai") if str(resp.get("id", "")).startswith("msg_") else f"msg_{resp.get('id','x')}",
        "type": "message",
        "role": "assistant",
        "model": model_name or resp.get("model", ""),
        "content": content,
        "stop_reason": _FINISH_TO_STOP.get(finish, "end_turn"),
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


# --------------------------------------------------------------------------- #
# Response: OpenAI SSE -> Anthropic SSE (streaming)
# --------------------------------------------------------------------------- #

def _sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


async def openai_stream_to_anthropic(
    aiter: AsyncIterator[bytes],
    model_name: str,
) -> AsyncIterator[bytes]:
    """Consume OpenAI SSE bytes and yield Anthropic-format SSE bytes.

    Statefully maps OpenAI delta.content -> text_delta and delta.tool_calls ->
    tool_use content blocks with input_json_delta, emitting the full Anthropic
    event sequence: message_start, content_block_start/delta/stop, message_delta, message_stop.
    """
    msg_id = "msg_openai_stream"
    block_index = -1          # current open block index
    block_type: Optional[str] = None  # "text" | "tool"
    tool_indices: Dict[int, int] = {}  # openai tool_call index -> anthropic block index
    started = False
    final_stop_reason = "end_turn"
    output_tokens = 0
    input_tokens = 0
    buf = ""

    def open_text_block() -> int:
        nonlocal block_index, block_type
        block_index += 1
        block_type = "text"
        return block_index

    def open_tool_block(idx: int, tool_id: str, name: str) -> int:
        nonlocal block_index, block_type
        block_index += 1
        block_type = "tool"
        tool_indices[idx] = block_index
        return block_index

    def close_current() -> Optional[bytes]:
        nonlocal block_type
        if block_type is None:
            return None
        ev = _sse("content_block_stop", {"type": "content_block_stop", "index": block_index})
        block_type = None
        return ev

    async for raw in aiter:
        if not raw:
            continue
        buf += raw.decode("utf-8", errors="replace")
        # OpenAI SSE records are separated by blank lines; each data line starts with "data: "
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            line = line.strip()
            if not line or line.startswith(":") or not line.startswith("data:"):
                continue
            data_str = line[len("data:"):].strip()
            if data_str == "[DONE]":
                # close any open block then finish
                if not started:
                    # stream ended before any content; still emit a minimal message
                    yield _sse("message_start", {"type": "message_start", "message": {
                        "id": msg_id, "type": "message", "role": "assistant", "content": [],
                        "model": model_name, "stop_reason": None, "stop_sequence": None,
                        "usage": {"input_tokens": 0, "output_tokens": 0}}})
                    started = True
                if block_type is not None:
                    ev = close_current()
                    if ev:
                        yield ev
                yield _sse("message_delta", {"type": "message_delta", "delta": {
                    "stop_reason": final_stop_reason, "stop_sequence": None},
                    "usage": {"output_tokens": output_tokens}})
                yield _sse("message_stop", {"type": "message_stop"})
                return
            try:
                chunk = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            if not started:
                yield _sse("message_start", {"type": "message_start", "message": {
                    "id": msg_id, "type": "message", "role": "assistant", "content": [],
                    "model": model_name, "stop_reason": None, "stop_sequence": None,
                    "usage": {"input_tokens": 0, "output_tokens": 0}}})
                yield _sse("ping", {"type": "ping"})
                started = True

            # usage-only final chunk (choices empty)
            usage = chunk.get("usage")
            if usage:
                input_tokens = usage.get("prompt_tokens", input_tokens)
                output_tokens = usage.get("completion_tokens", output_tokens)

            choices = chunk.get("choices") or []
            if not choices:
                continue
            choice = choices[0]
            delta = choice.get("delta") or {}
            finish = choice.get("finish_reason")

            # text delta (also accept reasoning_* — GLM/StepFun often stream there only)
            dc = delta.get("content") or delta.get("reasoning_content") or delta.get("reasoning")
            if isinstance(dc, list):
                dc = "".join(
                    (b.get("text") or b.get("content") or "") if isinstance(b, dict) else str(b)
                    for b in dc
                )
            if dc:
                if block_type != "text":
                    if block_type is not None:
                        ev = close_current()
                        if ev:
                            yield ev
                    bi = open_text_block()
                    yield _sse("content_block_start", {"type": "content_block_start", "index": bi,
                        "content_block": {"type": "text", "text": ""}})
                yield _sse("content_block_delta", {"type": "content_block_delta",
                    "index": block_index, "delta": {"type": "text_delta", "text": dc}})

            # tool_calls delta
            tcs = delta.get("tool_calls")
            if tcs:
                for tc in tcs:
                    tidx = tc.get("index", 0)
                    fn = tc.get("function") or {}
                    # first time we see this tool index -> open a tool_use block
                    if tidx not in tool_indices:
                        if block_type is not None:
                            ev = close_current()
                            if ev:
                                yield ev
                        bi = open_tool_block(tidx, tc.get("id", f"toolu_{tidx}"), fn.get("name", ""))
                        yield _sse("content_block_start", {"type": "content_block_start", "index": bi,
                            "content_block": {"type": "tool_use", "id": tc.get("id", f"toolu_{tidx}"),
                                              "name": fn.get("name", ""), "input": {}}})
                    args_frag = fn.get("arguments")
                    if args_frag:
                        yield _sse("content_block_delta", {"type": "content_block_delta",
                            "index": tool_indices[tidx],
                            "delta": {"type": "input_json_delta", "partial_json": args_frag}})

            if finish:
                final_stop_reason = _FINISH_TO_STOP.get(finish, "end_turn")
                if block_type is not None:
                    ev = close_current()
                    if ev:
                        yield ev
                yield _sse("message_delta", {"type": "message_delta",
                    "delta": {"stop_reason": final_stop_reason, "stop_sequence": None},
                    "usage": {"output_tokens": output_tokens}})
                yield _sse("message_stop", {"type": "message_stop"})
                return

    # Stream ended without [DONE] / finish_reason — close gracefully.
    if started:
        if block_type is not None:
            ev = close_current()
            if ev:
                yield ev
        yield _sse("message_delta", {"type": "message_delta",
            "delta": {"stop_reason": final_stop_reason, "stop_sequence": None},
            "usage": {"output_tokens": output_tokens}})
        yield _sse("message_stop", {"type": "message_stop"})
