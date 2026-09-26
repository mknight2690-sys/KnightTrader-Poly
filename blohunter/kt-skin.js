(() => {
  const BRAND = 'KnightTrader';

  function rebrandVisible() {
    document.title = BRAND;

    const base = document.querySelector('.brand-base');
    const shimmer = document.querySelector('.brand-shimmer');
    if (base && /blohunter/i.test(base.textContent || '')) base.textContent = BRAND;
    if (shimmer && /blohunter/i.test(shimmer.textContent || '')) shimmer.textContent = BRAND;

    document.querySelectorAll('h1, h2, .brand-lockup, .app-title, .placeholder-brand, .panel-caption').forEach((el) => {
      if (el.childElementCount > 1) return;
      const text = el.textContent || '';
      if (
        /blohunter/i.test(text) ||
        /live extension log/i.test(text) ||
        /live activity log/i.test(text) ||
        /^recent activity$/i.test(text.trim())
      ) {
        el.textContent = text
          .replace(/BloHunter(?:\s+Connect)?/gi, BRAND)
          .replace(/Live extension log/gi, 'Hermes cron log')
          .replace(/Live activity log/gi, 'Hermes cron log')
          .replace(/Recent Activity/gi, 'Hermes Activity');
      }
    });
  }

  function walkText(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      let next = String(node.nodeValue || '').replace(/BloHunter(?:\s+Connect)?/gi, BRAND);
      next = next
        .replace(/Live extension log/gi, 'Hermes cron log')
        .replace(/Recent Activity/gi, 'Hermes Activity');
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') return;
    for (const child of Array.from(node.childNodes)) walkText(child);
  }

  function rebrandTree(root = document.body) {
    rebrandVisible();
    if (root) walkText(root);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => rebrandTree());
  } else {
    rebrandTree();
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        walkText(mutation.target);
      } else if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => walkText(node));
      }
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  let lastEquityRedrawAt = 0;
  let lastEquitySize = '';

  function redrawEquityChart() {
    const canvas = document.getElementById('equityChartCanvas');
    const size = canvas ? `${canvas.clientWidth}x${canvas.clientHeight}` : '0x0';
    const now = Date.now();
    if (size === lastEquitySize && now - lastEquityRedrawAt < 80) return;
    lastEquitySize = size;
    lastEquityRedrawAt = now;
    window.dispatchEvent(new Event('resize'));
  }

  function bindEquityTimeframeChrome() {
    const chips = document.querySelectorAll('[data-equity-range]');
    chips.forEach((button) => {
      if (button.dataset.ktTfBound === 'true') return;
      button.dataset.ktTfBound = 'true';
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-equity-range]').forEach((chip) => {
          chip.classList.toggle('active', chip === button);
        });
      });
    });

    const canvas = document.getElementById('equityChartCanvas');
    if (canvas && canvas.dataset.ktResizeBound !== 'true') {
      canvas.dataset.ktResizeBound = 'true';
      let frame = 0;
      const resizeObserver = new ResizeObserver(() => {
        if (canvas.clientWidth <= 0 || canvas.clientHeight <= 0) return;
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = 0;
          redrawEquityChart();
        });
      });
      resizeObserver.observe(canvas);
    }
  }

  function bootEquityChrome() {
    bindEquityTimeframeChrome();
    window.requestAnimationFrame(redrawEquityChart);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootEquityChrome);
  } else {
    bootEquityChrome();
  }

  function scrollTaskbarPanelIntoView(panelId) {
    const PANEL_IDS = ['summary', 'activity', 'growth', 'closedTrades48h', 'openPositions', 'recentClosed'];
    if (!panelId || !PANEL_IDS.includes(panelId)) return;
    let panel = null;
    if (panelId === 'summary') {
      panel = document.querySelector('.summary-panel');
    } else if (panelId === 'activity') {
      panel = document.querySelector('.activity-panel');
    } else {
      panel = document.querySelector(`[data-resize-panel="${panelId}"]`);
    }
    if (!panel) return;
    const scroller = document.querySelector('.page-shell') || document.documentElement;
    const top = panel.getBoundingClientRect().top + (scroller.scrollTop || document.documentElement.scrollTop || document.body.scrollTop);
    scroller.scrollTo({ top, behavior: 'smooth' });
  }

  function bindTaskbarAutoScroll() {
    const container = document.getElementById('taskbarEntries');
    if (!container) return;
    container.addEventListener('click', (event) => {
      const entry = event.target.closest('.taskbar-entry');
      if (!entry) return;
      scrollTaskbarPanelIntoView(entry.dataset.panelId);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindTaskbarAutoScroll);
  } else {
    bindTaskbarAutoScroll();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') redrawEquityChart();
  });

  window.setTimeout(redrawEquityChart, 400);
  window.setTimeout(redrawEquityChart, 1200);

  function unlockVoiceButton() {
    const button = document.getElementById('dashboardSoundBtn');
    if (!button || !('speechSynthesis' in window)) return;
    const refresh = () => {
      try {
        window.speechSynthesis.getVoices();
      } catch (_) {}
      if (button.disabled) {
        button.disabled = false;
        if (!button.title || /unavailable/i.test(button.title)) {
          button.title = 'Dashboard voice: off (click to enable)';
        }
      }
    };
    if (typeof window.speechSynthesis.addEventListener === 'function') {
      window.speechSynthesis.addEventListener('voiceschanged', refresh);
    }
    refresh();
    window.setTimeout(refresh, 400);
    window.setTimeout(refresh, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', unlockVoiceButton);
  } else {
    unlockVoiceButton();
  }
})();
