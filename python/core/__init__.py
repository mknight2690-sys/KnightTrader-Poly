"""
Core trading engine modules for the 6-system hybrid quantitative trading engine.

Modules:
  - credentials: Credential loader from compendium file + env vars
  - database: SQLite trade logging, telemetry, and OBI persistence
  - connector: BloFin REST & WebSocket clients with HMAC-SHA256 signing
  - coordinator: LLM Strategy Coordinator for dynamic parameter updates
  - systems: All 6 trading systems + neural models + unified engine
"""

from .credentials import load_credentials
from .database import ProductionDatabase
from .connector import BloFinProductionClient
from .coordinator import LLMStrategyCoordinator
from .systems import (
    MarketTransformerEncoder,
    DeepActorCriticPolicy,
    System1_MLFactorScoring,
    System2_GMMRegimeGate,
    System3_DeepRLCircuitBreaker,
    System4_TransformerExecutor,
    System5_MicrostructureEngine,
    System6_OBIFilter,
    UnifiedProductionEngine,
)
