"""
SQLite persistence layer for trade logging, telemetry, and OBI storage.

Tables:
  - execution_logs: audit trail of all executed trades
  - telemetry: engine runtime telemetry (OBI, regime, alloc, etc.)
  - obi_history: order book imbalance snapshots for analysis
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from typing import Any, Dict, List, Optional


class ProductionDatabase:
    """Handles persistent local storage for market data and execution audits.

    Uses CREATE TABLE IF NOT EXISTS for safe idempotent initialization to
    prevent SQLite schema locks on restarts.
    """

    def __init__(self, db_path: str = "database/blofin_system.db") -> None:
        """Initialize the database, creating the directory and tables as needed.

        Args:
            db_path: Relative or absolute path to the SQLite database file.
        """
        db_dir = os.path.dirname(db_path)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        else:
            os.makedirs(".", exist_ok=True)
        self.db_path: str = db_path
        self.conn: sqlite3.Connection = sqlite3.connect(db_path, check_same_thread=False)
        self._init_tables()

    def _init_tables(self) -> None:
        """Create tables if they do not already exist (idempotent)."""
        with self.conn:
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS execution_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT,
                    symbol TEXT,
                    side TEXT,
                    position_side TEXT,
                    size REAL,
                    price REAL,
                    obi REAL,
                    alloc REAL,
                    response TEXT
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS telemetry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT,
                    symbol TEXT,
                    obi REAL,
                    regime INTEGER,
                    alloc REAL,
                    prob REAL,
                    effective_alloc REAL,
                    equity REAL,
                    drawdown REAL
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS obi_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT,
                    symbol TEXT,
                    obi REAL,
                    bid_volume REAL,
                    ask_volume REAL
                )
                """
            )

    def log_trade(
        self,
        symbol: str,
        side: str,
        pos_side: str,
        size: float,
        price: float,
        obi: float,
        alloc: float,
        resp: Dict[str, Any],
    ) -> None:
        """Persist a single trade execution to the execution_logs table.

        Args:
            symbol: Trading pair identifier (e.g., "BTC-USDT").
            side: "buy" or "sell".
            pos_side: "long" or "short".
            size: Order size in base currency.
            price: Execution price.
            obi: Order Book Imbalance at execution time.
            alloc: Model allocation signal.
            resp: Full BloFin API response dict.
        """
        with self.conn:
            self.conn.execute(
                "INSERT INTO execution_logs "
                "(timestamp, symbol, side, position_side, size, price, obi, alloc, response) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    time.strftime("%Y-%m-%d %H:%M:%S"),
                    symbol,
                    side,
                    pos_side,
                    size,
                    price,
                    obi,
                    alloc,
                    json.dumps(resp),
                ),
            )

    def log_telemetry(
        self,
        symbol: str,
        obi: float,
        regime: int,
        alloc: float,
        prob: float,
        effective_alloc: float,
        equity: float,
        drawdown: float,
    ) -> None:
        """Persist one telemetry snapshot from a strategy cycle.

        Args:
            symbol: Trading pair identifier.
            obi: Order Book Imbalance value.
            regime: GMM regime label (0, 1, or 2).
            alloc: Raw model allocation signal.
            prob: Random Forest directional probability.
            effective_alloc: LLM-adjusted allocation.
            equity: Current account equity.
            drawdown: Current drawdown fraction.
        """
        with self.conn:
            self.conn.execute(
                "INSERT INTO telemetry "
                "(timestamp, symbol, obi, regime, alloc, prob, effective_alloc, equity, drawdown) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    time.strftime("%Y-%m-%d %H:%M:%S"),
                    symbol,
                    obi,
                    regime,
                    alloc,
                    prob,
                    effective_alloc,
                    equity,
                    drawdown,
                ),
            )

    def log_obi(
        self, symbol: str, obi: float, bid_volume: float, ask_volume: float
    ) -> None:
        """Persist an OBI snapshot to obi_history.

        Args:
            symbol: Trading pair identifier.
            obi: Computed OBI value.
            bid_volume: Total bid-side volume in the book.
            ask_volume: Total ask-side volume in the book.
        """
        with self.conn:
            self.conn.execute(
                "INSERT INTO obi_history "
                "(timestamp, symbol, obi, bid_volume, ask_volume) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    time.strftime("%Y-%m-%d %H:%M:%S"),
                    symbol,
                    obi,
                    bid_volume,
                    ask_volume,
                ),
            )

    def get_recent_trades(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Retrieve the most recent trade executions.

        Args:
            limit: Maximum number of rows to return.

        Returns:
            List of dicts with keys: symbol, side, pos_side, size, price,
            obi, alloc, response, timestamp.
        """
        rows = self.conn.execute(
            "SELECT symbol, side, position_side, size, price, obi, alloc, response, timestamp "
            "FROM execution_logs ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {
                "symbol": r[0],
                "side": r[1],
                "pos_side": r[2],
                "size": float(r[3]),
                "price": float(r[4]),
                "obi": float(r[5]) if r[5] is not None else None,
                "alloc": float(r[6]) if r[6] is not None else None,
                "response": r[7],
                "timestamp": r[8],
            }
            for r in rows
        ]

    def get_total_trade_count(self) -> int:
        """Return the total number of executions logged.

        Returns:
            Integer row count from execution_logs.
        """
        row: Optional[tuple] = self.conn.execute(
            "SELECT COUNT(*) FROM execution_logs"
        ).fetchone()
        return row[0] if row else 0
