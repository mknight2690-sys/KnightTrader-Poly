/* ── KnightTrader BloFin App Logic v2 ─────────────────────────────── */

let currentTab = 'howto';
let autoScroll = true;
let newLogs = 0;
let hermesInstalled = false;
let dashboardRunning = false;
let dashboardStartInFlight = false;
let cachedAppVersion = '';
// One-shot: on startup we land on the Hermes tab so the user sees the
// gateway + dashboard starting up, and once the running indicator
// flashes we auto-switch — to the How-To tab for new users (no setup
// yet), or the Trading tab for existing users. Guards so we only do
// this once and never override a tab the user manually picked.
let startupAutoSwitchArmed = true;
let didStartupAutoSwitch = false;
let hasBlofinCreds = false;

// ── DOM shortcuts ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  minimize: $('btn-minimize'), maximize: $('btn-maximize'), close: $('btn-close'),

  // VPN helper
  vpnCountry: $('vpn-country'),
  btnVpnGuide: $('btn-vpn-guide'),
  vpnStatus: $('vpn-status'),
  navItems: document.querySelectorAll('.nav-item'),
  tabPanels: document.querySelectorAll('.tab-panel'),
  statusPill: $('status-pill'), statusOrb: $('status-orb'), statusLabel: $('status-label'),
  logBadge: $('log-badge'), hermesNavBadge: $('hermes-nav-badge'),

  // Setup
  formSetup: $('form-setup'),
  nousApiKey: $('nous-api-key'), nousModel: $('nous-model'),
  btnLoadNousFile: $('btn-load-nous-file'), nousFilePath: $('nous-file-path'),
  btnTestNous: $('btn-test-nous'), nousTestStatus: $('nous-test-status'),
  blofinApiKey: $('blofin-api-key'), blofinSecretKey: $('blofin-secret-key'), blofinPassphrase: $('blofin-passphrase'),
  polyPrivateKey: $('poly-private-key'),
  blofinDemoMode: $('blofin-demo-mode'),
  btnLoadBlofinFile: $('btn-load-blofin-file'), blofinFilePath: $('blofin-file-path'),
  btnTestBlofin: $('btn-test-blofin'), blofinTestStatus: $('blofin-test-status'),
  saveStatus: $('save-status'), btnSave: $('btn-save'),

  // Hermes tab
  hermesInstallStatus: $('hermes-install-status'), btnInstallHermes: $('btn-install-hermes'),
  hermesVersionTag: $('hermes-version-tag'), hermesHomeDisplay: $('hermes-home-display'),
  btnWriteCompendium: $('btn-write-compendium'), compendiumStatus: $('compendium-status'),
  compendiumPathDisplay: $('compendium-path-display'),
  btnStartDashboard: $('btn-start-dashboard'), btnStopDashboard: $('btn-stop-dashboard'),
  dashboardStatus: $('dashboard-status'),
  btnConfigureCron: $('btn-configure-cron'), cronStatus: $('cron-status'),
  manualPromptWrap: $('manual-prompt-wrap'), cronPromptText: $('cron-prompt-text'), btnCopyPrompt: $('btn-copy-prompt'),
  dashboardEmbedWrap: $('dashboard-embed-wrap'), dashUrl: $('dash-url'),
  hermesWebview: $('hermes-webview'),
  btnReloadDash: $('btn-reload-dash'), btnOpenDashExternal: $('btn-open-dash-external'),

  // Logs
  logContainer: $('log-container'), logList: $('log-list'), logEmpty: $('log-empty'),
  btnAutoscroll: $('btn-autoscroll'), btnClearLogs: $('btn-clear-logs'),

  // Settings
  aboutHermesVer: $('about-hermes-ver'),
  aboutAppVersion: $('about-app-version'),

  // Trading
  tradingWebview: $('trading-webview'),
  tradingWebviewWrap: $('trading-webview-wrap'),
  btnReloadTrading: $('btn-reload-trading'),

  // Sidebar / updates
  sidebarVersion: $('sidebar-version'),

  // Update popup menu
  popupLauncher: $('popup-launcher'),
  popupMenu: $('popup-menu'),
  btnPopupTrigger: $('btn-popup-trigger'),
  btnCheckForUpdates: $('btn-check-for-updates'),
  popupUpdateStatus: $('popup-update-status'),
  popupAppVersion: $('popup-app-version'),

  // Update banner
  updateBanner: $('update-banner'),
  updateBannerTitle: $('update-banner-title'),
  updateBannerText: $('update-banner-text'),
  btnRestartUpdate: $('btn-restart-update'),
  btnDismissUpdate: $('btn-dismiss-update'),

};



// ── Init ──────────────────────────────────────────────────────
async function populateNousModels() {
  if (!el.nousModel) return;
  const previous = el.nousModel.value;
  try {
    const catalog = await window.kt.getNousModels();
    if (!catalog?.free?.length) return;
    el.nousModel.innerHTML = '';
    const freeGroup = document.createElement('optgroup');
    freeGroup.label = 'Free tier';
    for (const model of catalog.free) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.label || model.id;
      freeGroup.appendChild(opt);
    }
    el.nousModel.appendChild(freeGroup);
    if (catalog.paid?.length) {
      const paidGroup = document.createElement('optgroup');
      paidGroup.label = 'Paid / subscription';
      for (const model of catalog.paid) {
        const opt = document.createElement('option');
        opt.value = model.id;
        opt.textContent = model.label || model.id;
        paidGroup.appendChild(opt);
      }
      el.nousModel.appendChild(paidGroup);
    }
    setNousModelValue(previous || catalog.defaultModel || 'tencent/hy3:free');
  } catch (_) {}
}

async function init() {
  // ── Guard: wait for the preload bridge before touching auth ──
  if (!window.kt) {
    console.warn('[init] window.kt not ready yet — waiting 200ms');
    await new Promise(r => setTimeout(r, 200));
    if (!window.kt) {
      console.error('[init] window.kt still unavailable after retry — aborting');
      throw new Error('window.kt is not available; preload bridge may have failed');
    }
  }

  await populateNousModels();

  try {
    const appVersion = await window.kt.getAppVersion();
    const normalized = appVersion ? String(appVersion).replace(/^v/, '') : '';
    const label = normalized ? `v${normalized}` : '1.0.0';
    // The popup menu is rendered on demand, so its #popup-app-version
    // node may not exist yet. Write to whatever live node we can find,
    // and also remember the version so buildPopupMenu() can use it later.
    if (normalized) {
      const liveVersionNode = el.popupMenu?.querySelector('#popup-app-version');
      if (liveVersionNode) liveVersionNode.textContent = normalized;
      // Stash on a module-scoped var so buildPopupMenu() picks it up.
      cachedAppVersion = normalized;
    }
    if (el.sidebarVersion) el.sidebarVersion.textContent = label;
    if (el.aboutAppVersion) el.aboutAppVersion.textContent = `KnightTrader Poly ${label}`;
  } catch (e) {}

  // Load creds
  try {
    const creds = await window.kt.getCredentials();
    if (creds.nous) {
      el.nousApiKey.value = creds.nous.apiKey || '';
      setNousModelValue(creds.nous.model || 'tencent/hy3:free');
    } else if (creds.nouse) {
      el.nousApiKey.value = creds.nouse.apiKey || '';
      setNousModelValue(creds.nouse.model || 'tencent/hy3:free');
    }
    if (creds.blofin) {
      el.blofinApiKey.value = creds.blofin.apiKey || '';
      el.blofinSecretKey.value = creds.blofin.secretKey || '';
      el.blofinPassphrase.value = creds.blofin.passphrase || '';
      if (el.polyPrivateKey) el.polyPrivateKey.value = creds.blofin.privateKey || '';
      if (el.blofinDemoMode) el.blofinDemoMode.checked = !!creds.blofin.demoMode;
      if (String(creds.blofin.apiKey || '').trim() && String(creds.blofin.secretKey || '').trim()) {
        hasBlofinCreds = true;
      }
    }
  } catch (e) {}

  // Compendium path
  try {
    const p = await window.kt.getCompendiumPath();
    el.compendiumPathDisplay.textContent = p;
  } catch (e) {}

  // Hermes sandboxed home path
  try {
    const h = await window.kt.getHermesHome();
    if (el.hermesHomeDisplay) el.hermesHomeDisplay.textContent = h;
  } catch (e) {}

  try { syncWebviewParking('setup'); } catch (_) {}

  // Load existing logs
  try {
    const logs = await window.kt.getLogs();
    logs.forEach(appendLogLine);
  } catch (e) {}

  // Check hermes install
  await checkHermesStatus();

  // Check dashboard status — only restore UI if gateway is actually ready.
  // A leftover listener on 9119 used to hide the start button forever.
  try {
    const ds = await window.kt.getDashboardStatus();
    if (ds.ready && ds.gatewayRunning) {
      setDashboardState(true, true, true);
      loadDashboard(ds.url || 'http://127.0.0.1:9219');
      maybeStartupAutoSwitch();
    } else {
      setDashboardState(false, false);
    }
  } catch (e) {}

  // Auto-connect Hermes dashboard + gateway on app startup (not only when
  // the user clicks into the Hermes tab). Previously this only fired from
  // switchTab('hermes'), so the user had to visit the tab + scroll to get
  // the gateway running before cron could fire.
  if (hermesInstalled && !dashboardRunning && !dashboardStartInFlight) {
    appendLog('🚀 Auto-starting Hermes dashboard + gateway on startup…', 'info');
    startHermesDashboardUi();
  }

  // Live events
  window.kt.onLogLine((entry) => {
    appendLogLine(entry);
    if (currentTab !== 'logs') { newLogs++; updateLogBadge(); }
  });

  window.kt.onDashboardReady((d) => {
    setDashboardState(true, true, d.gatewayRunning);
    loadDashboard(d.url);
    // Startup sequence: once the dashboard+gateway running indicator
    // flashes, switch from the Hermes tab to the How-To tab (new users)
    // or the Trading tab (existing users).
    if (d.gatewayRunning) maybeStartupAutoSwitch();
  });

  window.kt.onDashboardStopped(() => {
    setDashboardState(false, false);
  });

  // When the startup auto-ping picks a working free model, update the
  // dropdown so the UI matches what the cron is actually using.
  if (window.kt?.onFreeModelSelected) {
    window.kt.onFreeModelSelected((info) => {
      if (info?.model) {
        setNousModelValue(info.model);
        appendLogLine({ ts: Date.now(), type: 'success', msg: `🤖 Auto-selected free model: ${info.model}` });
      }
    });
  }

  updateNousTestButton();
  updateBlofinTestButton();
  bindHermesWebview();

  // Startup sequence: land on the Hermes tab first so the user sees the
  // gateway + dashboard starting up (the running indicator lives here).
  // Once the running indicator flashes, maybeStartupAutoSwitch() sends
  // new users to the How-To tab and existing users to the Trading tab.
  // We do NOT restore the last tab on startup — the user wants this
  // consistent hermes → (running) → howto/trading sequence every launch.
  try { switchTab('hermes'); } catch (_) {}

  // Fallback for brand-new users: if Hermes isn't installed the running
  // indicator will never flash, so after a short delay send them to the
  // How-To tab (the setup guide) anyway.
  if (!hermesInstalled) {
    setTimeout(() => {
      if (currentTab === 'hermes' && !didStartupAutoSwitch) {
        startupAutoSwitchArmed = false;
        didStartupAutoSwitch = true;
        try { switchTab('howto'); } catch (_) {}
      }
    }, 2500);
  }

  // Pre-warm the BloHunter trading desk in the background so the Trading
  // tab has live data the moment we switch to it. This just starts the
  // bridge/SSE; the webview itself loads when the Trading tab is shown.
  setTimeout(() => {
    try { window.kt?.startTradingDashboard?.().catch(() => {}); } catch (_) {}
  }, 12000);
}

// One-shot startup auto-switch: called when the dashboard+gateway running
// indicator is confirmed. Gives the user a brief moment to see the
// running indicator on the Hermes tab, then switches to the How-To tab
// for new users (no Blofin creds / Hermes not installed) or the Trading
// tab for existing users. Cancels itself if the user has already
// manually navigated away from the Hermes tab during the wait.
function maybeStartupAutoSwitch() {
  if (!startupAutoSwitchArmed || didStartupAutoSwitch) return;
  startupAutoSwitchArmed = false;
  didStartupAutoSwitch = true;
  setTimeout(() => {
    // Don't override a tab the user picked themselves during the wait.
    if (currentTab !== 'hermes') return;
    const targetTab = (hermesInstalled && hasBlofinCreds) ? 'trading' : 'howto';
    try { switchTab(targetTab); } catch (_) {}
  }, 1500);
}

// ── Hermes install check ──────────────────────────────────────
async function checkHermesStatus() {
  el.hermesInstallStatus.textContent = 'Checking...';
  try {
    const result = await window.kt.checkHermes();
    hermesInstalled = result.installed;
    if (result.installed) {
      el.hermesInstallStatus.textContent = '✓ Installed';
      el.hermesInstallStatus.style.color = 'var(--good)';
      el.hermesVersionTag.textContent = result.version;
      el.hermesVersionTag.classList.remove('hidden');
      el.btnInstallHermes.textContent = '✓ Already Installed';
      el.btnInstallHermes.disabled = true;
      el.aboutHermesVer.textContent = result.version;
    } else if (result.partial) {
      el.hermesInstallStatus.textContent = '⚠ Partial install — click Install to resume';
      el.hermesInstallStatus.style.color = 'var(--warn)';
      el.btnInstallHermes.textContent = 'Resume Hermes Install';
      el.btnInstallHermes.disabled = false;
      el.aboutHermesVer.textContent = 'Partial install';
    } else {
      el.hermesInstallStatus.textContent = '✗ Not installed';
      el.hermesInstallStatus.style.color = 'var(--error)';
      el.btnInstallHermes.disabled = false;
      el.hermesNavBadge.classList.remove('hidden');
      el.aboutHermesVer.textContent = 'Not installed';
    }
  } catch (e) {
    el.hermesInstallStatus.textContent = 'Check failed';
  }
}

// ── Dashboard state ───────────────────────────────────────────
function setDashboardState(running, ready, gatewayRunning) {
  dashboardRunning = !!(running && ready);
  el.btnStartDashboard.classList.toggle('hidden', running && ready);
  el.btnStartDashboard.disabled = dashboardStartInFlight;
  el.btnStopDashboard.classList.toggle('hidden', !running);
  el.statusPill.classList.toggle('running', running && ready);
  el.statusLabel.textContent = running ? (ready ? 'Running' : 'Starting…') : 'Stopped';

  if (ready) {
    el.dashboardStatus.textContent = gatewayRunning === false
      ? '✓ Dashboard ready — starting gateway…'
      : '✓ Dashboard + gateway ready — cron can fire';
    el.dashboardStatus.style.color = 'var(--good)';
    el.btnConfigureCron.disabled = false;
    el.dashboardEmbedWrap.classList.remove('hidden');
  } else if (running) {
    el.dashboardStatus.textContent = '⏳ Starting dashboard + gateway…';
    el.dashboardStatus.style.color = 'var(--accent)';
    el.btnConfigureCron.disabled = true;
  } else {
    el.dashboardStatus.textContent = 'Not running';
    el.dashboardStatus.style.color = 'var(--text3)';
    el.btnConfigureCron.disabled = true;
    el.dashboardEmbedWrap.classList.add('hidden');
  }
}

async function startHermesDashboardUi() {
  if (dashboardStartInFlight) return;
  dashboardStartInFlight = true;
  setDashboardState(true, false);
  el.dashboardStatus.textContent = '⏳ Starting dashboard + gateway…';
  el.dashboardStatus.style.color = 'var(--accent)';
  try {
    const result = await window.kt.startDashboard();
    if (!result.ok) {
      setDashboardState(false, false);
      el.dashboardStatus.textContent = '✗ ' + (result.msg || result.error || 'Failed to start');
      el.dashboardStatus.style.color = 'var(--error)';
      return;
    }
    setDashboardState(true, true, !!result.gatewayRunning);
    loadDashboard(result.url || 'http://127.0.0.1:9219');
  } catch (e) {
    setDashboardState(false, false);
    el.dashboardStatus.textContent = '✗ ' + (e.message || 'Failed to start');
    el.dashboardStatus.style.color = 'var(--error)';
  } finally {
    dashboardStartInFlight = false;
    el.btnStartDashboard.disabled = false;
  }
}

function loadDashboard(url) {
  el.dashUrl.textContent = url;
  el.hermesWebview.src = url;
}

function unthrottleGuestWebview(webview) {
  if (!webview) return;
  try {
    const wcId = webview.getWebContentsId();
    if (window.kt?.unthrottleWebview) {
      window.kt.unthrottleWebview(wcId).catch(() => {});
    } else {
      window.kt.attachTradingWebview(wcId).catch(() => {});
    }
  } catch (_) {}
}

function bindHermesWebview() {
  const webview = el.hermesWebview;
  if (!webview || webview.dataset.bound === '1') return;
  webview.dataset.bound = '1';
  webview.addEventListener('did-attach', () => unthrottleGuestWebview(webview));
  webview.addEventListener('dom-ready', () => {
    parkWebview(webview, currentTab !== 'hermes');
  });
}

// ── Credentials save ──────────────────────────────────────────
async function saveAndWriteCompendium() {
  const data = {
    nous: {
      apiKey: el.nousApiKey.value.trim(),
      model: el.nousModel.value
    },
    blofin: {
      apiKey: el.blofinApiKey.value.trim(),
      secretKey: el.blofinSecretKey.value.trim(),
      passphrase: el.blofinPassphrase.value.trim(),
      privateKey: el.polyPrivateKey ? el.polyPrivateKey.value.trim() : '',
      demoMode: !!(el.blofinDemoMode && el.blofinDemoMode.checked)
    }
  };
  try {
    await window.kt.saveCredentials(data);
    const comp = await window.kt.writeCompendium();
    if (comp.ok) {
      showSaveStatus('✓ Saved & compendium written', false);
      el.compendiumStatus.classList.remove('hidden');
    } else {
      showSaveStatus('Saved (compendium failed: ' + comp.error + ')', true);
    }
    if (tradingLoaded) {
      window.kt.startTradingDashboard().catch(() => {});
    }
  } catch (e) {
    showSaveStatus('✗ Error: ' + e.message, true);
  }
}

function showSaveStatus(msg, err) {
  el.saveStatus.textContent = msg;
  el.saveStatus.classList.toggle('error', err);
  el.saveStatus.classList.add('show');
  setTimeout(() => el.saveStatus.classList.remove('show'), 3000);
}

function updateNousTestButton() {
  const ready = el.nousApiKey.value.trim().length > 0 && el.nousModel.value.trim().length > 0;
  el.btnTestNous.disabled = !ready;
}

function setNousTestStatus(msg, state) {
  el.nousTestStatus.textContent = msg;
  el.nousTestStatus.className = 'nous-test-status' + (state ? ` ${state}` : '');
}

function setCredFilePath(span, filePath) {
  if (!span) return;
  if (!filePath) {
    span.textContent = '';
    span.classList.remove('loaded');
    return;
  }
  span.textContent = filePath;
  span.classList.add('loaded');
}

function setNousModelValue(model) {
  if (!model || !el.nousModel) return;
  const exists = [...el.nousModel.options].some((opt) => opt.value === model);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = `${model} (from file)`;
    el.nousModel.insertBefore(opt, el.nousModel.firstChild);
  }
  el.nousModel.value = model;
}

function applyNousFromFile(data) {
  if (data.apiKey) el.nousApiKey.value = data.apiKey;
  if (data.model) setNousModelValue(data.model);
  updateNousTestButton();
  setNousTestStatus('', '');
}

function applyBlofinFromFile(data) {
  if (data.apiKey) el.blofinApiKey.value = data.apiKey;
  if (data.secretKey) el.blofinSecretKey.value = data.secretKey;
  if (data.passphrase) el.blofinPassphrase.value = data.passphrase;
  if (el.blofinDemoMode && data.demoMode != null) el.blofinDemoMode.checked = !!data.demoMode;
  updateBlofinTestButton();
  setBlofinTestStatus('', '');
}

function updateBlofinTestButton() {
  const ready = el.blofinApiKey.value.trim().length > 0
    && el.blofinSecretKey.value.trim().length > 0
    && el.blofinPassphrase.value.trim().length > 0
    && el.polyPrivateKey && el.polyPrivateKey.value.trim().length > 0;
  el.btnTestBlofin.disabled = !ready;
}

function setBlofinTestStatus(msg, state) {
  el.blofinTestStatus.textContent = msg;
  el.blofinTestStatus.className = 'nous-test-status' + (state ? ` ${state}` : '');
}

// ── Logs ─────────────────────────────────────────────────────
function appendLog(msg, level = 'info') {
  appendLogLine({ ts: Date.now(), type: level, msg: String(msg) });
}
function appendLogLine(entry) {
  el.logEmpty.style.display = 'none';
  const d = document.createElement('div');
  d.className = `log-line ${entry.type || 'info'}`;
  const ts = new Date(entry.ts).toTimeString().slice(0, 8);
  d.innerHTML = `<span class="log-ts">${ts}</span><span class="log-msg">${esc(entry.msg)}</span>`;
  el.logList.appendChild(d);
  if (autoScroll) el.logContainer.scrollTop = el.logContainer.scrollHeight;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function updateLogBadge() {
  if (newLogs > 0) {
    el.logBadge.textContent = newLogs > 99 ? '99+' : newLogs;
    el.logBadge.classList.remove('hidden');
  } else {
    el.logBadge.classList.add('hidden');
  }
}

let tradingLoaded = false;
let tradingPreloadPath = '';
let tradingInitPromise = null;

function setTradingStatus(text, state) {
  const statusEl = document.getElementById('trading-dashboard-status');
  const activityEl = document.getElementById('trading-activity-status');
  if (statusEl) statusEl.textContent = text || 'Not loaded yet';
  if (statusEl) statusEl.className = 'monitor-value' + (state ? ` ${state}` : '');
}

function setTradingActivity(text) {
  const el = document.getElementById('trading-activity-status');
  if (el) el.textContent = text || 'Waiting for Hermes';
}

function showTradingError(message) {
  if (!message) return;
  try {
    appendLogLine({ ts: Date.now(), type: 'warn', msg: `[Trading] ${String(message)}` });
  } catch (_) {}
  setTradingStatus('Load failed', 'error');
}

function guestHasPage(webview) {
  if (!webview) return false;
  const src = String(webview.getAttribute('src') || webview.src || '');
  return !!src && src !== 'about:blank';
}

function parkWebview(webview, parked) {
  if (!webview) return;
  try {
    webview.classList.toggle('webview-parked', !!parked);
  } catch (_) {}
  if (parked || !guestHasPage(webview)) return;
  try {
    webview.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
  } catch (_) {}
}

function syncWebviewParking(activeTab) {
  parkWebview(el.tradingWebview, activeTab !== 'trading');
  parkWebview(el.hermesWebview, activeTab !== 'hermes');
}

function attachTradingGuest(webview) {
  if (!webview) return;
  try {
    const wcId = webview.getWebContentsId();
    window.kt.attachTradingWebview(wcId).catch((e) => console.warn('attachTradingWebview:', e));
  } catch (e) {
    console.warn('attachTradingWebview:', e);
  }
}

function bindTradingWebview(webview) {
  if (!webview || webview.dataset.bound === '1') return webview;
  webview.dataset.bound = '1';
  webview.addEventListener('did-attach', () => attachTradingGuest(webview));
  webview.addEventListener('dom-ready', () => {
    attachTradingGuest(webview);
    parkWebview(webview, currentTab !== 'trading');
  });
  webview.addEventListener('did-finish-load', async () => {
    try {
      const s = await window.kt.getTradingStatus();
      if (s?.sseConnected) {
        setTradingStatus('Live · SSE connected', 'ok');
        setTradingActivity('Signal connected');
      } else {
        setTradingStatus('Live', 'pending');
        setTradingActivity('Waiting for signal snapshot');
      }
    } catch (_) {
      setTradingStatus('Live', 'pending');
      setTradingActivity('Waiting for signal snapshot');
    }
  });
  webview.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return;
    const reason = e.errorDescription || `Failed to load trading desk (${e.errorCode})`;
    setTradingStatus('Load failed', 'error');
    setTradingActivity('Check Hermes dashboard');
    showTradingError(`${reason}. If trading desk is unavailable, open the Hermes Dashboard in the Hermes tab.`);
  });
  webview.addEventListener('console-message', (e) => {
    if (e.level >= 2 && /unexpected token|chrome is not defined/i.test(e.message || '')) {
      setTradingStatus('Desk error', 'error');
      setTradingActivity('Check Hermes dashboard');
      const where = [e.sourceId, Number.isFinite(e.line) ? `:${e.line}` : ''].join('');
      showTradingError(`${e.message}${where ? ` (${where})` : ''}. If the trading desk cannot load, use the Hermes tab dashboard.`);
    }
  });
  return webview;
}

function ensureTradingWebview(preloadPath) {
  const wrap = el.tradingWebviewWrap;
  if (!wrap) return null;
  const preload = String(preloadPath || '').trim();
  let webview = el.tradingWebview;
  if (webview && (!preload || webview.getAttribute('preload') === preload)) {
    return bindTradingWebview(webview);
  }

  const next = document.createElement('webview');
  next.id = 'trading-webview';
  if (preload) next.setAttribute('preload', preload);
  next.setAttribute('partition', 'persist:blohunter-trading');
  next.setAttribute('allowpopups', '');
  next.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no');
  if (webview) webview.replaceWith(next);
  else wrap.appendChild(next);
  el.tradingWebview = next;
  return bindTradingWebview(next);
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

// ── Tab switching ─────────────────────────────────────────────
function switchTab(name) {
  currentTab = name;
  el.navItems.forEach(i => i.classList.toggle('active', i.dataset.tab === name));
  el.tabPanels.forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  try { syncWebviewParking(name); } catch (_) {}
  if (name === 'logs') { newLogs = 0; updateLogBadge(); }
  if (name === 'trading') { initTradingTab(); }
  if (name === 'hermes' && hermesInstalled && !dashboardRunning && !dashboardStartInFlight) {
    startHermesDashboardUi();
  }
  // Remember the tab so an auto-update restart lands the user back where
  // they were (no lapse in service / context).
  try { localStorage.setItem('kt-last-tab', name); } catch (_) {}
}

async function loadTradingDesk(forceReload = false) {
  if (!tradingPreloadPath) {
    tradingPreloadPath = await window.kt.getBlohunterPreloadPath();
  }
  const webview = ensureTradingWebview(tradingPreloadPath);
  if (!webview) return;

  parkWebview(webview, false);

  const result = await withTimeout(
    window.kt.startTradingDashboard(),
    90000,
    'Trading desk startup timed out. Check Logs, then click Reload.'
  );
  if (!result?.ok || !result.url) return;

  // Always cache-bust so the dashboard loads fresh and reconnects its SSE
  // stream (a stale cached page can leave equity/positions frozen). This
  // only runs on the first desk load — later tab switches reuse the live
  // webview without reloading, so SSE stays connected.
  const nextUrl = `${result.url}${result.url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  if (webview.src !== nextUrl) webview.src = nextUrl;
  tradingLoaded = true;
}

let tradingFirstLoadWelcomed = false;
async function initTradingTab() {
  if (tradingInitPromise) return tradingInitPromise;
  if (tradingLoaded && guestHasPage(el.tradingWebview)) {
    parkWebview(el.tradingWebview, false);
    tradingInitPromise = (async () => {
      try { await window.kt.startTradingDashboard(); } catch (_) {}
      finally { tradingInitPromise = null; }
    })();
    return tradingInitPromise;
  }

  tradingInitPromise = (async () => {
    try {
      await loadTradingDesk(false);
      tradingFirstLoadWelcomed = true;
    } catch (_) {}
    finally { tradingInitPromise = null; }
  })();

  return tradingInitPromise;
}

let trayRestoreTimer = null;
let trayRestoreInFlight = false;

function nudgeGuestWebviews() {
  const guests = [
    { vw: el.tradingWebview, tab: 'trading', attachTrading: true },
    { vw: el.hermesWebview, tab: 'hermes', attachTrading: false },
  ];

  for (const { vw, tab, attachTrading } of guests) {
    if (!vw) continue;
    parkWebview(vw, currentTab !== tab);
    if (!guestHasPage(vw)) continue;
    try {
      if (attachTrading) {
        window.kt.attachTradingWebview(vw.getWebContentsId()).catch(() => {});
      } else {
        unthrottleGuestWebview(vw);
      }
    } catch (_) {}
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const { vw } of guests) {
        if (!vw || !guestHasPage(vw)) continue;
        try {
          vw.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
        } catch (_) {}
      }
      // Ensure bridge/runtime is up without reloading the desk (reload
      // disconnects SSE and forces Hermes dashboard/gateway UI reconnect).
      if (currentTab === 'trading' && tradingLoaded) {
        window.kt.startTradingDashboard().catch(() => {});
      }
    });
  });
}

function restoreUiFromTray() {
  if (trayRestoreTimer) clearTimeout(trayRestoreTimer);
  trayRestoreTimer = setTimeout(() => {
    trayRestoreTimer = null;
    if (trayRestoreInFlight) return;
    trayRestoreInFlight = true;
    try {
      // The bottom-left popup parks BOTH webviews off-screen; if it was
      // open when the user minimized to tray, restore would look frozen.
      if (el.popupMenu && !el.popupMenu.classList.contains('hidden')) {
        setPopupOpen(false);
      }

      syncWebviewParking(currentTab);
      void document.body.offsetHeight;
      nudgeGuestWebviews();
    } catch (_) {}
    finally {
      trayRestoreInFlight = false;
    }
  }, 120);
}

if (window.kt?.onLogLine) {
  window.kt.onLogLine(() => {});
}

if (window.kt?.onUpdateError) {
  window.kt.onUpdateError(() => {});
}

// Window shown after tray/taskbar restore — unpark webviews and nudge repaint.
// Do not reload guests here; that forced Hermes gateway/dashboard reconnect.
if (window.kt?.onWindowShown) {
  window.kt.onWindowShown(restoreUiFromTray);
}

if (el.btnReloadTrading) {
  el.btnReloadTrading.addEventListener('click', () => loadTradingDesk(true).catch(() => {}));
}

// ── Trading tab section quick-nav ──────────────────────────────
// Each button at the bottom of the Trading tab scrolls a section of the
// embedded BloHunter desk into view. The sections live INSIDE the
// #trading-webview guest, so we use executeJavaScript to scrollIntoView
// the matching element. Falls back to scrolling the parent page if the
// webview isn't loaded yet.
document.querySelectorAll('.trading-section-nav-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const selector = btn.dataset.deskScroll;
    if (!selector) return;
    const vw = el.tradingWebview;
    if (!vw) return;
    // Make sure the trading tab's webview is parked=false (visible) first.
    parkWebview(vw, false);
    const js = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'not-found';
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return 'ok';
      })()
    `;
    try {
      const result = await vw.executeJavaScript(js);
      if (result === 'not-found') {
        // Webview loaded but section missing — fall back to scrolling the
        // webview itself into view on the parent page.
        vw.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (_) {
      // Webview not ready — scroll it into view on the parent page so the
      // user at least lands on the desk.
      vw.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// ── Event listeners ───────────────────────────────────────────

if (el.minimize) el.minimize.addEventListener('click', () => window.kt.minimize());
if (el.maximize) el.maximize.addEventListener('click', () => window.kt.maximize());
if (el.close) el.close.addEventListener('click', () => window.kt.close());

el.navItems.forEach(item => item.addEventListener('click', () => switchTab(item.dataset.tab)));

// Setup form
el.formSetup.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.btnSave.disabled = true;
  await saveAndWriteCompendium();
  el.btnSave.disabled = false;
});

// Password toggles
document.querySelectorAll('.toggle-vis').forEach(btn => {
  btn.addEventListener('click', () => {
    const inp = document.getElementById(btn.dataset.target);
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  });
});

el.nousApiKey.addEventListener('input', () => {
  updateNousTestButton();
  setNousTestStatus('', '');
});
el.nousModel.addEventListener('change', () => {
  updateNousTestButton();
  setNousTestStatus('', '');
});

el.btnLoadNousFile.addEventListener('click', async () => {
  el.btnLoadNousFile.disabled = true;
  try {
    const result = await window.kt.pickNousCredentialFile();
    if (result.cancelled) return;
    if (!result.ok) {
      setNousTestStatus(`✗ ${result.error || 'Could not load file'}`, 'error');
      return;
    }
    applyNousFromFile(result.nous);
    setCredFilePath(el.nousFilePath, result.path);
  } catch (e) {
    setNousTestStatus(`✗ ${e.message}`, 'error');
  } finally {
    el.btnLoadNousFile.disabled = false;
  }
});

el.btnLoadBlofinFile.addEventListener('click', async () => {
  el.btnLoadBlofinFile.disabled = true;
  try {
    const result = await window.kt.pickBlofinCredentialFile();
    if (result.cancelled) return;
    if (!result.ok) {
      setBlofinTestStatus(`✗ ${result.error || 'Could not load file'}`, 'error');
      return;
    }
    applyBlofinFromFile(result.blofin);
    setCredFilePath(el.blofinFilePath, result.path);
  } catch (e) {
    setBlofinTestStatus(`✗ ${e.message}`, 'error');
  } finally {
    el.btnLoadBlofinFile.disabled = false;
  }
});

el.btnTestNous.addEventListener('click', async () => {
  const apiKey = el.nousApiKey.value.trim();
  const model = el.nousModel.value;
  if (!apiKey || !model) return;

  el.btnTestNous.disabled = true;
  setNousTestStatus('Testing…', 'pending');
  try {
    const result = await window.kt.testNousCredentials({ apiKey, model });
    if (result.ok) {
      const preview = result.reply ? ` — "${result.reply.slice(0, 60)}"` : '';
      setNousTestStatus(`✓ Connected to ${result.model}${preview}`, 'ok');
    } else {
      setNousTestStatus(`✗ ${result.error || 'Test failed'}`, 'error');
    }
  } catch (e) {
    setNousTestStatus(`✗ ${e.message}`, 'error');
  } finally {
    updateNousTestButton();
  }
});

function bindBlofinTestInputs() {
  const reset = () => {
    updateBlofinTestButton();
    setBlofinTestStatus('', '');
  };
  el.blofinApiKey.addEventListener('input', reset);
  el.blofinSecretKey.addEventListener('input', reset);
  el.blofinPassphrase.addEventListener('input', reset);
  if (el.blofinDemoMode) el.blofinDemoMode.addEventListener('change', reset);
}
bindBlofinTestInputs();

el.btnTestBlofin.addEventListener('click', async () => {
  const creds = {
    apiKey: el.blofinApiKey.value.trim(),
    secretKey: el.blofinSecretKey.value.trim(),
    passphrase: el.blofinPassphrase.value.trim(),
    privateKey: el.polyPrivateKey ? el.polyPrivateKey.value.trim() : '',
    demoMode: !!(el.blofinDemoMode && el.blofinDemoMode.checked),
  };
  if (!creds.apiKey || !creds.secretKey || !creds.passphrase || !creds.privateKey) return;

  el.btnTestBlofin.disabled = true;
  setBlofinTestStatus('Testing…', 'pending');
  try {
    const result = await window.kt.testBlofinCredentials(creds);
    if (result.ok) {
      setBlofinTestStatus(`✓ ${result.mode} connected — ${result.summary}`, 'ok');
    } else {
      setBlofinTestStatus(`✗ ${result.error || 'Test failed'}`, 'error');
    }
  } catch (e) {
    setBlofinTestStatus(`✗ ${e.message}`, 'error');
  } finally {
    updateBlofinTestButton();
  }
});

// Defender exclusion (Step 0)
const btnAddExclusion    = $('btn-add-exclusion');
const exclusionStatus    = $('exclusion-status');
const exclusionManual    = $('exclusion-manual');
const exclusionPathDisp  = $('exclusion-path-display');

btnAddExclusion.addEventListener('click', async () => {
  btnAddExclusion.disabled = true;
  exclusionStatus.textContent = '⏳ Adding exclusion… (approve the UAC prompt)';
  exclusionStatus.style.color = 'var(--accent)';
  const res = await window.kt.addDefenderExclusion();
  if (res.ok) {
    exclusionStatus.textContent = '✅ Exclusion added — now safe to install';
    exclusionStatus.style.color = 'var(--good)';
  } else {
    exclusionStatus.textContent = '⚠ Failed — add manually (see below)';
    exclusionStatus.style.color = 'var(--warn)';
    exclusionManual.classList.remove('hidden');
    if (res.manual && exclusionPathDisp) exclusionPathDisp.textContent = res.manual;
    btnAddExclusion.disabled = false;
  }
});

// Hermes install
el.btnInstallHermes.addEventListener('click', async () => {
  el.btnInstallHermes.disabled = true;
  el.hermesInstallStatus.textContent = '⏳ Installing Hermes, then starting dashboard…';
  el.hermesInstallStatus.style.color = 'var(--accent)';
  switchTab('logs');
  const result = await window.kt.installHermes();
  if (result.ok) {
    hermesInstalled = true;
    el.hermesInstallStatus.textContent = '✓ Installed: ' + result.version;
    el.hermesInstallStatus.style.color = 'var(--good)';
    el.hermesNavBadge.classList.add('hidden');
    el.btnInstallHermes.textContent = '✓ Already Installed';
    try {
      const ds = await window.kt.getDashboardStatus();
      if (ds.running || ds.ready) {
        setDashboardState(!!ds.running, !!ds.ready, !!ds.gatewayRunning);
        if (ds.ready) loadDashboard(ds.url || 'http://127.0.0.1:9219');
      }
    } catch (e) {}
  } else if (result.partial) {
    el.hermesInstallStatus.textContent = '⚠ Partial install — click Install to resume (see Logs)';
    el.hermesInstallStatus.style.color = 'var(--warn)';
    el.btnInstallHermes.textContent = 'Resume Hermes Install';
    el.btnInstallHermes.disabled = false;
  } else {
    el.hermesInstallStatus.textContent = '✗ Install failed — check Logs tab';
    el.hermesInstallStatus.style.color = 'var(--error)';
    el.btnInstallHermes.disabled = false;
  }
});

// Write compendium
el.btnWriteCompendium.addEventListener('click', async () => {
  const res = await window.kt.writeCompendium();
  if (res.ok) {
    el.compendiumStatus.textContent = '✓ Written to: ' + res.path;
    el.compendiumStatus.classList.remove('hidden');
    el.compendiumStatus.style.color = 'var(--good)';
  } else {
    el.compendiumStatus.textContent = '✗ ' + res.error;
    el.compendiumStatus.classList.remove('hidden');
    el.compendiumStatus.style.color = 'var(--error)';
  }
});

// Start / stop dashboard
el.btnStartDashboard.addEventListener('click', () => startHermesDashboardUi());

el.btnStopDashboard.addEventListener('click', async () => {
  await window.kt.stopDashboard();
  setDashboardState(false, false);
});

// Configure cron
el.btnConfigureCron.addEventListener('click', async () => {
  el.btnConfigureCron.disabled = true;
  el.cronStatus.textContent = '⏳ Configuring…';
  el.cronStatus.style.color = 'var(--accent)';
  const result = await window.kt.configureCron();
  if (result.ok) {
    el.cronStatus.textContent = result.updated
      ? '✅ Cron updated — every 5 minutes!'
      : '✅ Cron active — every 5 minutes!';
    el.cronStatus.style.color = 'var(--good)';
    el.manualPromptWrap.classList.add('hidden');
  } else {
    el.cronStatus.textContent = result.msg ? `⚠ ${result.msg}` : '⚠ Manual setup needed';
    el.cronStatus.style.color = 'var(--warn)';
    const prompt = result.prompt || await window.kt.getCronPrompt();
    el.cronPromptText.textContent = prompt;
    el.manualPromptWrap.classList.remove('hidden');
    el.btnConfigureCron.disabled = false;
  }
});

// Copy prompt
el.btnCopyPrompt.addEventListener('click', () => {
  navigator.clipboard.writeText(el.cronPromptText.textContent).then(() => {
    el.btnCopyPrompt.textContent = '✓ Copied!';
    setTimeout(() => el.btnCopyPrompt.textContent = 'Copy Prompt', 2000);
  });
});

// Dashboard controls
el.btnReloadDash.addEventListener('click', () => { el.hermesWebview.reload(); });
el.btnOpenDashExternal.addEventListener('click', () => window.kt.openExternal('http://127.0.0.1:9219'));

// Autoscroll toggle
el.btnAutoscroll.addEventListener('click', () => {
  autoScroll = !autoScroll;
  el.btnAutoscroll.classList.toggle('active', autoScroll);
});

// Clear logs
el.btnClearLogs.addEventListener('click', async () => {
  await window.kt.clearLogs();
  el.logList.innerHTML = '';
  el.logEmpty.style.display = '';
});

// Log scroll pause
el.logContainer.addEventListener('scroll', () => {
  const atBottom = el.logContainer.scrollHeight - el.logContainer.scrollTop <= el.logContainer.clientHeight + 40;
  if (!atBottom && autoScroll) { autoScroll = false; el.btnAutoscroll.classList.remove('active'); }
});

// Quick links
const NOUS_PORTAL_URL = 'https://portal.nousresearch.com/manage-subscription';

const LINKS = {
  'link-blofin-dashboard': 'https://polymarket.com',
  'link-blofin-api-page': 'https://docs.polymarket.com',
  'link-nous-portal-settings': NOUS_PORTAL_URL,
  'link-hermes-dashboard': 'http://127.0.0.1:9219',
  'link-hermes-docs': 'https://hermes-agent.nousresearch.com/docs/integrations/nous-portal',
  'link-nous-portal': NOUS_PORTAL_URL,
  'link-blofin-api': 'https://docs.polymarket.com',
  'btn-open-blofin': 'https://polymarket.com'
};
Object.entries(LINKS).forEach(([id, url]) => {
  const elem = document.getElementById(id);
  if (elem) elem.addEventListener('click', (e) => { e.preventDefault(); window.kt.openExternal(url); });
});

// ── Update banner ───────────────────────────────────────────────
function setUpdateBannerVisible(visible, title, text) {
  if (!el.updateBanner) return;
  el.updateBanner.classList.toggle('hidden', !visible);
  if (title && el.updateBannerTitle) el.updateBannerTitle.textContent = title;
  if (text && el.updateBannerText) el.updateBannerText.textContent = text;
}

if (el.btnRestartUpdate) {
  el.btnRestartUpdate.addEventListener('click', async () => {
    el.btnRestartUpdate.disabled = true;
    setUpdateBannerVisible(true, 'Installing update', 'Downloading if needed, then restarting…');
    setPopupUpdateStatus('Installing update…');
    try {
      const res = await window.kt.quitAndInstallUpdate();
      if (res?.ok && res?.installing) return;
      const err = res?.error || 'Update could not be installed';
      setUpdateBannerVisible(true, 'Update failed', err);
      setPopupUpdateStatus(err);
      el.btnRestartUpdate.disabled = false;
    } catch (e) {
      const err = e?.message || 'Update failed';
      setUpdateBannerVisible(true, 'Update failed', err);
      setPopupUpdateStatus(err);
      el.btnRestartUpdate.disabled = false;
    }
  });
}
if (el.btnDismissUpdate) {
  el.btnDismissUpdate.addEventListener('click', () => {
    setUpdateBannerVisible(false);
  });
}

window.kt.onUpdateAvailable((info) => {
  setUpdateBannerVisible(true, 'Update available', 'Restart to install the latest version.');
  setPopupUpdateStatus('Update available — restart to install');
});
window.kt.onUpdateNotAvailable((info) => {
  const remote = info?.remoteVersion || info?.version || '';
  const current = cachedAppVersion || info?.version || '';
  if (remote && current && remote !== current) {
    setPopupUpdateStatus(`Update ${remote} available — restart to install`);
    setUpdateBannerVisible(true, 'Update available', `Version ${remote} is ready — click Restart & Update.`);
    return;
  }
  setPopupUpdateStatus(`Up to date (${current || 'latest'})`);
});
window.kt.onUpdateDownloaded((info) => {
  setUpdateBannerVisible(true, 'Update ready', 'Restart to apply the latest version.');
  setPopupUpdateStatus('Update ready — restart to install');
});
window.kt.onUpdateError((error) => {
  let raw = '';
  if (error && typeof error === 'object') {
    raw = error.message || error.error || JSON.stringify(error);
  } else if (typeof error === 'string') {
    raw = error;
  } else if (error != null) {
    raw = String(error);
  }
  // electron-updater errors sometimes carry the entire response body of a
  // failed feed fetch (an HTML 404 / Cloudflare page) as the message string.
  // Pushing that into the menu made the whole popup render as raw HTML
  // ("gobbledygook"). Collapse any HTML-ish / oversized payload to a short,
  // human-readable status and log the full detail to the console instead.
  let msg = String(raw || 'Update failed');
  const looksLikeHtml = /^\s*<(!doctype|html|head|body|h1|p|br|center)/i.test(msg)
    || /<!DOCTYPE/i.test(msg)
    || /<html/i.test(msg);
  if (looksLikeHtml) {
    msg = 'Update check failed — check connection';
  } else if (msg.length > 80) {
    msg = msg.slice(0, 77) + '…';
  }
  console.error('[update] error:', raw);
  setPopupUpdateStatus(msg);
});

// ── Update popup menu ───────────────────────────────────────────
//
// The bottom-left menu (#popup-menu) is rendered once on first show and
// then left alone. The previous implementation rebuilt the menu's
// innerHTML on every open, which detached the cached
// el.btnCheckForUpdates / el.popupUpdateStatus / el.popupAppVersion
// references and made the "Check for updates" button visually dead.
// We now use event delegation on #popup-menu and re-query the live
// status elements on every update so they always land on the visible
// node.

const POPUP_MENU_BUILT = { value: false };
const DEFAULT_UPDATE_STATUS = 'Updates are automatic';

function buildPopupMenu() {
  if (!el.popupMenu || POPUP_MENU_BUILT.value) return;
  // Render once. Subsequent opens will refresh the status text only.
  const currentVersion = cachedAppVersion || '';
  const initialStatus = DEFAULT_UPDATE_STATUS;
  el.popupMenu.innerHTML = `
    <button id="btn-check-for-updates" class="popup-menu-item" role="menuitem" type="button">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      <span>Check for updates</span>
    </button>
    <div class="popup-separator"></div>
    <div class="popup-menu-item popup-menu-item-disabled" aria-disabled="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      <span>KnightTrader Poly</span>
    </div>
    <div class="popup-menu-item popup-menu-item-disabled" aria-disabled="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
      <span>v<span id="popup-app-version">${currentVersion || '1.2.1'}</span></span>
    </div>
    <div class="popup-menu-item popup-menu-item-disabled" aria-disabled="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <span id="popup-update-status">${initialStatus}</span>
    </div>
  `;
  // Re-resolve cached references to the live (now populated) DOM nodes.
  el.btnCheckForUpdates = el.popupMenu.querySelector('#btn-check-for-updates');
  el.popupUpdateStatus = el.popupMenu.querySelector('#popup-update-status');
  el.popupAppVersion = el.popupMenu.querySelector('#popup-app-version');
  POPUP_MENU_BUILT.value = true;
}

function setPopupUpdateStatus(text) {
  const node = el.popupMenu?.querySelector('#popup-update-status') || el.popupUpdateStatus;
  if (node) node.textContent = text;
}

function setPopupUpdateButtonDisabled(disabled) {
  const node = el.popupMenu?.querySelector('#btn-check-for-updates') || el.btnCheckForUpdates;
  if (node) node.disabled = !!disabled;
}

function setPopupOpen(open) {
  if (!el.popupLauncher || !el.popupMenu) return;
  if (open) {
    if (el.hermesWebview) el.hermesWebview.classList.add('webview-parked');
    if (el.tradingWebview) el.tradingWebview.classList.add('webview-parked');
  } else {
    try { syncWebviewParking(currentTab); } catch (_) {}
  }

  const show = () => {
    el.popupMenu.classList.toggle('hidden', false);
    if (el.btnPopupTrigger) el.btnPopupTrigger.setAttribute('aria-expanded', 'true');
    if (!POPUP_MENU_BUILT.value) buildPopupMenu();
  };
  const hide = () => {
    el.popupMenu.classList.toggle('hidden', true);
    if (el.btnPopupTrigger) el.btnPopupTrigger.setAttribute('aria-expanded', 'false');
  };

  if (open) {
    hide();
    if (requestAnimationFrame) requestAnimationFrame(() => requestAnimationFrame(show));
    else show();
  } else {
    hide();
  }
}

function togglePopupMenu() {
  if (!el.popupLauncher || !el.popupMenu) return;
  const isHidden = el.popupMenu.classList.contains('hidden');
  setPopupOpen(isHidden);
}

if (el.btnPopupTrigger) {
  el.btnPopupTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePopupMenu();
  });
}

if (el.popupLauncher) {
  el.popupLauncher.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

// Single delegated listener for any click inside the menu. Survives any
// future menu-content refresh because the parent element never changes.
if (el.popupMenu) {
  el.popupMenu.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest('#btn-check-for-updates');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      checkForUpdatesFromMenu();
    }
  });
}

document.addEventListener('click', (e) => {
  if (!el.popupMenu?.classList.contains('hidden')) {
    const inside = el.popupLauncher?.contains(e.target);
    if (!inside) setPopupOpen(false);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.popupMenu && !el.popupMenu.classList.contains('hidden')) {
    setPopupOpen(false);
  }
});

async function checkForUpdatesFromMenu() {
  setPopupUpdateStatus('Checking for updates…');
  setPopupUpdateButtonDisabled(true);
  try {
    const res = await window.kt.checkForUpdates();
    if (res?.updateAvailable) {
      const remote = res.remoteVersion || res.version || 'latest';
      setPopupUpdateStatus(res.downloaded ? `Update ${remote} ready — restart` : `Update ${remote} downloading…`);
      setUpdateBannerVisible(true, 'Update available', res.downloaded
        ? 'Restart to apply the latest version.'
        : 'Downloading update — restart when ready.');
    } else if (res?.error) {
      setPopupUpdateStatus(String(res.error).slice(0, 80));
    } else if (res?.packaged === false) {
      setPopupUpdateStatus('Dev mode — updates apply to installed app only');
    } else {
      setPopupUpdateStatus(`Up to date (${res?.version || cachedAppVersion || 'latest'})`);
    }
  } catch (e) {
    setPopupUpdateStatus(e?.message || 'Update check failed');
  } finally {
    setPopupUpdateButtonDisabled(false);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
// init() is defined above but was never invoked, so nothing on the app
// actually initialized on launch (no model dropdown population, no version
// label, no Hermes auto-connect, no log streaming). Fire it as soon as the
// DOM is ready and the preload bridge is exposed.
function bootInit() {
  init().catch((e) => console.error('[boot] init() failed:', e));
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootInit);
} else {
  bootInit();
}
