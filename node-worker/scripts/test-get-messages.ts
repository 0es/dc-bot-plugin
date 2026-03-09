/**
 * Run GET_UNREAD_DMS_JS and buildGetMessagesJS in the Discord tab via CDP.
 * Use when Discord is already open in Chrome (e.g. the same Chrome the worker uses).
 *
 *   cd node-worker && npx tsx scripts/test-get-messages.ts
 *
 * Requires CDP_PORT (default 18800) and the Discord tab to be on a DM channel
 * to see message list results.
 */
import {
  CDPSession,
  fetchTabs,
  rewriteWsHost,
} from "../src/cdp.js";
import { GET_UNREAD_DMS_JS, buildGetMessagesJS } from "../src/discord-dom.js";
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

  const unread = (await sess.evaluate(GET_UNREAD_DMS_JS)) as unknown;
  console.log("GET_UNREAD_DMS_JS:", JSON.stringify(unread, null, 2));

  const messages = (await sess.evaluate(buildGetMessagesJS("", null))) as unknown;
  console.log("buildGetMessagesJS('', null):", JSON.stringify(messages, null, 2));

  const withLast = (await sess.evaluate(buildGetMessagesJS("__DUMMY__", null))) as unknown;
  console.log("buildGetMessagesJS('__DUMMY__', null):", JSON.stringify(withLast, null, 2));

  sess.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
