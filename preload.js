const { contextBridge, ipcRenderer } = require('electron');
if (process.env && process.env.KT_DEBUG_PRELOAD) {
  console.log('[kt-preload] bridging kt api');
}
contextBridge.exposeInMainWorld('kt', {
  // Credentials
  getCredentials: () => ipcRenderer.invoke('get-credentials'),
  saveCredentials: (data) => ipcRenderer.invoke('save-credentials', data),
  writeCompendium: () => ipcRenderer.invoke('write-compendium'),
  getCompendiumPath: () => ipcRenderer.invoke('get-compendium-path'),
  getHermesHome: () => ipcRenderer.invoke('get-hermes-home'),
  testNousCredentials: (data) => ipcRenderer.invoke('test-nous-credentials', data),
  getNousModels: () => ipcRenderer.invoke('get-nous-models'),
  testBlofinCredentials: (data) => ipcRenderer.invoke('test-blofin-credentials', data),
  pickNousCredentialFile: () => ipcRenderer.invoke('pick-nous-credential-file'),
  pickBlofinCredentialFile: () => ipcRenderer.invoke('pick-blofin-credential-file'),

  // Hermes management
  checkHermes: () => ipcRenderer.invoke('check-hermes'),
  installHermes: () => ipcRenderer.invoke('install-hermes'),
  addDefenderExclusion: () => ipcRenderer.invoke('add-defender-exclusion'),
  startDashboard: () => ipcRenderer.invoke('start-dashboard'),
  stopDashboard: () => ipcRenderer.invoke('stop-dashboard'),
  getDashboardStatus: () => ipcRenderer.invoke('get-dashboard-status'),
  configureCron: () => ipcRenderer.invoke('configure-cron'),
  getCronPrompt: () => ipcRenderer.invoke('get-cron-prompt'),

  // Logs
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),

  // Live events from main process
  onLogLine: (cb) => ipcRenderer.on('log-line', (_e, entry) => cb(entry)),
  onDashboardReady: (cb) => ipcRenderer.on('dashboard-ready', (_e, d) => cb(d)),
  onDashboardStopped: (cb) => ipcRenderer.on('dashboard-stopped', (_e, d) => cb(d)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, info) => cb(info)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', (_, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_, info) => cb(info)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_, error) => cb(error)),
  // Window restore from tray/taskbar (single debounced channel)
  onWindowShown: (cb) => ipcRenderer.on('kt-window-shown', () => cb()),
  unthrottleWebview: (webContentsId) => ipcRenderer.invoke('unthrottle-webview', webContentsId),
  // Free-model auto-selection
  onFreeModelSelected: (cb) => ipcRenderer.on('kt-free-model-selected', (_e, info) => cb(info)),
  autoSelectFreeModel: () => ipcRenderer.invoke('auto-select-free-model'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  quitAndInstallUpdate: () => ipcRenderer.invoke('quit-and-install-update'),

  // Utilities
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  announceVoice: (text) => ipcRenderer.invoke('announce-voice', text),

  // Trading / BloHunter
  getBlohunterPreloadPath: () => ipcRenderer.invoke('get-blohunter-preload-path'),
  startTradingDashboard: () => ipcRenderer.invoke('start-trading-dashboard'),
  stopTradingDashboard: () => ipcRenderer.invoke('stop-trading-dashboard'),
  getTradingStatus: () => ipcRenderer.invoke('get-trading-status'),
  attachTradingWebview: (webContentsId) => ipcRenderer.invoke('attach-trading-webview', webContentsId),

  
  // KnightTrader BloFin System
  startTradingSystem: () => ipcRenderer.invoke('start-trading-system'),
  stopTradingSystem: () => ipcRenderer.invoke('stop-trading-system'),
  getTradingSystemStatus: () => ipcRenderer.invoke('get-trading-system-status'),
  getTradingSystemTelemetry: () => ipcRenderer.invoke('get-trading-system-telemetry'),
  onTradingSystemTelemetry: (cb) => ipcRenderer.on('trading-system-telemetry', (_e, data) => cb(data)),

  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // VPN controller
  vpnStatus: () => ipcRenderer.invoke('vpn-status'),
  vpnDetect: () => ipcRenderer.invoke('vpn-detect'),
  vpnConnect: (code) => ipcRenderer.invoke('vpn-connect', code),
  vpnDisconnect: () => ipcRenderer.invoke('vpn-disconnect'),
  vpnAllowed: () => ipcRenderer.invoke('vpn-allowed')
});
