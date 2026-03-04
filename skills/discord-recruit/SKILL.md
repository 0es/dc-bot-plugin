---
name: discord-recruit
description: Use the managed browser to find active members in a Discord guild channel and send them recruitment messages for the Gami gaming platform. Accesses Discord via the web UI to avoid bot detection.
metadata: {"openclaw": {"requires": {"config": ["browser.enabled"]}, "os": ["darwin"], "emoji": "🎮"}}
---

# Discord Recruitment via Browser

Use OpenClaw's managed browser to navigate Discord web and recruit users for the Gami gaming platform. This skill accesses Discord through a real browser session — never through a bot API — to avoid triggering Discord's automated detection systems.

## Prerequisites

- The managed browser must be running and logged into Discord (`browser.enabled: true` in config).
- You must be logged into Discord in the `openclaw` browser profile.
- You need the target Guild ID and Channel ID.

## How to Recruit: Step-by-Step

### Step 1 — Navigate to the target channel

Use the `browser` tool to open the channel URL:

```
https://discord.com/channels/{GUILD_ID}/{CHANNEL_ID}
```

Wait 2–3 seconds for the page to fully load before interacting.

### Step 2 — Collect active members from the channel

1. Look for the **member list panel** on the right side of the screen.
   - If not visible, click the **"Show Member List"** button (person icon) in the top-right toolbar.
2. Scroll through the member list slowly. Pause 1–2 seconds between scrolls to avoid rate limits.
3. Note down usernames of members who appear to be **active** (green/yellow dot) or have **recently sent messages** in the channel.
4. Avoid targeting:
   - Bots (usually have a "BOT" badge)
   - Users with "Do Not Disturb" status (red dot)
   - Server admins/moderators unless explicitly instructed

### Step 3 — Open a DM with each target user

For each target user:

1. Click on their **username or avatar** in the member list to open their profile card.
2. Click **"Send Message"** (or the message icon) on their profile card.
3. Wait 1–2 seconds for the DM window to open.
4. **Do not send immediately** — read Step 4 first.

### Step 4 — Send the recruitment message

Compose a personalized, natural-sounding message. Use the template below and adapt it to the user's apparent game interests if visible:

```
嗨！👋 我是 Gami 平台的招募专员。

Gami 是一个专注游戏陪玩的平台，我们正在招募热爱游戏的小伙伴加入我们的陪玩团队。

✨ 为什么选择 Gami？
• 灵活的工作时间，随时上线接单
• 公平的分成比例，按时结算
• 活跃的社区氛围，认识更多游戏圈朋友

如果你有兴趣了解更多，欢迎回复我！我可以详细介绍平台情况 🎮
```

**Important:** Vary the wording slightly between messages to avoid appearing automated. Change emoji positions, add different greetings, or reference their apparent game preference if visible on their profile.

### Step 5 — Anti-detection behavior

- Add a **random pause of 15–45 seconds** between sending DMs to different users.
- Do **not** send more than **10 DMs per hour** in a single session.
- If Discord shows a "You are sending messages too fast" warning, pause for at least **5 minutes** before continuing.
- If a CAPTCHA or verification prompt appears, stop the session and notify the user immediately.
- Prefer recruiting from channels where you have an existing presence (member of the server).

### Step 6 — Report results

After completing a recruitment session, summarize:
- How many users were contacted
- Usernames contacted (for tracking)
- Any errors or warnings encountered
- Suggested next action (wait time before next session, etc.)

## Example Usage

When a user asks you to "recruit from Discord server 123456789 channel 987654321", you should:

1. Call `discord_recruit` tool or begin the browser-based flow above.
2. Navigate to `https://discord.com/channels/123456789/987654321`.
3. Collect 5–10 active member names.
4. Send personalized DMs with appropriate delays.
5. Report back with results.

## Safety Notes

- Never send the same message text identically to more than 3 users in the same session.
- Never access channels you are not a member of.
- If Discord temporarily restricts the account, do not retry for at least 24 hours.
- This skill should only be used for legitimate recruitment on servers where recruiting is permitted.
