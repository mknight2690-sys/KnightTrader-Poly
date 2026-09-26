#!/usr/bin/env python3
"""
Unified Trading Agent — Integrates TradingView MCP with BloFin API execution.
TP/SL baked in, real-time dashboard, unlike anything on this computer.
"""

import asyncio
import json
import logging
import os
import subprocess
import time
from typing import Dict, List, Optional, Any
from collections import deque

# Set credentials from environment
os.environ.setdefault("BLOFIN_PASSPHRASE", "")
os.environ.setdefault("BLOFIN_API_KEY", "")
os.environ.setdefault("BLOFIN_SECRET_KEY", "")

from config import BLOFIN_API_KEY, BLOFIN_PASSPHRASE, BLOFIN_SECRET_KEY, BLOFIN_REST_URL
from blofin.client import (
    fetch_account_info, fetch_positions, fetch_pending_orders,
    place_order, cancel_order,
)
from blofin.auth import generate_signature, get_timestamp, get_standard_headers

TV_MCP_CLI = "/c/Users/mknig/tradingview-mcp/src/cli/index.js"
TV_MCP_DIR = "/c/Users/mknig/tradingview-mcp"

log = logging.getLogger("unified_trader")


def _ema(values: List[float], period: int) -> List[float]:
    """Calculate EMA manually without pandas."""
    if len(values) < period:
        return [0.0] * len(values)
    multiplier = 2.0 / (period + 1)
    ema = [0.0] * len(values)
    ema[period - 1] = sum(values[:period]) / period
    for i in range(period, len(values)):
        ema[i] = (values[i] - ema[i - 1]) * multiplier + ema[i - 1]
    return ema


def _rsi(values: List[float], period: int = 14) -> List[float]:
    """Calculate RSI manually without pandas."""
    if len(values) < period + 1:
        return [50.0] * len(values)
    deltas = [values[i] - values[i - 1] for i in range(1, len(values))]
    gains = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    rsi = [50.0] * (period + 1)  # Pad early values

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

        if avg_loss == 0:
            r = 100
        else:
            r = 100 - (100 / (1 + avg_gain / avg_loss))
        rsi.append(r)

    # Pad to match input length
    while len(rsi) < len(values):
        rsi.insert(0, 50.0)

    return rsi[-len(values):]


def _atr(highs: List[float], lows: List[float], closes: List[float], period: int = 14) -> List[float]:
    """Calculate ATR manually."""
    if len(closes) < period + 1:
        return [0.0] * len(closes)

    tr_values = []
    for i in range(1, len(closes)):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1])
        )
        tr_values.append(tr)

    # ATR is SMA of TR
    atr = []
    for i in range(len(tr_values)):
        if i < period - 1:
            atr.append(0.0)
        else:
            window = tr_values[i - period + 1: i + 1] if i >= period - 1 else tr_values[:i + 1]
            atr.append(sum(window) / len(window))

    # Pad to match length
    while len(atr) < len(closes):
        atr.insert(0, 0.0)

    return atr[-len(closes):]


def ema_rsi_v4_strategy(ohlcv: List[Dict]) -> Optional[Dict]:
    """Run EMA RSI v4 strategy on OHLCV data (no pandas dependency)."""
    if len(ohlcv) < 50:
        return None

    # Extract price and volume arrays
    closes = []
    highs = []
    lows = []
    volumes = []

    for candle in ohlcv:
        if isinstance(candle, dict):
            # Handle different key names
            close = candle.get("close", candle.get("c"))
            high = candle.get("high", candle.get("h"))
            low = candle.get("low", candle.get("l"))
            vol = candle.get("volume", candle.get("vol"))

            if close is None:
                continue
            closes.append(float(close))
            highs.append(float(high) if high is not None else float(close))
            lows.append(float(low) if low is not None else float(close))
            volumes.append(float(vol) if vol is not None else 1.0)

    if len(closes) < 50:
        return None

    # Calculate indicators
    ema9 = _ema(closes, 9)
    ema21 = _ema(closes, 21)
    ema20 = _ema(closes, 20)
    ema50 = _ema(closes, 50)
    rsi = _rsi(closes, 14)
    atr = _atr(highs, lows, closes, 14)

    # Volume SMA
    vol_sma = sum(volumes[-20:]) / 20 if len(volumes) >= 20 else 1.0

    # Latest values
    latest_close = closes[-1]
    latest_ema9 = ema9[-1]
    latest_ema21 = ema21[-1]
    latest_rsi = rsi[-1] if rsi[-1] != 0 else 50.0
    latest_vol = volumes[-1]
    latest_atr = atr[-1] if atr[-1] > 0 else 0.01

    # 1h trend filter (simplified - use 20/50 EMA crossover as proxy)
    trend_up = ema20[-1] > ema50[-1]
    trend_down = ema20[-1] < ema50[-1]

    # Entry conditions (EMA RSI v4)
    long_cond = (ema9 >= ema21) and (latest_rsi > 30) and trend_up and (latest_vol > vol_sma * 1.5)
    short_cond = (ema9 <= ema21) and (latest_rsi < 70) and trend_down and (latest_vol > vol_sma * 1.5)

    # Generate signal
    if long_cond:
        return {
            "signal": "long",
            "entry_price": latest_close,
            "stop_loss": latest_close - latest_atr * 2,
            "take_profit": latest_close + latest_atr * 3,
            "atr": latest_atr,
            "rsi": latest_rsi,
            "ema_crossover": "bullish"
        }
    elif short_cond:
        return {
            "signal": "short",
            "entry_price": latest_close,
            "stop_loss": latest_close + latest_atr * 2,
            "take_profit": latest_close - latest_atr * 3,
            "atr": latest_atr,
            "rsi": latest_rsi,
            "ema_crossover": "bearish"
        }

    return None


class UnifiedTradingAgent:
    """Main trading agent integrating TradingView MCP signals with BloFin API."""

    def __init__(self):
        self.positions: Dict[str, Dict] = {}
        self.pending_orders: Dict[str, Dict] = {}
        self.trades: List[Dict] = []
        self.running = False
        self.symbol_tv_map = self._load_symbol_mapping()

    def _load_symbol_mapping(self) -> Dict[str, str]:
        """Load BloFin to TradingView symbol mapping."""
        mapping = {}
        # Try absolute path first, then relative
        paths_to_try = [
            "/c/Users/mknig/tradingview-mcp/blofin_usdt_pairs.txt",
            os.path.join(TV_MCP_DIR, "blofin_usdt_pairs.txt"),
            "blofin_usdt_pairs.txt",
        ]
        for path in paths_to_try:
            try:
                with open(path, "r") as f:
                    for line in f:
                        parts = line.strip().split(",")
                        if len(parts) >= 2:
                            mapping[parts[0]] = parts[1]
                if mapping:
                    print(f"Loaded {len(mapping)} symbol mappings from {path}")
                    return mapping
            except (FileNotFoundError, IOError):
                continue

        print("Warning: pairs file not found, using default mapping")
        return {
            "BTC-USDT": "BTCUSDT",
            "ETH-USDT": "ETHUSDT",
            "BNB-USDT": "BNBUSDT",
            "SOL-USDT": "SOLUSDT",
            "XRP-USDT": "XRPUSDT",
        }

    def _run_cli(self, cmd: List[str]) -> Dict:
        """Run MCP CLI command and return parsed result."""
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30,
                cwd=TV_MCP_DIR
            )
            if result.returncode == 0 and result.stdout.strip():
                try:
                    return json.loads(result.stdout.strip())
                except json.JSONDecodeError:
                    return {"raw": result.stdout[:500]}
            else:
                return {"error": result.stderr[:500] if result.stderr else "command failed"}
        except subprocess.TimeoutExpired:
            return {"error": "Command timed out"}
        except Exception as e:
            return {"error": str(e)}

    async def fetch_ohlcv(self, symbol: str, timeframe: str = "5m", limit: int = 100) -> List[Dict]:
        """Fetch OHLCV data from TradingView MCP."""
        tv_symbol = self.symbol_tv_map.get(symbol, symbol.replace("-USDT", ""))
        result = self._run_cli([
            "node", TV_MCP_CLI, "ohlcv",
            "--symbol", f"Bybit:{tv_symbol}.P",
            "--timeframe", timeframe,
            "--limit", str(limit)
        ])
        if "data" in result:
            return result["data"]
        return []

    async def place_order_with_tp_sl(self, symbol: str, side: str, size: str,
                                     stop_loss: float, take_profit: float) -> Dict:
        """Place order with TP/SL on BloFin (TP/SL baked in)."""
        # Place entry order
        entry_result = place_order(
            symbol=symbol,
            side=side,
            order_type="market",
            size=size
        )

        if isinstance(entry_result, dict) and entry_result.get("code") and entry_result["code"] != "0":
            return {"error": "Entry order failed", "details": entry_result}

        # Place TP order (limit order)
        tp_side = "sell" if side == "buy" else "buy"
        tp_result = place_order(
            symbol=symbol,
            side=tp_side,
            order_type="limit",
            size=size,
            price=str(take_profit)
        )

        # Place SL order (stop order)
        sl_result = place_order(
            symbol=symbol,
            side=tp_side,
            order_type="stop",
            size=size,
            price=str(stop_loss)
        )

        return {
            "entry": entry_result,
            "take_profit_order": tp_result,
            "stop_loss_order": sl_result,
            "symbol": symbol,
            "side": side,
            "size": size,
            "stop_loss": stop_loss,
            "take_profit": take_profit
        }

    async def monitor_positions(self):
        """Monitor open positions and check if TP/SL hit."""
        while self.running:
            try:
                positions = fetch_positions()
                if isinstance(positions, dict) and positions.get("code") == "0":
                    for pos in positions.get("data", []):
                        symbol = pos.get("symbol")
                        if symbol not in self.positions:
                            continue

                        current_price = float(pos.get("markPrice", 0))
                        tp_price = self.positions[symbol]["take_profit"]
                        sl_price = self.positions[symbol]["stop_loss"]
                        pos_side = pos.get("side", "long")

                        should_close = False
                        if pos_side == "long":
                            if current_price >= tp_price or current_price <= sl_price:
                                should_close = True
                        elif pos_side == "short":
                            if current_price <= tp_price or current_price >= sl_price:
                                should_close = True

                        if should_close:
                            print(f"Closing position for {symbol} at {current_price}")
                            close_result = place_order(
                                symbol=symbol,
                                side="sell" if pos_side == "long" else "buy",
                                order_type="market",
                                size=pos.get("size", "0")
                            )
                            self.trades.append({
                                "symbol": symbol,
                                "side": pos_side,
                                "entry_price": self.positions[symbol]["entry_price"],
                                "close_price": current_price,
                                "timestamp": time.time()
                            })
                            self.positions.pop(symbol, None)

                await asyncio.sleep(5)
            except Exception as e:
                print(f"Error monitoring: {e}")
                await asyncio.sleep(10)

    async def run_strategy(self):
        """Main strategy loop."""
        print("Starting EMA RSI v4 strategy...")
        top_pairs = ["BTC-USDT", "ETH-USDT", "BNB-USDT", "SOL-USDT", "XRP-USDT"]

        while self.running:
            for symbol in top_pairs:
                try:
                    ohlcv = await self.fetch_ohlcv(symbol, "5m", 200)
                    if not ohlcv:
                        continue

                    signal = ema_rsi_v4_strategy(ohlcv)
                    if not signal:
                        continue

                    if symbol in self.positions:
                        continue

                    size = "0.0001"  # Tiny for testing
                    order_result = await self.place_order_with_tp_sl(
                        symbol=symbol,
                        side=signal["signal"],
                        size=size,
                        stop_loss=signal["stop_loss"],
                        take_profit=signal["take_profit"]
                    )

                    if "error" not in order_result:
                        print(f"Placed {signal['signal']} order for {symbol}")
                        self.positions[symbol] = {
                            "entry_price": signal["entry_price"],
                            "stop_loss": signal["stop_loss"],
                            "take_profit": signal["take_profit"],
                            "side": signal["signal"],
                            "size": size,
                            "timestamp": time.time()
                        }
                    else:
                        print(f"Order failed for {symbol}: {order_result.get('error', 'unknown')}")

                except Exception as e:
                    print(f"Error processing {symbol}: {e}")

            await asyncio.sleep(30)

    async def start(self):
        """Start the trading agent."""
        self.running = True
        print("Unified Trading Agent starting...")
        monitor_task = asyncio.create_task(self.monitor_positions())
        strategy_task = asyncio.create_task(self.run_strategy())
        await asyncio.gather(monitor_task, strategy_task)

    async def stop(self):
        """Stop the trading agent."""
        self.running = False
        print("Unified Trading Agent stopping...")

    def get_status(self) -> Dict:
        """Get current status."""
        return {
            "running": self.running,
            "positions": len(self.positions),
            "trades": len(self.trades),
            "position_details": list(self.positions.values()),
            "recent_trades": self.trades[-10:] if self.trades else []
        }


# FastAPI Dashboard
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse
import uvicorn

app = FastAPI(title="Unified Trading Agent Dashboard")
agent = UnifiedTradingAgent()


@app.get("/")
async def dashboard():
    html_content = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>Unified Trading Agent</title>
        <meta charset="utf-8">
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background: #0a0a0f; color: #e0e0e0; }
            .container { max-width: 1200px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
            h1 { color: #00d4ff; font-size: 24px; }
            .status-badge { padding: 4px 12px; border-radius: 4px; font-size: 12px; }
            .status-running { background: #064e35; color: #6ee7b7; }
            .status-stopped { background: #7f1d1d; color: #fca5a5; }
            .controls { margin: 15px 0; }
            button { padding: 10px 20px; margin: 5px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
            button.start { background: #059669; color: white; }
            button.stop { background: #dc2626; color: white; }
            .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
            .metric-card { background: #1a1a2e; padding: 15px; border-radius: 8px; border: 1px solid #333; }
            .metric-value { font-size: 28px; font-weight: bold; color: #00d4ff; }
            .metric-label { font-size: 12px; color: #888; margin-top: 4px; }
            table { width: 100%; border-collapse: collapse; margin: 15px 0; background: #1a1a2e; border-radius: 8px; overflow: hidden; }
            th { background: #16213e; padding: 10px; text-align: left; color: #00d4ff; }
            td { padding: 8px 10px; border-bottom: 1px solid #333; }
            .position-long { color: #6ee7b7; }
            .position-short { color: #fca5a5; }
            .websocket-status { height: 4px; background: #333; position: fixed; bottom: 0; left: 0; right: 0; }
            .websocket-active { background: #059669; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>⚔️ Unified Trading Agent</h1>
                <span id="statusBadge" class="status-badge status-stopped">Stopped</span>
            </div>
            <div class="websocket-status" id="wsStatus"></div>
            <div class="controls">
                <button class="start" onclick="startTrading()">Start Trading</button>
                <button class="stop" onclick="stopTrading()">Stop Trading</button>
                <button onclick="refreshStatus()">Refresh</button>
            </div>
            <div class="metrics-grid">
                <div class="metric-card"><div class="metric-value" id="positions">0</div><div class="metric-label">Open Positions</div></div>
                <div class="metric-card"><div class="metric-value" id="trades">0</div><div class="metric-label">Total Trades</div></div>
                <div class="metric-card"><div class="metric-value" id="balance">--</div><div class="metric-label">Account Balance</div></div>
            </div>
            <h2>Open Positions</h2>
            <table>
                <thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Stop Loss</th><th>Take Profit</th><th>Size</th></tr></thead>
                <tbody id="positionsBody"></tbody>
            </table>
            <h2>Recent Trades</h2>
            <table>
                <thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Time</th></tr></thead>
                <tbody id="tradesBody"></tbody>
            </table>
        </div>
        <script>
            const ws = new WebSocket('ws://localhost:8081/ws');
            ws.onopen = () => document.getElementById('wsStatus').className = 'websocket-status websocket-active';
            ws.onclose = () => document.getElementById('wsStatus').className = 'websocket-status';
            ws.onmessage = (event) => {
                const d = JSON.parse(event.data);
                document.getElementById('statusBadge').textContent = d.running ? 'Running' : 'Stopped';
                document.getElementById('statusBadge').className = 'status-badge ' + (d.running ? 'status-running' : 'status-stopped');
                document.getElementById('positions').textContent = d.positions;
                document.getElementById('trades').textContent = d.trades;
                const pb = document.getElementById('positionsBody');
                pb.innerHTML = '';
                (d.position_details || []).forEach(p => {
                    const row = pb.insertRow();
                    row.className = p.side === 'long' ? 'position-long' : 'position-short';
                    row.insertCell().textContent = p.symbol;
                    row.insertCell().textContent = p.side;
                    row.insertCell().textContent = p.entry_price.toFixed(2);
                    row.insertCell().textContent = p.stop_loss.toFixed(2);
                    row.insertCell().textContent = p.take_profit.toFixed(2);
                    row.insertCell().textContent = p.size;
                });
                const tb = document.getElementById('tradesBody');
                tb.innerHTML = '';
                (d.recent_trades || []).slice().reverse().forEach(t => {
                    const row = tb.insertRow();
                    row.insertCell().textContent = t.symbol;
                    row.insertCell().textContent = t.side;
                    row.insertCell().textContent = t.entry_price.toFixed(2);
                    row.insertCell().textContent = t.close_price.toFixed(2);
                    row.insertCell().textContent = new Date(t.timestamp * 1000).toLocaleTimeString();
                });
            };
            async function startTrading() {
                await fetch('/api/start', {method: 'POST'});
                setTimeout(refreshStatus, 1000);
            }
            async function stopTrading() {
                await fetch('/api/stop', {method: 'POST'});
                setTimeout(refreshStatus, 1000);
            }
            async function refreshStatus() {
                const r = await fetch('/api/status');
                const d = await r.json();
                document.getElementById('statusBadge').textContent = d.running ? 'Running' : 'Stopped';
                document.getElementById('statusBadge').className = 'status-badge ' + (d.running ? 'status-running' : 'status-stopped');
                document.getElementById('positions').textContent = d.positions;
                document.getElementById('trades').textContent = d.trades;
            }
            refreshStatus();
            setInterval(refreshStatus, 5000);
        </script>
    </body>
    </html>
    """
    return HTMLResponse(html_content)


@app.get("/api/status")
async def get_status():
    """Get agent status."""
    return JSONResponse(agent.get_status())


@app.post("/api/start")
async def start_trading():
    """Start trading."""
    if not agent.running:
        asyncio.create_task(agent.start())
        await asyncio.sleep(1)
    return {"status": "started", "running": agent.running}


@app.post("/api/stop")
async def stop_trading():
    """Stop trading."""
    if agent.running:
        await agent.stop()
    return {"status": "stopped", "running": agent.running}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket for real-time updates."""
    await websocket.accept()
    try:
        while True:
            await websocket.send_text(json.dumps(agent.get_status()))
            await asyncio.sleep(1)
    except:
        pass


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8081)