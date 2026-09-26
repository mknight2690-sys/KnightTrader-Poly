"""
BloFin REST and WebSocket client with HMAC-SHA256 signing.

Provides:
  - REST: account balance sync, signed order placement
  - WebSocket: live L2 order book subscription (books channel)
  - Real-time Order Book Imbalance (OBI) computation
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple, Union

import aiohttp
import numpy as np
import websockets


class BloFinProductionClient:
    """Handles BloFin REST orders, account balance sync, and WebSocket ingestion.

    Uses HMAC-SHA256 for request signing. When is_demo=False, routes to
    demo-trading endpoints; otherwise uses production endpoints.
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        passphrase: str,
        is_demo: bool = False,
    ) -> None:
        """Initialize the client with credentials and endpoint configuration.

        Args:
            api_key: BloFin API key.
            api_secret: BloFin API secret key.
            passphrase: BloFin API passphrase.
            is_demo: If True, use demo-trading endpoints; else production.
        """
        self.api_key: str = api_key
        self.api_secret: str = api_secret
        self.passphrase: str = passphrase
        self.is_demo: bool = is_demo

        if is_demo:
            self.base_url = "https://demo-trading-openapi.blofin.com"
            self.ws_url = "wss://demo-trading-openapi.blofin.com/ws/public"
        else:
            self.base_url = "https://openapi.blofin.com"
            self.ws_url = "wss://openapi.blofin.com/ws/public"

        self.latest_obi: Dict[str, float] = {}
        self.current_equity: float = 100000.0
        self._session: Optional[aiohttp.ClientSession] = None

    def _sign(
        self,
        path: str,
        method: str,
        timestamp: str,
        nonce: str,
        body: str = "",
    ) -> str:
        """Compute HMAC-SHA256 signature for a request.

        The prehash string is constructed as:
          {path}{method}{timestamp}{nonce}{body}

        Args:
            path: API path (e.g., "/api/v1/trade/order").
            method: HTTP method ("GET" or "POST").
            timestamp: Millisecond timestamp string.
            nonce: UUID nonce string.
            body: Request body string (empty for GET).

        Returns:
            Hexadecimal HMAC-SHA256 signature string.
        """
        prehash = f"{path}{method}{timestamp}{nonce}{body}"
        return hmac.new(
            self.api_secret.encode("utf-8"),
            prehash.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    async def sync_account_balance(self) -> float:
        """Fetch total account margin equity from the BloFin REST API.

        Returns:
            Current account equity as a float. Returns the previous equity
            value if the request fails.
        """
        path = "/api/v1/account/balance"
        method = "GET"
        timestamp = str(int(time.time() * 1000))
        nonce = str(uuid.uuid4())

        signature = self._sign(path, method, timestamp, nonce)
        headers = {
            "ACCESS-KEY": self.api_key,
            "ACCESS-SIGN": signature,
            "ACCESS-TIMESTAMP": timestamp,
            "ACCESS-PASSPHRASE": self.passphrase,
            "ACCESS-NONCE": nonce,
        }
        try:
            async with self._get_session() as session:
                async with session.get(
                    f"{self.base_url}{path}", headers=headers
                ) as resp:
                    res = await resp.json()
                    if res.get("code") == "0" and len(res.get("data", [])) > 0:
                        self.current_equity = float(
                            res["data"][0].get("totalEquity", self.current_equity)
                        )
        except Exception as e:
            logging.error(f"[REST ACCOUNT SYNC ERROR] {e}")
        return self.current_equity

    async def place_order(
        self, inst_id: str, side: str, pos_side: str, size: float
    ) -> Dict[str, Any]:
        """Dispatch a signed REST market order to BloFin.

        Args:
            inst_id: Instrument ID (e.g., "BTC-USDT").
            side: "buy" or "sell".
            pos_side: "long" or "short".
            size: Order size in base currency.

        Returns:
            BloFin API response dict. Returns an error dict on failure.
        """
        path = "/api/v1/trade/order"
        method = "POST"
        timestamp = str(int(time.time() * 1000))
        nonce = str(uuid.uuid4())

        payload = {
            "instId": inst_id,
            "marginMode": "cross",
            "positionSide": pos_side,
            "side": side,
            "orderType": "market",
            "size": str(size),
        }
        body_str = json.dumps(payload)
        signature = self._sign(path, method, timestamp, nonce, body_str)

        headers = {
            "ACCESS-KEY": self.api_key,
            "ACCESS-SIGN": signature,
            "ACCESS-TIMESTAMP": timestamp,
            "ACCESS-PASSPHRASE": self.passphrase,
            "ACCESS-NONCE": nonce,
            "Content-Type": "application/json",
        }
        try:
            async with self._get_session() as session:
                async with session.post(
                    f"{self.base_url}{path}", headers=headers, data=body_str
                ) as resp:
                    return await resp.json()
        except Exception as e:
            logging.error(f"[REST ORDER ERROR] {e}")
            return {"code": "-1", "msg": str(e)}

    async def listen_orderbook_stream(self, inst_ids: Union[str, List[str]]) -> None:
        """Stream L2 depth data from BloFin WebSocket and compute OBI.

        Subscribes to the books channel for the given instrument(s). Continuously
        parses bid/ask volumes from the top of the order book and computes
        the volume-weighted Order Book Imbalance.

        Args:
            inst_ids: Instrument ID or list of IDs (e.g., "BTC-USDT" or ["BTC-USDT", "ETH-USDT"]).
        """
        subscribe_payload = {
            "op": "subscribe",
            "args": [{"channel": "books", "instId": sid} for sid in inst_ids],
        }
        while True:
            try:
                async with websockets.connect(self.ws_url, ping_interval=20, ping_timeout=10) as ws:
                    await ws.send(json.dumps(subscribe_payload))
                    logging.info(
                        f"[WS STREAM] Connected & Subscribed to books for {len(inst_ids)} symbols"
                    )
                    while True:
                        msg = await asyncio.wait_for(ws.recv(), timeout=30)
                        data = json.loads(msg)
                        if "data" in data:
                            if isinstance(data["data"], list) and len(data["data"]) > 0:
                                book = data["data"][0]
                            elif isinstance(data["data"], dict):
                                book = data["data"]
                            bids_raw = book.get("bids", [])
                            asks_raw = book.get("asks", [])
                            try:
                                bids = np.array(
                                    [[float(str(b[0])), float(str(b[1]))] for b in bids_raw[:10]],
                                    dtype=float,
                                )
                                asks = np.array(
                                    [[float(str(a[0])), float(str(a[1]))] for a in asks_raw[:10]],
                                    dtype=float,
                                )
                            except (ValueError, IndexError, TypeError):
                                continue
                            if len(bids) > 0 and len(asks) > 0:
                                bid_vol = float(np.sum(bids[:, 1]))
                                ask_vol = float(np.sum(asks[:, 1]))
                                total_vol = bid_vol + ask_vol
                                if total_vol > 0:
                                    sym = data.get("arg", {}).get("instId", "")
                                    if not sym and isinstance(book, dict):
                                        sym = book.get("s", "")
                                    if sym:
                                        self.latest_obi[sym] = (bid_vol - ask_vol) / total_vol
            except Exception as e:
                logging.warning(
                    f"[WS DISCONNECTED] Reconnecting in 3s... Error: {e}"
                )
                await asyncio.sleep(3)

    def _get_session(self) -> aiohttp.ClientSession:
        """Return a shared aiohttp.ClientSession, creating one if needed.

        Returns:
            An aiohttp.ClientSession instance.
        """
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self) -> None:
        """Close the shared aiohttp session if it exists."""
        if self._session and not self._session.closed:
            await self._session.close()
