"""Knightly Swarm Scanner — screens all ~500 BloFin assets via technical indicators (no LLM).
Identifies breakout / breakdown / momentum candidates for the LLM agent pipeline."""
import asyncio
import logging
import time
from typing import Any

import numpy as np
import pandas as pd

from blofin.client import fetch_candles

log = logging.getLogger("knightly.scanner")


def _rsi(series: pd.Series, window: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = (-delta).where(delta < 0, 0.0)
    avg_g = gain.rolling(window).mean()
    avg_l = loss.rolling(window).mean()
    rs = avg_g / (avg_l + 1e-12)
    return 100.0 - (100.0 / (1.0 + rs))


def _macd(series: pd.Series, fast=12, slow=26, signal=9):
    ema_fast = series.ewm(span=fast, adjust=False).mean()
    ema_slow = series.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    return macd_line, signal_line


def _bbands(series, window=20, std=2.0):
    sma = series.rolling(window).mean()
    std_val = series.rolling(window).std()
    return sma, sma + std_val * std, sma - std_val * std


def analyze_symbol(symbol: str, candles: list[dict]) -> dict | None:
    if not candles or len(candles) < 50:
        return None
    df = pd.DataFrame(candles)
    for col in ("close", "c"):
        if col in df.columns:
            df["close"] = pd.to_numeric(df[col], errors="coerce")
            break
    for col in ("volume", "vol"):
        if col in df.columns:
            df["vol"] = pd.to_numeric(df[col], errors="coerce")
            break
    for col in ("high", "h"):
        if col in df.columns:
            df["high"] = pd.to_numeric(df[col], errors="coerce")
            break
    for col in ("low", "l"):
        if col in df.columns:
            df["low"] = pd.to_numeric(df[col], errors="coerce")
            break
    df = df.dropna(subset=["close"])
    if len(df) < 50:
        return None
    close = df["close"]
    vol = df.get("vol", pd.Series([0] * len(df)))
    sma20 = close.rolling(20).mean()
    sma50 = close.rolling(50).mean()
    sma200 = close.rolling(200).mean()
    bb_mid, bb_upper, bb_lower = _bbands(close)
    rsi = _rsi(close)
    macd_line, macd_signal = _macd(close)
    latest_close = float(close.iloc[-1])
    latest_rsi = float(rsi.iloc[-1]) if not np.isnan(rsi.iloc[-1]) else 50.0
    latest_macd = float(macd_line.iloc[-1]) if not np.isnan(macd_line.iloc[-1]) else 0.0
    latest_macd_sig = float(macd_signal.iloc[-1]) if not np.isnan(macd_signal.iloc[-1]) else 0.0
    vol_latest = float(vol.iloc[-1]) if not np.isnan(vol.iloc[-1]) else 0.0
    vol_avg = float(vol.rolling(20).mean().iloc[-1]) if not np.isnan(vol.rolling(20).mean().iloc[-1]) else 1.0
    vol_ratio = vol_latest / (vol_avg + 1e-12)
    recent_high = float(df["high"].tail(20).max()) if "high" in df.columns else latest_close
    recent_low = float(df["low"].tail(20).min()) if "low" in df.columns else latest_close
    signal, strength, direction = None, 0.0, "flat"
    if latest_close > recent_high and vol_ratio > 1.5:
        signal, direction, strength = "breakout", "long", min(1.0, vol_ratio / 5.0)
    elif latest_close < recent_low and vol_ratio > 1.5:
        signal, direction, strength = "breakdown", "short", min(1.0, vol_ratio / 5.0)
    elif len(sma20) >= 2 and sma20.iloc[-1] > sma50.iloc[-1] and sma20.iloc[-2] <= sma50.iloc[-2]:
        signal, direction, strength = "ema_cross_bullish", "long", 0.5
    elif len(sma20) >= 2 and sma20.iloc[-1] < sma50.iloc[-1] and sma20.iloc[-2] >= sma50.iloc[-2]:
        signal, direction, strength = "ema_cross_bearish", "short", 0.5
    if latest_rsi > 60 or latest_rsi < 40:
        strength = min(1.0, strength * 1.1)
    if signal is None or strength < 0.3:
        return None
    return {
        "symbol": symbol, "signal": signal, "direction": direction,
        "strength": round(strength, 3), "price": latest_close, "rsi": round(latest_rsi, 1),
        "macd_hist": round(latest_macd - latest_macd_sig, 4), "vol_ratio": round(vol_ratio, 2),
        "support": round(recent_low, 2), "resistance": round(recent_high, 2),
        "sma20": round(float(sma20.iloc[-1]) if not np.isnan(sma20.iloc[-1]) else latest_close, 2),
        "sma50": round(float(sma50.iloc[-1]) if not np.isnan(sma50.iloc[-1]) else latest_close, 2),
        "sma200": round(float(sma200.iloc[-1]) if not np.isnan(sma200.iloc[-1]) else latest_close, 2),
    }


class ScannerAgent:
    """Continuously scans all ~500 BloFin assets. No LLM — pure TA computation."""

    def __init__(self, shared_state: Any):
        self.shared_state = shared_state
        self._cached_assets: list[dict] = []
        self._cached_candidates: list[dict] = []

    async def scan_once(self) -> list[dict]:
        now = time.time()
        self.shared_state.set_agent_status("scanner", "scanning", "Fetching 500 assets…")
        try:
            from blofin.assets import get_asset_universe
            assets = get_asset_universe(force_refresh=True)
            if not assets:
                return self._cached_candidates
            self._cached_assets = [
                {"symbol": a["symbol"], "price": a["lastPrice"], "change24h": a["changePercent"],
                 "volume24h": a["volume24h"], "signal": "none", "inPipeline": False}
                for a in assets
            ]
            self.shared_state.update_assets(self._cached_assets)
            top_symbols = [a["symbol"] for a in sorted(
                self._cached_assets, key=lambda x: x["volume24h"], reverse=True)[:100]]
            self.shared_state.set_agent_status("scanner", "analyzing", f"Analyzing {len(top_symbols)} symbols…")
            candidates = []
            batch_size = 20
            for i in range(0, len(top_symbols), batch_size):
                batch = top_symbols[i:i + batch_size]
                tasks = [self._fetch_and_analyze(s) for s in batch]
                results = await asyncio.gather(*tasks, return_exceptions=True)
                for r in results:
                    if isinstance(r, dict) and r is not None:
                        candidates.append(r)
            candidates.sort(key=lambda c: c["strength"], reverse=True)
            self._cached_candidates = candidates[:8]
            self.shared_state.set_agent_status("scanner", "done", f"{len(self._cached_candidates)} candidates")
            return self._cached_candidates
        except Exception as e:
            log.error("Scan error: %s", e)
            return self._cached_candidates

    async def _fetch_and_analyze(self, symbol: str) -> dict | None:
        try:
            from concurrent.futures import ThreadPoolExecutor
            loop = asyncio.get_event_loop()
            candles = await loop.run_in_executor(
                None, fetch_candles, symbol, "1m", 100)
            return analyze_symbol(symbol, candles)
        except Exception as e:
            log.debug("Scan error for %s: %s", symbol, e)
            return None

    async def run(self):
        from config import SCAN_INTERVAL
        while True:
            await self.scan_once()
            await asyncio.sleep(SCAN_INTERVAL)
