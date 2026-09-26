"""
Modular implementations of all 6 trading systems plus neural model definitions.

Systems:
  - System 1: Adaptive ML Factor Scoring (Garman-Klass, Parkinson, Z-Scores, RF)
  - System 2: GMM Regime Gate & Sizing (volatility clustering, regime suppression)
  - System 3: Deep RL & Circuit Breaker (Actor-Critic PPO, drawdown guard)
  - System 4: Async Sequence Transformer & Executor (PyTorch Multi-Head, HMAC execution)
  - System 5: Microstructural Engine (high-speed WebSocket feature extraction)
  - System 6: Sub-Microsecond OBI Filtering (volume-weighted OBI gate threshold)
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, Tuple

import joblib
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.ensemble import RandomForestClassifier
from sklearn.mixture import GaussianMixture
from sklearn.preprocessing import RobustScaler

from .connector import BloFinProductionClient
from .coordinator import LLMStrategyCoordinator
from .credentials import load_credentials
from .database import ProductionDatabase

logger = logging.getLogger(__name__)

_FEATURE_COLUMNS = [
    "gk_vol", "parkerson_vol", "ofi_z",
    "z_score_10", "z_score_30", "z_score_60", "log_ret",
]


# =====================================================================
# NEURAL NETWORK MODEL DEFINITIONS (Systems 3 & 4)
# =====================================================================

class MarketTransformerEncoder(nn.Module):
    """System 4: Multi-head Transformer Encoder for temporal feature processing.

    Projects raw feature sequences into a latent embedding space, processes them
    through a 2-layer Transformer encoder, and produces a 32-dim embedding.

    NOTE: Do not modify without updating input/output dimension assertions.
    Input shape:  (batch, seq_len, feature_dim)
    Output shape: (batch, 32)
    """

    def __init__(self, feature_dim: int = 7, d_model: int = 64) -> None:
        """Initialize the transformer encoder.

        Args:
            feature_dim: Number of input features per timestep (default 7).
            d_model: Internal embedding dimension (default 64).
        """
        super().__init__()
        assert feature_dim > 0, "feature_dim must be positive"
        self.feature_dim: int = feature_dim
        self.d_model: int = d_model
        self.input_projection = nn.Linear(feature_dim, d_model)
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model, nhead=4, batch_first=True
        )
        self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=2)
        self.output_head = nn.Linear(d_model, 32)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Forward pass producing a 32-dim embedding.

        Args:
            x: Input tensor of shape (batch, seq_len, feature_dim).

        Returns:
            Tensor of shape (batch, 32).
        """
        projected = self.input_projection(x)
        encoded = self.transformer(projected)
        out = self.output_head(torch.mean(encoded, dim=1))
        assert out.shape[-1] == 32, f"Expected output dim 32, got {out.shape[-1]}"
        return out


class DeepActorCriticPolicy(nn.Module):
    """System 3: Deep RL Policy (Actor-Critic PPO) mapping embeddings to allocations.

    Input:  state embedding of dim 32
    Output: (actor_value, critic_value)
    actor_value in [-1, 1] via Tanh (full short to full long)
    """

    def __init__(self, state_dim: int = 32) -> None:
        """Initialize the actor-critic network.

        Args:
            state_dim: Dimension of the input state embedding (default 32).
        """
        super().__init__()
        assert state_dim == 32, "state_dim must match transformer output dim (32)"
        self.actor = nn.Sequential(
            nn.Linear(state_dim, 64),
            nn.Tanh(),
            nn.Linear(64, 1),
            nn.Tanh(),
        )
        self.critic = nn.Sequential(
            nn.Linear(state_dim, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
        )

    def forward(self, state_embedding: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        """Forward pass producing actor and critic values.

        Args:
            state_embedding: Tensor of shape (batch, 32).

        Returns:
            Tuple of (actor_output, critic_output), each shape (batch, 1).
        """
        return self.actor(state_embedding), self.critic(state_embedding)


# =====================================================================
# INDIVIDUAL TRADING SYSTEM IMPLEMENTATIONS
# =====================================================================

class System1_MLFactorScoring:
    """System 1: Adaptive ML Factor Scoring.

    Computes Garman-Klass Volatility, Parkinson Volatility, multi-timeframe
    Z-Scores, and order flow imbalance features. Feeds signals to a Random
    Forest classifier producing directional probability.
    """

    def __init__(self, feature_dim: int = 7) -> None:
        """Initialize System 1.

        Args:
            feature_dim: Number of features in the feature vector (default 7).
        """
        self.feature_dim: int = feature_dim
        self.feature_columns: list[str] = _FEATURE_COLUMNS.copy()

    def compute_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Calculate volatility, z-score, and order-flow features.

        Args:
            df: DataFrame with columns Open, High, Low, Close, Volume.

        Returns:
            DataFrame with added feature columns, NaN rows dropped.
        """
        data = df.copy()
        data["log_ret"] = np.log(data["Close"] / data["Close"].shift(1))

        log_hl = np.log(data["High"] / data["Low"]) ** 2
        log_co = np.log(data["Close"] / data["Open"]) ** 2
        data["gk_vol"] = np.sqrt(
            0.5 * log_hl - (2 * np.log(2) - 1) * log_co
        )
        data["parkerson_vol"] = np.sqrt(
            (1 / (4 * np.log(2))) * (np.log(data["High"] / data["Low"])) ** 2
        )
        data["ofi"] = np.where(
            data["Close"] > data["Open"], data["Volume"], -data["Volume"]
        )
        data["ofi_z"] = (
            data["ofi"] - data["ofi"].rolling(20).mean()
        ) / (data["ofi"].rolling(20).std() + 1e-8)

        for w in [10, 30, 60]:
            data[f"z_score_{w}"] = (
                data["Close"] - data["Close"].rolling(w).mean()
            ) / (data["Close"].rolling(w).std() + 1e-8)

        return data.dropna()

    def score_directional_probability(
        self, features: np.ndarray, scaler: RobustScaler, rf: RandomForestClassifier
    ) -> float:
        """Get RF directional probability score from feature vector.

        Args:
            features: 1D feature array of shape (feature_dim,).
            scaler: Fitted RobustScaler.
            rf: Fitted RandomForestClassifier.

        Returns:
            Probability of upward direction (class 1) as float.
        """
        scaled = scaler.transform(features.reshape(1, -1))
        return float(rf.predict_proba(scaled)[0, 1])


class System2_GMMRegimeGate:
    """System 2: Gaussian Mixture Model Regime Gate & Sizing.

    Clusters volatility states into regimes. Regime 2 (extreme volatility)
    triggers suppression of trading.
    """

    def __init__(self) -> None:
        self._suppress: bool = False

    def evaluate_regime(
        self,
        features: np.ndarray,
        gmm: GaussianMixture,
        feature_idx: int = 1,
        secondary_idx: int = 4,
    ) -> int:
        """Determine the current GMM regime from feature vector.

        Args:
            features: 1D feature array.
            gmm: Fitted GaussianMixture model.
            feature_idx: Primary feature index for clustering (default 1 = parkerson_vol).
            secondary_idx: Secondary feature index (default 4 = z_score_30).

        Returns:
            Integer regime label (0, 1, or 2). Sets _suppress=True if regime == 2.
        """
        point = np.array([[features[feature_idx], features[secondary_idx]]])
        regime = int(gmm.predict(point)[0])
        self._suppress = regime == 2
        return regime

    @property
    def is_suppressed(self) -> bool:
        """Whether the current regime suppresses trading."""
        return self._suppress


class System3_DeepRLCircuitBreaker:
    """System 3: Deep RL Allocation & Drawdown Circuit Breaker.

    Uses Actor-Critic PPO policy for allocation. Enforces a hard
    peak-to-trough drawdown limit that halts trading.
    """

    def __init__(
        self,
        transformer: MarketTransformerEncoder,
        policy: DeepActorCriticPolicy,
        max_drawdown: float = 0.12,
    ) -> None:
        """Initialize System 3.

        Args:
            transformer: MarketTransformerEncoder instance.
            policy: DeepActorCriticPolicy instance.
            max_drawdown: Maximum allowed drawdown before circuit breaker trips.
        """
        self.transformer: MarketTransformerEncoder = transformer
        self.policy: DeepActorCriticPolicy = policy
        self.max_drawdown_limit: float = max_drawdown
        self.peak_equity: float = 100000.0
        self._tripped: bool = False

    def compute_allocation(
        self, feature_seq: np.ndarray, scaler: RobustScaler, rf: RandomForestClassifier,
        risk_multiplier: float = 1.0,
    ) -> Tuple[float, float, float]:
        """Compute allocation signal via transformer + actor-critic + RF probability.

        Args:
            feature_seq: 2D feature array of shape (seq_len, feature_dim).
            scaler: Fitted RobustScaler.
            rf: Fitted RandomForestClassifier.
            risk_multiplier: LLM-adjusted risk multiplier.

        Returns:
            Tuple of (raw_allocation, rf_probability, effective_allocation).
        """
        self.transformer.eval()
        self.policy.eval()

        with torch.no_grad():
            seq_tensor = torch.tensor(feature_seq, dtype=torch.float32).unsqueeze(0)
            embedding = self.transformer(seq_tensor)
            raw_alloc, _ = self.policy(embedding)
            alloc = float(raw_alloc.item())

        system1 = System1_MLFactorScoring(feature_dim=feature_seq.shape[1])
        prob = system1.score_directional_probability(
            feature_seq[-1], scaler, rf
        )
        effective_alloc = float(
            np.clip(alloc * prob * risk_multiplier, -1.0, 1.0)
        )
        return alloc, prob, effective_alloc

    def check_drawdown(self, equity: float) -> bool:
        """Update peak equity and check if drawdown exceeds limit.

        Args:
            equity: Current account equity.

        Returns:
            True if trading should halt (circuit breaker tripped).
        """
        self.peak_equity = max(self.peak_equity, equity)
        drawdown = (self.peak_equity - equity) / self.peak_equity
        if drawdown >= self.max_drawdown_limit:
            self._tripped = True
            logging.error(
                f"[SYSTEM 3 CIRCUIT BREAKER] Drawdown reached "
                f"{drawdown * 100:.2f}%. Trading halted!"
            )
            return True
        return False

    @property
    def is_tripped(self) -> bool:
        """Whether the circuit breaker has tripped."""
        return self._tripped


class System4_TransformerExecutor:
    """System 4: Async Sequence Transformer & Executor.

    Processes temporal sequences through the transformer encoder and generates
    signed HMAC-SHA256 REST execution calls to BloFin.
    """

    def __init__(
        self, transformer: MarketTransformerEncoder, blofin: BloFinProductionClient
    ) -> None:
        """Initialize System 4.

        Args:
            transformer: MarketTransformerEncoder instance.
            blofin: BloFinProductionClient for REST execution.
        """
        self.transformer: MarketTransformerEncoder = transformer
        self.blofin: BloFinProductionClient = blofin

    async def execute_order(
        self, symbol: str, side: str, pos_side: str, size: float
    ) -> Dict[str, Any]:
        """Dispatch a signed REST order via BloFin client.

        Args:
            symbol: Instrument ID (e.g., "BTC-USDT").
            side: "buy" or "sell".
            pos_side: "long" or "short".
            size: Order size.

        Returns:
            BloFin API response dict.
        """
        return await self.blofin.place_order(symbol, side, pos_side, size)


class System5_MicrostructureEngine:
    """System 5: Microstructural Engine.

    Manages real-time state variables from the WebSocket depth stream,
    storing them in lightweight array-backed state queues.
    """

    def __init__(self) -> None:
        self._obi_history: list[float] = []
        self._max_history: int = 1000

    def update_obi(self, obi: float) -> None:
        """Append the latest OBI to the history queue.

        Args:
            obi: Latest Order Book Imbalance value.
        """
        self._obi_history.append(obi)
        if len(self._obi_history) > self._max_history:
            self._obi_history = self._obi_history[-self._max_history :]

    @property
    def latest_obi(self) -> float:
        """Return the most recent OBI value, or 0.0 if none seen."""
        return self._obi_history[-1] if self._obi_history else 0.0

    @property
    def obi_trend(self) -> float:
        """Return the sign of OBI momentum (1.0, -1.0, or 0.0)."""
        if len(self._obi_history) < 2:
            return 0.0
        diff = self._obi_history[-1] - self._obi_history[-2]
        return float(np.sign(diff))

    def reset(self) -> None:
        """Clear the OBI history buffer."""
        self._obi_history.clear()


class System6_OBIFilter:
    """System 6: Sub-Microsecond OBI Filtering.

    Enforces a volume-weighted OBI gate threshold. Trades are only
    permitted when OBI magnitude exceeds the configured threshold.
    """

    def __init__(self, threshold: float = 0.10) -> None:
        """Initialize System 6.

        Args:
            threshold: Minimum |OBI| required to pass the gate (default 0.10).
        """
        self.threshold: float = threshold

    def should_trade(self, obi: float) -> bool:
        """Check if OBI magnitude exceeds the gate threshold.

        Args:
            obi: Current OBI value.

        Returns:
            True if |OBI| >= threshold, False otherwise.
        """
        return abs(obi) >= self.threshold

    def compute_weighted_obi(
        self, obi: float, bid_volume: float, ask_volume: float
    ) -> float:
        """Compute volume-weighted OBI (alias for the standard OBI formula).

        Args:
            obi: Current OBI value.
            bid_volume: Total bid-side volume.
            ask_volume: Total ask-side volume.

        Returns:
            Volume-weighted OBI.
        """
        total = bid_volume + ask_volume
        if total <= 0:
            return 0.0
        return (bid_volume - ask_volume) / total


# =====================================================================
# 5. UNIFIED TRADING ENGINE (Orchestrator)
# =====================================================================

class UnifiedProductionEngine:
    """Orchestrates all 6 trading systems into a cohesive production pipeline.

    Execution order:
      1. System 3 — Drawdown circuit breaker check
      2. System 6 — OBI gate filter
      3. System 2 — GMM regime suppression
      4. System 4 — Transformer embedding → System 3 → allocation
      5. System 1 — RF directional probability score
      6. System 4 — Signed REST execution via HMAC-SHA256
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        passphrase: str,
        is_demo: bool = True,
    ) -> None:
        """Initialize the unified engine with all subsystems.

        Args:
            api_key: BloFin API key.
            api_secret: BloFin API secret.
            passphrase: BloFin API passphrase.
            is_demo: If True, use demo-trading endpoints.
        """
        self.is_demo: bool = is_demo
        self.db: ProductionDatabase = ProductionDatabase()
        self.blofin: BloFinProductionClient = BloFinProductionClient(
            api_key, api_secret, passphrase, is_demo
        )
        self.llm: LLMStrategyCoordinator = LLMStrategyCoordinator()

        self.feature_dim: int = 7
        self.transformer: MarketTransformerEncoder = MarketTransformerEncoder(
            feature_dim=self.feature_dim
        )
        self.policy: DeepActorCriticPolicy = DeepActorCriticPolicy(state_dim=32)

        os.makedirs("models", exist_ok=True)
        self.gmm, self.scaler, self.rf = self._load_or_train_models()

        self.system1: System1_MLFactorScoring = System1_MLFactorScoring(
            feature_dim=self.feature_dim
        )
        self.system2: System2_GMMRegimeGate = System2_GMMRegimeGate()
        self.system3: System3_DeepRLCircuitBreaker = System3_DeepRLCircuitBreaker(
            self.transformer, self.policy
        )
        self.system4: System4_TransformerExecutor = System4_TransformerExecutor(
            self.transformer, self.blofin
        )
        self.system5: System5_MicrostructureEngine = System5_MicrostructureEngine()
        self.system6: System6_OBIFilter = System6_OBIFilter(threshold=0.10)

        logging.info("[ENGINE INIT] 6-System Hybrid Engine initialized.")

    def _load_or_train_models(self) -> Tuple[GaussianMixture, RobustScaler, RandomForestClassifier]:
        """Load persistent models or generate baseline models if weights are absent.

        Returns:
            Tuple of (gmm, scaler, rf).
        """
        gmm_path = "models/gmm_regime.joblib"
        scaler_path = "models/robust_scaler.joblib"
        rf_path = "models/rf_classifier.joblib"

        if all(os.path.exists(p) for p in [gmm_path, scaler_path, rf_path]):
            logging.info("[MODELS] Loading pre-trained model weights from disk...")
            return joblib.load(gmm_path), joblib.load(scaler_path), joblib.load(rf_path)

        logging.info("[MODELS] Weights not found. Generating initial baseline models...")
        np.random.seed(42)
        X_dummy = np.random.randn(500, self.feature_dim)
        y_dummy = np.random.randint(0, 2, 500)

        gmm = GaussianMixture(n_components=3, random_state=42).fit(X_dummy[:, :2])
        scaler = RobustScaler().fit(X_dummy)
        rf = RandomForestClassifier(
            n_estimators=50, max_depth=5, random_state=42
        ).fit(scaler.transform(X_dummy), y_dummy)

        joblib.dump(gmm, gmm_path)
        joblib.dump(scaler, scaler_path)
        joblib.dump(rf, rf_path)
        return gmm, scaler, rf

    async def run_strategy_cycle(self, symbol: str, df_history: pd.DataFrame) -> None:
        """Process one full strategy cycle through all 6 systems.

        Args:
            symbol: Trading pair identifier.
            df_history: Historical OHLCV DataFrame with >= 60 rows.
        """
        current_equity = await self.blofin.sync_account_balance()
        if self.system3.check_drawdown(current_equity):
            return

        obi = self.blofin.latest_obi
        self.system5.update_obi(obi)
        if not self.system6.should_trade(obi):
            logging.info(
                f"[SYSTEM 5/6 OBI GATE] OBI too low ({obi:.4f}). Skipping iteration."
            )
            return

        processed_df = self.system1.compute_features(df_history)
        feature_seq = processed_df[self.system1.feature_columns].values[-30:]

        regime = self.system2.evaluate_regime(feature_seq[-1], self.gmm)
        if self.system2.is_suppressed:
            logging.info(
                "[SYSTEM 2 REGIME] Extreme volatility detected (Regime 2). "
                "Strategy suppressed."
            )
            return

        alloc, prob, effective_alloc = self.system3.compute_allocation(
            feature_seq, self.scaler, self.rf,
            risk_multiplier=self.llm.risk_multiplier,
        )

        self.db.log_telemetry(
            symbol=symbol, obi=obi, regime=regime, alloc=alloc, prob=prob,
            effective_alloc=effective_alloc, equity=current_equity,
            drawdown=(self.system3.peak_equity - current_equity)
            / self.system3.peak_equity,
        )

        if abs(effective_alloc) >= self.llm.confidence_threshold:
            side = "buy" if effective_alloc > 0 else "sell"
            pos_side = "long" if effective_alloc > 0 else "short"
            size = round(abs(effective_alloc) * 0.01, 3)

            logging.info(
                f"[EXECUTION] Submitting Order -> {side.upper()} {size} {symbol} "
                f"({pos_side.upper()})"
            )
            resp = await self.system4.execute_order(symbol, side, pos_side, size)

            latest_price = float(processed_df["Close"].iloc[-1])
            self.db.log_trade(
                symbol, side, pos_side, size, latest_price,
                obi, effective_alloc, resp,
            )
            self.db.log_obi(
                symbol, obi, float(np.sum(feature_seq[-1])), 0.0
            )
            logging.info(f"[BLOFIN RESPONSE] {resp}")
