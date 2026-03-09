import type { PluginApi, PluginConfig, ResolvedBotConfig } from "./types.js";
import { DEFAULTS, DEFAULT_SYSTEM_PROMPT, PLUGIN_ID } from "./constants.js";

// ── Raw config extraction ─────────────────────────────────────────────────────

export function resolvePluginConfig(api: PluginApi): PluginConfig {
  return (api.config?.plugins?.entries?.[PLUGIN_ID]?.config as PluginConfig) ?? {};
}

// ── Bot config resolution ─────────────────────────────────────────────────────

/**
 * Merge: global defaults → plugin-level config → per-bot overrides.
 * Returns a fully-resolved list with no optional fields.
 *
 * When `bots` is omitted the plugin runs in single-bot mode, treating the
 * top-level config as a single bot named "default".
 */
export function resolveBotConfigs(raw: PluginConfig): ResolvedBotConfig[] {
  const global = {
    cdpHost: raw.cdpHost ?? DEFAULTS.cdpHost,
    cdpPort: raw.cdpPort ?? DEFAULTS.cdpPort,
    pollIntervalMs: raw.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
    maxDmTurns: raw.maxDmTurns ?? DEFAULTS.maxDmTurns,
    takeoverMessage: raw.takeoverMessage ?? DEFAULTS.takeoverMessage,
    systemPrompt: raw.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    llmBaseUrl: raw.llmBaseUrl ?? DEFAULTS.llmBaseUrl,
    llmModel: raw.llmModel ?? DEFAULTS.llmModel,
    llmApiKey: raw.llmApiKey ?? DEFAULTS.llmApiKey,
  };

  if (!raw.bots || raw.bots.length === 0) {
    return [{ id: "default", label: "Default Bot", ...global }];
  }

  return raw.bots.map((bot) => ({
    id: bot.id,
    label: bot.label ?? bot.id,
    cdpHost: bot.cdpHost ?? global.cdpHost,
    cdpPort: bot.cdpPort ?? global.cdpPort,
    pollIntervalMs: global.pollIntervalMs,
    maxDmTurns: bot.maxDmTurns ?? global.maxDmTurns,
    takeoverMessage: bot.takeoverMessage ?? global.takeoverMessage,
    systemPrompt: bot.systemPrompt ?? global.systemPrompt,
    llmBaseUrl: bot.llmBaseUrl ?? global.llmBaseUrl,
    llmModel: bot.llmModel ?? global.llmModel,
    llmApiKey: bot.llmApiKey ?? global.llmApiKey,
  }));
}
