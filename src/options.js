// options.js — 설정 페이지

const SITES = [
  { key: 'chatgpt.com',        label: 'ChatGPT' },
  { key: 'claude.ai',          label: 'Claude' },
  { key: 'gemini.google.com',  label: 'Gemini' },
  { key: 'perplexity.ai',      label: 'Perplexity' }
];

// assets/sounds/ 에 있는 음원 파일 목록
// 파일 추가/삭제 시 여기만 수정하면 됨
const SOUND_FILES = [
  'default.wav',
  'bell1.mp3',
  'bell2.mp3',
  'bell3.mp3',
  'bell4.mp3',
  'coin.mp3',
  'ding.mp3',
  'honk1.mp3',
  'honk2.mp3',
  'honk3.mp3',
  'honk4.mp3',
  'water_drop.mp3'
];

// 확장자 제거 → 표시 이름
const soundLabel = (f) => f.replace(/\.[^.]+$/, '');

const DEFAULT_SOUNDS = {
  'chatgpt.com':        'default.wav',
  'claude.ai':          'default.wav',
  'gemini.google.com':  'default.wav',
  'perplexity.ai':      'default.wav'
};

// ─── DOM ──────────────────────────────────────────────────────

const $volume      = document.getElementById('volume');
const $volumeValue = document.getElementById('volumeValue');
const $alwaysNotify = document.getElementById('alwaysNotify');
const $soundsContainer = document.getElementById('soundsContainer');

// ─── 사이트별 소리 UI 생성 ───────────────────────────────────

function buildSoundRows(currentSounds) {
  $soundsContainer.innerHTML = '';

  for (const site of SITES) {
    const row = document.createElement('div');
    row.className = 'sound-row';

    const label = document.createElement('span');
    label.className = 'site-label';
    label.textContent = site.label;

    const select = document.createElement('select');
    select.dataset.site = site.key;

    for (const file of SOUND_FILES) {
      const opt = document.createElement('option');
      opt.value = file;
      opt.textContent = soundLabel(file);
      if (currentSounds[site.key] === file) opt.selected = true;
      select.appendChild(opt);
    }

    // "없음" 항상 마지막
    const noneOpt = document.createElement('option');
    noneOpt.value = 'none';
    noneOpt.textContent = '🔇 없음';
    if (currentSounds[site.key] === 'none') noneOpt.selected = true;
    select.appendChild(noneOpt);

    select.addEventListener('change', () => {
      saveSounds();
    });

    const previewBtn = document.createElement('button');
    previewBtn.className = 'preview-btn';
    previewBtn.textContent = '▶';
    previewBtn.title = '미리듣기';
    previewBtn.addEventListener('click', () => {
      const val = select.value;
      if (val === 'none') return;
      chrome.runtime.sendMessage({ type: 'PLAY_TEST_SOUND', site: site.key });
    });

    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(previewBtn);
    $soundsContainer.appendChild(row);
  }
}

function saveSounds() {
  const sounds = {};
  for (const select of $soundsContainer.querySelectorAll('select')) {
    sounds[select.dataset.site] = select.value;
  }
  chrome.storage.sync.set({ sounds });
}

// ─── 설정 로드 ───────────────────────────────────────────────

chrome.storage.sync.get({
  volume: 0.7,
  alwaysNotify: true,
  sounds: DEFAULT_SOUNDS
}, (s) => {
  $volume.value = s.volume;
  $volumeValue.textContent = Math.round(s.volume * 100) + '%';
  $alwaysNotify.checked = s.alwaysNotify;
  buildSoundRows(s.sounds);
});

// ─── 이벤트 핸들러 ──────────────────────────────────────────

$volume.addEventListener('input', () => {
  const v = parseFloat($volume.value);
  $volumeValue.textContent = Math.round(v * 100) + '%';
  chrome.storage.sync.set({ volume: v });
});

$alwaysNotify.addEventListener('change', () => {
  chrome.storage.sync.set({ alwaysNotify: $alwaysNotify.checked });
});

// ─── Discord Webhook ────────────────────────────────────────

const DEFAULT_DISCORD_SITES = {
  'chatgpt.com': true, 'claude.ai': true,
  'gemini.google.com': true, 'perplexity.ai': true
};

const $discordEnabled       = document.getElementById('discordEnabled');
const $discordUrl           = document.getElementById('discordUrl');
const $discordTestBtn       = document.getElementById('discordTestBtn');
const $discordStatus        = document.getElementById('discordStatus');
const $discordSitesContainer = document.getElementById('discordSitesContainer');
const $discordPreview       = document.getElementById('discordPreview');
const $discordPreviewLength = document.getElementById('discordPreviewLength');
const $discordErrors        = document.getElementById('discordErrors');
const $discordClearErrors   = document.getElementById('discordClearErrors');
const $debugLogs            = document.getElementById('debugLogs');

// ── 로드 ──

chrome.storage.sync.get({
  discordEnabled: false,
  discordWebhookUrl: '',
  discordSites: DEFAULT_DISCORD_SITES,
  discordPreview: true,
  discordPreviewLength: 200,
  debugLogs: false
}, (s) => {
  $discordEnabled.checked = s.discordEnabled;
  $discordUrl.value = s.discordWebhookUrl;
  $discordPreview.checked = s.discordPreview;
  $discordPreviewLength.value = s.discordPreviewLength;
  $debugLogs.checked = Boolean(s.debugLogs);
  buildDiscordSiteRows(s.discordSites);
});

loadDiscordErrors();

// ── 사이트별 Discord ON/OFF ──

function buildDiscordSiteRows(currentSites) {
  $discordSitesContainer.innerHTML = '';

  for (const site of SITES) {
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    label.style.marginBottom = '6px';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.site = site.key;
    checkbox.checked = currentSites[site.key] !== false;

    checkbox.addEventListener('change', saveDiscordSites);

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` ${site.label}`));
    $discordSitesContainer.appendChild(label);
  }
}

function saveDiscordSites() {
  const discordSites = {};
  for (const cb of $discordSitesContainer.querySelectorAll('input[type="checkbox"]')) {
    discordSites[cb.dataset.site] = cb.checked;
  }
  chrome.storage.sync.set({ discordSites });
}

// ── 기본 설정 이벤트 ──

$discordEnabled.addEventListener('change', () => {
  chrome.storage.sync.set({ discordEnabled: $discordEnabled.checked });
});

let urlSaveTimer;
$discordUrl.addEventListener('input', () => {
  clearTimeout(urlSaveTimer);
  urlSaveTimer = setTimeout(() => {
    chrome.storage.sync.set({ discordWebhookUrl: $discordUrl.value.trim() });
  }, 500);
});

$discordPreview.addEventListener('change', () => {
  chrome.storage.sync.set({ discordPreview: $discordPreview.checked });
});

$discordPreviewLength.addEventListener('change', () => {
  const val = Math.max(50, Math.min(500, parseInt($discordPreviewLength.value) || 200));
  $discordPreviewLength.value = val;
  chrome.storage.sync.set({ discordPreviewLength: val });
});


$debugLogs.addEventListener('change', () => {
  chrome.storage.sync.set({ debugLogs: $debugLogs.checked });
  showDiscordStatus($debugLogs.checked ? '디버그 로그 활성화됨' : '디버그 로그 비활성화됨', false);
});

// ── 테스트 전송 ──

$discordTestBtn.addEventListener('click', () => {
  const url = $discordUrl.value.trim();
  if (!url) {
    showDiscordStatus('Webhook URL을 입력하세요', true);
    return;
  }
  if (!url.startsWith('https://discord.com/api/webhooks/')) {
    showDiscordStatus('올바른 Discord Webhook URL이 아닙니다', true);
    return;
  }

  chrome.storage.sync.set({ discordWebhookUrl: url });
  $discordTestBtn.disabled = true;
  $discordTestBtn.textContent = '전송 중...';
  chrome.runtime.sendMessage({ type: 'TEST_DISCORD', webhookUrl: url });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'TEST_DISCORD_RESULT') return;
  $discordTestBtn.disabled = false;
  $discordTestBtn.textContent = '📤 테스트 전송';

  if (msg.ok) {
    showDiscordStatus('✓ 전송 성공! Discord 채널을 확인하세요', false);
  } else {
    showDiscordStatus(`✗ 전송 실패 (${msg.status || msg.error})`, true);
  }
});

function showDiscordStatus(text, isError) {
  $discordStatus.textContent = text;
  $discordStatus.className = 'discord-status ' + (isError ? 'err' : 'ok');
  setTimeout(() => { $discordStatus.textContent = ''; }, 5000);
}

// ── 에러 로그 ──

function loadDiscordErrors() {
  chrome.storage.local.get({ discordErrors: [] }, ({ discordErrors }) => {
    if (discordErrors.length === 0) {
      $discordErrors.textContent = '에러 없음';
      $discordErrors.style.color = '#888';
    } else {
      $discordErrors.textContent = discordErrors.join('\n');
      $discordErrors.style.color = '#f44336';
      $discordErrors.style.whiteSpace = 'pre-wrap';
    }
  });
}

$discordClearErrors.addEventListener('click', () => {
  chrome.storage.local.set({ discordErrors: [] });
  $discordErrors.textContent = '에러 없음';
  $discordErrors.style.color = '#888';
});
