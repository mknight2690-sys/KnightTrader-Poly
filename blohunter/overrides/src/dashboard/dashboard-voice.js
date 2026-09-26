/**
 * Dashboard voice subsystem — the speech-synthesis announcement queue, voice
 * selection/cycling, the sound-toggle button, and the transition announcers
 * (signal, trading, welcome, activity entries). Moved verbatim out of
 * dashboard.js; the message CONTENT helpers stay in voice.js (pure, tested),
 * this module owns the runtime state machines around them.
 *
 * Single-instance per dashboard page, so state is module-level (matching the
 * pre-extraction shape exactly).
 */

import {
  DASHBOARD_SOUND_ACTIVITY_TYPES,
  DASHBOARD_TRADING_VOICE_MESSAGES,
  DASHBOARD_SIGNAL_DISCONNECT_VOICE_DEBOUNCE_MS,
  getDashboardVoiceMessage,
  getDashboardWelcomeVoiceMessage,
  isDashboardTradingActive,
  shouldAnnounceDashboardActivityEntry,
} from './voice.js';
import { deriveDashboardSignalVoiceState } from '../shared/syncStatusPresentation.js';

const DASHBOARD_SOUND_STORAGE_KEY = 'dashboard_sound_enabled';
const DASHBOARD_SOUND_VOICE_STORAGE_KEY = 'dashboard_sound_voice';

const $ = (id) => document.getElementById(id);

let dashboardSoundEnabled = false;
let dashboardVoiceName = '';
let dashboardVoices = [];
let lastDashboardSignalVoiceState = null;
// Debounce state for the disconnect voice: a pending timer (fires only if the disconnect
// outlasts the debounce window) and whether we actually announced the disconnect (so a
// "restored" is only spoken if its "disconnected" was).
let signalDisconnectVoiceTimer = null;
let signalDisconnectVoiceAnnounced = false;
let lastDashboardTradingVoiceEnabled = null;
let dashboardTradingActiveAnnouncementPending = false;
let dashboardWelcomeAnnounced = false;
let dashboardAnnouncementQueue = [];
let dashboardAnnouncementRunning = false;
let dashboardAnnouncementSession = 0;
const dashboardCloseBlockedVoiceTimes = new Map();

export function isDashboardSoundEnabled() {
  return dashboardSoundEnabled;
}

function getRawSpeechVoices() {
  if (!('speechSynthesis' in window) || typeof window.speechSynthesis.getVoices !== 'function') {
    return [];
  }
  return window.speechSynthesis.getVoices();
}

function refreshDashboardVoices() {
  const seen = new Set();
  dashboardVoices = getRawSpeechVoices()
    .filter((voice) => {
      const key = String(voice?.voiceURI || voice?.name || '').trim();
      const lang = String(voice?.lang || '').toLowerCase();
      if (!key || seen.has(key)) return false;
      if (!lang.startsWith('en')) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => preferredDashboardVoiceRank(left) - preferredDashboardVoiceRank(right));
}

function preferredDashboardVoiceRank(voice) {
  const name = String(voice?.name || '').trim();
  const voiceUri = String(voice?.voiceURI || '').trim();
  const lang = String(voice?.lang || '').toLowerCase();
  const haystack = `${name} ${voiceUri}`.trim();
  const isGoogle = /^Google\b/i.test(name) || /^Google\b/i.test(voiceUri);
  const isUsEnglish = lang === 'en-us' || /\ben[-_ ]us\b/i.test(haystack);
  const isUkEnglish =
    lang === 'en-gb' || /\ben[-_ ]gb\b/i.test(haystack) || /\buk english\b/i.test(haystack);
  const isFemale = /\bfemale\b/i.test(haystack);

  // Preferred default: a UK English Female voice (e.g. "Google UK English Female") when the
  // local system offers one. This only sets the DEFAULT pick; a voice the user explicitly
  // cycled to (persisted dashboardVoiceName) still wins, and the tiers below are the
  // graceful fallback when no UK female voice is installed.
  if (isUkEnglish && isFemale) return 0;
  if (isGoogle && isUsEnglish) return 1;
  if (isGoogle) return 2;
  if (isUsEnglish) return 3;
  return 4;
}

function normalizeDashboardVoiceDisplayName(name = '') {
  const normalized = String(name || '')
    .replace(/^Microsoft\s+/i, '')
    .replace(/^Google\s+/i, '')
    .replace(/\s+Desktop\b/gi, '')
    .replace(/\s+\(Natural\)$/i, '')
    .replace(/\s+-\s+English.*$/i, '')
    .trim();
  return normalized || String(name || '').trim() || 'Default';
}

function preferredDashboardVoiceIndex() {
  if (!dashboardVoices.length) return -1;
  return 0;
}

function getSelectedDashboardVoice() {
  if (!dashboardVoices.length) return null;
  if (dashboardVoiceName) {
    const matchedVoice = dashboardVoices.find(
      (voice) =>
        String(voice?.voiceURI || voice?.name || '') === dashboardVoiceName ||
        String(voice?.name || '') === dashboardVoiceName
    );
    if (matchedVoice) return matchedVoice;
  }

  const preferredIndex = preferredDashboardVoiceIndex();
  return preferredIndex >= 0 ? dashboardVoices[preferredIndex] : dashboardVoices[0];
}

function hasDashboardVoiceSupport() {
  return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

function getDashboardVoiceButtonLabel() {
  if (!hasDashboardVoiceSupport() || !dashboardVoices.length) return 'Voice Unavailable';
  if (!dashboardSoundEnabled) return 'Voice Off';
  const selectedVoice = getSelectedDashboardVoice();
  if (!selectedVoice) return 'Voice On';
  return `Voice: ${normalizeDashboardVoiceDisplayName(selectedVoice.name)}`;
}

function updateDashboardSoundButton() {
  const button = $('dashboardSoundBtn');
  if (!button) return;
  const selectedVoice = getSelectedDashboardVoice();
  button.textContent = getDashboardVoiceButtonLabel();
  button.classList.toggle('on', dashboardSoundEnabled);
  button.classList.toggle('off', !dashboardSoundEnabled);
  button.setAttribute('aria-pressed', String(dashboardSoundEnabled));
  button.disabled = !hasDashboardVoiceSupport() || !dashboardVoices.length;
  if (!hasDashboardVoiceSupport()) {
    button.title = 'Dashboard voice unavailable in this browser';
  } else if (!dashboardVoices.length) {
    button.title = 'Dashboard voice unavailable: no English voices detected';
  } else if (dashboardSoundEnabled && selectedVoice) {
    button.title = `Dashboard voice: ${selectedVoice.name} (click to cycle voices)`;
  } else {
    button.title = 'Dashboard voice: off (click to enable)';
  }
}

function speakDashboardVoiceMessage(message, force = false) {
  if ((!force && !dashboardSoundEnabled) || !message) return Promise.resolve();
  if (!hasDashboardVoiceSupport()) return Promise.resolve();

  return new Promise((resolve) => {
    try {
      const utterance = new window.SpeechSynthesisUtterance(message);
      const selectedVoice = getSelectedDashboardVoice();
      if (selectedVoice) {
        utterance.voice = selectedVoice;
        if (selectedVoice.lang) utterance.lang = selectedVoice.lang;
      }
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 1;
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    } catch {
      // Voice alerts are optional; keep dashboard monitoring silent if speech is unavailable.
      resolve();
    }
  });
}

async function processDashboardAnnouncementQueue() {
  if (dashboardAnnouncementRunning) return;
  const session = dashboardAnnouncementSession;
  dashboardAnnouncementRunning = true;

  try {
    while (dashboardAnnouncementQueue.length && session === dashboardAnnouncementSession) {
      const next = dashboardAnnouncementQueue.shift();
      if (!next) continue;
      await speakDashboardVoiceMessage(next.message, next.force === true);
      if (dashboardAnnouncementQueue.length && session === dashboardAnnouncementSession) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
  } finally {
    if (session === dashboardAnnouncementSession) {
      dashboardAnnouncementRunning = false;
    }
  }
}

// KnightTrader: the only lines allowed through the speaker. Everything else
// (welcome, signal, trading, DCA, HOLD, Hermes cron) is dropped.
const POSITION_VOICE_LINE = /^(Opened|Closed) [a-z0-9].{0,48}$/i;
let positionVoiceBurst = [];
let positionVoiceBurstTimer = null;

try {
  window.speechSynthesis?.cancel();
} catch {
  // Ignore browsers without speech synthesis.
}

function isPositionVoiceLine(message) {
  return POSITION_VOICE_LINE.test(String(message || '').replace(/\s+/g, ' ').trim());
}

export function enqueueDashboardVoiceMessage(message, { force = false } = {}) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text || !isPositionVoiceLine(text)) return;

  // Collect every line queued in the same refresh. A real fill is one
  // position. A book reload queues many lines at once — speak none of them.
  positionVoiceBurst.push(text);
  clearTimeout(positionVoiceBurstTimer);
  positionVoiceBurstTimer = setTimeout(() => {
    const lines = positionVoiceBurst;
    positionVoiceBurst = [];
    positionVoiceBurstTimer = null;
    if (lines.length !== 1) {
      cancelDashboardVoiceQueue();
      return;
    }
    dashboardAnnouncementQueue = [{ message: lines[0], force: force === true }];
    processDashboardAnnouncementQueue().catch(() => {});
  }, 80);
}

function enqueueDashboardAnnouncement(entry, { force = false } = {}) {
  if (!entry) return;
  enqueueDashboardVoiceMessage(getDashboardVoiceMessage(entry), { force });
}

// The authoritative runtime version: the manifest the browser actually loaded, so it tracks
// manifest.json automatically on every release bump. Guarded for non-extension contexts.
function getDashboardExtensionVersion() {
  try {
    if (
      typeof chrome !== 'undefined' &&
      chrome.runtime &&
      typeof chrome.runtime.getManifest === 'function'
    ) {
      return String(chrome.runtime.getManifest().version || '');
    }
  } catch {
    // Version phrase is optional; fall through to no version on any failure.
  }
  return '';
}

export function enqueueDashboardWelcomeAnnouncement() {
  // KnightTrader: no welcome speech.
}

function cancelDashboardVoiceQueue() {
  dashboardAnnouncementSession += 1;
  dashboardAnnouncementQueue = [];
  dashboardAnnouncementRunning = false;
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignore browser speech cancellation failures.
  }
}

export function speakDashboardActivityAnnouncements() {
  // KnightTrader: activity log is visual only.
  return;
  if (!dashboardSoundEnabled) return;
  const voiceEntries = (entries || [])
    .filter(
      (entry) =>
        DASHBOARD_SOUND_ACTIVITY_TYPES.has(entry.type) &&
        Number(entry.loggedAt || 0) > previousTimestamp
    )
    .sort((a, b) => Number(a.loggedAt || 0) - Number(b.loggedAt || 0))
    .filter((entry) => shouldAnnounceDashboardActivityEntry(entry, dashboardCloseBlockedVoiceTimes))
    .slice(-3);

  if (!voiceEntries.length) return;
  voiceEntries.forEach((entry) => enqueueDashboardAnnouncement(entry));
}

function getDashboardSignalVoiceState(profile = {}, now = Date.now()) {
  return deriveDashboardSignalVoiceState(profile, now);
}

export function announceDashboardSignalTransitions() {
  // KnightTrader: signal connect/disconnect is not spoken.
  return;
  const nextState = getDashboardSignalVoiceState();
  const previousState = lastDashboardSignalVoiceState;
  lastDashboardSignalVoiceState = nextState;
  if (!dashboardSoundEnabled || previousState === null || previousState === nextState) return;

  if (nextState === 'awaiting-snapshot') {
    enqueueDashboardAnnouncement({ type: 'awaiting-snapshot' });
    return;
  }
  if (nextState === 'apilock-blocked') {
    enqueueDashboardAnnouncement({ type: 'apilock-blocked' });
    return;
  }
  if (previousState === 'apilock-blocked' && nextState === 'connected') {
    enqueueDashboardAnnouncement({ type: 'apilock-restored' });
    return;
  }
  if (nextState === 'reconnecting' && previousState !== 'reconnecting') {
    // Debounce: don't announce a brief keep-alive blip. Only speak the disconnect if it is
    // STILL reconnecting after the window. A faster self-healing reconnect stays silent.
    clearTimeout(signalDisconnectVoiceTimer);
    signalDisconnectVoiceTimer = setTimeout(() => {
      signalDisconnectVoiceTimer = null;
      if (lastDashboardSignalVoiceState === 'reconnecting' && dashboardSoundEnabled) {
        signalDisconnectVoiceAnnounced = true;
        enqueueDashboardAnnouncement({ type: 'signal-failed' });
      }
    }, DASHBOARD_SIGNAL_DISCONNECT_VOICE_DEBOUNCE_MS);
    return;
  }
  if (nextState === 'connected' && previousState !== 'connected') {
    // Reconnected. Cancel a pending (un-announced) disconnect — it was just a blip → silent.
    // Only announce "restored" if we actually announced the matching "disconnected".
    if (signalDisconnectVoiceTimer) {
      clearTimeout(signalDisconnectVoiceTimer);
      signalDisconnectVoiceTimer = null;
    }
    if (signalDisconnectVoiceAnnounced) {
      signalDisconnectVoiceAnnounced = false;
      enqueueDashboardAnnouncement({ type: 'signal-restored' });
    }
  }
}

export function announceDashboardTradingTransitions() {
  // KnightTrader: trading active/suspended is not spoken.
  return;
  const nextEnabled = false;
  const nextActive = isDashboardTradingActive(profile);
  const previousEnabled = lastDashboardTradingVoiceEnabled;
  lastDashboardTradingVoiceEnabled = nextEnabled;

  if (!dashboardSoundEnabled || previousEnabled === null) return;

  if (previousEnabled === true && nextEnabled === false) {
    dashboardTradingActiveAnnouncementPending = false;
    enqueueDashboardVoiceMessage(DASHBOARD_TRADING_VOICE_MESSAGES.suspended);
    return;
  }

  if (previousEnabled === false && nextEnabled === true && !nextActive) {
    dashboardTradingActiveAnnouncementPending = true;
    return;
  }

  if (
    nextActive &&
    (previousEnabled === false || dashboardTradingActiveAnnouncementPending === true)
  ) {
    dashboardTradingActiveAnnouncementPending = false;
    enqueueDashboardVoiceMessage(DASHBOARD_TRADING_VOICE_MESSAGES.active);
  }
}

export function initializeDashboardSoundToggle() {
  const button = $('dashboardSoundBtn');
  if (!button) return Promise.resolve();

  refreshDashboardVoices();

  const settingsReady = new Promise((resolve) => {
    chrome.storage.local.get(
      [DASHBOARD_SOUND_STORAGE_KEY, DASHBOARD_SOUND_VOICE_STORAGE_KEY],
      (result) => {
        dashboardSoundEnabled = result[DASHBOARD_SOUND_STORAGE_KEY] === true;
        dashboardVoiceName = String(result[DASHBOARD_SOUND_VOICE_STORAGE_KEY] || '').trim();
        updateDashboardSoundButton();
        resolve();
      }
    );
  });

  if (
    'speechSynthesis' in window &&
    typeof window.speechSynthesis.addEventListener === 'function'
  ) {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      refreshDashboardVoices();
      updateDashboardSoundButton();
    });
  }

  button.addEventListener('click', () => {
    refreshDashboardVoices();
    if (!dashboardVoices.length) {
      dashboardSoundEnabled = false;
      dashboardVoiceName = '';
      updateDashboardSoundButton();
      return;
    }

    if (!dashboardSoundEnabled) {
      dashboardSoundEnabled = true;
      const selectedVoice = getSelectedDashboardVoice();
      dashboardVoiceName = String(selectedVoice?.voiceURI || selectedVoice?.name || '').trim();
      chrome.storage.local.set({
        [DASHBOARD_SOUND_STORAGE_KEY]: true,
        [DASHBOARD_SOUND_VOICE_STORAGE_KEY]: dashboardVoiceName,
      });
      updateDashboardSoundButton();
      cancelDashboardVoiceQueue();
      speakDashboardVoiceMessage(
        selectedVoice
          ? `${normalizeDashboardVoiceDisplayName(selectedVoice.name)} voice on`
          : 'Voice alerts on',
        true
      );
      return;
    }

    const currentIndex = dashboardVoices.findIndex(
      (voice) =>
        String(voice?.voiceURI || voice?.name || '') === dashboardVoiceName ||
        String(voice?.name || '') === dashboardVoiceName
    );
    const nextIndex = currentIndex >= 0 ? currentIndex + 1 : preferredDashboardVoiceIndex();

    if (nextIndex >= 0 && nextIndex < dashboardVoices.length) {
      const nextVoice = dashboardVoices[nextIndex];
      dashboardSoundEnabled = true;
      dashboardVoiceName = String(nextVoice?.voiceURI || nextVoice?.name || '').trim();
      chrome.storage.local.set({
        [DASHBOARD_SOUND_STORAGE_KEY]: true,
        [DASHBOARD_SOUND_VOICE_STORAGE_KEY]: dashboardVoiceName,
      });
      updateDashboardSoundButton();
      cancelDashboardVoiceQueue();
      speakDashboardVoiceMessage(
        `${normalizeDashboardVoiceDisplayName(nextVoice.name)} voice on`,
        true
      );
      return;
    }

    dashboardSoundEnabled = false;
    dashboardVoiceName = '';
    chrome.storage.local.set({
      [DASHBOARD_SOUND_STORAGE_KEY]: false,
      [DASHBOARD_SOUND_VOICE_STORAGE_KEY]: '',
    });
    updateDashboardSoundButton();
    cancelDashboardVoiceQueue();
  });

  return settingsReady;
}
