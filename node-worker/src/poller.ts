import {
  CDPSession,
  fetchTabs,
  openNewTab,
  rewriteWsHost,
  sendMessageRaw,
  sleep,
} from "./cdp.js";
import { GET_UNREAD_DMS_JS, buildGetMessagesJS } from "./discord-dom.js";
import { callLLM } from "./llm.js";
import { createLogger } from "./logger.js";
import type {
  DiscordMessage,
  Logger,
  UnreadDM,
  WorkerConfig,
} from "./types.js";
import type { ConversationStore } from "./store.js";

// ── Discord Browser Poller ────────────────────────────────────────────────────

/**
 * Periodically connects to the local Chrome tab via CDP, checks for unread
 * DMs, and sends AI-generated replies.
 *
 * A single CDPSession is reused across polls; if the connection drops it is
 * transparently re-established on the next poll cycle.
 */
export class DiscordBrowserPoller {
  private session: CDPSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly processing = new Set<string>();
  private selfName: string | null = null;
  private running = false;
  private readonly log: Logger;

  constructor(
    private readonly cfg: WorkerConfig,
    private readonly store: ConversationStore,
    baseLogger?: Logger
  ) {
    this.log = createLogger("poller", baseLogger);
  }

  start(): void {
    this.running = true;
    this.log.info(
      `Starting poller — CDP=${this.cfg.cdpHost}:${this.cfg.cdpPort}, ` +
        `poll every ${this.cfg.pollIntervalMs}ms`
    );
    this.poll().catch((e) => this.log.error(`Initial poll error: ${(e as Error).message}`));
    this.timer = setInterval(() => {
      this.poll().catch((e) => this.log.error(`Poll error: ${(e as Error).message}`));
    }, this.cfg.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.session?.close();
    this.session = null;
    this.log.info("Poller stopped.");
  }

  isRunning(): boolean {
    return this.running;
  }

  getSelfName(): string | null {
    return this.selfName;
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

    const tabs = await fetchTabs(this.cfg.cdpHost, this.cfg.cdpPort);
    let discordTab = tabs.find((t) => t.url.includes("discord.com"));

    if (!discordTab) {
      this.log.info("No Discord tab found — opening discord.com/channels/@me");
      discordTab = await openNewTab(
        this.cfg.cdpHost,
        this.cfg.cdpPort,
        "https://discord.com/channels/@me"
      );
      await sleep(3000);
      const freshTabs = await fetchTabs(this.cfg.cdpHost, this.cfg.cdpPort);
      discordTab = freshTabs.find((t) => t.url.includes("discord.com")) ?? discordTab;
    }

    if (!discordTab?.webSocketDebuggerUrl) {
      throw new Error("Could not obtain CDP WebSocket URL for Discord tab");
    }

    const wsUrl = rewriteWsHost(discordTab.webSocketDebuggerUrl, this.cfg.cdpHost);
    const sess = new CDPSession();
    await sess.connect(wsUrl);
    this.log.debug("CDP session established");
    this.session = sess;
    return sess;
  }

  private async poll(): Promise<void> {
    let sess: CDPSession;
    try {
      sess = await this.getSession();
    } catch (e) {
      this.log.warn(`Browser not reachable: ${(e as Error).message}`);
      return;
    }

    if (!this.selfName) {
      this.selfName = (await sess.evaluate(
        `(document.querySelector('[class*="nameTag"] [class*="username"], [aria-label*="Logged in as"] strong') || {}).textContent || null`
      )) as string | null;
      if (this.selfName) {
        this.log.debug(`Detected self username: "${this.selfName}"`);
      }
    }

    const unread = ((await sess.evaluate(GET_UNREAD_DMS_JS)) ?? []) as UnreadDM[];
    if (unread.length > 0) {
      this.log.debug(`Found ${unread.length} unread DM channel(s)`);
    }

    for (const dm of unread) {
      if (this.processing.has(dm.channelId)) continue;
      this.processing.add(dm.channelId);
      this.handleDM(sess, dm).finally(() => this.processing.delete(dm.channelId));
    }
  }

  private async handleDM(sess: CDPSession, dm: UnreadDM): Promise<void> {
    try {
      const currentUrl = (await sess.evaluate("location.href")) as string;
      if (!currentUrl.includes(dm.channelId)) {
        await sess.send("Page.navigate", {
          url: `https://discord.com/channels/@me/${dm.channelId}`,
        });
        await sleep(1800);
      }

      const conv = this.store.get(dm.channelId);
      const messages = ((await sess.evaluate(
        buildGetMessagesJS(conv.lastSeenMsgId)
      )) ?? []) as DiscordMessage[];

      if (messages.length === 0) return;

      // First visit: record the latest message ID as anchor and skip.
      if (!conv.lastSeenMsgId && messages[0]?.author === "__INIT__") {
        conv.lastSeenMsgId = messages[0].id;
        this.log.debug(
          `Channel ${dm.channelId} (${dm.label}): anchor set to msg ${conv.lastSeenMsgId}`
        );
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

      // Handover mode: human agent is handling this conversation.
      if (conv.handedOver) {
        this.log.debug(`Channel ${dm.channelId}: already handed over, re-sending takeover notice`);
        await this.sendMessage(sess, dm.channelId, this.cfg.takeoverMessage);
        return;
      }

      this.store.addUserMessage(dm.channelId, userMsg.content, this.cfg.systemPrompt);

      // Turn limit reached — hand over to human agent.
      if (conv.turns >= this.cfg.maxDmTurns) {
        conv.handedOver = true;
        await this.sendMessage(sess, dm.channelId, this.cfg.takeoverMessage);
        this.log.info(
          `Channel ${dm.channelId} (${dm.label}): turn limit reached — handing over to human`
        );
        return;
      }

      this.log.debug(`Calling LLM for channel ${dm.channelId}`);
      const reply = await callLLM(conv.history, this.cfg);
      if (!reply) {
        this.log.warn(`Channel ${dm.channelId}: LLM returned empty reply`);
        return;
      }

      this.store.addAssistantMessage(dm.channelId, reply);
      await this.sendMessage(sess, dm.channelId, reply);

      this.log.info(
        `Replied to "${dm.label}" (${dm.channelId}) — turn ${conv.turns}/${this.cfg.maxDmTurns}`
      );
    } catch (e) {
      this.log.error(`Error handling DM ${dm.channelId} (${dm.label}): ${(e as Error).message}`);
    }
  }

  private async sendMessage(
    sess: CDPSession,
    channelId: string,
    text: string
  ): Promise<void> {
    const currentUrl = (await sess.evaluate("location.href")) as string;
    if (!currentUrl.includes(channelId)) {
      await sess.send("Page.navigate", {
        url: `https://discord.com/channels/@me/${channelId}`,
      });
      await sleep(1800);
    }
    await sendMessageRaw(sess, text, (msg) => this.log.warn(msg));
  }
}
