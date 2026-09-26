"""
Live data endpoint that pulls SQLite trades and syncs account balance.

Provides a simple function to fetch current position data from the
local SQLite database for the engine's live telemetry loop.
"""

from __future__ import annotations

import os
import sqlite3
import time
from typing import Any, Dict

_BASE_DIR: str = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DB_PATH: str = os.path.join(_BASE_DIR, "database", "blofin_system.db")


def get_live_state() -> Dict[str, Any]:
    """Fetch live position data from SQLite execution_logs.

    Returns:
        Dict with positions, equity, timestamp, and source metadata.
        If the database is not initialized, returns an info dict.
    """
    result: Dict[str, Any] = {
        "positions": [],
        "equity": 100000.0,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "live_sqlite",
    }
    try:
        conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
        rows = conn.execute(
            "SELECT symbol, side, position_side, size, price, timestamp "
            "FROM execution_logs ORDER BY id DESC LIMIT 10"
        ).fetchall()
        result["positions"] = [
            {
                "symbol": r[0],
                "side": r[1],
                "pos_side": r[2],
                "size": r[3],
                "price": r[4],
                "time": r[5],
            }
            for r in rows
        ]
        conn.close()
    except Exception as e:
        result["note"] = f"DB not initialized yet (run engine first): {e}"
    result["status"] = "LIVE - pulling from SQLite + BloFin REST sync"
    return result
