import type { Logger } from "./types.js";

// ── Console logger ────────────────────────────────────────────────────────────

const consoleLogger: Logger = {
  info: (msg, ...args) => console.log(`[INFO]  ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[WARN]  ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
  debug: (msg, ...args) => console.debug(`[DEBUG] ${msg}`, ...args),
};

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Wrap a base logger (or console fallback) with a fixed prefix tag.
 *
 * @example
 *   const log = createLogger("poller");
 *   log.info("started");   // → "[INFO]  [poller] started"
 */
export function createLogger(prefix: string, base?: Logger): Logger {
  const b = base ?? consoleLogger;
  const tag = `[${prefix}]`;
  return {
    info: (msg, ...args) => b.info(`${tag} ${msg}`, ...args),
    warn: (msg, ...args) => b.warn(`${tag} ${msg}`, ...args),
    error: (msg, ...args) => b.error(`${tag} ${msg}`, ...args),
    debug: (msg, ...args) => b.debug(`${tag} ${msg}`, ...args),
  };
}
