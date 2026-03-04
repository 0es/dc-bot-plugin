/**
 * Gami Discord Recruitment Plugin for OpenClaw
 *
 * All Discord communication is done through the managed browser via CDP —
 * no Discord bot token or Bot API is used. The plugin:
 *
 * 1. Polls Discord web (via Chrome DevTools Protocol) for new DMs.
 * 2. Calls the configured local LLM endpoint directly for each response.
 * 3. Sends replies by typing into the Discord web message box via CDP.
 * 4. Enforces a per-conversation turn limit; hands over to human after N turns.
 *
 * Exposes two agent tools:
 *   - discord_dm_reset  — re-enable AI for a conversation after human finishes
 *   - discord_dm_status — inspect current turn count for a channel
 */

import WebSocket from "ws";

// ── Types ──────────────────────────────────────────────────────────────────────

interface PluginConfig {
  /** Max AI turns before human takeover. Default: 5 */
  maxDmTurns?: number;
  /** Message sent to user on handover. */
  takeoverMessage?: string;
  /** How often to poll Discord for new DMs (ms). Default: 5000 */
  pollIntervalMs?: number;
  /** Chrome DevTools Protocol port for the openclaw browser profile. Default: 18800 */
  cdpPort?: number;
  /** Base URL for the OpenAI-compatible LLM. Default: http://192.168.8.201:8080/v1 */
  llmBaseUrl?: string;
  /** Model name to send to the LLM endpoint. Default: "default" */
  llmModel?: string;
  /** API key for the LLM endpoint (optional). Default: "not-required" */
  llmApiKey?: string;
  /** System prompt injected at the start of every new DM conversation. */
  systemPrompt?: string;
}

interface PluginApi {
  config?: { plugins?: { entries?: Record<string, { config?: PluginConfig }> } };
  registerTool: (
    tool: {
      name: string;
      description: string;
      parameters: object;
      execute: (
        id: string,
        params: Record<string, unknown>
      ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    },
    opts?: { optional?: boolean }
  ) => void;
  registerHook: (
    event: string,
    handler: (event: Record<string, unknown>) => Promise<void>,
    meta: { name: string; description: string }
  ) => void;
}

interface CDPTab {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface DiscordMessage {
  id: string;
  author: string;
  content: string;
}

interface UnreadDM {
  channelId: string;
  label: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
  maxDmTurns: 5,
  pollIntervalMs: 5000,
  cdpPort: 18800,
  llmBaseUrl: "http://192.168.8.201:8080/v1",
  llmModel: "default",
  llmApiKey: "not-required",
  takeoverMessage:
    "感谢您的耐心交流！我们的人工客服将接管后续沟通，为您提供更专业的服务。请稍候，工作人员将很快与您联系。🎮",
} as const;

const DEFAULT_SYSTEM_PROMPT = `你是 Gami 游戏陪玩平台的智能招募专员。

## 平台介绍
Gami 是专注游戏陪玩的平台，连接游戏玩家与专业陪玩师。
核心优势：灵活工作时间、公平分成机制、多游戏品类支持（LOL、王者荣耀、VALORANT等）、活跃社区。

## 对话规则
- 语气友好热情，像朋友间的对话
- 每条回复保持简洁（不超过150字），适度使用 emoji
- 聚焦招募话题，礼貌引导离题对话回正
- 不主动提供具体薪资数字（引导咨询人工客服）

## 常见问题参考
- 收入怎样？→ 引导联系人工客服了解详细分成
- 需要什么设备？→ 普通电脑 + 稳定网络即可
- 只会一款游戏行吗？→ 专精一款反而更受欢迎

## 加入条件
年满18岁、有游戏热情、擅长至少一款主流游戏、有良好沟通能力。`;

// ── CDP Session ───────────────────────────────────────────────────────────────

class CDPSession {
  private ws: WebSocket | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private nextId = 1;

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
      ws.on("message", (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            id?: number;
            result?: unknown;
            error?: unknown;
          };
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) reject(msg.error);
            else resolve(msg.result);
          }
        } catch {
          // ignore parse errors from CDP events
        }
      });
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP WebSocket not connected");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      (this.ws as WebSocket).send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown } };
    return result?.result?.value;
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

// ── Conversation Store ────────────────────────────────────────────────────────

interface Conversation {
  history: ChatMessage[];
  turns: number;
  handedOver: boolean;
  lastSeenMsgId: string;
}

class ConversationStore {
  private store = new Map<string, Conversation>();

  get(channelId: string): Conversation {
    if (!this.store.has(channelId)) {
      this.store.set(channelId, {
        history: [],
        turns: 0,
        handedOver: false,
        lastSeenMsgId: "",
      });
    }
    return this.store.get(channelId)!;
  }

  addUserMessage(channelId: string, content: string, systemPrompt: string) {
    const conv = this.get(channelId);
    if (conv.history.length === 0 && systemPrompt) {
      conv.history.push({ role: "system", content: systemPrompt });
    }
    conv.history.push({ role: "user", content });
  }

  addAssistantMessage(channelId: string, content: string) {
    const conv = this.get(channelId);
    conv.history.push({ role: "assistant", content });
    conv.turns++;
  }

  reset(channelId: string) {
    this.store.delete(channelId);
  }

  summary(channelId: string): { turns: number; handedOver: boolean } {
    const conv = this.get(channelId);
    return { turns: conv.turns, handedOver: conv.handedOver };
  }
}

// ── LLM Client ────────────────────────────────────────────────────────────────

async function callLLM(
  messages: ChatMessage[],
  cfg: Required<PluginConfig>
): Promise<string> {
  const res = await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.llmApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.llmModel,
      messages,
      stream: false,
      max_tokens: 512,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

// ── Discord DOM helpers (evaluated inside the browser page) ──────────────────

/**
 * Returns a list of DM channels that have an unread indicator.
 * Evaluated inside the Discord tab via Runtime.evaluate.
 */
const GET_UNREAD_DMS_JS = `
(function () {
  try {
    var results = [];
    // DM sidebar can be keyed by aria-label or data-list-id
    var sidebar =
      document.querySelector('[aria-label="Direct Messages"]') ||
      document.querySelector('[data-list-id="private-channels"]');
    if (!sidebar) return results;

    var links = sidebar.querySelectorAll('a[href*="/channels/@me/"]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var m = link.href.match(/\\/channels\\/@me\\/(\\d+)/);
      if (!m) continue;
      var channelId = m[1];
      // Unread badge: Discord adds a small badge element for unread counts
      var badge =
        link.querySelector('[class*="numberBadge"]') ||
        link.querySelector('[class*="unreadBadge"]') ||
        link.querySelector('[class*="badge"]');
      if (!badge) continue;
      var label =
        link.getAttribute('aria-label') ||
        (link.querySelector('[class*="name"]') || {}).textContent ||
        channelId;
      results.push({ channelId: channelId, label: label.trim() });
    }
    return results;
  } catch (e) {
    return [];
  }
})()
`;

/**
 * Returns messages in the current channel that appear after lastSeenId.
 * If lastSeenId is empty, returns only the last visible message (to avoid
 * replying to old backlog on first run).
 * Evaluated inside the Discord tab via Runtime.evaluate.
 */
function buildGetMessagesJS(lastSeenId: string): string {
  const escaped = JSON.stringify(lastSeenId);
  return `
(function (lastSeenId) {
  try {
    var results = [];
    var list = document.querySelector('[data-list-id="chat-messages"]');
    if (!list) return results;

    var items = Array.from(list.querySelectorAll('li[id^="chat-messages-"]'));

    // First run (no lastSeenId): just record the latest message id without returning content
    if (!lastSeenId) {
      var last = items[items.length - 1];
      if (!last) return results;
      var idm = last.id.match(/chat-messages-\\d+-(\\d+)/);
      if (idm) results.push({ id: idm[1], author: '__INIT__', content: '' });
      return results;
    }

    var found = false;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var idMatch = item.id.match(/chat-messages-\\d+-(\\d+)/);
      if (!idMatch) continue;
      var msgId = idMatch[1];

      if (!found) {
        if (msgId === lastSeenId) found = true;
        continue;
      }

      var contentEl = item.querySelector('[id^="message-content-"]');
      var content = (contentEl || {}).textContent;
      if (!content || !content.trim()) continue;

      // Get author from message header (only present on first message of a group)
      var headerEl = item.querySelector('[class*="header"]');
      var authorEl = headerEl
        ? headerEl.querySelector('[class*="username"], [class*="nameTag"], h3 span')
        : null;
      var author = authorEl ? authorEl.textContent.trim() : '__continued__';

      results.push({ id: msgId, author: author, content: content.trim() });
    }
    return results;
  } catch (e) {
    return [];
  }
})(${escaped})
`;
}

// ── Discord Browser Poller ────────────────────────────────────────────────────

class DiscordBrowserPoller {
  private session: CDPSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Channels currently being processed to avoid concurrent replies */
  private processing = new Set<string>();
  /** Track the bot's own display name to skip self-messages */
  private selfName: string | null = null;

  constructor(
    private store: ConversationStore,
    private cfg: Required<PluginConfig>
  ) {}

  start() {
    console.log("[gami-discord] Browser poller starting (CDP port:", this.cfg.cdpPort, ")");
    // Run once immediately, then on interval
    this.poll().catch((e) => console.error("[gami-discord] Initial poll error:", e));
    this.timer = setInterval(() => {
      this.poll().catch((e) => console.error("[gami-discord] Poll error:", e));
    }, this.cfg.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.session?.close();
    this.session = null;
    console.log("[gami-discord] Browser poller stopped.");
  }

  private async getSession(): Promise<CDPSession> {
    if (this.session?.isOpen()) {
      // Ping to confirm it's still alive
      try {
        await this.session.evaluate("1");
        return this.session;
      } catch {
        this.session.close();
        this.session = null;
      }
    }

    const tabs = await this.fetchTabs();
    let discordTab = tabs.find((t) => t.url.includes("discord.com"));

    if (!discordTab) {
      console.log("[gami-discord] No Discord tab found — opening discord.com/channels/@me");
      discordTab = await this.openNewTab("https://discord.com/channels/@me");
      // Give the page time to load before connecting
      await sleep(3000);
      // Re-fetch tabs to get the WebSocket debugger URL
      const freshTabs = await this.fetchTabs();
      discordTab = freshTabs.find((t) => t.url.includes("discord.com")) ?? discordTab;
    }

    if (!discordTab?.webSocketDebuggerUrl) {
      throw new Error("Could not get Discord tab CDP WebSocket URL");
    }

    const sess = new CDPSession();
    await sess.connect(discordTab.webSocketDebuggerUrl);
    this.session = sess;
    return sess;
  }

  private async fetchTabs(): Promise<CDPTab[]> {
    const res = await fetch(`http://127.0.0.1:${this.cfg.cdpPort}/json`);
    if (!res.ok) throw new Error(`CDP HTTP error: ${res.status}`);
    return (await res.json()) as CDPTab[];
  }

  private async openNewTab(url: string): Promise<CDPTab> {
    const res = await fetch(
      `http://127.0.0.1:${this.cfg.cdpPort}/json/new?${encodeURIComponent(url)}`
    );
    return (await res.json()) as CDPTab;
  }

  private async poll() {
    let sess: CDPSession;
    try {
      sess = await this.getSession();
    } catch (e) {
      console.warn("[gami-discord] Browser not reachable:", (e as Error).message);
      return;
    }

    // Read self name once (to skip our own messages)
    if (!this.selfName) {
      this.selfName = (await sess.evaluate(
        `(document.querySelector('[class*="nameTag"] [class*="username"], [aria-label*="Logged in as"] strong') || {}).textContent || null`
      )) as string | null;
    }

    const unread = ((await sess.evaluate(GET_UNREAD_DMS_JS)) ?? []) as UnreadDM[];

    for (const dm of unread) {
      if (this.processing.has(dm.channelId)) continue;
      this.processing.add(dm.channelId);
      this.handleDM(sess, dm).finally(() => this.processing.delete(dm.channelId));
    }
  }

  private async handleDM(sess: CDPSession, dm: UnreadDM) {
    try {
      // Navigate to the DM channel if needed
      const currentUrl = (await sess.evaluate("location.href")) as string;
      if (!currentUrl.includes(dm.channelId)) {
        await sess.send("Page.navigate", {
          url: `https://discord.com/channels/@me/${dm.channelId}`,
        });
        await sleep(1800);
      }

      const conv = this.store.get(dm.channelId);
      const js = buildGetMessagesJS(conv.lastSeenMsgId);
      const messages = ((await sess.evaluate(js)) ?? []) as DiscordMessage[];

      if (messages.length === 0) return;

      // On first visit (init), just record the last seen ID and don't reply
      if (!conv.lastSeenMsgId && messages[0]?.author === "__INIT__") {
        conv.lastSeenMsgId = messages[0].id;
        return;
      }

      // Filter out our own messages and empty/system entries
      const userMessages = messages.filter(
        (m) =>
          m.content &&
          m.author !== "__INIT__" &&
          m.author !== "__continued__" &&
          (!this.selfName || !m.author.includes(this.selfName))
      );

      if (userMessages.length === 0) {
        // Still update lastSeenId to the latest message we saw
        conv.lastSeenMsgId = messages[messages.length - 1].id;
        return;
      }

      // Use the last user message in the batch
      const userMsg = userMessages[userMessages.length - 1];
      conv.lastSeenMsgId = messages[messages.length - 1].id;

      // Already handed over — remind the user
      if (conv.handedOver) {
        await this.sendMessage(sess, dm.channelId, this.cfg.takeoverMessage);
        return;
      }

      // Add user message to history
      this.store.addUserMessage(dm.channelId, userMsg.content, this.cfg.systemPrompt);

      // Check turn limit
      if (conv.turns >= this.cfg.maxDmTurns) {
        conv.handedOver = true;
        await this.sendMessage(sess, dm.channelId, this.cfg.takeoverMessage);
        console.log(`[gami-discord] Human takeover triggered for channel ${dm.channelId}`);
        return;
      }

      // Call LLM
      const reply = await callLLM(conv.history, this.cfg);
      if (!reply) return;

      this.store.addAssistantMessage(dm.channelId, reply);
      await this.sendMessage(sess, dm.channelId, reply);

      console.log(
        `[gami-discord] Replied to ${dm.label} (turn ${conv.turns}/${this.cfg.maxDmTurns})`
      );
    } catch (e) {
      console.error(`[gami-discord] Error handling DM ${dm.channelId}:`, e);
    }
  }

  private async sendMessage(sess: CDPSession, channelId: string, text: string) {
    // Ensure we're on the right channel
    const currentUrl = (await sess.evaluate("location.href")) as string;
    if (!currentUrl.includes(channelId)) {
      await sess.send("Page.navigate", {
        url: `https://discord.com/channels/@me/${channelId}`,
      });
      await sleep(1800);
    }

    // Focus the message box
    const focused = (await sess.evaluate(`
      (function () {
        var box = document.querySelector('[role="textbox"][contenteditable]');
        if (!box) return false;
        box.click();
        box.focus();
        return true;
      })()
    `)) as boolean;

    if (!focused) {
      console.warn("[gami-discord] Could not focus message box in channel", channelId);
      return;
    }

    await sleep(150);

    // Type the message using CDP Input.insertText (works with Discord's Slate editor)
    await sess.send("Input.insertText", { text });

    await sleep(200);

    // Press Enter to send
    await sess.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await sess.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });

    await sleep(400);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Plugin Entry ──────────────────────────────────────────────────────────────

export default function register(api: PluginApi) {
  const conversations = new ConversationStore();
  let poller: DiscordBrowserPoller | null = null;

  function resolveConfig(): Required<PluginConfig> {
    const raw =
      (api.config?.plugins?.entries?.["gami-discord-recruit"]?.config as PluginConfig) ?? {};
    return {
      maxDmTurns: raw.maxDmTurns ?? DEFAULTS.maxDmTurns,
      takeoverMessage: raw.takeoverMessage ?? DEFAULTS.takeoverMessage,
      pollIntervalMs: raw.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      cdpPort: raw.cdpPort ?? DEFAULTS.cdpPort,
      llmBaseUrl: raw.llmBaseUrl ?? DEFAULTS.llmBaseUrl,
      llmModel: raw.llmModel ?? DEFAULTS.llmModel,
      llmApiKey: raw.llmApiKey ?? DEFAULTS.llmApiKey,
      systemPrompt: raw.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    };
  }

  // ── Hook: gateway:startup — kick off the browser polling loop ──────────────
  api.registerHook(
    "gateway:startup",
    async () => {
      const cfg = resolveConfig();
      poller = new DiscordBrowserPoller(conversations, cfg);
      poller.start();
    },
    {
      name: "gami-discord.browser-poller-start",
      description:
        "Starts the Discord browser DM polling service when the OpenClaw gateway starts.",
    }
  );

  // ── Tool: discord_dm_reset ─────────────────────────────────────────────────
  api.registerTool(
    {
      name: "discord_dm_reset",
      description:
        "Reset the AI turn counter for a Discord DM channel. " +
        "Use after a human agent finishes handling the conversation to re-enable AI responses.",
      parameters: {
        type: "object",
        properties: {
          channelId: {
            type: "string",
            description: "Discord DM channel ID (numeric snowflake ID).",
          },
        },
        required: ["channelId"],
      },
      async execute(_id, params) {
        const channelId = params.channelId as string;
        conversations.reset(channelId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                reset: true,
                channelId,
                message: "Conversation reset. AI will respond again from turn 1.",
              }),
            },
          ],
        };
      },
    },
    { optional: true }
  );

  // ── Tool: discord_dm_status ────────────────────────────────────────────────
  api.registerTool(
    {
      name: "discord_dm_status",
      description:
        "Check the current AI turn count and handover status for a Discord DM channel.",
      parameters: {
        type: "object",
        properties: {
          channelId: {
            type: "string",
            description: "Discord DM channel ID to inspect.",
          },
        },
        required: ["channelId"],
      },
      async execute(_id, params) {
        const cfg = resolveConfig();
        const channelId = params.channelId as string;
        const { turns, handedOver } = conversations.summary(channelId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                channelId,
                turns,
                maxTurns: cfg.maxDmTurns,
                turnsRemaining: Math.max(0, cfg.maxDmTurns - turns),
                handedOver,
              }),
            },
          ],
        };
      },
    },
    { optional: true }
  );
}
