"""
Import OpenRouter keys from arbitrary text files into this repo's local .env.

This is designed for ops/debug: add more `sk-or-...` keys so LLMWrapper can
cycle keys when one provider/model hits rate limits or key exhaustion.

NO secrets are printed to stdout. We only print counts + how many keys were
added.
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path


SK_OR_RE = re.compile(r"sk-or-[A-Za-z0-9_-]+")


def _read_text_safe(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def discover_keys_from_text(text: str) -> list[str]:
    keys = []
    seen: set[str] = set()
    for m in SK_OR_RE.finditer(text or ""):
        k = (m.group(0) or "").strip()
        if not k or not k.startswith("sk-or-"):
            continue
        if k in seen:
            continue
        seen.add(k)
        keys.append(k)
    return keys


def parse_existing_keys(env_text: str) -> list[str]:
    return discover_keys_from_text(env_text)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "files",
        nargs="+",
        help="Text files containing one or more OpenRouter keys (sk-or-...).",
    )
    ap.add_argument(
        "--env",
        default=str(Path(__file__).resolve().parents[1] / ".env"),
        help="Path to the repo's .env file to update.",
    )
    args = ap.parse_args()

    env_path = Path(args.env)
    env_path.parent.mkdir(parents=True, exist_ok=True)

    existing_text = _read_text_safe(env_path) if env_path.exists() else ""
    existing_keys = set(parse_existing_keys(existing_text))

    discovered: list[str] = []
    for f in args.files:
        p = Path(f).expanduser()
        text = _read_text_safe(p)
        for k in discover_keys_from_text(text):
            if k not in existing_keys and k not in discovered:
                discovered.append(k)

    if not discovered:
        print("OpenRouter keys: 0 new keys found (nothing to add).")
        return

    # Append keys as OPENROUTER_API_KEY_<n> entries.
    # Discover_openrouter_keys() scans .env for any `sk-or-...`, but naming them
    # keeps things debuggable.
    lines = existing_text.splitlines()
    if lines and lines[-1].strip():
        existing_text = "\n".join(lines) + "\n"

    start_idx = 2
    existing_named = set()
    for line in existing_text.splitlines():
        if line.strip().startswith("OPENROUTER_API_KEY_") and "=" in line:
            existing_named.add(line.split("=", 1)[0].strip())

    # Find next available suffix if user already has OPENROUTER_API_KEY_2/3...
    idx = start_idx
    while True:
        candidate = f"OPENROUTER_API_KEY_{idx}"
        if candidate not in existing_named:
            break
        idx += 1

    to_write = existing_text
    to_write += "\n# Imported OpenRouter keys (auto-added for cycling)\n"
    added = 0
    for k in discovered:
        key_name = f"OPENROUTER_API_KEY_{idx}"
        idx += 1
        to_write += f"{key_name}={k}\n"
        added += 1

    env_path.write_text(to_write, encoding="utf-8")

    print(f"OpenRouter keys: {added} new keys added to .env")


if __name__ == "__main__":
    main()

