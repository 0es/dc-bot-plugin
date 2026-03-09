import { parsePluginConfig, resolveBotConfigs } from "./config.js";
import { createLogger } from "./logger.js";
import { ConversationStore } from "./store.js";
import { DiscordBrowserPoller } from "./poller.js";
import { runRecruitSession } from "./recruit.js";
import { DEFAULTS } from "./constants.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
  ResolvedBotConfig,
} from "./types.js";

// ── Service shape ─────────────────────────────────────────────────────────────

/** Extends OpenClawPluginService with a tool-registration step. */
export interface GamiDiscordService extends OpenClawPluginService {
  /** Call once in plugin.register() to expose all agent tools via the API. */
  registerTools(api: OpenClawPluginApi): void;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the Gami Discord service.
 *
 * Configuration is resolved once from `pluginConfig` (the value of
 * `api.pluginConfig` at plugin load time) and never re-read at runtime.
 * This mirrors the acpx pattern where config is owned by the service layer.
 */
export function createDiscordService(pluginConfig?: unknown): GamiDiscordService {
  const rawConfig = parsePluginConfig(pluginConfig);
  const botConfigs = resolveBotConfigs(rawConfig);

  const store = new ConversationStore();
  const pollers = new Map<string, DiscordBrowserPoller>();

  // Placeholder until start() supplies the real ctx.logger.
  let log: PluginLogger = createLogger("gami-discord");

  // ── Lifecycle ───────────────────────────────────────────────────────────

  const service: GamiDiscordService = {
    id: "gami-discord",

    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      log = createLogger("gami-discord", ctx.logger);
      log.info(
        `Starting ${botConfigs.length} bot poller(s) ` +
          `(workspaceDir: ${ctx.workspaceDir ?? "n/a"})`
      );

      for (const cfg of botConfigs) {
        if (pollers.has(cfg.id)) {
          log.warn(`Bot "${cfg.id}" already running — skipping duplicate start`);
          continue;
        }
        const poller = new DiscordBrowserPoller(cfg, store, log);
        pollers.set(cfg.id, poller);
        poller.start();
        log.debug(`Bot "${cfg.id}" poller started (${cfg.cdpHost}:${cfg.cdpPort})`);
      }
    },

    async stop(ctx: OpenClawPluginServiceContext): Promise<void> {
      const stopLog = createLogger("gami-discord", ctx.logger);
      stopLog.info(`Stopping ${pollers.size} bot poller(s)…`);

      for (const [id, poller] of pollers) {
        poller.stop();
        stopLog.debug(`Bot "${id}" stopped`);
      }
      pollers.clear();
    },

    // ── Tool registration ─────────────────────────────────────────────────

    registerTools(api: OpenClawPluginApi): void {
      registerBotsListTool(api, botConfigs, pollers, store);
      registerDmResetTool(api, botConfigs, store, () => log);
      registerDmStatusTool(api, botConfigs, store, () => log);
      registerRecruitTool(api, botConfigs, () => log);
    },
  };

  return service;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

function registerBotsListTool(
  api: OpenClawPluginApi,
  botConfigs: ResolvedBotConfig[],
  pollers: Map<string, DiscordBrowserPoller>,
  store: ConversationStore
): void {
  api.registerTool(
    {
      name: "discord_bots_list",
      description:
        "List all configured Discord bots, their node addresses, running state, " +
        "and the number of active DM conversations.",
      parameters: { type: "object", properties: {} },
      execute: async (_id, _params) => {
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
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    },
    { optional: true }
  );
}

function registerDmResetTool(
  api: OpenClawPluginApi,
  botConfigs: ResolvedBotConfig[],
  store: ConversationStore,
  getLog: () => PluginLogger
): void {
  api.registerTool(
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
        const botId = resolveBotId(params.botId as string | undefined, botConfigs);
        if (!botId) return multipleBotsError(botConfigs);

        store.reset(botId, channelId);
        getLog().info(`DM reset: bot="${botId}" channel="${channelId}"`);
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

function registerDmStatusTool(
  api: OpenClawPluginApi,
  botConfigs: ResolvedBotConfig[],
  store: ConversationStore,
  _getLog: () => PluginLogger
): void {
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
        const botId = resolveBotId(params.botId as string | undefined, botConfigs);
        if (!botId) return multipleBotsError(botConfigs);

        const botCfg = botConfigs.find((b) => b.id === botId);
        const { turns, handedOver } = store.summary(botId, channelId);
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

function registerRecruitTool(
  api: OpenClawPluginApi,
  botConfigs: ResolvedBotConfig[],
  getLog: () => PluginLogger
): void {
  api.registerTool(
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
            description:
              "Number of users to contact in this session (default: 5, max: 10).",
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

        const botId = resolveBotId(params.botId as string | undefined, botConfigs);
        if (!botId) return multipleBotsError(botConfigs);

        const botCfg = botConfigs.find((b) => b.id === botId);
        if (!botCfg) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Bot "${botId}" not found in config.`,
                  availableBots: botConfigs.map((b) => b.id),
                }),
              },
            ],
          };
        }

        const log = getLog();
        log.info(
          `Recruit session: bot="${botId}" guild="${guildId}" channel="${channelId}" count=${count}`
        );

        try {
          const result = await runRecruitSession(
            botCfg,
            guildId,
            channelId,
            count,
            customMessage,
            log
          );
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          log.error(`Recruit session failed: ${(e as Error).message}`);
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

// ── Shared helpers ────────────────────────────────────────────────────────────

function resolveBotId(
  paramBotId: string | undefined,
  bots: ResolvedBotConfig[]
): string | undefined {
  return paramBotId ?? (bots.length === 1 ? bots[0].id : undefined);
}

function multipleBotsError(bots: ResolvedBotConfig[]) {
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
