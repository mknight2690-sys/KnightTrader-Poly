// Force-update modal logic. Loaded via the standard preload, so window.kt
// is available (quitAndInstallUpdate, openExternal, getAppVersion).
(() => {
  const params = new URLSearchParams(location.search || '');
  const msg = params.get('msg') || 'A critical update is required to continue using KnightTrader BloFin.';
  const url = params.get('url') || 'https://mknight2690-sys.github.io/knighttrader-blo-site/';
  const ver = params.get('ver') || '';
  const min = params.get('min') || '';

  document.getElementById('msg').textContent = msg;
  document.getElementById('ver').textContent = ver || '—';
  document.getElementById('min').textContent = min || '—';

  const btnUpdate = document.getElementById('update');
  const btnManual = document.getElementById('manual');
  const statusEl = document.getElementById('status');

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  btnUpdate.addEventListener('click', async () => {
    btnUpdate.disabled = true;
    btnUpdate.textContent = 'Downloading…';
    setStatus('Downloading the update — the app will restart automatically when ready.', 'ok');
    try {
      await window.kt.quitAndInstallUpdate();
      // If we get here, install didn't quit yet (e.g. still downloading).
      setStatus('Update is being installed. Please wait…', 'ok');
    } catch (e) {
      btnUpdate.disabled = false;
      btnUpdate.textContent = 'Update & Restart';
      setStatus('Automatic update failed. Use “Download installer manually”.', 'err');
    }
  });

  btnManual.addEventListener('click', () => {
    try { window.kt.openExternal(url); } catch (_) {}
    setStatus('Opening the download page in your browser…', 'ok');
  });
})();
