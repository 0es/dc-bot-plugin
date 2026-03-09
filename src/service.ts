import { resolvePluginConfig, resolveBotConfigs } from "./config.js";
import { createLogger, loggerFromEvent } from "./logger.js";
import { ConversationStore } from "./store.js";
import { DiscordBrowserPoller } from "./poller.js";
import { runRecruitSession } from "./recruit.js";
import { DEFAULTS } from "./constants.js";
import type { PluginApi, PluginLogger, ResolvedBotConfig } from "./types.js";

// ── Discord Service ───────────────────────────────────────────────────────────

/**
 * Encapsulates the full lifecycle of the Gami Discord plugin:
 * - Starts/stops one `DiscordBrowserPoller` per configured bot.
 * - Registers all agent tools against the OpenClaw plugin API.
 *
 * Call `service.start(event)` from a `gateway:startup` hook and
 * `service.stop(event)` from a `gateway:shutdown` hook.
 */
export class DiscordService {
  private readonly store = new ConversationStore();
  private readonly pollers = new Map<string, DiscordBrowserPoller>();
  private log: PluginLogger;

  constructor(private readonly api: PluginApi) {
    this.log = createLogger("gami-discord");
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(event: Record<string, unknown>): Promise<void> {
    this.log = createLogger("gami-discord", loggerFromEvent(event));

    const raw = resolvePluginConfig(this.api);
    const botConfigs = resolveBotConfigs(raw);

    this.log.info(`Starting ${botConfigs.length} bot poller(s)…`);

    for (const cfg of botConfigs) {
      if (this.pollers.has(cfg.id)) {
        this.log.warn(`Bot "${cfg.id}" already running — skipping duplicate start`);
        continue;
      }
      const poller = new DiscordBrowserPoller(cfg, this.store, this.log);
      this.pollers.set(cfg.id, poller);
      poller.start();
    }
  }

  async stop(event: Record<string, unknown>): Promise<void> {
    const log = createLogger("gami-discord", loggerFromEvent(event));
    log.info(`Stopping ${this.pollers.size} bot poller(s)…`);

    for (const [id, poller] of this.pollers) {
      poller.stop();
      log.debug(`Bot "${id}" stopped`);
    }
    this.pollers.clear();
  }

  // ── Tool registration ─────────────────────────────────────────────────────

  registerTools(): void {
    this.registerBotsListTool();
    this.registerDmResetTool();
    this.registerDmStatusTool();
    this.registerRecruitTool();
  }

  // ── Tool: discord_bots_list ───────────────────────────────────────────────

  private registerBotsListTool(): void {
    this.api.registerTool(
      {
        name: "discord_bots_list",
        description:
          "List all configured Discord bots, their node addresses, running state, " +
          "and the number of active DM conversations.",
        parameters: { type: "object", properties: {} },
        execute: async (_id, _params) => {
          const raw = resolvePluginConfig(this.api);
          const botConfigs = resolveBotConfigs(raw);
          const result = botConfigs.map((cfg) => ({
            id: cfg.id,
            label: cfg.label,
            node: `${cfg.cdpHost}:${cfg.cdpPort}`,
            running: this.pollers.has(cfg.id),
            maxDmTurns: cfg.maxDmTurns,
            llmBaseUrl: cfg.llmBaseUrl,
            llmModel: cfg.llmModel,
            activeConversations: this.store.listForBot(cfg.id),
          }));
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      },
      { optional: true }
    );
  }

  // ── Tool: discord_dm_reset ────────────────────────────────────────────────

  private registerDmResetTool(): void {
    this.api.registerTool(
      {
        name: "discord_dm_reset",
        description:
          "Reset the AI turn counter for a Discord DM channel on a specific bot. " +
          "Call this after a human agent finishes the conversation to re-enable AI responses.",
        parameters: {
          type: "object",
          properties: {
            botId: {
              type: "string",
              description:
                "Bot ID to target. Use discord_bots_list to see available bots. " +
                'Omit when only one bot is configured; use "default" as fallback.',
            },
            channelId: {
              type: "string",
              description: "Discord DM channel ID (numeric snowflake).",
            },
          },
          required: ["channelId"],
        },
        execute: async (_id, params) => {
          const channelId = params.channelId as string;
          const bots = resolveBotConfigs(resolvePluginConfig(this.api));
          const botId = this.resolveBotId(params.botId as string | undefined, bots);
          if (!botId) {
            return this.multipleBotsError(bots);
          }
          this.store.reset(botId, channelId);
          this.log.info(`DM reset: bot="${botId}" channel="${channelId}"`);
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
  }

  // ── Tool: discord_dm_status ───────────────────────────────────────────────

  private registerDmStatusTool(): void {
    this.api.registerTool(
      {
        name: "discord_dm_status",
        description:
          "Check the AI turn count and handover status for a Discord DM channel on a specific bot.",
        parameters: {
          type: "object",
          properties: {
            botId: {
              type: "string",
              description: "Bot ID to query. Omit when only one bot is configured.",
            },
            channelId: {
              type: "string",
              description: "Discord DM channel ID to inspect.",
            },
          },
          required: ["channelId"],
        },
        execute: async (_id, params) => {
          const channelId = params.channelId as string;
          const bots = resolveBotConfigs(resolvePluginConfig(this.api));
          const botId = this.resolveBotId(params.botId as string | undefined, bots);
          if (!botId) {
            return this.multipleBotsError(bots);
          }
          const botCfg = bots.find((b) => b.id === botId);
          const { turns, handedOver } = this.store.summary(botId, channelId);
          const maxTurns = botCfg?.maxDmTurns ?? DEFAULTS.maxDmTurns;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  botId,
                  channelId,
                  turns,
                  maxTurns,
                  turnsRemaining: Math.max(0, maxTurns - turns),
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

  // ── Tool: discord_recruit ─────────────────────────────────────────────────

  private registerRecruitTool(): void {
    this.api.registerTool(
      {
        name: "discord_recruit",
        description:
          "Send outbound recruitment DMs to active members in a Discord server channel, " +
          "using a specific bot's browser session on its designated OpenClaw node. " +
          "The bot navigates to the channel, finds online/idle members, opens each DM, " +
          "and sends a recruitment message. " +
          "Use discord_bots_list to see available bot IDs and their nodes.",
        parameters: {
          type: "object",
          properties: {
            botId: {
              type: "string",
              description:
                "Bot ID whose node/browser to use for recruitment. " +
                "Omit when only one bot is configured; use discord_bots_list to see options.",
            },
            guildId: {
              type: "string",
              description: "Discord server (guild) ID to recruit from.",
            },
            channelId: {
              type: "string",
              description: "Channel ID within the guild to find active members.",
            },
            count: {
              type: "number",
              description: "Number of users to contact in this session (default: 5, max: 10).",
            },
            message: {
              type: "string",
              description:
                "Custom recruitment message. Omit to rotate through built-in Gami templates.",
            },
          },
          required: ["guildId", "channelId"],
        },
        execute: async (_id, params) => {
          const guildId = params.guildId as string;
          const channelId = params.channelId as string;
          const count = Math.min(Math.max(1, (params.count as number | undefined) ?? 5), 10);
          const customMessage = params.message as string | undefined;

          const bots = resolveBotConfigs(resolvePluginConfig(this.api));
          const botId = this.resolveBotId(params.botId as string | undefined, bots);
          if (!botId) {
            return this.multipleBotsError(bots);
          }

          const botCfg = bots.find((b) => b.id === botId);
          if (!botCfg) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: `Bot "${botId}" not found in config.`,
                    availableBots: bots.map((b) => b.id),
                  }),
                },
              ],
            };
          }

          this.log.info(
            `Recruit session: bot="${botId}" guild="${guildId}" channel="${channelId}" count=${count}`
          );

          try {
            const result = await runRecruitSession(
              botCfg,
              guildId,
              channelId,
              count,
              customMessage,
              this.log
            );
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          } catch (e) {
            this.log.error(`Recruit session failed: ${(e as Error).message}`);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: (e as Error).message,
                    botId,
                    guildId,
                    channelId,
                  }),
                },
              ],
            };
          }
        },
      },
      { optional: true }
    );
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  /** Return botId from params, or auto-select when exactly one bot is configured. */
  private resolveBotId(
    paramBotId: string | undefined,
    bots: ResolvedBotConfig[]
  ): string | undefined {
    return paramBotId ?? (bots.length === 1 ? bots[0].id : undefined);
  }

  private multipleBotsError(bots: ResolvedBotConfig[]) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "Multiple bots configured — please specify botId.",
            availableBots: bots.map((b) => ({ id: b.id, label: b.label })),
          }),
        },
      ],
    };
  }
}
