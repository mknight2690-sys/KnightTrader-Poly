const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const PERSIST_DEBOUNCE_MS = 400;

// The desk file holds ~2 MB of equity history / forensics. Reading or writing
// it synchronously costs ~30 ms of main-process time, and the desk hammers
// storage when it wakes from the tray. Memory is the source of truth (only
// this process owns the file); disk writes are coalesced and async.
class BlohunterStorage extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.local = {};
    this.session = {};
    this.loaded = false;
    this.persistTimer = null;
    this.writing = false;
    this.dirty = false;
  }

  load({ force = false } = {}) {
    if (this.loaded && !force) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.local = raw.local && typeof raw.local === 'object' ? raw.local : {};
        this.session = raw.session && typeof raw.session === 'object' ? raw.session : {};
      }
    } catch {
      this.local = {};
      this.session = {};
    }
    this.loaded = true;
  }

  serialize() {
    return JSON.stringify({ local: this.local, session: this.session }, null, 0);
  }

  persist() {
    if (!this.loaded) return;
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writeAsync().catch(() => {});
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  async writeAsync() {
    if (this.writing || !this.dirty) return;
    this.writing = true;
    this.dirty = false;
    const tmpPath = `${this.filePath}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.writeFile(tmpPath, this.serialize(), 'utf8');
      await fs.promises.rename(tmpPath, this.filePath);
    } catch {
      this.dirty = true;
    } finally {
      this.writing = false;
    }
    if (this.dirty) this.persist();
  }

  flushSync() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.loaded || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, this.serialize(), 'utf8');
      this.dirty = false;
    } catch {
      // Best effort on shutdown.
    }
  }

  discardPending() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = false;
    this.loaded = false;
  }

  normalizeKeys(keys) {
    if (keys == null) return null;
    if (Array.isArray(keys)) return keys;
    if (typeof keys === 'string') return [keys];
    if (typeof keys === 'object') return Object.keys(keys);
    return null;
  }

  pick(area, keys) {
    const store = area === 'session' ? this.session : this.local;
    const keyList = this.normalizeKeys(keys);
    if (!keyList) return { ...store };
    const out = {};
    for (const key of keyList) {
      if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
    }
    if (typeof keys === 'object' && keys !== null && !Array.isArray(keys)) {
      for (const key of Object.keys(keys)) {
        if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = keys[key];
      }
    }
    return out;
  }

  setArea(area, items = {}) {
    const store = area === 'session' ? this.session : this.local;
    const changes = {};
    for (const [key, value] of Object.entries(items)) {
      const oldValue = store[key];
      store[key] = value;
      changes[key] = { oldValue, newValue: value };
    }
    this.persist();
    if (Object.keys(changes).length > 0) {
      this.emit('changed', changes, area);
    }
    return changes;
  }

  removeArea(area, keys) {
    const store = area === 'session' ? this.session : this.local;
    const keyList = this.normalizeKeys(keys) || [];
    const changes = {};
    for (const key of keyList) {
      if (Object.prototype.hasOwnProperty.call(store, key)) {
        changes[key] = { oldValue: store[key], newValue: undefined };
        delete store[key];
      }
    }
    this.persist();
    if (Object.keys(changes).length > 0) {
      this.emit('changed', changes, area);
    }
  }
}

module.exports = { BlohunterStorage };
