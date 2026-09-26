"""Knightly Swarm LLM agents — Director, Quant, Risk, Execution.
All LLM calls route through free-claude-router on port 8083."""
import json
import logging

from agents.base import KnightlyAgent, parse_json

log = logging.getLogger("knightly.llm")

# ── System prompts ────────────────────────────────────────────────────── #

DIRECTOR_PROMPT = """You are the DIRECTOR of the Knightly Swarm, an AI hedge fund operating on BloFin.
Your role is to generate trading theses from technical candidates.
Given market data and signals for ONE candidate asset, produce JSON:
{"symbol": "...", "direction": "long"/"short", "confidence": 0-1, "rationale": "...",
 "target_price": float, "stop_loss_price": float, "timeframe": "1m"/"5m"/"15m",
 "technical_setup": "breakout"|"breakdown"|"momentum"|"ema_cross"}
Focus on: trend confirmation, volume validation, and technical setup quality.
Output ONLY the JSON object — no extra text.
"""

QUANT_PROMPT = """You are the QUANT agent in the Knightly Swarm.
Perform detailed statistical analysis of the candidate and thesis.
Given the market data, technical indicators, and Director's thesis, compute:
{"signal_strength": 0-1, "support_levels": [floats], "resistance_levels": [floats],
 "volatility_pct": 0-1, "momentum_score": 0-1, "regime": "momentum"|"mean_reversion"|"breakout",
 "confidence": 0-1, "notes": "..."}
Output ONLY the JSON object.
"""

RISK_PROMPT = """You are the RISK MANAGEMENT agent in the Knightly Swarm.
Evaluate the position: position_size as % of equity (max 2% per trade),
stop_loss distance, take_profit distance, risk_reward_ratio (minimum 1.5:1),
max_drawdown_estimate, and confidence_adjustment.
Portfolio-level check: ensure total exposure stays within limits.
Given the symbol, thesis, and quant analysis, output JSON:
{"position_size_pct": 0-1, "position_size_usd": float, "stop_loss_level": float,
 "take_profit_level": float, "risk_reward_ratio": float, "risk_score": 0-1,
 "approved": true/false, "reasoning": "..."}
Never approve a position larger than 2% of equity. Output ONLY JSON.
"""

EXECUTION_PROMPT = """You are the EXECUTION agent in the Knightly Swarm.
Given the approved thesis, quant analysis, and risk assessment, generate
specific BloFin order instructions. Output JSON:
{"symbol": "...", "side": "buy"|"sell", "order_type": "market"|"limit",
 "size": float, "price": float|null, "strategy": "immediate"|"twap"|"iceberg",
 "take_profit_order": {"type": "limit", "price": float, "size": float, "side": "sell"|"buy"},
 "stop_loss_order": {"type": "limit", "price": float, "size": float, "side": "sell"|"buy"}}
For a $10 micro-test trade: size should be tiny (e.g., 0.001 BTC).
Output ONLY the JSON object.
"""


# ── Agent classes ─────────────────────────────────────────────────────── #

class DirectorAgent(KnightlyAgent):
    def __init__(self, shared_state=None):
        super().__init__("director", "Director", DIRECTOR_PROMPT, "👑", shared_state)

    async def analyze(self, symbol: str, candidate: dict) -> dict:
        ctx = json.dumps({"symbol": symbol, "candidate": candidate}, indent=2)
        result = await self.decide_json(ctx)
        return result


class QuantAgent(KnightlyAgent):
    def __init__(self, shared_state=None):
        super().__init__("quant", "Quant", QUANT_PROMPT, "📊", shared_state)

    async def analyze(self, symbol: str, candidate: dict, thesis: dict) -> dict:
        ctx = json.dumps({"symbol": symbol, "candidate": candidate, "thesis": thesis}, indent=2)
        result = await self.decide_json(ctx)
        return result


class RiskAgent(KnightlyAgent):
    def __init__(self, shared_state=None):
        super().__init__("risk", "Risk", RISK_PROMPT, "🛡️", shared_state)

    async def evaluate(self, symbol: str, thesis: dict, quant: dict, equity: float) -> dict:
        ctx = json.dumps({
            "symbol": symbol, "thesis": thesis, "quant": quant, "equity": equity
        }, indent=2)
        result = await self.decide_json(ctx)
        return result


class ExecutionAgent(KnightlyAgent):
    def __init__(self, shared_state=None):
        super().__init__("execution", "Execution", EXECUTION_PROMPT, "⚔️", shared_state)

    async def generate_order(self, symbol: str, thesis: dict, quant: dict, risk: dict) -> dict:
        ctx = json.dumps({
            "symbol": symbol, "thesis": thesis, "quant": quant, "risk": risk
        }, indent=2)
        result = await self.decide_json(ctx)
        return result
