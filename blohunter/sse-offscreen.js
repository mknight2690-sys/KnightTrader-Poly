const { openSse } = require('./node-https');

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;
const HEARTBEAT_TIMEOUT_MS = 60000;
const DISCONNECT_NOTIFY_DELAY_MS = 5000;

const EVENT_TYPES = new Set([
  'policy',
  'capabilities',
  'snapshot',
  'trade-opened',
  'trade-dca',
  'trade-risk-adjustment',
  'trade-state',
  'trade-closed',
  'resync-required',
  'heartbeat',
]);

function computeNextReconnectDelay(current) {
  return Math.min(current * RECONNECT_BACKOFF_MULTIPLIER, MAX_RECONNECT_DELAY_MS);
}

function handshakeEndpoint(endpoint) {
  try {
    const url = new URL(String(endpoint || ''));
    url.searchParams.delete('lastEventId');
    return url.toString();
  } catch {
    return String(endpoint || '').replace(/([?&])lastEventId=[^&]*&?/, '$1').replace(/[?&]$/, '');
  }
}

function createSseOffscreen({ sendToBackground, readGatewaySseConfig, log = () => {} }) {
  let stream = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let disconnectNotifyTimer = null;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let connected = false;
  let activeConfig = null;
  let running = false;

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearHeartbeatTimer() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function resetHeartbeatTimer() {
    clearHeartbeatTimer();
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      scheduleReconnect('heartbeat-timeout');
    }, HEARTBEAT_TIMEOUT_MS);
  }

  function notifyDisconnected() {
    sendToBackground({
      source: 'blohunter-offscreen',
      type: 'sse-status',
      connected: false,
      gatewaySseVersion: activeConfig?.version || 'v3',
      endpoint: activeConfig?.endpoint || '',
      v3ReplayCursor: null,
    }).catch(() => {});
  }

  function scheduleReconnect(reason) {
    if (!running || reconnectTimer) return;
    connected = false;
    if (!disconnectNotifyTimer) {
      disconnectNotifyTimer = setTimeout(() => {
        disconnectNotifyTimer = null;
        notifyDisconnected();
      }, DISCONNECT_NOTIFY_DELAY_MS);
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      log('[SSE] reconnect:', reason, reconnectDelayMs);
      start(`reconnect:${reason}`).catch((err) => log('[SSE] reconnect failed:', err.message));
    }, reconnectDelayMs);
    reconnectDelayMs = computeNextReconnectDelay(reconnectDelayMs);
  }

  function closeStream() {
    if (!stream) return;
    try { stream.close(); } catch {}
    stream = null;
  }

  async function start(reason = 'connect') {
    if (!running) running = true;
    clearReconnectTimer();
    clearHeartbeatTimer();
    if (disconnectNotifyTimer) {
      clearTimeout(disconnectNotifyTimer);
      disconnectNotifyTimer = null;
    }
    closeStream();

    let config;
    try {
      config = await readGatewaySseConfig();
    } catch (err) {
      log('[SSE] config read failed:', err.message);
      scheduleReconnect('config-failed');
      return;
    }
    if (!config?.endpoint) {
      log('[SSE] no endpoint configured');
      scheduleReconnect('no-endpoint');
      return;
    }

    const endpoint = handshakeEndpoint(config.endpoint);
    activeConfig = { ...config, endpoint };
    log('[SSE] connecting', endpoint, reason);

    stream = openSse(endpoint, {
      onOpen: () => {
        connected = true;
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        resetHeartbeatTimer();
        sendToBackground({
          source: 'blohunter-offscreen',
          type: 'sse-status',
          connected: true,
          gatewaySseVersion: activeConfig.version || 'v3',
          endpoint,
          v3ReplayCursor: null,
        }).catch(() => {});
      },
      onEvent: ({ eventName, id, data }) => {
        resetHeartbeatTimer();
        const type = EVENT_TYPES.has(eventName) ? eventName : '';
        if (!type) return;
        let parsed = {};
        if (data) {
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            log('[SSE] parse error', type, err.message);
            return;
          }
        }
        sendToBackground({
          source: 'blohunter-offscreen',
          type: 'sse-event',
          eventType: type,
          data: parsed,
          lastEventId: '',
          gatewaySseVersion: activeConfig.version || 'v3',
          endpoint,
          v3ReplayCursor: null,
        }).catch(() => {});
      },
      onError: (err) => {
        log('[SSE] stream error:', err?.message || err);
        scheduleReconnect(err?.message || 'stream-error');
      },
    });
  }

  async function restart(reason = 'manual-restart') {
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    closeStream();
    return start(reason);
  }

  function stop() {
    running = false;
    clearReconnectTimer();
    clearHeartbeatTimer();
    if (disconnectNotifyTimer) {
      clearTimeout(disconnectNotifyTimer);
      disconnectNotifyTimer = null;
    }
    closeStream();
    connected = false;
  }

  return { start, restart, stop, isConnected: () => connected };
}

module.exports = { createSseOffscreen };
