import http from "http";
import { createLogger } from "./logger.js";
import type { DiscordBrowserPoller } from "./poller.js";
import type { ConversationStore } from "./store.js";
import type { WorkerConfig } from "./types.js";

// ── HTTP Server ───────────────────────────────────────────────────────────────

/**
 * Start the worker HTTP server.
 *
 * This worker only handles DM replies (poller + store). Recruitment is done
 * by the Gateway AI controlling the node's browser via OpenClaw browser tools.
 *
 * API surface:
 *   GET    /health         → { ok: true }
 *   GET    /status         → WorkerStatus
 *   GET    /dms/:channelId → DmStatus
 *   DELETE /dms/:channelId  → { reset: true, channelId }
 */
export function startServer(
  cfg: WorkerConfig,
  poller: DiscordBrowserPoller,
  store: ConversationStore
): http.Server {
  const log = createLogger("server");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${cfg.port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    res.setHeader("Content-Type", "application/json");

    try {
      // GET /health
      if (method === "GET" && path === "/health") {
        send(res, 200, { ok: true });
        return;
      }

      // GET /status
      if (method === "GET" && path === "/status") {
        send(res, 200, {
          running: poller.isRunning(),
          selfName: poller.getSelfName(),
          activeConversations: store.listAll(),
        });
        return;
      }

      // /dms/:channelId
      const dmMatch = path.match(/^\/dms\/(\d+)$/);
      if (dmMatch) {
        const channelId = dmMatch[1];

        if (method === "GET") {
          const { turns, handedOver } = store.summary(channelId);
          send(res, 200, {
            channelId,
            turns,
            maxTurns: cfg.maxDmTurns,
            turnsRemaining: Math.max(0, cfg.maxDmTurns - turns),
            handedOver,
          });
          return;
        }

        if (method === "DELETE") {
          store.reset(channelId);
          log.info(`DM reset: channel="${channelId}"`);
          send(res, 200, { reset: true, channelId });
          return;
        }
      }

      send(res, 404, { error: "Not Found" });
    } catch (e) {
      log.error(`Request error [${method} ${path}]: ${(e as Error).message}`);
      send(res, 500, { error: (e as Error).message });
    }
  });

  server.listen(cfg.port, () => {
    log.info(`Worker HTTP server listening on :${cfg.port}`);
  });

  return server;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
