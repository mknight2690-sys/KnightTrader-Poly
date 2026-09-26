(function installKnightTraderChrome() {
  var bridge = window.__ktChrome;
  if (!bridge || !bridge.runtime || !bridge.storage) {
    console.error('[KnightTrader] Trading chrome bridge missing — BloFin desk cannot load');
    return;
  }

  var existing = (typeof window.chrome === 'object' && window.chrome) ? window.chrome : {};
  var next = {};
  try {
    for (var key in existing) {
      if (Object.prototype.hasOwnProperty.call(existing, key)) next[key] = existing[key];
    }
  } catch (_) {}

  next.runtime = Object.assign({}, existing.runtime || {}, bridge.runtime);
  next.storage = bridge.storage;

  function assignChrome(value) {
    try {
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: value,
      });
      return true;
    } catch (_) {}
    try {
      window.chrome = value;
      return window.chrome === value;
    } catch (_) {}
    return false;
  }

  if (!assignChrome(next)) {
    try { existing.runtime = next.runtime; } catch (_) {}
    try { existing.storage = next.storage; } catch (_) {}
  }

  if (!window.chrome || !window.chrome.runtime || typeof window.chrome.runtime.sendMessage !== 'function') {
    console.error('[KnightTrader] Failed to install chrome.runtime.sendMessage');
  }
})();
