// ── Plugin API (OpenClaw SDK surface) ─────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: object;
  execute: (
    id: string,
    params: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

export interface OpenClawPluginApi {
  /** Raw plugin config object as parsed from openclaw.plugin.json / user config. */
  pluginConfig?: unknown;
  registerTool(tool: ToolDefinition, opts?: { optional?: boolean }): void;
  registerService(service: OpenClawPluginService): void;
}

/** Service context passed to start() and stop() by the OpenClaw gateway. */
export interface OpenClawPluginServiceContext {
  logger: PluginLogger;
  workspaceDir?: string;
}

/** Lifecycle contract for a plugin service registered via api.registerService(). */
export interface OpenClawPluginService {
  id: string;
  start(ctx: OpenClawPluginServiceContext): Promise<void>;
  stop(ctx: OpenClawPluginServiceContext): Promise<void>;
}

// ── Logger ────────────────────────────────────────────────────────────────────

export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

// ── Configuration ─────────────────────────────────────────────────────────────

/** Per-bot configuration. */
export interface BotConfig {
  /** Unique identifier used in tool calls and log tags. */
  id: string;
  /** Human-readable label shown in logs and tool responses. */
  label?: string;
  /**
   * HTTP URL of the node worker running on this bot's machine.
   * e.g. "http://192.168.8.101:3000"
   */
  workerUrl?: string;
}

/** Top-level plugin configuration (all fields optional). */
export interface PluginConfig {
  /**
   * Default worker URL used when `bots` is omitted or a bot omits its own
   * workerUrl. Default: "http://127.0.0.1:3000"
   */
  workerUrl?: string;
  /** Multi-bot definitions. Omit to run in single-bot mode. */
  bots?: BotConfig[];
}

/** Fully-resolved configuration for one bot (no optional fields). */
export interface ResolvedBotConfig {
  id: string;
  label: string;
  /** HTTP base URL of the node worker for this bot. */
  workerUrl: string;
}

// ── Worker API response types ─────────────────────────────────────────────────

export interface WorkerStatus {
  running: boolean;
  selfName: string | null;
  activeConversations: Array<{ channelId: string; turns: number; handedOver: boolean }>;
}

export interface DmStatus {
  channelId: string;
  turns: number;
  maxTurns: number;
  turnsRemaining: number;
  handedOver: boolean;
}
