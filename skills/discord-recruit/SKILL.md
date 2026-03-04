---
name: discord-recruit
description: Use the managed browser to find active members in a Discord guild channel and send them recruitment DMs for the Gami gaming platform. Accesses Discord via the web UI to avoid bot detection. DM replies are handled automatically by the plugin — this skill only covers outbound recruitment.
metadata: {"openclaw": {"requires": {"config": ["browser.enabled"]}, "os": ["darwin"], "emoji": "🎮"}}
---

# Discord Outbound Recruitment via Browser

Use OpenClaw's managed browser to navigate Discord web and send recruitment messages to users for Gami.

**Important:** This skill handles **outbound** recruitment only (finding users and sending the first message). Once a user replies, the plugin's CDP polling loop takes over the conversation automatically — you do not need to monitor or reply to DMs.

## Prerequisites

- Managed browser running and logged into Discord (`browser.enabled: true`).
- The plugin is running (check: `openclaw plugins list` shows `gami-discord-recruit` enabled).
- You need: Guild ID (server ID) and Channel ID to recruit from.

## Recruitment Steps

### Step 1 — Navigate to the target channel

```
https://discord.com/channels/{GUILD_ID}/{CHANNEL_ID}
```

Wait 2–3 seconds for the page to fully load.

### Step 2 — Find active members

1. Open the **Member List** panel (person icon in the top-right toolbar if not visible).
2. Scroll slowly through the list. Pause 1–2 seconds between scrolls.
3. Note usernames of members with:
   - Green or yellow status dot (online/idle)
   - Recent messages visible in the channel
4. Skip: bots (BOT badge), red-dot (DND) users, and admins/moderators unless explicitly asked.

### Step 3 — Open DM and send recruitment message

For each target user:

1. Click their username/avatar → profile card appears.
2. Click **"Send Message"** (message icon on the profile card).
3. Wait 1–2 seconds for the DM window to open.
4. Compose a personalised message using the templates below, then press Enter.

**After sending the first message, do not stay in that DM.** The plugin will automatically detect the reply and handle the conversation.

### Step 4 — Message templates

Vary the wording between messages:

```
嗨！👋 我是 Gami 平台的招募专员。

Gami 是游戏陪玩平台，正在招募热爱游戏的小伙伴加入陪玩团队。

✨ 灵活接单 | 公平分成 | 活跃社区

有兴趣了解的话欢迎回复我！🎮
```

```
你好～ 我在帮 Gami 陪玩平台招募有游戏热情的小伙伴。

平台灵活、收益透明，很适合喜欢游戏的玩家 😊

感兴趣可以聊聊～
```

### Step 5 — Anti-detection behaviour

- Add a **15–45 second random pause** between each DM.
- Do **not** send more than **10 DMs per hour**.
- If Discord shows "You are sending too fast" — stop and wait 5+ minutes.
- If a CAPTCHA appears — stop immediately and notify the operator.
- Never send identical message text to more than 3 users in the same session.

### Step 6 — Report results

After completing a session, summarise:
- Number of users contacted and their usernames (for deduplication tracking)
- Any warnings or errors
- Recommended wait time before next session

## Example usage

> "在 Discord 服务器 123456789 的 987654321 频道里找5个活跃用户发招新消息"

1. Navigate to `https://discord.com/channels/123456789/987654321`
2. Identify 5 active members
3. Send personalised DMs with appropriate delays
4. Report back with usernames contacted
