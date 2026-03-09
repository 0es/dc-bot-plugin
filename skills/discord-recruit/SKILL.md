---
name: discord-recruit
description: Use the node's managed browser to find active members in a Discord guild channel and send them recruitment DMs for the Gami gaming platform. Recruitment is controlled by the Gateway AI via browser tools (navigate, snapshot, act) on the node. DM replies are handled automatically by the node-worker — this skill only covers outbound recruitment.
metadata: {"openclaw": {"requires": {"config": ["browser.enabled"]}, "os": ["darwin"], "emoji": "🎮"}}
---

# Discord Outbound Recruitment via Node Browser

Send recruitment messages to active members in a Discord server channel on behalf of Gami.

**Architecture:** Recruitment is done by the **Gateway AI** by controlling the **node's browser** (navigate, snapshot, act). The **node-worker** on each bot machine only handles **replying to DMs** (CDP poll + local LLM); it does not run recruitment.

**Important:** This skill covers **outbound** recruitment only. Once a user replies, the node-worker's CDP polling loop handles the conversation automatically.

---

## How to recruit

Use the **browser tools** with the **node** that runs the target Discord account (the same machine that runs the node-worker for that bot).

### Step 1 — Check available bots and nodes

Call `discord_bots_list` to see configured bots and their worker URLs. Identify which **OpenClaw node** runs the browser for the bot you want to use (typically the node that has that workerUrl). When using browser tools, target that node so the browser is the one logged into the correct Discord account.

### Step 2 — Navigate to the target channel

Using the browser on that node:

- Navigate to: `https://discord.com/channels/{GUILD_ID}/{CHANNEL_ID}`
- Wait 2–3 seconds for the page to load.

### Step 3 — Find active members

1. Open the **Member List** panel (person icon in the top-right toolbar if not visible).
2. Scroll slowly through the list. Pause 1–2 seconds between scrolls.
3. Note usernames of members with:
   - Green or yellow status dot (online/idle)
   - Recent messages visible in the channel
4. Skip: bots (BOT badge), red-dot (DND) users, and admins/moderators unless explicitly asked.

### Step 4 — Open DM and send recruitment message

For each target user:

1. Click their username/avatar → profile card appears.
2. Click **"Send Message"** (message icon on the profile card).
3. Wait 1–2 seconds for the DM window to open.
4. Compose a message using the templates below, then send (e.g. type + Enter).

**After sending the first message, do not stay in that DM.** The node-worker will detect the reply and handle the conversation.

### Step 5 — Message templates

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

### Step 6 — Anti-detection behaviour

- Add a **15–45 second random pause** between each DM.
- Do **not** send more than **10 DMs per hour**.
- If Discord shows "You are sending too fast" — stop and wait 5+ minutes.
- If a CAPTCHA appears — stop immediately and notify the operator.
- Never send identical message text to more than 3 users in the same session.

### Step 7 — Report results

After completing a session, summarise:

- Number of users contacted and their usernames (for deduplication tracking)
- Any warnings or errors
- Recommended wait time before next session
