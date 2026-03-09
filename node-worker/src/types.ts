// ── Logger ────────────────────────────────────────────────────────────────────

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

// ── Worker configuration ──────────────────────────────────────────────────────

export interface WorkerConfig {
  /** HTTP port the worker listens on. Default: 3000 */
  port: number;
  /** CDP host — always 127.0.0.1 on the node. */
  cdpHost: string;
  /** CDP port for the Chrome instance launched by OpenClaw. Default: 18800 */
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
  /** True if this message is from the logged-in (bot) account; only reply to messages where this is false. */
  isFromSelf: boolean;
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
  guildId: string;
  channelId: string;
  contacted: string[];
  skipped: string[];
  errors: string[];
}
