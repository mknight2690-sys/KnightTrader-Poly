r"""
Credential loader for BloFin API credentials.

Loads credentials in this priority order:
  1. Environment variables (BLOFIN_API_KEY, BLOFIN_SECRET_KEY, BLOFIN_PASSPHRASE)
  2. The compendium file at C:/Users/mknig/Downloads/MK Blo Hermes API compendium.txt
  3. Fallback to DEMO credentials (safe for is_demo=True)
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Optional, Tuple


_COMPENDIUM_PATH = Path("C:/Users/mknig/Downloads/MK Blo Hermes API compendium.txt")


def _parse_compendium(path: Path) -> Optional[Tuple[str, str, str]]:
    """Parse API Key, Secret Key, and Passphrase from the compendium text file.

    Args:
        path: Path to the MK Blo Hermes API compendium text file.

    Returns:
        Tuple of (api_key, secret_key, passphrase) if found, else None.
    """
    if not path.exists():
        return None

    text = path.read_text(encoding="utf-8", errors="replace")

    api_key_match = re.search(r"API Key:\s*(\S+)", text)
    secret_match = re.search(r"Secret Key:\s*(\S+)", text)
    passphrase_match = re.search(r"Passphrase:\s*(\S+)", text)

    if not (api_key_match and secret_match and passphrase_match):
        logging.warning("Compendium file found but credential fields missing.")
        return None

    return (
        api_key_match.group(1).strip(),
        secret_match.group(1).strip(),
        passphrase_match.group(1).strip(),
    )


def load_credentials() -> Tuple[str, str, str]:
    """Load BloFin API credentials from the environment or compendium file.

    Priority:
      1. Environment variables: BLOFIN_API_KEY, BLOFIN_SECRET_KEY, BLOFIN_PASSPHRASE
      2. Compendium file at the compendium path
      3. DEMO fallbacks (safe, invalid keys for demo mode)

    Returns:
        Tuple of (api_key, secret_key, passphrase).
    """
    api_key = os.getenv("BLOFIN_API_KEY")
    secret_key = os.getenv("BLOFIN_SECRET_KEY")
    passphrase = os.getenv("BLOFIN_PASSPHRASE")

    if api_key and secret_key and passphrase:
        logging.info("[CREDENTIALS] Loaded from environment variables.")
        return api_key, secret_key, passphrase

    parsed = _parse_compendium(_COMPENDIUM_PATH)
    if parsed:
        logging.info("[CREDENTIALS] Loaded from compendium file.")
        return parsed

    logging.warning("[CREDENTIALS] Using DEMO fallback credentials (invalid for live).")
    return "DEMO_API_KEY", "DEMO_SECRET_KEY", "DEMO_PASSPHRASE"
