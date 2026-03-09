import { DEFAULTS, DEFAULT_SYSTEM_PROMPT } from "./constants.js";
import type { WorkerConfig } from "./types.js";

/**
 * Load worker configuration from environment variables.
 *
 * All fields have safe defaults so the worker can start with zero configuration
 * (useful for local single-node setups). Override via env for production.
 *
 * Required in production:
 *   LLM_BASE_URL   — URL of the OpenAI-compatible LLM endpoint
 *
 * Optional overrides:
 *   WORKER_PORT    — HTTP port this worker listens on (default: 3000)
 *   CDP_PORT       — Chrome CDP port opened by OpenClaw (default: 18800)
 *   POLL_INTERVAL_MS
 *   MAX_DM_TURNS
 *   TAKEOVER_MESSAGE
 *   SYSTEM_PROMPT
 *   LLM_MODEL
 *   LLM_API_KEY
 */
export function loadConfig(): WorkerConfig {
  return {
    port: parseInt(process.env.WORKER_PORT ?? String(DEFAULTS.workerPort), 10),
    cdpHost: DEFAULTS.cdpHost, // always 127.0.0.1 — the whole point of the worker
    cdpPort: parseInt(process.env.CDP_PORT ?? String(DEFAULTS.cdpPort), 10),
    pollIntervalMs: parseInt(
      process.env.POLL_INTERVAL_MS ?? String(DEFAULTS.pollIntervalMs),
      10
    ),
    maxDmTurns: parseInt(process.env.MAX_DM_TURNS ?? String(DEFAULTS.maxDmTurns), 10),
    takeoverMessage: process.env.TAKEOVER_MESSAGE ?? DEFAULTS.takeoverMessage,
    systemPrompt: process.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
    llmBaseUrl: process.env.LLM_BASE_URL ?? DEFAULTS.llmBaseUrl,
    llmModel: process.env.LLM_MODEL ?? DEFAULTS.llmModel,
    llmApiKey: process.env.LLM_API_KEY ?? DEFAULTS.llmApiKey,
  };
}
