"""Base agent for the Knightly Swarm — all LLM calls route through free-claude-router (port 8083)."""
import asyncio
import json
import logging
import time
from typing import Any

import anthropic
from config import ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL

log = logging.getLogger("knightly")

# Every LLM call goes through the local free-claude-router on port 8083.
_client: anthropic.AsyncAnthropic | None = None


def get_llm() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(
            base_url=ANTHROPIC_BASE_URL,   # http://127.0.0.1:8083
            api_key=ANTHROPIC_API_KEY,
        )
    return _client


def parse_json(resp: str) -> dict:
    """Extract the first JSON object from an LLM response string."""
    s = resp.strip()
    # Try direct parse first
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    # Try extracting from code block
    if "```json" in s:
        start = s.index("```json") + 7
        end = s.rindex("```")
        return json.loads(s[start:end].strip())
    if "```" in s:
        start = s.index("```") + 3
        end = s.rindex("```")
        return json.loads(s[start:end].strip())
    # Fallback: find first { ... }
    start, end = s.find("{"), s.rfind("}")
    if start != -1 and end != -1:
        return json.loads(s[start:end + 1])
    return {"raw": s}


class KnightlyAgent:
    """Base class for all agents in the swarm."""
    def __init__(self, name: str, role: str, system_prompt: str,
                 icon: str = "🔮", shared_state: Any = None):
        self.name = name
        self.role = role
        self.system_prompt = system_prompt
        self.icon = icon
        self.shared_state = shared_state
        self._llm: anthropic.AsyncAnthropic | None = None

    @property
    def llm(self) -> anthropic.AsyncAnthropic:
        if self._llm is None:
            self._llm = get_llm()
        return self._llm

    def _set_status(self, status: str, detail: str = ""):
        if self.shared_state:
            self.shared_state.set_agent_status(self.name, status, detail)

    async def decide(self, prompt: str) -> str:
        """Call the LLM via free-claude-router and return raw text."""
        self._set_status("thinking", "LLM processing…")
        t0 = time.time()
        try:
            resp = await self.llm.messages.create(
                model="claude-3-5-sonnet-20241022",
                system=self.system_prompt,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=4096,
                temperature=0.2,
            )
            text = resp.content[0].text
            self._set_status("done", f"Completed in {time.time() - t0:.1f}s")
            return text
        except Exception as e:
            log.exception("%s LLM error: %s", self.name, e)
            self._set_status("error", str(e)[:80])
            return json.dumps({"error": str(e)})

    async def decide_json(self, prompt: str) -> dict:
        """Call the LLM and parse the JSON result."""
        text = await self.decide(prompt)
        return parse_json(text)
