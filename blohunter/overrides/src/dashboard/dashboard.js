import {
  bindChartTriggers,
  closeChartModal,
  initializeChartModal,
  openChartModal,
  redrawCurrentChart,
  refreshOpenChartModel,
} from './chart-modal.js';

import {
  bindEquityTimeframes,
  redrawEquityChart,
  renderEquityChart,
  setAccountFlows,
} from './equity-chart.js';
import {
  bindDashboardPanelStorageChanges,
  initializeDashboardPanelResizing,
} from './panel-layout.js';
import { createDashboardActivityRenderer } from './render-activity.js';
import {
  renderClosedTrades48h,
  renderOpenPositions,
  renderRecentClosed,
} from './render-positions.js';
import { renderSyncInsights } from './render-sync-insights.js';
import {
  enqueueDashboardVoiceMessage,
  initializeDashboardSoundToggle,
  isDashboardSoundEnabled,
} from './dashboard-voice.js';
import { initWindowSystem, resetWindowLayout } from './windowSystem.js';
import { installV3DiagnosticsConsoleTools } from './v3DiagnosticsConsole.js';
import {
  evaluateLiquidationWarnings,
  playLiquidationRecoveryTone,
  playLiquidationWarningTone,
} from './liquidationWarning.js';
import {
  OPEN_POSITIONS_SORT_DEFAULT_DIRECTION,
  OPEN_POSITIONS_SORT_FIELD,
  openPositionsSortIndicator,
  sortOpenPositionsByPnl,
  toggleOpenPositionsSortDirection,
} from '../shared/openPositionsSort.js';
import { createDomElement, createEmptyDiv, createEmptyTableRow } from '../shared/dom.js';
import { formatCountryName } from '../shared/country.js';
import { formatPercent, formatUsd } from '../shared/formatting.js';
import {
  applySyncRecoveryUiGrace,
  createSyncRecoveryGraceTracker,
  deriveDashboardLivePill,
  deriveDashboardSecondaryMeta,
  normalizeDashboardSyncHealthForV3,
} from '../shared/syncStatusPresentation.js';

const REFRESH_INTERVAL_MS = 10000;
const DASHBOARD_MESSAGE_TIMEOUT_MS = 75000;
const APILOCK_DIAGNOSTICS_KEY = 'apilock_diagnostics';

const $ = (id) => document.getElementById(id);

let latestOpenPositions = [];
let layoutToastTimer = null;
// Per-position lowest-fired liquidation-warning threshold
// (Map<positionKey, threshold>). See liquidationWarning.js for the
// semantics. Cleared automatically when a position drops out of the
// live list — the evaluator returns the next state on each tick.
let liquidationWarningState = new Map();
let hasRenderedDashboardSnapshot = false;

const OPEN_POSITION_VOICE_KEYS_STORAGE = 'kt_open_position_voice_keys';
const OPEN_POSITION_VOICE_BASELINED_STORAGE = 'kt_open_position_voice_baselined';

function loadStoredOpenPositionKeys() {
  try {
    const raw = sessionStorage.getItem(OPEN_POSITION_VOICE_KEYS_STORAGE);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function storeOpenPositionKeys(keys) {
  try {
    sessionStorage.setItem(OPEN_POSITION_VOICE_KEYS_STORAGE, JSON.stringify([...keys]));
    sessionStorage.setItem(OPEN_POSITION_VOICE_BASELINED_STORAGE, '1');
  } catch {
    // sessionStorage may be unavailable in some embed contexts — ignore.
  }
}

function isOpenPositionVoiceBaselined() {
  try {
    return sessionStorage.getItem(OPEN_POSITION_VOICE_BASELINED_STORAGE) === '1';
  } catch {
    return false;
  }
}

let previousOpenPositionKeys = loadStoredOpenPositionKeys();

let openPositionVoiceEmptyStreak = 0;

function normalizeVoiceSymbol(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/(USDT|USD|PERP|SWAP)$/g, '');
}

function normalizeVoiceSide(raw) {
  const side = String(raw || '').trim().toLowerCase();
  if (!side) return '';
  if (side.includes('short') || side === 'sell') return 'short';
  if (side.includes('long') || side === 'buy' || side === 'net') return 'long';
  return '';
}

function positionKeyFor(position = {}) {
  const symbol = normalizeVoiceSymbol(position?.contract || position?.symbol || position?.instId);
  const side = normalizeVoiceSide(position?.side || position?.positionSide || position?.posSide);
  if (!symbol || !side) return null;
  return `${symbol}:${side}`;
}

function positionLabel(position = {}) {
  const symbol = normalizeVoiceSymbol(position?.contract || position?.symbol || position?.instId);
  const side = normalizeVoiceSide(position?.side || position?.positionSide || position?.posSide);
  if (!symbol) return '';
  return side ? `${side} ${symbol}` : symbol;
}

function announceOpenPositionChanges(openPositions = [], { unavailable = false } = {}) {
  if (!isDashboardSoundEnabled() || unavailable) return;

  const nextKeys = new Map();
  for (const position of openPositions || []) {
    const key = positionKeyFor(position);
    const label = positionLabel(position);
    if (!key || !label || nextKeys.has(key)) continue;
    nextKeys.set(key, label);
  }

  // A blank book while we already track positions is usually a failed read,
  // not ten closes. Ignore it unless it stays empty.
  if (nextKeys.size === 0 && previousOpenPositionKeys.size > 0) {
    openPositionVoiceEmptyStreak += 1;
    if (openPositionVoiceEmptyStreak < 3) return;
  } else {
    openPositionVoiceEmptyStreak = 0;
  }

  if (!isOpenPositionVoiceBaselined()) {
    previousOpenPositionKeys = new Set(nextKeys.keys());
    storeOpenPositionKeys(previousOpenPositionKeys);
    return;
  }

  const opened = [];
  const closed = [];
  for (const [key, label] of nextKeys) {
    if (!previousOpenPositionKeys.has(key)) opened.push(label);
  }
  for (const key of previousOpenPositionKeys) {
    if (!nextKeys.has(key)) {
      closed.push(key.includes(':') ? key.replace(':', ' ').toLowerCase() : key);
    }
  }

  previousOpenPositionKeys = new Set(nextKeys.keys());
  storeOpenPositionKeys(previousOpenPositionKeys);

  // One fill per refresh. A full-book rewrite (source swap, reload) stays silent.
  if (opened.length + closed.length !== 1) return;
  if (opened.length === 1) enqueueDashboardVoiceMessage(`Opened ${opened[0]}`);
  else enqueueDashboardVoiceMessage(`Closed ${closed[0]}`);
}

let livePillOverride = null;
let dashboardSyncAcquireTimer = null;
let dashboardLoadRequestSeq = 0;
let dashboardLoadInFlight = null;
let dashboardReloadQueued = false;
const dashboardSyncRecoveryGraceTracker = createSyncRecoveryGraceTracker();

// Open Positions sort state. Default = sort by PnL descending so the
// most profitable open position sits at the top. Clicking the PnL
// column header toggles between desc (most profitable first) and asc
// (most negative first) and updates the indicator arrow. Pure sort /
// toggle / indicator helpers live in src/shared/openPositionsSort.js.
const openPositionsSort = {
  by: OPEN_POSITIONS_SORT_FIELD,
  direction: OPEN_POSITIONS_SORT_DEFAULT_DIRECTION,
};

function updateOpenPositionsSortIndicator() {
  const header = document.getElementById('openPositionsPnlHeader');
  if (!header) return;
  const indicator = header.querySelector('.sort-indicator');
  const isAsc = openPositionsSort.direction === 'asc';
  if (indicator) indicator.textContent = openPositionsSortIndicator(openPositionsSort.direction);
  header.setAttribute('aria-sort', isAsc ? 'ascending' : 'descending');
}

// Operator-only devtools console helpers. Read-only / clear-only utilities for
// the locally stored API Lock diagnostics ring; no effect unless an operator
// manually invokes them from the dashboard devtools console.
function installApilockDiagnosticsConsoleTools() {
  window.dumpApilockDiagnostics = async function dumpApilockDiagnostics(limit = 80) {
    const maxRows = Math.max(1, Number.parseInt(limit, 10) || 80);
    const data = await chrome.storage.local.get(APILOCK_DIAGNOSTICS_KEY);
    const entries = Array.isArray(data[APILOCK_DIAGNOSTICS_KEY])
      ? data[APILOCK_DIAGNOSTICS_KEY]
      : [];
    const rows = entries.slice(-maxRows);
    console.table(rows);
    return rows;
  };

  window.clearApilockDiagnostics = async function clearApilockDiagnostics() {
    await chrome.storage.local.remove(APILOCK_DIAGNOSTICS_KEY);
    console.info('[API Lock] diagnostics cleared');
    return true;
  };
}

installApilockDiagnosticsConsoleTools();

// Operator-only devtools console helpers `dumpV3Signal()` and `dumpV3Queue()`
// surface the v3 signal pipeline state + executor pending-jobs queue without
// requiring `copy()` or other devtools-only globals. See module header for
// why we deliberately avoid the IIFE+copy() snippet pattern.
installV3DiagnosticsConsoleTools();

function createStars() {
  const container = $('stars');
  for (let i = 0; i < 90; i++) {
    const star = document.createElement('div');
    star.className = 'star';
    star.style.left = `${Math.random() * 150 - 50}%`;
    star.style.top = `${Math.random() * 200}vh`;
    star.style.animationDuration = `${40 + Math.random() * 40}s`;
    star.style.animationDelay = `${-(Math.random() * 60)}s`;

    if (i % 7 === 0) {
      star.style.width = '4px';
      star.style.height = '4px';
      star.style.opacity = '0.8';
      star.style.boxShadow = '0 0 6px rgba(255, 255, 255, 0.5)';
    } else if (i % 5 === 0) {
      star.style.width = '3px';
      star.style.height = '3px';
      star.style.opacity = '0.7';
      star.style.boxShadow = '0 0 4px rgba(255, 255, 255, 0.4)';
    } else if (i % 3 === 0) {
      star.style.width = '1px';
      star.style.height = '1px';
      star.style.opacity = '0.3';
    } else if (i % 2 === 1) {
      star.style.opacity = '0.4';
    }

    container.appendChild(star);
  }
}

function directionClass(value) {
  return value >= 0 ? 'positive' : 'negative';
}

// Skip-if-unchanged render gates. The dashboard used to fully rebuild every
// section's DOM on each 10s tick even when the snapshot payload was identical
// (idle markets, no open positions). Each gated section keeps a JSON
// fingerprint of exactly the data it renders from and skips the rebuild when
// it matches. Sections with their own transition state machines (voice
// announcements, live pill, liquidation warnings) stay ungated. Cleared in
// renderError so the first good snapshot after an error always repaints.
const renderSectionFingerprints = new Map();

function sectionChanged(key, payload) {
  let fingerprint;
  try {
    fingerprint = JSON.stringify(payload);
  } catch {
    return true;
  }
  if (renderSectionFingerprints.get(key) === fingerprint) return false;
  renderSectionFingerprints.set(key, fingerprint);
  return true;
}

function renderMetricCard(containerId, rows) {
  // Node-valued rows can't be fingerprinted — render those unconditionally.
  const diffable = rows.every(
    (row) => !(typeof globalThis.Node !== 'undefined' && row.value instanceof globalThis.Node)
  );
  if (diffable && !sectionChanged(`metricCard:${containerId}`, rows)) return;
  $(containerId).replaceChildren(
    ...rows.map((row) => {
      const valueNode =
        typeof globalThis.Node !== 'undefined' && row.value instanceof globalThis.Node
          ? row.value
          : createDomElement('span', { text: row.value == null ? '' : row.value });
      return createDomElement(
        'div',
        { className: `metric-row ${row.inline ? 'inline' : ''}`.trim() },
        [
          createDomElement('span', {
            className: `metric-tag ${row.tagClass || ''}`.trim(),
            text: row.tag,
          }),
          createDomElement('span', { className: `metric-number ${row.valueClass || ''}`.trim() }, [
            valueNode,
          ]),
        ]
      );
    })
  );
}

function showDashboardSyncAcquired(profile = null) {
  if (dashboardSyncAcquireTimer) {
    clearTimeout(dashboardSyncAcquireTimer);
    dashboardSyncAcquireTimer = null;
  }
  livePillOverride = {
    text: 'SYNC ACQUIRED',
    className: 'live-pill',
    until: Date.now() + 1500,
  };
  renderLivePill(profile);
  dashboardSyncAcquireTimer = setTimeout(() => {
    livePillOverride = null;
    dashboardSyncAcquireTimer = null;
    renderLivePill(profile);
  }, 1500);
}

function getLivePillOverride() {
  if (!livePillOverride) return null;
  if (Date.now() >= Number(livePillOverride.until || 0)) {
    livePillOverride = null;
    return null;
  }
  return livePillOverride;
}

function getBlofinStatusText(profile) {
  if (!profile?.apiConfigured) return 'not configured';
  if (profile.apilockViolated) return 'apilocked';
  if (profile.blofinCooldownActive) return 'cooldown';
  if (profile.blofinMonitoringSuspended) return 'monitoring delayed';
  if (!profile.blofinApiKnown || !profile.blofinApiFresh) return 'checking';
  return profile.blofinApiOk ? 'reachable' : 'unreachable';
}

function getDashboardDisplayProfile(profile = null, now = Date.now()) {
  if (!profile?.syncHealth) return profile;
  const v3NormalizedSyncHealth = normalizeDashboardSyncHealthForV3(
    profile,
    profile.syncHealth,
    now
  );
  const displaySyncHealth =
    v3NormalizedSyncHealth === profile.syncHealth
      ? applySyncRecoveryUiGrace(profile.syncHealth, dashboardSyncRecoveryGraceTracker, { now })
      : v3NormalizedSyncHealth;
  if (displaySyncHealth === profile.syncHealth) return profile;
  return {
    ...profile,
    syncHealth: displaySyncHealth,
    signalAwaitingSnapshot: false,
  };
}

function renderSecondaryMetaLine(profile, errorMessage = '') {
  const {
    tradingText,
    signalText,
    signalClass,
    statusText,
    statusClass,
    cooldownText,
    healthText,
    errorText,
  } = deriveDashboardSecondaryMeta(profile, errorMessage, Date.now());
  const metaLine = $('metaLineSecondary');
  metaLine.replaceChildren();

  appendSecondaryMetaValue(metaLine, 'Trading', tradingText, 'meta-value-positive');
  appendSecondaryMetaValue(metaLine, 'Signal', signalText, signalClass);
  appendSecondaryMetaValue(metaLine, 'Status', statusText, statusClass);
  appendSecondaryMetaText(metaLine, cooldownText);
  appendSecondaryMetaText(metaLine, healthText);
  appendSecondaryMetaText(metaLine, errorText);
}

function appendSecondaryMetaValue(container, label, value, className) {
  if (container.childNodes.length) {
    container.append(' | ');
  }
  container.append(`${label}: `);
  const valueNode = document.createElement('span');
  valueNode.className = className;
  valueNode.textContent = value;
  container.append(valueNode);
}

function appendSecondaryMetaText(container, text) {
  const normalized = String(text || '')
    .replace(/^\s*\|\s*/, '')
    .trim();
  if (!normalized) {
    return;
  }
  container.append(' | ');
  container.append(normalized);
}

function renderLivePill(profile = null, forceError = false) {
  const livePill = $('livePill');
  const override = getLivePillOverride();
  if (override && !forceError) {
    livePill.textContent = override.text;
    livePill.className = override.className;
    return;
  }
  const pill = deriveDashboardLivePill(profile, forceError);
  livePill.textContent = pill.text;
  livePill.className = pill.className;
}

const dashboardActivityRenderer = createDashboardActivityRenderer({
  getContainer: () => $('activityLog'),
  // Opens/closes are announced only via announceOpenPositionChanges().
  speakActivityAnnouncements: () => {},
});

function renderDashboard(snapshot) {
  const {
    balances,
    exposure,
    performance,
    openPositions,
    closedTrades48h,
    recentClosed,
    recentActivity,
    profile,
    equityHistory,
    accountFlows,
    errorMessage,
    sectionStatus = {},
  } = snapshot;
  latestOpenPositions = openPositions || [];
  const displayProfile = getDashboardDisplayProfile(profile);
  const accountRows = (balances.account || []).slice(0, 2).map((asset, index) => ({
    tag: asset.currency || (index === 0 ? 'BF' : 'CB'),
    tagClass: index === 1 ? 'cb' : '',
    value: formatUsd(
      Number.parseFloat(
        asset.available ?? asset.availableBalance ?? asset.equity ?? asset.balance ?? 0
      ),
      true
    ),
    inline: true,
  }));

  if (!accountRows.length) {
    accountRows.push({
      tag: 'USDT',
      value: formatUsd(balances.totalAvailable || 0),
      inline: true,
    });
  }

  renderMetricCard('accountValueCard', [
    {
      tag: 'USDT',
      value: formatUsd(balances.totalEquity || 0),
      inline: true,
    },
  ]);
  renderMetricCard('accountBalanceCard', accountRows);
  renderMetricCard('exposureCard', [
    { tag: 'USDT', value: formatUsd(exposure.totalMargin || 0), inline: true },
  ]);
  renderMetricCard('dailyPnlCard', [
    {
      tag: 'USDT',
      value: formatUsd(performance.dailyPnl || 0),
      valueClass: directionClass(performance.dailyPnl || 0),
      inline: true,
    },
  ]);
  renderMetricCard('monthlyPnlCard', [
    {
      tag: 'USDT',
      value: formatUsd(performance.monthlyPnl || 0),
      valueClass: directionClass(performance.monthlyPnl || 0),
      inline: true,
    },
  ]);

  $('metaLinePrimary').textContent =
    `Exchange: ${profile.exchange} | BloFin: ${getBlofinStatusText(profile)} | API Lock: ${formatCountryName(profile.apilockCountry) || 'not set'}`;
  renderSecondaryMetaLine(displayProfile, errorMessage || '');
  // KnightTrader: voice is opens/closes only — skip signal/trading transition speech.
  renderLivePill(displayProfile, Boolean(errorMessage));

  if (sectionChanged('activity', recentActivity || [])) {
    dashboardActivityRenderer.renderActivityWithThinking(recentActivity || []);
  }
  // History only ever appends, so length + last point (with the live totals)
  // is a sufficient — and cheap — change signal for the canvas redraw. Flows
  // are part of the fingerprint so a newly detected transfer repaints its
  // marker without waiting for an equity change.
  const equityHistoryList = equityHistory || [];
  const accountFlowsList = accountFlows || [];
  setAccountFlows(accountFlowsList);
  if (
    sectionChanged('equityChart', {
      length: equityHistoryList.length,
      last: equityHistoryList[equityHistoryList.length - 1] || null,
      equity: balances.totalEquity || 0,
      unrealized: balances.totalUnrealized || 0,
      flowCount: accountFlowsList.length,
      lastFlowAt: accountFlowsList[accountFlowsList.length - 1]?.at || 0,
    })
  ) {
    renderEquityChart(equityHistoryList, balances.totalEquity || 0, balances.totalUnrealized || 0);
  }
  const closedTrades48hList = closedTrades48h || recentClosed || [];
  const closedTrades48hUnavailable = sectionStatus.closedTrades48hUnavailable === true;
  if (
    sectionChanged('closedTrades48h', {
      trades: closedTrades48hList,
      unavailable: closedTrades48hUnavailable,
    })
  ) {
    renderClosedTrades48h(closedTrades48hList, { unavailable: closedTrades48hUnavailable });
  }
  const openPositionsList = openPositions || [];
  const openPositionsUnavailable = sectionStatus.openPositionsUnavailable === true;
  if (
    sectionChanged('openPositions', {
      positions: openPositionsList,
      direction: openPositionsSort.direction,
      unavailable: openPositionsUnavailable,
    })
  ) {
    renderOpenPositions(
      sortOpenPositionsByPnl(openPositionsList, { direction: openPositionsSort.direction }),
      {
        unavailable: openPositionsUnavailable,
      }
    );
    announceOpenPositionChanges(openPositionsList, { unavailable: openPositionsUnavailable });
  }
  fireLiquidationWarnings(openPositions || []);
  const recentClosedList = recentClosed || [];
  const recentClosedUnavailable = sectionStatus.recentClosedUnavailable === true;
  if (
    sectionChanged('recentClosed', {
      trades: recentClosedList,
      unavailable: recentClosedUnavailable,
    })
  ) {
    renderRecentClosed(recentClosedList, { unavailable: recentClosedUnavailable });
  }
  hasRenderedDashboardSnapshot = true;
  // Removes the rainbow startup loader and fades the dashboard content
  // in. See `body.is-startup-loading` styles in dashboard.css.
  document.body.classList.remove('is-startup-loading');
}

function fireLiquidationWarnings(openPositions = []) {
  // Dashboard-side: audio chirp + voice when the user is watching.
  // Discord delivery is handled by the background runtime-maintenance
  // tick via `runLiquidationWarningCheck` so alerts fire even when
  // the dashboard is closed. The two paths use independent threshold
  // tracking (in-memory here, chrome.storage.local in background).
  const { warnings, recoveries, nextState } = evaluateLiquidationWarnings(
    openPositions,
    liquidationWarningState
  );
  liquidationWarningState = nextState;
  for (const warning of warnings) {
    playLiquidationWarningTone(warning.threshold).catch(() => {});
  }
  for (const recovery of recoveries) {
    playLiquidationRecoveryTone(recovery).catch(() => {});
  }
}

function renderError(message, profile = null) {
  // Force the next good snapshot to repaint every gated section — an error
  // may have altered the visible UI in ways the fingerprints can't see.
  renderSectionFingerprints.clear();
  // Drop the startup loader on error so the user sees the dashboard
  // (with the error message visible in the meta line) instead of being
  // stuck on the rainbow bar forever. The loader is purely a "first
  // snapshot is on the way" cue; once we know the snapshot failed,
  // showing real UI is more useful.
  document.body.classList.remove('is-startup-loading');
  if (profile) {
    const displayProfile = getDashboardDisplayProfile(profile);
    $('metaLinePrimary').textContent =
      `Exchange: ${profile.exchange} | BloFin: ${getBlofinStatusText(profile)} | API Lock: ${formatCountryName(profile.apilockCountry) || 'not set'}`;
    renderSecondaryMetaLine(displayProfile, message);
    renderLivePill(displayProfile);
  } else {
    $('metaLineSecondary').textContent = message;
    renderLivePill(null, true);
  }
  if (hasRenderedDashboardSnapshot) {
    return;
  }
  // The rainbow startup loader covered the dashboard while we waited
  // for the first snapshot; it was already dropped at the top of
  // `renderError` so the dashboard's error state is now visible.
  // Surface the failure in the meta line and panel empty-states.
  $('metaLineSync').textContent = `Status: ${message}`;
  $('livePill').textContent = 'Sync Delayed';
  $('livePill').className = 'live-pill offline';
  $('activityLog').replaceChildren(
    createEmptyDiv('empty-state', 'Unable to load recent activity.')
  );
  renderEquityChart([], 0);
  $('openPositionsBody').replaceChildren(createEmptyTableRow('Unable to load open positions.', 8));
  $('closedTrades48hGrid').replaceChildren(
    createEmptyDiv('closed-trades-48h-empty', 'Unable to load closed trades.')
  );
  $('closedTrades48hCaption').textContent = 'Closed trade data unavailable';
  $('recentClosedBody').replaceChildren(
    createEmptyTableRow('Unable to load recently closed trades.')
  );
}

function showLayoutToast(message) {
  const toast = $('layoutToast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('visible');
  if (layoutToastTimer) {
    clearTimeout(layoutToastTimer);
  }
  layoutToastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    layoutToastTimer = null;
  }, 1400);
}

async function requestDashboardSnapshot() {
  return Promise.race([
    chrome.runtime.sendMessage({
      source: 'blohunter-popup',
      type: 'get-dashboard-data',
    }),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error('Dashboard snapshot request timed out')),
        DASHBOARD_MESSAGE_TIMEOUT_MS
      );
    }),
  ]);
}

async function loadDashboard() {
  if (dashboardLoadInFlight) {
    dashboardReloadQueued = true;
    return dashboardLoadInFlight;
  }

  dashboardLoadInFlight = (async () => {
    const requestSeq = ++dashboardLoadRequestSeq;
    try {
      const response = await requestDashboardSnapshot();

      if (requestSeq !== dashboardLoadRequestSeq) return;

      if (!response?.ok || !response.data) {
        renderError(response?.msg || 'Dashboard snapshot failed', response?.profile || null);
        return;
      }

      const wasStartupSync = !hasRenderedDashboardSnapshot;
      renderDashboard(response.data);
      if (wasStartupSync && !response.data.errorMessage) {
        showDashboardSyncAcquired(response.data.profile || null);
      }
      await renderSyncInsights({ getElement: $ });
      bindChartTriggers();
      refreshOpenChartModel().catch(() => {});
    } catch (err) {
      if (requestSeq !== dashboardLoadRequestSeq) return;
      renderError(err.message);
    }
  })().finally(() => {
    dashboardLoadInFlight = null;
    if (dashboardReloadQueued) {
      dashboardReloadQueued = false;
      setTimeout(() => {
        loadDashboard();
      }, 0);
    }
  });

  return dashboardLoadInFlight;
}

// Window manager: drag, minimize, resize, taskbar. Boots once on load.
initWindowSystem().catch(() => {});

// Reset Layout also wipes the window manager's per-panel state (drag
// offsets, explicit width/height, minimize flags). The vertical-resize
// reset still runs first via panel-layout.js's own listener; this just
// adds the window-manager cleanup.
document.getElementById('resetDashboardLayoutBtn')?.addEventListener('click', () => {
  resetWindowLayout().catch(() => {});
});

// Open Positions PnL column header: click to toggle sort direction.
// First click after load goes asc (most negative first); next click
// goes back to desc (most profitable first). Re-renders from
// latestOpenPositions so it works without a full data refresh.
const openPositionsPnlHeader = document.getElementById('openPositionsPnlHeader');
if (openPositionsPnlHeader) {
  const togglePnlSort = () => {
    openPositionsSort.direction = toggleOpenPositionsSortDirection(openPositionsSort.direction);
    updateOpenPositionsSortIndicator();
    renderOpenPositions(
      sortOpenPositionsByPnl(latestOpenPositions || [], { direction: openPositionsSort.direction }),
      {}
    );
  };
  openPositionsPnlHeader.addEventListener('click', togglePnlSort);
  openPositionsPnlHeader.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      togglePnlSort();
    }
  });
}

// Per-row manual actions for an open position. The red X closes at market
// (bypassing the +5% floor); the green + adds to the position at market with a
// standard DCA-sized order (bypassing the engine caps). Each opens the shared
// confirm dialog, then sends a manual-close-position / manual-add-position
// message to the background. Both are explicit user overrides of the engine.
let pendingPositionAction = null;
// True while a manual close/add order is actually in flight to the background.
// While set, the confirm dialog cannot be dismissed (Escape/backdrop/Cancel) or
// re-armed for another action — a real market order is executing and the UI must
// not look idle or let a second order be queued against the same position.
let positionActionInFlight = false;
// The element focus was on when the confirm dialog opened, so focus can be
// restored to it when the dialog closes (keyboard-accessibility).
let positionConfirmTrigger = null;

const POSITION_ACTIONS = {
  close: {
    title: 'Close position?',
    acceptLabel: 'Close at market',
    busyLabel: 'Closing...',
    acceptClass: 'confirm-btn confirm-btn-danger',
    messageType: 'manual-close-position',
    failPrefix: 'Close failed',
  },
  add: {
    title: 'Add to position?',
    acceptLabel: 'Add at market',
    busyLabel: 'Adding...',
    acceptClass: 'confirm-btn confirm-btn-primary',
    messageType: 'manual-add-position',
    failPrefix: 'Add failed',
  },
};

// Friendly toast text for the executor reason codes that can come back on a
// failed manual action. Anything unmapped (already-friendly vault prompts or raw
// BloFin messages) passes through unchanged.
const POSITION_ACTION_ERROR_TEXT = {
  'no-position': 'That position is no longer open on BloFin.',
  'no-balance': 'Not enough margin available.',
  'no-instrument-metadata': "Couldn't read the market's contract details — try again.",
  'sizing-failed': "Couldn't size the add — try again.",
  blacklist: "This market isn't supported.",
  'invalid-add-request': 'Invalid request.',
  'invalid-close-request': 'Invalid request.',
  'positions-read-failed': "Couldn't reach BloFin — try again in a moment.",
};

function friendlyPositionActionError(msg, fallback) {
  if (!msg) return fallback;
  return POSITION_ACTION_ERROR_TEXT[msg] || msg;
}

function resetPositionConfirm() {
  pendingPositionAction = null;
  positionActionInFlight = false;
  $('closeConfirmOverlay').classList.remove('open');
  const accept = $('closeConfirmAccept');
  accept.disabled = false;
  $('closeConfirmCancel').disabled = false;
  // Return focus to whatever opened the dialog (the row's ✕ / + button). A
  // detached trigger after a refresh just no-ops.
  if (positionConfirmTrigger && typeof positionConfirmTrigger.focus === 'function') {
    positionConfirmTrigger.focus();
  }
  positionConfirmTrigger = null;
}

// Dismissal entry point (Escape / backdrop / Cancel). Ignored while an order is
// in flight so a stray keystroke can't close the dialog mid-execution and re-arm
// a second action.
function dismissPositionConfirm() {
  if (positionActionInFlight) return;
  resetPositionConfirm();
}

function findOpenPosition(contract, side) {
  return (latestOpenPositions || []).find(
    (position) => position.contract === contract && (position.side || 'long') === side
  );
}

function appendCurrentPnlLine(body, match) {
  if (!match || !Number.isFinite(match.pnlUsd)) return;
  const pnlClass = match.pnlUsd >= 0 ? 'positive' : 'negative';
  const pct = Number.isFinite(match.pnlPct) ? ` (${formatPercent(match.pnlPct)})` : '';
  body.append(
    createDomElement('div', { className: 'confirm-pnl-line' }, [
      'Current PnL: ',
      createDomElement('span', {
        className: pnlClass,
        text: `${formatUsd(match.pnlUsd)}${pct}`,
      }),
    ])
  );
}

function openPositionConfirm(action, contract, side) {
  const config = POSITION_ACTIONS[action];
  if (!config) return;
  // Don't let a new confirm replace one whose order is still executing.
  if (positionActionInFlight) return;
  pendingPositionAction = { action, contract, side };
  const sideLabel = side === 'short' ? 'Short' : 'Long';
  const match = findOpenPosition(contract, side);

  $('closeConfirmTitle').textContent = config.title;
  const body = $('closeConfirmBody');
  body.replaceChildren(
    createDomElement('span', {}, [
      action === 'add' ? 'Add to ' : 'Close ',
      createDomElement('strong', { text: `${sideLabel} ${contract}` }),
      action === 'add' ? '?' : ' at market?',
    ])
  );
  appendCurrentPnlLine(body, match);
  body.append(
    createDomElement('div', {
      className: 'confirm-pnl-line muted',
      text:
        action === 'add'
          ? 'This adds a standard DCA-sized order at market and cannot be undone.'
          : 'This sends a market close and cannot be undone.',
    })
  );

  positionConfirmTrigger = document.activeElement;
  const accept = $('closeConfirmAccept');
  accept.className = config.acceptClass;
  accept.textContent = config.acceptLabel;
  accept.disabled = false;
  $('closeConfirmOverlay').classList.add('open');
  accept.focus();
}

async function submitPositionAction() {
  if (!pendingPositionAction || positionActionInFlight) return;
  const { action, contract, side } = pendingPositionAction;
  const config = POSITION_ACTIONS[action];
  const accept = $('closeConfirmAccept');
  const cancel = $('closeConfirmCancel');
  positionActionInFlight = true;
  accept.disabled = true;
  cancel.disabled = true;
  accept.textContent = config.busyLabel;
  try {
    const response = await chrome.runtime.sendMessage({
      source: 'blohunter-popup',
      type: config.messageType,
      contract,
      side,
    });
    if (response?.ok) {
      const sideLabel = side === 'short' ? 'Short' : 'Long';
      if (action === 'add') {
        showLayoutToast(`Added to ${sideLabel} ${contract}`);
      } else {
        showLayoutToast(
          response.reason === 'close-no-position' || response.reason === 'close-already'
            ? `${contract} already closed`
            : `Closed ${sideLabel} ${contract}`
        );
      }
      resetPositionConfirm();
      loadDashboard();
    } else {
      showLayoutToast(friendlyPositionActionError(response?.msg, config.failPrefix));
    }
  } catch (err) {
    showLayoutToast(err?.message || config.failPrefix);
  } finally {
    // On success resetPositionConfirm already cleared the flag; if it is still
    // set the order didn't complete, so re-arm the dialog for retry/cancel.
    if (positionActionInFlight) {
      positionActionInFlight = false;
      accept.disabled = false;
      cancel.disabled = false;
      accept.textContent = config.acceptLabel;
    }
  }
}

$('openPositionsBody').addEventListener('click', (event) => {
  const closeBtn = event.target.closest('.position-close-btn');
  if (closeBtn) {
    const contract = closeBtn.dataset.closeContract || '';
    const side = closeBtn.dataset.closeSide === 'short' ? 'short' : 'long';
    if (contract) openPositionConfirm('close', contract, side);
    return;
  }
  const addBtn = event.target.closest('.position-add-btn');
  if (addBtn) {
    const contract = addBtn.dataset.addContract || '';
    const side = addBtn.dataset.addSide === 'short' ? 'short' : 'long';
    if (contract) openPositionConfirm('add', contract, side);
  }
});
$('closeConfirmCancel').addEventListener('click', dismissPositionConfirm);
$('closeConfirmAccept').addEventListener('click', submitPositionAction);
$('closeConfirmOverlay').addEventListener('click', (event) => {
  if (event.target === $('closeConfirmOverlay')) dismissPositionConfirm();
});
document.addEventListener('keydown', (event) => {
  if (!$('closeConfirmOverlay').classList.contains('open')) return;
  if (event.key === 'Escape') {
    dismissPositionConfirm();
    return;
  }
  // Trap Tab within the dialog's two buttons so keyboard focus can't land on the
  // obscured page behind an aria-modal dialog.
  if (event.key === 'Tab') {
    const focusables = [$('closeConfirmCancel'), $('closeConfirmAccept')].filter(
      (el) => el && !el.disabled
    );
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !focusables.includes(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !focusables.includes(active))) {
      event.preventDefault();
      first.focus();
    }
  }
});

createStars();
window.openChartModal = openChartModal;
window.closeChartModal = closeChartModal;
$('chartOverlay').addEventListener('click', (event) => {
  if (event.target === $('chartOverlay')) {
    closeChartModal();
  }
});
$('chartCloseBtn').addEventListener('click', closeChartModal);
window.addEventListener('resize', () => {
  redrawCurrentChart();
  redrawEquityChart();
});
initializeChartModal({ getOpenPositions: () => latestOpenPositions });
const dashboardSoundReady = initializeDashboardSoundToggle();
bindEquityTimeframes();
initializeDashboardPanelResizing({
  onPanelResize(panelKey) {
    if (panelKey === 'growth') {
      redrawEquityChart();
    }
  },
  onPanelLayoutMessage: showLayoutToast,
})
  .then(() => dashboardSoundReady)
  .finally(loadDashboard);
setInterval(loadDashboard, REFRESH_INTERVAL_MS);
chrome.storage.onChanged.addListener((changes, areaName) => {
  bindDashboardPanelStorageChanges(changes, areaName);
  if (areaName !== 'local') return;
  if (
    changes.enabled ||
    changes.percent_order_size ||
    changes.min_qty_multiplier ||
    changes.max_position_size_percent
  ) {
    loadDashboard();
  }
});
