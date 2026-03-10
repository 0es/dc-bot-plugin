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
4. Compose a **new** recruitment message (do not use a fixed template). Then send (e.g. type + Enter).
5. **Navigate back to the channel.** After sending, the browser stays on the DM page. You must go back to the channel page: navigate to `https://discord.com/channels/{GUILD_ID}/{CHANNEL_ID}` so you can continue with the next user. Do not stay in the DM — the node-worker will handle replies.

**Important:** Each send leaves you in that user’s DM. Always return to the channel URL before finding/contacting the next user.

### Step 5 — Composing the message (no fixed copy)

- **Do not use a fixed script.** Write a fresh, natural message each time.
- **Language:** Use **Indonesian (Bahasa Indonesia)** by default. If the target user’s profile or recent messages clearly use another language, you may use that language.
- **Tone:** Sound like a real person: friendly, short, casual. You may use filler words; avoid sounding like a bot or an official announcement.
- **Content:** Introduce Gami as a community with many skilled players (game pros); users can quickly find strong players to play with. Invite them to join or ask for more info.
- Vary the wording for every user — never send the same text to multiple people.

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
