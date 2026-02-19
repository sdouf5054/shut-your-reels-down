# LLM Answer Notifier — shut your reels down
*Stop doomscrolling. Start working.*

A lightweight browser extension that **plays a sound when an LLM finishes generating a response**—so you can stop watching the spinner and get back to work.

<p align="center">
  <img src="https://github.com/user-attachments/assets/72616a09-90e0-4a7f-817c-628058fe5679" width="260" height="598" alt="Screenshot 1">
  <img src="https://github.com/user-attachments/assets/36312bf3-e985-4b7b-ad69-0aa525383a52" width="246" height="500" alt="Screenshot 2">
</p>

## Supported Platforms

**ChatGPT**  
DOM detection works even in background tabs

**Claude, Gemini, Perplexity**  
Uses network detection when backgrounded

> This extension uses a **hybrid strategy (DOM + network)** because some sites stop rendering / throttle timers in hidden tabs.


## Key Features

- **Sound notification on completion** (per tab, per platform)
- **Multi-platform support**: ChatGPT, Claude, Gemini, Perplexity
- **Multi-tab aware**: detects multiple completions independently
- **Duplicate prevention**: cooldown + suppression window to avoid double pings
- **Options page**:
  - Volume control
  - Per-platform sound selection (or disable)


## Installation (Developer Mode)

### Chrome / Whale (Chromium-based)
1. Download or clone this repo.
2. Open your browser and go to:
   - Chrome: `chrome://extensions`
   - Whale: `whale://extensions`
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).
5. Open the extension **Options** page and press **Test sound**.

## Usage
1. Go to one of the supported platforms.
2. Send a prompt.
3. When the response finishes generating, you’ll hear a sound.

## Discord Push Notifications (Optional)

This is the simplest way to get **iPhone push** without running your own server.
The extension sends a message to a Discord channel via **Webhook**, and Discord delivers the push notification.

### Step 1 — Create a Discord Webhook
1. Create a **private Discord server** (or use an existing one).
2. Create a channel, e.g. `#ai-notify`.
3. Channel settings → **Integrations** → **Webhooks** → **New Webhook**.
4. Copy the **Webhook URL**.
<img width="600" height="600" alt="image" src="https://github.com/user-attachments/assets/b8ba4d94-bf96-4153-bd3d-e251da8786f3" />

### Step 2 — Connect in Extension Options
1. Open the extension **Options** page.
2. Paste the Webhook URL.
3. Click **Send test notification**.
4. Enable Discord notifications (global and/or per-platform).

### Notes
- Make sure the Discord channel/server is **not muted** and notifications are set to **All Messages**.
- On iPhone: Settings → Notifications → Discord → Allow Notifications.


## Privacy
- The extension runs locally in your browser.
- If Discord integration is enabled, it sends **minimal metadata** by default (e.g., platform name, tab title, timestamp).

## Troubleshooting
- **No sound?**
  - Check volume in Options.
  - Click **Test sound** in Options.
  - Some OS/browsers may block audio until you interact once—try clicking on the page and testing again.
- **Discord push not arriving?**
  - Verify webhook URL using **Send test notification**.
  - Ensure the channel/server isn’t muted and notifications are set to All Messages.
  - Check iPhone Focus / Do Not Disturb settings.
- **Duplicate sounds?**
  - This can happen when a platform triggers both DOM and network signals; the extension includes cooldown/suppression, but selectors may need updates after platform UI changes.

## Test Result Interpretation

When reviewing automated checks, use this quick guide:

- ✅ **`node --check ...` passed**
  - Good sign. JavaScript files are syntactically valid.
  - This does **not** guarantee runtime behavior in Chrome, but it confirms there are no parse errors.

- ✅ **`manifest.json` parse test passed**
  - Good sign. The JSON structure is valid.
  - This does **not** validate Chrome permission semantics, only JSON format.

- ⚠️ **Playwright/browser-container `ERR_FILE_NOT_FOUND` for `file:///.../options.html`**
  - Usually an environment limitation, **not** necessarily a code bug.
  - It means the browser runner could not access your local repository path directly.

### Recommended fallback verification

1. Reload extension in `chrome://extensions`.
2. Open Options page from the extension card.
3. Toggle settings (including debug logs), click save/test actions.
4. Confirm behavior in service worker console (`chrome://extensions` → service worker inspect).

## TODO
- [ ] Language support (especially English)
- [ ] Support notifications for other app integrations (image generation, music/playlist creation & linking)
- [ ] Publish to Chrome Web Store

## License
MIT
