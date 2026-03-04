---
name: discord-recruit
description: Use the managed browser to find active members in a Discord guild channel and send them recruitment DMs for the Gami gaming platform. Accesses Discord via the web UI to avoid bot detection. DM replies are handled automatically by the plugin — this skill only covers outbound recruitment.
metadata: {"openclaw": {"requires": {"config": ["browser.enabled"]}, "os": ["darwin"], "emoji": "🎮"}}
---

# Discord Outbound Recruitment via Browser

Send recruitment messages to active members in a Discord server channel on behalf of Gami.

**Important:** This skill handles **outbound** recruitment only (finding users and sending the first message). Once a user replies, the plugin's CDP polling loop takes over the conversation automatically — you do not need to monitor or reply to DMs.

---

## Which approach to use?

| Scenario | Recommended approach |
|----------|---------------------|
| Recruit using a **specific bot / OpenClaw node** | Use the `discord_recruit` **agent tool** (see below) |
| Recruit using the **local browser** only | Follow the manual browser steps further below |

---

## Approach A — `discord_recruit` tool (recommended)

Use this when you want to target a specific bot whose browser session lives on a remote OpenClaw node.

### Step 1 — Check available bots

```
List all Discord bots and their nodes
```

Calls `discord_bots_list`. Note the `id` of the bot whose node you want to use.

### Step 2 — Call `discord_recruit`

Parameters:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `botId` | Yes (if multiple bots) | Bot ID from `discord_bots_list` |
| `guildId` | Yes | Discord server ID |
| `channelId` | Yes | Channel to scan for active members |
| `count` | No | How many users to contact (default 5, max 10) |
| `message` | No | Custom DM text; omit to rotate built-in Gami templates |

**Example:**

> "用 bot-node2 在服务器 123456789 的 987654321 频道里给 5 个活跃用户发招新消息"

This will:
1. Open a new Chrome tab on `bot-node2`'s node
2. Navigate to the channel, find online/idle members
3. Click each member → open DM → send the message
4. Return a report: `{ contacted, skipped, errors }`

### Rate limit reminder

- Max **10 DMs per session** (enforced by the `count` cap)
- The tool automatically waits **15–45 seconds** between DMs
- Do not run multiple sessions for the same bot within an hour

---

## Approach B — Manual browser steps (local bot only)

Use the managed browser tools when you want to operate the **local** Discord account directly (no `botId` targeting).

### Prerequisites

- Managed browser running and logged into Discord (`browser.enabled: true`).
- You need: Guild ID and Channel ID to recruit from.

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
