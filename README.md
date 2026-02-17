# shut your reels down — LLM Answer Notifier
*Stop doomscrolling. Start working.*

## 목적

여러 LLM에 질문을 던지고 다른 작업을 하다가, 답변이 완료되면 **사이트별로 다른 알림음**으로 어떤 모델이 끝났는지 바로 알 수 있게 하는 것.

## 지원 플랫폼

| 사이트 | DOM 감지 | 네트워크 감지 | Heartbeat | 비고 |
|---|---|---|---|---|
| ChatGPT | ✅ | ✅ `/backend-api/f/conversation` | — | Hidden 탭에서도 DOM 동작 |
| Claude | ✅ | ✅ `/api/*/completion` | ✅ | Hidden 탭에서 DOM 멈춤 |
| Gemini | ✅ | ✅ `StreamGenerate*` | ✅ | 페이지 로드 grace 5초 |
| Perplexity | ✅ | ✅ `/rest/sse/perplexity_ask*` | ✅ | 페이지 로드 grace 5초 |

## 아키텍처

```
┌─ Content Script (탭마다 독립) ─────────────────────┐
│  detector (사이트별)  →  engine.js (상태머신)       │
│  isGenerating() / getLastResponseText()             │
│                                                     │
│  상태 흐름:                                          │
│  IDLE → GENERATING → SETTLING → DONE → IDLE         │
│              ↑ flickering ↓                          │
│           GENERATING ← SETTLING                      │
└──────────────────────────────────────────────────────┘
        ↕ 메시지                    ↕ 메시지
┌─ Background (Service Worker) ────────────────────────┐
│  네트워크 감지 (webRequest)                           │
│  Heartbeat/Pacemaker (hidden 탭 대응)                │
│  탭별 쿨다운 (중복 알림 방지)                         │
│  사이트별 알림음 선택 → Offscreen 소리 재생           │
└──────────────────────────────────────────────────────┘
        ↕ 메시지
┌─ Offscreen Document ─────────────────────────────────┐
│  Audio 재생 전용 (Service Worker에서 직접 불가)       │
└──────────────────────────────────────────────────────┘
```

### 감지 전략: DOM + 네트워크 이중 감지

- **DOM 감지**: Content Script가 Stop 버튼, streaming 클래스 등을 MutationObserver + polling으로 감시
- **네트워크 감지**: Background가 webRequest API로 스트리밍 HTTP 요청 완료를 감지
- **왜 둘 다?**: Chrome은 hidden 탭에서 setTimeout/setInterval을 throttle함. Claude, Gemini 등은 탭을 떠나면 DOM이 얼어붙어 Content Script만으로는 감지 불가. 네트워크 감지가 이를 보완.

### 중복 알림 방지

1. **탭별 쿨다운** (`tabCooldown`): 같은 탭에서 5초 내 중복 재생 방지
2. **NETWORK_DONE 메시지**: 네트워크가 먼저 알림을 울리면 Content Script에 알려 상태 리셋
3. **네트워크 억제 기간** (`NET_SUPPRESS_MS`): 네트워크 알림 후 10초간 Content Script의 모든 감지 억제 → 탭 복귀 시 DOM flickering에 의한 재감지 방지

### 멀티탭 동시 지원

- 모든 추적이 `tabId` 또는 `requestId` 기반으로 독립
- 여러 LLM에 동시 질문 시 각각 별도로 감지 → 각각 알림

## 파일 구조

```
ai-answer-notifier/
├── manifest.json
├── assets/
│   ├── icons/          # 확장 아이콘 (16/48/128px)
│   └── sounds/         # 알림음 파일 (wav, mp3)
│       └── default.wav
└── src/
    ├── background.js   # Service Worker (네트워크 감지, heartbeat, 소리 재생)
    ├── offscreen.html  # Offscreen Document (오디오 재생용)
    ├── offscreen.js
    ├── options.html    # 설정 페이지 UI
    ├── options.js      # 설정 로직 (볼륨, 사이트별 알림음)
    └── content/
        ├── engine.js   # 공통 상태머신 엔진
        └── detectors/  # 사이트별 감지 로직
            ├── chatgpt.js
            ├── claude.js
            ├── gemini.js
            └── perplexity.js
```

## 옵션 설정

- **볼륨**: 0~100% 슬라이더
- **사이트별 알림음**: 각 사이트마다 다른 소리 선택 가능, "없음"으로 특정 사이트 알림 끄기
- **항상 알림**: 탭을 보고 있을 때도 알림 (기본 ON, 해제 시 다른 탭에 있을 때만)

### 알림음 추가 방법

1. `assets/sounds/`에 wav 또는 mp3 파일 넣기
2. `src/options.js`의 `SOUND_FILES` 배열에 파일명 추가
3. 확장 새로고침 → 옵션에서 선택 가능

## 해결한 주요 이슈

| 이슈 | 원인 | 해결 |
|---|---|---|
| Hidden 탭에서 감지 안 됨 | Chrome이 setTimeout throttle | 네트워크 감지 + Heartbeat(Pacemaker) |
| 알림 2번 울림 | 네트워크 + DOM 감지 양쪽에서 동시 트리거 | NETWORK_DONE 메시지 + 10초 억제 기간 |
| 페이지 로드 시 오감지 (Gemini) | 이전 답변 DOM + progress bar 잔존 | Init grace period 5초 |
| Gemini URL 패턴 불일치 | 멀티 계정 `/u/0/` 경로 | 추가 URL 패턴 등록 |
| 탭 복귀 시 재감지 | DOM이 깨어나며 isGenerating() flickering | NET_SUPPRESS_MS 10초 보호 |

## 앞으로 할 것

### 실사용 테스트 & 튜닝
- [ ] 사이트별 알림음 wav/mp3 파일 세팅
- [ ] 장시간 사용 시 안정성 확인 (메모리 누수, Service Worker 재시작 등)
- [ ] 새로운 LLM 사이트 추가 가능성 (Grok, DeepSeek 등)

### Discord Webhook 연동 (Step 6)
- [ ] 답변 완료 시 Discord 채널에 메시지 전송
- [ ] 전송 내용: 사이트명, 답변 미리보기(첫 N자), 타임스탬프
- [ ] 옵션 페이지에서 Webhook URL 설정
- [ ] 사이트별 ON/OFF

### 추가 개선 아이디어
- [ ] 답변 완료 시 브라우저 Notification API 알림 (소리 외 시각적 알림)
- [ ] 확장 아이콘 뱃지로 완료된 탭 수 표시
- [ ] 알림 히스토리 (최근 N개 답변 완료 로그)

## 버전 히스토리

- **v0.2.0** — 4개 플랫폼 지원, 사이트별 알림음, DOM+네트워크 이중 감지, 중복 알림 방지
- **v0.1.0** — ChatGPT DOM 감지 + 소리 재생 초기 버전
