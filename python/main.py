"""
Unified main execution runtime daemon for the 6-system hybrid trading engine.

Loads credentials from the compendium file (with env var and config.json fallbacks),
reads configuration from config.json, and runs the continuous strategy execution loop.
"""


from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

import numpy as np
import pandas as pd

from core.credentials import load_credentials
from core.systems import UnifiedProductionEngine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

_BASE_DIR: Path = Path(__file__).resolve().parent


def _load_config() -> dict:
    """Load configuration from config.json.

    Returns:
        Dict with configuration parameters (is_demo, base_url, ws_url, symbol, etc.)
    """
    config_path = _BASE_DIR / "config.json"
    defaults = {
        "is_demo": False,
        "base_url": "https://openapi.blofin.com",
        "ws_url": "wss://openapi.blofin.com/ws/public",
        "symbol": "BTC-USDT",
        "max_drawdown": 0.12,
        "confidence_threshold": 0.35,
    }
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                defaults.update(loaded)
        except Exception as e:
            logging.warning(f"[CONFIG] Failed to load config.json: {e}")
    return defaults


async def main() -> None:
    """Initialize the engine and run the continuous trading loop."""
    config = _load_config()

    API_KEY, API_SECRET, PASSPHRASE = load_credentials()
    SYMBOL = config.get("symbol", "BTC-USDT")

    engine = UnifiedProductionEngine(
        API_KEY, API_SECRET, PASSPHRASE, is_demo=config.get("is_demo", False)
    )

    asyncio.create_task(engine.blofin.listen_orderbook_stream(SYMBOL))
    engine.llm.update_via_llm_json(
        '{"risk_multiplier": 1.20, "confidence_threshold": 0.25}'
    )

    np.random.seed(42)
    dates = pd.date_range("2026-01-01", periods=100, freq="15min")
    prices = 65000 + np.cumsum(np.random.randn(100) * 50)
    history_df = pd.DataFrame(
        {
            "Open": prices + np.random.randn(100) * 2,
            "High": prices + np.abs(np.random.randn(100) * 10),
            "Low": prices - np.abs(np.random.randn(100) * 10),
            "Close": prices,
            "Volume": np.random.exponential(100, 100),
        },
        index=dates,
    )

    logging.info("--- Unified 6-System Engine Live Loop Started ---")

    for loop_cnt in range(5):
        await asyncio.sleep(3)
        await engine.run_strategy_cycle(SYMBOL, history_df)


if __name__ == "__main__":
    asyncio.run(main())
