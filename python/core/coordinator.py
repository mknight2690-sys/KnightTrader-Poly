"""
LLM Strategy Coordinator.

Provides an asynchronous interface for LLMs to adjust trading strategy
hyperparameters (risk_multiplier, confidence_threshold) at runtime without
restarting the daemon.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict


class LLMStrategyCoordinator:
    """Manages dynamic strategy parameters updated by LLM commands.

    Attributes:
        risk_multiplier: Multiplier applied to allocation signals (default 1.0).
        confidence_threshold: Minimum absolute allocation to trigger execution
            (default 0.35).
    """

    def __init__(self) -> None:
        """Initialize coordinator with default hyperparameters."""
        self.risk_multiplier: float = 1.0
        self.confidence_threshold: float = 0.35

    def update_via_llm_json(self, json_command: str) -> None:
        """Parse a JSON command string and update strategy parameters.

        Expected JSON schema:
            {"risk_multiplier": <float>, "confidence_threshold": <float>}

        Args:
            json_command: JSON string containing parameter updates. Unused keys
                are ignored; present values override existing ones.
        """
        try:
            params: Dict[str, Any] = json.loads(json_command)
            self.risk_multiplier = float(
                params.get("risk_multiplier", self.risk_multiplier)
            )
            self.confidence_threshold = float(
                params.get("confidence_threshold", self.confidence_threshold)
            )
            logging.info(
                f"[LLM UPDATE] Risk Multiplier={self.risk_multiplier} | "
                f"Conf Threshold={self.confidence_threshold}"
            )
        except Exception as e:
            logging.error(f"[LLM PARSE ERROR] {e}")

    async def async_update_via_llm_json(self, json_command: str) -> None:
        """Asynchronous wrapper around update_via_llm_json.

        Args:
            json_command: JSON string containing parameter updates.
        """
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None, self.update_via_llm_json, json_command
        )
