"""HMAC-SHA256 signing for BloFin REST requests."""
import base64
import hashlib
import hmac
import time


def generate_signature(timestamp: str, method: str, request_path: str,
                        body: str, secret_key: str) -> str:
    """Generate HMAC-SHA256 signature for BloFin API.

    The signature string is: timestamp + method + requestPath + body
    The request_path should NOT include query parameters.
    """
    message = f"{timestamp}{method.upper()}{request_path}{body}"
    mac = hmac.new(
        bytes(secret_key, encoding='utf-8'),
        bytes(message, encoding='utf-8'),
        digestmod=hashlib.sha256,
    )
    return base64.b64encode(mac.digest()).decode('utf-8')


def get_timestamp() -> str:
    """Return current Unix timestamp as a string (milliseconds)."""
    return str(int(time.time() * 1000))


def get_standard_headers(api_key: str, passphrase: str,
                          timestamp: str, signature: str,
                          body: str = "") -> dict:
    """Build standard BloFin request headers for signed endpoints."""
    headers = {
        "Content-Type": "application/json",
        "Origin": "https://www.blofin.com",
        "Referer": "https://www.blofin.com/",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "BF-ACCESS-KEY": api_key,
        "BF-ACCESS-SIGN": signature,
        "BF-ACCESS-TIMESTAMP": timestamp,
        "BF-ACCESS-PASSPHRASE": passphrase,
    }
    return headers
