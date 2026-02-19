// engine.js — 공통 감지 엔진
// detector(사이트별)가 먼저 로드되어 window.__AI_NOTIFIER_DETECTOR에 등록된 후 실행.
//
// 상태 흐름:
//   IDLE → GENERATING → SETTLING → DONE → IDLE
//                ↑ flickering ↓
//             GENERATING ← SETTLING
//
// 모든 시간 판정은 tick() 내에서 Date.now() 비교로 수행.
// (hidden 탭에서 setTimeout이 throttle되므로 setTimeout 사용하지 않음)

(function () {
  'use strict';

  const detector = window.__AI_NOTIFIER_DETECTOR;
  if (!detector) {
    console.warn('[AI-Notifier] No detector found. Aborting.');
    return;
  }

  // ─── 상수 ────────────────────────────────────────────────────

  const P = '[AI-Notifier]';
  const POLL_MS          = 500;   // 안전망 polling 주기
  const TEXT_STABLE_MS   = 1500;  // 텍스트 변화 없으면 완료 판정
  const COOLDOWN_MS      = 3000;  // DONE → IDLE 전이 대기
  const GRACE_MS         = 2000;  // 생성 신호 소멸 후 flickering 유예
  const NET_SUPPRESS_MS  = 10000; // 네트워크 알림 후 감지 억제

  // ─── 상태 ────────────────────────────────────────────────────

  let state            = 'IDLE';
  let lastNotifiedAt   = 0;

  // SETTLING phase
  let settleStartedAt  = 0;
  let settleGraceDone  = false;
  let stableText       = null;
  let stableCheckAt    = 0;

  // DONE phase
  let doneEnteredAt    = 0;

  // 네트워크 감지 보호
  let netDoneAt        = 0;

  // ─── 유틸리티 ────────────────────────────────────────────────

  const log = (...args) => console.log(P, ...args);

  function transition(to) {
    if (state === to) return;
    log(`State: ${state} → ${to}`);
    state = to;
  }

  // ─── Heartbeat (Pacemaker) ───────────────────────────────────

  const HEARTBEAT_SITES = ['claude.ai', 'gemini.google.com', 'perplexity.ai'];
  const needsHeartbeat  = detector.hostnames.some(h => HEARTBEAT_SITES.some(s => h.includes(s)));
  let heartbeatActive   = false;

  function startHeartbeat() {
    if (!needsHeartbeat || heartbeatActive) return;
    chrome.runtime.sendMessage({ type: 'START_HEARTBEAT' });
    heartbeatActive = true;
  }

  function stopHeartbeat() {
    if (!heartbeatActive) return;
    chrome.runtime.sendMessage({ type: 'STOP_HEARTBEAT' });
    heartbeatActive = false;
  }

  // ─── 메시지 수신 ────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PULSE') {
      tick();
    }
    if (msg.type === 'NETWORK_DONE') {
      log('Network handled notification — suppressing detection');
      stopHeartbeat();
      netDoneAt = Date.now();
      lastNotifiedAt = Date.now();
      state = 'IDLE';
    }
    if (msg.type === 'GET_LATEST_PREVIEW') {
      const text = detector.getLastResponseText();
      sendResponse({ preview: text ? text.slice(0, 500) : '' });
    }
  });

  // ─── 완료 처리 ──────────────────────────────────────────────

  function onDone() {
    const now = Date.now();

    if (now - lastNotifiedAt < COOLDOWN_MS) {
      log('Skipped: cooldown active');
      stopHeartbeat();
      transition('IDLE');
      return;
    }

    const text = detector.getLastResponseText();

    chrome.storage.sync.get({ alwaysNotify: true }, ({ alwaysNotify }) => {
      if (!alwaysNotify && document.visibilityState === 'visible') {
        log('Skipped: tab visible (alwaysNotify off)');
        stopHeartbeat();
        transition('IDLE');
        return;
      }

      lastNotifiedAt = now;
      stopHeartbeat();

      log('✅ Notification sent');
      log('   Site:', detector.hostnames[0], '| Length:', text?.length ?? 0);

      chrome.runtime.sendMessage({
        type: 'ANSWER_DONE',
        site: detector.hostnames[0],
        tabTitle: document.title,
        timestamp: new Date().toISOString(),
        preview: text ? text.slice(0, 500) : ''
      });

      transition('DONE');
      doneEnteredAt = now;
    });
  }

  // ─── 메인 tick ──────────────────────────────────────────────

  function tick() {
    const now = Date.now();

    // 네트워크 감지 후 보호 기간 — 모든 감지 억제
    if (now - netDoneAt < NET_SUPPRESS_MS) {
      if (state !== 'IDLE') state = 'IDLE';
      return;
    }

    const generating = detector.isGenerating();

    switch (state) {
      case 'IDLE':
        if (generating) {
          transition('GENERATING');
          startHeartbeat();
        }
        break;

      case 'GENERATING':
        if (!generating) {
          transition('SETTLING');
          settleStartedAt = now;
          settleGraceDone = false;
          stableText = null;
          stableCheckAt = 0;
        }
        break;

      case 'SETTLING':
        if (generating) {
          log('Signal flickered — returning to GENERATING');
          transition('GENERATING');
          settleGraceDone = false;
          break;
        }

        // Phase 1: flickering 유예
        if (!settleGraceDone) {
          if (now - settleStartedAt >= GRACE_MS) {
            settleGraceDone = true;
            log('Signal off confirmed — checking text stability');
            stableText = detector.getLastResponseText();
            stableCheckAt = now;
          }
          break;
        }

        // Phase 2: 텍스트 안정화
        if (now - stableCheckAt >= TEXT_STABLE_MS) {
          const current = detector.getLastResponseText();
          if (current === stableText) {
            onDone();
          } else {
            log('Text still changing — rechecking');
            stableText = current;
            stableCheckAt = now;
          }
        }
        break;

      case 'DONE':
        if (now - doneEnteredAt >= COOLDOWN_MS) {
          transition('IDLE');
        }
        if (generating) {
          transition('GENERATING');
          startHeartbeat();
        }
        break;
    }
  }

  // ─── 초기화 ─────────────────────────────────────────────────

  new MutationObserver(() => tick()).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-label', 'aria-busy', 'data-testid']
  });

  setInterval(tick, POLL_MS);

  log('Engine ready —', detector.hostnames.join(', '));
})();
