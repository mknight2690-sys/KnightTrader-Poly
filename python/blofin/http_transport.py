"""HTTP transport layer for BloFin API.
Uses curl_cffi (Chrome impersonation) first, falls back to httpx direct,
then Camoufox browser for WAF bypass.
"""
import json
import logging
import os
import threading
import urllib.parse

log = logging.getLogger("blofin.http")

_transport_type = os.getenv("BLOFIN_HTTP_TRANSPORT", "auto")


def _get_curl_session():
    from curl_cffi import requests as cfi_requests
    local = threading.local()
    if not hasattr(local, 'session'):
        local.session = cfi_requests.Session(impersonate="chrome120")
    return local.session


def _httpx_request(method, url, headers=None, params=None, data=None, timeout=30):
    import httpx
    headers = headers or {}
    if data:
        resp = httpx.request(method, url, headers=headers, params=params, content=data, timeout=timeout)
    else:
        resp = httpx.request(method, url, headers=headers, params=params, timeout=timeout)
    try:
        return resp.json()
    except Exception:
        return {"raw": resp.text[:500]}


def request(method, url, headers=None, params=None, data=None, timeout=30):
    headers = headers or {}

    if _transport_type == "httpx":
        return _httpx_request(method, url, headers, params, data, timeout)

    # Auto mode: try curl_cffi first, then httpx, then Camoufox
    try:
        s = _get_curl_session()
        resp = s.request(method, url, headers=headers, params=params, data=data, timeout=timeout)
        try:
            result = resp.json()
        except Exception:
            result = {"raw": resp.text[:500]}
        # Check if blocked (HTML instead of JSON)
        if isinstance(result, dict) and "raw" in result and "<!DOCTYPE" in result.get("raw", ""):
            log.warning("curl_cffi blocked, trying httpx...")
            return _httpx_request(method, url, headers, params, data, timeout)
        return result
    except Exception as curl_err:
        log.warning("curl_cffi error: %s, trying httpx...", curl_err)
        try:
            return _httpx_request(method, url, headers, params, data, timeout)
        except Exception as httpx_err:
            log.warning("httpx error: %s, trying Camoufox...", httpx_err)
            # Last resort: Camoufox browser
            return _camoufox_request(method, url, headers, params, data, timeout)


def _camoufox_request(method, url, headers, params=None, data=None, timeout=30):
    """Make request via Camoufox browser."""
    import json as json_mod
    import threading

    result_box = {}

    def _worker():
        try:
            from camoufox.sync_api import Camoufox
            with Camoufox(headless=True) as browser:
                page = browser.new_page()
                try:
                    fetch_config = {"method": method, "headers": headers or {}}
                    full_url = url
                    if params:
                        full_url = f"{url}?{urllib.parse.urlencode(params)}"
                    if data:
                        fetch_config["body"] = data
                    js = ("(async () => { const resp = await fetch(%s, %s);"
                          "const text = await resp.text();"
                          "return JSON.stringify({status: resp.status, body: text}); })();") % (
                        json_mod.dumps(full_url), json_mod.dumps(fetch_config))
                    result = json_mod.loads(page.evaluate(js))
                    status = result["status"]
                    body = result["body"]
                    if 200 <= status < 300:
                        try:
                            result_box["data"] = json_mod.loads(body)
                        except json_mod.JSONDecodeError:
                            result_box["data"] = {"raw": body[:500]}
                    else:
                        try:
                            result_box["data"] = json_mod.loads(body)
                        except json_mod.JSONDecodeError:
                            result_box["data"] = {"error": f"HTTP {status}", "raw": body[:500]}
                finally:
                    page.close()
        except Exception as e:
            result_box["error"] = str(e)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if "data" in result_box:
        return result_box["data"]
    if "error" in result_box:
        raise Exception(result_box["error"])
    raise TimeoutError("Camoufox request timed out")


def get(url, headers=None, params=None, timeout=30):
    return request("GET", url, headers, params, None, timeout)


def post(url, data, headers=None, timeout=30):
    return request("POST", url, headers, None, data, timeout)