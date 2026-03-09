/**
 * Gami Discord Recruitment Plugin for OpenClaw
 *
 * All Discord communication is done through the managed browser via CDP —
 * no Discord bot token or Bot API is used.
 *
 * Supports multiple bots running in parallel, each on its own OpenClaw node.
 * See README.md for full configuration reference.
 */

import { createDiscordService } from "./src/service.js";
import type { OpenClawPluginApi } from "./src/types.js";

export default {
  id: "gami-discord-recruit",
  name: "Gami Discord Recruitment",
  description:
    "Browser-based Discord DM handler for the Gami gaming platform. " +
    "Node-worker on each bot only handles DM replies (CDP + LLM). " +
    "Recruitment is done by the Gateway AI controlling the node's browser. " +
    "Supports multiple bots, each on its own OpenClaw node.",

  register(api: OpenClawPluginApi) {
    const svc = createDiscordService(api.pluginConfig);

    // Tools are registered immediately so the agent can call them
    // even before the gateway has fully started.
    svc.registerTools(api);

    api.registerService(svc);
  },
};
