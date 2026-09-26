const { contextBridge, ipcRenderer } = require('electron');

function createEmitter() {
  const listeners = new Set();
  return {
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    hasListener(fn) { return listeners.has(fn); },
    _emit(...args) {
      for (const fn of listeners) {
        try { fn(...args); } catch (err) { console.error('[blohunter-preload] listener error:', err); }
      }
    },
  };
}

function withCallback(promise, callback) {
  if (typeof callback === 'function') {
    Promise.resolve(promise)
      .then((value) => {
        try { callback(value); } catch (_) {}
      })
      .catch(() => {
        try { callback(undefined); } catch (_) {}
      });
    return undefined;
  }
  return promise;
}

const storageLocalOnChanged = createEmitter();
const runtimeOnMessage = createEmitter();

ipcRenderer.on('bh-storage-changed', (_event, changes, area) => {
  if (area === 'local' || area === 'session') {
    storageLocalOnChanged._emit(changes, area);
  }
});

ipcRenderer.on('bh-runtime-message', (_event, msg) => {
  runtimeOnMessage._emit(msg, { id: 'knight-trader-main' }, () => {});
});

function sendRuntimeMessage(message) {
  return ipcRenderer.invoke('bh-runtime-send', message);
}

const chromeApi = {
  runtime: {
    id: 'knight-trader-blohunter-dashboard',
    lastError: null,
    sendMessage: (messageOrId, maybeMessage, maybeCallback) => {
      // Extension shapes: sendMessage(msg), sendMessage(msg, cb), sendMessage(extId, msg, cb)
      let message = messageOrId;
      let callback = maybeCallback;
      if (typeof maybeMessage === 'function') {
        callback = maybeMessage;
      } else if (maybeMessage != null && typeof maybeMessage === 'object') {
        message = maybeMessage;
      }
      return withCallback(sendRuntimeMessage(message), callback);
    },
    onMessage: runtimeOnMessage,
    getURL: (relativePath) => {
      const rel = String(relativePath || '').replace(/^\/+/, '');
      if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
        return `${location.origin}/${rel}`;
      }
      return `bh://local/${rel}`;
    },
  },
  storage: {
    local: {
      get: (keys, callback) => withCallback(ipcRenderer.invoke('bh-storage-get', keys), callback),
      set: (items, callback) => withCallback(
        ipcRenderer.invoke('bh-storage-set', items).then(() => undefined),
        callback,
      ),
      remove: (keys, callback) => withCallback(
        ipcRenderer.invoke('bh-storage-remove', keys).then(() => undefined),
        callback,
      ),
    },
    session: {
      get: (keys, callback) => withCallback(ipcRenderer.invoke('bh-storage-get-session', keys), callback),
      set: (items, callback) => withCallback(
        ipcRenderer.invoke('bh-storage-set-session', items).then(() => undefined),
        callback,
      ),
      remove: (keys, callback) => withCallback(
        ipcRenderer.invoke('bh-storage-remove-session', keys).then(() => undefined),
        callback,
      ),
    },
    onChanged: storageLocalOnChanged,
  },
};

// Always expose under a unique name — Electron/Chromium often owns a non-writable window.chrome.
contextBridge.exposeInMainWorld('__ktChrome', chromeApi);
try {
  contextBridge.exposeInMainWorld('chrome', chromeApi);
} catch (_) {
  // Expected when Chromium already defined a non-configurable chrome object.
}
