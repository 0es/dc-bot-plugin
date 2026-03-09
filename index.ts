/**
 * Gami Discord Recruitment Plugin for OpenClaw
 *
 * All Discord communication is done through the managed browser via CDP —
 * no Discord bot token or Bot API is used.
 *
 * Supports multiple bots running in parallel, each on its own OpenClaw node.
 * Configuration: plugins.entries.gami-discord-recruit.config
 *
 * See README.md for full configuration reference.
 */

import { DiscordService } from "./src/service.js";
import type { PluginApi } from "./src/types.js";

export default function register(api: PluginApi) {
  const service = new DiscordService(api);

  // Register all agent tools up front (tools are available immediately).
  service.registerTools();

  api.registerHook(
    "gateway:startup",
    (event) => service.start(event),
    {
      name: "gami-discord.startup",
      description: "Starts one Discord browser DM poller per configured bot.",
    }
  );

  api.registerHook(
    "gateway:shutdown",
    (event) => service.stop(event),
    {
      name: "gami-discord.shutdown",
      description: "Stops all Discord browser DM pollers and clears resources.",
    }
  );
}
