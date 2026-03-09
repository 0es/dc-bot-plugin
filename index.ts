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
    "Browser-based Discord DM handler and outbound recruiter for the Gami gaming platform. " +
    "Monitors Discord web via Chrome CDP — no bot token required. " +
    "Supports multiple bots running in parallel, each on its own OpenClaw node.",

  register(api: OpenClawPluginApi) {
    const svc = createDiscordService(api.pluginConfig);

    // Tools are registered immediately so the agent can call them
    // even before the gateway has fully started.
    svc.registerTools(api);

    api.registerService(svc);
  },
};
