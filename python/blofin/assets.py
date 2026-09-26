"""BloFin asset universe — ~500 trading pairs.

The asset universe is fetched live from the BloFin market tickers endpoint.
We cache the list and refresh periodically.
"""
import logging
import time

from blofin.client import fetch_tickers

log = logging.getLogger("blofin.assets")

# Cache TTL (seconds)
_CACHE_TTL = 60.0
_cached_assets: list[dict] | None = None
_cached_ts: float = 0.0


def get_asset_universe(force_refresh: bool = False) -> list[dict]:
    """Return the current BloFin asset universe (~500 pairs).

    Each item has at least: symbol, lastPrice, changePercent, volume24h.
    """
    global _cached_assets, _cached_ts
    now = time.time()
    if _cached_assets is not None and not force_refresh:
        if now - _cached_ts < _CACHE_TTL:
            return _cached_assets

    try:
        tickers = fetch_tickers()
        if tickers and isinstance(tickers, list):
            assets = []
            for t in tickers:
                symbol = t.get("symbol", "")
                if not symbol:
                    continue
                assets.append({
                    "symbol": symbol,
                    "lastPrice": float(t.get("lastPrice", t.get("last", 0))),
                    "changePercent": float(t.get("changePercent", t.get("chgPct", 0))),
                    "volume24h": float(t.get("volume24h", t.get("vol24h", 0))),
                })
            log.info("Fetched %d assets from BloFin", len(assets))
            _cached_assets = assets
            _cached_ts = now
            return assets
    except Exception as e:
        log.warning("Failed to fetch tickers: %s", e)

    if _cached_assets is not None:
        return _cached_assets
    return []


def get_top_symbols(limit: int = 100) -> list[str]:
    """Return top N symbols by 24h volume."""
    assets = get_asset_universe()
    sorted_assets = sorted(assets, key=lambda a: a["volume24h"], reverse=True)
    return [a["symbol"] for a in sorted_assets[:limit]]
