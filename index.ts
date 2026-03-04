/**
 * Gami Discord Recruitment Plugin for OpenClaw
 *
 * All Discord communication is done through the managed browser via CDP —
 * no Discord bot token or Bot API is used.
 *
 * Supports multiple bots running in parallel, each on its own OpenClaw node
 * (or the local machine). Each bot has its own:
 *   - Chrome browser session (accessed via CDP)
 *   - Discord account (already logged in)
 *   - Conversation state store
 *   - Optional per-bot LLM / turn-limit overrides
 *
 * Configuration:
 *   plugins.entries.gami-discord-recruit.config.bots = [{ id, cdpHost, cdpPort, ... }]
 *
 * If `bots` is omitted, the plugin runs in single-bot mode using the
 * top-level cdpPort / cdpHost values (backward compatible).
 *
 * Agent tools:
 *   discord_bots_list  — list all configured bots and their status
 *   discord_dm_reset   — re-enable AI for a conversation after human finishes
 *   discord_dm_status  — inspect turn count / handover state for a channel
 */

import WebSocket from "ws";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Per-bot configuration; all fields except `id` are optional overrides. */
interface BotConfig {
  /** Unique identifier for this bot instance (used in tool calls and logs). */
  id: string;
  /** Human-readable label shown in logs and tool responses. */
  label?: string;
  /**
   * Hostname or IP of the OpenClaw node running this bot's browser.
   * Use "127.0.0.1" for the local machine (default).
   */
  cdpHost?: string;
  /** Chrome DevTools Protocol port on the node. Default: 18800 */
  cdpPort?: number;
  // ── Per-bot overrides for global settings ──
  maxDmTurns?: number;
  takeoverMessage?: string;
  systemPrompt?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
}

/** Top-level plugin configuration (all fields optional). */
interface PluginConfig {
  // ── Global defaults (used by all bots unless overridden) ──
  /** Max AI turns before human takeover. Default: 5 */
  maxDmTurns?: number;
  /** Message sent to user on handover. */
  takeoverMessage?: string;
  /** How often to poll Discord for new DMs (ms). Default: 5000 */
  pollIntervalMs?: number;
  /** Default CDP host for single-bot / fallback mode. Default: "127.0.0.1" */
  cdpHost?: string;
  /** Default CDP port for single-bot / fallback mode. Default: 18800 */
  cdpPort?: number;
  /** Base URL for the OpenAI-compatible LLM. Default: http://192.168.8.201:8080/v1 */
  llmBaseUrl?: string;
  /** Model name sent to the LLM endpoint. Default: "default" */
  llmModel?: string;
  /** API key for the LLM endpoint. Default: "not-required" */
  llmApiKey?: string;
  /** System prompt for new DM conversations. */
  systemPrompt?: string;
  /**
   * Multi-bot definitions.
   * If omitted, runs in single-bot mode using the global fields above.
   */
  bots?: BotConfig[];
}

/** Fully-resolved configuration for one bot (no optional fields). */
interface ResolvedBotConfig {
  id: string;
  label: string;
  cdpHost: string;
  cdpPort: number;
  pollIntervalMs: number;
  maxDmTurns: number;
  takeoverMessage: string;
  systemPrompt: string;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
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
  cdpHost: "127.0.0.1",
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
          // ignore CDP event frames without id
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
// Key format: "${botId}:${channelId}" — isolates each bot's conversations.

interface Conversation {
  history: ChatMessage[];
  turns: number;
  handedOver: boolean;
  lastSeenMsgId: string;
}

class ConversationStore {
  private store = new Map<string, Conversation>();

  private key(botId: string, channelId: string): string {
    return `${botId}:${channelId}`;
  }

  get(botId: string, channelId: string): Conversation {
    const k = this.key(botId, channelId);
    if (!this.store.has(k)) {
      this.store.set(k, { history: [], turns: 0, handedOver: false, lastSeenMsgId: "" });
    }
    return this.store.get(k)!;
  }

  addUserMessage(botId: string, channelId: string, content: string, systemPrompt: string) {
    const conv = this.get(botId, channelId);
    if (conv.history.length === 0 && systemPrompt) {
      conv.history.push({ role: "system", content: systemPrompt });
    }
    conv.history.push({ role: "user", content });
  }

  addAssistantMessage(botId: string, channelId: string, content: string) {
    const conv = this.get(botId, channelId);
    conv.history.push({ role: "assistant", content });
    conv.turns++;
  }

  reset(botId: string, channelId: string) {
    this.store.delete(this.key(botId, channelId));
  }

  summary(botId: string, channelId: string): { turns: number; handedOver: boolean } {
    const conv = this.get(botId, channelId);
    return { turns: conv.turns, handedOver: conv.handedOver };
  }

  /** List all active conversations for a given bot. */
  listForBot(botId: string): Array<{ channelId: string; turns: number; handedOver: boolean }> {
    const prefix = `${botId}:`;
    const results: Array<{ channelId: string; turns: number; handedOver: boolean }> = [];
    for (const [k, conv] of this.store) {
      if (k.startsWith(prefix)) {
        results.push({
          channelId: k.slice(prefix.length),
          turns: conv.turns,
          handedOver: conv.handedOver,
        });
      }
    }
    return results;
  }
}

// ── LLM Client ────────────────────────────────────────────────────────────────

async function callLLM(messages: ChatMessage[], cfg: ResolvedBotConfig): Promise<string> {
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

// ── Discord DOM helpers ───────────────────────────────────────────────────────

const GET_UNREAD_DMS_JS = `
(function () {
  try {
    var results = [];
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
      var badge =
        link.querySelector('[class*="numberBadge"]') ||
        link.querySelector('[class*="unreadBadge"]') ||
        link.querySelector('[class*="badge"]');
      if (!badge) continue;
      var label =
        link.getAttribute('aria-label') ||
        ((link.querySelector('[class*="name"]') || {}).textContent) ||
        channelId;
      results.push({ channelId: channelId, label: label.trim() });
    }
    return results;
  } catch (e) { return []; }
})()`;

function buildGetMessagesJS(lastSeenId: string): string {
  const escaped = JSON.stringify(lastSeenId);
  return `
(function (lastSeenId) {
  try {
    var results = [];
    var list = document.querySelector('[data-list-id="chat-messages"]');
    if (!list) return results;
    var items = Array.from(list.querySelectorAll('li[id^="chat-messages-"]'));
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
      if (!found) { if (msgId === lastSeenId) found = true; continue; }
      var contentEl = item.querySelector('[id^="message-content-"]');
      var content = (contentEl || {}).textContent;
      if (!content || !content.trim()) continue;
      var headerEl = item.querySelector('[class*="header"]');
      var authorEl = headerEl
        ? headerEl.querySelector('[class*="username"], [class*="nameTag"], h3 span')
        : null;
      var author = authorEl ? authorEl.textContent.trim() : '__continued__';
      results.push({ id: msgId, author: author, content: content.trim() });
    }
    return results;
  } catch (e) { return []; }
})(${escaped})`;
}

// ── CDP URL helper ────────────────────────────────────────────────────────────

/**
 * Chrome's CDP /json listing reports WebSocket URLs as ws://localhost:PORT/...
 * even when running on a remote machine.  We replace the host part so that our
 * WebSocket connection goes to the actual node IP instead of localhost.
 */
function rewriteWsHost(wsUrl: string, cdpHost: string): string {
  if (cdpHost === "127.0.0.1" || cdpHost === "localhost") return wsUrl;
  return wsUrl.replace(/^(ws:\/\/)(localhost|127\.0\.0\.1)/, `$1${cdpHost}`);
}

// ── Discord Browser Poller ────────────────────────────────────────────────────

class DiscordBrowserPoller {
  private session: CDPSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = new Set<string>();
  private selfName: string | null = null;
  private readonly tag: string;

  constructor(
    private readonly botCfg: ResolvedBotConfig,
    private readonly store: ConversationStore
  ) {
    this.tag = `[gami-discord:${botCfg.id}]`;
  }

  start() {
    console.log(
      `${this.tag} Starting poller — node ${this.botCfg.cdpHost}:${this.botCfg.cdpPort}`
    );
    this.poll().catch((e) => console.error(`${this.tag} Initial poll error:`, e));
    this.timer = setInterval(() => {
      this.poll().catch((e) => console.error(`${this.tag} Poll error:`, e));
    }, this.botCfg.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.session?.close();
    this.session = null;
    console.log(`${this.tag} Stopped.`);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async getSession(): Promise<CDPSession> {
    if (this.session?.isOpen()) {
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
      console.log(`${this.tag} No Discord tab — opening discord.com/channels/@me`);
      discordTab = await this.openNewTab("https://discord.com/channels/@me");
      await sleep(3000);
      const freshTabs = await this.fetchTabs();
      discordTab = freshTabs.find((t) => t.url.includes("discord.com")) ?? discordTab;
    }

    if (!discordTab?.webSocketDebuggerUrl) {
      throw new Error(`${this.tag} Could not get CDP WebSocket URL for Discord tab`);
    }

    const wsUrl = rewriteWsHost(discordTab.webSocketDebuggerUrl, this.botCfg.cdpHost);
    const sess = new CDPSession();
    await sess.connect(wsUrl);
    this.session = sess;
    return sess;
  }

  private async fetchTabs(): Promise<CDPTab[]> {
    const url = `http://${this.botCfg.cdpHost}:${this.botCfg.cdpPort}/json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CDP HTTP ${res.status} from ${url}`);
    return (await res.json()) as CDPTab[];
  }

  private async openNewTab(pageUrl: string): Promise<CDPTab> {
    const url = `http://${this.botCfg.cdpHost}:${this.botCfg.cdpPort}/json/new?${encodeURIComponent(pageUrl)}`;
    const res = await fetch(url);
    return (await res.json()) as CDPTab;
  }

  private async poll() {
    let sess: CDPSession;
    try {
      sess = await this.getSession();
    } catch (e) {
      console.warn(`${this.tag} Browser not reachable:`, (e as Error).message);
      return;
    }

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
      const currentUrl = (await sess.evaluate("location.href")) as string;
      if (!currentUrl.includes(dm.channelId)) {
        await sess.send("Page.navigate", {
          url: `https://discord.com/channels/@me/${dm.channelId}`,
        });
        await sleep(1800);
      }

      const conv = this.store.get(this.botCfg.id, dm.channelId);
      const messages = ((await sess.evaluate(buildGetMessagesJS(conv.lastSeenMsgId))) ??
        []) as DiscordMessage[];

      if (messages.length === 0) return;

      // First visit: record anchor message ID and exit without replying
      if (!conv.lastSeenMsgId && messages[0]?.author === "__INIT__") {
        conv.lastSeenMsgId = messages[0].id;
        return;
      }

      const userMessages = messages.filter(
        (m) =>
          m.content &&
          m.author !== "__INIT__" &&
          m.author !== "__continued__" &&
          (!this.selfName || !m.author.includes(this.selfName))
      );

      conv.lastSeenMsgId = messages[messages.length - 1].id;

      if (userMessages.length === 0) return;

      const userMsg = userMessages[userMessages.length - 1];

      // Already handed over
      if (conv.handedOver) {
        await this.sendMessage(sess, dm.channelId, this.botCfg.takeoverMessage);
        return;
      }

      this.store.addUserMessage(
        this.botCfg.id,
        dm.channelId,
        userMsg.content,
        this.botCfg.systemPrompt
      );

      // Check turn limit
      if (conv.turns >= this.botCfg.maxDmTurns) {
        conv.handedOver = true;
        await this.sendMessage(sess, dm.channelId, this.botCfg.takeoverMessage);
        console.log(`${this.tag} Human takeover for channel ${dm.channelId}`);
        return;
      }

      // Call LLM
      const reply = await callLLM(conv.history, this.botCfg);
      if (!reply) return;

      this.store.addAssistantMessage(this.botCfg.id, dm.channelId, reply);
      await this.sendMessage(sess, dm.channelId, reply);

      console.log(
        `${this.tag} Replied to "${dm.label}" — turn ${conv.turns}/${this.botCfg.maxDmTurns}`
      );
    } catch (e) {
      console.error(`${this.tag} Error handling DM ${dm.channelId}:`, e);
    }
  }

  private async sendMessage(sess: CDPSession, channelId: string, text: string) {
    const currentUrl = (await sess.evaluate("location.href")) as string;
    if (!currentUrl.includes(channelId)) {
      await sess.send("Page.navigate", {
        url: `https://discord.com/channels/@me/${channelId}`,
      });
      await sleep(1800);
    }

    const focused = (await sess.evaluate(`
      (function () {
        var box = document.querySelector('[role="textbox"][contenteditable]');
        if (!box) return false;
        box.click(); box.focus(); return true;
      })()`)) as boolean;

    if (!focused) {
      console.warn(`${this.tag} Could not focus message box in ${channelId}`);
      return;
    }

    await sleep(150);
    await sess.send("Input.insertText", { text });
    await sleep(200);
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

// ── Config resolution ─────────────────────────────────────────────────────────

function resolvePluginConfig(api: PluginApi): PluginConfig {
  return (api.config?.plugins?.entries?.["gami-discord-recruit"]?.config as PluginConfig) ?? {};
}

/**
 * Merge global defaults → plugin-level config → per-bot overrides
 * into a list of fully-resolved bot configs.
 */
function resolveBotConfigs(raw: PluginConfig): ResolvedBotConfig[] {
  const global: Required<Omit<ResolvedBotConfig, "id" | "label">> = {
    cdpHost: raw.cdpHost ?? DEFAULTS.cdpHost,
    cdpPort: raw.cdpPort ?? DEFAULTS.cdpPort,
    pollIntervalMs: raw.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
    maxDmTurns: raw.maxDmTurns ?? DEFAULTS.maxDmTurns,
    takeoverMessage: raw.takeoverMessage ?? DEFAULTS.takeoverMessage,
    systemPrompt: raw.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    llmBaseUrl: raw.llmBaseUrl ?? DEFAULTS.llmBaseUrl,
    llmModel: raw.llmModel ?? DEFAULTS.llmModel,
    llmApiKey: raw.llmApiKey ?? DEFAULTS.llmApiKey,
  };

  if (!raw.bots || raw.bots.length === 0) {
    // Single-bot fallback: treat global config as one bot
    return [{ id: "default", label: "Default Bot", ...global }];
  }

  return raw.bots.map((bot) => ({
    id: bot.id,
    label: bot.label ?? bot.id,
    cdpHost: bot.cdpHost ?? global.cdpHost,
    cdpPort: bot.cdpPort ?? global.cdpPort,
    pollIntervalMs: global.pollIntervalMs,
    maxDmTurns: bot.maxDmTurns ?? global.maxDmTurns,
    takeoverMessage: bot.takeoverMessage ?? global.takeoverMessage,
    systemPrompt: bot.systemPrompt ?? global.systemPrompt,
    llmBaseUrl: bot.llmBaseUrl ?? global.llmBaseUrl,
    llmModel: bot.llmModel ?? global.llmModel,
    llmApiKey: bot.llmApiKey ?? global.llmApiKey,
  }));
}

// ── Plugin Entry ──────────────────────────────────────────────────────────────

export default function register(api: PluginApi) {
  const store = new ConversationStore();
  /** botId → running poller */
  const pollers = new Map<string, DiscordBrowserPoller>();

  // ── Hook: gateway:startup ──────────────────────────────────────────────────
  api.registerHook(
    "gateway:startup",
    async () => {
      const raw = resolvePluginConfig(api);
      const botConfigs = resolveBotConfigs(raw);

      console.log(`[gami-discord] Starting ${botConfigs.length} bot(s)...`);
      for (const cfg of botConfigs) {
        const poller = new DiscordBrowserPoller(cfg, store);
        pollers.set(cfg.id, poller);
        poller.start();
      }
    },
    {
      name: "gami-discord.browser-poller-start",
      description: "Starts one Discord browser DM poller per configured bot on gateway startup.",
    }
  );

  // ── Tool: discord_bots_list ────────────────────────────────────────────────
  api.registerTool(
    {
      name: "discord_bots_list",
      description:
        "List all configured Discord bots, their node addresses, and the number of active conversations.",
      parameters: { type: "object", properties: {} },
      async execute(_id, _params) {
        const raw = resolvePluginConfig(api);
        const botConfigs = resolveBotConfigs(raw);
        const result = botConfigs.map((cfg) => ({
          id: cfg.id,
          label: cfg.label,
          node: `${cfg.cdpHost}:${cfg.cdpPort}`,
          running: pollers.has(cfg.id),
          maxDmTurns: cfg.maxDmTurns,
          llmBaseUrl: cfg.llmBaseUrl,
          llmModel: cfg.llmModel,
          activeConversations: store.listForBot(cfg.id),
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      },
    },
    { optional: true }
  );

  // ── Tool: discord_dm_reset ─────────────────────────────────────────────────
  api.registerTool(
    {
      name: "discord_dm_reset",
      description:
        "Reset the AI turn counter for a Discord DM channel on a specific bot. " +
        "Use after a human agent finishes the conversation to re-enable AI responses.",
      parameters: {
        type: "object",
        properties: {
          botId: {
            type: "string",
            description:
              "Bot ID to target. Use discord_bots_list to see available bots. " +
              'Omit to target the single bot (when only one is configured); use "default" as fallback.',
          },
          channelId: {
            type: "string",
            description: "Discord DM channel ID (numeric snowflake).",
          },
        },
        required: ["channelId"],
      },
      async execute(_id, params) {
        const channelId = params.channelId as string;
        const raw = resolvePluginConfig(api);
        const bots = resolveBotConfigs(raw);
        const botId =
          (params.botId as string | undefined) ?? (bots.length === 1 ? bots[0].id : undefined);
        if (!botId) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Multiple bots configured — please specify botId.",
                  availableBots: bots.map((b) => b.id),
                }),
              },
            ],
          };
        }
        store.reset(botId, channelId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                reset: true,
                botId,
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
        "Check the AI turn count and handover status for a Discord DM channel on a specific bot.",
      parameters: {
        type: "object",
        properties: {
          botId: {
            type: "string",
            description:
              "Bot ID to query. Omit when only one bot is configured.",
          },
          channelId: {
            type: "string",
            description: "Discord DM channel ID to inspect.",
          },
        },
        required: ["channelId"],
      },
      async execute(_id, params) {
        const channelId = params.channelId as string;
        const raw = resolvePluginConfig(api);
        const bots = resolveBotConfigs(raw);
        const botId =
          (params.botId as string | undefined) ?? (bots.length === 1 ? bots[0].id : undefined);
        if (!botId) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Multiple bots configured — please specify botId.",
                  availableBots: bots.map((b) => b.id),
                }),
              },
            ],
          };
        }
        const botCfg = bots.find((b) => b.id === botId);
        const { turns, handedOver } = store.summary(botId, channelId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                botId,
                channelId,
                turns,
                maxTurns: botCfg?.maxDmTurns ?? DEFAULTS.maxDmTurns,
                turnsRemaining: Math.max(0, (botCfg?.maxDmTurns ?? DEFAULTS.maxDmTurns) - turns),
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
