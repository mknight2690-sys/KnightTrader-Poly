"""Knightly Swarm orchestrator.

Coordinates the multi-agent pipeline:
  Scanner (TA, no LLM) -> Director (LLM) -> Quant (LLM) -> Risk (LLM) -> Execution (LLM) -> Order

All LLM calls route through free-claude-router on port 8083.
State streams to the dashboard via WebSocket at <500ms.
"""
import asyncio
import json
import logging
import time
from typing import Any, Optional
from weakref import WeakSet

from config import TRADING_ENABLED, RISK_PER_TRADE
from agents.scanner import ScannerAgent
from agents.llm_agents import DirectorAgent, QuantAgent, RiskAgent, ExecutionAgent
from blofin.client import (
    fetch_account_info, fetch_positions, fetch_pending_orders,
    place_order, cancel_order,
)

log = logging.getLogger("knightly.swarm")


class SharedState:
    """Global state object — updated by agents, streamed to the dashboard."""

    def __init__(self):
        self._lock = asyncio.Lock()
        self._agents: dict[str, dict] = {}
        self._assets: list[dict] = []
        self._pipeline: list[dict] = []
        self._account: dict = {
            "balance": 0.0, "equity": 0.0, "pnl": 0.0,
            "pnl_percent": 0.0, "positions": [],
            "daily_trades": 0, "win_rate": 0.0,
        }
        self._trades: list[dict] = []
        self._logs: list[dict] = []
        self._system: dict = {
            "router_status": True, "blofin_connected": True,
            "trading_enabled": TRADING_ENABLED, "single_instance": True,
            "uptime": 0.0,
        }
        self._start_ts = time.time()

    def init_agent(self, name: str, display_name: str, icon: str):
        self._agents[name] = {
            "name": display_name, "icon": icon, "status": "idle",
            "detail": "", "last_update": 0.0,
        }

    def set_agent_status(self, name: str, status: str, detail: str = ""):
        if name in self._agents:
            self._agents[name]["status"] = status
            self._agents[name]["detail"] = detail
            self._agents[name]["last_update"] = time.time()

    def log(self, agent: str, message: str):
        self._logs.insert(0, {
            "agent": agent, "message": message[:200],
            "ts": time.time(),
        })
        self._logs = self._logs[:200]

    def update_assets(self, assets: list[dict]):
        self._assets = assets

    def update_account(self, account: dict):
        self._account.update(account)

    def add_trade(self, trade: dict):
        self._trades.insert(0, trade)
        self._trades = self._trades[:100]
        self._account["daily_trades"] = len(self._trades)

    def add_pipeline_item(self, item: dict):
        self._pipeline.insert(0, item)
        self._pipeline = self._pipeline[:20]

    def to_dict(self) -> dict:
        return {
            "agents": dict(self._agents),
            "assets": self._assets,
            "pipeline": self._pipeline,
            "account": self._account,
            "trades": self._trades,
            "logs": self._logs[:50],
            "system": {**self._system, "uptime": time.time() - self._start_ts},
        }


class KnightSwarm:
    """Orchestrates the Knightly Swarm multi-agent pipeline."""

    def __init__(self, state: SharedState):
        self.state = state
        self.scanner = ScannerAgent(state)
        self.director = DirectorAgent(state)
        self.quant = QuantAgent(state)
        self.risk = RiskAgent(state)
        self.execution = ExecutionAgent(state)
        self.ws_clients: WeakSet = WeakSet()
        self._running = False
        self._trade_counter = 0

    # -- WebSocket broadcasting --

    async def register_ws(self, ws):
        """Register a new WebSocket client."""
        self.ws_clients.add(ws)
        log.info("WebSocket client registered (%d total)", len(self.ws_clients))

    async def unregister_ws(self, ws):
        """Remove a WebSocket client."""
        self.ws_clients.discard(ws)
        log.info("WebSocket client removed (%d total)", len(self.ws_clients))

    async def broadcast(self):
        """Send current state to all WebSocket clients."""
        if not self.ws_clients:
            return
        data = json.dumps(self.state.to_dict())
        dead = set()
        for ws in self.ws_clients:
            try:
                await ws.send_text(data)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.ws_clients.discard(ws)

    async def broadcast_loop(self):
        """Broadcast state every 200ms for sub-500ms streaming."""
        while True:
            try:
                await self.broadcast()
            except Exception:
                pass
            await asyncio.sleep(0.2)

    # -- Account polling --

    async def account_loop(self):
        """Poll account info every 5 seconds."""
        while True:
            try:
                info = fetch_account_info()
                positions = fetch_positions()
                # Try to extract balance
                balance = 0.0
                if isinstance(info, dict):
                    if info.get("code") == "0":
                        data = info.get("data", {})
                        if isinstance(data, dict):
                            balance = float(data.get("balance", data.get("available", 0)))
                self.state.update_account({
                    "balance": balance,
                    "equity": balance,  # simplified
                    "positions": positions.get("data", []) if isinstance(positions, dict) else [],
                })
            except Exception as e:
                log.debug("Account poll error: %s", e)
            await asyncio.sleep(5)

    # -- LLM pipeline --

    async def process_candidate(self, candidate: dict):
        """Process a single candidate through the full LLM pipeline."""
        symbol = candidate["symbol"]
        self.state.add_pipeline_item({
            "symbol": symbol,
            "candidate": candidate,
            "stages": {},
            "status": "running",
        })
        self.state.log("swarm", f"Processing candidate: {symbol}")

        start = time.time()

        # Stage 1: Director
        self.state.set_agent_status("director", "thinking", f"Analyzing {symbol}…")
        try:
            thesis = await self.director.analyze(symbol, candidate)
            self.state.log("director", f"Thesis: {json.dumps(thesis)[:200]}")
            if "error" in thesis:
                self._pipeline_fail(symbol, "director", thesis["error"], start)
                return
        except Exception as e:
            self._pipeline_fail(symbol, "director", str(e), start)
            return

        # Stage 2: Quant
        self.state.set_agent_status("quant", "analyzing", f"Quant analysis {symbol}…")
        try:
            quant_result = await self.quant.analyze(symbol, candidate, thesis)
            self.state.log("quant", f"Signal strength: {quant_result.get('signal_strength', 'N/A')}")
            if "error" in quant_result:
                self._pipeline_fail(symbol, "quant", quant_result["error"], start)
                return
        except Exception as e:
            self._pipeline_fail(symbol, "quant", str(e), start)
            return

        # Stage 3: Risk
        self.state.set_agent_status("risk", "sizing", f"Risk assessment {symbol}…")
        try:
            equity = self.state._account.get("equity", 0)
            risk_result = await self.risk.evaluate(symbol, thesis, quant_result, equity)
            self.state.log("risk", f"Risk score: {risk_result.get('risk_score', 'N/A')}")
            if "error" in risk_result:
                self._pipeline_fail(symbol, "risk", risk_result["error"], start)
                return
        except Exception as e:
            self._pipeline_fail(symbol, "risk", str(e), start)
            return

        # Stage 4: Execution
        if not risk_result.get("approved", False):
            self.state.log("swarm", f"Trade not approved for {symbol}: {risk_result.get('reasoning', 'N/A')}")
            self._pipeline_complete(symbol, "rejected", start)
            return

        self.state.set_agent_status("execution", "executing", f"Generating order {symbol}…")
        try:
            order = await self.execution.generate_order(symbol, thesis, quant_result, risk_result)
            if "error" in order:
                self._pipeline_fail(symbol, "execution", order["error"], start)
                return
        except Exception as e:
            self._pipeline_fail(symbol, "execution", str(e), start)
            return

        # Stage 5: Place order (if trading enabled)
        if TRADING_ENABLED and self.state._system.get("trading_enabled", False):
            await self._execute_trade(symbol, order)
        else:
            self.state.log("swarm", f"Would have traded: {json.dumps(order)[:200]}")

        self._pipeline_complete(symbol, "completed", start)
        self.state.set_agent_status("execution", "done", f"Order generated for {symbol}")

    def _pipeline_fail(self, symbol: str, stage: str, error: str, start: float):
        elapsed = time.time() - start
        self.state.log("swarm", f"Pipeline failed at {stage} for {symbol}: {error}")
        for item in self.state._pipeline:
            if item["symbol"] == symbol:
                item["status"] = "failed"
                item["error"] = error
                item["elapsed"] = round(elapsed, 2)

    def _pipeline_complete(self, symbol: str, status: str, start: float):
        elapsed = time.time() - start
        for item in self.state._pipeline:
            if item["symbol"] == symbol:
                item["status"] = status
                item["elapsed"] = round(elapsed, 2)

    async def _execute_trade(self, symbol: str, order: dict):
        """Place an order on BloFin."""
        self.state.log("swarm", f"Placing {order['side']} order for {symbol}")
        self._trade_counter += 1
        try:
            result = place_order(
                symbol=symbol,
                side=order["side"],
                order_type=order.get("order_type", "market"),
                size=str(order["size"]),
                price=order.get("price"),
            )
            self.state.add_trade({
                "id": self._trade_counter,
                "symbol": symbol,
                "side": order["side"],
                "size": order["size"],
                "price": order.get("price") or 0,
                "timestamp": time.time(),
                "result": str(result)[:200],
                "status": "filled" if isinstance(result, dict) and result.get("code") == "0" else "error",
            })
            self.state.log("swarm", f"Trade executed: {symbol} {order['side']} {order['size']}")
        except Exception as e:
            self.state.log("swarm", f"Trade failed: {e}")
            self.state.add_trade({
                "id": self._trade_counter,
                "symbol": symbol,
                "side": order["side"],
                "size": order["size"],
                "price": order.get("price") or 0,
                "timestamp": time.time(),
                "status": "error",
                "error": str(e)[:200],
            })

    # -- Main pipeline --

    async def pipeline_loop(self):
        """Main loop: scan -> pipeline -> repeat."""
        while True:
            try:
                candidates = await self.scanner.scan_once()
                self.state.log("scanner", f"Found {len(candidates)} candidates")

                # Process candidates through LLM pipeline
                for candidate in candidates[:MAX_CONCURRENT]:
                    # Mark asset as in-pipeline
                    for asset in self.state._assets:
                        if asset["symbol"] == candidate["symbol"]:
                            asset["inPipeline"] = True
                            asset["signal"] = candidate["signal"]

                    await self.process_candidate(candidate)

                    # Unmark
                    for asset in self.state._assets:
                        if asset["symbol"] == candidate["symbol"]:
                            asset["inPipeline"] = False

                # Reset LLM agents to idle
                for name in ("director", "quant", "risk", "execution"):
                    self.state.set_agent_status(name, "idle", "")
            except Exception as e:
                log.exception("Pipeline error: %s", e)
                self.state.log("swarm", f"Pipeline error: {e}")
            await asyncio.sleep(1)

    async def start(self):
        """Start all background tasks."""
        self._running = True
        for name, icon in [("scanner", "🔍"), ("director", "👑"),
                           ("quant", "📊"), ("risk", "🛡️"), ("execution", "⚔️")]:
            self.state.init_agent(name, name.capitalize(), icon)

        self.state.log("swarm", "KnightSwarm starting…")
        tasks = [
            asyncio.create_task(self.scanner.run()),
            asyncio.create_task(self.pipeline_loop()),
            asyncio.create_task(self.broadcast_loop()),
            asyncio.create_task(self.account_loop()),
        ]
        await asyncio.gather(*tasks)

    async def stop(self):
        """Stop all background tasks."""
        self._running = False
        self.state.log("swarm", "KnightSwarm stopping…")


# Avoid circular import
from config import MAX_CANDIDATES  # noqa: E402
MAX_CONCURRENT = 2  # Process 2 candidates at a time through LLM pipeline
