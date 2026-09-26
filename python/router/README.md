# free-claude-router

A local proxy that lets **Claude Code** run on the best **free / cheap cloud models**
across multiple providers, rotating keys and models to dodge rate limits.

Claude Code speaks the Anthropic Messages API. This proxy sits between Claude Code
and a pool of providers (OpenRouter, DeepSeek, Kimi, SiliconFlow, Qwen, GLM),
overrides the model to a free/cheap one, and transparently rotates across
**every key × every model × every provider** on rate limits — so you (effectively)
never run out. OpenAI-native providers get full Anthropic↔OpenAI translation
(including tool calls + SSE streaming), so Claude Code's agent mode works everywhere.

## Files

| File | Purpose |
|---|---|
| `router.py` | The proxy server (FastAPI). Run this. |
| `translate.py` | Anthropic Messages ↔ OpenAI ChatCompletion conversion (tools + streaming). |
| `providers.json` | Provider config: endpoint, key file, models, priority. |
| `keys_*.txt` | One API key per line per provider. A provider activates when its file has a real key. |
| `start.bat` | One-click launcher: starts the router, then launches Claude Code. |
| `requirements.txt` | `fastapi`, `uvicorn`, `httpx`. |

## Quick start

1. Install deps (once):
   ```
   py -3.12 -m pip install -r requirements.txt
   ```
2. Your `~/.claude/settings.json` is already configured to point Claude Code at
   `http://127.0.0.1:8082` (token `freecc`) with free-model aliases. Nothing to
   change there.
3. Double-click **`start.bat`** (or run it). It boots the router in a new window
   and launches Claude Code. Start coding.

   Alternatively, run the router manually in one window:
   ```
   py -3.12 router.py
   ```
   then run `claude` in another. The router listens on `127.0.0.1:8082`.

## How routing works

For each Claude Code request the router builds an ordered attempt list:
1. The model Claude Code asked for (resolved to its provider), then
2. every provider in priority order, each with all its models.

It tries the first available key on each (provider, model). On a **429 / 503 / 529**
it cooldowns that (key, model) pair and moves to the next key. On a **hard
failure** (401/402/403, "insufficient balance", "suspended", invalid key) it
marks the whole provider dead for 60 minutes and skips it. When one model is
exhausted it falls to the next; when one provider is exhausted it falls to the
next. As long as any free model on any provider is up, your request succeeds.

The router also strips OpenRouter's fake `thinking`/`redacted_thinking` blocks
(free reasoning models emit these with empty signatures, which break Claude
Code's parser) and renumbers the surviving content blocks.

## Providers (current status)

| Provider | Kind | Free? | Status | Notes |
|---|---|---|---|---|
| **OpenRouter** | anthropic-native | ✅ free `:models` | ✅ 4 keys | Best free coding: `qwen/qwen3-coder:free`, `openai/gpt-oss-120b:free`, etc. |
| **SiliconFlow** | openai (translated) | ✅ free tier | ✅ key works | Free Qwen2.5-72B, DeepSeek-V3, Qwen3-235B, GLM-4-9B. Uses `api.siliconflow.com` (international). |
| **GLM / Z.ai** | openai (translated) | ⚠️ credits | ✅ `glm-4.5-flash` works | `glm-4.5-flash` is the cheap/working one. `glm-4.5` is out of balance. |
| **DeepSeek** | anthropic-native | ⚠️ $5 credit | ❌ insufficient balance | Recharge at https://platform.deepseek.com to activate. Anthropic-native endpoint. |
| **Kimi / Moonshot** | openai (translated) | ❌ paid | ❌ insufficient balance | Flagship K2.6. Recharge at https://platform.moonshot.ai. No free tier exists. |
| **Qwen / DashScope** | openai (translated) | ⚠️ 70M tokens | ❌ invalid key | The provided key is not a valid DashScope key. Get one at https://dashscope.aliyun.com. |

### About Kimi K2.6 and Step 3.7

There is **no free cloud API** for Kimi K2.6 or Step 3.7 — that combination
doesn't exist. Kimi requires a $1+ recharge; Step 3.7 only has a time-limited
15-day trial. Kimi K2.6 is wired in as a paid fallback (activates when you
recharge). Step 3.7 can be added to `providers.json` the same way if you get a
StepFun key.

## Adding / fixing a provider

1. Sign up at the provider (links above) and create an API key.
2. Paste the key into the matching `keys_<provider>.txt` file (one per line,
   delete the `#` comment lines).
3. Restart the router. It auto-activates the provider.

To add a brand-new provider, add an entry to `providers.json`:
```json
{
  "name": "myprov",
  "kind": "openai",            // or "anthropic"
  "base_url": "https://api.example.com/v1",
  "keys_file": "keys_myprov.txt",
  "free": true,
  "priority": 60,
  "models": ["model-a", "model-b"]
}
```
- `kind: "anthropic"` → native Anthropic Messages passthrough (no translation).
- `kind: "openai"` → OpenAI ChatCompletion with full Anthropic↔OpenAI translation.
- `priority` = order tried (lower = earlier). Free providers first.

## Model aliases in Claude Code

`~/.claude/settings.json` sets these aliases (all free/cheap models):
- `model` / sonnet → `qwen/qwen3-coder:free` (OpenRouter, best free coding)
- opus → `nvidia/nemotron-3-ultra-550b-a55b:free` (heaviest)
- haiku → `meta-llama/llama-3.3-70b-instruct:free` (mid)
- small/fast (tab-style) → `meta-llama/llama-3.2-3b-instruct:free`
- subagent → `openai/gpt-oss-120b:free`

When any alias's model is rate-limited, the router falls through to the next
provider/model automatically.

## Watching it work

The router window logs each served request, e.g.:
```
OK  openrouter   openai/gpt-oss-120b:free   key1  2.27s stream=True
429 openrouter   qwen/qwen3-coder:free      key0 cd 30s
HARD FAIL deepseek (status 402) — dead for 60m: Insufficient Balance
OK  siliconflow  Qwen/Qwen2.5-72B-Instruct  key0  1.42s stream=False
OK  glm          glm-4.5-flash              key0  1.94s stream=False
```

## Stopping it

Close the `free-claude-router` window, or:
```
taskkill /F /IM python.exe /FI "WINDOWTITLE eq free-claude-router"
```

## Requirements

- Python 3.12 (`py -3.12`) with `fastapi`, `uvicorn`, `httpx`.
- Claude Code CLI (`claude`) installed.
- At least one valid API key in a `keys_*.txt` file.
