const nodeCrypto = require('crypto');

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(value);
}

function algorithmName(algorithm) {
  if (!algorithm) return '';
  if (typeof algorithm === 'string') return algorithm;
  return String(algorithm.name || '');
}

function ensureSubtle() {
  if (!globalThis.crypto && nodeCrypto.webcrypto) {
    globalThis.crypto = nodeCrypto.webcrypto;
  }
  if (globalThis.crypto && !globalThis.crypto.subtle && nodeCrypto.webcrypto?.subtle) {
    globalThis.crypto = nodeCrypto.webcrypto;
  }
  if (typeof global !== 'undefined' && globalThis.crypto) {
    global.crypto = globalThis.crypto;
  }
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  throw new Error('WebCrypto subtle is unavailable; cannot polyfill Ed25519');
}

function installEd25519Subtle() {
  const subtle = ensureSubtle();
  if (subtle.__ktEd25519) return subtle;

  const originalImportKey = subtle.importKey.bind(subtle);
  const originalVerify = subtle.verify.bind(subtle);
  const nodeKeys = new WeakMap();

  subtle.importKey = async function importKey(format, keyData, algorithm, extractable, keyUsages) {
    const name = algorithmName(algorithm);
    if (name === 'Ed25519') {
      try {
        return await originalImportKey(format, keyData, algorithm, extractable, keyUsages);
      } catch (err) {
        if (String(format).toLowerCase() !== 'spki') throw err;
        const key = nodeCrypto.createPublicKey({
          key: toBuffer(keyData),
          format: 'der',
          type: 'spki',
        });
        const handle = {
          type: 'public',
          extractable: !!extractable,
          algorithm: { name: 'Ed25519' },
          usages: keyUsages || ['verify'],
        };
        nodeKeys.set(handle, key);
        return handle;
      }
    }
    return originalImportKey(format, keyData, algorithm, extractable, keyUsages);
  };

  subtle.verify = async function verify(algorithm, key, signature, data) {
    const name = algorithmName(algorithm);
    if (name === 'Ed25519' && nodeKeys.has(key)) {
      return nodeCrypto.verify(null, toBuffer(data), nodeKeys.get(key), toBuffer(signature));
    }
    try {
      return await originalVerify(algorithm, key, signature, data);
    } catch (err) {
      if (name !== 'Ed25519') throw err;
      const keyObj = nodeKeys.get(key);
      if (!keyObj) throw err;
      return nodeCrypto.verify(null, toBuffer(data), keyObj, toBuffer(signature));
    }
  };

  subtle.__ktEd25519 = true;
  return subtle;
}

module.exports = { installEd25519Subtle };
