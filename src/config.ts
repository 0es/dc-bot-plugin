import type { PluginConfig, ResolvedBotConfig } from "./types.js";
import { DEFAULTS } from "./constants.js";

// ── Raw config normalisation ──────────────────────────────────────────────────

/**
 * Cast the opaque `api.pluginConfig` value to our typed PluginConfig.
 * Unknown/extra keys are ignored — OpenClaw validates the schema separately.
 */
export function parsePluginConfig(raw: unknown): PluginConfig {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as PluginConfig;
  }
  return {};
}

// ── Bot config resolution ─────────────────────────────────────────────────────

/**
 * Resolve the final list of bot configs.
 *
 * Precedence: per-bot workerUrl → global workerUrl → built-in default.
 * When `bots` is omitted, runs in single-bot mode using the global workerUrl.
 */
export function resolveBotConfigs(raw: PluginConfig): ResolvedBotConfig[] {
  const defaultWorkerUrl = raw.workerUrl ?? DEFAULTS.workerUrl;

  if (!raw.bots || raw.bots.length === 0) {
    return [{ id: "default", label: "Default Bot", workerUrl: defaultWorkerUrl }];
  }

  return raw.bots.map((bot) => ({
    id: bot.id,
    label: bot.label ?? bot.id,
    workerUrl: bot.workerUrl ?? defaultWorkerUrl,
  }));
}
