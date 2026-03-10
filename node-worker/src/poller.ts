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

/** After handling a DM, skip that channel in the unread list for this long to avoid re-entering every poll. */
const DM_COOLDOWN_MS = 20_000;

/**
 * Periodically connects to the local Chrome tab via CDP, checks for unread
 * DMs and the current DM (if the tab is on a channel), and sends AI-generated replies.
 *
 * A single CDPSession is reused across polls; if the connection drops it is
 * transparently re-established on the next poll cycle.
 */
export class DiscordBrowserPoller {
  private session: CDPSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly processing = new Set<string>();
  private readonly lastHandledAt = new Map<string, number>();
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

    const unread = ((await sess.evaluate(GET_UNREAD_DMS_JS)) ?? []) as UnreadDM[];
    if (unread.length > 0) {
      this.log.debug(`Found ${unread.length} unread DM channel(s)`);
    }

    const currentUrl = (await sess.evaluate("location.href")) as string;
    const currentDmMatch = currentUrl.match(/\/channels\/@me\/(\d+)/);
    const currentChannelId = currentDmMatch?.[1] ?? null;
    const seenIds = new Set(unread.map((d) => d.channelId));
    const channelsToProcess: UnreadDM[] = [...unread];
    if (
      currentChannelId &&
      !seenIds.has(currentChannelId) &&
      currentUrl.includes("discord.com")
    ) {
      channelsToProcess.push({
        channelId: currentChannelId,
        label: "(current)",
      });
      this.log.debug(`Including current DM channel ${currentChannelId} (page already open)`);
    }

    for (const dm of channelsToProcess) {
      if (this.processing.has(dm.channelId)) continue;
      const lastHandled = this.lastHandledAt.get(dm.channelId);
      if (
        lastHandled !== undefined &&
        Date.now() - lastHandled < DM_COOLDOWN_MS
      ) {
        this.log.debug(
          `Channel ${dm.channelId} (${dm.label}): skipping, cooldown (handled ${Math.round((Date.now() - lastHandled) / 1000)}s ago)`
        );
        continue;
      }
      this.processing.add(dm.channelId);
      this.handleDM(sess, dm).finally(() => {
        this.processing.delete(dm.channelId);
        this.lastHandledAt.set(dm.channelId, Date.now());
      });
    }
  }

  private async handleDM(sess: CDPSession, dm: UnreadDM): Promise<void> {
    const dbg = (msg: string, ...args: unknown[]) =>
      this.log.debug(`[handleDM ${dm.channelId} (${dm.label})] ${msg}`, ...args);
    try {
      dbg("getting current URL");
      const currentUrl = (await sess.evaluate("location.href")) as string;
      if (!currentUrl.includes(dm.channelId)) {
        dbg("navigating to channel (current URL does not match)", { currentUrl });
        await sess.send("Page.navigate", {
          url: `https://discord.com/channels/@me/${dm.channelId}`,
        });
        await sleep(1800);
        dbg("navigation sleep done");
      } else {
        dbg("already on channel, skip navigate");
      }

      dbg("loading conversation from store");
      const conv = this.store.get(dm.channelId);
      dbg("evaluating getMessages in page", { lastSeenMsgId: conv.lastSeenMsgId });
      const rawMessages = ((await sess.evaluate(
        buildGetMessagesJS(conv.lastSeenMsgId)
      )) ?? []) as Array<{ id: string; author: string; content: string }>;
      dbg("raw messages from page", { count: rawMessages.length, ids: rawMessages.map((m) => m.id) });

      if (rawMessages.length === 0) {
        dbg("no new messages, skip");
        return;
      }

      conv.lastSeenMsgId = rawMessages[rawMessages.length - 1].id;
      dbg("updated lastSeenMsgId", { lastSeenMsgId: conv.lastSeenMsgId });

      const messages: DiscordMessage[] = rawMessages.map((m) => ({
        ...m,
        isFromSelf: this.store.hasSentHash(dm.channelId, m.content),
      }));
      const fromOther = messages.filter(
        (m) => m.content && m.author !== "__continued__" && !m.isFromSelf
      );
      dbg("messages from other (non-self, with content)", {
        fromOtherCount: fromOther.length,
        authors: fromOther.map((m) => m.author),
      });
      if (fromOther.length === 0) {
        dbg("no messages from other user, skip");
        return;
      }

      const userMsg = fromOther[fromOther.length - 1];
      dbg("last user message", { id: userMsg.id, author: userMsg.author, contentPreview: userMsg.content.slice(0, 80) });

      // Handover mode: human agent is handling this conversation.
      if (conv.handedOver) {
        dbg("already handed over, re-sending takeover notice");
        this.store.addSentHash(dm.channelId, this.cfg.takeoverMessage);
        await this.sendMessage(sess, dm.channelId, this.cfg.takeoverMessage);
        return;
      }

      dbg("adding user message to store and building history");
      this.store.addUserMessage(dm.channelId, userMsg.content, this.cfg.systemPrompt);

      // Turn limit reached — hand over to human agent.
      if (conv.turns >= this.cfg.maxDmTurns) {
        dbg("turn limit reached, handing over to human", { turns: conv.turns, max: this.cfg.maxDmTurns });
        conv.handedOver = true;
        this.store.addSentHash(dm.channelId, this.cfg.takeoverMessage);
        await this.sendMessage(sess, dm.channelId, this.cfg.takeoverMessage);
        this.log.info(
          `Channel ${dm.channelId} (${dm.label}): turn limit reached — handing over to human`
        );
        return;
      }

      dbg("calling LLM", { historyLength: conv.history.length });
      const reply = await callLLM(conv.history, this.cfg);
      if (!reply) {
        this.log.warn(`Channel ${dm.channelId}: LLM returned empty reply`);
        return;
      }
      dbg("LLM reply received", { length: reply.length, preview: reply.slice(0, 80) });

      dbg("saving assistant message and sent hash, sending to Discord");
      this.store.addAssistantMessage(dm.channelId, reply);
      this.store.addSentHash(dm.channelId, reply);
      await this.sendMessage(sess, dm.channelId, reply);

      this.log.info(
        `Replied to "${dm.label}" (${dm.channelId}) — turn ${conv.turns}/${this.cfg.maxDmTurns}`
      );
      dbg("handleDM done");
    } catch (e) {
      this.log.error(`Error handling DM ${dm.channelId} (${dm.label}): ${(e as Error).message}`);
      dbg("handleDM error", { message: (e as Error).message });
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
