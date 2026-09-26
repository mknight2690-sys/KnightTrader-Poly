// KnightTrader: voice only for new opens/closes (position delta tracker in
// dashboard.js). Activity-log types like DCA/HOLD/recovery/signal stay silent.
export const DASHBOARD_SOUND_ACTIVITY_TYPES = new Set(['opened', 'closed']);

export const DASHBOARD_CLOSE_BLOCKED_VOICE_COOLDOWN_MS = 60 * 60 * 1000;

// Debounce for the "BloHunter signal disconnected" voice. SSE connections are routinely
// recycled (keep-alive cycling by the gateway / an upstream hop) and reconnect within seconds —
// announcing every brief blip is noise. Only speak the disconnect if it PERSISTS past this
// window; a faster self-healing reconnect stays silent (and so does its "restored" pair).
export const DASHBOARD_SIGNAL_DISCONNECT_VOICE_DEBOUNCE_MS = 20 * 1000;

export const DASHBOARD_VOICE_MESSAGES = {
  opened: 'Opened',
  dca: 'DCA made on',
  closed: 'Closed',
  'manual-close': 'Manual close.',
  'manual-add': 'Manual add on',
  'trade-risk-adjustment-executed': 'Risk adjustment executed for',
  'trade-risk-adjustment-retry': 'Risk adjustment delayed for',
  'trade-risk-adjustment-retry-abandoned': 'Risk adjustment abandoned for',
  'trade-state-hold': 'moved to HOLD protection',
  'hold-resumed-to-active': 'returned to active BloHunter control',
  'v3-metadata-reacquired': 'restored under active BloHunter signal',
  'close-blocked': 'close blocked under five percent, HOLD protection active',
  'close-blocked-recovery': 'close blocked under five percent, Recovery active',
  'recovery-armed': 'moved to Recovery',
  'recovery-step': 'Recovery step placed on',
  'recovery-reset': 'Recovery reset for',
  'recovery-resumed-to-server-management': 'left Recovery and returned to active BloHunter control',
  liquidated: 'Liquidation detected on',
  'apilock-blocked': 'Trading blocked by API lock',
  'apilock-restored': 'API lock restored, trading can resume',
  'awaiting-snapshot': 'Waiting for fresh BloHunter snapshot',
  'signal-failed': 'BloHunter signal disconnected',
  'signal-restored': 'BloHunter signal restored',
};

export const DASHBOARD_WELCOME_VOICE_MESSAGES = {
  active: 'Welcome to KnightTrader Blofin. Trading Active.',
  default: 'Welcome to KnightTrader Blofin.',
};

export const DASHBOARD_TRADING_VOICE_MESSAGES = {
  active: 'Trading Active.',
  suspended: 'Trading Suspended.',
};

export function isDashboardTradingActive(profile = {}) {
  const apilockBlocked =
    profile?.apilockViolated === true ||
    (profile?.apilockCountry && profile?.apilockReady === false);
  return profile?.tradingEnabled === true && profile?.signalConnected === true && !apilockBlocked;
}

const SPOKEN_ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];
const SPOKEN_TEENS = [
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const SPOKEN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

function spellWholeNumberForSpeech(value) {
  const n = Math.abs(Math.trunc(Number(value)));
  if (!Number.isFinite(n)) return '';
  if (n < 10) return SPOKEN_ONES[n];
  if (n < 20) return SPOKEN_TEENS[n - 10];
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0 ? SPOKEN_TENS[tens] : `${SPOKEN_TENS[tens]} ${SPOKEN_ONES[ones]}`;
  }
  return String(n);
}

// Convert a semantic version into a spoken phrase that voices EVERY numeric
// component, for any version length: "3.9.1" -> "three point nine point one",
// "3.9" -> "three point nine", "4" -> "four", "4.0.0" -> "four point oh point
// oh". A zero component after the major speaks as "oh" (version convention);
// the major itself spells normally. Stops at the first non-numeric component
// (so a "-beta" suffix or a trailing dot is ignored). Returns '' for an
// unparseable version so callers can omit the phrase entirely rather than
// speak something wrong. The runtime reads the version from the manifest, so
// this auto-tracks every bump (1, 2, or 3 components).
export function formatVersionForSpeech(version) {
  const parts = String(version || '')
    .trim()
    .split('.');
  const major = Number.parseInt(parts[0], 10);
  if (!Number.isInteger(major)) return '';
  const words = [spellWholeNumberForSpeech(major)];
  for (let index = 1; index < parts.length; index += 1) {
    const component = Number.parseInt(parts[index], 10);
    if (!Number.isInteger(component)) break;
    words.push(component === 0 ? 'oh' : spellWholeNumberForSpeech(component));
  }
  return words.join(' point ');
}

export function getDashboardWelcomeVoiceMessage(profile = {}, version = '') {
  const tradingActive = isDashboardTradingActive(profile);
  const spokenVersion = formatVersionForSpeech(version);
  // Spoken order: greeting, then the version, then the trading state — e.g.
  // "Welcome to KnightTrader, three point seven, Trading Active." No "Version" word.
  // Falls back to the plain constants when there is no parseable version.
  if (!spokenVersion) {
    return tradingActive
      ? DASHBOARD_WELCOME_VOICE_MESSAGES.active
      : DASHBOARD_WELCOME_VOICE_MESSAGES.default;
  }
  return tradingActive
    ? `Welcome to KnightTrader, ${spokenVersion}, Trading Active.`
    : `Welcome to KnightTrader, ${spokenVersion}.`;
}

export function formatDashboardVoiceSymbolForSpeech(symbol = '') {
  const normalized = String(symbol || '')
    .trim()
    .toUpperCase();
  if (!normalized) return '';
  if (/^[A-Z]{1,3}$/.test(normalized)) {
    return normalized.split('').join(' ');
  }
  return `${normalized.charAt(0)}${normalized.slice(1).toLowerCase()}`;
}

export function getDashboardVoiceSymbol(entry) {
  return String(entry?.symbol || entry?.contract || entry?.instId || '')
    .replace(/-?USDT$/i, '')
    .trim()
    .toUpperCase();
}

export function getDashboardVoiceSide(entry) {
  const side = String(entry?.side || '')
    .trim()
    .toLowerCase();
  if (side === 'long' || side === 'short') return side;
  return '';
}

export function getDashboardCloseBlockedVoiceKey(entry = {}) {
  if (entry?.type !== 'close-blocked') return '';
  const symbol = getDashboardVoiceSymbol(entry);
  const side = getDashboardVoiceSide(entry);
  if (!symbol || !side) return '';
  const modeLower = String(entry?.managementMode || '').toLowerCase();
  const managementMode = modeLower === 'recovery' ? 'recovery' : 'hold';
  return `close-blocked:${symbol}:${side}:${managementMode}`;
}

export function shouldAnnounceDashboardActivityEntry(
  entry = {},
  closeBlockedVoiceTimes = new Map(),
  now = Date.now()
) {
  if (entry?.type !== 'close-blocked') return true;

  const key = getDashboardCloseBlockedVoiceKey(entry);
  if (!key) return true;

  // Bound the dedupe Map: any entry older than the cooldown window can no longer
  // suppress a future announce, so it is safe to evict. Keeps the dedupe behavior
  // identical for in-window entries while preventing unbounded growth.
  for (const [storedKey, storedAt] of closeBlockedVoiceTimes) {
    if (now - Number(storedAt || 0) >= DASHBOARD_CLOSE_BLOCKED_VOICE_COOLDOWN_MS) {
      closeBlockedVoiceTimes.delete(storedKey);
    }
  }

  const lastSpokenAt = Number(closeBlockedVoiceTimes.get(key) || 0);
  if (lastSpokenAt > 0 && now - lastSpokenAt < DASHBOARD_CLOSE_BLOCKED_VOICE_COOLDOWN_MS) {
    return false;
  }

  closeBlockedVoiceTimes.set(key, now);
  return true;
}

function getDashboardVoiceSubject(entry) {
  const symbol = getDashboardVoiceSymbol(entry);
  const spokenSymbol = formatDashboardVoiceSymbolForSpeech(symbol);
  const side = getDashboardVoiceSide(entry);
  return [spokenSymbol, side].filter(Boolean).join(' ').trim();
}

export function getDashboardVoiceCloseResult(entry) {
  if (entry?.type !== 'closed') return '';
  const execPnl = Number.parseFloat(entry?.execPnl);
  if (!Number.isFinite(execPnl)) return '';
  const direction = execPnl >= 0 ? 'up' : 'down';
  return `${direction} ${Math.abs(execPnl).toFixed(1)} percent`;
}

function isUpshiftVoiceEntry(entry = {}) {
  if (entry?.type !== 'opened' && entry?.type !== 'dca') return false;
  if (entry?.upshiftActive === true) return true;
  const upshiftSteps = Number.parseInt(entry?.upshiftSteps, 10);
  return Number.isFinite(upshiftSteps) && upshiftSteps > 0;
}

function isDownshiftVoiceEntry(entry = {}) {
  if (entry?.type !== 'opened' && entry?.type !== 'dca') return false;
  if (entry?.downshiftActive === true) return true;
  return String(entry?.sizingIntent || '').trim() === 'absolute_min_qty_multiplier';
}

function getOrderSizingVoiceSuffix(entry = {}) {
  if (entry?.type !== 'opened' && entry?.type !== 'dca') return '';
  const sizingDirection = String(entry?.sizingDirection || '').trim();
  if (sizingDirection === 'up') return 'Upshift';
  if (sizingDirection === 'down') return 'Downshift';
  if (isUpshiftVoiceEntry(entry)) return 'Upshift';
  if (isDownshiftVoiceEntry(entry)) return 'Downshift';
  return '';
}

function appendSizingVoiceSuffix(message = '', entry = {}) {
  const trimmed = String(message || '').trim();
  if (!trimmed) return '';
  const suffix = getOrderSizingVoiceSuffix(entry);
  return suffix ? `${trimmed}, ${suffix}` : trimmed;
}

export function getDashboardVoiceMessage(entry) {
  const type = String(entry?.type || '').trim();
  const subject = getDashboardVoiceSubject(entry);
  const closeResult = getDashboardVoiceCloseResult(entry);

  switch (type) {
    case 'opened':
      return appendSizingVoiceSuffix(
        subject ? `${DASHBOARD_VOICE_MESSAGES.opened} ${subject}` : DASHBOARD_VOICE_MESSAGES.opened,
        entry
      );
    case 'dca': {
      // A user-initiated manual add (+ button) gets its own line so it is
      // distinguishable from an automated DCA. Marker set in handleManualAdd.
      if (entry?.manualAdd === true) {
        return appendSizingVoiceSuffix(
          subject
            ? `${DASHBOARD_VOICE_MESSAGES['manual-add']} ${subject}`
            : DASHBOARD_VOICE_MESSAGES['manual-add'].replace(/\s+on$/i, ''),
          entry
        );
      }
      return appendSizingVoiceSuffix(
        subject
          ? `${DASHBOARD_VOICE_MESSAGES.dca} ${subject}`
          : DASHBOARD_VOICE_MESSAGES.dca.replace(/\s+on$/i, ''),
        entry
      );
    }
    case 'closed': {
      // A user-initiated manual close (✕ button) gets its own line. Marker set
      // in handleClose when detail.bypassLossFloor is true.
      const closedLead =
        entry?.manualClose === true
          ? DASHBOARD_VOICE_MESSAGES['manual-close']
          : DASHBOARD_VOICE_MESSAGES.closed;
      const base = subject ? `${closedLead} ${subject}` : closedLead;
      return appendSizingVoiceSuffix(closeResult ? `${base}, ${closeResult}` : base, entry);
    }
    case 'trade-risk-adjustment-executed':
    case 'trade-risk-adjustment-retry':
    case 'trade-risk-adjustment-retry-abandoned':
      if (!subject) return '';
      if (type === 'trade-risk-adjustment-retry') {
        return appendSizingVoiceSuffix(
          `${DASHBOARD_VOICE_MESSAGES[type]} ${subject}. Retry scheduled.`,
          entry
        );
      }
      return appendSizingVoiceSuffix(`${DASHBOARD_VOICE_MESSAGES[type]} ${subject}.`, entry);
    case 'trade-state-hold':
      return appendSizingVoiceSuffix(
        subject ? `${subject} ${DASHBOARD_VOICE_MESSAGES[type]}` : '',
        entry
      );
    case 'hold-resumed-to-active':
    case 'v3-metadata-reacquired':
    case 'recovery-resumed-to-server-management':
      return appendSizingVoiceSuffix(
        subject ? `${subject} ${DASHBOARD_VOICE_MESSAGES[type]}` : DASHBOARD_VOICE_MESSAGES[type],
        entry
      );
    case 'close-blocked': {
      const recoveryManaged = String(entry?.managementMode || '').toLowerCase() === 'recovery';
      return appendSizingVoiceSuffix(
        subject
          ? `${subject} ${
              recoveryManaged
                ? DASHBOARD_VOICE_MESSAGES['close-blocked-recovery']
                : DASHBOARD_VOICE_MESSAGES['close-blocked']
            }`
          : '',
        entry
      );
    }
    case 'recovery-armed':
      return appendSizingVoiceSuffix(
        subject ? `${subject} ${DASHBOARD_VOICE_MESSAGES[type]}` : '',
        entry
      );
    case 'recovery-step':
      return appendSizingVoiceSuffix(
        subject
          ? `${DASHBOARD_VOICE_MESSAGES[type]} ${subject}`
          : DASHBOARD_VOICE_MESSAGES[type].replace(/\s+on$/i, ''),
        entry
      );
    case 'recovery-reset':
      return appendSizingVoiceSuffix(
        subject
          ? `${DASHBOARD_VOICE_MESSAGES[type]} ${subject}`
          : DASHBOARD_VOICE_MESSAGES[type].replace(/\s+for$/i, ''),
        entry
      );
    case 'liquidated':
      return appendSizingVoiceSuffix(
        subject
          ? `${DASHBOARD_VOICE_MESSAGES.liquidated} ${subject}`
          : DASHBOARD_VOICE_MESSAGES.liquidated.replace(/\s+on$/i, ''),
        entry
      );
    case 'apilock-blocked':
      return DASHBOARD_VOICE_MESSAGES['apilock-blocked'];
    case 'apilock-restored':
      return DASHBOARD_VOICE_MESSAGES['apilock-restored'];
    case 'awaiting-snapshot':
      return DASHBOARD_VOICE_MESSAGES['awaiting-snapshot'];
    case 'signal-failed':
      return DASHBOARD_VOICE_MESSAGES['signal-failed'];
    case 'signal-restored':
      return DASHBOARD_VOICE_MESSAGES['signal-restored'];
    default:
      return '';
  }
}
