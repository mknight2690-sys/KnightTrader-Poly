"""KnightTrader-BloFin-Hybrid configuration."""
import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

# --- BloFin API ---
BLOFIN_PASSPHRASE = os.getenv("BLOFIN_PASSPHRASE", "")
BLOFIN_API_KEY = os.getenv("BLOFIN_API_KEY", "")
BLOFIN_SECRET_KEY = os.getenv("BLOFIN_SECRET_KEY", "")

BLOFIN_REST_URL = "https://openapi.blofin.com"
BLOFIN_WS_URL = "wss://ws.blofin.com/ws/v2"

# --- Router ---
ANTHROPIC_BASE_URL = os.getenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:8083")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "sk-proxy")
ROUTER_PORT = int(os.getenv("ROUTER_PORT", "8083"))

# --- Trading ---
TRADING_ENABLED = os.getenv("TRADING_ENABLED", "false").lower() == "true"
MAX_POSITION_SIZE = float(os.getenv("MAX_POSITION_SIZE", "10"))
MAX_CANDIDATES = int(os.getenv("MAX_CANDIDATES", "8"))
TIMEFRAME = os.getenv("TIMEFRAME", "1m")
SCAN_INTERVAL = int(os.getenv("SCAN_INTERVAL", "1"))
RISK_PER_TRADE = float(os.getenv("RISK_PER_TRADE", "0.01"))

# --- Dashboard ---
DASHBOARD_PORT = int(os.getenv("DASHBOARD_PORT", "8080"))
DASHBOARD_HOST = os.getenv("DASHBOARD_HOST", "127.0.0.1")
