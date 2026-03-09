// ── Discord DOM helpers ───────────────────────────────────────────────────────
// All strings are self-contained IIFEs executed via CDP Runtime.evaluate.
// They must be compatible with the page's JavaScript environment (ES5-safe).

// ── DM poller helpers ─────────────────────────────────────────────────────────

/**
 * Scan the DM sidebar for channels that have an unread badge.
 * Returns an array of { channelId, label }.
 */
export const GET_UNREAD_DMS_JS = `
(function () {
  try {
    var results = [];
    var sidebar =
      document.querySelector('[aria-label="Direct Messages"]') ||
      document.querySelector('[data-list-id="private-channels"]');
    if (!sidebar) return results;
    var links = sidebar.querySelectorAll('a[href*="/channels/@me/"]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var m = link.href.match(/\\/channels\\/@me\\/(\\d+)/);
      if (!m) continue;
      var channelId = m[1];
      var badge =
        link.querySelector('[class*="numberBadge"]') ||
        link.querySelector('[class*="unreadBadge"]') ||
        link.querySelector('[class*="badge"]');
      if (!badge) continue;
      var label =
        link.getAttribute('aria-label') ||
        ((link.querySelector('[class*="name"]') || {}).textContent) ||
        channelId;
      results.push({ channelId: channelId, label: label.trim() });
    }
    return results;
  } catch (e) { return []; }
})()`;

/**
 * Fetch new messages since `lastSeenId`.
 * On the first visit (lastSeenId = "") returns a single __INIT__ sentinel with
 * the latest message ID so we never reply to messages sent before we started.
 */
export function buildGetMessagesJS(lastSeenId: string): string {
  const escaped = JSON.stringify(lastSeenId);
  return `
(function (lastSeenId) {
  try {
    var results = [];
    var list = document.querySelector('[data-list-id="chat-messages"]');
    if (!list) return results;
    var items = Array.from(list.querySelectorAll('li[id^="chat-messages-"]'));
    if (!lastSeenId) {
      var last = items[items.length - 1];
      if (!last) return results;
      var idm = last.id.match(/chat-messages-\\d+-(\\d+)/);
      if (idm) results.push({ id: idm[1], author: '__INIT__', content: '' });
      return results;
    }
    var found = false;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var idMatch = item.id.match(/chat-messages-\\d+-(\\d+)/);
      if (!idMatch) continue;
      var msgId = idMatch[1];
      if (!found) { if (msgId === lastSeenId) found = true; continue; }
      var contentEl = item.querySelector('[id^="message-content-"]');
      var content = (contentEl || {}).textContent;
      if (!content || !content.trim()) continue;
      var headerEl = item.querySelector('[class*="header"]');
      var authorEl = headerEl
        ? headerEl.querySelector('[class*="username"], [class*="nameTag"], h3 span')
        : null;
      var author = authorEl ? authorEl.textContent.trim() : '__continued__';
      results.push({ id: msgId, author: author, content: content.trim() });
    }
    return results;
  } catch (e) { return []; }
})(${escaped})`;
}

// ── Recruitment helpers ───────────────────────────────────────────────────────

/**
 * Returns display names of online/idle non-bot members visible in the member
 * list sidebar.
 */
export const GET_ONLINE_MEMBERS_JS = `
(function () {
  try {
    var results = [];
    var listEl = document.querySelector('[data-list-id="members"]');
    if (!listEl) return results;
    var items = Array.from(listEl.querySelectorAll('[class*="member_"]'));
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.querySelector('[class*="botTag"]')) continue;
      var statusEl = item.querySelector('[class*="status_"]');
      if (!statusEl) continue;
      var classes = statusEl.getAttribute('class') || '';
      if (!/(online|idle)/i.test(classes)) continue;
      var nameEl = item.querySelector('[class*="nick_"]') ||
                   item.querySelector('[class*="roleColor_"]') ||
                   item.querySelector('[class*="username_"]');
      if (!nameEl) continue;
      var name = nameEl.textContent.trim();
      if (name) results.push(name);
    }
    return results;
  } catch (e) { return []; }
})()`;

/**
 * Open the member list sidebar if it is not already visible.
 * Returns 'already-open' | 'opened' | 'not-found'.
 */
export const ENSURE_MEMBER_LIST_JS = `
(function () {
  if (document.querySelector('[data-list-id="members"]')) return 'already-open';
  var btn = document.querySelector('[aria-label="Show Member List"]') ||
            document.querySelector('[aria-label="Members"]');
  if (btn) { btn.click(); return 'opened'; }
  return 'not-found';
})()`;

/**
 * Click a member row by display name to open their profile popup.
 * Returns 'clicked' | 'not-found' | 'no-list'.
 */
export function buildClickMemberJS(name: string): string {
  return `
(function (targetName) {
  try {
    var listEl = document.querySelector('[data-list-id="members"]');
    if (!listEl) return 'no-list';
    var items = Array.from(listEl.querySelectorAll('[class*="member_"]'));
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var nameEl = item.querySelector('[class*="nick_"]') ||
                   item.querySelector('[class*="roleColor_"]') ||
                   item.querySelector('[class*="username_"]');
      if (nameEl && nameEl.textContent.trim() === targetName) {
        nameEl.click();
        return 'clicked';
      }
    }
    return 'not-found';
  } catch (e) { return 'error:' + e.message; }
})(${JSON.stringify(name)})`;
}

/**
 * Click the "Send Message" button inside a member profile popup.
 * Returns true on success, false if the button was not found.
 */
export const CLICK_DM_BUTTON_JS = `
(function () {
  try {
    var btn = document.querySelector('[aria-label^="Send a message to"]') ||
              document.querySelector('[aria-label="Send Message"]');
    if (!btn) {
      var popouts = document.querySelectorAll('[class*="userPopout_"], [class*="popout_"]');
      for (var pi = 0; pi < popouts.length; pi++) {
        var btns = popouts[pi].querySelectorAll('button');
        for (var bi = 0; bi < btns.length; bi++) {
          if (/message/i.test(btns[bi].getAttribute('aria-label') || '') ||
              /message/i.test(btns[bi].textContent)) {
            btn = btns[bi]; break;
          }
        }
        if (btn) break;
      }
    }
    if (btn) { btn.click(); return true; }
    return false;
  } catch (e) { return false; }
})()`;

/**
 * Return the DM channel ID if the current page is a @me DM, otherwise null.
 */
export const GET_DM_CHANNEL_ID_JS = `
(function () {
  var m = location.href.match(/\\/channels\\/@me\\/(\\d+)/);
  return m ? m[1] : null;
})()`;
