import { parsePluginConfig, resolveBotConfigs } from "./config.js";
import { createLogger } from "./logger.js";
import { WorkerClient } from "./worker-client.js";
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
 * In the new architecture the plugin is a thin gateway layer:
 *   - Configuration maps each bot to a node-worker URL.
 *   - All CDP / browser operations are handled by the node-worker processes.
 *   - The plugin only routes tool calls to the right worker via HTTP.
 */
export function createDiscordService(pluginConfig?: unknown): GamiDiscordService {
  const rawConfig = parsePluginConfig(pluginConfig);
  const botConfigs = resolveBotConfigs(rawConfig);

  // One WorkerClient per bot, keyed by bot ID.
  const clients = new Map<string, WorkerClient>(
    botConfigs.map((cfg) => [cfg.id, new WorkerClient(cfg.workerUrl)])
  );

  let log: PluginLogger = createLogger("gami-discord");

  // ── Lifecycle ───────────────────────────────────────────────────────────

  const service: GamiDiscordService = {
    id: "gami-discord",

    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      log = createLogger("gami-discord", ctx.logger);
      log.info(`Plugin started — ${botConfigs.length} bot(s) configured`);
      for (const cfg of botConfigs) {
        log.debug(`  ${cfg.id} (${cfg.label}) → ${cfg.workerUrl}`);
      }
    },

    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      log.info("Plugin stopped");
    },

    // ── Tool registration ─────────────────────────────────────────────────

    registerTools(api: OpenClawPluginApi): void {
      registerBotsListTool(api, botConfigs, clients);
      registerDmResetTool(api, botConfigs, clients, () => log);
      registerDmStatusTool(api, botConfigs, clients);
    },
  };

  return service;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

function registerBotsListTool(
  api: OpenClawPluginApi,
  botConfigs: ResolvedBotConfig[],
  clients: Map<string, WorkerClient>
): void {
  api.registerTool(
    {
      name: "discord_bots_list",
      description:
        "List all configured Discord bots, their worker URLs, running state, " +
        "and the number of active DM conversations.",
      parameters: { type: "object", properties: {} },
      execute: async (_id, _params) => {
        const results = await Promise.all(
          botConfigs.map(async (cfg) => {
            const client = clients.get(cfg.id)!;
            try {
              const status = await client.getStatus();
              return {
                id: cfg.id,
                label: cfg.label,
                workerUrl: cfg.workerUrl,
                ...status,
              };
            } catch (e) {
              return {
                id: cfg.id,
                label: cfg.label,
                workerUrl: cfg.workerUrl,
                running: false,
                error: (e as Error).message,
              };
            }
          })
        );
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      },
    },
  );
}

function registerDmResetTool(
  api: OpenClawPluginApi,
  botConfigs: ResolvedBotConfig[],
  clients: Map<string, WorkerClient>,
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

        const client = clients.get(botId)!;
        try {
          await client.resetDm(channelId);
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
        } catch (e) {
          return workerError(botId, (e as Error).message);
        }
      },
    }
  );
}

function registerDmStatusTool(
  api: OpenClawPluginApi,
  botConfigs: ResolvedBotConfig[],
  clients: Map<string, WorkerClient>
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

        const client = clients.get(botId)!;
        try {
          const status = await client.getDmStatus(channelId);
          return {
            content: [{ type: "text", text: JSON.stringify({ botId, ...status }) }],
          };
        } catch (e) {
          return workerError(botId, (e as Error).message);
        }
      },
    }
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

function workerError(botId: string, message: string) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, botId }),
      },
    ],
  };
}
