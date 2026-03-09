/**
 * Gami Discord Node Worker
 *
 * Runs on each bot node alongside the OpenClaw-managed Chrome browser.
 * Connects to the local Chrome CDP endpoint (127.0.0.1), polls for unread
 * Discord DMs, replies via LLM, and exposes an HTTP API for the OpenClaw
 * gateway plugin to call.
 *
 * Configuration is entirely via environment variables — see src/config.ts.
 *
 * Start: tsx index.ts
 *        WORKER_PORT=3001 CDP_PORT=18800 LLM_BASE_URL=http://... tsx index.ts
 */

import { loadConfig } from "./src/config.js";
import { DiscordBrowserPoller } from "./src/poller.js";
import { ConversationStore } from "./src/store.js";
import { startServer } from "./src/server.js";
import { createLogger } from "./src/logger.js";

const log = createLogger("worker");
const cfg = loadConfig();

log.info(
  `Gami node worker starting — CDP=${cfg.cdpHost}:${cfg.cdpPort}  HTTP=:${cfg.port}`
);

const store = new ConversationStore();
const poller = new DiscordBrowserPoller(cfg, store, log);

poller.start();
startServer(cfg, poller, store);

process.on("SIGTERM", () => {
  log.info("Shutting down (SIGTERM)…");
  poller.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  log.info("Shutting down (SIGINT)…");
  poller.stop();
  process.exit(0);
});
