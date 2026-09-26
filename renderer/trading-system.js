/* KnightTrader BloFin System - renderer module
   Manages Python trading engine + dashboard server lifecycle
*/

let tradingSystemProcess = null;
let dashboardProcess = null;
let tradingSystemStarted = false;
let telemetryInterval = null;
let telemetryCallback = null;

async function startTradingSystem() {
  try {
    const result = await window.kt.startTradingSystem();
    if (result?.ok) {
      tradingSystemStarted = true;
      tradingSystemProcess = result.pid;
      dashboardProcess = result.dashboardPid;
      startTelemetryPolling();
    }
    return result;
  } catch (e) {
    console.error('[trading-system] start failed:', e);
    return { ok: false, error: e.message };
  }
}

async function stopTradingSystem() {
  try {
    const result = await window.kt.stopTradingSystem();
    tradingSystemStarted = false;
    tradingSystemProcess = null;
    dashboardProcess = null;
    stopTelemetryPolling();
    return result;
  } catch (e) {
    console.error('[trading-system] stop failed:', e);
    return { ok: false, error: e.message };
  }
}

async function getTradingSystemStatus() {
  try {
    return await window.kt.getTradingSystemStatus();
  } catch (e) {
    return { running: false, engine: false, dashboard: false, error: e.message };
  }
}

async function getTradingSystemTelemetry() {
  try {
    return await window.kt.getTradingSystemTelemetry();
  } catch (e) {
    return null;
  }
}

function setTelemetryCallback(cb) {
  telemetryCallback = cb;
}

function startTelemetryPolling() {
  stopTelemetryPolling();
  telemetryInterval = setInterval(async () => {
    try {
      const tel = await getTradingSystemTelemetry();
      if (tel && telemetryCallback) {
        telemetryCallback(tel);
      }
    } catch (_) {}
  }, 2000);
}

function stopTelemetryPolling() {
  if (telemetryInterval) {
    clearInterval(telemetryInterval);
    telemetryInterval = null;
  }
}

function isTradingSystemStarted() {
  return tradingSystemStarted;
}

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  stopTelemetryPolling();
});

// Expose for app.js
window.tradingSystem = {
  startTradingSystem,
  stopTradingSystem,
  getTradingSystemStatus,
  getTradingSystemTelemetry,
  setTelemetryCallback,
  startTelemetryPolling,
  stopTelemetryPolling,
  isTradingSystemStarted,
};
