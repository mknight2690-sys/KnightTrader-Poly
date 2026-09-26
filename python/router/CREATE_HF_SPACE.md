# Create Hugging Face Space for Free LLM Rotator

## Quick Setup (5 minutes)

### Option 1: Web UI (Easiest)
1. Go to https://huggingface.co/new-space
2. **Owner**: `mknight2690-sys` (or your username)
2. **Space name**: `emirald-rotator`
3. **SDK**: `Docker`
4. **Hardware**: `CPU basic` (Free)
5. **Visibility**: `Public` (free forever)
6. Click **Create Space**

### Option 2: CLI (if you have HF token)
```bash
hf auth login  # Enter your token from https://huggingface.co/settings/tokens
hf repo create mknight2690-sys/emirald-rotator --type space --sdk docker
```

---

## After Space Creation

The Space will automatically build from the GitHub repo:
- **Source**: `https://github.com/mknight2690-sys/emirald-rotator`
- **Build**: Uses the `Dockerfile` in the repo
- **Port**: 8082 (configured in Dockerfile)

**Wait 3-5 minutes for first build** - check the "Logs" tab.

---

## Get Your Public URL

Once built, your rotator will be available at:
```
https://mknight2690-sys-emirald-rotator.hf.space
```

Test it:
```bash
curl https://mknight2690-sys-emirald-rotator.hf.space/health
curl -X POST https://mknight2690-sys-emirald-rotator.hf.space/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'
```

---

## Update Chat Widget

Once you have the URL, update the chat widget in `emirald-web/static/chat/chat-widget.js`:

```javascript
this.rotatorUrl = 'https://mknight2690-sys-emirald-rotator.hf.space';
```

And update the Flask API endpoint in `emirald-web/app.py`:
```python
rotator_url = 'https://mknight2690-sys-emirald-rotator.hf.space/v1/chat/completions'
```

---

## Free Tier Limits (Hugging Face Spaces)

| Resource | Free Tier |
|----------|-----------|
| CPU | 2 vCPUs |
| RAM | 16 GB |
| Storage | 50 GB |
| Uptime | **Always on** (public spaces) |
| GPU | Not included (need paid) |
| Concurrency | Limited by CPU/RAM |

**No sleep mode for public spaces!** Always available.

---

## Environment Variables (Optional)

In HF Space Settings → Variables, you can add:
- `ROUTER_MAX_INFLIGHT_PER_KEY` = "3"
- `ROUTER_MAX_INFLIGHT_TOTAL` = "64"
- `ROUTER_KEY_ACQUIRE_WAIT_S` = "8"

---

## Keys Management

**Important**: The API keys (`keys_*.txt`) are in `.gitignore` and NOT pushed to GitHub.

**Add keys in HF Space Settings → Secrets:**
- Go to Space Settings → Variables and secrets → New secret
- Create secrets for each provider (optional, can embed in providers.json):
  - `OPENROUTER_KEYS` (comma-separated)
  - `DEEPSEEK_KEYS`
  - `KIMI_KEYS`
  - `SILICONFLOW_KEYS`
  - `QWEN_KEYS`
  - `GLM_KEYS`
  - `NOUS_KEYS`
  - `NVIDIA_KEYS`

Then modify `router.py` to read from environment variables, OR create the key files at runtime in Dockerfile:

```dockerfile
# In Dockerfile, before CMD:
RUN echo "${OPENROUTER_KEYS}" | tr ',' '\n' > keys_openrouter.txt
```

---

## Testing the Deployed Rotator

Once live:
```bash
# Health check
curl https://mknight2690-sys-emirald-rotator.hf.space/health

# Chat completion
curl -X POST https://mknight2690-sys-emirald-rotator.hf.space/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello Emirald!"}]}'
```

Expected response: JSON with `choices[0].message.content`

---

## Update Emirald Chat Widget

Once deployed, update these two places:

1. **Frontend** (`emirald-web/static/chat/chat-widget.js`):
   ```javascript
   this.rotatorUrl = 'https://mknight2690-sys-emirald-rotator.hf.space';
   ```

2. **Backend** (`emirald-web/app.py`):
   ```python
   rotator_url = 'https://mknight2690-sys-emirald-rotator.hf.space/v1/chat/completions'
   ```

Then push both repos - the chat will work globally without any local rotator!