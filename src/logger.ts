import type { PluginLogger } from "./types.js";

// ── Console fallback ──────────────────────────────────────────────────────────

const consoleLogger: PluginLogger = {
  info: (msg, ...args) => console.log(msg, ...args),
  warn: (msg, ...args) => console.warn(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
  debug: (msg, ...args) => console.debug(msg, ...args),
};

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Wrap a base logger (or console fallback) with a fixed prefix tag.
 * The tag is prepended to every message so log lines are easy to grep.
 *
 * @example
 *   const log = createLogger("gami-discord:bot-1", ctx.logger);
 *   log.info("Poller started");
 *   // → "[gami-discord:bot-1] Poller started"
 */
export function createLogger(prefix: string, base?: PluginLogger): PluginLogger {
  const b = base ?? consoleLogger;
  const tag = `[${prefix}]`;
  return {
    info: (msg, ...args) => b.info(`${tag} ${msg}`, ...args),
    warn: (msg, ...args) => b.warn(`${tag} ${msg}`, ...args),
    error: (msg, ...args) => b.error(`${tag} ${msg}`, ...args),
    debug: (msg, ...args) => b.debug(`${tag} ${msg}`, ...args),
  };
}

/**
 * Extract a PluginLogger from an OpenClaw hook event object if available,
 * otherwise fall back to console.
 */
export function loggerFromEvent(event: Record<string, unknown>): PluginLogger {
  const candidate = event["logger"] as Partial<PluginLogger> | undefined;
  if (
    candidate &&
    typeof candidate.info === "function" &&
    typeof candidate.warn === "function" &&
    typeof candidate.error === "function"
  ) {
    return {
      info: candidate.info.bind(candidate),
      warn: candidate.warn.bind(candidate),
      error: candidate.error.bind(candidate),
      debug:
        typeof candidate.debug === "function"
          ? candidate.debug.bind(candidate)
          : consoleLogger.debug,
    };
  }
  return consoleLogger;
}
