/**
 * Run window.__dcBotPlugin (Vencord dcBotPlugin) in the Discord tab via CDP.
 * Use when Discord is already open in Chrome with Vencord + dcBotPlugin enabled.
 *
 *   cd node-worker && npx tsx scripts/test-get-messages.ts
 *
 * Requires CDP_PORT (default 18800), a Discord tab, and Vencord Web with dcBotPlugin.
 * If __dcBotPlugin is missing, install Vencord from the Vencord workspace and enable dcBotPlugin.
 */
import { CDPSession, fetchTabs, rewriteWsHost } from "../src/cdp.js";
import { loadConfig } from "../src/config.js";

async function main() {
  const cfg = loadConfig();
  const tabs = await fetchTabs(cfg.cdpHost, cfg.cdpPort);
  const discordTab = tabs.find((t) => t.url.includes("discord.com"));
  if (!discordTab?.webSocketDebuggerUrl) {
    console.error("No Discord tab found. Open discord.com in the CDP Chrome.");
    process.exit(1);
  }
  const wsUrl = rewriteWsHost(discordTab.webSocketDebuggerUrl, cfg.cdpHost);
  const sess = new CDPSession();
  await sess.connect(wsUrl);

  const hasPlugin = (await sess.evaluate("typeof window.__dcBotPlugin !== 'undefined'")) as boolean;
  if (!hasPlugin) {
    console.error(
      "window.__dcBotPlugin not found. Install Vencord Web and enable the dcBotPlugin userplugin (build from the Vencord workspace with pnpm buildWeb)."
    );
    sess.close();
    process.exit(1);
  }

  const unread = (await sess.evaluate("window.__dcBotPlugin.getUnreadDMs()")) as unknown;
  console.log("getUnreadDMs():", JSON.stringify(unread, null, 2));

  const currentUrl = (await sess.evaluate("location.href")) as string;
  const dmMatch = currentUrl.match(/\/channels\/@me\/(\d+)/);
  const channelId = dmMatch?.[1] ?? (Array.isArray(unread) && (unread as { channelId: string }[])[0]?.channelId);
  if (channelId) {
    const messages = (await sess.evaluate(
      `window.__dcBotPlugin.getMessages(${JSON.stringify(channelId)}, null)`
    )) as unknown;
    console.log("getMessages(" + JSON.stringify(channelId) + ", null):", JSON.stringify(messages, null, 2));
  } else {
    console.log("No DM channel in URL and no unread DMs — open a DM or pass channelId to test getMessages.");
  }

  sess.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
