"""BloFin REST API client with httpx/curl_cffi/Camoufox transport support."""
import json
import logging
from typing import Any, Dict, Optional

from blofin.http_transport import get as http_get, post as http_post
from blofin.auth import generate_signature, get_timestamp, get_standard_headers
from config import (
    BLOFIN_API_KEY, BLOFIN_PASSPHRASE, BLOFIN_SECRET_KEY, BLOFIN_REST_URL,
)

log = logging.getLogger("blofin.client")


def _headers(path: str, method: str, body: str | None = None) -> dict:
    """Build headers for a signed request."""
    if body is None:
        body = ""
    body_str = body if isinstance(body, str) else json.dumps(body or "")
    ts = get_timestamp()
    sig = generate_signature(ts, method, path, body_str, BLOFIN_SECRET_KEY)
    return get_standard_headers(BLOFIN_API_KEY, BLOFIN_PASSPHRASE, ts, sig, body_str)


def _public_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Origin": "https://www.blofin.com",
        "Referer": "https://www.blofin.com/",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
    }


def _safe_json(result: dict) -> dict:
    """Extract data from HTTP response result."""
    if isinstance(result, dict):
        return result
    return {"raw": str(result)[:500]}


# --------------------------------------------------------------------------- #
# Public market data
# --------------------------------------------------------------------------- #

def fetch_tickers() -> list[dict]:
    """Fetch all tickers (the ~500 asset universe)."""
    data = http_get(
        f"{BLOFIN_REST_URL}/api/v1/market/tickers",
        headers=_public_headers(),
        timeout=30,
    )
    if isinstance(data, dict) and data.get("code") == "0":
        return data.get("data", [])
    return data if isinstance(data, list) else []


def fetch_ticker(symbol: str) -> dict:
    """Fetch a single ticker."""
    return http_get(
        f"{BLOFIN_REST_URL}/api/v1/market/tickers",
        headers=_public_headers(),
        params={"symbol": symbol},
        timeout=10,
    )


def fetch_candles(symbol: str, bar: str = "1m", limit: int = 100) -> list[dict]:
    """Fetch candlestick data for a symbol."""
    data = http_get(
        f"{BLOFIN_REST_URL}/api/v1/market/candles",
        headers=_public_headers(),
        params={"symbol": symbol, "bar": bar, "limit": limit},
        timeout=15,
    )
    if isinstance(data, dict) and data.get("code") == "0":
        return data.get("data", [])
    return data if isinstance(data, list) else []


def fetch_order_book(symbol: str, depth: int = 20) -> dict:
    """Fetch order book for a symbol."""
    return http_get(
        f"{BLOFIN_REST_URL}/api/v1/market/order-book",
        headers=_public_headers(),
        params={"symbol": symbol, "depth": depth},
        timeout=10,
    )


# --------------------------------------------------------------------------- #
# Signed endpoints
# --------------------------------------------------------------------------- #

def fetch_account_info() -> dict:
    """Fetch account info (balance, etc.)."""
    path = "/api/v1/account/info"
    data = http_get(
        f"{BLOFIN_REST_URL}{path}",
        headers=_headers(path, "GET"),
        timeout=15,
    )
    log.info("Account info fetched")
    return _safe_json(data)


def fetch_positions() -> dict:
    """Fetch all positions."""
    path = "/api/v1/position/all"
    data = http_get(
        f"{BLOFIN_REST_URL}{path}",
        headers=_headers(path, "GET"),
        timeout=15,
    )
    log.info("Positions fetched")
    return _safe_json(data)


def fetch_pending_orders(symbol: str | None = None) -> list[dict]:
    """Fetch pending orders. Confirmed endpoint: /api/v1/order/pending."""
    path = "/api/v1/order/pending"
    params = {"symbol": symbol} if symbol else {}
    data = http_get(
        f"{BLOFIN_REST_URL}{path}",
        headers=_headers(path, "GET", ""),
        params=params,
        timeout=15,
    )
    if isinstance(data, dict) and data.get("code") == "0":
        return data.get("data", [])
    return data if isinstance(data, list) else []


def place_order(symbol: str, side: str, order_type: str,
                size: str, price: str | None = None,
                stop_loss_price: str | None = None,
                take_profit_price: str | None = None,
                stop_loss_type: str = "market",
                take_profit_type: str = "limit") -> dict:
    """Place an order with optional TP/SL.

    Args:
        symbol: e.g. "BTCUSDT"
        side: "buy" or "sell"
        order_type: "market" or "limit"
        size: order size as string
        price: limit price (required for limit orders)
        stop_loss_price: stop loss price (optional)
        take_profit_price: take profit price (optional)
        stop_loss_type: "market" or "limit" (default: "market")
        take_profit_type: "market" or "limit" (default: "limit")
    """
    path = "/api/v1/order"
    body = {
        "symbol": symbol,
        "side": side,
        "orderType": order_type,
        "size": size,
    }
    if order_type == "limit" and price:
        body["price"] = price
    if stop_loss_price:
        body["stopLossPrice"] = stop_loss_price
        body["stopLossType"] = stop_loss_type
    if take_profit_price:
        body["takeProfitPrice"] = take_profit_price
        body["takeProfitType"] = take_profit_type
    body_str = json.dumps(body)
    data = http_post(
        f"{BLOFIN_REST_URL}{path}",
        data=body_str,
        headers=_headers(path, "POST", body_str),
        timeout=15,
    )
    log.info("Place order %s %s %s", side, symbol, size)
    return _safe_json(data)


def cancel_order(order_id: str, symbol: str) -> dict:
    """Cancel an order."""
    path = "/api/v1/order/cancel"
    body_str = json.dumps({"orderId": order_id, "symbol": symbol})
    data = http_post(
        f"{BLOFIN_REST_URL}{path}",
        data=body_str,
        headers=_headers(path, "POST", body_str),
        timeout=15,
    )
    log.info("Cancel order %s", order_id)
    return _safe_json(data)


def fetch_order_history(symbol: str | None = None, limit: int = 100) -> list[dict]:
    """Fetch recent order history."""
    path = "/api/v1/order/history"
    params = {"symbol": symbol, "limit": limit} if symbol else {"limit": limit}
    data = http_get(
        f"{BLOFIN_REST_URL}{path}",
        headers=_headers(path, "GET", ""),
        params=params,
        timeout=15,
    )
    if isinstance(data, dict) and data.get("code") == "0":
        return data.get("data", [])
    return data if isinstance(data, list) else []


def fetch_fills(symbol: str | None = None, limit: int = 100) -> list[dict]:
    """Fetch recent fills."""
    path = "/api/v1/fill/history"
    params = {"symbol": symbol, "limit": limit} if symbol else {"limit": limit}
    data = http_get(
        f"{BLOFIN_REST_URL}{path}",
        headers=_headers(path, "GET", ""),
        params=params,
        timeout=15,
    )
    if isinstance(data, dict) and data.get("code") == "0":
        return data.get("data", [])
    return data if isinstance(data, list) else []