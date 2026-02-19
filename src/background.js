// background.js — Service Worker
// 담당: 소리 재생, heartbeat(pacemaker), 네트워크 기반 스트리밍 완료 감지

'use strict';

const P = '[AI-Notifier BG]';

let debugLogs = false;

function logDebug(...args) {
  if (!debugLogs) return;
  console.log(P, '[debug]', ...args);
}


function bgMsg(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

chrome.storage.sync.get({ debugLogs: false }, ({ debugLogs: enabled }) => {
  debugLogs = Boolean(enabled);
  console.log(P, `Debug logs ${debugLogs ? 'enabled' : 'disabled'}`);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.debugLogs) return;
  debugLogs = Boolean(changes.debugLogs.newValue);
  console.log(P, `Debug logs ${debugLogs ? 'enabled' : 'disabled'}`);
});

// ─── 사이트별 기본 알림음 ────────────────────────────────────

const DEFAULT_SOUNDS = {
  'chatgpt.com':        'default.wav',
  'claude.ai':          'default.wav',
  'gemini.google.com':  'default.wav',
  'perplexity.ai':      'default.wav'
};

// ─── 소리 재생 (Offscreen Document) ───────────────────────────

const OFFSCREEN_PATH = 'src/offscreen.html';
let offscreenInitPromise = null;

async function ensureOffscreen() {
  if (offscreenInitPromise) {
    await offscreenInitPromise;
    return;
  }

  const exists = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  if (exists.length > 0) return;

  offscreenInitPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play notification sound on LLM response completion'
  }).catch((err) => {
    // 동시 호출 경쟁으로 이미 생성된 경우는 무해
    if (!err?.message?.includes('Only a single offscreen document may be created')) {
      throw err;
    }
  }).finally(() => {
    offscreenInitPromise = null;
  });

  await offscreenInitPromise;
}

function normalizeSite(site) {
  if (!site) return site;
  if (site === 'www.perplexity.ai') return 'perplexity.ai';
  if (site === 'chat.openai.com') return 'chatgpt.com';
  return site;
}

async function playSound(site) {
  const normalizedSite = normalizeSite(site);

  const { volume, sounds } = await chrome.storage.sync.get({
    volume: 0.7,
    sounds: DEFAULT_SOUNDS
  });

  const soundFile = sounds[normalizedSite] || 'default.wav';

  // "none" → 이 사이트는 알림 꺼짐
  if (soundFile === 'none') {
    console.log(P, `Sound disabled for ${normalizedSite}`);
    return;
  }

  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'PLAY_SOUND', volume, soundFile });
}

// ─── Discord Webhook ─────────────────────────────────────────

const SITE_LABELS = {
  'chatgpt.com':        'ChatGPT',
  'claude.ai':          'Claude',
  'gemini.google.com':  'Gemini',
  'perplexity.ai':      'Perplexity'
};

const DEFAULT_DISCORD_SITES = {
  'chatgpt.com': true, 'claude.ai': true,
  'gemini.google.com': true, 'perplexity.ai': true
};

// ── 전송 큐 (rate limit 대응) ──
const discordQueue = [];
let discordBusy = false;

const DISCORD_MIN_INTERVAL_MS = 500;
const DISCORD_MAX_QUEUE = 30;
const DISCORD_MAX_RETRIES = 5;
const DISCORD_MAX_BACKOFF_MS = 30000;
const DISCORD_STALE_WARNING_MS = 120000;

async function processDiscordQueue() {
  if (discordBusy || discordQueue.length === 0) return;
  discordBusy = true;

  const job = discordQueue.shift();
  const queuedMs = Date.now() - (job.queuedAt || Date.now());
  logDebug(`Discord: dequeued ${job.siteLabel} (wait ${queuedMs}ms, remaining ${discordQueue.length})`);
  if (queuedMs > DISCORD_STALE_WARNING_MS) {
    console.log(P, `Discord: stale job warning (${queuedMs}ms, site: ${job.siteLabel})`);
  }

  try {
    const res = await fetch(job.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job.payload)
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      job.retries = (job.retries || 0) + 1;

      if (job.retries > DISCORD_MAX_RETRIES) {
        const errMsg = `rate limit retries exceeded (${job.siteLabel})`;
        console.log(P, `Discord: ${errMsg}`);
        saveDiscordError(errMsg);
      } else {
        const retryAfterMs = Math.ceil((data.retry_after || 0) * 1000);
        const backoffMs = Math.min(DISCORD_MAX_BACKOFF_MS, DISCORD_MIN_INTERVAL_MS * (2 ** job.retries));
        const waitMs = Math.max(retryAfterMs, backoffMs);
        console.log(P, `Discord: rate limited, waiting ${waitMs}ms (queue: ${discordQueue.length + 1}, retries: ${job.retries}, site: ${job.siteLabel})`);
        discordQueue.unshift(job); // 다시 맨 앞에
        discordBusy = false;
        setTimeout(processDiscordQueue, waitMs);
        return;
      }
    } else if (!res.ok) {
      const errMsg = `HTTP ${res.status}`;
      console.log(P, `Discord: ${errMsg}`);
      saveDiscordError(errMsg);
    } else {
      console.log(P, `Discord: sent (${job.siteLabel})`);
      logDebug(`Discord: delivered ${job.siteLabel} (retries: ${job.retries || 0})`);
    }
  } catch (err) {
    console.log(P, 'Discord: fetch error', err.message);
    logDebug(`Discord: fetch error detail (site: ${job.siteLabel}, retries: ${job.retries || 0})`);
    saveDiscordError(err.message);
  }

  discordBusy = false;
  if (discordQueue.length > 0) {
    logDebug(`Discord: scheduling next job (queue: ${discordQueue.length})`);
    setTimeout(processDiscordQueue, DISCORD_MIN_INTERVAL_MS);
  }
}

function saveDiscordError(msg) {
  const entry = `${formatTime(new Date())} — ${msg}`;
  chrome.storage.local.get({ discordErrors: [] }, ({ discordErrors }) => {
    discordErrors.push(entry);
    if (discordErrors.length > 10) discordErrors.shift(); // 최근 10개만
    chrome.storage.local.set({ discordErrors });
  });
}


function getPreviewFromTab(tabId) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve('');
      return;
    }

    chrome.tabs.sendMessage(tabId, { type: 'GET_LATEST_PREVIEW' }, (res) => {
      if (chrome.runtime.lastError) {
        logDebug(`Discord: preview unavailable from tab ${tabId} (${chrome.runtime.lastError.message})`);
        resolve('');
        return;
      }
      resolve(typeof res?.preview === 'string' ? res.preview : '');
    });
  });
}

async function sendDiscord(site, tabTitle, timestamp, preview, tabId) {
  const normalizedSite = normalizeSite(site);

  const settings = await chrome.storage.sync.get({
    discordWebhookUrl: '',
    discordEnabled: false,
    discordSites: DEFAULT_DISCORD_SITES,
    discordPreview: true,
    discordPreviewLength: 200
  });

  if (!settings.discordEnabled || !settings.discordWebhookUrl) return;
  if (!settings.discordWebhookUrl.startsWith('https://discord.com/api/webhooks/')) return;

  // 사이트별 ON/OFF
  if (settings.discordSites[normalizedSite] === false) {
    console.log(P, `Discord: disabled for ${normalizedSite}`);
    return;
  }

  const siteLabel = SITE_LABELS[normalizedSite] || normalizedSite;
  const time = formatTime(new Date(timestamp));

  let content = bgMsg('discordCompletionMessage', [siteLabel, tabTitle, time]);

  let previewText = preview || '';
  if (settings.discordPreview && !previewText) {
    previewText = await getPreviewFromTab(tabId);
  }

  // 미리보기 추가
  if (settings.discordPreview && previewText) {
    const trimmed = previewText.slice(0, settings.discordPreviewLength).replace(/\n{3,}/g, '\n\n').trim();
    if (trimmed) {
      content += `\n>>> ${trimmed}`;
      if (previewText.length > settings.discordPreviewLength) content += '…';
    }
  }

  const queueKey = `${normalizedSite}|${tabTitle}|${previewText ? previewText.slice(0, 80) : ''}`;

  // 동일 메시지가 큐에 이미 있으면 최신 정보로 덮어씀
  const existing = discordQueue.find((job) => job.queueKey === queueKey);
  if (existing) {
    existing.queuedAt = Date.now();
    existing.payload = { username: 'shut your reels down', content };
    logDebug(`Discord: coalesced ${siteLabel} (queue: ${discordQueue.length})`);
    return;
  }

  if (discordQueue.length >= DISCORD_MAX_QUEUE) {
    const dropped = discordQueue.shift();
    const dropMsg = `Discord queue full (${DISCORD_MAX_QUEUE}) — dropped oldest (${dropped?.siteLabel || 'unknown'})`;
    console.log(P, dropMsg);
    saveDiscordError(dropMsg);
  }

  // 큐에 추가
  discordQueue.push({
    url: settings.discordWebhookUrl,
    siteLabel,
    queueKey,
    queuedAt: Date.now(),
    retries: 0,
    payload: { username: 'shut your reels down', content }
  });

  logDebug(`Discord: enqueued ${siteLabel} (queue: ${discordQueue.length})`);
  processDiscordQueue();
}

// ─── 탭별 알림 쿨다운 (네트워크 ↔ Content Script 중복 방지) ──

const tabCooldown = new Map();
const TAB_COOLDOWN_MS = 5000;

function canNotify(tabId) {
  return Date.now() - (tabCooldown.get(tabId) || 0) >= TAB_COOLDOWN_MS;
}

function markNotified(tabId) {
  tabCooldown.set(tabId, Date.now());
}

// ─── Heartbeat (Pacemaker) ────────────────────────────────────

const heartbeats = new Map();

function startHeartbeat(tabId) {
  if (heartbeats.has(tabId)) return;
  console.log(P, `Heartbeat started (tab ${tabId})`);

  const timer = setInterval(() => {
    chrome.tabs.sendMessage(tabId, { type: 'PULSE' }).catch(() => {
      stopHeartbeat(tabId);
    });
  }, 1000);

  heartbeats.set(tabId, timer);
}

function stopHeartbeat(tabId) {
  const timer = heartbeats.get(tabId);
  if (!timer) return;
  clearInterval(timer);
  heartbeats.delete(tabId);
  console.log(P, `Heartbeat stopped (tab ${tabId})`);
}

// ─── 메시지 핸들러 ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;

  switch (msg.type) {
    case 'PLAY_TEST_SOUND':
      playSound(msg.site);
      break;

    case 'TEST_DISCORD': {
      // 옵션 페이지에서 테스트 전송 → 결과를 sendResponse로 반환
      const url = msg.webhookUrl;
      if (!url || !url.startsWith('https://discord.com/api/webhooks/')) {
        msg._sendResponse?.({ ok: false, error: 'Invalid URL' });
        break;
      }
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'shut your reels down',
          content: bgMsg('discordTestMessage')
        })
      }).then(res => {
        chrome.runtime.sendMessage({
          type: 'TEST_DISCORD_RESULT',
          ok: res.ok,
          status: res.status
        });
      }).catch(err => {
        chrome.runtime.sendMessage({
          type: 'TEST_DISCORD_RESULT',
          ok: false,
          error: err.message
        });
      });
      break;
    }

    case 'ANSWER_DONE':
      msg.site = normalizeSite(msg.site);
      console.log(P, 'Answer done:', msg.site, `(tab ${tabId})`);
      if (tabId && !canNotify(tabId)) {
        console.log(P, 'Skipped — tab cooldown active');
        break;
      }
      if (tabId) markNotified(tabId);
      playSound(msg.site);
      sendDiscord(msg.site, msg.tabTitle, msg.timestamp, msg.preview, tabId);
      break;

    case 'START_HEARTBEAT':
      if (tabId) startHeartbeat(tabId);
      break;

    case 'STOP_HEARTBEAT':
      if (tabId) stopHeartbeat(tabId);
      break;
  }
});

// ─── 네트워크 기반 스트리밍 완료 감지 ─────────────────────────

const STREAM_RULES = [
  { site: 'chatgpt.com', pattern: 'https://chatgpt.com/backend-api/f/conversation' },
  { site: 'chatgpt.com', pattern: 'https://chatgpt.com/backend-api/*/conversation' },
  { site: 'chat.openai.com', pattern: 'https://chat.openai.com/backend-api/f/conversation' },
  { site: 'chat.openai.com', pattern: 'https://chat.openai.com/backend-api/*/conversation' },
  { site: 'claude.ai', pattern: 'https://claude.ai/api/*/completion' },
  { site: 'gemini.google.com', pattern: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate*' },
  { site: 'gemini.google.com', pattern: 'https://gemini.google.com/u/*/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate*' },
  { site: 'perplexity.ai', pattern: 'https://www.perplexity.ai/rest/sse/perplexity_ask*' },
  { site: 'perplexity.ai', pattern: 'https://perplexity.ai/rest/sse/perplexity_ask*' }
];

const STREAM_URL_PATTERNS = [...new Set(STREAM_RULES.map((rule) => rule.pattern))];

const MIN_STREAM_DURATION_MS = 1000;
const pendingStreams = new Map();

function siteFromUrl(url) {
  for (const rule of STREAM_RULES) {
    if (url.includes(rule.site)) return normalizeSite(rule.site);
  }
  return null;
}

chrome.webRequest.onBeforeRequest.addListener(
  ({ tabId, url, requestId }) => {
    if (tabId < 0) return;
    const site = siteFromUrl(url);
    if (!site) return;
    pendingStreams.set(requestId, { tabId, startTime: Date.now(), site });
    logDebug(`${site} stream matched URL: ${url}`);
    console.log(P, `${site} stream started (tab ${tabId}, req ${requestId})`);
  },
  { urls: STREAM_URL_PATTERNS }
);

chrome.webRequest.onCompleted.addListener(
  ({ tabId, requestId }) => {
    const tracked = pendingStreams.get(requestId);
    if (!tracked) return;
    pendingStreams.delete(requestId);

    const duration = Date.now() - tracked.startTime;
    const { site } = tracked;

    if (duration < MIN_STREAM_DURATION_MS) return;
    if (!canNotify(tabId)) {
      console.log(P, `${site} stream ended — tab cooldown active (${duration}ms)`);
      return;
    }

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;

      chrome.storage.sync.get({ alwaysNotify: true }, ({ alwaysNotify }) => {
        if (!alwaysNotify && tab.active) {
          console.log(P, `${site} stream ended — tab active, CS handles (${duration}ms)`);
          return;
        }

        markNotified(tabId);
        console.log(P, `${site} stream ended (${duration}ms) — playing sound`);
        playSound(site);
        sendDiscord(site, tab.title, new Date().toISOString(), '', tabId);
        chrome.tabs.sendMessage(tabId, { type: 'NETWORK_DONE' }).catch(() => {});
      });
    });
  },
  { urls: STREAM_URL_PATTERNS }
);

chrome.webRequest.onErrorOccurred.addListener(
  ({ requestId }) => { pendingStreams.delete(requestId); },
  { urls: STREAM_URL_PATTERNS }
);

console.log(P, 'Service worker started');
