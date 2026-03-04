/**
 * Gami Discord Recruitment Plugin for OpenClaw
 *
 * Provides two capabilities:
 * 1. discord_dm_gate tool — tracks AI turn counts per DM conversation and
 *    returns a handover signal after the configured limit (default: 5 turns).
 * 2. message:received hook — sends a direct human-takeover notification as a
 *    fallback safety net when the per-conversation turn limit is exceeded.
 */

interface PluginConfig {
  maxDmTurns?: number;
  takeoverMessage?: string;
}

interface PluginApi {
  config?: { plugins?: { entries?: Record<string, { config?: PluginConfig }> } };
  registerTool: (
    tool: {
      name: string;
      description: string;
      parameters: object;
      execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
    },
    opts?: { optional?: boolean }
  ) => void;
  registerHook: (
    event: string,
    handler: (event: HookEvent) => Promise<void>,
    meta: { name: string; description: string }
  ) => void;
}

interface HookEvent {
  type: string;
  action: string;
  sessionKey: string;
  timestamp: Date;
  messages: string[];
  context: {
    from?: string;
    to?: string;
    content?: string;
    channelId?: string;
    conversationId?: string;
    messageId?: string;
    metadata?: {
      surface?: string;
      senderId?: string;
      senderName?: string;
    };
  };
}

const DEFAULT_MAX_TURNS = 5;
const DEFAULT_TAKEOVER_MSG =
  "感谢您的耐心交流！我们的人工客服将接管后续沟通，为您提供更专业的服务。请稍候，工作人员将很快与您联系。🎮";

/** In-memory turn counter: conversationId → AI turn count */
const dmTurnCounts = new Map<string, number>();

/** Conversations that have already received the takeover notification */
const handedOverConversations = new Set<string>();

function getPluginConfig(api: PluginApi): PluginConfig {
  return api.config?.plugins?.entries?.["gami-discord-recruit"]?.config ?? {};
}

function isDiscordDm(event: HookEvent): boolean {
  if (event.context.channelId !== "discord") return false;
  // Guild channels have surface === "guild"; DMs don't
  if (event.context.metadata?.surface === "guild") return false;
  return true;
}

function getConversationId(event: HookEvent): string | undefined {
  return event.context.conversationId ?? event.context.from;
}

export default function register(api: PluginApi) {
  // ── Tool: discord_dm_gate ──────────────────────────────────────────────────
  // The AI (via AGENTS.md instructions) must call this tool before every DM
  // reply. It increments the turn counter and returns whether to continue.
  api.registerTool(
    {
      name: "discord_dm_gate",
      description:
        "Check whether this Discord DM conversation is still within the AI turn limit. " +
        "MUST be called at the start of every Discord DM reply. " +
        "Returns { allowed: true } if the AI should respond, or " +
        "{ allowed: false, message: '...' } when the conversation should be handed to a human. " +
        "When allowed is false, respond to the user with ONLY the provided message and nothing else.",
      parameters: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            description:
              "The Discord DM conversation ID or sender user ID. Use the sender's Discord user ID.",
          },
        },
        required: ["conversationId"],
      },
      async execute(_id, params) {
        const cfg = getPluginConfig(api);
        const maxTurns = cfg.maxDmTurns ?? DEFAULT_MAX_TURNS;
        const takeoverMsg = cfg.takeoverMessage ?? DEFAULT_TAKEOVER_MSG;
        const convId = params.conversationId as string;

        if (handedOverConversations.has(convId)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ allowed: false, message: takeoverMsg }),
              },
            ],
          };
        }

        const current = dmTurnCounts.get(convId) ?? 0;
        const next = current + 1;
        dmTurnCounts.set(convId, next);

        if (next > maxTurns) {
          handedOverConversations.add(convId);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ allowed: false, message: takeoverMsg }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                allowed: true,
                turnsUsed: next,
                turnsRemaining: maxTurns - next,
              }),
            },
          ],
        };
      },
    },
    { optional: true }
  );

  // ── Tool: discord_dm_reset ─────────────────────────────────────────────────
  // Allows an operator to reset the turn counter for a conversation (e.g. after
  // a human agent finishes and the AI should be re-enabled).
  api.registerTool(
    {
      name: "discord_dm_reset",
      description:
        "Reset the AI turn counter for a Discord DM conversation. " +
        "Use this after a human agent has finished handling the conversation " +
        "and you want to re-enable AI responses for the same user.",
      parameters: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            description: "The Discord DM conversation ID or sender user ID to reset.",
          },
        },
        required: ["conversationId"],
      },
      async execute(_id, params) {
        const convId = params.conversationId as string;
        dmTurnCounts.delete(convId);
        handedOverConversations.delete(convId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                reset: true,
                conversationId: convId,
                message: "Turn counter reset. AI is active for this conversation again.",
              }),
            },
          ],
        };
      },
    },
    { optional: true }
  );

  // ── Hook: message:received — fallback human-takeover notification ──────────
  // This fires before the AI processes the message. When the turn limit is
  // already exceeded, it pushes a direct notification to the user and also
  // injects a marker into the hook messages array so any downstream listener
  // can see that handover was triggered.
  api.registerHook(
    "message:received",
    async (event: HookEvent) => {
      if (!isDiscordDm(event)) return;

      const convId = getConversationId(event);
      if (!convId) return;

      const cfg = getPluginConfig(api);
      const maxTurns = cfg.maxDmTurns ?? DEFAULT_MAX_TURNS;
      const takeoverMsg = cfg.takeoverMessage ?? DEFAULT_TAKEOVER_MSG;

      // Only act when already handed over (turn counter exceeded on a prior turn)
      if (handedOverConversations.has(convId)) {
        event.messages.push(takeoverMsg);
        return;
      }

      // Also guard: if somehow the hook fires and turns are already at limit
      const current = dmTurnCounts.get(convId) ?? 0;
      if (current >= maxTurns) {
        handedOverConversations.add(convId);
        event.messages.push(takeoverMsg);
      }
    },
    {
      name: "gami-discord.dm-turn-gate",
      description:
        "Sends a human-takeover notification for Discord DM conversations " +
        "that have exceeded the configured AI turn limit.",
    }
  );
}
