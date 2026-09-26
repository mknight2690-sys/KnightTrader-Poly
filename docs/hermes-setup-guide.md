# Hermes + Blofin Setup — Complete Beginner Guide (Windows)
> **Cached from:** https://mknight2690-sys.github.io/Polly-Poly-Bot/hermes-windows-1min-cron.html  
> **Cached by:** KnightTrader app — available offline

---

## Your guide link (bookmark this)
```
https://mknight2690-sys.github.io/Polly-Poly-Bot/hermes-windows-1min-cron.html
```

## Your money plan (example)
1. You started with about **$100**.
2. You paid about **$47** for this setup guide.
3. Keep about **$50** to buy **USDT on Coinbase** (debit/credit card, Apple Pay, Google Pay, or bank — whatever Coinbase offers you).
4. Send that USDT from Coinbase → **Blofin** deposit address (same network both sides).
5. Fees exist (Coinbase + network). You might land with a little less than $50 on Blofin. That is normal. Still continue.

> **Honest residency note:** Blofin's Terms list some places (including the United States) as Restricted Locations for residents/domiciled users. Coinbase is the sane place to buy with a normal card. Sending crypto to Blofin does *not* rewrite Blofin's rules. Follow Blofin's Terms and your local laws. Account freezes / loss of access are real risks if you are not allowed to use Blofin.

> **Finish line:** computer never sleeps → VPN on an allowed country → USDT bought on Coinbase → arrived on Blofin Futures → Hermes installed → 1-minute job running → you see Hermes take at least one trade on Blofin.

> **Risk (plain English):** Trading can lose money. With ~$50 you can lose some or all of it. Only use money you can afford to lose. This is a how-to, not financial advice. Follow Blofin's rules and your local laws.

---

## Table of Contents — Do these in order — do not skip
0. [Tiny word list + first-computer basics](#0-tiny-word-list)
1. [Stop your computer from sleeping (required)](#1-stop-computer-from-sleeping)
2. [Free Proton VPN → Blofin-allowed country](#2-free-proton-vpn)
3. [Create Coinbase + buy ~$50 USDT](#3-coinbase)
4. [Create a Blofin account (VPN still on)](#4-blofin-account)
5. [Send USDT from Coinbase → Blofin](#5-send-usdt)
6. [Move USDT into Futures (so Hermes can trade)](#6-move-to-futures)
7. [Create Blofin API key (Compendium + Trading + Transfer)](#7-api-key)
8. [Save keys in a text file on your computer](#8-save-keys)
9. [Install Hermes (Windows or Mac)](#9-install-hermes)
10. [Open the Hermes dashboard in your browser](#10-dashboard)
11. [Paste your key-file path (builds the prompt)](#11-key-path)
12. [Create the 1-minute cron job](#12-cron)
13. [Copy the prompt into that cron job](#13-prompt)
14. [Confirm Hermes takes a trade or two](#14-confirm)

---

## 0. Tiny word list

| Term | Meaning |
|------|---------|
| **Browser** | The app for websites. Windows usually has **Edge**. Chrome is fine too. |
| **Address bar** | The long box at the top of the browser where you paste URLs. |
| **Copy / Paste** | Windows: **Ctrl+C** copy, **Ctrl+V** paste. In PowerShell, **right-click** often pastes. |
| **Start menu** | Windows logo key or Start button. Type an app name. |
| **Blofin** | The exchange website where your money and trades live. |
| **USDT** | "Digital dollars" on Blofin. Roughly 1 USDT ≈ $1. |
| **VPN** | App that changes which country the internet thinks you are in. Required. |
| **API key** | A password-like key that lets Hermes trade for you (not your login password). |
| **Hermes** | The free program on your computer that thinks and places trades. |
| **Dashboard** | Hermes' control page in your web browser. |
| **Cron** | A repeating timer. Ours runs Hermes every 1 minute. |
| **PowerShell** | The text window on Windows where you paste install commands. |

---

## 1. Stop Computer From Sleeping

If the computer sleeps, Hermes' 1-minute loop stops and you miss trades.
Do this once now. Leave the laptop **open** and preferably **plugged in** while Hermes runs.

### Windows (PowerShell — paste with right-click → Enter):
```powershell
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
```
> `0` means Never. Screen staying on uses more power — leave the charger connected when Hermes runs overnight.

### Windows (click path):
1. Click **Start** → type **Power and sleep** or **Power & battery** → open it.
2. When plugged in: set **Turn off my screen after** to **Never**.
3. When plugged in: set **Put my device to sleep after** to **Never**.
4. On battery: also set sleep to **Never** while learning (or keep it plugged in).
5. Optional: Start → type **Choose what closing the lid does** → for "When I close the lid" set **Do nothing** → Save changes.

---

## 2. Free Proton VPN

Blofin is not available in all countries. You need a VPN pointing to an allowed country.

### Allowed countries (use one of these as your VPN exit):
- Romania 🇷🇴
- Poland 🇵🇱
- Netherlands 🇳🇱
- Mexico 🇲🇽
- Japan 🇯🇵

### Restricted (do NOT use):
- United States 🇺🇸
- Canada 🇨🇦
- Singapore 🇸🇬

### Steps:
1. Go to **https://protonvpn.com/download** — download the Windows app (free tier is fine).
2. Install it, create a free account.
3. Connect to a server in an allowed country (Netherlands is reliable).
4. Confirm your IP changed: go to **https://whatismyipaddress.com** — it should show a non-US country.
5. **Keep VPN on for all steps below.**

---

## 3. Coinbase — Buy ~$50 USDT

1. Go to **https://coinbase.com** — create an account, verify your ID.
2. Once verified, click **Buy / Sell**.
3. Search for **USDT** (Tether).
4. Buy approximately **$50 worth** using your debit card, credit card, Apple Pay, or bank.
5. Wait for it to arrive in your Coinbase account (usually instant with a card).

---

## 4. Blofin Account (VPN still on)

1. **Keep your VPN connected** to an allowed country.
2. Go to **https://blofin.com** → click **Sign Up**.
3. Use your email. Complete email verification.
4. KYC is optional. You can withdraw up to **20,000 USDT per day** without KYC. If you want higher limits or extra features later, you can explore additional options such as Palau-based verification, but it is not required for normal use.
5. Log in. You are now on Blofin.

---

## 5. Send USDT from Coinbase → Blofin

1. On **Blofin**: click **Assets** → **Deposit** → choose **USDT** → choose network (**TRC20** is cheapest, or **ERC20**).
2. Copy the **Blofin deposit address**.
3. On **Coinbase**: click **Send / Receive** → **Send** → choose **USDT** → paste the Blofin address.
4. **Match the network** (both must be TRC20, or both ERC20 — mixing causes permanent loss).
5. Send the full amount. Confirm. Wait 5–15 minutes for arrival.
6. Check **Blofin → Assets → Funding** to see your USDT.

---

## 6. Move USDT into Futures

Hermes trades in the **Futures / USDT-M** wallet. USDT lands in Funding first.

1. On Blofin: **Assets** → **Transfer**.
2. From: **Funding** → To: **Futures**.
3. Asset: **USDT** → Amount: all of it → **Confirm**.
4. Check **Assets → Futures** — your USDT should now be there.

---

## 7. Create Blofin API Key

Hermes needs 3 permissions: **Compendium + Trading + Transfer**

1. Blofin: click your avatar (top right) → **API Management** → **Create API Key**.
2. Label: anything (e.g. `hermes`).
3. Check these boxes: ✅ **Read** (Compendium) ✅ **Trade** ✅ **Withdraw/Transfer**
4. Set passphrase — **remember this, you need it**.
5. Complete 2FA if prompted.
6. You will see: **API Key**, **Secret Key**, **Passphrase**.

> ⚠ The Secret Key is shown ONCE. Copy it immediately.

---

## 8. Save Keys in a Text File

Create a file called exactly:
```
My Blofin API Compendium.txt
```

Save it to your **Downloads** folder. Contents:
```
Passphrase: your-passphrase-here
API Key: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
API Secret: your-secret-key-here
```

> KnightTrader writes this file automatically when you click **Save & Write Compendium** in the Setup tab.

---

## 9. Install Hermes (Sandboxed in KnightTrader)

In **KnightTrader**, go to the **Hermes** tab → **Step 1: Install Hermes (Sandboxed)**.

Click **Install Hermes**. The app will run the official Nous Research installer:
```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```
...but with custom `-HermesHome` and `-InstallDir` flags so it installs **inside the app's data folder only** — never touching your system.

This downloads: Python (via `uv`), the Hermes agent repo from GitHub, and all dependencies. Takes 2–5 minutes.

---

## 10. Open the Hermes Dashboard

In **KnightTrader**, go to the **Hermes** tab → **Step 3: Start Dashboard**.

Click **Start Dashboard**. The dashboard embeds directly in the app at `http://127.0.0.1:9119`.

---

## 11. Paste Your Key-File Path (builds the prompt)

The prompt references your Compendium file path. KnightTrader builds this automatically based on the credentials you entered in the Setup tab.

Example path:
```
C:\Users\YourName\Downloads\My Blofin API Compendium.txt
```

---

## 12. Create the 1-Minute Cron Job

In **KnightTrader**, go to the **Hermes** tab → **Step 4: Auto-Configure Cron**.

Click **Auto-Configure Cron**. KnightTrader will attempt to create the cron via the Hermes dashboard API with these settings:

| Field | Value |
|-------|-------|
| **Name** | `blofin-equity-vertical` |
| **Schedule** | `every 1m` |
| **Provider** | `Nous` |
| **Model** | `tencent/hy free` |
| **Delivery** | `local` |

---

## 13. The Trading Prompt

The full prompt is auto-generated and injected by KnightTrader when configuring the cron. It includes:
- Your compendium file path (credentials)
- The "equity curve vertical" trading mission
- The Blofin WAF/Cloudflare bypass playbook (Camoufox, curl_cffi)
- Learning persistence instructions (write lessons after each tick)

If auto-config fails, a **Copy Prompt** button appears in KnightTrader so you can paste it into the Hermes dashboard manually.

---

## 14. Confirm Hermes Takes a Trade

1. On Blofin: go to **Futures** → **Open Orders** or **Order History**.
2. Wait 1–3 minutes after the cron starts.
3. You should see Hermes place at least one position.
4. In KnightTrader **Logs tab**: watch live output from Hermes.

### Prove cron via Chats refresh (rubber to the road):
- In the Hermes dashboard (embedded in KnightTrader), click **Chats**.
- You should see a new chat entry appear every ~1 minute.
- Each chat is one tick of Hermes running and reporting back.

---

## VPN Country Reference

### ✅ Allowed (use one):
- Netherlands, United Kingdom, Germany, France, Spain, Italy, Canada, Australia, Singapore, Japan, South Korea, UAE, Turkey, Brazil, Mexico, Argentina, Colombia, Poland, Czech Republic, Romania, Hungary

### ❌ Restricted (do NOT use):
- United States, Cuba, Iran, North Korea, Syria, Crimea (any country on Blofin's restricted list — check blofin.com/terms for the current list)

---

*Cached locally by KnightTrader. Check the live URL above for the latest version.*
