const crypto = require('crypto');
const https = require('https');
const { Wallet } = require('ethers');

const CLOB_HOST = 'https://clob.polymarket.com';
const DATA_HOST = 'https://data-api.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';

function decodeApiSecret(secret) {
  let s = String(secret || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function l2Signature(secret, timestamp, method, requestPath, body = '') {
  const message = `${timestamp}${String(method || 'GET').toUpperCase()}${requestPath}${body || ''}`;
  return crypto.createHmac('sha256', decodeApiSecret(secret)).update(message).digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function requestJson(url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout,
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
        resolve({ status: res.statusCode || 0, raw, data });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Polymarket request timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function signerAddress(privateKey) {
  const key = String(privateKey || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('Private key must be a 0x-prefixed 32-byte hex key');
  }
  return new Wallet(key).address;
}

function clobHeaders(creds, method, requestPath, body = '') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const address = signerAddress(creds.privateKey);
  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: l2Signature(creds.secret || creds.secretKey, timestamp, method, requestPath, body),
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: creds.apiKey,
    POLY_PASSPHRASE: creds.passphrase,
  };
}

async function clobGet(creds, requestPath, query = '') {
  const headers = clobHeaders(creds, 'GET', requestPath, '');
  const url = `${CLOB_HOST}${requestPath}${query ? `?${query}` : ''}`;
  return requestJson(url, { headers });
}

async function deriveL2Creds(privateKey) {
  const wallet = new Wallet(String(privateKey || '').trim());
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 0;
  const signature = await wallet.signTypedData(
    { name: 'ClobAuthDomain', version: '1', chainId: 137 },
    {
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
    },
    {
      address: wallet.address,
      timestamp,
      nonce,
      message: 'This message attests that I control the given wallet',
    }
  );
  const res = await requestJson(`${CLOB_HOST}/auth/derive-api-key`, {
    headers: {
      POLY_ADDRESS: wallet.address,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: timestamp,
      POLY_NONCE: String(nonce),
    },
  });
  const apiKey = res.data?.apiKey || res.data?.api_key || '';
  const secret = res.data?.secret || '';
  const passphrase = res.data?.passphrase || '';
  if (res.status < 200 || res.status >= 300 || !apiKey || !secret || !passphrase) {
    return null;
  }
  return { apiKey, secret, passphrase, privateKey: String(privateKey || '').trim() };
}

async function readCollateral(creds, signatureType) {
  const res = await clobGet(
    creds,
    '/balance-allowance',
    `asset_type=COLLATERAL&signature_type=${signatureType}`
  );
  const balance = Number(res.data?.balance);
  if (res.status >= 200 && res.status < 300 && Number.isFinite(balance)) {
    return { ok: true, signatureType, balance: balance / 1e6, raw: res.data };
  }
  return { ok: false, signatureType, status: res.status, msg: res.data?.error || res.raw?.slice(0, 180) || `HTTP ${res.status}` };
}

async function resolveFunder(address) {
  const profile = await requestJson(`${GAMMA_HOST}/public-profile?address=${address}`);
  const proxy = String(profile.data?.proxyWallet || profile.data?.proxy_wallet || '').trim();
  return proxy || address;
}

async function readPortfolio(user) {
  const [valueRes, posRes] = await Promise.all([
    requestJson(`${DATA_HOST}/value?user=${user}`),
    requestJson(`${DATA_HOST}/positions?user=${user}&sizeThreshold=0.01&limit=100`),
  ]);
  const valueRow = Array.isArray(valueRes.data) ? valueRes.data[0] : valueRes.data;
  const portfolioValue = Number(valueRow?.value);
  const positions = Array.isArray(posRes.data) ? posRes.data : [];
  return {
    portfolioValue: Number.isFinite(portfolioValue) ? portfolioValue : 0,
    positions,
  };
}

function mapPosition(position) {
  const title = String(position.title || position.slug || 'market').replace(/\s+/g, ' ').trim();
  const outcome = String(position.outcome || '').trim();
  const symbol = `${title} ${outcome}`.trim();
  return {
    instId: `${symbol}-USDT`,
    settleCcy: 'USDT',
    positionSide: 'long',
    side: 'long',
    symbol,
    unrealizedPnl: Number(position.cashPnl) || 0,
    unrealizedPnlRatio: (Number(position.percentPnl) || 0) / 100,
    margin: Number(position.currentValue) || 0,
    initialMargin: Number(position.initialValue) || Number(position.currentValue) || 0,
    positions: Number(position.size) || 0,
    averagePrice: Number(position.avgPrice) || 0,
    markPrice: Number(position.curPrice) || 0,
    leverage: 1,
    marginMode: 'isolated',
  };
}

async function fetchPolymarketAccount(creds) {
  const apiKey = String(creds.apiKey || '').trim();
  const secret = String(creds.secret || creds.secretKey || '').trim();
  const passphrase = String(creds.passphrase || '').trim();
  const privateKey = String(creds.privateKey || '').trim();
  if (!apiKey || !secret || !passphrase || !privateKey) return null;

  let normalized = { apiKey, secret, passphrase, privateKey };
  const address = signerAddress(privateKey);
  let cash = null;
  let signatureType = 0;
  async function readCash(creds) {
    let found = null;
    let usedType = 0;
    for (const type of [3, 1, 2, 0]) {
      const attempt = await readCollateral(creds, type);
      if (!attempt.ok) continue;
      found = attempt.balance;
      usedType = type;
      if (attempt.balance > 0) break;
    }
    return { found, usedType };
  }
  let cashRead = await readCash(normalized);
  const derived = await deriveL2Creds(privateKey);
  if (derived) {
    const derivedRead = await readCash(derived);
    const pastedOk = cashRead.found != null;
    const derivedOk = derivedRead.found != null;
    const derivedBetter = derivedOk && (
      !pastedOk || (derivedRead.found > 0 && (cashRead.found == null || cashRead.found <= 0))
    );
    if (derivedBetter || !pastedOk) {
      normalized = derived;
      cashRead = derivedOk ? derivedRead : cashRead;
    }
  } else if (cashRead.found == null) {
    return null;
  }
  cash = cashRead.found;
  signatureType = cashRead.usedType;
  if (cash == null) return null;

  const funder = await resolveFunder(address);
  const portfolio = await readPortfolio(funder);
  const openPositions = portfolio.positions.filter((row) => Number(row.size) > 0).map(mapPosition);
  const positionValue = openPositions.reduce((sum, row) => sum + (Number(row.margin) || 0), 0);
  const unrealized = openPositions.reduce((sum, row) => sum + (Number(row.unrealizedPnl) || 0), 0);
  const totalEquity = portfolio.portfolioValue > 0 ? portfolio.portfolioValue : cash + positionValue;

  return {
    ok: true,
    address,
    funder,
    signatureType,
    totalEquity,
    totalAvailable: cash,
    totalUnrealized: unrealized,
    totalMargin: positionValue,
    accountRows: [{ currency: 'USDC', available: cash, equity: totalEquity }],
    openPositions,
    closedPositions: [],
    openCount: openPositions.length,
    fetchedAt: Date.now(),
  };
}

async function testPolymarketCredentials(creds) {
  const account = await fetchPolymarketAccount(creds);
  if (!account) {
    return { ok: false, error: 'Polymarket rejected the API key, secret, passphrase, or private key.' };
  }
  const summary = `USDC cash ${account.totalAvailable.toFixed(2)} · portfolio ${account.totalEquity.toFixed(2)} · ${account.openCount} open`;
  return { ok: true, summary, mode: 'LIVE', address: account.address, funder: account.funder };
}

module.exports = {
  fetchPolymarketAccount,
  testPolymarketCredentials,
  signerAddress,
};
