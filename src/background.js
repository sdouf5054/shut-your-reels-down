// background.js — Service Worker
// 담당: 소리 재생, heartbeat(pacemaker), 네트워크 기반 스트리밍 완료 감지

'use strict';

const P = '[AI-Notifier BG]';

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

async function processDiscordQueue() {
  if (discordBusy || discordQueue.length === 0) return;
  discordBusy = true;

  const job = discordQueue.shift();

  try {
    const res = await fetch(job.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job.payload)
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const waitMs = Math.ceil((data.retry_after || 2) * 1000);
      console.log(P, `Discord: rate limited, waiting ${waitMs}ms (queue: ${discordQueue.length + 1})`);
      discordQueue.unshift(job); // 다시 맨 앞에
      discordBusy = false;
      setTimeout(processDiscordQueue, waitMs);
      return;
    }

    if (!res.ok) {
      const errMsg = `HTTP ${res.status}`;
      console.log(P, `Discord: ${errMsg}`);
      saveDiscordError(errMsg);
    } else {
      console.log(P, `Discord: sent (${job.siteLabel})`);
    }
  } catch (err) {
    console.log(P, 'Discord: fetch error', err.message);
    saveDiscordError(err.message);
  }

  discordBusy = false;
  if (discordQueue.length > 0) {
    setTimeout(processDiscordQueue, 500); // 최소 0.5초 간격
  }
}

function saveDiscordError(msg) {
  const entry = `${new Date().toLocaleTimeString('ko-KR')} — ${msg}`;
  chrome.storage.local.get({ discordErrors: [] }, ({ discordErrors }) => {
    discordErrors.push(entry);
    if (discordErrors.length > 10) discordErrors.shift(); // 최근 10개만
    chrome.storage.local.set({ discordErrors });
  });
}

async function sendDiscord(site, tabTitle, timestamp, preview) {
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
  const time = new Date(timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

  let content = `✅ **${siteLabel}** 답변 완료 — ${tabTitle} (${time})`;

  // 미리보기 추가
  if (settings.discordPreview && preview) {
    const trimmed = preview.slice(0, settings.discordPreviewLength).replace(/\n{3,}/g, '\n\n').trim();
    if (trimmed) {
      content += `\n>>> ${trimmed}`;
      if (preview.length > settings.discordPreviewLength) content += '…';
    }
  }

  // 큐에 추가
  discordQueue.push({
    url: settings.discordWebhookUrl,
    siteLabel,
    payload: { username: 'shut your reels down', content }
  });

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
          content: '🔔 테스트 메시지 — shut your reels down이 정상 연결되었습니다!'
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
      sendDiscord(msg.site, msg.tabTitle, msg.timestamp, msg.preview);
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

const STREAM_URL_PATTERNS = [
  'https://chatgpt.com/backend-api/f/conversation',
  'https://chatgpt.com/backend-api/*/conversation',
  'https://chat.openai.com/backend-api/f/conversation',
  'https://chat.openai.com/backend-api/*/conversation',
  'https://claude.ai/api/*/completion',
  'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate*',
  'https://gemini.google.com/u/*/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate*',
  'https://www.perplexity.ai/rest/sse/perplexity_ask*',
  'https://perplexity.ai/rest/sse/perplexity_ask*'
];

const MIN_STREAM_DURATION_MS = 1000;
const pendingStreams = new Map();

function siteFromUrl(url) {
  if (url.includes('chatgpt.com'))        return 'chatgpt.com';
  if (url.includes('chat.openai.com'))    return 'chat.openai.com';
  if (url.includes('claude.ai'))          return 'claude.ai';
  if (url.includes('gemini.google.com'))  return 'gemini.google.com';
  if (url.includes('perplexity.ai'))      return 'perplexity.ai';
  return null;
}

chrome.webRequest.onBeforeRequest.addListener(
  ({ tabId, url, requestId }) => {
    if (tabId < 0) return;
    const site = siteFromUrl(url);
    pendingStreams.set(requestId, { tabId, startTime: Date.now(), site });
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
        sendDiscord(site, tab.title, new Date().toISOString(), '');
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
