import {
  CDPSession,
  closeTab,
  openNewTab,
  rewriteWsHost,
  sendMessageRaw,
  sleep,
} from "./cdp.js";
import {
  buildClickMemberJS,
  CLICK_DM_BUTTON_JS,
  ENSURE_MEMBER_LIST_JS,
  GET_DM_CHANNEL_ID_JS,
  GET_ONLINE_MEMBERS_JS,
} from "./discord-dom.js";
import { createLogger } from "./logger.js";
import { RECRUIT_MESSAGE_TEMPLATES } from "./constants.js";
import type { Logger, RecruitResult, WorkerConfig } from "./types.js";

// ── Recruitment session ───────────────────────────────────────────────────────

/**
 * Open a dedicated Chrome tab, navigate to the target guild channel,
 * find online/idle members, and send each a recruitment DM.
 *
 * A separate tab is used so the DM poller's existing session is not disturbed.
 * The tab is always closed when the session ends (success or error).
 */
export async function runRecruitSession(
  cfg: WorkerConfig,
  guildId: string,
  channelId: string,
  count: number,
  customMessage?: string,
  baseLogger?: Logger
): Promise<RecruitResult> {
  const log = createLogger("recruit", baseLogger);
  const contacted: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const channelUrl = `https://discord.com/channels/${guildId}/${channelId}`;

  log.info(`Opening recruitment tab → ${channelUrl}`);
  const newTab = await openNewTab(cfg.cdpHost, cfg.cdpPort, channelUrl);
  await sleep(3500);

  const wsUrl = rewriteWsHost(newTab.webSocketDebuggerUrl, cfg.cdpHost);
  const sess = new CDPSession();
  await sess.connect(wsUrl);
  log.debug("CDP session established for recruitment tab");

  try {
    await sess.evaluate(ENSURE_MEMBER_LIST_JS);
    await sleep(1500);

    const members = ((await sess.evaluate(GET_ONLINE_MEMBERS_JS)) ?? []) as string[];
    log.info(`Found ${members.length} online/idle member(s) in channel ${channelId}`);

    if (members.length === 0) {
      skipped.push("No online/idle members found in member list");
      return { guildId, channelId, contacted, skipped, errors };
    }

    const targets = members.slice(0, count);
    log.info(`Targeting ${targets.length} member(s): ${targets.join(", ")}`);

    for (let i = 0; i < targets.length; i++) {
      const memberName = targets[i];
      try {
        // Return to the guild channel before each click.
        if (i > 0) {
          await sess.send("Page.navigate", { url: channelUrl });
          await sleep(2500);
          await sess.evaluate(ENSURE_MEMBER_LIST_JS);
          await sleep(1000);
        }

        // Click the member to open their profile popup.
        const clickResult = (await sess.evaluate(buildClickMemberJS(memberName))) as string;
        if (clickResult !== "clicked") {
          log.warn(`"${memberName}": member click failed (${clickResult}) — skipping`);
          skipped.push(`${memberName}: could not click (${clickResult})`);
          continue;
        }
        await sleep(1000);

        // Click the "Send Message" button in the popup.
        const dmClicked = (await sess.evaluate(CLICK_DM_BUTTON_JS)) as boolean;
        if (!dmClicked) {
          log.warn(`"${memberName}": DM button not found in popup — skipping`);
          skipped.push(`${memberName}: Message button not found in popup`);
          await sess.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
          await sess.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape" });
          continue;
        }
        await sleep(1800);

        // Confirm we navigated into a DM channel.
        const dmChannelId = (await sess.evaluate(GET_DM_CHANNEL_ID_JS)) as string | null;
        if (!dmChannelId) {
          log.warn(`"${memberName}": DM window did not open — skipping`);
          skipped.push(`${memberName}: DM window did not open`);
          continue;
        }

        // Pick message text (rotate templates to avoid identical messages).
        const message =
          customMessage ?? RECRUIT_MESSAGE_TEMPLATES[i % RECRUIT_MESSAGE_TEMPLATES.length];

        await sendMessageRaw(sess, message, (msg) => log.warn(msg));
        contacted.push(memberName);
        log.info(`DM sent to "${memberName}" (${i + 1}/${targets.length})`);

        // Anti-detection delay between DMs (15–45 s).
        if (i < targets.length - 1) {
          const pause = 15_000 + Math.floor(Math.random() * 30_000);
          log.info(`Pausing ${Math.round(pause / 1000)}s before next DM…`);
          await sleep(pause);
        }
      } catch (e) {
        log.error(`"${memberName}": ${(e as Error).message}`);
        errors.push(`${memberName}: ${(e as Error).message}`);
      }
    }
  } finally {
    sess.close();
    await closeTab(cfg.cdpHost, cfg.cdpPort, newTab.id);
    log.info(
      `Session complete — contacted: ${contacted.length}, skipped: ${skipped.length}, errors: ${errors.length}`
    );
  }

  return { guildId, channelId, contacted, skipped, errors };
}
