'use strict';

// KnightTrader proprietary VPN controller.
// Drives OS WireGuard (or the ProtonVPN app as a fallback) to route traffic
// through a BloFin-allowed country, then PROVES the route by checking the
// real external IP and geolocating it.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// BloFin-allowed countries. (Mexico requires a paid ProtonVPN plan.)
const ALLOWED_COUNTRIES = [
  { code: 'RO', name: 'Romania' },
  { code: 'PL', name: 'Poland' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'MX', name: 'Mexico' },
  { code: 'JP', name: 'Japan' },
];

const ALLOWED_CODES = new Set(ALLOWED_COUNTRIES.map((c) => c.code));

// Folder where the user drops one WireGuard .conf per country, e.g. RO.conf
const VPN_CONFIG_DIR = path.join(os.homedir(), '.knighttrader', 'vpn');

function isAllowedCountry(code) {
  return !!code && ALLOWED_CODES.has(String(code).toUpperCase());
}

function allowedCountryList() {
  return ALLOWED_COUNTRIES.slice();
}

function ensureConfigDir() {
  try {
    if (!fs.existsSync(VPN_CONFIG_DIR)) fs.mkdirSync(VPN_CONFIG_DIR, { recursive: true });
  } catch {}
  return VPN_CONFIG_DIR;
}

// --- External IP + geolocation (the proof that routing works) -------------

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON from ' + url));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Timeout contacting ' + url));
    });
    req.on('error', reject);
  });
}

// Returns { ip, country, countryName, allowed, source }
async function getExternalIpInfo() {
  // Rotate through free geo IP services so a single rate-limit doesn't
  // break the "allowed country" verification.
  const geoSources = [
    { url: 'https://ipapi.co/json/', ip: (d) => d.ip, cc: (d) => d.country_code, name: (d) => d.country_name },
    { url: 'https://ipwho.is/', ip: (d) => d.ip, cc: (d) => d.country_code, name: (d) => d.country },
  ];
  for (const src of geoSources) {
    try {
      const info = await fetchJson(src.url);
      const country = String(src.cc(info) || '').toUpperCase();
      if (!country) continue;
      return {
        ip: src.ip(info) || null,
        country,
        countryName: src.name(info) || '',
        allowed: isAllowedCountry(country),
        source: new URL(src.url).hostname,
      };
    } catch (e) {
      // try next source
    }
  }
  // Last resort: ip + no geo (can't prove allowed)
  try {
    const ip = (await fetchJson('https://api.ipify.org?format=json')).ip;
    return { ip, country: null, countryName: '', allowed: false, source: 'ipify.org (no geo)' };
  } catch (e2) {
    return { ip: null, country: null, countryName: '', allowed: false, source: 'unreachable' };
  }
}

// --- Backend detection -----------------------------------------------------

function findWireGuard() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'WireGuard', 'wireguard.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'WireGuard', 'wireguard.exe'),
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
  }
  // macOS / Linux
  for (const p of ['/usr/local/bin/wg-quick', '/opt/homebrew/bin/wg-quick', '/usr/bin/wg-quick']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findProtonVpnApp() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Proton', 'ProtonVPN', 'ProtonVPN.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Proton', 'ProtonVPN', 'ProtonVPN.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'ProtonVPN', 'ProtonVPN.exe'),
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
  }
  const macPath = '/Applications/ProtonVPN.app';
  return fs.existsSync(macPath) ? macPath : null;
}

function detectBackends() {
  const wireguard = findWireGuard();
  const proton = findProtonVpnApp();
  const configs = listConfigs();
  return {
    wireguard,
    protonVpn: proton,
    configDir: VPN_CONFIG_DIR,
    configs,
    hasUsableBackend: !!(wireguard || proton),
    recommended: wireguard ? 'wireguard' : proton ? 'protonvpn-app' : 'none',
  };
}

// Map config files to countries. File names like RO.conf, NL.conf, or
// country-romania.conf are accepted.
function listConfigs() {
  ensureConfigDir();
  let files = [];
  try {
    files = fs.readdirSync(VPN_CONFIG_DIR).filter((f) => f.toLowerCase().endsWith('.conf'));
  } catch {}
  return files.map((f) => {
    const base = path.basename(f, '.conf');
    const code = base.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
    const meta = ALLOWED_COUNTRIES.find((c) => c.code === code);
    return {
      file: f,
      path: path.join(VPN_CONFIG_DIR, f),
      code,
      name: meta ? meta.name : code,
      allowed: isAllowedCountry(code),
    };
  });
}

// --- Connection management -------------------------------------------------

let activeProcess = null; // for wg-quick spawned on mac/linux
let activeTunnelName = null; // for Windows wireguard service

function configForCountry(code) {
  const target = String(code).toUpperCase();
  const found = listConfigs().find((c) => c.code === target && c.allowed);
  return found || null;
}

async function connectCountry(code) {
  const country = String(code).toUpperCase();
  if (!isAllowedCountry(country)) {
    return { ok: false, error: `${country} is not a BloFin-allowed country.` };
  }
  const wg = findWireGuard();
  if (!wg) {
    const proton = findProtonVpnApp();
    if (proton) {
      // Fallback: launch the ProtonVPN app and ask the user to pick the country.
      const { shell } = require('electron');
      try { shell.openPath(proton); } catch {}
      return {
        ok: false,
        needsConfig: true,
        error: 'WireGuard not found. Opened ProtonVPN — please connect to ' + country + ' there, then click Verify.',
      };
    }
    return { ok: false, needsConfig: true, error: 'No VPN backend detected. Install WireGuard or ProtonVPN.' };
  }

  const cfg = configForCountry(country);
  if (!cfg) {
    return {
      ok: false,
      needsConfig: true,
      error: `No WireGuard config for ${country}. Drop ${country}.conf into ${VPN_CONFIG_DIR} (see How-To).`,
    };
  }

  try {
    if (process.platform === 'win32') {
      // Install as a tunnel service so it survives the app process.
      await run(wg, ['/installtunnelservice', cfg.path]);
      activeTunnelName = path.basename(cfg.path, '.conf');
    } else {
      // macOS/Linux: wg-quick up <path>
      activeProcess = spawn(wg, ['up', cfg.path], { stdio: 'ignore' });
    }
    // Give WireGuard a moment, then prove the route.
    await new Promise((r) => setTimeout(r, 2500));
    const ipInfo = await getExternalIpInfo();
    return {
      ok: true,
      connected: true,
      country,
      ipInfo,
      routedThroughAllowed: ipInfo.allowed,
    };
  } catch (e) {
    return { ok: false, error: `Failed to connect: ${e.message}` };
  }
}

async function disconnect() {
  try {
    if (process.platform === 'win32' && activeTunnelName) {
      const wg = findWireGuard();
      if (wg) await run(wg, ['/uninstalltunnelservice', activeTunnelName]);
      activeTunnelName = null;
    } else if (activeProcess) {
      activeProcess.kill('SIGTERM');
      activeProcess = null;
    }
    return { ok: true, connected: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function getStatus() {
  const backends = detectBackends();
  const ipInfo = await getExternalIpInfo();
  return {
    ...backends,
    connected: !!(activeProcess || activeTunnelName),
    externalIp: ipInfo.ip,
    country: ipInfo.country,
    countryName: ipInfo.countryName,
    allowed: ipInfo.allowed,
    ipSource: ipInfo.source,
  };
}

module.exports = {
  ALLOWED_COUNTRIES,
  allowedCountryList,
  isAllowedCountry,
  getExternalIpInfo,
  detectBackends,
  listConfigs,
  connectCountry,
  disconnect,
  getStatus,
  VPN_CONFIG_DIR,
};
