// ── Plugin API ────────────────────────────────────────────────────────────────

export interface PluginApi {
  config?: { plugins?: { entries?: Record<string, { config?: unknown }> } };
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

// ── Logger ────────────────────────────────────────────────────────────────────

export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

// ── Configuration ─────────────────────────────────────────────────────────────

/** Per-bot configuration; all fields except `id` are optional overrides. */
export interface BotConfig {
  /** Unique identifier used in tool calls and log tags. */
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
  maxDmTurns?: number;
  takeoverMessage?: string;
  systemPrompt?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
}

/** Top-level plugin configuration (all fields optional). */
export interface PluginConfig {
  maxDmTurns?: number;
  takeoverMessage?: string;
  /** How often to poll Discord for new DMs (ms). Default: 5000 */
  pollIntervalMs?: number;
  cdpHost?: string;
  cdpPort?: number;
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
  systemPrompt?: string;
  /**
   * Multi-bot definitions.
   * If omitted, runs in single-bot mode using the global fields above.
   */
  bots?: BotConfig[];
}

/** Fully-resolved configuration for one bot (no optional fields). */
export interface ResolvedBotConfig {
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

// ── CDP ───────────────────────────────────────────────────────────────────────

export interface CDPTab {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

// ── Conversation ──────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DiscordMessage {
  id: string;
  author: string;
  content: string;
}

export interface UnreadDM {
  channelId: string;
  label: string;
}

export interface Conversation {
  history: ChatMessage[];
  turns: number;
  handedOver: boolean;
  lastSeenMsgId: string;
}

// ── Recruitment ───────────────────────────────────────────────────────────────

export interface RecruitResult {
  botId: string;
  guildId: string;
  channelId: string;
  contacted: string[];
  skipped: string[];
  errors: string[];
}
